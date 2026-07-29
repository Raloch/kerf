/**
 * EDL（Edit Decision List）——时间轴的唯一数据来源。
 *
 * 预览和导出都从同一份 EDL 出发，经由同一个 compose() 产出画面，
 * 这是"预览与导出画面一致"的唯一保证，详见 CLAUDE.md 硬规则 2。
 *
 * 所有时间字段一律是**帧号**（整数），不是秒。M0 只用到单轨单片段，
 * 但类型按 M1/M2 的需要留好了扩展位（多轨、多片段、转场、效果）。
 */

import { COLOR_PROPERTIES, type KeyframeChannels } from "../anim/keyframes";
import { isAudioTransitionKind, type AudioTransitionKind } from "../audio/crossfade";
import type { ColorAdjust } from "../compose/color";
import type { LayerTransform } from "../compose/compositor";
import type { TextStyle } from "../compose/text-raster";
import { isShaderTransition } from "../compose/transition-shader";
import type { Rational } from "../time/rational";

export type SourceId = string;
export type ClipId = string;
export type TrackId = string;
export type LutId = string;
export type FontFamily = string;

/**
 * 导入的一个字体文件。**存字节**——注册 `FontFace` 只能用原始字节，
 * 没有"解析结果"可存（对比 `LutSource`）。
 *
 * `family` 由我们生成，**同时就是这个字体在项目里的 id**：文字样式里本来就有
 * `TextStyle.fontFamily`，再给片段加一个 `fontId` 就有了两个"这个片段用哪个字体"
 * 的真值来源，而"两个都设了听谁的"错了不报错，只表现成"选了 A 拿到 B"（硬规则 10）。
 * 族名不取自字体文件里的名字：同名不同版本会互相顶掉，表现为"改了一个片段的字体，
 * 另一个片段也跟着变了"。生成规则和"这个族名是不是我们管的"见 `compose/font-registry.ts`。
 */
export interface FontSource {
  readonly family: FontFamily;
  /** 显示名，取自文件名。 */
  readonly name: string;
  /** 字体文件字节。 */
  readonly data: ArrayBuffer;
}

/**
 * 导入的一张 3D LUT。**存的是解析结果，不是文件**。
 *
 * 与 `MediaSource` 存 `File` 的选择相反，理由是两者的解析代价完全不同：视频要
 * 按需解码、且必须流式；LUT 是一次性的几万行文本，解析结果只有几百 KB，而且
 * 预览和导出**必须拿到逐位相同的表**——存文件就意味着两个上下文各解析一遍，
 * 那是硬规则 2 的新入口（解析器有分歧不会报错，只会让两边颜色差一点点）。
 *
 * `rgb` 是 `Float32Array`，结构化克隆进 Worker 是零拷贝之外的一次内存复制，
 * 一次导出只发生一次，可以接受。
 */
export interface LutSource {
  readonly id: LutId;
  /** 显示名，取自文件名或 `.cube` 里的 TITLE。 */
  readonly name: string;
  readonly size: number;
  /** 长度 `size³ × 3`，顺序与 `.cube` 相同（红变化最快）。见 `compose/lut.ts`。 */
  readonly rgb: Float32Array;
}

/**
 * 轨道只分两条通道：**画面**和**声音**。
 *
 * 刻意**不加** `"text"`——"这一段是素材还是文字"是**片段**的属性（见 `Clip.kind`），
 * 不是轨道的属性。默认布局里的 T1 轨叫「字幕 / 标题」，那是约定俗成的摆放位置，
 * 不是类型约束：标题要能压在叠加轨上，Premiere / Resolve 也都是这么分的。
 * 一旦把文字锁进专用轨，`moveClip` 的"同类轨才能拖"检查就会把这件事直接禁掉。
 */
export type TrackKind = "video" | "audio";

/**
 * 画面转场的种类。描述的是**像素**怎么混。
 *
 * `dissolve` 走既有的图层不透明度通道（入场层画在出场层之上、alpha = 进度），
 * 因此**两个后端都画得出来、不需要任何新的合成能力**。
 *
 * 其余三种要同时采样两张纹理，只有 Pixi 后端做得了，因此归 `supportsEffects` 管
 * （判据是 `compose/transition-shader.ts` 的 `isShaderTransition()`，不要在别处
 * 另写一份"哪些算 shader 转场"的名单——漏一种的表现是导出闸门放行，用户拿到
 * 一个转场变成硬切的成片）。
 */
