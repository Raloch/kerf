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

import { containRect, type Compositor, type ComposeLayer } from "./compositor";

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
  let contextLost = false;
  let disposed = false;

  // GL 上下文丢失不会抛错，渲染只是变成 no-op——导出跑几分钟，中途切标签页或
  // 系统休眠都可能触发，静默产出几百帧黑画面是这个项目最不能接受的失败方式。
  // 事件在 OffscreenCanvas 上不一定派发，所以 composeFrame 里还会再查一次
  // gl.isContextLost()，这里的监听只是为了尽早置位
  const onContextLost = () => {
    contextLost = true;
  };
  canvas.addEventListener("webglcontextlost", onContextLost);

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
      contextLost: () => contextLost || renderer.gl.isContextLost(),
    },

    composeFrame(layers) {
      if (disposed) throw new Error("合成器已释放");
      if (contextLost || renderer.gl.isContextLost()) {
        contextLost = true;
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
          slot.sprite.position.set(rect.dx, rect.dy);
          // 不用 sprite.width/height：那两个 setter 依赖纹理尺寸的记账，
          // 换源尺寸时容易慢一帧。直接算缩放是确定的
          slot.sprite.scale.set(rect.width / srcWidth, rect.height / srcHeight);
          slot.sprite.alpha = layer.opacity ?? 1;
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
