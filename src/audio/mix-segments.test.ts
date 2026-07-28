/**
 * 分段混音的边界算术单测。
 *
 * 这里锁的每一条,坏掉之后都**不会报错**,只会在成片里留下听得见但量不到的东西:
 *
 * 1. **对齐量** —— 段边界不落在整数输出样本上时,同一个片段在相邻两段里的
 *    `start(when)` 会 round 到不同相位,接缝错开一个样本 = 一声轻微咔哒。
 *    而 RMS 包络断言(M0 后 9 项)对此完全免疫。
 * 2. **首尾相接且不重叠** —— 漏一个样本是咔哒,多一个样本是整条音频从此往后
 *    偏移,越到片尾偏得越多,表现成"音画不同步"而根因在分段上。
 * 3. **各段长度之和 = 总长** —— 差一点点就是成片末尾多/少几个样本。
 * 4. **pad 被导出区间夹住** —— 首段左侧 / 末段右侧没有"外面"可撑,不夹会算出
 *    负的帧号,解码器要么抛错要么给出错位的数据。
 *
 * `OfflineAudioContext` 在 node 里造不出来,所以这些必须在接线之前验完
 * ——同 `mix-plan.test.ts` 的理由。
 */

import { describe, expect, it } from "vitest";
import {
  framesToSamples,
  planMixSegments,
  sampleAlignFrames,
  SEGMENT_PAD_SECONDS,
  SEGMENT_TARGET_SECONDS,
} from "./mix-segments";
import { FPS, rational } from "../time/rational";

const RATE = 48_000;

describe("sampleAlignFrames", () => {
  it("整数帧率下一帧就对齐", () => {
    // 48000/25 = 1920、48000/30 = 1600、48000/24 = 2000,都是整数
    expect(sampleAlignFrames(FPS.pal25, RATE)).toBe(1);
    expect(sampleAlignFrames(FPS.ntsc30, RATE)).toBe(1);
    expect(sampleAlignFrames(FPS.film24, RATE)).toBe(1);
  });

  it("29.97 要 5 帧才对齐", () => {
    // 一帧 = 48000×1001/30000 = 1601.6 样本,5 帧 = 8008 样本
    expect(sampleAlignFrames(FPS.ndf2997, RATE)).toBe(5);
    expect(framesToSamples(5, FPS.ndf2997, RATE)).toBe(8008);
  });

  it("23.976 一帧就对齐,59.94 要 5 帧", () => {
    // 48000×1001/24000 = 2002,整数
    expect(sampleAlignFrames(rational(24_000, 1001), RATE)).toBe(1);
    // 48000×1001/60000 = 800.8
    expect(sampleAlignFrames(rational(60_000, 1001), RATE)).toBe(5);
  });

  it("对齐量的定义成立:整数倍帧数换出来的样本数是整数", () => {
    const rates = [FPS.ndf2997, FPS.pal25, rational(60_000, 1001), rational(24_000, 1001)];
    for (const fps of rates) {
      const align = sampleAlignFrames(fps, RATE);
      const exact = (align * RATE * fps.den) / fps.num;
      expect(Number.isInteger(exact)).toBe(true);
      // 而且它是**最小**的那个:少一帧就不再是整数(align > 1 时才有意义)
      if (align > 1) {
        expect(Number.isInteger(((align - 1) * RATE * fps.den) / fps.num)).toBe(false);
      }
    }
  });
});

