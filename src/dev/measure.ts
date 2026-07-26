/**
 * 画面测量：给自检脚本用的"这一帧长什么样"。
 *
 * 两条自检共用同一套测量，否则两边各写一个"怎么算平均色"，比对结果就不可比。
 *
 * 测的是三样东西：
 * - **上下黑边高度**：等比缩放留边的几何。预览和导出差 1px 就说明缩放算法分叉了。
 * - **画面区平均色**：内容是否相同。
 * - **色相**：测试素材的背景色随帧号线性渐变（见 make-sample.ts 的
 *   `hsl(i/frames*300 …)`），所以色相直接编码了"这是源片第几帧"。
 *   这让"跨片段边界后取到的是不是正确的源片位置"变成一个可断言的数字，
 *   而不是只能肉眼看水印。
 */

export interface Bands {
  readonly top: number;
  readonly bottom: number;
  /**
   * 左右黑边宽度。等比缩放留边只会产生上下**或**左右其中一组，所以横屏素材上
   * 这两个恒为 0；它们是给**图层变换**用的——缩放和位移只改水平位置时，
   * 上下黑边一个像素都不变，只有左右能看出来。
   */
  readonly left: number;
  readonly right: number;
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
  /** 画面区平均色的色相（0–360）。灰度时无意义，用 `chroma` 判断。 */
  readonly hue: number;
  /** 平均色的饱和距离（max-min），太小说明画面接近灰/黑，色相不可信。 */
  readonly chroma: number;
  /** 整幅画面的最大通道值。判断"是不是纯黑"用它。 */
  readonly maxChannel: number;
}

export function measure(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
): Bands {
  const { data } = ctx.getImageData(0, 0, width, height);

  const rowIsBlack = (y: number): boolean => {
    for (let x = 0; x < width; x += 4) {
      const i = (y * width + x) * 4;
      if (data[i]! + data[i + 1]! + data[i + 2]! > 24) return false;
    }
    return true;
  };

  const colIsBlack = (x: number): boolean => {
    for (let y = 0; y < height; y += 4) {
      const i = (y * width + x) * 4;
      if (data[i]! + data[i + 1]! + data[i + 2]! > 24) return false;
    }
    return true;
  };

  let top = 0;
  while (top < height && rowIsBlack(top)) top++;
  let bottom = 0;
  while (bottom < height && rowIsBlack(height - 1 - bottom)) bottom++;
  let left = 0;
  while (left < width && colIsBlack(left)) left++;
  let right = 0;
  while (right < width && colIsBlack(width - 1 - right)) right++;

  let maxChannel = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! > maxChannel) maxChannel = data[i]!;
    if (data[i + 1]! > maxChannel) maxChannel = data[i + 1]!;
    if (data[i + 2]! > maxChannel) maxChannel = data[i + 2]!;
  }

  // 只在画面区取平均色，避开黑边
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const y0 = Math.min(top + 4, height - 1);
  const y1 = Math.max(height - bottom - 4, y0 + 1);
  for (let y = y0; y < y1; y += 2) {
    for (let x = 4; x < width - 4; x += 2) {
      const i = (y * width + x) * 4;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      n++;
    }
  }
  const meanR = Math.round(r / Math.max(1, n));
  const meanG = Math.round(g / Math.max(1, n));
  const meanB = Math.round(b / Math.max(1, n));
  const { hue, chroma } = hueOf(meanR, meanG, meanB);

  return { top, bottom, left, right, meanR, meanG, meanB, hue, chroma, maxChannel };
}

/** RGB → 色相（度）与彩度（max-min，0–255）。 */
export function hueOf(r: number, g: number, b: number): { hue: number; chroma: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  if (chroma === 0) return { hue: 0, chroma: 0 };

  let h: number;
  if (max === r) h = ((g - b) / chroma) % 6;
  else if (max === g) h = (b - r) / chroma + 2;
  else h = (r - g) / chroma + 4;

  h *= 60;
  if (h < 0) h += 360;
  return { hue: Math.round(h), chroma };
}

/** 两个色相的环形距离（度），处理 350° 与 10° 只差 20° 的情况。 */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * 测试素材第 `frame` 帧的背景色相。
 *
 * 必须与 make-sample.ts 里的 `hue = round(i / frames * 300)` 保持一致——
 * 改了那边要同步改这里，否则自检会开始误报。
 */
export function sampleHueAt(frame: number, totalFrames: number): number {
  return Math.round((frame / totalFrames) * 300);
}
