/**
 * M0 验收脚本：生成 → 探测 → trim 导出 → 读回断言。
 *
 * 这是 M0 的验收标准本身，不是一次性调试代码——改动管道后重跑它，
 * 能立刻发现帧数、时长、音轨、trim 起点是否被改坏。
 *
 * 之所以要"读回断言"而不是只看导出成功：帧数少一帧、trim 起点偏一帧、
 * 音轨丢失这些问题都不会让导出报错，只会静默产出错误的片子。
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  BlobSource,
  Input,
  VideoSampleSink,
  type InputAudioTrack,
} from "mediabunny";
import { makeSampleVideo } from "./make-sample";
import { probeFile } from "../media/probe";
import { startExport } from "../export/client";
import { readExportFile, removeExportFile } from "../export/write-target";
import { singleClipTimeline, type Timeline } from "../edl/types";
import { crossfadeGain } from "../audio/crossfade";
import { FPS, toNumber } from "../time/rational";
import { frameToSeconds } from "../time/timebase";

/** 自检导出的落盘文件名。固定名字，每次跑覆盖上一次。 */
const VERIFY_OUT = "kerf-verify-m0.mp4";

export interface Check {
  readonly name: string;
  readonly pass: boolean;
  readonly expected: string;
  readonly actual: string;
}

export interface VerifyResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
  readonly elapsedMs: number;
  readonly exportedBytes: number;
  readonly realtimeFactor: number;
}

function check(name: string, expected: unknown, actual: unknown, pass?: boolean): Check {
  return {
    name,
    expected: String(expected),
    actual: String(actual),
    pass: pass ?? String(expected) === String(actual),
  };
}

export interface VerifyOptions {
  readonly totalFrames?: number;
  readonly inFrame?: number;
  readonly outFrame?: number;
  /** 传入两个 canvas 时，会把导出结果的首帧/末帧画上去供肉眼核对水印。 */
  readonly firstFrameCanvas?: HTMLCanvasElement | undefined;
  readonly lastFrameCanvas?: HTMLCanvasElement | undefined;
}

