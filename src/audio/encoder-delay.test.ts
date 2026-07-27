/**
 * `bestLag` 的单测——延迟测量的算术部分。
 *
 * 这个数会被拿去**丢掉 PCM 头部的若干样本**，所以错一点就是音画偏一点，而且
 * 不报错。真正的 `AudioEncoder` 在 node 里没有，但"峰值在哪"这段算术不需要它：
 * 造一段噪声，人为往后挪已知的样本数，看能不能量回来。
 *
 * 锁的是当初容易写错的几处：差一、搜索窗口越界、以及**对不上时要给低相关性**
 * （不然测出来的垃圾值会被当真，比不补偿更糟）。
 */

import { describe, expect, it } from "vitest";
import { bestLag, probeNoise } from "./encoder-delay";

/** 把 `signal` 整体后移 `lag` 个样本，前面补零——模拟编码器的 priming。 */
function delayed(signal: Float32Array, lag: number, tail = 2048): Float32Array {
  const out = new Float32Array(lag + signal.length + tail);
  out.set(signal, lag);
  return out;
}

const SEARCH = 4000;
const WINDOW = 2048;

describe("probeNoise", () => {
  it("同样长度两次调用给同一串（固定种子，两次测量才可比）", () => {
    expect(Array.from(probeNoise(16))).toEqual(Array.from(probeNoise(16)));
  });

  it("不是常数——常数信号的互相关处处相等，量不出延迟", () => {
    const n = probeNoise(1024);
    expect(new Set(n).size).toBeGreaterThan(500);
  });
});

describe("bestLag 能量回已知的延迟", () => {
  it.each([0, 1, 512, 2112, 3999])("延迟 %i 个样本", (lag) => {
    const ref = probeNoise(8192);
    const got = bestLag(ref, delayed(ref, lag), SEARCH, WINDOW);
    expect(got.lag).toBe(lag);
    expect(got.correlation).toBeGreaterThan(0.99);
  });

  it("2112 就是 AAC 实测的那个值（Chrome 150 / Safari 26.5 都是它）", () => {
    const ref = probeNoise(8192);
    expect(bestLag(ref, delayed(ref, 2112), SEARCH, WINDOW).lag).toBe(2112);
  });
});

describe("bestLag 在对不上时要给低相关性", () => {
  it("完全无关的信号 → 相关性远低于阈值 0.3", () => {
    const ref = probeNoise(8192);
    const other = new Float32Array(8192 + SEARCH);
    let s = 999;
    for (let i = 0; i < other.length; i++) {
      s = (s * 1_664_525 + 1_013_904_223) & 0x7fff_ffff;
      other[i] = ((s / 0x7fff_ffff) * 2 - 1) * 0.5;
    }
    expect(Math.abs(bestLag(ref, other, SEARCH, WINDOW).correlation)).toBeLessThan(0.3);
  });

  it("全零的解码结果 → 相关性 0，不能除出 NaN", () => {
    const ref = probeNoise(8192);
    const zeros = new Float32Array(8192 + SEARCH);
    const got = bestLag(ref, zeros, SEARCH, WINDOW);
    expect(got.correlation).toBe(0);
    expect(Number.isNaN(got.correlation)).toBe(false);
  });
});

describe("bestLag 的边界", () => {
  it("解码结果比搜索范围还短 → 返回 0 而不是越界读", () => {
    const ref = probeNoise(8192);
    const got = bestLag(ref, new Float32Array(100), SEARCH, WINDOW);
    expect(got).toEqual({ lag: 0, correlation: 0 });
  });

  it("有损压缩式的失真下仍能定位（叠 20% 噪声）", () => {
    const ref = probeNoise(8192);
    const dirty = delayed(ref, 2112);
    const jitter = probeNoise(dirty.length);
    for (let i = 0; i < dirty.length; i++) dirty[i] = dirty[i]! + jitter[i]! * 0.2;
    const got = bestLag(ref, dirty, SEARCH, WINDOW);
    expect(got.lag).toBe(2112);
    expect(got.correlation).toBeGreaterThan(0.3);
  });
});
