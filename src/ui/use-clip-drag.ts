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
  moveClips,
  snapDrag,
  snapFrame,
  snapTargets,
  trimClip,
  type TrimEdge,
  type TrimMode,
} from "../state/operations";
import { useTimeline, type DragHint } from "../state/timeline-store";

/**
 * 小于这个像素位移视为点击，不启动拖拽——否则点选片段会被当成微小拖动。
 *
 * 必须按**二维距离**判定：跨轨道拖拽是纯垂直移动，只看 X 位移的话
 * `|dx| = 0` 永远不过阈值，片段就永远拖不到别的轨道上（踩过）。
 */
const DRAG_THRESHOLD_PX = 3;

export interface Ghost {
  /** 这个幽灵是哪个片段的落点。整组拖拽时一次画好几个，React 拿它当 key。 */
  readonly clipId: string;
  readonly trackId: TrackId;
  readonly inFrame: number;
  readonly lengthFrames: number;
  readonly valid: boolean;
  readonly reason?: string | undefined;
  readonly kind: "move" | "trim";
}

/** 整组拖拽里跟着一起动的一个片段：原位置 + 长度，够画幽灵也够算落点。 */
interface Follower {
  readonly clipId: string;
  readonly trackId: TrackId;
  readonly originIn: number;
  readonly lengthFrames: number;
}

interface MoveSession {
  readonly kind: "move";
  readonly clipId: string;
  readonly fromTrack: TrackId;
  readonly originIn: number;
  readonly lengthFrames: number;
  readonly startX: number;
  readonly startY: number;
  /**
   * 跟着一起动的其他片段（多选整组拖拽）。空数组 = 单个片段那条原路径。
   *
   * 存**快照**而不是每次 pointermove 去 store 查选中集合：拖拽期间选中不会变，而拖到
   * 一半重新读一次的话，任何让选中变化的东西都会让这次拖拽中途换掉被移动的对象。
   */
  readonly followers: readonly Follower[];
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
  /**
   * 普通 / 波纹 / 卷动，**在按下那一刻定死**。
   *
   * 不跟着修饰键实时变，因为松手也是一个事件：先松开 ⇧ 再松开鼠标的话，落下的
   * 就成了另一种编辑，而用户全程看到的都是波纹的落点。这一点和 ⌥ 关磁吸刻意不同
   * ——那个读实时的代价只是吸不吸，而这个决定的是"后面十个片段动不动"。
   */
  readonly mode: TrimMode;
}

type Session = MoveSession | TrimSession;

/** 一次 pointermove 算出来的东西。`delta` 只有裁切那条路用（见 `computeTrim`）。 */
interface Computed {
  readonly ghosts: readonly Ghost[];
  readonly snap: number | null;
  readonly delta?: number;
}

export interface ClipDragApi {
  /** 拖拽中的落点，**一个或多个**（整组拖拽时每个片段一个）。空数组 = 没在拖。 */
  readonly ghosts: readonly Ghost[];
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
  const toggleSelect = useTimeline((s) => s.toggleSelect);
  const selectedClipIds = useTimeline((s) => s.selectedClipIds);
  // 用 moveClip 而不是 dragClipTo 提交：磁吸已经在这里算完了（且要尊重 ⌥ 临时关闭），
  // dragClipTo 会按 store 的 snapEnabled 再吸一次，把 ⌥ 的效果覆盖掉。
  const move = useTimeline((s) => s.moveClip);
  const moveGroup = useTimeline((s) => s.moveClips);
  const trim = useTimeline((s) => s.trimClip);

  const setDragHint = useTimeline((s) => s.setDragHint);

  const [ghosts, setGhosts] = useState<readonly Ghost[]>([]);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const session = useRef<Session | null>(null);
  const movedEnough = useRef(false);
  const hint = useRef<string | null>(null);

  /** 只在提示变化时写 store，避免每次 pointermove 都触发全局订阅者重渲染。 */
  const publishHint = useCallback(
    (next: DragHint | null) => {
      const key = next === null ? null : `${next.bad ? "!" : ""}${next.text}`;
      if (hint.current === key) return;
      hint.current = key;
      setDragHint(next);
    },
    [setDragHint],
  );

