/**
 * 真机自检：这台设备**能跑到哪儿**。
 *
 * 和另外四个自检的分工完全不同。那四个问的是"代码对不对"，答案在所有机器上都该
 * 一样；这一个问的是"这台设备的上限在哪"，答案本来就因机而异——它量的是设备常量，
 * 不是正确性。所以它**不进回归门禁**，只在需要一台新设备的数字时手跑。
 *
 * 存在的理由是 PLAN.md §8 里两条一直没验的风险：**iOS Safari 全未验**（风险 6 的
 * 残留项）和**移动端导出分辨率要单独限制**（风险 4），而后者到今天为止**没有任何
 * 实测依据**——限制到多少纯属拍脑袋。
 *
 * ## 为什么结果要落 localStorage，而不是跑完一次性返回
 *
 * 这里有一步是**故意往死里逼**的：逐级升高导出分辨率，直到这台设备扛不住。
 * 而移动端"扛不住"的形态不是抛异常——是**操作系统直接把标签页杀掉**：没有异常、
 * 没有 `unload`、没有任何机会写下"我死在这一档"。跑完再返回结果的写法，在最关键的
 * 那一次运行里恰好什么都拿不到，人还以为是自检坏了。
 *
 * 所以每一档**动手之前**先把"正在试 X"写进 localStorage，成功之后再写"X 通过"。
 * 页面重新打开时读到"正在试 2160p"而没有对应的"通过"，那条记录本身就是答案。
 * **崩溃是一种测量结果，得让它留下痕迹。**
 *
 * ## 为什么升的是输出分辨率，源片始终很小
 *
 * 要问的是"这台设备能导出多大的片子"，所以变量只留输出分辨率一个：源片固定
 * 640×360，由合成器放大到目标尺寸。源片跟着一起放大的话，解码内存和编码内存一起涨，
 * 量到的上限说不清是被哪一头顶掉的。
 *
 * **代价要说清楚**：这样量不到"能不能解 4K 素材"，那是另一根轴，得另外测。
 *
 * ## 这里量不到"用了多少内存"，只量得到"活没活下来"
 *
 * `ResidencyReport` 数的是**我们自己记过账的东西**——解码帧、解码器、Input，全在
 * 源片侧。而这条阶梯扫的是输出分辨率：合成器画布、渲染目标、编码器缓冲全在输出侧，
 * 一个字节都没记进去。实测桌面上五档全是 `峰值 1MB`（就是那两张 640×360 解码帧），
 * **从 360p 到 2160p 纹丝不动**。
 *
 * 所以这个数照报，但**必须标明它是源片侧的**——不标的话读的人会得出"4K 只要 1MB"。
 * 输出侧的内存这里没有任何 API 可问（`performance.memory` 只报 JS 堆，而这些全不在
 * JS 堆上；`measureUserAgentSpecificMemory()` 要 COOP/COEP，那套头会打断第三方脚本）。
 *
 * 于是输出侧内存的**唯一测量手段就是标签页活没活下来**，而那正是上面那本日志记的东西。
 * 崩溃不是这个自检的失败模式，是它的读数。
 */

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { createCompositor } from "../compose/backend";
import type { Compositor } from "../compose/compositor";
import { startExport, type ExportHandle } from "../export/client";
import type { ExportDone } from "../export/protocol";
import { probeFile } from "../media/probe";
import { canPickSaveFile, readExportFile, removeExportFile } from "../export/write-target";
import { singleClipTimeline, type MediaSource, type Timeline } from "../edl/types";
import { makeSampleVideo } from "./make-sample";

const JOURNAL_KEY = "kerf.device-report.v1";

/** 逐级往上试的输出分辨率。短边封顶的写法见导出预设（D7），这里直接给成品尺寸。 */
const LADDER: readonly { readonly label: string; readonly w: number; readonly h: number }[] = [
  { label: "360p", w: 640, h: 360 },
  { label: "720p", w: 1280, h: 720 },
  { label: "1080p", w: 1920, h: 1080 },
  { label: "1440p", w: 2560, h: 1440 },
  { label: "2160p", w: 3840, h: 2160 },
];

/**
 * 每档导出多少帧。
 *
 * 60 帧（2 秒）足够：常驻量实测**第 9 帧起就完全平**（PLAN.md §7 的 30 分钟长跑），
 * 所以峰值早就到了。再长只是让人在手机前面多等，不会得到新信息。
 */
const LADDER_FRAMES = 60;

/** 上下文预算最多往上试到几个。到这个数还没被驱逐就当"够用"，不必真的耗到底。 */
const MAX_CONTEXTS = 24;

