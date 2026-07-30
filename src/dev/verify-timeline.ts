/**
 * 多片段时间轴的预览／导出一致性自检——硬规则 2 的第二道护栏。
 *
 * verify-preview.ts 只比对**单片段**的一帧：它能抓住"缩放几何分叉"，
 * 但抓不住 EDL 化引入的那一整类错误，因为单片段时间轴根本走不到它们：
 *
 * - 跨片段边界后取到的是**下一个片段的源片位置**，还是继续读上一个片段？
 *   （reader 没换游标 → 成片在切点之后画面完全错，但不报任何错）
 * - 时间轴空档产出**黑帧**，还是被跳过？
 *   （跳过 → 后面所有帧整体前移，音画从此不同步）
 * - 空档之后的片段能不能**重新开出解码器**？
 * - 预览在这三种情况下与导出是否仍然一致？
 *
 * ## 为什么能断言"取到的是源片第 N 帧"
 *
 * 测试素材的背景色随帧号线性渐变（`hue = i/frames*300`），所以**色相编码了源片帧号**。
 * 于是"跨片段边界取对了没有"从"肉眼看水印"变成一个可比较的数字：
 * 时间轴第 80 帧应该显示源片第 200 帧（色相 200°），如果 reader 没换游标，
 * 它会显示源片第 60 帧（色相 60°）——差 140°，任何容差都盖不住。
 *
 * 仍然用**方形输出**跑，这样 16:9 素材必然留边，几何分叉也一并被覆盖。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { makeSampleVideo } from "./make-sample";
import { probeAvFile } from "../media/probe";
import { runExport } from "../export/pipeline";
import { readExportFile, removeExportFile } from "../export/write-target";
import { createPreviewEngine } from "../preview/preview-engine";
import type { Clip, Timeline, Track } from "../edl/types";
import { frameDurationMicros, frameToSeconds, MICROS_PER_SECOND } from "../time/timebase";
import { BLACK_ROW_SUM, hueDistance, measure, sampleHueAt, type Bands } from "./measure";
import type { Check } from "./verify-m0";

/** 方形输出：让 16:9 素材必然产生上下黑边，从而能比较留边几何。 */
const OUT_SIZE = 320;
/** 源片尺寸（`makeSampleVideo` 的缺省值）。留边的手算值要用它。 */
const SRC_W = 640;
const SRC_H = 360;
/**
 * 上下留边各多少像素，**手算**：内容高 = 320 × 360/640 = 180，留边 = (320−180)/2 = 70。
 *
 * 刻意不调 `containRect()` 算——那是被测代码，拿它当期望值会让断言恒成立
 * （同 D46 那条"命中手算的 `containRect`"）。改 `OUT_SIZE` 或源片尺寸要跟着改这里。
 */
const EXPECTED_BAND = (OUT_SIZE - Math.round((OUT_SIZE * SRC_H) / SRC_W)) / 2;

/**
 * "两条路径的留边相差多少还算一致"（像素）。
 *
 * **不能是 0**，而这个 1 是实测逼出来的：导出侧的像素是从**解回来的成片**里读的，
 * 而黑边紧邻内容的那一行会被 H.264 的变换块染上亮度。`measure` 判黑的阈值是
 * 三通道之和 24，实测导出侧那一行在 0–16 之间跳（预览侧恒为 0）——余量只剩 8。
 * 于是同一份代码在 Chrome 上全绿、在**桌面 Safari 上红 2 帧**，而红的正是 Chrome
 * 上余量最小的那两帧（都是 16/24）。那是量法贴着健康值，不是产品差了一个像素。
 *
 * 放掉这 1px 之后"两边一起偏了 1px"就没人抓了，所以下面补了一条**预览侧命中
 * 手算值**的断言——预览读的是无损画布（那一行恒为 0），那条可以用 0 容差。
 */
const LETTERBOX_TOLERANCE = 1;
/** 源片总帧数。色相 = frame/300*300，即色相数值恰好等于帧号，便于对照。 */
const SOURCE_FRAMES = 300;

/** 片段 A：时间轴 0–60，读源片 0–60。 */
const A_IN = 0;
const A_OUT = 60;
const A_SOURCE_IN = 0;
/** 空档：时间轴 60–80。 */
/** 片段 B：时间轴 80–140，读源片 200–260。刻意让源片位置**不连续**。 */
const B_IN = 80;
const B_OUT = 140;
const B_SOURCE_IN = 200;

/**
 * 转场段：空档 140–160 之后 C[160,220) 与 D[220,280) 紧邻，D 挂 20 帧交叉溶解。
 *
 * 单独摆在后面而不是复用 A/B，是因为转场窗口会盖住交界两侧各 10 帧——挂在
 * A/B 上会把"片段末帧取到源片第几帧"那几条断言变成一个混合色，两件事就纠缠了。
 *
 * C 和 D **来自同一个源文件**，这是刻意的：那时一条轨上要同时开两个游标去读
 * 同一份素材，而 Input 的 demuxer 有读取位置——共用一份会互相打乱拉包顺序，
 * 表现是转场两侧同帧或花屏。这条路径只有同源片时才走得到。
 */
