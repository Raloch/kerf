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

import { applyColorMatrix8, colorMatrixOf, type ColorAdjust } from "../compose/color";
import {
  buildLutTexture,
  identityLut,
  sampleLutTexture8,
  type LutData,
} from "../compose/lut";
import {
  GLITCH_BLOCKS,
  GLITCH_SHIFT,
  glitchPoint,
  mixTransition,
} from "../compose/transition-shader";
import {
  createCanvas2DCompositor,
  type Compositor,
  type LayerTransform,
} from "../compose/compositor";
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

/**
 * 上下文预算测试要连开几个。
 *
 * 12 是"一次剪辑里导出十几次"这个量级——比 WebKit 常见的上限低不了多少，
 * 又不至于让自检跑很久。这里只要求"起完这么多轮之后还能画"，不要求某个具体上限：
 * 上限是浏览器和显卡的实现细节，会变；"用户连着导出会不会失败"不会变。
 */
const CONTEXT_BUDGET_CYCLES = 12;

/**
 * 上下文恢复之后要画的那一帧，**刻意不是丢失前那一帧**。
 *
 * 开着 `preserveDrawingBuffer`，画布会保留丢失前的内容。如果恢复后 `render()`
 * 其实是空操作，重画同一帧仍会量到正确的色相——那条断言就是空的，什么都挡不住。
 * 换一帧之后，"量到的色相 = 新帧的色相"才能证明**这一次渲染真的发生了**。
 */
const RECOVER_SAMPLE_INDEX = 20;

export interface FrameComparison {
  readonly index: number;
  readonly expectedHue: number;
  readonly pixi: Bands;
  readonly canvas2d: Bands;
}