export interface DeviceEnv {
  readonly userAgent: string;
  readonly platform: string;
  readonly screen: string;
  readonly devicePixelRatio: number;
  /** `navigator.deviceMemory`，Safari 不给，那时是 null。 */
  readonly deviceMemoryGb: number | null;
  readonly cores: number | null;
  /** 不是安全上下文的话 WebCodecs / OPFS 直接没有，后面全部测不了。 */
  readonly secureContext: boolean;
  /**
   * 这台浏览器有没有"选保存位置"（`showSaveFilePicker`）。
   *
   * 它决定成品**走哪条写盘路径**：有 picker 就直接写用户选的文件，没有就流式写
   * OPFS 再触发下载（硬规则 9）。自检永远走 OPFS——picker 必须在用户手势里同步
   * 调起，脚本调不动——所以**凡是"写盘路径上的结论"，都只对这个值为 false 的
   * 浏览器有实测依据**。记进环境里，免得把 OPFS 上量到的结论当成两条路都验过。
   */
  readonly canPickSaveFile: boolean;
}

export interface LadderResult {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly bytes: number;
  /**
   * **源片侧**常驻量峰值（字节）；管道没报就是 null。
   *
   * 不随输出分辨率变化——见文件头。放在这里是为了看出"源片侧没有跟着涨"，
   * 不是用来判断这一档花了多少内存的。
   */
  readonly peakBytes: number | null;
  /**
   * 重新读一遍 OPFS 拿到的大小。和 `bytes`（管道报的）**不一定相等**。
   *
   * iOS Safari 实测两者都是 16777216 = **恰好 mediabunny 的 16MiB 攒批阈值**
   * （`StreamTarget` 的 `chunked: true`），五档一模一样。桌面上是真实大小。
   * 两个数都留着才分得清是"管道报错了"还是"文件真的被撑到 16MB"。
   */
  readonly rereadBytes: number | null;
  /**
   * 把成片解回来量到的**真实**宽高和帧数。
   *
   * 这一条才是"这一档真的按目标分辨率导出了"的判据。第一版拿成片字节数当代理
   * ——在 iOS 上那个数恒为 16MB，于是**代理坏掉了而断言还是绿的**，我一度以为
   * 4K 真的导出成功。字节数是旁证，解回来的宽高才是证据。
   */
  readonly decoded: string;
  readonly note: string;
}

export interface DeviceReport {
  readonly env: DeviceEnv;
  /** Pixi 后端起没起来；起不来时调色 / LUT / shader 转场全部不可用。 */
  readonly backend: string;
  readonly supportsEffects: boolean;
  readonly backendNote: string;
  /**
   * 同时活着几个 WebGL 上下文时，最老的那个被驱逐。
   *
   * `null` = 试到 `MAX_CONTEXTS` 都没被驱逐。桌面 Safari 实测在 12 附近
   * （见 `verify-pixi.worker.ts` 的 `probeContextBudget`），iOS 预期更小。
   */
  readonly contextBudget: number | null;
  readonly contextNote: string;
  readonly ladder: readonly LadderResult[];
  /** 最高跑通的那一档；一档都没过是 null。 */
  readonly maxResolution: string | null;
  /**
   * 上一次运行**死在**哪一档（标签页被杀，没留下"通过"）。
   *
   * 这条比 `ladder` 更重要：它是唯一能报告"设备直接崩了"的渠道。
   */
  readonly diedAt: string | null;
}

interface Journal {
  readonly startedAt: string;
  readonly ua: string;
  /** 正在试、还没有结论的那一档。 */
  attempting: string | null;
  done: LadderResult[];
  contextAttempt: number | null;
}

function readJournal(): Journal | null {
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? (JSON.parse(raw) as Journal) : null;
  } catch {
    return null;
  }
}

function writeJournal(journal: Journal): void {
  try {
    localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
  } catch {
    // 无痕模式下 localStorage 可能不可写。那时崩溃就真的什么都留不下，
    // 但不该因此让整个自检跑不了——只是少了这一层保险
  }
}

/**
 * 上一次运行有没有死在半路。**开跑之前先问这个**，否则新的一轮会把证据覆盖掉。
 *
 * 返回死在哪一档；上次跑完了、或者从来没跑过，都是 null。
 */
export function previousCrash(): string | null {
  return readJournal()?.attempting ?? null;
}

/** 清掉上一次的记录。看过结论之后再清，别在开跑时自动清。 */
export function clearDeviceJournal(): void {
  try {
    localStorage.removeItem(JOURNAL_KEY);
  } catch {
    /* 同上 */
  }
}

