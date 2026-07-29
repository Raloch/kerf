/**
 * 图片素材的解码与缓存。**每个 JS 上下文一份**（主线程一份、导出 Worker 一份）。
 *
 * ## 为什么要有这一层
 *
 * `composeFrame()` 是**同步**的（调用点在 rAF 回调和导出的逐帧循环里，每帧 await
 * 不可接受），而 `createImageBitmap()` 是异步的。所以解码必须发生在渲染之前，
 * 渲染时只做一次同步查表。纪律和字体那条同构（`compose/font-registry.ts`）：
 * **导出在逐帧循环之前 `prepareImages()`，预览按需解、没解好的那一帧先不画它。**
 *
 * 两条路径的**错误处理刻意不同**，这不违反硬规则 2——像素来自同一个 `createImageBitmap`
 * 和同一份文件：
 *
 * - **预览**里"还没解好"是常态（刚导入、刚恢复），跳过一帧下一帧就有了，同 video
 *   元素的 `readyState < 2`。
 * - **导出**里"还没解好"是 bug，而它的表现是**成片里少一层画面且不报错**。所以
 *   导出侧拿 `prepareImages()` 的返回值当闸门：有解不出来的就带着文件名抛。
 *
 * ## 尺寸上限，以及为什么它必须被看见
 *
 * 一张 6000×4000 的照片解成 `ImageBitmap` 是 **96MB**，几十张就能把标签页顶掉——
 * 同 `compose/raster-cache.ts` 那条"按字节限流，不按条数"的教训，只是这里的单张
 * 更大。所以超过输出分辨率 `MAX_OVERSAMPLE` 倍时按比例缩小再解。
 *
 * 但缩小是一次**画质取舍**，而图层可以被 `LayerTransform.scaleX` 放大——放到
 * 300% 时就看得出软。硬规则 10 要的不是"不许降级"而是"降级要被看见"，所以
 * `DecodedImage` 把原图尺寸和实际解码尺寸都留着，检查器在两者不同时说出来
 * （同 D19 把定格帧数报到界面上）。
 */

import type { MediaSource, SourceId, ImageSource } from "../edl/types";

/**
 * 解码尺寸相对输出分辨率的上限倍数。
 *
 * 2 倍意味着图层放大到 200% 之前都还是原生像素。取 1 会让"稍微放大一点"立刻变软，
 * 取 4 则单张就回到几十 MB——而这个数字的代价是可测的（检查器会说出被缩了多少）。
 */
export const MAX_OVERSAMPLE = 2;

export interface DecodedImage {
  readonly bitmap: ImageBitmap;
  /** 实际解码出来的尺寸，可能小于原图。 */
  readonly width: number;
  readonly height: number;
  /** 原图尺寸，用来判断"被缩过没有"。 */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

const decoded = new Map<SourceId, DecodedImage>();
/** 正在解的，避免同一帧里对同一张图发起多次解码。 */
const inflight = new Map<SourceId, Promise<DecodedImage | null>>();

// 模块级单例在 dev 挂全局：控制台里 `import('/src/compose/image-store.ts')` 会因为
// Vite 的 HMR URL 带参数而拿到**另一个模块实例**，于是量到的是一个空缓存。
// 这个坑踩过四次（store、常驻量计量、波形，以及这里之前的每一个同类模块）
if (import.meta.env.DEV) {
  (globalThis as { __kerfImages?: unknown }).__kerfImages = { decoded, inflight };
}

/** 按输出分辨率算这张图该解成多大。不超上限时返回原尺寸。 */
export function decodeSizeFor(
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
): { readonly width: number; readonly height: number } {
  const limit = Math.max(1, MAX_OVERSAMPLE * Math.max(outWidth, outHeight));
  const longest = Math.max(sourceWidth, sourceHeight);
  if (longest <= limit) return { width: sourceWidth, height: sourceHeight };
  const scale = limit / longest;
  // 至少 1 像素：极端长宽比（1×20000 的横幅）缩下来会把短边算成 0，
  // 而 `createImageBitmap` 收到 0 会抛
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

/**
 * 解一张图并缓存。已经解过就直接返回。
 *
 * 解不出来返回 `null` 并**记进缓存的反面**（`inflight` 里留一条已 resolve 的
 * null），于是不会每帧重试一次——同 `waveformSettled()` 那条"没试过"和"试过没有"
 * 必须分开。
 */
export async function decodeImage(
  source: ImageSource,
  outWidth: number,
  outHeight: number,
): Promise<DecodedImage | null> {
  const cached = decoded.get(source.id);
  if (cached) return cached;
  const pending = inflight.get(source.id);
  if (pending) return pending;

  const task = (async (): Promise<DecodedImage | null> => {
    try {
      const size = decodeSizeFor(source.width, source.height, outWidth, outHeight);
      const bitmap =
        size.width === source.width && size.height === source.height
          ? await createImageBitmap(source.file)
          : await createImageBitmap(source.file, {
              resizeWidth: size.width,
              resizeHeight: size.height,
              resizeQuality: "high",
            });
      const entry: DecodedImage = {
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        sourceWidth: source.width,
        sourceHeight: source.height,
      };
      decoded.set(source.id, entry);
      return entry;
    } catch {
      return null;
    }
  })();
  inflight.set(source.id, task);
  return task;
}

/**
 * 把这条时间轴用到的所有图片解好，返回**解不出来的那些**的名字。
 *
 * 导出侧在逐帧循环之前调它，并把非空的返回值当错误抛出去——那一刻抛出来能带上
 * 文件名，而循环里发现时只剩"某一层没画"。
 */
export async function prepareImages(
  sources: readonly MediaSource[],
  outWidth: number,
  outHeight: number,
): Promise<string[]> {
  const failed: string[] = [];
  for (const source of sources) {
    if (source.kind !== "image") continue;
    const entry = await decodeImage(source, outWidth, outHeight);
    if (!entry) failed.push(source.name);
  }
  return failed;
}

/**
 * 取一张已经解好的图；还没解好返回 `null`。
 *
 * **不在这里发起解码**：调用点是同步渲染路径，而"顺手解一下"会让每一帧都产生一个
 * 新的 promise（如果忘了查 `inflight` 的话），而查了也仍然是"这一帧没有图"。
 * 谁需要它就先 `decodeImage()` / `prepareImages()`。
 */
export function decodedImage(sourceId: SourceId): DecodedImage | null {
  return decoded.get(sourceId) ?? null;
}

/** 已解码图片占的字节数（`宽 × 高 × 4`）。常驻量报表用。 */
export function decodedImageBytes(): number {
  let bytes = 0;
  for (const entry of decoded.values()) bytes += entry.width * entry.height * 4;
  return bytes;
}

/** 清空缓存并关掉所有 bitmap。换项目 / 自检之间用。 */
export function clearImageStore(): void {
  for (const entry of decoded.values()) entry.bitmap.close();
  decoded.clear();
  inflight.clear();
}
