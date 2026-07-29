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
import {
  duplicatedSnapshot,
  fromSnapshot,
  isSnapshotUsable,
  renamedSnapshot,
  summarizeProject,
  toSnapshot,
  type ProjectId,
  type ProjectSnapshot,
  type ProjectSummary,
  type RestoreAssets,
  type RestoreResult,
  type SourceMeta,
} from "./project-snapshot";

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
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(source.file), `source:${source.id}`));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function putLutAsset(lut: LutSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(lut.rgb), `lut:${lut.id}`));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function putFontAsset(font: FontSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(wrapAsset(font.data), `font:${font.family}`));
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
    const record = await run<unknown>(ASSET_STORE, "readonly", (s) => s.get(`source:${id}`));
    const file = assetPayload(record);
    return file instanceof File ? file : null;
  } catch {
    return null;
  }
}

/**
 * 这批素材里有几个已经读不动了（文件失效或压根没存上）。
 *
 * 首页卡片的「N 个素材找不到了」从这里来。**每个项目一次、卡片各自异步填**——
 * 全部项目 × 全部素材是 N×M 次读，同步等它会卡首屏（D37）。
 */
export async function countUnreadableSources(sources: readonly SourceMeta[]): Promise<number> {
  let unreadable = 0;
  for (const meta of sources) {
    const file = await readSourceFile(meta.id);
    if (!file || !(await isReadable(file))) unreadable += 1;
  }
  return unreadable;
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
 * 读回一个项目。没有或版本不认时返回 null（**按"没存过"处理**：恢复一个半坏的
 * 时间轴比不恢复更坏，理由见 `project-snapshot.ts` 文件头）。
 *
 * 素材验的是**真读一个字节**；读不动的素材，其片段由 `fromSnapshot` 移除并记在
 * `droppedSources` 里——**必须报给用户**。被移除的结果只在用户第一次编辑落盘时
 * 才写回去，所以"打开看一眼再关掉"不会把丢片段写死（指认页靠的正是这一点）。
 */
export async function loadProject(id: ProjectId): Promise<StoredProject | null> {
  const snapshot = await readSnapshot(id);
  if (!snapshot) return null;

  const files = new Map<SourceId, File>();
  const luts = new Map<LutId, Float32Array>();
  const fonts = new Map<FontFamily, ArrayBuffer>();
  try {
    for (const meta of snapshot.timeline.sources) {
      const file = await readSourceFile(meta.id);
      // 存在**且读得动**才算拿回来了，见 `isReadable`
      if (file && (await isReadable(file))) files.set(meta.id, file);
    }
    for (const meta of snapshot.timeline.luts ?? []) {
      const record = await run<unknown>(ASSET_STORE, "readonly", (s) => s.get(`lut:${meta.id}`));
      const rgb = assetPayload(record);
      if (rgb instanceof Float32Array) luts.set(meta.id, rgb);
    }
    for (const meta of snapshot.timeline.fonts ?? []) {
      const record = await run<unknown>(ASSET_STORE, "readonly", (s) =>
        s.get(`font:${meta.family}`),
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
