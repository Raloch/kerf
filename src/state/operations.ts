/**
 * 时间轴编辑操作：纯函数，输入旧 Timeline 输出新 Timeline。
 *
 * 全部运算只用**整数帧号**，不出现浮点秒（CLAUDE.md 硬规则 1）。
 * 做成纯函数而不是塞进 store，是为了能脱离 React 和浏览器直接单测——
 * 移动、裁切、切分的边界条件极多，靠手点界面验不完。
 *
 * 同一轨道内片段**不允许重叠**。这是时间轴编辑的核心不变量：
 * 一旦允许重叠，compose() 就得决定"同一轨道同一帧取哪个片段"，
 * 而那个决定无论怎么定都会让用户困惑。越界的操作一律被夹紧或拒绝。
 *
 * 大部分操作对素材片段和文字片段一视同仁——它们改的是时间轴占位，那是
 * `ClipBase` 的字段。**只有两处必须分岔**：裁切要看源素材够不够长，
 * 切分要推进右半段的 `sourceIn`。文字层没有源素材，这两件事都不适用。
 */

import {
  ANIMATABLE_PROPERTIES,
  AUDIO_PROPERTIES,
  COLOR_PROPERTIES,
  TRANSFORM_PROPERTIES,
  type AnimatableProperty,
  type AudioProperty,
  type ColorProperty,
  type Easing,
  type Keyframe,
  type KeyframeChannels,
  type TransformProperty,
} from "../anim/keyframes";
import type { ColorAdjust } from "../compose/color";
import type { LayerTransform } from "../compose/compositor";
import { isCssColor } from "../compose/css-color";
import { isManagedFamily } from "../compose/font-registry";
import type { TextStyle } from "../compose/text-raster";
import {
  clipDuration,
  findFont,
  sourceDurationFrames,
  transitionFitsTrack,
  type Clip,
  type ClipId,
  type FontSource,
  type LutId,
  type LutSource,
  type MediaClip,
  type MediaSource,
  type TextClip,
  type Timeline,
  type Track,
  type TrackId,
  type TrackKind,
  type Transition,
  type TransitionKind,
} from "../edl/types";
import {
  MAX_TRANSITION_FRAMES,
  MIN_TRANSITION_FRAMES,
  frozenFrames,
  transitionWindow,
} from "../edl/transition";

/** 操作失败时返回原对象，并给出原因，便于 UI 提示而不是静默无反应。 */
export interface EditResult {
  readonly timeline: Timeline;
  readonly changed: boolean;
  /**
   * 失败原因。
   *
   * `changed:false` 且**没有** reason 是第三种结果：**值没变**——不是失败，
   * 只是不该产生历史条目。滑块拖到边界后继续拖会一直发同一个值，
   * 把它当失败会让状态栏一直闪红字。store 的 `apply()` 据此决定要不要提示。
   */
  readonly reason?: string;
}

function ok(timeline: Timeline): EditResult {
  return { timeline, changed: true };
}
function reject(timeline: Timeline, reason: string): EditResult {
  return { timeline, changed: false, reason };
}
/** 值没变：不进撤销栈，也不算失败。见 `EditResult.reason`。 */
function unchanged(timeline: Timeline): EditResult {
  return { timeline, changed: false };
}

function findTrack(timeline: Timeline, trackId: TrackId): Track | undefined {
  return timeline.tracks.find((t) => t.id === trackId);
}

export function findClip(
  timeline: Timeline,
  clipId: ClipId,
): { track: Track; clip: Clip } | undefined {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return undefined;
}

/** 片段按 timelineIn 排序，保证轨道内始终有序——UI 和 compose 都依赖这个顺序。 */
function sortClips(clips: readonly Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.timelineIn - b.timelineIn);
}

function overlaps(a: Clip, b: Clip): boolean {
  // 左闭右开：[0,10) 与 [10,20) 相邻但不重叠
  return a.timelineIn < b.timelineOut && b.timelineIn < a.timelineOut;
}

/** 在轨道内找与候选片段重叠的其他片段（排除自己）。 */
function collisionsIn(track: Track, candidate: Clip): Clip[] {
  return track.clips.filter((c) => c.id !== candidate.id && overlaps(c, candidate));
}

function replaceTracks(timeline: Timeline, tracks: readonly Track[]): Timeline {
  return { ...timeline, tracks, durationFrames: computeDuration(tracks) };
}

/**
 * 换掉整组轨道，并把每一条都**过一遍归一化**（排序 + 丢孤儿转场 + 重算总长）。
 *
 * 给"不是普通编辑但同样改了片段列表"的入口用——目前只有崩溃恢复（素材找不回来时
 * 要移除片段，见 `project-snapshot.ts`）。它必须走这里而不是自己拼一个 `Timeline`：
 * 删掉一个片段会让后继片段的转场指向一个不存在的交界，而那是"界面显示有转场、
 * 画面上没有"的状态，两边都不报错（见 `dropOrphanTransitions`）。
 */
export function withNormalizedTracks(
  timeline: Timeline,
  tracks: readonly Track[],
): Timeline {
  return replaceTracks(
    timeline,
    tracks.map((t) => withClips(t, t.clips)),
  );
}

/** 时间轴长度 = 所有片段的最大 timelineOut。空时间轴长度为 0。 */
export function computeDuration(tracks: readonly Track[]): number {
  let max = 0;
  for (const track of tracks) {
    for (const clip of track.clips) {
      if (clip.timelineOut > max) max = clip.timelineOut;
    }
  }
  return max;
}

/**
 * 丢掉失去前驱的转场。**每次改动片段列表都要过这里**（见 `withClips`）。
 *
 * 转场挂在入场片段上，而"和谁交界"由占位决定，不由字段记录（见 `edl/types.ts`
 * 的 `Transition`）。片段被拖开、前驱被删掉、前驱被裁短之后，那个字段就指向了
 * 一个不存在的交界。留着它是"存了但不生效"的状态：界面显示有转场、画面上没有，
 * 而两边都不报错。
 *
 * 只在**相邻关系断掉**时清，不因为"片段太短、窗口解不出来"而清——后者是可恢复的
 * （把片段拉长转场就回来了），和关键帧被平移到片段外仍然保留是同一个道理。
 *
 * 顺带兜住"种类和轨道对不上"：画面转场描述像素怎么混，音频轨上没有像素
 * （见 `edl/types.ts` 的 `transitionFitsTrack`）。片段不能跨轨道种类拖，
 * 所以这一条实际拦不到东西——它防的是将来某个新编辑操作忘了校验。
 */
function dropOrphanTransitions(sorted: readonly Clip[], kind: TrackKind): Clip[] {
  return sorted.map((clip, i) => {
    const transition = clip.transitionIn;
    if (!transition) return clip;
    const prev = i > 0 ? sorted[i - 1] : undefined;
    const live =
      prev !== undefined &&
      prev.timelineOut === clip.timelineIn &&
      transitionFitsTrack(transition.kind, kind);
    return live ? clip : setOptional(clip, "transitionIn", undefined);
  });
}

function withClips(track: Track, clips: readonly Clip[]): Track {
  return { ...track, clips: dropOrphanTransitions(sortClips(clips), track.kind) };
}

function mapTrack(
  timeline: Timeline,
  trackId: TrackId,
  fn: (track: Track) => Track,
): Timeline {
  const tracks = timeline.tracks.map((t) => (t.id === trackId ? fn(t) : t));
  return replaceTracks(timeline, tracks);
}

/** 原地替换一个片段。只给**不改时间占位**的操作用，所以不做重叠检查。 */
function replaceClip(timeline: Timeline, trackId: TrackId, next: Clip): Timeline {
  return mapTrack(timeline, trackId, (t) =>
    withClips(t, t.clips.map((c) => (c.id === next.id ? next : c))),
  );
}

/**
 * 设置或**删除**一个可选字段。
 *
 * 不能写成 `{ ...clip, transform: undefined }`：严格模式开了
 * `exactOptionalPropertyTypes`，"字段存在但值是 undefined"和"字段不存在"是
 * 两种类型，而下游判的正是**存在与否**——合成器的恒等快路径（D9）和
 * `resolveTransform` 原样返回 base（D10）都靠它。所以清除必须真的 delete。
 */
