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
import { residency, ResidencyTracker } from "./residency";
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

    // 混音的常驻量要**主线程自己量**：计量器每个 JS 上下文一份，Worker 那份
    // 看不到这一段。而混音恰恰是长片最可能先崩的地方——它要一次性把整条
    // 时间轴的 PCM 分配出来，且中途有两三份同时活着（见 mixdown.ts 文件头）
    const mixTracker = new ResidencyTracker();
    residency.reset();
    const sampleMix = () => {
      mixTracker.sample(0);
      onProgress({
        stage: "mix",
        encodedFrames: 0,
        totalFrames,
        elapsedMs: 0,
        residency: residency.snapshot(),
      });
    };

    sampleMix();
    const audio = options.includeAudio
      ? await mixdown(options.timeline, options.range, sampleMix)
      : null;
    sampleMix();
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
        // 这个回调在 postMessage **之后**才被调，所以 PCM 的所有权已经交给
        // Worker 了（transfer 之后主线程这边是零长数组）。计量报的是"我们还
        // 引用着多少"，那就得在这里销账——否则 mixTracker 的末尾采样会一直
        // 显示几百 MB，看起来像主线程没放手
        residency.setAudioPcmBytes(0);
        sampleMix();
        // 混音期间用户就点了取消
        if (canceled) w.postMessage({ type: "cancel" } satisfies WorkerRequest);
      },
    );

    if (!result) return null;
    // Worker 报的 residency 只覆盖导出循环，混音那一段挂在这里合并回去
    const merged: ExportDone = { ...result, mixResidency: mixTracker.report() };

    // ---- 阶段 3：OPFS 回退路径把成品交给浏览器下载 ----
    if (result.opfsName && options.autoDownload !== false) {
      await downloadFromOpfs(result.opfsName, result.mimeType);
    }
    return merged;
  })();

  return {
    done,
    cancel() {
      canceled = true;
      worker?.postMessage({ type: "cancel" } satisfies WorkerRequest);
    },
  };
}

/**
 * 常驻导出 Worker。**跨导出复用，不再一次一个。**
 *
 * 换 Pixi 之后合成器是个 WebGL 上下文，而浏览器对同时存活的上下文有预算、
 * 超了驱逐**最老的那个**——最老的正是预览。每导出一次就建一个新上下文，
 * Safari 上十几轮就把预览判死，而且**救不回来**（spike 量过：被预算驱逐的
 * 上下文 `recover()` 会超时）。所以合成器必须常驻，而合成器住在 Worker 里，
 * Worker 就得跟着常驻。
 *
 * 出错的那个不留：Worker 抛到顶层之后内部状态不可知，terminate 掉换新的。
 * 正常结束和取消都保留。
 */
let sharedWorker: Worker | null = null;

function getWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  sharedWorker = new Worker(new URL("./export.worker.ts", import.meta.url), {
    type: "module",
    name: "kerf-export",
  });
  return sharedWorker;
}

function discardWorker(worker: Worker): void {
  if (sharedWorker === worker) sharedWorker = null;
  worker.terminate();
}

/**
 * 让常驻 Worker 放掉合成器画布，但**保留 Worker 本身**。
 *
 * 关掉导出面板时调。销毁 Worker 会连渲染上下文一起销毁，下次导出又要新建一个——
 * 正是上面要避免的事。
 */
export function releaseExportResources(): void {
  sharedWorker?.postMessage({ type: "release" } satisfies WorkerRequest);
}

function runInWorker(
  request: ExportRequest,
  audioTransfer: Transferable[],
  onProgress: (progress: ExportProgress) => void,
  onReady: (worker: Worker) => void,
): Promise<ExportDone | null> {
  const worker = getWorker();
  let settled = false;

  const promise = new Promise<ExportDone | null>((resolve, reject) => {
    // 每次导出重挂 handler：Worker 是复用的，上一次的闭包还挂着就会
    // 把这一次的进度报给上一次的调用方
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      switch (message.type) {
        case "progress":
          onProgress(message.progress);
          break;
        case "done":
          settled = true;
          resolve(message.result);
          break;
        case "canceled":
          settled = true;
          resolve(null);
          break;
        case "error":
          settled = true;
          // 业务错误（编码器不可用、写盘失败等）由管道自己收拾干净，
          // Worker 仍然可用，留着它——常驻的意义就在这里
          reject(new Error(message.message));
          break;
      }
    };

    worker.onerror = (event) => {
      if (settled) return;
      settled = true;
      // 这条是**没被捕获**的顶层错误，Worker 内部状态不可知，不能再用
      discardWorker(worker);
      reject(new Error(event.message || "导出 Worker 异常退出"));
    };
  });

  // PCM 可能有几百 MB，必须 transfer 而不是结构化克隆——克隆会整份复制一遍
  const startMessage: WorkerRequest = { type: "start", request };
  worker.postMessage(startMessage, audioTransfer);
  onReady(worker);

  return promise;
}
