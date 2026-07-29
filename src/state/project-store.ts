/**
 * 项目的存储层：把 EDL 按项目存进 IndexedDB（M4 起多项目，D37）。
 *
 * 取舍全在 `project-snapshot.ts`（纯函数、可单测），这里只负责存取。
 *
 * ## 存法
 *
 * `meta` store 按 **项目 id** 一条记录一份快照（单项目时代的单键 `current` 是 v4，
 * 版本不认、列表里自动不可见，不迁移——同"版本不认按没存过处理"）。
 * `assets` 按 `sourceId` / `lutId` / 字体族名存原始数据，**全项目共享**：`File` 是
 * 磁盘引用，「制作副本」两个项目引用同一个 `sourceId` 是对的，所以**删项目绝不能
 * 顺手删 assets**——没人引用的资产归"孤儿 + 够老"的清理管（D37）。
 *
 * ## 为什么素材和快照分两个 store
 *
 * **快照每次编辑都要重写，素材一辈子只写一次。** 混在一条记录里的话，拖一下片段
 * 就要把几百 MB 的 `File` 连带重写一遍——自动存盘会变成整个编辑器最慢的东西，
 * 而且 iOS 上那是最容易被系统杀掉的时刻。
 *
 * ## `File` 存进 IndexedDB 靠得住吗
 *
 * 结构化克隆认 `File`，浏览器存的是**对磁盘上那个文件的引用**（不复制内容），
 * 所以代价很低。代价低的另一面是它**会失效**：用户把文件移走 / 删掉 / 改了内容，
 * 取回来的 `File` 属性正常，**一读就抛**。所以打开时必须**真读一个字节**去验
 * （`isReadable`），不能光看它存不存在——那正是"别把某个浏览器给的元数据
 * 当成事实"在存储层的翻版。验不过的素材由 `fromSnapshot` 收拾并报给用户。
 *
 * ## 存不下的时候
 *
 * 自动存盘失败**不能打断编辑**（配额满、隐私模式下 IndexedDB 不可用都会抛），
 * 所以写入路径一律吞错并把原因记在 `lastSaveError` 上，由界面决定要不要说一句。
 */

import { registerFont } from "../compose/font-registry";
import type {
  FontFamily,
  FontSource,
  LutId,
  LutSource,
  MediaSource,
  SourceId,
  Timeline,
} from "../edl/types";
import type { Rational } from "../time/rational";
import {
  fontAssetKey,
  lutAssetKey,
  planCleanup,
  referencedAssetKeys,
  sourceAssetKey,
  type AssetEntry,
  type CleanupPlan,
  type StorageReadout,
} from "./asset-cleanup";
import {
  countClipsBySource,
  duplicatedSnapshot,
  fromSnapshot,
  isSnapshotUsable,
  renamedSnapshot,
  summarizeProject,
  toSnapshot,
  withReplacedSources,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSummary,
  type RestoreAssets,
  type RestoreResult,
  type SourceMeta,
} from "./project-snapshot";
import type { MissingSource, Reidentified } from "./reidentify";

const DB_NAME = "kerf";
const DB_VERSION = 1;
/** 快照：一个项目一条记录，键就是 `ProjectId`。 */
const META_STORE = "meta";
/** 原始素材与 LUT / 字体数据，按 id 存，全项目共享。 */
const ASSET_STORE = "assets";

/** 最近一次写入失败的原因；没失败过是 null。落盘失败的读数从这里来（D37）。 */
let lastSaveError: string | null = null;
export function lastPersistError(): string | null {
  return lastSaveError;
}