function collectEnv(): DeviceEnv {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    screen: `${screen.width}×${screen.height}`,
    devicePixelRatio: devicePixelRatio,
    deviceMemoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    cores: typeof navigator.hardwareConcurrency === "number" ? navigator.hardwareConcurrency : null,
    secureContext: isSecureContext,
    canPickSaveFile: canPickSaveFile(),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 同时握住 N 个 WebGL 上下文，看长命的那个什么时候被驱逐。
 *
 * 和 `verify-pixi.worker.ts` 里那个预算测试**问的不是同一件事**：那个断言的是
 * "复用常驻合成器这套生产架构在 12 轮之内活得下来"，是正确性；这个要的是
 * **这台设备的那个数字本身**，所以逐个往上加、加到死为止。两个都留着。
 */
async function probeContextBudget(): Promise<{ budget: number | null; note: string }> {
  const held: Compositor[] = [];
  let longLived: Compositor | null = null;
  try {
    const created = await createCompositor(64, 64);
    longLived = created.compositor;
    if (!longLived.supportsEffects) {
      return { budget: null, note: "退到了 Canvas2D，没有 WebGL 上下文可数" };
    }
    for (let i = 1; i <= MAX_CONTEXTS; i++) {
      try {
        held.push((await createCompositor(64, 64)).compositor);
      } catch (error) {
        return { budget: i, note: `新建第 ${i} 个时就抛了：${describe(error)}` };
      }
      // 判据只问长命的那个还画不画得出——那是用户遇到的形态（"预览黑了"），
      // 而"还剩几个上下文"没有跨浏览器的 API 可数
      if (!alive(longLived)) {
        return {
          budget: i,
          note: `再开 ${i} 个之后，最老的那个被驱逐（预览在生产里就是最老的那个）`,
        };
      }
    }
    return { budget: null, note: `再开 ${MAX_CONTEXTS} 个都没驱逐，够用` };
  } catch (error) {
    return { budget: null, note: `探测本身失败：${describe(error)}` };
  } finally {
    for (const c of held) {
      try {
        c.dispose();
      } catch {
        /* 上下文可能已经没了 */
      }
    }
    try {
      longLived?.dispose();
    } catch {
      /* 同上 */
    }
  }
}

/** 这个合成器还画得出东西吗。上下文被驱逐之后画出来是全黑（或直接抛）。 */
function alive(compositor: Compositor): boolean {
  try {
    const size = 64;
    const paint = document.createElement("canvas");
    paint.width = size;
    paint.height = size;
    const pctx = paint.getContext("2d");
    if (!pctx) return false;
    pctx.fillStyle = "#ffffff";
    pctx.fillRect(0, 0, size, size);

    compositor.composeFrame([{ kind: "image", image: paint, width: size, height: size }]);

    // 引擎画布可能是 WebGL 的，不能直接 getContext("2d")——先拷到一张干净的 2D 画布
    const probe = document.createElement("canvas");
    probe.width = size;
    probe.height = size;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(compositor.canvas as CanvasImageSource, 0, 0);
    const data = ctx.getImageData(0, 0, size, size).data;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! > max) max = data[i]!;
    }
    return max > 32;
  } catch {
    return false;
  }
}

/**
 * 把成片解回来，确认它**真的是**那个分辨率、那个帧数。
 *
 * 存在的理由是一次实测教训：ladder 原本只看"导出有没有抛错"，再拿成片字节数当
 * "分辨率生效了"的旁证。桌面上字节数随分辨率涨（26→280KB），看着挺好；到了
 * iOS Safari 五档**全报 16MB**（正好是 mediabunny 的攒批阈值），代理彻底失效，
 * 而 ladder 照样全绿——也就是说"4K 导出成功"这个结论当时根本没有证据支撑。
 *
 * 解回来量宽高是唯一不会被这类问题绕过去的判据。顺带也验了文件本身能不能被
 * 解析：真被撑到 16MB 且尾部是垃圾的话，这里会直接失败。
 */
async function verifyOutput(
  name: string,
  wantW: number,
  wantH: number,
): Promise<{ ok: boolean; size: number | null; detail: string }> {
  try {
    const file = await readExportFile(name);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) return { ok: false, size: file.size, detail: "解回来没有视频轨" };
      const w = track.displayWidth;
      const h = track.displayHeight;
      const stats = await track.computePacketStats();
      const sized = w === wantW && h === wantH;
      const framed = stats.packetCount === LADDER_FRAMES;
      return {
        ok: sized && framed,
        size: file.size,
        detail:
          `解回 ${w}×${h} · ${stats.packetCount} 帧` +
          (sized ? "" : ` ← 期望 ${wantW}×${wantH}`) +
          (framed ? "" : ` ← 期望 ${LADDER_FRAMES} 帧`),
      };
    } finally {
      input.dispose();
    }
  } catch (error) {
    return { ok: false, size: null, detail: `解不回来：${describe(error)}` };
  }
}

/**
 * 跑完整台设备的自检。
 *
 * @param onStep 每完成一步报一句，手机上要能看见进度——最后几档一档要跑十几秒，
 *               没有进度的话人会以为卡死了然后手动杀掉，那正好毁掉这次测量
 */
