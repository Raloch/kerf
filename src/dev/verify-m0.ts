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
import { makeSampleAudio, makeSampleVideo } from "./make-sample";
import { probeAvFile, probeFile } from "../media/probe";
import { startExport } from "../export/client";
import { readExportFile, removeExportFile } from "../export/write-target";
import {
  singleClipTimeline,
  sourceDurationFrames,
  type AvSource,
  type Clip,
  type Timeline,
} from "../edl/types";
import { addSource } from "../state/operations";
import { EMPTY_TIMELINE } from "../state/timeline-store";
import { crossfadeGain } from "../audio/crossfade";
import { createMixer, MIX_CHANNELS, MIX_SAMPLE_RATE } from "../audio/mixdown";
import { formatBytes, residency } from "../export/residency";
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
  const probe = await probeAvFile(sample.file);
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

  // ---- 6. 预览听到的 == 成片里的（D26 欠的那条护栏）----
  // 用 M0 那条素材的时间轴：缺省的 `beeps` 每秒一声、其余静音，那个静音 → 有声的
  // 沿正是对齐要用的东西（见 `verifyPreviewAudio` 的"对齐用起始沿"）
  checks.push(...(await verifyPreviewAudio(singleClipTimeline(probe.source))));

  // ---- 7. 纯音频素材（配乐）----
  checks.push(...(await verifyAudioOnlySource()));

  return {
    checks,
    passed: checks.every((c) => c.pass),
    elapsedMs: performance.now() - startedAt,
    exportedBytes: exported.bytesWritten,
    realtimeFactor,
  };
}

// ---------------------------------------------------------------------------
// 纯音频素材（配乐）
// ---------------------------------------------------------------------------

const MUSIC_OUT = "kerf-verify-music.mp4";
/** 配乐素材长度（秒）。每秒一声 1kHz，见 `MUSIC_TRIMMED_SOURCE_IN`。 */
const MUSIC_SECONDS = 4;
/** 整段配乐放在第几帧。刻意不是 0——放在 0 时"整体平移"和"没平移"给出同一个位置。 */
const MUSIC_START_FRAME = 30;
/**
 * 第二个配乐片段的 `sourceIn`（帧，按项目帧率的栅格）。
 *
 * **这个片段存在的唯一理由是让帧栅格真正参与运算。** 第一版只有一个 `sourceIn:0`
 * 的片段，而 `sourceMicrosAt` 是 `frameToMicros(sourceIn, 栅格) + …`——`sourceIn`
 * 为 0 时**栅格被乘以零**，那条起始沿断言其实一次都没碰到 `sourceGridFps`。
 * 同「挑用例时要先问被测的那个量在这里是不是恰好等于零/一」。
 *
 * 75 帧 ≈ 2.5 秒，**必须落在两声之间的静音里**：落在某一声内部的话
 * `firstOnsetAfter` 会立刻在取样起点上找到"正在响"，量出来的位置就等于取样起点
 * 本身、不含任何"取到了源片哪一刻"的信息（那时断言恒真）。
 */
const MUSIC_TRIMMED_SOURCE_IN = 75;
/** 第二个片段放在第几帧，要和第一个错开不重叠。 */
const MUSIC_TRIMMED_START_FRAME = 200;
/** 整条时间轴（画面）长度，比配乐结束得晚，好让"之后是静音"有地方可量。 */
const MUSIC_TOTAL_FRAMES = 300;
/**
 * 起始沿容差。
 *
 * 判据是"成片里的第一声 − 配乐被放的那一帧 == 配乐素材自己的第一声"，两边同口径，
 * 所以容差可以收得和"导出没有移动音频"一样紧（5ms）。它要抓的是错一帧（33ms）和
 * 栅格用错（29.97 与项目帧率的差会累积成上百毫秒），两者都远在容差之外。
 */
const MUSIC_ONSET_TOLERANCE = 0.005;

/**
 * 纯音频素材从导入到成片的整条链路。
 *
 * 这条护栏钉的是**静默失败**：配乐没进成片、或者进错了位置，导出侧一切正常
 * （不抛错、泄漏为 0、帧数对得上），只有听才听得出来。三个真实的出错点是
 * 排期用错帧栅格（`sourceGridFps`）、混流跳过它（`hasAudio`）、以及导出的逐帧
 * 循环拿一个没有视频轨的文件去开解码游标。
 *
 * 画面素材刻意**不带音轨**（`withAudio:false`）：那样成片里的每一点声音都只能来自
 * 配乐，"有没有信号"这个判据才是干净的。同「给音频断言做隔离」那条。
 */
