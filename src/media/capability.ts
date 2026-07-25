/**
 * 编码能力探测。
 *
 * 客户端导出的成败取决于本机能力，所以探测结果必须在用户点导出**之前**就摆出来，
 * 并且绝不静默降级格式（CLAUDE.md 硬规则 9、PLAN.md 决策 D3）。
 *
 * 2026-07 的现实：Firefox 桌面与 Linux 桌面浏览器不能编码 AAC，
 * 因此那些环境下 MP4 不可用（连"仅音频"也只能出 Opus）。
 */

import {
  canEncodeAudio,
  canEncodeVideo,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
} from "mediabunny";

export interface ExportCapabilities {
  /** MP4 优先用的视频编码，null 表示本机没有可用的 MP4 视频编码器。 */
  readonly mp4Video: VideoCodec | null;
  /** WebM 优先用的视频编码。 */
  readonly webmVideo: VideoCodec | null;
  readonly aac: boolean;
  readonly opus: boolean;
  /** 能不能导出带声音的 MP4。 */
  readonly mp4WithAudio: boolean;
  readonly webmWithAudio: boolean;
  /** 探测时用的分辨率，换分辨率后结论可能变化。 */
  readonly probedWidth: number;
  readonly probedHeight: number;
}

export type ContainerChoice = "mp4" | "webm";

export interface FormatDecision {
  readonly container: ContainerChoice;
  readonly videoCodec: VideoCodec;
  readonly audioCodec: AudioCodec | null;
  /** 用户要 MP4 但本机不能编 AAC 时为 true——此时必须挡住，不是降级。 */
  readonly mp4BlockedByAudio: boolean;
}

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

/**
 * 根据用户选择的容器和能力表决定最终编码组合。
 *
 * 不做静默替换：想要 MP4 但缺 AAC 时返回 `mp4BlockedByAudio: true`，
 * 由 UI 置灰 MP4 并就地说明原因（决策 D3），而不是偷偷换成 WebM。
 */
export function decideFormat(
  caps: ExportCapabilities,
  wanted: ContainerChoice,
  needAudio: boolean,
): FormatDecision {
  if (wanted === "mp4") {
    if (!caps.mp4Video) throw new Error("本机没有可用的 MP4 视频编码器");
    const blocked = needAudio && !caps.aac;
    return {
      container: "mp4",
      videoCodec: caps.mp4Video,
      audioCodec: needAudio && caps.aac ? "aac" : null,
      mp4BlockedByAudio: blocked,
    };
  }

  if (!caps.webmVideo) throw new Error("本机没有可用的 WebM 视频编码器");
  return {
    container: "webm",
    videoCodec: caps.webmVideo,
    audioCodec: needAudio && caps.opus ? "opus" : null,
    mp4BlockedByAudio: false,
  };
}

/** 给 UI 用的一句话说明。 */
export function describeCapabilities(caps: ExportCapabilities): string[] {
  const lines: string[] = [];
  lines.push(caps.mp4Video ? `MP4 视频编码：${caps.mp4Video}` : "MP4 视频编码：不可用");
  lines.push(caps.webmVideo ? `WebM 视频编码：${caps.webmVideo}` : "WebM 视频编码：不可用");
  lines.push(caps.aac ? "AAC 音频编码：可用" : "AAC 音频编码：此浏览器不支持");
  lines.push(caps.opus ? "Opus 音频编码：可用" : "Opus 音频编码：不可用");
  return lines;
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
