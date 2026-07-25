/**
 * EDL（Edit Decision List）——时间轴的唯一数据来源。
 *
 * 预览和导出都从同一份 EDL 出发，经由同一个 compose() 产出画面，
 * 这是"预览与导出画面一致"的唯一保证，详见 CLAUDE.md 硬规则 2。
 *
 * 所有时间字段一律是**帧号**（整数），不是秒。M0 只用到单轨单片段，
 * 但类型按 M1/M2 的需要留好了扩展位（多轨、多片段、转场、效果）。
 */

import type { Rational } from "../time/rational";

export type SourceId = string;
export type ClipId = string;
export type TrackId = string;

export type TrackKind = "video" | "audio";

/** 导入的素材。M0 直接持有 File；M1 起改为 OPFS 句柄 + 代理文件。 */
export interface MediaSource {
  readonly id: SourceId;
  readonly name: string;
  readonly file: File;
  /** 源片自身的帧率，已吸附成有理数。 */
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  /** 源片总帧数（按 fps 换算）。 */
  readonly durationFrames: number;
  readonly hasAudio: boolean;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
}

/**
 * 时间轴上的一个片段。
 *
 * `timelineIn` / `timelineOut` 是它在时间轴上的占位（左闭右开），
 * `sourceIn` 是它引用源片的起始帧。三者都是帧号。
 */
export interface Clip {
  readonly id: ClipId;
  readonly sourceId: SourceId;
  readonly timelineIn: number;
  readonly timelineOut: number;
  readonly sourceIn: number;
  /** 片段标签，缺省时 UI 回退到素材名。冲突提示也用它。 */
  readonly name?: string | undefined;
  /** M2 起承载滤镜/变换/关键帧。M0 恒为空。 */
  readonly effects?: readonly never[];
}

export interface Track {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly clips: readonly Clip[];
  /** 轨道头显示的名称，例如「主视频」「人声」。 */
  readonly label?: string | undefined;
  readonly muted?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  /** 锁定后所有编辑操作被拒绝。UI 上是轨道头的锁图标。 */
  readonly locked?: boolean | undefined;
}

/** 一个项目的完整可渲染状态。不可变——改动产生新对象，以便撤销栈直接持有快照。 */
export interface Timeline {
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  /** 时间轴总长（帧）。 */
  readonly durationFrames: number;
  readonly tracks: readonly Track[];
  readonly sources: readonly MediaSource[];
}

/** 导出范围，帧号，左闭右开。 */
export interface RenderRange {
  readonly inFrame: number;
  readonly outFrame: number;
}

export function clipDuration(clip: Clip): number {
  return clip.timelineOut - clip.timelineIn;
}

export function findSource(timeline: Timeline, id: SourceId): MediaSource {
  const source = timeline.sources.find((s) => s.id === id);
  if (!source) throw new Error(`EDL 引用了不存在的素材：${id}`);
  return source;
}

/** 取某轨道在指定帧处的片段；空档返回 null。 */
export function clipAt(track: Track, frame: number): Clip | null {
  for (const clip of track.clips) {
    if (frame >= clip.timelineIn && frame < clip.timelineOut) return clip;
  }
  return null;
}

/** 把时间轴帧号换算成源片帧号。 */
export function toSourceFrame(clip: Clip, timelineFrame: number): number {
  return clip.sourceIn + (timelineFrame - clip.timelineIn);
}

/**
 * M0 用：把单个素材包成"单轨单片段"的时间轴。
 *
 * 时间轴帧率直接继承源片帧率——M0 不做变速和帧率转换，
 * 保证管道验证的是纯粹的 decode → compose → encode → mux。
 */
export function singleClipTimeline(
  source: MediaSource,
  range?: Partial<RenderRange>,
): Timeline {
  const inFrame = Math.max(0, range?.inFrame ?? 0);
  const outFrame = Math.min(source.durationFrames, range?.outFrame ?? source.durationFrames);
  const length = Math.max(1, outFrame - inFrame);

  const videoClip: Clip = {
    id: "clip-v1",
    sourceId: source.id,
    timelineIn: 0,
    timelineOut: length,
    sourceIn: inFrame,
  };

  const tracks: Track[] = [
    { id: "V1", kind: "video", clips: [videoClip] },
  ];
  if (source.hasAudio) {
    tracks.push({
      id: "A1",
      kind: "audio",
      clips: [{ ...videoClip, id: "clip-a1" }],
    });
  }

  return {
    fps: source.fps,
    width: source.width,
    height: source.height,
    durationFrames: length,
    tracks,
    sources: [source],
  };
}