async function verifyAudioOnlySource(): Promise<Check[]> {
  const checks: Check[] = [];

  const videoSample = await makeSampleVideo({
    durationFrames: MUSIC_TOTAL_FRAMES,
    withAudio: false,
  });
  // `beeps` 而不是 `tone`：连续音上"裁过入点的片段取错了内容"完全测不出来
  const musicSample = await makeSampleAudio({ seconds: MUSIC_SECONDS, shape: "beeps" });
  const video = (await probeAvFile(videoSample.file)).source;
  const musicProbe = await probeFile(musicSample.file);
  const music = musicProbe.source;

  checks.push(
    check(
      "配乐：探针认出这是纯音频素材",
      `kind:"audio" · ${musicSample.sampleRate}Hz · ${musicSample.channels} 声道`,
      music.kind === "audio"
        ? `kind:"audio" · ${music.sampleRate}Hz · ${music.channels} 声道`
        : `kind:"${music.kind}"`,
      music.kind === "audio" &&
        music.sampleRate === musicSample.sampleRate &&
        music.channels === musicSample.channels,
    ),
  );

  // **走真正的编辑入口**，不手搓时间轴：那样"配乐落在哪条轨、长度按哪个帧率算"
  // 也一起进了被测范围（手搓的话这两件事就是我自己写进去的答案）
  const placedVideo = addSource(EMPTY_TIMELINE, { source: video, timelineIn: 0 });
  const placed = addSource(placedVideo.timeline, {
    source: music,
    timelineIn: MUSIC_START_FRAME,
  });
  if (!placed.changed) throw new Error(`配乐自检放不下片段：${placed.reason ?? "未知原因"}`);

  const expectedFrames = sourceDurationFrames(music, placed.timeline.fps);
  // **第二个片段手搓**，因为它要有非零 `sourceIn`，而 `addSource` 只会整段放。
  // 编辑入口本身由上面那次调用和 `operations.test.ts` 覆盖
  const trimmed: Clip = {
    id: "music-trimmed",
    kind: "media",
    sourceId: music.id,
    name: "配乐（裁过入点）",
    timelineIn: MUSIC_TRIMMED_START_FRAME,
    timelineOut: MUSIC_TRIMMED_START_FRAME + expectedFrames - MUSIC_TRIMMED_SOURCE_IN,
    sourceIn: MUSIC_TRIMMED_SOURCE_IN,
  };
  const timeline: Timeline = {
    ...placed.timeline,
    durationFrames: MUSIC_TOTAL_FRAMES,
    tracks: placed.timeline.tracks.map((t) =>
      t.id === "A1" ? { ...t, clips: [...t.clips, trimmed] } : t,
    ),
  };

  const musicClip = timeline.tracks
    .filter((t) => t.kind === "audio")
    .flatMap((t) => t.clips.map((c) => ({ trackId: t.id, clip: c })))
    .find((x) => x.clip.id === `${music.id}-a`);
  checks.push(
    check(
      "配乐：落在第一条音频轨上，长度按项目帧率派生",
      `A1 · ${expectedFrames} 帧`,
      musicClip
        ? `${musicClip.trackId} · ${musicClip.clip.timelineOut - musicClip.clip.timelineIn} 帧`
        : "没放上去",
      musicClip?.trackId === "A1" &&
        musicClip.clip.timelineOut - musicClip.clip.timelineIn === expectedFrames,
    ),
  );
  checks.push(
    check(
      "配乐：不产生画面片段（纯音频素材没有像素）",
      "画面轨上只有那段视频",
      `${timeline.tracks
        .filter((t) => t.kind === "video")
        .reduce((n, t) => n + t.clips.length, 0)} 个画面片段`,
      timeline.tracks
        .filter((t) => t.kind === "video")
        .every((t) => t.clips.every((c) => c.kind === "media" && c.sourceId === video.id)),
    ),
  );

  await removeExportFile(MUSIC_OUT);
  const run = startExport(
    {
      timeline,
      range: { inFrame: 0, outFrame: MUSIC_TOTAL_FRAMES },
      container: "mp4",
      videoBitrate: 4e6,
      audioBitrate: 128e3,
      includeAudio: true,
      target: { kind: "opfs", name: MUSIC_OUT },
      autoDownload: false,
    },
    () => undefined,
  );
  const done = await run.done;
  if (!done) throw new Error("配乐自检的导出被取消");

  const r = done.residency;
  const leaked = r.leakedSamples + r.leakedCursors + r.leakedInputs;
  checks.push(
    check(
      "配乐：导出没有为它开解码游标（泄漏为 0）",
      "leaked 0",
      `帧 ${r.leakedSamples} · 游标 ${r.leakedCursors} · Input ${r.leakedInputs}`,
      leaked === 0,
    ),
  );

  const file = await readExportFile(MUSIC_OUT);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    // **不抛**：抛掉的话上面那几条读数一起丢，而"落在哪条轨、长度多少、泄漏多少"
    // 正是查"为什么没进去"要看的东西。同「断言红了但没有诊断，等于只知道坏了」
    if (!track) {
      checks.push(check("配乐：成片里有音轨", true, false));
      return checks;
    }
    const at = (frames: number) => frameToSeconds(frames, timeline.fps);
    const audio = await decodeTrackToPcm(track, at(MUSIC_TOTAL_FRAMES) + 1);

    // 素材自己那份 PCM——两侧的起始沿都拿它当参照
    const srcInput = new Input({ formats: ALL_FORMATS, source: new BlobSource(musicSample.file) });
    let srcAudio: { readonly pcm: Float32Array; readonly rate: number } | null = null;
    try {
      const srcTrack = await srcInput.getPrimaryAudioTrack();
      if (srcTrack) srcAudio = await decodeTrackToPcm(srcTrack, MUSIC_SECONDS + 1);
    } finally {
      srcInput.dispose();
    }

    const startSeconds = at(MUSIC_START_FRAME);
    const trimmedStart = at(MUSIC_TRIMMED_START_FRAME);
    const peak = peakBetween(audio, startSeconds, trimmedStart);
    checks.push(
      check("配乐：成片里有声音", "峰值 > 0.2", peak.toFixed(4), peak > 0.2),
    );

    /**
     * 两条起始沿断言共用的判据：**成片里的第一声 − 片段被放的位置 == 素材里
     * 对应位置之后的第一声 − 那个位置**。两边同口径，所以编码器的 priming 和我
     * 刻意留的静音前导都被约掉。
     *
     * 判据**必须是量出来的素材起始沿**，不能是理论上的帧号：素材是 AAC 编的、
     * 自带约 48ms priming（2112/44100）。第一版拿理论值比，红了 67.9ms ≈
     * 20（前导）+ 47.9（priming）——一个完全正确的产品被判成错。这正是
     * "音画同步的两个操作数"那条记着的教训。
     */
    const onsetCheck = (
      name: string,
      placeSeconds: number,
      sourceInSeconds: number,
      searchFrom: number,
    ): void => {
      const out = firstOnsetAfter(audio, searchFrom);
      const src = srcAudio === null ? null : firstOnsetAfter(srcAudio, sourceInSeconds);
      const expected = src === null ? null : src - sourceInSeconds + placeSeconds;
      const drift = out === null || expected === null ? null : out - expected;
      checks.push(
        check(
          name,
          `|Δ| < ${MUSIC_ONSET_TOLERANCE * 1000}ms`,
          // **两个操作数都印出来**：只印差值时"素材那边量歪了"和"配乐真被挪了"
          // 长得一模一样，而这两个的处置完全不同
          `素材 ${src === null ? "?" : (src * 1000).toFixed(1)}ms` +
            ` − 入点 ${(sourceInSeconds * 1000).toFixed(1)}ms` +
            ` + 放置 ${(placeSeconds * 1000).toFixed(1)}ms` +
            ` = 期望 ${expected === null ? "?" : (expected * 1000).toFixed(1)}ms` +
            ` · 成片 ${out === null ? "整条静音" : `${(out * 1000).toFixed(1)}ms`}` +
            ` · Δ ${drift === null ? "?" : (drift * 1000).toFixed(1)}ms`,
          drift !== null && Math.abs(drift) < MUSIC_ONSET_TOLERANCE,
        ),
      );
    };

    // 整段放进来的那个：钉"配乐落在第几帧"。**只判"有信号"的话把它整体挪半秒
    // 仍然全绿**——同 D34 那条"按起始沿对齐会把整体平移原样吸收掉"的教训。
    // 顺带也钉住了"它之前是静音"：之前若有杂音，第一声会更早
    onsetCheck("配乐：第一声落在它被放的那一帧上", startSeconds, 0, 0);
    // 裁过入点的那个：钉**帧栅格换算**。取样起点落在两声之间的静音里，见
    // `MUSIC_TRIMMED_SOURCE_IN`
    onsetCheck(
      "配乐：裁过入点的片段取到源片正确的位置（栅格换算）",
      trimmedStart,
      MUSIC_TRIMMED_SOURCE_IN / toNumber(timeline.fps),
      trimmedStart,
    );

    // 尾巴钉一头：一段"一直响到底"的成片同样能通过上面两条
    const tailFrom = MUSIC_TRIMMED_START_FRAME + expectedFrames - MUSIC_TRIMMED_SOURCE_IN;
    const after = peakBetween(audio, at(tailFrom) + 0.1, at(MUSIC_TOTAL_FRAMES));
    checks.push(
      check("配乐：结束之后是静音", "峰值 < 0.02", after.toFixed(4), after < 0.02),
    );
  } finally {
    input.dispose();
  }
  await removeExportFile(MUSIC_OUT);

  return checks;
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
 * 淡化自检里用的段长（秒）。**远小于素材长度是刻意的**——缺省 10 秒会让
 * 这条 6 秒的时间轴只跑出一段，分段路径整个不被走到。
 */
