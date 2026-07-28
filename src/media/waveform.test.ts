/**
 * 波形取桶的单测。
 *
 * 这一层只有两件会**静默**算错的事，而两件都不抛错：
 *
 * 1. **桶边界取整**。取错半个桶的表现是"波形整体偏了一点"，没人看得出来；而它
 *    会让波形和播放头对不上，最终被当成"取帧映射错了"去查另一个模块。
 * 2. **区间退化成零宽**。放大到极限时相邻两个像素落进同一个桶，`ceil - 1 < floor`；
 *    这时若返回 0，波形上会出现随机的空洞（看着像素材本身有断音）。
 *
 * 绘制本身（`drawWaveform` / `drawVolumeEnvelope`）在 node 里没有 canvas，
 * 靠浏览器里看——但它们的取样位置全部经过 `peakBetween`，也就是这里。
 */

import { describe, expect, it } from "vitest";
import {
  bucketCountFor,
  BUCKETS_PER_SECOND,
  MAX_BUCKETS,
  peakBetween,
  type Waveform,
} from "./waveform";

/** 峰值 [0.1, 0.2, …] 的十个桶，每桶 0.1 秒，总长 1 秒。 */
function ramp(): Waveform {
  return {
    peaks: Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]),
    secondsPerBucket: 0.1,
    durationSeconds: 1,
  };
}

describe("桶数", () => {
  it("按目标密度算", () => {
    expect(bucketCountFor(2)).toBe(2 * BUCKETS_PER_SECOND);
  });

  it("长素材桶变粗，而不是把数组撑大", () => {
    // 上限存在的理由是内存：桶数无上限时 3 小时的素材要 216 万个 f32
    const long = bucketCountFor(3 * 3600);
    expect(long).toBe(MAX_BUCKETS);
  });

  it("零长和负数不炸，至少一个桶", () => {
    expect(bucketCountFor(0)).toBe(1);
    expect(bucketCountFor(-5)).toBe(1);
    expect(bucketCountFor(Number.NaN)).toBe(1);
  });
});

describe("区间峰值", () => {
  it("一个桶的区间取那个桶", () => {
    expect(peakBetween(ramp(), 0, 0.1)).toBeCloseTo(0.1, 6);
    expect(peakBetween(ramp(), 0.5, 0.6)).toBeCloseTo(0.6, 6);
  });

  it("跨多个桶取最大值——缩小时一个像素跨很多桶，那正是峰值包络", () => {
    expect(peakBetween(ramp(), 0, 0.5)).toBeCloseTo(0.5, 6);
    expect(peakBetween(ramp(), 0, 1)).toBeCloseTo(1, 6);
  });

  it("**零宽区间至少取一个桶**，不返回 0", () => {
    // 放大到极限时相邻像素落进同一个桶。返回 0 会让波形上出现随机空洞，
    // 看着像素材本身有断音
    expect(peakBetween(ramp(), 0.35, 0.35)).toBeCloseTo(0.4, 6);
    expect(peakBetween(ramp(), 0.72, 0.7201)).toBeCloseTo(0.8, 6);
  });

  it("不取到区间右端点所在的下一个桶", () => {
    // [0, 0.1) 应当只覆盖第 0 个桶。多取一个的表现是波形整体往右糊一个桶宽，
    // 而在缩小的视图里完全看不出来
    expect(peakBetween(ramp(), 0, 0.1)).toBeCloseTo(0.1, 6);
    expect(peakBetween(ramp(), 0.1, 0.2)).toBeCloseTo(0.2, 6);
  });

  it("越界的区间被夹住，不读到数组外", () => {
    // 片段可以引用到源片末尾之后（余量不足的转场窗口，见 mix-plan 文件头），
    // 那时区间会超出波形长度
    expect(peakBetween(ramp(), -5, -1)).toBeCloseTo(0.1, 6);
    expect(peakBetween(ramp(), 5, 9)).toBeCloseTo(1, 6);
    expect(peakBetween(ramp(), -1, 99)).toBeCloseTo(1, 6);
  });

  it("空波形返回 0 而不是抛错", () => {
    const empty: Waveform = {
      peaks: new Float32Array(0),
      secondsPerBucket: 0.1,
      durationSeconds: 0,
    };
    expect(peakBetween(empty, 0, 1)).toBe(0);
  });

  it("裁过入点的片段从对应位置取，不是从 0", () => {
    // 这是波形和缩略图共有的那条：按顺序平铺会让裁切过的片段显示错误的段
    expect(peakBetween(ramp(), 0.8, 0.9)).toBeCloseTo(0.9, 6);
    expect(peakBetween(ramp(), 0.8, 0.9)).not.toBeCloseTo(0.1, 6);
  });
});
