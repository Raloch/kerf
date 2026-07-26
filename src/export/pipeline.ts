/**
 * 导出流水线：decode → compose → encode → mux，按**整份 EDL**驱动。
 *
 * M1 的版本只认单个文件加一对帧号。EDL 化之后的形态：
 *
 *   输出帧 i ──┬─ V1 reader → 该帧的 VideoSample ─┐
 *              ├─ V2 reader → 该帧的 VideoSample ─┼→ compose() → CanvasSource
 *              └─ （空档）→ null ────────────────┘
 *   音频       └─ 主线程混好的 PCM → 按 0.5 秒切块，与视频帧交错 add
 *
 * 几个刻意的实现选择：
 *
 * - **帧对齐由输出驱动**：外层循环走输出帧号，内层由每条轨的 reader 拉"覆盖该时刻"
 *   的源片帧。源片帧率与时间轴帧率不一致时也正确（见 `edl/sampling.ts`）。
 * - **不逐帧 seek**：每个片段一个 `VideoSampleSink.samples(start, end)` 生成器顺序
 *   解码，mediabunny 内部会从入点之前的关键帧开始解并丢弃多余帧（硬规则 7）。
 * - **图层顺序与"该画哪个片段"由 `edl/sampling.ts` 决定**，预览走同一个函数。
 *   这里只管把拿到的图层交给 `compose()`（硬规则 2）。
 * - **背压靠 await**：`source.add()` 的 Promise 在编码器就绪时才 resolve，
 *   await 它就等于给编码队列施加背压，不需要自己盯 encodeQueueSize（硬规则 5）。
 * - **VideoSample 的所有权在 reader**（硬规则 4）：时间轴帧率高于源片帧率时同一个
 *   sample 会被多个输出帧复用，这里 close 会造成 use-after-close。
 * - **流式写盘**：`StreamTarget` 直接写进用户选定的文件或 OPFS，不攒 Blob（硬规则 9）。
 * - **音频与视频交错写**：把整段音频先 add 完再写视频，封装器必须把音频全缓存在
 *   内存里等视频，流式写盘就白做了。
 */