  const reset = useCallback(() => {
    session.current = null;
    movedEnough.current = false;
    setGhosts([]);
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
    (s: MoveSession, event: PointerEvent): Computed => {
      const group = s.followers.length > 0;
      const rawDelta = (event.clientX - s.startX) / pxPerFrame;
      let desiredIn = Math.max(0, Math.round(s.originIn + rawDelta));
      let snap: number | null = null;

      // 按住 ⌥ 临时关闭磁吸（PLAN.md 决策 D2 承诺的行为）
      if (snapEnabled && !event.altKey) {
        // 整组拖拽时候选位置要排掉**整组**：同伴也在移动，吸到它们的原位置是错的。
        // 磁吸只按被按住的那个片段算——一组有 2N 个端点，全都参与会让落点来回跳
        const exclude = group ? [s.clipId, ...s.followers.map((f) => f.clipId)] : [s.clipId];
        const targets = snapTargets(timeline, exclude, { playhead });
        const snapped = snapDrag(desiredIn, s.lengthFrames, targets);
        if (snapped.snapped) {
          // 吸附线画在真正贴住的那一端
          const headHit = targets.includes(snapped.frame);
          snap = headHit ? snapped.frame : snapped.frame + s.lengthFrames;
        }
        desiredIn = snapped.frame;
      }

      const delta = desiredIn - s.originIn;

      // 整组：不换轨（见 `moveClips`），落点合法性对整组是**一个**布尔——分别判会画出
      // "这几个绿那几个红"，而提交是全体或拒绝，那就是界面说了一件不会发生的事
      if (group) {
        const ids = [s.clipId, ...s.followers.map((f) => f.clipId)];
        const probe = moveClips(timeline, ids, delta, { clampToBounds: false });
        const shared = { kind: "move" as const, valid: probe.changed, reason: probe.reason };
        return {
          ghosts: [
            { ...shared, clipId: s.clipId, trackId: s.fromTrack, inFrame: desiredIn, lengthFrames: s.lengthFrames },
            ...s.followers.map((f) => ({
              ...shared,
              clipId: f.clipId,
              trackId: f.trackId,
              inFrame: f.originIn + delta,
              lengthFrames: f.lengthFrames,
            })),
          ],
          snap,
        };
      }

      const targetTrack = trackAt(event.clientX, event.clientY) ?? s.fromTrack;
      const probe = moveClip(timeline, s.clipId, delta, {
        toTrack: targetTrack,
        clampToBounds: false,
      });

      return {
        ghosts: [
          {
            kind: "move",
            clipId: s.clipId,
            trackId: targetTrack,
            inFrame: desiredIn,
            lengthFrames: s.lengthFrames,
            valid: probe.changed,
            reason: probe.reason,
          },
        ],
        snap,
      };
    },
    [pxPerFrame, playhead, snapEnabled, timeline, trackAt],
  );

  const computeTrim = useCallback(
    (s: TrimSession, event: PointerEvent): Computed => {
      const rawDelta = (event.clientX - s.startX) / pxPerFrame;
      let delta = Math.round(rawDelta);
      let snap: number | null = null;

      if (snapEnabled && !event.altKey) {
        const targets = snapTargets(timeline, [s.clipId], { playhead });
        const edgeFrame = (s.edge === "in" ? s.originIn : s.originOut) + delta;
        const snapped = snapFrame(edgeFrame, targets);
        if (snapped.snapped && snapped.target !== undefined) {
          snap = snapped.target;
          delta = snapped.target - (s.edge === "in" ? s.originIn : s.originOut);
        }
      }

      const probe = trimClip(timeline, s.clipId, s.edge, delta, s.mode);

      /*
        合法时**从结果里反推幽灵**，不手算。

        这一次拖拽可能改动好几个片段：音画伙伴在另一条轨上、波纹把后面一整排往前
        收、卷动动的是交界另一侧。手算一遍就是第二个真值来源，漏掉一类的表现是
        "松手之后多动了几个我没看见的片段"——而差分不可能和被测对象漂开。
      */
      if (probe.changed) return { ghosts: diffGhosts(timeline, probe.timeline), snap, delta };

      // 非法时结果里什么都没有，仍要让用户看到自己拖到了哪
      const inFrame = s.edge === "in" ? s.originIn + delta : s.originIn;
      const outFrame = s.edge === "in" ? s.originOut : s.originOut + delta;
      return {
        ghosts: [
          {
            kind: "trim",
            clipId: s.clipId,
            trackId: s.trackId,
            inFrame,
            lengthFrames: Math.max(1, outFrame - inFrame),
            valid: false,
            // 位移为 0 不是失败（`EditResult` 的第三态），报出来会在状态栏一直闪红字
            reason: delta === 0 ? undefined : probe.reason,
          },
        ],
        snap,
        delta,
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
        setGhosts(result.ghosts);
        setSnapLine(result.snap);
        // 整组共用一个合法性，所以看第一个就够；写成"有没有任何一个非法"是一样的结果，
        // 但那种写法会让人以为这里允许部分合法
        const first = result.ghosts[0];
        const bad = first !== undefined && !first.valid;
        publishHint(
          bad
            ? { text: first.reason ?? "这里放不下", bad: true }
            : s.kind === "trim"
              ? { text: trimReadout(s, result), bad: false }
              : null,
        );
      };

      const onUp = (e: PointerEvent) => {
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("pointercancel", onCancel);

        const s = session.current;
        // **低于阈值 = 点击，那时要把选中收缩成这一个。**
        //
        // 按下时刻刻意不收缩（否则一按就丢掉整组，而用户接下来正是要拖这一组），代价是
        // "点一下组里的某个片段"必须在这里补上语义——不补的话从"选了三个"回到"只要这一个"
        // 就只剩 Esc 再点一次这条路，而用户明明点了一个片段却看到三个还亮着。
        // 判据用的是拖拽阈值本身（同关键帧那条"低于阈值算点击"），所以真的拖过就不会误触
        if (s && !movedEnough.current && s.kind === "move" && s.followers.length > 0) {
          select(s.clipId);
        }
        if (s && movedEnough.current) {
          const result = s.kind === "move" ? computeMove(s, e) : computeTrim(s, e);
          const ghost = result.ghosts[0];
          if (ghost && ghost.valid) {
            if (s.kind === "move") {
              const delta = ghost.inFrame - s.originIn;
              if (s.followers.length > 0) {
                // 整组一次提交（一条撤销），而且**不带目标轨道**——多选拖拽不换轨
                moveGroup([s.clipId, ...s.followers.map((f) => f.clipId)], delta, false);
              } else {
                move(s.clipId, delta, { toTrack: ghost.trackId, clampToBounds: false });
              }
            } else {
              // 位移由 `computeTrim` 直接给出，**不从幽灵反推**：合法时幽灵是从结果
              // 差分出来的，第一个未必是用户拖的那个片段（波纹里可能是后继、卷动里
              // 可能是交界另一侧），按它反推出来的帧数会指向另一条边
              trim(s.clipId, s.edge, result.delta ?? 0, s.mode);
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
    [computeMove, computeTrim, move, moveGroup, publishHint, reset, select, trim],
  );

  const onClipPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: Clip, trackId: TrackId) => {
      // ⌘/Ctrl 按下 = 加减选择，**不启动拖拽**。加选的那一下顺手把片段拖走是"选了 A
      // 拿到 B"：用户的手势是"再选一个"，位移只是手抖
      if (event.metaKey || event.ctrlKey) {
        event.stopPropagation();
        toggleSelect(clip.id);
        return;
      }

      // 按下即选中，和真实 NLE 一致；不等到 click，否则拖拽后选中态会滞后。
      // **已经在多选里的片段不要把选中收缩成它自己**：那样一按就丢掉整组，
      // 而用户接下来正是要拖这一组
      const inGroup = selectedClipIds.includes(clip.id);
      if (!inGroup) select(clip.id);

      const followers =
        inGroup && selectedClipIds.length > 1
          ? selectedClipIds
              .filter((id) => id !== clip.id)
              .flatMap((id) => {
                const found = findFollower(timeline, id);
                return found ? [found] : [];
              })
          : [];

      begin(event, {
        kind: "move",
        clipId: clip.id,
        fromTrack: trackId,
        originIn: clip.timelineIn,
        lengthFrames: clipDuration(clip),
        startX: event.clientX,
        startY: event.clientY,
        followers,
      });
    },
    [begin, select, selectedClipIds, timeline, toggleSelect],
  );

  const onHandlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clip: Clip, trackId: TrackId, edge: TrimEdge) => {
      // 裁切永远只作用于一个片段（多选裁切要么按各自长度按比例缩、要么全裁同一个量，
      // 两种都不是明显正确的），所以按住边缘就把选中收缩成它自己——那是看得见的降级。
      // **音画伙伴不在此列**：那是"还有谁跟着变"，由纯函数回答，不走选中（D55）
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
        mode: trimModeOf(event),
      });
    },
    [begin, select],
  );