function setOptional<T extends object>(obj: T, key: string, value: unknown): T {
  const next = { ...obj } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as T;
}

// ---------------------------------------------------------------------------
// 移动
// ---------------------------------------------------------------------------

export interface MoveOptions {
  /** 目标轨道；不传表示留在原轨道。 */
  readonly toTrack?: TrackId;
  /** 是否允许把落点夹到合法位置（拖拽时为 true，输入框精确设值时为 false）。 */
  readonly clampToBounds?: boolean;
}

/**
 * 平移片段。
 *
 * 片段自身长度不变，`sourceIn` 也不变——移动改的是"放在时间轴哪里"，
 * 不是"引用源片的哪一段"。这两件事混在一起是时间轴 bug 的常见来源。
 */
export function moveClip(
  timeline: Timeline,
  clipId: ClipId,
  deltaFrames: number,
  options: MoveOptions = {},
): EditResult {
  if (!Number.isInteger(deltaFrames)) return reject(timeline, "位移必须是整数帧");

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);

  const targetTrackId = options.toTrack ?? found.track.id;
  const targetTrack = findTrack(timeline, targetTrackId);
  if (!targetTrack) return reject(timeline, `找不到轨道 ${targetTrackId}`);
  if (targetTrack.kind !== found.track.kind) {
    // 措辞按**轨道通道**说而不是按片段类型说：文字片段也住在画面轨上，
    // 说"不能把视频片段拖到另一种轨道"对着一个字幕片段是错的
    return reject(
      timeline,
      found.track.kind === "video" ? "不能把画面片段拖到音频轨" : "不能把音频片段拖到画面轨",
    );
  }
  if (targetTrack.locked) return reject(timeline, "目标轨道已锁定");
  if (found.track.locked) return reject(timeline, "片段所在轨道已锁定");

  const length = clipDuration(found.clip);
  let newIn = found.clip.timelineIn + deltaFrames;
  // 不允许拖到 0 之前：时间轴没有负时间
  if (newIn < 0) {
    if (options.clampToBounds === false) return reject(timeline, "片段不能移到时间轴起点之前");
    newIn = 0;
  }

  const moved: Clip = { ...found.clip, timelineIn: newIn, timelineOut: newIn + length };
  const sameTrack = targetTrackId === found.track.id;
  const probeTrack = sameTrack
    ? targetTrack
    : withClips(targetTrack, [...targetTrack.clips, moved]);
  const hits = collisionsIn(probeTrack, moved);
  if (hits.length > 0) {
    return reject(timeline, `与「${hits[0]!.name ?? hits[0]!.id}」重叠`);
  }

  if (sameTrack) {
    return ok(
      mapTrack(timeline, targetTrackId, (t) =>
        withClips(t, t.clips.map((c) => (c.id === clipId ? moved : c))),
      ),
    );
  }

  const tracks = timeline.tracks.map((t) => {
    if (t.id === found.track.id) return withClips(t, t.clips.filter((c) => c.id !== clipId));
    if (t.id === targetTrackId) return withClips(t, [...t.clips, moved]);
    return t;
  });
  return ok(replaceTracks(timeline, tracks));
}

// ---------------------------------------------------------------------------
// 裁切
// ---------------------------------------------------------------------------

export type TrimEdge = "in" | "out";

/**
 * 把关键帧偏移整体平移 `delta` 帧。
 *
 * 关键帧的 `frame` 是**相对片段起点**的偏移（PLAN.md 的 D10），所以片段起点
 * 一旦改变指向的内容，就必须跟着改：入点右移 10 帧意味着少用开头 10 帧，
 * 原本挂在"片段第 30 帧"上的动作，现在是这个片段的第 20 帧。不平移的话
 * 整条动画会相对画面内容滑走，而这**不会报错**——只会让用户发现"裁了一下，
 * 字幕的飞入时机就不对了"。
 *
 * 只有两处会改变"片段起点对应哪一刻内容"：**裁入点**和**切分出来的右半段**。
 * 在时间轴上平移片段不需要动它——那正是当初选相对偏移的理由。
 *
 * 平移后落到 `[0, 时长)` 之外的关键帧**保留不删**：`valueAt` 在区间外取端点值，
 * 语义仍然正确，而且用户把入点拖回去时动画能原样回来。删掉则不可逆。
 */
function shiftKeyframes(channels: KeyframeChannels, delta: number): KeyframeChannels {
  if (delta === 0) return channels;
  const next: { -readonly [K in AnimatableProperty]?: readonly Keyframe[] } = {};
  for (const property of ANIMATABLE_PROPERTIES) {
    const series = channels[property];
    if (!series) continue;
    next[property] = series.map((k) => ({ ...k, frame: k.frame - delta }));
  }
  return next;
}

/**
 * 拖动片段边缘裁切。
 *
 * 关键约束：入点裁切会同步改 `sourceIn`——把左边缘往右拖 10 帧，
 * 意味着少用源片开头的 10 帧，而不是让画面内容跟着平移。
 * 出点裁切不动 `sourceIn`。
 *
 * 另外裁切不能超过源片可用范围：往左拖不能早于源片第 0 帧，
 * 往右拖不能超过源片总长。M0 的经验是这类越界不会报错，只会让导出时
 * 拉不到帧而静默少帧，所以在编辑层就必须夹住。
 *
 * **文字片段两头都不受源片限制**：画面是现场生成的，想拉多长有多长。
 * 它唯一的下限仍是"至少 1 帧"和不撞邻居。
 */
export function trimClip(
  timeline: Timeline,
  clipId: ClipId,
  edge: TrimEdge,
  deltaFrames: number,
): EditResult {
  if (!Number.isInteger(deltaFrames)) return reject(timeline, "裁切量必须是整数帧");
  if (deltaFrames === 0) return reject(timeline, "裁切量为 0");

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const { clip, track } = found;

  let next: Clip;
  if (edge === "in") {
    const newIn = clip.timelineIn + deltaFrames;
    if (newIn < 0) return reject(timeline, "片段不能延伸到时间轴起点之前");
    // "源片开头"和"至少 1 帧"互斥，所以先后顺序不影响提示语：前者只可能在
    // deltaFrames 为负时触发，那时 newIn 一定还小于 timelineOut
    if (newIn >= clip.timelineOut) return reject(timeline, "片段至少要保留 1 帧");
    if (clip.kind === "media") {
      const newSourceIn = clip.sourceIn + deltaFrames;
      if (newSourceIn < 0) return reject(timeline, "已经到源片开头，没有更多素材");
      next = { ...clip, timelineIn: newIn, sourceIn: newSourceIn };
    } else {
      next = { ...clip, timelineIn: newIn };
    }
    // 起点动了，关键帧偏移要跟着动，否则动画从内容上滑走。出点裁切不需要
    if (clip.keyframes) next = { ...next, keyframes: shiftKeyframes(clip.keyframes, deltaFrames) };
  } else {
    const newOut = clip.timelineOut + deltaFrames;
    if (newOut <= clip.timelineIn) return reject(timeline, "片段至少要保留 1 帧");
    if (clip.kind === "media") {
      const source = timeline.sources.find((s) => s.id === clip.sourceId);
      // 纯音频素材的帧数按项目帧率派生——**这就是裁切必须和 `sourceIn` 同栅格的地方**，
      // 见 `AudioOnlySource` 的文件头
      const sourceLimit = source
        ? sourceDurationFrames(source, timeline.fps)
        : Number.MAX_SAFE_INTEGER;
      const usedSourceFrames = clip.sourceIn + (newOut - clip.timelineIn);
      if (usedSourceFrames > sourceLimit) return reject(timeline, "已经到源片末尾，没有更多素材");
    }
    next = { ...clip, timelineOut: newOut };
  }

  const hits = collisionsIn(track, next);
  if (hits.length > 0) return reject(timeline, `与「${hits[0]!.name ?? hits[0]!.id}」重叠`);

  return ok(
    mapTrack(timeline, track.id, (t) =>
      withClips(t, t.clips.map((c) => (c.id === clipId ? next : c))),
    ),
  );
}

