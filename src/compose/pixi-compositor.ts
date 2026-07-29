/**
 * PixiJS v8 后端的合成器——**预览和导出的默认后端**（2026-07-27 接入，见 D16），
 * 也是一级调色 / LUT / shader 转场这些只有 GPU 才做得了的能力的落点。
 *
 * 它实现的是 `compositor.ts` 里那个 `Compositor` 接口，和 Canvas2D 后端可互换；
 * 选哪个只在 `backend.ts` 一处决定，起不来才退回 Canvas2D。谁静态 import 本文件
 * 都不会把 Pixi 拖进自己的 chunk——见下面第 1 条。
 *
 * 六条实现约束，每一条都对应一个"不这么写就会静默出错"的坑：
 *
 * 1. **工厂 async、`composeFrame` 同步。** Pixi 走动态 `import()`（不能进主 chunk，
 *    见 CLAUDE.md 的体积一节），但调用点在 rAF 回调和导出逐帧循环里，每帧 await
 *    一次动态 import 不可接受。所以边界划在"创建时"而不是"调用时"。
 *    注意本文件对 pixi.js **只有 `import type`**，因此谁静态 import 它都不会
 *    把 Pixi 拖进自己的 chunk。
 * 2. **只用 WebGL，不用 WebGPU。** Pixi v8 默认优先 WebGPU，两个后端等于两套
 *    光栅化行为——同一份 EDL 在不同机器上出不同画面。导出要的是确定性。
 * 3. **Worker 里必须先切 `WebWorkerAdapter`。** 默认的 BrowserAdapter 会去
 *    `document.createElement('canvas')`，Worker 里没有 document。
 * 4. **每个图层一个常驻 `ImageSource`，逐帧只换 `resource` 再 `update()`。**
 *    每帧 `Texture.from(frame)` 会逐帧新建 GPU 纹理，导出会慢一个量级。
 *    尺寸不变时 Pixi 的上传走 `texSubImage2D`，复用同一个 GL 纹理对象。
 * 5. **临时 `VideoFrame` 必须在 `render()` 之后才 close。** 纹理上传发生在
 *    render 期间，提前 close 会上传到一个已关闭的帧。Canvas2D 后端里
 *    `drawImage` 是立即的，所以那边可以画完就关——这条差异换后端时最容易踩。
 * 6. **没用效果的图层不能挂滤镜。** 挂上 filter（哪怕是单位阵 / 恒等 LUT）Pixi
 *    就会先把 sprite 渲进临时纹理再合成，多一次重采样；而且滤镜也是跨帧复用的
 *    槽位状态，上一帧的效果不清掉会画到这一帧头上。见 `applyEffects`。
 *
 * 另外开了 `preserveDrawingBuffer`。WebGL 的 drawing buffer 默认在下一帧被丢弃，
 * 而导出是"合成一帧、立刻把画布交给编码器"——两者在同一个 task 里时本来没问题，
 * 但这个不变量太脆：中间插进任何一个 await 就会间歇性产出黑帧，且不报错。
 * 这里的画布每帧都要被读走，本来就没有可保留的合成快路径，关掉省不到什么。
 */

import type {
  ColorMatrixFilter,
  Container,
  Filter,
  Geometry,
  ICanvas,
  ImageResource,
  ImageSource,
  Mesh,
  RenderTexture,
  Shader,
  Sprite,
  Texture,
  WebGLRenderer,
} from "pixi.js";

import { colorMatrixOf, isDefaultColorMatrix, lutIntensityOf, type ColorAdjust } from "./color";
import { buildLutTexture, LUT_FRAGMENT, LUT_VERTEX, type LutTable } from "./lut";
import {
  GLITCH_BLOCKS,
  GLITCH_SHIFT,
  GLITCH_WINDOW,
  TRANSITION_CODES,
  TRANSITION_FEATHER,
  TRANSITION_FRAGMENT,
  TRANSITION_VERTEX,
} from "./transition-shader";
import {
  containRect,
  isDefaultGeometry,
  placeLayer,
  type ComposeSourceLayer,
  type Compositor,
} from "./compositor";

