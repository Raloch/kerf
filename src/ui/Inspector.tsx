/**
 * 检查器：选中片段的属性编辑面板。
 *
 * 变换 / 关键帧 / 文字在这里第一次有了编辑入口。在此之前它们能存进 EDL、
 * 能被两条渲染路径读到、能被自检验证，但只能靠控制台脚本注入。
 *
 * ## 单位换算只在这一层
 *
 * EDL 里旋转存**弧度**、缩放和不透明度存**倍数**、字号存**占输出高度的比例**
 * （见 PLAN.md 的 D9 / D11）。界面上显示的是度数和百分比，换算全部收在
 * `PROPERTY_SPECS` 的 `toDisplay` / `fromDisplay` 一对函数里。散到各个输入框上
 * 迟早会出现"这个框按度算、那个框按弧度算"，而画面上只表现为"转多了"。
 *
 * ## 改的是静态值还是关键帧，取决于这个属性有没有动画
 *
 * 这是 NLE 的既定行为，也是 D10 里"静态值与关键帧并存"的直接后果：
 * 没打关键帧时输入框改的是 `clip.transform`；一旦打了，同一个输入框改的就是
 * **播放头所在那一帧**的关键帧值。于是播放头不在片段内时动画值不能改——
 * 那时"当前帧"没有意义，硬写会打出一个偏移为负的关键帧。
 *
 * 上下限和缺省值一律取自 `PROPERTY_RANGES`，不在这里另写一份：两处夹紧规则
 * 一旦不一致，用户看到的是"输入框允许输入、松手却弹回去"。
 *
 * ## 变换和调色是同一套界面
 *
 * 它们在编辑侧完全同构（静态值 / 关键帧、单位换算、重置），所以共用
 * `PropertySection` + `PropertyRow`，只在"改哪个 action、读哪个静态字段"上分岔，
 * 而那两处收在 `GROUPS` 表里。见 PLAN.md 的 D17。
 */

import { useRef, useState } from "react";
import { valueAt, type AnimatableProperty, type Easing } from "../anim/keyframes";
import { parseCubeLut } from "../compose/lut";
import { TEXT_STYLE_DEFAULTS } from "../compose/text-raster";
import {
  clipDuration,
  findLut,
  type Clip,
  type MediaClip,
  type TextClip,
  type Timeline,
  type Track,
  type TransitionKind,
} from "../edl/types";
import {
  findClip,
  isColorProperty,
  junctionInfo,
  DEFAULT_TRANSITION_KIND,
  PROPERTY_LABELS,
  PROPERTY_RANGES,
  TRANSITION_LABELS,
  TRANSITION_ORDER,
  type ColorPatch,
  type TransformPatch,
} from "../state/operations";
import { MAX_TRANSITION_FRAMES, MIN_TRANSITION_FRAMES } from "../edl/transition";
import { isShaderTransition } from "../compose/transition-shader";
import { observedCapabilities } from "../compose/backend";
import { useTimeline } from "../state/timeline-store";
import { framesToTimecode, formatDuration } from "../time/timebase";
import { IconX } from "./icons";

// ---------------------------------------------------------------------------
// 属性表
// ---------------------------------------------------------------------------

interface PropertySpec {
  readonly property: AnimatableProperty;
  readonly label: string;
  readonly suffix: string;
  /** 显示单位下的步进。 */
  readonly step: number;
  /** 显示时保留几位小数。关键帧插值会算出一长串小数，不截断的话输入框会抖。 */
  readonly digits: number;
  readonly toDisplay: (v: number) => number;
  readonly fromDisplay: (v: number) => number;
}

const RAW = { toDisplay: (v: number) => v, fromDisplay: (v: number) => v };
const PERCENT = { toDisplay: (v: number) => v * 100, fromDisplay: (v: number) => v / 100 };
/** 弧度 ⇄ 度。合成层收弧度（D9），度数只活在界面上。 */
const DEGREES = {
  toDisplay: (v: number) => (v * 180) / Math.PI,
  fromDisplay: (v: number) => (v * Math.PI) / 180,
};

