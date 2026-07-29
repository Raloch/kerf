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
import {
  clipDuration,
  sourceGridFps,
  type Clip,
  type Timeline as Tl,
  type Track,
  type TrackId,
} from "../edl/types";
import { trackTransitionWindows } from "../edl/transition";
import { TRANSITION_LABELS } from "../state/operations";
import { framesToTimecode, secondsToFrameCount } from "../time/timebase";
import { toNumber } from "../time/rational";
import { useTimeline } from "../state/timeline-store";
import { ghostForTrack, useClipDrag, type ClipDragApi, type Ghost } from "./use-clip-drag";
import { buildStrip, cachedStrip, drawStrip } from "../media/thumbnails";
import {
  buildWaveform,
  cachedWaveform,
  drawVolumeEnvelope,
  drawWaveform,
  waveformSettled,
} from "../media/waveform";
import { proxyManager } from "../media/proxy-client";
import {
  ANIMATABLE_PROPERTIES,
  resolveVolume,
  type AnimatableProperty,
  type Keyframe,
} from "../anim/keyframes";
import { PROPERTY_LABELS, PROPERTY_RANGES } from "../state/operations";
import { IconCut, IconEye, IconFilm, IconLock, IconMagnet, IconMute, IconPlus, IconText, IconTrash, IconVolume, IconWave } from "./icons";

/** 片段内缩略图条高度，与 .strip 的 CSS 保持一致。 */
const STRIP_HEIGHT = 32;
/** 片段内波形高度，与 .wave 的 CSS 保持一致。 */
const WAVE_HEIGHT = 30;
/**
 * 波形和包络的颜色。写成常量而不是从 CSS 变量读：canvas 里没有 `currentColor`，
 * 读 CSS 变量要每次重绘 `getComputedStyle`（那是一次强制布局）。界面是单一深色
 * 主题（design/ 里的稿子已定稿），所以这里不需要跟着主题变。
 */
const WAVE_COLOR = "rgba(150, 235, 190, 0.55)";
const ENVELOPE_COLOR = "rgba(255, 214, 102, 0.95)";
const ENVELOPE_REF_COLOR = "rgba(255, 255, 255, 0.18)";

/**
 * 拖关键帧的启动阈值（像素），与 `use-clip-drag` 的 `DRAG_THRESHOLD_PX` 同值。
 *
 * 低于它算**点击**（跳到那一帧）。没有阈值的话，想点一下跳过去的手抖一像素
 * 就变成了一次"移动关键帧"——而那是一次进撤销栈的编辑。
 */
const KF_DRAG_THRESHOLD_PX = 3;

/** 缩放滑块的取值范围（每帧像素数 × 100）。 */
const ZOOM_MIN = 8;
const ZOOM_MAX = 200;

