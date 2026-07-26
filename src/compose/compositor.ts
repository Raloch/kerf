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
    }
  | {
      readonly kind: "image";
      /** 任何可直接 drawImage 的源：video 元素、ImageBitmap、canvas。 */
      readonly image: CanvasImageSource;
      readonly width: number;
      readonly height: number;
      readonly transform?: LayerTransform;
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
  /** 供编码器捕获（导出）或直接显示（预览）的画布。 */
  readonly canvas: OffscreenCanvas | HTMLCanvasElement;
  /**
   * 合成一帧。
   *
   * 传入的 `VideoSample` 由调用方负责 `close()`——合成器不接管生命周期，
   * 避免"谁该 close"的责任分散（硬规则 4）。合成器内部临时创建的
   * `VideoFrame` 由它自己关闭。
   */
  composeFrame(layers: readonly ComposeLayer[]): void;
  dispose(): void;
}

/**
 * @param target 传入时直接画到这个可见画布（预览）；不传则新建 OffscreenCanvas（导出）。
 */
export function createCanvas2DCompositor(
  width: number,
  height: number,
  target?: HTMLCanvasElement,
): Compositor {
  const canvas: OffscreenCanvas | HTMLCanvasElement = target ?? new OffscreenCanvas(width, height);
  if (target) {
    // 可见画布要按输出分辨率设置位图尺寸，CSS 再缩放显示，否则预览是模糊的
    target.width = width;
    target.height = height;
  }

  const ctx = (canvas as HTMLCanvasElement).getContext("2d", {
    alpha: false,
  }) as (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null;
  if (!ctx) throw new Error("拿不到画布的 2D 上下文");

  return {
    width,
    height,
    canvas,

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