// ---------------------------------------------------------------------------
// 切分 / 删除
// ---------------------------------------------------------------------------

let splitSeq = 0;

/**
 * 在指定帧切分片段（⌘K）。
 *
 * 切点必须严格落在片段内部：正好落在边界上等于什么都没切，
 * 返回 changed=false 而不是产出一个 0 帧的空片段。
 */
export function splitClipAt(timeline: Timeline, clipId: ClipId, frame: number): EditResult {
  if (!Number.isInteger(frame)) return reject(timeline, "切点必须是整数帧");

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const { clip, track } = found;
  if (frame <= clip.timelineIn || frame >= clip.timelineOut) {
    return reject(timeline, "切点不在片段内部");
  }

  const left: Clip = { ...clip, timelineOut: frame };
  const rightId = `${clip.id}-s${++splitSeq}`;
  const cut = frame - clip.timelineIn;
  let right: Clip =
    clip.kind === "media"
      ? {
          ...clip,
          id: rightId,
          timelineIn: frame,
          // 右半段引用源片的起点要跟着推进，否则右半段会重播左半段的内容
          sourceIn: clip.sourceIn + cut,
        }
      // 文字层没有源片游标，两半段显示同一段文字
      : { ...clip, id: rightId, timelineIn: frame };
  // 与裁入点同理：右半段的起点换了内容，关键帧偏移要减掉切掉的那一段。
  // 左半段起点没动，原样保留（超出新长度的关键帧不删，见 shiftKeyframes）
  if (clip.keyframes) right = { ...right, keyframes: shiftKeyframes(clip.keyframes, cut) };
  // **入点转场只跟左半段走。** 不清的话右半段会继承同一个转场，而它的新前驱正是
  // 左半段——于是用户按一下 ⌘K 就凭空多出一个自己没加过的溶解，还刚好在新切点上
  right = setOptional(right, "transitionIn", undefined);

  return ok(
    mapTrack(timeline, track.id, (t) =>
      withClips(t, [...t.clips.filter((c) => c.id !== clipId), left, right]),
    ),
  );
}

export function removeClip(timeline: Timeline, clipId: ClipId): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  return ok(
    mapTrack(timeline, found.track.id, (t) =>
      withClips(t, t.clips.filter((c) => c.id !== clipId)),
    ),
  );
}

/**
 * 删除片段并把右侧片段左移填补空档（波纹删除）。
 *
 * 只影响同一轨道——跨轨道波纹会让其他轨道的对齐关系莫名改变，
 * 那是"我只删了一个片段，为什么音乐也动了"这类投诉的来源。
 */