/** 新建文字片段的默认时长（秒）。够读完一句话，又不至于压住下一句。 */
const TEXT_CLIP_SECONDS = 3;

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
  const addTextClip = useTimeline((s) => s.addTextClip);

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
        <button
          type="button"
          className="ib sm"
          title={`在播放头新建文字片段（${TEXT_CLIP_SECONDS} 秒）`}
          onClick={() =>
            addTextClip({
              timelineIn: playhead,
              // 时长按秒定、按当前帧率换算：写死帧数会让 60fps 项目里的字幕只有一半时间
              durationFrames: Math.max(1, secondsToFrameCount(TEXT_CLIP_SECONDS, timeline.fps)),
              text: "新建文字",
            })
          }
        >
          <IconText />
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
  // 关键帧轨只给**这条轨上被选中的那个片段**展开：全都展开的话，一条有动画的
  // 字幕轨能顶出十几行，而用户此刻只在编辑一个片段
  const selected = track.clips.find((c) => c.id === selectedClipId);
  const animatedProps = selected ? animatedPropertiesOf(selected) : [];
  const [lanesOpen, setLanesOpen] = useState(true);

  return (
    <>
    <div className={`trk h-${track.kind}`}>
      <div className="th">
        <div className="lb">
          <div className="k">{track.id}</div>
          <div className="d">{track.label ?? ""}</div>
        </div>
        {/* 没有动画时这个按钮根本不出现：给每条轨挂一个永远点不出东西的开关，
            比没有开关更让人困惑 */}
        {animatedProps.length > 0 && (
          <button
            type="button"
            className="ib sm kft"
            aria-pressed={lanesOpen}
            title={
              lanesOpen
                ? "收起关键帧轨"
                : `展开关键帧轨（${animatedProps.length} 个属性有动画）`
            }
            onClick={() => setLanesOpen((v) => !v)}
          >
            <Diamond />
          </button>
        )}
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
            proxyUrl={clip.kind === "media" ? proxyUrls[clip.sourceId] : undefined}
          />
        ))}
        {/* 声音转场同样要标出来：窗口跨过剪切点，用户得能看见它占了哪一段。
            名字从 TRANSITION_LABELS 取，不写死——写死过一次「交叉溶解」，
            结果擦除和推移的提示也都说自己是溶解 */}
        {trackTransitionWindows(track.clips).map((w) => (
          <div
            key={`tr-${w.to.id}`}
            className="tr-mark"
            title={`${w.frames} 帧${TRANSITION_LABELS[w.kind]}`}
            style={{
              left: `${w.startFrame * pxPerFrame}px`,
              width: `${w.frames * pxPerFrame}px`,
            }}
          />
        ))}
        {ghost && <GhostView ghost={ghost} pxPerFrame={pxPerFrame} />}
      </div>
    </div>
    {selected && lanesOpen && (
      <KeyframeLanes clip={selected} properties={animatedProps} pxPerFrame={pxPerFrame} />
    )}
    </>
  );
}

/** 这个片段有哪些属性打了关键帧。顺序取自 `ANIMATABLE_PROPERTIES`，于是行序稳定。 */
function animatedPropertiesOf(clip: Clip): AnimatableProperty[] {
  const channels = clip.keyframes;
  if (!channels) return [];
  return ANIMATABLE_PROPERTIES.filter((p) => (channels[p]?.length ?? 0) > 0);
}

/** 拖动中的落点。`valid` 为 false = 那一帧已经有关键帧，松手不提交。 */
interface KeyframeDrag {
  readonly property: AnimatableProperty;
  /** 片段内偏移，拖动的起点。 */
  readonly from: number;
  readonly to: number;
  readonly valid: boolean;
}

/**
 * 关键帧轨：一个属性一行，钻石可以横向拖动改时间。
 *
 * 三件事是刻意的：
 *
 * - **只画选中片段的关键帧。** 关键帧属于片段，而"这一轨上所有片段的动画"叠在一行
 *   里根本读不出来（两个片段可以在同一个偏移上各有一个点）。
 * - **拖动中只画落点、松手才提交**，同 `use-clip-drag`。于是一次拖拽只进一条历史，
 *   不需要"带关键帧身份的合并键"——而关键帧的身份只有偏移，拖动中它一直在变，
 *   那种键根本立不住（D10 的重新评估条款当时担心的正是"边拖边提交"那种写法）。
 * - **落点夹回片段范围内。** 片段之外的偏移在数据上是合法的（裁入点之后还能拖回来，
 *   见 D10），但让**拖动**产生一个片段外的点，等于把它拖到用户看不见的地方。
 */
