/**
 * 导出结果写到哪里。
 *
 * 硬规则 9：**流式写盘，不要攒成 Blob**。M0/M1 用 `BufferTarget` 出内存是权宜之计，
 * 一段 1080p H.264 按 8Mbps 算是 60MB/分钟，十分钟就 600MB 全在堆里，
 * 而且封装完成前一个字节都写不出去——中途失败等于白跑。
 *
 * 两条路：
 *
 * 1. **File System Access API**（Chrome / Edge）：`showSaveFilePicker()` 拿到用户
 *    选定的真实文件，边编码边写进去。峰值内存与片长无关。
 * 2. **OPFS 回退**（Safari / Firefox 没有 picker）：先流式写进 OPFS，
 *    封装完再用 `URL.createObjectURL(file)` 触发下载。仍然是流式写盘——
 *    浏览器从磁盘读文件喂给下载，不需要把整段读进内存。
 *
 * picker **必须在用户手势里同步调起**，所以这一步留在主线程点击回调中；
 * 拿到的 `FileSystemFileHandle` 是可结构化克隆的，能直接 postMessage 进 Worker，
 * 由 Worker 自己 `createWritable()`。
 */

/** 导出临时文件在 OPFS 里的目录。与代理文件分开，方便单独清理。 */
export const EXPORT_DIR = "exports";

export type WriteTargetSpec =
  | { readonly kind: "picked"; readonly handle: FileSystemFileHandle }
  | { readonly kind: "opfs"; readonly name: string };

export function canPickSaveFile(): boolean {
  return typeof globalThis.showSaveFilePicker === "function";
}

/**
 * 让用户选保存位置。**必须在点击等用户手势的同步调用链里调用**，
 * 否则浏览器会以 `SecurityError` 拒绝。
 *
 * 用户取消（`AbortError`）时抛出，由调用方当作"放弃导出"处理，
 * 不要静默退化成 OPFS——那会让文件出现在用户找不到的地方。
 */
export async function pickWriteTarget(
  filename: string,
  container: "mp4" | "webm",
): Promise<WriteTargetSpec> {
  if (!canPickSaveFile()) {
    return { kind: "opfs", name: filename };
  }
  const handle = await globalThis.showSaveFilePicker!({
    suggestedName: filename,
    types: [
      {
        description: container === "mp4" ? "MP4 视频" : "WebM 视频",
        accept: container === "mp4" ? { "video/mp4": [".mp4"] } : { "video/webm": [".webm"] },
      },
    ],
  });
  return { kind: "picked", handle };
}

/** Worker 侧：把 spec 变成可写文件句柄。 */
export async function resolveHandle(spec: WriteTargetSpec): Promise<FileSystemFileHandle> {
  if (spec.kind === "picked") return spec.handle;
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
  return dir.getFileHandle(spec.name, { create: true });
}

/**
 * 把 OPFS 里的成品读成 File（不触发下载）。
 *
 * 自检脚本要读回导出结果做断言，而流式写盘之后管道不再回传字节——
 * 断言只能从落盘的文件读。
 */
export async function readExportFile(name: string): Promise<File> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

export async function removeExportFile(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
    await dir.removeEntry(name);
  } catch {
    // 不存在就算了
  }
}

/** 主线程侧：把 OPFS 里的成品读出来触发下载，然后删掉临时文件。 */
export async function downloadFromOpfs(name: string, mimeType: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(EXPORT_DIR, { create: true });
  const handle = await dir.getFileHandle(name);
  const file = await handle.getFile();

  // 直接用 OPFS 里的 File 建 URL：浏览器从磁盘流式读取喂给下载，
  // 不需要把几百 MB 读进内存再包一个 Blob
  const url = URL.createObjectURL(mimeType ? new File([file], name, { type: mimeType }) : file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();

  // 下载开始前 revoke 会中断传输；删临时文件同理要等下载真正读完
  setTimeout(() => {
    URL.revokeObjectURL(url);
    void dir.removeEntry(name).catch(() => undefined);
  }, 60_000);
}
