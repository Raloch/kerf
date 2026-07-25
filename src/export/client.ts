/**
 * 主线程侧的导出入口：起 Worker、转发进度、支持取消。
 */

import type { ExportDone, ExportProgress, ExportRequest, WorkerRequest, WorkerResponse } from "./protocol";

export interface ExportHandle {
  readonly done: Promise<ExportDone | null>;
  cancel(): void;
}

/** 返回 null 表示用户取消。 */
export function startExport(
  request: ExportRequest,
  onProgress: (progress: ExportProgress) => void,
): ExportHandle {
  const worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
    type: "module",
    name: "kerf-export",
  });

  let settled = false;

  const done = new Promise<ExportDone | null>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          onProgress(message.progress);
          break;
        case "done":
          settled = true;
          resolve(message.result);
          worker.terminate();
          break;
        case "canceled":
          settled = true;
          resolve(null);
          worker.terminate();
          break;
        case "error":
          settled = true;
          reject(new Error(message.message));
          worker.terminate();
          break;
      }
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      reject(new Error(event.message || "导出 Worker 异常退出"));
      worker.terminate();
    };
  });

  const startMessage: WorkerRequest = { type: "start", request };
  worker.postMessage(startMessage);

  return {
    done,
    cancel() {
      if (settled) return;
      const cancelMessage: WorkerRequest = { type: "cancel" };
      worker.postMessage(cancelMessage);
    },
  };
}

/** 触发浏览器下载。M1 起改用 File System Access API 流式写盘。 */
export function downloadBytes(bytes: Uint8Array, filename: string, mimeType: string): void {
  const view = new Uint8Array(bytes);
  const blob = new Blob([view], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // 立刻 revoke 会让部分浏览器的下载中断，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
