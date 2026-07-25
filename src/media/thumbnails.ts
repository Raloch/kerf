/**
 * 缩略图条：时间轴片段上的画面预览。
 *
 * 从**代理文件**抽帧，不碰原片：抽 20 张 4K 帧比转一遍代理还慢，而且会和预览
 * 抢同一个解码器。代理没就绪时不出缩略图（片段显示纯色），就绪后再补上。
 *
 * 抽帧用 `VideoSampleSink.samples(start, end)` 顺序解码而不是逐帧 `getSample()`：
 * 后者会为每张缩略图重新 seek，慢一个量级（硬规则 7 的同一条理由）。
 *
 * 结果按 sourceId 缓存在内存里。缩略图很小（每张几 KB 的 ImageBitmap），
 * 但**不能按缩放级别缓存**——那会让每次拖缩放滑块都重新抽帧。固定抽一组，
 * 绘制时按需重复或跳过。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";

/** 一组缩略图的张数。20 张足够让用户认出内容，再多收益递减。 */
const STRIP_COUNT = 20;
/** 单张缩略图高度（像素）。时间轴轨道高 54，留出标签行后约 32。 */
const THUMB_HEIGHT = 36;

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

  const task = extract(sourceId, file, durationFrames).finally(() => {
    inflight.delete(sourceId);
  });
  inflight.set(sourceId, task);
  return task;
}

async function extract(
  sourceId: string,
  file: File,
  durationFrames: number,
): Promise<ThumbnailStrip | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;

    const duration = await track.computeDuration();
    if (duration <= 0) return null;

    const srcWidth = await track.getDisplayWidth();
    const srcHeight = await track.getDisplayHeight();
    const height = THUMB_HEIGHT;
    const width = Math.max(2, Math.round((srcWidth / srcHeight) * height));

    // 取样点：均匀分布，取每段的中点而不是起点，避免总落在切换帧上
    const count = Math.min(STRIP_COUNT, Math.max(1, Math.floor(durationFrames)));
    const times: number[] = [];
    const frames: number[] = [];
    for (let i = 0; i < count; i++) {
      const ratio = (i + 0.5) / count;
      times.push(ratio * duration);
      frames.push(Math.floor(ratio * durationFrames));
    }

    const sink = new VideoSampleSink(track);
    const images: ImageBitmap[] = [];
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;

    // samplesAtTimestamps 一次顺序解码取多个时间点，比逐个 getSample 少很多 seek
    for await (const sample of sink.samplesAtTimestamps(times)) {
      if (!sample) continue;
      const frame = sample.toVideoFrame();
      try {
        ctx.drawImage(frame, 0, 0, width, height);
        images.push(canvas.transferToImageBitmap());
      } finally {
        frame.close();
        sample.close();
      }
    }

    if (images.length === 0) return null;
    const strip: ThumbnailStrip = {
      images,
      frames: frames.slice(0, images.length),
      width,
      height,
    };
    cache.set(sourceId, strip);
    return strip;
  } catch {
    return null;
  } finally {
    input.dispose();
  }
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