export async function runDeviceReport(
  onStep?: (message: string) => void,
): Promise<DeviceReport> {
  const env = collectEnv();
  const diedAt = previousCrash();
  const journal: Journal = {
    startedAt: new Date().toISOString(),
    ua: env.userAgent,
    attempting: null,
    done: [],
    contextAttempt: null,
  };
  writeJournal(journal);

  if (!env.secureContext) {
    return {
      env,
      backend: "未知",
      supportsEffects: false,
      backendNote:
        "不是安全上下文——WebCodecs 和 OPFS 都不可用，后面全部测不了。用 pnpm dev:device（HTTPS）重开。",
      contextBudget: null,
      contextNote: "跳过",
      ladder: [],
      maxResolution: null,
      diedAt,
    };
  }

  // ---- 1. 后端起不起得来 ----
  onStep?.("探测合成后端…");
  let backend = "未知";
  let supportsEffects = false;
  let backendNote = "";
  try {
    const created = await createCompositor(320, 180);
    backend = created.backend;
    supportsEffects = created.compositor.supportsEffects;
    backendNote = supportsEffects
      ? "WebGL 可用，调色 / LUT / shader 转场都能画"
      : `退到了 Canvas2D（${created.reason ?? "原因未报"}）：调色、LUT、shader 转场在这台设备上不可用，导出会被闸门拦下`;
    created.compositor.dispose();
  } catch (error) {
    backendNote = `合成器起不来：${describe(error)}`;
  }

  // ---- 2. WebGL 上下文预算 ----
  onStep?.("探测 WebGL 上下文预算…");
  const context = await probeContextBudget();

  // ---- 3. 逐级升分辨率导出 ----
  onStep?.("生成测试素材…");
  const sample = await makeSampleVideo({
    durationFrames: LADDER_FRAMES,
    withAudio: true,
  });
  const probe = await probeFile(sample.file);

  const ladder: LadderResult[] = [];
  for (const step of LADDER) {
    onStep?.(`导出 ${step.label}（${step.w}×${step.h}）…`);
    // **动手之前先写**。这一行就是崩溃时唯一会留下的东西
    journal.attempting = step.label;
    writeJournal(journal);

    const name = `kerf-device-${step.label}.mp4`;
    const started = performance.now();
    let result: LadderResult;
    try {
      await removeExportFile(name);
      const timeline: Timeline = {
        ...singleClipTimeline(probe.source),
        width: step.w,
        height: step.h,
      };
      const done = await startExport(
        {
          timeline,
          range: { inFrame: 0, outFrame: timeline.durationFrames },
          container: "mp4",
          // 码率按像素量给，不然高档位会被一个写死的低码率掩盖掉真实开销
          videoBitrate: Math.round(step.w * step.h * 0.1),
          audioBitrate: 128e3,
          includeAudio: true,
          target: { kind: "opfs", name },
          autoDownload: false,
        },
        () => undefined,
      ).done;
      if (!done) throw new Error("导出被取消");
      // **把成片解回来验**，不拿字节数当代理——见 `decoded` 的注释
      const verified = await verifyOutput(name, step.w, step.h);
      result = {
        label: step.label,
        width: step.w,
        height: step.h,
        ok: verified.ok,
        elapsedMs: Math.round(performance.now() - started),
        bytes: done.bytesWritten,
        peakBytes: done.residency?.peak.estimatedBytes ?? null,
        rereadBytes: verified.size,
        decoded: verified.detail,
        note: `${done.encodedFrames} 帧 · ${done.backend ?? "?"}`,
      };
      await removeExportFile(name);
    } catch (error) {
      result = {
        label: step.label,
        width: step.w,
        height: step.h,
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        bytes: 0,
        peakBytes: null,
        rereadBytes: null,
        decoded: "没跑到",
        note: describe(error),
      };
    }

    ladder.push(result);
    journal.attempting = null;
    journal.done = ladder;
    writeJournal(journal);

    // 一档失败之后不再往上试：更高的档位只会更失败，而每一档都有把标签页
    // 拖死的风险，没必要拿已经拿到的结论去冒险
    if (!result.ok) break;
  }

  const passed = ladder.filter((r) => r.ok);
  return {
    env,
    backend,
    supportsEffects,
    backendNote,
    contextBudget: context.budget,
    contextNote: context.note,
    ladder,
    maxResolution: passed.length > 0 ? passed[passed.length - 1]!.label : null,
    diedAt,
  };
}

// ---------------------------------------------------------------------------
// 长度轴
// ---------------------------------------------------------------------------

/**
 * 逐级加长片长。**这和上面那条阶梯是两根不同的轴**，不能混着扫。
 *
 * 分辨率那条扫的是"一帧有多大"，长度这条扫的是"有多少帧、多少音频"。会炸的机制
 * 完全不同：前者顶的是画布、渲染目标、编码器缓冲（全在输出侧，一帧就到峰值）；
 * 后者顶的是**随片长累积**的东西——分段之前那就是混音的整条 PCM（30 分钟 989MB、
 * 一小时 2GB，全在主线程）。两根轴一起扫的话，崩了都说不清是被哪一头顶掉的。
 *
 * 分段混流（D22）之后混音峰值理论上与片长无关，但那个结论是**4 倍片长外推**出来的
 * （M0 自检里 10 秒 vs 40 秒），不等于"30 分钟真的跑得完"。这条阶梯就是来把外推
 * 换成实测的。
 */
