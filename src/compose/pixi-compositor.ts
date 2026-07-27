/**
 * PixiJS v8 后端的合成器——**M2 滤镜 / shader 转场的落点，目前只被 spike 自检使用**。
 *
 * 它实现的是 `compositor.ts` 里那个 `Compositor` 接口，和 Canvas2D 后端可互换。
 * 现在不接进预览和导出：换渲染后端的风险应该和"新增图层类型"的风险分开承担，
 * 同时动两边，画面一旦不对就分不清是关键帧算错了还是纹理上传错了。
 * 先让 `src/dev/verify-pixi.ts` 把下面这些前提验掉，M2 后半段再切。
 *
 * 五条实现约束，每一条都对应一个"不这么写就会静默出错"的坑：
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
 *
 * 另外开了 `preserveDrawingBuffer`。WebGL 的 drawing buffer 默认在下一帧被丢弃，
 * 而导出是"合成一帧、立刻把画布交给编码器"——两者在同一个 task 里时本来没问题，
 * 但这个不变量太脆：中间插进任何一个 await 就会间歇性产出黑帧，且不报错。
 * 这里的画布每帧都要被读走，本来就没有可保留的合成快路径，关掉省不到什么。
 */

import type {
  Container,
  ICanvas,
  ImageResource,
  ImageSource,
  Sprite,
  Texture,
  WebGLRenderer,
} from "pixi.js";

import { containRect, isDefaultGeometry, placeLayer, type Compositor } from "./compositor";

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
  width: number,
  height: number,
  options: PixiCompositorOptions = {},
): Promise<PixiCompositor> {
  const { target, preserveDrawingBuffer = true } = options;
  const pixi = await import("pixi.js");

  // Worker 里没有 document，得换掉默认的 BrowserAdapter。这是全局设置，
  // 重复 set 同一个 adapter 无副作用
  if (typeof document === "undefined") {
    pixi.DOMAdapter.set(pixi.WebWorkerAdapter);
  }

  const canvas: OffscreenCanvas | HTMLCanvasElement = target ?? new OffscreenCanvas(width, height);
  if (target) {
    target.width = width;
    target.height = height;
  }

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

  const ensureSlot = (index: number): LayerSlot => {
    const existing = slots[index];
    if (existing) return existing;

    // 先建 1×1 的空源，真正的尺寸在第一帧 resize 出来
    const source = new pixi.ImageSource({ width: 1, height: 1 });
    const texture = new pixi.Texture({ source });
    const sprite = new pixi.Sprite(texture);
    stage.addChild(sprite);
    const slot: LayerSlot = { source, texture, sprite };
    slots[index] = slot;
    return slot;
  };

  return {
    width,
    height,
    canvas,
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
        let used = 0;
        for (const layer of layers) {
          let resource: ImageResource;
          let srcWidth: number;
          let srcHeight: number;

          if (layer.kind === "sample") {
            const frame = layer.sample.toVideoFrame();
            temporaries.push(frame);
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
          if (!rect) continue;

          const slot = ensureSlot(used);
          slot.source.resource = resource;
          // 尺寸没变时 resize 是 no-op，Pixi 的上传就会走 texSubImage2D 复用纹理
          slot.source.resize(srcWidth, srcHeight);
          slot.source.update();

          slot.sprite.visible = true;
          slot.sprite.alpha = layer.transform?.opacity ?? 1;

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
          used++;
        }

        for (let i = used; i < slots.length; i++) {
          slots[i]!.sprite.visible = false;
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
        slot.sprite.destroy();
        slot.texture.destroy(true);
      }
      slots.length = 0;
      stage.destroy();
      renderer.destroy();
    },
  };
}
