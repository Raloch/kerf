/**
 * 合成层：把 EDL 在某一帧的内容画到一张画布上。
 *
 * 这里是 CLAUDE.md 硬规则 2 的落点——**预览和导出调用同一个 `composeFrame()`**，
 * 不允许各写一套渲染。两条路径的差异只在"帧从哪来"和"由谁驱动节奏"：
 *
 *   导出：VideoDecoder 顺序解码 → `{ kind: "sample" }`  → 顺序驱动，不看墙上时钟
 *   预览：HTMLVideoElement seek  → `{ kind: "image" }`   → rAF 驱动，丢帧无所谓
 *
 * 图层进来时已按 z 序从底到顶排好，合成器只管画，不判断"该显示哪个片段"——
 * 那是 EDL 查询的职责（`clipAt`），两条路径也共用它。
 *
 * M0/M1 用 Canvas2D（只做等比缩放贴图）。M2 需要 LUT / 混合模式 / 转场时
 * 换成 PixiJS v8 实现同一个接口，上层不用改。
 */

import type { VideoSample } from "mediabunny";

import type { ColorAdjust } from "./color";

/**
 * 图层变换：位置 / 缩放 / 旋转 / 不透明度。**这四个量正是关键帧的作用目标。**
 *
 * 全部**相对默认留边位置**（`containRect` 的结果），不是绝对画布坐标：
 * 关键帧要表达的是"放大到 1.2 倍""挪到右下角"，而不是"贴到第 480 像素"——
 * 后者一换输出分辨率就全错。省略等于不动，所以 `undefined` 与"填满默认位置"同义。
 *
 * `rotation` 用**弧度**：Canvas2D 的 `ctx.rotate` 和 Pixi 的 `sprite.rotation`
 * 都收弧度，度数转换留给 UI 层做，不要在这里出现第二种单位。
 */
export interface LayerTransform {
  /** 相对默认位置的偏移，单位是输出画布像素。 */
  readonly x?: number;
  readonly y?: number;
  /** 相对默认尺寸的缩放倍数。 */
  readonly scaleX?: number;
  readonly scaleY?: number;
  /** 绕**图层中心**旋转，弧度。 */
  readonly rotation?: number;
  /** 0–1。 */
  readonly opacity?: number;
}

/** 一个图层的画面来源。两种形态对应两条取帧路径，但走同一个合成函数。 */
export type ComposeLayer =
  | {
      readonly kind: "sample";
      /** mediabunny 解码出的帧。生命周期由调用方负责，合成器只读不关。 */
      readonly sample: VideoSample;
      readonly transform?: LayerTransform;
      /** 一级调色。省略 = 不调，后端据此不挂滤镜（见 `compose/color.ts`）。 */
      readonly color?: ColorAdjust;
    }
  | {
      readonly kind: "image";
      /** 任何可直接 drawImage 的源：video 元素、ImageBitmap、canvas。 */
      readonly image: CanvasImageSource;
      readonly width: number;
      readonly height: number;
      readonly transform?: LayerTransform;
      readonly color?: ColorAdjust;
    };