const LENGTH_LADDER: readonly { readonly label: string; readonly seconds: number }[] = [
  { label: "30 秒", seconds: 30 },
  { label: "2 分钟", seconds: 120 },
  { label: "10 分钟", seconds: 600 },
  { label: "30 分钟", seconds: 1800 },
];

/** 长度轴上分辨率固定，否则量到的上限说不清是被哪一头顶掉的。 */
const LENGTH_WIDTH = 1280;
const LENGTH_HEIGHT = 720;

/**
 * 每个片段多长（帧）。300 帧 ≈ 10 秒，于是 30 分钟 = 180 个片段。
 *
 * **接成很多片段而不是一条长素材**，两个理由：生成 30 分钟的测试素材本身要跑很久
 * 且占几百 MB；而"上百个片段"恰恰是长项目的真实形态，顺带压到解码游标池
 * （池深必须由"同时活着的片段数"限住，不能随片段总数增长）。
 */
const LENGTH_CLIP_FRAMES = 300;

export interface LengthResult {
  readonly label: string;
  readonly seconds: number;
  readonly clips: number;
  readonly frames: number;
  readonly ok: boolean;
  readonly elapsedMs: number;
  /** 相对实时的倍数。低于 1 就是"导一分钟片子要等一分钟以上"。 */
  readonly realtime: number;
  /**
   * **混音段**的常驻量峰值。这一条是这根轴的主角——分段之前它随片长线性涨。
   *
   * 由主线程填（`ExportDone.mixResidency`）：混音跑在主线程，而计量器每个 JS
   * 上下文一份，Worker 那份看不到这一段。
   */
  readonly mixPeakBytes: number | null;
  /** 导出循环的常驻量峰值（Worker 侧）。实测第 9 帧就压平，这里是对照。 */
  readonly loopPeakBytes: number | null;
  readonly loopPeakAtFrame: number | null;
  /** 解回来的宽高和帧数。同分辨率轴那条教训：字节数是旁证，解回来才是证据。 */
  readonly decoded: string;
  readonly note: string;
}

export interface LengthReport {
  readonly env: DeviceEnv;
  readonly rungs: readonly LengthResult[];
  /** 最长跑通的那一档；一档都没过是 null。 */
  readonly maxLength: string | null;
  /**
   * 混音峰值随片长涨了多少倍。**这是这根轴要的那个数。**
   *
   * 分段之后应当接近 1；分段之前它会跟片长同比例涨。跑通不足两档时是 null
   * ——一个点画不出趋势。
   */
  readonly mixPeakRatio: number | null;
  readonly diedAt: string | null;
}

/**
 * 逐级加长片长，量混音峰值涨不涨、以及这台设备扛不扛得住。
 *
 * 和 `runDeviceReport` 共用那本 localStorage 日志（**崩溃是读数**），所以真被系统
 * 杀掉时重新打开页面能看到死在哪一档。两者串不到一起跑：这条要十几分钟，混进去
 * 会让"看一眼这台设备的分辨率上限"这件事也变成十几分钟。
 */
