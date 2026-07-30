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
  /**
   * 上黑边边界那两行"最亮采样点的三通道之和"：`topLastBlackSum` 是最后一行还算黑的，
   * `topFirstLitSum` 是第一行不算黑的。判黑阈值是 `BLACK_ROW_SUM`，所以这两个数说的是
   * **离阈值多远**。
   *
   * 加它是因为"留边差 1px"有两种根因，而只印 `top`/`bottom` 分不开，两种长得一模一样：
   * 几何真的分叉了（那一行是内容，`topFirstLitSum` 会是几百），还是编码往返在黑边
   * 边界留下的量化噪声把一行染到了阈值之上（会是 25–60）。后者不是产品的问题，
   * 是这个量法对有损编码太紧——而导出侧的像素恰恰是从**解回来的成片**里读的，
   * 预览侧读的是无损画布，所以这条差异只会出现在导出那一侧。
   *
   * 实测遇到过一次：桌面 Safari 上 15 个取样帧里有 2 帧报 `预览 70 / 导出 69`，
   * 而 Chrome 全绿。没有这两个数就只能靠猜。
   */
  readonly topLastBlackSum: number;
  readonly topFirstLitSum: number;
}

/**
 * 判"这一行算黑吗"的阈值：一行里最亮采样点的三通道之和不超过它就算黑。
 *
 * 24 = 平均每通道 8。这个数**只对无损像素安全**，见 `topFirstLitSum` 的注释。
 */
export const BLACK_ROW_SUM = 24;

/**
 * 只测画面里的一块矩形。坐标是画布绝对坐标，黑边则相对**这块矩形**的四条边算。
 *
 * 这是 PLAN.md 的 **D6**：文字层一叠上去，整幅画面的平均色就不再精确编码帧号，
 * 而那正是多片段自检判断"取到的是源片第几帧"的依据。做法是同一套测量分两块用——
 * 背景区（避开文字）继续做色相断言，文字区单独看位置。
 *
 * 参数加在 `measure()` 上而不是另写一个函数：**两条自检必须共用同一套测量**，
 * 各写一个"怎么算平均色"，两边的结果就不可比了。
 */
export interface MeasureRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function measure(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  region?: MeasureRegion,
): Bands {
  // 只读需要的那块，避免整幅取回来再自己裁——getImageData 是这里最贵的一步
  const rx = region ? Math.max(0, Math.min(width - 1, Math.round(region.x))) : 0;
  const ry = region ? Math.max(0, Math.min(height - 1, Math.round(region.y))) : 0;
  const rw = region ? Math.max(1, Math.min(width - rx, Math.round(region.width))) : width;
  const rh = region ? Math.max(1, Math.min(height - ry, Math.round(region.height))) : height;
  const { data } = ctx.getImageData(rx, ry, rw, rh);

  // 返回这一行最亮采样点的三通道之和，而不是直接返回"黑不黑"：那个布尔丢掉了
  // "离阈值多远"，而判 1px 差异的根因时要的正是这个数（见 `topFirstLitSum`）
  const rowMaxSum = (y: number): number => {
    let max = 0;
    for (let x = 0; x < rw; x += 4) {
      const i = (y * rw + x) * 4;
      const sum = data[i]! + data[i + 1]! + data[i + 2]!;
      if (sum > max) max = sum;
    }
    return max;
  };
  const rowIsBlack = (y: number): boolean => rowMaxSum(y) <= BLACK_ROW_SUM;

  const colIsBlack = (x: number): boolean => {
    for (let y = 0; y < rh; y += 4) {
      const i = (y * rw + x) * 4;
      if (data[i]! + data[i + 1]! + data[i + 2]! > BLACK_ROW_SUM) return false;
    }
    return true;
  };

  let top = 0;
  while (top < rh && rowIsBlack(top)) top++;
  const topLastBlackSum = top > 0 ? rowMaxSum(top - 1) : -1;
  const topFirstLitSum = top < rh ? rowMaxSum(top) : -1;
  let bottom = 0;
  while (bottom < rh && rowIsBlack(rh - 1 - bottom)) bottom++;
  let left = 0;
  while (left < rw && colIsBlack(left)) left++;
  let right = 0;
  while (right < rw && colIsBlack(rw - 1 - right)) right++;

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
  const y0 = Math.min(top + 4, rh - 1);
  const y1 = Math.max(rh - bottom - 4, y0 + 1);
  const x0 = Math.min(4, rw - 1);
  const x1 = Math.max(rw - 4, x0 + 1);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * rw + x) * 4;
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

  return {
    top,
    bottom,
    left,
    right,
    meanR,
    meanG,
    meanB,
    hue,
    chroma,
    maxChannel,
    topLastBlackSum,
    topFirstLitSum,
  };
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
