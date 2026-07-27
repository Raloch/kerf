/**
 * 关键帧求值：给定一组关键帧和一个帧号，算出这一帧的属性值。
 *
 * 纯函数，**不认识渲染、不认识浏览器**——所以它能脱离浏览器单测，而移动/缓动/
 * 边界外取值的条件多到必须靠测试锁死（和 `state/operations.ts` 同一个理由）。
 * 作用目标是**两组**量：`compose/compositor.ts` 的 `LayerTransform`（摆位六项，
 * 见 PLAN.md 的 D9）和 `compose/color.ts` 的 `ColorAdjust`（调色五项，见 D17 / D18）。
 * 求值机制完全共用，只在"结果交给谁"上分岔——见 `ANIMATABLE_PROPERTIES`。
 *
 * ## 时间全程在帧号空间，不出现秒
 *
 * 关键帧的时刻是**整数帧偏移**，求值也只做帧号的加减和比值，所以这个模块
 * 连帧率都不需要知道——硬规则 1 说"禁止用浮点秒做帧运算"，这里的做法是
 * 干脆不让秒进来。唯一的浮点是区间内的归一化进度 `t ∈ [0,1]`，它是两个整数
 * 帧差的比值，而且喂给的是位置/缩放这类**本来就连续**的量，不参与任何帧定位。
 *
 * ## 帧偏移相对片段起点，不是绝对时间轴帧号
 *
 * 关键帧写的是"片段自己的第几帧"（0 = 片段第一帧）。用绝对帧号的话，
 * 用户每次把片段在时间轴上挪一下，都得重写它全部关键帧——而挪动本来
 * 不该影响动画。代价是**裁入点时要跟着平移关键帧**（入点右移 10 帧意味着
 * 片段少用开头 10 帧，关键帧偏移要减 10 才能贴住原来的内容），
 * 那件事属于把关键帧接进 EDL 的那一步，不在这里。
 *
 * ## 编辑关键帧的入口不在这里
 *
 * 插入/移动/删除关键帧要维护"按 frame 升序"这条不变量，和片段按 `timelineIn`
 * 排序是同一类约定，会随状态层一起落地。本模块的 `valueAt` **假定输入已升序**。
 */

import type { ColorAdjust } from "../compose/color";
import type { LayerTransform } from "../compose/compositor";

/**
 * 段缓动。
 *
 * 刻意只给命名缓动，不给贝塞尔控制点：曲线编辑器在 PLAN.md §9 里是明确推后的
 * 界面，现在把控制点塞进模型，等于为一个还没设计的 UI 定死数据形状。
 * `easing` 是关键帧上的一个字段，将来加 `{ kind: "bezier", … }` 不破坏现有数据。
 *
 * `hold` 是"跳变"：保持前一个值直到下一个关键帧，用于开关式的属性变化
 * （文字出现/消失、瞬间换位），没有它就只能靠两个相距 1 帧的关键帧硬凑。
 */
export type Easing = "linear" | "ease-in" | "ease-out" | "ease-in-out" | "hold";

export interface Keyframe {
  /** 片段内的帧偏移，整数，0 = 片段第一帧。 */
  readonly frame: number;
  readonly value: number;
  /**
   * 从这个关键帧到**下一个**关键帧那一段的缓动，缺省线性。
   *
   * 缓动归"左端"关键帧所有，而不是给每个关键帧配进/出两条曲线：
   * 一段区间只有一条曲线，把它挂在区间的起点上就不会出现"左边说 ease-out、
   * 右边说 linear，到底听谁"的歧义。最后一个关键帧的 easing 无意义。
   */
  readonly easing?: Easing;
}

/** 摆位类属性，与 `LayerTransform` 的字段一一对应。 */
export const TRANSFORM_PROPERTIES = [
  "x",
  "y",
  "scaleX",
  "scaleY",
  "rotation",
  "opacity",
] as const;

/**
 * 调色类属性，与 `ColorAdjust` 的字段一一对应。
 *
 * `lutIntensity` 在这一组里是刻意的：它是"LUT 这个看渐渐上来"，用的是和亮度
 * 完全一样的打点 / 求值 / 撤销机制，另起一组等于把那一套再写一遍。它只是在
 * 求值之后走另一条渲染路径（查表而不是矩阵），那是合成器的事，不是这里的事。
 */
export const COLOR_PROPERTIES = [
  "brightness",
  "contrast",
  "saturation",
  "hue",
  "lutIntensity",
] as const;

export type TransformProperty = (typeof TRANSFORM_PROPERTIES)[number];
export type ColorProperty = (typeof COLOR_PROPERTIES)[number];

/**
 * 所有能打关键帧的属性。
 *
 * **分成两组、但共用一张通道表**（下面的 `KeyframeChannels`）。两个选择各有理由：
 *
 * - **共用一张表**：打/删/平移关键帧、撤销栈合并键、检查器的关键帧条，这些逻辑
 *   与"这个属性最后作用到摆位还是颜色"完全无关。分成两张表等于把它们全部写两遍，
 *   而漏改一处的表现是"某类属性的关键帧撤销不了"。
 * - **分成两组**：求值时必须知道去向——`resolveTransform` 只能吐 `LayerTransform`，
 *   把 `brightness` 混进去会变成一个合成器不认识、也不报错的字段。
 */
