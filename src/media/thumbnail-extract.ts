/**
 * 缩略图抽帧：唯一需要 mediabunny 的那一半。
 *
 * 单独成文件是为了体积——`drawStrip` 是同步渲染路径上的函数（每次重绘都要调），
 * 不能在那里 await 一个动态 import；但只要它和抽帧不在同一个模块，
 * 静态 import 绘制侧就不会把 mediabunny 拖进首屏 chunk。
 * 调度与缓存在 [thumbnails.ts](./thumbnails.ts)。
 *
 * 抽帧用 `VideoSampleSink.samplesAtTimestamps()` 顺序解码而不是逐帧 `getSample()`：
 * 后者会为每张缩略图重新 seek，慢一个量级（硬规则 7 的同一条理由）。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import type { ThumbnailStrip } from "./thumbnails";

/** 一组缩略图的张数。20 张足够让用户认出内容，再多收益递减。 */
const STRIP_COUNT = 20;
/** 单张缩略图高度（像素）。时间轴轨道高 54，留出标签行后约 32。 */
const THUMB_HEIGHT = 36;

/**
 * 从代理文件抽一组缩略图。**不要传原片**——抽 20 张 4K 帧比转一遍代理还慢。
 *
 * @param durationFrames 源片总帧数，用于把取样点换算成源片帧号
 */
export async function extractStrip(
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
    return { images, frames: frames.slice(0, images.length), width, height };
  } catch {
    return null;
  } finally {
    input.dispose();
  }
}
