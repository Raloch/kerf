/**
 * 导出流水线：decode → compose → encode → mux。
 *
 * M0 的验证目标就是这条链路和时间基模型。几个刻意的实现选择：
 *
 * - **帧对齐由输出驱动**：外层循环走输出帧号，内层从源片拉取"覆盖该时刻"的帧。
 *   这样源片帧率与时间轴帧率不一致时也正确（M0 两者相同，但代码不假设相同）。
 * - **不逐帧 seek**：用 `VideoSampleSink.samples(start, end)` 顺序解码，
 *   mediabunny 内部会从 in 点之前的关键帧开始解并丢弃多余帧（硬规则 7 的 GOP 边界）。
 *   逐帧 `getSample()` 会反复触发 seek，慢一个量级。
 * - **背压靠 await**：`source.add()` 的 Promise 在编码器就绪时才 resolve，
 *   await 它就等于给编码队列施加背压，不需要自己盯 encodeQueueSize（硬规则 5）。
 * - **每个 sample / VideoFrame 都显式 close**（硬规则 4），漏一个几秒就 OOM。
 */

import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSampleSink,
  WebMOutputFormat,
  type AudioSample,
  type VideoSample,
} from "mediabunny";

import { createCanvas2DCompositor } from "../compose/compositor";
import { decideFormat, probeCapabilities } from "../media/capability";
import {
  FRAME_ALIGN_EPSILON_SECONDS,
  frameDurationMicros,
  frameToSeconds,
  MICROS_PER_SECOND,
} from "../time/timebase";
import type { ExportDone, ExportProgress, ExportRequest } from "./protocol";

export interface PipelineHooks {
  onProgress(progress: ExportProgress): void;
  /** 返回 true 表示用户已取消，流水线会尽快停下并清理。 */
  isCanceled(): boolean;
}

export class ExportCanceled extends Error {
  constructor() {
    super("导出已取消");
    this.name = "ExportCanceled";
  }
}

