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
import { formatCssColor, parseCssColor, toHexRgb } from "../compose/css-color";
import { newFontFamily, registerFont } from "../compose/font-registry";
import { parseCubeLut } from "../compose/lut";
import { TEXT_STYLE_DEFAULTS } from "../compose/text-raster";
import { decodeSizeFor } from "../compose/image-store";
import {
  clipDuration,
  clipSourceId,
  clipSpeed,
  findLut,
  SPEED_RANGE,
  type Clip,
  type ImageClip,
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
  isAudioProperty,
  staticValueOf,
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
import { rational, toNumber, type Rational } from "../time/rational";
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

/**
 * 音量一项。按百分比显示（100% = 原样），和缩放/不透明度同一套换算。
 *
 * 走 `PropertySpec` 而不是单独一个组件，是为了**白拿关键帧按钮和关键帧条**：
 * 打点 / 删点 / 跳到关键帧 / 播放头不在片段内时不可编辑，这些逻辑与"这个值最后
 * 作用到画面还是声音"完全无关。分岔只在两处——改哪个 store action（`PropertyRow`
 * 的 `commit`）、静态值读哪个字段（`staticValueOf`）。
 */
const VOLUME_SPECS: readonly PropertySpec[] = [
  { property: "volume", label: PROPERTY_LABELS.volume, suffix: "%", step: 5, digits: 0, ...PERCENT },
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
  const fallback = PROPERTY_RANGES[property].fallback;
  const series = clip.keyframes?.[property];
  if (series && series.length > 0) return valueAt(series, offset) ?? fallback;
  // 静态值存在三个地方（两个对象 + 一个标量），"存在哪儿"的判断只有 `staticValueOf`
  // 一处——同 `clearKeyframes` 的烘焙用的是同一个函数
  return staticValueOf(clip, property) ?? fallback;
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
  const sourceId = clipSourceId(clip);
  const sourceName = sourceId
    ? timeline.sources.find((s) => s.id === sourceId)?.name
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
            {clip.kind === "text"
              ? "文字"
              : clip.kind === "image"
                ? "图片"
                : track.kind === "video"
                  ? "视频"
                  : "音频"}{" "}
            · {track.id}
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
      ) : clip.kind === "image" ? (
        <ImageSection clip={clip} timeline={timeline} />
      ) : (
        <SourceSection clip={clip} timeline={timeline} />
      )}

      {/* 变速两种轨道都有：画面片段和配乐都可能要放快放慢。图片没有"源片的哪一刻"
          （见 `MediaClip.speed`），文字更没有，所以只给素材片段 */}
      {clip.kind === "media" && <SpeedSection clip={clip} timeline={timeline} />}

      {/* 转场两种轨道都有（画面混像素、声音混增益）；变换和调色只有画面才有意义 */}
      <TransitionSection clip={clip} track={track} timeline={timeline} />
      {track.kind === "video" && (
        <>
          <PropertySection group="transform" clip={clip} playhead={playhead} />
          <PropertySection group="color" clip={clip} playhead={playhead} />
        </>
      )}
      {/* 音量只在**音频轨的素材片段**上出现：`planAudioJobs` 只混音频轨，
          视频轨上的片段调了音量也不会有任何效果——那就是"能调但没用" */}
      {track.kind === "audio" && clip.kind === "media" && (
        <PropertySection group="audio" clip={clip} playhead={playhead} />
      )}
    </>
  );
}

/** 速度预设。覆盖常用档位，任意值走旁边那个输入框。 */
const SPEED_PRESETS: readonly Rational[] = [
  { num: 1, den: 4 },
  { num: 1, den: 2 },
  { num: 1, den: 1 },
  { num: 3, den: 2 },
  { num: 2, den: 1 },
  { num: 4, den: 1 },
];

/** 把倍数显示成百分比整数（2× → 200）。 */
function speedPercent(speed: Rational): number {
  return Math.round(toNumber(speed) * 100);
}

