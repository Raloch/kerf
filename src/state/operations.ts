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
import type { CropInsets, LayerTransform } from "../compose/compositor";
import { isCssColor } from "../compose/css-color";
import { isManagedFamily } from "../compose/font-registry";
import type { TextStyle } from "../compose/text-raster";
import {
  clipDuration,
  clipSourceFrames,
  clipSourceId,
  clipSpeed,
  findFont,
  isFrozen,
  scaleBySpeed,
  sourceDurationFrames,
  SPEED_RANGE,
  transitionFitsTrack,
  type Clip,
  type ClipId,
  type FontSource,
  type LutId,
  type LutSource,
  type MediaClip,
  type MediaSource,
  type SourceId,
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
import { newClipId } from "../media/source-id";
import { rational, toNumber, type Rational } from "../time/rational";

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
  const durationFrames = computeDuration(tracks);
  return clampMarks({ ...timeline, tracks, durationFrames });
}

/**
 * 把入点 / 出点标记夹回 `[0, durationFrames]`，夹完站不住就整个清掉（**D50**）。
 *
 * **每一次改片段列表都要过**（`replaceTracks` 是唯一出口，所以这里就够了），因为
 * 时间轴会变短：出点标在第 300 帧、把最后一个片段删掉之后总长只有 200，那个标记
 * 就悬在末尾之外。它不会报错——导出照样跑，只是**多渲染 100 帧黑画面**，而 D25 那个
 * 耗时预测和空间预估都按区间算，于是一起算大。
 *
 * "站不住"包括两种：夹完之后区间变成零长（入点被夹到等于出点），以及标记本来就在
 * 末尾之外、夹完两个撞在一起。那时清掉整个标记，因为"入点等于出点"导不出任何东西，
 * 而留着一个导不出东西的标记会让导出面板出现一个选了就报错的选项。
 */
