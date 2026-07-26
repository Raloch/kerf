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

/** 一个图层的画面来源。两种形态对应两条取帧路径，但走同一个合成函数。 */
export type ComposeLayer =
  | {
      readonly kind: "sample";
      /** mediabunny 解码出的帧。生命周期由调用方负责，合成器只读不关。 */
      readonly sample: VideoSample;
      readonly opacity?: number;
    }
  | {
      readonly kind: "image";
      /** 任何可直接 drawImage 的源：video 元素、ImageBitmap、canvas。 */
      readonly image: CanvasImageSource;
      readonly width: number;
      readonly height: number;
      readonly opacity?: number;
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
            drawContain(ctx, frame, frame.displayWidth, frame.displayHeight, width, height, layer.opacity);
          } finally {
            frame.close();
          }
        } else {
          drawContain(ctx, layer.image, layer.width, layer.height, width, height, layer.opacity);
        }
      }
    },

    dispose() {
      ctx.clearRect(0, 0, width, height);
    },
  };
}

/** 按 `containRect` 的几何贴图。几何本身不在这里算——见该函数的注释。 */
function drawContain(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  outWidth: number,
  outHeight: number,
  opacity?: number,
): void {
  const rect = containRect(srcWidth, srcHeight, outWidth, outHeight);
  if (!rect) return;

  if (opacity !== undefined) ctx.globalAlpha = opacity;
  ctx.drawImage(image, rect.dx, rect.dy, rect.width, rect.height);
  ctx.globalAlpha = 1;
}
