/**
 * 主线程侧的导出入口。
 *
 * 主线程做三件 Worker 做不了的事：
 *
 * 1. **混音**——`OfflineAudioContext` 在 Worker 里不可用（硬规则 6）。
 * 2. **调保存位置的 picker**——必须在用户手势里同步调起，所以由调用方在点击
 *    回调里先拿到 `WriteTargetSpec` 再传进来。
 * 3. **OPFS 回退时触发下载**——Worker 里没有 DOM。
 *
 * 其余（解码、合成、编码、封装）全在 Worker，导出期间界面不卡。
 */

import type { MixedAudio } from "../audio/mixdown";
import type { RenderRange, Timeline } from "../edl/types";
import type { ContainerChoice } from "../media/capability";
import type {
  ExportDone,
  ExportProgress,
  ExportRequest,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import { downloadFromOpfs, type WriteTargetSpec } from "./write-target";

export interface ExportOptions {
  readonly timeline: Timeline;
  readonly range: RenderRange;
  readonly container: ContainerChoice;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  /** 关掉就完全不混音，成片没有音轨。 */
  readonly includeAudio: boolean;
  readonly target: WriteTargetSpec;
  /** 成品写完后自动触发下载（仅 OPFS 回退路径需要；picker 路径已经写进用户选的文件）。 */
  readonly autoDownload?: boolean;
}

export interface ExportHandle {
  /** 返回 null 表示用户取消。 */
  readonly done: Promise<ExportDone | null>;
  cancel(): void;
}

export function startExport(
  options: ExportOptions,
  onProgress: (progress: ExportProgress) => void,
): ExportHandle {
  const totalFrames = options.range.outFrame - options.range.inFrame;
  let canceled = false;
  let worker: Worker | null = null;

  const done = (async (): Promise<ExportDone | null> => {
    // ---- 阶段 1：主线程混音 ----
    // 动态 import：mixdown 拖着 mediabunny 的运行时（约 500KB），
    // 静态 import 会让它经由导出对话框回到首屏 chunk（实测踩过一次）
    const { mixdown, mixedAudioTransferables } = await import("../audio/mixdown");

    onProgress({ stage: "mix", encodedFrames: 0, totalFrames, elapsedMs: 0 });
    const audio = options.includeAudio
      ? await mixdown(options.timeline, options.range, () => {
          onProgress({ stage: "mix", encodedFrames: 0, totalFrames, elapsedMs: 0 });
        })
      : null;
    if (canceled) return null;

    // ---- 阶段 2：交给 Worker ----
    const request: ExportRequest = {
      timeline: options.timeline,
      range: options.range,
      container: options.container,
      videoBitrate: options.videoBitrate,
      audioBitrate: options.audioBitrate,
      audio,
      target: options.target,
    };

    const result = await runInWorker(
      request,
      audio ? mixedAudioTransferables(audio) : [],
      onProgress,
      (w) => {
        worker = w;
        // 混音期间用户就点了取消
        if (canceled) w.postMessage({ type: "cancel" } satisfies WorkerRequest);
      },
    );

    if (!result) return null;

    // ---- 阶段 3：OPFS 回退路径把成品交给浏览器下载 ----
    if (result.opfsName && options.autoDownload !== false) {
      await downloadFromOpfs(result.opfsName, result.mimeType);
    }
    return result;
  })();

  return {
    done,
    cancel() {
      canceled = true;
      worker?.postMessage({ type: "cancel" } satisfies WorkerRequest);
    },
  };
}

function runInWorker(
  request: ExportRequest,
  audioTransfer: Transferable[],
  onProgress: (progress: ExportProgress) => void,
  onReady: (worker: Worker) => void,
): Promise<ExportDone | null> {
  const worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
    type: "module",
    name: "kerf-export",
  });

  let settled = false;

  const promise = new Promise<ExportDone | null>((resolve, reject) => {
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

  // PCM 可能有几百 MB，必须 transfer 而不是结构化克隆——克隆会整份复制一遍
  const startMessage: WorkerRequest = { type: "start", request };
  worker.postMessage(startMessage, audioTransfer);
  onReady(worker);

  return promise;
}