export function newProjectId(): ProjectId {
  // 同 `media/source-id.ts` 那条纪律：模块级计数器随页面加载重置，跨会话必撞
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `proj-${crypto.randomUUID()}`;
  }
  return `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("此环境没有 IndexedDB"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("打不开 IndexedDB"));
    // 另一个标签升级同一个库时会卡在这里，报出来而不是无限等
    request.onblocked = () => reject(new Error("IndexedDB 被另一个标签占着，升不上去"));
  });
  // 打不开就别把失败的 promise 缓存一辈子——用户可能只是当时在隐私模式里
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = fn(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        // 事务级失败（配额满就在这里）和请求级失败都要接住
        request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
      }),
  );
}

// ---------------------------------------------------------------- 资产

/**
 * 资产记录：数据 + 写入时间。
 *
 * `writtenAt` 是给"孤儿 + 够老"的清理准备的（D37）：只看引用在单标签下成立，
 * 两个标签就不成立——标签 A 刚导入素材（`assets` 已写、快照还没写），标签 B
 * 回首页点清理，当场删掉 A 刚导入的那份。"够老"那道闸拦的就是它。
 *
 * **旧记录是裸值（没有时间戳）。清理遇到没有时间戳的记录，必须当作"这一轮先别删"
 * 并顺手回填一个时间戳（首次见到时补上）**——绝不能当成"没有时间戳 = 很老 = 可以删"，
 * 那会把加时间戳之前导入的所有素材一次删光，而且不报错。
 */
interface AssetRecord {
  readonly data: unknown;
  readonly writtenAt: number;
}

function wrapAsset(data: unknown): AssetRecord {
  return { data, writtenAt: Date.now() };
}

/** 取出资产数据，裸值旧记录原样返回。 */
function assetPayload(record: unknown): unknown {
  if (
    record !== null &&
    typeof record === "object" &&
    "data" in record &&
    "writtenAt" in record
  ) {
    return (record as AssetRecord).data;
  }
  return record;
}

/**
 * 把一个素材的文件收进资产库。**导入时调一次就够。**
 *
 * 和 `saveProject` 一样只记不抛，但后果不同：这一份没存上，下次打开时这个素材
 * 就会被判成"找不回来"、它的片段会被移除。所以返回值有意义，调用方可以决定
 * 要不要提示"这个素材不会被保住"。
 */
export async function putSourceAsset(source: MediaSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(source.file), sourceAssetKey(source.id)));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function putLutAsset(lut: LutSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(lut.rgb), lutAssetKey(lut.id)));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function putFontAsset(font: FontSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(font.data), fontAssetKey(font.family)));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/**
 * 真读一个字节，确认这个 `File` 还指向一个能读的文件。
 *
 * 存进 IndexedDB 的是对磁盘文件的引用；文件被移走或改过之后，取回来的对象
 * **属性全都正常**（`name` / `size` / `lastModified` 都在），只有真去读才会抛
 * `NotReadableError`。读 1 个字节而不是整份：代价与文件大小无关，
 * 而失效是整份失效，一个字节就够判。
 */
async function isReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** 从资产库取一个素材文件（不验可读性）。首页抽封面帧用。 */
export async function readSourceFile(id: SourceId): Promise<File | null> {
  try {
    const record = await run<unknown>(ASSET_STORE, "readonly", (s) => s.get(sourceAssetKey(id)));
    const file = assetPayload(record);
    return file instanceof File ? file : null;
  } catch {
    return null;
  }
}

/**
 * 这批素材里哪些已经读不动了（文件失效或压根没存上）。
 *
 * 首页卡片的「N 个素材找不到了」和指认页的名单是**同一个读数**，所以只有这一个
 * 实现：两处各写一遍的话，卡片说"2 个找不到"而指认页列出 3 行是完全可能的，
 * 而那种不一致没有任何东西会报错。
 */
export async function unreadableSourceIds(
  sources: readonly SourceMeta[],
): Promise<Set<SourceId>> {
  const missing = new Set<SourceId>();
  for (const meta of sources) {
    const file = await readSourceFile(meta.id);
    if (!file || !(await isReadable(file))) missing.add(meta.id);
  }
  return missing;
}

/**
 * 这批素材里有几个已经读不动了。
 *
 * 首页卡片的「N 个素材找不到了」从这里来。**每个项目一次、卡片各自异步填**——
 * 全部项目 × 全部素材是 N×M 次读，同步等它会卡首屏（D37）。
 */
export async function countUnreadableSources(sources: readonly SourceMeta[]): Promise<number> {
  return (await unreadableSourceIds(sources)).size;
}

// ---------------------------------------------------------------- 项目

/**
 * 存一次快照。**失败只记不抛**——自动存盘炸掉不该打断编辑。
 *
 * 空项目也存：用户清空了时间轴，那份"空"同样是编辑成果；新建项目也靠它先落一条
 * 记录，让"回到首页"能看见刚建的项目。
 */
export async function saveProject(
  id: ProjectId,
  timeline: Timeline,
  playhead: number,
): Promise<boolean> {
  try {
    const snapshot = toSnapshot(timeline, playhead, Date.now());
    await run(META_STORE, "readwrite", (s) => s.put(snapshot, id));
    lastSaveError = null;
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/**
 * 列出所有项目，按改动时间倒序（最近的排第一，首页给它黄铜描边）。
 *
 * 键和值要在**同一个事务**里取——分两个事务的话，另一个标签在中间删了一个项目，
 * 键值就错位一格，每张卡片显示的都是别的项目的内容。
 */
export async function listProjects(): Promise<ProjectSummary[]> {
  let keys: IDBValidKey[];
  let values: unknown[];
  try {
    const db = await openDb();
    [keys, values] = await new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
      const tx = db.transaction(META_STORE, "readonly");
      const store = tx.objectStore(META_STORE);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      tx.oncomplete = () => resolve([keysReq.result, valuesReq.result]);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 请求失败"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
    });
  } catch {
    // 读不出来当空列表：隐私模式下首页照样要能开，提示归落盘失败那条读数管
    return [];
  }

  const summaries: ProjectSummary[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const value = values[i];
    // 版本不认（含单项目时代的 `current`）就不出现在列表里，见 `isSnapshotUsable`
    if (typeof key !== "string" || !isSnapshotUsable(value)) continue;
    summaries.push(summarizeProject(key, value));
  }
  summaries.sort((a, b) => b.savedAt - a.savedAt);
  return summaries;
}

async function readSnapshot(id: ProjectId): Promise<ProjectSnapshot | null> {
  try {
    const value = await run<unknown>(META_STORE, "readonly", (s) => s.get(id));
    return isSnapshotUsable(value) ? value : null;
  } catch {
    return null;
  }
}

export interface StoredProject extends RestoreResult {
  /** 存盘时刻（毫秒）。 */
  readonly savedAt: number;
}

/**
 * 打开之前先看一眼：这个项目有哪些素材读不动。**只读，一个字节都不写。**
 *
 * 拆成"先验一眼"和"带着指认结果装载"两步，是为了让离线素材有出路（D37）：
 * `loadProject` 直接把读不动的素材连带片段丢掉，而**丢掉这件事在用户表态之前
 * 不能发生**。这一步只报告，不装载、不落盘——所以"打开看一眼再退回首页"
 * 一个片段都不会丢。
 */
export interface ProjectInspection {
  readonly id: ProjectId;
  readonly name: string | null;
  readonly savedAt: number;
  /** 项目帧率。纯音频素材的栅格是派生的，描述它的时长要用这个（`sourceGridFps`）。 */
  readonly fps: Rational;
  /** 读不动的素材，连带它牵着多少片段。空数组 = 可以直接打开。 */
  readonly missing: readonly MissingSource[];
}

export async function inspectProject(id: ProjectId): Promise<ProjectInspection | null> {
  const snapshot = await readSnapshot(id);
  if (!snapshot) return null;
  const missingIds = await unreadableSourceIds(snapshot.timeline.sources);
  const counts = countClipsBySource(snapshot.timeline);
  return {
    id,
    name: snapshot.timeline.name ?? null,
    savedAt: snapshot.savedAt,
    fps: snapshot.timeline.fps,
    missing: snapshot.timeline.sources
      .filter((meta) => missingIds.has(meta.id))
      .map((meta) => ({ meta, clips: counts.get(meta.id) ?? 0 })),
  };
}

/**
 * 把指认结果落盘。**文件和元数据成对写，而且先写快照再写文件。**
 *
 * 成对：只换文件不换元数据会留下一个陈旧的第二真值来源，错起来是静默的
 * （见 `state/reidentify.ts` 文件头）。所以两者要么都写上，要么都别写。
 *
 * 顺序：写一半时，"新元数据 + 老（读不动的）文件"仍然落在**离线**这个安全的桶里
 * ——下次打开照样问一遍。反过来"新文件 + 老元数据"才是危险的那半，会静默取错帧。
 * 所以先快照后文件，让部分失败落在安全的那一侧。
 *
 * 只在**用户明确指认**之后调用；「跳过」一个字节都不写（那是破坏性的，留给
 * 第一次编辑去写死）。
 */
export async function commitReidentified(
  id: ProjectId,
  replacements: ReadonlyMap<SourceId, Reidentified>,
): Promise<boolean> {
  if (replacements.size === 0) return true;
  const snapshot = await readSnapshot(id);
  if (!snapshot) return false;
  const metas = new Map<SourceId, SourceMeta>();
  for (const [sourceId, next] of replacements) metas.set(sourceId, next.meta);
  try {
    await run(META_STORE, "readwrite", (s) => s.put(withReplacedSources(snapshot, metas), id));
    for (const [sourceId, next] of replacements) {
      await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(next.file), sourceAssetKey(sourceId)));
    }
    lastSaveError = null;
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/**
 * 读回一个项目。没有或版本不认时返回 null（**按"没存过"处理**：恢复一个半坏的
 * 时间轴比不恢复更坏，理由见 `project-snapshot.ts` 文件头）。
 *
 * 素材验的是**真读一个字节**；读不动的素材，其片段由 `fromSnapshot` 移除并记在
 * `droppedSources` 里——**必须报给用户**。被移除的结果只在用户第一次编辑落盘时
 * 才写回去，所以"打开看一眼再关掉"不会把丢片段写死（指认页靠的正是这一点）。
 *
 * `replacements` 是指认结果（按 `sourceId`，**不按顺序**）：它同时换掉文件和元数据，
 * 于是那些素材不再算"找不回来"，片段留住。落盘归 `commitReidentified`，两件事分开
 * 是刻意的——装载是每次打开都做的，落盘只在用户明确指认过之后做。
 */
export async function loadProject(
  id: ProjectId,
  replacements?: ReadonlyMap<SourceId, Reidentified>,
): Promise<StoredProject | null> {
  const stored = await readSnapshot(id);
  if (!stored) return null;
  // 元数据先换（`id` 不变），后面读资产、拼时间轴用的就都是新文件的帧率和尺寸
  const metas = new Map<SourceId, SourceMeta>();
  for (const [sourceId, next] of replacements ?? []) metas.set(sourceId, next.meta);
  const snapshot = withReplacedSources(stored, metas);

  const files = new Map<SourceId, File>();
  const luts = new Map<LutId, Float32Array>();
  const fonts = new Map<FontFamily, ArrayBuffer>();
  try {
    for (const meta of snapshot.timeline.sources) {
      // 指认进来的文件直接用：它刚被用户挑出来、探针也刚读过，比再验一遍可靠
      const replaced = replacements?.get(meta.id);
      if (replaced) {
        files.set(meta.id, replaced.file);
        continue;
      }
      const file = await readSourceFile(meta.id);
      // 存在**且读得动**才算拿回来了，见 `isReadable`
      if (file && (await isReadable(file))) files.set(meta.id, file);
    }
    for (const meta of snapshot.timeline.luts ?? []) {
      const record = await run<unknown>(ASSET_STORE, "readonly", (s) => s.get(lutAssetKey(meta.id)));
      const rgb = assetPayload(record);
      if (rgb instanceof Float32Array) luts.set(meta.id, rgb);
    }
    for (const meta of snapshot.timeline.fonts ?? []) {
      const record = await run<unknown>(ASSET_STORE, "readonly", (s) =>
        s.get(fontAssetKey(meta.family)),
      );
      const data = assetPayload(record);
      if (!(data instanceof ArrayBuffer) || data.byteLength === 0) continue;
      // **读回来就当场注册**，装不上的当"拿不回来"。同 `File` 那条"真读一个字节"：
      // 字节存在不等于它还是个字体，而不注册就把它放进时间轴的话，渲染时
      // `rasterizeText` 会抛（见 compose/font-registry.ts 文件头那条纪律）
      try {
        await registerFont({ ...meta, data });
        fonts.set(meta.family, data);
      } catch (error) {
        lastSaveError = error instanceof Error ? error.message : String(error);
      }
    }
  } catch {
    // 资产读到一半失败：剩下的当"找不回来"，由 fromSnapshot 收拾并报出来，
    // 比整份放弃好——已经拿回来的那些片段仍然是用户的编辑成果
  }

  const assets: RestoreAssets = { files, luts, fonts };
  try {
    const restored = fromSnapshot(snapshot, assets);
    return { ...restored, savedAt: snapshot.savedAt };
  } catch {
    return null;
  }
}

/**
 * 删掉一个项目。**只删快照，不碰 assets**——「制作副本」让两个项目共享 `sourceId`
 * 是刻意的（`File` 是引用，复制毫无意义），顺手删资产会把原项目的素材一起删掉。
 * 没人引用的资产归"孤儿 + 够老"的清理管。
 */
export async function deleteProject(id: ProjectId): Promise<boolean> {
  try {
    await run(META_STORE, "readwrite", (s) => s.delete(id));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** 重命名一个**没装进 store** 的项目（首页那条路）。名字须已去空白且非空。 */
export async function renameStoredProject(id: ProjectId, name: string): Promise<boolean> {
  const snapshot = await readSnapshot(id);
  if (!snapshot) return false;
  try {
    await run(META_STORE, "readwrite", (s) => s.put(renamedSnapshot(snapshot, name, Date.now()), id));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

// ---------------------------------------------------------------- 存储读数与清理

/**
 * 这个窗口能不能持久化。**能则返回 null**，不能则返回原因。
 *
 * 隐私模式 / 被策略禁掉时 IndexedDB 根本打不开，那是从第一次写就注定的**能力性
 * 事实**，不该等用户编辑半天才说——首页进来就要提示（D24 的"折叠回根因"：它和
 * 配额满的派生现象相同，出路完全不同）。
 */
export async function probePersistence(): Promise<string | null> {
  try {
    await openDb();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** 量一条资产记录占多少字节。量不出来的按 0 记——**宁可少报，不要编**。 */
function assetBytes(payload: unknown): number {
  if (payload instanceof File || payload instanceof Blob) return payload.size;
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  return 0;
}

/** 资产记录的写入时刻；裸值旧记录**没有**，返回 null（见 `asset-cleanup.ts` 文件头）。 */
function assetWrittenAt(record: unknown): number | null {
  if (
    record !== null &&
    typeof record === "object" &&
    "writtenAt" in record &&
    typeof (record as AssetRecord).writtenAt === "number"
  ) {
    return (record as AssetRecord).writtenAt;
  }
  return null;
}

interface AssetScan {
  readonly entries: readonly AssetEntry[];
  /** 字体与 LUT 的字节合计。**`File` 是磁盘引用，不算进存储读数。** */
  readonly storedBytes: number;
}

/**
 * 扫一遍资产库。键、字节、写入时刻都在这里量，取舍归 `asset-cleanup.ts`。
 *
 * 键和值要在**同一个事务**里取——分两个事务的话，另一个标签在中间写了一条，
 * 键值就错位一格，于是"这个键有多大 / 多老"全部对错人（同 `listProjects`）。
 */
async function scanAssets(): Promise<AssetScan> {
  let keys: IDBValidKey[];
  let values: unknown[];
  try {
    const db = await openDb();
    [keys, values] = await new Promise<[IDBValidKey[], unknown[]]>((resolve, reject) => {
      const tx = db.transaction(ASSET_STORE, "readonly");
      const store = tx.objectStore(ASSET_STORE);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      tx.oncomplete = () => resolve([keysReq.result, valuesReq.result]);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 请求失败"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
    });
  } catch {
    return { entries: [], storedBytes: 0 };
  }

  const entries: AssetEntry[] = [];
  let storedBytes = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key !== "string") continue;
    const record = values[i];
    const bytes = assetBytes(assetPayload(record));
    entries.push({ key, bytes, writtenAt: assetWrittenAt(record) });
    // 素材文件是磁盘引用，占的不是浏览器存储；只有 LUT 和字体是真存进来的字节
    if (!key.startsWith("source:")) storedBytes += bytes;
  }
  return { entries, storedBytes };
}

/** 全部快照（清理要算"所有项目"的引用集合，漏一个项目就删一批）。 */
async function allSnapshots(): Promise<ProjectSnapshot[]> {
  try {
    const values = await run<unknown[]>(META_STORE, "readonly", (s) => s.getAll());
    return values.filter(isSnapshotUsable);
  } catch {
    return [];
  }
}

export interface StorageStatus {
  readonly readout: StorageReadout;
  readonly plan: CleanupPlan;
}

/**
 * 存储读数 + 清理计划。**自己数，不问 `estimate()`**（理由见 `asset-cleanup.ts`）。
 *
 * 快照字节用 `JSON.stringify` 的长度量：EDL 是纯数据，这个数和真实占用同量级，
 * 而且**它和括号里的分项来自同一次扫描**，对得上账——那正是不问 `estimate().usage`
 * 的理由（那个数会把 OPFS 导出残留混进来，与分项对不上）。
 */
export async function measureStorage(): Promise<StorageStatus> {
  const [snapshots, scan] = await Promise.all([allSnapshots(), scanAssets()]);
  let projectBytes = 0;
  for (const snapshot of snapshots) {
    try {
      projectBytes += JSON.stringify(snapshot).length;
    } catch {
      /* 量不出来就不算这一份，宁可少报 */
    }
  }
  const referenced = referencedAssetKeys(snapshots.map((s) => s.timeline));
  return {
    readout: { projectBytes, assetBytes: scan.storedBytes },
    plan: planCleanup(scan.entries, referenced, Date.now()),
  };
}

/**
 * 执行清理。**删孤儿 + 给没有时间戳的旧记录回填时间戳。**
 *
 * 回填是这件事的另一半，而且是不能省的一半：那些记录这一轮**不删**（不知道多老），
 * 回填之后它们从现在开始计龄，够老了才真的可清。少了回填，它们会永远停在"待定"。
 */
export async function runCleanup(plan: CleanupPlan): Promise<{ removed: number; bytes: number }> {
  let removed = 0;
  let bytes = 0;
  for (const entry of plan.removable) {
    try {
      await run(ASSET_STORE, "readwrite", (s) => s.delete(entry.key));
      removed += 1;
      bytes += entry.bytes;
    } catch (error) {
      lastSaveError = error instanceof Error ? error.message : String(error);
    }
  }
  for (const entry of plan.needsStamp) {
    try {
      // 读回来再包一层时间戳写回去。**不能凭 entry 重建数据**——那里只有字节数
      const record = await run<unknown>(ASSET_STORE, "readonly", (s) => s.get(entry.key));
      const payload = assetPayload(record);
      if (payload === undefined) continue;
      await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(payload), entry.key));
    } catch (error) {
      lastSaveError = error instanceof Error ? error.message : String(error);
    }
  }
  return { removed, bytes };
}

/** 制作副本。返回副本的摘要（列表刷新前界面就能说出「X 副本」）。 */
export async function duplicateProject(id: ProjectId): Promise<ProjectSummary | null> {
  const snapshot = await readSnapshot(id);
  if (!snapshot) return null;
  const copy = duplicatedSnapshot(snapshot, Date.now());
  const copyId = newProjectId();
  try {
    await run(META_STORE, "readwrite", (s) => s.put(copy, copyId));
    return summarizeProject(copyId, copy);
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return null;
  }
}
