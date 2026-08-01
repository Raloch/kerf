/**
 * 时间轴 store：编辑器的单一状态源。
 *
 * 分层刻意做得很清楚：
 *   `operations.ts`（纯函数，可单测）→ 这里（撤销栈 + 选中 + 播放头）→ React 组件
 *
 * 所有改动 Timeline 的入口都必须走 `apply()`，它负责进撤销栈。
 * 绕过 apply 直接 set timeline 会产生"撤销不了的编辑"，是最难查的一类 bug。
 *
 * 播放头和选中**不进撤销栈**：没人希望按 ⌘Z 是把光标移回去而不是撤销上一次剪辑。
 */

import { create } from "zustand";
import type { AnimatableProperty, Easing } from "../anim/keyframes";
import type {
  Clip,
  ClipId,
  FontSource,
  LutId,
  LutSource,
  MediaSource,
  SourceId,
  Timeline,
  TrackId,
  TrackKind,
  Transition,
} from "../edl/types";
import { FPS, type Rational } from "../time/rational";
import {
  canRedo as histCanRedo,
  canUndo as histCanUndo,
  commit,
  current,
  initHistory,
  redo as histRedo,
  redoLabel as histRedoLabel,
  undo as histUndo,
  undoLabel as histUndoLabel,
  type History,
} from "./history";
import {
  addSource,
  addTextClip,
  addTrack,
  clearKeyframes,
  findClip,
  moveClip,
  moveClips,
  removeClips,
  removeKeyframe,
  removeSource,
  removeTrack,
  moveKeyframe,
  addLut,
  addFont,
  freezeClipAt,
  unfreezeClip,
  renameProject,
  setClipColor,
  setClipCrop,
  setClipLut,
  copyClips,
  duplicateClips,
  pasteClips,
  setClipPreservePitch,
  setClipSpeed,
  setClipsProperty,
  resetClipsProperties,
  PROPERTY_LABELS,
  setMark,
  setTrackFlag,
  trackFlagLabel,
  setClipVolume,
  setTransition,
  setClipTransform,
  setKeyframe,
  setTextContent,
  setTextStyle,
  primarySelection,
  snapDrag,
  snapTargets,
  splitAtFrame,
  linkedIds,
  unlinkClips,
  trimClip,
  type AddTextOptions,
  type BatchResult,
  type ColorPatch,
  type CropPatch,
  type EditResult,
  type MoveOptions,
  type TextStylePatch,
  type TrackFlag,
  type TransformPatch,
  type ClipboardEntry,
  sideLabel,
  slipClip,
  type TrimEdge,
  type TrimMode,
} from "./operations";

/**
 * 空项目：没有素材时的初始时间轴。默认 5 轨，见 PLAN.md 决策 D1。
 *
 * T1 的 `kind` 是 `"video"`，这是对的而不是笔误：轨道只分画面/声音两条通道，
 * 「字幕 / 标题」是**摆放约定**（文字层习惯放最上面），不是类型约束——
 * 标题同样能压在叠加轨上。"这一段是素材还是文字"由 `Clip.kind` 判别（见 `edl/types.ts`）。
 */
export const EMPTY_TIMELINE: Timeline = {
  fps: FPS.ndf2997,
  width: 1920,
  height: 1080,
  durationFrames: 0,
  tracks: [
    { id: "T1", kind: "video", label: "字幕 / 标题", clips: [] },
    { id: "V2", kind: "video", label: "叠加", clips: [] },
    { id: "V1", kind: "video", label: "主视频", clips: [] },
    { id: "A1", kind: "audio", label: "人声", clips: [] },
    { id: "A2", kind: "audio", label: "音乐", clips: [] },
  ],
  sources: [],
};

export interface TimelineState {
  history: History<Timeline>;
  /**
   * 当前装着的项目 id；**null = 没有项目装好**（首页、装载中、刚被删掉）。
   *
   * 它是自动存盘的闸门（见 `autosave.ts` 文件头）：id 和时间轴由 `openProject()`
   * **原子地一起换**，autosave 从同一份 state 里读这两样，所以"store 已经是项目 B
   * 而存盘还捏着项目 A 的 id"在结构上不存在——那正是切项目串写的形态（D37）。
   */
  projectId: string | null;
  /** 当前播放头（帧）。不进撤销栈。 */
  playhead: number;
  /**
   * 选中的片段。**数组不是 Set**：React 里 `includes` 够用，而 Set 在 devtools 里读不出来，
   * 也让"选中集合"看起来比它实际承担的更重。顺序是**加入顺序**且**不承载语义**——凡是
   * 需要确定顺序的地方（粘贴的锚点）自己按 `timelineIn` 排（见 `copyClips`）。
   *
   * 不变量：**没有重复**、**不指向已不存在的片段**（撤销 / 重做后要过滤，见 `undo`）。
   * 空数组 = 没选中，不用 null——`length` 一个判据管三种情形（0 / 1 / 多个）。
   */
  selectedClipIds: readonly ClipId[];
  snapEnabled: boolean;
  /** 时间轴缩放：每帧像素数 × 100。UI 状态，不进撤销栈。 */
  zoom: number;
  /** 最近一次被拒绝的操作原因，供 UI 提示；成功操作会清空。 */
  lastRejection: string | null;
  /**
   * 上一次编辑里**软件替用户多做的那一步**，中性语气，不是错误。
   *
   * 和 `lastRejection` 是一对而不是同一个：拒绝是"你要的事没做成"（状态栏红字），
   * 这个是"你要的事做成了，另外还发生了一件你没要求、但在界面上看得见的事"——
   * 目前唯一的来源是导入时自动新建了一条轨道。走红字会让一次正常的导入看起来
   * 像出了错；不说则是让轨道数悄悄增长（同 D19 那条"看得见的降级要标注"）。
   *
   * 清除时机**只有 `apply()` 一处**（成功编辑就清），所以它不会一直挂在状态栏上。
   */
  lastNotice: string | null;
  /**
   * 拖拽过程中的即时读数。拖拽结束清空，不进撤销栈。
   *
   * **带 `bad` 而不是一律红字**：这一行既要说"这里放不下"，也要说"松手会移到第 60
   * 帧""按 ⇧ 可以让后面跟着走"，而后两句是中性的。原来是个裸字符串、渲染成 `.reject`，
   * 于是**关键帧拖拽那句「移到第 N 帧」全程红着**——一次完全正常的操作看起来像出了错
   * （同 D54 那条 `lastNotice` / `lastRejection` 的分工，也同 `.notice` 用了未定义
   * 变量那个坑：显眼度是选出来的，不能默认继承）。
   */
  dragHint: DragHint | null;
  /**
   * 剪贴板里的那一组片段（空数组 = 没有可粘的）。**不进撤销栈**（复制没有改动任何
   * 东西），**不进快照**（它引用的素材下次打开时可能已经不在，见 `ClipboardEntry`），
   * 而且**切项目要清掉**（见 `openProject`）。
   */
  clipboard: readonly ClipboardEntry[];

