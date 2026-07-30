/**
 * 转场的**时间模型**：窗口落在哪儿、进度怎么算、素材余量够不够。
 *
 * 纯函数、只认帧号，和渲染方式完全无关——溶解走图层不透明度、以后的 shader 转场
 * 走双输入合成节点，但"哪两个片段、从第几帧到第几帧、这一帧的进度是多少"必须
 * 只有这一份答案，否则预览和导出会在**转场的时间位置**上分叉（硬规则 2 管的是
 * 画法一致，管不到这个）。
 *
 * ## 为什么是"零长交界"，不是"两个片段重叠"
 *
 * 重叠模型（Premiere / Resolve 的存储形态）要打破**同轨片段永不重叠**这条核心
 * 不变量：`clipAt()` 会有两个候选而它只返回第一个，`moveClip` / `trimClip` /
 * 磁吸的碰撞检查全部要加"除非这是转场重叠"的例外，而漏掉任何一处都不报错——
 * 只会让一层画面静默消失。代价与收益完全不成比例。
 *
 * 所以这里选：**两个片段在 EDL 里严格相邻（`from.timelineOut === to.timelineIn`），
 * 转场是挂在交界上的一个对象**，窗口由它自己声明、由这个模块算出来。
 *
 * ## 窗口恒对称，因此恒为偶数帧
 *
 * 窗口是 `[J-half, J+half)`，`J` 是交界帧。对称是刻意的：不对称时 50% 那一刻
 * 就不在 `J` 上了，用户看到的"剪切点"会随转场时长漂移，而剪切点的位置是他们
 * 刚刚精心调过的。代价是请求奇数帧时向下取偶——由 `effectiveFrames` 报出来。
 *
 * ## 每个片段最多借出自己长度的一半
 *
 * 一个片段可能同时是上一个转场的 `to` 和下一个转场的 `from`。各自最多借一半，
 * 两个窗口就永远不会重叠——重叠意味着某一帧上有三层画面要混，那是个没有定义
 * 的状态。这条约束让"一帧最多两层参与转场"成为**结构性保证**而不是运气。
 *
 * ## 余量不足时定格，不拒绝
 *
 * 窗口跨过交界，于是 `from` 要读它出点之后的素材、`to` 要读它入点之前的素材
 * （即 NLE 说的 handle）。最常见的场景恰恰一点余量都没有：两段**满长**素材
 * 前后相邻，`from` 的出点就是源片末尾、`to` 的入点就是源片开头。
 *
 * 那时的选择只有三个：拒绝创建（最常见的用法直接不可用）、把后面的片段整体
 * 左移让它们真重叠（改变成片时长，且是个波及全轨的编辑）、或者**定格边缘帧**。
 * 这里选第三个，和 Premiere 的行为一致，但**必须把定格帧数报到界面上**
 * （`frozenFrames`）——它和硬规则 10 那种"静默降级"的区别在于：定格在预览里
 * 看得见，格式被悄悄换掉看不见。看得见的降级要标注，不必禁止。
 */

import type { Clip, MediaClip, Transition } from "./types";
import { clipDuration, clipSourceFrames, clipSpeed, unscaleBySpeed } from "./types";

/** 转场时长的下限。低于 2 帧对称窗口就退化成空。 */
export const MIN_TRANSITION_FRAMES = 2;

/**
 * 转场时长的上限（帧）。
 *
 * 不是技术限制，是**防手滑**：时长框里多打一个零会让一个 300 帧的片段整段
 * 参与转场，而窗口本来就会被"最多借一半"夹住，用户看到的是"输入 1200、
 * 实际 150"，很难对上。10 秒（300 帧 @30fps）远超任何实际用法。
 */
export const MAX_TRANSITION_FRAMES = 300;

/**
 * 一个已经解算好的转场窗口。**所有消费方都只认这个结构，不自己算帧号。**
 *
 * `startFrame` 含、`endFrame` 不含，与片段占位的左闭右开一致。
 */
export interface TransitionWindow {
  readonly kind: Transition["kind"];
  /** 出场片段，窗口后半段要读它出点之后的素材。 */
  readonly from: Clip;
  /** 入场片段，窗口前半段要读它入点之前的素材。 */
  readonly to: Clip;
  /** 交界帧：`from.timelineOut === to.timelineIn`，也是进度 50% 的位置。 */
  readonly junction: number;
  readonly startFrame: number;
  readonly endFrame: number;
  /** 窗口实际长度（帧），恒为偶数，可能小于请求值。 */
  readonly frames: number;
}

/**
 * 解算一个转场窗口；两段不相邻、或夹紧后长度归零时返回 null。
 *
 * 返回 null 而不是抛错：EDL 里可能留着一个"曾经相邻、现在被拖开了"的转场，
 * 那是编辑器该扛住的中间状态，不该让整条渲染崩掉。真正保证不留孤儿的是
 * `state/operations.ts` 里的归一化，这里只是不信任它。
 */
export function transitionWindow(
  from: Clip,
  to: Clip,
  transition: Transition,
): TransitionWindow | null {
  if (from.timelineOut !== to.timelineIn) return null;

  const requested = Math.min(
    MAX_TRANSITION_FRAMES,
    Math.max(0, Math.floor(transition.frames)),
  );
  // 三个上限取小：请求值的一半、两个片段各自能借出的一半。
  // 用 floor 而不是 round——借多了会让两个相邻转场的窗口重叠
  const half = Math.min(
    Math.floor(requested / 2),
    Math.floor(clipDuration(from) / 2),
    Math.floor(clipDuration(to) / 2),
  );
  if (half < 1) return null;

  const junction = from.timelineOut;
  return {
    kind: transition.kind,
    from,
    to,
    junction,
    startFrame: junction - half,
    endFrame: junction + half,
    frames: half * 2,
  };
}