export type VideoTransitionKind = "dissolve" | "wipe" | "iris" | "slide" | "glitch";

/** 声音转场的种类，定义在 `audio/crossfade.ts`（曲线和它的语义在一起）。 */
export type { AudioTransitionKind };

/**
 * 转场的种类。**分画面组和声音组，由轨道种类决定哪一组合法。**
 *
 * 时间模型（窗口在哪、多长、余量够不够）两组完全共用，见 `edl/transition.ts`；
 * 分岔只发生在"这一刻拿这个进度干什么"——画面是混像素，声音是乘增益。
 *
 * 不合成一组用"音频轨上就按交叉淡化渲染"糊过去：那样用户能在音频轨上选中
 * 「圆形张开」，然后拿到一段听起来完全正常、但和他选的东西毫无关系的声音。
 * 同硬规则 10。校验有两道——`setTransition` 挡住编辑入口，`dropOrphanTransitions`
 * 在每次改动后兜底（片段不能跨轨道种类拖，所以第二道纯粹是不信任第一道）。
 */
export type TransitionKind = VideoTransitionKind | AudioTransitionKind;

/**
 * 这个种类只能挂在音频轨上。
 *
 * 从 `audio/crossfade.ts` 再导出而不是在这里另列一份名单：加一种淡化曲线时
 * 漏改这里的表现是"能选、但被归一化当成画面转场清掉"，而清掉是静默的。
 */
export function isAudioTransition(kind: TransitionKind): kind is AudioTransitionKind {
  return isAudioTransitionKind(kind);
}

/** 这个种类只能挂在画面轨上。 */
export function isVideoTransition(kind: TransitionKind): kind is VideoTransitionKind {
  return !isAudioTransitionKind(kind);
}

/** 这个种类挂在这种轨道上合法吗。**归一化和编辑入口都问这一个函数。** */
export function transitionFitsTrack(kind: TransitionKind, track: TrackKind): boolean {
  return isAudioTransitionKind(kind) === (track === "audio");
}

/**
 * 挂在两个**紧邻**片段交界上的转场。
 *
 * 存在**入场片段**（右边那个）的 `transitionIn` 上，不单独放一张表：转场天然
 * 属于一个交界，而交界由"这个片段和它的前驱"唯一确定；单独放表就要自己维护
 * 一组片段 id 引用，而片段会被移动、切分、删除——那些引用会悄悄变成孤儿。
 * 挂在片段上时，删掉片段就删掉了转场，切分时它跟着左半段走，都是对的。
 *
 * `frames` 是**请求**时长。实际窗口恒对称、恒为偶数、且被两侧片段各自的一半
 * 夹住，由 `edl/transition.ts` 的 `transitionWindow()` 算出来——**不要在别处
 * 用这个数字推窗口**。
 */
export interface Transition {
  readonly kind: TransitionKind;
  readonly frames: number;
}

/** 所有素材共有的部分。 */
interface SourceBase {
  readonly id: SourceId;
  readonly name: string;
  readonly file: File;
  /** 有没有**能解**的音轨。没有的话混流会整段跳过它（见 `audio/mix-plan.ts`）。 */
  readonly hasAudio: boolean;
  readonly audioCodec: string | null;
}

/** 带画面的素材（可能同时带声音）。 */
export interface AvSource extends SourceBase {
  readonly kind: "av";
  /** 源片自身的帧率，已吸附成有理数。 */
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  /** 源片总帧数（按 fps 换算）。 */
  readonly durationFrames: number;
  readonly videoCodec: string | null;
}

/**
 * 只有声音的素材——配乐、旁白。
 *
 * **刻意不给它 `fps` / `durationFrames` / `width` / `height`**，而不是填 0 或者
 * 编一个帧率进去。理由是 `sourceIn` 的单位不是自由的：裁入点把**时间轴帧号的增量**
 * 直接加到 `sourceIn` 上（见 `state/operations.ts` 的 `trimClip`），所以那个栅格
 * 必须就是项目帧率。存一个"导入时的项目帧率"就成了会陈旧的第二真值来源，
 * 而陈旧的表现是"裁一帧变成裁 1.2 帧"且不报错。
 *
 * 所以栅格是**派生**的，见 `sourceGridFps()`；这条派生成立的前提是项目帧率在
 * 时间轴上有片段之后不再改动，由 `addSource()` 保证。
 */