/** 四条黑边，用来把"图层落在哪"变成四个可断言的整数。 */
export interface Edges {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface TransformComparison {
  readonly name: string;
  /** 手算的期望摆位。计算过程见 `TRANSFORM_CASES` 每条的注释。 */
  readonly expected: Edges;
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
    /** `recover()` 有没有把上下文要回来。 */
    readonly recovered: boolean;
    /**
     * 丢失前画一帧、恢复后画**另一帧**，两次量到的色相与最大通道。
     *
     * 只断言"恢复后不黑"是不够的：GPU 资源在丢失时全部作废，如果 Pixi 没能
     * 重新上传纹理，画出来会是别的东西（纯色、上一帧、乱码）而不是黑屏。
     * 而且开着 `preserveDrawingBuffer`，重画**同一帧**的话画布上的旧内容会让
     * 断言即使在"渲染其实没发生"时也通过——所以恢复后换一帧，
     * 断言 `afterHue` 命中新帧的期望色相，见 `RECOVER_SAMPLE_INDEX`。
     */
    readonly beforeMaxChannel: number;
    readonly afterMaxChannel: number;
    readonly beforeHue: number;
    readonly afterHue: number;
    /** 恢复后应当画出的那一帧的色相。 */
    readonly afterExpectedHue: number;
    readonly recoverDetail: string;
  };
  /** WebGL 上下文预算：复用 vs 每轮新建的对照。见 `probeContextBudget`。 */
  readonly contextBudget: {
    readonly cycles: number;
    readonly survivedCycles: number;
    /**
     * **复用**常驻合成器跑完这些轮之后，长命的那个（预览）还画不画得出。
     * 这是导出侧复用的验收——生产架构就是这一条。
     */
    readonly reuseLongLivedMaxChannel: number;
    /** 对照组：**每轮新建 + 销毁**时，长命的那个还画不画得出。 */
    readonly churnLongLivedMaxChannel: number;
    /** 跑完之后新建的那个的最大通道值。 */
    readonly freshMaxChannel: number;
    /**
     * 对照组里老的被驱逐之后，`recover()` 救不救得回来。
     *
     * 这决定了复用是"锦上添花"还是"唯一解"：救得回来的话预算耗尽只是闪一下黑，
     * 救不回来就是预览真的死了。实测 Safari **救不回来**。
     */
    readonly churnLongLivedRecovered: boolean;
    readonly detail: string;
  };
  /** 纯合成耗时（CPU 提交，不含 GPU 完成）。 */
  readonly composeMs: { readonly pixi: number; readonly canvas2d: number };
  /** 合成 + 捕获 + 编码的整段墙上时间——这个才是导出真正花的时间。 */
  readonly encodeMs: { readonly pixi: number; readonly canvas2d: number };
  readonly frames: readonly FrameComparison[];
  readonly frameCount: number;
  /** 图层变换在两个后端上的摆位比对（M2 第 2 步加的）。 */
  readonly transforms: readonly TransformComparison[];
  /** 一级调色：GPU 出来的像素与 CPU 参照实现的比对（M2 后半段加的）。 */
  readonly colors: readonly ColorComparison[];
  /** 3D LUT：同上，外加"先调色再 LUT"这个顺序的钉子。 */
  readonly luts: readonly LutComparison[];
  readonly transitions: readonly TransitionComparison[];
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

/**
 * 图层变换的比对用例。
 *
 * 输出 320×320、源片 640×360，所以默认留边矩形是 **320×180 @ (0,70)**，中心 (160,160)。
 * 下面每条的 `expected` 都由此手算——**不是**拿 `placeLayer()` 算出来再回填的，
 * 否则这组断言只能证明"两个后端都按 placeLayer 摆"，证不出 placeLayer 摆得对。
 * （placeLayer 自己的算式由 `compose/compositor.test.ts` 用手算数锁住。）
 *
 * 旋转刻意取 90°：任意角度会让边缘落在半个像素上，Canvas2D 的插值和 Pixi 的
 * 无抗锯齿采样必然差一两个像素，那时断言只能放松到看不出真错误。90° 的四条边
 * 仍落在整像素上，同时足够暴露旋转中心搞错或方向搞反——两者都会让位置整体偏掉。
 */
const TRANSFORM_CASES: readonly {
  readonly name: string;
  readonly transform: LayerTransform;
  readonly expected: Edges;
}[] = [
  {
    // 对照组：恒等变换必须与"不传变换"完全一样，也就是默认留边
    name: "恒等变换 = 默认留边",
    transform: {},
    expected: { top: 70, bottom: 70, left: 0, right: 0 },
  },
  {
    // 320×180 缩一半 = 160×90，中心不动 → x 80..240，y 115..205
    name: "缩到一半，绕中心缩",
    transform: { scaleX: 0.5, scaleY: 0.5 },
    expected: { top: 115, bottom: 115, left: 80, right: 80 },
  },
  {
    // 160×90 的中心从 (160,160) 挪到 (200,130) → x 120..280，y 85..175
    name: "缩一半再挪到右上（画中画）",
    transform: { scaleX: 0.5, scaleY: 0.5, x: 40, y: -30 },
    expected: { top: 85, bottom: 145, left: 120, right: 40 },
  },
  {
    // 160×90 绕中心转 90° → 外接框变成 90 宽 × 160 高 → x 115..205，y 80..240
    name: "缩一半再转 90°，绕图层中心",
    transform: { scaleX: 0.5, scaleY: 0.5, rotation: Math.PI / 2 },
    expected: { top: 80, bottom: 80, left: 115, right: 115 },
  },
  {
    // 只改不透明度：几何必须一点不动，仍是默认留边
    name: "半透明不改几何",
    transform: { opacity: 0.5 },
    expected: { top: 70, bottom: 70, left: 0, right: 0 },
  },
];

/**
 * 两个后端各按同一组变换摆一遍，直接量画布——**不过编码器**。
 *
 * 这里要的是几何精度，而 H.264 的 4:2:0 色度下采样会把硬边糊开一两个像素，
 * 刚好落在断言的量级上。编码捕获路径由上面那三个取样帧负责。
 */
async function transformPass(sample: VideoSample): Promise<TransformComparison[]> {
  const probe = new OffscreenCanvas(OUT, OUT);
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  if (!probeCtx) throw new Error("变换比对画布没有 2D 上下文");

  const snapshot = (compositor: Compositor, transform: LayerTransform): Bands => {
    compositor.composeFrame([{ kind: "sample", sample, transform }]);
    probeCtx.clearRect(0, 0, OUT, OUT);
    probeCtx.drawImage(compositor.canvas, 0, 0);
    return measure(probeCtx, OUT, OUT);
  };

  const pixi = await createPixiCompositor(OUT, OUT);
  const canvas2d = createCanvas2DCompositor(OUT, OUT);
  try {
    return TRANSFORM_CASES.map((testCase) => ({
      name: testCase.name,
      expected: testCase.expected,
      // 刻意让同一个合成器连着跑所有用例：slot / sprite 是跨帧复用的，
      // "上一帧有旋转、这一帧没有"是最容易残留状态的路径
      pixi: snapshot(pixi, testCase.transform),
      canvas2d: snapshot(canvas2d, testCase.transform),
    }));
  } finally {
    pixi.dispose();
    canvas2d.dispose();
  }
}

/**
 * 一级调色：**GPU 出来的像素要等于 `colorMatrixOf()` 在 CPU 上算出来的像素**。
 *
 * 这条是整个调色能力的地基。矩阵语义有单测，但"shader 有没有按这个矩阵算"
 * 单测够不着——它只能在真的跑一遍 WebGL 之后比对。写错了不会报错，画面只是
 * "看着有点怪"：在预乘 alpha 上算、偏移列当成 0–255、行列转置，三种都画得出图。
 *
 * 参照值不用写死的常量，而是**当场量一遍不调色时的像素**再喂给参照实现。
 * 这样 RGB → 纹理这一路上的任何色彩转换都从比对里消掉了，剩下的差异只可能
 * 来自滤镜本身。
 */
const COLOR_CASES: readonly { readonly name: string; readonly color?: ColorAdjust }[] = [
  { name: "饱和度 0（灰度）", color: { saturation: 0 } },
  { name: "亮度 0.5", color: { brightness: 0.5 } },
  { name: "对比度 2", color: { contrast: 2 } },
  { name: "色相转 90°", color: { hue: Math.PI / 2 } },
  { name: "四项一起调", color: { brightness: 1.2, contrast: 0.8, saturation: 1.6, hue: 0.5 } },
  // 压轴的这条最重要：**跟在调色之后的恒等帧**必须一个字节不差地回到原色。
  // 滤镜是跨帧复用的槽位状态，忘了清就会把上一帧的调色画到这一帧头上，
  // 而且只在"某帧有调色、下一帧没有"时出现——最难复现的那种
  { name: "恒等（紧跟在调色之后）" },
];

export interface ColorComparison {
  readonly name: string;
  /** 不调色时量到的像素，也就是喂给参照实现的输入。 */
  readonly base: readonly [number, number, number];
  readonly expected: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
  /** 三个通道里最差的那个差值。 */
  readonly worst: number;
}

async function colorPass(sample: VideoSample): Promise<ColorComparison[]> {
  const probe = new OffscreenCanvas(OUT, OUT);
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  if (!probeCtx) throw new Error("调色比对画布没有 2D 上下文");

  /** 取画面正中一小块的平均色。源片是纯色，所以这就是那个颜色本身。 */
  const centerColor = (compositor: Compositor): [number, number, number] => {
    probeCtx.clearRect(0, 0, OUT, OUT);
    probeCtx.drawImage(compositor.canvas, 0, 0);
    const { data } = probeCtx.getImageData(OUT / 2 - 8, OUT / 2 - 8, 16, 16);
    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
    }
    return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
  };

