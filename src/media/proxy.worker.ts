/// <reference lib="webworker" />
/**
 * 代理转码 Worker。
 *
 * 用 mediabunny 的 `Conversion` 而不是手写 decode → encode：转码只是"换分辨率和码率"，
 * 手写一遍等于把导出管道的解码、背压、帧生命周期逻辑复制一份，多一处会漏 close 的地方。
 * Conversion 内部已经处理了这些。
 *
 * 一次只转一个：转码吃满硬件编码器，并发只会让每个都变慢，还会和导出抢编码器。
 * 排队由主线程侧（proxy-client）负责，这里只保证串行执行。
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import type { ProxyWorkerRequest, ProxyWorkerResponse } from "./proxy";

let currentId: string | null = null;
let currentConversion: Conversion | null = null;
const canceled = new Set<string>();

function post(message: ProxyWorkerResponse, transfer?: Transferable[]): void {
  self.postMessage(message, { transfer: transfer ?? [] });
}

self.onmessage = async (event: MessageEvent<ProxyWorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    canceled.add(message.sourceId);
    if (currentId === message.sourceId) {
      await currentConversion?.cancel().catch(() => undefined);
    }
    return;
  }

  if (message.type !== "transcode") return;
  const { request } = message;
  if (canceled.has(request.sourceId)) {
    post({ type: "canceled", sourceId: request.sourceId });
    return;
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(request.file) });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("没有视频轨，无法生成代理");

    const srcWidth = await videoTrack.getDisplayWidth();
    const srcHeight = await videoTrack.getDisplayHeight();

    // 源片本来就不比代理高就不用缩，但仍要转码——原片可能是高码率或难解的编码
    const targetHeight = Math.min(request.targetHeight, srcHeight);
    // 宽度取偶数：奇数宽在部分 H.264 编码器上会直接报错
    const targetWidth = Math.max(2, Math.round((srcWidth * targetHeight) / srcHeight / 2) * 2);

    const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], {
      width: targetWidth,
      height: targetHeight,
    });
    if (!codec) throw new Error("本机没有可用的视频编码器，无法生成代理");

    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      // 只要主轨：代理是给预览看的，多余的轨道纯属浪费转码时间
      tracks: "primary",
      video: { width: targetWidth, height: targetHeight, fit: "contain", codec, bitrate: request.bitrate },
      // 代理不需要音频：预览静音（见 preview-engine 的说明），带上只会拖慢转码
      audio: { discard: true },
    });

    currentId = request.sourceId;
    currentConversion = conversion;
    conversion.onProgress = (progress) => {
      post({ type: "progress", sourceId: request.sourceId, progress });
    };

    await conversion.execute();

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("代理转码完成但没有拿到数据");
    const bytes = new Uint8Array(buffer);
    post(
      {
        type: "done",
        sourceId: request.sourceId,
        key: request.key,
        bytes,
        width: targetWidth,
        height: targetHeight,
      },
      [bytes.buffer],
    );
  } catch (error) {
    if (canceled.has(request.sourceId)) {
      post({ type: "canceled", sourceId: request.sourceId });
    } else {
      post({
        type: "failed",
        sourceId: request.sourceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    currentId = null;
    currentConversion = null;
    canceled.delete(request.sourceId);
    input.dispose();
  }
};
