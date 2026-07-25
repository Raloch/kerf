/// <reference lib="webworker" />
/**
 * 导出 Worker。
 *
 * 解码、合成、编码、封装全在这里，主线程只负责 UI 和进度显示——
 * 否则导出期间界面完全卡死（CLAUDE.md 硬规则 6）。
 */

import { ExportCanceled, runExport } from "./pipeline";
import type { WorkerRequest, WorkerResponse } from "./protocol";

let canceled = false;
let running = false;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  self.postMessage(message, { transfer: transfer ?? [] });
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
    // 把结果字节 transfer 出去，避免几十 MB 的结构化克隆拷贝
    post({ type: "done", result }, [result.bytes.buffer]);
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
