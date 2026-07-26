/// <reference lib="webworker" />
/**
 * 导出 Worker。
 *
 * 解码、合成、编码、封装全在这里，主线程只负责 UI 和进度显示——
 * 否则导出期间界面完全卡死（CLAUDE.md 硬规则 6）。
 *
 * **音频混流不在这里**：`OfflineAudioContext` 在 Worker 里不可用，
 * PCM 由主线程混好 transfer 进来（见 `audio/mixdown.ts`）。
 *
 * 结果也不再回传字节：`StreamTarget` 已经把成品写进用户选定的文件或 OPFS
 * （硬规则 9），回传的只有元信息。
 */

import { ExportCanceled, runExport } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let canceled = false;
let running = false;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    canceled = true;
    return;
  }

  if (message.type !== "start") return;
  if (running) {
    post({ type: "error", message: "已有导出任务在进行中" });
    return;
  }

  running = true;
  canceled = false;

  try {
    const result = await runExport(message.request, {
      onProgress: (progress) => post({ type: "progress", progress }),
      isCanceled: () => canceled,
    });
    post({ type: "done", result });
  } catch (error) {
    if (error instanceof ExportCanceled || canceled) {
      post({ type: "canceled" });
    } else {
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    running = false;
  }
};
