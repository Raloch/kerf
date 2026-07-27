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
import { singleClipTimeline } from "../edl/types";
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
        const srcOnset = sourceAudio ? await firstOnsetAfter(sourceAudio, inSeconds + 0.5) : null;
        const outOnset = await firstOnsetAfter(audioTrack, 0.5);
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
      } finally {
        sourceInput.dispose();
      }
    }
  } finally {
    input.dispose();
  }

  return {
    checks,
    passed: checks.every((c) => c.pass),
    elapsedMs: performance.now() - startedAt,
    exportedBytes: exported.bytesWritten,
    realtimeFactor,
  };
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
async function firstOnsetAfter(
  track: InputAudioTrack,
  from: number,
): Promise<number | null> {
  const sink = new AudioSampleSink(track);
  for await (const audioSample of sink.samples(from, from + 2)) {
    try {
      const buffer = audioSample.toAudioBuffer();
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        if (Math.abs(data[i]!) > ONSET_THRESHOLD) {
          return audioSample.timestamp + i / buffer.sampleRate;
        }
      }
    } finally {
      audioSample.close();
    }
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
