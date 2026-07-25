/**
 * 主线程 ↔ 导出 Worker 的消息协议。
 *
 * Worker 里不能碰 DOM，也不能用 Web Audio（OfflineAudioContext 只在主线程可用）。
 * M0 的音频是"单轨转封装"，不需要混音，因此整条管道都能留在 Worker 里；
 * M2 引入多轨混音后，PCM 要在主线程算好再 transfer 进来（见 PLAN.md §4 备注）。
 */

import type { Rational } from "../time/rational";
import type { ContainerChoice } from "../media/capability";

export interface ExportRequest {
  readonly file: File;
  readonly container: ContainerChoice;
  /** 时间轴帧率（有理数）。 */
  readonly fps: Rational;
  readonly width: number;
  readonly height: number;
  /** 导出范围，源片帧号，左闭右开。 */
  readonly inFrame: number;
  readonly outFrame: number;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  readonly includeAudio: boolean;
}

export type ExportStage = "prepare" | "video" | "finalize";

export interface ExportProgress {
  readonly stage: ExportStage;
  readonly encodedFrames: number;
  readonly totalFrames: number;
  /** 已耗时（毫秒），用于算实时倍数。 */
  readonly elapsedMs: number;
}

export interface ExportDone {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly encodedFrames: number;
  readonly elapsedMs: number;
  readonly audioIncluded: boolean;
}

export type WorkerRequest =
  | { readonly type: "start"; readonly request: ExportRequest }
  | { readonly type: "cancel" };

export type WorkerResponse =
  | { readonly type: "progress"; readonly progress: ExportProgress }
  | { readonly type: "done"; readonly result: ExportDone }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "canceled" };