export const ANIMATABLE_PROPERTIES = [
  ...TRANSFORM_PROPERTIES,
  ...COLOR_PROPERTIES,
] as const;

export type AnimatableProperty = TransformProperty | ColorProperty;

/** 每个属性一条独立的关键帧序列。没有条目 = 这个属性不动画。 */
export type KeyframeChannels = {
  readonly [K in AnimatableProperty]?: readonly Keyframe[];
};

/**
 * 把区间内的线性进度 `t` 映射成缓动后的进度。
 *
 * 用二次曲线而不是三次：手感差别很小，但 `ease-in` 在中点恰好是 0.25、
 * `ease-out` 是 0.75、`ease-in-out` 是 0.5，断言写得出整数，测试读得懂。
 */
export function easeProgress(t: number, easing: Easing = "linear"): number {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  switch (easing) {
    case "linear":
      return clamped;
    case "ease-in":
      return clamped * clamped;
    case "ease-out":
      return clamped * (2 - clamped);
    case "ease-in-out":
      return clamped < 0.5
        ? 2 * clamped * clamped
        : 1 - 2 * (1 - clamped) * (1 - clamped);
    case "hold":
      // 保持左端值。右端点由 valueAt 的"精确命中"分支处理，不走到这里
      return 0;
  }
}

/**
 * 取某一帧的属性值。序列为空返回 null（表示"这个属性没有动画"，由调用方保留静态值）。
 *
 * **区间外一律保持端点值，绝不外推。** 外推会让缩放冲到负数、不透明度越过 1，
 * 而这些都不会报错——只会让某一段画面凭空消失或翻转。
 *
 * 线性扫描而不是二分：一个属性的关键帧数量是几个到几十个，二分的收益在这个
 * 量级上量不出来，而它的边界条件（相等、重复帧）恰好是最容易写错的地方。
 *
 * @param keyframes **必须按 `frame` 升序**，见文件头
 * @param frame 片段内的帧偏移
 */
export function valueAt(keyframes: readonly Keyframe[], frame: number): number | null {
  if (keyframes.length === 0) return null;

  const first = keyframes[0]!;
  if (frame <= first.frame) return first.value;
  const last = keyframes[keyframes.length - 1]!;
  if (frame >= last.frame) return last.value;

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (frame >= b.frame) continue;

    const span = b.frame - a.frame;
    // 同帧上有两个关键帧时后者胜。既避免除零，也给"跳变"一个不用 hold 的写法；
    // 顺序颠倒的输入（违反升序前提）也在这里被兜住，不会算出负进度
    if (span <= 0) return b.value;

    const eased = easeProgress((frame - a.frame) / span, a.easing);
    return a.value + (b.value - a.value) * eased;
  }

  return last.value;
}

/**
 * 把静态值和关键帧合成这一帧真正要用的那一组属性。
 *
 * 优先级：**某属性有关键帧就用求值结果，没有就保留静态值**。两者并存是刻意的，
 * 也是所有 NLE 的做法——用户先调出一个满意的值，再决定要不要让它动起来；
 * 强迫"动画属性必须删掉静态值"会让"暂时关掉动画"变成破坏性操作。
 *
 * **这一组里没有任何属性被动画时原样返回 `base`（包括返回 `undefined`）。**
 * 这条不是省事：`undefined` 才会让合成器走恒等快路径，而那条路径是"没用这项能力
 * 的项目输出逐像素不变"的保证（摆位见 PLAN.md 的 D9，调色见 `compose/color.ts`
 * 的 `isDefaultColorMatrix`）。这里若顺手返回一个 `{}`，所有静态图层就会集体掉出快路径。
 *
 * 泛型是为了让两组属性共用这一段——摆位和调色的合并规则一模一样，
 * 各写一遍迟早会在"什么时候返回 base"上分叉，而分叉的表现是画面整体挪半个像素。
 */
function resolveGroup<K extends AnimatableProperty, T>(
  properties: readonly K[],
  base: T | undefined,
  channels: KeyframeChannels | undefined,
  frame: number,
): T | undefined {
  if (!channels) return base;

  let animated: Record<string, number> | null = null;
  for (const property of properties) {
    const keyframes = channels[property];
    if (!keyframes || keyframes.length === 0) continue;
    const value = valueAt(keyframes, frame);
    if (value === null) continue;
    animated ??= { ...base };
    animated[property] = value;
  }

  return (animated as T | null) ?? base;
}

/**
 * 这一帧的摆位（静态变换 + 关键帧）。`frame` 是**片段内的帧偏移**。
 */
export function resolveTransform(
  base: LayerTransform | undefined,
  channels: KeyframeChannels | undefined,
  frame: number,
): LayerTransform | undefined {
  return resolveGroup(TRANSFORM_PROPERTIES, base, channels, frame);
}

/**
 * 这一帧的调色（静态调色 + 关键帧）。`frame` 是**片段内的帧偏移**。
 *
 * 和 `resolveTransform` 是同一套规则，分成两个函数只因为返回类型不同——
 * 合成器要能从类型上区分"这是摆位"和"这是颜色"。
 */
export function resolveColor(
  base: ColorAdjust | undefined,
  channels: KeyframeChannels | undefined,
  frame: number,
): ColorAdjust | undefined {
  return resolveGroup(COLOR_PROPERTIES, base, channels, frame);
}
