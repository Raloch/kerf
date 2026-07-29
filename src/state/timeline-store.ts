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
import type { AnimatableProperty, Easing } from "../anim/keyframes";
import type {
  Clip,
  ClipId,
  FontSource,
  LutId,
  LutSource,
  MediaSource,
  Timeline,
  TrackId,
  Transition,
} from "../edl/types";
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
  addSource,
  addTextClip,
  clearKeyframes,
  findClip,
  moveClip,
  removeClip,
  removeKeyframe,
  moveKeyframe,
  addLut,
  addFont,
  renameProject,
  rippleDeleteClip,
  setClipColor,
  setClipLut,
  setClipVolume,
  setTransition,
  setClipTransform,
  setKeyframe,
  setTextContent,
  setTextStyle,
  snapDrag,
  snapTargets,
  splitClipAt,
  trimClip,
  type AddTextOptions,
  type ColorPatch,
  type EditResult,
  type MoveOptions,
  type TextStylePatch,
  type TransformPatch,
  type TrimEdge,
} from "./operations";

/**
 * 空项目：没有素材时的初始时间轴。默认 5 轨，见 PLAN.md 决策 D1。
 *
 * T1 的 `kind` 是 `"video"`，这是对的而不是笔误：轨道只分画面/声音两条通道，
 * 「字幕 / 标题」是**摆放约定**（文字层习惯放最上面），不是类型约束——
 * 标题同样能压在叠加轨上。"这一段是素材还是文字"由 `Clip.kind` 判别（见 `edl/types.ts`）。
 */
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
  /**
   * 当前装着的项目 id；**null = 没有项目装好**（首页、装载中、刚被删掉）。
   *
   * 它是自动存盘的闸门（见 `autosave.ts` 文件头）：id 和时间轴由 `openProject()`
   * **原子地一起换**，autosave 从同一份 state 里读这两样，所以"store 已经是项目 B
   * 而存盘还捏着项目 A 的 id"在结构上不存在——那正是切项目串写的形态（D37）。
   */
  projectId: string | null;
  /** 当前播放头（帧）。不进撤销栈。 */
  playhead: number;
  selectedClipId: ClipId | null;
  snapEnabled: boolean;
  /** 时间轴缩放：每帧像素数 × 100。UI 状态，不进撤销栈。 */
  zoom: number;
  /** 最近一次被拒绝的操作原因，供 UI 提示；成功操作会清空。 */
  lastRejection: string | null;
  /** 拖拽过程中的即时提示（落点非法的原因）。拖拽结束清空，不进撤销栈。 */
  dragHint: string | null;

  // ---- 读 ----
  timeline: () => Timeline;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;

  // ---- 编辑（都会进撤销栈）----
  /**
   * 把素材加进项目并在时间轴上放好片段。**追加，不覆盖**——见 `addSource()`。
   *
   * `timelineIn` 不传则放在播放头。放不下会走 `lastRejection` 提示，不静默换位置。
   */
  addSource: (source: MediaSource, timelineIn?: number) => void;
  /**
   * 把一个项目装进 store。**历史从这里重新开始。**
   *
   * 不恢复存下来的历史——快照里刻意没有撤销栈（见 `project-snapshot.ts`）。
   * 所以撤销回不到"打开之前"，那正是想要的：把一个引用了可能已经不在的素材的
   * 栈装回来，比没有撤销更坏。id 和时间轴**在同一次 set 里换**，见 `projectId`。
   */
  openProject: (projectId: string, timeline: Timeline, playhead: number) => void;
  /**
   * 卸下当前项目（删除项目、回首页时用）。`projectId` 归 null，自动存盘的 flush
   * 从此拒写——**删完项目必须先调它再等卸载**，否则收尾那次 flush 会把项目复活。
   */
  closeProject: () => void;
  /** 重命名当前项目。进撤销栈（它改的是 Timeline），`namedByUser` 由纯函数置位。 */
  renameProject: (name: string) => void;
  moveClip: (clipId: ClipId, deltaFrames: number, options?: MoveOptions) => void;
  /** 拖拽落点：先算磁吸再移动，中间态按 clipId 合并成一步撤销。 */
  dragClipTo: (clipId: ClipId, desiredIn: number, toTrack?: TrackId) => void;
  trimClip: (clipId: ClipId, edge: TrimEdge, deltaFrames: number) => void;
  splitAtPlayhead: () => void;
  removeSelected: (ripple?: boolean) => void;
  /** 改静态变换。连续拖滑块按"片段 + 改的是哪几个属性"合并成一步撤销。 */
  setClipTransform: (clipId: ClipId, patch: TransformPatch) => void;
  /** 改静态调色。合并策略同上。 */
  setClipColor: (clipId: ClipId, patch: ColorPatch) => void;
  /** 改片段音量。合并键带 clipId，理由同 `setClipTransform`。 */
  setClipVolume: (clipId: ClipId, volume: number) => void;
  /** 把一张解析好的 LUT 加进项目库。 */
  addLut: (lut: LutSource) => void;
  /** 给片段挂上 / 摘掉 LUT。传 undefined 表示摘掉。 */
  setClipLut: (clipId: ClipId, lutId?: LutId) => void;
  /**
   * 把一个**已经注册好**的字体加进项目库。
   *
   * 调用方要先 `await registerFont(font)` 再调它，见 `compose/font-registry.ts`。
   */
  addFont: (font: FontSource) => void;
  /**
   * 给片段的入点设置（或摘掉）转场。
   *
   * 合并键带 clipId：拖时长滑块时连续发同一个交界的改动，应该合成一次撤销，
   * 但换一个交界必须断开——否则一次 ⌘Z 会同时撤掉两个交界上的编辑。
   */
  setTransition: (clipId: ClipId, transition?: Transition) => void;
  /** 在**时间轴帧号** `frame` 处打关键帧；内部换算成片段内偏移。 */
  setKeyframeAt: (
    clipId: ClipId,
    property: AnimatableProperty,
    frame: number,
    value: number,
    easing?: Easing,
  ) => void;
  removeKeyframeAt: (clipId: ClipId, property: AnimatableProperty, frame: number) => void;
  /**
   * 把关键帧从**时间轴帧号** `fromFrame` 挪到 `toFrame`；内部换算成片段内偏移。
   *
   * 目标位置已有关键帧时会被拒（不覆盖），原因走 `lastRejection` 报到状态栏。
   */
  moveKeyframeAt: (
    clipId: ClipId,
    property: AnimatableProperty,
    fromFrame: number,
    toFrame: number,
  ) => void;
  clearKeyframes: (clipId: ClipId, property: AnimatableProperty, bakeValue?: number) => void;
  setTextContent: (clipId: ClipId, text: string) => void;
  setTextStyle: (clipId: ClipId, patch: TextStylePatch) => void;
  /** 新建文字片段；成功后自动选中它，用户接着就能在检查器里改。 */
  addTextClip: (options: AddTextOptions) => void;

  // ---- 不进撤销栈 ----
  setPlayhead: (frame: number) => void;
  select: (clipId: ClipId | null) => void;
  toggleSnap: () => void;
  setZoom: (zoom: number) => void;
  setDragHint: (hint: string | null) => void;
  undo: () => void;
  redo: () => void;
}