export async function runLengthReport(
  onStep?: (message: string) => void,
  options?: { readonly maxSeconds?: number },
): Promise<LengthReport> {
  const env = collectEnv();
  const diedAt = previousCrash();
  const journal: Journal = {
    startedAt: new Date().toISOString(),
    ua: env.userAgent,
    attempting: null,
    done: [],
    contextAttempt: null,
  };
  writeJournal(journal);

  if (!env.secureContext) {
    return { env, rungs: [], maxLength: null, mixPeakRatio: null, diedAt };
  }

  onStep?.("生成测试素材…");
  const sample = await makeSampleVideo({
    durationFrames: LENGTH_CLIP_FRAMES,
    withAudio: true,
  });
  const probe = await probeFile(sample.file);
  const source = probe.source;
  const fps = source.fps.num / source.fps.den;
  const cap = options?.maxSeconds ?? Number.POSITIVE_INFINITY;

  const rungs: LengthResult[] = [];
  for (const step of LENGTH_LADDER) {
    if (step.seconds > cap) break;
    const clips = Math.max(1, Math.round((step.seconds * fps) / LENGTH_CLIP_FRAMES));
    const frames = clips * LENGTH_CLIP_FRAMES;
    onStep?.(`导出 ${step.label}（${clips} 个片段 · ${frames} 帧）…`);
    // **动手之前先写**。这一行就是崩溃时唯一会留下的东西
    journal.attempting = `长片 ${step.label}`;
    writeJournal(journal);

    const name = `kerf-length-${step.seconds}.mp4`;
    const started = performance.now();
    let result: LengthResult;
    try {
      await removeExportFile(name);
      const timeline = buildLongTimeline(source, clips);
      // **进度不能丢。** 第一版这里传的是 `() => undefined`，于是 Safari 死等时
      // 连"停在第几帧"都拿不到——只知道"不动了"。现在每条进度都记下来，死等的
      // 那一刻它就是唯一的证据
      let lastAt = performance.now();
      let lastText = "还没有任何进度";
      // 判"卡住了"看的是**推进**，不是"有没有收到消息"：心跳每秒一条，拿消息
      // 到达当判据的话永远不会超时。同时心跳带来的 `marker` 要留下——它才是
      // "此刻停在哪一步"，而循环里那条进度的 marker 恒为 `audio`
      let seen = "";
      const done = await watchForStall(
        startExport(
          {
            timeline,
            range: { inFrame: 0, outFrame: frames },
            container: "mp4",
            videoBitrate: Math.round(LENGTH_WIDTH * LENGTH_HEIGHT * 0.1),
            audioBitrate: 128e3,
            includeAudio: true,
            target: { kind: "opfs", name },
            autoDownload: false,
          },
          (p) => {
            const now = `${p.stage}/${p.marker ?? "?"}/${p.encodedFrames}`;
            lastText =
              `${p.stage}/${p.marker ?? "?"} 第 ${p.encodedFrames}/${p.totalFrames} 帧` +
              (p.heartbeat ? "（心跳）" : "");
            if (now === seen) return;
            seen = now;
            lastAt = performance.now();
          },
        ),
        () => ({ at: lastAt, text: lastText }),
      );
      if (!done) throw new Error("导出被取消");
      const verified = await verifyLongOutput(name, frames);
      const elapsedMs = Math.round(performance.now() - started);
      result = {
        label: step.label,
        seconds: step.seconds,
        clips,
        frames,
        ok: verified.ok,
        elapsedMs,
        realtime: frames / fps / (elapsedMs / 1000),
        mixPeakBytes: done.mixResidency?.peak.estimatedBytes ?? null,
        loopPeakBytes: done.residency?.peak.estimatedBytes ?? null,
        loopPeakAtFrame: done.residency?.peakAtFrame ?? null,
        decoded: verified.detail,
        note:
          `${done.encodedFrames} 帧 · ${done.backend ?? "?"}` +
          // 管道报的字节数和上面重读到的**两个都印**：iOS 上前者曾恒为 16MiB
          // （mediabunny 的攒批阈值），只印一个时"管道报错了"和"文件真的不对"
          // 分不开。同 M0 那条"两个操作数都要印在断言旁边"
          ` · 管道报 ${(done.bytesWritten / 1e6).toFixed(1)}MB` +
          ` · 泄漏 ${done.residency ? `${done.residency.leakedSamples}/${done.residency.leakedCursors}/${done.residency.leakedInputs}` : "?"}`,
      };
      // **验不过就把成片留着。** 第一版无论成败都删，于是"解回来没有视频轨"这条
      // 报错一出现，唯一能查下去的东西当场就没了——和"跑之前先清 `.reports/`"是
      // 同一类错误：为了看着干净，把失败那次的证据毁掉。阶梯在失败后就停，所以
      // 最多留一个文件，`?autorun=clear` 清。
      if (verified.ok) await removeExportFile(name);
    } catch (error) {
      result = {
        label: step.label,
        seconds: step.seconds,
        clips,
        frames,
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        realtime: 0,
        mixPeakBytes: null,
        loopPeakBytes: null,
        loopPeakAtFrame: null,
        decoded: "没跑到",
        note: describe(error),
      };
    }

    rungs.push(result);
    journal.attempting = null;
    writeJournal(journal);
    // 一档没过就停。**死等那条路上这不是"省时间"而是必需的**：被判死等的那次导出
    // 只是被放弃，常驻 Worker 很可能还占着，接着往下跑只会收获一串
    // "已有导出任务在进行中"，把真正的诊断埋在噪声里（见 `watchForStall`）
    if (!result.ok) break;
  }

  const passed = rungs.filter((r) => r.ok);
  const withMix = passed.filter((r) => r.mixPeakBytes !== null && r.mixPeakBytes > 0);
  const first = withMix[0];
  const last = withMix[withMix.length - 1];
  return {
    env,
    rungs,
    maxLength: passed.length > 0 ? passed[passed.length - 1]!.label : null,
    // 一个点画不出趋势——不足两档时明确报 null，别拿 1.00 冒充"证明了不涨"
    mixPeakRatio:
      withMix.length >= 2 && first && last ? last.mixPeakBytes! / first.mixPeakBytes! : null,
    diedAt,
  };
}