export function rippleDeleteClip(timeline: Timeline, clipId: ClipId): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const gap = clipDuration(found.clip);
  const cutAt = found.clip.timelineIn;

  return ok(
    mapTrack(timeline, found.track.id, (t) =>
      withClips(
        t,
        t.clips
          .filter((c) => c.id !== clipId)
          .map((c) =>
            c.timelineIn >= cutAt
              ? { ...c, timelineIn: c.timelineIn - gap, timelineOut: c.timelineOut - gap }
              : c,
          ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// 变换 / 调色 / 关键帧 / 文字
// ---------------------------------------------------------------------------

/** 检查器里的属性名。与错误提示共用一套字面量，避免同一个属性有两种叫法。 */
export const PROPERTY_LABELS: Record<AnimatableProperty, string> = {
  x: "位置 X",
  y: "位置 Y",
  scaleX: "缩放 X",
  scaleY: "缩放 Y",
  rotation: "旋转",
  opacity: "不透明度",
  brightness: "亮度",
  contrast: "对比度",
  saturation: "饱和度",
  hue: "色相",
  lutIntensity: "LUT 强度",
  volume: "音量",
};

export interface PropertyRange {
  /** 缺省值。等于它的属性会被归一化掉——见 `normalizeGroup`。 */
  readonly fallback: number;
  readonly min: number;
  readonly max: number;
}

/**
 * 每个属性的缺省值与取值范围。**摆位和调色共用这一张表。**
 *
 * 和 `PROPERTY_LABELS` 一样按 `Record<AnimatableProperty, …>` 声明：将来往
 * `ANIMATABLE_PROPERTIES` 里加一个属性，这两处会**编译不过**，而不是静默漏配。
 * （加调色四项时它确实当场报了这两处，这是这个声明方式唯一的用处。）
 *
 * 检查器的输入框也从这里取上下限和缺省值——夹紧规则写两份，就会出现
 * "界面拦不住但纯函数拦得住"的诡异反馈（滑块能拖到底，松手却弹回来）。
 */
export const PROPERTY_RANGES: Record<AnimatableProperty, PropertyRange> = {
  // 位移单位是输出画布像素，允许移出画面外（飞入飞出要用），只挡住离谱的值
  x: { fallback: 0, min: -100_000, max: 100_000 },
  y: { fallback: 0, min: -100_000, max: 100_000 },
  // 缩放下限取 0 而不是某个小正数：0 → 1 的"弹出"是最常见的关键帧动画之一，
  // 卡在 0.01 会让动画起点留一个看得见的小方块。负数（翻转）暂不支持——
  // 两个后端对负尺寸的处理没验过，要开得先在 Pixi spike 里加用例
  scaleX: { fallback: 1, min: 0, max: 20 },
  scaleY: { fallback: 1, min: 0, max: 20 },
  // 弧度（合成层的单位，见 D9）。±100 圈足够任何"转起来"，也挡住手滑输入
  rotation: { fallback: 0, min: -200 * Math.PI, max: 200 * Math.PI },
  opacity: { fallback: 1, min: 0, max: 1 },

  // 调色三项都是**倍数、1 = 不变**（对齐 CSS filter，见 compose/color.ts）。
  // 上限取 4：再往上画面已经全部溢出到纯色，滑块的后半段等于没用
  brightness: { fallback: 1, min: 0, max: 4 },
  contrast: { fallback: 1, min: 0, max: 4 },
  saturation: { fallback: 1, min: 0, max: 4 },
  // 色相是**弧度**（合成层单位，度数换算在 UI 层）。±1 圈就够——色相是循环量，
  // 转 3 圈和转 1 圈画面完全相同，放宽只会让关键帧插值走冤枉路
  hue: { fallback: 0, min: -2 * Math.PI, max: 2 * Math.PI },
  // LUT 强度：0 = 不套，1 = 完全套用。上限就是 1——外插一张查找表没有意义，
  // 那不是"更强的看"，只是把颜色推出色域
  lutIntensity: { fallback: 1, min: 0, max: 1 },

  // 音量倍数，1 = 原样、0 = 静音。上限 2（约 +6dB）：再往上几乎必然削波，而
  // Web Audio 到编码器那一步是**硬截断、不抛错**，用户听到的只是"声音变糊了"
  volume: { fallback: 1, min: 0, max: 2 },
};

/**
 * 片段音量的范围。`PROPERTY_RANGES.volume` 的别名，留着是为了**调用点读起来是
 * "音量的范围"而不是"从一张大表里按名字取"**——检查器和编辑入口都只关心这一项。
 */
export const VOLUME_RANGE: PropertyRange = PROPERTY_RANGES.volume;

/** 变换补丁：给数值就设，显式给 `undefined` 就**删掉**这个属性（回到缺省）。 */
export type TransformPatch = {
  readonly [K in TransformProperty]?: number | undefined;
};

/** 调色补丁。语义同 `TransformPatch`。 */
export type ColorPatch = {
  readonly [K in ColorProperty]?: number | undefined;
};

function clampProperty(property: AnimatableProperty, value: number): number {
  const range = PROPERTY_RANGES[property];
  return Math.min(range.max, Math.max(range.min, value));
}

/**
 * 丢掉所有等于缺省值的属性；全都是缺省则返回 `undefined`（= 这项能力没被用过）。
 *
 * 这样"调上去又调回来"的片段会回到**真的没有那个字段**的状态，
 * 而不是留一个 `{ x: 0 }` / `{ brightness: 1 }`。合成器的恒等判定看的是值不是字段，
 * 所以这不是正确性问题；但它让"这个片段动过变换/调过色没有"在数据层一眼可判，
 * UI 的重置按钮和"没用这项能力的输出逐像素不变"也就有了同一个依据。
 *
 * 摆位和调色共用这一段：两组的归一化规则一模一样，各写一遍必然在
 * "什么时候该整个删掉字段"上分叉，而那正是上面这条可判性的唯一支点。
 */
function normalizeGroup<K extends AnimatableProperty, T>(
  properties: readonly K[],
  values: { readonly [P in K]?: number },
): T | undefined {
  const next: Record<string, number> = {};
  let any = false;
  for (const property of properties) {
    const value = values[property];
    if (value === undefined || value === PROPERTY_RANGES[property].fallback) continue;
    next[property] = value;
    any = true;
  }
  return any ? (next as T) : undefined;
}

function sameGroup<K extends AnimatableProperty>(
  properties: readonly K[],
  a: { readonly [P in K]?: number } | undefined,
  b: { readonly [P in K]?: number } | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return properties.every((property) => a[property] === b[property]);
}

type PatchResult<T> =
  | { readonly ok: true; readonly value: T | undefined }
  | { readonly ok: false; readonly reason: string };

/** 校验 + 夹紧 + 归一化。返回错误文案或合并后的那一组值。 */
function applyGroupPatch<K extends AnimatableProperty, T>(
  properties: readonly K[],
  base: { readonly [P in K]?: number } | undefined,
  patch: { readonly [P in K]?: number | undefined },
): PatchResult<T> {
  const merged: Record<string, number> = { ...base };
  for (const property of properties) {
    if (!(property in patch)) continue;
    const raw = patch[property];
    if (raw === undefined) {
      delete merged[property];
      continue;
    }
    // NaN 会一路传到 drawImage / 色彩矩阵，画面整层消失或整层变黑，且不报错
    if (!Number.isFinite(raw)) return { ok: false, reason: `${PROPERTY_LABELS[property]}必须是有限数` };
    merged[property] = clampProperty(property, raw);
  }
  return { ok: true, value: normalizeGroup<K, T>(properties, merged as { [P in K]?: number }) };
}

const applyTransformPatch = (
  base: LayerTransform | undefined,
  patch: TransformPatch,
): PatchResult<LayerTransform> => applyGroupPatch(TRANSFORM_PROPERTIES, base, patch);

const applyColorPatch = (
  base: ColorAdjust | undefined,
  patch: ColorPatch,
): PatchResult<ColorAdjust> => applyGroupPatch(COLOR_PROPERTIES, base, patch);

/**
 * 这个属性作用到调色还是摆位。
 *
 * 判据是 `COLOR_PROPERTIES` 这份名单本身，不是"名字里有没有 color"之类的约定——
 * 名单是求值时的同一份（`resolveColor` 也用它），所以加一个调色属性只需要改
 * 一处，不会出现"求值当它是颜色、编辑当它是摆位"。
 */
export function isColorProperty(property: AnimatableProperty): property is ColorProperty {
  return (COLOR_PROPERTIES as readonly AnimatableProperty[]).includes(property);
}

/** 这个属性作用到声音。判据同上，是 `AUDIO_PROPERTIES` 那份名单本身。 */
export function isAudioProperty(property: AnimatableProperty): property is AudioProperty {
  return (AUDIO_PROPERTIES as readonly AnimatableProperty[]).includes(property);
}

/**
 * 这个属性的**静态值**（没有关键帧时生效的那个），取不到就返回 `undefined`。
 *
 * 三组的静态值存在三个地方：`clip.transform` / `clip.color` 是对象，`clip.volume`
 * 是标量。**这个"存在哪儿"的判断只能有一处**——检查器要显示它、`clearKeyframes`
 * 要往回烘、将来的曲线编辑器也要读它，三处各写一遍 `isColorProperty ? … : …`
 * 就一定会在加第三组时漏掉一处，而漏掉的表现是"关掉动画之后这个属性的值丢了"
 * 或者"输入框显示缺省值而画面/声音不是"。都不报错。
 */
export function staticValueOf(clip: Clip, property: AnimatableProperty): number | undefined {
  if (isAudioProperty(property)) return clip.kind === "media" ? clip.volume : undefined;
  const group = isColorProperty(property) ? clip.color : clip.transform;
  return (group as Record<string, number | undefined> | undefined)?.[property];
}

/**
 * 改片段的**静态**变换。
 *
 * 与关键帧并存：某属性有关键帧时，渲染以关键帧为准（`resolveTransform`），
 * 这里改的是"关掉动画之后的那个值"。要改动画上的值请用 `setKeyframe`。
 */
export function setClipTransform(
  timeline: Timeline,
  clipId: ClipId,
  patch: TransformPatch,
): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const result = applyTransformPatch(found.clip.transform, patch);
  if (!result.ok) return reject(timeline, result.reason);
  if (sameGroup(TRANSFORM_PROPERTIES, result.value, found.clip.transform)) {
    return unchanged(timeline);
  }

  return ok(
    replaceClip(timeline, found.track.id, setOptional(found.clip, "transform", result.value)),
  );
}

/**
 * 把一张解析好的 LUT 加进项目。同名同尺寸也不去重——两张看起来一样的表可能
 * 内容不同，靠名字去重会让用户"换了一张但没生效"。
 */
export function addLut(timeline: Timeline, lut: LutSource): EditResult {
  if (timeline.luts?.some((l) => l.id === lut.id)) return unchanged(timeline);
  return ok({ ...timeline, luts: [...(timeline.luts ?? []), lut] });
}

/**
 * 把一个**已经在本上下文注册好**的字体加进项目。
 *
 * 顺序是纪律不是习惯：注册在前、进 EDL 在后。反过来的话中间那一瞬 EDL 里有一个
 * 本上下文用不了的族名，而预览随时可能在那一瞬渲染——`rasterizeText` 会抛。
 * 完整理由见 `compose/font-registry.ts` 文件头。
 */
export function addFont(timeline: Timeline, font: FontSource): EditResult {
  if (timeline.fonts?.some((f) => f.family === font.family)) return unchanged(timeline);
  return ok({ ...timeline, fonts: [...(timeline.fonts ?? []), font] });
}

/**
 * 给片段挂上（或摘掉）一张 LUT。`lutId` 传 `undefined` 表示摘掉。
 *
 * 摘掉时**不动 `color.lutIntensity`**：用户常常是"先摘下来看看原片、再挂回去"，
 * 顺手把强度重置成 1 会让挂回去时和摘掉之前不一样。强度是没挂 LUT 时的死值，
 * 留着不会影响画面（`applyEffects` 只在有 LUT 时才看它）。
 */
export function setClipLut(timeline: Timeline, clipId: ClipId, lutId?: LutId): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  if (lutId !== undefined && !timeline.luts?.some((l) => l.id === lutId)) {
    return reject(timeline, `项目里没有这张 LUT：${lutId}`);
  }
  if (found.clip.lutId === lutId) return unchanged(timeline);
  return ok(replaceClip(timeline, found.track.id, setOptional(found.clip, "lutId", lutId)));
}

// ---------------------------------------------------------------------------
// 转场
// ---------------------------------------------------------------------------

/** 一个交界当前的可编辑状态，给检查器用。 */
export interface JunctionInfo {
  /** 前驱片段；没有紧邻前驱时为 null，此时不能加转场。 */
  readonly previous: Clip | null;
  readonly transition: Transition | null;
  /** 按当前时长解算出的实际窗口长度（帧）；解不出来是 0。 */
  readonly effectiveFrames: number;
  /**
   * 出场侧、入场侧各有多少帧读不到真实素材。
   *
   * 后果按轨道分岔：画面轨上定格边缘帧，音频轨上静音。见 `junctionInfo`。
   */
  readonly shortfall: { readonly from: number; readonly to: number };
}

/**
 * 给片段的入点加上（或改掉、或摘掉）转场。`transition` 传 `undefined` 表示摘掉。
 *
 * 拒绝的两种情况都是**结构性**的、改时长也救不回来：没有紧邻前驱（时间轴开头，
 * 或前面是空档），以及种类和轨道对不上（画面转场混像素，音频轨上没有像素——
 * 静默按交叉淡化渲染是硬规则 10 那种"选了 A 拿到 B"，见 `audio/crossfade.ts`）。
 *
 * **不因为"素材余量不足"而拒绝**：最常见的用法恰恰是两段满长素材相邻，那时
 * 两侧一帧余量都没有。那种情况画面定格、声音静音，并把帧数报到界面上，理由见
 * `edl/transition.ts` 的文件头。
 */
export function setTransition(
  timeline: Timeline,
  clipId: ClipId,
  transition?: Transition,
): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  if (transition !== undefined) {
    if (!transitionFitsTrack(transition.kind, found.track.kind)) {
      return reject(
        timeline,
        found.track.kind === "audio"
          ? "音频轨上只能加声音转场（交叉淡化）"
          : "画面轨上只能加画面转场",
      );
    }
    if (!previousClip(found.track, found.clip)) {
      return reject(timeline, "这个片段前面没有紧邻的片段，无法添加转场");
    }
    if (!Number.isInteger(transition.frames)) return reject(timeline, "转场时长必须是整数帧");
    if (
      transition.frames < MIN_TRANSITION_FRAMES ||
      transition.frames > MAX_TRANSITION_FRAMES
    ) {
      return reject(
        timeline,
        `转场时长要在 ${MIN_TRANSITION_FRAMES}–${MAX_TRANSITION_FRAMES} 帧之间`,
      );
    }
  }

  const current = found.clip.transitionIn;
  if (
    current?.kind === transition?.kind &&
    current?.frames === transition?.frames
  ) {
    return unchanged(timeline);
  }

  return ok(
    replaceClip(timeline, found.track.id, setOptional(found.clip, "transitionIn", transition)),
  );
}

/** 紧邻在这个片段之前的片段；中间有空档或它是第一个时返回 null。 */
export function previousClip(track: Track, clip: Clip): Clip | null {
  return track.clips.find((c) => c.id !== clip.id && c.timelineOut === clip.timelineIn) ?? null;
}

/**
 * 交界的完整状态。界面拿它决定"能不能加""实际多长""要不要提示余量不足"。
 *
 * 短缺帧数在这里算而不是在界面上算：它要用 `transitionWindow` 解出来的**实际**
 * 窗口，而实际窗口会被两侧片段各自的一半夹住——界面按用户输入的时长去推，
 * 提示的数字就会和画面对不上，那比不提示更坏。
 *
 * `shortfall` 的**后果按轨道种类分岔**：画面轨上是定格边缘帧，音频轨上是静音
 * （按住最后一个采样点会得到直流台阶，松开是"啪"的一声，比静音坏得多，见
 * `audio/mix-plan.ts`）。数字是同一个，措辞由界面按 `track.kind` 决定——
 * 在这里就分成两个字段的话，两条分支里总有一条永远是 0，读的人要先想清楚
 * 自己在看哪一条。音频轨上这个数是**近似**：它按视频轨时长算（硬规则 8），
 * 而音轨长度可能差几帧。作为"要不要往里裁一点"的提示足够了。
 */
export function junctionInfo(timeline: Timeline, clipId: ClipId): JunctionInfo | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  const previous = previousClip(found.track, found.clip);
  const transition = found.clip.transitionIn ?? null;
  const empty = { previous, transition, effectiveFrames: 0, shortfall: { from: 0, to: 0 } };
  if (!previous || !transition) return empty;

  const window = transitionWindow(previous, found.clip, transition);
  if (!window) return empty;
  return {
    previous,
    transition,
    effectiveFrames: window.frames,
    shortfall: {
      from: frozenFrames(window, "from", sourceFramesOf(timeline, previous)),
      to: frozenFrames(window, "to", sourceFramesOf(timeline, found.clip)),
    },
  };
}