  const pixi = await createPixiCompositor(OUT, OUT);
  try {
    // 基准：不调色时这一层是什么颜色
    pixi.composeFrame([{ kind: "sample", sample }]);
    const base = centerColor(pixi);

    return COLOR_CASES.map((testCase) => {
      pixi.composeFrame([
        { kind: "sample", sample, ...(testCase.color ? { color: testCase.color } : {}) },
      ]);
      const actual = centerColor(pixi);
      const [er, eg, eb] = applyColorMatrix8(colorMatrixOf(testCase.color), [...base, 255]);
      const expected: [number, number, number] = [er, eg, eb];
      return {
        name: testCase.name,
        base,
        expected,
        actual,
        worst: Math.max(
          Math.abs(actual[0] - er),
          Math.abs(actual[1] - eg),
          Math.abs(actual[2] - eb),
        ),
      };
    });
  } finally {
    pixi.dispose();
  }
}

/**
 * 3D LUT：**GPU 查出来的颜色要等于 `sampleLutTexture()` 在 CPU 上查出来的**。
 *
 * 和上面调色那一段是同一个理由，但对 LUT 更要紧：调色错了还能靠"画面偏绿了"
 * 看出来，LUT 本来就是用来把颜色改成另一样的，查歪了肉眼根本分不出来。
 * 半纹素偏移、切片拼接、蓝方向的手动 lerp，三处任何一处写错都只会让颜色偏一点。
 *
 * 四个用例覆盖四类失效：
 *
 * - **恒等 LUT**：查表这条路本身不能改变画面。这条最强——它不需要知道"应该"是
 *   什么颜色，任何一处偏移写错都会打破它。
 * - **通道互换**：线性映射，三线性插值处处精确，所以可以按精确值断言。
 * - **强度 0.5**：混合系数走的是另一条分支。
 * - **调色 + LUT 同时**：钉住**顺序**（先调色再 LUT）。顺序反了两条单独的断言
 *   都还是绿的，只有这条会红。
 */
const LUT_SIZE = 17;
/**
 * 第二张恒等 LUT 刻意用**很小的尺寸**。
 *
 * 半纹素偏移写错时，误差大小与格点间距成正比：17³ 上只差 4/255（刚压在容差线上，
 * 实测过），5³ 上就是 17/255。这条探针不是为了"真实"，是为了**把我们最怕的那类
 * 错误放大到不可能漏判**——用真实尺寸去测一个亚纹素级的偏移，等于把断言的余量
 * 交给运气。
 */
const SMALL_LUT_SIZE = 5;
const LUT_CASES = [
  { name: "恒等 LUT（查表本身不改画面）", kind: "identity" },
  { name: "恒等 LUT · 5³（放大半纹素偏移）", kind: "small" },
  { name: "通道互换 RGB → BRG", kind: "swap" },
  { name: "通道互换 · 强度 50%", kind: "swap", intensity: 0.5 },
  { name: "先调色再 LUT（顺序）", kind: "swap", color: { saturation: 0, brightness: 1.4 } },
  { name: "恒等（紧跟在 LUT 之后）", kind: "none" },
] as const;

export interface LutComparison {
  readonly name: string;
  readonly base: readonly [number, number, number];
  readonly expected: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
  readonly worst: number;
}

async function lutPass(sample: VideoSample): Promise<LutComparison[]> {
  const probe = new OffscreenCanvas(OUT, OUT);
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  if (!probeCtx) throw new Error("LUT 比对画布没有 2D 上下文");

  const centerColor = (compositor: Compositor): [number, number, number] => {
    probeCtx.clearRect(0, 0, OUT, OUT);
    probeCtx.drawImage(compositor.canvas, 0, 0);
    const { data } = probeCtx.getImageData(OUT / 2 - 8, OUT / 2 - 8, 16, 16);
    let r = 0;
    let g = 0;
    let b = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
    }
    return [Math.round(r / pixels), Math.round(g / pixels), Math.round(b / pixels)];
  };

  const identity = identityLut(LUT_SIZE);
  const small = identityLut(SMALL_LUT_SIZE);
  // 红→蓝、绿→红、蓝→绿：线性映射，所以三线性插值精确，断言可以写得很紧
  const swap = swapLut(LUT_SIZE);
  const identityTex = buildLutTexture(identity);
  const smallTex = buildLutTexture(small);
  const swapTex = buildLutTexture(swap);

  const pixi = await createPixiCompositor(OUT, OUT);
  try {
    pixi.composeFrame([{ kind: "sample", sample }]);
    const base = centerColor(pixi);

    return LUT_CASES.map((testCase) => {
      const lut =
        testCase.kind === "identity"
          ? identity
          : testCase.kind === "small"
            ? small
            : testCase.kind === "swap"
              ? swap
              : undefined;
      const tex =
        testCase.kind === "identity" ? identityTex : testCase.kind === "small" ? smallTex : swapTex;
      const intensity = "intensity" in testCase ? testCase.intensity : 1;
      const color = "color" in testCase ? testCase.color : undefined;
      const adjust =
        color || intensity !== 1
          ? { ...(color ?? {}), ...(intensity !== 1 ? { lutIntensity: intensity } : {}) }
          : undefined;

      pixi.composeFrame([
        {
          kind: "sample",
          sample,
          ...(adjust ? { color: adjust } : {}),
          ...(lut ? { lut } : {}),
        },
      ]);
      const actual = centerColor(pixi);

      // CPU 参照：**顺序必须和 applyEffects 一致**——先色彩矩阵，再查表
      const [mr, mg, mb] = applyColorMatrix8(colorMatrixOf(adjust), [...base, 255]);
      const expected: [number, number, number] = lut
        ? sampleLutTexture8(tex, [mr, mg, mb], intensity)
        : [mr, mg, mb];

      return {
        name: testCase.name,
        base,
        expected,
        actual,
        worst: Math.max(
          Math.abs(actual[0] - expected[0]),
          Math.abs(actual[1] - expected[1]),
          Math.abs(actual[2] - expected[2]),
        ),
      };
    });
  } finally {
    pixi.dispose();
  }
}