/**
 * 多久没有任何进度就判成死等（毫秒）。
 *
 * 要大到不会把"这台机器慢"误判成死等：Safari 上 10 分钟档实测 178 秒、3.37× 实时，
 * 而收尾那几步（写 mp4 索引、把几百 MB 落进 OPFS）现在都各自上报一次，所以单步
 * 静默期远小于这个数。也要小到别真等十几分钟——Safari 那次实测干等了 18.5 分钟
 * 才被我手动杀掉，而那 18 分钟里一个字节的新信息都没有。
 *
 * 比 `mixdown.ts` 的渲染看门狗（60 秒）大一档是**刻意的**：混音卡在
 * `startRendering()` 上时该由那道更具体的看门狗先开火、报出段号；这里兜的是
 * 其余所有位置。
 */
const STALL_TIMEOUT_MS = 90_000;

/**
 * 把"死等"变成一条读数。
 *
 * 长片这根轴上最坏的失败形态不是崩溃而是**死等**：0% CPU、几百 MB 常驻、不抛错、
 * 不崩溃、进度条永远不动（Safari 导 30 分钟实测，PLAN.md §8 风险 1）。崩溃至少
 * 还能靠 localStorage 那条前置记录留痕，死等连那都取不出来——页面还活着，只是
 * 永远不返回，于是 autorun 那条 POST 通道也永远不触发。
 *
 * 做法是盯**进度停了多久**，而不是给整次导出设一个总时限：后者会把"30 分钟的片子
 * 本来就要跑十分钟"误判成故障，而前者能把"慢"和"停"分开。超时就把最后进到的那
 * 一步连同帧号抛出来，那条错误会被记进这一档的 `note` 里，随报告一路 POST 回本地。
 *
 * **前提是主线程的事件循环还活着**——实测正是如此（0% CPU 说明卡在一个永不 resolve
 * 的 await 上，不是同步死循环）。真要是同步卡死，这个定时器同样不会跑，那时只能
 * 回到 localStorage 那条路。
 *
 * 超时之后那次导出**只是被放弃，不保证真的停下**（`cancel()` 发过去也可能没人收）。
 * 常驻 Worker 的 `running` 标志因此可能一直是 true，下一档会直接被"已有导出任务在
 * 进行中"顶掉——所以调用方在这一档失败后必须**中断整条阶梯**，不能接着往下跑。
 */
function watchForStall(
  handle: ExportHandle,
  probe: () => { readonly at: number; readonly text: string },
): Promise<ExportDone | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      run();
    };
    const timer = setInterval(() => {
      const { at, text } = probe();
      const idleMs = performance.now() - at;
      if (idleMs < STALL_TIMEOUT_MS) return;
      finish(() => {
        handle.cancel();
        reject(new Error(`死等：${Math.round(idleMs / 1000)} 秒没有任何进度，最后停在 ${text}`));
      });
    }, 1000);
    handle.done.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** 把同一个源片接成 `clips` 个首尾相连的片段，画面轨和音频轨各一条。 */
function buildLongTimeline(source: MediaSource, clips: number): Timeline {
  const make = (prefix: string) =>
    Array.from({ length: clips }, (_, i) => ({
      id: `${prefix}${i}`,
      kind: "media" as const,
      sourceId: source.id,
      timelineIn: i * LENGTH_CLIP_FRAMES,
      timelineOut: (i + 1) * LENGTH_CLIP_FRAMES,
      sourceIn: 0,
    }));
  return {
    fps: source.fps,
    width: LENGTH_WIDTH,
    height: LENGTH_HEIGHT,
    durationFrames: clips * LENGTH_CLIP_FRAMES,
    sources: [source],
    tracks: [
      { id: "V1", kind: "video", clips: make("v") },
      { id: "A1", kind: "audio", clips: make("a") },
    ],
  };
}

/**
 * 解回来确认帧数对得上。
 *
 * 长片这根轴上最像"成功"的失败形态是**音频或画面被悄悄截短**——导出不报错、文件
 * 能播、只是短了一截。帧数是唯一能一眼看出来的判据，所以哪怕解一条 30 分钟的片子
 * 要花几秒也得解。顺带把音轨时长也量出来：**音画哪一条短了要分得清**。
 */