const XFADE_SEGMENT_SECONDS = 0.5;

/**
 * "分段与不分段混出来的 PCM 一致"的容差，**无转场**那一路。
 *
 * 自检素材是 48kHz 单声道、输出也是 48kHz，中间既没有重采样也没有采样率转换，
 * 所以健康值应当是纯 float64 噪声——实测 **1.82e-12**。
 *
 * 破坏侧有实测值垫底：起播时刻经微秒取整时是 **5.22e-4**（那是真踩过的 bug，
 * 见 `mix-plan.ts` 的 `exactSeconds`）。容差落在两者之间，离健康值六个数量级、
 * 离破坏值两个数量级。
 */
const SEGMENT_MATCH_TOLERANCE = 1e-6;

/**
 * 带淡化那一路的容差。
 *
 * 健康值 **1.49e-8**，比上面高四个数量级，原因是包络曲线存在 `Float32Array` 里
 * ——f32 的相对精度约 1e-7，落在 0.25 幅度上就是这个量级。**这是精度地板，
 * 不是误差**，所以不能用同一个 1.82e-12 去要求它。
 *
 * 仍然取 1e-6：离健康值 67 倍，离实测破坏值（5.2e-4 / 7.4e-4）两个数量级。
 */
const SEGMENT_ENVELOPE_TOLERANCE = 1e-6;

/**
 * 音量缩放的容差。沿用上面那个 1e-6：被比的是同一条带淡化的时间轴，
 * 精度地板同样由 `Float32Array` 里的包络曲线决定（f32 相对精度约 1e-7）。
 *
 * 破坏侧的量级完全不同——"音量没生效"的偏差是 `0.5 × 峰值`，约 **0.1**，
 * 离容差五个数量级。这条断言不需要精调，它抓的不是精度而是"有没有乘"。
 */
