/**
 * 混音的**排期**：每个音频片段解源片哪一段、在成片什么时候起播、增益怎么走。
 *
 * 从 `mixdown.ts` 里拆出来是为了**能单测**。真正会算错的是这里——转场窗口把
 * 解码区间往两边撑开多少、窗口被导出区间切掉一半时曲线该从哪个进度接上、
 * 一个片段同时是上一个转场的入场和下一个转场的出场时两条包络怎么排。这些全是
 * 纯帧号算术，而 `OfflineAudioContext` 在 node 里造不出来，混在一起就只能靠
 * 端到端自检去撞，撞到了也不知道是排期错了还是接线错了。
 *
 * 同 `state/operations.ts` 那条约定：**判断写进纯函数，副作用留在外面。**
 *
 * ## 解码区间要按 `clipRenderSpan()` 开，不是按片段占位
 *
 * 和导出的取帧循环是同一条规则（CLAUDE.md 导出层约定）：转场窗口跨过交界，
 * 出场片段要多解出点之后一段、入场片段要多解入点之前一段。按占位开区间的话
 * 那一段是静音的，听起来就是"淡化只淡了一半，另一半直接没了"。
 *
 * ## 素材余量不够时是**静音**，不是定格
 *
 * 画面那边余量不足会定格边缘帧（`edl/transition.ts` 文件头）。声音**不能定格**
 * ——把最后一个采样点按住会得到一个直流台阶，松开时是"啪"的一声，比静音坏得多。
 * 所以这里让它自然静音：源片区间照常按窗口算出来，**允许为负、允许超过源片
 * 末尾**，`decodeRange()` 会把不存在的那部分留成零。于是余量不足的交叉淡化会
 * 退化成单侧淡入/淡出，这在界面上要标注（`junctionInfo` 的 `frozen`）。
 */

import {
  crossfadeCurvePoints,
  crossfadeGain,
  type AudioTransitionKind,
  type CrossfadeRole,
} from "./crossfade";
import { resolveVolume, type KeyframeChannels } from "../anim/keyframes";
import { clipRenderSpan, trackTransitionWindows } from "../edl/transition";
import { microsToSeconds, sourceMicrosAt } from "../edl/sampling";
import {
  clipSpeed,
  isAudioTransition,
  isNormalSpeed,
  sourceGridFps,
  type ClipId,
  type RenderRange,
  type SourceId,
  type Timeline,
} from "../edl/types";
import { frameToMicros } from "../time/timebase";
import type { Rational } from "../time/rational";

/**
 * 帧数 → 秒，**不经过微秒**。
 *
 * 管线里别处的秒一律走 `microsToSeconds(frameToMicros(...))`，那是硬规则 1 要的。
 * 音频的**起播时刻**不能这么算：微秒取整在 48kHz 上是 **0.048 个样本**的误差，
 * 而 Web Audio 的 `start(when)` 是亚采样精确的（Chrome 会按小数相位插值）。
 * 于是同一个片段在不同段里被排期时相位不同，接缝两侧的波形对不上。
 *
 * 实测就是这么发现的：分段与不分段混出来的 PCM 差 **5.22e-4**，而 0.016 个样本
 * 的相位差在 0.25 幅度的 1kHz 正弦上恰好是 5.3e-4——两个数对上了，改成精确
 * 有理数之后归零。这不违反硬规则 1：帧运算仍然是整数帧号，只是**换算成秒的
 * 那一步**不再多绕一道量化。
 *
 * `frames × den` 在 800 万帧、den=1001 时是 8e9，远在安全整数内。
 */
function exactSeconds(frames: number, fps: { readonly num: number; readonly den: number }): number {
  return (frames * fps.den) / fps.num;
}

/** 一段增益包络。时间相对**导出区间起点**，不是时间轴起点。 */
export interface CrossfadeRamp {
  readonly kind: AudioTransitionKind;
  readonly role: CrossfadeRole;
  readonly startSeconds: number;
  readonly durationSeconds: number;
  /**
   * 曲线覆盖的进度区间。通常 0 → 1；**导出区间从窗口中间切过去**时是一截，
   * 那时端点值不再是 1 和 0，要由 `crossfadeGain()` 现算（见 `baseGain`）。
   */
  readonly fromProgress: number;
  readonly toProgress: number;
  /** 曲线采样点数，见 `crossfadeCurvePoints()`。 */
  readonly points: number;
}

