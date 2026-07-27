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
 * 上下限和缺省值一律取自 `TRANSFORM_RANGES`，不在这里另写一份：两处夹紧规则
 * 一旦不一致，用户看到的是"输入框允许输入、松手却弹回去"。
 */

import { useState } from "react";
import { valueAt, type AnimatableProperty, type Easing } from "../anim/keyframes";
import { TEXT_STYLE_DEFAULTS } from "../compose/text-raster";
import { clipDuration, type Clip, type MediaClip, type TextClip, type Timeline } from "../edl/types";
import {
  findClip,
  PROPERTY_LABELS,
  TRANSFORM_RANGES,
  type TransformPatch,
} from "../state/operations";
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

const PROPERTY_SPECS: readonly PropertySpec[] = [
  { property: "x", label: PROPERTY_LABELS.x, suffix: "px", step: 1, digits: 1, ...RAW },
  { property: "y", label: PROPERTY_LABELS.y, suffix: "px", step: 1, digits: 1, ...RAW },
  { property: "scaleX", label: PROPERTY_LABELS.scaleX, suffix: "%", step: 1, digits: 1, ...PERCENT },
  { property: "scaleY", label: PROPERTY_LABELS.scaleY, suffix: "%", step: 1, digits: 1, ...PERCENT },
  { property: "rotation", label: PROPERTY_LABELS.rotation, suffix: "°", step: 1, digits: 1, ...DEGREES },
  { property: "opacity", label: PROPERTY_LABELS.opacity, suffix: "%", step: 1, digits: 0, ...PERCENT },
];

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
  const fallback = TRANSFORM_RANGES[property].fallback;
  const series = clip.keyframes?.[property];
  if (series && series.length > 0) return valueAt(series, offset) ?? fallback;
  return clip.transform?.[property] ?? fallback;
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

      {/* 音频片段没有画面，变换对它没有意义 */}
      {track.kind === "video" && <TransformSection clip={clip} playhead={playhead} />}
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
// 变换与关键帧
// ---------------------------------------------------------------------------

function TransformSection({
  clip,
  playhead,
}: {
  readonly clip: Clip;
  readonly playhead: number;
}) {
  const setClipTransform = useTimeline((s) => s.setClipTransform);
  const inside = playhead >= clip.timelineIn && playhead < clip.timelineOut;

  const reset = (): void => {
    const patch: TransformPatch = {};
    for (const spec of PROPERTY_SPECS) {
      (patch as Record<string, undefined>)[spec.property] = undefined;
    }
    setClipTransform(clip.id, patch);
  };

  return (
    <>
      <div className="grp-title row">
        <span>变换</span>
        <button
          type="button"
          className="mini"
          disabled={clip.transform === undefined}
          title="把静态变换恢复成默认（不动关键帧）"
          onClick={reset}
        >
          重置
        </button>
      </div>
      {!inside && (
        <p className="hint">播放头不在这个片段上，只能改静态值；打关键帧要先把播放头移进片段。</p>
      )}
      <div className="fields">
        {PROPERTY_SPECS.map((spec) => (
          <TransformRow
            key={spec.property}
            clip={clip}
            spec={spec}
            playhead={playhead}
            inside={inside}
          />
        ))}
      </div>
    </>
  );
}

function TransformRow({
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
  const range = TRANSFORM_RANGES[property];

  const commit = (display: number): void => {
    const next = spec.fromDisplay(display);
    // 有动画就改这一帧的关键帧，没有就改静态值——见文件头
    if (animated && inside) setKeyframeAt(clip.id, property, playhead, next);
    else if (!animated) setClipTransform(clip.id, { [property]: next } as TransformPatch);
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