const VOLUME_MATCH_TOLERANCE = 1e-6;

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
/**
 * 分段混音是否**透明**：同一条时间轴，切成很多段混 vs 一整段混，逐样本比对。
 *
 * 这条断言存在的理由是**隔离**。分段的失效形态里最坏的一种是接缝错开一个样本
 * ——20.8µs 的台阶，在连续波形上是一声轻微咔哒，而下面那 9 条 RMS 包络断言
 * 对它**完全免疫**（40ms 窗口里一个样本的偏差淹没在噪声里）。走一遍编码器再读
 * 回来更查不出：AAC 是有损的，它自己就会改动样本值。
 *
 * 所以这里绕开编码器和封装器，直接拿两次混音的 PCM 对拍。素材是 48kHz、
 * 输出也是 48kHz，中间没有重采样，健康值应当是**精确的 0**。
 *
 * 三条断言缺一不可：
 *
 * - **段数确实大于 1**——不然比的是同一条路径跑两遍，恒绿。这是"先确认健康值
 *   量的是被测对象"那条规矩的直接应用。
 * - **参照那次确实只有一段**——它是被比对的基准，自己分了段就说明不了问题。
 * - **PCM 里真的有信号**——两条静音也是逐样本一致的。
 */
async function verifyMixSegmentation(timeline: Timeline, total: number): Promise<Check[]> {
  const range = { inFrame: 0, outFrame: total };

  const compare = async (label: string, target: Timeline, tolerance: number) => {
    const inner: Check[] = [];
    // 段长取得比整条还长 = 一段。这就是分段之前的行为，拿它当基准
    const whole = await mixWholeTimeline(target, range, 3600);
    const split = await mixWholeTimeline(target, range, XFADE_SEGMENT_SECONDS);

    inner.push(
      check(`分段自检（${label}）：参照混音只有一段`, 1, whole.segments),
      check(
        `分段自检（${label}）：对照混音真的切开了`,
        "> 1 段",
        `${split.segments} 段`,
        split.segments > 1,
      ),
      check(`分段自检（${label}）：总样本数一致`, whole.frameCount, split.frameCount),
    );

    let peak = 0;
    let worst = 0;
    let worstAt = -1;
    let firstBad = -1;
    let badCount = 0;
    const length = Math.min(whole.frameCount, split.frameCount);
    for (let ch = 0; ch < MIX_CHANNELS; ch++) {
      const a = whole.planes[ch]!;
      const b = split.planes[ch]!;
      for (let i = 0; i < length; i++) {
        const av = a[i]!;
        if (Math.abs(av) > peak) peak = Math.abs(av);
        const diff = Math.abs(av - b[i]!);
        if (diff > tolerance) {
          badCount++;
          if (firstBad < 0) firstBad = i;
        }
        if (diff > worst) {
          worst = diff;
          worstAt = i;
        }
      }
    }

    inner.push(
      check(
        `分段自检（${label}）：参照 PCM 里有信号`,
        "峰值 > 0.05",
        peak.toFixed(4),
        peak > 0.05,
      ),
      check(
        `分段自检（${label}）：分段与不分段一致`,
        `最大差 < ${tolerance}`,
        // **把定位信息一起印出来**：只报一个最大值时，"某一段整段错位"和"接缝上
        // 差几个样本"长得一模一样，而这两个的处置完全不同。第一个越界样本的位置
        // 除以段长就知道是哪一段先坏的
        `${worst.toExponential(2)}（第 ${worstAt} 个样本，峰值 ${peak.toFixed(3)}）` +
          ` · 越界 ${badCount}/${length * MIX_CHANNELS} 个，首个在 ${firstBad}`,
        worst < tolerance,
      ),
    );
    return inner;
  };

  return [
    ...(await compare("无转场", withoutAudioTransitions(timeline), SEGMENT_MATCH_TOLERANCE)),
    ...(await compare("带淡化", timeline, SEGMENT_ENVELOPE_TOLERANCE)),
  ];
}

/** 自检里给片段设的音量。取 0.5 而不是 0.9：偏差要比浮点噪声大好几个数量级。 */
const VOLUME_PROBE = 0.5;

/**
 * 片段音量：**同一条带淡化的时间轴，音量设成一半之后逐样本恰好是原值的一半。**
 *
 * **两条时间轴各测一次**：
 *
 * - **无转场**那一路是"音量根本没生效"的干净判据。最可能的形态是 `envelopeInput`
 *   的恒等快路径忘了把 `job.volume` 算进去，于是调过音量的片段照旧直连总线。
 *   这条时间轴上没有任何 `ramps`，所以每一段都必然走那条快路径。
 * - **带淡化**那一路多覆盖了淡化窗口内的样本，抓"音量覆盖了淡化"而不是与它相乘
 *   （比如写成 `baseGain = volume`）——那时窗口外仍然正好是 0.5，只有窗口里偏。
 *
 * 我第一版写的理由是"带淡化那条每个片段都有 ramps、进不了快路径，所以只有无转场
 * 那条能抓快路径的 bug"。**反向验证当场否掉了它**：注入那个 bug 之后两条都红。
 * 原因是 `renderSegment` 的排期**按段重算**（不是切整条的排期），而段长 0.5 秒、
 * 转场窗口只有 0.667 秒——绝大多数段里 `ramps` 是空的，于是带淡化那条时间轴
 * 同样在走快路径。这不影响两条断言各自的价值，但它说明**"这条断言覆盖了什么"
 * 也要靠反向验证去确认，光读代码推是会推错的。**
 *
 * 走 `mixWholeTimeline` 而不是端到端导出：被测对象在 `envelopeInput` 里，
 * 而 AAC 是有损的、它自己就会改动样本值，容差得放到 1e-2 才不误报——那时
 * "少乘了一次"和"编码噪声"就分不开了。同分段自检那条"绕开编码器"的理由。
 *
 * **不加"volume:1 与不设该字段逐位相同"那条**：`× 1` 在浮点上是精确的，所以
 * 快路径坏掉时那条读数**和健康值一模一样**，测的是运气。恒等快路径的真正护栏
 * 是 M0 那条"成片与素材的第一声位置差"——它对多穿一级节点是敏感的。
 */