export async function verifyM0(options: VerifyOptions = {}): Promise<VerifyResult> {
  const totalFrames = options.totalFrames ?? 300;
  const inFrame = options.inFrame ?? 90;
  const outFrame = options.outFrame ?? 210;
  const expectedFrames = outFrame - inFrame;
  const startedAt = performance.now();
  const checks: Check[] = [];

  // ---- 1. 生成素材 ----
  const sample = await makeSampleVideo({ durationFrames: totalFrames, withAudio: true });

  // ---- 2. 探测 ----
  const probe = await probeFile(sample.file);
  checks.push(check("探测帧率分子", 30000, probe.source.fps.num));
  checks.push(check("探测帧率分母", 1001, probe.source.fps.den));
  checks.push(
    check(
      "探测帧数（须按视频轨算，不受 AAC padding 影响）",
      totalFrames,
      probe.source.durationFrames,
    ),
  );
  checks.push(check("探测到音轨", true, probe.source.hasAudio));
  checks.push(
    check(
      "容器时长长于视频轨（AAC padding 存在的证据）",
      "containerSeconds >= durationSeconds",
      `${probe.containerSeconds.toFixed(3)} vs ${probe.durationSeconds.toFixed(3)}`,
      probe.containerSeconds >= probe.durationSeconds,
    ),
  );

  // ---- 3. 导出 trim 区间 ----
  // "导出源片 90–210 帧"翻译成 EDL 就是"一个 sourceIn=90、长 120 帧的片段，整条导出"
  const timeline = singleClipTimeline(probe.source, { inFrame, outFrame });
  await removeExportFile(VERIFY_OUT);
  const handle = startExport(
    {
      timeline,
      range: { inFrame: 0, outFrame: timeline.durationFrames },
      container: "mp4",
      videoBitrate: 6e6,
      audioBitrate: 128e3,
      includeAudio: true,
      target: { kind: "opfs", name: VERIFY_OUT },
      // 自检不该往用户的下载目录里扔文件
      autoDownload: false,
    },
    () => undefined,
  );
  const exported = await handle.done;
  if (!exported) throw new Error("导出被取消，无法验收");

  checks.push(
    check(
      "EDL 片段长度等于 trim 区间",
      expectedFrames,
      timeline.durationFrames,
    ),
  );

  checks.push(check("导出帧数", expectedFrames, exported.encodedFrames));
  checks.push(check("导出含音频", true, exported.audioIncluded));

  // **补偿量本身要印出来。** 下面那条"导出没有移动音频"红的时候，光知道偏了多少
  // 没法往下查——真正要看的是"测出来的延迟是多少、可不可信"。iOS 18.7 上那条红了
  // 9.3ms，而残留 9.3ms 与"完全没补偿"（约 44ms）是两个完全不同的结论：前者说明
  // 测量偏了几百个样本，后者说明测量整个失败了。不印这个数就分不出来
  {
    const d = exported.audioEncoderDelay;
    const ms = d.sampleRate > 0 ? (d.samples / d.sampleRate) * 1000 : 0;
    checks.push(
      check(
        "编码延迟测出来了（补偿量与可信度）",
        "reason 为空",
        `${d.samples} 样本 = ${ms.toFixed(1)}ms @ ${d.sampleRate}Hz · 相关性 ${d.correlation.toFixed(2)}` +
          (d.reason ? ` · 未测成：${d.reason}` : ""),
        d.reason === undefined,
      ),
    );
  }

  const realtimeFactor =
    frameToSeconds(exported.encodedFrames, probe.source.fps) / (exported.elapsedMs / 1000);
  checks.push(
    check("导出快于实时", "> 1×", `${realtimeFactor.toFixed(2)}×`, realtimeFactor > 1),
  );

  // ---- 4. 读回导出文件断言 ----
  // 从 OPFS 读回而不是从内存：管道已改成流式写盘，不再回传字节（硬规则 9）。
  // 顺带也验证了写盘路径本身是通的——落盘失败会在这里读不出文件。
  const outFile = await readExportFile(VERIFY_OUT);
  checks.push(
    check("落盘字节数与管道报告一致", exported.bytesWritten, outFile.size),
  );
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(outFile) });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("导出文件里没有视频轨");
    const audioTrack = await input.getPrimaryAudioTrack();

    // 全量包统计：导出文件不大，packetCount 就是精确帧数
    const stats = await videoTrack.computePacketStats();
    checks.push(check("读回视频帧数", expectedFrames, stats.packetCount));

    const videoSeconds = await videoTrack.computeDuration();
    const expectedSeconds = frameToSeconds(expectedFrames, FPS.ndf2997);
    checks.push(
      check(
        "读回视频时长（秒）",
        expectedSeconds.toFixed(3),
        videoSeconds.toFixed(3),
        Math.abs(videoSeconds - expectedSeconds) < 0.05,
      ),
    );

    checks.push(check("读回音轨存在", true, audioTrack !== null));

    const readBackFps = (await videoTrack.computePacketStats()).averagePacketRate;
    checks.push(
      check(
        "读回帧率接近 29.97",
        "|Δ| < 0.05",
        readBackFps.toFixed(4),
        Math.abs(readBackFps - toNumber(FPS.ndf2997)) < 0.05,
      ),
    );

    // 首帧时间戳必须归零：导出是新的时间轴，不能继承源片的 in 点偏移
    const sink = new VideoSampleSink(videoTrack);
    const first = await sink.getSample(0);
    if (!first) throw new Error("读不出导出文件的首帧");
    checks.push(
      check("首帧时间戳归零", "< 0.001s", first.timestamp.toFixed(4), Math.abs(first.timestamp) < 0.001),
    );
    drawTo(options.firstFrameCanvas, first);
    first.close();

    // 取帧按**帧中点**查询：帧号换算成秒有微秒取整误差，按帧起点查询容易
    // 落回前一帧。加半帧后查询点稳定落在目标帧区间内部。
    // （管道内部的同类问题由 pipeline.ts 的 ALIGN_EPSILON_SECONDS 解决。）
    const halfFrame = frameToSeconds(1, FPS.ndf2997) / 2;
    const lastTs = frameToSeconds(expectedFrames - 1, FPS.ndf2997) + halfFrame;
    const last = await sink.getSample(lastTs);
    if (last) {
      drawTo(options.lastFrameCanvas, last);
      last.close();
    }
    checks.push(check("能取到末帧", true, last !== null));

    // ---- 音画同步：导出这一步不许把音频挪位置 ----
    //
    // 抓的是 AAC 编码延迟没被补偿那一类错误（实测 2112 样本 = 44ms，而且每导出
    // 一次叠加一次）。做法是**同一个判据量两遍**：素材里第一声在哪、成片里第一声
    // 在哪，两者的差应当正好等于 trim 的入点。量素材而不是拿理论值比，是因为素材
    // 本身也是 AAC 编的、自己就带着一份 priming 偏移——只有两边同口径才问得出
    // "导出**改变**了多少"这个真问题。
    //
    // 从入点后 0.5 秒起找，避开成片开头那 44ms priming 区（那一段无论如何都不是
    // 有效音频，在里面找会量到编码器的爬升而不是提示音）。
    if (audioTrack) {
      const inSeconds = frameToSeconds(inFrame, FPS.ndf2997);
      const sourceInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(sample.file) });
      try {
        const sourceAudio = await sourceInput.getPrimaryAudioTrack();
        // 两边都整轨从 0 解，不 seek——见 `decodeTrackToPcm` 的注释
        const srcAudio = sourceAudio ? await decodeTrackToPcm(sourceAudio, inSeconds + 3) : null;
        const outAudio = await decodeTrackToPcm(audioTrack, expectedSeconds + 1);
        const srcOnset = srcAudio ? firstOnsetAfter(srcAudio, inSeconds + 0.5) : null;
        const outOnset = firstOnsetAfter(outAudio, 0.5);
        const expectedOnset = srcOnset === null ? null : srcOnset - inSeconds;
        const drift =
          outOnset === null || expectedOnset === null ? null : outOnset - expectedOnset;
        checks.push(
          check(
            "导出没有移动音频（AAC 编码延迟已补偿）",
            "|Δ| < 5ms",
            drift === null ? "量不到提示音" : `${(drift * 1000).toFixed(1)}ms`,
            drift !== null && Math.abs(drift) < 0.005,
          ),
        );
        // **把两个操作数都印出来。** 只报差值时，"素材那边量歪了"和"成片真的被
        // 挪了"长得一模一样，而这两个的处置完全不同。Safari 上这条红 9.3ms 而
        // 编码/封装/解封装三条路各自量出来都是 2112 样本、残留 0，所以偏移一定
        // 出在这两个读数之一，不在补偿上
        checks.push(
          check(
            "音画同步的两个操作数（诊断用）",
            "素材与成片的提示音位置",
            `素材 ${srcOnset === null ? "?" : (srcOnset * 1000).toFixed(1)}ms` +
              ` − 入点 ${(inSeconds * 1000).toFixed(1)}ms` +
              ` = 期望 ${expectedOnset === null ? "?" : (expectedOnset * 1000).toFixed(1)}ms` +
              ` · 成片 ${outOnset === null ? "?" : (outOnset * 1000).toFixed(1)}ms`,
            srcOnset !== null && outOnset !== null,
          ),
        );
      } finally {
        sourceInput.dispose();
      }
    }
  } finally {
    input.dispose();
  }

  // ---- 5. 音频交叉淡化 ----
  checks.push(...(await verifyCrossfade()));

  return {
    checks,
    passed: checks.every((c) => c.pass),
    elapsedMs: performance.now() - startedAt,
    exportedBytes: exported.bytesWritten,
    realtimeFactor,
  };
}

