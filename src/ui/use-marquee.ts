/**
 * 框选（橡皮筋）的交互状态机。
 *
 * 单独一个钩子而不是塞进 `use-clip-drag`：那边的 `Session` 是"移动 / 裁切"两态，每个分支
 * 都要判 `s.kind`，加进第三态会让每一处都长一截；而这个手势的起点不是片段而是**轨道空白**，
 * 命中测试也从"一个片段"变成"一片区域 × 几条轨"。共享的只有形状（按下 → 阈值 → 松手），
 * 而形状不值得抽象。
 *
 * 三条取舍：
 *
 * - **边拖边写选中，不等松手。** 那是这个手势唯一的反馈；选中不进撤销栈，所以每次
 *   pointermove 写一次没有代价（同播放头）。判据不在这里，在 `clipsInBox` 那个纯函数里。
 * - **垂直方向的命中测试用像素，不用轨道序号。** 关键帧轨会插在轨道之间（`.trk.kfl`），
 *   按 `tracks` 数组的下标算就会把它数进去、于是"框到第 2 条"实际选中第 3 条。做法是拿
 *   `[data-track-id]` 那些 lane 的真实矩形去和框相交——关键帧轨的 lane **刻意没有**这个属性。
 * - **而那些矩形要在按下那一刻取一次快照，不能每次 pointermove 重新量。** 这里有一个真实的
 *   反馈环：关键帧轨只在"恰好选中一个片段"时展开（D32），而框选一旦选中第二个它就收起，
 *   底下所有轨道**在拖动过程中往上跳一行**。每次重新量的话，框覆盖的轨道会跟着跳——用户
 *   看到的是"框还在原地，选中的却换了一条轨"。快照让手势自己造成的布局变化进不了判据。
 * - **低于阈值 = 点空白处，清空选中。** 而按着 ⌘ 点空白处**什么都不做**：⌘ 的含义是"加选"，
 *   加上零个应该保持原样，清空是"选了 A 拿到 B"。
 *
 * 已知取舍：拖到一半横向滚动时框会偏（锚点记的是 client 坐标）。和 `use-clip-drag` 里的
 * `startX` 是同一条，没有自动滚动所以够不到。
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { ClipId, TrackId } from "../edl/types";
import { clipsInBox } from "../state/operations";
import { useTimeline } from "../state/timeline-store";

/**
 * 小于这个像素位移算点击而不是框选。
 *
 * 和 `use-clip-drag` 的阈值同一个数、刻意不共享一个常量：那边防的是"点选片段被当成微小
 * 拖动"，这边防的是"想清空选中的手抖变成一次框选"，两件事将来可以各自调。
 */
const MARQUEE_THRESHOLD_PX = 3;