export interface AudioOnlySource extends SourceBase {
  readonly kind: "audio";
  /** 音轨解得动才让它进来，所以这里恒为 true——留着字段是让混流侧不必分岔。 */
  readonly hasAudio: true;
  /** 源片时长（整数微秒）。没有帧栅格，所以不能用帧数表达。 */
  readonly durationMicros: number;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * 一张静态图片——Logo、水印、片头卡、图片素材。
 *
 * **有尺寸但没有时间**：没有 `fps`、没有 `durationFrames`，因为一张图想在时间轴上
 * 占多久都行。这正是它不能当成"只有一帧的视频"的原因——那样裁出点就会被"源片
 * 只有一帧"挡住，而用户想要的恰恰是把它拉成 5 秒。
 *
 * `hasAudio` 恒为 false，留着字段是让混流侧那句 `!source.hasAudio` 不必分岔。
 */
export interface ImageSource extends SourceBase {
  readonly kind: "image";
  readonly hasAudio: false;
  readonly width: number;
  readonly height: number;
  /** 图片格式（`image/png` 这一类），只用来显示。 */
  readonly mimeType: string;
  /**
   * 动图的帧数，探不出来时为 null。
   *
   * 我们**只画第一帧**，所以 >1 时界面要说出来（硬规则 10：不静默降级）。探测靠
   * `ImageDecoder`，它不是所有浏览器都有——**探不出来时不许假称"是静态图"**，
   * 那和"确实是静态图"是两个结论。
   */
  readonly frameCount: number | null;
}

/**
 * 导入的素材。
 *
 * 用**判别联合**而不是"`width` / `height` 填 0"，理由同 `Clip`（见 D8）：填 0
 * 的代价是每个用到画面尺寸的地方都要先判"这个素材到底有没有画面"，而漏掉一处
 * 不会报错——代理转码会去转一个没有视频轨的文件、缩略图会画出一条空白带、
 * 而合成器会拿到一个 0×0 的图层。
 */
export type MediaSource = AvSource | AudioOnlySource | ImageSource;

/** 这个素材有画面吗（视频或图片）。画面轨上只放得下这两种。 */
export function sourceHasPicture(source: MediaSource): source is AvSource | ImageSource {
  return source.kind !== "audio";
}

/**
 * 这个素材的 `sourceIn` 用哪个帧栅格。
 *
 * 带画面的素材用它自己的帧率；纯音频素材没有帧率，用**项目帧率**——见
 * `AudioOnlySource` 的文件头。**凡是把 `sourceIn` 换算成时间的地方都要问这个函数**，
 * 直接读 `source.fps` 在纯音频素材上编译不过（那正是这个联合想要的效果）。
 */
export function sourceGridFps(source: MediaSource, timelineFps: Rational): Rational {
  return source.kind === "av" ? source.fps : timelineFps;
}

/**
 * 图片的"源片长度"。
 *
 * 一张图想在时间轴上占多久都行，所以正确答案是**没有上限**——`Number.POSITIVE_INFINITY`
 * 让裁出点那道 `usedSourceFrames > sourceLimit` 永远不成立，而这正是想要的行为。
 * 别改成一个大整数：那会在某个片长上突然变成"到源片末尾了"，而用户看不出为什么。
 *
 * 图片片段的**初始**长度是另一件事，由 `addSource()` 按 `IMAGE_DEFAULT_SECONDS` 给。
 */
export const IMAGE_SOURCE_FRAMES = Number.POSITIVE_INFINITY;

/**
 * 这个素材在自己的栅格里有多少帧——裁切的"还有没有更多素材"就是拿它判的。
 *
 * 纯音频素材用 `floor` 而不是 `round`：宁可少报一帧，也不能报出一帧解不出内容的
 * 位置（那会让裁到末尾的片段末帧静音，而静音在波形上看着就像素材本身如此）。
 */
export function sourceDurationFrames(source: MediaSource, timelineFps: Rational): number {
  if (source.kind === "av") return source.durationFrames;
  if (source.kind === "image") return IMAGE_SOURCE_FRAMES;
  return Math.max(
    1,
    Math.floor((source.durationMicros * timelineFps.num) / (timelineFps.den * 1_000_000)),
  );
}

/**
 * 所有片段共有的部分：**在时间轴上的占位**。
 *
 * `timelineIn` / `timelineOut` 左闭右开，都是帧号。移动、切分、波纹删除、磁吸
 * 只关心这几个字段，所以它们对两种片段一视同仁，不需要判别分支。
 */
interface ClipBase {
  readonly id: ClipId;
  readonly timelineIn: number;
  readonly timelineOut: number;
  /** 片段标签，缺省时 UI 回退到素材名 / 文字内容。冲突提示也用它。 */
  readonly name?: string | undefined;
  /**
   * 静态变换：位置 / 缩放 / 旋转 / 不透明度。缺省 = 铺满默认留边位置。
   *
   * 与 `keyframes` **并存**，某属性有关键帧时以关键帧为准（见 PLAN.md 的 D10）。
   * 这里存的是"用户调出来的那个值"，动画只是让它随时间变。
   */
  readonly transform?: LayerTransform;
  /**
   * 静态一级调色：亮度 / 对比度 / 饱和度 / 色相。缺省 = 不调。
   *
   * 和 `transform` 完全同构（静态值 + 关键帧并存、缺省时字段整个不存在），
   * 但**必须是两个字段**：它们作用在合成层的两个不同环节（摆位 vs 颜色），
   * 混成一个的话合成器就得靠字段名去猜这个数该进哪儿。见 PLAN.md 的 D17。
   */
  readonly color?: ColorAdjust;
  /**
   * 套用哪一张 LUT。指向 `Timeline.luts` 里的一项，缺省 = 不套。
   *
   * **只存引用，表本身放在 `Timeline.luts`**：同一张 LUT 常常要套在几十个片段上，
   * 每个片段各存一份 431KB（33³）的表既撑爆撤销栈，也让"这些片段用的是同一张表"
   * 从数据上看不出来。和 `MediaClip.sourceId` 指向 `Timeline.sources` 是同一个模式。
   *
   * 强度不在这里，在 `color.lutIntensity`——那样它就能打关键帧（见 D18）。
   */
  readonly lutId?: LutId;
  /**
   * 关键帧通道，每个属性一条独立序列。帧偏移**相对片段起点**（D10）——
   * 所以在时间轴上平移片段不需要动它，但**裁入点时要跟着平移**。
   *
   * 摆位和调色**共用这一张表**（见 `anim/keyframes.ts` 的 `ANIMATABLE_PROPERTIES`）：
   * 打点、删点、平移、撤销都与"这个属性最后作用到哪儿"无关。
   */
  readonly keyframes?: KeyframeChannels;
  /**
   * 与**前一个紧邻片段**之间的转场。缺省 = 硬切。
   *
   * 放在入场片段上而不是出场片段上，是为了让"第一个片段"天然没有转场——
   * 时间轴开头没有可以溶解过来的东西。理由与窗口算法见 `edl/transition.ts`。
   *
   * **相邻关系不由类型保证**：片段被拖开之后这个字段会变成孤儿。归一化在
   * `state/operations.ts`（每次编辑后清理），渲染侧再防一道（窗口解不出来就当没有）。
   */
  readonly transitionIn?: Transition;
}

/** 引用一段导入素材的片段。`sourceIn` 是它引用源片的起始帧。 */
export interface MediaClip extends ClipBase {
  readonly kind: "media";
  readonly sourceId: SourceId;
  readonly sourceIn: number;
  /**
   * 这个片段的音量倍数。缺省 = 1 = 原样，0 = 静音。
   *
   * **放在 `MediaClip` 上而不是 `ClipBase`**：声音只可能来自素材，文字片段没有
   * 音轨。给它一个永远无意义的音量字段就是状态层约定里那条"加可选字段来兼容
   * 两种片段"，而它的代价是每个消费点都要先判"这个片段到底有没有声音"。
   *
   * **和转场淡化是同一条增益链上的两个来源**，合成方式是相乘：淡化是交界处的
   * 形状，音量是整段的高低。相乘发生在 `audio/mixdown.ts` 的 `envelopeInput`，
   * 那里也是"恒等增益不穿 `GainNode`"这条快路径的判据所在——所以没调过音量、
   * 也没有转场的项目，混出来的 PCM 与加这个功能之前**逐样本一致**。
   */
  readonly volume?: number;
}

/**
 * 文字 / 字幕片段。没有源素材，画面由 `compose/text-raster.ts` 现场生成。
 *
 * **样式里没有位置**：文字在栅格里恒定居中，往哪儿放、放多大一律由 `transform`
 * 表达（见 text-raster.ts 的文件头）。位置有两个来源就必然打架。
 */
export interface TextClip extends ClipBase {
  readonly kind: "text";
  readonly text: string;
  /** 省略则用默认样式（白色、居中、字号占输出高度 8%）。 */
  readonly style?: TextStyle;
}

/**
 * 一张静态图片的片段。
 *
 * **有 `sourceId` 但没有 `sourceIn`**，这就是它不能并进 `MediaClip` 的全部理由：
 * `sourceId` 回答"用哪个素材"，`sourceIn` 回答"用它的哪一刻"，而一张图没有"哪一刻"。
 * 给它一个恒为 0 的 `sourceIn` 会让四件事跟着错——裁出点会被源片长度挡住、切分会
 * 徒劳地推进它、取帧会算出一个没人读的时刻、而 reader 会拿一个 PNG 去问视频轨
 * （拿到 null，于是**画面静默消失**）。同 D8 那条"不要加可选字段来兼容两种片段"。
 *
 * 也没有 `volume`：图片没有声音，同 `MediaClip.volume` 不放在 `ClipBase` 上的理由。
 */
export interface ImageClip extends ClipBase {
  readonly kind: "image";
  readonly sourceId: SourceId;
}

/**
 * 时间轴上的一个片段。
 *
 * 用**判别联合**而不是"`sourceId` 可选"：可选会把 null 处理散到每一个消费点，
 * 而且漏掉一处不会报错——只会在导出时静默少一层画面。判别联合让 TS 在
 * strict + `noUncheckedIndexedAccess` 下强制每个取源片的地方先表态。
 */
export type Clip = MediaClip | TextClip | ImageClip;

/**
 * 这个片段引用哪个素材；文字片段返回 null。
 *
 * 存在的理由是**有两种片段带 `sourceId`**（素材和图片），而"这个素材找不回来了、
 * 谁引用了它"这类问题跟种类无关。散着写 `clip.kind === "media" && …` 的地方会在
 * 加了图片之后**漏掉图片**，而漏掉的表现是：素材丢了却留着片段，渲染时才炸
 * （见 `project-snapshot.ts` 那条"素材找不回来时片段必须移除"）。
 */
export function clipSourceId(clip: Clip): SourceId | null {
  return clip.kind === "text" ? null : clip.sourceId;
}

export interface Track {
  readonly id: TrackId;
  readonly kind: TrackKind;
  readonly clips: readonly Clip[];
  /** 轨道头显示的名称，例如「主视频」「人声」。 */
  readonly label?: string | undefined;
  readonly muted?: boolean | undefined;
  readonly hidden?: boolean | undefined;
  /** 锁定后所有编辑操作被拒绝。UI 上是轨道头的锁图标。 */
  readonly locked?: boolean | undefined;
}

/** 一个项目的完整可渲染状态。不可变——改动产生新对象，以便撤销栈直接持有快照。 */
export interface Timeline {
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  /** 时间轴总长（帧）。 */
  readonly durationFrames: number;
  readonly tracks: readonly Track[];
  readonly sources: readonly MediaSource[];
  /** 导入过的 LUT。片段用 `lutId` 引用，缺省为空数组。 */
  readonly luts?: readonly LutSource[];
  /** 导入过的字体。文字片段用 `style.fontFamily` 引用，缺省为空数组。 */
  readonly fonts?: readonly FontSource[];
}

/** 导出范围，帧号，左闭右开。 */
export interface RenderRange {
  readonly inFrame: number;
  readonly outFrame: number;
}

export function clipDuration(clip: Clip): number {
  return clip.timelineOut - clip.timelineIn;
}

export function findSource(timeline: Timeline, id: SourceId): MediaSource {
  const source = timeline.sources.find((s) => s.id === id);
  if (!source) throw new Error(`EDL 引用了不存在的素材：${id}`);
  return source;
}

/** 取某轨道在指定帧处的片段；空档返回 null。 */
export function clipAt(track: Track, frame: number): Clip | null {
  for (const clip of track.clips) {
    if (frame >= clip.timelineIn && frame < clip.timelineOut) return clip;
  }
  return null;
}

/**
 * 用了 GPU 效果的片段——一级调色、LUT，或 **shader 转场**；静态值和关键帧任一算数。
 *
 * 存在的理由是**导出前的能力闸门**：这台机器起不来 WebGL 时这些效果画不出来，
 * 界面要在开始导出之前就拦下来并说明（见 `ui/ExportDialog.tsx`）。
 *
 * 判据必须**把关键帧也算进去**。只看 `clip.color` 会漏掉"静态值是缺省、全靠
 * 关键帧动"的片段——那种片段的 `color` 字段根本不存在（归一化会把全缺省的整个
 * 删掉，见 `state/operations.ts`），于是闸门放行，用户拿到一个丢了效果的成片。
 *
 * **交叉溶解不算**：它走图层不透明度，Canvas2D 也画得出来。把它一起算进去会让
 * 一个只用了溶解的项目在没有 WebGL 的机器上被无谓地禁掉导出——那是另一种形态的
 * 错误提示，和漏报一样坏。判据用 `isShaderTransition()`，不在这里另抄一份名单。
 */
export function clipsUsingEffects(timeline: Timeline): Clip[] {
  const out: Clip[] = [];
  for (const track of timeline.tracks) {
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      const animated = clip.keyframes
        ? COLOR_PROPERTIES.some((p) => (clip.keyframes?.[p]?.length ?? 0) > 0)
        : false;
      const shaderTransition =
        clip.transitionIn !== undefined && isShaderTransition(clip.transitionIn.kind);
      if (
        clip.color !== undefined ||
        clip.lutId !== undefined ||
        animated ||
        shaderTransition
      ) {
        out.push(clip);
      }
    }
  }
  return out;
}

