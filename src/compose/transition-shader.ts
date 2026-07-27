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
 * ## 为什么没有「故障」
 *
 * PLAN.md 原本列的第三种是故障（glitch）。它需要一个逐块的伪随机位移，而常见的
 * `fract(sin(x)*43758.5453)` 哈希在 GPU 和 JS 上**不是逐位相同**的——`sin` 的
 * 精度是实现定义的。那会让上面那条 GPU-vs-CPU 断言从"能抓错"退化成"必须给一个
 * 松到抓不住东西的容差"。要做得先换一个整数哈希（位运算在两边一致），那是独立
 * 的一件事，不和双输入节点混在一起做。见 PLAN.md 的 D20。
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
export const SHADER_TRANSITION_KINDS = ["wipe", "iris", "slide"] as const;

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
};

/** 归一化坐标里，中心到角落的距离。`iris` 用它把半径归一到 0–1。 */
const CORNER_DISTANCE = Math.SQRT1_2;

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

// 与 JS 参照里的 wipeEdge() 同一个式子：系数 1 + feather 才能在 t=1 时把整条
// 羽化带推出屏幕。少算半条带的表现是转场首尾几帧画面纹丝不动（实测踩过）
float wipeEdge(float t, float feather) {
  return t * (1.0 + feather);
}

void main() {
  int effect = int(uEffect + 0.5);

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