async function verifyVolume(timeline: Timeline, total: number): Promise<Check[]> {
  const range = { inFrame: 0, outFrame: total };

  /** 给每个音频素材片段套一层音量，套法由 `apply` 决定（静态值还是关键帧）。 */
  const mapAudioClips = (target: Timeline, apply: (clip: Clip) => Clip): Timeline => ({
    ...target,
    tracks: target.tracks.map((track) =>
      track.kind !== "audio"
        ? track
        : { ...track, clips: track.clips.map((c) => (c.kind === "media" ? apply(c) : c)) },
    ),
  });

  const withStatic = (target: Timeline) =>
    mapAudioClips(target, (clip) => ({ ...clip, volume: VOLUME_PROBE }));
  /**
   * 恒定包络：**一个**关键帧就够——`valueAt` 在区间外取端点值，所以整段恒为它。
   * 这一路走的是 `gainCurve` 那条分支，而结果必须和静态音量那一路一模一样。
   */
  const withFlatEnvelope = (target: Timeline) =>
    mapAudioClips(target, (clip) => ({
      ...clip,
      keyframes: { volume: [{ frame: 0, value: VOLUME_PROBE }] },
    }));

  const compare = async (
    label: string,
    target: Timeline,
    variant: (t: Timeline) => Timeline = withStatic,
  ): Promise<Check[]> => {
    const plain = await mixWholeTimeline(target, range, XFADE_SEGMENT_SECONDS);
    const scaled = await mixWholeTimeline(variant(target), range, XFADE_SEGMENT_SECONDS);

    let peak = 0;
    let scaledPeak = 0;
    let worst = 0;
    let worstAt = -1;
    const length = Math.min(plain.frameCount, scaled.frameCount);
    for (let ch = 0; ch < MIX_CHANNELS; ch++) {
      const a = plain.planes[ch]!;
      const b = scaled.planes[ch]!;
      for (let i = 0; i < length; i++) {
        const av = a[i]!;
        const bv = b[i]!;
        if (Math.abs(av) > peak) peak = Math.abs(av);
        if (Math.abs(bv) > scaledPeak) scaledPeak = Math.abs(bv);
        const diff = Math.abs(bv - av * VOLUME_PROBE);
        if (diff > worst) {
          worst = diff;
          worstAt = i;
        }
      }
    }

    return [
      check(`音量自检（${label}）：参照 PCM 里有信号`, "峰值 > 0.05", peak.toFixed(4), peak > 0.05),
      check(
        `音量自检（${label}）：逐样本等于原值 × ${VOLUME_PROBE}`,
        `最大差 < ${VOLUME_MATCH_TOLERANCE}`,
        // 两个操作数都印出来：只印差值时"音量没生效"和"参照那边量歪了"长得一样。
        // 峰值那一对同时是"音量确实小了一半"的旁证
        `${worst.toExponential(2)}（第 ${worstAt} 个样本）· 峰值 ${peak.toFixed(3)} → ` +
          `${scaledPeak.toFixed(3)}`,
        worst < VOLUME_MATCH_TOLERANCE,
      ),
    ];
  };

  return [
    ...(await compare("无转场", withoutAudioTransitions(timeline))),
    ...(await compare("带淡化", timeline)),
    // 恒定包络走的是 `gainCurve` 那条分支（淡化被逐帧重建再乘上音量），而结果必须
    // 和上面那条乘常数的路径**逐样本相同**。这是 `crossfadeGainAtFrame` 唯一的
    // 端到端护栏：它算错半帧、把"越过窗口后保持末值"写成"回到 1"、或者把片段坐标
    // 和时间轴坐标混起来，表现都只是"声音大小不太对"，不抛错
    ...(await compare("恒定包络", timeline, withFlatEnvelope)),
    ...(await compare("恒定包络·无转场", withoutAudioTransitions(timeline), withFlatEnvelope)),
  ];
}

/**
 * 分段的**目的**本身：混音峰值不随片长增长。
 *
 * 这是 M3 那条"长视频内存"风险的验收判据，也是唯一能证明分段有用的断言——
 * 上面那些只证明了分段**没把声音弄坏**。
 *
 * 做法是同一种素材接出两条长度差 4 倍的时间轴，各混一遍，比峰值。峰值必须在
 * `renderSegment` **内部**采（`onSample`）：段与段之间解码结果和渲染目标都已经
 * 销账，那时采到的是谷值，两条长度当然都一样——那种"绿"什么也没说明。
 *
 * 判据取 1.5 倍而不是"完全相等"：长的那条一段里可能多压上一个片段，允许有常数
 * 级差别，但**不允许 4 倍**。旧行为（整条混）在这两条上正好是 1:4。
 */