const TRANSFORM_SPECS: readonly PropertySpec[] = [
  { property: "x", label: PROPERTY_LABELS.x, suffix: "px", step: 1, digits: 1, ...RAW },
  { property: "y", label: PROPERTY_LABELS.y, suffix: "px", step: 1, digits: 1, ...RAW },
  { property: "scaleX", label: PROPERTY_LABELS.scaleX, suffix: "%", step: 1, digits: 1, ...PERCENT },
  { property: "scaleY", label: PROPERTY_LABELS.scaleY, suffix: "%", step: 1, digits: 1, ...PERCENT },
  { property: "rotation", label: PROPERTY_LABELS.rotation, suffix: "°", step: 1, digits: 1, ...DEGREES },
  { property: "opacity", label: PROPERTY_LABELS.opacity, suffix: "%", step: 1, digits: 0, ...PERCENT },
];

/**
 * 调色四项。三个倍数按百分比显示（100% = 不调），色相按度数——
 * 和变换那一组用的是同一套 `toDisplay` / `fromDisplay`，单位换算不新开第二处。
 */
const COLOR_SPECS: readonly PropertySpec[] = [
  { property: "brightness", label: PROPERTY_LABELS.brightness, suffix: "%", step: 1, digits: 0, ...PERCENT },
  { property: "contrast", label: PROPERTY_LABELS.contrast, suffix: "%", step: 1, digits: 0, ...PERCENT },
  { property: "saturation", label: PROPERTY_LABELS.saturation, suffix: "%", step: 1, digits: 0, ...PERCENT },
  { property: "hue", label: PROPERTY_LABELS.hue, suffix: "°", step: 1, digits: 1, ...DEGREES },
];

/**
 * LUT 强度单独一条，**只在片段真的挂了 LUT 时才渲染**。
 *
 * 它在数据上属于调色那一组（能打关键帧，见 `COLOR_PROPERTIES`），但在界面上
 * 跟着 LUT 走——没挂 LUT 时它是个改了也没有任何效果的滑块，摆出来只会让人
 * 以为"调了没反应"。
 */
const LUT_INTENSITY_SPEC: PropertySpec = {
  property: "lutIntensity",
  label: PROPERTY_LABELS.lutIntensity,
  suffix: "%",
  step: 1,
  digits: 0,
  ...PERCENT,
};

const EASINGS: readonly { readonly value: Easing; readonly label: string }[] = [
  { value: "linear", label: "线性" },
  { value: "ease-in", label: "缓入" },
  { value: "ease-out", label: "缓出" },
  { value: "ease-in-out", label: "缓入缓出" },
  { value: "hold", label: "保持" },
];

/**
 * 某一帧上该属性**实际生效**的值。
 *
 * 和渲染路径同一个优先级：有关键帧就用求值结果，否则静态值，再否则缺省值。
 * 界面显示的必须是这个值，否则打关键帧时会把一个屏幕上根本不存在的值定下来。
 */
