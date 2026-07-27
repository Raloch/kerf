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
 * 没用效果时两个后端画得一样（spike 逐像素比过：留边 ≤1px、色相 ≤8°），退回只是
 * 少了 GPU 加速。**但一级调色（以及后面的 LUT / shader 转场）在 Canvas2D 上做不了**，
 * 那时"退回"就等于"这个项目里的效果全都不生效"——必须让用户知道，而不是
 * 悄悄画出一个没有效果的片子（同硬规则 10 的精神）。
 *
 * 这一条已经兑现：`backend` 和 `reason` 一路报到导出面板上，而
 * `observedCapabilities()`（下面）让界面能在**开始导出之前**就把这件事拦下来。
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
    return record({
      compositor: createCanvas2DCompositor(width, height, target),
      backend: "canvas2d",
    });
  }

  try {
    const compositor = await createPixiCompositor(width, height, target ? { target } : {});
    return record({ compositor, backend: "pixi" });
  } catch (error) {
    if (force === "pixi") throw error;
    // 一张画布只能有一种上下文类型：上面 getContext('webgl2') 失败时不会占住它，
    // 所以这里还能在同一张画布上拿 2D 上下文。若哪天 Pixi 改成失败前先占住，
    // 这条会静默变成"预览一片空白"——接效果时要在自检里钉住
    return record({
      compositor: createCanvas2DCompositor(width, height, target),
      backend: "canvas2d",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 这个 JS 上下文里最近一次真的造出来的合成器能做什么。 */
export interface ObservedCapabilities {
  readonly backend: CompositorBackend;
  readonly supportsColor: boolean;
  readonly reason?: string;
}

let observed: ObservedCapabilities | null = null;

function record(created: CreatedCompositor): CreatedCompositor {
  observed = {
    backend: created.backend,
    supportsColor: created.compositor.supportsColor,
    ...(created.reason ? { reason: created.reason } : {}),
  };
  return created;
}

/**
 * 这台机器实际拿到的渲染能力；从没造过合成器时是 `null`。
 *
 * **界面靠它在开始导出之前就把"效果做不了"拦下来**——等导出跑完再说，用户已经
 * 拿到一个丢了调色的片子了（硬规则 10：不静默降级）。
 *
 * 为什么是模块级的一份记录，而不是把能力当参数一层层传下去：
 *
 * - "能不能起 WebGL"是**机器**的属性，不是某个合成器实例的。主线程上预览那一个
 *   就是最好的探针，它从打开项目起就存在，而且和导出会拿到的是同一个答案。
 * - 只为了回答这个问题去多造一个合成器是错的：WebGL 上下文有预算（D15），
 *   多握一个就多一分把预览挤掉的风险。
 *
 * 每个 JS 上下文一份（Worker 里那份记的是 Worker 自己的），这与常驻量计量器是
 * 同一个模式，也同样有那个坑：**dev 下要挂全局才能在控制台里问**，
 * 直接 `import()` 会因为 Vite 的 HMR URL 拿到另一个模块实例。
 */
export function observedCapabilities(): ObservedCapabilities | null {
  return observed;
}
