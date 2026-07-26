/**
 * 编码能力的实际探测。
 *
 * 单独成文件是为了体积：它 import mediabunny 的运行时（编码器查询那部分），
 * 而调用方（状态栏徽标、导出面板）都是"用户动作之后"才需要结论的，
 * 所以一律 `await import("./capability-probe")` 动态加载。
 * 类型与纯决策函数在 [capability.ts](./capability.ts)，可以随便静态 import。
 */

import { canEncodeAudio, canEncodeVideo, getFirstEncodableVideoCodec } from "mediabunny";
import type { AudioCodec, VideoCodec } from "mediabunny";
import type { ExportCapabilities } from "./capability";

export async function probeCapabilities(
  width: number,
  height: number,
): Promise<ExportCapabilities> {
  const videoConfig = { width, height };

  const [mp4Video, webmVideo, aac, opus] = await Promise.all([
    // MP4 容器：优先 H.264（通用性最好），退 HEVC，再退 AV1
    getFirstEncodableVideoCodec(["avc", "hevc", "av1"], videoConfig),
    // WebM 容器只吃 VP9 / VP8 / AV1
    getFirstEncodableVideoCodec(["vp9", "av1", "vp8"], videoConfig),
    canEncodeAudio("aac"),
    canEncodeAudio("opus"),
  ]);

  return {
    mp4Video,
    webmVideo,
    aac,
    opus,
    mp4WithAudio: mp4Video !== null && aac,
    webmWithAudio: webmVideo !== null && opus,
    probedWidth: width,
    probedHeight: height,
  };
}

/** 单独查某个组合能不能编，给 UI 做即时校验用。 */
export async function canEncodeCombo(
  videoCodec: VideoCodec,
  audioCodec: AudioCodec | null,
  width: number,
  height: number,
): Promise<boolean> {
  const video = await canEncodeVideo(videoCodec, { width, height });
  if (!video) return false;
  if (!audioCodec) return true;
  return canEncodeAudio(audioCodec);
}