/** 一个音频片段在这次导出里的完整排期。 */
export interface AudioJob {
  readonly clipId: ClipId;
  readonly sourceId: SourceId;
  /** 相对导出区间起点，这段 PCM 从什么时候开始播。 */
  readonly whenSeconds: number;
  /**
   * 要解的源片区间。**可能为负、也可能超过源片末尾**——那部分是静音，
   * 见文件头"素材余量不够时是静音"。
   */
  readonly srcStartSeconds: number;
  readonly srcEndSeconds: number;
  /**
   * 第一段包络生效之前的增益。
   *
   * 不恒等于 1：作为入场片段时它从 0 起（前半个窗口正在淡入），而导出区间从
   * 窗口中间切过去时它是那个进度上的曲线值。写死 1 的表现是**成片开头第一
   * 瞬间音量跳一下**，只有几毫秒，容易被当成编码噪声。
   */
  readonly baseGain: number;
  /** 按时间先后排；D19 保证两段永不重叠，所以可以直接顺序喂给 AudioParam。 */
  readonly ramps: readonly CrossfadeRamp[];
  /**
   * 片段的静态音量倍数（`MediaClip.volume`，缺省 1）。
   *
   * **刻意不乘进 `baseGain` / 各条 `ramps` 里**，尽管那在算术上完全等价。这一层
   * 唯一的用处是可单测，而乘在一起之后"淡化的进度算错了"和"音量传错了"在返回值
   * 上就分不开——两者都表现为"某个数不对"。分开留着，一条断言只会因为一个原因红。
   *
   * 相乘发生在 `mixdown.ts` 的 `envelopeInput`，那里也是恒等快路径的判据所在。
   *
   * **音量被打了关键帧时这个字段仍然是静态值**，实际生效的是下面的 `gainCurve`。
   */
  readonly volume: number;
  /**
   * 播放速率（变速，D39）。**原速时这个字段不存在**，于是接线那边连
   * `playbackRate` 都不碰——同"恒等增益不穿 `GainNode`"，为的是没变速的项目
   * 逐样本与加变速之前完全相同。
   *
   * **它不需要改动 `srcStartSeconds` / `srcEndSeconds` 的算法**：那两个已经走
   * `sourceMicrosAt`，速度进了那个函数，源片区间自动变成 `时长 × speed`。所以这里
   * 只是把"同样长的一段源片要在多短的时间里放完"告诉音频图，两者相乘恰好等于
   * 片段在时间轴上的占位。漏了这个字段的表现是**声音变慢/变快到和画面对不上**，
   * 而且不报错——区间是对的，只是放的速度不对。
   *
   * `ramps` / `gainCurve` **在导出坐标系里，不受它影响**：`playbackRate` 只改
   * "buffer 里的哪一点对应输出的哪一刻"，包络挂在 `GainNode` 上，仍按输出时间走。
   *
   * 是 `Rational` 而不是 `number`，理由同 `MediaClip.speed`：精确值留到最后一步
   * （`playbackRate.value` 才是 float），中间不引入第二次量化。
   */
  readonly speed?: Rational;
  /**
   * 淡化 × 音量的**合成曲线**，只在音量有关键帧时才有。有它的时候
   * `baseGain` / `ramps` 都不再喂给 `AudioParam`——那三样加起来就是这一条。
   *
   * ## 为什么要把两者预先乘成一条，而不是串两级 GainNode
   *
   * 静态音量是常数，乘进淡化曲线的每个采样点上就完事（D27）。**包络不是常数**：
   * 两条随时间变化的曲线相乘，结果不是任何一条曲线的缩放版。Web Audio 的
   * `AudioParam` 上同一段时间只能有一条 `setValueCurveAtTime`（重叠直接抛错），
   * 所以要么串第二个 `GainNode`、要么把乘积算出来。选后者：
   *
   * - **算术留在纯函数里**。乘积的形状（淡化窗口内外怎么接、包络在片段坐标系而
   *   淡化在导出坐标系）正是会写错的地方，而写错的表现是"声音大小不对"，不抛错。
   *   放在这里它就能被单测钉住，同这个文件存在的全部理由。
   * - **没打关键帧的项目一个字节都不变**。串两级的话得再证明"第二级在恒等时也
   *   走快路径"，判据从一个变成两个（同 D27 否掉串两级的理由，在这里第二次成立）。
   *
   * 采样点是**每帧一个**（`lastFrame - firstFrame + 1` 个），`setValueCurveAtTime`
   * 在点之间线性插值。关键帧本来就只能打在整数帧上，所以在关键帧处是精确的；
   * 帧之间用 33ms 的直线段逼近缓动曲线，听不出来。这不违反"音频进度是连续的"
   * ——那条说的是**不要取帧中点**，而这里取的是帧起点，插值把中间补上了。
   */
  readonly gainCurve?: {
    readonly points: readonly number[];
    /** 相对导出区间起点，恒等于 `whenSeconds`；显式给出免得读的人去推。 */
    readonly startSeconds: number;
    readonly durationSeconds: number;
  };
}

