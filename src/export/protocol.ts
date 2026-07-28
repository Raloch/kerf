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
 * 多轨混流只能在主线程算好 PCM 再 transfer 进来。请求里带的只有**元信息**
 * （`MixHeader`）——Worker 据此建音轨、探编码器延迟；PCM 本身**按段拉取**：
 * Worker 发 `audio-pull`，主线程混好一段回一条 `audio-chunk`。
 *
 * 之所以是"拉"而不是"推"，是为了**背压**。推的话主线程会尽快把所有段混完发过来，
 * Worker 那边照样堆成整条 PCM，峰值一个字节都没省，只是从主线程搬到了 Worker。
 * 拉才能让同时活着的段数有上界（见 `pipeline.ts` 的 `AudioChunkChannel`）。
 */

import type { Rational } from "../time/rational";
import type { ContainerChoice } from "../media/capability";
import type { RenderRange, Timeline } from "../edl/types";
import type { EncoderDelay } from "../audio/encoder-delay";
import type { CompositorBackend } from "../compose/backend";
import type { MixChunk, MixHeader } from "../audio/mixdown";
import type { ResidencyReport, ResidencySnapshot } from "./residency";
import type { WriteTargetSpec } from "./write-target";

export interface ExportRequest {
  readonly timeline: Timeline;
  /** 导出范围，时间轴帧号，左闭右开。 */
  readonly range: RenderRange;
  readonly container: ContainerChoice;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  /**
   * 主线程混音的元信息。null 表示这次导出没有音频。
   *
   * **PCM 不在这里**——它按段拉取，见文件头。这个字段只回答"要不要建音轨、
   * 采样率和声道数是多少、一共多少样本"，那三件事都发生在逐帧循环开始之前。
   */
  readonly audio: MixHeader | null;
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
  /**
   * 这一刻我们攥着多少资源。见 `residency.ts`——它数的是自己持有量，不是问浏览器。
   *
   * `mix` 阶段没有：混音跑在**主线程**、进 Worker 之前，而计量器是每个 JS 上下文
   * 一份，主线程那份没人喂。混出来的 PCM 有多大会在 Worker 侧作为
   * `audioPcmBytes` 报出来，所以这里缺的只是"混的过程中"那一段。
   */
  readonly residency?: ResidencySnapshot;
}

/**
 * 导出结束时的常驻量小结。
 *
 * `leaked*` 是**跑完之后还没归还的数量**，正常必须全是 0：解码帧和解码器都在
 * reader 的 dispose 里还回去。非 0 就是泄漏，而泄漏在短片上看不出来，
 * 到 30 分钟的片子上才会变成标签页崩掉——所以这个数要跟着每次导出报出来。
 */
export interface ExportResidency extends ResidencyReport {
  readonly leakedSamples: number;
  readonly leakedCursors: number;
  readonly leakedInputs: number;
  /** 上一次导出留下的残留（本次开始前清掉的量）。非 0 说明上一次泄漏了。 */
  readonly leakedFromPrevious: number;
}

export interface ExportDone {
  readonly mimeType: string;
  readonly encodedFrames: number;
  readonly elapsedMs: number;
  readonly audioIncluded: boolean;
  /**
   * 实际用上的渲染后端。**必须和预览一致**（硬规则 2）——一边 Pixi 一边
   * Canvas2D 时，今天只是留边差一个像素，接了滤镜之后就是"预览有效果、成片没有"。
   */
  readonly backend: CompositorBackend;
  /**
   * 这次导出补偿掉的编码器 priming（样本数）。**不是可选的诊断信息**：它意味着
   * 音轨头部有这么长一段被丢弃了（AAC 约 44ms），也意味着没补成时成片会整体
   * 晚这么多。`reason` 非空就是没测出来、退回了未补偿的行为。见 `audio/encoder-delay.ts`。
   */
  readonly audioEncoderDelay: EncoderDelay;
  readonly bytesWritten: number;
  readonly residency: ExportResidency;
  /**
   * 混音那一段的常驻量。**由主线程填**——Worker 产不出这个字段：混音跑在主线程
   * （硬规则 6：`OfflineAudioContext` 在 Worker 里不可用），而计量器每个 JS 上下文
   * 一份。长片的峰值很可能就在这里而不在导出循环里，所以两段都要报。
   */
  readonly mixResidency?: ResidencyReport;
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
  /**
   * 应答一次 `audio-pull`。`chunk` 为 null 表示**没有更多段了**。
   *
   * `error` 非空表示主线程混这一段时炸了。**不能当成"音频结束"处理**——那会
   * 静默产出一条被截短的音轨（硬规则 10 那类"选了 A 拿到 B"），必须让整次导出失败。
   */
  | {
      readonly type: "audio-chunk";
      /**
       * 应答的是哪一次 `audio-pull`。
       *
       * **不能靠 `chunk.index` 认领**：`chunk` 为 null（产完了 / 混炸了）时没有
       * 段序号可读，而那恰恰是必须把等着的那个 Promise 叫醒的时刻。同时在飞的
       * 请求不止一个（预取），认领错了就是死等。
       */
      readonly index: number;
      readonly chunk: MixChunk | null;
      readonly error?: string;
    }
  | { readonly type: "cancel" }
  /**
   * 放掉常驻资源（合成器画布），但**不结束 Worker**。
   *
   * Worker 跨导出存活是为了让渲染上下文只建一次（见 `client.ts` 与
   * `pipeline.ts` 的 `acquireCompositor`）；代价是一个 4K 项目的画布会一直占着。
   * 这个口子让"关掉导出面板"能把它还回去，而不必连 Worker 一起销毁——
   * 销毁了下次导出就又要新建一个上下文，正是要避免的事。
   */
  | { readonly type: "release" };

export type WorkerResponse =
  | { readonly type: "progress"; readonly progress: ExportProgress }
  /** 要第 `index` 段 PCM。主线程按序应答一条 `audio-chunk`。 */
  | { readonly type: "audio-pull"; readonly index: number }
  | { readonly type: "done"; readonly result: ExportDone }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "canceled" };
