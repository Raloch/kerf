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
import { clipRenderSpan, trackTransitionWindows } from "../edl/transition";
import { microsToSeconds, sourceMicrosAt } from "../edl/sampling";
import {
  isAudioTransition,
  type ClipId,
  type RenderRange,
  type SourceId,
  type Timeline,
} from "../edl/types";
import { frameToMicros } from "../time/timebase";

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
   */
  readonly volume: number;
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

      // 占位向两侧转场借出的部分要一起解，否则淡化只淡了一半
      const span = clipRenderSpan(track.clips, clip);
      const firstFrame = Math.max(span.firstFrame, range.inFrame);
      const lastFrame = Math.min(span.lastFrame, range.outFrame);
      if (lastFrame <= firstFrame) continue;

      const ramps: CrossfadeRamp[] = [];
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

        if (!earliest || startFrame < earliest.startFrame) {
          earliest = { startFrame, gain: crossfadeGain(window.kind, role, fromProgress) };
        }
      }

      ramps.sort((a, b) => a.startSeconds - b.startSeconds);
      // 包络在这段 PCM 起播之前就已经开始 → 起始增益取那一刻的曲线值。
      // 作为入场片段时解码区间恰好起于窗口起点，于是这里取到 0
      const baseGain = earliest && earliest.startFrame <= firstFrame ? earliest.gain : 1;

      jobs.push({
        clipId: clip.id,
        sourceId: clip.sourceId,
        whenSeconds: seconds(firstFrame - range.inFrame),
        srcStartSeconds: microsToSeconds(
          sourceMicrosAt(clip, firstFrame, timeline.fps, source.fps),
        ),
        srcEndSeconds: microsToSeconds(
          sourceMicrosAt(clip, lastFrame, timeline.fps, source.fps),
        ),
        baseGain,
        ramps,
        volume: clip.volume ?? 1,
      });
    }
  }

  return jobs;
}
