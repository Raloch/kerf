/**
 * 多轨时间轴。
 *
 * 像素与帧的换算集中在这里：`pxPerFrame`（CSS 变量 --pxf）是唯一的换算系数，
 * 所有位置都由帧号乘它算出。**不允许**任何地方缓存像素值再反推帧号——
 * 那是缩放后位置错乱的根源。
 *
 * 本步只做渲染 + 点选 + 播放头，拖拽/裁切留在 M1 子步骤 3（复用 operations.ts）。
 */

import { useCallback, useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { clipDuration, type Clip, type Timeline as Tl, type Track } from "../edl/types";
import { framesToTimecode } from "../time/timebase";
import { toNumber } from "../time/rational";
import { useTimeline } from "../state/timeline-store";
import { IconCut, IconEye, IconFilm, IconLock, IconMagnet, IconMute, IconPlus, IconTrash, IconVolume, IconWave } from "./icons";

/** 缩放滑块的取值范围（每帧像素数 × 100）。 */
const ZOOM_MIN = 8;
const ZOOM_MAX = 200;

export function TimelinePanel() {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const selectedClipId = useTimeline((s) => s.selectedClipId);
  const snapEnabled = useTimeline((s) => s.snapEnabled);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const select = useTimeline((s) => s.select);
  const toggleSnap = useTimeline((s) => s.toggleSnap);
  const splitAtPlayhead = useTimeline((s) => s.splitAtPlayhead);
  const removeSelected = useTimeline((s) => s.removeSelected);
  const zoom = useTimeline((s) => s.zoom);
  const setZoom = useTimeline((s) => s.setZoom);

  const pxPerFrame = zoom / 100;
  const ticksRef = useRef<HTMLDivElement>(null);

  // 时间轴至少铺满可视宽度，否则空项目时标尺是一条短线
  const contentWidth = Math.max(1, timeline.durationFrames) * pxPerFrame;

  const scrubTo = useCallback(
    (clientX: number) => {
      const el = ticksRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPlayhead((clientX - rect.left + el.scrollLeft) / pxPerFrame);
    },
    [pxPerFrame, setPlayhead],
  );

  const onRulerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      scrubTo(event.clientX);
    },
    [scrubTo],
  );

  const onRulerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // 只有按住时才擦洗；e.buttons 的位 0 表示主键
      if ((event.buttons & 1) === 1) scrubTo(event.clientX);
    },
    [scrubTo],
  );

  return (
    <div className="tl" style={{ ["--pxf" as string]: String(pxPerFrame) }}>
      <div className="tl-bar">
        <button
          type="button"
          className="ib sm"
          aria-pressed={snapEnabled}
          title={snapEnabled ? "磁吸已开启（拖拽时按住 ⌥ 临时关闭）" : "磁吸已关闭"}
          onClick={toggleSnap}
        >
          <IconMagnet />
        </button>
        <button
          type="button"
          className="ib sm"
          title="在播放头切分 ⌘K"
          onClick={() => splitAtPlayhead()}
        >
          <IconCut />
        </button>
        <button
          type="button"
          className="ib sm"
          title="删除选中片段 ⌫"
          disabled={!selectedClipId}
          onClick={() => removeSelected(false)}
        >
          <IconTrash />
        </button>
        <span className="sep" />
        <button type="button" className="ib sm" title="新建轨道（M1 后续）" disabled>
          <IconPlus />
        </button>

        <div className="spacer" />

        <span className="chip m">
          {timeline.durationFrames} 帧 · {toNumber(timeline.fps).toFixed(2)} fps
        </span>
        <span className="sep" />
        <label className="zoom">
          <span>缩放</span>
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            value={zoom}
            aria-label="时间轴缩放"
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="tl-scroll">
        <div className="tl-inner" style={{ width: `calc(var(--head-w) + ${contentWidth}px)` }}>
          <div className="ruler">
            <div className="rh">
              <span>时间码</span>
            </div>
            <div
              className="ticks"
              ref={ticksRef}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              role="slider"
              tabIndex={0}
              aria-label="播放头位置"
              aria-valuemin={0}
              aria-valuemax={timeline.durationFrames}
              aria-valuenow={playhead}
              aria-valuetext={framesToTimecode(playhead, timeline.fps)}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setPlayhead(playhead - 1);
                if (e.key === "ArrowRight") setPlayhead(playhead + 1);
              }}
            >
              <Ticks timeline={timeline} pxPerFrame={pxPerFrame} />
              <div
                className="playhead ph-head"
                style={{ left: `${playhead * pxPerFrame}px` }}
              />
            </div>
          </div>

          <div className="tracks">
            {timeline.tracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                timeline={timeline}
                pxPerFrame={pxPerFrame}
                selectedClipId={selectedClipId}
                onSelect={select}
              />
            ))}
            <div className="ph-layer">
              <div className="playhead" style={{ left: `${playhead * pxPerFrame}px` }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 标尺刻度。
 *
 * 间隔按缩放自适应：候选秒数里挑第一个"主刻度间距 ≥ 62px"的，
 * 否则缩小时标签会糊成一片。次刻度是主刻度的 1/5。
 */
function Ticks({ timeline, pxPerFrame }: { timeline: Tl; pxPerFrame: number }) {
  const fps = toNumber(timeline.fps);

  const marks = useMemo(() => {
    const step =
      [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * fps * pxPerFrame >= 62) ?? 600;
    const minorFrames = Math.max(1, Math.round((step * fps) / 5));
    // 空项目或短片时刻度也要铺满可视区，否则标尺是一小截断线。
    // 用固定的 2400px 作为"够宽"的近似，避免为了拿容器宽度引入 ResizeObserver。
    const total = Math.max(timeline.durationFrames, Math.ceil(2400 / pxPerFrame));
    const out: { frame: number; major: boolean }[] = [];
    for (let f = 0; f <= total; f += minorFrames) {
      out.push({ frame: f, major: Math.round(f / minorFrames) % 5 === 0 });
    }
    return out;
  }, [fps, pxPerFrame, timeline.durationFrames]);

  return (
    <>
      {marks.map(({ frame, major }) => (
        <div
          key={frame}
          className={major ? "tick maj" : "tick min"}
          style={{ left: `${frame * pxPerFrame}px` }}
        />
      ))}
      {marks
        .filter((m) => m.major)
        .map(({ frame }) => (
          <div key={`l${frame}`} className="tick-lbl" style={{ left: `${frame * pxPerFrame}px` }}>
            {framesToTimecode(frame, timeline.fps).slice(3, 8)}
          </div>
        ))}
    </>
  );
}

function TrackRow({
  track,
  timeline,
  pxPerFrame,
  selectedClipId,
  onSelect,
}: {
  track: Track;
  timeline: Tl;
  pxPerFrame: number;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
}) {
  const isAudio = track.kind === "audio";
  return (
    <div className={`trk h-${track.kind}`}>
      <div className="th">
        <div className="lb">
          <div className="k">{track.id}</div>
          <div className="d">{track.label ?? ""}</div>
        </div>
        <button
          type="button"
          className="ib sm"
          aria-pressed={isAudio ? Boolean(track.muted) : Boolean(track.hidden)}
          title={isAudio ? "静音" : "隐藏"}
          disabled
        >
          {isAudio ? track.muted ? <IconMute /> : <IconVolume /> : <IconEye />}
        </button>
        <button
          type="button"
          className="ib sm"
          aria-pressed={Boolean(track.locked)}
          title="锁定"
          disabled
        >
          <IconLock />
        </button>
      </div>
      <div className="lane">
        {track.clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            timeline={timeline}
            kind={track.kind}
            pxPerFrame={pxPerFrame}
            selected={clip.id === selectedClipId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function ClipView({
  clip,
  timeline,
  kind,
  pxPerFrame,
  selected,
  onSelect,
}: {
  clip: Clip;
  timeline: Tl;
  kind: "video" | "audio";
  pxPerFrame: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  const label = clip.name ?? source?.name ?? clip.id;
  const length = clipDuration(clip);

  return (
    <button
      type="button"
      className="clip"
      role="option"
      aria-selected={selected}
      title={`${label} · ${framesToTimecode(clip.timelineIn, timeline.fps)} → ${framesToTimecode(clip.timelineOut, timeline.fps)}`}
      style={{
        left: `${clip.timelineIn * pxPerFrame}px`,
        width: `${length * pxPerFrame}px`,
        ["--fill" as string]: kind === "video" ? "var(--c-video)" : "var(--c-audio)",
        ["--band" as string]: kind === "video" ? "var(--c-video-hi)" : "var(--c-audio-hi)",
      }}
      onClick={() => onSelect(clip.id)}
    >
      <span className="lbl">
        {kind === "video" ? <IconFilm /> : <IconWave />}
        {label}
      </span>
      {/* 片段太窄时藏掉帧数，否则会溢出成一团 */}
      {length * pxPerFrame > 56 && <span className="len m">{length}f</span>}
    </button>
  );
}