  return {
    ghosts,
    snapLine,
    dragging: ghosts.length > 0,
    onClipPointerDown,
    onHandlePointerDown,
  };
}

/**
 * 按下边缘手柄时按修饰键选模式。
 *
 * **⇧ = 波纹**，因为这个仓库里 ⇧ 已经表示波纹了（⇧⌫ 是波纹删除，右键菜单里写着）
 * ——同一个字母表，用户学一次。**⌘ = 卷动**：⌘ 在片段上是"加减选择"，但手柄上
 * 没有选择语义（按下就收缩成这一个），所以那个键在这里是空的。
 *
 * **⌥ 不能用**：它已经是"临时关掉磁吸"（PLAN.md 的 D2 承诺过），而裁切正是最需要
 * 磁吸的操作之一。
 *
 * 两个键一起按时**卷动优先**——它是三者里唯一不改变总片长的，误判成波纹会把后面
 * 一整排片段挪走，反过来只是少挪几个。
 */
function trimModeOf(event: { readonly shiftKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean }): TrimMode {
  if (event.metaKey || event.ctrlKey) return "roll";
  return event.shiftKey ? "ripple" : "normal";
}

/**
 * 裁切拖动中状态栏那一行。
 *
 * 普通裁切时**把另外两种模式说出来**，这是它们唯一能被发现的时机：⇧ 和 ⌘ 按在
 * 手柄上，界面上没有任何东西提示它们存在，而写进 `title` 等于没写（hover 才看得见
 * 的解释同 D3 / D44）。用户正拖着边缘的这一刻恰好就是他想要波纹的那一刻。
 *
 * 波纹和卷动时不再重复那句话，改成报"这次会动几个片段"——那是它们和普通裁切的
 * 全部区别，而幽灵已经画出来了，这行字只是把数字说准。
 */
