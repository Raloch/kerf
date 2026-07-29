/**
 * 代理生成的调度：串行队列 + OPFS 复用。
 *
 * 两条刻意的规则：
 * - **一次只转一个。** 转码吃满硬件编码器，并发只让每个都变慢，还会和导出抢编码器。
 * - **先查 OPFS。** 已经转过的直接用，重开项目不该再等一遍。命中缓存时状态直接跳到 ready。
 */

import {
  NO_PROXY,
  PROXY_BITRATE,
  PROXY_HEIGHT,
  proxyKey,
  readProxy,
  writeProxy,
  type ProxyInfo,
  type ProxyWorkerRequest,
  type ProxyWorkerResponse,
} from "./proxy";
import type { AvSource, MediaSource } from "../edl/types";

export type ProxyListener = (sourceId: string, info: ProxyInfo) => void;

interface Job {
  /** 纯音频素材不进队列，所以这里恒为带画面的素材（`request()` 挡在门口）。 */
  readonly source: AvSource;
  readonly key: string;
}

export class ProxyManager {
  private worker: Worker | null = null;
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private readonly infos = new Map<string, ProxyInfo>();
  /** blob URL 要留着给 <video> 用，销毁时统一 revoke。 */
  private readonly urls = new Map<string, string>();
  private readonly listeners = new Set<ProxyListener>();

  subscribe(listener: ProxyListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  infoFor(sourceId: string): ProxyInfo {
    return this.infos.get(sourceId) ?? NO_PROXY;
  }

  private emit(sourceId: string, info: ProxyInfo): void {
    this.infos.set(sourceId, info);
    for (const listener of this.listeners) listener(sourceId, info);
  }

  /**
   * 请求为某素材准备代理。已就绪或在队列里则无操作。
   *
   * **纯音频素材直接返回。** 代理只服务预览的画面 seek，而它的转码配置正好把音轨
   * 整个丢掉（`proxy.worker.ts` 的 `audio: { discard: true }`）——给一个只有声音的
   * 文件转代理，产出的是一个空文件。挡在这一处而不是每个调用点各判一次：调用点
   * 漏判不会报错，只会让素材面板上挂一个永远转不完的进度条。
   */
  async request(source: MediaSource): Promise<void> {
    if (source.kind !== "av") return;
    const current = this.infos.get(source.id);
    if (current && current.status !== "none" && current.status !== "failed") return;

    const key = proxyKey(source.name, source.width, source.height, source.durationFrames);

    // 命中 OPFS：直接可用，不排队
    const cached = await readProxy(key);
    if (cached) {
      this.publishReady(source.id, cached);
      return;
    }

    this.emit(source.id, { status: "queued", progress: 0 });
    this.queue.push({ source, key });
    this.pump();
  }

  cancel(sourceId: string): void {
    const index = this.queue.findIndex((job) => job.source.id === sourceId);
    if (index >= 0) this.queue.splice(index, 1);
    if (this.active?.source.id === sourceId) {
      const message: ProxyWorkerRequest = { type: "cancel", sourceId };
      this.worker?.postMessage(message);
    }
    this.emit(sourceId, NO_PROXY);
  }

  private publishReady(sourceId: string, file: File): void {
    const previous = this.urls.get(sourceId);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(file);
    this.urls.set(sourceId, url);
    this.emit(sourceId, { status: "ready", progress: 1, url });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./proxy.worker.ts", import.meta.url), {
      type: "module",
      name: "kerf-proxy",
    });
    worker.onmessage = (event: MessageEvent<ProxyWorkerResponse>) => {
      void this.onWorkerMessage(event.data);
    };
    worker.onerror = () => {
      if (this.active) {
        this.emit(this.active.source.id, {
          status: "failed",
          progress: 0,
          reason: "代理转码进程异常退出",
        });
        this.active = null;
      }
      this.pump();
    };
    this.worker = worker;
    return worker;
  }

  private async onWorkerMessage(message: ProxyWorkerResponse): Promise<void> {
    switch (message.type) {
      case "progress":
        this.emit(message.sourceId, { status: "working", progress: message.progress });
        return;
      case "done": {
        try {
          const file = await writeProxy(message.key, message.bytes);
          this.publishReady(message.sourceId, file);
        } catch (error) {
          // 写盘失败（配额满）不该让预览彻底不可用，退回读源片
          this.emit(message.sourceId, {
            status: "failed",
            progress: 0,
            reason: error instanceof Error ? error.message : "代理写入失败",
          });
        }
        break;
      }
      case "failed":
        this.emit(message.sourceId, { status: "failed", progress: 0, reason: message.message });
        break;
      case "canceled":
        this.emit(message.sourceId, NO_PROXY);
        break;
    }
    this.active = null;
    this.pump();
  }

  private pump(): void {
    if (this.active) return;
    const next = this.queue.shift();
    if (!next) return;
    this.active = next;
    this.emit(next.source.id, { status: "working", progress: 0 });

    const message: ProxyWorkerRequest = {
      type: "transcode",
      request: {
        sourceId: next.source.id,
        key: next.key,
        file: next.source.file,
        fps: next.source.fps,
        targetHeight: PROXY_HEIGHT,
        bitrate: PROXY_BITRATE,
      },
    };
    this.ensureWorker().postMessage(message);
  }

  dispose(): void {
    this.queue.length = 0;
    this.active = null;
    this.worker?.terminate();
    this.worker = null;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.infos.clear();
    this.listeners.clear();
  }
}

/** 全局单例：素材库、预览、时间轴都要读同一份代理状态。 */
export const proxyManager = new ProxyManager();