/**
 * shader 转场的取样点。
 *
 * **刻意挑在羽化带和硬边界两侧**，而不是随便找几个点：擦除类效果在带外是纯色，
 * 那里 GPU 和参照实现"一致"只说明两边都读到了同一层，说明不了混合算得对。
 * 每个用例都带一个落在带内（或紧贴 slide 硬边界）的点。
 */
const TRANSITION_CASES = [
  { name: "擦除 · t=0.25（带外·出场侧）", effect: "wipe", progress: 0.25, u: 0.7, v: 0.5 },
  { name: "擦除 · t=0.5（羽化带正中）", effect: "wipe", progress: 0.5, u: 0.5, v: 0.5 },
  { name: "擦除 · t=0.5（带内偏入场）", effect: "wipe", progress: 0.5, u: 0.495, v: 0.5 },
  { name: "圆形张开 · t=0.5（中心）", effect: "iris", progress: 0.5, u: 0.5, v: 0.5 },
  { name: "圆形张开 · t=0.5（半径上的羽化带）", effect: "iris", progress: 0.5, u: 0.5, v: 0.146 },
  { name: "推移 · t=0.4（出场侧）", effect: "slide", progress: 0.4, u: 0.3, v: 0.5 },
  { name: "推移 · t=0.4（入场侧）", effect: "slide", progress: 0.4, u: 0.8, v: 0.5 },
] as const;

/**
 * 故障的**纯色层**用例：验的是整数哈希。
 *
 * 某条带在 GPU 上算出不同的翻转时刻，这一点就整块取到另一层，两个纯色差 200 个
 * 色阶，红得不可能看漏——这正是把故障拖到最后的那件事（见 D20）。
 *
 * **带号由参照实现挑，不手写。** 第一版手挑了第 0 / 7 / 15 条带，结果三条在
 * `t=0.5` 时恰好都已经翻过（每条带翻转与否各 50%，三条同侧的概率 1/8），于是
 * "不同的带给出不同像素"那条假红。同 CLAUDE.md 那条"挑用例时要先问被测的那个量
 * 在这里是不是恰好等于零/一"，这里的形态是：**让参照实现自己挑出有区分力的取样点**。
 * 挑不出来就抛错，那说明常量被改得所有带同时翻，这一组从此是空断言。
 */
function glitchBandCases(): {
  readonly name: string;
  readonly effect: "glitch";
  readonly progress: number;
  readonly u: number;
  readonly v: number;
}[] {
  const bandV = (band: number) => (band + 0.5) / GLITCH_BLOCKS;
  const flipped = (band: number) => glitchPoint(0.5, bandV(band), 0.5).useTo;
  let already = -1;
  let notYet = -1;
  for (let band = 0; band < GLITCH_BLOCKS; band++) {
    if (flipped(band)) {
      if (already < 0) already = band;
    } else if (notYet < 0) notYet = band;
  }
  if (already < 0 || notYet < 0) {
    throw new Error(
      `故障用例挑不出有区分力的带：t=0.5 时 16 条带全部${already < 0 ? "未翻" : "已翻"}，` +
        "「不同的带给出不同像素」会变成空断言",
    );
  }
  return [
    { name: `故障 · t=0.5（第 ${already} 条带，已翻）`, effect: "glitch", progress: 0.5, u: 0.5, v: bandV(already) },
    { name: `故障 · t=0.5（第 ${notYet} 条带，未翻）`, effect: "glitch", progress: 0.5, u: 0.5, v: bandV(notYet) },
    // 同一条带的两个进度：钉的是"翻转时刻"这个量本身，而不只是"带之间不同"
    { name: `故障 · t=0.1（第 ${already} 条带）`, effect: "glitch", progress: 0.1, u: 0.5, v: bandV(already) },
    { name: `故障 · t=0.9（第 ${notYet} 条带）`, effect: "glitch", progress: 0.9, u: 0.5, v: bandV(notYet) },
  ];
}

/**
 * 故障的**位移**用两色层单独验一组。
 *
 * 纯色层看不出位移（在哪儿取都一样），而位移是这个效果一半的内容：把
 * `clamp(vUV.x + amp, …)` 写成 `vUV.x - amp` 或 `vUV.y + amp` 都画得出图、
 * 上面那五条也全绿。这里把 `from` 层做成左右两色，取样点选在竖直分界线附近、
 * 距分界 0.02（OUT=320 上是 6 像素，远离双线性过滤影响的范围），于是"位移有没有
 * 把取样点推过分界"就是一个整色阶的差别。
 *
 * 进度取各带窗口的**中点附近**——那里幅度最大（抛物线的顶点）。具体是哪条带的
 * 中点由哈希决定，所以这里不写死进度，由 `glitchShiftCases()` 现算。
 */
const GLITCH_SPLIT_U = 0.5;
/** 取样点离分界多远。要大于过滤半径、小于最大位移（0.08）。 */
const GLITCH_PROBE_OFFSET = 0.02;

export interface TransitionComparison {
  readonly name: string;
  readonly expected: readonly [number, number, number];
  readonly actual: readonly [number, number, number];
  readonly worst: number;
  /** 该点与"只画出场层"和"只画入场层"的差，用来证明这一点真的被混过。 */
  readonly awayFromPure: number;
}