const C_IN = 160;
const C_OUT = 220;
const C_SOURCE_IN = 0;
const D_IN = 220;
const D_OUT = 280;
const D_SOURCE_IN = 200;
const TRANSITION_FRAMES = 20;
/** 解算后的窗口：以交界 D_IN 为中心，左右各一半。 */
const WIN_IN = D_IN - TRANSITION_FRAMES / 2;
const WIN_OUT = D_IN + TRANSITION_FRAMES / 2;

/**
 * 擦除段：E[280,340) 紧跟 D，挂 20 帧**线性擦除**（shader 转场）。
 *
 * 溶解那一段验的是"两层有没有被混"，这一段验的是**只有这个自检能验的东西**：
 * shader 转场在**导出路径**上也画对了。逐像素的混合算术由 Pixi spike 里的
 * GPU-vs-CPU 断言管（那里两层是纯色，取样精度不参与）；这里管的是
 * reader 有没有解出两层、Worker 里的合成器有没有拿到转场节点、边界落在哪。
 *
 * 擦除在画面上是**左右分区**的，所以这里能用 D6 的分区测量做一条很强的断言：
 * 边界左边整块是入场层的色相、右边整块是出场层的，两条路径都要成立。
 */
const E_IN = 280;
const E_OUT = 340;
const E_SOURCE_IN = 100;
const WIPE_FRAMES = 20;
const WIPE_WIN_IN = E_IN - WIPE_FRAMES / 2;
/** 取样帧：进度 0.275，擦除边界落在画面 28% 处。 */
const WIPE_PROBE = WIPE_WIN_IN + 5;
/** 边界左侧（已被入场层覆盖）与右侧（仍是出场层）的取样区，都避开留边黑区。 */
const WIPE_LEFT = { x: 0, y: 90, width: 60, height: 140 };
const WIPE_RIGHT = { x: 160, y: 90, width: 160, height: 140 };

/**
 * 定格段：F[340,400) 紧跟 E，**整段定在源片第 150 帧**（**D48**）。
 *
 * 色相编码源片帧号，所以定格在这套自检里有一个**一眼可判**的判据：F 里任意两帧的
 * 色相必须**相同**（都等于第 150 帧那个色相），而同样两帧在不定格时相差 50°。
 * 这一条只有走完整条导出才验得到——reader 那侧是"游标停在同一帧不再前进"这条路径
 * （`advance` 里那个循环），而它和"余量不足时夹住"共用同一段代码。
 *
 * 定格帧刻意**不取源片第 0 帧**：0 会让 `frameToMicros(sourceIn, …)` 恒等于 0，那时
 * "取帧位置来自 `sourceIn`"这件事被乘以零、测不到（同 D35 那条被乘以零的因子）。
 */
const F_IN = 340;
const F_OUT = 400;
const F_SOURCE_IN = 150;
/** F 里的两个取样帧，刻意隔得远：相邻两帧色相只差 1°，容差会把它吸收掉。 */
const F_PROBE_EARLY = F_IN + 5;
const F_PROBE_LATE = F_OUT - 5;

/**
 * "定格确实生效"的下限（度）。
 *
 * 不定格时那两帧相差 `F_PROBE_LATE - F_PROBE_EARLY = 50`°，定格时应该是 0（实测受
 * 编码噪声影响约 1–2°）。阈值取 20 = `HUE_TOLERANCE`：它要同时离健康值（≈0）和
 * 坏掉时的值（50）都远，同 `BLEND_MIN_DIFF` 那条的定法。
 */
const FREEZE_MIN_DIFF = 20;
/** 定格段两帧"是同一帧"的容差（度）。同一个源片帧被编码两次，实测差 ≈ 0–2。 */
const FREEZE_SAME_TOLERANCE = 10;

const TIMELINE_FRAMES = F_OUT;
const VERIFY_OUT = "kerf-verify-timeline.mp4";

/** 色相容差。素材每帧变 1°，编码有损再加几度，20° 足够区分"差一帧"和"差一个片段"。 */
const HUE_TOLERANCE = 20;
/** "纯黑"的最大通道阈值。H.264 有损压缩后纯黑不会正好是 0。 */
const BLACK_MAX_CHANNEL = 24;

interface Probe {
  readonly frame: number;
  readonly label: string;
  /**
   * 期望读到的源片帧号；`null` = 空档（应为纯黑）；`"blend"` = 落在转场窗口里。
   *
   * 窗口内没有"应该是源片第几帧"这个说法——画面是两层混出来的，所以那几帧
   * 的色相断言换成下面 §6 的混合比例断言。
   */
  readonly expectSourceFrame: number | null | "blend";
}

