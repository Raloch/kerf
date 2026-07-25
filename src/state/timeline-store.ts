/**
 * 时间轴 store：编辑器的单一状态源。
 *
 * 分层刻意做得很清楚：
 *   `operations.ts`（纯函数，可单测）→ 这里（撤销栈 + 选中 + 播放头）→ React 组件
 *
 * 所有改动 Timeline 的入口都必须走 `apply()`，它负责进撤销栈。
 * 绕过 apply 直接 set timeline 会产生"撤销不了的编辑"，是最难查的一类 bug。
 *
 * 播放头和选中**不进撤销栈**：没人希望按 ⌘Z 是把光标移回去而不是撤销上一次剪辑。
 */

import { create } from "zustand";
import type { Clip, ClipId, MediaSource, Timeline, TrackId } from "../edl/types";
import { singleClipTimeline } from "../edl/types";
import { FPS } from "../time/rational";
import {
  canRedo as histCanRedo,
  canUndo as histCanUndo,
  commit,
  current,
  initHistory,
  redo as histRedo,
  redoLabel as histRedoLabel,
  undo as histUndo,
  undoLabel as histUndoLabel,
  type History,
} from "./history";
import {
  findClip,
  moveClip,
  removeClip,
  rippleDeleteClip,
  snapDrag,
  snapTargets,
  splitClipAt,
  trimClip,
  type EditResult,
  type MoveOptions,
  type TrimEdge,
} from "./operations";

/** 空项目：没有素材时的初始时间轴。 */
export const EMPTY_TIMELINE: Timeline = {
  fps: FPS.ndf2997,
  width: 1920,
  height: 1080,
  durationFrames: 0,
  tracks: [
    { id: "T1", kind: "video", label: "字幕 / 标题", clips: [] },
    { id: "V2", kind: "video", label: "叠加", clips: [] },
    { id: "V1", kind: "video", label: "主视频", clips: [] },
    { id: "A1", kind: "audio", label: "人声", clips: [] },
    { id: "A2", kind: "audio", label: "音乐", clips: [] },
  ],
  sources: [],
};

export interface TimelineState {
  history: History<Timeline>;
  /** 当前播放头（帧）。不进撤销栈。 */
  playhead: number;
  selectedClipId: ClipId | null;
  snapEnabled: boolean;
  /** 时间轴缩放：每帧像素数 × 100。UI 状态，不进撤销栈。 */
  zoom: number;
  /** 最近一次被拒绝的操作原因，供 UI 提示；成功操作会清空。 */
  lastRejection: string | null;

  // ---- 读 ----
  timeline: () => Timeline;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;

  // ---- 编辑（都会进撤销栈）----
  loadSource: (source: MediaSource) => void;
  moveClip: (clipId: ClipId, deltaFrames: number, options?: MoveOptions) => void;
  /** 拖拽落点：先算磁吸再移动，中间态按 clipId 合并成一步撤销。 */
  dragClipTo: (clipId: ClipId, desiredIn: number, toTrack?: TrackId) => void;
  trimClip: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void;
  splitAtPlayhead: () => void;
  removeSelected: (ripple?: boolean) => void;

  // ---- 不进撤销栈 ----
  setPlayhead: (frame: number) => void;
  select: (clipId: ClipId | null) => void;
  toggleSnap: () => void;
  setZoom: (zoom: number) => void;
  undo: () => void;
  redo: () => void;
}

/** 单调递增的时间源。用 performance.now() 让合并窗口按真实时间算。 */
const now = () => performance.now();