/**
 * GPU 的双输入 shader 对上 `mixTransition()` 的 CPU 参照。
 *
 * 两个输入用**纯色铺满**输出（正方形源 → 没有留边），于是任意取样点上"该层的
 * 颜色"是已知常量，参照值可以精确算出来，不受纹理过滤影响。slide 要在别的
 * 坐标取样，但纯色层在哪儿取都一样——**这正是用纯色的理由**：它把被测对象
 * 从"采样精度"里剥出来，只剩下混合函数本身。
 */
async function transitionPass(): Promise<TransitionComparison[]> {
  const probe = new OffscreenCanvas(OUT, OUT);
  const probeCtx = probe.getContext("2d", { willReadFrequently: true });
  if (!probeCtx) throw new Error("转场比对画布没有 2D 上下文");

  const solid = (r: number, g: number, b: number): OffscreenCanvas => {
    const cv = new OffscreenCanvas(OUT, OUT);
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("造纯色层失败");
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, OUT, OUT);
    return cv;
  };

  const FROM_RGB: [number, number, number] = [220, 40, 30];
  const TO_RGB: [number, number, number] = [20, 60, 210];
  const fromLayer = {
    kind: "image" as const,
    image: solid(...FROM_RGB),
    width: OUT,
    height: OUT,
  };
  const toLayer = { kind: "image" as const, image: solid(...TO_RGB), width: OUT, height: OUT };

  const pixelAt = (u: number, v: number): [number, number, number] => {
    probeCtx.clearRect(0, 0, OUT, OUT);
    probeCtx.drawImage(pixiCanvasOf(), 0, 0);
    const x = Math.min(OUT - 1, Math.max(0, Math.round(u * OUT - 0.5)));
    const y = Math.min(OUT - 1, Math.max(0, Math.round(v * OUT - 0.5)));
    const { data } = probeCtx.getImageData(x, y, 1, 1);
    return [data[0]!, data[1]!, data[2]!];
  };

  let canvasRef: OffscreenCanvas | HTMLCanvasElement | null = null;
  const pixiCanvasOf = () => canvasRef!;

  /** 左右两色的层。故障位移那一组用它——纯色层看不出位移。 */
  const split = (
    left: readonly [number, number, number],
    right: readonly [number, number, number],
  ): OffscreenCanvas => {
    const cv = new OffscreenCanvas(OUT, OUT);
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("造两色层失败");
    ctx.fillStyle = `rgb(${left[0]},${left[1]},${left[2]})`;
    ctx.fillRect(0, 0, Math.round(OUT * GLITCH_SPLIT_U), OUT);
    ctx.fillStyle = `rgb(${right[0]},${right[1]},${right[2]})`;
    ctx.fillRect(Math.round(OUT * GLITCH_SPLIT_U), 0, OUT, OUT);
    return cv;
  };

  // 四色互不相同：于是取样点的颜色同时说明"取的哪一层"和"分界哪一侧"
  const FROM_L: [number, number, number] = [230, 30, 30];
  const FROM_R: [number, number, number] = [230, 200, 30];
  const TO_L: [number, number, number] = [30, 60, 220];
  const TO_R: [number, number, number] = [30, 200, 120];
  const splitFrom = { kind: "image" as const, image: split(FROM_L, FROM_R), width: OUT, height: OUT };
  const splitTo = { kind: "image" as const, image: split(TO_L, TO_R), width: OUT, height: OUT };

  const pixi = await createPixiCompositor(OUT, OUT);
  canvasRef = pixi.canvas;
  try {
    const asRgba01 = (c: readonly [number, number, number]) => ({
      r: c[0] / 255,
      g: c[1] / 255,
      b: c[2] / 255,
      a: 1,
    });
    const dist = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
      Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

    const shiftCases: TransitionComparison[] = glitchShiftCases().map((testCase) => {
      pixi.composeFrame([
        {
          kind: "transition",
          from: splitFrom,
          to: splitTo,
          progress: testCase.progress,
          effect: "glitch",
        },
      ]);
      const actual = pixelAt(testCase.u, testCase.v);
      // 取样点同样落在像素中心，与 GPU 光栅化一致
      const px = Math.min(OUT - 1, Math.max(0, Math.round(testCase.u * OUT - 0.5)));
      const py = Math.min(OUT - 1, Math.max(0, Math.round(testCase.v * OUT - 0.5)));
      const cu = (px + 0.5) / OUT;
      const cv = (py + 0.5) / OUT;
      // 参照实现按同一条分界取色。分界用 `<` 而不是 `<=`：GPU 那边分界左侧最后
      // 一个纹素中心是 (OUT/2 - 0.5)/OUT < 0.5，两边判据必须同向
      const mixed = mixTransition("glitch", asRgba01(FROM_L), asRgba01(TO_L), cu, cv, testCase.progress, {
        from: (su) => asRgba01(su < GLITCH_SPLIT_U ? FROM_L : FROM_R),
        to: (su) => asRgba01(su < GLITCH_SPLIT_U ? TO_L : TO_R),
      });
      const expected: [number, number, number] = [
        Math.round(mixed.r * 255),
        Math.round(mixed.g * 255),
        Math.round(mixed.b * 255),
      ];
      return {
        name: testCase.name,
        expected,
        actual,
        worst: dist(actual, expected),
        // 这一组的两层都不是纯色，这个诊断值对它没有意义，报 0 免得被上面
        // 那条"羽化带确实混过"的过滤误捡（它按名字过滤，这里的名字不含"羽化带"）
        awayFromPure: 0,
      };
    });

    const solidCases = [...TRANSITION_CASES, ...glitchBandCases()].map((testCase) => {
      pixi.composeFrame([
        {
          kind: "transition",
          from: fromLayer,
          to: toLayer,
          progress: testCase.progress,
          effect: testCase.effect,
        },
      ]);
      const actual = pixelAt(testCase.u, testCase.v);

      // CPU 参照。两层都是纯色，所以 slide 的位移取样返回的还是同一个常量
      const asRgba = (c: readonly [number, number, number]) => ({
        r: c[0] / 255,
        g: c[1] / 255,
        b: c[2] / 255,
        a: 1,
      });
      // 取样点用**像素中心**，与 GPU 光栅化落点一致；用格点会在羽化带上差半个纹素
      const px = Math.min(OUT - 1, Math.max(0, Math.round(testCase.u * OUT - 0.5)));
      const py = Math.min(OUT - 1, Math.max(0, Math.round(testCase.v * OUT - 0.5)));
      const cu = (px + 0.5) / OUT;
      const cv = (py + 0.5) / OUT;
      const mixed = mixTransition(
        testCase.effect,
        asRgba(FROM_RGB),
        asRgba(TO_RGB),
        cu,
        cv,
        testCase.progress,
        { from: () => asRgba(FROM_RGB), to: () => asRgba(TO_RGB) },
      );
      const expected: [number, number, number] = [
        Math.round(mixed.r * 255),
        Math.round(mixed.g * 255),
        Math.round(mixed.b * 255),
      ];

      return {
        name: testCase.name,
        expected,
        actual,
        worst: dist(actual, expected),
        // 离两个纯色都远 = 这一点确实被混过；两者取小，所以纯色点会得到 0
        awayFromPure: Math.min(dist(actual, FROM_RGB), dist(actual, TO_RGB)),
      };
    });

    return [...solidCases, ...shiftCases];
  } finally {
    pixi.dispose();
  }
}

