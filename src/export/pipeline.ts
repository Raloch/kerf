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
 * - **图层顺序、每层的变换、"该画哪个片段"全部由 `edl/sampling.ts` 决定**，预览走
 *   同一个函数。所以这里分两步：先把所有 reader 推进到这一帧（解码是有状态的），
 *   再按 `visibleVideoClips` 给的顺序装配图层（硬规则 2）。两步不能合成一步——
 *   见循环里的注释。
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
  type VideoSample,
} from "mediabunny";

import { createCanvas2DCompositor, type ComposeLayer } from "../compose/compositor";
import { residency, ResidencyTracker } from "./residency";
import { rasterizeText, textRasterCacheBytes } from "../compose/text-raster";
import { videoTracksInDrawOrder, visibleVideoClips } from "../edl/sampling";
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

  // 常驻量计量。挂在已有的进度节流上，不另起定时器——见 residency.ts 的文件头，
  // 以及 PLAN.md §4 那条"把测量塞进已经会跑的路径，才不会随时间烂掉"
  const tracker = new ResidencyTracker();
  const leftover = residency.reset();
  // text-raster 的缓存字节由它自己算，这里注入取值函数，避免 residency 反向依赖 compose
  residency.bindTextRasterBytes(textRasterCacheBytes);
  residency.setAudioPcmBytes(
    audio ? audio.channels.reduce((sum, plane) => sum + plane.byteLength, 0) : 0,
  );

  const report = (stage: ExportProgress["stage"], encodedFrames: number) => {
    hooks.onProgress({
      stage,
      encodedFrames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
      residency: tracker.sample(encodedFrames),
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

  // 带上 trackId：装配图层时要按轨对上 `visibleVideoClips` 给的那一层
  const readers = drawOrder.map((track) => ({
    trackId: track.id,
    reader: new VideoTrackReader(timeline, track, range),
  }));
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

      // 第一步：把**每条**轨都推进到这一帧，包括这一帧没有片段的。
      // 不能只问"有可见图层"的那几条轨——空档轨也要被问到才会主动释放解码器，
      // 而且 reader 只允许向前问（硬规则 3），漏问一帧就再也补不回来。
      // sample 归 reader 所有，这里不能 close（硬规则 4）
      const samples = new Map<string, VideoSample>();
      for (const { trackId, reader } of readers) {
        const sample = await reader.sampleAt(outputFrame);
        if (sample) samples.set(trackId, sample);
      }

      // 第二步：按图层顺序装配。顺序和每层的变换都来自 sampling.ts，
      // 导出侧一个都不自己算——预览侧拿的是同一个函数的同一份结果（硬规则 2）
      const layers: ComposeLayer[] = [];
      for (const visible of visibleVideoClips(timeline, outputFrame)) {
        if (visible.kind === "text") {
          // 与预览侧调的是同一个 rasterizeText、同一份缓存，所以字形一致是
          // 结构性的而不是靠对齐（硬规则 2）。缓存命中时这里不做任何排版工作
          const raster = rasterizeText(
            visible.clip.text,
            visible.clip.style,
            timeline.width,
            timeline.height,
          );
          if (raster) {
            layers.push({
              kind: "image",
              image: raster.canvas,
              width: raster.width,
              height: raster.height,
              ...(visible.transform ? { transform: visible.transform } : {}),
            });
          }
          continue;
        }
        const sample = samples.get(visible.trackId);
        if (!sample) continue;
        layers.push({
          kind: "sample",
          sample,
          ...(visible.transform ? { transform: visible.transform } : {}),
        });
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

    // 收尾前先把 reader 关掉，这样下面的"归零了没有"问的是**这一次导出**有没有
    // 泄漏，而不是"finally 还没跑"。finally 里再关一次是幂等的
    await Promise.all(readers.map(({ reader }) => reader.dispose()));
    const after = residency.snapshot();

    return {
      mimeType,
      encodedFrames,
      elapsedMs: performance.now() - startedAt,
      audioIncluded: willWriteAudio,
      bytesWritten: written.size,
      residency: {
        ...tracker.report(),
        // 跑完还没归零就是真泄漏：解码帧和解码器都该在 dispose 里还回去了。
        // 上一次导出的残留单独报，否则会算到这一次头上
        leakedSamples: after.decodedSamples,
        leakedCursors: after.openCursors,
        leakedInputs: after.openInputs,
        leakedFromPrevious: leftover.samples + leftover.cursors + leftover.inputs,
      },
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
    await Promise.all(readers.map(({ reader }) => reader.dispose()));
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