/** 仅供自检使用的观察窗口。生产代码不要依赖这里的任何东西。 */
export interface PixiCompositorDebug {
  /** 渲染器当前托管的 GPU 纹理数。逐帧新建纹理时它会随帧数增长。 */
  managedTextureCount(): number;
  /** 形如 `WebGL 2.0 (OpenGL ES 3.0 Chromium)`，用来确认真的跑在 WebGL2 上。 */
  contextVersion(): string;
  /** 主动丢掉 GL 上下文（`WEBGL_lose_context`）。返回 false 表示浏览器不给这个扩展。 */
  loseContext(): boolean;
  contextLost(): boolean;
}

export interface PixiCompositor extends Compositor {
  readonly debug: PixiCompositorDebug;
}

interface LayerSlot {
  readonly source: ImageSource;
  readonly texture: Texture;
  readonly sprite: Sprite;
  /**
   * 调色滤镜。**懒建并跨帧复用**——和 `ImageSource` 是同一个理由：
   * 每帧 `new ColorMatrixFilter()` 会逐帧新建 GPU 资源，导出慢一个量级。
   * 没调过色的图层永远不会建它（`null`）。
   */
  colorFilter: ColorMatrixFilter | null;
  /** LUT 滤镜，同上懒建。 */
  lutFilter: Filter | null;
  /** `lutFilter` 当前装的是哪张表；换表时才重新上传纹理。 */
  lutData: LutTable | null;
  /** LUT 查找纹理。跟着 `lutFilter` 的生命周期走。 */
  lutTexture: Texture | null;
}

/**
 * 一个 shader 转场节点的常驻 GPU 资源。
 *
 * 每个转场要**两张输出尺寸的渲染目标**外加一个全屏网格。全部跨帧复用，理由同
 * 文件头第 4 条：逐帧新建渲染目标比逐帧新建纹理更贵，而这一整套只在"这一帧
 * 有转场"时才第一次建出来——没用转场的项目一张渲染目标都不会有。
 */
interface TransitionSlot {
  /** 两个输入各自的槽位。它们的 sprite **不在 stage 上**，只在自己的离屏容器里。 */
  readonly fromSlot: LayerSlot;
  readonly toSlot: LayerSlot;
  readonly fromScratch: Container;
  readonly toScratch: Container;
  fromTexture: RenderTexture;
  toTexture: RenderTexture;
  /**
   * 全屏四边形，挂在 stage 上，按 z 序参与合成。
   *
   * 泛型要显式写成 `<Geometry, Shader>`：`Mesh` 的默认参数是
   * `<MeshGeometry, TextureShader>`，而我们给的是自建几何 + 自建着色器。
   */
  readonly mesh: Mesh<Geometry, Shader>;
  readonly shader: Shader;
}

/** `recover()` 等上下文回来的上限。浏览器主动恢复通常在一两帧内，给足富余。 */
const RECOVER_TIMEOUT_MS = 3_000;
/** 轮询间隔。事件在 OffscreenCanvas 上不保证派发，所以只能问 GL。 */
const RECOVER_POLL_MS = 16;

export interface PixiCompositorOptions {
  /** 渲染到这个可见画布（预览）；不传则新建 OffscreenCanvas（导出）。 */
  readonly target?: HTMLCanvasElement;
  /**
   * 默认 true，理由见文件头最后一段。关掉能省下每帧一次缓冲区拷贝，
   * 代价是"捕获必须与渲染同一个 task"变成一条无人守卫的口头约定。
   * 只有自检为了量这个选项的开销才会传 false。
   */
  readonly preserveDrawingBuffer?: boolean;
}