/** 一条淡化包络在**帧**坐标系下的位置，`gainCurve` 逐帧求值时要用。 */
interface RampSpan {
  readonly kind: AudioTransitionKind;
  readonly role: CrossfadeRole;
  readonly startFrame: number;
  readonly windowStartFrame: number;
  readonly windowFrames: number;
  readonly toProgress: number;
}

/**
 * 第 `frame` 帧上的**淡化**增益（不含音量）。
 *
 * 语义必须与喂给 `AudioParam` 的那串 `setValueAtTime` + `setValueCurveAtTime`
 * **逐点一致**：起点是 `baseGain`；进到某条包络里取当前进度的曲线值；越过它之后
 * **保持末值**（`AudioParam` 在曲线结束后就是这样，不会跳回去）。`spans` 按起点
 * 升序且互不重叠（D19 保证一个片段两侧的窗口最多各借一半），所以顺序走一遍即可。
 *
 * 单测里有一条"音量恒定时这条曲线等于老路径 × 音量"、M0 里有一条"恒定包络的成片
 * 与静态音量逐样本相同"，钉的都是这份一致性——两条路径分叉的表现是"打了关键帧
 * 之后淡化的形状变了"，而那会被当成包络本身算错。反向验证过：把这个函数改成只返回
 * `baseGain`（= 忘了把淡化折进合成曲线），M0 那条立刻红到 **1.15e-1**，比容差高
 * 五个数量级，而"恒定包络·无转场"那条仍绿——没有淡化可折，也就无从忘记。
 *
 * `Math.min(toProgress, …)` 那层夹紧**是可证明冗余的**，留着只为了把"越过之后保持
 * 末值"这件事写在本地：`crossfadeGain` 内部已经把进度夹在 [0,1]，而 `toProgress < 1`
 * 只在窗口被区间切掉尾巴时出现，那时 `lastFrame` 同样被切到那里、`frame` 到不了
 * 更远。别把它当成护栏——我拿去掉它当破坏验过一轮，两层断言全绿，那是对的。
 */
function crossfadeGainAtFrame(
  baseGain: number,
  spans: readonly RampSpan[],
  frame: number,
): number {
  let gain = baseGain;
  for (const span of spans) {
    if (frame < span.startFrame) break;
    const progress = Math.min(
      span.toProgress,
      (frame - span.windowStartFrame) / span.windowFrames,
    );
    gain = crossfadeGain(span.kind, span.role, progress);
  }
  return gain;
}

/**
 * 音量有关键帧时，把淡化 × 音量逐帧采成一条曲线；没关键帧返回 `null`
 * （于是那条 spread 什么都不加，`gainCurve` 字段根本不存在——同"改回缺省值要把
 * 字段整个删掉"，这里更要紧：`envelopeInput` 判的就是这个字段有没有）。
 *
 * 关键帧的帧偏移**相对片段起点**（D10），而淡化和采样点都在时间轴/导出坐标系里，
 * 所以这里要减 `clip.timelineIn`。两个坐标系混用的表现是"包络整体偏移了一个片段
 * 起点的量"——片段恰好从 0 开始时完全正常，拖到时间轴中间才出错。
 */
function sampleGainCurve(
  clip: { readonly timelineIn: number; readonly volume?: number; readonly keyframes?: KeyframeChannels },
  seconds: (frames: number) => number,
  rangeInFrame: number,
  baseGain: number,
  spans: readonly RampSpan[],
  firstFrame: number,
  lastFrame: number,
): { readonly gainCurve: NonNullable<AudioJob["gainCurve"]> } | null {
  const series = clip.keyframes?.volume;
  if (!series || series.length === 0) return null;

  const count = lastFrame - firstFrame + 1;
  const points: number[] = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    const frame = firstFrame + i;
    // 关键帧的值域由 `setKeyframe` 夹紧过，插值不会越界，所以这里不再夹一遍
    const volume = resolveVolume(clip.volume, clip.keyframes, frame - clip.timelineIn) ?? 1;
    points[i] = crossfadeGainAtFrame(baseGain, spans, frame) * volume;
  }

  return {
    gainCurve: {
      // 和 `whenSeconds` 同一个坐标系：相对**导出区间起点**，不是时间轴起点。
      // 少减这一项时片段的起播和它的增益曲线会错开整个 trim 入点的量
      points,
      startSeconds: seconds(firstFrame - rangeInFrame),
      durationSeconds: seconds(lastFrame - firstFrame),
    },
  };
}

