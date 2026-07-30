/**
 * EDL ↔ 可持久化快照的相互转换。**纯函数，不碰 IndexedDB。**
 *
 * 拆成两层的理由和状态层那条"编辑逻辑写在纯函数里"一样：会写错的是**取舍**，
 * 不是存取。`File` 要从 EDL 里剥出去（否则每次自动存盘都可能把几百 MB 的素材
 * 重写一遍）、素材找不回来时哪些片段要跟着走、LUT 找不回来时片段**不该**跟着走、
 * 旧版本快照要干净地拒掉而不是恢复成一个半坏的时间轴——这些都能在 node 里单测，
 * 而 IndexedDB 在 node 里没有。
 *
 * ## 为什么素材和 LUT / 字体的失败处理不对称
 *
 * 素材没了，引用它的片段**必须移除**：`resolveSource()` 找不到就抛，留着会让预览
 * 整个崩掉。LUT 没了，片段仍然完全可渲染（只是不上那张表），所以**只清 `lutId`、
 * 保留片段**。字体没了同理，只是要清的是 `style.fontFamily`——而这一处**必须清**，
 * 不能留着：留着的话渲染时 `rasterizeText` 会抛（那道断言是刻意的，见
 * `compose/font-registry.ts` 文件头），表现成"恢复完预览就崩"。
 * 三者都要**报出来**，不能静默——用户丢了三个片段而软件一声不响，
 * 是硬规则 10 那类"选了 A 拿到 B"在数据层的形态。
 *
 * ## 为什么不存撤销栈
 *
 * 恢复出来的项目从一条干净历史开始。撤销栈里每一条都是一份完整 EDL 快照，
 * 而它们引用的素材可能已经不在了——恢复一个"撤销回去就会崩"的栈，比没有撤销更坏。
 * 崩溃恢复要保住的是**此刻的编辑成果**，不是编辑过程。
 */

import type {
  Clip,
  FontFamily,
  FontSource,
  LutId,
  LutSource,
  MediaSource,
  SourceFacts,
  SourceId,
  TextClip,
  Timeline,
  Track,
} from "../edl/types";
import { clipSourceId } from "../edl/types";
import type { Rational } from "../time/rational";
import { withNormalizedTracks } from "./operations";

/**
 * 快照格式版本。**改了 EDL 的形状就要 +1。**
 *
 * 不带版本号的后果不是"读出来是旧的"，而是**读出来是坏的**：少一个字段的
 * `Timeline` 在类型上过不去，但从 IndexedDB 出来的东西没有类型，会一路流到
 * 合成器里才炸，而那时早已看不出是快照的问题。版本不认就当没有存过（见
 * `readSnapshot` 的调用方），代价是丢一次未保存的编辑，比恢复出一个半坏的项目好。
 *
 * 这一轮 4 → 5：`Timeline` 加了 `name` / `namedByUser`，存法也从单键 `current`
 * 换成按项目 id 存（D37）。旧的 `current` 记录版本不认、自动不可见，不迁移。
 *
 * **纯加法的可选字段不算"改了形状"，不要为它 +1。** 判据是上面那句话的理由：
 * 老记录读出来是不是**坏的**。`MediaClip.speed`（变速，D39）就是这一类——老快照
 * 没有这个字段，而 `clipSpeed()` 对"没有"给出的答案恰好就是正确答案（1×），
 * 没有任何东西会流到合成器里才炸。这时候 +1 会把用户现有的项目全部变成不可见，
 * 为的是防一个不存在的问题；而 4 → 5 和 2 → 3 都不是这一类（前者换了存储键的
 * 形状，后者把 `MediaSource` 改成判别联合，老记录真的解释不出来）。
 */
export const SNAPSHOT_VERSION = 5;

/** 项目 id。存储层的概念，不进 EDL——`Timeline` 自己不知道也不需要知道它是哪个项目。 */
export type ProjectId = string;

/** 界面显示"还没取过名"的项目用的名字。数据层的判据是 `name === undefined`，不是这串文案。 */
export const UNNAMED_PROJECT = "未命名项目";

