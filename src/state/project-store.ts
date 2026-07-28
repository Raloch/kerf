/**
 * 崩溃恢复的存储层：把 EDL 自动存进 IndexedDB，下次打开能捡回来。
 *
 * 取舍全在 `project-snapshot.ts`（纯函数、可单测），这里只负责存取。
 *
 * ## 为什么素材和快照分两个 store
 *
 * **快照每次编辑都要重写，素材一辈子只写一次。** 混在一条记录里的话，拖一下片段
 * 就要把几百 MB 的 `File` 连带重写一遍——自动存盘会变成整个编辑器最慢的东西，
 * 而且 iOS 上那是最容易被系统杀掉的时刻。所以：`meta` 存快照（几十 KB，随便写），
 * `assets` 按 `sourceId` / `lutId` 存原始数据（导入时写一次，之后只读）。
 *
 * ## `File` 存进 IndexedDB 靠得住吗
 *
 * 结构化克隆认 `File`，浏览器存的是**对磁盘上那个文件的引用**（不复制内容），
 * 所以代价很低。代价低的另一面是它**会失效**：用户把文件移走 / 删掉 / 改了内容，
 * 取回来的 `File` 属性正常，**一读就抛**。所以恢复时必须**真读一个字节**去验
 * （`assertReadable`），不能光看它存不存在——那正是"别把某个浏览器给的元数据
 * 当成事实"在存储层的翻版。验不过的素材由 `fromSnapshot` 收拾并报给用户。
 *
 * ## 存不下的时候
 *
 * 自动存盘失败**不能打断编辑**（配额满、隐私模式下 IndexedDB 不可用都会抛），
 * 所以写入路径一律吞错并把原因记在 `lastSaveError` 上，由界面决定要不要说一句。
 * 静默失败在这里是可接受的降级：用户没有丢任何东西，只是失去了崩溃恢复。
 */

import type { LutId, LutSource, MediaSource, SourceId, Timeline } from "../edl/types";
import {
  fromSnapshot,
  snapshotHasWork,
  toSnapshot,
  type ProjectSnapshot,
  type RestoreAssets,
  type RestoreResult,
} from "./project-snapshot";

const DB_NAME = "kerf";
const DB_VERSION = 1;
/** 快照：一个项目一条记录。目前只有"当前项目"这一个隐含项目，见 PLAN.md D23。 */
const META_STORE = "meta";
/** 原始素材与 LUT 数据，按 id 存。 */
const ASSET_STORE = "assets";
const CURRENT_KEY = "current";

/** 最近一次写入失败的原因；没失败过是 null。界面可以据此说一句"崩溃恢复没在工作"。 */
let lastSaveError: string | null = null;
export function lastPersistError(): string | null {
  return lastSaveError;
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

/**
 * 存一次快照。**失败只记不抛**——自动存盘炸掉不该打断编辑。
 *
 * 空项目也存：用户清空了时间轴，那份"空"同样是编辑成果，留着旧快照会让下次打开
 * 提议恢复一个已经被删掉的项目。要不要提议由 `snapshotHasWork` 判，不由存不存判。
 */
export async function saveProject(timeline: Timeline, playhead: number): Promise<boolean> {
  try {
    const snapshot = toSnapshot(timeline, playhead, Date.now());
    await run(META_STORE, "readwrite", (s) => s.put(snapshot, CURRENT_KEY));
    lastSaveError = null;
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/**
 * 把一个素材的文件收进资产库。**导入时调一次就够。**
 *
 * 和 `saveProject` 一样只记不抛，但后果不同：这一份没存上，下次恢复时这个素材
 * 就会被判成"找不回来"、它的片段会被移除。所以返回值有意义，调用方可以决定
 * 要不要提示"这个素材不会被崩溃恢复保住"。
 */
export async function putSourceAsset(source: MediaSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(source.file, `source:${source.id}`));
    return true;
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error);
    return false;
  }
}

export async function putLutAsset(lut: LutSource): Promise<boolean> {
  try {
    await run(ASSET_STORE, "readwrite", (s) => s.put(lut.rgb, `lut:${lut.id}`));
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
 * `NotReadableError`。只看属性就等于把浏览器给的元数据当事实——同 CLAUDE.md 那条
 * "别把某个浏览器读到的时间戳当成事实"。
 *
 * 读 1 个字节而不是整份：代价与文件大小无关，而失效是整份失效，一个字节就够判。
 */
async function isReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export interface StoredProject extends RestoreResult {
  /** 存盘时刻（毫秒），显示在恢复提示上。 */
  readonly savedAt: number;
}

/**
 * 读回上次的项目。没有、版本不认、或者一个片段都没有时返回 null。
 *
 * **版本不认按"没存过"处理**（`fromSnapshot` 会抛，这里吞掉）：恢复一个半坏的
 * 时间轴比不恢复更坏，理由见 `project-snapshot.ts` 文件头。
 */
export async function loadProject(): Promise<StoredProject | null> {
  let snapshot: ProjectSnapshot | undefined;
  try {
    snapshot = await run<ProjectSnapshot | undefined>(META_STORE, "readonly", (s) =>
      s.get(CURRENT_KEY),
    );
  } catch {
    return null;
  }
  if (!snapshot || typeof snapshot !== "object" || !snapshotHasWork(snapshot)) return null;

  const files = new Map<SourceId, File>();
  const luts = new Map<LutId, Float32Array>();
  try {
    for (const meta of snapshot.timeline.sources) {
      const file = await run<File | undefined>(ASSET_STORE, "readonly", (s) =>
        s.get(`source:${meta.id}`),
      );
      // 存在**且读得动**才算拿回来了，见 `isReadable`
      if (file instanceof File && (await isReadable(file))) files.set(meta.id, file);
    }
    for (const meta of snapshot.timeline.luts ?? []) {
      const rgb = await run<Float32Array | undefined>(ASSET_STORE, "readonly", (s) =>
        s.get(`lut:${meta.id}`),
      );
      if (rgb instanceof Float32Array) luts.set(meta.id, rgb);
    }
  } catch {
    // 资产读到一半失败：剩下的当"找不回来"，由 fromSnapshot 收拾并报出来，
    // 比整份放弃好——已经拿回来的那些片段仍然是用户的编辑成果
  }

  const assets: RestoreAssets = { files, luts };
  try {
    const restored = fromSnapshot(snapshot, assets);
    return { ...restored, savedAt: snapshot.savedAt };
  } catch {
    return null;
  }
}

/**
 * 丢掉存着的项目和所有资产。
 *
 * 用户点「不恢复」时调——**必须真删，不能只是不用它**。留着的话下次打开又会问
 * 一遍同一个已经被拒绝过的项目，而那是纯噪声。
 */
export async function clearProject(): Promise<void> {
  try {
    await run(META_STORE, "readwrite", (s) => s.clear());
    await run(ASSET_STORE, "readwrite", (s) => s.clear());
    lastSaveError = null;
  } catch {
    /* 清不掉也不该报错打断用户，下次恢复提示还会出现而已 */
  }
}
