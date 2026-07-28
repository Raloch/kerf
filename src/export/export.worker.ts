/// <reference lib="webworker" />
/**
 * 导出 Worker。
 *
 * 解码、合成、编码、封装全在这里，主线程只负责 UI 和进度显示——
 * 否则导出期间界面完全卡死（CLAUDE.md 硬规则 6）。
 *
 * **音频混流不在这里**：`OfflineAudioContext` 在 Worker 里不可用，
 * PCM 由主线程混好 transfer 进来（见 `audio/mixdown.ts`）。而且是**按段拉**的
 * ——整条一次性传过来，一小时的项目就是 2GB。所以这里有一个小邮箱
 * （`AudioChunkChannel`）：流水线发 `audio-pull`，主线程回 `audio-chunk`，
 * 邮箱把那条消息接回到等着的那个 Promise 上。
 *
 * 结果也不再回传字节：`StreamTarget` 已经把成品写进用户选定的文件或 OPFS
 * （硬规则 9），回传的只有元信息。
 *
 * **这个 Worker 跨导出存活**（主线程侧见 `client.ts`）：合成器常驻在里面，
 * 每次导出复用同一个渲染上下文。原因是换 Pixi 之后"每导出一次建一个 WebGL
 * 上下文"会把预览挤掉，见 `pipeline.ts` 的 `acquireCompositor`。所以这里
 * 每条消息都要把状态复位干净——它不再是"一次性"的。
 */

import type { MixChunk } from "../audio/mixdown";
import { ExportCanceled, releaseResidentCompositor, runExport } from "./pipeline";
import type { RunId, WorkerRequest, WorkerResponse } from "./protocol";

let canceled = false;
let running = false;
/**
 * 当前这一次导出的编号。**跨导出常驻的 Worker 必须认号**，理由见
 * `protocol.ts` 的 `RunId`——不认号时上一次留下的 `cancel` 会掐掉这一次。
 */
let currentRun: RunId | null = null;

function post(message: WorkerResponse): void {
  self.postMessage(message);
}

/**
 * 音频分段的邮箱：把 `audio-chunk` 消息接回到 `pull()` 那个 Promise 上。
 *
 * **同时可以有不止一个未决请求**：`makeAudioPump` 会预取，好让主线程混第 k+1 段
 * 的同时这边在编第 k 段的视频。所以按段序号索引，而不是留一个槽位——留一个槽位
 * 的第一版当场就炸在"请求重入"上。
 *
 * 取消时要把等着的那些 Promise 都叫醒（`reject`），否则流水线会永远停在
 * `await pullAudio()` 上——用户点了取消而进度条不动，Worker 也不退出。
 */
class AudioChunkChannel {
  private readonly pending = new Map<
    number,
    { readonly resolve: (chunk: MixChunk | null) => void; readonly reject: (e: Error) => void }
  >();

  pull(runId: RunId, index: number): Promise<MixChunk | null> {
    if (this.pending.has(index)) {
      return Promise.reject(new Error(`音频分段请求重复：第 ${index} 段已经在等了`));
    }
    const promise = new Promise<MixChunk | null>((resolve, reject) => {
      this.pending.set(index, { resolve, reject });
      post({ type: "audio-pull", runId, index });
    });
    // 兜底一个 rejection 处理器：`abort()` 可能在流水线已经因为别的原因倒下、
    // 没人再 await 这个 Promise 时开火，那会变成 unhandled rejection——在 Worker
    // 里表现为 `onerror`，主线程据此把这个常驻 Worker 当成坏的 terminate 掉
    promise.catch(() => undefined);
    return promise;
  }

  deliver(index: number, chunk: MixChunk | null, error?: string): void {
    const waiting = this.pending.get(index);
    if (!waiting) return;
    this.pending.delete(index);
    // 主线程混这一段炸了：**不能当成"音频到此为止"**，那会静默产出被截短的音轨
    if (error) waiting.reject(new Error(error));
    else waiting.resolve(chunk);
  }

  abort(reason: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const one of waiting) one.reject(reason);
  }
}

const audioChannel = new AudioChunkChannel();

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  // **认号，不认号的丢掉。** 这两条都是"针对某一次导出"的消息，而 Worker 活得比
  // 任何一次导出都长。放过去的代价实测过：别人的 cancel 会掐掉正在跑的这一次，
  // 而两边都不抛错（见 `protocol.ts` 的 `RunId`）
  if (message.type === "cancel") {
    if (message.runId !== currentRun) return;
    canceled = true;
    audioChannel.abort(new ExportCanceled());
    return;
  }

  if (message.type === "audio-chunk") {
    if (message.runId !== currentRun) return;
    audioChannel.deliver(message.index, message.chunk, message.error);
    return;
  }

  if (message.type === "release") {
    // 跑着的时候不能放——合成器正被逐帧写。这时忽略即可：
    // 导出结束后主线程会再发一次
    if (!running) releaseResidentCompositor();
    return;
  }

  if (message.type !== "start") return;
  const runId = message.runId;
  if (running) {
    post({ type: "error", runId, message: "已有导出任务在进行中" });
    return;
  }

  running = true;
  canceled = false;
  currentRun = runId;

  try {
    const result = await runExport(message.request, {
      onProgress: (progress) => post({ type: "progress", runId, progress }),
      isCanceled: () => canceled,
      pullAudio: (index) => audioChannel.pull(runId, index),
    });
    post({ type: "done", runId, result });
  } catch (error) {
    const message_ = error instanceof Error ? error.message : String(error);
    if (error instanceof ExportCanceled) {
      post({ type: "canceled", runId });
    } else if (canceled) {
      // **取消期间倒下的，真实原因照报。** 早先这里是 `ExportCanceled || canceled`
      // 一起归成"已取消"，于是取消前后真正抛出来的东西（`Decoder failure` 那一类）
      // 被一句"导出被取消"盖掉——而那正是要查的。同 M0 那条"两个操作数都要印出来"
      post({ type: "error", runId, message: `取消期间失败：${message_}` });
    } else {
      post({ type: "error", runId, message: message_ });
    }
  } finally {
    running = false;
    currentRun = null;
    // Worker 跨导出存活，邮箱也是。上一次要是在等一段 PCM 的时候失败了，
    // 那个槽位不清掉，下一次导出的第一次 pull 就会被当成"请求重入"直接拒掉
    audioChannel.abort(new Error("导出已结束"));
  }
};
