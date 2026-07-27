/**
 * 选后端：优先 PixiJS（WebGL2），起不来就退回 Canvas2D。
 *
 * ## 为什么需要这一层
 *
 * 预览和导出必须画得一样（硬规则 2），所以**"用哪个后端"这个决定只能有一处**。
 * 两边各写一遍 `try pixi catch canvas2d` 迟早会分叉——而分叉的表现不是报错，
 * 是预览和成片长得不一样。
 *
 * ## 退回 Canvas2D 意味着什么
 *
 * 今天两个后端画得一样（spike 逐像素比过：留边 ≤1px、色相 ≤8°），所以退回只是
 * 少了 GPU 加速。**但 M2 后半段的滤镜 / LUT / shader 转场在 Canvas2D 上做不了**，
 * 那时"退回"就等于"这个项目里的效果全都不生效"——必须让用户知道，而不是
 * 悄悄画出一个没有效果的片子（同硬规则 10 的精神）。所以这里把 `backend` 和
 * `reason` 一路报出去，接效果之前要在界面上兑现。
 *
 * ## 为什么不在这里缓存
 *
 * 合成器有生命周期（预览一个、导出一个），谁持有谁负责释放。这里只做"造一个"，
 * 复用的策略在各自的持有方（导出侧见 `export/pipeline.ts` 的 `acquireCompositor`）。
 */

import { createCanvas2DCompositor, type Compositor } from "./compositor";
import { createPixiCompositor } from "./pixi-compositor";

export type CompositorBackend = "pixi" | "canvas2d";

export interface CreatedCompositor {
  readonly compositor: Compositor;
  readonly backend: CompositorBackend;
  /** 退回 Canvas2D 的原因。用了 Pixi 时是 undefined。 */
  readonly reason?: string;
}

export interface CreateCompositorOptions {
  /** 渲染到这个可见画布（预览）；不传则新建 OffscreenCanvas（导出）。 */
  readonly target?: HTMLCanvasElement;
  /**
   * 强制某个后端。只有自检会用——生产代码一律走默认，
   * 否则"预览和导出用同一个后端"就不再是结构性保证。
   */
  readonly force?: CompositorBackend;
}

export async function createCompositor(
  width: number,
  height: number,
  options: CreateCompositorOptions = {},
): Promise<CreatedCompositor> {
  const { target, force } = options;

  if (force === "canvas2d") {
    return { compositor: createCanvas2DCompositor(width, height, target), backend: "canvas2d" };
  }

  try {
    const compositor = await createPixiCompositor(width, height, target ? { target } : {});
    return { compositor, backend: "pixi" };
  } catch (error) {
    if (force === "pixi") throw error;
    // 一张画布只能有一种上下文类型：上面 getContext('webgl2') 失败时不会占住它，
    // 所以这里还能在同一张画布上拿 2D 上下文。若哪天 Pixi 改成失败前先占住，
    // 这条会静默变成"预览一片空白"——接效果时要在自检里钉住
    return {
      compositor: createCanvas2DCompositor(width, height, target),
      backend: "canvas2d",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