/** 单调递增的时间源。用 performance.now() 让合并窗口按真实时间算。 */
const now = () => performance.now();

export const useTimeline = create<TimelineState>((set, get) => {
  /** 所有 Timeline 变更的唯一入口。 */
  function apply(result: EditResult, label: string, coalesceKey: string | null = null): void {
    if (!result.changed) {
      // 没给 reason 表示"值没变"，不是失败——见 EditResult.reason。
      // 一律当失败提示的话，滑块拖到边界后会一直闪红字
      if (result.reason !== undefined) set({ lastRejection: result.reason });
      return;
    }
    set((state) => ({
      history: commit(state.history, result.timeline, { label, coalesceKey, at: now() }),
      lastRejection: null,
    }));
  }

  return {
    history: initHistory(EMPTY_TIMELINE, "新建项目"),
    projectId: null,
    playhead: 0,
    selectedClipId: null,
    snapEnabled: true, // 默认开，见 PLAN.md 决策 D2
    zoom: 42,
    lastRejection: null,
    dragHint: null,

    timeline: () => current(get().history),
    canUndo: () => histCanUndo(get().history),
    canRedo: () => histCanRedo(get().history),
    undoLabel: () => histUndoLabel(get().history),
    redoLabel: () => histRedoLabel(get().history),

    addSource(source, timelineIn) {
      const state = get();
      const at = timelineIn ?? state.playhead;
      const result = addSource(state.timeline(), { source, timelineIn: at });
      if (!result.changed) {
        set({ lastRejection: result.reason ?? null });
        return;
      }
      set((s) => ({
        history: commit(s.history, result.timeline, {
          label: `导入 ${source.name}`,
          coalesceKey: null,
          at: now(),
        }),
        // 选中新片段（画面在前）。**不动播放头**：导入配乐时用户正停在某一处，
        // 把它拨回 0 等于让"在播放头处插入"这件事自己失效
        selectedClipId: result.clipIds?.[0] ?? null,
        lastRejection: null,
      }));
    },

    openProject(projectId, timeline, playhead) {
      set({
        projectId,
        history: initHistory(timeline, "打开项目"),
        playhead,
        selectedClipId: null,
        lastRejection: null,
        dragHint: null,
      });
    },

    closeProject() {
      set({
        projectId: null,
        history: initHistory(EMPTY_TIMELINE, "新建项目"),
        playhead: 0,
        selectedClipId: null,
        lastRejection: null,
        dragHint: null,
      });
    },

    renameProject(name) {
      apply(renameProject(get().timeline(), name), "重命名项目");
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

      // "没动"必须连轨道一起判。跨轨道拖拽是**纯垂直**移动，delta 恒为 0，
      // 只看 delta 会把整个跨轨落点静默丢掉——既不移动也不给 lastRejection，
      // 表现成"拖上去松手，片段弹回原轨"。见 CLAUDE.md 的"水平和垂直都要测"
      const delta = target - found.clip.timelineIn;
      const sameTrack = toTrack === undefined || toTrack === found.track.id;
      if (delta === 0 && sameTrack) return; // 真的没动才不产生历史条目
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

    setClipTransform(clipId, patch) {
      // 合并键带上"改的是哪几个属性"：拖 X 滑块和紧接着拖 Y 滑块是两次编辑，
      // 只按 clipId 合并会把它们并成一步，⌘Z 一下退回去两个属性
      const keys = Object.keys(patch).sort().join(",");
      apply(
        setClipTransform(get().timeline(), clipId, patch),
        "调整变换",
        `transform:${clipId}:${keys}`,
      );
    },

    setClipColor(clipId, patch) {
      const keys = Object.keys(patch).sort().join(",");
      apply(setClipColor(get().timeline(), clipId, patch), "调色", `color:${clipId}:${keys}`);
    },

    setClipVolume(clipId, volume) {
      apply(setClipVolume(get().timeline(), clipId, volume), "音量", `volume:${clipId}`);
    },

    addLut(lut) {
      apply(addLut(get().timeline(), lut), `导入 LUT ${lut.name}`);
    },

    setClipLut(clipId, lutId) {
      apply(setClipLut(get().timeline(), clipId, lutId), lutId ? "套用 LUT" : "移除 LUT");
    },

    addFont(font) {
      apply(addFont(get().timeline(), font), `导入字体 ${font.name}`);
    },

    setTransition(clipId, transition) {
      apply(
        setTransition(get().timeline(), clipId, transition),
        transition ? "设置转场" : "移除转场",
        transition ? `transition:${clipId}` : undefined,
      );
    },

    setKeyframeAt(clipId, property, frame, value, easing) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      // 关键帧偏移相对片段起点（D10）。换算只在这一处做，纯函数层只认偏移
      const offset = frame - found.clip.timelineIn;
      apply(
        setKeyframe(get().timeline(), clipId, property, offset, value, easing),
        `关键帧 ${property}`,
        // 偏移进合并键：在同一个位置拖值要合并，换个位置再打就是新的一步
        `keyframe:${clipId}:${property}:${offset}`,
      );
    },

    removeKeyframeAt(clipId, property, frame) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      apply(
        removeKeyframe(get().timeline(), clipId, property, frame - found.clip.timelineIn),
        "删除关键帧",
      );
    },

    moveKeyframeAt(clipId, property, fromFrame, toFrame) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      const { timelineIn } = found.clip;
      // **不给合并键。** 时间轴上拖关键帧走的是"拖动中只画落点、松手才提交"
      // （同 `use-clip-drag`），所以一次拖拽本来就只产生一条历史。D10 的重新评估
      // 条款担心的是"边拖边提交"那种写法，那时才需要一个带关键帧身份的合并键——
      // 而关键帧的身份只有偏移，拖动中偏移一直在变，那个键根本立不住。
      apply(
        moveKeyframe(get().timeline(), clipId, property, fromFrame - timelineIn, toFrame - timelineIn),
        "移动关键帧",
      );
    },

    clearKeyframes(clipId, property, bakeValue) {
      apply(clearKeyframes(get().timeline(), clipId, property, bakeValue), "关闭动画");
    },

    setTextContent(clipId, text) {
      // 逐次按键都会进来，靠合并窗口把连续输入并成一步撤销
      apply(setTextContent(get().timeline(), clipId, text), "修改文字", `text:${clipId}`);
    },

    setTextStyle(clipId, patch) {
      const keys = Object.keys(patch).sort().join(",");
      apply(setTextStyle(get().timeline(), clipId, patch), "文字样式", `style:${clipId}:${keys}`);
    },

    addTextClip(options) {
      const result = addTextClip(get().timeline(), options);
      apply(result, "新建文字");
      // 选中新片段，用户接着就能改内容；失败时 clipId 为空，不动选中
      if (result.changed && result.clipId) set({ selectedClipId: result.clipId });
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

    setDragHint(hint) {
      set({ dragHint: hint });
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

/**
 * 开发期把 store 挂到全局，供浏览器控制台和自动化实测脚本驱动**真实**实例。
 *
 * 不这样做的话，脚本里 `import('/src/state/timeline-store.ts')` 会因为 Vite 的
 * HMR URL 带参数而拿到另一个模块实例——脚本改了状态，界面毫无反应，
 * 看起来像 UI 没绑定 store，实际是两份状态各自为政。排查过一次，记在这里。
 */
if (import.meta.env.DEV) {
  (globalThis as typeof globalThis & { __kerfStore?: typeof useTimeline }).__kerfStore =
    useTimeline;
}