/**
 * 故障位移那一组：两色层 + 成对的取样点。
 *
 * 挑选规则是**必须能区分**：取样点固定在分界左/右 `GLITCH_PROBE_OFFSET`，进度取
 * 该带位移最大的那一刻，而只有 `|位移| > offset` 的带才会把取样推过分界。所以这里
 * 先用参照实现扫一遍找出合格的带，**一条都找不到就抛错**——那说明常量被改小了，
 * 这一组从此变成永远绿的空断言，而那比红更坏。
 *
 * 证明链是：参照实现真的在位移（单测钉住：窗口中点幅度 = `GLITCH_SHIFT × dir`、
 * 两端为 0），而 GPU == 参照（下面这一组进上面那条聚合断言）。所以 GPU 也在位移。
 * 单靠"GPU == 参照"不够——两边都不位移时它们照样相等，正是靠"用例能区分"这一条
 * 把那种情形排除掉的。
 */
function glitchShiftCases(): {
  readonly name: string;
  readonly progress: number;
  readonly u: number;
  readonly v: number;
}[] {
  const cases: { name: string; progress: number; u: number; v: number }[] = [];
  for (let band = 0; band < GLITCH_BLOCKS && cases.length < 3; band++) {
    const v = (band + 0.5) / GLITCH_BLOCKS;
    // 扫一遍进度找位移最大的那一刻。不去反推哈希——那等于把哈希抄第二遍
    let peak = { progress: 0, amp: 0 };
    for (let i = 0; i <= 200; i++) {
      const progress = i / 200;
      const amp = glitchPoint(GLITCH_SPLIT_U, v, progress).u - GLITCH_SPLIT_U;
      if (Math.abs(amp) > Math.abs(peak.amp)) peak = { progress, amp };
    }
    if (Math.abs(peak.amp) <= GLITCH_PROBE_OFFSET * 1.5) continue;

    // 取样点放在位移**来向**那一侧，于是位移会把它推过分界
    const u = GLITCH_SPLIT_U - Math.sign(peak.amp) * GLITCH_PROBE_OFFSET;
    cases.push(
      { name: `故障位移 · 第 ${band} 条带（最大位移，应当跨过分界）`, progress: peak.progress, u, v },
      // 同一点、零位移的那一刻：t=0 时幅度恒为 0（单测钉住），取的是分界这一侧
      { name: `故障位移 · 第 ${band} 条带（t=0，不位移）`, progress: 0, u, v },
    );
  }
  if (cases.length === 0) {
    throw new Error(
      `故障位移用例挑不出来：最大位移 ${GLITCH_SHIFT} 不足以跨过 ${GLITCH_PROBE_OFFSET}，` +
        "这一组会变成永远绿的空断言",
    );
  }
  return cases;
}

/** 红→蓝、绿→红、蓝→绿。线性映射，插值精确，适合当断言的真值。 */
function swapLut(size: number): LutData {
  const rgb = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const d = size - 1;
        rgb[i++] = b / d;
        rgb[i++] = r / d;
        rgb[i++] = g / d;
      }
    }
  }
  return { size, rgb, title: "swap" };
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
 * GL 上下文丢失之后：**先要报错，再要能救回来。**
 *
 * Canvas2D 没有这个失效模式，WebGL 有：导出跑几分钟，期间切标签页、系统休眠、
 * 驱动重置都可能触发；上下文超预算被驱逐是第四种（见 `probeContextBudget`）。
 * 默认行为是渲染变成 no-op——也就是静默写出几百帧黑画面。
 *
 * 两问缺一不可：
 *
 * - **报不报错**：不报错就是静默产出黑片，比崩掉还糟。
 * - **救不救得回来**：这是换后端的前置条件之一。丢失在生产里不是异常而是常态
 *   （用户切个标签页就可能触发），每次都要求"重开项目"是不可接受的。
 *
 * 恢复之后**比对画面内容**而不只是"不黑"：GPU 资源在丢失时全部作废，Pixi 若没能
 * 重新上传纹理，画出来会是别的东西——纯色、上一帧、乱码——那些都不是黑的。
 */