/** 等比缩放居中（contain）后，图层在输出画布上占据的矩形。 */
export interface ContainRect {
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 等比缩放居中贴图（contain）的几何。
 *
 * **只有这一处**算这个。Canvas2D 后端把它喂给 `drawImage`，Pixi 后端把它变成
 * sprite 的位置与缩放——两个后端各算一遍就会在留边上差一两个像素，而
 * "预览 / 导出一致性自检"要求黑边高度**完全相等**，届时会失败得莫名其妙。
 *
 * 源片尺寸非法时返回 null（表示这一层不画），不要返回零尺寸矩形——
 * 后者会让调用方画出一个不可见但仍占 draw call 的图层。
 */
export function containRect(
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
): ContainRect | null {
  if (srcWidth <= 0 || srcHeight <= 0) return null;
  const scale = Math.min(outWidth / srcWidth, outHeight / srcHeight);
  const width = srcWidth * scale;
  const height = srcHeight * scale;
  return {
    dx: (outWidth - width) / 2,
    dy: (outHeight - height) / 2,
    width,
    height,
  };
}

/**
 * 图层最终落在输出画布上的位置。以**中心点 + 尺寸 + 旋转**描述，不用左上角矩形：
 * 旋转必须绕中心，用左上角表达就得在两个后端各写一遍"先平移到中心再转回去"。
 */
export interface LayerPlacement {
  readonly centerX: number;
  readonly centerY: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly opacity: number;
}

/**
 * 把默认留边矩形和变换合成最终摆位。**只有这一处**做这件事——
 * 两个后端各算一遍就会在"两后端留边几何一致"那条断言上差出像素来。
 */
export function placeLayer(rect: ContainRect, transform?: LayerTransform): LayerPlacement {
  const { x = 0, y = 0, scaleX = 1, scaleY = 1, rotation = 0, opacity = 1 } = transform ?? {};
  return {
    centerX: rect.dx + rect.width / 2 + x,
    centerY: rect.dy + rect.height / 2 + y,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
    rotation,
    opacity,
  };
}

/**
 * 变换有没有动过几何（位移 0、缩放 1、旋转 0）。
 *
 * 两个后端据此走"直接按 `containRect` 贴图"的原路径，让**没用变换的项目输出与
 * 加变换之前逐字节相同**。这不是性能优化，是确定性：`translate(cx,cy)` 再
 * `drawImage(-w/2,…)` 在数学上等于 `drawImage(dx,…)`，但浮点上 `(dx + w/2) - w/2`
 * 未必精确回到 `dx`，边缘像素可能挪半个像素——而留边断言是逐行判黑的，
 * 半个像素就够让"上黑边高度完全相等"变成差 1px。
 *
 * `opacity` 刻意不在判断条件里：它不改几何，两条路径都直接设 alpha。
 */
export function isDefaultGeometry(transform?: LayerTransform): boolean {
  if (!transform) return true;
  const { x = 0, y = 0, scaleX = 1, scaleY = 1, rotation = 0 } = transform;
  return x === 0 && y === 0 && scaleX === 1 && scaleY === 1 && rotation === 0;
}

export interface Compositor {
  readonly width: number;
  readonly height: number;
  /**
   * 这个后端能不能做一级调色（`ComposeLayer.color`）。
   *
   * **为 false 时 `composeFrame` 会照常画，只是把 `color` 忽略掉**——它不抛错，
   * 因为一次导出跑到第三千帧才发现画不了是更坏的失败方式。真正的守卫在上层：
   * 项目里有调色而这个后端做不了时，导出面板会**禁掉导出并说明原因**
   * （见 `ui/ExportDialog.tsx`，同硬规则 10 的精神——不静默交付一个丢了效果的片子）。
   *
   * 放在接口上而不是让上层去问"后端是不是 pixi"，是为了让能力和后端名解耦：
   * 将来加第三个后端时，判据仍然是"它能不能做"，不是"它叫什么"。
   */
  readonly supportsColor: boolean;
  /**
   * 就地改输出尺寸。
   *
   * **不能用"销毁再建一个"代替**：Pixi 的 `renderer.destroy()` 会调
   * `WEBGL_lose_context.loseContext()`，那张画布之后再也拿不到可用的 WebGL
   * 上下文——而且第二次 `init()` 不报错，是**死循环**（实测 Chrome 150，
   * 整个标签页 100% CPU 卡死）。所以尺寸变化必须走这条路。
   */
  resize(width: number, height: number): void;
  /**
   * 供编码器捕获（导出）或直接显示（预览）的画布。
   *
   * **恢复上下文时这个引用不会变**——导出侧的 `CanvasSource` 在开始时就抓住了它，
   * 换一张画布等于把编码器接到一个没人画的地方。
   */
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  /**
   * 合成一帧。
   *
   * 传入的 `VideoSample` 由调用方负责 `close()`——合成器不接管生命周期，
   * 避免"谁该 close"的责任分散（硬规则 4）。合成器内部临时创建的
   * `VideoFrame` 由它自己关闭。
   *
   * 渲染上下文丢失时**抛错**，不静默出黑帧——见 `isContextLost`。
   */
  composeFrame(layers: readonly ComposeLayer[]): void;
  /**
   * 现在能不能画。
   *
   * GPU 后端的上下文会被浏览器收走（显卡驱动重置、系统休眠、切标签页，以及
   * **同时存活的 WebGL 上下文超预算时驱逐最老的那个**）。丢了之后渲染不报错，
   * 只是变成 no-op——导出跑几分钟静默产出几百帧黑画面是这个项目最不能接受的
   * 失败方式，所以要有一个能主动问的判据。
   */
  isContextLost(): boolean;
  /**
   * 尝试把丢掉的上下文恢复回来。没丢时是个便宜的空操作。
   *
   * 返回 `false` 表示**救不回来**，调用方应当整个重建合成器（预览重新初始化、
   * 导出中止并告知用户），而不是继续画——继续画就是黑帧。
   *
   * 放进这个接口而不是只放在 Pixi 后端上，是为了让预览和导出**不必判断自己
   * 用的是哪个后端**。Canvas2D 那份是常量实现（见其注释）。
   */
  recover(): Promise<boolean>;
  dispose(): void;
}

/**
 * @param target 传入时直接画到这个可见画布（预览）；不传则新建 OffscreenCanvas（导出）。
 */
export function createCanvas2DCompositor(
  initialWidth: number,
  initialHeight: number,
  target?: HTMLCanvasElement,
): Compositor {
  let width = initialWidth;
  let height = initialHeight;
  const canvas: OffscreenCanvas | HTMLCanvasElement = target ?? new OffscreenCanvas(width, height);
  // 可见画布要按输出分辨率设置位图尺寸，CSS 再缩放显示，否则预览是模糊的
  canvas.width = width;
  canvas.height = height;

  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    alpha: false,
  }) as (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null;
  if (!ctx) throw new Error("拿不到画布的 2D 上下文");

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    canvas,

    // Canvas2D 做不了一级调色。**不用 `ctx.filter` 拼一个近似版**：那会让同一份
    // EDL 在有 GPU 和没 GPU 的机器上画出两张不同的画面，而"两套光栅化行为"正是
    // D5 当初否掉 WebGPU 的理由。宁可这台机器上明确不给用，也不给一个看着像、
    // 但和成片对不上的结果。上层据此禁掉导出并说明原因，见接口注释
    supportsColor: false,

    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    },

    composeFrame(layers) {
      // 底色：源片比例与输出比例不一致时会露出来（letterbox）
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      for (const layer of layers) {
        if (layer.kind === "sample") {
          // toVideoFrame() 产出的 VideoFrame 必须单独 close，
          // 它的生命周期与传入的 sample 是分开的（mediabunny 明确要求）
          const frame = layer.sample.toVideoFrame();
          try {
            drawLayer(ctx, frame, frame.displayWidth, frame.displayHeight, width, height, layer.transform);
          } finally {
            frame.close();
          }
        } else {
          drawLayer(ctx, layer.image, layer.width, layer.height, width, height, layer.transform);
        }
      }
    },

    // Canvas2D 上下文在现代浏览器里也能丢（内存压力下 Chrome 会派发 `contextlost`），
    // 但**我们没有观测到过**，而且它没有 WebGL 那个"同时存活数量有预算"的失效模式——
    // 后者才是换 Pixi 后端新引入的风险。这里给常量实现只是为了让上层不必判断后端；
    // 真遇到 2D 上下文丢失，表现会是画面不更新而不是抛错，届时再按同一套接口补。
    isContextLost: () => false,
    recover: async () => true,

    dispose() {
      ctx.clearRect(0, 0, width, height);
    },
  };
}