export async function createPixiCompositor(
  initialWidth: number,
  initialHeight: number,
  options: PixiCompositorOptions = {},
): Promise<PixiCompositor> {
  let width = initialWidth;
  let height = initialHeight;
  const { target, preserveDrawingBuffer = true } = options;
  const pixi = await import("pixi.js");

  // Worker 里没有 document，得换掉默认的 BrowserAdapter。这是全局设置，
  // 重复 set 同一个 adapter 无副作用
  if (typeof document === "undefined") {
    pixi.DOMAdapter.set(pixi.WebWorkerAdapter);
  }

  const canvas: OffscreenCanvas | HTMLCanvasElement = target ?? new OffscreenCanvas(width, height);
  canvas.width = width;
  canvas.height = height;

  const renderer: WebGLRenderer<ICanvas> = new pixi.WebGLRenderer<ICanvas>();
  await renderer.init({
    // OffscreenCanvas 满足 ICanvas 的运行时契约（width/height/getContext），
    // 但两个类型不是结构兼容的，这里只能断言
    canvas: canvas as unknown as ICanvas,
    width,
    height,
    // 见文件头第 2 条：锁死 WebGL2，不让它掉到 WebGPU 或 WebGL1
    preferWebGLVersion: 2,
    // 抗锯齿会改变留边边缘的像素，而一致性自检按黑边高度逐行判定
    antialias: false,
    // 底色：源片比例与输出比例不一致时露出来（letterbox），与 Canvas2D 后端一致
    background: 0x000000,
    backgroundAlpha: 1,
    clearBeforeRender: true,
    preserveDrawingBuffer,
    powerPreference: "high-performance",
    resolution: 1,
    autoDensity: false,
    hello: false,
  });

  const stage: Container = new pixi.Container();
  const slots: LayerSlot[] = [];
  const transitions: TransitionSlot[] = [];
  let disposed = false;

  /**
   * 上下文当前丢没丢。
   *
   * **以 `gl.isContextLost()` 为准，不自己锁一个布尔量。** 第一版用一个只置位、
   * 永不复位的标志，于是即使 Pixi 底下已经把上下文恢复了，合成器仍然一直抛错——
   * "救得回来但我们不让它活"。事件监听只用来尽早察觉（`webglcontextlost` 在
   * OffscreenCanvas 上不一定派发），真正的判据始终是问 GL 本身。
   */
  /**
   * **创建时**就把 `WEBGL_lose_context` 抓在手里。
   *
   * 丢失之后 `gl.getExtension()` 返回 **null**（实测 Chrome 150），所以"等要用了
   * 再取"永远取不到——第一版就是这么写的，表现为 `recover()` 什么也没做就超时。
   * 扩展对象本身在上下文丢失后仍然可用，`restoreContext()` 正是要在那时调。
   */
  const loseContextExt = renderer.gl.getExtension("WEBGL_lose_context");

  let sawLossEvent = false;
  const lost = (): boolean => sawLossEvent || renderer.gl.isContextLost();

  const onContextLost = (event: Event) => {
    sawLossEvent = true;
    // **不 preventDefault 就永远恢复不了**：规范要求丢失事件被取消，上下文才有
    // 资格恢复；否则 `restoreContext()` 是空操作，`webglcontextrestored` 也不会派发
    // （三种组合都实测过）。Pixi 自己也调，这里再调一次是为了让恢复能力不依赖
    // 于它的实现细节——这条链上少一环就整条失效，而失效方式是"画面再也回不来"
    event.preventDefault();
  };
  const onContextRestored = () => {
    sawLossEvent = false;
  };
  // Pixi 在同一张画布上也挂了这两个事件：restored 时它重新取扩展并向所有子系统
  // 广播 contextChange 重建 GPU 状态。**真正的重建是 Pixi 做的**，
  // `recover()` 只负责把上下文要回来
  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextrestored", onContextRestored);

  /** 造一个空槽位。**不挂到任何容器上**——挂哪儿由调用方决定。 */
  const makeSlot = (): LayerSlot => {
    // 先建 1×1 的空源，真正的尺寸在第一帧 resize 出来
    const source = new pixi.ImageSource({ width: 1, height: 1 });
    const texture = new pixi.Texture({ source });
    const sprite = new pixi.Sprite(texture);
    return {
      source,
      texture,
      sprite,
      colorFilter: null,
      lutFilter: null,
      lutData: null,
      lutTexture: null,
    };
  };

  const ensureSlot = (index: number): LayerSlot => {
    const existing = slots[index];
    if (existing) return existing;
    const slot = makeSlot();
    stage.addChild(slot.sprite);
    slots[index] = slot;
    return slot;
  };

  /**
   * 确保这个槽位上挂的是这张 LUT。换表时**连滤镜一起重建**。
   *
   * 只换 `filter.resources.uLut` 更省，但那要依赖 Pixi 内部重新绑定资源组的时机；
   * 而换表是用户点一下才发生的事，重建的代价可以忽略，换来的是"表换了画面一定跟着变"
   * 这件事不依赖框架实现细节——依赖错了的表现是"选了 LUT 没生效"，静默。
   */
  const ensureLut = (slot: LayerSlot, lut: LutTable): void => {
    if (slot.lutData === lut && slot.lutFilter) return;
    slot.lutFilter?.destroy();
    slot.lutTexture?.destroy(true);

    const built = buildLutTexture(lut);
    const source = new pixi.BufferImageSource({
      // BufferImageSource 收的是 Uint8Array；Uint8ClampedArray 与它共用同一块 buffer
      resource: new Uint8Array(built.pixels.buffer),
      width: built.width,
      height: built.height,
      format: "rgba8unorm",
      // 红绿两维靠采样器的双线性过滤插值——**这一条不能关**，
      // 关了查表就退化成最近邻，画面出色带，而且不报错
      scaleMode: "linear",
      // 半纹素偏移让采样永远落在切片内部，理论上取不到边界外；
      // clamp 是兜底，wrap 的话浮点误差会让边缘像素取到隔壁切片
      addressMode: "clamp-to-edge",
      // 表里的数是颜色本身，不是"颜色乘以透明度"。alpha 恒为 255，
      // 声明成已预乘就是让上传这一步别去动它
      alphaMode: "premultiplied-alpha",
    });
    const texture = new pixi.Texture({ source });

    slot.lutTexture = texture;
    slot.lutFilter = new pixi.Filter({
      glProgram: pixi.GlProgram.from({ vertex: LUT_VERTEX, fragment: LUT_FRAGMENT }),
      resources: {
        lutUniforms: {
          uLutSize: { value: lut.size, type: "f32" },
          uIntensity: { value: 1, type: "f32" },
        },
        uLut: source,
        uLutSampler: source.style,
      },
    });
    slot.lutData = lut;
  };

  /**
   * 按这一层的调色和 LUT 决定挂哪些滤镜。
   *
   * **两条恒等分支都必须把 `filters` 设回空**，不能挂一个单位阵滤镜 / 恒等 LUT
   * 了事：挂了滤镜 Pixi 就会先把 sprite 渲进一张临时纹理再合成，多一次重采样。
   * 所以"没用效果的项目输出逐像素不变"这条保证靠的是这里——和 `isDefaultGeometry`
   * 完全同构（见 D9），也同样**不是性能优化**。
   *
   * 而且 slot 是**跨帧复用**的：上一帧留下的滤镜不清掉，这一帧就会带着别人的
   * 效果画出去——只在"某帧有效果、下一帧没有"时出现，最难复现的那种。
   *
   * **顺序定死：先一级调色，再 LUT**（`filters` 数组的顺序就是应用顺序）。
   * 这是调色台的常规做法——LUT 是"看"，它应当作用在调整过的画面上；反过来
   * 会让同一组参数出另一张画面，而那正是硬规则 2 要消灭的东西。
   */
  const applyEffects = (
    slot: LayerSlot,
    color: ColorAdjust | undefined,
    lut: LutTable | undefined,
  ): void => {
    const chain: Filter[] = [];

    if (!isDefaultColorMatrix(color)) {
      let filter = slot.colorFilter;
      if (!filter) {
        filter = new pixi.ColorMatrixFilter();
        slot.colorFilter = filter;
      }
      // 矩阵由 `compose/color.ts` 算，这里只负责搬——两个地方各算一遍就是
      // "预览和成片颜色不一样"的入口（硬规则 2）
      // Pixi 的 matrix 类型是个 20 长的元组，我们这边是 readonly number[]；
      // 布局完全相同（5×4 行主序，偏移在第 5 列），只是类型表达方式不同
      filter.matrix = colorMatrixOf(color) as unknown as ColorMatrixFilter["matrix"];
      chain.push(filter);
    }

    const intensity = lutIntensityOf(color);
    // 强度 0 等于没套，走恒等快路径而不是挂一个混合系数为 0 的滤镜
    if (lut && intensity > 0) {
      ensureLut(slot, lut);
      const filter = slot.lutFilter!;
      // 强度是逐帧可变的（它能打关键帧），所以每帧写一次 uniform。
      // 这是普通的 uniform 组更新，Pixi 每帧会重新上传，不涉及资源重绑
      const group = filter.resources["lutUniforms"] as { uniforms: { uIntensity: number } };
      group.uniforms.uIntensity = intensity;
      chain.push(filter);
    }

    // 空数组而不是 null：Pixi v8 据 `filters.length` 决定挂不挂 filter pass，
    // 空数组就是"不挂"。判空要带 `?.`——`filters` 在从没设过时是 undefined
    const current = slot.sprite.filters;
    if (chain.length === 0) {
      if (current?.length) slot.sprite.filters = [];
      return;
    }
    // 只在链真的变了时才赋值：这个 setter 会增删渲染组上的 effect，逐帧重设是白费
    const same =
      current?.length === chain.length && chain.every((f, i) => current[i] === f);
    if (!same) slot.sprite.filters = chain;
  };

  /**
   * 把一个有来源的图层配置到槽位上：换纹理资源、算摆位、挂效果。
   *
   * 抽出来是因为**转场的两个输入走的是完全相同的这套逻辑**，只是最后渲到一张
   * 离屏纹理而不是主画布。各写一遍的话，"转场里的那一层不吃调色 / 不吃变换"
   * 会是个只在转场窗口里出现、且不报错的画面差异。
   *
   * 返回 false 表示这一层画不出来（源尺寸非法），调用方应当跳过。
   */
  const configureSlot = (slot: LayerSlot, layer: ComposeSourceLayer): VideoFrame | null | false => {
    let resource: ImageResource;
    let srcWidth: number;
    let srcHeight: number;
    let temporary: VideoFrame | null = null;

    if (layer.kind === "sample") {
      const frame = layer.sample.toVideoFrame();
      temporary = frame;
      resource = frame;
      srcWidth = frame.displayWidth;
      srcHeight = frame.displayHeight;
    } else {
      // CanvasImageSource 比 Pixi 的 ImageResource 多一个 SVGImageElement，
      // 取帧路径不会产出它
      resource = layer.image as ImageResource;
      srcWidth = layer.width;
      srcHeight = layer.height;
    }

    const rect = containRect(srcWidth, srcHeight, width, height);
    if (!rect) {
      temporary?.close();
      return false;
    }

    slot.source.resource = resource;
    // 尺寸没变时 resize 是 no-op，Pixi 的上传就会走 texSubImage2D 复用纹理
    slot.source.resize(srcWidth, srcHeight);
    slot.source.update();

    slot.sprite.visible = true;
    slot.sprite.alpha = layer.transform?.opacity ?? 1;
    applyEffects(slot, layer.color, layer.lut);

    // anchor 和 rotation 两条分支都要显式写。slot 是**跨帧复用**的，
    // 上一帧留下的 anchor 0.5 会让这一帧的恒等摆位整体偏半个图层——
    // 而且只在"某帧有变换、下一帧没有"时才出现，最难复现的那种
    if (isDefaultGeometry(layer.transform)) {
      // 与加变换之前完全相同的摆法：anchor 留在左上角，直接摆到 containRect 的位置
      slot.sprite.anchor.set(0, 0);
      slot.sprite.rotation = 0;
      slot.sprite.position.set(rect.dx, rect.dy);
      // 不用 sprite.width/height：那两个 setter 依赖纹理尺寸的记账，
      // 换源尺寸时容易慢一帧。直接算缩放是确定的
      slot.sprite.scale.set(rect.width / srcWidth, rect.height / srcHeight);
    } else {
      // 旋转要绕图层中心，所以 anchor 挪到中心、position 跟着变成中心点
      const placement = placeLayer(rect, layer.transform);
      slot.sprite.anchor.set(0.5, 0.5);
      slot.sprite.rotation = placement.rotation;
      slot.sprite.position.set(placement.centerX, placement.centerY);
      slot.sprite.scale.set(placement.width / srcWidth, placement.height / srcHeight);
    }
    return temporary;
  };

  /**
   * 造（或复用）一个转场节点的 GPU 资源。
   *
   * 渲染目标的尺寸跟着输出走，所以每次都对一下——`resize()` 只改渲染器，
   * 不知道这些离屏目标的存在。尺寸对不上时画出来的是一张被拉伸的旧画面，
   * 而且**不报错**：改分辨率之后转场那几帧会莫名其妙地糊。
   */
  const ensureTransition = (index: number): TransitionSlot => {
    const existing = transitions[index];
    if (existing) {
      if (existing.fromTexture.width !== width || existing.fromTexture.height !== height) {
        existing.fromTexture.resize(width, height);
        existing.toTexture.resize(width, height);
      }
      return existing;
    }

    const fromSlot = makeSlot();
    const toSlot = makeSlot();
    const fromScratch: Container = new pixi.Container();
    const toScratch: Container = new pixi.Container();
    fromScratch.addChild(fromSlot.sprite);
    toScratch.addChild(toSlot.sprite);

    const fromTexture = pixi.RenderTexture.create({ width, height, antialias: false });
    const toTexture = pixi.RenderTexture.create({ width, height, antialias: false });

    // 自己给几何和 UV，不借 Pixi 的 filter 管线——理由见 TRANSITION_VERTEX 的注释。
    // aPosition 是 0–1 的单位四边形，顶点着色器直接映到裁剪空间，所以这个网格
    // 永远铺满屏幕，与它在场景图里的变换无关
    const geometry = new pixi.Geometry({
      attributes: { aPosition: [0, 0, 1, 0, 1, 1, 0, 1] },
      indexBuffer: [0, 1, 2, 0, 2, 3],
    });
    const shader: Shader = pixi.Shader.from({
      gl: { vertex: TRANSITION_VERTEX, fragment: TRANSITION_FRAGMENT },
      resources: {
        uFrom: fromTexture.source,
        uFromSampler: fromTexture.source.style,
        uTo: toTexture.source,
        uToSampler: toTexture.source.style,
        transitionUniforms: {
          uProgress: { value: 0, type: "f32" },
          uEffect: { value: 0, type: "f32" },
          // 羽化宽度走 uniform 而不是写死进 GLSL：只有这样它才能和 JS 参照实现
          // 共用同一个常量，而两边不一致时 GPU-vs-CPU 断言只会在羽化带上红
          uFeather: { value: TRANSITION_FEATHER, type: "f32" },
          // 故障的三个量同理，都只有 transition-shader.ts 那一份定义
          uBlocks: { value: GLITCH_BLOCKS, type: "f32" },
          uWindow: { value: GLITCH_WINDOW, type: "f32" },
          uShift: { value: GLITCH_SHIFT, type: "f32" },
        },
      },
    });
    const mesh: Mesh<Geometry, Shader> = new pixi.Mesh({ geometry, shader });
    stage.addChild(mesh);

    const slot: TransitionSlot = {
      fromSlot,
      toSlot,
      fromScratch,
      toScratch,
      fromTexture,
      toTexture,
      mesh,
      shader,
    };
    transitions[index] = slot;
    return slot;
  };

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    canvas,

    supportsEffects: true,

    /**
     * 就地改尺寸。**必须就地，不能销毁重建**——`renderer.destroy()` 会
     * `loseContext()`，同一张画布之后再 `init()` 会**死循环**（实测 Chrome 150，
     * 标签页 100% CPU）。这是从 Canvas2D 迁过来时最容易踩的一条：那边
     * "dispose 再 new 一个"完全没问题。
     */
    resize(nextWidth, nextHeight) {
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      renderer.resize(nextWidth, nextHeight);
    },

    debug: {
      managedTextureCount: () => renderer.texture.managedTextures.length,
      contextVersion: () => String(renderer.gl.getParameter(renderer.gl.VERSION)),
      loseContext: () => {
        const ext = renderer.gl.getExtension("WEBGL_lose_context");
        if (!ext) return false;
        ext.loseContext();
        return true;
      },
      contextLost: () => lost(),
    },

    isContextLost: () => !disposed && lost(),

    /**
     * 把上下文要回来。**重建 GPU 状态的是 Pixi，不是这里**（见上面事件监听处）。
     *
     * 两种丢失来源要分开看：
     *
     * - **浏览器主动收走**（驱动重置、休眠、上下文超预算被驱逐）：Pixi 已经
     *   `preventDefault()` 过，浏览器会在能给的时候派发 `webglcontextrestored`。
     *   我们要做的只是**等**。
     * - **`WEBGL_lose_context` 模拟的丢失**（自检用）：没人会自动还回来，
     *   必须显式 `restoreContext()`。规范说它只在配对的 `loseContext()` 之后有效，
     *   所以对第一种情况调它是无害的，包在 try 里以防某些实现抛错。
     *
     * 等不回来就返回 false——那意味着这个合成器已经救不回来了，调用方该整个重建。
     * 不在这里自己 `new WebGLRenderer` 重来一遍：`getContext()` 对同一张画布返回的
     * 是同一个（仍然丢失的）上下文对象，重建拿不到新的；而换一张画布会让导出侧
     * 已经抓住 `canvas` 的 `CanvasSource` 指向一个没人画的地方。
     */
    async recover(timeoutMs = RECOVER_TIMEOUT_MS) {
      if (disposed) throw new Error("合成器已释放");
      if (!lost()) return true;

      try {
        loseContextExt?.restoreContext();
      } catch {
        /* 不是我们弄丢的那种情况，交给浏览器 */
      }

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        // 轮询而不是只等事件：Chrome 上 `webglcontextrestored` 在 OffscreenCanvas
        // 上确实会派发（实测），但 Safari 未验，而 gl.isContextLost() 在哪都能问
        if (!renderer.gl.isContextLost()) {
          sawLossEvent = false;
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, RECOVER_POLL_MS));
      }
      return false;
    },

    composeFrame(layers) {
      if (disposed) throw new Error("合成器已释放");
      if (lost()) {
        throw new Error("WebGL 上下文已丢失，无法继续合成——这一帧及之后都会是黑的");
      }

      // sample.toVideoFrame() 产出的临时帧：**render 之后**才能 close（第 5 条）
      const temporaries: VideoFrame[] = [];
      try {
        let usedSlots = 0;
        let usedTransitions = 0;
        // stage 的子节点顺序必须与图层顺序一致，而普通层和转场节点来自两个池，
        // 创建顺序对不上 z 序。每帧按序 addChild 一遍——已在 stage 上的节点会被
        // 移到末尾，于是顺序总是对的。层数是个位数，这点开销可以忽略
        const ordered: Container[] = [];

        for (const layer of layers) {
          if (layer.kind === "transition") {
            const slot = ensureTransition(usedTransitions);
            const fromTemp = configureSlot(slot.fromSlot, layer.from);
            const toTemp = configureSlot(slot.toSlot, layer.to);
            if (fromTemp) temporaries.push(fromTemp);
            if (toTemp) temporaries.push(toTemp);
            // 任一侧画不出来（源尺寸非法）就整个节点跳过：只画一侧的话，
            // 用户看到的是"转场那几帧突然只剩一层"，比不画更难查
            if (fromTemp === false || toTemp === false) {
              slot.mesh.visible = false;
              continue;
            }

            // 两个输入各渲进自己的离屏目标。**清成全透明**而不是渲染器的黑底：
            // 混合是在预乘 alpha 上做的，底色不透明的话留边区域会把黑铺进结果，
            // 下面那条轨就被这一层的黑边盖住了
            renderer.render({
              container: slot.fromScratch,
              target: slot.fromTexture,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });
            renderer.render({
              container: slot.toScratch,
              target: slot.toTexture,
              clear: true,
              clearColor: [0, 0, 0, 0],
            });

            const group = slot.shader.resources["transitionUniforms"] as {
              uniforms: { uProgress: number; uEffect: number };
            };
            group.uniforms.uProgress = layer.progress;
            group.uniforms.uEffect = TRANSITION_CODES[layer.effect];
            slot.mesh.visible = true;
            ordered.push(slot.mesh);
            usedTransitions++;
            continue;
          }

          const slot = ensureSlot(usedSlots);
          const temporary = configureSlot(slot, layer);
          if (temporary === false) continue;
          if (temporary) temporaries.push(temporary);
          ordered.push(slot.sprite);
          usedSlots++;
        }

        for (const node of ordered) stage.addChild(node);
        for (let i = usedSlots; i < slots.length; i++) {
          slots[i]!.sprite.visible = false;
        }
        for (let i = usedTransitions; i < transitions.length; i++) {
          transitions[i]!.mesh.visible = false;
        }

        renderer.render(stage);
      } finally {
        for (const frame of temporaries) frame.close();
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      for (const slot of slots) {
        // 先断开 resource，避免纹理销毁时还攥着某个 VideoFrame
        slot.source.resource = null as unknown as ImageResource;
        slot.sprite.filters = [];
        slot.colorFilter?.destroy();
        slot.colorFilter = null;
        slot.lutFilter?.destroy();
        slot.lutFilter = null;
        slot.lutTexture?.destroy(true);
        slot.lutTexture = null;
        slot.lutData = null;
        slot.sprite.destroy();
        slot.texture.destroy(true);
      }
      slots.length = 0;
      for (const t of transitions) {
        // 渲染目标是两张**输出尺寸**的 GPU 纹理，1080p 下每张 8MB——
        // 漏掉的话每建一次合成器就少 16MB 显存，而它在导出侧是跨导出常驻的
        t.fromTexture.destroy(true);
        t.toTexture.destroy(true);
        t.mesh.destroy();
        t.shader.destroy();
        for (const slot of [t.fromSlot, t.toSlot]) {
          slot.source.resource = null as unknown as ImageResource;
          slot.sprite.filters = [];
          slot.colorFilter?.destroy();
          slot.lutFilter?.destroy();
          slot.lutTexture?.destroy(true);
          slot.sprite.destroy();
          slot.texture.destroy(true);
        }
        t.fromScratch.destroy();
        t.toScratch.destroy();
      }
      transitions.length = 0;
      stage.destroy();
      renderer.destroy();
    },
  };
}