// ---------------------------------------------------------------------------
// 音频交叉淡化
// ---------------------------------------------------------------------------

const XFADE_OUT = "kerf-verify-xfade.mp4";
/** 淡化窗口时长（帧），偶数。20 帧 @29.97 ≈ 0.667 秒，够放下三个取样点。 */
const XFADE_FRAMES = 20;
/** 每段片段的长度（帧）。 */
const SEG = 60;
/** 取样窗口，秒。1kHz 上 40ms 有 40 个周期，RMS 已经很稳。 */
const RMS_WINDOW = 0.04;

/**
 * 曲线取样点（窗口进度）。**刻意不取 0 和 1**：那两点上曲线值是 1 和 0，
 * 而"整条包络被丢掉"和"端点正确"在那里区分不开。
 */
const XFADE_PROBES = [0.25, 0.5, 0.75] as const;

/**
 * 增益比值的容差。**两侧都是量出来的，不是估的。**
 *
 * 破坏侧最轻的一档是"整条包络被丢掉"（比值恒为 1）在 t=0.25 上的偏差：
 * 1 − 0.924 = **0.076**。容差必须小于它，否则最轻的破坏漏网。
 *
 * 健康侧实测 **0.008**（三个取样点上的最大偏差；另用 21 点密集扫过整个窗口
 * 交叉验证过，最大 0.010，两个口径一致）。
 *
 * 这两个数之间一度只有 0.033 vs 0.076，因为 `rmsAround` 漏了跨窗口起点的那个
 * 包——那是**量法的偏差，不是被测对象的**，而它看起来和真实误差一模一样。
 * 密集扫描是把两者分开的唯一办法，见 `rmsAround` 的注释。
 *
 * 取 0.03：离健康值 3.75×，离最轻的破坏 2.5×。
 *
 * **Safari / iOS 上曾经红过一次（淡出 t=0.75 实测 0.420，偏差 0.037），但根因不在
 * 这个数上，也不在产品里。** 当时六个取样点拟合出一致的"包络偏晚"，同一次运行里
 * "导出没有移动音频"也独立报了 9.3ms，于是两条红被判成同一个产品 bug。真正的原因是
 * **测量函数 seek 之后读到的时间戳在 Safari 上偏 9.3ms**——成片本身三个提示音位置
 * 偏移全是 0。改成整轨从 0 解（`decodeTrackToPcm`）之后两条都绿了。
 *
 * 所以这个容差没动过，也**不该**为了让某个浏览器变绿而动它。
 */