async function probeContextLoss(
  sample: VideoSample,
  afterSample: VideoSample,
  afterExpectedHue: number,
): Promise<PixiProbeReport["contextLoss"]> {
  const blank = {
    recovered: false,
    beforeMaxChannel: 0,
    afterMaxChannel: 0,
    beforeHue: 0,
    afterHue: 0,
    afterExpectedHue,
    recoverDetail: "",
  };

  const compositor = await createPixiCompositor(OUT, OUT);
  const draw = (which: VideoSample): { maxChannel: number; hue: number } => {
    compositor.composeFrame([{ kind: "sample", sample: which }]);
    const probe = new OffscreenCanvas(OUT, OUT);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("探测画布没有 2D 上下文");
    ctx.drawImage(compositor.canvas, 0, 0);
    const measured = measure(ctx, OUT, OUT);
    return { maxChannel: measured.maxChannel, hue: measured.hue };
  };

  try {
    // 丢之前先确认它是能画的，否则下面的"抛错"可能是别的原因
    const before = draw(sample);

    if (!compositor.debug.loseContext()) {
      return {
        ...blank,
        extensionAvailable: false,
        threwAfterLoss: false,
        detail: "浏览器不提供 WEBGL_lose_context，这条只能手动验证",
        beforeMaxChannel: before.maxChannel,
        beforeHue: before.hue,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    let threwAfterLoss: boolean;
    let detail: string;
    try {
      compositor.composeFrame([{ kind: "sample", sample }]);
      threwAfterLoss = false;
      detail = "composeFrame 没有抛错——上下文丢失会静默产出黑帧";
    } catch (error) {
      threwAfterLoss = true;
      detail = describe(error);
    }

    // ---- 再问第二件事：救得回来吗 ----
    let recovered = false;
    let after = { maxChannel: 0, hue: 0 };
    let recoverDetail: string;
    try {
      recovered = await compositor.recover();
      if (!recovered) {
        recoverDetail = "recover() 超时，上下文没回来";
      } else if (compositor.isContextLost()) {
        recoverDetail = "recover() 说成功了但 isContextLost() 仍为真——两处判据不一致";
        recovered = false;
      } else {
        after = draw(afterSample);
        recoverDetail =
          `恢复后画的是**另一帧**，色相 ${after.hue}°（期望 ${afterExpectedHue}°，丢失前那帧是 ${before.hue}°）`;
      }
    } catch (error) {
      recoverDetail = `恢复过程抛错：${describe(error)}`;
    }

    return {
      extensionAvailable: true,
      threwAfterLoss,
      detail,
      recovered,
      beforeMaxChannel: before.maxChannel,
      afterMaxChannel: after.maxChannel,
      beforeHue: before.hue,
      afterHue: after.hue,
      afterExpectedHue,
      recoverDetail,
    };
  } finally {
    // 上下文可能已经没了，destroy 自己可能抛，不影响上面的结论
    try {
      compositor.dispose();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * WebGL 上下文预算：**复用**一个常驻合成器 vs **每轮新建**，长命的那个（预览）活不活。
 *
 * 浏览器对同时存活的 WebGL 上下文有预算，超了就把**最老的那个**丢掉。Safari 在这个
 * spike 里连报 `There are too many active WebGL contexts on this page, the oldest
 * context will be lost`——说明 `dispose()` 没有立刻把上下文还回去，而是等 GC。
 * Canvas2D 完全没有这个失效模式，是换后端**新引入**的风险。
 *
 * 危险的是**老的那个**，不是新的：驱逐顺序是"最老先死"，而生产里最老的正是预览——
 * 它从打开项目起就一直握着一个合成器。用户每导出一次就产生一轮创建/销毁，
 * 十几次之后被判死的是预览，表现为"我只是导出了几次，预览黑了"。
 *
 * 所以这里跑**两组对照**：
 *
 * - **复用组**：一个常驻合成器被用 12 轮（生产架构，见 `pipeline.ts` 的
 *   `acquireCompositor`）。这一组是验收——它必须活。
 * - **对照组**：每轮新建 + 销毁（旧架构）。它在 Safari 上会把预览判死，
 *   而且**救不回来**（`recover()` 超时：浏览器要等预算腾出来才还）。
 *   这一组只记录，不断言——它测的是我们已经废弃的做法，永远红没有意义，
 *   但那个数字正是"为什么必须复用"的证据，所以留着。
 *
 * 顺序不能反：对照组会污染上下文预算，先跑它的话复用组量到的就不是干净状态。
 *
 * 刻意不去数上下文（没有跨浏览器的 API 可数），只问画得出画不出——那是用户遇到的形态。
 */
async function probeContextBudget(
  sample: VideoSample,
): Promise<PixiProbeReport["contextBudget"]> {
  const draw = (compositor: Compositor): number => {
    compositor.composeFrame([{ kind: "sample", sample }]);
    const probe = new OffscreenCanvas(OUT, OUT);
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("探测画布没有 2D 上下文");
    ctx.drawImage(compositor.canvas, 0, 0);
    return measure(ctx, OUT, OUT).maxChannel;
  };

  const safely = (label: string, run: () => number): { value: number; note: string } => {
    try {
      const value = run();
      return { value, note: value > 32 ? `${label}画得出` : `${label}画出来是黑的` };
    } catch (error) {
      return { value: 0, note: `${label}抛错：${describe(error)}` };
    }
  };

  const notes: string[] = [];

  // ---- 复用组（生产架构）：一个常驻合成器用 12 轮，长命的那个必须活下来 ----
  let reuseLongLived = 0;
  {
    const preview = await createPixiCompositor(OUT, OUT);
    const resident = await createPixiCompositor(OUT, OUT);
    try {
      if (draw(preview) <= 32) {
        return {
          cycles: CONTEXT_BUDGET_CYCLES,
          survivedCycles: 0,
          reuseLongLivedMaxChannel: 0,
          churnLongLivedMaxChannel: 0,
          freshMaxChannel: 0,
          churnLongLivedRecovered: false,
          detail: "长命合成器一开始就画不出东西，后面的结论都不成立",
        };
      }
      for (let i = 0; i < CONTEXT_BUDGET_CYCLES; i++) {
        resident.composeFrame([{ kind: "sample", sample }]);
      }
      const result = safely("复用组里的预览", () => draw(preview));
      reuseLongLived = result.value;
      notes.push(result.note);
    } finally {
      for (const c of [resident, preview]) {
        try {
          c.dispose();
        } catch {
          /* 上下文可能已经没了 */
        }
      }
    }
  }

  // ---- 对照组（旧架构）：每轮新建 + 销毁 ----
  const longLived = await createPixiCompositor(OUT, OUT);
  try {
    let survivedCycles = 0;
    let cycleError = "";
    for (let i = 0; i < CONTEXT_BUDGET_CYCLES; i++) {
      const short = await createPixiCompositor(OUT, OUT);
      try {
        short.composeFrame([{ kind: "sample", sample }]);
        survivedCycles = i + 1;
      } catch (error) {
        cycleError = `对照组第 ${i + 1} 轮就画不出来了：${describe(error)}`;
        break;
      } finally {
        short.dispose();
      }
    }

    const longLivedResult = safely("对照组里的预览", () => draw(longLived));
    const fresh = await createPixiCompositor(OUT, OUT);
    let freshResult: { value: number; note: string };
    try {
      freshResult = safely("对照组之后新建的", () => draw(fresh));
    } finally {
      try {
        fresh.dispose();
      } catch {
        /* 上下文可能已经没了，destroy 自己会抛 */
      }
    }

    // 被驱逐了的话问一句：还救得回来吗？救不回来才说明"复用"是唯一解
    let churnRecovered = false;
    if (longLivedResult.value <= 32) {
      try {
        churnRecovered = (await longLived.recover()) && safely("恢复后", () => draw(longLived)).value > 32;
        notes.push(churnRecovered ? "对照组被驱逐后能救回来" : "对照组被驱逐后**救不回来**");
      } catch (error) {
        notes.push(`对照组恢复时抛错：${describe(error)}`);
      }
    }

    return {
      cycles: CONTEXT_BUDGET_CYCLES,
      survivedCycles,
      reuseLongLivedMaxChannel: reuseLongLived,
      churnLongLivedMaxChannel: longLivedResult.value,
      freshMaxChannel: freshResult.value,
      churnLongLivedRecovered: churnRecovered,
      detail: [cycleError, ...notes, longLivedResult.note, freshResult.note]
        .filter(Boolean)
        .join("；"),
    };
  } finally {
    try {
      longLived.dispose();
    } catch {
      /* 同上 */
    }
  }
}

async function run(): Promise<PixiProbeReport> {
  const samples = makeSourceSamples(FRAMES, SRC_WIDTH, SRC_HEIGHT);
  const probeSample = samples[0]!;
  const recoverSample = samples[RECOVER_SAMPLE_INDEX]!;

  try {
    const avc = await getFirstEncodableVideoCodec(["avc"], { width: OUT, height: OUT });
    const container: "mp4" | "webm" = avc ? "mp4" : "webm";
    const codec =
      avc ?? (await getFirstEncodableVideoCodec(["vp9", "vp8"], { width: OUT, height: OUT }));
    if (!codec) throw new Error("这个浏览器编不了 AVC / VP9 / VP8，spike 没法跑");

    // ---- 0. 吞吐先跑 ----
    // 必须在**一个 Pixi 上下文都还没建过**的时候量。放在最后跑时，前面几个探针
    // 已经创建又销毁过 4 个上下文，而 dispose() 未必立刻把它们还回去
    // （Safari 会报 "too many active WebGL contexts"）——那样量到的是带着
    // GPU 内存压力的数字，不是导出的常态。这一段自己会各建一个后端再销毁
    const perf = await throughputPass(container, codec);

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

    // ---- 5. 图层变换：两个后端摆位是否一致、是否落在手算的位置上 ----
    const transforms = await transformPass(probeSample);

    // ---- 5b. 一级调色：GPU 算出来的颜色是不是 colorMatrixOf() 那个矩阵 ----
    const colors = await colorPass(probeSample);

    // ---- 5c. 3D LUT：GPU 查出来的是不是 sampleLutTexture() 查出来的 ----
    const luts = await lutPass(probeSample);
    const transitions = await transitionPass();

    // ---- 6. 三个失效模式 ----
    // 上下文预算放最后：它会连开十几个上下文，跑完之后 GPU 侧的状态最脏，
    // 别的探针再跟在后面就说不清失败是自己的问题还是被它拖累的
    const drawingBuffer = await probeDrawingBuffer(probeSample);
    const contextLoss = await probeContextLoss(
      probeSample,
      recoverSample,
      sampleHueAt(RECOVER_SAMPLE_INDEX, FRAMES),
    );
    const contextBudget = await probeContextBudget(probeSample);

    return {
      contextVersion,
      container,
      codec,
      textures: { afterFirstFrame: texturesAfterFirstFrame, afterLastFrame: texturesAfterLastFrame },
      drawingBuffer,
      contextLoss,
      contextBudget,
      composeMs: { pixi: composePixiMs, canvas2d: composeCanvas2dMs },
      encodeMs: { pixi: encodePixiMs, canvas2d: encodeCanvas2dMs },
      frames: PROBE_FRAMES.map((index, i) => ({
        index,
        expectedHue: sampleHueAt(index, FRAMES),
        pixi: pixiBands[i]!,
        canvas2d: canvas2dBands[i]!,
      })),
      frameCount: FRAMES,
      transforms,
      colors,
      luts,
      transitions,
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
