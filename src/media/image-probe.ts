/**
 * 图片素材的探针。
 *
 * **单独成一个文件，因为它一行 mediabunny 都不需要。** 和 `probe.ts` 合在一起的话，
 * 导入一张 PNG 也要把那 500KB 拖进来——同 `capability.ts` / `capability-probe.ts`
 * 那个拆分模式（见 CLAUDE.md「首屏体积」）。
 *
 * 尺寸靠 `createImageBitmap()` 量：它是唯一在主线程和 Worker 里都有、且不需要
 * DOM 的办法（`new Image()` 要 document）。量完就关掉——真正要用的那份由
 * `compose/image-store.ts` 按输出分辨率重新解，两者的尺寸取舍不同。
 */

import type { ImageSource } from "../edl/types";
import { newImageSourceId } from "./source-id";

export interface ImageProbeResult {
  readonly source: ImageSource;
}

/** 这个文件像图片吗。按 MIME 判，用来决定走哪个探针。 */
export function looksLikeImage(file: File): boolean {
  return file.type.startsWith("image/");
}

export async function probeImageFile(file: File): Promise<ImageProbeResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`认不出这张图片：${file.name}（${file.type || "没有类型"}）`);
  }
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();
  if (width <= 0 || height <= 0) {
    throw new Error(`图片 ${file.name} 的尺寸是 ${width}×${height}，用不了`);
  }

  return {
    source: {
      id: newImageSourceId(),
      kind: "image",
      name: file.name,
      file,
      hasAudio: false,
      audioCodec: null,
      width,
      height,
      mimeType: file.type || "image/*",
      frameCount: await countFrames(file),
    },
  };
}

/**
 * 动图有几帧，探不出来返回 null。
 *
 * **`null` 和 `1` 不是一回事**："探不出来"不能当成"是静态图"——那正是硬规则 10
 * 那类静默降级：用户导入一个动画 GIF，我们只画第一帧，而界面什么也不说。
 * `ImageDecoder` 不是所有浏览器都有（写这段时 Chrome 有、Safari 没有），所以
 * 没有它的时候老实报 null，界面据此说"认不出是不是动图"而不是"这是静态图"。
 */
async function countFrames(file: File): Promise<number | null> {
  const decoderCtor = (globalThis as { ImageDecoder?: unknown }).ImageDecoder;
  if (typeof decoderCtor !== "function") return null;
  try {
    const Ctor = decoderCtor as new (init: { data: ArrayBuffer; type: string }) => {
      tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
      close(): void;
    };
    const decoder = new Ctor({ data: await file.arrayBuffer(), type: file.type });
    try {
      await decoder.tracks.ready;
      return decoder.tracks.selectedTrack?.frameCount ?? null;
    } finally {
      decoder.close();
    }
  } catch {
    return null;
  }
}
