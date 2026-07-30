import { describe, expect, it } from "vitest";
import {
  elementPlaybackRate,
  isNormalPlayback,
  isShuttling,
  MAX_SHUTTLE_RATE,
  shuttleLabel,
  shuttleStep,
} from "./shuttle";

describe("倍率梯子", () => {
  it("从暂停按 L 是 1× 正放，按 J 是 1× 倒放", () => {
    expect(shuttleStep(0, 1)).toBe(1);
    expect(shuttleStep(0, -1)).toBe(-1);
  });

  it("L 一路加到上限就停在上限", () => {
    expect(shuttleStep(1, 1)).toBe(2);
    expect(shuttleStep(2, 1)).toBe(4);
    expect(shuttleStep(4, 1)).toBe(8);
    expect(shuttleStep(8, 1)).toBe(8);
  });

  it("J 一路加到倒放上限就停在那里", () => {
    expect(shuttleStep(-1, -1)).toBe(-2);
    expect(shuttleStep(-2, -1)).toBe(-4);
    expect(shuttleStep(-4, -1)).toBe(-8);
    expect(shuttleStep(-8, -1)).toBe(-8);
  });

  it("对向的键是退一档，不是立刻反向——否则 8× 慢不下来", () => {
    expect(shuttleStep(8, -1)).toBe(4);
    expect(shuttleStep(4, -1)).toBe(2);
    expect(shuttleStep(2, -1)).toBe(1);
    // 退过 1× 才跨到倒放，中间不落在暂停上（暂停只由 K 给）
    expect(shuttleStep(1, -1)).toBe(-1);
    expect(shuttleStep(-1, 1)).toBe(1);
  });

  it("绝对值上限两个方向对称", () => {
    let forward = 0;
    let backward = 0;
    for (let i = 0; i < 10; i++) {
      forward = shuttleStep(forward, 1);
      backward = shuttleStep(backward, -1);
    }
    expect(forward).toBe(MAX_SHUTTLE_RATE);
    expect(backward).toBe(-MAX_SHUTTLE_RATE);
  });

  it("怪值当「从暂停起步」，不抛也不返回 undefined", () => {
    // 梯子上没有 3；`LADDER[…]` 越界会给 undefined，而那个值会一路流进 rAF
    expect(shuttleStep(3, 1)).toBe(1);
    expect(shuttleStep(-3, -1)).toBe(-1);
    expect(shuttleStep(Number.NaN, 1)).toBe(1);
  });
});

describe("出声与读数是同一个判据的两面", () => {
  it("只有常速正放才出声", () => {
    expect(isNormalPlayback(1)).toBe(true);
    expect(isNormalPlayback(0)).toBe(false);
    expect(isNormalPlayback(2)).toBe(false);
    expect(isNormalPlayback(-1)).toBe(false);
  });

  it("在放而且不是常速正放，界面就要报出来", () => {
    expect(isShuttling(0)).toBe(false);
    expect(isShuttling(1)).toBe(false);
    expect(isShuttling(2)).toBe(true);
    expect(isShuttling(-1)).toBe(true);
    expect(isShuttling(-8)).toBe(true);
  });

  it("凡是不出声的在放档位，界面都会报——否则就是静默降级", () => {
    for (const rate of [-8, -4, -2, -1, 1, 2, 4, 8]) {
      expect(isShuttling(rate)).toBe(!isNormalPlayback(rate));
    }
  });

  it("读数带方向和倍数", () => {
    expect(shuttleLabel(2)).toBe("快进 2×");
    expect(shuttleLabel(-4)).toBe("倒放 4×");
  });
});

describe("video 元素的倍率", () => {
  it("倍率乘片段速度", () => {
    expect(elementPlaybackRate(1, 1, false)).toBe(1);
    expect(elementPlaybackRate(4, 1, false)).toBe(4);
    expect(elementPlaybackRate(2, 0.5, false)).toBe(1);
    expect(elementPlaybackRate(1, 2, false)).toBe(2);
  });

  it("倒放取 0——没有浏览器实现负的 playbackRate", () => {
    expect(elementPlaybackRate(-1, 1, false)).toBe(0);
    expect(elementPlaybackRate(-8, 2, false)).toBe(0);
  });

  it("定格恒为 0，与倍率和速度都无关（D48）", () => {
    expect(elementPlaybackRate(1, 1, true)).toBe(0);
    expect(elementPlaybackRate(8, 8, true)).toBe(0);
    expect(elementPlaybackRate(-2, 0.5, true)).toBe(0);
  });

  it("暂停时也是 0", () => {
    expect(elementPlaybackRate(0, 1, false)).toBe(0);
  });

  it("超出浏览器支持范围要夹住，不能让赋值抛出去", () => {
    // 8× 倍率 × 8× 片段速度 = 64，Blink 的上界是 16
    expect(elementPlaybackRate(8, 8, false)).toBe(16);
    expect(elementPlaybackRate(4, 8, false)).toBe(16);
    // 夹紧只在那个荒唐角落生效，常规组合一个字都不动
    expect(elementPlaybackRate(8, 2, false)).toBe(16);
    expect(elementPlaybackRate(8, 1, false)).toBe(8);
  });

  it("最慢的组合仍在浏览器支持范围内（Blink 下界 0.0625）", () => {
    // 片段速度下限 1/8（SPEED_RANGE.min），常速正放时元素走 0.125
    expect(elementPlaybackRate(1, 1 / 8, false)).toBeCloseTo(0.125, 6);
  });
});