async function verifyLongOutput(
  name: string,
  wantFrames: number,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const file = await readExportFile(name);
    // **重读到的字节数要印出来，成功失败都印。** 没有它，"没有视频轨"分不开两种
    // 完全不同的病：文件被截断（写盘没落全），还是文件完整但索引解不动。Safari 上
    // 导 30 分钟实测撞到过这条报错，当时报告里没有字节数，等于只知道"坏了"
    const size = `${(file.size / 1e6).toFixed(1)}MB`;
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) {
        // 音轨在不在能再切一刀：两条都没有 = 整个容器没解析出来；只缺视频轨 =
        // 视频那条轨自己写坏了
        let audioNote = "音轨也问不到";
        try {
          audioNote = (await input.getPrimaryAudioTrack()) ? "但有音轨" : "音轨也没有";
        } catch {
          /* 容器整个解不动时这里也会抛，那本身就是诊断 */
        }
        return { ok: false, detail: `解回来没有视频轨（${size}，${audioNote}）` };
      }
      const stats = await track.computePacketStats();
      const audio = await input.getPrimaryAudioTrack();
      const audioSeconds = audio ? await audio.computeDuration() : null;
      const videoSeconds = await track.computeDuration();
      const framed = stats.packetCount === wantFrames;
      // 音画时长差半秒以内算齐；再大就是有一条被截短了
      const synced = audioSeconds !== null && Math.abs(audioSeconds - videoSeconds) < 0.5;
      return {
        ok: framed && synced,
        detail:
          `解回 ${stats.packetCount} 帧 / ${videoSeconds.toFixed(1)}s · ${size}` +
          ` · 音轨 ${audioSeconds === null ? "无" : `${audioSeconds.toFixed(1)}s`}` +
          (framed ? "" : ` ← 期望 ${wantFrames} 帧`) +
          (synced ? "" : " ← 音画时长对不上"),
      };
    } finally {
      input.dispose();
    }
  } catch (error) {
    return { ok: false, detail: `解不回来：${describe(error)}` };
  }
}

export function formatLengthReport(report: LengthReport): string {
  const mb = (bytes: number | null) =>
    bytes === null ? "?" : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  const lines: string[] = [];
  lines.push("=== Kerf 长片自检 ===");
  lines.push(`UA: ${report.env.userAgent}`);
  lines.push(`输出固定 ${LENGTH_WIDTH}×${LENGTH_HEIGHT}，只变片长`);
  lines.push("");
  for (const r of report.rungs) {
    lines.push(
      `  ${r.ok ? "✓" : "✗"} ${r.label} · ${r.clips} 片段 / ${r.frames} 帧` +
        ` · ${(r.elapsedMs / 1000).toFixed(1)}s（${r.realtime.toFixed(2)}× 实时）` +
        ` · 混音峰值 ${mb(r.mixPeakBytes)} · 循环峰值 ${mb(r.loopPeakBytes)}@${r.loopPeakAtFrame ?? "?"}` +
        ` · ${r.decoded} · ${r.note}`,
    );
  }
  lines.push(`最长跑通: ${report.maxLength ?? "一档都没过"}`);
  lines.push(
    `混音峰值随片长的倍率: ${report.mixPeakRatio === null ? "档数不够，画不出趋势" : report.mixPeakRatio.toFixed(2)}`,
  );
  if (report.diedAt) {
    lines.push("");
    lines.push(`⚠️ 上一次运行死在 ${report.diedAt}（标签页被杀，没留下结论）`);
  }
  return lines.join("\n");
}

/**
 * 把报告压成一段纯文本，方便手机上长按复制发回来。
 *
 * 手机上没有开发者工具，截图又读不到长 UA——不给一个能复制的形态，结论就只能靠
 * 人对着屏幕念。
 */
export function formatDeviceReport(report: DeviceReport): string {
  const lines: string[] = [];
  lines.push("=== Kerf 真机自检 ===");
  lines.push(`UA: ${report.env.userAgent}`);
  lines.push(
    `平台 ${report.env.platform} · 屏幕 ${report.env.screen}@${report.env.devicePixelRatio}x` +
      ` · 核心 ${report.env.cores ?? "?"} · 内存 ${report.env.deviceMemoryGb ?? "?"}GB` +
      ` · 安全上下文 ${report.env.secureContext ? "是" : "否"}`,
  );
  lines.push("");
  lines.push(`后端: ${report.backend}（effects=${report.supportsEffects}）— ${report.backendNote}`);
  lines.push(
    `WebGL 上下文预算: ${report.contextBudget ?? `> ${MAX_CONTEXTS}`} — ${report.contextNote}`,
  );
  lines.push("");
  lines.push("导出阶梯:");
  for (const r of report.ladder) {
    const kb = (r.bytes / 1024).toFixed(0);
    const reread = r.rereadBytes === null ? "?" : (r.rereadBytes / 1024).toFixed(0);
    lines.push(
      `  ${r.ok ? "✓" : "✗"} ${r.label} ${r.width}×${r.height} · ${r.elapsedMs}ms` +
        ` · ${r.decoded} · 管道报 ${kb}KB / 重读 ${reread}KB · ${r.note}`,
    );
  }
  lines.push(`最高跑通: ${report.maxResolution ?? "一档都没过"}`);
  lines.push(
    "（常驻量是源片侧的，不随输出分辨率变化；输出侧内存没有 API 可问，" +
      "唯一的读数是标签页活没活下来——见下面那行 ⚠️）",
  );
  if (report.diedAt) {
    lines.push("");
    lines.push(`⚠️ 上一次运行死在 ${report.diedAt}（标签页被杀，没留下结论）`);
  }
  return lines.join("\n");
}
