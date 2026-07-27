/**
 * EDL（Edit Decision List）——时间轴的唯一数据来源。
 *
 * 预览和导出都从同一份 EDL 出发，经由同一个 compose() 产出画面，
 * 这是"预览与导出画面一致"的唯一保证，详见 CLAUDE.md 硬规则 2。
 *
 * 所有时间字段一律是**帧号**（整数），不是秒。M0 只用到单轨单片段，
 * 但类型按 M1/M2 的需要留好了扩展位（多轨、多片段、转场、效果）。
 */

import { COLOR_PROPERTIES, type KeyframeChannels } from "../anim/keyframes";
import type { ColorAdjust } from "../compose/color";
import type { LayerTransform } from "../compose/compositor";
import type { TextStyle } from "../compose/text-raster";
import type { Rational } from "../time/rational";

export type SourceId = string;
export type ClipId = string;
export type TrackId = string;

/**
 * 轨道只分两条通道：**画面**和**声音**。
 *
 * 刻意**不加** `"text"`——"这一段是素材还是文字"是**片段**的属性（见 `Clip.kind`），
 * 不是轨道的属性。默认布局里的 T1 轨叫「字幕 / 标题」，那是约定俗成的摆放位置，
 * 不是类型约束：标题要能压在叠加轨上，Premiere / Resolve 也都是这么分的。
 * 一旦把文字锁进专用轨，`moveClip` 的"同类轨才能拖"检查就会把这件事直接禁掉。
 */
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
 * 所有片段共有的部分：**在时间轴上的占位**。
 *
 * `timelineIn` / `timelineOut` 左闭右开，都是帧号。移动、切分、波纹删除、磁吸
 * 只关心这几个字段，所以它们对两种片段一视同仁，不需要判别分支。
 */
interface ClipBase {
  readonly id: ClipId;
  readonly timelineIn: number;
  readonly timelineOut: number;
  /** 片段标签，缺省时 UI 回退到素材名 / 文字内容。冲突提示也用它。 */
  readonly name?: string | undefined;
  /**
   * 静态变换：位置 / 缩放 / 旋转 / 不透明度。缺省 = 铺满默认留边位置。
   *
   * 与 `keyframes` **并存**，某属性有关键帧时以关键帧为准（见 PLAN.md 的 D10）。
   * 这里存的是"用户调出来的那个值"，动画只是让它随时间变。
   */
  readonly transform?: LayerTransform;
  /**
   * 静态一级调色：亮度 / 对比度 / 饱和度 / 色相。缺省 = 不调。
   *
   * 和 `transform` 完全同构（静态值 + 关键帧并存、缺省时字段整个不存在），
   * 但**必须是两个字段**：它们作用在合成层的两个不同环节（摆位 vs 颜色），
   * 混成一个的话合成器就得靠字段名去猜这个数该进哪儿。见 PLAN.md 的 D17。
   */
  readonly color?: ColorAdjust;
  /**
   * 关键帧通道，每个属性一条独立序列。帧偏移**相对片段起点**（D10）——
   * 所以在时间轴上平移片段不需要动它，但**裁入点时要跟着平移**。
   *
   * 摆位和调色**共用这一张表**（见 `anim/keyframes.ts` 的 `ANIMATABLE_PROPERTIES`）：
   * 打点、删点、平移、撤销都与"这个属性最后作用到哪儿"无关。
   */
  readonly keyframes?: KeyframeChannels;
}

/** 引用一段导入素材的片段。`sourceIn` 是它引用源片的起始帧。 */
export interface MediaClip extends ClipBase {
  readonly kind: "media";
  readonly sourceId: SourceId;
  readonly sourceIn: number;
}

/**
 * 文字 / 字幕片段。没有源素材，画面由 `compose/text-raster.ts` 现场生成。
 *
 * **样式里没有位置**：文字在栅格里恒定居中，往哪儿放、放多大一律由 `transform`
 * 表达（见 text-raster.ts 的文件头）。位置有两个来源就必然打架。
 */
export interface TextClip extends ClipBase {
  readonly kind: "text";
  readonly text: string;
  /** 省略则用默认样式（白色、居中、字号占输出高度 8%）。 */
  readonly style?: TextStyle;
}

/**
 * 时间轴上的一个片段。
 *
 * 用**判别联合**而不是"`sourceId` 可选"：可选会把 null 处理散到每一个消费点，
 * 而且漏掉一处不会报错——只会在导出时静默少一层画面。判别联合让 TS 在
 * strict + `noUncheckedIndexedAccess` 下强制每个取源片的地方先表态。
 */
export type Clip = MediaClip | TextClip;

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

/**
 * 用了一级调色的片段（静态值或关键帧任一算数）。
 *
 * 存在的理由是**导出前的能力闸门**：这台机器起不来 WebGL 时调色画不出来，
 * 界面要在开始导出之前就拦下来并说明（见 `ui/ExportDialog.tsx`）。
 *
 * 判据必须**同时看两处**。只看 `clip.color` 会漏掉"静态值是缺省、全靠关键帧动"
 * 的片段——那种片段的 `color` 字段根本不存在（归一化会把全缺省的整个删掉，
 * 见 `state/operations.ts`），于是闸门放行，用户拿到一个丢了调色的成片。
 */
export function clipsUsingColor(timeline: Timeline): Clip[] {
  const out: Clip[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const animated = clip.keyframes
        ? COLOR_PROPERTIES.some((p) => (clip.keyframes?.[p]?.length ?? 0) > 0)
        : false;
      if (clip.color !== undefined || animated) out.push(clip);
    }
  }
  return out;
}

/** 把时间轴帧号换算成源片帧号。 */
export function toSourceFrame(clip: MediaClip, timelineFrame: number): number {
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

  const videoClip: MediaClip = {
    id: "clip-v1",
    kind: "media",
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
