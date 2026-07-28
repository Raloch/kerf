/**
 * EDL ↔ 可持久化快照的相互转换。**纯函数，不碰 IndexedDB。**
 *
 * 拆成两层的理由和状态层那条"编辑逻辑写在纯函数里"一样：会写错的是**取舍**，
 * 不是存取。`File` 要从 EDL 里剥出去（否则每次自动存盘都可能把几百 MB 的素材
 * 重写一遍）、素材找不回来时哪些片段要跟着走、LUT 找不回来时片段**不该**跟着走、
 * 旧版本快照要干净地拒掉而不是恢复成一个半坏的时间轴——这些都能在 node 里单测，
 * 而 IndexedDB 在 node 里没有。
 *
 * ## 为什么素材和 LUT 的失败处理不对称
 *
 * 素材没了，引用它的片段**必须移除**：`resolveSource()` 找不到就抛，留着会让预览
 * 整个崩掉。LUT 没了，片段仍然完全可渲染（只是不上那张表），所以**只清 `lutId`、
 * 保留片段**。两者都要**报出来**，不能静默——用户丢了三个片段而软件一声不响，
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
  LutId,
  LutSource,
  MediaSource,
  SourceId,
  Timeline,
  Track,
} from "../edl/types";
import { withNormalizedTracks } from "./operations";

/**
 * 快照格式版本。**改了 EDL 的形状就要 +1。**
 *
 * 不带版本号的后果不是"读出来是旧的"，而是**读出来是坏的**：少一个字段的
 * `Timeline` 在类型上过不去，但从 IndexedDB 出来的东西没有类型，会一路流到
 * 合成器里才炸，而那时早已看不出是快照的问题。版本不认就当没有存过（见
 * `readSnapshot` 的调用方），代价是丢一次未保存的编辑，比恢复出一个半坏的项目好。
 */
export const SNAPSHOT_VERSION = 1;

/** 素材在快照里的样子：除 `file` 之外的一切。文件本身单独存一份，见 `project-store.ts`。 */
export type SourceMeta = Omit<MediaSource, "file">;
/** LUT 在快照里的样子：除查表数据之外的一切。 */
export type LutMeta = Omit<LutSource, "rgb">;

export interface SnapshotTimeline extends Omit<Timeline, "sources" | "luts"> {
  readonly sources: readonly SourceMeta[];
  readonly luts?: readonly LutMeta[];
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
}

export function toSnapshot(timeline: Timeline, playhead: number, savedAt: number): ProjectSnapshot {
  const sources = timeline.sources.map(({ file: _file, ...meta }) => meta);
  const luts = timeline.luts?.map(({ rgb: _rgb, ...meta }) => meta);
  return {
    version: SNAPSHOT_VERSION,
    savedAt,
    playhead,
    timeline: {
      ...timeline,
      sources,
      // `exactOptionalPropertyTypes`：没有 LUT 时字段要**不存在**，不是 undefined
      ...(luts !== undefined ? { luts } : {}),
    },
  };
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

  /** 每个丢掉的素材连带走了几个片段。0 也要报——"没用到"和"丢了三段"是两个结论。 */
  const dropCount = new Map<SourceId, number>();
  for (const id of missingSourceIds) dropCount.set(id, 0);

  const tracks: Track[] = snapshot.timeline.tracks.map((track) => {
    const clips: Clip[] = [];
    for (const clip of track.clips) {
      if (clip.kind === "media" && missingSourceIds.has(clip.sourceId)) {
        dropCount.set(clip.sourceId, (dropCount.get(clip.sourceId) ?? 0) + 1);
        continue;
      }
      // LUT 丢了**不删片段**：它照样渲染，只是不上那张表。见文件头那条不对称
      if (clip.lutId !== undefined && missingLutIds.has(clip.lutId)) {
        const { lutId: _lutId, ...rest } = clip;
        clips.push(rest as Clip);
        continue;
      }
      clips.push(clip);
    }
    return { ...track, clips };
  });

  // **过一遍和每次编辑同一个归一化器。** 删掉片段会留下指向不存在交界的转场
  // （转场挂在入场片段上、相邻关系不由类型保证，见 CLAUDE.md 状态层约定），
  // 而时间轴总长也要跟着重算——两件事都已经在 `withNormalizedTracks` 里
  // **`sources` / `luts` 必须从展开里摘掉**，不能只靠后面覆盖：`luts` 为空时
  // 我们不写这个字段，于是快照里那份 `LutMeta[]`（没有 `rgb`）会原样漏进 `Timeline`
  // ——类型上就过不去，而这正是那道 `exactOptionalPropertyTypes` 拦住的东西
  const { sources: _s, luts: _l, ...rest } = snapshot.timeline;
  const base: Timeline = {
    ...rest,
    sources,
    ...(luts.length > 0 ? { luts } : {}),
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
  };
}

/**
 * 这份快照里有没有值得恢复的东西。
 *
 * 空项目也会被存（用户可能只是打开过页面），而拿一个空时间轴去问"要不要恢复上次编辑"
 * 只会让人困惑。判据是**有没有片段**，不是有没有素材：导入了素材但一个片段都没放，
 * 恢复它等于什么都没恢复。
 */
export function snapshotHasWork(snapshot: ProjectSnapshot): boolean {
  return snapshot.timeline.tracks.some((t) => t.clips.length > 0);
}