import {
  AudioSample,
  AudioSampleSource,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from "mediabunny";

import { createCanvas2DCompositor, type ComposeLayer } from "../compose/compositor";
import { videoTracksInDrawOrder } from "../edl/sampling";
import { decideFormat } from "../media/capability";
import { probeCapabilities } from "../media/capability-probe";
import { frameToSeconds, frameDurationMicros, MICROS_PER_SECOND } from "../time/timebase";
import { VideoTrackReader } from "./frame-reader";
import type { ExportDone, ExportProgress, ExportRequest } from "./protocol";
import { removeExportFile, resolveHandle } from "./write-target";

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

/**
 * 一次 add 进编码器的音频长度（秒）。
 *
 * 太小则 add 次数过多（每次都有跨线程开销），太大则封装器要缓存更多音频等视频。
 * 0.5 秒在两者之间，且远小于 MP4 默认的 1 秒分片粒度。
 */
const AUDIO_CHUNK_SECONDS = 0.5;

export async function runExport(
  request: ExportRequest,
  hooks: PipelineHooks,
): Promise<ExportDone> {
  const startedAt = performance.now();
  const { timeline, range, audio } = request;
  const totalFrames = range.outFrame - range.inFrame;
  if (totalFrames <= 0) throw new Error("导出范围为空：出点必须大于入点");

  const checkCancel = () => {
    if (hooks.isCanceled()) throw new ExportCanceled();
  };

  const report = (stage: ExportProgress["stage"], encodedFrames: number) => {
    hooks.onProgress({
      stage,
      encodedFrames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
    });
  };

  report("prepare", 0);

  // 能力探测放在建 Output 之前：编码器不可用要在写出任何字节之前就失败
  const caps = await probeCapabilities(timeline.width, timeline.height);
  const decision = decideFormat(caps, request.container, audio !== null);
  if (decision.mp4BlockedByAudio) {
    throw new Error(
      "这个浏览器不能编码 AAC，导出 MP4 会没有声音。请改用 WebM，或换 Chrome / Safari。",
    );
  }

  const drawOrder = videoTracksInDrawOrder(timeline);
  if (drawOrder.length === 0) throw new Error("时间轴上没有可见的视频轨");

  const readers = drawOrder.map((track) => new VideoTrackReader(timeline, track, range));
  const compositor = createCanvas2DCompositor(timeline.width, timeline.height);

  const handle = await resolveHandle(request.target);
  const writable = await handle.createWritable();

  const output = new Output({
    format: request.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    // chunked：攒到 16MiB 再落盘，减少写次数。峰值内存仍与片长无关
    target: new StreamTarget(writable, { chunked: true }),
  });

  const videoSource = new CanvasSource(compositor.canvas, {
    codec: decision.videoCodec,
    bitrate: request.videoBitrate,
  });
  // frameRate 传浮点是 mediabunny 的接口要求（它内部据此吸附时间戳）。
  // 我们自己的时间戳仍然由帧号换算，不依赖这个浮点值做运算。
  output.addVideoTrack(videoSource, {
    frameRate: timeline.fps.num / timeline.fps.den,
  });

  const willWriteAudio = audio !== null && decision.audioCodec !== null;
  const audioSource = willWriteAudio
    ? new AudioSampleSource({ codec: decision.audioCodec!, bitrate: request.audioBitrate })
    : null;
  if (audioSource) output.addAudioTrack(audioSource);

  let encodedFrames = 0;

  try {
    await output.start();
    checkCancel();

    const frameDurationSeconds = frameDurationMicros(timeline.fps) / MICROS_PER_SECOND;
    const pumpAudio = makeAudioPump(audio, audioSource, request.audioBitrate);

    let lastReportedAt = 0;
    for (let i = 0; i < totalFrames; i++) {
      checkCancel();
      const outputFrame = range.inFrame + i;

      // 每条轨都要问一次，包括空档的：让 reader 在空档处主动释放解码器，
      // 而不是把上一个片段的解码器一直挂着
      const layers: ComposeLayer[] = [];
      for (const reader of readers) {
        const sample = await reader.sampleAt(outputFrame);
        // sample 归 reader 所有，这里不能 close（硬规则 4）
        if (sample) layers.push({ kind: "sample", sample });
      }

      // layers 为空 → 合成器画纯黑，这正是时间轴空隙该有的样子
      compositor.composeFrame(layers);

      // await = 背压：编码队列满时这里会等，不会无限堆积帧
      await videoSource.add(
        frameToSeconds(i, timeline.fps),
        frameDurationSeconds,
        i === 0 ? { keyFrame: true } : undefined,
      );
      encodedFrames++;

      // 音频跟着视频往前喂，保持封装器里两条轨的时间戳接近
      await pumpAudio(frameToSeconds(i, timeline.fps));

      const now = performance.now();
      if (now - lastReportedAt > 100 || encodedFrames === totalFrames) {
        lastReportedAt = now;
        report("video", encodedFrames);
      }
    }

    checkCancel();
    // 视频比音频短时把剩下的音频补完（例如末尾有一段只有音轨的片段）
    await pumpAudio(Infinity);

    report("finalize", encodedFrames);

    videoSource.close();
    audioSource?.close();
    const mimeType = await output.getMimeType();
    await output.finalize();

    const written = await handle.getFile();

    return {
      mimeType,
      encodedFrames,
      elapsedMs: performance.now() - startedAt,
      audioIncluded: willWriteAudio,
      bytesWritten: written.size,
      ...(request.target.kind === "opfs" ? { opfsName: request.target.name } : {}),
    };
  } catch (error) {
    // 取消或失败都要撤掉半成品：output.cancel() 会 abort 掉 writable，
    // 用户选定的文件不会留下一个放不出来的残片
    if (output.state !== "finalized") {
      await output.cancel().catch(() => undefined);
    }
    // abort 只丢掉未提交的内容，**目录项还在**。OPFS 是我们自己建的条目，
    // 得自己删掉，否则每取消一次就留一个 0 字节文件在浏览器存储里慢慢堆积。
    // picker 路径不碰：那是用户自己选的文件，删掉等于替用户删文件
    if (request.target.kind === "opfs") {
      await removeExportFile(request.target.name);
    }
    throw error;
  } finally {
    compositor.dispose();
    await Promise.all(readers.map((reader) => reader.dispose()));
  }
}

/**
 * 造一个"把音频喂到指定时刻"的函数。
 *
 * 主线程混好的 PCM 是 f32-planar 的一组声道数组，切块时要把各声道的这一段
 * **按平面顺序拼进一个连续数组**（ch0 全部帧，然后 ch1 全部帧），
 * 这是 `f32-planar` 的内存布局；写成交错格式会得到左右声道互相穿插的噪音。
 */
function makeAudioPump(
  audio: ExportRequest["audio"],
  audioSource: AudioSampleSource | null,
  _bitrate: number,
): (untilSeconds: number) => Promise<void> {
  if (!audio || !audioSource) return async () => undefined;

  const { sampleRate, numberOfChannels, frameCount, channels } = audio;
  const chunkFrames = Math.max(1, Math.round(sampleRate * AUDIO_CHUNK_SECONDS));
  let written = 0;

  return async (untilSeconds: number) => {
    while (written < frameCount) {
      // 已经喂到比视频还超前一整块了就先停，等视频追上来
      if (written / sampleRate > untilSeconds + AUDIO_CHUNK_SECONDS) return;

      const length = Math.min(chunkFrames, frameCount - written);
      const data = new Float32Array(length * numberOfChannels);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const plane = channels[ch];
        if (!plane) continue;
        data.set(plane.subarray(written, written + length), ch * length);
      }

      const sample = new AudioSample({
        format: "f32-planar",
        sampleRate,
        numberOfChannels,
        timestamp: written / sampleRate,
        data,
      });
      try {
        await audioSource.add(sample);
      } finally {
        sample.close();
      }
      written += length;
    }
  };
}
