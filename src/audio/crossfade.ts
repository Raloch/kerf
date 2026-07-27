/**
 * 交叉淡化的**增益曲线**。声音这边的 `compose/transition-shader.ts`。
 *
 * 时间模型完全复用 `edl/transition.ts`——窗口在哪、多长、余量够不够，和画面
 * 转场是同一份答案。这里只回答一件事：**窗口里这一刻两条轨各该乘多少**。
 *
 * ## 为什么音频转场是独立的一组种类，不复用画面那四种
 *
 * `dissolve` / `wipe` / `iris` / `slide` 描述的是**像素**怎么混，音频轨上没有
 * 像素。让用户在音频轨上选「圆形张开」然后我们静默按交叉淡化渲染，正是硬规则
 * 10 那种"选了 A 拿到 B"。所以 `TransitionKind` 从这一步起分成画面组和声音组，
 * 由轨道种类决定哪一组合法（`edl/types.ts` 的 `isAudioTransition`，校验在
 * `state/operations.ts` 的 `setTransition` 和 `dropOrphanTransitions`）。
 *
 * ## 为什么是两条曲线，不是一条
 *
 * 哪条对**取决于两段素材相不相关**，而这件事只有用户知道：
 *
 * - **等功率**（`xfade-power`，gain = sin/cos）：两条曲线的**平方和**恒为 1。
 *   两段**不同**的声音用它——不相关信号叠加时功率相加，所以平方和为 1 才能让
 *   响度在窗口里平掉。绝大多数剪辑点是这种，所以它是缺省。
 * - **等增益**（`xfade-linear`，gain = t）：两条曲线的**和**恒为 1。同一个声音的
 *   两次录音用它（同期声接口、房间声、同一段音乐的两个副本）——完全相关的信号
 *   叠加时振幅相加，等功率会在中点鼓起 √2 倍 ≈ **+3dB**，听起来是"接缝处响一下"。
 *
 * 反过来用同样是错的：不相关素材用等增益，中点的功率只有 1/√2 ≈ **−1.5dB**，
 * 听起来是"接缝处沉一下"。两种错都不报错，只是听感不对，所以必须让用户选。
 *
 * ## 进度是连续的，不取帧中点
 *
 * 画面那边 `transitionProgress()` 取的是**帧中点**——帧是区间，一帧只能有一个
 * 颜色。声音不是：它在窗口里连续变化，采样率比帧率高三个数量级。所以这里的
 * 进度是"距窗口起点的时间 ÷ 窗口时长"，端点精确取到 0 和 1。
 *
 * 硬套帧中点会让整条淡化**偏移半帧**（30fps 下 16.7ms）。单帧看不出来，但两侧
 * 各偏半帧就是接缝处一个 33ms 的功率缺口——正好落在能听见的量级上。
 */

import type { TransitionKind } from "../edl/types";

/**
 * 声音转场的种类。加新曲线时**只改这里**——`TransitionKind` 由它推导，
 * `TRANSITION_LABELS` 会因为 Record 缺项而编译报错。
 */
export const AUDIO_TRANSITION_KINDS = ["xfade-power", "xfade-linear"] as const;

export type AudioTransitionKind = (typeof AUDIO_TRANSITION_KINDS)[number];

/** 淡出的那一段（窗口左边）还是淡入的那一段（右边）。 */
export type CrossfadeRole = "from" | "to";

/**
 * 这一刻这一侧的增益。**这就是那份 CPU 参照实现**——`mixdown.ts` 交给
 * Web Audio 的曲线由 `crossfadeCurve()` 采样自这个函数，自检读回成片测到的
 * 包络也拿它当参照值。
 *
 * `progress` 是窗口进度 0 → 1（`from` 全响 → `to` 全响），会被夹到 [0,1]。
 */
export function crossfadeGain(
  kind: AudioTransitionKind,
  role: CrossfadeRole,
  progress: number,
): number {
  const t = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  // 两条曲线互为镜像：把 from 的进度翻过来就是 to 的，所以只写一个表达式。
  // 各自单独写一遍是"改了一侧忘了另一侧"的入口，而那种错只表现为接缝处音量歪
  const x = role === "from" ? 1 - t : t;
  return kind === "xfade-linear" ? x : Math.sin((x * Math.PI) / 2);
}

/**
 * 曲线的采样点数：每帧一个点，两端各含。
 *
 * 和画面转场同一个时间分辨率，不是随手取的数。`setValueCurveAtTime` 在点之间
 * 线性插值，而正弦在一帧的跨度上几乎就是直线：16 帧窗口每段 π/32 弧度，弦与弧
 * 的最大偏差约 1.2e-3，即 **−58dB**，远在听阈之下。
 */
export function crossfadeCurvePoints(windowFrames: number): number {
  return Math.max(2, Math.floor(windowFrames) + 1);
}

/**
 * 把增益曲线采样成 `AudioParam.setValueCurveAtTime()` 要的数组。
 *
 * `fromProgress` / `toProgress` 通常是 0 和 1；**导出区间从转场窗口中间切过去**
 * 时会是一截（见 `mix-plan.ts`），那时曲线只覆盖可见的那一段，端点值跟着变。
 */
export function crossfadeCurve(
  kind: AudioTransitionKind,
  role: CrossfadeRole,
  fromProgress: number,
  toProgress: number,
  points: number,
): Float32Array {
  const n = Math.max(2, Math.floor(points));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = fromProgress + ((toProgress - fromProgress) * i) / (n - 1);
    curve[i] = crossfadeGain(kind, role, at);
  }
  return curve;
}

/** 这个种类是不是声音转场。判据只有这一处，见 `edl/types.ts` 的再导出。 */
export function isAudioTransitionKind(kind: TransitionKind): kind is AudioTransitionKind {
  return (AUDIO_TRANSITION_KINDS as readonly string[]).includes(kind);
}
