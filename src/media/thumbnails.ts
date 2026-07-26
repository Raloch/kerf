/**
 * 缩略图条：时间轴片段上的画面预览。缓存 + 绘制，**不含解码**。
 *
 * 抽帧那半边在 [thumbnail-extract.ts](./thumbnail-extract.ts)，只在真的要抽时
 * 动态 import。原因是体积：`drawStrip` 在同步渲染路径上（每次重绘都调，
 * 不能 await 动态 import），而它一旦和 mediabunny 同模块，
 * 时间轴的静态 import 就会把整个 mediabunny 拖进首屏 chunk。
 *
 * 从**代理文件**抽帧，不碰原片：抽 20 张 4K 帧比转一遍代理还慢，而且会和预览
 * 抢同一个解码器。代理没就绪时不出缩略图（片段显示纯色），就绪后再补上。
 *
 * 结果按 sourceId 缓存在内存里。缩略图很小（每张几 KB 的 ImageBitmap），
 * 但**不能按缩放级别缓存**——那会让每次拖缩放滑块都重新抽帧。固定抽一组，
 * 绘制时按需重复或跳过。
 */

export interface ThumbnailStrip {
  readonly images: readonly ImageBitmap[];
  /** 每张图对应的源片帧号，绘制时用它做位置匹配。 */
  readonly frames: readonly number[];
  readonly width: number;
  readonly height: number;
}

const cache = new Map<string, ThumbnailStrip>();
const inflight = new Map<string, Promise<ThumbnailStrip | null>>();

export function cachedStrip(sourceId: string): ThumbnailStrip | null {
  return cache.get(sourceId) ?? null;
}

/**
 * 为某素材抽一组缩略图。并发调用会复用同一次抽帧。
 *
 * @param file 代理文件（不要传原片）
 * @param durationFrames 源片总帧数，用于均匀取样
 */
export async function buildStrip(
  sourceId: string,
  file: File,
  durationFrames: number,
): Promise<ThumbnailStrip | null> {
  const hit = cache.get(sourceId);
  if (hit) return hit;
  const pending = inflight.get(sourceId);
  if (pending) return pending;

  const task = run(file, durationFrames)
    .then((strip) => {
      if (strip) cache.set(sourceId, strip);
      return strip;
    })
    .finally(() => {
      inflight.delete(sourceId);
    });
  inflight.set(sourceId, task);
  return task;
}

async function run(file: File, durationFrames: number): Promise<ThumbnailStrip | null> {
  const { extractStrip } = await import("./thumbnail-extract");
  return extractStrip(file, durationFrames);
}

/**
 * 把缩略图条画进片段。
 *
 * 片段可能被裁切（`sourceIn` 偏移）或缩放到很窄，所以按"这个像素位置对应源片哪一帧"
 * 反查最近的缩略图，而不是按顺序平铺——不然裁切过的片段会显示错误的画面段。
 */
export function drawStrip(
  ctx: CanvasRenderingContext2D,
  strip: ThumbnailStrip,
  options: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly sourceInFrame: number;
    readonly lengthFrames: number;
  },
): void {
  const { widthPx, heightPx, sourceInFrame, lengthFrames } = options;
  if (widthPx <= 0 || strip.images.length === 0) return;

  const tileWidth = Math.max(8, Math.round((strip.width * heightPx) / strip.height));
  for (let x = 0; x < widthPx; x += tileWidth) {
    // 这一列左边缘对应的源片帧
    const sourceFrame = sourceInFrame + (x / widthPx) * lengthFrames;
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < strip.frames.length; i++) {
      const d = Math.abs(strip.frames[i]! - sourceFrame);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    const image = strip.images[best];
    if (image) ctx.drawImage(image, x, 0, tileWidth, heightPx);
  }
}

export function clearThumbnailCache(): void {
  for (const strip of cache.values()) {
    for (const image of strip.images) image.close();
  }
  cache.clear();
}