/**
 * 排出这次导出要混哪些片段、各自怎么淡。没有可用音频时返回空数组。
 *
 * 不在这里查 `source.file`，只留 `sourceId`：这样整个返回值是纯数据，
 * 单测里造一个 Timeline 就能断言，不需要真的有文件。
 */
export function planAudioJobs(timeline: Timeline, range: RenderRange): AudioJob[] {
  const jobs: AudioJob[] = [];
  const seconds = (frames: number) => exactSeconds(frames, timeline.fps);

  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    const windows = trackTransitionWindows(track.clips);

    for (const clip of track.clips) {
      // 文字片段没有声音——落到音频轨上是类型允许但 UI 造不出来的组合
      if (clip.kind !== "media") continue;
      const source = timeline.sources.find((s) => s.id === clip.sourceId);
      if (!source || !source.hasAudio) continue;
      // 纯音频素材没有自己的帧栅格，`sourceIn` 按项目帧率算，见 `sourceGridFps()`
      const grid = sourceGridFps(source, timeline.fps);

      // 占位向两侧转场借出的部分要一起解，否则淡化只淡了一半
      const span = clipRenderSpan(track.clips, clip);
      const firstFrame = Math.max(span.firstFrame, range.inFrame);
      const lastFrame = Math.min(span.lastFrame, range.outFrame);
      if (lastFrame <= firstFrame) continue;

      const ramps: CrossfadeRamp[] = [];
      /** 同一批包络的帧坐标，只有 `gainCurve` 用得到。 */
      const spans: RampSpan[] = [];
      /** 最早那段包络，用来定 `baseGain`。比帧号而不是比秒——硬规则 1。 */
      let earliest: { readonly startFrame: number; readonly gain: number } | null = null;

      for (const window of windows) {
        const role: CrossfadeRole | null =
          window.to.id === clip.id ? "to" : window.from.id === clip.id ? "from" : null;
        if (!role) continue;
        // 画面转场不该出现在音频轨上（归一化会清掉），这里只是不信任它
        if (!isAudioTransition(window.kind)) continue;

        // 窗口可能被导出区间切掉一头
        const startFrame = Math.max(window.startFrame, range.inFrame);
        const endFrame = Math.min(window.endFrame, range.outFrame);
        if (endFrame <= startFrame) continue;

        const fromProgress = (startFrame - window.startFrame) / window.frames;
        const toProgress = (endFrame - window.startFrame) / window.frames;
        ramps.push({
          kind: window.kind,
          role,
          startSeconds: seconds(startFrame - range.inFrame),
          durationSeconds: seconds(endFrame - startFrame),
          fromProgress,
          toProgress,
          points: crossfadeCurvePoints(endFrame - startFrame),
        });
        spans.push({
          kind: window.kind,
          role,
          startFrame,
          windowStartFrame: window.startFrame,
          windowFrames: window.frames,
          toProgress,
        });

        if (!earliest || startFrame < earliest.startFrame) {
          earliest = { startFrame, gain: crossfadeGain(window.kind, role, fromProgress) };
        }
      }

      ramps.sort((a, b) => a.startSeconds - b.startSeconds);
      spans.sort((a, b) => a.startFrame - b.startFrame);
      // 包络在这段 PCM 起播之前就已经开始 → 起始增益取那一刻的曲线值。
      // 作为入场片段时解码区间恰好起于窗口起点，于是这里取到 0
      const baseGain = earliest && earliest.startFrame <= firstFrame ? earliest.gain : 1;

      jobs.push({
        clipId: clip.id,
        sourceId: clip.sourceId,
        whenSeconds: seconds(firstFrame - range.inFrame),
        srcStartSeconds: microsToSeconds(sourceMicrosAt(clip, firstFrame, timeline.fps, grid)),
        srcEndSeconds: microsToSeconds(sourceMicrosAt(clip, lastFrame, timeline.fps, grid)),
        baseGain,
        ramps,
        volume: clip.volume ?? 1,
        // 原速不带这个字段，接线那边就不碰 `playbackRate`（见 `AudioJob.speed`）
        ...(isNormalSpeed(clip) ? {} : { speed: clipSpeed(clip) }),
        ...(sampleGainCurve(clip, seconds, range.inFrame, baseGain, spans, firstFrame, lastFrame) ??
          {}),
      });
    }
  }

  return jobs;
}