const RESIDENCY_SEGMENT_SECONDS = 2;

async function verifyMixResidency(source: AvSource, clipFrames: number): Promise<Check[]> {
  const build = (count: number): Timeline => ({
    fps: source.fps,
    width: source.width,
    height: source.height,
    durationFrames: clipFrames * count,
    sources: [source],
    tracks: [
      {
        id: "A1",
        kind: "audio",
        clips: Array.from({ length: count }, (_, i) => ({
          id: `a${i}`,
          kind: "media" as const,
          sourceId: source.id,
          timelineIn: i * clipFrames,
          timelineOut: (i + 1) * clipFrames,
          sourceIn: 0,
        })),
      },
    ],
  });

  const peakOf = async (count: number): Promise<number> => {
    let peak = 0;
    const mixer = await createMixer(build(count), { inFrame: 0, outFrame: clipFrames * count }, {
      // **两边都必须切成好几段**，否则比的是"一段装得下"和"要好几段"这两件不同的事
      // ——第一版短的那条只有一段，比值 2.04，看起来像还在随片长涨
      segmentSeconds: RESIDENCY_SEGMENT_SECONDS,
      onSample: () => {
        const snapshot = residency.snapshot();
        peak = Math.max(peak, snapshot.audioMixBytes + snapshot.audioPcmBytes);
      },
    });
    if (!mixer) throw new Error("常驻量自检：混音器建不起来");
    try {
      while (await mixer.next()) {
        /* 逐段跑完，峰值由 onSample 采到 */
      }
    } finally {
      mixer.dispose();
    }
    return peak;
  };

  const shortPeak = await peakOf(5);
  const longPeak = await peakOf(20);
  const ratio = shortPeak > 0 ? longPeak / shortPeak : Infinity;
  // 一段交出去的 PCM 有多大。峰值必须**明显**比它大——峰值那一刻源片解码结果和
  // 渲染目标同时活着，两者都比交出去的那截大
  const chunkBytes = RESIDENCY_SEGMENT_SECONDS * MIX_SAMPLE_RATE * MIX_CHANNELS * 4;
  return [
    // **这条是被反向验证逼出来的。** 第一版只断言"峰值 > 0"，而把采样点错误地挪到
    // 段与段之间（那时解码结果和渲染目标都已销账）仍然读得到 751KB——上一段交出去
    // 的 PCM 还挂在计量上——于是断言全绿而量的根本不是峰值。健康值 2.0MB = 2.7×，
    // 错误采样点恰好是 1.0×，取 1.5 落在两者之间
    check(
      "常驻量自检：峰值确实采在段内（不是段间的谷值）",
      `> 1.5 × 单段 ${formatBytes(chunkBytes)}`,
      `${formatBytes(shortPeak)} = ${(shortPeak / chunkBytes).toFixed(2)}×`,
      shortPeak > chunkBytes * 1.5,
    ),
    check(
      "常驻量自检：峰值不随片长增长（4× 长度）",
      "比值 < 1.5",
      `${formatBytes(shortPeak)} → ${formatBytes(longPeak)}，比值 ${ratio.toFixed(2)}`,
      ratio < 1.5,
    ),
  ];
}

/** 把整条时间轴按指定段长混完，拼成完整 PCM。段长大于片长就是"不分段"。 */
/**
 * 预览要抓多少秒。**够长到跨过几个混音段**（预览段长 1 秒），又不至于把自检拖慢。
 * 抓 3 秒、比对 2 秒，留 1 秒给起播余量和尾部。
 */
const PREVIEW_CAPTURE_SECONDS = 3;
const PREVIEW_COMPARE_SECONDS = 2;

/**
 * 预览听到的 == 成片里的。**D26 欠的那条护栏**。
 *
 * ## 它补的是什么
 *
 * 预览不是"用同样的算法自己混一遍"，而是跑同一个 `createMixer`、播它产出的同一段
 * PCM——所以淡化曲线、等功率还是等增益、片段音量都不可能分叉，**因为没有第二份
 * 实现**。但那个结构性保证有一处覆盖不到：**把这些段排到实时时钟上**那一步
 * （`pump()` + `audio-schedule.ts`）。排期把某一段放错了位置、漏排一段、或者
 * 重复排一段，声音就错了而结构性论证一句话都不会变。
 *
 * 单测已经钉住 `audio-schedule.ts` 那三个纯函数，这里钉的是**集成**：真的把声音
 * 排进一个真的 `AudioContext`，把**图的输出**无损抓下来，和导出会写进成片的那份
 * PCM 逐样本对拍。
 *
 * ## 对齐用起始沿，不用互相关
 *
 * 采集是从插节点那一刻开始的，而声音从 `originTime`（第一次 tick + 起播余量）才响，
 * 所以两条 PCM 之间有一个未知的整数偏移。互相关在这里**没法用**：被测信号是 1kHz
 * 正弦，自相关每 48 个样本一个同样高的峰，"最佳偏移"根本不唯一。缺省的 `beeps`
 * 素材每秒一声、其余静音，那个**静音 → 有声的沿**在搜索窗里是唯一的，直接拿它对齐。
 *
 * ## 为什么还要断言"错开一个样本就不一致"
 *
 * 逐样本相等这条断言有一个不易发现的失效方式：**两边都是静音**。素材没解出来、
 * 采集没接上、增益被静音，读数都是"最大差 0"，全绿。所以另外三条护栏：参照 PCM
 * 里必须有信号、采集到的必须有信号、以及**把偏移挪一个样本之后必须显著不一致**
 * ——最后这条同时证明"对齐是唯一的"和"比的不是两段静音"。
 */