/**
 * 素材在快照里的样子：除 `file` 之外的一切。文件本身单独存一份，见 `project-store.ts`。
 *
 * **必须是分配式的 `Omit`。** `MediaSource` 是判别联合，而 `Omit<A | B, K>` 会先把
 * 联合塌成"两边共有的字段"再去掉 K——于是 `SourceMeta` 里只剩 id / name / kind /
 * hasAudio / audioCodec，帧率、尺寸、时长全部消失。存的时候不报错（多余字段照样
 * 写进 IndexedDB），读回来拼 `{...meta, file}` 才编译不过；真正坏的形态是它**编译
 * 得过**的那一天——快照少一半字段，恢复出来的素材没有时长。
 */
export type SourceMeta = SourceFacts;
/** LUT 在快照里的样子：除查表数据之外的一切。 */
export type LutMeta = Omit<LutSource, "rgb">;
/**
 * 字体在快照里的样子：除字节之外的一切。
 *
 * 字节要剥出去的理由和 `File` 完全相同：快照**每次编辑都重写**，而字体文件一辈子
 * 只写一次。一个 CJK 字体动辄 10–20MB，混在快照里就是拖一下片段重写 20MB。
 */
export type FontMeta = Omit<FontSource, "data">;

export interface SnapshotTimeline extends Omit<Timeline, "sources" | "luts" | "fonts"> {
  readonly sources: readonly SourceMeta[];
  readonly luts?: readonly LutMeta[];
  readonly fonts?: readonly FontMeta[];
}

export interface ProjectSnapshot {
  readonly version: number;
  /**
   * 存盘时刻（毫秒）。**由调用方传进来**，不在这里取——纯函数取当前时间就没法单测，
   * 而"上次编辑于几点"要显示在恢复提示上，是用户判断"这份值不值得恢复"的唯一依据。
   */
  readonly savedAt: number;
  /** 播放头不进撤销栈，但恢复时接着上次的位置看是免费的好处。 */
  readonly playhead: number;
  readonly timeline: SnapshotTimeline;
}

/** 恢复时能从资产库里拿回来的东西。拿不回来的那些由 `fromSnapshot` 负责收拾。 */
export interface RestoreAssets {
  readonly files: ReadonlyMap<SourceId, File>;
  readonly luts: ReadonlyMap<LutId, Float32Array>;
  /**
   * 字体字节。**只有在本上下文注册成功的才该出现在这里**——`loadProject()` 读回字节
   * 之后当场 `registerFont()`，装不上的就不放进来，于是它们走"拿不回来"那条路。
   * 这样"EDL 里有的字体一定注册过"这条纪律在恢复路径上也是结构性的。
   */
  readonly fonts: ReadonlyMap<FontFamily, ArrayBuffer>;
}

export interface DroppedSource {
  readonly name: string;
  /** 因为它而被移除的片段数。0 表示这个素材没被用到，移除它不损失任何编辑。 */
  readonly clips: number;
}

export interface RestoreResult {
  readonly timeline: Timeline;
  readonly playhead: number;
  /** 文件找不回来的素材。**必须报给用户**，见文件头。 */
  readonly droppedSources: readonly DroppedSource[];
  /** 查表数据找不回来的 LUT 名字。引用它的片段保留，只是不上表。 */
  readonly droppedLuts: readonly string[];
  /** 字节找不回来（或装不上）的字体名字。引用它的片段保留，字体退回兜底。 */
  readonly droppedFonts: readonly string[];
}

export function toSnapshot(timeline: Timeline, playhead: number, savedAt: number): ProjectSnapshot {
  const sources = timeline.sources.map(({ file: _file, ...meta }) => meta);
  const luts = timeline.luts?.map(({ rgb: _rgb, ...meta }) => meta);
  const fonts = timeline.fonts?.map(({ data: _data, ...meta }) => meta);
  return {
    version: SNAPSHOT_VERSION,
    savedAt,
    playhead,
    timeline: {
      ...timeline,
      sources,
      // `exactOptionalPropertyTypes`：没有 LUT 时字段要**不存在**，不是 undefined
      ...(luts !== undefined ? { luts } : {}),
      ...(fonts !== undefined ? { fonts } : {}),
    },
  };
}