/** 片段引用的源片有多少帧。文字片段没有源片，返回 0（它永远不会定格）。 */
function sourceFramesOf(timeline: Timeline, clip: Clip): number {
  if (clip.kind !== "media") return 0;
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  return source ? sourceDurationFrames(source, timeline.fps) : 0;
}

/** 转场种类的显示名。加新种类时这里会因为 Record 缺项而编译报错。 */
export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: "交叉溶解",
  wipe: "线性擦除",
  iris: "圆形张开",
  slide: "推移",
  glitch: "故障",
  // 「交叉淡化」这四个字由分组标题和添加按钮给足了上下文，下拉里只留区分点——
  // 写全名是 9 个字，实测把 112px 的下拉撑到 124px 并截断（画面那组都是 4 个字）
  "xfade-power": "等功率淡化",
  "xfade-linear": "等增益淡化",
};

/**
 * 界面上按轨道种类给不同的一组，顺序即列表顺序。
 *
 * 画面组里溶解在最前——它是唯一不需要 GPU 的。声音组里等功率在最前，它对
 * "两段不同的声音"是对的，而那是绝大多数剪辑点（见 `audio/crossfade.ts`）。
 */
export const TRANSITION_ORDER: Record<TrackKind, readonly TransitionKind[]> = {
  video: ["dissolve", "wipe", "iris", "slide", "glitch"],
  audio: ["xfade-power", "xfade-linear"],
};

/** 新建转场时给哪一种。和 `TRANSITION_ORDER` 的第一项一致。 */
export const DEFAULT_TRANSITION_KIND: Record<TrackKind, TransitionKind> = {
  video: "dissolve",
  audio: "xfade-power",
};

/**
 * 改片段的**静态**调色。与 `setClipTransform` 完全同构，见其注释。
 *
 * 文字片段也能调色——栅格化出来的文字层在合成器眼里就是一张普通图片，
 * 给它加饱和度/色相和给视频加是同一条路径。刻意不在这里禁掉。
 */
export function setClipColor(timeline: Timeline, clipId: ClipId, patch: ColorPatch): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const result = applyColorPatch(found.clip.color, patch);
  if (!result.ok) return reject(timeline, result.reason);
  if (sameGroup(COLOR_PROPERTIES, result.value, found.clip.color)) return unchanged(timeline);

  return ok(replaceClip(timeline, found.track.id, setOptional(found.clip, "color", result.value)));
}

/**
 * 改片段音量。只有素材片段有音量，文字片段拒掉而不是静默忽略。
 *
 * 不走 `applyGroupPatch` 那一套：那是给"一组属性 + 关键帧通道"设计的，音量目前
 * 是单个静态值，套进去要先造一个只有一项的组。做包络时会反过来——那时它就该
 * 并进那一套里。
 *
 * **回到缺省值 1 时把字段整个删掉**（同 `normalizeGroup`）：合成器判的是值不是
 * 字段，所以这不是正确性问题；但"这个片段调过音量没有"要能在数据层一眼看出来，
 * 而混音那边的恒等快路径也正是照着这个值判的。
 */
export function setClipVolume(timeline: Timeline, clipId: ClipId, volume: number): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  if (found.clip.kind !== "media") return reject(timeline, "只有素材片段有音量");
  // NaN 会一路传到 GainNode，那一段整个静音且不报错
  if (!Number.isFinite(volume)) return reject(timeline, "音量必须是有限数");

  const clamped = Math.min(VOLUME_RANGE.max, Math.max(VOLUME_RANGE.min, volume));
  // 滑块拖到边界后会持续发同一个值——那是"值没变"，不是失败（见 EditResult 那条约定）
  if ((found.clip.volume ?? VOLUME_RANGE.fallback) === clamped) return unchanged(timeline);

  const next = clamped === VOLUME_RANGE.fallback ? undefined : clamped;
  return ok(replaceClip(timeline, found.track.id, setOptional(found.clip, "volume", next)));
}

