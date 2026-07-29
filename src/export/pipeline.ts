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
  type AudioCodec,
  type VideoSample,
} from "mediabunny";

import { measureEncoderDelay, type EncoderDelay } from "../audio/encoder-delay";
import type { MixChunk, MixHeader } from "../audio/mixdown";
import { createCompositor, type CompositorBackend } from "../compose/backend";
import type { ComposeLayer, ComposeSourceLayer, Compositor } from "../compose/compositor";
import { registerFonts } from "../compose/font-registry";
import { decodedImage, decodedImageBytes, prepareImages } from "../compose/image-store";
import { residency, ResidencyTracker } from "./residency";
import { rasterizeText, textRasterCacheBytes } from "../compose/text-raster";
import { videoTracksInDrawOrder, visibleVideoClips, type VisibleClip } from "../edl/sampling";
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
  /**
   * 向主线程要第 `index` 段混好的 PCM，产完返回 null。
   *
   * 这是**唯一**能拿到音频的口子：混音在主线程（硬规则 6），而整条 PCM 一小时
   * 能到 2GB，所以按段拉。混那一段出错时这里抛，整次导出跟着失败——静默截短
   * 音轨比失败坏得多。
   */
  pullAudio(index: number): Promise<MixChunk | null>;
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
  // 图片解码缓存同理。单张可以到 37MB（1080p 下的解码上限），不记账的话
  // 一个幻灯片项目的常驻量报表会明显少报（同那条"内存要自己数"）
  residency.bindDecodedImageBytes(decodedImageBytes);
  // PCM 不再一次性拿到手，`audioPcmBytes` 由音频泵按"此刻攥着几段"逐段维护。
  // 这一项从"随片长线性增长"变成"有上界"，正是分段要证明的事
  residency.setAudioPcmBytes(0);

  /**
   * 最后进入的那一步。**只赋常量字符串，不做任何分配**——逐帧循环里一帧要赋四次。
   *
   * 存在的理由是死等：Safari 上导 30 分钟会停在 0% CPU、不抛错、不崩溃、进度条
   * 永远不动，那时"卡住了"是唯一的读数。有了它，读数变成"卡在第 N 帧的哪一步"。
   * 见 `ExportProgress.marker`。
   */
  let mark = "start";
  const at = (step: string): void => {
    mark = step;
  };

  const report = (stage: ExportProgress["stage"], encodedFrames: number) => {
    hooks.onProgress({
      stage,
      encodedFrames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
      residency: tracker.sample(encodedFrames),
      marker: mark,
    });
  };

  /**
   * 标记一步并上报，但**不记测量点**（`peek` 而不是 `sample`）。
   *
   * 这些上报是为了让"卡在哪一步"看得见，不是采样点。收尾那几步发生在关编码器、
   * 还解码帧、dispose reader **之后**，记进去会把 `last` 变成"拆干净以后的量"，
   * 于是导出面板上 `last − first` 那个"峰值还在涨吗"的判据永远读成 0。
   */
  const step = (name: string, stage: ExportProgress["stage"], frames: number): void => {
    at(name);
    hooks.onProgress({
      stage,
      encodedFrames: frames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
      residency: tracker.peek(),
      marker: mark,
    });
  };

  report("prepare", 0);

  // **自定义字体要在逐帧循环之前装进这个 Worker。** `FontFaceSet` 每个上下文一份，
  // 主线程注册过不算——漏了这一步的表现是成片里的字**静默换成兜底字体**，
  // 而预览里是对的。装不上就在这里失败，不要写出半份文件（见 font-registry.ts 文件头）
  step("register-fonts", "prepare", 0);
  await registerFonts(timeline.fonts);

  // **图片同理，而且理由一字不差**：`ImageBitmap` 是每个上下文一份的资源，
  // `composeFrame` 是同步的所以循环里没法等，漏了这一步的表现是成片里少一层画面。
  // 解不出来在这里失败并带上文件名——循环里发现时只剩"某一层没画"
  step("decode-images", "prepare", 0);
  const failedImages = await prepareImages(timeline.sources, timeline.width, timeline.height);
  if (failedImages.length > 0) {
    throw new Error(`这些图片解不出来，导出会少画它们：${failedImages.join("、")}`);
  }

  // 能力探测放在建 Output 之前：编码器不可用要在写出任何字节之前就失败
  step("probe-capabilities", "prepare", 0);
  const caps = await probeCapabilities(timeline.width, timeline.height);
  const decision = decideFormat(caps, request.container, audio !== null);
  if (decision.mp4BlockedByAudio) {
    throw new Error(
      "这个浏览器不能编码 AAC，导出 MP4 会没有声音。请改用 WebM，或换 Chrome / Safari。",
    );
  }

  const drawOrder = videoTracksInDrawOrder(timeline);
  if (drawOrder.length === 0) throw new Error("时间轴上没有可见的视频轨");

  // 标记串在这里预先拼好：逐帧循环里只允许赋常量，不允许每帧拼一次字符串
  const readers = drawOrder.map((track) => ({
    reader: new VideoTrackReader(timeline, track, range),
    mark: `decode:${track.id}`,
  }));
  step("acquire-compositor", "prepare", 0);
  const compositor = await acquireCompositor(timeline.width, timeline.height);

  step("open-target", "prepare", 0);
  const handle = await resolveHandle(request.target);
  const writable = await handle.createWritable();

  const output = new Output({
    format: request.container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    /**
     * **`chunked` 必须是 false。** 它不是性能开关，开着会在 Safari 上写出坏文件。
     *
     * 攒批模式（攒到 16MiB 再落盘）在 Safari 上实测：成片大小恒为 **16MiB 的整数倍**
     * ——0.5MB 的片子报 16.8MB，32.1MB 的片子报 33.6MB。小片子还解得开（moov 落在
     * 已写区域里，尾部那堆填充被解析器忽略），而 **30 分钟那一档解回来连音轨都问
     * 不到**：容器整个坏了，而导出侧一切正常——54000 帧全编完、泄漏 0、不抛错。
     * 这是最坏的一类失败：用户拿到一个放不出来的文件，而软件说成功了。
     *
     * 注意**不是"最后一块没落盘"**那么简单：坏掉那个文件 33.6MB 比真实内容 32.1MB
     * 还大，所以是补到 chunk 边界之后某块的内容或偏移写错了。具体机制在 mediabunny
     * 与 Safari 的 `FileSystemWritableFileStream` 之间，没有再往下挖——外部事实已经
     * 够硬，而且换掉它没有代价。
     *
     * 关掉之后：Safari 四档全过（30 分钟 4.4× 实时），**Chrome 反而更快**
     * （12.4× → 13.5×，写次数多了但少了一层缓冲和拷贝），两边字节数都变成真实大小。
     * 所以这里不按浏览器分岔——同一条路，两边都更好。
     *
     * 仍然满足硬规则 9：每次 write 直接进 `FileSystemWritableFileStream`，
     * 不攒 Blob。攒批省的只是写次数，而实测它连这个都没省到。
     */
    target: new StreamTarget(writable, { chunked: false }),
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

  // 编码器的 priming 会把整条音轨往后推（AAC 实测 2112 样本 = 44ms），而容器这一层
  // 补偿不了——见 audio/encoder-delay.ts 的文件头。这里测出来，喂 PCM 时从头部丢掉
  // 同样多，让成片里的音频落回正确的绝对位置
  const probeCodec = decision.audioCodec ? audioCodecString(decision.audioCodec) : null;
  step("measure-encoder-delay", "prepare", 0);
  const encoderDelay: EncoderDelay =
    audio && audioSource && probeCodec
      ? await measureEncoderDelay({
          codec: probeCodec,
          sampleRate: audio.sampleRate,
          numberOfChannels: audio.numberOfChannels,
          bitrate: request.audioBitrate,
        })
      : { samples: 0, sampleRate: audio?.sampleRate ?? 0, correlation: 0 };

  let encodedFrames = 0;

  /**
   * 心跳：每秒报一次"此刻进到哪一步"，与逐帧循环无关。
   *
   * 逐帧循环里的进度上报固定在 `await pumpAudio()` 之后，那一刻 `mark` 恒为
   * `audio`，所以光靠它定位不到卡在哪（实测踩过）。心跳由事件循环驱动，卡在
   * 任何一个 await 上时它照样跑，报出来的就是真正停住的那一步；连心跳都停了
   * 则说明是同步卡死——那也是一条结论。
   */
  const heartbeat = setInterval(() => {
    hooks.onProgress({
      stage: "video",
      encodedFrames,
      totalFrames,
      elapsedMs: performance.now() - startedAt,
      marker: mark,
      heartbeat: true,
    });
  }, 1000);

  try {
    step("output-start", "prepare", 0);
    await output.start();
    checkCancel();

    const frameDurationSeconds = frameDurationMicros(timeline.fps) / MICROS_PER_SECOND;
    const pumpAudio = makeAudioPump(
      audio,
      audioSource,
      encoderDelay.samples,
      (index) => hooks.pullAudio(index),
      at,
    );

    let lastReportedAt = 0;
    for (let i = 0; i < totalFrames; i++) {
      checkCancel();
      const outputFrame = range.inFrame + i;

      // 第一步：把**每条**轨都推进到这一帧，包括这一帧没有片段的。
      // 不能只问"有可见图层"的那几条轨——空档轨也要被问到才会主动释放解码器，
      // 而且 reader 只允许向前问（硬规则 3），漏问一帧就再也补不回来。
      // sample 归 reader 所有，这里不能 close（硬规则 4）。
      // **按 clipId 索引而不是按轨**：转场窗口里一条轨会同时吐出两个片段的帧
      const samples = new Map<string, VideoSample>();
      for (const entry of readers) {
        at(entry.mark);
        for (const [clipId, sample] of await entry.reader.samplesAt(outputFrame)) {
          samples.set(clipId, sample);
        }
      }

      // 第二步：按图层顺序装配。顺序、每层的变换和调色都来自 sampling.ts，
      // 导出侧一个都不自己算——预览侧拿的是同一个函数的同一份结果（硬规则 2）
      const toLayer = (visible: VisibleClip): ComposeSourceLayer | null => {
        const looks = {
          ...(visible.transform ? { transform: visible.transform } : {}),
          ...(visible.color ? { color: visible.color } : {}),
          ...(visible.lut ? { lut: visible.lut } : {}),
        };
        if (visible.kind === "text") {
          // 与预览侧调的是同一个 rasterizeText、同一份缓存，所以字形一致是
          // 结构性的而不是靠对齐（硬规则 2）。缓存命中时这里不做任何排版工作
          const raster = rasterizeText(
            visible.clip.text,
            visible.clip.style,
            timeline.width,
            timeline.height,
          );
          if (!raster) return null;
          return {
            kind: "image",
            image: raster.canvas,
            width: raster.width,
            height: raster.height,
            ...looks,
          };
        }
        if (visible.kind === "image") {
          // **解不出来要抛，不能返回 null。** 图片在循环开始前就该全部解好
          // （下面那个 `prepareImages`），这里拿不到只有两种可能：漏了那一步，
          // 或者缓存被谁清了。两种都是 bug，而返回 null 的表现是**成片里少一层
          // 画面且导出报成功**——那是最坏的一类失败（同硬规则 10）。
          //
          // 注意编译器**没有**逼出这个分支：`VisibleImageClip` 和 `VisibleMediaClip`
          // 都有 `clip.id`，所以少写它照样编译得过，只是会去查一个不存在的解码帧。
          // 判别联合只在字段集合真的不同的地方才帮得上忙
          const entry = decodedImage(visible.source.id);
          if (!entry) {
            throw new Error(
              `图片 ${visible.source.name} 没有解好就开始导出了——` +
                `逐帧循环之前必须 prepareImages()，见 compose/image-store.ts`,
            );
          }
          return {
            kind: "image",
            image: entry.bitmap,
            width: entry.width,
            height: entry.height,
            ...looks,
          };
        }
        const sample = samples.get(visible.clip.id);
        if (!sample) return null;
        return { kind: "sample", sample, ...looks };
      };

      const layers: ComposeLayer[] = [];
      for (const entry of visibleVideoClips(timeline, outputFrame)) {
        if (entry.kind === "transition") {
          // shader 转场：两层配成一个双输入节点。任一侧取不到帧（reader 漏解）
          // 就整个节点跳过——只画一侧的话成片里转场会突然只剩一层，比不画更难查
          const from = toLayer(entry.from);
          const to = toLayer(entry.to);
          if (!from || !to) continue;
          layers.push({
            kind: "transition",
            from,
            to,
            progress: entry.progress,
            effect: entry.effect,
          });
          continue;
        }
        const layer = toLayer(entry);
        if (layer) layers.push(layer);
      }

      // layers 为空 → 合成器画纯黑，这正是时间轴空隙该有的样子。
      // 渲染上下文可能在导出中途被浏览器收走（切标签页、休眠、驱动重置），
      // 那时 composeFrame 会抛错而不是静默出黑帧——救一次，救不回来就整次失败。
      // **绝不能吞掉继续跑**：那会写出几百帧黑画面而用户以为导出成功了
      at("compose");
      try {
        compositor.composeFrame(layers);
      } catch (error) {
        if (!compositor.isContextLost()) throw error;
        at("recover-context");
        if (!(await compositor.recover())) {
          throw new Error(
            `第 ${outputFrame} 帧时渲染上下文丢失且无法恢复，导出中止（成品不完整，已撤销）`,
          );
        }
        compositor.composeFrame(layers);
      }

      // await = 背压：编码队列满时这里会等，不会无限堆积帧
      at("encode");
      await videoSource.add(
        frameToSeconds(i, timeline.fps),
        frameDurationSeconds,
        i === 0 ? { keyFrame: true } : undefined,
      );
      encodedFrames++;

      // 音频跟着视频往前喂，保持封装器里两条轨的时间戳接近
      at("audio");
      await pumpAudio(frameToSeconds(i, timeline.fps));

      const now = performance.now();
      if (now - lastReportedAt > 100 || encodedFrames === totalFrames) {
        lastReportedAt = now;
        report("video", encodedFrames);
      }
    }

    checkCancel();
    // 视频比音频短时把剩下的音频补完（例如末尾有一段只有音轨的片段）
    step("audio-flush", "video", encodedFrames);
    await pumpAudio(Infinity);

    // **收尾这一串每步都上报。** 它原本是一段完全静默的路：`finalize()` 要把 mp4
    // 的样本索引写出来、`getFile()` 要等 OPFS 把几百 MB 落完盘，两者都随片长增长。
    // 30 分钟的片子在这里停十几秒是正常的，停住不动也是这个形态——不逐步上报就
    // 分不开，而这正是 Safari 死等最可疑的落点（PLAN.md §8 风险 1）
    step("close-encoders", "finalize", encodedFrames);
    videoSource.close();
    audioSource?.close();

    step("mime", "finalize", encodedFrames);
    const mimeType = await output.getMimeType();

    step("mux-finalize", "finalize", encodedFrames);
    await output.finalize();

    step("stat-output", "finalize", encodedFrames);
    const written = await handle.getFile();

    // 收尾前先把 reader 关掉，这样下面的"归零了没有"问的是**这一次导出**有没有
    // 泄漏，而不是"finally 还没跑"。finally 里再关一次是幂等的
    step("dispose-readers", "finalize", encodedFrames);
    await Promise.all(readers.map(({ reader }) => reader.dispose()));
    const after = residency.snapshot();

    return {
      mimeType,
      encodedFrames,
      elapsedMs: performance.now() - startedAt,
      audioIncluded: willWriteAudio,
      backend: residentBackend,
      audioEncoderDelay: encoderDelay,
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
    clearInterval(heartbeat);
    /**
     * **编码器要在 finally 里关，不能只关成功那一路。**
     *
     * 原来 `videoSource.close()` / `audioSource.close()` 只在成功路径上；失败和取消
     * 走的是 catch 里的 `output.cancel()`，而那个是否会关掉两个 source 内部的
     * `VideoEncoder` / `AudioEncoder` 不在我们手里。这些是操作系统级资源，而 Worker
     * **跨导出存活**——漏一次，下一次导出的余量就少一份。同"每个 `VideoFrame` 都必须
     * `close()`"（硬规则 4）、`OfflineAudioContext` 要显式 `close()`（D22）、WebGL
     * 上下文要复用（D15）：这类资源一律显式释放，不指望 GC。
     *
     * （查这条时曾拿"iPhone 上连着导第 2、3 次就 `Decoder failure`"当动机，**那个
     * 读数已撤回**——它出自并行自检污染，见 PLAN.md §8 风险 4。这个 finally 仍然
     * 该在：它修的是"失败路径上不释放"，而那与那批读数真不真无关。）
     *
     * `close()` 幂等：成功路径已经关过，这里再关一次是空操作。
     */
    try {
      videoSource.close();
    } catch {
      // 已经关过 / 从没起来，都不该盖住真正的错误
    }
    try {
      audioSource?.close();
    } catch {
      /* 同上 */
    }
    // **刻意不 dispose 合成器**——它是常驻的，跨导出复用，见 `acquireCompositor`
    await Promise.all(readers.map(({ reader }) => reader.dispose()));
  }
}

/**
 * 常驻合成器。**每次导出复用同一个，不新建。**
 *
 * 今天的 Canvas2D 后端无所谓，这条是**换 Pixi 之前必须先立起来的前提**：
 * 浏览器对同时存活的 WebGL 上下文有预算，超了就驱逐**最老的那一个**。
 * 直觉会去防"连着导出十几次，下一次起不来"，但驱逐顺序决定了那个方向天然安全；
 * 真正会死的是**预览**——它从打开项目起就一直握着一个合成器，是全场最老的，
 * 而用户每导出一次就产生一轮创建/销毁。Safari 上 12 轮就把预览判死
 * （spike 第 8 项）。
 *
 * 而且**救不回来**：spike 里量过，被预算驱逐的上下文调 `recover()` 会超时——
 * 浏览器要等预算腾出来才还，而 Safari 的 `dispose()` 本来就不立刻还。
 * 所以这不是"闪一下黑再自愈"，是预览真的死了。治因是唯一的解法。
 *
 * 尺寸变了才重建（不同项目的输出分辨率不同）。做成 async 是因为 Pixi 的工厂
 * 是异步的——换后端时只有这个函数体要动。
 */
let residentCompositor: Compositor | null = null;

async function acquireCompositor(width: number, height: number): Promise<Compositor> {
  const existing = residentCompositor;
  if (existing) {
    // 上一次导出之后上下文可能已经没了（切标签页、休眠、驱动重置）。
    // 救得回来就接着用，救不回来才丢掉重建
    if (!existing.isContextLost() || (await existing.recover())) {
      // **尺寸变了就地 resize，不销毁重建**：Pixi 销毁渲染器会 loseContext()，
      // 那张画布之后再建会死循环（见 compositor.ts 的 `resize`）。
      // 导出侧每次新建 OffscreenCanvas 本来不会撞上，但没有理由留这个雷
      existing.resize(width, height);
      return existing;
    }
    existing.dispose();
    residentCompositor = null;
  }

  const created = await createCompositor(width, height);
  residentCompositor = created.compositor;
  residentBackend = created.backend;
  return created.compositor;
}

/** 上一次造合成器用上的后端，报进导出结果供界面显示。 */
let residentBackend: CompositorBackend = "canvas2d";

/**
 * 放掉常驻合成器。
 *
 * Worker 现在跨导出存活（见 `export/client.ts`），所以要有一个显式的口子——
 * 否则一个 4K 项目的画布会一直占着，哪怕用户之后再也不导出。
 * 目前只在 Worker 收到 `release` 时调。
 */
export function releaseResidentCompositor(): void {
  residentCompositor?.dispose();
  residentCompositor = null;
}

/**
 * mediabunny 的编解码器名换成 WebCodecs 的编解码器串。
 *
 * 只为了给延迟探针配一个**和 mediabunny 内部一模一样**的编码器——两边配置不同的话，
 * 测出来的延迟就不是实际用的那个。mediabunny 没有把这个映射导出来，而我们只会选到
 * 这两个（见 `capability.ts` 的 `decideFormat`），所以这里照抄
 * （`aac` → AAC-LC，见 mediabunny `codec.js`）。
 *
 * 认不出来的编解码器返回 null，让调用方**跳过补偿**而不是猜一个串去测：
 * 拿错配置测出来的延迟比不补偿更糟，那会按一个错的量去移。
 */
function audioCodecString(codec: AudioCodec): string | null {
  if (codec === "aac") return "mp4a.40.2";
  if (codec === "opus") return "opus";
  return null;
}

/**
 * 段的预取深度。**1 表示"手上这段之外再多要一段"。**
 *
 * 0 会把两条线串起来：Worker 每次都停下来等主线程混完下一段，而混一段要真解
 * 音频，长片上累计几十秒的干等。预取 1 就够——主线程混第 k+1 段的同时 Worker
 * 在编第 k 段的视频，两边都不闲着。再大只是把峰值抬高，换不到吞吐。
 */
const AUDIO_PREFETCH = 1;

/**
 * 按段拉取 PCM，拼成"把音频喂到指定时刻"的函数。
 *
 * 混好的 PCM 是 f32-planar 的一组声道数组，切块时要把各声道的这一段
 * **按平面顺序拼进一个连续数组**（ch0 全部帧，然后 ch1 全部帧），
 * 这是 `f32-planar` 的内存布局；写成交错格式会得到左右声道互相穿插的噪音。
 *
 * `delayFrames` 是编码器的 priming 长度，要从 PCM **头部**丢掉这么多帧。
 * 为什么必须这么做、以及为什么容器这一层补偿不了，见 `audio/encoder-delay.ts`。
 * **注意 skip 可能横跨不止一段**（段长 10 秒时轮不到，但自检会把段长压到 1 秒），
 * 所以它按"还欠多少"逐段扣，不能只在第一段上减。
 *
 * 时间戳一律按 `written`（已喂样本数）算，**不按段边界算**：段是内存管理的单位，
 * 不是时间单位，让它渗进时间戳就等于把分段的实现细节写进成片。
 */
function makeAudioPump(
  audio: MixHeader | null,
  audioSource: AudioSampleSource | null,
  delayFrames: number,
  pull: (index: number) => Promise<MixChunk | null>,
  mark: (step: string) => void,
): (untilSeconds: number) => Promise<void> {
  if (!audio || !audioSource) return async () => undefined;

  const { sampleRate, numberOfChannels, frameCount, segmentCount } = audio;
  const chunkFrames = Math.max(1, Math.round(sampleRate * AUDIO_CHUNK_SECONDS));
  const bytesPerFrame = numberOfChannels * 4;
  // 编码延迟补偿：源里的第 delayFrames 个样本要成为喂进去的第 0 个，
  // 解码器把它吐回到绝对位置 delayFrames 上，正好对上（见 encoder-delay.ts）。
  // 丢掉的那一小段（AAC 是 44ms）只能落在 priming 区，没有别的地方可去
  let remainingSkip = Math.max(0, Math.min(delayFrames, frameCount));
  const feedFrames = frameCount - remainingSkip;

  /** 已喂给编码器的样本数。成片里的时间戳只由它决定。 */
  let written = 0;
  /** 从混音流里取走的样本数 = 已喂 + 已因 priming 丢弃。段边界按它对账。 */
  let consumed = 0;

  /**
   * 已经到手、还没喂完的 PCM 字节。
   *
   * 记的是**到手**而不是**请求**：预取中的那一段正在主线程混，那边有自己的计量
   * （`audioMixBytes`）；重复计一次会让"分段之后峰值有上界"这个结论建立在
   * 虚高的数上。而 transfer 一旦落地它就实打实在 Worker 手里，那一刻要立即入账，
   * 不能等到开始喂——否则峰值恰好漏掉预取的那一段，低报一半。
   */
  let heldBytes = 0;
  const noteHeld = (delta: number): void => {
    heldBytes += delta;
    residency.setAudioPcmBytes(heldBytes);
  };

  /** 已发出、还没消费的请求。键是段序号，保证一段只拉一次、且按序消费。 */
  const inflight = new Map<number, Promise<MixChunk | null>>();
  let nextToRequest = 0;
  const requestAhead = (): void => {
    while (nextToRequest < segmentCount && inflight.size <= AUDIO_PREFETCH) {
      const index = nextToRequest++;
      inflight.set(
        index,
        pull(index).then((chunk) => {
          if (chunk) noteHeld(chunk.frameCount * bytesPerFrame);
          return chunk;
        }),
      );
    }
  };

  let current: MixChunk | null = null;
  let currentOffset = 0;
  let currentIndex = 0;
  let drained = false;

  const dropCurrent = (): void => {
    if (!current) return;
    noteHeld(-current.frameCount * bytesPerFrame);
    current = null;
    currentOffset = 0;
  };

  /** 保证手上有没喂完的样本；产完了返回 false。 */
  const ensureChunk = async (): Promise<boolean> => {
    while (!current) {
      if (drained) return false;
      requestAhead();
      const pending = inflight.get(currentIndex);
      if (!pending) {
        drained = true;
        return false;
      }
      inflight.delete(currentIndex);
      // **这一步等的是主线程**（混音在那边，硬规则 6）。标出来是为了把"Worker 卡住"
      // 和"Worker 在等主线程混完"分开——两者在进度条上完全一样，而混音那侧只有
      // `startRendering()` 有看门狗，解码那一段没有
      mark(`audio-pull:${currentIndex}`);
      currentIndex++;
      const chunk = await pending;
      if (!chunk) {
        drained = true;
        return false;
      }
      // 起始样本由主线程带过来，这里对一遍。对不上说明段被跳过或乱序了——
      // 那让整条音频从此错位，而**听起来仍然是正常的声音**，只是内容挪了位，
      // 是最难从成片上发现的一类 bug。宁可当场炸
      if (chunk.startSample !== consumed) {
        throw new Error(
          `音频分段错位：第 ${chunk.index} 段自称起于样本 ${chunk.startSample}，` +
            `但已取走 ${consumed}`,
        );
      }
      if (chunk.frameCount <= 0) {
        noteHeld(-chunk.frameCount * bytesPerFrame);
        continue;
      }
      current = chunk;
      currentOffset = 0;
    }
    return true;
  };

  const advance = (count: number): void => {
    currentOffset += count;
    consumed += count;
    if (current && currentOffset >= current.frameCount) dropCurrent();
  };

  /**
   * 攒够一整块再喂编码器。**段边界不能变成编码器的输入边界。**
   *
   * 段长几乎不可能正好是喂块的整数倍（段 24024 样本、喂块 24000），直接从段里
   * 切就会在每段末尾多喂一个 **24 样本的碎块**。Chrome 上没事，**Safari 上成片的
   * 淡出曲线整体偏高约 0.05**（等于内容晚了约 33ms）——AudioToolbox 对这种远短于
   * 一个 AAC 帧（1024 样本）的输入不是白拿的。判据是把导出侧分段关掉重跑，两条
   * 断言立刻变绿。
   *
   * 攒了之后喂进去的每一块都是 `chunkFrames`，只有整条最后一块可能短——和分段
   * 之前逐字节一致。这也顺带让"分段"这个纯内存管理的决定不再渗进成片。
   */
  const staging = Array.from({ length: numberOfChannels }, () => new Float32Array(chunkFrames));
  let staged = 0;

  const emit = async (): Promise<void> => {
    if (staged === 0) return;
    const data = new Float32Array(staged * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      data.set(staging[ch]!.subarray(0, staged), ch * staged);
    }
    const sample = new AudioSample({
      format: "f32-planar",
      sampleRate,
      numberOfChannels,
      timestamp: written / sampleRate,
      data,
    });
    mark("audio-encode");
    try {
      await audioSource.add(sample);
    } finally {
      sample.close();
    }
    written += staged;
    staged = 0;
  };

  return async (untilSeconds: number) => {
    for (;;) {
      if (written + staged >= feedFrames) break;
      // 已经喂到比视频还超前一整块了就先停，等视频追上来
      if (written / sampleRate > untilSeconds + AUDIO_CHUNK_SECONDS) return;
      if (!(await ensureChunk())) break;
      const chunk = current;
      if (!chunk) break;
      const available = chunk.frameCount - currentOffset;

      // priming 补偿：头部这些样本要丢掉，而它可能横跨不止一段（段长 10 秒时
      // 轮不到，但自检会把段长压到 1 秒），所以按"还欠多少"逐段扣
      if (remainingSkip > 0) {
        const drop = Math.min(remainingSkip, available);
        remainingSkip -= drop;
        advance(drop);
        continue;
      }

      const take = Math.min(chunkFrames - staged, available, feedFrames - written - staged);
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const plane = chunk.channels[ch];
        if (!plane) continue;
        staging[ch]!.set(plane.subarray(currentOffset, currentOffset + take), staged);
      }
      staged += take;
      advance(take);
      if (staged === chunkFrames) await emit();
    }
    // 流走完了（或者只剩不足一块的尾巴）：把余量喂出去
    await emit();
    dropCurrent();
  };
}