function clampMarks(timeline: Timeline): Timeline {
  const { markIn, markOut, durationFrames } = timeline;
  if (markIn === undefined && markOut === undefined) return timeline;
  const nextIn = markIn === undefined ? undefined : Math.min(markIn, durationFrames);
  const nextOut = markOut === undefined ? undefined : Math.min(markOut, durationFrames);
  // 夹完之后还站得住吗：两个都在时要求严格有序，只有一个时要求它自己留出非零长度
  const valid =
    nextIn !== undefined && nextOut !== undefined
      ? nextIn < nextOut
      : nextIn !== undefined
        ? nextIn < durationFrames
        : nextOut !== undefined && nextOut > 0;
  if (!valid) {
    return setOptional(setOptional(timeline, "markIn", undefined), "markOut", undefined);
  }
  if (nextIn === markIn && nextOut === markOut) return timeline;
  return setOptional(setOptional(timeline, "markIn", nextIn), "markOut", nextOut);
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

/**
 * 音频轨上的 `freeze` 一律清掉。**第二道兜底**，理由和 `dropOrphanTransitions` 里那条
 * "种类和轨道对不上"完全一样（D48）：编辑入口（`freezeClipAt`）已经拦着，而片段不能跨
 * 轨道种类拖，所以这一条实际拦不到东西——它防的是手工快照和将来某个新编辑操作。
 *
 * 值得单独兜是因为**它的失效形态是静音而不是"没效果"**：定格让 `sourceMicrosAt` 恒定，
 * 而 `mix-plan` 用它算源片区间的两端，于是 `srcStart === srcEnd`，那一段整个没声音、
 * 不抛错。同 D19 那条"存了但不生效"里最坏的一档。
 */
function dropFreezeOnAudio(clips: Clip[], kind: TrackKind): Clip[] {
  if (kind !== "audio") return clips;
  return clips.map((clip) =>
    clip.kind === "media" && clip.freeze !== undefined
      ? setOptional(clip, "freeze", undefined)
      : clip,
  );
}

function withClips(track: Track, clips: readonly Clip[]): Track {
  const sorted = dropOrphanTransitions(sortClips(clips), track.kind);
  return { ...track, clips: dropFreezeOnAudio(sorted, track.kind) };
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

/**
 * 去掉重复 id 并保持原顺序。
 *
 * 多选的选中集合是**数组**（不是 Set），所以"里面没有重复"是一条要维护的不变量而不是
 * 类型保证。批量操作全部先过这里：重复一次的表现是"波纹删除同一个片段两次"——第二次
 * 找不到它，于是被算进"没做成的那些"，报出一句用户看不懂的失败。
 */
function uniqueIds(ids: readonly ClipId[]): ClipId[] {
  return [...new Set(ids)];
}

/**
 * 把一组片段**整体**平移同一个位移。
 *
 * 三条和单个片段不同的取舍：
 *
 * - **全体或拒绝。** N 个片段的相对位置就是内容本身，移动成功 3 个、剩下 2 个留在原处，
 *   得到的是一个用户没要的排列（同 `addSource` 那条"不允许画面放下了、声音挪到了别处"）。
 *   判据是"部分成功是不是一个用户没要的新状态"——删除不是（删掉 3 个和删掉 5 个都是
 *   "这些不在了"），移动是。
 * - **不换轨。** 一组片段可以横跨多条轨道，而"目标轨道"是一个值不是一组——把 5 个片段
 *   全塞进同一条轨等于毁掉排列。所以多选拖拽只走水平，要换轨得单选（`moveClip`）。
 * - **夹紧是调整整组的位移，不是把每个片段各自夹到 0。** 后者会把越界的那几个压成一叠
 *   （它们全落在 0），而那正好是"相对位置就是内容"这条被破坏的形态。
 *
 * 只需要检查每个片段与**不在移动集合里**的邻居是否重叠：整组共用一个位移，所以移动中的
 * 片段之间的相对位置不变，原本不重叠的现在也不会重叠。
 */
export function moveClips(
  timeline: Timeline,
  clipIds: readonly ClipId[],
  deltaFrames: number,
  options: { readonly clampToBounds?: boolean } = {},
): EditResult {
  if (!Number.isInteger(deltaFrames)) return reject(timeline, "位移必须是整数帧");
  const ids = uniqueIds(clipIds);
  if (ids.length === 0) return reject(timeline, "没有选中片段");
  // 单个片段走原路径：那条支持换轨，而且"多选"退化成一个时行为必须和从来没多选过一样
  if (ids.length === 1) return moveClip(timeline, ids[0]!, deltaFrames, options);

  const entries: { track: Track; clip: Clip }[] = [];
  for (const id of ids) {
    const found = findClip(timeline, id);
    if (!found) return reject(timeline, `找不到片段 ${id}`);
    if (found.track.locked) return reject(timeline, `${found.track.label ?? found.track.id} 已锁定`);
    entries.push(found);
  }

  let delta = deltaFrames;
  const minIn = Math.min(...entries.map((e) => e.clip.timelineIn));
  if (minIn + delta < 0) {
    if (options.clampToBounds === false) return reject(timeline, "片段不能移到时间轴起点之前");
    delta = -minIn;
  }
  if (delta === 0) return unchanged(timeline);

  const moving = new Set(ids);
  const movedById = new Map<ClipId, Clip>();
  for (const { track, clip } of entries) {
    const length = clipDuration(clip);
    const moved: Clip = {
      ...clip,
      timelineIn: clip.timelineIn + delta,
      timelineOut: clip.timelineIn + delta + length,
    };
    const hit = track.clips.find((c) => !moving.has(c.id) && overlaps(c, moved));
    if (hit) return reject(timeline, `与「${hit.name ?? hit.id}」重叠`);
    movedById.set(clip.id, moved);
  }

  return ok(
    replaceTracks(
      timeline,
      timeline.tracks.map((t) =>
        t.clips.some((c) => moving.has(c.id))
          ? withClips(t, t.clips.map((c) => movedById.get(c.id) ?? c))
          : t,
      ),
    ),
  );
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
    if (clip.kind === "media" && isFrozen(clip)) {
      // **定格片段裁入点不推 `sourceIn`**（D48）：定住的是"那一帧"，而裁左边缘改的是
      // 这一帧要停多久。推了的表现是"把定格片段的头往右拖一下，定住的画面就换了一张"
      // ——而用户的手势是改时长。于是它和文字片段走同一条路（两头都不受源片限制）
      next = { ...clip, timelineIn: newIn };
    } else if (clip.kind === "media") {
      // 变速片段：时间轴上裁掉 Δ 帧，源片要跳过 Δ×speed 帧。取整只在
      // `scaleBySpeed` 一处发生（1.5× 下一帧对不上整数源片帧，量化误差 < 0.5 帧、
      // 看不出来；散着取整两次才会变成"裁一帧、画面动两帧"）
      const newSourceIn = clip.sourceIn + scaleBySpeed(deltaFrames, clipSpeed(clip));
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
      // 变速片段消耗的源片帧数不等于占位帧数（`clipSourceFrames`，原速下逐值相同）。
      // 漏乘的表现是 2× 下能把出点拉到源片之外，而那几帧解不出来 =
      // **那一层画面静默消失**（同 D37 记的那个形态）
      const usedSourceFrames =
        clip.sourceIn + clipSourceFrames({ ...clip, timelineOut: newOut });
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
    clip.kind === "media" && !isFrozen(clip)
      ? {
          ...clip,
          id: rightId,
          timelineIn: frame,
          // 右半段引用源片的起点要跟着推进，否则右半段会重播左半段的内容。
          // 变速片段推进的是 cut×speed（同裁入点）——漏乘的表现是"切一刀，
          // 右半段从中间跳回去了"，而 1× 的项目上完全正常
          sourceIn: clip.sourceIn + scaleBySpeed(cut, clipSpeed(clip)),
        }
      // 文字层没有源片游标，两半段显示同一段文字；**定格片段同理**（D48）——
      // 它整段就是一帧，两半段定的是同一帧，推进 `sourceIn` 会让右半段换一张画面
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

/**
 * 批量结果：**部分成功是合法结果**，而它不能走 `reason`。
 *
 * `apply()` 在 `changed:true` 时**根本不看 `reason`**（那条通道是给失败用的），所以把
 * "5 个里有 1 个没删"写进 `reason` 等于静默丢掉——用户按了删除，看到 4 个消失、
 * 一个还在，而软件一个字都没说。字段单独取名就是为了让调用方漏掉时显眼。
 */
export interface BatchResult extends EditResult {
  /** 做成了几个。0 表示整批失败，那时 `changed` 是 false、原因走 `reason`。 */
  readonly done: number;
  /** 一共要做几个。 */
  readonly total: number;
  /** 没做成的那些是为什么。`done === total` 时不给。 */
  readonly skippedReason?: string;
}

/** `perClip` 的战果。 */
interface PerClipTally {
  readonly timeline: Timeline;
  /** 真的改了几个。 */
  readonly done: number;
  /** 带着原因失败了几个。 */
  readonly skipped: number;
  /** 第一个失败原因。只报第一个——一串重复的"轨道已锁定"没有更多信息。 */
  readonly firstReason?: string;
}

/**
 * 逐个做，失败的记下来。**批量删除和批量改属性共用这条循环**，因为它们的失败语义是
 * 同一类（各自独立，见 `removeClips`）。
 *
 * 分三类而不是两类，第三类是这里唯一容易写错的地方：`changed:false` 且**不给 `reason`**
 * 的那个结果是"值没变"（见 `EditResult.reason`），它既不是成功也不是失败。把它算进
 * `skipped` 的话，"给 5 个片段设 50% 而其中 2 个本来就是 50%"会报成"5 个里有 2 个没改"
 * ——那是句假话，而且它只在"部分片段的值本来就对"时出现，最容易漏测。
 */
function perClip(
  timeline: Timeline,
  ids: readonly ClipId[],
  step: (working: Timeline, id: ClipId) => EditResult,
): PerClipTally {
  let working = timeline;
  let done = 0;
  let skipped = 0;
  let firstReason: string | undefined;
  for (const id of ids) {
    const result = step(working, id);
    if (result.changed) {
      working = result.timeline;
      done += 1;
    } else if (result.reason !== undefined) {
      skipped += 1;
      firstReason ??= result.reason;
    }
  }
  // exactOptionalPropertyTypes 下 `firstReason: undefined` 和"没有这个字段"是两种类型
  return firstReason === undefined
    ? { timeline: working, done, skipped }
    : { timeline: working, done, skipped, firstReason };
}

/**
 * 把战果折成 `BatchResult`。`verb`（"删" / "改"）进文案，所以措辞仍归调用方。
 *
 * 三种出口对应 `EditResult` 的三态，中间那个是"一个都没变而且没人失败" = 值没变：
 * 那时**不能给 `reason`**，否则滑块拖到边界会一直闪红字（见 `EditResult.reason`）。
 */
function tallyResult(
  timeline: Timeline,
  tally: PerClipTally,
  total: number,
  verb: string,
): BatchResult {
  if (tally.done === 0 && tally.skipped === 0) return { ...unchanged(timeline), done: 0, total };
  if (tally.done === 0) {
    return { ...reject(timeline, tally.firstReason ?? `没有可${verb}的片段`), done: 0, total };
  }
  if (tally.skipped > 0) {
    return {
      ...ok(tally.timeline),
      done: tally.done,
      total,
      skippedReason: `${total} 个片段里有 ${tally.skipped} 个没${verb}：${tally.firstReason ?? "原因不明"}`,
    };
  }
  return { ...ok(tally.timeline), done: tally.done, total };
}

/**
 * 批量删除。**逐个做，做不成的报出来，不整批拒绝。**
 *
 * 和 `moveClips` 的全体或拒绝刻意相反，判据是"部分成功是不是一个用户没要的新状态"：
 * 删掉 3 个和删掉 5 个都是"这些片段不在了"，没有第三种含义；而整批拒绝会让"选中的一堆
 * 里有一个在锁定轨道上"变成什么都删不掉，那不是用户的意图。
 *
 * 波纹删除逐个做同样是对的：每一步都从**当前**时间轴重读位置，而每次波纹左移的量都是
 * 那个片段自己的长度，所以顺序不影响结果（几个删除彼此可交换）。
 */
export function removeClips(
  timeline: Timeline,
  clipIds: readonly ClipId[],
  ripple = false,
): BatchResult {
  const ids = uniqueIds(clipIds);
  if (ids.length === 0) return { ...reject(timeline, "没有选中片段"), done: 0, total: 0 };

  const tally = perClip(timeline, ids, (working, id) =>
    ripple ? rippleDeleteClip(working, id) : removeClip(working, id),
  );
  return tallyResult(timeline, tally, ids.length, "删");
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
 * 这个属性对这个片段有没有意义。**单选的界面门和批量操作共用这一处判据。**
 *
 * 两条规则都是既有的，原来写在检查器的 JSX 里：变换和调色只作用于画面，所以音频轨上的
 * 片段没有；音量只在**音频轨的素材片段**上有意义（`planAudioJobs` 只混音频轨，视频轨上
 * 的片段调了音量不会进任何一条增益链）。
 *
 * 收成一个函数是因为批量改属性给了它第二个消费者。两处各写一遍 `track.kind === "video"`，
 * 漂了的表现是"单选看得见这一行、批量里没有"，或者更坏——批量把音量写进视频轨的片段，
 * 字段存下来了而声音一点没变（D19 那类"存了但不生效"）。**`setClipVolume` 自己不判轨道
 * 种类**，所以这个函数就是唯一的门，新的调用点都要先过它。
 */
export function propertyApplies(clip: Clip, track: Track, property: AnimatableProperty): boolean {
  if (isAudioProperty(property)) return track.kind === "audio" && clip.kind === "media";
  return track.kind === "video";
}

/** 一组片段在某个属性上的共同读数。见 `summarizeProperty`。 */
export interface PropertySummary {
  /** 这个属性对几个片段适用**且**没有动画——也就是这次批量真的会改到几个。 */
  readonly editable: number;
  /** 适用但打了关键帧的有几个。批量改不到它们，界面要说出来。 */
  readonly animated: number;
  /**
   * `editable` 那几个的共同静态值（缺省值算在内）。**不一致时给 `undefined`**，
   * 界面显示"多个值"；`editable === 0` 时同样是 `undefined`。
   */
  readonly value: number | undefined;
}

/**
 * 一组片段在某个属性上是什么读数。
 *
 * **有动画的片段既不参与读数也不参与写入，两边必须是同一份名单。** 批量写的是静态值，
 * 而有动画时静态值不是画面上生效的那个值——把它算进"共同值"里，用户会看到一个改不出来
 * 的数字（改完那一行还是原样，而软件一个字都没说，硬规则 10 的形状）。
 *
 * 不适用的片段**不计入任何一个数**：它们不是这次操作的对象，算进去会让"5 个里有 2 个没改"
 * 这句话把"文字片段没有音量"说成一次失败。
 */
export function summarizeProperty(
  timeline: Timeline,
  clipIds: readonly ClipId[],
  property: AnimatableProperty,
): PropertySummary {
  const fallback = PROPERTY_RANGES[property].fallback;
  let editable = 0;
  let animated = 0;
  let value: number | undefined;
  let same = true;
  for (const id of uniqueIds(clipIds)) {
    const found = findClip(timeline, id);
    if (!found || !propertyApplies(found.clip, found.track, property)) continue;
    if ((found.clip.keyframes?.[property]?.length ?? 0) > 0) {
      animated += 1;
      continue;
    }
    const own = staticValueOf(found.clip, property) ?? fallback;
    if (editable === 0) value = own;
    else if (own !== value) same = false;
    editable += 1;
  }
  return { editable, animated, value: same ? value : undefined };
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

/** 裁剪的四条边。顺序就是界面上的顺序（上 / 下 / 左 / 右 读起来比顺时针顺）。 */
export type CropEdge = "top" | "bottom" | "left" | "right";

export const CROP_EDGES: readonly CropEdge[] = ["top", "bottom", "left", "right"];

export const CROP_EDGE_LABELS: Record<CropEdge, string> = {
  top: "上",
  bottom: "下",
  left: "左",
  right: "右",
};

/**
 * 单边最多裁掉多少。**对边加起来还有一条更强的约束**（见 `setClipCrop`），这个上限只是
 * 让界面上每个输入框各自有个头——两条一起才挡得住"左右各 60%"。
 */
export const CROP_EDGE_MAX = 0.9;

/** 裁剪补丁：给数值就设，显式给 `undefined` 就**删掉**这条边（回到不裁）。 */
export type CropPatch = { readonly [K in CropEdge]?: number | undefined };

/**
 * 改片段的裁剪。
 *
 * **只有画面轨上的片段能裁**：音频轨上的片段没有像素，裁剪存下来永远不会被求值，
 * 那是 D19 那类"存了但不生效"——按钮亮着而什么都没变。判据和检查器那一节的门是
 * 同一个（`track.kind`），而**这里必须自己判**，不能只靠界面不显示：纯函数单独拿出来
 * 用也得安全（同 `pasteClip` 那条"素材必须在当前项目里"）。
 *
 * **对边加起来到 100% 时拒绝，不夹紧。** 夹紧要么改用户刚输的那个数、要么改另一边——
 * 两个都是"选了 A 拿到 B"。报出来的话用户知道该先减哪一边。
 *
 * **四条边都回到 0 时把字段整个删掉**（同 `normalizeGroup`）：两个后端的恒等快路径判的
 * 是"有没有这个字段"，而"这个片段裁过没有"也要能在数据层一眼看出来。
 */
export function setClipCrop(timeline: Timeline, clipId: ClipId, patch: CropPatch): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  if (found.track.kind !== "video") return reject(timeline, "只有画面轨上的片段能裁剪");

  const merged: Record<string, number> = { ...found.clip.crop };
  for (const edge of CROP_EDGES) {
    if (!(edge in patch)) continue;
    const raw = patch[edge];
    if (raw === undefined) {
      delete merged[edge];
      continue;
    }
    // NaN 会让 cropRect 算出 NaN 尺寸，drawImage 静默不画、Pixi 画出一张空纹理
    if (!Number.isFinite(raw)) return reject(timeline, `${CROP_EDGE_LABELS[edge]}边的裁剪必须是有限数`);
    merged[edge] = Math.min(CROP_EDGE_MAX, Math.max(0, raw));
  }

  const pairs: readonly (readonly [CropEdge, CropEdge, string])[] = [
    ["top", "bottom", "上下"],
    ["left", "right", "左右"],
  ];
  for (const [a, b, label] of pairs) {
    const sum = (merged[a] ?? 0) + (merged[b] ?? 0);
    if (sum >= 1) {
      return reject(timeline, `${label}一共要裁掉 ${Math.round(sum * 100)}%，画面就没有了`);
    }
  }

  let any = false;
  const next: Record<string, number> = {};
  for (const edge of CROP_EDGES) {
    const value = merged[edge];
    if (value === undefined || value === 0) continue;
    next[edge] = value;
    any = true;
  }
  const crop = any ? (next as CropInsets) : undefined;
  if (CROP_EDGES.every((edge) => (crop?.[edge] ?? 0) === (found.clip.crop?.[edge] ?? 0))) {
    return unchanged(timeline);
  }
  return ok(replaceClip(timeline, found.track.id, setOptional(found.clip, "crop", crop)));
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

/**
 * 把"若干属性 → 值"落到**一个**片段上。`undefined` = 回到缺省（字段整个删掉）。
 *
 * 静态值存在三个地方（`clip.transform` / `clip.color` 是对象、`clip.volume` 是标量），
 * 这是**写**这一侧的唯一分岔点，`staticValueOf` 是读那一侧的。两边各写一遍
 * `isAudioProperty ? … : isColorProperty ? … : …` 就会在加第四组时漏掉一处，而漏掉的
 * 表现是"这个属性批量改不动"或者"改了但读回来还是老值"。都不报错。
 *
 * 三个组各调一次既有的编辑入口，于是夹紧、NaN 校验、归一化、锁定判断都不重写一遍；
 * 中间态串在同一份 working timeline 上，对外仍然只是一个结果。**任何一步失败就整个
 * 失败**（不返回半个补丁）——一次调用是一个属性组的一次编辑，部分落地的那种状态没人要。
 */
function setClipProperties(
  timeline: Timeline,
  clipId: ClipId,
  values: ReadonlyMap<AnimatableProperty, number | undefined>,
): EditResult {
  const transform: Record<string, number | undefined> = {};
  const color: Record<string, number | undefined> = {};
  /** `null` = 这次不动音量。`undefined` 是个合法的值（回到缺省），不能拿它当哨兵。 */
  let volume: number | undefined | null = null;
  for (const [property, value] of values) {
    if (isAudioProperty(property)) volume = value;
    else if (isColorProperty(property)) color[property] = value;
    else transform[property] = value;
  }

  let working = timeline;
  let changed = false;
  /** 成功就推进 working，失败（带原因）就把那个结果交出去；"值没变"两者都不做。 */
  const advance = (result: EditResult): EditResult | null => {
    if (result.changed) {
      working = result.timeline;
      changed = true;
      return null;
    }
    return result.reason === undefined ? null : result;
  };

  if (Object.keys(transform).length > 0) {
    const failed = advance(setClipTransform(working, clipId, transform as TransformPatch));
    if (failed) return failed;
  }
  if (Object.keys(color).length > 0) {
    const failed = advance(setClipColor(working, clipId, color as ColorPatch));
    if (failed) return failed;
  }
  if (volume !== null) {
    const failed = advance(setClipVolume(working, clipId, volume ?? VOLUME_RANGE.fallback));
    if (failed) return failed;
  }
  return changed ? ok(working) : unchanged(timeline);
}

/**
 * 批量改**一个**属性的静态值。**逐个做，做不成的报出来**（同 `removeClips`，与
 * `moveClips` 的全体或拒绝刻意相反）。
 *
 * 判据还是那一条——"部分成功是不是一个用户没要的新状态"：几个片段的不透明度之间没有
 * 任何关系，把 3 个改成 50% 就只是"这 3 个是 50%"，没有第三种含义；而整批拒绝会让"选中
 * 的一堆里有一个在锁定轨道上"变成整组都调不了。（对比 `moveClips`：N 个片段的**相对
 * 位置**就是内容本身，所以那边部分成功是个用户没要的新状态。）
 *
 * **有动画的片段跳过并报出来。** 那时静态值不是画面上生效的值，写进去看不出任何变化。
 * 单选时这件事在界面上是可读的（钻石亮着、下面有关键帧条，而输入框改的就是当前帧那个
 * 关键帧值），批量时既看不见谁有动画、也没有一个共同的"当前帧"——播放头只落在其中一部分
 * 片段里。所以唯一诚实的做法是不改、并且说出来。
 *
 * **不适用的片段不计入 `total`**：它们不是这次操作的对象（见 `summarizeProperty`）。
 */
export function setClipsProperty(
  timeline: Timeline,
  clipIds: readonly ClipId[],
  property: AnimatableProperty,
  value: number,
): BatchResult {
  const ids = uniqueIds(clipIds).filter((id) => {
    const found = findClip(timeline, id);
    return found !== undefined && propertyApplies(found.clip, found.track, property);
  });
  if (ids.length === 0) {
    return {
      ...reject(timeline, `选中的片段都没有${PROPERTY_LABELS[property]}`),
      done: 0,
      total: 0,
    };
  }

  const values = new Map<AnimatableProperty, number | undefined>([[property, value]]);
  const tally = perClip(timeline, ids, (working, id) => {
    const found = findClip(working, id);
    if (found && (found.clip.keyframes?.[property]?.length ?? 0) > 0) {
      return reject(working, `${PROPERTY_LABELS[property]}有动画，要单选才改得到动画值`);
    }
    return setClipProperties(working, id, values);
  });
  return tallyResult(timeline, tally, ids.length, "改");
}

/**
 * 批量把若干属性恢复成缺省值（字段整个删掉）。检查器里每一组的「重置」按钮走这里。
 *
 * 和 `setClipsProperty` 差一条：**这里不跳过有动画的片段。** 重置的语义就是"把静态值
 * 恢复成默认、不动关键帧"（单选那个按钮的提示原话），所以对一个有动画的属性写它的静态值
 * 正是用户要的——那个值在关掉动画之后才生效（`clearKeyframes` 会往回烘，见它的注释）。
 *
 * 每个片段只重置**对它适用**的那几项，所以一次调用可以横跨画面轨和音频轨：视频轨上的
 * 片段重置变换与调色、音频轨上的重置音量，各不相干。
 */
export function resetClipsProperties(
  timeline: Timeline,
  clipIds: readonly ClipId[],
  properties: readonly AnimatableProperty[],
): BatchResult {
  const plans = new Map<ClipId, Map<AnimatableProperty, number | undefined>>();
  for (const id of uniqueIds(clipIds)) {
    const found = findClip(timeline, id);
    if (!found) continue;
    const values = new Map<AnimatableProperty, number | undefined>();
    for (const property of properties) {
      if (propertyApplies(found.clip, found.track, property)) values.set(property, undefined);
    }
    if (values.size > 0) plans.set(id, values);
  }
  if (plans.size === 0) {
    return { ...reject(timeline, "选中的片段都没有这几项"), done: 0, total: 0 };
  }

  const targets = [...plans.keys()];
  const tally = perClip(timeline, targets, (working, id) =>
    setClipProperties(working, id, plans.get(id) ?? new Map()),
  );
  return tallyResult(timeline, tally, targets.length, "改");
}

/**
 * 给素材片段设速度倍数。
 *
 * **语义是"保内容、改长度"**：源片跨度不变，片段在时间轴上按 `1/speed` 缩放
 * （2× → 占位减半）。另一种语义是"保长度、改用到多少源片"，但那会让"加速"
 * 变成"后面凭空多一段空白"，而用户想要的正是那一段整体变短。
 *
 * **放不下就拒绝，不做隐式波纹。** 变慢要变长，撞到后面的片段时静默推走整轨
 * 是硬规则 10 那种"选了 A 拿到 B"——波纹该是用户自己选的动作（`rippleDeleteClip`
 * 那样显式）。变快永远放得下。
 *
 * **关键帧不跟着缩**：偏移相对片段起点、单位是时间轴帧，属于时间轴侧。缩了的话
 * "在第 10 帧放大到 1.2 倍"会变成一个用户没打过的位置；落到新长度之外的点照旧
 * 保留不删（`valueAt` 区间外取端点值，同 `shiftKeyframes` 那条）。
 *
 * **回到 1× 要把字段整个删掉**（同 `setClipVolume`）：取帧那条"不乘不除"的原路径
 * 判的是这个字段。
 */
export function setClipSpeed(timeline: Timeline, clipId: ClipId, speed: Rational): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  const { clip, track } = found;
  // 图片片段没有"源片的哪一刻"，它要停多久是改长度；文字同理。见 `MediaClip.speed`
  if (clip.kind !== "media") return reject(timeline, "只有素材片段能变速");
  // **定格片段没有速度可言**（D48）：它整段就是一帧，改速度只会改长度而画面纹丝不动。
  // 放过去不是"没效果"而是 D19 那类"存了但不生效"——检查器写着 2× 而什么都没变；
  // 界面上那一节在定格时整个不出现，这道门是给纯函数自己的（同 `setClipCrop` 那条）
  if (isFrozen(clip)) return reject(timeline, "定格片段没有速度，先解除定格");
  if (!Number.isFinite(speed.num) || !Number.isFinite(speed.den)) {
    return reject(timeline, "速度必须是有限数");
  }
  // 倒放不做（`VideoTrackReader` 只能向前，硬规则 3 的前提）。0 会让源片时刻恒等于
  // 入点——那不是"停住"而是"整段都是同一帧"，且长度算出来是 Infinity
  if (speed.num <= 0 || speed.den <= 0) return reject(timeline, "速度必须是正数，不支持倒放");

  const wanted = rational(speed.num, speed.den);
  const factor = toNumber(wanted);
  if (factor < SPEED_RANGE.min || factor > SPEED_RANGE.max) {
    return reject(timeline, `速度只支持 ${SPEED_RANGE.min}× 到 ${SPEED_RANGE.max}×`);
  }

  const current = clipSpeed(clip);
  // 值没变：不进撤销栈也不算失败（预设按钮会重复点同一个值）
  if (current.num * wanted.den === wanted.num * current.den) return unchanged(timeline);

  const oldFrames = clipDuration(clip);
  // 保内容：oldFrames × 老速度 == newFrames × 新速度。整数乘除，不过浮点秒
  const newFrames = Math.max(
    1,
    Math.round((oldFrames * current.num * wanted.den) / (current.den * wanted.num)),
  );
  const next = setOptional(
    { ...clip, timelineOut: clip.timelineIn + newFrames },
    "speed",
    wanted.num === wanted.den ? undefined : wanted,
  );

  const hits = collisionsIn(track, next);
  if (hits.length > 0) {
    return reject(timeline, `放不下：会和「${hits[0]!.name ?? hits[0]!.id}」重叠`);
  }
  // 保内容意味着源片跨度不变，所以这一条只可能被上面那次取整推出去一帧。仍然要判：
  // 越界那一帧解不出来，而它的表现是成片尾部少一层画面、不报错
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  if (source) {
    const limit = sourceDurationFrames(source, timeline.fps);
    if (clip.sourceIn + clipSourceFrames(next) > limit) {
      return reject(timeline, "变速后会超出源片末尾，先把出点往回收一帧");
    }
  }

  return ok(replaceClip(timeline, track.id, next));
}

/**
 * 把片段定格在 `timelineFrame` 那一帧（**D48**）。
 *
 * 「定格」这个动作做的是**两件事一起**：把 `sourceIn` 挪到播放头指着的那一帧，再置上
 * `freeze`。之所以不给 `freeze` 配一个"定在哪一帧"的字段，理由在 `MediaClip.freeze`：
 * 那会造出第二个真值来源，而错了不报错、只表现成"定格定在了别的地方"。
 *
 * **要求播放头落在片段内**（左闭右开，同 `splitClipAt` 那道判据）。落在外面时定在哪一帧
 * 没有答案——夹到最近的一端等于替用户改了目标（"选了 A 拿到 B"），所以拒绝并说明。
 *
 * 三条门：
 *
 * - **只有素材片段能定格。** 文字片段的画面是现场生成的、本来就不动；图片片段整段就是
 *   一张图（那正是 D36 里它没有 `sourceIn` 的理由），给它们一个"定格"是造第二种表达
 *   同一件事的方式。
 * - **只有画面轨上的片段能定格**（同 `setClipCrop` 那条）。"定格一帧声音"没有意义，
 *   而真存下去的后果不是没效果而是**静音**：`mix-plan` 拿恒定的 `sourceMicrosAt` 会算出
 *   `srcStart === srcEnd` 的零长区间，那一段整个没声音且不报错。
 * - **已经定格了就是"值没变"**，不是失败：定格期间每一帧都映射到同一个源片帧，所以在
 *   任何位置再定一次都不产生新状态（滑块那条 `EditResult` 三态的同一个形态）。
 */
export function freezeClipAt(
  timeline: Timeline,
  clipId: ClipId,
  timelineFrame: number,
): EditResult {
  if (!Number.isInteger(timelineFrame)) return reject(timeline, "定格位置必须是整数帧");

  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  const { clip, track } = found;
  if (clip.kind !== "media") {
    return reject(
      timeline,
      clip.kind === "image" ? "图片片段本来就是静止的" : "只有素材片段能定格",
    );
  }
  if (track.kind !== "video") return reject(timeline, "只有画面轨上的片段能定格");
  if (isFrozen(clip)) return unchanged(timeline);
  if (timelineFrame < clip.timelineIn || timelineFrame >= clip.timelineOut) {
    return reject(timeline, "播放头不在这个片段里，定不了格");
  }

  // 换算和裁入点**完全一样**（`scaleBySpeed` 一处取整）：都是"从片段起点走了 Δ 个时间轴帧，
  // 源片走到哪一帧"。抄一份别的算式出来就等于给同一个问题开第二个答案
  const sourceIn = clip.sourceIn + scaleBySpeed(timelineFrame - clip.timelineIn, clipSpeed(clip));
  return ok(replaceClip(timeline, track.id, { ...clip, sourceIn, freeze: true }));
}

/**
 * 解除定格：从定住的那一帧接着往后播（**D48**）。
 *
 * **必须当场校验素材够不够长。** 定格把这个片段的"源片长度"变成了无穷（`clipSourceFrames`
 * 返回 1），所以用户可以把它拉到任意长；解除之后它要真的消耗 `clipSourceFrames` 帧，而
 * 那些帧可能根本不存在——不校验的表现是**尾部那一层画面静默消失**（同 `trimClip` 出点
 * 那道判据守着的东西，也同 D39 漏乘速度的形态）。报出来才让用户知道该先收出点。
 *
 * **`sourceIn` 留在定住的那一帧**，不退回定格之前的位置：那个位置已经没有记录了（见
 * `MediaClip.freeze`：刻意只有一个字段），而"从定住的这一帧继续播"本身是个说得通的结果。
 */
export function unfreezeClip(timeline: Timeline, clipId: ClipId): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  const { clip, track } = found;
  if (clip.kind !== "media") return reject(timeline, "只有素材片段能定格");
  if (!isFrozen(clip)) return unchanged(timeline);

  // 关掉要把字段整个删掉，不留 `freeze: false`（同 `speed` / `preservePitch`）
  const thawed = setOptional(clip, "freeze", undefined) as MediaClip;
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  if (source) {
    const limit = sourceDurationFrames(source, timeline.fps);
    const needed = clipSourceFrames(thawed);
    const available = limit - clip.sourceIn;
    if (needed > available) {
      return reject(
        timeline,
        `解除定格要 ${needed} 帧素材，定住那一帧之后只剩 ${Math.max(0, available)} 帧，先把出点往回收`,
      );
    }
  }
  return ok(replaceClip(timeline, track.id, thawed));
}

/**
 * 开关这个片段的"变速保持音高"（**D40**）。
 *
 * **不改片段长度、不动 `speed`**——它换的只是"同样的源片区间用哪种算法铺到同样长的
 * 输出上"。所以这里不需要碰碰撞检测，也不可能超出源片末尾。
 *
 * **允许在原速下开关**：字段是用户表达过的偏好，`clipPreservesPitch()` 会先判速度，
 * 所以原速下开着它不产生任何效果。反过来"原速不许开"会让"调到 1× 再调回 2×"丢掉勾选。
 */
export function setClipPreservePitch(
  timeline: Timeline,
  clipId: ClipId,
  on: boolean,
): EditResult {
  const found = findClip(timeline, clipId);
  if (!found) return reject(timeline, `找不到片段 ${clipId}`);
  if (found.track.locked) return reject(timeline, "轨道已锁定");
  const { clip, track } = found;
  if (clip.kind !== "media") return reject(timeline, "只有素材片段有声音");
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  // 无声素材上这个开关没有意义，而"设了没反应"比拒绝更难查
  if (!source?.hasAudio) return reject(timeline, "这个素材没有音轨");
  if ((clip.preservePitch === true) === on) return unchanged(timeline);

  // 关掉要把字段整个删掉，不留 `preservePitch: false`
  const next = setOptional(clip, "preservePitch", on ? true : undefined);
  return ok(replaceClip(timeline, track.id, next));
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

  // 不能用模块级计数器，理由见 `newClipId`（同 D36 那条，只是长在片段 id 上）
  const clipId = newClipId("text");
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
// 复制 / 粘贴 / 副本
// ---------------------------------------------------------------------------

/**
 * 剪贴板里的一份片段。
 *
 * **带上原轨道**，而不是只存片段：粘贴要落回同一条轨（音频片段粘到画面轨没有意义，
 * 而 `TrackKind` 是轨道的属性、片段自己看不出来——字幕轨 T1 的 `kind` 就是 `"video"`）。
 *
 * **不进撤销栈、不进快照。** 前者同播放头和选中（复制没有改动任何东西）；后者是因为它
 * 引用的 `sourceId` 可能在下次打开时已经不在了，而快照里一个引用不到素材的片段会让
 * `resolveSource()` 抛错（D23）。
 */
export interface ClipboardEntry {
  readonly clip: Clip;
  readonly trackId: TrackId;
  readonly trackKind: TrackKind;
}

/** 把这个片段放进剪贴板。找不到就返回 null（不算失败，UI 不提示）。 */
export function copyClip(timeline: Timeline, clipId: ClipId): ClipboardEntry | null {
  const found = findClip(timeline, clipId);
  if (!found) return null;
  return { clip: found.clip, trackId: found.track.id, trackKind: found.track.kind };
}

/**
 * 把这一组片段放进剪贴板，**按 `timelineIn` 升序**。
 *
 * 排序买到的是**确定的报错**：`pasteClips` 逐个插、失败时报出挡路的那一个，按点选顺序
 * 存的话同一组片段两次粘贴可能怪到不同的片段头上。**它不负责锚点的正确性**——那由
 * `pasteClips` 里的 `Math.min` 结构性保证（试过把这里的排序去掉，行为一个字节都不变，
 * 于是那次注入不算反向验证，只说明我原来写的理由是假的）。
 *
 * 找不到的悄悄跳过（选中集合可能刚被撤销掉一部分）。
 */
export function copyClips(timeline: Timeline, clipIds: readonly ClipId[]): ClipboardEntry[] {
  const entries: ClipboardEntry[] = [];
  for (const id of uniqueIds(clipIds)) {
    const entry = copyClip(timeline, id);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.clip.timelineIn - b.clip.timelineIn);
}

/**
 * 复制一份片段用来插入别处。
 *
 * 两件必须做的事：
 *
 * - **换一个新 id**。用 `newClipId` 而不是任何计数器，理由见那个函数；而且这里的要求
 *   更紧——连按三次粘贴必须得到三个不同的片段，模块计数器在页面刷新之后才出错，
 *   这里是当场就错。
 * - **`transitionIn` 整个删掉**。转场描述的是"这个片段和它前驱的交界"（D19），粘到别处
 *   之后那个前驱不存在了；留着的话粘贴会凭空多一个用户自己没加过的溶解，还刚好在
 *   新落点上——同 `splitClipAt` 右半段那条，这是第二次踩。
 *
 * **关键帧原样保留、偏移不动**：偏移相对片段起点，而这里换的只是片段落在时间轴的哪儿
 * （同"在时间轴上平移片段不要动关键帧"）。变换 / 调色 / LUT / 音量 / 速度 / 保音高 /
 * 文字样式全部照抄——用户复制一个片段要的就是"再来一个一样的"。
 */
function cloneAt(clip: Clip, timelineIn: number, prefix: string): Clip {
  const frames = clip.timelineOut - clip.timelineIn;
  const moved = {
    ...clip,
    id: newClipId(prefix),
    timelineIn,
    timelineOut: timelineIn + frames,
  };
  return setOptional(moved, "transitionIn", undefined);
}

/** 粘贴 / 副本共用的落点校验与插入。 */
function insertClone(
  timeline: Timeline,
  entry: ClipboardEntry,
  at: number,
  prefix: string,
): AddClipResult {
  if (!Number.isInteger(at) || at < 0) return reject(timeline, "落点必须是非负整数帧");

  const track = findTrack(timeline, entry.trackId);
  if (!track) return reject(timeline, `原轨道 ${entry.trackId} 已经不在了`);
  // 轨道种类变了（现在造不出来，留着是不信任将来新的轨道操作）
  if (track.kind !== entry.trackKind) return reject(timeline, "原轨道的种类变了");
  if (track.locked) return reject(timeline, `${track.label ?? track.id} 已锁定`);

  // **素材必须还在当前项目里。** 剪贴板活过 `openProject`，所以跨项目粘贴是够得到的
  // 姿势；而一个引用不到素材的片段会让快照恢复时 `resolveSource()` 抛错（D23），
  // 也就是"粘完这一下，下次打开项目就崩"。store 那边同时会在切项目时清空剪贴板，
  // 但那是体验；这一条才是契约——这个函数单独拿出来用也必须是安全的
  // **`clipSourceId` 对文字片段返回的是 `null` 不是 `undefined`。** 判 `!== undefined`
  // 会让 `null` 通过这道门、再去找一个 id 为 null 的素材，于是**文字片段永远粘不了**
  // ——单测当场抓到（"这个素材不在当前项目里"）。返回类型写成 `SourceId | null` 正是
  // 为了让这里必须显式判 null
  const sourceId = clipSourceId(entry.clip);
  if (sourceId !== null && !timeline.sources.some((s) => s.id === sourceId)) {
    return reject(timeline, "这个素材不在当前项目里，粘不过来");
  }

  const clip = cloneAt(entry.clip, at, prefix);
  const hits = collisionsIn(track, clip);
  if (hits.length > 0) {
    // 不隐式挪走别人、也不找别的轨道：静默换个位置就是"选了 A 拿到 B"（同 setClipSpeed）
    return reject(timeline, `放不下：会和「${hits[0]!.name ?? hits[0]!.id}」重叠`);
  }

  return {
    ...ok(mapTrack(timeline, track.id, (t) => withClips(t, [...t.clips, clip]))),
    clipId: clip.id,
  };
}

/**
 * 把剪贴板里那份粘到 `at` 帧，落回**原来那条轨**。
 *
 * 不去别的轨道上找位置：paste 的落点是用户用播放头指定的，静默换一条轨等于替他改了
 * 目标（同 `setClipSpeed` 放不下就拒绝，不隐式波纹）。放不下时报出挡路的是谁。
 */
export function pasteClip(timeline: Timeline, entry: ClipboardEntry, at: number): AddClipResult {
  return insertClone(timeline, entry, at, "paste");
}

/** 一次放下多个片段的结果。id 按落点顺序给回去，UI 拿它整组选中。 */
export interface AddClipsResult extends EditResult {
  readonly clipIds?: readonly ClipId[];
}

/**
 * 把剪贴板里那一组粘到 `at` 帧：**组的开头对齐播放头，组内相对位置原样保留**。
 *
 * 偏移按"离组内最早那个片段多远"算，而不是各自的绝对帧号——后者会让粘贴无视播放头
 * （直接粘回原处），而**单个片段时完全正常**（那时锚点就是它自己），同 D35 那个被乘以零
 * 的因子。每个片段各自回到自己那条轨（`insertClone` 认 `entry.trackId`），所以跨轨道的
 * 一组粘过去仍然是原来的排列。
 *
 * **全体或拒绝**（同 `moveClips`）：放下 3 个、剩下 2 个被挡住，得到的是一个用户没要的
 * 排列。做法是在一份工作副本上逐个插，任何一个失败就把整份丢掉、返回**原**时间轴。
 * 逐个插还顺带把"新片段之间互相重叠"检查掉了——它们看得见前面已经插进去的那些。
 */
export function pasteClips(
  timeline: Timeline,
  entries: readonly ClipboardEntry[],
  at: number,
): AddClipsResult {
  if (entries.length === 0) return reject(timeline, "剪贴板是空的");
  if (!Number.isInteger(at) || at < 0) return reject(timeline, "落点必须是非负整数帧");

  // **锚点必须是 `min`，不能写成 `entries[0]`。** 后者靠 `copyClips` 恰好排过序才对，
  // 而那是另一个函数的实现细节；⌘ 点选的顺序是"先点右边再点左边"时，锚点会变成右边那个，
  // 整组往左偏一个间距（落点为负时更是直接被拒），而两次操作在用户眼里完全一样
  const anchor = Math.min(...entries.map((e) => e.clip.timelineIn));
  let working = timeline;
  const clipIds: ClipId[] = [];
  for (const entry of entries) {
    const result = insertClone(working, entry, at + (entry.clip.timelineIn - anchor), "paste");
    if (!result.changed) return reject(timeline, result.reason ?? "粘不过来");
    working = result.timeline;
    if (result.clipId) clipIds.push(result.clipId);
  }
  return { ...ok(working), clipIds };
}

/**
 * 就地做一个副本，放在**原片段的出点**上（紧接着它）。
 *
 * 落点不取播放头：⌘D 的语义是"再来一个"，而用户按它的时候播放头很可能就在这个片段
 * 中间——那时按播放头放必然和自己重叠、直接被拒。紧接着放是唯一不需要用户先移动
 * 播放头的落点。**刻意不动剪贴板**：⌘D 不该把 ⌘C 复制好的东西冲掉。
 */
export function duplicateClip(timeline: Timeline, clipId: ClipId): AddClipResult {
  const entry = copyClip(timeline, clipId);
  if (!entry) return reject(timeline, `找不到片段 ${clipId}`);
  return insertClone(timeline, entry, entry.clip.timelineOut, "copy");
}

/**
 * 一组片段各做一个副本，**整组往后平移"组的跨度"**（最晚的出点 − 最早的入点）。
 *
 * 落点不能各自取自己的出点：两个前后相邻的片段那样做，A 的副本正好落在 B 头上，于是
 * **选中相邻几个片段按 ⌘D 永远失败**。按整组跨度平移则一定落在整组之后，而单个片段时
 * 跨度就是它自己的长度，落点退化成"紧接着它"——和 `duplicateClip` 落在同一处。
 *
 * 组里有空档、或者横跨多条轨道时，空档和轨道关系原样保留（平移量对整组是同一个）。
 * 同样**全体或拒绝**，理由见 `pasteClips`。
 */
export function duplicateClips(timeline: Timeline, clipIds: readonly ClipId[]): AddClipsResult {
  const ids = uniqueIds(clipIds);
  if (ids.length === 0) return reject(timeline, "没有选中片段");
  const entries = copyClips(timeline, ids);
  if (entries.length !== ids.length) return reject(timeline, "有片段已经不在了");

  const start = Math.min(...entries.map((e) => e.clip.timelineIn));
  const end = Math.max(...entries.map((e) => e.clip.timelineOut));
  const shift = end - start;

  let working = timeline;
  const clipIdsOut: ClipId[] = [];
  for (const entry of entries) {
    const result = insertClone(working, entry, entry.clip.timelineIn + shift, "copy");
    if (!result.changed) return reject(timeline, result.reason ?? "放不下");
    working = result.timeline;
    if (result.clipId) clipIdsOut.push(result.clipId);
  }
  return { ...ok(working), clipIds: clipIdsOut };
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

/**
 * 从项目里删掉一个素材，**引用它的片段一起删**。
 *
 * 它和 D37 第 3 刀那个"孤儿 + 够老"的清理不是一件事：那个回答"所有项目都不引用的
 * 资产什么时候可以从磁盘上清掉"，这里回答"用户在这个项目里不要它了"。所以这里
 * **只动 Timeline、不碰资产库**——字节的去留交给既有清理（它的判据必须跨项目算，
 * 见 `asset-cleanup.ts`），顺带保住撤销：⌘Z 之后片段和素材原样回来，文件也还在库里。
 *
 * **全体或拒绝**（判据同 `moveClips`）：引用它的片段有一个在锁定轨道上就整个拒绝。
 * "素材没了、片段还留着"不是部分成功，是一个非法状态——`resolveSource()` 对着
 * 引用不到素材的片段直接抛，预览当场崩（`project-snapshot.ts` 那条"素材找不回来时
 * 片段必须移除"守的就是它，这里不能亲手造一个出来）。
 *
 * 引用判据问 `clipSourceId()`：图片片段同样带 `sourceId`，散写 `kind === "media"`
 * 会漏掉它——表现是"素材删了、图片片段还在"，渲染时那一层静默消失。
 */
export function removeSource(timeline: Timeline, sourceId: SourceId): EditResult {
  const source = timeline.sources.find((s) => s.id === sourceId);
  if (!source) return reject(timeline, `找不到素材 ${sourceId}`);

  for (const track of timeline.tracks) {
    if (!track.locked) continue;
    if (track.clips.some((c) => clipSourceId(c) === sourceId)) {
      return reject(
        timeline,
        `${track.label ?? track.id} 已锁定，上面还有引用这个素材的片段，先解锁`,
      );
    }
  }

  // 删掉片段的轨道要过 `withClips` 归一化：后继片段的转场此刻指向一个不存在的交界
  // （转场挂在入场片段上、相邻关系不由类型保证），不清掉就是"界面显示有转场、画面上没有"
  const tracks = timeline.tracks.map((t) =>
    t.clips.some((c) => clipSourceId(c) === sourceId)
      ? withClips(t, t.clips.filter((c) => clipSourceId(c) !== sourceId))
      : t,
  );
  return ok({
    ...replaceTracks(timeline, tracks),
    sources: timeline.sources.filter((s) => s.id !== sourceId),
  });
}

// ---------------------------------------------------------------------------
// 轨道增删
// ---------------------------------------------------------------------------

/** 新建轨道要把 id 交回给调用方（同 `AddClipResult`：UI 可能要立刻指到它）。 */
export interface AddTrackResult extends EditResult {
  readonly trackId?: TrackId;
}

/**
 * 下一个空闲的轨道 id：`V3` / `A3` 这种可读形式，不用 UUID。
 *
 * 轨道 id 直接显示在轨道头和状态栏上（片段 id 不显示，所以那边用 UUID），可读性是
 * 界面的一部分。这**不违反** D36/D41 那条"不许用模块级计数器"：那两个坑坏在计数器
 * 随页面加载重置、记不住快照里已经用掉的号，而这里每次都从当前时间轴现算——时间轴
 * 本身就是唯一真值来源，快照恢复回来的轨道天然参与判重。
 *
 * 取"同前缀最大号 + 1"而不是"最小空号"：删掉 V2 再新建给的是 V4 不是 V2——剪贴板
 * 按 `trackId` 记原轨道（`ClipboardEntry`），复用刚删掉的号会让旧剪贴板把片段粘进
 * 一条毫不相干的新轨。末尾那道 while 防的是手工快照里"音频轨叫 V3"这类越界命名。
 */
function nextTrackId(tracks: readonly Track[], kind: TrackKind): TrackId {
  const prefix = kind === "video" ? "V" : "A";
  const pattern = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const track of tracks) {
    const match = pattern.exec(track.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let n = max + 1;
  while (tracks.some((t) => t.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

/**
 * 新建一条空轨道。
 *
 * **画面轨插在最上面，音频轨加在最下面**：`tracks` 数组是自上而下的显示顺序，画面的
 * z 序是"上面的压住下面的"（`videoTracksInDrawOrder` 反转这个数组），所以新画面轨
 * 天然成为最上层的叠加位；音频没有 z 序，挂在末尾和"画面朝上长、声音朝下长"的
 * NLE 习惯一致。不给 `label`：默认那五条的标签描述的是**角色**（主视频 / 人声），
 * 新轨道没有预设角色，编一个「画面 4」不比轨道头上已有的 id 多说任何东西。
 */
export function addTrack(timeline: Timeline, kind: TrackKind): AddTrackResult {
  const id = nextTrackId(timeline.tracks, kind);
  const track: Track = { id, kind, clips: [] };
  const tracks = kind === "video" ? [track, ...timeline.tracks] : [...timeline.tracks, track];
  return { ...ok(replaceTracks(timeline, tracks)), trackId: id };
}

/**
 * 删除一条轨道，上面的片段一起删。
 *
 * **锁定的轨道拒绝**：锁定的语义是"编辑会被拒绝"，而删掉整条轨是最大的一次编辑。
 * D43 那条例外只属于 `locked` 开关本身（不然锁上就解不开），不延伸到删除。
 *
 * 轨道上**有片段时不在这里拦**：删除走撤销栈、一步就回得来，"要不要先确认"是界面
 * 的事（菜单项的标签会写明连带几个片段）。也**不设"至少留一条"的下限**——空到没有
 * 画面轨时，导入和新建文字都会带原因拒绝（"没有画面轨"），出路就是旁边的新建轨道。
 */
export function removeTrack(timeline: Timeline, trackId: TrackId): EditResult {
  const track = findTrack(timeline, trackId);
  if (!track) return reject(timeline, `找不到轨道 ${trackId}`);
  if (track.locked) return reject(timeline, `${track.label ?? track.id} 已锁定，先解锁才能删除`);
  return ok(replaceTracks(timeline, timeline.tracks.filter((t) => t.id !== trackId)));
}

// ---------------------------------------------------------------------------
// 轨道开关
// ---------------------------------------------------------------------------

/** 轨道上的三个开关。`muted` 只对音频轨、`hidden` 只对画面轨、`locked` 两种都行。 */
export type TrackFlag = "locked" | "muted" | "hidden";

const TRACK_FLAG_LABELS: Record<TrackFlag, string> = {
  locked: "锁定",
  muted: "静音",
  hidden: "隐藏",
};

/**
 * 开关一条轨道的锁定 / 静音 / 隐藏。
 *
 * **这三个字段都在 `Timeline` 里，所以它必须走撤销栈**（`apply()`），没有第二种选择：
 * 历史里存的是整份 `Timeline`，绕过去直接改的话，之后任何一次撤销都会把这个开关
 * 连带回滚——"改了但撤销不了"和"没改但被撤销掉了"是同一个坑的两面。
 * 而它本来就该是编辑：**静音和隐藏会改变成片**（`mix-plan` 跳过静音音轨、
 * `videoTracksInDrawOrder` 跳过隐藏画面轨），撤销得回去才对。
 *
 * 三条纪律：
 *
 * - **`locked` 不能被"轨道已锁定"挡住。** 其他每个编辑操作都要判 `track.locked` 并拒绝，
 *   而这一个如果照着写，锁上之后就再也解不开了。这是唯一一处例外。
 * - **`muted` 只能给音频轨、`hidden` 只能给画面轨，装错了要拒绝。** 给画面轨设 `muted`
 *   不会报错、也不会有任何效果（混音只看音频轨），于是界面上那个按钮亮着而声音照旧
 *   ——那是 D19 记的"存了但不生效"同一类（界面显示有转场、画面上没有）。
 * - **关掉要把字段整个删掉**，不留 `false`（`setOptional`）。同 `transform` 那条：
 *   合成器判的是值，但"这条轨动过没有"要能在数据层一眼看出来。
 */
export function setTrackFlag(
  timeline: Timeline,
  trackId: TrackId,
  flag: TrackFlag,
  on: boolean,
): EditResult {
  const track = findTrack(timeline, trackId);
  if (!track) return reject(timeline, `找不到轨道 ${trackId}`);

  // 刻意**不判** track.locked：见文件注释第一条
  if (flag === "muted" && track.kind !== "audio") {
    return reject(timeline, "只有音频轨能静音");
  }
  if (flag === "hidden" && track.kind !== "video") {
    return reject(timeline, "只有画面轨能隐藏");
  }
  if ((track[flag] === true) === on) return unchanged(timeline);

  const next = setOptional(track, flag, on ? true : undefined);
  return ok(replaceTracks(timeline, timeline.tracks.map((t) => (t.id === trackId ? next : t))));
}

/** 撤销栈里那一步叫什么。开和关是两句话——"锁定"和"解锁"读起来完全不同。 */
export function trackFlagLabel(flag: TrackFlag, on: boolean): string {
  const name = TRACK_FLAG_LABELS[flag];
  return on ? name : `取消${name}`;
}

// ---------------------------------------------------------------------------
// 入点 / 出点标记
// ---------------------------------------------------------------------------

/**
 * 打或清一个标记（**D50**）。`frame` 给 null 表示清掉这一端。
 *
 * 一个函数带 `edge` 参数而不是 `setMarkIn` / `setMarkOut` 两个：**"入点必须严格小于
 * 出点"这条规则只有一份**，两个函数各写一遍的话漏改一边的表现是"从出点那侧可以打出
 * 一个反的区间"，而反的区间在 `markedRange()` 里被判成 null——于是标记看得见、导出
 * 范围那一项却不出现，两边都不报错。
 *
 * **越过另一端时拒绝，不夹紧也不顺手清掉对面**（同 D46 那条对边裁剪之和超 100% 的
 * 处理）：夹紧要么改用户刚点的那一帧、要么改另一端，两种都是"选了 A 拿到 B"；而
 * "打入点时把出点悄悄清掉"是 NLE 里常见做法，但它会让一次误按毁掉另一端的标记，
 * 而那一端没有任何提示。拒绝的代价只是多按一次 ⌥O。
 *
 * **不要求标记落在片段上**：入点打在空档里是合法的（导出会渲染黑画面 + 静音），
 * 那是用户的选择，不是错误。
 */
export function setMark(
  timeline: Timeline,
  edge: "in" | "out",
  frame: number | null,
): EditResult {
  const key = edge === "in" ? "markIn" : "markOut";
  const current = edge === "in" ? timeline.markIn : timeline.markOut;

  if (frame === null) {
    if (current === undefined) return unchanged(timeline);
    return ok(setOptional(timeline, key, undefined));
  }
  if (!Number.isInteger(frame)) return reject(timeline, "标记位置必须是整数帧");
  if (frame < 0 || frame > timeline.durationFrames) {
    return reject(timeline, `标记要落在 0 – ${timeline.durationFrames} 帧之间`);
  }
  if (current === frame) return unchanged(timeline);

  // 另一端在的话要留出非零长度；一端都没有时和时间轴自己比
  const other = edge === "in" ? timeline.markOut : timeline.markIn;
  if (edge === "in") {
    const limit = other ?? timeline.durationFrames;
    if (frame >= limit) {
      return reject(
        timeline,
        other === undefined
          ? "入点不能打在时间轴末尾"
          : `入点要在出点（第 ${other} 帧）之前，先清掉出点`,
      );
    }
  } else {
    const limit = other ?? 0;
    if (frame <= limit) {
      return reject(
        timeline,
        other === undefined
          ? "出点不能打在第 0 帧"
          : `出点要在入点（第 ${other} 帧）之后，先清掉入点`,
      );
    }
  }
  return ok(setOptional(timeline, key, frame));
}

// ---------------------------------------------------------------------------
// 框选
// ---------------------------------------------------------------------------

/**
 * 框选的范围。**帧号必须已经归一化**（`from <= to`）——往左拖出来的框在像素上是反的，
 * 而把归一化留给这里意味着每个调用点都要记得，忘了的表现是"往左框什么都选不中"。
 *
 * 轨道给的是**一组 id 而不是上下边界**：`tracks` 只是一个数组，"第 2 到第 4 条"这种说法
 * 依赖它的顺序，而垂直命中测试本来就在像素上做（关键帧轨会插在轨道之间，按序号算就会
 * 把它数进去）。所以由 UI 把"框碰到了哪几条轨"算好交进来。
 */
export interface SelectionBox {
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly trackIds: readonly TrackId[];
}

/**
 * 框里碰到的片段。**碰到就算，不要求完全框住。**
 *
 * 要求完全框住的话，一个比可视区还长的片段永远选不中（用户只能先缩小时间轴），
 * 而"碰到就算"是所有 NLE 的做法。判据和 `overlaps` 完全一样（**左闭右开**）：框到 200 帧
 * 而片段从 200 开始就不算碰到——两处用不同的边界规则会让"框到贴边"时选中数忽多忽少。
 *
 * 推论：**零宽的框（纯垂直拖动）选中它穿过的那些片段**，这是对的；而框刚好落在交界上时
 * 两边都不选中（`in < to && from < out` 在 from===to===交界 时两边都假）。
 *
 * **锁定轨道上的片段照样选中**，同 `selectAll`：能不能删由批量操作自己判并报出来，
 * 在选中这一步先筛一遍等于让用户看不见"那里还有东西"。
 */
export function clipsInBox(timeline: Timeline, box: SelectionBox): ClipId[] {
  const tracks = new Set(box.trackIds);
  const ids: ClipId[] = [];
  for (const track of timeline.tracks) {
    if (!tracks.has(track.id)) continue;
    for (const clip of track.clips) {
      if (clip.timelineIn < box.toFrame && box.fromFrame < clip.timelineOut) ids.push(clip.id);
    }
  }
  return ids;
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
 *
 * 排除的是**一组** id 而不是一个：多选整组拖拽时，组内其他片段的两端同样要排掉，
 * 否则被拖的那个会吸到同伴的**原**位置上（它们也在移动），表现是整组拖起来一顿一顿的。
 * 参数收成数组而不是"一个 id 或一组"的联合，是为了让漏改的调用点在编译期就红。
 */
export function snapTargets(
  timeline: Timeline,
  excludeClipIds: readonly ClipId[],
  extra: SnapCandidates = {},
): number[] {
  const excluded = new Set(excludeClipIds);
  const targets = new Set<number>([0]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (excluded.has(clip.id)) continue;
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