/**
 * 把片段上"指向已经不在的东西"的引用摘干净。摘不掉的（素材）由调用方负责删片段。
 *
 * 两条规则**都要过一遍**，不能一条命中就 `continue`：`lutId` 挂在 `ClipBase` 上，
 * 文字片段同样可以有——今天两者同时丢的概率不高，但"先命中的那条把另一条挡掉"
 * 是个不报错的坑，留着迟早踩。
 */
function withoutMissingRefs(
  clip: Clip,
  missingLuts: ReadonlySet<LutId>,
  missingFonts: ReadonlySet<FontFamily>,
): Clip {
  let next = clip;
  if (next.lutId !== undefined && missingLuts.has(next.lutId)) {
    const { lutId: _lutId, ...rest } = next;
    next = rest as Clip;
  }
  if (next.kind === "text") {
    const family = next.style?.fontFamily;
    if (family !== undefined && missingFonts.has(family)) {
      const { fontFamily: _f, ...style } = next.style ?? {};
      // 样式被清空就把 `style` 整个删掉，同状态层那条"改回缺省值要删字段"
      if (Object.keys(style).length > 0) {
        next = { ...next, style } satisfies TextClip;
      } else {
        const { style: _s, ...rest } = next;
        next = rest satisfies TextClip;
      }
    }
  }
  return next;
}

/**
 * 把快照和资产拼回一个可用的 `Timeline`。
 *
 * 版本不认就抛——调用方当"没有存过"处理。**恢复一个半坏的项目比不恢复更坏**：
 * 用户会以为编辑还在，接着改，然后在导出时才发现少了东西。
 */
export function fromSnapshot(snapshot: ProjectSnapshot, assets: RestoreAssets): RestoreResult {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `快照版本不认：存的是 ${snapshot.version}，这个版本只认 ${SNAPSHOT_VERSION}`,
    );
  }

  const sources: MediaSource[] = [];
  const missingSourceIds = new Set<SourceId>();
  const missingSourceNames = new Map<SourceId, string>();
  for (const meta of snapshot.timeline.sources) {
    const file = assets.files.get(meta.id);
    if (file) sources.push({ ...meta, file });
    else {
      missingSourceIds.add(meta.id);
      missingSourceNames.set(meta.id, meta.name);
    }
  }

  const luts: LutSource[] = [];
  const droppedLuts: string[] = [];
  const missingLutIds = new Set<LutId>();
  for (const meta of snapshot.timeline.luts ?? []) {
    const rgb = assets.luts.get(meta.id);
    if (rgb) luts.push({ ...meta, rgb });
    else {
      missingLutIds.add(meta.id);
      droppedLuts.push(meta.name);
    }
  }

  const fonts: FontSource[] = [];
  const droppedFonts: string[] = [];
  const missingFontFamilies = new Set<FontFamily>();
  for (const meta of snapshot.timeline.fonts ?? []) {
    const data = assets.fonts.get(meta.family);
    if (data) fonts.push({ ...meta, data });
    else {
      missingFontFamilies.add(meta.family);
      droppedFonts.push(meta.name);
    }
  }

  /** 每个丢掉的素材连带走了几个片段。0 也要报——"没用到"和"丢了三段"是两个结论。 */
  const dropCount = new Map<SourceId, number>();
  for (const id of missingSourceIds) dropCount.set(id, 0);

  const tracks: Track[] = snapshot.timeline.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      // **问 `clipSourceId` 而不是判 `kind === "media"`**：图片片段同样带 `sourceId`，
      // 而漏掉它的表现是"图片文件找不回来了，片段却留着"——渲染时那一层静默消失，
      // 而用户得到的提示里也不会提这张图（见 `clipSourceId` 的注释）
      const sourceId = clipSourceId(clip);
      if (sourceId !== null && missingSourceIds.has(sourceId)) {
        dropCount.set(sourceId, (dropCount.get(sourceId) ?? 0) + 1);
        continue;
      }
      // LUT / 字体丢了**不删片段**：它照样渲染，只是不上那张表、字体退回兜底。
      // 见文件头那条不对称
      clips.push(withoutMissingRefs(clip, missingLutIds, missingFontFamilies));
    }
    return { ...track, clips };
  });

  // **过一遍和每次编辑同一个归一化器。** 删掉片段会留下指向不存在交界的转场
  // （转场挂在入场片段上、相邻关系不由类型保证，见 CLAUDE.md 状态层约定），
  // 而时间轴总长也要跟着重算——两件事都已经在 `withNormalizedTracks` 里
  // **`sources` / `luts` / `fonts` 必须从展开里摘掉**，不能只靠后面覆盖：`luts` 为空时
  // 我们不写这个字段，于是快照里那份 `LutMeta[]`（没有 `rgb`）会原样漏进 `Timeline`
  // ——类型上就过不去，而这正是那道 `exactOptionalPropertyTypes` 拦住的东西
  const { sources: _s, luts: _l, fonts: _f, ...rest } = snapshot.timeline;
  const base: Timeline = {
    ...rest,
    sources,
    ...(luts.length > 0 ? { luts } : {}),
    ...(fonts.length > 0 ? { fonts } : {}),
  };
  const timeline = withNormalizedTracks(base, tracks);

  const droppedSources = [...dropCount.entries()].map(([id, clips]) => ({
    name: missingSourceNames.get(id) ?? id,
    clips,
  }));

  return {
    timeline,
    // 恢复出来的播放头要落在新时长内：素材丢了之后时间轴可能短了一大截，
    // 播放头留在外面会让预览一开始就是黑的，看着像恢复失败
    playhead: Math.max(0, Math.min(snapshot.playhead, Math.max(0, timeline.durationFrames - 1))),
    droppedSources,
    droppedLuts,
    droppedFonts,
  };
}