/** 框的矩形，单位是**轨道区内的像素**（左边界已经是内容原点，见 `.ph-layer`）。 */
export interface MarqueeRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MarqueeApi {
  /** 正在框选时的矩形，null = 没在框。 */
  readonly rect: MarqueeRect | null;
  /** 挂在每条轨道的 lane 上。片段自己的 pointerdown 会 `stopPropagation`，所以这里只收空白处。 */
  onLanePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** 一条轨道的垂直范围，相对轨道区顶部。**按下那一刻的快照**，见文件头。 */
interface LaneBand {
  readonly trackId: TrackId;
  readonly top: number;
  readonly bottom: number;
}

interface Session {
  /** 锚点：帧号（可以是小数，最后交给 `clipsInBox` 的是原样的浮点边界）。 */
  readonly anchorFrame: number;
  /** 锚点：相对轨道区顶部的像素。 */
  readonly anchorY: number;
  /** 内容原点的 client x（所有 lane 的左边界都在这里）。 */
  readonly originLeft: number;
  /** 轨道区顶部的 client y。 */
  readonly tracksTop: number;
  /** 按下时已经选中的那些。⌘ 框选是"加选"，所以要并上它。 */
  readonly base: readonly ClipId[];
  /** 各轨道的垂直范围，按下那一刻量的。 */
  readonly lanes: readonly LaneBand[];
  readonly startX: number;
  readonly startY: number;
}

export function useMarquee(pxPerFrame: number): MarqueeApi {
  const timeline = useTimeline((s) => s.timeline());
  const selectedClipIds = useTimeline((s) => s.selectedClipIds);
  const select = useTimeline((s) => s.select);
  const selectMany = useTimeline((s) => s.selectMany);

  const [rect, setRect] = useState<MarqueeRect | null>(null);
  const session = useRef<Session | null>(null);
  const movedEnough = useRef(false);
  /** 上一次写进 store 的选中（join 过的），用来跳过没变化的写入。 */
  const written = useRef<string>("");

  const onLanePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 只响应主键，右键留给后续的上下文菜单（同 `use-clip-drag`）
      if (event.button !== 0) return;
      const lane = event.currentTarget;
      const tracks = lane.closest<HTMLElement>(".tracks");
      if (!tracks) return;
      const laneRect = lane.getBoundingClientRect();
      const tracksRect = tracks.getBoundingClientRect();
      const additive = event.metaKey || event.ctrlKey;

      const lanes: LaneBand[] = [];
      for (const el of tracks.querySelectorAll<HTMLElement>("[data-track-id]")) {
        const id = el.dataset.trackId;
        if (id === undefined) continue;
        const r = el.getBoundingClientRect();
        lanes.push({ trackId: id, top: r.top - tracksRect.top, bottom: r.bottom - tracksRect.top });
      }

      lane.setPointerCapture(event.pointerId);
      session.current = {
        anchorFrame: (event.clientX - laneRect.left) / pxPerFrame,
        anchorY: event.clientY - tracksRect.top,
        originLeft: laneRect.left,
        tracksTop: tracksRect.top,
        base: additive ? selectedClipIds : [],
        lanes,
        startX: event.clientX,
        startY: event.clientY,
      };
      movedEnough.current = false;
      written.current = "";

      const finish = () => {
        lane.removeEventListener("pointermove", onMove);
        lane.removeEventListener("pointerup", onUp);
        lane.removeEventListener("pointercancel", onCancel);
        session.current = null;
        movedEnough.current = false;
        setRect(null);
      };

      const onMove = (e: PointerEvent) => {
        const s = session.current;
        if (!s) return;
        if (!movedEnough.current) {
          if (Math.hypot(e.clientX - s.startX, e.clientY - s.startY) < MARQUEE_THRESHOLD_PX) return;
          movedEnough.current = true;
        }

        const curFrame = (e.clientX - s.originLeft) / pxPerFrame;
        const curY = e.clientY - s.tracksTop;
        const fromFrame = Math.min(s.anchorFrame, curFrame);
        const toFrame = Math.max(s.anchorFrame, curFrame);
        const top = Math.min(s.anchorY, curY);
        const bottom = Math.max(s.anchorY, curY);

        // 垂直命中：和**按下时那份快照**相交，不重新量、也不数轨道序号（见文件头）
        const trackIds = s.lanes
          .filter((l) => l.top < bottom && top < l.bottom)
          .map((l) => l.trackId);

        setRect({
          left: fromFrame * pxPerFrame,
          top,
          width: (toFrame - fromFrame) * pxPerFrame,
          height: bottom - top,
        });

        // 只在选中真的变了时才写 store（同 `use-clip-drag` 的 `publishHint`）：框在同一批
        // 片段上继续拖时每次 pointermove 都写一遍，等于让全部片段跟着重渲染
        const next = [...new Set([...s.base, ...clipsInBox(timeline, { fromFrame, toFrame, trackIds })])];
        const key = next.join(",");
        if (key !== written.current) {
          written.current = key;
          selectMany(next);
        }
      };

      const onUp = () => {
        // 没拖动过 = 点了一下空白处：**清空选中**。按着 ⌘ 点空白处什么都不做——⌘ 的含义是
        // "加选"，加上零个应该保持原样（见文件头）
        if (!movedEnough.current && !additive) select(null);
        finish();
      };

      const onCancel = () => finish();

      lane.addEventListener("pointermove", onMove);
      lane.addEventListener("pointerup", onUp);
      lane.addEventListener("pointercancel", onCancel);
    },
    [pxPerFrame, select, selectMany, selectedClipIds, timeline],
  );

  return { rect, onLanePointerDown };
}