const XFADE_TOLERANCE = 0.03;

/**
 * 交叉淡化的端到端断言：导出一段带淡化的音频，读回来量包络。
 *
 * ## 怎么把两条曲线各自单独量出来
 *
 * 交叉淡化的成片是两层相加，直接量只能得到"和"，而和是平的（等功率的意义就在
 * 于此），**恰恰看不出任何一条曲线**。所以这里让每个窗口里只有一层有声音：
 *
 * ```
 *   A（有声）│ B（无声源）│ C（有声）
 *          交界1        交界2
 * ```
 *
 * 交界 1 的窗口里只有 A 在响 → 量到的就是**淡出**曲线；交界 2 的窗口里只有 C
 * 在响 → 量到的就是**淡入**曲线。B 用一个 `withAudio:false` 的素材，于是它连
 * 排期都进不去（`planAudioJobs` 会跳过没有音轨的源片），比"用一段静音素材"更干净。
 *
 * ## 为什么素材要用连续音
 *
 * 缺省的每秒一声提示音在 0.667 秒的窗口里可能一声都没有，那时 RMS 全是 0，
 * 三条断言会**同时通过**（0 和 0 比较总是相等）——测的是运气不是代码。
 */
async function verifyCrossfade(): Promise<Check[]> {
  const checks: Check[] = [];
  const total = SEG * 3;

  const toneSample = await makeSampleVideo({
    durationFrames: total,
    withAudio: true,
    audioShape: "tone",
  });
  const muteSample = await makeSampleVideo({ durationFrames: SEG, withAudio: false });
  const tone = (await probeFile(toneSample.file)).source;
  const mute = (await probeFile(muteSample.file)).source;

  const xfade = { kind: "xfade-power", frames: XFADE_FRAMES } as const;
  const timeline: Timeline = {
    fps: tone.fps,
    width: tone.width,
    height: tone.height,
    durationFrames: total,
    sources: [tone, mute],
    tracks: [
      {
        id: "V1",
        kind: "video",
        clips: [
          {
            id: "v",
            kind: "media",
            sourceId: tone.id,
            timelineIn: 0,
            timelineOut: total,
            sourceIn: 0,
          },
        ],
      },
      {
        id: "A1",
        kind: "audio",
        clips: [
          { id: "a", kind: "media", sourceId: tone.id, timelineIn: 0, timelineOut: SEG, sourceIn: 0 },
          {
            id: "b",
            kind: "media",
            sourceId: mute.id,
            timelineIn: SEG,
            timelineOut: SEG * 2,
            sourceIn: 0,
            transitionIn: xfade,
          },
          {
            id: "c",
            kind: "media",
            sourceId: tone.id,
            timelineIn: SEG * 2,
            timelineOut: total,
            // 入点往里让 10 帧，好让窗口借得到真实素材而不是静音
            sourceIn: SEG * 2 + XFADE_FRAMES,
            transitionIn: xfade,
          },
        ],
      },
    ],
  };

  await removeExportFile(XFADE_OUT);
  const done = await startExport(
    {
      timeline,
      range: { inFrame: 0, outFrame: total },
      container: "mp4",
      videoBitrate: 4e6,
      audioBitrate: 128e3,
      includeAudio: true,
      target: { kind: "opfs", name: XFADE_OUT },
      autoDownload: false,
    },
    () => undefined,
  ).done;
  if (!done) throw new Error("交叉淡化自检的导出被取消");

  const file = await readExportFile(XFADE_OUT);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error("交叉淡化自检的成片里没有音轨");
    const at = (frames: number) => frameToSeconds(frames, tone.fps);
    // 整轨解一次，后面所有取样都是纯数组索引（不 seek，见 `decodeTrackToPcm`）
    const audio = await decodeTrackToPcm(track, at(total) + 1);

    // 参照值取 A 段正中间，那里没有任何包络
    const reference = rmsAround(audio, at(SEG / 2), RMS_WINDOW);
    checks.push(
      check(
        "淡化自检：参照段有声音",
        "> 0.05",
        reference.toFixed(4),
        reference > 0.05,
      ),
    );

    for (const role of ["from", "to"] as const) {
      // 交界 1 = SEG（A→B，只有 A 在响）；交界 2 = SEG*2（B→C，只有 C 在响）
      const junction = role === "from" ? SEG : SEG * 2;
      const windowStart = junction - XFADE_FRAMES / 2;
      const ratios: number[] = [];

      for (const t of XFADE_PROBES) {
        const centre = at(windowStart + XFADE_FRAMES * t);
        const measured = rmsAround(audio, centre, RMS_WINDOW);
        const ratio = measured / reference;
        ratios.push(ratio);
        const expected = crossfadeGain("xfade-power", role, t);
        checks.push(
          check(
            `淡化自检：${role === "from" ? "淡出" : "淡入"}曲线 t=${t}`,
            expected.toFixed(3),
            ratio.toFixed(3),
            Math.abs(ratio - expected) < XFADE_TOLERANCE,
          ),
        );
      }

      // 三个点落在参照值上还不够：整条包络被丢掉时它们会**一起**变成 1，
      // 而那时上面三条里 t=0.25 那条只差 0.08，容差稍微放松就抓不住。
      // 这一条要的是"包络真的在动"，判据与曲线形状无关
      const spread = Math.max(...ratios) - Math.min(...ratios);
      checks.push(
        check(
          `淡化自检：${role === "from" ? "淡出" : "淡入"}包络确实在变化`,
          "> 0.3",
          spread.toFixed(3),
          spread > 0.3,
        ),
      );
    }
  } finally {
    input.dispose();
  }

  return checks;
}