/**
 * 按"默认留边 + 变换"的几何贴图。几何本身不在这里算——见 `containRect` / `placeLayer`。
 *
 * 两条路径不是重复代码：恒等变换那条必须保持与加变换之前**完全相同的 drawImage 调用**，
 * 理由见 `isDefaultGeometry`。
 */
function drawLayer(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
  transform?: LayerTransform,
): void {
  const rect = containRect(srcWidth, srcHeight, outWidth, outHeight);
  if (!rect) return;
  const opacity = transform?.opacity ?? 1;

  if (isDefaultGeometry(transform)) {
    ctx.globalAlpha = opacity;
    ctx.drawImage(image, rect.dx, rect.dy, rect.width, rect.height);
    ctx.globalAlpha = 1;
    return;
  }

  const placement = placeLayer(rect, transform);
  // save/restore 而不是手工回滚：rotate 之后的 CTM 靠 setTransform(1,0,0,1,0,0) 复位
  // 会连带把调用方可能设过的变换一起清掉，那是别人的状态
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.translate(placement.centerX, placement.centerY);
  if (placement.rotation !== 0) ctx.rotate(placement.rotation);
  ctx.drawImage(
    image,
    -placement.width / 2,
    -placement.height / 2,
    placement.width,
    placement.height,
  );
  ctx.restore();
}
