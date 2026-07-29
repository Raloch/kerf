/**
 * 无引用资产的清理与存储读数（D37 第 3 刀）。**纯函数，IndexedDB 那层只存取。**
 *
 * ## 判据是"孤儿 + 够老"，不是"没人引用"
 *
 * 只看引用**在一个标签里成立，两个标签就不成立**：标签 A 正在编辑（刚导入一个素材，
 * `assets` 已经写了、快照还没写），标签 B 回到首页点了清理——当场把 A 刚导入的那份
 * 删掉。`project-store.ts` 里那句 `onblocked`「被另一个标签占着」说明这个仓库知道
 * 多标签存在，而"入口互斥"那类做法在跨标签时拦不住。所以再加一道年龄闸。
 *
 * 误删的表现是**下次打开项目素材丢了、片段被移除，而且全程不报错**——这正是
 * D37 列的第二个失败形态，也是这一层必须是纯函数、必须有单测的理由。
 *
 * ## 没有时间戳的旧记录：这一轮先别删，顺手回填
 *
 * `assets` 的值在第 1 刀之前是**裸值**（没有 `writtenAt`）。遇到没有时间戳的记录，
 * 判据必须是**"这一轮先别删"并回填一个时间戳**（首次见到时补上）。
 *
 * **绝不能当成"没有时间戳 = 很老 = 可以删"**——那会把加时间戳之前导入的所有素材
 * 一次删光，而且不报错。回填之后它们从"现在"开始计龄，一段时间后才真的可清。
 *
 * ## 引用集合要从"所有"项目算
 *
 * 漏一个项目就删一批。「制作副本」让两个项目共享同一个 `sourceId` 是**对的**
 * （`File` 是磁盘引用，复制毫无意义），所以"这个素材还有没有人用"只能全局回答。
 *
 * ## 存储读数自己数，空态沉默
 *
 * 同导出层那条"内存要自己数，不要问浏览器"：`estimate().usage` 会把 OPFS 导出残留
 * 混进来，总数和括号里的分项**对不上账**，而对不上账的读数比没有读数更坏（残留仍归
 * 导出面板的 `.dlg-tidy` 管）。一个字节都没存时**不报**——`quota` 不是磁盘空间，
 * 跨浏览器语义不一致，摆出来必然被读成"磁盘剩多少"，而编一个数字比沉默更坏（D25）。
 */

import type { FontFamily, LutId, SourceId } from "../edl/types";
import type { SnapshotTimeline } from "./project-snapshot";

/**
 * 孤儿资产要多老才准删。
 *
 * 守的是上面那个跨标签窗口：导入之后 `assets` 立刻写，而快照要等自动存盘防抖 1 秒，
 * 所以危险窗口本身只有一两秒。取 1 小时是**刻意留出几个数量级的余量**——另一个标签
 * 可能正卡在一次失败的落盘上（配额满时快照写不进去，而素材已经写了），那种情形下
 * 引用关系会缺很久。代价只是"刚导错的文件要过一阵才清得掉"，而误删是不可逆的。
 */
export const CLEANUP_MIN_AGE_MS = 60 * 60 * 1000;

// 资产的键格式**只有这一处定义**。散在读写两侧各写一遍 `source:${id}` 的话，
// 清理侧算出来的"引用集合"会和存储侧的键差一个字，而那表现为"清理把所有素材都
// 当成孤儿"——删光且不报错。
export function sourceAssetKey(id: SourceId): string {
  return `source:${id}`;
}
export function lutAssetKey(id: LutId): string {
  return `lut:${id}`;
}
export function fontAssetKey(family: FontFamily): string {
  return `font:${family}`;
}

/** 资产库里的一条记录（`bytes` 由存储层量，这一层只做取舍）。 */
export interface AssetEntry {
  readonly key: string;
  readonly bytes: number;
  /** 写入时刻。**`null` = 加时间戳之前的旧记录**，见文件头。 */
  readonly writtenAt: number | null;
}

