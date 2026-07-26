/// <reference lib="webworker" />
/**
 * PixiJS spike——**在 Worker 里**把换渲染后端的方向性风险验掉。
 *
 * 为什么是 Worker：M2 要用 GPU 做滤镜和 shader 转场，而导出的解码/合成/编码全在
 * Worker 里（硬规则 6）。如果 Pixi 在 Worker 里根本起不来，整个 M2 的图层模型
 * 设计就得换方向——这是个会波及接口的结论，不能等功能写完才知道。
 *
 * 这里不改任何生产代码路径，只是拿 `compose/pixi-compositor.ts` 和现有的
 * Canvas2D 后端跑同一份输入，回答六个问题：
 *
 * 1. Worker 里能不能起 WebGL2 渲染器（OffscreenCanvas + WebWorkerAdapter）。
 * 2. 逐帧换 `VideoFrame` 会不会逐帧新建 GPU 纹理（会的话导出慢一个量级）。
 * 3. Pixi 渲染完的画布交给 mediabunny 编码，读回来是不是正确的像素——
 *    WebGL 的 drawing buffer 默认下一帧就没了，这是"间歇性黑帧"的来源。
 * 4. GL 上下文丢失时，合成器是报错还是静默产出黑帧。
 * 5. 吞吐相对 Canvas2D 有没有倒退。
 * 6. 两个后端的留边几何和色彩差多少——迁移后画面会不会变。
 *
 * 输入是**合成的**素材，不走 make-sample：这几个问题都在 Pixi ↔ WebCodecs 的
 * 边界上，跟解码没关系，用真素材只会让自检慢十几秒。背景色相仍按
 * `sampleHueAt` 随帧号线性渐变，所以色相直接编码了"这是第几帧"。
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSink,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
  type VideoCodec,
} from "mediabunny";

import { createCanvas2DCompositor, type Compositor } from "../compose/compositor";
import { createPixiCompositor, type PixiCompositor } from "../compose/pixi-compositor";
import { measure, sampleHueAt, type Bands } from "./measure";

/** 方形输出 + 16:9 源片 → 必然产生上下黑边，留边几何才有得比。 */
const OUT = 320;
const SRC_WIDTH = 640;
const SRC_HEIGHT = 360;
const FRAMES = 30;
const FPS = 30;
/** 取样帧：首帧（关键帧）、中段、末帧。 */
const PROBE_FRAMES = [0, 12, 29] as const;

/**
 * 吞吐单独在 720p 上量，不复用上面的 320×320。
 *
 * 小画布上每帧的固定开销（画布→VideoFrame 的捕获、命令提交）占比过高，
 * 而实际导出里编码才是大头——拿 320×320 的比值下结论会把 Pixi 判得过重。
 * 源片尺寸与输出相同，也就是不缩放，这才是导出的常态。
 */
const PERF_SIZE = { width: 1280, height: 720 } as const;
const PERF_FRAMES = 40;

export interface FrameComparison {
  readonly index: number;
  readonly expectedHue: number;
  readonly pixi: Bands;
  readonly canvas2d: Bands;
}

export interface PixiProbeReport {
  readonly contextVersion: string;
  readonly container: "mp4" | "webm";
  readonly codec: string;
  /** 同一个合成器跑第 1 帧和最后一帧时，渲染器托管的 GPU 纹理数。 */
  readonly textures: { readonly afterFirstFrame: number; readonly afterLastFrame: number };
  readonly drawingBuffer: { readonly survivedTaskBoundary: boolean; readonly maxChannel: number };
  readonly contextLoss: {
    readonly extensionAvailable: boolean;
    readonly threwAfterLoss: boolean;
    readonly detail: string;
  };
  /** 纯合成耗时（CPU 提交，不含 GPU 完成）。 */
  readonly composeMs: { readonly pixi: number; readonly canvas2d: number };
  /** 合成 + 捕获 + 编码的整段墙上时间——这个才是导出真正花的时间。 */
  readonly encodeMs: { readonly pixi: number; readonly canvas2d: number };
  readonly frames: readonly FrameComparison[];
  readonly frameCount: number;
  /** 720p 上的吞吐，`pixiNoPreserve` 用来量 preserveDrawingBuffer 的开销。 */
  readonly perf: {
    readonly width: number;
    readonly height: number;
    readonly frames: number;
    readonly canvas2dMs: number;
    readonly pixiMs: number;
    readonly pixiNoPreserveMs: number;
  };
}

