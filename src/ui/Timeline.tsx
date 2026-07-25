/**
 * 多轨时间轴。
 *
 * 像素与帧的换算集中在这里：`pxPerFrame`（CSS 变量 --pxf）是唯一的换算系数，
 * 所有位置都由帧号乘它算出。**不允许**任何地方缓存像素值再反推帧号——
 * 那是缩放后位置错乱的根源。
 *
 * 本步只做渲染 + 点选 + 播放头，拖拽/裁切留在 M1 子步骤 3（复用 operations.ts）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { clipDuration, type Clip, type Timeline as Tl, type Track, type TrackId } from "../edl/types";
import { framesToTimecode } from "../time/timebase";
import { toNumber } from "../time/rational";
import { useTimeline } from "../state/timeline-store";
import { ghostForTrack, useClipDrag, type ClipDragApi, type Ghost } from "./use-clip-drag";
import { buildStrip, cachedStrip, drawStrip } from "../media/thumbnails";
import { proxyManager } from "../media/proxy-client";
import { IconCut, IconEye, IconFilm, IconLock, IconMagnet, IconMute, IconPlus, IconTrash, IconVolume, IconWave } from "./icons";

/** 片段内缩略图条高度，与 .strip 的 CSS 保持一致。 */
const STRIP_HEIGHT = 32;

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
  const drag = useClipDrag(pxPerFrame);

  /**
   * 代理就绪的 URL 表。
   *
   * 必须在这里订阅并往下传：缩略图的 effect 需要"代理状态"作为依赖，
   * 否则代理转好时片段不会重跑 effect，缩略图永远不出现（踩过）。
   */
  const [proxyUrls, setProxyUrls] = useState<Record<string, string>>({});
  useEffect(
    () =>
      proxyManager.subscribe((sourceId, info) => {
        if (info.status !== "ready" || !info.url) return;
        setProxyUrls((prev) => (prev[sourceId] === info.url ? prev : { ...prev, [sourceId]: info.url! }));
      }),
    [],
  );

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
                drag={drag}
                proxyUrls={proxyUrls}
              />
            ))}
            <div className="ph-layer">
              <div className="playhead" style={{ left: `${playhead * pxPerFrame}px` }} />
              {/* 吸附辅助线：贯穿所有轨道，让用户看清贴住了什么 */}
              {drag.snapLine !== null && (
                <div className="snapline" style={{ left: `${drag.snapLine * pxPerFrame}px` }} />
              )}
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
  drag,
  proxyUrls,
}: {
  track: Track;
  timeline: Tl;
  pxPerFrame: number;
  selectedClipId: string | null;
  onSelect: (id: string) => void;
  drag: ClipDragApi;
  proxyUrls: Record<string, string>;
}) {
  const isAudio = track.kind === "audio";
  const ghost = ghostForTrack(drag.ghost, track.id);
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
      {/* data-track-id 供拖拽时做几何命中测试，判断落在哪条轨道 */}
      <div className="lane" data-track-id={track.id}>
        {track.clips.map((clip) => (
          <ClipView
            key={clip.id}
            clip={clip}
            timeline={timeline}
            kind={track.kind}
            trackId={track.id}
            pxPerFrame={pxPerFrame}
            selected={clip.id === selectedClipId}
            onSelect={onSelect}
            drag={drag}
            proxyUrl={proxyUrls[clip.sourceId]}
          />
        ))}
        {ghost && <GhostView ghost={ghost} pxPerFrame={pxPerFrame} />}
      </div>
    </div>
  );
}

/**
 * 落点预览。只用颜色区分合法/非法——非法原因由状态栏显示，
 * 因为片段窄时（默认缩放下 180 帧只有 75px）幽灵里根本装不下文字。
 */
function GhostView({ ghost, pxPerFrame }: { ghost: Ghost; pxPerFrame: number }) {
  return (
    <div
      className={`ghost${ghost.valid ? "" : " invalid"}`}
      style={{
        left: `${ghost.inFrame * pxPerFrame}px`,
        width: `${ghost.lengthFrames * pxPerFrame}px`,
      }}
    />
  );
}

function ClipView({
  clip,
  timeline,
  kind,
  trackId,
  pxPerFrame,
  selected,
  onSelect,
  drag,
  proxyUrl,
}: {
  clip: Clip;
  timeline: Tl;
  kind: "video" | "audio";
  trackId: TrackId;
  pxPerFrame: number;
  selected: boolean;
  onSelect: (id: string) => void;
  drag: ClipDragApi;
  proxyUrl: string | undefined;
}) {
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  const label = clip.name ?? source?.name ?? clip.id;
  const length = clipDuration(clip);
  const widthPx = length * pxPerFrame;
  const stripRef = useRef<HTMLCanvasElement>(null);

  // 缩略图只画视频片段，且只在代理就绪后——从原片抽帧比转一遍代理还慢
  useEffect(() => {
    if (kind !== "video" || !source) return;
    const canvas = stripRef.current;
    if (!canvas || widthPx < 24) return;

    let cancelled = false;
    const paint = (strip: ReturnType<typeof cachedStrip>) => {
      if (cancelled || !strip) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const h = STRIP_HEIGHT;
      canvas.width = Math.max(1, Math.round(widthPx * dpr));
      canvas.height = Math.round(h * dpr);
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      drawStrip(ctx, strip, {
        widthPx,
        heightPx: h,
        sourceInFrame: clip.sourceIn,
        lengthFrames: length,
      });
    };

    const cached = cachedStrip(source.id);
    if (cached) {
      paint(cached);
      return () => {
        cancelled = true;
      };
    }

    if (!proxyUrl) return;
    // 用代理的 blob URL 取回 File 再抽帧
    void fetch(proxyUrl)
      .then((r) => r.blob())
      .then((blob) => buildStrip(source.id, new File([blob], `${source.id}-proxy.mp4`), source.durationFrames))
      .then(paint)
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [clip.sourceIn, kind, length, proxyUrl, pxPerFrame, source, widthPx]);

  return (
    <div
      className="clip"
      role="option"
      tabIndex={0}
      aria-selected={selected}
      title={`${label} · ${framesToTimecode(clip.timelineIn, timeline.fps)} → ${framesToTimecode(clip.timelineOut, timeline.fps)}`}
      style={{
        left: `${clip.timelineIn * pxPerFrame}px`,
        width: `${widthPx}px`,
        ["--fill" as string]: kind === "video" ? "var(--c-video)" : "var(--c-audio)",
        ["--band" as string]: kind === "video" ? "var(--c-video-hi)" : "var(--c-audio-hi)",
      }}
      onPointerDown={(e) => drag.onClipPointerDown(e, clip, trackId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(clip.id);
        }
      }}
    >
      {kind === "video" && <canvas className="strip" ref={stripRef} />}
      <span className="lbl">
        {kind === "video" ? <IconFilm /> : <IconWave />}
        {label}
      </span>
      {/* 片段太窄时藏掉帧数，否则会溢出成一团 */}
      {widthPx > 56 && <span className="len m">{length}f</span>}

      {/* 裁切手柄。窄片段也要留出可抓区域，否则短片段无法裁切 */}
      <span
        className="grip l"
        title="裁切入点（拖动同时改变引用源片的起点）"
        onPointerDown={(e) => drag.onHandlePointerDown(e, clip, trackId, "in")}
      />
      <span
        className="grip r"
        title="裁切出点"
        onPointerDown={(e) => drag.onHandlePointerDown(e, clip, trackId, "out")}
      />
    </div>
  );
}