  // ---- 读 ----
  timeline: () => Timeline;
  canUndo: () => boolean;
  canRedo: () => boolean;
  undoLabel: () => string | null;
  redoLabel: () => string | null;
  /**
   * 恰好选中一个时返回它，**0 个和多个都返回 null**。
   *
   * 检查器、关键帧轨、状态栏都只在"就一个"时才有意义：选中 5 个却显示其中一个的亮度，
   * 用户改它会以为 5 个都变了，那正是硬规则 10 的形状。所以这个判据收在一处，
   * 不让各个组件自己写 `length === 1 ? ids[0] : null`——写漏一处就是上面那句假话。
   */
  soleSelectedClipId: () => ClipId | null;

  // ---- 编辑（都会进撤销栈）----
  /**
   * 把素材加进项目并在时间轴上放好片段。**追加，不覆盖**——见 `addSource()`。
   *
   * `timelineIn` **通常不要传**：落点由 `importPlacement()` 按素材种类决定（带画面的
   * 追加到主画面轨末尾、纯音频落在播放头）。传了就是强制，绕过那条判据。
   * 都放不下时会新建一条轨道并把这件事报到 `lastRejection` 上——那不是拒绝，是
   * "软件替你做了一步"，但同样得说出来。
   */
  addSource: (source: MediaSource, timelineIn?: number) => void;
  /**
   * 把一个项目装进 store。**历史从这里重新开始。**
   *
   * 不恢复存下来的历史——快照里刻意没有撤销栈（见 `project-snapshot.ts`）。
   * 所以撤销回不到"打开之前"，那正是想要的：把一个引用了可能已经不在的素材的
   * 栈装回来，比没有撤销更坏。id 和时间轴**在同一次 set 里换**，见 `projectId`。
   */
  openProject: (projectId: string, timeline: Timeline, playhead: number) => void;
  /**
   * 卸下当前项目（删除项目、回首页时用）。`projectId` 归 null，自动存盘的 flush
   * 从此拒写——**删完项目必须先调它再等卸载**，否则收尾那次 flush 会把项目复活。
   */
  closeProject: () => void;
  /** 重命名当前项目。进撤销栈（它改的是 Timeline），`namedByUser` 由纯函数置位。 */
  renameProject: (name: string) => void;
  moveClip: (clipId: ClipId, deltaFrames: number, options?: MoveOptions) => void;
  /**
   * 整组平移。**不换轨**，理由见 `moveClips`；合并键带上整组，换一组片段必须断开。
   *
   * 磁吸不在这里：拖拽的落点由 `use-clip-drag` 算完（它要尊重 ⌥ 临时关掉磁吸），
   * 同 `moveClip` 那条。
   */
  moveClips: (clipIds: readonly ClipId[], deltaFrames: number, clampToBounds?: boolean) => void;
  /** 拖拽落点：先算磁吸再移动，中间态按 clipId 合并成一步撤销。 */
  dragClipTo: (clipId: ClipId, desiredIn: number, toTrack?: TrackId) => void;
  /**
   * 拖边缘。`mode` 决定"还有谁跟着变"（见 `TrimMode`），缺省是只动这一个片段
   * （和它的音画伙伴——那一条在纯函数里，界面探路和真正提交才不会分叉）。
   */
  trimClip: (clipId: ClipId, edge: TrimEdge, deltaFrames: number, mode?: TrimMode) => void;
  /**
   * 滑移：占位不动，换掉用的是源片哪一段（**D57**）。`sourceDeltaFrames` 的单位是
   * **源片帧**（见 `slipClip`）。
   *
   * `clampToBounds` 给拖拽用。滑移**没有位置幽灵可画**——占位一帧不动，画一个
   * 和原片段完全重合的矩形只会让人以为卡住了——所以它是这个仓库里唯一**边拖边提交**
   * 的片段编辑，缩略图和预览就是它的反馈。合并键让整条拖拽只进一条撤销。
   */
  slipClip: (clipId: ClipId, sourceDeltaFrames: number, clampToBounds?: boolean) => void;
  /**
   * 拖拽用的滑移：给**绝对目标**（源片第几帧），差值由 store 自己算（**D57**）。
   *
   * 和 `slipClip` 收增量是一对，同 `dragClipTo` / `moveClip`。收增量的版本在
   * 边拖边提交时**会重复施加**：调用方要先知道"现在是多少"才能算差值，而它手里那份
   * 时间轴来自 React 闭包、比 store 慢一拍——浏览器实测过，读数说「150 → 50」而实际
   * 落到 0，再往回拖一次说「0 → 100」而实际到 300。同 D50 那条"在 store 里读播放头"。
   */
  slipClipTo: (clipId: ClipId, targetSourceIn: number) => void;
  splitAtPlayhead: () => void;
  removeSelected: (ripple?: boolean) => void;
  /**
   * 解除选中片段的音画链接（**D55**）。两边一起解——只清一边会留下一个指着没人
   * 认领的 id 的片段。做 J-cut / L-cut（声音先进、画面后进）就必须能解开。
   */
  unlinkSelected: () => void;
  /** 改静态变换。连续拖滑块按"片段 + 改的是哪几个属性"合并成一步撤销。 */
  setClipTransform: (clipId: ClipId, patch: TransformPatch) => void;
  /** 改静态调色。合并策略同上。 */
  setClipColor: (clipId: ClipId, patch: ColorPatch) => void;
  /**
   * 改裁剪。合并键带上"改的是哪几条边"，理由同 `setClipTransform`。
   *
   * 不是可动画属性（D46），所以没有"改的是静态值还是关键帧"那套分岔。
   */
  setClipCrop: (clipId: ClipId, patch: CropPatch) => void;
  /** 改片段音量。合并键带 clipId，理由同 `setClipTransform`。 */
  setClipVolume: (clipId: ClipId, volume: number) => void;
  /**
   * 批量改一个属性的静态值。**逐个做、做不成的报出来**，见 `setClipsProperty`。
   *
   * 合并键带上整组**和属性**：换一组片段、或者改另一个属性，都必须断开撤销合并
   * （同 `moveClips` 和 `setClipTransform` 各自那半条理由）。
   */
  setClipsProperty: (
    clipIds: readonly ClipId[],
    property: AnimatableProperty,
    value: number,
  ) => void;
  /** 批量把若干属性恢复成缺省。不合并——重置是一下按出来的，没有中间态。 */
  resetClipsProperties: (
    clipIds: readonly ClipId[],
    properties: readonly AnimatableProperty[],
  ) => void;
  /** 改片段速度。**片段长度会跟着变**（保内容），放不下会被拒。见 `setClipSpeed`。 */
  setClipSpeed: (clipId: ClipId, speed: Rational) => void;
  /** 开关变速保持音高。不改长度、不动速度，见 `setClipPreservePitch`。 */
  setClipPreservePitch: (clipId: ClipId, on: boolean) => void;
  /**
   * 把片段定格在**当前播放头**那一帧（**D48**）。
   *
   * 播放头由 store 读、纯函数收一个显式帧号，同 `setKeyframeAt` 那条分工：换算和"现在
   * 是第几帧"归这一层，判据归纯函数。播放头不在片段里时纯函数拒绝并报到状态栏。
   */
  freezeAtPlayhead: (clipId: ClipId) => void;
  /** 解除定格，从定住那一帧继续播。素材不够长会被拒（见 `unfreezeClip`）。 */
  unfreezeClip: (clipId: ClipId) => void;
  /**
   * 开关轨道的锁定 / 静音 / 隐藏。**进撤销栈**——这三个字段在 `Timeline` 里，
   * 而静音和隐藏会改变成片，理由见 `setTrackFlag`。
   */
  setTrackFlag: (trackId: TrackId, flag: TrackFlag, on: boolean) => void;
  /** 新建一条空轨道（画面轨插最上、音频轨加最下，见 `addTrack`）。进撤销栈。 */
  addTrack: (kind: TrackKind) => void;
  /** 删除轨道，上面的片段一起删。锁定的会被拒；确认与否是界面的事（`removeTrack`）。 */
  removeTrack: (trackId: TrackId) => void;
  /**
   * 把素材从项目里删掉，引用它的片段一起删（有片段在锁定轨道上就整体拒绝）。
   * 只动 Timeline，资产库里的字节交给"孤儿 + 够老"的清理（见 `removeSource`）。
   */
  removeSource: (sourceId: SourceId) => void;
  /**
   * 在**当前播放头**打入点 / 出点。**进撤销栈**——字段在 `Timeline` 里（D43），
   * 而导出范围会改变成片。同一端连着打会合并成一条历史。
   *
   * 播放头由这里自己读（`get().playhead`），**不从调用方传进来**：同
   * `freezeAtPlayhead` / `splitAtPlayhead`。键盘处理器里那个 `playhead` 来自 React
   * 闭包，比 store 慢一拍——浏览器里实测过，`setPlayhead(60)` 之后立刻按 I 打出来的
   * 是第 0 帧。传参数的写法把这类错误留在了每一个调用点上。
   */
  markAtPlayhead: (edge: "in" | "out") => void;
  /** 清掉一端的标记。没有那一端时什么都不做（不进栈、不报错）。 */
  clearMark: (edge: "in" | "out") => void;
  /** 把选中的（可能多个）片段放进剪贴板。**不进撤销栈**——它什么都没改。 */
  copySelected: () => void;
  /** 把剪贴板那一组粘到播放头，各自落回原轨。放不下就整组拒绝。 */
  paste: () => void;
  /** 给选中的每个片段做一个副本，整组落在它们之后。不动剪贴板。 */
  duplicateSelected: () => void;
  /** 把一张解析好的 LUT 加进项目库。 */
  addLut: (lut: LutSource) => void;
  /** 给片段挂上 / 摘掉 LUT。传 undefined 表示摘掉。 */
  setClipLut: (clipId: ClipId, lutId?: LutId) => void;
  /**
   * 把一个**已经注册好**的字体加进项目库。
   *
   * 调用方要先 `await registerFont(font)` 再调它，见 `compose/font-registry.ts`。
   */
  addFont: (font: FontSource) => void;
  /**
   * 给片段的入点设置（或摘掉）转场。
   *
   * 合并键带 clipId：拖时长滑块时连续发同一个交界的改动，应该合成一次撤销，
   * 但换一个交界必须断开——否则一次 ⌘Z 会同时撤掉两个交界上的编辑。
   */
  setTransition: (clipId: ClipId, transition?: Transition) => void;
  /** 在**时间轴帧号** `frame` 处打关键帧；内部换算成片段内偏移。 */
  setKeyframeAt: (
    clipId: ClipId,
    property: AnimatableProperty,
    frame: number,
    value: number,
    easing?: Easing,
  ) => void;
  removeKeyframeAt: (clipId: ClipId, property: AnimatableProperty, frame: number) => void;
  /**
   * 把关键帧从**时间轴帧号** `fromFrame` 挪到 `toFrame`；内部换算成片段内偏移。
   *
   * 目标位置已有关键帧时会被拒（不覆盖），原因走 `lastRejection` 报到状态栏。
   */
  moveKeyframeAt: (
    clipId: ClipId,
    property: AnimatableProperty,
    fromFrame: number,
    toFrame: number,
  ) => void;
  clearKeyframes: (clipId: ClipId, property: AnimatableProperty, bakeValue?: number) => void;
  setTextContent: (clipId: ClipId, text: string) => void;
  setTextStyle: (clipId: ClipId, patch: TextStylePatch) => void;
  /** 新建文字片段；成功后自动选中它，用户接着就能在检查器里改。 */
  addTextClip: (options: AddTextOptions) => void;

