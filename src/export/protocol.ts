/**
 * 主线程 ↔ 导出 Worker 的消息协议。
 *
 * 请求里带的是**整份 EDL**，不是一个文件加一对帧号。这是硬规则 2 的要求：
 * 预览按 EDL 取帧，导出也必须按同一份 EDL 取帧，否则"共用 compose()"只保证了
 * 画法一致，而"该画哪个片段、读源片哪一刻"仍是两套逻辑——M1 的导出只认单个
 * 文件，正是这个漏洞，多片段时间轴的一致性完全没有护栏。
 *
 * `Timeline` 是纯数据（数字、字符串、`File`），可以直接结构化克隆，
 * 不需要额外的序列化层。`File` 克隆进 Worker 不复制内容，只是转移引用。
 *
 * **音频例外**：Worker 里没有 `OfflineAudioContext`（硬规则 6），
 * 多轨混流只能在主线程算好 PCM 再 transfer 进来，所以 `audio` 是请求的一部分，
 * 而不是 Worker 自己去混。
 */

import type { Rational } from "../time/rational";
import type { ContainerChoice } from "../media/capability";
import type { RenderRange, Timeline } from "../edl/types";
import type { MixedAudio } from "../audio/mixdown";
import type { WriteTargetSpec } from "./write-target";

export interface ExportRequest {
  readonly timeline: Timeline;
  /** 导出范围，时间轴帧号，左闭右开。 */
  readonly range: RenderRange;
  readonly container: ContainerChoice;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  /** 主线程混好的 PCM。null 表示这次导出没有音频。 */
  readonly audio: MixedAudio | null;
  readonly target: WriteTargetSpec;
}

/**
 * 导出阶段。
 *
 * `mix` 发生在主线程、进 Worker 之前，但仍然放进同一个进度枚举里——
 * 用户看到的是一条进度，不该因为实现分了线程就断成两截。
 */
export type ExportStage = "mix" | "prepare" | "video" | "finalize";

export interface ExportProgress {
  readonly stage: ExportStage;
  readonly encodedFrames: number;
  readonly totalFrames: number;
  /** 已耗时（毫秒），用于算实时倍数。 */
  readonly elapsedMs: number;
}

export interface ExportDone {
  readonly mimeType: string;
  readonly encodedFrames: number;
  readonly elapsedMs: number;
  readonly audioIncluded: boolean;
  readonly bytesWritten: number;
  /** 走 OPFS 回退时的文件名；主线程据此读回触发下载。picker 路径为 undefined。 */
  readonly opfsName?: string | undefined;
}

/** 时间轴帧率随 EDL 走，单独列出来只为进度显示方便。 */
export interface ExportPlan {
  readonly fps: Rational;
  readonly totalFrames: number;
}

export type WorkerRequest =
  | { readonly type: "start"; readonly request: ExportRequest }
  | { readonly type: "cancel" };

export type WorkerResponse =
  | { readonly type: "progress"; readonly progress: ExportProgress }
  | { readonly type: "done"; readonly result: ExportDone }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "canceled" };