const PROBES: readonly Probe[] = [
  { frame: 10, label: "片段 A 内部", expectSourceFrame: A_SOURCE_IN + 10 },
  { frame: A_OUT - 1, label: "片段 A 末帧", expectSourceFrame: A_SOURCE_IN + A_OUT - 1 },
  { frame: A_OUT, label: "空档首帧", expectSourceFrame: null },
  { frame: B_IN - 1, label: "空档末帧", expectSourceFrame: null },
  { frame: B_IN, label: "片段 B 首帧（跨片段边界）", expectSourceFrame: B_SOURCE_IN },
  { frame: B_IN + 30, label: "片段 B 内部", expectSourceFrame: B_SOURCE_IN + 30 },
  { frame: B_OUT - 1, label: "片段 B 末帧", expectSourceFrame: B_SOURCE_IN + B_OUT - B_IN - 1 },
  { frame: WIN_IN - 5, label: "转场之前（纯 C）", expectSourceFrame: C_SOURCE_IN + WIN_IN - 5 - C_IN },
  { frame: WIN_IN + 1, label: "转场窗口刚开始", expectSourceFrame: "blend" },
  { frame: D_IN - 1, label: "转场窗口·交界前一帧", expectSourceFrame: "blend" },
  { frame: D_IN + 1, label: "转场窗口·交界后一帧", expectSourceFrame: "blend" },
  { frame: WIN_OUT - 1, label: "转场窗口末帧", expectSourceFrame: "blend" },
  { frame: WIN_OUT + 5, label: "转场之后（纯 D）", expectSourceFrame: D_SOURCE_IN + WIN_OUT + 5 - D_IN },
  { frame: WIPE_PROBE, label: "擦除窗口内（shader 转场）", expectSourceFrame: "blend" },
  { frame: E_IN + 20, label: "擦除之后（纯 E）", expectSourceFrame: E_SOURCE_IN + 20 },
  // 定格段的两帧**期望的都是同一个源片帧**，于是既有的那三条断言（导出取到第 N 帧 /
  // 预览与导出一致 / 留边一致）对定格自动成立，不需要新写一套
  { frame: F_PROBE_EARLY, label: "定格段·靠前一帧", expectSourceFrame: F_SOURCE_IN },
  { frame: F_PROBE_LATE, label: "定格段·靠后一帧", expectSourceFrame: F_SOURCE_IN },
];

/**
 * 落在**溶解**窗口里的取样帧。
 *
 * 擦除那一帧刻意不在其中：混合比例那一节算的是"逐点 `(1-t)·出场 + t·入场`"，
 * 而擦除在每一点上都是纯的一层、混合发生在**空间**上。拿溶解的公式去套它会
 * 得到一个必然对不上的参照值，那种红是噪声不是信号。擦除由分区色相断言管。
 */
const DISSOLVE_PROBES = PROBES.filter(
  (p) => p.expectSourceFrame === "blend" && p.frame >= WIN_IN && p.frame < WIN_OUT,
).map((p) => p.frame);

/**
 * 混合比例的允许偏差（每通道 0–255）。
 *
 * 参照值由两次**纯层预览**加权算出，再和实际画面比。误差来源是 H.264 有损压缩
 * 和两条路径各自的重采样，**实测为 1**。
 *
 * 10 这个数是反向验证定出来的，不是拍的：第一版取 30，而"把溶解整个丢掉"这个
 * 破坏在交界前一帧只造成 32 的偏差——余量只剩 2，等于把断言交给运气。容差要
 * 同时离健康值（1）和破坏值（32）都远，10 落在中间偏低。
 */
const BLEND_TOLERANCE = 10;

/**
 * "画面确实被混过"的下限（每通道 0–255）。
 *
 * 与"同一帧但没挂转场"的画面比，交界附近至少要差这么多。**没有这一条，
 * 整个转场被丢掉时前面那些断言仍然全绿**——预览和导出共用同一份取样映射，
 * 一起丢掉的话两边照样一致。同 D17 那条"摆位真的在变"。
 *
 * 阈值要落在"坏掉时的值"和"实测健康值"**之间**，不能贴着后者：这条差值的
 * 上界是 0.5×两层色差，测试素材上实测 29，而转场被丢掉时是 0（噪声实测 ≤1）。
 * 12 离两头都远。取 24 的话每次重编码抖一点就会误报，而那种阈值只是看起来严格。
 */
const BLEND_MIN_DIFF = 12;

export interface TimelineVerifyRow {
  readonly label: string;
  readonly frame: number;
  readonly previewHue: number;
  readonly exportedHue: number;
  readonly expectedHue: number | null;
  readonly previewBlack: boolean;
  readonly exportedBlack: boolean;
  readonly previewBands: string;
  readonly exportedBands: string;
  /**
   * 上黑边边界两行的最亮采样和（`黑的那行/不黑的那行`），判黑阈值见 `BLACK_ROW_SUM`。
   *
   * **绿的时候也记**：这两个数回答的是"这条断言还剩多少余量"，而那个问题只有在
   * 断言还没红的时候问才有用。留边差 1px 时它把"几何分叉"（不黑的那行是几百）
   * 和"编码噪声顶过了阈值"（25–60）分开，而只看 `top/bottom` 两者一模一样。
   */
  readonly previewTopEdge: string;
  readonly exportedTopEdge: string;
}

