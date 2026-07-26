/**
 * 取样映射：从"时间轴第 N 帧"推出"该读哪个源片的哪个时刻"。
 *
 * 这个模块是硬规则 2 的第二个落点。共用 `compose()` 只保证了"画法一致"，
 * 但如果预览和导出各自算"该画哪个片段、读源片哪一刻"，画面照样会不一致——
 * M1 的导出管道只认单个文件，一致性自检也只覆盖了单片段，正是这个漏洞。
 * 因此**两条路径都必须经由这里**决定取帧位置与图层顺序。
 *
 * ## 为什么不能用 `toSourceFrame()` 做帧号加减
 *
 * `toSourceFrame()` 算的是 `sourceIn + (帧 - timelineIn)`，隐含假设
 * **源片帧率等于时间轴帧率**。导入一个 25fps 素材放到 30fps 时间轴上，
 * 这个假设就破了：时间轴走 30 帧（1 秒）会被映射成源片走 30 帧（1.2 秒），
 * 成片播放速度慢 20%，而且不报任何错。
 *
 * 正确的换算要过一次时间：
 *
 *     源片时刻 = sourceIn/源帧率 + (时间轴帧 - timelineIn)/时间轴帧率
 *
 * 两项都用 `frameToMicros` 算成整数微秒再相加，不碰浮点秒（硬规则 1）。
 * 源帧率与时间轴帧率相同时，结果与 `toSourceFrame()` 完全一致。
 */

import {
  clipAt,
  findSource,
  type MediaClip,
  type MediaSource,
  type TextClip,
  type Timeline,
  type Track,
} from "./types";
import { frameDurationMicros, frameToMicros, MICROS_PER_SECOND } from "../time/timebase";
import type { Rational } from "../time/rational";

/**
 * 时间轴帧号 → 源片时刻（整数微秒）。
 *
 * @param timelineFrame 时间轴帧号，必须落在 clip 的占位区间内
 */
export function sourceMicrosAt(
  clip: MediaClip,
  timelineFrame: number,
  timelineFps: Rational,
  sourceFps: Rational,
): number {
  return (
    frameToMicros(clip.sourceIn, sourceFps) +
    frameToMicros(timelineFrame - clip.timelineIn, timelineFps)
  );
}

/**
 * 同上，但落在**帧中点**。
 *
 * 帧 N 覆盖 [N/fps, (N+1)/fps)。取左边界去 seek 时浏览器常常返回前一帧
 * （currentTime 精度 + "最近可解码位置"的实现差异），于是时间码显示 30
 * 而画面是 frame 29。落在帧内部就没有这个歧义。
 *
 * 预览的 `video.currentTime` 必须用这个；导出走顺序解码，用左边界配合
 * `FRAME_ALIGN_EPSILON_SECONDS` 判断即可，取中点反而会跳过边界帧。
 */
export function sourceCenterMicrosAt(
  clip: MediaClip,
  timelineFrame: number,
  timelineFps: Rational,
  sourceFps: Rational,
): number {
  return (
    sourceMicrosAt(clip, timelineFrame, timelineFps, sourceFps) +
    Math.round(frameDurationMicros(sourceFps) / 2)
  );
}

/** 微秒 → 秒。**只在调用 mediabunny / HTMLMediaElement 的那一行用**（硬规则 1）。 */
export function microsToSeconds(micros: number): number {
  return micros / MICROS_PER_SECOND;
}

/** 某一帧要画的一层素材画面。 */
export interface VisibleMediaClip {
  readonly kind: "media";
  readonly trackId: string;
  readonly clip: MediaClip;
  readonly source: MediaSource;
  /** 该帧对应的源片时刻（整数微秒）。 */
  readonly sourceMicros: number;
}

/** 某一帧要画的一层文字。没有源片，也就没有取帧位置。 */
export interface VisibleTextClip {
  readonly kind: "text";
  readonly trackId: string;
  readonly clip: TextClip;
}

/**
 * 某一帧在某条画面轨上要画的东西。
 *
 * `kind` 与 `clip.kind` 同值，冗余是刻意的：调用点写 `if (v.kind === "media")`
 * 就能同时收窄 `clip` / `source` / `sourceMicros`，靠嵌套的 `v.clip.kind` 收窄不了外层。
 * 这个字段只在下面两个函数里赋值，不存在第二个真值来源。
 */
export type VisibleClip = VisibleMediaClip | VisibleTextClip;

/**
 * 视频轨的**绘制顺序：从底到顶**。
 *
 * `timeline.tracks` 是从上到下（V2 在 V1 之前）的显示顺序，画的时候必须反过来：
 * 先画底层再画上层，否则叠加轨会被主视频盖住。这个反转**只能有一处**——
 * 预览按帧收集图层、导出按轨建 reader，两边都从这里拿顺序，
 * 否则叠加轨的上下关系会在两条路径里不一致（硬规则 2）。
 */
export function videoTracksInDrawOrder(timeline: Timeline): Track[] {
  return [...timeline.tracks].reverse().filter((t) => t.kind === "video" && !t.hidden);
}

/**
 * 收集某帧要画的所有图层，**按 z 序从底到顶**排列。素材层和文字层混在一起返回。
 *
 * 空档（该轨在该帧没有片段）不产生图层——所有轨都空时合成器画纯黑底，
 * 这正是时间轴空隙应有的样子。
 *
 * 文字层**不拆成第二个函数**：叠加轨的素材和字幕轨的文字谁压谁，是同一个 z 序问题，
 * 拆开就等于让调用方自己再合并一次顺序，而那个反转只允许有一处
 * （见 `videoTracksInDrawOrder`）。
 */
export function visibleVideoClips(timeline: Timeline, frame: number): VisibleClip[] {
  const out: VisibleClip[] = [];
  for (const track of videoTracksInDrawOrder(timeline)) {
    const clip = clipAt(track, frame);
    if (!clip) continue;
    if (clip.kind === "text") {
      out.push({ kind: "text", trackId: track.id, clip });
      continue;
    }
    const source = timeline.sources.find((s) => s.id === clip.sourceId);
    if (!source) continue;
    out.push({
      kind: "media",
      trackId: track.id,
      clip,
      source,
      sourceMicros: sourceMicrosAt(clip, frame, timeline.fps, source.fps),
    });
  }
  return out;
}

/**
 * 某一帧在某条音频轨上要混的东西。混流用，取值方式与视频轨一致。
 *
 * 文字片段没有声音，落到音频轨上也直接跳过——不变量是"轨道只管画面/声音的通道，
 * 片段类型由 `clip.kind` 定"，所以这个组合虽然没有 UI 能造出来，类型上仍然合法。
 */
export function audioClipsAt(timeline: Timeline, frame: number): VisibleMediaClip[] {
  const out: VisibleMediaClip[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    const clip = clipAt(track, frame);
    if (!clip || clip.kind !== "media") continue;
    const source = findSource(timeline, clip.sourceId);
    out.push({
      kind: "media",
      trackId: track.id,
      clip,
      source,
      sourceMicros: sourceMicrosAt(clip, frame, timeline.fps, source.fps),
    });
  }
  return out;
}
