/**
 * shader 转场的**混合函数**：给定两层的像素和这一帧的进度，输出该显示什么。
 *
 * 与 `edl/transition.ts` 的分工是干净的：那边只管**时间**（窗口在哪、进度多少），
 * 这里只管**空间**（这个像素该取哪一层、按什么比例）。时间模型和渲染方式互不知道
 * 对方存在，所以交叉溶解能完全不碰这个文件、而这里的每一种效果都白拿窗口解算。
 *
 * ## 为什么有一份 CPU 参照实现
 *
 * 「预览 / 导出一致性自检」覆盖不了 shader 本身——两条路径共用同一个（错的）
 * shader 时它是绿的。这一条在 LUT 上实测过：把半纹素偏移改错，一致性自检 19/19
 * 全绿，只有 spike 里那条 GPU-vs-CPU 会红。所以每加一种 GPU 效果都要同时加一份
 * 能在 JS 里跑的参照实现（见 `compose/color.ts` 与 `compose/lut.ts` 的文件头），
 * 这里是第三份。`mixTransition()` 与 `TRANSITION_FRAGMENT` **必须逐行对应**，
 * 改一边就要改另一边。
 *
 * ## 坐标与 alpha 的约定
 *
 * - `uv` 是**输出画布**的归一化坐标，原点左上、y 向下。两个输入都已经各自渲进
 *   一张输出尺寸的纹理（含留边、变换、调色、LUT），所以这里看到的是"摆好之后"
 *   的画面，效果作用在输出空间而不是素材空间——画中画层做擦除时，擦的是屏幕，
 *   不是那个小窗口。
 * - 颜色是**预乘 alpha** 的。Pixi 的 render texture 就是预乘的，而预乘颜色做
 *   线性插值正好等于"先各自合成再按比例混"，所以 `mix()` 直接可用；非预乘的话
 *   透明区域的 RGB 是垃圾值，混出来会在留边处渗出彩边。
 *
 * ## 「故障」用整数哈希，不用 `fract(sin(x)*43758.5453)`
 *
 * 故障效果要一个逐块的伪随机量，而那个常见的一行哈希在 GPU 和 JS 上**不是逐位
 * 相同**的：`sin` 的精度是实现定义的，而乘 43758 会把 1e-7 的差放大成 4e-3，
 * 再经 `fract` 变成完全无关的数。于是"某一条带该取哪一层"在两边可能给出不同答案，
 * 上面那条 GPU-vs-CPU 断言就从"能抓错"退化成"必须给一个松到抓不住东西的容差"。
 *
 * 换成 **PCG 整数哈希**：只有 `uint` 乘法（两边都是 mod 2³²）、移位和异或，
 * 没有任何实现定义的精度。归一化也不能随手写 `float(h) / 4294967296.0`
 * ——`float(uint)` 在超过 2²⁴ 时要**舍入**，而 JS 那边是双精度、不舍入。所以只取
 * 高 24 位再除以 2²⁴：24 位整数在 float32 里精确可表示，除以 2 的幂也精确，
 * 两边于是给出同一个数。这一条是把故障从 M2 拖到最后的唯一原因，见 PLAN.md 的 D20。
 */

import type { TransitionKind } from "../edl/types";

/**
 * 擦除类效果的羽化宽度，占画面对角方向的比例。
 *
 * 完全硬边（0）在 GPU 上会沿边界产生锯齿，而**斜向或径向的边界锯齿在视频编码后
 * 会变成一条抖动的脏边**。0.02 大约是 1080p 上的 20 像素，肉眼看仍然是"硬擦除"。
 *
 * 它同时出现在 GLSL 和 JS 参照里，所以只能有这一个定义——两边不一致时
 * GPU-vs-CPU 断言只会在羽化带上红，很容易被误读成"采样精度问题"。
 */
export const TRANSITION_FEATHER = 0.02;

/** 只有这些种类需要双输入 shader；`dissolve` 走图层不透明度，不进这里。 */
export const SHADER_TRANSITION_KINDS = ["wipe", "iris", "slide", "glitch"] as const;

export type ShaderTransitionKind = (typeof SHADER_TRANSITION_KINDS)[number];

export function isShaderTransition(kind: TransitionKind): kind is ShaderTransitionKind {
  return (SHADER_TRANSITION_KINDS as readonly string[]).includes(kind);
}