function effectiveValue(clip: Clip, property: AnimatableProperty, offset: number): number {
  const fallback = PROPERTY_RANGES[property].fallback;
  const series = clip.keyframes?.[property];
  if (series && series.length > 0) return valueAt(series, offset) ?? fallback;
  // 静态值存在两个字段里，去哪儿取由属性自己决定（判据同 `clearKeyframes` 的烘焙）
  const statics = isColorProperty(property) ? clip.color : clip.transform;
  return (statics as Record<string, number | undefined> | undefined)?.[property] ?? fallback;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// 面板
// ---------------------------------------------------------------------------

export function Inspector() {
  const timeline = useTimeline((s) => s.timeline());
  const selectedClipId = useTimeline((s) => s.selectedClipId);
  const playhead = useTimeline((s) => s.playhead);

  const found = selectedClipId ? findClip(timeline, selectedClipId) : undefined;
  if (!found) {
    return <p className="empty">未选中片段。点时间轴上的片段查看属性，或用时间轴工具条的「T」新建文字。</p>;
  }

  const { clip, track } = found;
  // 先落到 const 再判别：属性路径的收窄进不到 find() 的回调里
  const sourceName =
    clip.kind === "media"
      ? timeline.sources.find((s) => s.id === clip.sourceId)?.name
      : undefined;

  return (
    <>
      <div className="insp-hd">
        <span
          className="swatch"
          style={{
            background:
              clip.kind === "text"
                ? "var(--c-text-hi)"
                : track.kind === "video"
                  ? "var(--c-video-hi)"
                  : "var(--c-audio-hi)",
          }}
        />
        <div style={{ minWidth: 0 }}>
          <div className="n">
            {clip.name ?? (clip.kind === "text" ? clip.text : sourceName) ?? clip.id}
          </div>
          <div className="s">
            {clip.kind === "text" ? "文字" : track.kind === "video" ? "视频" : "音频"} · {track.id}
          </div>
        </div>
      </div>

      <div className="grp-title">时间轴位置</div>
      <div className="fields">
        <div className="f">
          <label>入点</label>
          <span className="val">{framesToTimecode(clip.timelineIn, timeline.fps)}</span>
        </div>
        <div className="f">
          <label>出点</label>
          <span className="val">{framesToTimecode(clip.timelineOut, timeline.fps)}</span>
        </div>
        <div className="f">
          <label>时长</label>
          <span className="val">
            {clipDuration(clip)} 帧 · {formatDuration(clipDuration(clip), timeline.fps)}
          </span>
        </div>
      </div>

      {clip.kind === "text" ? (
        <TextSection clip={clip} />
      ) : (
        <SourceSection clip={clip} timeline={timeline} />
      )}

      {/* 转场两种轨道都有（画面混像素、声音混增益）；变换和调色只有画面才有意义 */}
      <TransitionSection clip={clip} track={track} timeline={timeline} />
      {track.kind === "video" && (
        <>
          <PropertySection group="transform" clip={clip} playhead={playhead} />
          <PropertySection group="color" clip={clip} playhead={playhead} />
        </>
      )}
    </>
  );
}

function SourceSection({
  clip,
  timeline,
}: {
  readonly clip: MediaClip;
  readonly timeline: Timeline;
}) {
  return (
    <>
      <div className="grp-title">源片引用</div>
      <div className="fields">
        <div className="f">
          <label>源起始帧</label>
          <span className="val">{clip.sourceIn}</span>
        </div>
        <div className="f">
          <label>源时间码</label>
          <span className="val">{framesToTimecode(clip.sourceIn, timeline.fps)}</span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 入点转场
// ---------------------------------------------------------------------------

/** 新建转场的默认时长（帧）。半秒上下，是最常用的溶解长度。 */
const DEFAULT_TRANSITION_FRAMES = 16;

/**
 * 片段**入点**上的转场。挂在入场片段上，所以这一节属于右边那个片段。
 *
 * 三件事只在这里说，因为它们只有解算之后才知道，而用户输入的时长推不出来：
 * 前面有没有紧邻片段（没有就整节禁用）、**实际**窗口多长（会被两侧片段各自的
 * 一半夹住）、以及素材余量不够时两侧各短缺几帧。最后一条是刻意要显眼的——
 * 它是看得见（听得见）的降级，那种降级要标注（见 `edl/transition.ts` 文件头）。
 *
 * 可选的种类**按轨道分组**（`TRANSITION_ORDER[track.kind]`），不在这里另列名单：
 * 漏一种的表现是"新加的曲线选不到"，而那不报错。余量不足的后果两种轨道不同
 * （定格 vs 静音），所以只有措辞在这里分岔，数字仍由 `junctionInfo` 给。
 */
function TransitionSection({
  clip,
  track,
  timeline,
}: {
  readonly clip: Clip;
  readonly track: Track;
  readonly timeline: Timeline;
}) {
  const setTransition = useTimeline((s) => s.setTransition);
  const info = junctionInfo(timeline, clip.id);
  if (!info) return null;

  const { previous, transition, effectiveFrames, shortfall } = info;
  const shortfallTotal = shortfall.from + shortfall.to;
  const kinds = TRANSITION_ORDER[track.kind];
  const audio = track.kind === "audio";

  return (
    <>
      <div className="grp-title">入点转场</div>
      <div className="fields">
        <div className="f ctl wide3">
          <label>类型</label>
          {transition ? (
            <>
              <select
                value={transition.kind}
                aria-label="转场类型"
                onChange={(e) =>
                  setTransition(clip.id, {
                    kind: e.target.value as TransitionKind,
                    frames: transition.frames,
                  })
                }
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {TRANSITION_LABELS[kind]}
                  </option>
                ))}
              </select>
              <button type="button" className="mini" onClick={() => setTransition(clip.id)}>
                移除
              </button>
            </>
          ) : (
            <button
              type="button"
              className="mini"
              disabled={!previous}
              title={previous ? "" : "前面没有紧邻的片段"}
              onClick={() =>
                setTransition(clip.id, {
                  kind: DEFAULT_TRANSITION_KIND[track.kind],
                  frames: DEFAULT_TRANSITION_FRAMES,
                })
              }
            >
              {audio ? "添加交叉淡化" : "添加交叉溶解"}
            </button>
          )}
        </div>
        {transition && (
          <div className="f ctl wide3">
            <label>时长</label>
            <input
              type="range"
              min={MIN_TRANSITION_FRAMES}
              max={MAX_TRANSITION_FRAMES}
              step={2}
              value={transition.frames}
              onChange={(e) =>
                setTransition(clip.id, {
                  kind: transition.kind,
                  frames: Number(e.target.value),
                })
              }
            />
            <span className="val">{transition.frames} 帧</span>
          </div>
        )}
      </div>
      {/* 还没建过合成器时是 null（用户刚打开、预览未初始化），那时不下结论——
          报一个还没测过的能力比不报更坏。真正的闸门在导出面板上 */}
      {transition &&
        isShaderTransition(transition.kind) &&
        observedCapabilities()?.supportsEffects === false && (
          <p className="hint err">
            这台机器起不来 WebGL，这种转场画不出来（交叉溶解可以）。导出会被禁掉，
            换 Chrome / Safari，或改用交叉溶解。
          </p>
        )}
      {transition && effectiveFrames !== transition.frames && (
        <p className="hint">
          实际 {effectiveFrames} 帧：窗口以剪切点为中心左右对称，且每个片段最多借出
          自己长度的一半。
        </p>
      )}
      {shortfallTotal > 0 && (
        <p className="hint err">
          {"素材余量不足，转场里"}
          {[
            shortfall.from > 0
              ? `前一段末尾${audio ? "静音" : "定格"} ${shortfall.from} 帧`
              : null,
            shortfall.to > 0
              ? `这一段开头${audio ? "静音" : "定格"} ${shortfall.to} 帧`
              : null,
          ]
            .filter(Boolean)
            .join("、")}
          {audio
            ? "，交叉淡化会退化成单侧淡入/淡出。把两侧的入/出点各往里裁一些就能拿回真实声音。"
            : "。把两侧的入/出点各往里裁一些就能拿回真实画面。"}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 变换 / 调色与关键帧
// ---------------------------------------------------------------------------

/**
 * 两组属性共用同一套界面。
 *
 * 摆位和调色在**编辑**这一侧完全同构：同样的"有动画改关键帧、没动画改静态值"、
 * 同样的关键帧条、同样的重置。各写一套组件就会漂——今天是调色那边少了缓动下拉，
 * 明天是变换那边的重置按钮判据不一样。它们只在两处分岔（改哪个 store action、
 * 读哪个静态字段），下面用一张表把这两处收起来。
 */
type PropertyGroup = "transform" | "color";

const GROUPS: Record<
  PropertyGroup,
  {
    readonly title: string;
    readonly specs: readonly PropertySpec[];
    readonly staticsOf: (clip: Clip) => object | undefined;
    readonly resetHint: string;
  }
> = {
  transform: {
    title: "变换",
    specs: TRANSFORM_SPECS,
    staticsOf: (clip) => clip.transform,
    resetHint: "把静态变换恢复成默认（不动关键帧）",
  },
  color: {
    title: "调色",
    specs: COLOR_SPECS,
    staticsOf: (clip) => clip.color,
    resetHint: "把静态调色恢复成默认（不动关键帧）",
  },
};

function PropertySection({
  group,
  clip,
  playhead,
}: {
  readonly group: PropertyGroup;
  readonly clip: Clip;
  readonly playhead: number;
}) {
  const setClipTransform = useTimeline((s) => s.setClipTransform);
  const setClipColor = useTimeline((s) => s.setClipColor);
  const inside = playhead >= clip.timelineIn && playhead < clip.timelineOut;
  const { title, specs, staticsOf, resetHint } = GROUPS[group];

  const reset = (): void => {
    const patch: Record<string, undefined> = {};
    for (const spec of specs) patch[spec.property] = undefined;
    if (group === "color") setClipColor(clip.id, patch as ColorPatch);
    else setClipTransform(clip.id, patch as TransformPatch);
  };

  return (
    <>
      <div className="grp-title row">
        <span>{title}</span>
        <button
          type="button"
          className="mini"
          disabled={staticsOf(clip) === undefined}
          title={resetHint}
          onClick={reset}
        >
          重置
        </button>
      </div>
      {!inside && group === "transform" && (
        <p className="hint">播放头不在这个片段上，只能改静态值；打关键帧要先把播放头移进片段。</p>
      )}
      <div className="fields">
        {specs.map((spec) => (
          <PropertyRow
            key={spec.property}
            clip={clip}
            spec={spec}
            playhead={playhead}
            inside={inside}
          />
        ))}
      </div>
      {group === "color" && <LutRow clip={clip} playhead={playhead} inside={inside} />}
    </>
  );
}

/**
 * LUT：载入 / 摘掉 + 强度。
 *
 * 解析在这里同步做完再进状态层（`parseCubeLut` 抛错就原地提示），**不把文件
 * 存进 EDL**——那样预览和导出会各解析一遍，是硬规则 2 的新入口（解析器有分歧
 * 不报错，只让两边颜色差一点点）。理由见 `edl/types.ts` 的 `LutSource`。
 */
function LutRow({
  clip,
  playhead,
  inside,
}: {
  readonly clip: Clip;
  readonly playhead: number;
  readonly inside: boolean;
}) {
  const timeline = useTimeline((s) => s.timeline());
  const addLut = useTimeline((s) => s.addLut);
  const setClipLut = useTimeline((s) => s.setClipLut);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = clip.lutId ? findLut(timeline, clip.lutId) : null;

  const load = async (file: File): Promise<void> => {
    try {
      const parsed = parseCubeLut(await file.text());
      const id = `lut-${file.name}-${parsed.size}-${Date.now()}`;
      const lut = {
        id,
        name: parsed.title || file.name.replace(/\.cube$/i, ""),
        size: parsed.size,
        rgb: parsed.rgb,
      };
      addLut(lut);
      // 查表数据单独收进资产库（快照里只留元信息，见 `project-snapshot.ts`）。
      // 这一份没存上，崩溃恢复时片段会保留、只是退回不上表
      void import("../state/project-store").then(({ putLutAsset }) => putLutAsset(lut));
      setClipLut(clip.id, id);
      setError(null);
    } catch (e) {
      // 解析失败要就地说清楚，不能静默不套——用户会以为这张 LUT 就是没效果
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="fields">
        <div className="f ctl wide3">
          <label>LUT</label>
          {current ? (
            <>
              <span className="val lut-name" title={`${current.name} · ${current.size}³`}>
                {current.name} · {current.size}³
              </span>
              <button
                type="button"
                className="mini"
                title="摘掉这张 LUT（强度值保留，挂回去还是原来那个）"
                onClick={() => setClipLut(clip.id)}
              >
                移除
              </button>
            </>
          ) : (
            <button type="button" className="mini" onClick={() => fileRef.current?.click()}>
              载入 .cube
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".cube"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              // 清掉 value，否则连着选同一个文件不触发 change
              e.target.value = "";
              if (file) void load(file);
            }}
          />
        </div>
        {current && (
          <PropertyRow clip={clip} spec={LUT_INTENSITY_SPEC} playhead={playhead} inside={inside} />
        )}
      </div>
      {error && <p className="hint err">LUT 读不了：{error}</p>}
    </>
  );
}

function PropertyRow({
  clip,
  spec,
  playhead,
  inside,
}: {
  readonly clip: Clip;
  readonly spec: PropertySpec;
  readonly playhead: number;
  readonly inside: boolean;
}) {
  const setClipTransform = useTimeline((s) => s.setClipTransform);
  const setClipColor = useTimeline((s) => s.setClipColor);
  const setKeyframeAt = useTimeline((s) => s.setKeyframeAt);
  const removeKeyframeAt = useTimeline((s) => s.removeKeyframeAt);
  const clearKeyframes = useTimeline((s) => s.clearKeyframes);
  const setPlayhead = useTimeline((s) => s.setPlayhead);

  const { property } = spec;
  const offset = playhead - clip.timelineIn;
  const series = clip.keyframes?.[property] ?? [];
  const animated = series.length > 0;
  const onKeyframe = animated && series.some((k) => k.frame === offset);
  const value = effectiveValue(clip, property, offset);
  const range = PROPERTY_RANGES[property];

  const commit = (display: number): void => {
    const next = spec.fromDisplay(display);
    // 有动画就改这一帧的关键帧，没有就改静态值——见文件头
    if (animated && inside) setKeyframeAt(clip.id, property, playhead, next);
    else if (animated) return;
    else if (isColorProperty(property)) setClipColor(clip.id, { [property]: next } as ColorPatch);
    else setClipTransform(clip.id, { [property]: next } as TransformPatch);
  };

  return (
    <>
      <div className="f ctl">
        <label>{spec.label}</label>
        <NumberField
          value={spec.toDisplay(value)}
          step={spec.step}
          min={spec.toDisplay(range.min)}
          max={spec.toDisplay(range.max)}
          digits={spec.digits}
          suffix={spec.suffix}
          disabled={animated && !inside}
          title={animated && !inside ? "播放头不在片段内，动画值不可改" : spec.label}
          onCommit={commit}
        />
        <button
          type="button"
          className={`kf${onKeyframe ? " on" : animated ? " anim" : ""}`}
          disabled={!inside}
          title={
            !inside
              ? "播放头不在片段内"
              : onKeyframe
                ? "删除这一帧的关键帧"
                : `在第 ${offset} 帧打关键帧`
          }
          onClick={() =>
            onKeyframe
              ? removeKeyframeAt(clip.id, property, playhead)
              : setKeyframeAt(clip.id, property, playhead, value)
          }
        >
          <Diamond />
        </button>
      </div>

      {animated && (
        <div className="kfrow">
          <div className="kfbar" title={`${series.length} 个关键帧，点一下跳过去`}>
            {series.map((k) => {
              const span = Math.max(1, clipDuration(clip) - 1);
              const outside = k.frame < 0 || k.frame >= clipDuration(clip);
              return (
                <button
                  key={k.frame}
                  type="button"
                  className={`kfm${outside ? " out" : ""}${k.frame === offset ? " cur" : ""}`}
                  style={{ left: `${Math.max(0, Math.min(100, (k.frame / span) * 100))}%` }}
                  title={
                    outside
                      ? `第 ${k.frame} 帧（已在片段之外，裁回去还能用）`
                      : `第 ${k.frame} 帧 · ${round(spec.toDisplay(k.value), spec.digits)}${spec.suffix}`
                  }
                  onClick={() => setPlayhead(clip.timelineIn + k.frame)}
                />
              );
            })}
          </div>
          {onKeyframe && (
            <select
              className="sel"
              value={series.find((k) => k.frame === offset)?.easing ?? "linear"}
              title="这一段（到下一个关键帧）的缓动"
              onChange={(e) =>
                setKeyframeAt(clip.id, property, playhead, value, e.target.value as Easing)
              }
            >
              {EASINGS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="ib xs"
            title="关闭这个属性的动画（停在当前值）"
            onClick={() => clearKeyframes(clip.id, property, value)}
          >
            <IconX />
          </button>
        </div>
      )}
    </>
  );
}

const Diamond = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M8 2.5L13.5 8 8 13.5 2.5 8z" />
  </svg>
);

// ---------------------------------------------------------------------------
// 文字
// ---------------------------------------------------------------------------

const ALIGNS: readonly { readonly value: "left" | "center" | "right"; readonly label: string }[] = [
  { value: "left", label: "左" },
  { value: "center", label: "中" },
  { value: "right", label: "右" },
];

const WEIGHTS = [300, 400, 600, 800] as const;

function TextSection({ clip }: { readonly clip: TextClip }) {
  const setTextContent = useTimeline((s) => s.setTextContent);
  const setTextStyle = useTimeline((s) => s.setTextStyle);
  // 显示"没设过时实际长什么样"，所以要把默认值填进来
  const style = { ...TEXT_STYLE_DEFAULTS, ...clip.style };

  return (
    <>
      <div className="grp-title">文字内容</div>
      <div className="fields">
        <textarea
          className="ta"
          rows={3}
          value={clip.text}
          placeholder="输入文字，回车换行"
          onChange={(e) => setTextContent(clip.id, e.target.value)}
        />
        <div className="f ctl">
          <label>字号</label>
          <NumberField
            value={style.fontSizeRatio * 100}
            step={0.5}
            min={1}
            max={100}
            digits={1}
            suffix="%高"
            title="字号占输出画面高度的比例——换分辨率导出时字幕大小才不会变（D11）"
            onCommit={(v) => setTextStyle(clip.id, { fontSizeRatio: v / 100 })}
          />
        </div>
        <div className="f">
          <label>字重</label>
          <select
            className="sel wide"
            value={style.fontWeight}
            onChange={(e) => setTextStyle(clip.id, { fontWeight: Number(e.target.value) })}
          >
            {WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </div>
        <div className="f">
          <label>颜色</label>
          <input
            type="color"
            className="color"
            value={style.color}
            onChange={(e) => setTextStyle(clip.id, { color: e.target.value })}
          />
        </div>
        <div className="f ctl">
          <label>描边</label>
          <NumberField
            value={style.strokeRatio * 100}
            step={0.05}
            min={0}
            max={5}
            digits={2}
            suffix="%高"
            title="0 = 不描边。字幕压在亮画面上时靠它保持可读"
            onCommit={(v) => setTextStyle(clip.id, { strokeRatio: v / 100 })}
          />
          <input
            type="color"
            className="color sm"
            value={style.strokeColor}
            title="描边颜色"
            onChange={(e) => setTextStyle(clip.id, { strokeColor: e.target.value })}
          />
        </div>
        <div className="f ctl">
          <label>阴影</label>
          <NumberField
            value={style.shadowRatio * 100}
            step={0.1}
            min={0}
            max={10}
            digits={2}
            suffix="%高"
            title="投影模糊半径，0 = 不投影"
            onCommit={(v) => setTextStyle(clip.id, { shadowRatio: v / 100 })}
          />
        </div>
        <div className="f">
          <label>对齐</label>
          <div className="seg">
            {ALIGNS.map((a) => (
              <button
                key={a.value}
                type="button"
                aria-pressed={style.align === a.value}
                onClick={() => setTextStyle(clip.id, { align: a.value })}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <div className="f ctl">
          <label>行距</label>
          <NumberField
            value={style.lineHeight}
            step={0.05}
            min={0.5}
            max={3}
            digits={2}
            suffix="×"
            title="行距 ÷ 字号"
            onCommit={(v) => setTextStyle(clip.id, { lineHeight: v })}
          />
        </div>
        <div className="f ctl">
          <label>断行宽度</label>
          <NumberField
            value={style.maxWidthRatio * 100}
            step={1}
            min={5}
            max={100}
            digits={0}
            suffix="%宽"
            title="超过这个宽度自动换行"
            onCommit={(v) => setTextStyle(clip.id, { maxWidthRatio: v / 100 })}
          />
        </div>
      </div>
      <p className="hint">
        文字的位置和大小由下面的「变换」决定，样式里没有位置——两个来源必然打架（D11）。
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// 数值输入
// ---------------------------------------------------------------------------

/**
 * 带草稿态的数字输入框。
 *
 * 直接 `value={String(value)}` 的受控输入会和用户打架：输到一半的 `-`、`1.`、
 * 空串都不是合法数字，父级一重渲染就被抹掉。这里保留用户敲的原始字符串，
 * 只把**能解析出有限数**的中间态提交上去。
 *
 * 但草稿必须在**值从外面变了**的时候立刻扔掉，否则拖播放头时这个框会一直
 * 显示上次输入的数字——动画值明明在变，输入框却纹丝不动，看起来像关键帧没生效。
 * 判据是"当前值还等不等于我们自己提交出去的那个"（`echo`）：相等说明这次
 * 重渲染是自己引起的，草稿留着；不等说明播放头动了或者被夹紧了，草稿作废。
 */
function NumberField({
  value,
  step,
  min,
  max,
  digits,
  suffix,
  disabled,
  title,
  onCommit,
}: {
  readonly value: number;
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly digits: number;
  readonly suffix: string;
  readonly disabled?: boolean | undefined;
  readonly title?: string | undefined;
  readonly onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  /** 上一次由这个框提交出去的显示值。渲染期比对，见上面的注释。 */
  const [echo, setEcho] = useState<number | null>(null);
  if (draft !== null && echo !== null && round(value, digits) !== round(echo, digits)) {
    setDraft(null);
    setEcho(null);
  }
  const shown = draft ?? String(round(value, digits));

  return (
    <span className="numw" title={title ?? ""}>
      <input
        type="number"
        className="num"
        value={shown}
        step={step}
        min={min}
        max={max}
        disabled={disabled ?? false}
        onChange={(e) => {
          const text = e.target.value;
          const parsed = Number(text);
          setDraft(text);
          if (text.trim() !== "" && Number.isFinite(parsed)) {
            setEcho(parsed);
            onCommit(parsed);
          } else {
            // 空串 / 半截负号：不提交，于是外面的值不会变，草稿也就该留着
            setEcho(value);
          }
        }}
        onBlur={() => {
          setDraft(null);
          setEcho(null);
        }}
      />
      <i>{suffix}</i>
    </span>
  );
}