describe("planMixSegments", () => {
  const fps = FPS.ndf2997;

  it("空区间没有段", () => {
    const plan = planMixSegments({ inFrame: 100, outFrame: 100 }, fps, RATE);
    expect(plan.segments).toHaveLength(0);
    expect(plan.totalSamples).toBe(0);
  });

  it("短片只有一段,没有 pad 可撑,取全部", () => {
    // 60 帧 ≈ 2 秒,远短于 10 秒的段长
    const plan = planMixSegments({ inFrame: 0, outFrame: 60 }, fps, RATE);
    expect(plan.segments).toHaveLength(1);
    const only = plan.segments[0]!;
    expect(only.renderInFrame).toBe(0);
    expect(only.renderOutFrame).toBe(60);
    expect(only.takeOffsetSamples).toBe(0);
    expect(only.takeLengthSamples).toBe(plan.totalSamples);
  });

  it("段边界和 pad 都是对齐量的整数倍", () => {
    const plan = planMixSegments({ inFrame: 7, outFrame: 7 + 3000 }, fps, RATE);
    expect(plan.alignFrames).toBe(5);
    expect(plan.padFrames % plan.alignFrames).toBe(0);
    for (const seg of plan.segments) {
      // 相对导出区间起点度量——绝对帧号可以是任意值(这里故意用 7 开头)
      expect((seg.startFrame - 7) % plan.alignFrames).toBe(0);
      expect((seg.startFrame - seg.renderInFrame) % plan.alignFrames).toBe(0);
    }
  });

  it("段与段首尾相接、不重叠,合起来正好是总长", () => {
    const plan = planMixSegments({ inFrame: 0, outFrame: 3001 }, fps, RATE);
    expect(plan.segments.length).toBeGreaterThan(1);

    let cursor = 0;
    for (const seg of plan.segments) {
      expect(seg.outStartSample).toBe(cursor);
      cursor = seg.outEndSample;
    }
    expect(cursor).toBe(plan.totalSamples);

    const taken = plan.segments.reduce((sum, s) => sum + s.takeLengthSamples, 0);
    expect(taken).toBe(plan.totalSamples);
  });

  it("帧号也首尾相接,覆盖整个导出区间", () => {
    const range = { inFrame: 120, outFrame: 120 + 2500 };
    const plan = planMixSegments(range, fps, RATE);
    expect(plan.segments[0]!.startFrame).toBe(range.inFrame);
    expect(plan.segments.at(-1)!.endFrame).toBe(range.outFrame);
    for (let i = 1; i < plan.segments.length; i++) {
      expect(plan.segments[i]!.startFrame).toBe(plan.segments[i - 1]!.endFrame);
    }
  });

  it("pad 往两侧撑开,但被导出区间夹住", () => {
    const range = { inFrame: 500, outFrame: 500 + 2500 };
    const plan = planMixSegments(range, fps, RATE);
    const first = plan.segments[0]!;
    const last = plan.segments.at(-1)!;

    // 首段左边、末段右边没有"外面"
    expect(first.renderInFrame).toBe(range.inFrame);
    expect(last.renderOutFrame).toBe(range.outFrame);
    // 中间的段两侧都撑满
    const middle = plan.segments[1]!;
    expect(middle.startFrame - middle.renderInFrame).toBe(plan.padFrames);
    expect(middle.renderOutFrame - middle.endFrame).toBe(plan.padFrames);
  });

  it("取的那截永远落在渲染出来的范围内", () => {
    for (const outFrame of [61, 300, 901, 3001, 5407]) {
      const plan = planMixSegments({ inFrame: 0, outFrame }, fps, RATE);
      for (const seg of plan.segments) {
        expect(seg.takeOffsetSamples).toBeGreaterThanOrEqual(0);
        expect(seg.takeOffsetSamples + seg.takeLengthSamples).toBeLessThanOrEqual(
          seg.renderLengthSamples,
        );
      }
    }
  });

  it("相邻两段对同一个绝对时刻的样本偏移差是整数——接缝逐样本连续的前提", () => {
    // 这条是文件头那段"对齐量"的直接断言:片段在段 k 与段 k+1 里的起播时刻
    // 相差 (段起点之差) 个样本,必须是整数,否则两边 round 到不同相位
    const plan = planMixSegments({ inFrame: 0, outFrame: 3000 }, fps, RATE);
    for (let i = 1; i < plan.segments.length; i++) {
      const prev = plan.segments[i - 1]!;
      const curr = plan.segments[i]!;
      const shiftFrames = curr.renderInFrame - prev.renderInFrame;
      const exact = (shiftFrames * RATE * fps.den) / fps.num;
      expect(Number.isInteger(exact)).toBe(true);
    }
  });

  it("整数帧率下段长正好是目标时长", () => {
    const plan = planMixSegments({ inFrame: 0, outFrame: 750 }, FPS.pal25, RATE);
    const first = plan.segments[0]!;
    expect(first.endFrame - first.startFrame).toBe(SEGMENT_TARGET_SECONDS * 25);
    expect(plan.padFrames).toBe(Math.ceil(SEGMENT_PAD_SECONDS * 25));
  });

  it("段长可调,用来在自检里逼出多段", () => {
    const plan = planMixSegments({ inFrame: 0, outFrame: 300 }, FPS.pal25, RATE, {
      targetSeconds: 1,
      padSeconds: 0.04,
    });
    expect(plan.segments).toHaveLength(12);
    expect(plan.padFrames).toBe(1);
  });

  it("总样本数与整条一次算出来的一致", () => {
    // 分段不该改变成片长度。这条把"分段"和"整条"两种算法钉在一起
    for (const [fpsValue, outFrame] of [
      [FPS.ndf2997, 3001],
      [FPS.pal25, 2500],
      [rational(60_000, 1001), 7207],
    ] as const) {
      const plan = planMixSegments({ inFrame: 0, outFrame }, fpsValue, RATE);
      expect(plan.totalSamples).toBe(framesToSamples(outFrame, fpsValue, RATE));
    }
  });
});
