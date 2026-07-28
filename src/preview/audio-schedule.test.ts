import { describe, expect, it } from "vitest";
import {
  chunkOffsetSeconds,
  chunkStartTime,
  driftedTooFar,
  LOOKAHEAD_SECONDS,
  needsMoreAudio,
  RESYNC_TOLERANCE_SECONDS,
  segmentsContiguous,
  shouldSkip,
} from "./audio-schedule";

const RATE = 48_000;

describe("每段的起播时刻", () => {
  it("从原点算，不从上一段递推", () => {
    // 递推会让浮点误差逐段积累，而 30 分钟有上百段
    expect(chunkStartTime(10, 0, RATE)).toBe(10);
    expect(chunkStartTime(10, RATE, RATE)).toBe(11);
    expect(chunkStartTime(10, RATE * 3, RATE)).toBe(13);
  });

  it("第 100 段的时刻与「逐段累加」逐位一致，因为它根本没累加", () => {
    const segment = 96_000; // 2 秒
    const direct = chunkStartTime(0, segment * 100, RATE);
    expect(direct).toBe(200);
  });
});

describe("接缝", () => {
  const seg = (startSample: number, frameCount: number) => ({ startSample, frameCount });

  it("首尾相接算连续", () => {
    expect(segmentsContiguous([seg(0, 96_000), seg(96_000, 96_000), seg(192_000, 40_000)])).toBe(
      true,
    );
  });

  it("差一个样本就算断——那是一声咔哒", () => {
    // 判据必须逐样本相等：差一个样本听起来像"素材本身有杂音"，
    // 而 RMS 包络那类断言对它完全免疫
    expect(segmentsContiguous([seg(0, 96_000), seg(96_001, 96_000)])).toBe(false);
  });

  it("重叠一个样本也算断", () => {
    expect(segmentsContiguous([seg(0, 96_000), seg(95_999, 96_000)])).toBe(false);
  });

  it("只有一段时恒为真", () => {
    expect(segmentsContiguous([seg(0, 100)])).toBe(true);
    expect(segmentsContiguous([])).toBe(true);
  });
});

describe("已经过去的段", () => {
  it("连尾巴都过去了才跳过", () => {
    // origin=0，段是 [1s, 3s)，此刻 3.1s → 整段都过去了
    expect(shouldSkip(0, RATE, RATE * 2, RATE, 3.1)).toBe(true);
  });

  it("只过去一半的段不跳——那会在声音里留个洞", () => {
    expect(shouldSkip(0, RATE, RATE * 2, RATE, 2)).toBe(false);
  });

  it("恰好到终点算过去", () => {
    expect(shouldSkip(0, RATE, RATE * 2, RATE, 3)).toBe(true);
  });

  it("半过去的段给出段内偏移，好从中间接上", () => {
    // 段起点 1s，此刻 2.25s → 从段内 1.25s 开始播
    expect(chunkOffsetSeconds(0, RATE, RATE, 2.25)).toBeCloseTo(1.25, 9);
  });

  it("还没到的段偏移是 0，不是负数", () => {
    expect(chunkOffsetSeconds(0, RATE * 5, RATE, 2)).toBe(0);
  });
});

describe("要不要再混一段", () => {
  it("提前量不够就要", () => {
    const now = 10 * RATE;
    // 只排到 11 秒，提前量 1 秒 < LOOKAHEAD
    expect(needsMoreAudio(11 * RATE, now, RATE)).toBe(true);
  });

  it("提前量够了就不要", () => {
    const now = 10 * RATE;
    expect(needsMoreAudio((10 + LOOKAHEAD_SECONDS + 1) * RATE, now, RATE)).toBe(false);
  });

  it("刚好等于提前量时不再要——否则会在边界上反复触发", () => {
    const now = 10 * RATE;
    expect(needsMoreAudio((10 + LOOKAHEAD_SECONDS) * RATE, now, RATE)).toBe(false);
  });
});

describe("音画漂移", () => {
  it("容差内不动它——重新对齐要重启混音，比一点偏移更难听", () => {
    expect(driftedTooFar(5, 5 + RESYNC_TOLERANCE_SECONDS / 2)).toBe(false);
  });

  it("超了就对齐，两个方向都算", () => {
    expect(driftedTooFar(5, 5 + RESYNC_TOLERANCE_SECONDS * 2)).toBe(true);
    expect(driftedTooFar(5, 5 - RESYNC_TOLERANCE_SECONDS * 2)).toBe(true);
  });

  it("容差落在「刚刚可感」之前", () => {
    // 音画不同步在 100ms 上下开始明显可感
    expect(RESYNC_TOLERANCE_SECONDS).toBeLessThan(0.1);
    // 也不能小到频繁重启：一帧（30fps 下 33ms）之内的偏移不该触发
    expect(RESYNC_TOLERANCE_SECONDS).toBeGreaterThan(1 / 30);
  });
});