export async function runExport(
  request: ExportRequest,
  hooks: PipelineHooks,
): Promise<ExportDone> {
  const startedAt = performance.now();
  const totalFrames = request.outFrame - request.inFrame;
  if (totalFrames <= 0) throw new Error("导出范围为空：出点必须大于入点");

  const checkCancel = () => {
    if (hooks.isCanceled()) throw new ExportCanceled();
  };

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(request.file) });
  const compositor = createCanvas2DCompositor(request.width, request.height);

  let output: Output | null = null;
  let videoSource: CanvasSource | null = null;
  let audioSource: AudioSampleSource | null = null;

  try {
    hooks.onProgress({
      stage: "prepare",
      encodedFrames: 0,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("源文件没有视频轨");
    const audioTrack = request.includeAudio ? await input.getPrimaryAudioTrack() : null;
    const audioUsable = audioTrack !== null && (await audioTrack.canDecode());

    // 能力探测放在建 Output 之前：编码器不可用要在写出任何字节之前就失败
    const caps = await probeCapabilities(request.width, request.height);
    const decision = decideFormat(caps, request.container, audioUsable);
    if (decision.mp4BlockedByAudio) {
      throw new Error(
        "这个浏览器不能编码 AAC，导出 MP4 会没有声音。请改用 WebM，或换 Chrome / Safari。",
      );
    }

    output = new Output({
      format: request.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
      target: new BufferTarget(),
    });

    videoSource = new CanvasSource(compositor.canvas, {
      codec: decision.videoCodec,
      bitrate: request.videoBitrate,
    });
    // frameRate 传浮点是 mediabunny 的接口要求（它内部据此吸附时间戳）。
    // 我们自己的时间戳仍然由帧号换算，不依赖这个浮点值做运算。
    output.addVideoTrack(videoSource, {
      frameRate: request.fps.num / request.fps.den,
    });

    const willWriteAudio = audioUsable && decision.audioCodec !== null;
    if (willWriteAudio && audioTrack) {
      audioSource = new AudioSampleSource({
        codec: decision.audioCodec!,
        bitrate: request.audioBitrate,
      });
      output.addAudioTrack(audioSource);
    }

    await output.start();
    checkCancel();

    // ---- 音频：M0 是单轨转封装，不需要混音，直接 sink → source ----
    if (willWriteAudio && audioTrack && audioSource) {
      await copyAudio(audioTrack, audioSource, request, checkCancel);
    }

    // ---- 视频：按输出帧号驱动，从源片顺序拉帧 ----
    const inSeconds = frameToSeconds(request.inFrame, request.fps);
    const outSeconds = frameToSeconds(request.outFrame, request.fps);
    const videoSink = new VideoSampleSink(videoTrack);
    const samples = videoSink.samples(inSeconds, outSeconds);

    // 单帧时长只用于告知编码器"这帧覆盖多久"，不参与时间戳累加
    const frameDurationSeconds = frameDurationMicros(request.fps) / MICROS_PER_SECOND;

    let current: VideoSample | null = null;
    let next: VideoSample | null = null;
    let encodedFrames = 0;
    let lastReportedAt = 0;

    try {
      for (let i = 0; i < totalFrames; i++) {
        checkCancel();

        // 输出帧 i 对应的源片时刻（用帧号换算，只在此处落到秒）
        const targetSeconds = frameToSeconds(request.inFrame + i, request.fps);

        if (!current) {
          const first = await samples.next();
          if (first.done) break; // 源片提前结束
          current = first.value;
        }

        // 向前推进，直到 current 是"最后一个不晚于 target 的帧"
        for (;;) {
          if (!next) {
            const step = await samples.next();
            next = step.done ? null : step.value;
          }
          if (next && next.timestamp <= targetSeconds + FRAME_ALIGN_EPSILON_SECONDS) {
            current.close();
            current = next;
            next = null;
            continue;
          }
          break;
        }

        compositor.composeFrame([{ kind: "sample", sample: current }]);

        // await = 背压：编码队列满时这里会等，不会无限堆积 VideoFrame
        await videoSource.add(
          frameToSeconds(i, request.fps),
          frameDurationSeconds,
          // 每 2 秒一个关键帧，与 mediabunny 默认一致，显式写出便于将来调
          i === 0 ? { keyFrame: true } : undefined,
        );
        encodedFrames++;

        const now = performance.now();
        if (now - lastReportedAt > 100 || encodedFrames === totalFrames) {
          lastReportedAt = now;
          hooks.onProgress({
            stage: "video",
            encodedFrames,
            totalFrames,
            elapsedMs: now - startedAt,
          });
        }
      }
    } finally {
      current?.close();
      next?.close();
      // 提前退出时要让生成器释放解码器
      await samples.return?.(undefined);
    }

    checkCancel();
    hooks.onProgress({
      stage: "finalize",
      encodedFrames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
    });

    videoSource.close();
    audioSource?.close();
    const mimeType = await output.getMimeType();
    await output.finalize();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("封装完成但没有拿到输出数据");

    return {
      bytes: new Uint8Array(buffer),
      mimeType,
      encodedFrames,
      elapsedMs: performance.now() - startedAt,
      audioIncluded: willWriteAudio,
    };
  } catch (error) {
    // 取消或失败都要撤掉半成品，否则 BufferTarget 会留着已写入的字节
    if (output && output.state !== "finalized") {
      await output.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    compositor.dispose();
    input.dispose();
  }
}

/**
 * 音频转封装：解码源片音频再用目标编码器重编。
 *
 * 边界帧用 AudioSample.trim() 精确裁掉——音频包的边界几乎不会正好落在
 * in/out 点上，不裁就会多出或少掉几毫秒，累积成音画偏移。
 */
async function copyAudio(
  audioTrack: NonNullable<Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>>,
  audioSource: AudioSampleSource,
  request: ExportRequest,
  checkCancel: () => void,
): Promise<void> {
  const inSeconds = frameToSeconds(request.inFrame, request.fps);
  const outSeconds = frameToSeconds(request.outFrame, request.fps);
  const sink = new AudioSampleSink(audioTrack);

  for await (const sample of sink.samples(inSeconds, outSeconds)) {
    let toAdd: AudioSample | null = sample;
    let trimmed: AudioSample | null = null;
    try {
      checkCancel();

      const sampleStart = sample.timestamp;
      const sampleEnd = sampleStart + sample.duration;
      const rate = sample.sampleRate;

      // 计算需要保留的帧区间（音频帧，不是视频帧）
      const startOffset = Math.max(0, Math.round((inSeconds - sampleStart) * rate));
      const endOffset = Math.min(
        sample.numberOfFrames,
        Math.round((Math.min(outSeconds, sampleEnd) - sampleStart) * rate),
      );

      if (endOffset <= startOffset) continue;
      if (startOffset > 0 || endOffset < sample.numberOfFrames) {
        trimmed = sample.trim(startOffset, endOffset);
        toAdd = trimmed;
      }

      await audioSource.add(toAdd);
    } finally {
      trimmed?.close();
      sample.close();
    }
  }
}