/**
 * 效果种类 → shader 里的分支号。
 *
 * 用数字而不是给每种效果编译一个 shader：分支在这里是**均匀的**（整屏同一个
 * uniform，不存在 warp 内发散），而每种一个 program 意味着每种一次编译 + 一组
 * 常驻 GPU 资源，且切换效果时要销毁重建——那正是"选了效果没生效"这类静默 bug
 * 的温床（LUT 换表时踩过一次同类问题）。
 */
export const TRANSITION_CODES: Record<ShaderTransitionKind, number> = {
  wipe: 0,
  iris: 1,
  slide: 2,
  glitch: 3,
};

/** 归一化坐标里，中心到角落的距离。`iris` 用它把半径归一到 0–1。 */
const CORNER_DISTANCE = Math.SQRT1_2;

// ---------------------------------------------------------------------------
// 故障效果的常量与哈希
// ---------------------------------------------------------------------------

/** 故障把画面横切成多少条带。16 条在 1080p 上每条 67 像素，够"块状"又不碎。 */
export const GLITCH_BLOCKS = 16;
/**
 * 每条带自己的翻转窗口有多宽（占整个转场的比例）。
 *
 * 0.35 意味着任一时刻大约三分之一的带正在抖动，其余已经翻完或还没开始——
 * 太窄（0.05）会让 16 条带几乎同时翻，看起来就是硬切；太宽（0.9）则整段时间
 * 全屏都在抖，认不出"翻转"这件事。
 */
export const GLITCH_WINDOW = 0.35;
/** 抖动的最大横向位移，占画面宽度的比例。 */
export const GLITCH_SHIFT = 0.08;
/** 第二个哈希的盐。同一条带要两个互不相关的随机量（翻转时刻、位移方向）。 */
const GLITCH_SALT = 9781;

/**
 * PCG 整数哈希。**GLSL 与这里必须给出逐位相同的结果**，见文件头。
 *
 * `Math.imul` 取 32 位乘法的低位（GLSL 的 `uint` 乘法同样是 mod 2³²），`>>> 0`
 * 把每一步的结果拉回无符号——少一个的表现是某些输入上符号位泄漏进后续移位，
 * 而那只影响一部分带，画面上看起来"随机得挺像"，只有对拍才发现。
 */