export interface TimelineVerifyResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
  readonly rows: readonly TimelineVerifyRow[];
  readonly encodedFrames: number;
  readonly bytesWritten: number;
  readonly elapsedMs: number;
}

/** 两次测量的平均色逐通道最大差。混合色的色相不稳定，比 RGB 更可靠。 */
function rgbDistance(
  a: { meanR: number; meanG: number; meanB: number },
  b: { meanR: number; meanG: number; meanB: number },
): number {
  return Math.round(
    Math.max(
      Math.abs(a.meanR - b.meanR),
      Math.abs(a.meanG - b.meanG),
      Math.abs(a.meanB - b.meanB),
    ),
  );
}

function bandsAgree(pv: Bands, ex: Bands): boolean {
  return (
    Math.abs(pv.top - ex.top) <= LETTERBOX_TOLERANCE &&
    Math.abs(pv.bottom - ex.bottom) <= LETTERBOX_TOLERANCE
  );
}

/**
 * 留边读数。**不一致时**追加边界行的亮度，因为只印 `top/bottom` 的话两种根因
 * 长得一模一样：几何真的分叉了（第一行不黑的值会是几百），还是编码往返在黑边
 * 边界的量化噪声把一行染过了阈值（25–60）。后者只会出现在**导出**那一侧——
 * 那边的像素是从解回来的成片里读的，预览侧读的是无损画布。
 *
 * 一致时不印，否则 13 条绿断言各拖一串数字，反而看不见红的那两条。
 */
function bandsReading(b: Bands, agree: boolean): string {
  if (agree) return `${b.top}/${b.bottom}`;
  return (
    `${b.top}/${b.bottom}（上边界行最亮采样和：黑的那行 ${b.topLastBlackSum}、` +
    `不黑的那行 ${b.topFirstLitSum}，判黑阈值 ${BLACK_ROW_SUM}）`
  );
}

function check(name: string, expected: unknown, actual: unknown, pass?: boolean): Check {
  return {
    name,
    expected: String(expected),
    actual: String(actual),
    pass: pass ?? String(expected) === String(actual),
  };
}