/** 把某个属性的关键帧序列换成新的；空序列会连通道一起删掉。 */
function withChannel(
  clip: Clip,
  property: AnimatableProperty,
  series: readonly Keyframe[],
): Clip {
  const channels: { -readonly [K in AnimatableProperty]?: readonly Keyframe[] } = {
    ...clip.keyframes,
  };
  if (series.length === 0) delete channels[property];
  else channels[property] = series;

  const empty = ANIMATABLE_PROPERTIES.every((p) => channels[p] === undefined);
  // 最后一条关键帧被删掉时要把 keyframes 字段整个去掉，而不是留个 `{}`：
  // `resolveTransform` 只在 `!channels` 时才原样返回 base，留空对象会走进
  // 遍历分支——结果虽然一样，但"这个片段有没有动画"就不能靠字段判断了
  return setOptional(clip, "keyframes", empty ? undefined : channels);
}

/**
 * 在片段的第 `offset` 帧打一个关键帧（已有则改值）。
 *
 * `offset` 是**片段内偏移**，不是时间轴帧号——调用方要减掉 `timelineIn`。
 * 插入时维持"按 frame 升序"，那是 `valueAt` 的前提（见 keyframes.ts 文件头）。
 *
 * @param easing 省略表示沿用已有关键帧的缓动（新建则为默认线性）
 */
export function setKeyframe(
  timeline: Timeline,
  clipId: ClipId,
  property: AnimatableProperty,
  offset: number,
  value: number,
  easing?: Easing,
): EditResult {
  if (!Number.isInteger(offset)) return reject(timeline, "关键帧位置必须是整数帧");
  if (!Number.isFinite(value)) return reject(timeline, `${PROPERTY_LABELS[property]}必须是有限数`);

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  // 关键帧通道挂在 `ClipBase` 上（三组共用一张表，见 keyframes.ts），所以类型上
  // 拦不住"给文字或图片片段打一条音量曲线"。那条曲线永远不会被求值——它们没有音轨
  if (isAudioProperty(property) && found.clip.kind !== "media") {
    return reject(timeline, "只有素材片段有音量");
  }

  const clamped = clampProperty(property, value);
  const series = found.clip.keyframes?.[property] ?? [];
  const existing = series.find((k) => k.frame === offset);
  if (existing && existing.value === clamped && (easing === undefined || existing.easing === easing)) {
    return unchanged(timeline);
  }

  const kept = easing ?? existing?.easing;
  const next: Keyframe = { frame: offset, value: clamped, ...(kept ? { easing: kept } : {}) };
  const merged = [...series.filter((k) => k.frame !== offset), next].sort((a, b) => a.frame - b.frame);

  return ok(replaceClip(timeline, found.track.id, withChannel(found.clip, property, merged)));
}

export function removeKeyframe(
  timeline: Timeline,
  clipId: ClipId,
  property: AnimatableProperty,
  offset: number,
): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const series = found.clip.keyframes?.[property];
  if (!series?.some((k) => k.frame === offset)) return reject(timeline, "这一帧上没有关键帧");

  const kept = series.filter((k) => k.frame !== offset);
  return ok(replaceClip(timeline, found.track.id, withChannel(found.clip, property, kept)));
}

/**
 * 把一个关键帧从 `fromOffset` 挪到 `toOffset`（值和缓动都跟着走）。
 *
 * 这是 D10 留下的那笔债：在此之前"改关键帧的时间"只能删了重打，而那是两步撤销、
 * 中间还有一瞬间动画少一个点。缓动跟着走是对的——它归**左端**关键帧所有、管的是
 * 它右边那一段（见 keyframes.ts），所以它是这个关键帧自己的属性，不是位置的属性。
 *
 * **目标位置已经有关键帧时拒绝，不覆盖。** 覆盖会静默吃掉一个用户自己打的点，
 * 是硬规则 10 那类"选了 A 拿到 B"；拒绝则由界面把落点画成非法、并把原因报到状态栏。
 *
 * 偏移**允许落在片段之外**（同 `setKeyframe`）：D10 定的语义是片段外的关键帧保留
 * 不删、裁回去还能用。夹回片段范围是界面的事，不是这一层的事。
 */
export function moveKeyframe(
  timeline: Timeline,
  clipId: ClipId,
  property: AnimatableProperty,
  fromOffset: number,
  toOffset: number,
): EditResult {
  if (!Number.isInteger(toOffset)) return reject(timeline, "关键帧位置必须是整数帧");

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");

  const series = found.clip.keyframes?.[property] ?? [];
  const moving = series.find((k) => k.frame === fromOffset);
  if (!moving) return reject(timeline, "这一帧上没有关键帧");
  // 没挪动不是失败，所以不给 reason——拖到边界后会一直发同一个值
  if (fromOffset === toOffset) return unchanged(timeline);
  if (series.some((k) => k.frame === toOffset)) {
    return reject(timeline, `第 ${toOffset} 帧已经有一个关键帧了`);
  }

  const merged = [...series.filter((k) => k.frame !== fromOffset), { ...moving, frame: toOffset }].sort(
    (a, b) => a.frame - b.frame,
  );
  return ok(replaceClip(timeline, found.track.id, withChannel(found.clip, property, merged)));
}

/**
 * 关掉某个属性的动画：删光它的关键帧。
 *
 * `bakeValue` 是"关掉动画时停在哪个值"——不传的话属性会跳回静态变换里那个
 * 可能很久以前的旧值，用户看到的是画面突然弹走。UI 传的是播放头当前的求值结果，
 * 于是"关掉动画"只是停住，不移动。两件事合成一步撤销，因为它们是一次操作。
 */
export function clearKeyframes(
  timeline: Timeline,
  clipId: ClipId,
  property: AnimatableProperty,
  bakeValue?: number,
): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  if (!found.clip.keyframes?.[property]) return reject(timeline, "这个属性没有关键帧");

  let next = withChannel(found.clip, property, []);
  if (bakeValue !== undefined) {
    // 烘到哪一组由属性自己决定。写死成 transform 的话，关掉「亮度」的动画会把
    // `brightness` 塞进 LayerTransform——合成器不认识那个字段，也不会报错，
    // 表现是"关掉动画之后调色整个丢了"
    if (isAudioProperty(property)) {
      // 音量的静态值是片段上的标量，没有"一组"可以归一化，所以自己夹紧 + 判缺省
      if (next.kind !== "media") return reject(timeline, "只有素材片段有音量");
      const clamped = clampProperty(property, bakeValue);
      const keep = clamped === PROPERTY_RANGES[property].fallback ? undefined : clamped;
      next = setOptional(next, property, keep);
    } else if (isColorProperty(property)) {
      const baked = applyColorPatch(next.color, { [property]: bakeValue });
      if (!baked.ok) return reject(timeline, baked.reason);
      next = setOptional(next, "color", baked.value);
    } else {
      const baked = applyTransformPatch(next.transform, { [property]: bakeValue });
      if (!baked.ok) return reject(timeline, baked.reason);
      next = setOptional(next, "transform", baked.value);
    }
  }
  return ok(replaceClip(timeline, found.track.id, next));
}

// ---- 文字 ----

/** 文字样式补丁：显式给 `undefined` 表示恢复该项的默认值。 */
export type TextStylePatch = {
  readonly [K in keyof TextStyle]?: TextStyle[K] | undefined;
};

/**
 * 样式里的颜色项。**值要当场校验**：`ctx.shadowColor = "乱码"` 不抛错，赋值被整个
 * 忽略、保持上一个值——新建的上下文里那是透明黑，表现是"颜色调了没反应"。
 * 认得出的写法见 `compose/css-color.ts` 文件头。
 */
const STYLE_COLORS = ["color", "strokeColor", "shadowColor"] as const;

/** 样式里数值项的取值范围。字符串项（字体族、对齐）不夹。 */
const STYLE_RANGES: Record<string, { readonly min: number; readonly max: number }> = {
  fontSizeRatio: { min: 0.01, max: 1 },
  fontWeight: { min: 100, max: 900 },
  strokeRatio: { min: 0, max: 0.05 },
  shadowRatio: { min: 0, max: 0.1 },
  lineHeight: { min: 0.5, max: 3 },
  maxWidthRatio: { min: 0.05, max: 1 },
};