/** 该帧是否落在窗口内。 */
export function windowCovers(window: TransitionWindow, frame: number): boolean {
  return frame >= window.startFrame && frame < window.endFrame;
}

/**
 * 这一帧的转场进度，0 → 1（`from` 完全可见 → `to` 完全可见）。
 *
 * 取的是**帧中点**，所以两端都不会精确等于 0 或 1：窗口第一帧若是纯 `from`，
 * 那一帧就白费了（画面和没有转场时一模一样），末帧同理。和 `sourceCenterMicrosAt`
 * 取帧中点是同一个道理——帧是区间不是瞬间。
 */
export function transitionProgress(window: TransitionWindow, frame: number): number {
  return (frame - window.startFrame + 0.5) / window.frames;
}

/**
 * 窗口里有多少帧读不到真实素材、只能定格边缘帧。
 *
 * `from` 要的是出点**之后**的余量，`to` 要的是入点**之前**的余量，两侧各 `frames/2`。
 * 文字片段没有源片，永远是 0（它的画面是现场生成的，任意时刻都有）。
 *
 * 这个数要显示在界面上，见文件头"余量不足时定格，不拒绝"。
 */
export function frozenFrames(
  window: TransitionWindow,
  role: "from" | "to",
  sourceDurationFrames: number,
): number {
  const clip = role === "from" ? window.from : window.to;
  if (clip.kind !== "media") return 0;
  const need = window.frames / 2;
  return Math.max(0, Math.min(need, need - availableHandle(clip, role, sourceDurationFrames)));
}

/**
 * 把源片时刻夹回素材真实存在的范围，超出的部分就是定格。
 *
 * **只在转场窗口里会越界**：窗口跨过交界之后，`sourceMicrosAt` 算出来的位置会
 * 落到片段自己的占位之外，可能为负、也可能超过源片末尾。夹紧发生在这里而不是
 * `sourceMicrosAt` 里，是因为后者是纯换算——"这一刻对应源片哪一点"和"源片有
 * 没有这一点"是两个问题，混在一起会让越界变得看不出来。
 */
export function clampSourceMicros(micros: number, lastFrameMicros: number): number {
  if (!(micros > 0)) return 0;
  return Math.min(micros, Math.max(0, lastFrameMicros));
}

/**
 * 一条轨上所有生效的转场窗口，按交界帧从小到大。
 *
 * 转场存在**入场片段**上（`Clip.transitionIn`），所以这里逐个片段往前找紧邻的
 * 前驱。前驱不存在或不紧邻 → 那是个孤儿，跳过（见 `transitionWindow` 的注释）。
 */
export function trackTransitionWindows(clips: readonly Clip[]): TransitionWindow[] {
  const sorted = [...clips].sort((a, b) => a.timelineIn - b.timelineIn);
  const out: TransitionWindow[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const to = sorted[i];
    const from = sorted[i - 1];
    if (!to || !from || !to.transitionIn) continue;
    const window = transitionWindow(from, to, to.transitionIn);
    if (window) out.push(window);
  }
  return out;
}

/** 覆盖该帧的转场窗口；一帧最多一个（见文件头"最多借出一半"）。 */
export function transitionAt(clips: readonly Clip[], frame: number): TransitionWindow | null {
  for (const window of trackTransitionWindows(clips)) {
    if (windowCovers(window, frame)) return window;
  }
  return null;
}

/**
 * 一个片段实际要出画的帧区间，**把两侧转场借走的部分算进去**，左闭右开。
 *
 * 平时就是它自己的占位；作为入场片段时向前延伸到窗口起点，作为出场片段时
 * 向后延伸到窗口终点。导出的 reader 用它决定每个片段要解码多长一段——
 * 只按占位开区间的话，转场窗口里越界的那些帧解不出来，成片里那一层是黑的。
 */
export function clipRenderSpan(
  clips: readonly Clip[],
  clip: Clip,
): { readonly firstFrame: number; readonly lastFrame: number } {
  let firstFrame = clip.timelineIn;
  let lastFrame = clip.timelineOut;
  for (const window of trackTransitionWindows(clips)) {
    if (window.to.id === clip.id) firstFrame = Math.min(firstFrame, window.startFrame);
    if (window.from.id === clip.id) lastFrame = Math.max(lastFrame, window.endFrame);
  }
  return { firstFrame, lastFrame };
}

/**
 * 素材片段在转场窗口里能借到的余量，单位是**时间轴帧**。给编辑层做提示用。
 *
 * 与 `frozenFrames` 的区别：这个只问素材本身有多少，不问窗口要多少。
 *
 * **余量在源片侧算、报出来时换成时间轴帧**（`unscaleBySpeed`）。两者在变速下不是
 * 一回事：2× 的片段有 30 帧源片余量，只够铺 15 个时间轴帧。混着用不报错，表现是
 * 界面说"余量够 30 帧"而窗口开到第 16 帧就开始定格。
 */
export function availableHandle(
  clip: MediaClip,
  role: "from" | "to",
  sourceDurationFrames: number,
): number {
  const inSource =
    role === "from"
      ? sourceDurationFrames - (clip.sourceIn + clipSourceFrames(clip))
      : clip.sourceIn;
  return Math.max(0, unscaleBySpeed(inSource, clipSpeed(clip)));
}
