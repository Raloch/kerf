/**
 * 片段拖拽与边缘裁切的交互状态机。
 *
 * 关键取舍：**拖拽过程只更新本地"幽灵"，松手才提交 store**。
 * 每次 pointermove 都提交的话，拖到非法位置时 store 会拒绝、片段停在原地，
 * 用户看到的是"卡住了"而不是"这里不能放"。幽灵能把合法/非法画出来，
 * 而且撤销栈天然只有一条记录，不依赖合并窗口去补救。
 *
 * 合法性判定直接复用 `operations.ts` 的纯函数（不提交，只看 changed），
 * 所以幽灵显示的规则和真正落下时执行的规则是同一套代码，不会漂移。
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Clip, Timeline, TrackId } from "../edl/types";
import { clipDuration } from "../edl/types";
import {
  moveClip,
  snapDrag,
  snapFrame,
  snapTargets,
  trimClip,
  type TrimEdge,
} from "../state/operations";
import { useTimeline } from "../state/timeline-store";

/**
 * 小于这个像素位移视为点击，不启动拖拽——否则点选片段会被当成微小拖动。
 *
 * 必须按**二维距离**判定：跨轨道拖拽是纯垂直移动，只看 X 位移的话
 * `|dx| = 0` 永远不过阈值，片段就永远拖不到别的轨道上（踩过）。
 */
const DRAG_THRESHOLD_PX = 3;

export interface Ghost {
  readonly trackId: TrackId;
  readonly inFrame: number;
  readonly lengthFrames: number;
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly kind: "move" | "trim";
}

interface MoveSession {
  readonly kind: "move";
  readonly clipId: string;
  readonly fromTrack: TrackId;
  readonly originIn: number;
  readonly lengthFrames: number;
  readonly startX: number;
  readonly startY: number;
}

interface TrimSession {
  readonly kind: "trim";
  readonly clipId: string;
  readonly trackId: TrackId;
  readonly edge: TrimEdge;
  readonly originIn: number;
  readonly originOut: number;
  readonly startX: number;
  readonly startY: number;
}

type Session = MoveSession | TrimSession;

export interface ClipDragApi {
  readonly ghost: Ghost | null;
  /** 吸附辅助线的帧号，null 表示当前没有吸附。 */
  readonly snapLine: number | null;
  readonly dragging: boolean;
  onClipPointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    clip: Clip,
    trackId: TrackId,
  ) => void;
  onHandlePointerDown: (
    event: ReactPointerEvent<HTMLElement>,
    clip: Clip,
    trackId: TrackId,
    edge: TrimEdge,
  ) => void;
}

