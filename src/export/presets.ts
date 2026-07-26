/**
 * 导出预设。
 *
 * 命名遵循 PLAN.md 决策 D4：**场景词做主标签，参数留在同一行**。
 * 场景词回答"我该选哪个"，参数回答"选了会得到什么"。纯参数命名要求用户
 * 知道码率意味着什么，结果是所有人默认选第一个。
 *
 * 分辨率按**高度**指定、宽度按源片比例算出来，而不是写死 1920×1080：
 * 竖屏素材（1080×1920）选「1080p」应该得到 1080 高、608 宽，
 * 写死横向尺寸会把竖屏片子拉变形。
 */

import type { Rational } from "../time/rational";
import { toNumber } from "../time/rational";

export interface ExportPreset {
  readonly id: string;
  /** 场景词，主标签。 */
  readonly scene: string;
  /** 高度上限；null 表示跟随时间轴（存档母版）。**只降不升**，见 resolvePreset。 */
  readonly maxHeight: number | null;
  /**
   * 画质档位，单位是"每像素每帧的比特数"。
   *
   * **不写死码率**，因为码率只有配上分辨率才有意义。曾经写死过
   * 「标准发布 = 10 Mbps」，结果 640×360 的素材被限到 360p 后仍然按 10 Mbps 编，
   * 白扔 5 倍字节换不到任何画质；而「存档母版」按公式算出 2 Mbps，
   * 档位直接倒挂成最低的一档。
   *
   * 量级参考：0.16 bits/px 在 1080p30 上约等于 10 Mbps，是 H.264 交付档位的
   * 常见值；母版取一倍余量。
   */
  readonly bitsPerPixel: number;
  readonly audioBitrate: number;
}

export const PRESETS: readonly ExportPreset[] = [
  { id: "standard", scene: "标准发布", maxHeight: 1080, bitsPerPixel: 0.16, audioBitrate: 128e3 },
  { id: "high", scene: "高清发布", maxHeight: 1080, bitsPerPixel: 0.26, audioBitrate: 192e3 },
  { id: "fast", scene: "快速分享", maxHeight: 720, bitsPerPixel: 0.12, audioBitrate: 128e3 },
  { id: "master", scene: "存档母版", maxHeight: null, bitsPerPixel: 0.32, audioBitrate: 192e3 },
];

export const DEFAULT_PRESET_ID = "standard";

export interface ResolvedExport {
  readonly width: number;
  readonly height: number;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
}

/**
 * 把预设套到具体时间轴上，算出真实的输出尺寸与码率。
 *
 * **只降不升**：360p 的素材选「标准发布（1080p）」得到的是 360p，不是放大到
 * 1080p——放大不会增加任何信息，只会让文件大好几倍。
 *
 * 尺寸一律取偶数：H.264 的 4:2:0 色度采样要求宽高都能被 2 整除，
 * 奇数尺寸在部分编码器上直接报 `NotSupportedError`，在另一些上静默裁掉一行。
 */
export function resolvePreset(
  preset: ExportPreset,
  timelineWidth: number,
  timelineHeight: number,
  fps: Rational,
): ResolvedExport {
  const targetHeight =
    preset.maxHeight === null ? timelineHeight : Math.min(preset.maxHeight, timelineHeight);
  const height = even(targetHeight);
  const width = even(Math.round((timelineWidth * height) / timelineHeight));

  // 码率跟着**实际**分辨率算，不是跟着预设的名义分辨率
  const videoBitrate = Math.round(width * height * toNumber(fps) * preset.bitsPerPixel);

  return { width, height, videoBitrate, audioBitrate: preset.audioBitrate };
}

function even(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * 预设那一行的参数文案，例如 `1080p · 10 Mbps`。
 *
 * 码率低于 10 Mbps 时留一位小数：低分辨率素材上几个预设的码率都在个位数，
 * 取整会让「1.7」和「2.2」都显示成「2」，看起来像三个一模一样的选项。
 */
export function describePreset(resolved: ResolvedExport, preset: ExportPreset): string {
  const size = preset.maxHeight === null ? "与源片一致" : `${resolved.height}p`;
  const mbps = resolved.videoBitrate / 1e6;
  return `${size} · ${mbps < 10 ? mbps.toFixed(1) : mbps.toFixed(0)} Mbps`;
}

/** 粗估成品体积（字节）。只用码率乘时长，不考虑封装开销。 */
export function estimateBytes(
  resolved: ResolvedExport,
  seconds: number,
  withAudio: boolean,
): number {
  const bits = (resolved.videoBitrate + (withAudio ? resolved.audioBitrate : 0)) * seconds;
  return Math.round(bits / 8);
}