export function pcgHash(value: number): number {
  const state = (Math.imul(value >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul((state >>> ((state >>> 28) + 4)) ^ state, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/**
 * 哈希 → `[0, 1)`，**两边逐位相同**。
 *
 * 只取高 24 位：`float(uint)` 在超过 2²⁴ 时要舍入，而这里的除数是 2 的幂，
 * 于是 24 位整数在 float32 和 double 里都精确。直接 `h / 2³²` 会让 GPU 侧多一次
 * 舍入，差值约 1e-7——单独看无所谓，但它落在"这条带翻没翻"的比较上就是一个
 * 完全不同的像素。
 */
export function hashUnit(hash: number): number {
  return (hash >>> 8) / 16777216;
}

/** 故障效果在某一点的取样位置和该取哪一层。GLSL 里同名逻辑必须逐行对应。 */
export interface GlitchPoint {
  /** 位移之后的横坐标，已夹到 [0,1]。 */
  readonly u: number;
  /** true = 取入场层。 */
  readonly useTo: boolean;
}

/**
 * 故障效果的几何：这一点属于哪条带、带内进度多少、位移多大。
 *
 * 每条带有自己的翻转窗口 `[start, start + GLITCH_WINDOW)`，`start` 由哈希给出，
 * 于是各带先后不同；窗口内横向抖动，**中点翻转**。
 *
 * 幅度用抛物线 `4·l·(1-l)` 而不是 `sin(l·π)`：两者形状几乎一样，但 `sin` 的精度
 * 是实现定义的，而这里的幅度会决定取样落在哪个纹素上——在两色边界附近就是一个
 * 完全不同的像素。既然整个故障效果是为了"不用实现定义的函数"才做的，幅度这一步
 * 也不该再引入一个（同文件头那条哈希的理由）。
 *
 * 两端幅度为 0 是必需的：`t=0` 和 `t=1` 时整屏必须是纯的一层且**不位移**，
 * 否则转场首尾几帧画面会突然错位一下（同 `wipeEdge` 那条"整条羽化带要推出屏幕"）。
 */
export function glitchPoint(u: number, v: number, progress: number): GlitchPoint {
  const band = Math.floor(clamp01(v) * GLITCH_BLOCKS);
  const flipAt = hashUnit(pcgHash(band)) * (1 - GLITCH_WINDOW);
  const dir = hashUnit(pcgHash(band + GLITCH_SALT)) * 2 - 1;
  const local = clamp01((progress - flipAt) / GLITCH_WINDOW);
  const amp = 4 * local * (1 - local) * GLITCH_SHIFT * dir;
  // 夹到边缘而不是取透明：位移是刻意的、可以很大（8% 画宽），越界取透明会在
  // 每条带两侧留黑边，而故障效果的常规长相是把边缘那一列拖出来
  return { u: clamp01(u + amp), useTo: local >= 0.5 };
}

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

function mix(a: Rgba, b: Rgba, m: number): Rgba {
  return {
    r: a.r + (b.r - a.r) * m,
    g: a.g + (b.g - a.g) * m,
    b: a.b + (b.b - a.b) * m,
    a: a.a + (b.a - a.a) * m,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 擦除边界的位置。羽化带是 `[edge - feather, edge]`，带内 `m` 从 0 涨到 1。
 *
 * 系数是 `1 + feather` 而不是 1：`t=1` 时必须让**整条羽化带都推出屏幕**
 * （`edge ≥ 1 + feather`），否则最远那一点只被覆盖一半。第一版写成
 * `t*(1+feather) - feather/2`，两端各差半条带，表现是**转场首尾几帧画面纹丝
 * 不动、结束时角落还留着上一层的残影**——而残影只有几个像素宽，很容易被
 * 当成编码噪声。单测的"t=0/1 时整屏是纯的"就是钉这一条的。
 *
 * 带的中点是 `edge - feather/2 = t`，所以 `t=0.5` 时边界正好在画面中线上。
 */
function wipeEdge(progress: number): number {
  return progress * (1 + TRANSITION_FEATHER);
}

/**
 * 一个像素的转场结果。**这是 `TRANSITION_FRAGMENT` 的参照实现，两者必须一致。**
 *
 * @param from   出场层在该点的**预乘**颜色，各通道 0–1
 * @param to     入场层在该点的预乘颜色
 * @param u,v    输出画布归一化坐标，原点左上
 * @param sample `slide` 需要在**别的**坐标上取样，所以两层的取样得由调用方提供。
 *               其余效果只用 `from` / `to` 这两个原位取样。
 */
export function mixTransition(
  kind: ShaderTransitionKind,
  from: Rgba,
  to: Rgba,
  u: number,
  v: number,
  progress: number,
  sample?: {
    readonly from: (u: number, v: number) => Rgba;
    readonly to: (u: number, v: number) => Rgba;
  },
): Rgba {
  if (kind === "wipe") {
    const m = clamp01((wipeEdge(progress) - u) / TRANSITION_FEATHER);
    return mix(from, to, m);
  }

  if (kind === "iris") {
    const dx = u - 0.5;
    const dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) / CORNER_DISTANCE;
    const m = clamp01((wipeEdge(progress) - d) / TRANSITION_FEATHER);
    return mix(from, to, m);
  }

  if (kind === "glitch") {
    const point = glitchPoint(u, v, progress);
    if (point.useTo) return sample ? sample.to(point.u, v) : to;
    return sample ? sample.from(point.u, v) : from;
  }

  // slide：出场层整体左移 t，入场层从右边推进来。边界是硬的（推移本来就没有
  // 羽化可言），两侧各自在自己的纹理里取样，越界取透明——越界只会发生在
  // 浮点误差刚好落在边界上时，取透明比 clamp 更诚实（clamp 会把边缘像素拉成一条线）
  const shifted = u + progress;
  if (shifted < 1) {
    return sample ? sample.from(shifted, v) : from;
  }
  const entering = u - (1 - progress);
  if (entering < 0 || entering > 1) return TRANSPARENT;
  return sample ? sample.to(entering, v) : to;
}

/**
 * 全屏四边形的顶点着色器。
 *
 * 不复用 Pixi 的 filter 顶点着色器：filter 走的是"先把内容渲进一张带 padding 的
 * 临时纹理、再用 `uInputSize` / `uOutputFrame` 换算 UV"那一套，UV 与屏幕不是 1:1，
 * 而这里的每一种效果都按**屏幕坐标**定义。自己给几何、自己给 UV，参照实现才算得准。
 */
export const TRANSITION_VERTEX = `#version 300 es
in vec2 aPosition;
out vec2 vUV;

void main() {
  // aPosition 直接是 0–1 的四边形，映射到裁剪空间。y 翻转让 vUV 的原点在左上，
  // 与 Canvas / 输出画布的坐标系一致
  vUV = aPosition;
  gl_Position = vec4(aPosition.x * 2.0 - 1.0, 1.0 - aPosition.y * 2.0, 0.0, 1.0);
}
`;

/**
 * 双采样器混合。**必须与 `mixTransition()` 逐行对应。**
 *
 * 两个输入都是输出尺寸的预乘 alpha 纹理，见文件头的坐标与 alpha 约定。
 */
export const TRANSITION_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vUV;
out vec4 fragColor;

uniform sampler2D uFrom;
uniform sampler2D uTo;

uniform float uProgress;
uniform float uEffect;
uniform float uFeather;
// 故障的三个量也从 uniform 读，不写死在 shader 里——同 uFeather 那条：
// 两边不一致时断言只会在抖动带上红，很容易被误读成"采样精度问题"
uniform float uBlocks;
uniform float uWindow;
uniform float uShift;

// 与 JS 参照里的 wipeEdge() 同一个式子：系数 1 + feather 才能在 t=1 时把整条
// 羽化带推出屏幕。少算半条带的表现是转场首尾几帧画面纹丝不动（实测踩过）
float wipeEdge(float t, float feather) {
  return t * (1.0 + feather);
}

// PCG 整数哈希，与 JS 的 pcgHash() **逐位相同**：只有 mod 2³² 的乘法、移位、异或，
// 没有任何实现定义的精度。不要换回 fract(sin(x)*43758.5453)，理由见该文件头
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

// 只取高 24 位：float(uint) 超过 2²⁴ 要舍入，而 JS 那边是双精度。24 位整数在
// float32 里精确，除以 2 的幂也精确，于是两边给出同一个数
float hashUnit(uint h) {
  return float(h >> 8u) / 16777216.0;
}

void main() {
  int effect = int(uEffect + 0.5);

  if (effect == 3) {
    // 故障：横切成 uBlocks 条带，每条带自己的窗口里抖动并在中点翻转。
    // 与 JS 的 glitchPoint() 逐行对应
    uint band = uint(floor(clamp(vUV.y, 0.0, 1.0) * uBlocks));
    float flipAt = hashUnit(pcgHash(band)) * (1.0 - uWindow);
    float dir = hashUnit(pcgHash(band + ${GLITCH_SALT}u)) * 2.0 - 1.0;
    float local = clamp((uProgress - flipAt) / uWindow, 0.0, 1.0);
    // 抛物线而不是 sin：sin 的精度是实现定义的，而幅度决定取样落在哪个纹素上
    float amp = 4.0 * local * (1.0 - local) * uShift * dir;
    vec2 at = vec2(clamp(vUV.x + amp, 0.0, 1.0), vUV.y);
    fragColor = local >= 0.5 ? texture(uTo, at) : texture(uFrom, at);
    return;
  }

  if (effect == 2) {
    // slide：出场层左移，入场层从右推入。硬边界，无羽化
    float shifted = vUV.x + uProgress;
    if (shifted < 1.0) {
      fragColor = texture(uFrom, vec2(shifted, vUV.y));
      return;
    }
    float entering = vUV.x - (1.0 - uProgress);
    if (entering < 0.0 || entering > 1.0) {
      fragColor = vec4(0.0);
      return;
    }
    fragColor = texture(uTo, vec2(entering, vUV.y));
    return;
  }

  vec4 from = texture(uFrom, vUV);
  vec4 to = texture(uTo, vUV);

  float d;
  if (effect == 1) {
    // iris：到中心的距离，归一到"中心 → 角落"为 1
    d = distance(vUV, vec2(0.5)) / ${CORNER_DISTANCE.toFixed(8)};
  } else {
    // wipe：左 → 右
    d = vUV.x;
  }

  float m = clamp((wipeEdge(uProgress, uFeather) - d) / uFeather, 0.0, 1.0);
  fragColor = mix(from, to, m);
}
`;
