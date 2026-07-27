/**
 * 按**字节**限流的 LRU 缓存，给栅格结果用。
 *
 * ## 为什么按字节而不是按条数
 *
 * 这是一个实测出来的 bug 的修法。第一版按条数卡（32 条，满了整体清空），
 * 而每张栅格是**输出尺寸**的画布（D11 的选择，为了让 `containRect` 退化成 1:1）：
 * 1080p 下单张 1920×1080×4 ≈ **7.9MB**，32 张就是 **253MB**。
 * 常驻量计量（`export/residency.ts`）第一次跑就抓到了：一条 60 秒、6 句字幕的
 * 时间轴，文字缓存从 0 单调涨到 47.5MB **从不回落**——里面全是已经播过的字幕。
 *
 * 条数上限的根本问题是**它对分辨率一无所知**：同样 32 条，720p 是 113MB、
 * 4K 是 1GB。会爆的是字节，那就用字节做上限。
 *
 * ## 为什么还要一个"最少留几张"的下限
 *
 * 缓存的意义是"一个片段整个时长只排版一次"。同一帧上可能同时有字幕 + 标题，
 * 两张都得留住，否则每一帧都要把它们全部重新排版一遍——那等于没有缓存。
 * 所以预算再紧也保底留 `minEntries` 张。代价是超高分辨率下字节上限会被突破，
 * 这是刻意的取舍：宁可 4K 上多占一点，也不要退化成逐帧重排。
 *
 * ## 淘汰顺序
 *
 * 真正想要的是"片段不再可见就淘汰"，但栅格化这一层不认识片段。LRU 是不需要
 * 调用方配合就能逼近它的做法——正在播的那句每帧都被摸到，播过的自然沉底。
 * 让调用方每帧报一次"现在有哪些文字层可见"会更准，但那是一个**忘了调也不报错**
 * 的接口，只会静默退回今天这个问题。
 *
 * 淘汰不影响一致性：预览在主线程、导出在 Worker，本来就是**两份**缓存，
 * "两条路径栅格结果相同"靠的是栅格化本身确定（同样入参同样输出），不靠共享缓存。
 */

export interface Sized {
  readonly width: number;
  readonly height: number;
}

/** RGBA 后备存储。栅格是透明画布，一律按 4 字节/像素算。 */
export function rasterBytes(value: Sized): number {
  return value.width * value.height * 4;
}

/**
 * 给定按**从旧到新**排列的条目字节数，算出该从头部丢掉几条。
 *
 * 单独抽成纯函数是为了能单测：真正的缓存要拿 `OffscreenCanvas` 才建得起来，
 * 而这段决定"丢几张"的算术恰恰是会算错的地方（差一、以及下限和预算打架时听谁的）。
 */
export function evictCount(
  sizes: readonly number[],
  budgetBytes: number,
  minEntries: number,
): number {
  let total = sizes.reduce((sum, n) => sum + n, 0);
  let dropped = 0;
  while (total > budgetBytes && sizes.length - dropped > minEntries) {
    total -= sizes[dropped]!;
    dropped++;
  }
  return dropped;
}

export class RasterCache<T extends Sized> {
  // Map 保持插入顺序，命中时删掉再塞回去就等于把它挪到队尾——这就是 LRU 的全部
  private readonly entries = new Map<string, T>();
  private bytes = 0;

  constructor(
    private readonly budgetBytes: number,
    private readonly minEntries: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // 命中即刷新recency。不刷的话正在播的那句会随时间沉底，被自己挤掉
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, value: T): void {
    const existing = this.entries.get(key);
    if (existing) this.bytes -= rasterBytes(existing);
    this.entries.delete(key);
    this.entries.set(key, value);
    this.bytes += rasterBytes(value);
    this.evict();
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** 当前占用的估算字节。常驻量计量读的就是它。 */
  get byteSize(): number {
    return this.bytes;
  }

  private evict(): void {
    while (this.bytes > this.budgetBytes && this.entries.size > this.minEntries) {
      // Map 的第一个键就是最久没被摸过的那个
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      const value = this.entries.get(oldest.value);
      if (value) this.bytes -= rasterBytes(value);
      this.entries.delete(oldest.value);
    }
  }
}