export type PixiProbeResponse =
  | { readonly type: "done"; readonly report: PixiProbeReport }
  | { readonly type: "error"; readonly message: string };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 造 `count` 帧 16:9 的纯色源片，色相随帧号线性渐变。
 *
 * 纯色是刻意的：留边边界因此是硬边，`measure()` 逐行判黑就能量出精确的黑边高度；
 * 带纹理的素材会让边界像素被插值糊掉，两个后端差 1px 也看不出来。
 */
function makeSourceSamples(count: number, width: number, height: number): VideoSample[] {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("造素材的画布没有 2D 上下文");

  const samples: VideoSample[] = [];
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = `hsl(${sampleHueAt(i, count)}, 70%, 45%)`;
    ctx.fillRect(0, 0, width, height);
    // 包一层 VideoSample 是为了走**和导出完全相同的路径**：合成器拿到的是 sample，
    // 内部 toVideoFrame() 再 close，Pixi 后端的"render 之后才能 close"就在这条路上
    samples.push(new VideoSample(new VideoFrame(canvas, { timestamp: Math.round((i / FPS) * 1e6) })));
  }
  return samples;
}

async function encodePass(
  compositor: Compositor,
  samples: readonly VideoSample[],
  container: "mp4" | "webm",
  codec: VideoCodec,
  onFrame?: (index: number) => void,
): Promise<{ buffer: ArrayBuffer; ms: number }> {
  const output = new Output({
    format: container === "mp4" ? new Mp4OutputFormat() : new WebMOutputFormat(),
    // 这里用 BufferTarget 不违反硬规则 9：那条针对导出管道。自检片固定 30 帧、
    // 几百 KB，而且下一步就要在内存里回读比对，落盘再读回纯属绕路
    target: new BufferTarget(),
  });
  const source = new CanvasSource(compositor.canvas, { codec, bitrate: 4_000_000 });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();

  const startedAt = performance.now();
  for (let i = 0; i < samples.length; i++) {
    compositor.composeFrame([{ kind: "sample", sample: samples[i]! }]);
    // add() 内部同步 new VideoFrame(canvas)，捕获就发生在这一行——与 composeFrame
    // 同一个 task。它也是让 GPU 真正把画面出完的地方，所以这段计时才是有意义的
    await source.add(i / FPS, 1 / FPS, i === 0 ? { keyFrame: true } : undefined);
    onFrame?.(i);
  }
  const ms = performance.now() - startedAt;

  source.close();
  await output.finalize();
  const buffer = output.target.buffer;
  if (!buffer) throw new Error("编码没有产出字节");
  return { buffer, ms };
}

async function measureFrames(
  buffer: ArrayBuffer,
  indices: readonly number[],
): Promise<Bands[]> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([buffer])) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("自检片里没有视频轨");
    const sink = new VideoSampleSink(track);

    const canvas = new OffscreenCanvas(OUT, OUT);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("比对画布没有 2D 上下文");

    const bands: Bands[] = [];
    for (const index of indices) {
      // 取帧中点：落在帧起点会拿到前一帧
      const sample = await sink.getSample((index + 0.5) / FPS);
      if (!sample) throw new Error(`读不到自检片第 ${index} 帧`);
      const frame = sample.toVideoFrame();
      try {
        ctx.clearRect(0, 0, OUT, OUT);
        ctx.drawImage(frame, 0, 0);
      } finally {
        frame.close();
        sample.close();
      }
      bands.push(measure(ctx, OUT, OUT));
    }
    return bands;
  } finally {
    input.dispose();
  }
}