/**
 * 这个值是不是一份本版本认得的快照。**列项目时的过滤器**：`meta` store 里可能躺着
 * 旧版本的记录（比如单项目时代的 `current` 键，v4），版本不认的直接不出现在列表里
 * ——同 `fromSnapshot` 那条"恢复一个半坏的项目比不恢复更坏"，只是这里连问都不问。
 */
export function isSnapshotUsable(value: unknown): value is ProjectSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<ProjectSnapshot>;
  const timeline = snapshot.timeline as Partial<SnapshotTimeline> | undefined;
  return (
    snapshot.version === SNAPSHOT_VERSION &&
    typeof snapshot.savedAt === "number" &&
    typeof snapshot.playhead === "number" &&
    typeof timeline === "object" &&
    timeline !== null &&
    Array.isArray(timeline.tracks) &&
    Array.isArray(timeline.sources)
  );
}

/**
 * 每个素材被多少个片段引用。指认页要显示"用在 4 个片段"——**跳过它就丢这么多**。
 *
 * 问 `clipSourceId()` 而不是判 `kind === "media"`：图片片段同样带 `sourceId`，
 * 漏掉它的表现是"跳过之后又多丢了几个片段，而提示里没提这张图"。
 */
export function countClipsBySource(timeline: SnapshotTimeline): Map<SourceId, number> {
  const counts = new Map<SourceId, number>();
  for (const meta of timeline.sources) counts.set(meta.id, 0);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      const sourceId = clipSourceId(clip);
      if (sourceId === null) continue;
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 把指认到的新文件的元数据换进快照。**按 `sourceId` 查表，所以顺序无关**——
 * 这正是"指认结果不按顺序配对"那条判据的落点（D37）。
 *
 * 换的是帧率 / 尺寸 / 时长这些**描述文件本身**的字段，`id` 由调用方保住（见
 * `reidentifiedFrom`）。为什么必须换而不是只换文件，见 `state/reidentify.ts` 文件头。
 */
export function withReplacedSources(
  snapshot: ProjectSnapshot,
  overrides: ReadonlyMap<SourceId, SourceMeta>,
): ProjectSnapshot {
  if (overrides.size === 0) return snapshot;
  return {
    ...snapshot,
    timeline: {
      ...snapshot.timeline,
      sources: snapshot.timeline.sources.map((meta) => overrides.get(meta.id) ?? meta),
    },
  };
}

/** 带画面的素材在快照里的样子。首页抽封面帧只认它——纯音频和图片项目退回类型图标（D37）。 */
export type AvSourceMeta = Extract<SourceMeta, { kind: "av" }>;

export interface PosterTarget {
  readonly source: AvSourceMeta;
  /** 那个片段的入点（源片栅格帧号）。封面抽的是"第一个视频片段的首帧"，不是源片第 0 帧。 */
  readonly sourceIn: number;
}

/**
 * 首页卡片封面该抽哪一帧："第一个视频片段的首帧"（D37）。
 *
 * 只认引用 `av` 素材的 `media` 片段：图片没有"抽帧"这回事，纯音频没有画面。
 * 同一帧起点时取更靠下的轨（主视频在最底下）——那是用户眼里"打底"的那一层。
 */
export function posterTarget(timeline: SnapshotTimeline): PosterTarget | null {
  const avById = new Map<SourceId, AvSourceMeta>();
  for (const meta of timeline.sources) {
    if (meta.kind === "av") avById.set(meta.id, meta);
  }
  let best: PosterTarget | null = null;
  let bestAt = Infinity;
  let bestTrack = -1;
  for (let index = 0; index < timeline.tracks.length; index++) {
    const track = timeline.tracks[index]!;
    if (track.kind !== "video") continue;
    for (const clip of track.clips) {
      if (clip.kind !== "media") continue;
      const meta = avById.get(clip.sourceId);
      if (!meta) continue;
      if (clip.timelineIn < bestAt || (clip.timelineIn === bestAt && index > bestTrack)) {
        best = { source: meta, sourceIn: clip.sourceIn };
        bestAt = clip.timelineIn;
        bestTrack = index;
      }
    }
  }
  return best;
}

/** 首页一张卡片要显示的一切。从快照算出来，不需要资产库。 */
export interface ProjectSummary {
  readonly id: ProjectId;
  /** `null` = 还没取过名，界面显示 `UNNAMED_PROJECT`。 */
  readonly name: string | null;
  readonly savedAt: number;
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  readonly durationFrames: number;
  readonly clipCount: number;
  /** 素材元数据，供"离线素材"惰性检查用（文件本身在资产库里）。 */
  readonly sources: readonly SourceMeta[];
  readonly poster: PosterTarget | null;
}

export function summarizeProject(id: ProjectId, snapshot: ProjectSnapshot): ProjectSummary {
  const { timeline } = snapshot;
  return {
    id,
    name: timeline.name ?? null,
    savedAt: snapshot.savedAt,
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    durationFrames: timeline.durationFrames,
    clipCount: timeline.tracks.reduce((n, t) => n + t.clips.length, 0),
    sources: timeline.sources,
    poster: posterTarget(timeline),
  };
}

/**
 * 重命名后的快照（首页那条路：项目没装进 store，直接改快照）。
 *
 * `namedByUser` 在这里置位，同 `operations.ts` 的 `renameProject`——两条路都是
 * "用户给名字"的入口。名字的校验（去空白、拒空）归调用方，这里只管形状。
 */
export function renamedSnapshot(
  snapshot: ProjectSnapshot,
  name: string,
  savedAt: number,
): ProjectSnapshot {
  return { ...snapshot, savedAt, timeline: { ...snapshot.timeline, name, namedByUser: true } };
}

/**
 * 制作副本：同一份时间轴换个名字。
 *
 * **`sources` 原样保留（两个项目共享 `sourceId`）——这是对的**：`File` 是磁盘引用，
 * 复制毫无意义。它的代价是"删掉副本绝不能顺手删 assets"（D37），清理只能走
 * "全项目引用集合 + 够老"那条路。`namedByUser` 摘掉：「X 副本」是系统起的名字，
 * 不是用户给的。
 */
export function duplicatedSnapshot(snapshot: ProjectSnapshot, savedAt: number): ProjectSnapshot {
  const { namedByUser: _named, ...timeline } = snapshot.timeline;
  return {
    ...snapshot,
    savedAt,
    timeline: { ...timeline, name: `${snapshot.timeline.name ?? UNNAMED_PROJECT} 副本` },
  };
}