export const useTimeline = create<TimelineState>((set, get) => {
  /** 所有 Timeline 变更的唯一入口。 */
  function apply(result: EditResult, label: string, coalesceKey: string | null = null): void {
    if (!result.changed) {
      set({ lastRejection: result.reason ?? "操作未生效" });
      return;
    }
    set((state) => ({
      history: commit(state.history, result.timeline, { label, coalesceKey, at: now() }),
      lastRejection: null,
    }));
  }

  return {
    history: initHistory(EMPTY_TIMELINE, "新建项目"),
    playhead: 0,
    selectedClipId: null,
    snapEnabled: true, // 默认开，见 PLAN.md 决策 D2
    zoom: 42,
    lastRejection: null,

    timeline: () => current(get().history),
    canUndo: () => histCanUndo(get().history),
    canRedo: () => histCanRedo(get().history),
    undoLabel: () => histUndoLabel(get().history),
    redoLabel: () => histRedoLabel(get().history),

    loadSource(source) {
      // M0 的 singleClipTimeline 只铺单轨；M1 把它放进完整轨道布局里
      const single = singleClipTimeline(source);
      const videoClip = single.tracks.find((t) => t.kind === "video")?.clips[0];
      const audioClip = single.tracks.find((t) => t.kind === "audio")?.clips[0];

      const named = (clip: Clip | undefined, suffix: string): Clip[] =>
        clip ? [{ ...clip, id: `${source.id}${suffix}`, name: source.name }] : [];

      const next: Timeline = {
        ...EMPTY_TIMELINE,
        fps: source.fps,
        width: source.width,
        height: source.height,
        durationFrames: single.durationFrames,
        sources: [source],
        tracks: EMPTY_TIMELINE.tracks.map((track) => {
          if (track.id === "V1") return { ...track, clips: named(videoClip, "-v") };
          if (track.id === "A1") return { ...track, clips: named(audioClip, "-a") };
          return track;
        }),
      };

      set((state) => ({
        history: commit(state.history, next, {
          label: `导入 ${source.name}`,
          coalesceKey: null,
          at: now(),
        }),
        playhead: 0,
        selectedClipId: videoClip ? `${source.id}-v` : null,
        lastRejection: null,
      }));
    },

    moveClip(clipId, deltaFrames, options) {
      apply(
        moveClip(get().timeline(), clipId, deltaFrames, options ?? {}),
        "移动片段",
        `move:${clipId}`,
      );
    },

    dragClipTo(clipId, desiredIn, toTrack) {
      const state = get();
      const timeline = state.timeline();
      const found = findClip(timeline, clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }

      let target = Math.round(desiredIn);
      if (state.snapEnabled) {
        const length = found.clip.timelineOut - found.clip.timelineIn;
        const targets = snapTargets(timeline, clipId, { playhead: state.playhead });
        target = snapDrag(target, length, targets).frame;
      }

      const delta = target - found.clip.timelineIn;
      if (delta === 0) return; // 没动就不要产生历史条目
      apply(
        moveClip(timeline, clipId, delta, toTrack === undefined ? {} : { toTrack }),
        "移动片段",
        `move:${clipId}`,
      );
    },

    trimClip(clipId, edge, deltaFrames) {
      apply(
        trimClip(get().timeline(), clipId, edge, deltaFrames),
        edge === "in" ? "裁切入点" : "裁切出点",
        `trim:${edge}:${clipId}`,
      );
    },

    splitAtPlayhead() {
      const state = get();
      const timeline = state.timeline();
      const frame = state.playhead;
      // 没选中片段时，切播放头下所有未锁定轨道里的片段
      const targets = state.selectedClipId
        ? [state.selectedClipId]
        : timeline.tracks
            .filter((t) => !t.locked)
            .flatMap((t) => t.clips.filter((c) => frame > c.timelineIn && frame < c.timelineOut))
            .map((c) => c.id);

      if (targets.length === 0) {
        set({ lastRejection: "播放头下没有可切分的片段" });
        return;
      }

      let working = timeline;
      let changed = false;
      let reason: string | undefined;
      for (const id of targets) {
        const result = splitClipAt(working, id, frame);
        if (result.changed) {
          working = result.timeline;
          changed = true;
        } else {
          reason = result.reason;
        }
      }
      apply({ timeline: working, changed, ...(reason === undefined ? {} : { reason }) }, "切分片段");
    },

    removeSelected(ripple = false) {
      const { selectedClipId } = get();
      if (!selectedClipId) {
        set({ lastRejection: "没有选中片段" });
        return;
      }
      const timeline = get().timeline();
      const result = ripple
        ? rippleDeleteClip(timeline, selectedClipId)
        : removeClip(timeline, selectedClipId);
      if (result.changed) set({ selectedClipId: null });
      apply(result, ripple ? "波纹删除" : "删除片段");
    },

    setPlayhead(frame) {
      const timeline = get().timeline();
      // 夹在 [0, duration]：播放头允许停在末尾（等于 duration）以便追加
      const clamped = Math.max(0, Math.min(timeline.durationFrames, Math.round(frame)));
      set({ playhead: clamped });
    },

    select(clipId) {
      set({ selectedClipId: clipId, lastRejection: null });
    },

    toggleSnap() {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },

    setZoom(zoom) {
      // 夹住范围：0 会让所有片段宽度归零，过大则一帧几十像素、滚动条失控
      set({ zoom: Math.max(4, Math.min(400, Math.round(zoom))) });
    },

    undo() {
      set((state) => {
        const history = histUndo(state.history);
        const timeline = current(history);
        return {
          history,
          lastRejection: null,
          // 撤销后选中的片段可能已不存在，清掉悬空引用
          selectedClipId:
            state.selectedClipId && findClip(timeline, state.selectedClipId)
              ? state.selectedClipId
              : null,
          playhead: Math.min(state.playhead, timeline.durationFrames),
        };
      });
    },

    redo() {
      set((state) => {
        const history = histRedo(state.history);
        const timeline = current(history);
        return {
          history,
          lastRejection: null,
          selectedClipId:
            state.selectedClipId && findClip(timeline, state.selectedClipId)
              ? state.selectedClipId
              : null,
          playhead: Math.min(state.playhead, timeline.durationFrames),
        };
      });
    },
  };
});