/**
 * 720p 上的吞吐三连测：Canvas2D / Pixi / Pixi 关掉 preserveDrawingBuffer。
 *
 * 第三项不是备选方案，是用来知道"这个选项到底要多少钱"——如果它占了大头，
 * 那 M2 就得认真处理"捕获必须与渲染同 task"这条约束，而不是拿它换省事。
 */
async function throughputPass(
  container: "mp4" | "webm",
  codec: VideoCodec,
): Promise<PixiProbeReport["perf"]> {
  const { width, height } = PERF_SIZE;
  // 源片尺寸等于输出尺寸：不缩放，这是导出的常态
  const samples = makeSourceSamples(PERF_FRAMES, width, height);

  const time = async (make: () => Promise<Compositor> | Compositor): Promise<number> => {
    const compositor = await make();
    try {
      return (await encodePass(compositor, samples, container, codec)).ms;
    } finally {
      compositor.dispose();
    }
  };

  try {
    return {
      width,
      height,
      frames: PERF_FRAMES,
      canvas2dMs: await time(() => createCanvas2DCompositor(width, height)),
      pixiMs: await time(() => createPixiCompositor(width, height)),
      pixiNoPreserveMs: await time(() =>
        createPixiCompositor(width, height, { preserveDrawingBuffer: false }),
      ),
    };
  } finally {
    for (const sample of samples) sample.close();
  }
}

/** 纯合成耗时。只测 CPU 提交，GPU 是否完成不在这里体现——真实耗时看 encodeMs。 */
function timeCompose(compositor: Compositor, samples: readonly VideoSample[]): number {
  // 预热一轮：排除着色器编译和纹理首次分配
  for (const sample of samples) compositor.composeFrame([{ kind: "sample", sample }]);
  const startedAt = performance.now();
  for (const sample of samples) compositor.composeFrame([{ kind: "sample", sample }]);
  return performance.now() - startedAt;
}

/**
 * 渲染完、跨一个 macrotask 之后画布上还有没有东西。
 *
 * 不开 `preserveDrawingBuffer` 时这里会读到全黑。生产路径上捕获与渲染同 task，
 * 本来撞不上；但那个不变量太脆——中间插进任何一个 await 就间歇性出黑帧，
 * 且不报错。这条断言是防止后人"优化"掉那个选项。
 */
