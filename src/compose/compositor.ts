/**
 * 合成层：把 EDL 在某一帧的内容画到一张画布上。
 *
 * 这里是 CLAUDE.md 硬规则 2 的落点——预览和导出都调用同一个
 * `Compositor.composeFrame()`，不允许各写一套渲染。
 *
 * M0 用 Canvas2D 实现（只做等比缩放贴图，没有滤镜和转场），
 * M2 需要 LUT / 混合模式 / 转场时换成 PixiJS v8 实现同一个接口。
 * 接口刻意只暴露"画一帧"，不暴露具体绘图上下文，换实现时上层不用改。
 */

import type { VideoSample } from "mediabunny";

/** 一帧的输入：某个轨道上解码出来的画面，已按 z 序从底到顶排列。 */
export interface ComposeLayer {
  readonly sample: VideoSample;
  /** 预留给 M2 的不透明度/变换。M0 恒为 undefined。 */
  readonly opacity?: number;
}

export interface Compositor {
  readonly width: number;
  readonly height: number;
  /** 供编码器捕获用的画布。 */
  readonly canvas: OffscreenCanvas;
  /**
   * 合成一帧。传入的 sample 由调用方负责 close()——
   * 合成器不接管生命周期，避免"谁该 close"的责任分散（硬规则 4）。
   */
  composeFrame(layers: readonly ComposeLayer[]): void;
  dispose(): void;
}

export function createCanvas2DCompositor(width: number, height: number): Compositor {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: false });
  if (!ctx) throw new Error("拿不到 OffscreenCanvas 的 2D 上下文");

  return {
    width,
    height,
    canvas,

    composeFrame(layers) {
      // 底色：源片比例与输出比例不一致时会露出来（letterbox）
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);

      for (const layer of layers) {
        // toVideoFrame() 产出的 VideoFrame 必须单独 close，
        // 它的生命周期与传入的 sample 是分开的（mediabunny 明确要求）
        const frame = layer.sample.toVideoFrame();
        try {
          const scale = Math.min(width / frame.displayWidth, height / frame.displayHeight);
          const drawWidth = frame.displayWidth * scale;
          const drawHeight = frame.displayHeight * scale;
          const dx = (width - drawWidth) / 2;
          const dy = (height - drawHeight) / 2;

          if (layer.opacity !== undefined) ctx.globalAlpha = layer.opacity;
          ctx.drawImage(frame, dx, dy, drawWidth, drawHeight);
          ctx.globalAlpha = 1;
        } finally {
          frame.close();
        }
      }
    },

    dispose() {
      // OffscreenCanvas 没有显式释放接口，置空绘制以尽快让 GPU 资源可回收
      ctx.clearRect(0, 0, width, height);
    },
  };
}
