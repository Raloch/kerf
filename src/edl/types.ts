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
import type { CropInsets, LayerTransform } from "../compose/compositor";
import type { TextStyle } from "../compose/text-raster";
import { isShaderTransition } from "../compose/transition-shader";
import type { Rational } from "../time/rational";
import { regridFrames, regridFramesNeeded } from "../time/timebase";

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

/**
 * **分配式 `Omit`。** `Omit<A | B, K>` 会先把联合塌成"两边共有的字段"再去掉 K，
 * 而那会让 `MediaSource` 只剩 id / name / kind / hasAudio / audioCodec——帧率、
 * 尺寸、时长全部消失，且**不报错**。理由展开见 `project-snapshot.ts` 的 `SourceMeta`。
 */
export type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;

/**
 * 素材去掉文件之后的样子——快照里存的就是它（`SourceMeta`）。
 *
 * 帧栅格的派生（`sourceGridFps` / `sourceDurationFrames`）**只认判别字段和时长，
 * 不需要文件**，所以那两个函数收这个更宽的类型：指认页要在文件还读不回来的时候
 * 说出"这个素材应该是 1:12"，而抄一份换算式就等于给那条派生开了第二个真值来源
 * （CLAUDE.md：纯音频素材的帧栅格是派生的、不存）。
 */