function requireText(
  timeline: Timeline,
  clipId: ClipId,
): { readonly track: Track; readonly clip: TextClip } | EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  if (found.clip.kind !== "text") return reject(timeline, "这不是文字片段");
  return { track: found.track, clip: found.clip };
}

function isEditResult(v: { readonly clip: TextClip } | EditResult): v is EditResult {
  return "changed" in v;
}

export function setTextContent(timeline: Timeline, clipId: ClipId, text: string): EditResult {
  const found = requireText(timeline, clipId);
  if (isEditResult(found)) return found;
  if (found.clip.text === text) return unchanged(timeline);
  return ok(replaceClip(timeline, found.track.id, { ...found.clip, text }));
}

export function setTextStyle(
  timeline: Timeline,
  clipId: ClipId,
  patch: TextStylePatch,
): EditResult {
  const found = requireText(timeline, clipId);
  if (isEditResult(found)) return found;

  // 引用一个不在项目里的自定义字体要**当场拒掉**，同 `setClipLut`。放过去的话
  // 渲染时 `rasterizeText` 会抛（那道断言是刻意的），而用户看到的是预览整个崩
  if (
    patch.fontFamily !== undefined &&
    isManagedFamily(patch.fontFamily) &&
    !findFont(timeline, patch.fontFamily)
  ) {
    return reject(timeline, `项目里没有这个字体：${patch.fontFamily}`);
  }

  const merged: Record<string, unknown> = { ...found.clip.style };
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) {
      delete merged[key];
      continue;
    }
    if (typeof raw === "string" && (STYLE_COLORS as readonly string[]).includes(key)) {
      if (!isCssColor(raw)) return reject(timeline, `认不出这个颜色：${raw}`);
    }
    if (typeof raw === "number") {
      if (!Number.isFinite(raw)) return reject(timeline, `样式项 ${key} 必须是有限数`);
      const range = STYLE_RANGES[key];
      merged[key] = range ? Math.min(range.max, Math.max(range.min, raw)) : raw;
    } else {
      merged[key] = raw;
    }
  }

  // 样式全被清空时把 style 字段整个去掉，和变换归一化同一个理由：
  // "这个片段改过样式没有"要能在数据层直接看出来
  const style = Object.keys(merged).length > 0 ? (merged as TextStyle) : undefined;
  const before = JSON.stringify(found.clip.style ?? null);
  if (before === JSON.stringify(style ?? null)) return unchanged(timeline);

  return ok(replaceClip(timeline, found.track.id, setOptional(found.clip, "style", style)));
}

let textSeq = 0;

export interface AddTextOptions {
  readonly timelineIn: number;
  readonly durationFrames: number;
  readonly text: string;
  /** 不传则自上而下挑第一条放得下的画面轨（T1 在最上，正是「字幕 / 标题」轨）。 */
  readonly trackId?: TrackId;
}

/** 新建片段要把 id 交回给调用方，UI 才能选中它。 */
export interface AddClipResult extends EditResult {
  readonly clipId?: ClipId;
}

/**
 * 新建一个文字片段。
 *
 * 文字只能落在**画面轨**——音频轨上的文字层没有任何含义，而 `moveClip` 的
 * 同类轨检查也会立刻把它锁死在那儿，等于造一个搬不走的片段。
 */
export function addTextClip(timeline: Timeline, options: AddTextOptions): AddClipResult {
  const { timelineIn, durationFrames, text } = options;
  if (!Number.isInteger(timelineIn) || timelineIn < 0) {
    return reject(timeline, "起点必须是非负整数帧");
  }
  if (!Number.isInteger(durationFrames) || durationFrames < 1) {
    return reject(timeline, "文字片段至少要有 1 帧");
  }

  const clipId = `text-${++textSeq}`;
  const clip: TextClip = {
    id: clipId,
    kind: "text",
    text,
    timelineIn,
    timelineOut: timelineIn + durationFrames,
  };

  const candidates = options.trackId
    ? timeline.tracks.filter((t) => t.id === options.trackId)
    : timeline.tracks.filter((t) => t.kind === "video");
  if (candidates.length === 0) {
    return reject(timeline, options.trackId ? `找不到轨道 ${options.trackId}` : "没有画面轨");
  }

  let lastReason = "";
  for (const track of candidates) {
    if (track.kind !== "video") {
      lastReason = "文字片段只能放在画面轨";
      continue;
    }
    if (track.locked) {
      lastReason = `${track.label ?? track.id} 已锁定`;
      continue;
    }
    const hits = collisionsIn(track, clip);
    if (hits.length > 0) {
      lastReason = `与「${hits[0]!.name ?? hits[0]!.id}」重叠`;
      continue;
    }
    return {
      ...ok(mapTrack(timeline, track.id, (t) => withClips(t, [...t.clips, clip]))),
      clipId,
    };
  }
  return reject(timeline, options.trackId ? lastReason : `所有画面轨在这个位置都放不下：${lastReason}`);
}

// ---------------------------------------------------------------------------
// 导入素材
// ---------------------------------------------------------------------------

/**
 * 图片片段的缺省时长（秒）。
 *
 * 一张图在时间轴上想占多久都行，所以这个数纯粹是"刚拖进来时多长"。5 秒是图片
 * 轮播的常见长度，也足够长到能一眼看见、不至于让用户先去拉一下才看得到。
 */
export const IMAGE_DEFAULT_SECONDS = 5;

export interface AddSourceOptions {
  readonly source: MediaSource;
  /** 片段放在哪一帧起。通常是播放头。 */
  readonly timelineIn: number;
}

export interface AddSourceResult extends EditResult {
  /** 新建出来的片段 id，画面在前。UI 用它选中新片段。 */
  readonly clipIds?: readonly ClipId[];
}

/**
 * 把一个素材加进项目，并在时间轴上放好它的片段。
 *
 * ## 为什么是"追加"而不是"载入"
 *
 * 这个函数取代了原来那个把整条时间轴换掉的 `loadSource`。**配乐这件事本身就要求
 * 追加**：用户必然是先导入画面、再导入音乐，覆盖式载入会让第二次导入把第一次的
 * 编辑全部扔掉（而且是静默扔掉，撤销栈里只留下"导入"这一条）。
 *
 * ## 项目帧率和画布只在时间轴还空着的时候跟着素材走
 *
 * 这不是"能省事就省事"，而是 `AudioOnlySource` 那条派生栅格成立的前提：纯音频
 * 素材的 `sourceIn` 按**项目帧率**解释，一旦项目帧率能在已经有片段之后被改掉，
 * 所有音频片段的入点就会同时被重新解释一遍——表现是配乐整体错位，且不报错。
 * 所以这里的判据是"一个片段都没有"，不是"没有画面素材"。
 *
 * 带音轨的画面素材要**同时**放画面片段和音频片段，两者起点必须相同；任一放不下
 * 就整体拒绝，不允许"画面放下了、声音挪到了别处"——那是音画错位而不是失败。
 */
