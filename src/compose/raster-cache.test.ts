/**
 * 按字节限流的 LRU 缓存的单测。
 *
 * 这个缓存是一个**实测出来的 bug** 的修法：上一版按条数卡（32 条），而每张栅格
 * 是输出尺寸的画布，1080p 下 32 条就是 253MB。常驻量计量抓到文字缓存在一条
 * 60 秒的时间轴上从 0 单调涨到 47.5MB 从不回落。
 *
 * 所以这里锁的是**当初错在哪**：上限的单位（字节，不是条数）、淘汰顺序
 * （最久没被摸过的先走，而不是整体清空）、以及命中要刷新 recency
 * （不刷的话正在播的那句会被自己挤掉，退化成逐帧重排）。
 */

import { describe, expect, it } from "vitest";
import { evictCount, rasterBytes, RasterCache } from "./raster-cache";

/** 1080p 一张 RGBA 栅格 = 7.91MB。文档里那些数字都从它来。 */
const HD = { width: 1920, height: 1080 };
const HD_BYTES = 1920 * 1080 * 4;

/** 造一个占 n 个"1080p 单位"的假栅格，方便按倍数写断言。 */
const sized = (units: number) => ({ width: 1920 * units, height: 1080 });

describe("rasterBytes", () => {
  it("按 RGBA 4 字节/像素算", () => {
    expect(rasterBytes(HD)).toBe(HD_BYTES);
    // 这个数就是当初 bug 的量级来源：32 条 × 7.91MB ≈ 253MB
    expect(Math.round((HD_BYTES * 32) / 1024 / 1024)).toBe(253);
  });
});

describe("evictCount", () => {
  it("没超预算就一条都不丢", () => {
    expect(evictCount([10, 10], 100, 1)).toBe(0);
  });

  it("从最旧的开始丢，丢到不超预算为止", () => {
    // [10,10,10,10] 共 40，预算 25 → 丢掉最旧的两条剩 20
    expect(evictCount([10, 10, 10, 10], 25, 1)).toBe(2);
  });

  it("下限优先于预算——宁可超字节也不退化成逐帧重排", () => {
    // 预算只够 0 条，但下限 2 挡住了
    expect(evictCount([10, 10, 10], 5, 2)).toBe(1);
  });

  it("刚好等于预算时不丢（边界是 >，不是 >=）", () => {
    expect(evictCount([10, 10], 20, 1)).toBe(0);
  });
});

describe("RasterCache 上限按字节生效", () => {
  it("1080p 下 32MB 预算约等于 4 张，不是 32 张", () => {
    // 上一版按条数卡 32，在这里会存下 32 张 = 253MB，这条断言就是钉住那个回归
    const cache = new RasterCache(32 * 1024 * 1024, 2);
    for (let i = 0; i < 32; i++) cache.set(`k${i}`, HD);
    expect(cache.size).toBe(4);
    expect(cache.byteSize).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it("分辨率越高存得越少——条数上限正是对这件事一无所知", () => {
    const budget = 32 * 1024 * 1024;
    const count = (units: number): number => {
      const cache = new RasterCache(budget, 1);
      for (let i = 0; i < 20; i++) cache.set(`k${i}`, sized(units));
      return cache.size;
    };
    expect(count(0.5)).toBeGreaterThan(count(1));
    expect(count(1)).toBeGreaterThan(count(4));
  });

  it("单张就超预算时靠下限兜底，不会存不下任何东西", () => {
    const cache = new RasterCache(1024, 2);
    cache.set("a", HD);
    cache.set("b", HD);
    cache.set("c", HD);
    expect(cache.size).toBe(2);
    // 刚放进去的那张必须还在——把自己挤掉就等于缓存完全失效
    expect(cache.get("c")).toBeDefined();
  });
});

describe("RasterCache 淘汰顺序", () => {
  it("丢最久没被摸过的那张，不是整体清空", () => {
    // 整体清空（上一版的做法）会让缓存周期性归零，命中率忽高忽低
    const cache = new RasterCache(rasterBytes(HD) * 2, 1);
    cache.set("a", HD);
    cache.set("b", HD);
    cache.set("c", HD);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("命中会刷新 recency——正在播的那句不该被自己挤掉", () => {
    const cache = new RasterCache(rasterBytes(HD) * 2, 1);
    cache.set("a", HD);
    cache.set("b", HD);
    cache.get("a"); // a 被摸到，挪到队尾
    cache.set("c", HD); // 该丢的是 b
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("同一个键重设不会把字节数算两遍", () => {
    const cache = new RasterCache(rasterBytes(HD) * 4, 1);
    cache.set("a", HD);
    cache.set("a", HD);
    expect(cache.size).toBe(1);
    expect(cache.byteSize).toBe(rasterBytes(HD));
  });
});

describe("RasterCache 清空", () => {
  it("clear 之后字节数也归零", () => {
    const cache = new RasterCache(rasterBytes(HD) * 4, 1);
    cache.set("a", HD);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.byteSize).toBe(0);
  });
});