async function verifyPreviewAudio(timeline: Timeline): Promise<Check[]> {
  const checks: Check[] = [];
  const range = { inFrame: 0, outFrame: timeline.durationFrames };

  // 参照：导出会写进成片的那份 PCM（缺省段长，和导出走同一条路）
  const reference = await mixWholeTimeline(timeline, range, 10);
  const refPeak = channelPeak(reference.planes);

  const { createPreviewAudio, START_LEAD_SECONDS } = await import("../preview/audio-engine");
  const { tapAudioOutput, firstOnset, diffAt } = await import("./audio-capture");

  const captureState: {
    tap: Awaited<ReturnType<typeof tapAudioOutput>> | null;
    context: AudioContext | null;
    graphs: number;
  } = { tap: null, context: null, graphs: 0 };
  const engine = createPreviewAudio({
    onGraph: async (context, output) => {
      captureState.graphs++;
      captureState.context = context;
      captureState.tap = await tapAudioOutput(context, output, {
        channelCount: MIX_CHANNELS,
        seconds: PREVIEW_CAPTURE_SECONDS + 1,
      });
    },
  });

  try {
    const started = await engine.start(timeline, 0);
    const { tap, context } = captureState;
    checks.push(check("预览音频：起得来（混音器 + 采集节点都建上了）", true, started && tap !== null));
    if (!started || !tap || !context) return checks;
    const contextRate = context.sampleRate;

    // 主时钟：墙上时间 × 帧率，和 `Preview.tsx` 那个 rAF 一样
    const fps = toNumber(timeline.fps);
    const wallStart = performance.now();
    const need = Math.ceil(contextRate * PREVIEW_CAPTURE_SECONDS);
    for (;;) {
      const elapsed = (performance.now() - wallStart) / 1000;
      engine.tick(Math.round(elapsed * fps));
      if (tap.captured() >= need) break;
      if (elapsed > PREVIEW_CAPTURE_SECONDS * 3 + 5) break; // 兜底，别无限等
      await new Promise((r) => setTimeout(r, 16));
    }

    const captured = await tap.dump();
    // 状态是**当场读的**，不是写死的常量。`suspended` 时下面几条会全红，而原因
    // 只在这一行里：没有用户手势的页面（`?autorun=`）要用
    // `--autoplay-policy=no-user-gesture-required` 起浏览器
    const contextState = context.state;
    const capPeak = channelPeak(captured.channels);

    checks.push(
      check("预览音频：AudioContext 在跑", "running", contextState),
      check("预览音频：采样率与混音器一致（没有重采样）", MIX_SAMPLE_RATE, contextRate),
      /*
        **采集期间一次都不许重新对齐。** 重排会关掉这个 context 并重建混音器
        （要重探解码器，几百毫秒），声音每秒一顿。这条正是建这套自检时抓到的那个
        bug 的回归护栏：起播余量没从漂移判据里减掉，于是偏差恒定 50ms、
        吃掉 80ms 容差的六成，实测 125ms 就越界、之后被限流成 1 次/秒。
      */
      check(
        "预览音频：采集期间没有重新对齐",
        "1 次建图",
        `${captureState.graphs} 次`,
        captureState.graphs === 1,
      ),
      check("预览音频：抓回来了（worklet 没有失联）", true, !captured.timedOut),
      check("预览音频：参照 PCM 里有信号", "峰值 > 0.05", refPeak.toFixed(4), refPeak > 0.05),
      // 两边都是静音时"最大差 0"照样全绿，所以这一条是必须的
      check("预览音频：抓到的声音里有信号", "峰值 > 0.05", capPeak.toFixed(4), capPeak > 0.05),
    );
    if (captured.timedOut) return checks;

    const refOnset = firstOnset(reference.planes[0]!);
    const capOnset = firstOnset(captured.channels[0]!);
    const offset = capOnset - refOnset;
    /*
      **偏移必须落在起播余量上，不能只判"是个合理的数"。**

      这一条是反向验证逼出来的：第一版只判 `0 ≤ 偏移 < 1 秒`，而"把每一段都推迟
      50ms"这个注入**全绿**——因为按起始沿对齐会把任何**整体**平移原样吸收掉，
      之后逐样本自然一致。整体平移正是音画不同步，所以这里要钉住绝对位置：
      采集从插节点那一刻开始、锚定发生在紧接着的第一次 tick，所以偏移应当就是
      起播余量本身。容差 20ms 留给这两件事之间的那点间隔。
    */
    const expectedOffset = Math.round(START_LEAD_SECONDS * contextRate);
    const offsetSlack = Math.round(0.02 * contextRate);
    checks.push(
      check(
        "预览音频：起始沿落在起播余量上（整体平移就是音画不同步）",
        `${expectedOffset} ± ${offsetSlack} 个样本`,
        `${offset}（参照第 ${refOnset} 个样本、采集第 ${capOnset} 个；余量 ${START_LEAD_SECONDS}s）`,
        refOnset >= 0 && capOnset >= 0 && Math.abs(offset - expectedOffset) <= offsetSlack,
      ),
    );
    if (refOnset < 0 || capOnset < 0 || offset < 0 || offset >= contextRate) return checks;

    const length = Math.min(
      Math.ceil(contextRate * PREVIEW_COMPARE_SECONDS),
      reference.frameCount,
      captured.channels[0]!.length - offset,
    );
    const aligned = diffAt(reference.planes, captured.channels, offset, length);
    const shifted = diffAt(reference.planes, captured.channels, offset + 1, length - 1);

    checks.push(
      check(
        "预览音频：比对区间够长",
        `≥ ${Math.round(contextRate)} 个样本`,
        `${length} 个（${(length / contextRate).toFixed(2)} 秒）`,
        length >= contextRate,
      ),
      check(
        "预览音频：预览听到的与成片逐样本一致",
        `最大差 < ${PREVIEW_MATCH_TOLERANCE}`,
        `${aligned.worst.toExponential(2)}（第 ${aligned.worstAt} 个样本，共比 ${aligned.compared} 个）` +
          ` · context ${contextState}`,
        aligned.worst < PREVIEW_MATCH_TOLERANCE,
      ),
      // 这一条同时证明"对齐是唯一的"和"比的不是两段静音"——挪一个样本就该明显不同
      check(
        "预览音频：错开一个样本就不一致（说明对齐唯一、且不是在比静音）",
        `最大差 > ${PREVIEW_MATCH_TOLERANCE}`,
        shifted.worst.toExponential(2),
        shifted.worst > PREVIEW_MATCH_TOLERANCE,
      ),
    );
    return checks;
  } finally {
    captureState.tap?.dispose();
    engine.dispose();
  }
}