  // ---- 不进撤销栈 ----
  setPlayhead: (frame: number) => void;
  /** 换成只选这一个；传 null 清空。 */
  select: (clipId: ClipId | null) => void;
  /**
   * 加进 / 移出选中集合（⌘ 点选）。
   *
   * 已经选中的再点一次就移出——那是"加减选择"的常规语义，而且它是唯一不用先清空
   * 就能取消误选的手势。
   */
  toggleSelect: (clipId: ClipId) => void;
  /**
   * 换成正好选中这一组（框选拖动中每帧都在调它）。
   *
   * 框选**边拖边写选中**，不等松手：那是这个手势唯一的反馈——不写的话用户得先松手才知道
   * 框住了什么。选中不进撤销栈，所以"每次 pointermove 写一次"没有代价（同播放头）。
   */
  selectMany: (clipIds: readonly ClipId[]) => void;
  /** 全选所有轨道上的所有片段（⌘A）。锁定轨道上的也选，批量操作会自己报出没做成的。 */
  selectAll: () => void;
  toggleSnap: () => void;
  setZoom: (zoom: number) => void;
  setDragHint: (hint: DragHint | null) => void;
  undo: () => void;
  redo: () => void;
}

/** 拖拽读数。`bad` 决定它在状态栏上是红字还是中性色——见 `TimelineState.dragHint`。 */
export interface DragHint {
  readonly text: string;
  readonly bad: boolean;
}