export async function verifyTimelineConsistency(): Promise<TimelineVerifyResult> {
  const startedAt = performance.now();
  const checks: Check[] = [];

  // ---- 1. 素材与多片段 EDL ----
  const sample = await makeSampleVideo({ durationFrames: SOURCE_FRAMES, withAudio: false });
  const probe = await probeAvFile(sample.file);

  const clipA: Clip = {
    id: "A",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: A_IN,
    timelineOut: A_OUT,
    sourceIn: A_SOURCE_IN,
  };
  const clipB: Clip = {
    id: "B",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: B_IN,
    timelineOut: B_OUT,
    sourceIn: B_SOURCE_IN,
  };
  // C 与 D 紧邻，D 的入点挂交叉溶解。两者同源片 → 转场窗口里要在一条轨上
  // 同时开两个游标读同一份素材（见常量处的注释）
  const clipC: Clip = {
    id: "C",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: C_IN,
    timelineOut: C_OUT,
    sourceIn: C_SOURCE_IN,
  };
  const clipD: Clip = {
    id: "D",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: D_IN,
    timelineOut: D_OUT,
    sourceIn: D_SOURCE_IN,
    transitionIn: { kind: "dissolve", frames: TRANSITION_FRAMES },
  };
  // E 紧跟 D，挂线性擦除——这是唯一走**双输入 shader** 的一段
  const clipE: Clip = {
    id: "E",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: E_IN,
    timelineOut: E_OUT,
    sourceIn: E_SOURCE_IN,
    transitionIn: { kind: "wipe", frames: WIPE_FRAMES },
  };
  // F 定格：整段只画源片第 F_SOURCE_IN 帧（D48）
  const clipF: Clip = {
    id: "F",
    kind: "media",
    sourceId: probe.source.id,
    timelineIn: F_IN,
    timelineOut: F_OUT,
    sourceIn: F_SOURCE_IN,
    freeze: true,
  };
  const track: Track = {
    id: "V1",
    kind: "video",
    clips: [clipA, clipB, clipC, clipD, clipE, clipF],
  };
  const timeline: Timeline = {
    fps: probe.source.fps,
    width: OUT_SIZE,
    height: OUT_SIZE,
    durationFrames: TIMELINE_FRAMES,
    tracks: [track],
    sources: [probe.source],
  };

  // ---- 2. 预览路径：逐个取样帧渲染并测量 ----
  const engine = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  const previewBands = new Map<number, Bands>();
  let previewWipe: { left: Bands; right: Bands } | null = null;
  let exportedWipe: { left: Bands; right: Bands } | null = null;
  let noTransition = new Map<number, Bands>();
  let pureFrom = new Map<number, Bands>();
  let pureTo = new Map<number, Bands>();
  let freezeControl = new Map<number, Bands>();
  try {
    // 引擎画布接了 Pixi 之后是 WebGL 画布，不能直接 getContext("2d")——
    // 一张画布只能有一种上下文类型。先 drawImage 到干净的 2D 画布上再量
    const probe = document.createElement("canvas");
    probe.width = OUT_SIZE;
    probe.height = OUT_SIZE;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    if (!pctx) throw new Error("探测画布没有 2D 上下文");
    for (const p of PROBES) {
      await engine.renderFrame(timeline, p.frame);
      pctx.drawImage(engine.canvas as CanvasImageSource, 0, 0);
      previewBands.set(p.frame, measure(pctx, OUT_SIZE, OUT_SIZE));
      // 擦除那一帧另外做分区测量（D6）：整幅平均色对左右分区的效果是瞎的
      if (p.frame === WIPE_PROBE) {
        previewWipe = {
          left: measure(pctx, OUT_SIZE, OUT_SIZE, WIPE_LEFT),
          right: measure(pctx, OUT_SIZE, OUT_SIZE, WIPE_RIGHT),
        };
      }
    }

    // 转场用的三组参照，全部走预览路径（不用再导出一遍）：
    //   noTransition —— 同一份 EDL 摘掉转场，用来证明"画面确实被混过"
    //   pureFrom / pureTo —— 把两层各自铺满窗口，用来算出期望的混合色
    // 两个纯层的取帧映射与真实转场里**完全一致**（占位与 sourceIn 同步偏移），
    // 所以 (1-t)·from + t·to 就是这一帧应该长的样子
    const shoot = async (tl: Timeline, frames: readonly number[]) => {
      const out = new Map<number, Bands>();
      for (const f of frames) {
        await engine.renderFrame(tl, f);
        pctx.drawImage(engine.canvas as CanvasImageSource, 0, 0);
        out.set(f, measure(pctx, OUT_SIZE, OUT_SIZE));
      }
      return out;
    };
    const bare: Clip = { ...clipD };
    delete (bare as { transitionIn?: unknown }).transitionIn;
    noTransition = await shoot(
      { ...timeline, tracks: [{ ...track, clips: [clipA, clipB, clipC, bare] }] },
      DISSOLVE_PROBES,
    );
    pureFrom = await shoot(
      {
        ...timeline,
        tracks: [{ ...track, clips: [{ ...clipC, timelineOut: D_OUT }] }],
      },
      DISSOLVE_PROBES,
    );
    pureTo = await shoot(
      {
        ...timeline,
        tracks: [
          {
            ...track,
            clips: [{ ...bare, timelineIn: WIN_IN, sourceIn: D_SOURCE_IN - (D_IN - WIN_IN) }],
          },
        ],
      },
      DISSOLVE_PROBES,
    );

    // 定格的对照组：同一个 F 去掉 `freeze`，同样两帧走预览路径。
    // **没有它，"定格段两帧画面相同"在取帧整个坏掉（恒定返回某一帧）时同样成立**
    // ——那正是 `BLEND_MIN_DIFF` 那条对照断言存在的理由，一字不差
    const thawedF: Clip = { ...clipF };
    delete (thawedF as { freeze?: unknown }).freeze;
    freezeControl = await shoot(
      {
        ...timeline,
        tracks: [{ ...track, clips: [clipA, clipB, clipC, clipD, clipE, thawedF] }],
      },
      [F_PROBE_EARLY, F_PROBE_LATE],
    );
  } finally {
    engine.dispose();
  }

  // ---- 3. 导出路径：整条时间轴一次导出 ----
  // 刻意导整条而不是逐帧单独导：只有连续跑一遍才会走到"换片段游标"、
  // "空档释放解码器"、"空档之后重开解码器"这些真实路径
  await removeExportFile(VERIFY_OUT);
  const exported = await runExport(
    {
      timeline,
      range: { inFrame: 0, outFrame: TIMELINE_FRAMES },
      container: "mp4",
      videoBitrate: 8e6,
      audioBitrate: 128e3,
      audio: null,
      target: { kind: "opfs", name: VERIFY_OUT },
    },
    {
      onProgress: () => undefined,
      isCanceled: () => false,
      // 这几条自检都传 audio: null，逐帧循环里的音频泵是空实现，拉不到这儿
      pullAudio: async () => null,
    },
  );

  checks.push(
    check("导出帧数等于时间轴总长（空档也要出帧，不能跳过）", TIMELINE_FRAMES, exported.encodedFrames),
  );

  // ---- 4. 读回导出结果，解码同样的取样帧 ----
  const outFile = await readExportFile(VERIFY_OUT);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(outFile) });
  const exportedBands = new Map<number, Bands>();
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("导出文件里没有视频轨");

    const stats = await videoTrack.computePacketStats();
    checks.push(check("读回视频帧数", TIMELINE_FRAMES, stats.packetCount));

    const sink = new VideoSampleSink(videoTrack);
    const canvas = document.createElement("canvas");
    canvas.width = OUT_SIZE;
    canvas.height = OUT_SIZE;
    const ectx = canvas.getContext("2d");
    if (!ectx) throw new Error("导出比对画布没有 2D 上下文");

    // 半帧偏移：按帧起点查询容易落回前一帧（微秒取整误差）
    const half = frameDurationMicros(timeline.fps) / 2 / MICROS_PER_SECOND;
    for (const p of PROBES) {
      const at = frameToSeconds(p.frame, timeline.fps) + half;
      const decoded = await sink.getSample(at);
      if (!decoded) throw new Error(`读不出导出文件的第 ${p.frame} 帧`);
      const frame = decoded.toVideoFrame();
      try {
        ectx.drawImage(frame, 0, 0);
      } finally {
        frame.close();
        decoded.close();
      }
      exportedBands.set(p.frame, measure(ectx, OUT_SIZE, OUT_SIZE));
      if (p.frame === WIPE_PROBE) {
        exportedWipe = {
          left: measure(ectx, OUT_SIZE, OUT_SIZE, WIPE_LEFT),
          right: measure(ectx, OUT_SIZE, OUT_SIZE, WIPE_RIGHT),
        };
      }
    }
  } finally {
    input.dispose();
  }

  // ---- 5. 比对 ----
  const rows: TimelineVerifyRow[] = [];
  for (const p of PROBES) {
    const pv = previewBands.get(p.frame)!;
    const ex = exportedBands.get(p.frame)!;
    const expectedHue =
      typeof p.expectSourceFrame === "number"
        ? sampleHueAt(p.expectSourceFrame, SOURCE_FRAMES)
        : null;

    rows.push({
      label: p.label,
      frame: p.frame,
      previewHue: pv.hue,
      exportedHue: ex.hue,
      expectedHue,
      previewBlack: pv.maxChannel <= BLACK_MAX_CHANNEL,
      exportedBlack: ex.maxChannel <= BLACK_MAX_CHANNEL,
      previewBands: `${pv.top}/${pv.bottom}`,
      exportedBands: `${ex.top}/${ex.bottom}`,
      previewTopEdge: `${pv.topLastBlackSum}/${pv.topFirstLitSum}`,
      exportedTopEdge: `${ex.topLastBlackSum}/${ex.topFirstLitSum}`,
    });

    if (p.expectSourceFrame === "blend") {
      // 窗口内没有"应该是源片第几帧"，只断言两条路径画的是同一张画面。
      // **这一条正是这次结构性改动的护栏**：导出侧漏解第二层时，成片里只有出场层，
      // 而预览是对的——用色相比不够（混合色的色相不稳定），改用平均色逐通道比
      const delta = rgbDistance(pv, ex);
      checks.push(
        check(
          `帧 ${p.frame}（${p.label}）预览与导出画面一致`,
          `每通道 Δ ≤ ${BLEND_TOLERANCE}`,
          delta,
          delta <= BLEND_TOLERANCE,
        ),
      );
      checks.push(
        check(
          `帧 ${p.frame}（${p.label}）留边几何一致`,
          bandsReading(pv, bandsAgree(pv, ex)),
          bandsReading(ex, bandsAgree(pv, ex)),
          bandsAgree(pv, ex),
        ),
      );
      continue;
    }

    if (p.expectSourceFrame === null) {
      // 空档：两条路径都必须是纯黑，而不是"上一帧的残留画面"
      checks.push(
        check(
          `帧 ${p.frame}（${p.label}）导出为纯黑`,
          `maxChannel ≤ ${BLACK_MAX_CHANNEL}`,
          ex.maxChannel,
          ex.maxChannel <= BLACK_MAX_CHANNEL,
        ),
      );
      checks.push(
        check(
          `帧 ${p.frame}（${p.label}）预览为纯黑`,
          `maxChannel ≤ ${BLACK_MAX_CHANNEL}`,
          pv.maxChannel,
          pv.maxChannel <= BLACK_MAX_CHANNEL,
        ),
      );
      continue;
    }

    // 内容帧：先断言"取到的确实是期望的源片帧"（这条能抓住跨片段没换游标），
    // 再断言"预览和导出一致"（这条是硬规则 2 本身）
    checks.push(
      check(
        `帧 ${p.frame}（${p.label}）导出取到源片第 ${p.expectSourceFrame} 帧`,
        `色相 ${expectedHue}° ±${HUE_TOLERANCE}`,
        `${ex.hue}°`,
        hueDistance(ex.hue, expectedHue!) <= HUE_TOLERANCE,
      ),
    );
    checks.push(
      check(
        `帧 ${p.frame}（${p.label}）预览与导出色相一致`,
        `Δ ≤ ${HUE_TOLERANCE}°`,
        `${hueDistance(pv.hue, ex.hue)}°`,
        hueDistance(pv.hue, ex.hue) <= HUE_TOLERANCE,
      ),
    );
    checks.push(
      check(
        `帧 ${p.frame}（${p.label}）留边几何一致`,
        bandsReading(pv, bandsAgree(pv, ex)),
        bandsReading(ex, bandsAgree(pv, ex)),
        bandsAgree(pv, ex),
      ),
    );
  }

  // 留边命中**手算值**，只判预览侧、0 容差。
  //
  // 上面那条"两条路径一致"给编码噪声留了 ±1（见 `LETTERBOX_TOLERANCE`），于是
  // "**两边一起**偏了 1px"就没人抓了——而那正是"某条路径自己加了一次取整"的形态，
  // 两条路径共用 `containRect()` 也挡不住。这一条补上：预览读的是无损画布，
  // 那一行恒为纯黑，所以它可以要求精确相等。
  //
  // 一条汇总断言而不是每帧一条：15 帧各加一条会把这个自检从 62 项顶到 77 项，
  // 而它们全部只在同一件事上有信息量（几何是不是整体偏了）。
  const contentProbes = PROBES.filter((p) => p.expectSourceFrame !== null);
  const offBand = contentProbes
    .map((p) => ({ frame: p.frame, b: previewBands.get(p.frame)! }))
    .filter(({ b }) => b.top !== EXPECTED_BAND || b.bottom !== EXPECTED_BAND);
  checks.push(
    check(
      `预览侧留边命中手算值（${OUT_SIZE} 方形输出 · ${SRC_W}×${SRC_H} 源片）`,
      `${contentProbes.length} 个取样帧全部 ${EXPECTED_BAND}/${EXPECTED_BAND}`,
      offBand.length === 0
        ? `${contentProbes.length} 帧全部命中`
        : `${offBand.length} 帧不命中，例如帧 ${offBand[0]!.frame} 是 ` +
          `${offBand[0]!.b.top}/${offBand[0]!.b.bottom}`,
      offBand.length === 0,
    ),
  );

  // 跨片段边界这条单独再断言一次：它是 EDL 化最容易错、后果最严重的地方
  const boundary = rows.find((r) => r.frame === B_IN)!;
  const wrongHue = sampleHueAt(A_SOURCE_IN + B_IN, SOURCE_FRAMES);
  checks.push(
    check(
      "跨片段边界没有沿用上一个片段的源片位置",
      `不接近色相 ${wrongHue}°（那是没换游标的表现）`,
      `${boundary.exportedHue}°`,
      hueDistance(boundary.exportedHue, wrongHue) > HUE_TOLERANCE,
    ),
  );

  // ---- 5b. 定格：整段是同一帧，而且这个量法看得见帧差（D48）----
  //
  // 上面那三条（导出取到第 150 帧 / 预览与导出一致 / 留边一致）对 F 的两个取样帧
  // 已经各成立一次，但它们**单独不足以说明定格生效**：两帧各自都接近 150° 只说明
  // 期望值写对了，而如果取帧整个坏掉、恒定返回某一帧，它们照样绿。所以再要两条——
  // 一条量"这两帧确实是同一张画面"，一条**对照**（同两帧不定格时必须不同）。
  const frozenEarly = rows.find((r) => r.frame === F_PROBE_EARLY)!;
  const frozenLate = rows.find((r) => r.frame === F_PROBE_LATE)!;
  const frozenDelta = hueDistance(frozenEarly.exportedHue, frozenLate.exportedHue);
  checks.push(
    check(
      `定格段里相隔 ${F_PROBE_LATE - F_PROBE_EARLY} 帧的两帧是同一张画面`,
      `Δ ≤ ${FREEZE_SAME_TOLERANCE}°`,
      `${frozenDelta}°`,
      frozenDelta <= FREEZE_SAME_TOLERANCE,
    ),
  );
  const controlDelta = hueDistance(
    freezeControl.get(F_PROBE_EARLY)!.hue,
    freezeControl.get(F_PROBE_LATE)!.hue,
  );
  checks.push(
    check(
      "对照：同两帧不定格时画面不同（证明这个量法看得见帧差）",
      `Δ ≥ ${FREEZE_MIN_DIFF}°`,
      `${controlDelta}°`,
      controlDelta >= FREEZE_MIN_DIFF,
    ),
  );

  // ---- 6. 转场：画面确实被混过，而且混的比例对得上 ----
  //
  // 两条一起才有意义。只比"预览 == 导出"的话，**整个转场被丢掉时它照样绿**——
  // 两条路径共用同一份取样映射，一起丢掉当然还是一致（同 D17 那条"摆位真的在变"）。
  // 所以先证明画面被改过（对照没挂转场的同一帧），再证明改成了该有的样子
  // （对照两个纯层按进度加权算出来的参照值）。
  for (const frame of DISSOLVE_PROBES) {
    const actual = previewBands.get(frame)!;
    const bare = noTransition.get(frame)!;
    const from = pureFrom.get(frame)!;
    const to = pureTo.get(frame)!;
    // 与 transitionProgress() 同一个公式：帧中点采样
    const t = (frame - WIN_IN + 0.5) / TRANSITION_FRAMES;
    const expected = {
      meanR: from.meanR * (1 - t) + to.meanR * t,
      meanG: from.meanG * (1 - t) + to.meanG * t,
      meanB: from.meanB * (1 - t) + to.meanB * t,
    };
    const blended = rgbDistance(actual, bare);
    const offBy = rgbDistance(actual, expected);
    // 交界两侧靠外的取样帧本来就接近单层，那两帧不要求"差得多"
    const nearJunction = Math.abs(frame - D_IN) <= 2;
    if (nearJunction) {
      checks.push(
        check(
          `帧 ${frame} 的画面确实是混出来的（对照没挂转场的同一帧）`,
          `每通道 Δ ≥ ${BLEND_MIN_DIFF}`,
          blended,
          blended >= BLEND_MIN_DIFF,
        ),
      );
    }
    checks.push(
      check(
        `帧 ${frame} 的混合比例落在 (1-t)·出场 + t·入场 上（t=${t.toFixed(3)}）`,
        `每通道 Δ ≤ ${BLEND_TOLERANCE}`,
        offBy,
        offBy <= BLEND_TOLERANCE,
      ),
    );
  }

  // 窗口外必须回到单层：窗口算宽了会让溶解漫出剪切点，而那不报错
  const beforeWindow = rows.find((r) => r.frame === WIN_IN - 5)!;
  const afterWindow = rows.find((r) => r.frame === WIN_OUT + 5)!;
  checks.push(
    check(
      "转场窗口之外恢复单层（窗口没有漫出去）",
      `${sampleHueAt(C_SOURCE_IN + WIN_IN - 5 - C_IN, SOURCE_FRAMES)}° / ${sampleHueAt(D_SOURCE_IN + WIN_OUT + 5 - D_IN, SOURCE_FRAMES)}°`,
      `${beforeWindow.exportedHue}° / ${afterWindow.exportedHue}°`,
      hueDistance(
        beforeWindow.exportedHue,
        sampleHueAt(C_SOURCE_IN + WIN_IN - 5 - C_IN, SOURCE_FRAMES),
      ) <= HUE_TOLERANCE &&
        hueDistance(
          afterWindow.exportedHue,
          sampleHueAt(D_SOURCE_IN + WIN_OUT + 5 - D_IN, SOURCE_FRAMES),
        ) <= HUE_TOLERANCE,
    ),
  );

  // ---- 7. shader 转场（擦除）：边界两侧各是哪一层，两条路径都要对上 ----
  //
  // 这是**只有这个自检能验的东西**。逐像素的混合算术由 Pixi spike 里的
  // GPU-vs-CPU 断言管；这里管的是整条导出路径：reader 有没有解出第二层、
  // Worker 里的合成器有没有收到转场节点、边界落在画面的哪一处。
  //
  // 擦除是**空间**上的分区，所以用 D6 的分区测量：左块应当整块是入场层 E 的
  // 色相、右块整块是出场层 D 的。这一条同时钉住了三件事——方向（左→右）、
  // 角色（谁进谁出）、以及进度到边界位置的映射。
  const wipeProgress = (WIPE_PROBE - WIPE_WIN_IN + 0.5) / WIPE_FRAMES;
  const wipeIncomingHue = sampleHueAt(E_SOURCE_IN + WIPE_PROBE - E_IN, SOURCE_FRAMES);
  const wipeOutgoingHue = sampleHueAt(D_SOURCE_IN + WIPE_PROBE - D_IN, SOURCE_FRAMES);
  for (const [pathName, bands] of [
    ["预览", previewWipe],
    ["导出", exportedWipe],
  ] as const) {
    if (!bands) {
      checks.push(check(`擦除·${pathName}分区测量`, "有数据", "缺失", false));
      continue;
    }
    checks.push(
      check(
        `擦除·${pathName}：边界左侧是入场层 E（t=${wipeProgress.toFixed(3)}）`,
        `色相 ${wipeIncomingHue}° ±${HUE_TOLERANCE}`,
        `${bands.left.hue}°`,
        hueDistance(bands.left.hue, wipeIncomingHue) <= HUE_TOLERANCE,
      ),
    );
    checks.push(
      check(
        `擦除·${pathName}：边界右侧仍是出场层 D`,
        `色相 ${wipeOutgoingHue}° ±${HUE_TOLERANCE}`,
        `${bands.right.hue}°`,
        hueDistance(bands.right.hue, wipeOutgoingHue) <= HUE_TOLERANCE,
      ),
    );
  }
  // 两侧必须**不同**。整个转场退化成"只画一层"时，上面四条里会有两条仍然绿
  // （那一层恰好是被断言的那个），只有这一条能一次抓住
  if (previewWipe) {
    checks.push(
      check(
        "擦除：边界两侧确实是不同的两层（没有退化成单层）",
        `色相相差 > ${HUE_TOLERANCE}°`,
        `${hueDistance(previewWipe.left.hue, previewWipe.right.hue)}°`,
        hueDistance(previewWipe.left.hue, previewWipe.right.hue) > HUE_TOLERANCE,
      ),
    );
  }

  // 确实产生了留边，否则几何比对是空的
  const first = rows[0]!;
  checks.push(
    check(
      "确实产生了留边（方形输出 + 16:9 源片）",
      "> 0",
      first.exportedBands,
      previewBands.get(PROBES[0]!.frame)!.top > 0,
    ),
  );

  return {
    checks,
    passed: checks.every((c) => c.pass),
    rows,
    encodedFrames: exported.encodedFrames,
    bytesWritten: exported.bytesWritten,
    elapsedMs: performance.now() - startedAt,
  };
}