/**
 * 所有项目引用到的资产键。**必须传全部项目的时间轴**——漏一个就删一批。
 */
export function referencedAssetKeys(timelines: readonly SnapshotTimeline[]): Set<string> {
  const keys = new Set<string>();
  for (const timeline of timelines) {
    // 素材按 `sources` 算而不是按片段算：导入了但一个片段都没放的素材**照样是被引用的**
    // （用户还能把它拖上时间轴）。按片段算会把它当孤儿删掉，而素材库里那一行还在
    for (const source of timeline.sources) keys.add(sourceAssetKey(source.id));
    for (const lut of timeline.luts ?? []) keys.add(lutAssetKey(lut.id));
    for (const font of timeline.fonts ?? []) keys.add(fontAssetKey(font.family));
  }
  return keys;
}

export interface CleanupPlan {
  /** 孤儿且够老：可以删。 */
  readonly removable: readonly AssetEntry[];
  readonly removableBytes: number;
  /** 孤儿但**还不够老**：这一轮先别删（跨标签窗口，见文件头）。 */
  readonly tooYoung: readonly AssetEntry[];
  /** 孤儿且**没有时间戳**：这一轮先别删，回填一个时间戳。 */
  readonly needsStamp: readonly AssetEntry[];
}

/**
 * 算一遍"能清掉什么"。**只算不删**——删是存储层的事，而且只在用户明确点时做
 * （不做后台自动 GC：误删不报错）。
 */
export function planCleanup(
  entries: readonly AssetEntry[],
  referenced: ReadonlySet<string>,
  now: number,
  minAgeMs: number = CLEANUP_MIN_AGE_MS,
): CleanupPlan {
  const removable: AssetEntry[] = [];
  const tooYoung: AssetEntry[] = [];
  const needsStamp: AssetEntry[] = [];
  for (const entry of entries) {
    if (referenced.has(entry.key)) continue;
    if (entry.writtenAt === null) {
      // **不是"很老所以能删"**，是"不知道多老所以这一轮不动"，见文件头
      needsStamp.push(entry);
      continue;
    }
    if (now - entry.writtenAt < minAgeMs) {
      tooYoung.push(entry);
      continue;
    }
    removable.push(entry);
  }
  return {
    removable,
    removableBytes: removable.reduce((sum, e) => sum + e.bytes, 0),
    tooYoung,
    needsStamp,
  };
}

/** 清理按钮上的文案。没什么可清时返回 null——按钮跟着消失，不摆一个"0 项"。 */
export function cleanupLabel(plan: CleanupPlan): string | null {
  if (plan.removable.length === 0) return null;
  return `清理没人用的 · ${plan.removable.length} 项 / ${formatBytes(plan.removableBytes)}`;
}

export interface StorageReadout {
  /** 快照（EDL）占的字节。 */
  readonly projectBytes: number;
  /** 字体与 LUT 的字节。**视频 / 音频 / 图片是磁盘引用，不算在这里。** */
  readonly assetBytes: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 首页底部那行存储读数。**一个字节都没存时返回 null**（空态沉默，见文件头）。
 *
 * 不能笼统写"素材不占浏览器存储"：`File` 是磁盘引用不占字节，但 **LUT 的 rgb 和
 * 字体的字节是真存进 IndexedDB 的**（45³ LUT = 1.09MB，一个 CJK 字体 10–20MB），
 * 所以带字体的项目会显示 2MB 而实际占 20MB。分项要写明白。
 */
export function storageLine(readout: StorageReadout): string | null {
  const total = readout.projectBytes + readout.assetBytes;
  if (total <= 0) return null;
  const parts = [`项目 ${formatBytes(readout.projectBytes)}`];
  if (readout.assetBytes > 0) parts.push(`字体与 LUT ${formatBytes(readout.assetBytes)}`);
  return `浏览器里存了 ${formatBytes(total)}（${parts.join(" · ")}）· 视频音频图片是磁盘引用，不占这里`;
}