export function useClipDrag(pxPerFrame: number): ClipDragApi {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const snapEnabled = useTimeline((s) => s.snapEnabled);
  const select = useTimeline((s) => s.select);
  // 用 moveClip 而不是 dragClipTo 提交：磁吸已经在这里算完了（且要尊重 ⌥ 临时关闭），
  // dragClipTo 会按 store 的 snapEnabled 再吸一次，把 ⌥ 的效果覆盖掉。
  const move = useTimeline((s) => s.moveClip);
  const trim = useTimeline((s) => s.trimClip);

  const setDragHint = useTimeline((s) => s.setDragHint);

  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const session = useRef<Session | null>(null);
  const movedEnough = useRef(false);
  const hint = useRef<string | null>(null);

  /** 只在提示变化时写 store，避免每次 pointermove 都触发全局订阅者重渲染。 */
  const publishHint = useCallback(
    (next: string | null) => {
      if (hint.current === next) return;
      hint.current = next;
      setDragHint(next);
    },
    [setDragHint],
  );

  const reset = useCallback(() => {
    session.current = null;
    movedEnough.current = false;
    setGhost(null);
    setSnapLine(null);
    publishHint(null);
  }, [publishHint]);

  /** 命中测试：光标落在哪条轨道上。用几何查询，不受 pointer capture 影响。 */
  const trackAt = useCallback((clientX: number, clientY: number): TrackId | null => {
    const el = document.elementFromPoint(clientX, clientY);
    const lane = el?.closest<HTMLElement>("[data-track-id]");
    return lane?.dataset.trackId ?? null;
  }, []);

  const computeMove = useCallback(
    (s: MoveSession, event: PointerEvent): { ghost: Ghost; snap: number | null } => {
      const rawDelta = (event.clientX - s.startX) / pxPerFrame;
      let desiredIn = Math.max(0, Math.round(s.originIn + rawDelta));
      let snap: number | null = null;

      // 按住 ⌥ 临时关闭磁吸（PLAN.md 决策 D2 承诺的行为）
      if (snapEnabled && !event.altKey) {
        const targets = snapTargets(timeline, s.clipId, { playhead });
        const snapped = snapDrag(desiredIn, s.lengthFrames, targets);
        if (snapped.snapped) {
          // 吸附线画在真正贴住的那一端
          const headHit = targets.includes(snapped.frame);
          snap = headHit ? snapped.frame : snapped.frame + s.lengthFrames;
        }
        desiredIn = snapped.frame;
      }

      const targetTrack = trackAt(event.clientX, event.clientY) ?? s.fromTrack;
      const delta = desiredIn - s.originIn;
      const probe = moveClip(timeline, s.clipId, delta, {
        toTrack: targetTrack,
        clampToBounds: false,
      });

      return {
        ghost: {
          kind: "move",
          trackId: targetTrack,
          inFrame: desiredIn,
          lengthFrames: s.lengthFrames,
          valid: probe.changed,
          reason: probe.reason,
        },
        snap,
      };
    },
    [pxPerFrame, playhead, snapEnabled, timeline, trackAt],
  );

  const computeTrim = useCallback(
    (s: TrimSession, event: PointerEvent): { ghost: Ghost; snap: number | null } => {
      const rawDelta = (event.clientX - s.startX) / pxPerFrame;
      let delta = Math.round(rawDelta);
      let snap: number | null = null;

      if (snapEnabled && !event.altKey) {
        const targets = snapTargets(timeline, s.clipId, { playhead });
        const edgeFrame = (s.edge === "in" ? s.originIn : s.originOut) + delta;
        const snapped = snapFrame(edgeFrame, targets);
        if (snapped.snapped && snapped.target !== undefined) {
          snap = snapped.target;
          delta = snapped.target - (s.edge === "in" ? s.originIn : s.originOut);
        }
      }

      const probe = trimClip(timeline, s.clipId, s.edge, delta);
      // 幽灵按裁切后的边界画，即使非法也让用户看到自己拖到了哪
      const inFrame = s.edge === "in" ? s.originIn + delta : s.originIn;
      const outFrame = s.edge === "in" ? s.originOut : s.originOut + delta;

      return {
        ghost: {
          kind: "trim",
          trackId: s.trackId,
          inFrame,
          lengthFrames: Math.max(1, outFrame - inFrame),
          valid: probe.changed && delta !== 0,
          reason: probe.reason,
        },
        snap,
      };
    },
    [pxPerFrame, playhead, snapEnabled, timeline],
  );

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, next: Session) => {
      // 只响应主键，右键留给后续的上下文菜单
      if (event.button !== 0) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      session.current = next;
      movedEnough.current = false;

      const target = event.currentTarget;

      const onMove = (e: PointerEvent) => {
        const s = session.current;
        if (!s) return;
        if (!movedEnough.current) {
          const dx = e.clientX - s.startX;
          const dy = e.clientY - s.startY;
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          movedEnough.current = true;
        }
        const result = s.kind === "move" ? computeMove(s, e) : computeTrim(s, e);
        setGhost(result.ghost);
        setSnapLine(result.snap);
        publishHint(result.ghost.valid ? null : result.ghost.reason ?? "这里放不下");
      };

      const onUp = (e: PointerEvent) => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onCancel);

        const s = session.current;
        if (s && movedEnough.current) {
          const result = s.kind === "move" ? computeMove(s, e) : computeTrim(s, e);
          if (result.ghost.valid) {
            if (s.kind === "move") {
              move(s.clipId, result.ghost.inFrame - s.originIn, {
                toTrack: result.ghost.trackId,
                clampToBounds: false,
              });
            } else {
              const delta =
                s.edge === "in"
                  ? result.ghost.inFrame - s.originIn
                  : result.ghost.inFrame + result.ghost.lengthFrames - s.originOut;
              trim(s.clipId, s.edge, delta);
            }
          }
        }
        reset();
      };

      const onCancel = () => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onCancel);
        reset();
      };

      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("pointercancel", onCancel);
    },
    [computeMove, computeTrim, move, publishHint, reset, trim],
  );

  const onClipPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: Clip, trackId: TrackId) => {
      // 按下即选中，和真实 NLE 一致；不等到 click，否则拖拽后选中态会滞后
      select(clip.id);
      begin(event, {
        kind: "move",
        clipId: clip.id,
        fromTrack: trackId,
        originIn: clip.timelineIn,
        lengthFrames: clipDuration(clip),
        startX: event.clientX,
        startY: event.clientY,
      });
    },
    [begin, select],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: Clip, trackId: TrackId, edge: TrimEdge) => {
      select(clip.id);
      begin(event, {
        kind: "trim",
        clipId: clip.id,
        trackId,
        edge,
        originIn: clip.timelineIn,
        originOut: clip.timelineOut,
        startX: event.clientX,
        startY: event.clientY,
      });
    },
    [begin, select],
  );

  return {
    ghost,
    snapLine,
    dragging: ghost !== null,
    onClipPointerDown,
    onHandlePointerDown,
  };
}

/** 供 Timeline 复用：某轨道上要不要画幽灵。 */
export function ghostForTrack(ghost: Ghost | null, trackId: TrackId): Ghost | null {
  return ghost && ghost.trackId === trackId ? ghost : null;
}

/** 幽灵的合法性也决定了鼠标样式与提示文案。 */
export function ghostTitle(ghost: Ghost, fps: Timeline["fps"]): string {
  void fps;
  if (ghost.valid) return `落到 ${ghost.inFrame} 帧`;
  return ghost.reason ?? "这里放不下";
}