/**
 * 速度那一节（D39）。
 *
 * **改速度会改片段长度**（保内容），所以这里同时报出新长度——用户点一下 2× 之后
 * 片段在时间轴上缩短一半，不说明的话那看起来像"我的片段被吃掉了一半"。放不下时
 * `setClipSpeed` 拒绝，原因走 `lastRejection` 到状态栏（同别的编辑操作）。
 *
 * **变调提示只在真的会变调时出现**：速度不是 1× **且**这个素材有音轨。给一个无声
 * 的画面片段挂"声音会变调"是句假话，而产品里的假话要删不是补充说明（同 D37）。
 * 这条提示本身是必须的——变调是一次**看得见（听得见）的取舍**，静默变调就是硬规则 10
 * 那种"选了 A 拿到 B"；同余量不足时把定格帧数报到界面上（D19）。
 *
 * 范围从 `SPEED_RANGE` 取，**不在这里写第二份**：两处不一致时用户看到的是
 * "输入框允许、松手弹回"（同 `PROPERTY_RANGES` 那条）。
 */
function SpeedSection({
  clip,
  timeline,
}: {
  readonly clip: MediaClip;
  readonly timeline: Timeline;
}) {
  const setClipSpeed = useTimeline((s) => s.setClipSpeed);
  const speed = clipSpeed(clip);
  const percent = speedPercent(speed);
  const source = timeline.sources.find((x) => x.id === clip.sourceId);
  const frames = clip.timelineOut - clip.timelineIn;

  return (
    <>
      <div className="grp-title">速度</div>
      <div className="speed-presets">
        {SPEED_PRESETS.map((preset) => {
          const active = preset.num * speed.den === speed.num * preset.den;
          return (
            <button
              key={`${preset.num}/${preset.den}`}
              type="button"
              className={active ? "on" : undefined}
              onClick={() => setClipSpeed(clip.id, preset)}
            >
              {toNumber(preset)}×
            </button>
          );
        })}
      </div>
      <div className="fields">
        <div className="f">
          <label>倍数</label>
          {/* 复用 `NumberField`：那条"外部值变化时要丢掉草稿"的纪律只该有一处实现，
              手搓一个的话点了预设之后输入框还显示上次输入的数字（踩过一次） */}
          <NumberField
            value={percent}
            step={5}
            min={Math.round(SPEED_RANGE.min * 100)}
            max={Math.round(SPEED_RANGE.max * 100)}
            digits={0}
            suffix="%"
            title="百分比。100% = 原速"
            onCommit={(next) => setClipSpeed(clip.id, rational(Math.round(next), 100))}
          />
        </div>
        <div className="f">
          <label>片段长度</label>
          <span className="val">
            {frames} 帧 · {framesToTimecode(frames, timeline.fps)}
          </span>
        </div>
      </div>
      {percent !== 100 && source?.hasAudio === true && (
        <p className="hint">声音会跟着变调（变速用的是重采样）。画面不受影响。</p>
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

/**
 * 图片片段那一节。
 *
 * **没有"源起始帧"**：一张图没有"哪一刻"，那一行会是个恒为 0 的谜。
 *
 * 有的是**解码尺寸**，而且只在它小于原图时才出现——那是一次看得见的画质取舍
 * （见 `compose/image-store.ts` 的 `MAX_OVERSAMPLE`），静默缩掉就是硬规则 10。
 *
 * 尺寸**直接算，不去问缓存**（`decodeSizeFor` 是纯函数）。第一版读的是
 * `decodedImage()` 的结果，于是渲染那一刻还没解好就什么都不显示，而解好之后
 * 没有任何东西触发重渲——那条"看得见的降级"实际上**看不见**，实测 6000×4000
 * 的图只显示了原图尺寸。要说的本来就是"我们会把它解成多大"，那不需要等。
 */
function ImageSection({
  clip,
  timeline,
}: {
  readonly clip: ImageClip;
  readonly timeline: Timeline;
}) {
  const source = timeline.sources.find((s) => s.id === clip.sourceId);
  if (!source || source.kind !== "image") return null;
  const size = decodeSizeFor(source.width, source.height, timeline.width, timeline.height);
  const shrunk = size.width < source.width;
  return (
    <>
      <div className="grp-title">图片</div>
      <div className="fields">
        <div className="f">
          <label>原图尺寸</label>
          <span className="val">
            {source.width}×{source.height}
          </span>
        </div>
        {shrunk && (
          <div className="f">
            <label>解码尺寸</label>
            <span className="val" title="为省内存按输出分辨率的 2 倍上限缩过；放大超过 200% 会偏软">
              {size.width}×{size.height}
            </span>
          </div>
        )}
        {source.frameCount !== null && source.frameCount > 1 && (
          <div className="f">
            <label>动图</label>
            <span className="val">{source.frameCount} 帧，只用第一帧</span>
          </div>
        )}
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
type PropertyGroup = "transform" | "color" | "audio";

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
  audio: {
    title: "音量",
    specs: VOLUME_SPECS,
    // 音量的静态值是标量，这里只是把"动过没有"包成 staticsOf 要的形状
    // （它唯一的用处是重置按钮的可用状态）
    staticsOf: (clip) =>
      clip.kind === "media" && clip.volume !== undefined ? { volume: clip.volume } : undefined,
    resetHint: "把音量恢复成 100%（不动关键帧）",
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
  const setClipVolume = useTimeline((s) => s.setClipVolume);
  const inside = playhead >= clip.timelineIn && playhead < clip.timelineOut;
  const { title, specs, staticsOf, resetHint } = GROUPS[group];

  const reset = (): void => {
    // 音量没有"一组属性"，重置就是设回缺省值本身
    if (group === "audio") {
      setClipVolume(clip.id, PROPERTY_RANGES.volume.fallback);
      return;
    }
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
      {group === "audio" && <GainReadout clip={clip} playhead={playhead} />}
    </>
  );
}

/**
 * 音量的 dB 读数。**跟着播放头走**——有包络时它显示的是这一帧实际生效的增益，
 * 所以拖播放头能看出曲线在动。
 *
 * dB 是音频里唯一有意义的刻度（50% 听起来不是"一半响"），而百分比是拖动时好用的
 * 那个。两个一起给，不用其中一个替掉另一个。放大时标出削波风险：Web Audio 到
 * 编码器那一步是**硬截断、不报错**，只表现为"声音变糊了"。
 */
function GainReadout({ clip, playhead }: { readonly clip: Clip; readonly playhead: number }) {
  const volume = effectiveValue(clip, "volume", playhead - clip.timelineIn);
  return (
    <div className="fields">
      <div className="f">
        <label>增益</label>
        <span className="val">
          {volume === 0 ? "静音" : `${volume > 1 ? "+" : ""}${round(20 * Math.log10(volume), 1)} dB`}
          {volume > 1 ? " · 可能削波" : ""}
        </span>
      </div>
    </div>
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
  const setClipVolume = useTimeline((s) => s.setClipVolume);
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
    else if (isAudioProperty(property)) setClipVolume(clip.id, next);
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

/**
 * 可选的系统字体族。**存的是整条兜底链**，不是单个族名——列表里哪一款装在哪台机器上
 * 说不准，写死一个族名会在别的系统上静默换成别的字。
 */
const SYSTEM_FONTS: readonly { readonly value: string; readonly label: string }[] = [
  { value: TEXT_STYLE_DEFAULTS.fontFamily, label: "系统无衬线" },
  { value: '"Songti SC", "Noto Serif CJK SC", "SimSun", serif', label: "系统衬线" },
  { value: '"SF Mono", "Menlo", "Consolas", monospace', label: "系统等宽" },
];

/**
 * 字体：系统族 + 导入的字体，同一个下拉框里选。
 *
 * 导入的顺序是纪律：**先 `registerFont()` 成功，再 `addFont()` 进 EDL，最后才
 * 挂到片段上**。反过来的话中间那一瞬 EDL 里有一个本上下文用不了的族名，而预览随时
 * 可能在那一瞬渲染——`rasterizeText` 会抛。完整理由见 `compose/font-registry.ts`。
 *
 * 字节单独收进资产库（快照里只留元信息）。那一份没存上的后果是崩溃恢复时字体装不
 * 回来、相关文字退回默认字体，恢复面板会报出来。
 */
function FontRow({ clip }: { readonly clip: TextClip }) {
  const timeline = useTimeline((s) => s.timeline());
  const addFont = useTimeline((s) => s.addFont);
  const setTextStyle = useTimeline((s) => s.setTextStyle);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = clip.style?.fontFamily ?? TEXT_STYLE_DEFAULTS.fontFamily;
  const fonts = timeline.fonts ?? [];

  const load = async (file: File): Promise<void> => {
    try {
      const data = await file.arrayBuffer();
      const font = { family: newFontFamily(Date.now()), name: file.name, data };
      // 装不上就在这里抛（字节不是字体、或这个上下文没有 FontFaceSet），
      // 于是 EDL 里永远不会出现一个用不了的族名
      await registerFont(font);
      addFont(font);
      void import("../state/project-store").then(({ putFontAsset }) => putFontAsset(font));
      setTextStyle(clip.id, { fontFamily: font.family });
      setError(null);
    } catch (e) {
      // 读不了要就地说清楚：静默回退到默认字体正是这一整套要消灭的东西
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="f ctl wide3">
        <label>字体</label>
        <select
          className="sel wide"
          value={current}
          title="导入的字体会被崩溃恢复保住；导出时它会装进导出线程，成片和预览用同一份字形"
          onChange={(e) => setTextStyle(clip.id, { fontFamily: e.target.value })}
        >
          {SYSTEM_FONTS.map((f) => (
            <option key={f.label} value={f.value}>
              {f.label}
            </option>
          ))}
          {fonts.map((f) => (
            <option key={f.family} value={f.family}>
              {f.name}
            </option>
          ))}
          {/* 系统族之外、又不在项目字体里的值（比如手改过的 EDL）也要显示出来，
              否则下拉框会看起来停在"系统无衬线"而实际不是 */}
          {!SYSTEM_FONTS.some((f) => f.value === current) &&
            !fonts.some((f) => f.family === current) && <option value={current}>{current}</option>}
        </select>
        <button
          type="button"
          className="mini"
          title="导入 .ttf / .otf / .woff2"
          onClick={() => fileRef.current?.click()}
        >
          导入…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".ttf,.otf,.ttc,.woff,.woff2,font/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            // 清掉 value，否则连着选同一个文件不触发 change
            e.target.value = "";
            if (file) void load(file);
          }}
        />
      </div>
      {error && <p className="hint err">字体装不上：{error}</p>}
    </>
  );
}

/**
 * 带不透明度的颜色行：`input[type=color]` 管 RGB，旁边一个百分比管 alpha。
 *
 * 为什么要拆成两个控件：**`input[type=color]` 吐不出 alpha**，而阴影颜色不带 alpha
 * 就没法用（缺省本来就是半透明黑）。原生控件里没有带 alpha 的取色器，自绘一个
 * 色轮属于 §9 里推后的东西，所以拆成"原生取色器 + 一个百分比"——两个控件都是原生的、
 * 都能用键盘输入，而且拼装规则收在 `css-color.ts` 一处。
 *
 * 认不出的字符串（手改过 EDL）**不静默改掉**：控件按缺省值显示，但只有用户真的动了
 * 才会写回去。同"带草稿态的受控输入"那条——显示归显示，提交归提交。
 */
function RgbaRow({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (next: string) => void;
}) {
  const parsed = parseCssColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  return (
    <div className="f ctl">
      <label>{label}</label>
      {/* 顺序和「描边」那一行一致：数字在前占满，小色块收在末尾。
          色块用 `.color`（宽度 100%）的话不透明度输入框会被挤成一条缝 */}
      <NumberField
        value={parsed.a * 100}
        step={5}
        min={0}
        max={100}
        digits={0}
        suffix="%不透明"
        title="不透明度。0 = 完全透明（等于没有阴影）"
        onCommit={(v) => onCommit(formatCssColor({ ...parsed, a: v / 100 }))}
      />
      <input
        type="color"
        className="color sm"
        value={toHexRgb(parsed)}
        title={parseCssColor(value) ? value : `认不出这个颜色：${value}`}
        onChange={(e) => {
          const rgb = parseCssColor(e.target.value);
          // 原生取色器只会给出 `#rrggbb`，解析不出来说不通；解析不出就什么都不做，
          // 而不是把 alpha 悄悄丢掉
          if (rgb) onCommit(formatCssColor({ ...rgb, a: parsed.a }));
        }}
      />
    </div>
  );
}

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
        <FontRow clip={clip} />
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
        {/* 只在真的有阴影时才出现：模糊半径是 0 时调它的颜色毫无效果，
            而一个"调了没反应"的控件比没有这个控件更让人困惑 */}
        {style.shadowRatio > 0 && (
          <RgbaRow
            label="阴影颜色"
            value={style.shadowColor}
            onCommit={(v) => setTextStyle(clip.id, { shadowColor: v })}
          />
        )}
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
