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
  clipDuration,
  type Clip,
  type ClipId,
  type Timeline,
  type Track,
  type TrackId,
} from "../edl/types";

/** 操作失败时返回原对象，并给出原因，便于 UI 提示而不是静默无反应。 */
export interface EditResult {
  readonly timeline: Timeline;
  readonly changed: boolean;
  readonly reason?: string;
}

function ok(timeline: Timeline): EditResult {
  return { timeline, changed: true };
}
function reject(timeline: Timeline, reason: string): EditResult {
  return { timeline, changed: false, reason };
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

function withClips(track: Track, clips: readonly Clip[]): Track {
  return { ...track, clips: sortClips(clips) };
}

function mapTrack(
  timeline: Timeline,
  trackId: TrackId,
  fn: (track: Track) => Track,
): Timeline {
  const tracks = timeline.tracks.map((t) => (t.id === trackId ? fn(t) : t));
  return replaceTracks(timeline, tracks);
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
  } else {
    const newOut = clip.timelineOut + deltaFrames;
    if (newOut <= clip.timelineIn) return reject(timeline, "片段至少要保留 1 帧");
    if (clip.kind === "media") {
      const source = timeline.sources.find((s) => s.id === clip.sourceId);
      const sourceLimit = source?.durationFrames ?? Number.MAX_SAFE_INTEGER;
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
  const right: Clip =
    clip.kind === "media"
      ? {
          ...clip,
          id: rightId,
          timelineIn: frame,
          // 右半段引用源片的起点要跟着推进，否则右半段会重播左半段的内容
          sourceIn: clip.sourceIn + (frame - clip.timelineIn),
        }
      // 文字层没有源片游标，两半段显示同一段文字
      : { ...clip, id: rightId, timelineIn: frame };

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
