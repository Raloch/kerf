/**
 * 代理文件：导入后在后台转出的低分辨率副本，专供预览使用。
 *
 * 为什么必须有：预览走 `video.currentTime` seek，而 4K 源片每次 seek 都要解一个
 * GOP 的高分辨率帧，拖动播放头会明显跟不上手。转成 720p 后 seek 成本降一个量级。
 * 导出**始终读原片**——代理只是为了预览流畅，绝不能影响成片画质。
 *
 * 存在 OPFS 而不是内存：一个 10 分钟的 720p 代理有几十 MB，攒在内存里几个素材就爆了
 * （硬规则 9 的同一条理由）。OPFS 还能跨会话复用，重开项目不用重新转。
 */

import type { Rational } from "../time/rational";

/** 代理规格。720p 是预览流畅度与转码耗时的平衡点。 */
export const PROXY_HEIGHT = 720;
export const PROXY_BITRATE = 2.5e6;
const PROXY_DIR = "proxies";

export type ProxyStatus = "none" | "queued" | "working" | "ready" | "failed";

export interface ProxyInfo {
  readonly status: ProxyStatus;
  /** 0–1，仅 working 时有意义。 */
  readonly progress: number;
  /** 就绪后可直接喂给 <video> 的 blob URL。 */
  readonly url?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly reason?: string | undefined;
}

export const NO_PROXY: ProxyInfo = { status: "none", progress: 0 };

/**
 * 代理文件名。带上源片尺寸与时长，源文件换了内容但同名时不会错读旧代理。
 * 不用文件内容哈希——那要把整个文件读一遍，代价比转码省下来的还大。
 */
export function proxyKey(
  name: string,
  width: number,
  height: number,
  durationFrames: number,
): string {
  const safe = name.replace(/[^\w.\-]+/g, "_").slice(-60);
  return `${safe}.${width}x${height}.${durationFrames}f.h${PROXY_HEIGHT}.mp4`;
}

async function proxyDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(PROXY_DIR, { create: true });
}

/** 已有代理就返回，没有返回 null。不做任何转码。 */
export async function readProxy(key: string): Promise<File | null> {
  try {
    const dir = await proxyDir();
    const handle = await dir.getFileHandle(key);
    const file = await handle.getFile();
    // 0 字节意味着上次转码写了一半就中断了，当作没有
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

export async function writeProxy(key: string, bytes: Uint8Array): Promise<File> {
  const dir = await proxyDir();
  const handle = await dir.getFileHandle(key, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as unknown as BufferSource);
  } finally {
    await writable.close();
  }
  return handle.getFile();
}

export async function deleteProxy(key: string): Promise<void> {
  try {
    const dir = await proxyDir();
    await dir.removeEntry(key);
  } catch {
    // 不存在就算了
  }
}

/** 供设置面板用：当前代理占了多少空间。 */
export async function proxyUsage(): Promise<{ count: number; bytes: number }> {
  let count = 0;
  let bytes = 0;
  try {
    const dir = await proxyDir();
    // FileSystemDirectoryHandle 的异步迭代在类型定义里缺失，运行时是有的
    const entries = (dir as unknown as {
      values(): AsyncIterableIterator<FileSystemHandle>;
    }).values();
    for await (const entry of entries) {
      if (entry.kind !== "file") continue;
      const file = await (entry as FileSystemFileHandle).getFile();
      count++;
      bytes += file.size;
    }
  } catch {
    // OPFS 不可用时当作空
  }
  return { count, bytes };
}

export interface ProxyRequest {
  readonly sourceId: string;
  readonly key: string;
  readonly file: File;
  readonly fps: Rational;
  readonly targetHeight: number;
  readonly bitrate: number;
}

export type ProxyWorkerRequest =
  | { readonly type: "transcode"; readonly request: ProxyRequest }
  | { readonly type: "cancel"; readonly sourceId: string };

export type ProxyWorkerResponse =
  | { readonly type: "progress"; readonly sourceId: string; readonly progress: number }
  | {
      readonly type: "done";
      readonly sourceId: string;
      readonly key: string;
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly type: "failed"; readonly sourceId: string; readonly message: string }
  | { readonly type: "canceled"; readonly sourceId: string };