function KeyframeLanes({
  clip,
  properties,
  pxPerFrame,
}: {
  clip: Clip;
  properties: readonly AnimatableProperty[];
  pxPerFrame: number;
}) {
  const moveKeyframeAt = useTimeline((s) => s.moveKeyframeAt);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const setDragHint = useTimeline((s) => s.setDragHint);
  const [drag, setDrag] = useState<KeyframeDrag | null>(null);
  const session = useRef<{
    property: AnimatableProperty;
    from: number;
    startX: number;
    series: readonly Keyframe[];
  } | null>(null);
  const moved = useRef(false);

  const length = clipDuration(clip);

  const onDiamondDown = (
    event: ReactPointerEvent<HTMLElement>,
    property: AnimatableProperty,
    frame: number,
  ): void => {
    if (event.button !== 0) return;
    // 不冒泡到片段：否则按下钻石会连带开始拖片段
    event.stopPropagation();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    session.current = {
      property,
      from: frame,
      startX: event.clientX,
      series: clip.keyframes?.[property] ?? [],
    };
    moved.current = false;

    const compute = (e: PointerEvent): KeyframeDrag => {
      const s = session.current!;
      const delta = Math.round((e.clientX - s.startX) / pxPerFrame);
      const to = Math.max(0, Math.min(length - 1, s.from + delta));
      const occupied = to !== s.from && s.series.some((k) => k.frame === to);
      return { property: s.property, from: s.from, to, valid: !occupied };
    };

    const finish = (): void => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", finish);
      session.current = null;
      setDrag(null);
      setDragHint(null);
    };

    const onMove = (e: PointerEvent): void => {
      if (!session.current) return;
      if (!moved.current) {
        if (Math.abs(e.clientX - session.current.startX) < KF_DRAG_THRESHOLD_PX) return;
        moved.current = true;
      }
      const next = compute(e);
      setDrag(next);
      setDragHint(
        next.valid
          ? `移到第 ${next.to} 帧`
          : `第 ${next.to} 帧已经有一个关键帧了`,
      );
    };

    const onUp = (e: PointerEvent): void => {
      const s = session.current;
      if (s) {
        if (!moved.current) {
          // 没拖动就是"点一下跳过去"，同检查器里那条迷你关键帧条
          setPlayhead(clip.timelineIn + s.from);
        } else {
          const next = compute(e);
          if (next.valid) {
            moveKeyframeAt(
              clip.id,
              s.property,
              clip.timelineIn + next.from,
              clip.timelineIn + next.to,
            );
          }
        }
      }
      finish();
    };

    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", finish);
  };

  return (
    <>
      {properties.map((property) => {
        const series = clip.keyframes?.[property] ?? [];
        return (
          <div className="trk kfl" key={`kfl-${property}`}>
            <div className="th kfh">
              <span>{PROPERTY_LABELS[property]}</span>
            </div>
            <div className="lane">
              {series.map((k) => {
                // 裁入点之后落到片段外的关键帧保留着（`shiftKeyframes` 不删），
                // 要看得出它现在不生效，否则用户会以为动画坏了
                const outside = k.frame < 0 || k.frame >= length;
                const dragging = drag?.property === property && drag.from === k.frame;
                return (
                  <button
                    key={k.frame}
                    type="button"
                    className={`kfd${outside ? " out" : ""}${dragging ? " src" : ""}`}
                    style={{ left: `${(clip.timelineIn + k.frame) * pxPerFrame}px` }}
                    title={
                      outside
                        ? `第 ${k.frame} 帧（已在片段之外，裁回去还能用）`
                        : `第 ${k.frame} 帧 · 拖动改时间，点一下跳过去`
                    }
                    onPointerDown={(e) => onDiamondDown(e, property, k.frame)}
                  />
                );
              })}
              {drag?.property === property && moved.current && (
                <div
                  className={`kfd drop${drag.valid ? "" : " invalid"}`}
                  style={{ left: `${(clip.timelineIn + drag.to) * pxPerFrame}px` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** 关键帧那个菱形。和检查器里的 `.kfm` 同形，用 CSS 旋转，不用 SVG。 */
const Diamond = () => <span className="kfi" />;

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
  // 片段颜色和标签跟着**片段**类型走，不跟轨道类型：文字片段可以放在任意画面轨上
  const isText = clip.kind === "text";
  const source = clip.kind === "media" ? timeline.sources.find((s) => s.id === clip.sourceId) : undefined;
  const sourceInFrame = clip.kind === "media" ? clip.sourceIn : 0;
  const label = clip.name ?? (clip.kind === "text" ? clip.text : source?.name) ?? clip.id;
  const length = clipDuration(clip);
  const widthPx = length * pxPerFrame;
  const stripRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  // 拆成两个标量再进依赖数组：直接依赖 `clip` 会让每次任何编辑都重画所有波形
  const volumeBase = clip.kind === "media" ? clip.volume : undefined;
  const keyframes = clip.keyframes;
  const hasVolume = volumeBase !== undefined || (keyframes?.volume?.length ?? 0) > 0;

  // 缩略图只画素材片段，且只在代理就绪后——从原片抽帧比转一遍代理还慢。
  // 纯音频素材没有画面也没有代理，`source.kind` 这一判同时给出类型收窄
  useEffect(() => {
    if (kind !== "video" || source?.kind !== "av") return;
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
        sourceInFrame,
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
  }, [sourceInFrame, kind, length, proxyUrl, pxPerFrame, source, widthPx]);

  // 波形只画音频轨上的素材片段。**解原片而不是代理**（代理丢掉了音轨），所以
  // 不必等代理就绪；解不出来时缓存记 null，不会每次重绘都重试
  useEffect(() => {
    if (kind !== "audio" || !source || clip.kind !== "media") return;
    const canvas = waveRef.current;
    if (!canvas || widthPx < 8) return;

    let cancelled = false;
    const paint = (wave: ReturnType<typeof cachedWaveform>) => {
      if (cancelled) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(widthPx * dpr));
      canvas.height = Math.round(WAVE_HEIGHT * dpr);
      canvas.style.height = `${WAVE_HEIGHT}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, widthPx, WAVE_HEIGHT);

      if (wave) {
        drawWaveform(ctx, wave, {
          widthPx,
          heightPx: WAVE_HEIGHT,
          // 源片时刻按**源片自己的栅格**换算；时间轴帧率换算的是片段有多长。
          // 纯音频素材没有自己的帧率，栅格就是项目帧率（见 `sourceGridFps`），
          // 两者混用不报错，只表现成波形整体拉伸
          sourceInSeconds: sourceInFrame / toNumber(sourceGridFps(source, timeline.fps)),
          lengthSeconds: length / toNumber(timeline.fps),
          color: WAVE_COLOR,
        });
      }
      // 恒等音量不画线——每个片段都横一条毫无信息的线，反而看不出哪个调过
      if (hasVolume) {
        drawVolumeEnvelope(ctx, {
          widthPx,
          heightPx: WAVE_HEIGHT,
          lengthFrames: length,
          maxValue: PROPERTY_RANGES.volume.max,
          valueAt: (offset) => resolveVolume(volumeBase, keyframes, offset) ?? 1,
          color: ENVELOPE_COLOR,
          referenceColor: ENVELOPE_REF_COLOR,
        });
      }
    };

    if (waveformSettled(source.id)) {
      paint(cachedWaveform(source.id));
      return () => {
        cancelled = true;
      };
    }
    void buildWaveform(source.id, source.file).then(paint).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    clip.kind,
    hasVolume,
    keyframes,
    kind,
    length,
    source,
    sourceInFrame,
    timeline.fps,
    volumeBase,
    widthPx,
  ]);

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
        ["--fill" as string]: isText
          ? "var(--c-text)"
          : kind === "video"
            ? "var(--c-video)"
            : "var(--c-audio)",
        ["--band" as string]: isText
          ? "var(--c-text-hi)"
          : kind === "video"
            ? "var(--c-video-hi)"
            : "var(--c-audio-hi)",
      }}
      onPointerDown={(e) => drag.onClipPointerDown(e, clip, trackId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(clip.id);
        }
      }}
    >
      {kind === "video" && !isText && <canvas className="strip" ref={stripRef} />}
      {kind === "audio" && !isText && <canvas className="wave" ref={waveRef} />}
      <span className="lbl">
        {isText ? <IconText /> : kind === "video" ? <IconFilm /> : <IconWave />}
        {label}
      </span>
      {/* 片段太窄时藏掉帧数，否则会溢出成一团 */}
      {widthPx > 56 && <span className="len m">{length}f</span>}

      {/* 裁切手柄。窄片段也要留出可抓区域，否则短片段无法裁切 */}
      <span
        className="grip l"
        title={isText ? "裁切入点" : "裁切入点（拖动同时改变引用源片的起点）"}
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