/** 单调递增的时间源。用 performance.now() 让合并窗口按真实时间算。 */
const now = () => performance.now();

export const useTimeline = create<TimelineState>((set, get) => {
  /** 所有 Timeline 变更的唯一入口。 */
  function apply(result: EditResult, label: string, coalesceKey: string | null = null): void {
    if (!result.changed) {
      // 没给 reason 表示"值没变"，不是失败——见 EditResult.reason。
      // 一律当失败提示的话，滑块拖到边界后会一直闪红字
      if (result.reason !== undefined) set({ lastRejection: result.reason });
      return;
    }
    set((state) => ({
      history: commit(state.history, result.timeline, { label, coalesceKey, at: now() }),
      lastRejection: null,
      lastNotice: null,
    }));
  }

  /**
   * 批量结果的第二次上报。
   *
   * `apply()` 在成功时会把 `lastRejection` 清空，所以"部分成功"那句话只能在它之后写
   * ——顺序反了就是自己把自己擦掉，而且不报错（见 `BatchResult.skippedReason`）。
   */
  function applyBatch(
    result: BatchResult,
    label: string,
    coalesceKey: string | null = null,
  ): void {
    apply(result, label, coalesceKey);
    if (result.changed && result.skippedReason !== undefined) {
      set({ lastRejection: result.skippedReason });
    }
  }

  /**
   * 移动一个片段，**连它的音画伙伴一起**（**D55**）。
   *
   * 被拖的那个可以换轨，伙伴**只跟着平移同样的帧数**——它在音频轨上，换不到画面轨去
   * （反过来同理）。所以这不是 `moveClips` 能表达的：那个函数是"整组同一位移、不换轨"。
   *
   * **全体或拒绝**：伙伴放不下时整次移动都不做，因为"画面挪过去了、声音留在原地"正是
   * 这一刀要消灭的状态（同 `addSource` 那条"不允许画面放下了、声音挪到了别处"）。
   *
   * 两个调用方——`moveClip`（真实拖拽走这条，磁吸已在 `use-clip-drag` 里算完）和
   * `dragClipTo`（按 store 的磁吸设置再吸一次）。**必须共用**：只改其中一个的后果是
   * "键盘/程序移动会联动、鼠标拖拽不会"，而那种半联动比完全不联动更难查（实测就是
   * 只改了 `dragClipTo`，浏览器里拖完发现声音没跟上，而单测全绿）。
   */
  function moveWithPartners(clipId: ClipId, delta: number, options: MoveOptions): void {
    const timeline = get().timeline();
    const partners = linkedIds(timeline, [clipId]).filter((id) => id !== clipId);
    const first = moveClip(timeline, clipId, delta, options);
    if (partners.length === 0 || !first.changed) {
      apply(first, "移动片段", `move:${clipId}`);
      return;
    }
    let working = first.timeline;
    for (const id of partners) {
      // 位移为 0 时 `moveClip` 返回"值没变"（`changed:false` 且不给 reason），那不是
      // 失败——跨轨拖拽就是这种情形（delta 恒为 0，只换轨）
      const step = moveClip(working, id, delta);
      if (!step.changed && step.reason !== undefined) {
        // 措辞问 `sideLabel`，别写死"声音"——用户拖的可能就是音频片段，那时被挡住的
        // 是画面，而一句"声音那一段放不下"指着他刚拖的那个，读起来像软件出错了
        set({ lastRejection: `${sideLabel(timeline, id)}那一段放不下：${step.reason}` });
        return;
      }
      if (step.changed) working = step.timeline;
    }
    apply({ timeline: working, changed: true }, "移动片段", `move:${clipId}`);
  }

  /**
   * 打或清一个标记，带上标签和合并键（D50）。
   *
   * 合并键按**端**给（`mark:in` / `mark:out`），所以"拖着播放头连打几次入点"合成
   * 一条历史。不给的话每按一次 I 都是一条，⌘Z 要按到手酸才回到上一次真编辑。
   *
   * **两端不能共用一个键**：合并只发生在紧邻的上一条上，共用键会让"打入点、紧接着
   * 打出点"被合成一条——那时 ⌘Z 一下把两端一起撤掉，而用户只想撤回一个。
   */
  function commitMark(timeline: Timeline, edge: "in" | "out", frame: number | null): void {
    const name = edge === "in" ? "入点" : "出点";
    apply(setMark(timeline, edge, frame), frame === null ? `清除${name}` : name, `mark:${edge}`);
  }

  /** 撤销 / 重做之后，选中集合里可能有片段已经不在了。**逐个过滤，不整体清空。** */
  function liveSelection(timeline: Timeline, ids: readonly ClipId[]): readonly ClipId[] {
    const live = ids.filter((id) => findClip(timeline, id));
    return live.length === ids.length ? ids : live;
  }

  return {
    history: initHistory(EMPTY_TIMELINE, "新建项目"),
    projectId: null,
    clipboard: [],
    playhead: 0,
    selectedClipIds: [],
    snapEnabled: true, // 默认开，见 PLAN.md 决策 D2
    zoom: 42,
    lastRejection: null,
    lastNotice: null,
    dragHint: null,

    timeline: () => current(get().history),
    soleSelectedClipId: () => {
      const ids = get().selectedClipIds;
      return ids.length === 1 ? ids[0]! : null;
    },
    canUndo: () => histCanUndo(get().history),
    canRedo: () => histCanRedo(get().history),
    undoLabel: () => histUndoLabel(get().history),
    redoLabel: () => histRedoLabel(get().history),

    addSource(source, timelineIn) {
      const state = get();
      // 落点的判据在 `importPlacement()` 里，不在这儿——store 只把播放头递进去。
      // `timelineIn` 给了才是强制落点（`exactOptionalPropertyTypes` 下不能写
      // `timelineIn: undefined`，那是另一种类型）
      const result = addSource(state.timeline(), {
        source,
        playhead: state.playhead,
        ...(timelineIn === undefined ? {} : { timelineIn }),
      });
      if (!result.changed) {
        set({ lastRejection: result.reason ?? null });
        return;
      }
      set((s) => ({
        history: commit(s.history, result.timeline, {
          label: `导入 ${source.name}`,
          coalesceKey: null,
          at: now(),
        }),
        // 选中新片段。**音画两个不能都选上**：多选态下检查器只报计数（那是刻意的，
        // 见 `soleSelectedClipId`），两个都选中就等于导入之后看不到这个片段的属性。
        // 判据和粘贴 / 副本共用一处（`primarySelection`）——散写必然漏一家。
        // **不动播放头**：导入配乐时用户正停在某一处，把它拨回 0 等于让
        // "在播放头处插入"这件事自己失效
        selectedClipIds: primarySelection(result.timeline, result.clipIds ?? []),
        lastRejection: null,
        // 自动新建的轨道要说出来（见 `lastNotice`）。这里直接写进同一次 set，
        // 不像 `applyBatch` 那样分两步——那条纪律针对的是 `apply()` 会把消息擦掉，
        // 而这一支根本没走 `apply()`
        lastNotice:
          result.addedTrackId === undefined
            ? null
            : `放不下，已新建轨道 ${result.addedTrackId}（撤销会一起去掉）`,
      }));
    },

    openProject(projectId, timeline, playhead) {
      set({
        projectId,
        history: initHistory(timeline, "打开项目"),
        playhead,
        selectedClipIds: [],
        lastRejection: null,
        dragHint: null,
        // 跨项目粘贴够得到（剪贴板本来活过切项目），而粘过去的片段会引用一个不在这个
        // 项目里的素材——那时快照恢复会抛（D23）。`pasteClip` 自己也拦着，但那是契约；
        // 这里清掉是体验：与其让用户按了粘贴看到一句拒绝，不如根本没有可粘的东西
        clipboard: [],
      });
    },

    closeProject() {
      set({
        projectId: null,
        history: initHistory(EMPTY_TIMELINE, "新建项目"),
        playhead: 0,
        selectedClipIds: [],
        lastRejection: null,
        dragHint: null,
        clipboard: [],
      });
    },

    renameProject(name) {
      apply(renameProject(get().timeline(), name), "重命名项目");
    },

    moveClip(clipId, deltaFrames, options) {
      moveWithPartners(clipId, deltaFrames, options ?? {});
    },

    moveClips(clipIds, deltaFrames, clampToBounds) {
      // 整组拖拽同样要带上音画伙伴（D55）。这里比 `dragClipTo` 简单：`moveClips`
      // 本来就是"整组同一个位移、不换轨"（D42），伙伴天然符合那个形状
      apply(
        moveClips(
          get().timeline(),
          linkedIds(get().timeline(), clipIds),
          deltaFrames,
          clampToBounds === undefined ? {} : { clampToBounds },
        ),
        "移动片段",
        `move:${[...clipIds].join(",")}`,
      );
    },

    dragClipTo(clipId, desiredIn, toTrack) {
      const state = get();
      const timeline = state.timeline();
      const found = findClip(timeline, clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }

      let target = Math.round(desiredIn);
      if (state.snapEnabled) {
        const length = found.clip.timelineOut - found.clip.timelineIn;
        const targets = snapTargets(timeline, [clipId], { playhead: state.playhead });
        target = snapDrag(target, length, targets).frame;
      }

      // "没动"必须连轨道一起判。跨轨道拖拽是**纯垂直**移动，delta 恒为 0，
      // 只看 delta 会把整个跨轨落点静默丢掉——既不移动也不给 lastRejection，
      // 表现成"拖上去松手，片段弹回原轨"。见 CLAUDE.md 的"水平和垂直都要测"
      const delta = target - found.clip.timelineIn;
      const sameTrack = toTrack === undefined || toTrack === found.track.id;
      if (delta === 0 && sameTrack) return; // 真的没动才不产生历史条目

      // 音画联动收在 `moveWithPartners` 一处，两条移动路径共用（见那里的注释）
      moveWithPartners(clipId, delta, toTrack === undefined ? {} : { toTrack });
    },

    trimClip(clipId, edge, deltaFrames, mode = "normal") {
      apply(
        trimClip(get().timeline(), clipId, edge, deltaFrames, mode),
        trimLabel(edge, mode),
        // **合并键带模式**：普通裁切和波纹裁切改变的东西不是一回事（后者还挪了后继
        // 片段），合成一条撤销会让 ⌘Z 一下把两次都撤掉。卷动同理
        `trim:${mode}:${edge}:${clipId}`,
      );
    },

    slipClip(clipId, sourceDeltaFrames, clampToBounds = false) {
      apply(
        slipClip(get().timeline(), clipId, sourceDeltaFrames, { clampToBounds }),
        "滑移片段",
        `slip:${clipId}`,
      );
    },

    slipClipTo(clipId, targetSourceIn) {
      const timeline = get().timeline();
      const found = findClip(timeline, clipId);
      // 差值在这里算，不让调用方算——理由见接口那段注释
      const now = found?.clip.kind === "media" ? found.clip.sourceIn : null;
      if (now === null) return;
      apply(
        slipClip(timeline, clipId, targetSourceIn - now, { clampToBounds: true }),
        "滑移片段",
        `slip:${clipId}`,
      );
    },

    splitAtPlayhead() {
      const state = get();
      // 判据整个在 `splitAtFrame()` 里（含音画联动和右半段重新配对）——`null` 表示
      // "没选中，切播放头下所有未锁定轨道里的片段"
      const ids = state.selectedClipIds.length ? state.selectedClipIds : null;
      apply(splitAtFrame(state.timeline(), state.playhead, ids), "切分片段");
    },

    removeSelected(ripple = false) {
      const { selectedClipIds } = get();
      if (selectedClipIds.length === 0) {
        set({ lastRejection: "没有选中片段" });
        return;
      }
      // 连音画伙伴一起删：只删一半会留下一个"有声音没画面"的片段，而用户看得见
      // 它还在那儿（D55）
      const result = removeClips(get().timeline(), linkedIds(get().timeline(), selectedClipIds), ripple);
      // 删掉的那些当然不能还选着；部分成功时留下没删掉的那几个仍然选中
      if (result.changed) {
        set({ selectedClipIds: liveSelection(result.timeline, selectedClipIds) });
      }
      applyBatch(result, ripple ? "波纹删除" : "删除片段");
    },

    unlinkSelected() {
      const { selectedClipIds } = get();
      if (selectedClipIds.length === 0) {
        set({ lastRejection: "没有选中片段" });
        return;
      }
      applyBatch(unlinkClips(get().timeline(), selectedClipIds), "解除音画链接");
    },

    setClipTransform(clipId, patch) {
      // 合并键带上"改的是哪几个属性"：拖 X 滑块和紧接着拖 Y 滑块是两次编辑，
      // 只按 clipId 合并会把它们并成一步，⌘Z 一下退回去两个属性
      const keys = Object.keys(patch).sort().join(",");
      apply(
        setClipTransform(get().timeline(), clipId, patch),
        "调整变换",
        `transform:${clipId}:${keys}`,
      );
    },

    setClipColor(clipId, patch) {
      const keys = Object.keys(patch).sort().join(",");
      apply(setClipColor(get().timeline(), clipId, patch), "调色", `color:${clipId}:${keys}`);
    },

    setClipCrop(clipId, patch) {
      const keys = Object.keys(patch).sort().join(",");
      apply(setClipCrop(get().timeline(), clipId, patch), "裁剪", `crop:${clipId}:${keys}`);
    },

    setClipVolume(clipId, volume) {
      apply(setClipVolume(get().timeline(), clipId, volume), "音量", `volume:${clipId}`);
    },

    setClipsProperty(clipIds, property, value) {
      applyBatch(
        setClipsProperty(get().timeline(), clipIds, property, value),
        `批量改${PROPERTY_LABELS[property]}`,
        `props:${[...clipIds].join(",")}:${property}`,
      );
    },

    resetClipsProperties(clipIds, properties) {
      applyBatch(resetClipsProperties(get().timeline(), clipIds, properties), "批量重置");
    },

    setClipSpeed(clipId, speed) {
      apply(setClipSpeed(get().timeline(), clipId, speed), "变速", `speed:${clipId}`);
    },

    setClipPreservePitch(clipId, on) {
      // 不给合并键：这是一次点击，不是连续拖拽
      apply(setClipPreservePitch(get().timeline(), clipId, on), on ? "保持音高" : "允许变调");
    },

    freezeAtPlayhead(clipId) {
      const state = get();
      apply(freezeClipAt(state.timeline(), clipId, state.playhead), "定格");
    },

    unfreezeClip(clipId) {
      apply(unfreezeClip(get().timeline(), clipId), "解除定格");
    },

    setTrackFlag(trackId, flag, on) {
      apply(setTrackFlag(get().timeline(), trackId, flag, on), trackFlagLabel(flag, on));
    },

    addTrack(kind) {
      // 不给合并键：每按一次就是新的一条轨，两次新建合成一步撤销会让 ⌘Z 一下删掉两条
      apply(addTrack(get().timeline(), kind), kind === "video" ? "新建画面轨" : "新建音频轨");
    },

    removeTrack(trackId) {
      const result = removeTrack(get().timeline(), trackId);
      // 删掉的轨道上可能有选中的片段。逐个过滤不整体清空，同 `removeSelected`
      if (result.changed) {
        set((s) => ({ selectedClipIds: liveSelection(result.timeline, s.selectedClipIds) }));
      }
      apply(result, "删除轨道");
    },

    removeSource(sourceId) {
      const timeline = get().timeline();
      const name = timeline.sources.find((s) => s.id === sourceId)?.name ?? sourceId;
      const result = removeSource(timeline, sourceId);
      // 引用它的片段随之消失，选中集合里的悬空引用同样要过滤
      if (result.changed) {
        set((s) => ({ selectedClipIds: liveSelection(result.timeline, s.selectedClipIds) }));
      }
      apply(result, `删除素材 ${name}`);
    },

    markAtPlayhead(edge) {
      const state = get();
      commitMark(state.timeline(), edge, state.playhead);
    },

    clearMark(edge) {
      commitMark(get().timeline(), edge, null);
    },

    copySelected() {
      const state = get();
      if (state.selectedClipIds.length === 0) return;
      // 复制一个画面片段要连它的声音一起（D55），否则粘出来的是一段哑片
      const entries = copyClips(state.timeline(), linkedIds(state.timeline(), state.selectedClipIds));
      // **不走 `apply`**：复制什么都没改，进撤销栈的话用户要按两次 ⌘Z 才回到上一次真编辑。
      // 一个都没抓到时不动剪贴板——上一次复制的东西还能粘，比清空更有用
      if (entries.length > 0) set({ clipboard: entries, lastRejection: null });
    },

    paste() {
      const state = get();
      const entries = state.clipboard;
      if (entries.length === 0) return;
      const result = pasteClips(state.timeline(), entries, state.playhead);
      apply(result, "粘贴片段");
      // 整组选中粘出来的那些：接着按 ⌘V 之外的任何编辑，作用对象都是刚粘的这一组
      // 选中不跟着链接扩展：粘出来的那一段该是一个可编辑的选中，两个都选中
      // 会让检查器只报计数（见 `primarySelection`）
      if (result.changed && result.clipIds) {
        set({ selectedClipIds: primarySelection(result.timeline, result.clipIds) });
      }
    },

    duplicateSelected() {
      const state = get();
      if (state.selectedClipIds.length === 0) return;
      // 同 copySelected：⌘D 出来的副本要连声音一起
      const result = duplicateClips(
        state.timeline(),
        linkedIds(state.timeline(), state.selectedClipIds),
      );
      apply(result, "片段副本");
      // 选中副本而不是原片段：接着按 ⌘D 就能连着复制一串
      // 选中不跟着链接扩展：粘出来的那一段该是一个可编辑的选中，两个都选中
      // 会让检查器只报计数（见 `primarySelection`）
      if (result.changed && result.clipIds) {
        set({ selectedClipIds: primarySelection(result.timeline, result.clipIds) });
      }
    },

    addLut(lut) {
      apply(addLut(get().timeline(), lut), `导入 LUT ${lut.name}`);
    },

    setClipLut(clipId, lutId) {
      apply(setClipLut(get().timeline(), clipId, lutId), lutId ? "套用 LUT" : "移除 LUT");
    },

    addFont(font) {
      apply(addFont(get().timeline(), font), `导入字体 ${font.name}`);
    },

    setTransition(clipId, transition) {
      apply(
        setTransition(get().timeline(), clipId, transition),
        transition ? "设置转场" : "移除转场",
        transition ? `transition:${clipId}` : undefined,
      );
    },

    setKeyframeAt(clipId, property, frame, value, easing) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      // 关键帧偏移相对片段起点（D10）。换算只在这一处做，纯函数层只认偏移
      const offset = frame - found.clip.timelineIn;
      apply(
        setKeyframe(get().timeline(), clipId, property, offset, value, easing),
        `关键帧 ${property}`,
        // 偏移进合并键：在同一个位置拖值要合并，换个位置再打就是新的一步
        `keyframe:${clipId}:${property}:${offset}`,
      );
    },

    removeKeyframeAt(clipId, property, frame) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      apply(
        removeKeyframe(get().timeline(), clipId, property, frame - found.clip.timelineIn),
        "删除关键帧",
      );
    },

    moveKeyframeAt(clipId, property, fromFrame, toFrame) {
      const found = findClip(get().timeline(), clipId);
      if (!found) {
        set({ lastRejection: `找不到片段 ${clipId}` });
        return;
      }
      const { timelineIn } = found.clip;
      // **不给合并键。** 时间轴上拖关键帧走的是"拖动中只画落点、松手才提交"
      // （同 `use-clip-drag`），所以一次拖拽本来就只产生一条历史。D10 的重新评估
      // 条款担心的是"边拖边提交"那种写法，那时才需要一个带关键帧身份的合并键——
      // 而关键帧的身份只有偏移，拖动中偏移一直在变，那个键根本立不住。
      apply(
        moveKeyframe(get().timeline(), clipId, property, fromFrame - timelineIn, toFrame - timelineIn),
        "移动关键帧",
      );
    },

    clearKeyframes(clipId, property, bakeValue) {
      apply(clearKeyframes(get().timeline(), clipId, property, bakeValue), "关闭动画");
    },

    setTextContent(clipId, text) {
      // 逐次按键都会进来，靠合并窗口把连续输入并成一步撤销
      apply(setTextContent(get().timeline(), clipId, text), "修改文字", `text:${clipId}`);
    },

    setTextStyle(clipId, patch) {
      const keys = Object.keys(patch).sort().join(",");
      apply(setTextStyle(get().timeline(), clipId, patch), "文字样式", `style:${clipId}:${keys}`);
    },

    addTextClip(options) {
      const result = addTextClip(get().timeline(), options);
      apply(result, "新建文字");
      // 选中新片段，用户接着就能改内容；失败时 clipId 为空，不动选中
      if (result.changed && result.clipId) set({ selectedClipIds: [result.clipId] });
    },

    setPlayhead(frame) {
      const timeline = get().timeline();
      // 夹在 [0, duration]：播放头允许停在末尾（等于 duration）以便追加
      const clamped = Math.max(0, Math.min(timeline.durationFrames, Math.round(frame)));
      set({ playhead: clamped });
    },

    select(clipId) {
      set({ selectedClipIds: clipId === null ? [] : [clipId], lastRejection: null });
    },

    toggleSelect(clipId) {
      set((state) => ({
        selectedClipIds: state.selectedClipIds.includes(clipId)
          ? state.selectedClipIds.filter((id) => id !== clipId)
          : [...state.selectedClipIds, clipId],
        lastRejection: null,
      }));
    },

    selectMany(clipIds) {
      // 去重是这里的责任：`selectedClipIds` 的不变量是"没有重复"，而框选把基础选中和
      // 框里那些并起来时天然会撞（⌘ 加框选，框住的正好包含已经选中的那个）
      set({ selectedClipIds: [...new Set(clipIds)], lastRejection: null });
    },

    selectAll() {
      const timeline = get().timeline();
      set({
        selectedClipIds: timeline.tracks.flatMap((t) => t.clips.map((c) => c.id)),
        lastRejection: null,
      });
    },

    toggleSnap() {
      set((state) => ({ snapEnabled: !state.snapEnabled }));
    },

    setDragHint(hint) {
      set({ dragHint: hint });
    },

    setZoom(zoom) {
      // 夹住范围：0 会让所有片段宽度归零，过大则一帧几十像素、滚动条失控
      set({ zoom: Math.max(4, Math.min(400, Math.round(zoom))) });
    },

    undo() {
      set((state) => {
        const history = histUndo(state.history);
        const timeline = current(history);
        return {
          history,
          lastRejection: null,
          // 撤销 / 重做**也要**清 `lastNotice`：它描述的是"上一次编辑里多做的那一步"，
          // 撤销之后那句话就是假的——实测过，⌘Z 收走了刚建的 A3，状态栏还挂着
          // 「已新建轨道 A3」。这两个动作不走 `apply()`，所以那一处清不到它们
          lastNotice: null,
          // 撤销后选中的片段可能已不存在，清掉悬空引用（逐个过滤，不整体清空）
          selectedClipIds: liveSelection(timeline, state.selectedClipIds),
          playhead: Math.min(state.playhead, timeline.durationFrames),
        };
      });
    },

    redo() {
      set((state) => {
        const history = histRedo(state.history);
        const timeline = current(history);
        return {
          history,
          lastRejection: null,
          lastNotice: null, // 同 undo：那句话描述的是上一次编辑，重做换了一次就不成立了
          selectedClipIds: liveSelection(timeline, state.selectedClipIds),
          playhead: Math.min(state.playhead, timeline.durationFrames),
        };
      });
    },
  };
});

/**
 * 撤销栈里那条编辑叫什么。
 *
 * 三种模式要分开说：用户按 ⌘Z 之前看到的是这行字，而"裁切出点"和"波纹裁切出点"
 * 撤销回去的东西差着后面一整排片段。
 */
function trimLabel(edge: TrimEdge, mode: TrimMode): string {
  if (mode === "roll") return "卷动交界";
  return `${mode === "ripple" ? "波纹裁切" : "裁切"}${edge === "in" ? "入点" : "出点"}`;
}

/**
 * 开发期把 store 挂到全局，供浏览器控制台和自动化实测脚本驱动**真实**实例。
 *
 * 不这样做的话，脚本里 `import('/src/state/timeline-store.ts')` 会因为 Vite 的
 * HMR URL 带参数而拿到另一个模块实例——脚本改了状态，界面毫无反应，
 * 看起来像 UI 没绑定 store，实际是两份状态各自为政。排查过一次，记在这里。
 */
if (import.meta.env.DEV) {
  (globalThis as typeof globalThis & { __kerfStore?: typeof useTimeline }).__kerfStore =
    useTimeline;
}
