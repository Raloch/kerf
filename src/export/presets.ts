/**
 * 导出预设。
 *
 * 命名遵循 PLAN.md 决策 D4：**场景词做主标签，参数留在同一行**。
 * 场景词回答"我该选哪个"，参数回答"选了会得到什么"。纯参数命名要求用户
 * 知道码率意味着什么，结果是所有人默认选第一个。
 *
 * 分辨率按**短边**封顶、另一边按源片比例算出来，而不是写死 1920×1080——
 * 写死横向尺寸会把竖屏片子拉变形。
 *
 * 短边而不是高度：竖屏语境里「1080p」指的是 **1080×1920**（抖音 / Reels /
 * Shorts 都这么算），不是长边 1080。按高度封顶会把 1080×1920 压成 608×1080，
 * 像素量只剩三分之一，而标签上还写着「1080p」。横屏不受影响，两种算法同解。
 */

import type { Rational } from "../time/rational";
import { toNumber } from "../time/rational";

export interface ExportPreset {
  readonly id: string;
  /** 场景词，主标签。 */
  readonly scene: string;
  /**
   * **短边**上限；null 表示跟随时间轴（存档母版）。**只降不升**，见 resolvePreset。
   *
   * 是短边不是高度——竖屏的「1080p」是 1080×1920。见文件头。
   */
  readonly maxShortSide: number | null;
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
  { id: "standard", scene: "标准发布", maxShortSide: 1080, bitsPerPixel: 0.16, audioBitrate: 128e3 },
  { id: "high", scene: "高清发布", maxShortSide: 1080, bitsPerPixel: 0.26, audioBitrate: 192e3 },
  { id: "fast", scene: "快速分享", maxShortSide: 720, bitsPerPixel: 0.12, audioBitrate: 128e3 },
  { id: "master", scene: "存档母版", maxShortSide: null, bitsPerPixel: 0.32, audioBitrate: 192e3 },
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
 * **按短边封顶**：横屏 1920×1080 和竖屏 1080×1920 选「1080p」都得到 200 万像素，
 * 而不是让竖屏只剩 66 万。见文件头。
 *
 * **只降不升**：360p 的素材选「标准发布（1080p）」得到的是 360p，不是放大到
 * 1080p——放大不会增加任何信息，只会让文件大好几倍。
 *
 * 尺寸一律取偶数：H.264 的 4:2:0 色度采样要求宽高都能被 2 整除，
 * 奇数尺寸在部分编码器上直接报 `NotSupportedError`，在另一些上静默裁掉一行。
 * 宽高各自取偶数会让长宽比最多差 1 像素，这个误差比奇数尺寸的后果小得多。
 */
export function resolvePreset(
  preset: ExportPreset,
  timelineWidth: number,
  timelineHeight: number,
  fps: Rational,
): ResolvedExport {
  // 尺寸非法时早失败：不然 scale 会算出 NaN，一路流进 VideoEncoder 的 config，
  // 到那时报的错和真正的原因隔了好几层。目前这个状态不可达（时间轴尺寸来自
  // 探测出的源片），但 NaN 分辨率值得挡一道
  if (
    !Number.isFinite(timelineWidth) ||
    !Number.isFinite(timelineHeight) ||
    timelineWidth <= 0 ||
    timelineHeight <= 0
  ) {
    throw new Error(`时间轴尺寸非法：${timelineWidth}×${timelineHeight}`);
  }

  const sourceShortSide = Math.min(timelineWidth, timelineHeight);
  const targetShortSide =
    preset.maxShortSide === null
      ? sourceShortSide
      : Math.min(preset.maxShortSide, sourceShortSide);
  const scale = targetShortSide / sourceShortSide;
  const width = even(timelineWidth * scale);
  const height = even(timelineHeight * scale);

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
 * `p` 前面的数是**短边**，与 `resolvePreset` 的封顶口径一致：竖屏输出
 * 1080×1920 要显示「1080p」而不是「1920p」。
 *
 * 码率低于 10 Mbps 时留一位小数：低分辨率素材上几个预设的码率都在个位数，
 * 取整会让「1.7」和「2.2」都显示成「2」，看起来像三个一模一样的选项。
 */
export function describePreset(resolved: ResolvedExport, preset: ExportPreset): string {
  const size =
    preset.maxShortSide === null
      ? "与源片一致"
      : `${Math.min(resolved.width, resolved.height)}p`;
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