export function addSource(timeline: Timeline, options: AddSourceOptions): AddSourceResult {
  const { source, timelineIn } = options;
  if (!Number.isInteger(timelineIn) || timelineIn < 0) {
    return reject(timeline, "起点必须是非负整数帧");
  }
  if (timeline.sources.some((s) => s.id === source.id)) {
    return reject(timeline, `素材 ${source.name} 已经在项目里了`);
  }

  const empty = timeline.tracks.every((t) => t.clips.length === 0);
  let conformed: Timeline =
    empty && source.kind === "av"
      ? { ...timeline, fps: source.fps, width: source.width, height: source.height }
      : timeline;
  // 自动取名只做一次：`name` 还不存在（= 没自动取过也没重命名过）才用素材名填上。
  // `namedByUser` 在 `name` 已存在时必然挡不上什么，但作为判据显式写出来——
  // "用户重命名过之后不再自动"靠的是标志，不是猜（D37）
  if (conformed.name === undefined && conformed.namedByUser !== true) {
    conformed = { ...conformed, name: source.name };
  }
  /**
   * 片段初始有多长。
   *
   * 视频和音频用素材自己的长度；**图片没有长度**，用一个缺省秒数——它想占多久都行，
   * 而 0 帧或 1 帧的片段用户还得自己拉开。这个数不是"源片长度"，所以刻意不走
   * `sourceDurationFrames`（那个函数对图片返回 `Infinity`，正是裁切要的答案）。
   */
  const lengthFrames =
    source.kind === "image"
      ? Math.max(1, Math.round((IMAGE_DEFAULT_SECONDS * conformed.fps.num) / conformed.fps.den))
      : // 帧数要在**定好项目帧率之后**再算：纯音频素材的帧数是按项目帧率派生的
        sourceDurationFrames(source, conformed.fps);
  const withSource: Timeline = {
    ...conformed,
    sources: [...conformed.sources, source],
  };

  const placing = { timelineIn, timelineOut: timelineIn + lengthFrames, name: source.name };

  /** 画面片段和音频片段共用同一份占位与 `sourceIn`，只是落在不同种类的轨上。 */
  const clipFor = (suffix: string): MediaClip => ({
    id: `${source.id}${suffix}`,
    kind: "media",
    sourceId: source.id,
    ...placing,
    sourceIn: 0,
  });

  const plan: { readonly clip: Clip; readonly kind: TrackKind }[] = [];
  if (source.kind === "av") plan.push({ clip: clipFor("-v"), kind: "video" });
  if (source.kind === "image") {
    // 图片片段**没有 `sourceIn`**，所以不能走 `clipFor`——那是它自己一种片段的
    // 全部理由，见 `ImageClip`
    plan.push({
      clip: { id: `${source.id}-i`, kind: "image", sourceId: source.id, ...placing },
      kind: "video",
    });
  }
  if (source.hasAudio) plan.push({ clip: clipFor("-a"), kind: "audio" });
  if (plan.length === 0) {
    // 探针不会产出这种素材（三条路都要求对应的轨道/格式能用），所以这只是不信任它
    return reject(timeline, `素材 ${source.name} 既没有画面也没有能解的声音`);
  }

  let next = withSource;
  const clipIds: ClipId[] = [];
  for (const { clip, kind } of plan) {
    const placed = placeOnFirstFittingTrack(next, clip, kind);
    if (!placed.changed) return reject(timeline, placed.reason ?? "放不下");
    next = placed.timeline;
    clipIds.push(clip.id);
  }
  return { ...ok(next), clipIds };
}

/**
 * 重命名项目。**这是"用户给名字"的唯一入口**，所以 `namedByUser` 在这里置位——
 * 之后 `addSource` 的自动取名就永远不再发生（D37：改了名字再导入素材，名字不能被改回去）。
 *
 * 空白名拒绝而不是清空：清空会把项目送回"待自动取名"状态，下一次导入素材
 * 名字就悄悄变了，用户看到的是"我删了名字，它自己起了一个"。
 */
export function renameProject(timeline: Timeline, rawName: string): EditResult {
  const name = rawName.trim();
  if (name.length === 0) return reject(timeline, "项目名不能是空白");
  if (timeline.name === name && timeline.namedByUser === true) return unchanged(timeline);
  return ok({ ...timeline, name, namedByUser: true });
}

/**
 * 在指定种类的轨道里挑第一条放得下的，把片段放进去。
 *
 * **画面轨的候选顺序是自下而上**（V1 → V2 → T1），和 `addTextClip` 相反：素材该
 * 落在「主视频」轨上，而文字该落在最上面的「字幕 / 标题」轨上。两者共用一个顺序
 * 的话，导入的第二个视频会跑到字幕轨顶上去。
 */
function placeOnFirstFittingTrack(
  timeline: Timeline,
  clip: Clip,
  kind: TrackKind,
): EditResult {
  const candidates = timeline.tracks.filter((t) => t.kind === kind);
  const ordered = kind === "video" ? [...candidates].reverse() : candidates;
  if (ordered.length === 0) return reject(timeline, kind === "video" ? "没有画面轨" : "没有音频轨");

  let lastReason = "";
  for (const track of ordered) {
    if (track.locked) {
      lastReason = `${track.label ?? track.id} 已锁定`;
      continue;
    }
    const hits = collisionsIn(track, clip);
    if (hits.length > 0) {
      lastReason = `与「${hits[0]!.name ?? hits[0]!.id}」重叠`;
      continue;
    }
    return ok(mapTrack(timeline, track.id, (t) => withClips(t, [...t.clips, clip])));
  }
  const what = kind === "video" ? "画面轨" : "音频轨";
  return reject(timeline, `所有${what}在这个位置都放不下：${lastReason}`);
}

// ---------------------------------------------------------------------------
// 磁吸
// ---------------------------------------------------------------------------

/** 磁吸默认阈值（像素换算成帧由调用方决定，这里给帧数上限兜底）。见 PLAN.md 决策 D2。 */
export const SNAP_THRESHOLD_FRAMES = 6;

export interface SnapCandidates {
  /** 播放头位置。 */
  readonly playhead?: number;
  /** 入出点。 */
  readonly inFrame?: number;
  readonly outFrame?: number;
}

/**
 * 收集所有可吸附的帧位置：其他片段的两端、播放头、入出点、时间轴起点。
 *
 * 刻意排除被拖动片段自身的两端——否则它会吸附到自己原来的位置，永远拖不动。
 */
export function snapTargets(
  timeline: Timeline,
  excludeClipId: ClipId | null,
  extra: SnapCandidates = {},
): number[] {
  const targets = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (clip.id === excludeClipId) continue;
      targets.add(clip.timelineIn);
      targets.add(clip.timelineOut);
    }
  }
  if (extra.playhead !== undefined) targets.add(extra.playhead);
  if (extra.inFrame !== undefined) targets.add(extra.inFrame);
  if (extra.outFrame !== undefined) targets.add(extra.outFrame);
  return [...targets].sort((a, b) => a - b);
}

/**
 * 把 frame 吸附到最近的候选位置。
 *
 * 返回吸附后的帧号和是否发生了吸附——UI 需要后者来显示吸附辅助线。
 * 距离相同时优先吸到较小的帧号，保证结果稳定（不会因遍历顺序抖动）。
 */
export function snapFrame(
  frame: number,
  targets: readonly number[],
  threshold = SNAP_THRESHOLD_FRAMES,
): { frame: number; snapped: boolean; target?: number } {
  let best: number | undefined;
  let bestDistance = Infinity;
  for (const target of targets) {
    const distance = Math.abs(target - frame);
    if (distance < bestDistance || (distance === bestDistance && target < (best ?? Infinity))) {
      bestDistance = distance;
      best = target;
    }
  }
  if (best === undefined || bestDistance > threshold) return { frame, snapped: false };
  return { frame: best, snapped: bestDistance !== 0, target: best };
}

/**
 * 拖拽落点的吸附：同时考虑片段的左右两端。
 *
 * 只吸左端会导致"右端明明该和别的片段对齐却差一帧"，
 * 用户看到的缝隙正是这么来的。取两端中吸附距离更小的那个。
 */
export function snapDrag(
  desiredIn: number,
  length: number,
  targets: readonly number[],
  threshold = SNAP_THRESHOLD_FRAMES,
): { frame: number; snapped: boolean } {
  const head = snapFrame(desiredIn, targets, threshold);
  const tail = snapFrame(desiredIn + length, targets, threshold);
  const headDistance = head.target === undefined ? Infinity : Math.abs(head.target - desiredIn);
  const tailDistance =
    tail.target === undefined ? Infinity : Math.abs(tail.target - (desiredIn + length));

  if (headDistance === Infinity && tailDistance === Infinity) {
    return { frame: desiredIn, snapped: false };
  }
  if (tailDistance < headDistance) {
    return { frame: tail.target! - length, snapped: tailDistance !== 0 };
  }
  return { frame: head.target!, snapped: headDistance !== 0 };
}