async function probeDrawingBuffer(
  sample: VideoSample,
): Promise<{ survivedTaskBoundary: boolean; maxChannel: number }> {
  const compositor = await createPixiCompositor(OUT, OUT);
  try {
    compositor.composeFrame([{ kind: "sample", sample }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const probe = new OffscreenCanvas(OUT, OUT);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("探测画布没有 2D 上下文");
    ctx.drawImage(compositor.canvas, 0, 0);
    const bands = measure(ctx, OUT, OUT);
    return { survivedTaskBoundary: bands.maxChannel > 32, maxChannel: bands.maxChannel };
  } finally {
    compositor.dispose();
  }
}

/**
 * GL 上下文丢失之后合成器是不是会报错。
 *
 * Canvas2D 没有这个失效模式，WebGL 有：导出跑几分钟，期间切标签页、系统休眠、
 * 驱动重置都可能触发。默认行为是渲染变成 no-op——也就是静默写出几百帧黑画面。
 */
async function probeContextLoss(
  sample: VideoSample,
): Promise<PixiProbeReport["contextLoss"]> {
  const compositor = await createPixiCompositor(OUT, OUT);
  try {
    // 丢之前先确认它是能画的，否则下面的"抛错"可能是别的原因
    compositor.composeFrame([{ kind: "sample", sample }]);

    if (!compositor.debug.loseContext()) {
      return {
        extensionAvailable: false,
        threwAfterLoss: false,
        detail: "浏览器不提供 WEBGL_lose_context，这条只能手动验证",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    try {
      compositor.composeFrame([{ kind: "sample", sample }]);
      return {
        extensionAvailable: true,
        threwAfterLoss: false,
        detail: "composeFrame 没有抛错——上下文丢失会静默产出黑帧",
      };
    } catch (error) {
      return { extensionAvailable: true, threwAfterLoss: true, detail: describe(error) };
    }
  } finally {
    // 上下文已经没了，destroy 自己可能抛，不影响上面的结论
    try {
      compositor.dispose();
    } catch {
      /* 忽略 */
    }
  }
}

async function run(): Promise<PixiProbeReport> {
  const samples = makeSourceSamples(FRAMES, SRC_WIDTH, SRC_HEIGHT);
  const probeSample = samples[0]!;

  try {
    // ---- 1. 能不能起来 ----
    let pixi: PixiCompositor;
    try {
      pixi = await createPixiCompositor(OUT, OUT);
    } catch (error) {
      throw new Error(`Worker 里起不了 Pixi WebGL 渲染器：${describe(error)}`);
    }

    let contextVersion: string;
    let composePixiMs: number;
    let texturesAfterFirstFrame = 0;
    let texturesAfterLastFrame = 0;
    let pixiClip: ArrayBuffer;
    let encodePixiMs: number;

    // ---- 2. 编码一遍，顺便数纹理 ----
    const avc = await getFirstEncodableVideoCodec(["avc"], { width: OUT, height: OUT });
    const container: "mp4" | "webm" = avc ? "mp4" : "webm";
    const codec =
      avc ?? (await getFirstEncodableVideoCodec(["vp9", "vp8"], { width: OUT, height: OUT }));
    if (!codec) throw new Error("这个浏览器编不了 AVC / VP9 / VP8，spike 没法跑");

    try {
      contextVersion = pixi.debug.contextVersion();
      composePixiMs = timeCompose(pixi, samples);
      const pass = await encodePass(pixi, samples, container, codec, (index) => {
        if (index === 0) texturesAfterFirstFrame = pixi.debug.managedTextureCount();
        if (index === FRAMES - 1) texturesAfterLastFrame = pixi.debug.managedTextureCount();
      });
      pixiClip = pass.buffer;
      encodePixiMs = pass.ms;
    } finally {
      pixi.dispose();
    }

    // ---- 3. Canvas2D 基线：同一份 sample，同样的编码参数 ----
    const canvas2d = createCanvas2DCompositor(OUT, OUT);
    let canvas2dClip: ArrayBuffer;
    let encodeCanvas2dMs: number;
    let composeCanvas2dMs: number;
    try {
      composeCanvas2dMs = timeCompose(canvas2d, samples);
      const pass = await encodePass(canvas2d, samples, container, codec);
      canvas2dClip = pass.buffer;
      encodeCanvas2dMs = pass.ms;
    } finally {
      canvas2d.dispose();
    }

    // ---- 4. 读回比对 ----
    const pixiBands = await measureFrames(pixiClip, PROBE_FRAMES);
    const canvas2dBands = await measureFrames(canvas2dClip, PROBE_FRAMES);

    // ---- 5. 两个失效模式 ----
    const drawingBuffer = await probeDrawingBuffer(probeSample);
    const contextLoss = await probeContextLoss(probeSample);

    // ---- 6. 吞吐（720p，不缩放）----
    const perf = await throughputPass(container, codec);

    return {
      contextVersion,
      container,
      codec,
      textures: { afterFirstFrame: texturesAfterFirstFrame, afterLastFrame: texturesAfterLastFrame },
      drawingBuffer,
      contextLoss,
      composeMs: { pixi: composePixiMs, canvas2d: composeCanvas2dMs },
      encodeMs: { pixi: encodePixiMs, canvas2d: encodeCanvas2dMs },
      frames: PROBE_FRAMES.map((index, i) => ({
        index,
        expectedHue: sampleHueAt(index, FRAMES),
        pixi: pixiBands[i]!,
        canvas2d: canvas2dBands[i]!,
      })),
      frameCount: FRAMES,
      perf,
    };
  } finally {
    for (const sample of samples) sample.close();
  }
}

self.onmessage = async () => {
  try {
    const report = await run();
    self.postMessage({ type: "done", report } satisfies PixiProbeResponse);
  } catch (error) {
    self.postMessage({ type: "error", message: describe(error) } satisfies PixiProbeResponse);
  }
};