/** 取一张 LUT；找不到返回 null（引用了已删除的 LUT 时不该整条渲染崩掉）。 */
export function findLut(timeline: Timeline, id: LutId): LutSource | null {
  return timeline.luts?.find((l) => l.id === id) ?? null;
}

/** 取一个字体；找不到返回 null。同 `findLut`：引用一个不在的字体不该让渲染崩掉。 */
export function findFont(timeline: Timeline, family: FontFamily): FontSource | null {
  return timeline.fonts?.find((f) => f.family === family) ?? null;
}

/** 把时间轴帧号换算成源片帧号。 */
export function toSourceFrame(clip: MediaClip, timelineFrame: number): number {
  return clip.sourceIn + (timelineFrame - clip.timelineIn);
}

/**
 * M0 用：把单个素材包成"单轨单片段"的时间轴。
 *
 * 时间轴帧率直接继承源片帧率——M0 不做变速和帧率转换，
 * 保证管道验证的是纯粹的 decode → compose → encode → mux。
 */
export function singleClipTimeline(
  source: AvSource,
  range?: Partial<RenderRange>,
): Timeline {
  const inFrame = Math.max(0, range?.inFrame ?? 0);
  const outFrame = Math.min(source.durationFrames, range?.outFrame ?? source.durationFrames);
  const length = Math.max(1, outFrame - inFrame);

  const videoClip: MediaClip = {
    id: "clip-v1",
    kind: "media",
    sourceId: source.id,
    timelineIn: 0,
    timelineOut: length,
    sourceIn: inFrame,
  };

  const tracks: Track[] = [
    { id: "V1", kind: "video", clips: [videoClip] },
  ];
  if (source.hasAudio) {
    tracks.push({
      id: "A1",
      kind: "audio",
      clips: [{ ...videoClip, id: "clip-a1" }],
    });
  }

  return {
    fps: source.fps,
    width: source.width,
    height: source.height,
    durationFrames: length,
    tracks,
    sources: [source],
  };
}