export type SourceFacts = DistributiveOmit<MediaSource, "file">;

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
export function sourceGridFps(source: SourceFacts, timelineFps: Rational): Rational {
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
 * 这个素材在**自己的栅格**里有多少帧——裁切的"还有没有更多素材"就是拿它判的。
 *
 * 单位是 `sourceGridFps(source)`，**不是项目帧率**（`timelineFps` 只是纯音频素材
 * 的栅格来源）。"这个素材铺在时间轴上占多少帧"是另一个量，见 `sourceTimelineFrames`
 * ——两者只在源片帧率恰好等于项目帧率时相等，而那是绝大多数项目的形态，所以拿错了
 * 很久都不会被发现。
 *
 * 纯音频素材用 `floor` 而不是 `round`：宁可少报一帧，也不能报出一帧解不出内容的
 * 位置（那会让裁到末尾的片段末帧静音，而静音在波形上看着就像素材本身如此）。
 */
export function sourceDurationFrames(source: SourceFacts, timelineFps: Rational): number {
  if (source.kind === "av") return source.durationFrames;
  if (source.kind === "image") return IMAGE_SOURCE_FRAMES;
  return Math.max(
    1,
    Math.floor((source.durationMicros * timelineFps.num) / (timelineFps.den * 1_000_000)),
  );
}

/**
 * 这个素材**铺满在时间轴上占多少帧**——导入时片段的初始长度就是它。
 *
 * 和 `sourceDurationFrames` 是**两个量**，只在"源片帧率 == 项目帧率"时相等。拿错
 * 的两个方向都不报错，两个都是把成片解回来量出来的：
 *
 * - 源片帧率**低于**项目帧率（25fps 素材进 30fps 项目）：片段短 20%，**尾部那 2.5
 *   秒永远够不到**——拉出点被"已经到源片末尾"挡住，滑移余量也算成 0。实测一条前 12.5
 *   秒绿、后 2.5 秒红的素材，成片里**一帧红都没有**；
 * - 源片帧率**高于**项目帧率（60 进 30）：片段长一倍。**不是黑帧，是定格**——前 10 秒
 *   内容正常，之后 300 帧全是源片最后那一帧（reader 只能向前，问不到就一直给最后一个
 *   sample）。实测一条颜色随时间线性变化的 10 秒素材，成片 20 秒、后 10 秒逐帧读回来
 *   都是 `#fc0000` 一动不动，而导出报成功、泄漏为 0。定格比黑屏更坏：黑屏一眼能看出
 *   是故障，而定格看起来像"这段素材本来就静止"（同 D48 那个角标存在的理由）。
 *
 * 纯音频素材的栅格本来就是项目帧率，所以那一支直接落回 `sourceDurationFrames`
 * ——**不抄一份换算式**，那就是给同一条派生开第二个真值来源（同 `sourceGridFps`）。
 */
export function sourceTimelineFrames(source: SourceFacts, timelineFps: Rational): number {
  if (source.kind === "image") return IMAGE_SOURCE_FRAMES;
  if (source.kind !== "av") return sourceDurationFrames(source, timelineFps);
  return Math.max(1, regridFrames(source.durationFrames, source.fps, timelineFps));
}

/**
 * 一个素材片段身上的**两把尺子**。
 *
 * `sourceIn` 和 `sourceDurationFrames()` 量在源片栅格上，而片段占位量在时间轴帧率上
 * ——凡是把两者放进同一个算式的地方（"还有没有更多素材"那一族判据全都是），都要先
 * 换算。写成一个具名对象而不是两个 `Rational` 参数：那两个参数**换过来不报错**，
 * 只把换算方向整个反过来，而两个方向的后果都长得像"素材本身就那么长"（见
 * `sourceTimelineFrames` 的文件头）。
 */
export interface FrameGrids {
  /** 片段所在时间轴的帧栅格。 */
  readonly timelineFps: Rational;
  /** 源片自己的帧栅格，由 `sourceGridFps()` 给——**不要直接读 `source.fps`**。 */
  readonly sourceFps: Rational;
}

/** 这个素材配上项目帧率之后的两把尺子。构造 `FrameGrids` 只走这里。 */
export function gridsFor(source: SourceFacts, timelineFps: Rational): FrameGrids {
  return { timelineFps, sourceFps: sourceGridFps(source, timelineFps) };
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
   * 裁剪：从源片四边各切掉多少，**按比例存**（见 `CropInsets`）。缺省 = 不裁。
   *
   * 和 `transform` 分开而不是塞进它，理由同 `color` 那条：它们作用在合成层的两个不同
   * 环节（**取源片的哪一块** vs 摆到画布的哪儿），而且顺序有内容——裁剪改变这一层的
   * 宽高比，留边是按裁剪之后算的。混成一个字段的话合成器就得靠字段名猜这个数该进哪儿。
   *
   * **不在 `keyframes` 里**（不是可动画属性，见 D46）。所以它没有"静态值与关键帧并存"
   * 那套东西，就是一个静态字段。
   */
  readonly crop?: CropInsets;
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
   * 音画链接：同一个 id 的片段是**一对**，编辑时一起动（**D55**）。
   *
   * 由 `addSource` 在导入带音轨的画面素材时给出——那一刻画面片段和音频片段必须同起点
   * （不允许"画面放下了、声音挪到了别处"，那是音画错位不是失败）。**这个不变量原来
   * 只在导入那一刻成立，第一次拖拽就破坏了**：实测拖走画面之后声音留在原地，不报错。
   *
   * ## 为什么是一个 id 而不是"互相指对方"
   *
   * 互指（`partnerId`）要维护两条边，删一个就得记得清另一条——漏掉的表现是"指向一个
   * 不存在的片段"，而那不报错、只在下次联动时静默少动一个。共用一个 id 则是**没有边
   * 可漏**：谁都不指谁，一起动的判据是"这个字段相等"。切分之后右半段那一对换成新 id
   * （`newLinkId()`），于是"切开的两段各自成对"是结构性的。
   *
   * ## 为什么不靠 id 命名去猜
   *
   * `${sourceId}-v` / `-a` 这套派生名在**第一次切分之后就断了**：新片段走 `newClipId()`，
   * 名字里再没有那层关系。而且用户可以故意解除链接（做 J-cut / L-cut 就必须能），
   * 那时命名仍然配得上对，只有一个真实字段才表达得了"这两个不再是一对"。
   *
   * 挂在 `ClipBase` 上，所以类型拦不住给文字片段设一个——但没有任何入口会那么做
   * （只有 `addSource` 设、`unlinkClips` 清），所以不像 D48 那样另加一道兜底。
   */
  readonly linkId?: string;
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
  /**
   * 播放速度倍数。缺省 = 1× = 原速。**没有这个字段和 `speed: 1` 必须行为相同**，
   * 而且缺省时取帧要走**不乘不除的原路径**（同 `isDefaultGeometry` / 恒等增益）：
   * 那不是性能优化，是保证没变速的项目逐像素、逐样本不变——否则 M0 那条音画同步
   * 断言会开始漂，而漂的原因和变速毫无关系。所以改回 1× 要把字段整个 `delete`。
   *
   * **是 `Rational` 不是 `number`。** 会做的预设（0.25 / 0.5 / 1.5 / 2 / 4）都是精确
   * 有理数，而浮点倍数会给"源片时刻"多加一道量化——那正是 `mix-plan.ts` 的
   * `exactSeconds` 踩过的地方（微秒取整在 48kHz 上是 0.048 个样本，实测让分段与
   * 不分段差了 5.22e-4）。有理数下换算仍是整数乘除加一次取整，同硬规则 1。
   *
   * **放 `MediaClip` 不放 `ClipBase`**，理由同 `volume`：文字片段没有"源片的哪一刻"。
   * 图片片段也没有——一张图要停多久是改片段长度，给它一个速度就是造出第二种表达
   * 同一件事的方式，而两个真值来源"都设了听谁的"错了不报错。
   *
   * **不是可动画属性**，刻意不进那三张关键帧通道表。给速度打关键帧意味着源片时刻
   * 变成速度曲线的**积分**（还要保证单调），那是另一个模型、要配曲线编辑器（§9 推后）；
   * 半做的表现是"钻石能拖、画面不动"。它不在 `AnimatableProperty` 里，所以
   * `setKeyframe` 编译期就传不进来——这比运行时拒绝好。
   *
   * **只允许正数**（倒放不做）：`VideoTrackReader` 的"取帧只能向前"是硬规则 3 的
   * 前提，整个解码架构建在顺序解码上。范围由 `SPEED_RANGE` 夹。
   */
  readonly speed?: Rational;
  /**
   * 变速时是否保持音高（时间伸缩，**D40**）。缺省 = 不保持 = 重采样（声音跟着变调）。
   *
   * **缺省刻意是"不保持"**：重采样变调是多数剪辑器的行为（Premiere 也要勾"保持音高"），
   * 而保音高有 CPU 开销和瞬态代价；把默认改掉等于让所有现存项目的声音换一种算法。
   *
   * **它只在 `speed` 不是原速时有意义**，原速下整条伸缩路径根本不进（`isNormalSpeed`
   * 先短路）。但字段**不跟着 `speed` 一起删**：用户调到 2×、勾上保音高、再调回 1×、
   * 又调到 2×，勾选该还在——那是他表达过的偏好，清掉是"我没动过它却变了"。
   *
   * 关掉时要把字段整个 `delete`（同 `speed` / `volume` / `transform`）：合成路径判的是
   * 值，所以这不是正确性问题；但"这个片段有没有开过保音高"要能在数据层一眼看出来。
   */
  readonly preservePitch?: boolean;
  /**
   * 定格：整段只画 `sourceIn` 那**一帧**（**D48**）。缺省 = 正常播放。
   *
   * **只有这一个字段，没有"定格在哪一帧"那个字段**——定住的就是 `sourceIn`。给它另加一个
   * `freezeAt` 会立刻造出两个真值来源（"`sourceIn` 和 `freezeAt` 都设了听谁的"），而错了
   * 不报错、只表现成"定格定在了别的地方"。所以「在播放头定格」这个动作做的是**把 `sourceIn`
   * 挪到播放头那一帧**（`freezeClipAt`），和裁入点用的是同一套整数帧换算。
   *
   * 写成 `?: true` 而不是 `?: boolean`（同 `Timeline.namedByUser`）：关掉要把字段整个
   * `delete`，`freeze: false` 那种中间状态在类型上就不存在。
   *
   * **它让这个片段的"源片长度"变成无穷**（`clipSourceFrames` 返回 1，一帧就够铺任意长），
   * 所以定格片段的出点拉不到尽头、转场余量也永远够——后者由 `availableHandle` 返回
   * `Infinity` 表达。**解除定格反过来要当场校验素材够不够长**，见 `unfreezeClip`。
   *
   * **只作用在画面上，声音一行不改。** 带音轨的素材导进来是两个片段（画面在 V1、声音在
   * A1，见 `addSource`），定格只属于画面那一个；`freezeClipAt` 拒绝音频轨上的片段，
   * 因为"定格一帧声音"没有意义——真按 `sourceMicrosAt` 恒定去混，`mix-plan` 会算出一个
   * 零长的源片区间，表现是**那一段整个静音且不报错**。归一化里还有一道兜底（同
   * `dropOrphanTransitions`：防将来新的编辑操作忘了校验）。
   */
  readonly freeze?: true;
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
  /**
   * 项目名。**没有这个字段 = 还没被取过名**，界面显示「未命名项目」。
   *
   * 不给缺省字符串：`name === undefined` 就是「自动取名还没发生」的判据本身
   * （`addSource` 在导入第一个素材时用素材名填它，之后不再动），存一个
   * 「未命名项目」字符串反而得靠比对文案去猜——同「改回缺省值要把字段整个删掉」。
   */
  readonly name?: string;
  /**
   * 名字是不是用户自己给的（重命名过）。**是标志，不靠"名字等不等于素材名"去猜**
   * （D37）：猜的写法在用户恰好把项目改名成素材名时会误判成"还没取过名"。
   * 只在用户重命名时置位；自动取名和「制作副本」都不算。
   */
  readonly namedByUser?: true;
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
  /**
   * 入点 / 出点标记（**D50**），左闭右开，单位是时间轴帧。两个各自可以单独存在：
   * 只有入点 = 从这里到末尾，只有出点 = 从头到这里。**"这两个字段描述哪一段"只有
   * `markedRange()` 一个答案**——导出面板、状态栏读数、标尺overlay 三处都问它，
   * 各写一遍"只设了一个怎么算"必然会漂。
   *
   * **它们在 `Timeline` 里，所以必须进撤销栈**（D43 那条：字段在 EDL 里就没得选，
   * 绕过 `apply()` 之后任何一次撤销都会把标记连带回滚）。而它本来就该是编辑——
   * 导出范围**会改变成片**，这正是 D43 判"静音 / 隐藏算编辑"用的那把尺子。
   *
   * 缺省是**字段整个不存在**，不是 0 / `durationFrames`：填了缺省值就分不出
   * "用户把入点打在第 0 帧"和"没有入点"，而前者在时间轴上要画出来。
   */
  readonly markIn?: number;
  readonly markOut?: number;
}

/** 导出范围，帧号，左闭右开。 */
export interface RenderRange {
  readonly inFrame: number;
  readonly outFrame: number;
}

/**
 * 入点 / 出点标记描述的区间；一个都没打时返回 null（**D50**）。
 *
 * **这是"标记指哪一段"的唯一答案。** 只设了一个的补全规则（入点 → 到末尾、
 * 出点 → 从头开始）散写在三处调用点必然会漂，而漂了的表现是"导出面板说 5 秒、
 * 状态栏说 8 秒"，两边都不报错。
 *
 * 夹回 `[0, durationFrames]` 是**兜底不是主判据**：主判据在 `setMark` 和归一化里
 * （删片段之后标记会跟着夹）。这里再夹一次是因为快照可能是旧数据、也可能被别处
 * 构造，而一个 `outFrame > durationFrames` 的区间会让导出多跑一段黑帧、并且把
 * D25 那个耗时预测和空间预估一起算大。
 */
export function markedRange(timeline: Timeline): RenderRange | null {
  const { markIn, markOut, durationFrames } = timeline;
  if (markIn === undefined && markOut === undefined) return null;
  const inFrame = Math.max(0, Math.min(durationFrames, markIn ?? 0));
  const outFrame = Math.max(0, Math.min(durationFrames, markOut ?? durationFrames));
  return outFrame > inFrame ? { inFrame, outFrame } : null;
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

/**
 * 把时间轴帧号换算成源片帧号。
 *
 * **不要拿它做取帧位置**（见 `edl/sampling.ts` 的文件头）。它有两个隐含假设，
 * 各自都不报错：源片帧率等于时间轴帧率，以及**片段没有变速**。留着是给单测当
 * "错的那一种算法"的对照。
 */
export function toSourceFrame(clip: MediaClip, timelineFrame: number): number {
  return clip.sourceIn + (timelineFrame - clip.timelineIn);
}

/** 原速。`speed` 字段省略时的等价值。 */
export const NORMAL_SPEED: Rational = { num: 1, den: 1 };

/**
 * 速度的取值范围。上下限不是技术限制，是**防手滑**（同 `MAX_TRANSITION_FRAMES`）：
 * 输入框里多打一个零会让一个 10 秒的片段变成 0.1 秒，而用户很难对上发生了什么。
 */
export const SPEED_RANGE = { min: 1 / 8, max: 8 } as const;

/** 这个片段的速度倍数；没设过就是原速。**判"是不是原速"一律问 `isNormalSpeed`。** */
export function clipSpeed(clip: MediaClip): Rational {
  return clip.speed ?? NORMAL_SPEED;
}

/**
 * 原速吗。取帧、音频排期、波形都靠它决定走不走那条"不乘不除"的原路径。
 *
 * 判 `speed === undefined` 是不够的：`{num:2,den:2}` 也是原速，而它进得来
 * （`setClipSpeed` 会归一化，但快照是旧数据、也可能被别处构造）。
 */
export function isNormalSpeed(clip: MediaClip): boolean {
  const s = clip.speed;
  return s === undefined || s.num === s.den;
}

/**
 * 这个片段要不要走保音高的时间伸缩（**D40**）。
 *
 * **两个条件都要**：开关开着，**而且**速度不是原速。少判后一条不会报错——伸缩器自己
 * 对原速也走直通——但那会让"没变速的项目连代码路径都和以前相同"这句话不再成立，
 * 而它正是 M0 那条音画同步断言不漂的地基（同 `isNormalSpeed` 存在的全部理由）。
 */
export function clipPreservesPitch(clip: MediaClip): boolean {
  return clip.preservePitch === true && !isNormalSpeed(clip);
}

/**
 * 定格吗（**D48**）。取帧、消耗多少源片帧、转场余量都先问它。
 *
 * 判据只有这一个字段，**不掺"速度是不是 0"之类的等价说法**：速度不允许为 0（`setClipSpeed`
 * 拒绝，理由见那里——0 算出来的长度是 Infinity），所以"定格"在数据上只有一种表达。
 */
export function isFrozen(clip: MediaClip): boolean {
  return clip.freeze === true;
}

/** 这个片段定格了吗。判别联合上的版本，给拿着 `Clip` 的调用点（UI 居多）用。 */
export function clipIsFrozen(clip: Clip): boolean {
  return clip.kind === "media" && isFrozen(clip);
}

/**
 * 这个片段从 `sourceIn` 起消耗多少源片帧，**单位是源片自己的栅格**——裁出点那道
 * "还有没有更多素材"就是拿它判的，所以它必须和 `sourceIn` / `sourceDurationFrames()`
 * 量在同一把尺子上。
 *
 * 片段占 L 帧，末帧落在源片的 `sourceIn + (L-1)×speed`，所以要 L-1 而不是 L 乘速度，
 * 再加回那一帧本身。**原速 + 同栅格时结果与旧式的 `sourceIn + L` 逐值相同**，这是
 * 刻意的：那道判据的行为在没变速、源片帧率又恰好等于项目帧率的项目上一个字都不能变
 * （四个浏览器自检全是这个形态）。
 *
 * `grids` 不给缺省值是有意的：它是**必填**，于是漏传的调用点在编译期就红。以前这个
 * 函数只收 `clip`，返回的其实是"时间轴帧 × 速度"，而调用方拿它去和源片栅格上的数
 * 相减——两把尺子的读数加在一起，只在源片帧率等于项目帧率时恰好对。
 *
 * 用 `ceil` 而不是 `round`：宁可少给一帧，也不能报出一帧解不出内容的位置——同
 * `sourceDurationFrames` 里那个 `floor`，失败形态也一样（末帧静默变成解不出来的黑帧）。
 */
export function clipSourceFrames(clip: MediaClip, grids: FrameGrids): number {
  const frames = clipDuration(clip);
  if (frames <= 0) return 0;
  // 定格只消耗**一帧**，与占位多长、速度多少、哪把尺子全都无关（D48）。这一条必须在
  // 速度那两条之前判：定格片段身上可能还留着 `speed`（改速度在定格期间被拒、但字段是
  // 之前设的，同 D40 那条"字段不跟着清掉"），按速度算出来的数会把出点上限和转场余量
  // 一起算错
  if (isFrozen(clip)) return 1;
  const s = clipSpeed(clip);
  // 这一步的单位还是**时间轴帧**（乘过速度）
  const spanned = isNormalSpeed(clip) ? frames : Math.ceil(((frames - 1) * s.num) / s.den) + 1;
  // 换成源片栅格。两个栅格相同时 `regridFramesNeeded` 不乘不除，原样返回
  return regridFramesNeeded(spanned, grids.timelineFps, grids.sourceFps);
}

/**
 * 时间轴上走 `frames` 帧，源片走多少帧（可负——转场窗口要往入点之前借）。
 *
 * 取整**只在这里发生一次**。散到各个调用点会让"裁入点"和"取帧"对同一个量取整
 * 两次，而两次取整的差表现为"裁了一帧，画面动了两帧"，不报错。
 */
export function scaleBySpeed(frames: number, speed: Rational): number {
  return speed.num === speed.den ? frames : Math.round((frames * speed.num) / speed.den);
}

/**
 * 反过来：源片有 `sourceFrames` 帧余量，够铺多少个时间轴帧。
 *
 * 用 `floor` 而不是 `round`，**和 `scaleBySpeed` 刻意不对称**：这个数用来回答
 * "余量够不够"，少算一帧只会让界面多报一帧定格（看得见、无害），多算一帧则是
 * 报"余量够"而那一帧实际解不出来——那正是转场一侧静默定格、而检查器说没事。
 */
export function unscaleBySpeed(sourceFrames: number, speed: Rational): number {
  return speed.num === speed.den ? sourceFrames : Math.floor((sourceFrames * speed.den) / speed.num);
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