/**
 * 把整条音轨**从 0 解一次**，摆进按绝对样本位置索引的缓冲区。
 *
 * ## 为什么必须从 0 解，不能 seek 到关心的那一段
 *
 * 这不是性能取舍，是正确性。原来两个测量函数都 `sink.samples(from, …)` 直接
 * seek 进去，再用 `audioSample.timestamp` 定位——**在 Safari 上那个时间戳偏
 * 9.3ms**（实测：同一个文件、只改"从 0 读"还是"seek 到 0.5 秒再读"这一个变量，
 * 前者 1041.0ms、后者 1050.4ms；Chrome 两种都是 1041.0ms）。
 *
 * 那 9.3ms 一度被当成**产品的音画同步 bug**：M0 第 17 项在 Safari / iOS 上红，
 * 而交叉淡化的包络断言也跟着红，六个取样点还拟合出了一致的"包络偏晚"。两条红
 * 确实是同一个根因，但根因在**读法**里——真实成片的三个提示音位置逐个量下来
 * 偏移都是 **0**（1041 / 2041 / 3041ms），编解码、封装、解封装三条路各自的
 * priming 都是 2112 样本，Chrome 与 Safari 一模一样。
 *
 * 教训：**跨浏览器的红，先把"量法"从"被测对象"里剥出来**。做法就是只改一个
 * 变量重测一次——这里是"要不要 seek"。
 *
 * 自检的素材只有几秒，整轨解一次的代价可以忽略；换来的是所有测量都变成纯数组
 * 索引，彻底不依赖 seek 语义。
 */