/** 预览抓到的和参照 PCM 之间的容差。 */
const PREVIEW_MATCH_TOLERANCE = 1e-6;

function channelPeak(planes: readonly Float32Array[]): number {
  let peak = 0;
  for (const plane of planes) {
    for (let i = 0; i < plane.length; i++) {
      const v = Math.abs(plane[i]!);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

async function mixWholeTimeline(
  timeline: Timeline,
  range: { readonly inFrame: number; readonly outFrame: number },
  segmentSeconds: number,
  padSeconds?: number,
): Promise<{
  readonly planes: Float32Array[];
  readonly segments: number;
  readonly frameCount: number;
}> {
  const mixer = await createMixer(timeline, range, {
    segmentSeconds,
    ...(padSeconds !== undefined ? { padSeconds } : {}),
  });
  if (!mixer) throw new Error("分段自检：混音器建不起来（素材没有可解的音轨？）");
  try {
    const { frameCount } = mixer.header;
    const planes = Array.from({ length: MIX_CHANNELS }, () => new Float32Array(frameCount));
    let segments = 0;
    for (;;) {
      const chunk = await mixer.next();
      if (!chunk) break;
      for (let ch = 0; ch < MIX_CHANNELS; ch++) {
        const plane = chunk.channels[ch];
        if (plane) planes[ch]!.set(plane, chunk.startSample);
      }
      segments++;
    }
    return { planes, segments, frameCount };
  } finally {
    mixer.dispose();
  }
}

/** 把音频轨上的转场全部摘掉，其余原样。用来把包络的影响从分段比对里剥出来。 */
function withoutAudioTransitions(timeline: Timeline): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.kind !== "audio"
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => {
              if (!("transitionIn" in clip) || clip.transitionIn === undefined) return clip;
              const { transitionIn: _drop, ...rest } = clip;
              return rest;
            }),
          },
    ),
  };
}

async function verifyCrossfade(): Promise<Check[]> {
  const checks: Check[] = [];
  const total = SEG * 3;

  const toneSample = await makeSampleVideo({
    durationFrames: total,
    withAudio: true,
    audioShape: "tone",
  });
  const muteSample = await makeSampleVideo({ durationFrames: SEG, withAudio: false });
  const tone = (await probeAvFile(toneSample.file)).source;
  const mute = (await probeAvFile(muteSample.file)).source;

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

  // 分段混音是否透明，先在**不经过编码器**的地方判掉——见 verifyMixSegmentation
  checks.push(...(await verifyMixSegmentation(timeline, total)));
  checks.push(...(await verifyVolume(timeline, total)));
  checks.push(...(await verifyMixResidency(tone, SEG)));

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
      // **刻意压到远小于素材长度**：缺省 10 秒，而这条时间轴只有 6 秒，不压小
      // 就只跑出一段,下面那 9 条包络断言一次都碰不到段边界。压到 0.5 秒之后
      // 整个淡化窗口横跨好几段,拉取顺序、priming 跨段扣、接缝全在被测范围内
      mixSegmentSeconds: XFADE_SEGMENT_SECONDS,
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

/**
 * 一段区间里的最大绝对值。
 *
 * 稀疏提示音上**不能用 RMS**：40ms 的窗口很可能整个落在两声之间的静音里，那时
 * "有没有声音"这个判据会在正确的成片上给出 0。峰值对占空比免疫。
 */
function peakBetween(
  audio: { readonly pcm: Float32Array; readonly rate: number },
  fromSeconds: number,
  toSeconds: number,
): number {
  const from = Math.max(0, Math.round(fromSeconds * audio.rate));
  const to = Math.min(audio.pcm.length, Math.round(toSeconds * audio.rate));
  let peak = 0;
  for (let i = from; i < to; i++) {
    const v = Math.abs(audio.pcm[i]!);
    if (v > peak) peak = v;
  }
  return peak;
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