function trimReadout(session: TrimSession, result: Computed): string {
  const delta = result.delta ?? 0;
  const signed = `${delta > 0 ? "+" : ""}${delta}f`;
  if (session.mode === "roll") return `卷动交界 ${signed}（总长不变）`;
  if (session.mode === "ripple") {
    return `波纹裁切 ${signed} · 跟着动 ${Math.max(0, result.ghosts.length - 1)} 个片段`;
  }
  return `裁切 ${signed} · ⇧ 波纹 · ⌘ 卷动`;
}

/**
 * 差分两份时间轴，给每个位置或长度变了的片段一个幽灵。
 *
 * 这是"拖拽中会发生什么"的**唯一**答案（见 `computeTrim`）。判据是占位而不是整个
 * 片段：裁入点会同时改 `sourceIn`，按深比较的话每个被裁的片段都会多报一次，而
 * 幽灵画的是矩形、位置没变就没什么可画。
 */
function diffGhosts(before: Timeline, after: Timeline): Ghost[] {
  const was = new Map<string, Clip>();
  for (const track of before.tracks) for (const clip of track.clips) was.set(clip.id, clip);

  const ghosts: Ghost[] = [];
  for (const track of after.tracks) {
    for (const clip of track.clips) {
      const old = was.get(clip.id);
      if (old && old.timelineIn === clip.timelineIn && old.timelineOut === clip.timelineOut) {
        continue;
      }
      ghosts.push({
        kind: "trim",
        clipId: clip.id,
        trackId: track.id,
        inFrame: clip.timelineIn,
        lengthFrames: clipDuration(clip),
        valid: true,
      });
    }
  }
  return ghosts;
}

/** 整组拖拽要记住每个同伴的原位置和长度。找不到就跳过（选中集合可能刚被撤销掉一部分）。 */
function findFollower(timeline: Timeline, clipId: string): Follower | null {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      return {
        clipId,
        trackId: track.id,
        originIn: clip.timelineIn,
        lengthFrames: clipDuration(clip),
      };
    }
  }
  return null;
}

/** 供 Timeline 复用：某轨道上要画哪些幽灵。 */
export function ghostsForTrack(ghosts: readonly Ghost[], trackId: TrackId): readonly Ghost[] {
  return ghosts.filter((g) => g.trackId === trackId);
}

/** 幽灵的合法性也决定了鼠标样式与提示文案。 */
export function ghostTitle(ghost: Ghost, fps: Timeline["fps"]): string {
  void fps;
  if (ghost.valid) return `落到 ${ghost.inFrame} 帧`;
  return ghost.reason ?? "这里放不下";
}