async function decodeTrackToPcm(
  track: InputAudioTrack,
  maxSeconds: number,
): Promise<{ readonly pcm: Float32Array; readonly rate: number }> {
  const rate = await track.getSampleRate();
  const pcm = new Float32Array(Math.ceil(maxSeconds * rate));
  const sink = new AudioSampleSink(track);
  for await (const audioSample of sink.samples(0, maxSeconds)) {
    try {
      const buffer = audioSample.toAudioBuffer();
      const data = buffer.getChannelData(0);
      const offset = Math.round(audioSample.timestamp * rate);
      for (let i = 0; i < data.length; i++) {
        const j = offset + i;
        if (j >= 0 && j < pcm.length) pcm[j] = data[i]!;
      }
    } finally {
      audioSample.close();
    }
  }
  return { pcm, rate };
}

/**
 * `centre` 前后各半个 `window` 的 RMS。
 *
 * 用 RMS 而不是峰值：AAC 是有损的，单个样本的幅度会抖，而 40ms 上的能量很稳。
 * 窗口边界按样本精确切，不受解码包边界影响——包络正在变化时，窗口宽度浮动
 * 就成了系统误差。
 */
function rmsAround(
  audio: { readonly pcm: Float32Array; readonly rate: number },
  centre: number,
  window: number,
): number {
  const half = (window * audio.rate) / 2;
  const from = Math.max(0, Math.round(centre * audio.rate - half));
  const to = Math.min(audio.pcm.length, Math.round(centre * audio.rate + half));
  let sum = 0;
  let count = 0;
  for (let i = from; i < to; i++) {
    sum += audio.pcm[i]! * audio.pcm[i]!;
    count++;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** 高于这个绝对值就算"响了"。测试素材的提示音幅度 0.25，静音段是精确的 0。 */
const ONSET_THRESHOLD = 0.05;

/**
 * 找 `from` 之后第一个"响起来"的时刻（秒），找不到返回 null。
 *
 * **与 `make-sample.ts` 的配音耦合**：它每秒前 80ms 打一声 1kHz、其余为静音，
 * 所以"第一个超过阈值的样本"就是那一声的起点。改配音的占空比或幅度要回来看这里，
 * 和 `sampleHueAt` 依赖背景色相是同一类耦合。
 */
function firstOnsetAfter(
  audio: { readonly pcm: Float32Array; readonly rate: number },
  from: number,
): number | null {
  for (let i = Math.max(0, Math.round(from * audio.rate)); i < audio.pcm.length; i++) {
    if (Math.abs(audio.pcm[i]!) > ONSET_THRESHOLD) return i / audio.rate;
  }
  return null;
}

function drawTo(canvas: HTMLCanvasElement | undefined, sample: { toVideoFrame(): VideoFrame }): void {
  if (!canvas) return;
  const frame = sample.toVideoFrame();
  try {
    canvas.width = frame.displayWidth;
    canvas.height = frame.displayHeight;
    const ctx = canvas.getContext("2d");
    ctx?.drawImage(frame, 0, 0);
  } finally {
    frame.close();
  }
}
