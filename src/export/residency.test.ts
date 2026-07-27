/**
 * 常驻量计量的单测。
 *
 * 锁的是"这个计量器本身会不会说谎"——它是判断长片能不能导的唯一依据，
 * 而它一旦漏记/多记，得到的结论会**反过来**：真泄漏被报成 0，或者正常导出
 * 被报成泄漏。两种都很难在浏览器里当场发现，因为没有第二个数可以对。
 *
 * 三类：借还配平、峰值与首尾（"涨没涨"靠这两个判）、跨次导出不串味。
 */

import { beforeEach, describe, expect, it } from "vitest";
import { formatBytes, residency, ResidencyTracker } from "./residency";

/** 1080p 一帧按 4:2:0 折算的字节数，与 residency.ts 的 1.5 字节/像素一致。 */
const FRAME_1080P = Math.round(1920 * 1080 * 1.5);

beforeEach(() => {
  residency.reset();
  residency.bindTextRasterBytes(() => 0);
});

describe("借出与归还配平", () => {
  it("借一个还一个后回到零", () => {
    residency.retainSample(1920, 1080);
    expect(residency.snapshot().decodedSamples).toBe(1);
    expect(residency.snapshot().decodedBytes).toBe(FRAME_1080P);

    residency.releaseSample(1920, 1080);
    expect(residency.snapshot().decodedSamples).toBe(0);
    expect(residency.snapshot().decodedBytes).toBe(0);
  });

  it("尺寸不同的帧各按各的尺寸记账", () => {
    // 归还时按**这一帧自己的**尺寸减，否则多轨混合分辨率时字节数会漂移
    residency.retainSample(1920, 1080);
    residency.retainSample(640, 360);
    residency.releaseSample(1920, 1080);
    expect(residency.snapshot().decodedBytes).toBe(Math.round(640 * 360 * 1.5));
  });

  it("解码游标和 demuxer 分开计数", () => {
    residency.openCursor();
    residency.openCursor();
    residency.openInput();
    const snapshot = residency.snapshot();
    expect(snapshot.openCursors).toBe(2);
    expect(snapshot.openInputs).toBe(1);
  });
});

describe("估算字节的构成", () => {
  it("解码帧 + 文字栅格 + 音频 PCM 三项相加", () => {
    residency.retainSample(1920, 1080);
    residency.bindTextRasterBytes(() => 8_294_400); // 1080p 一张 RGBA
    residency.setAudioPcmBytes(1_000_000);

    const snapshot = residency.snapshot();
    expect(snapshot.estimatedBytes).toBe(FRAME_1080P + 8_294_400 + 1_000_000);
  });

  it("文字缓存的字节是**实时读**的，不是注册时的快照", () => {
    // 缓存会在导出过程中被填满，注册时读一次的话峰值永远看不到
    let bytes = 0;
    residency.bindTextRasterBytes(() => bytes);
    expect(residency.snapshot().textRasterBytes).toBe(0);
    bytes = 265_000_000;
    expect(residency.snapshot().textRasterBytes).toBe(265_000_000);
  });
});

describe("峰值与首尾", () => {
  it("峰值记住的是最大那一次，以及它发生在第几帧", () => {
    const tracker = new ResidencyTracker();
    tracker.sample(0);
    residency.retainSample(1920, 1080);
    residency.retainSample(1920, 1080);
    tracker.sample(500); // 峰值在这里
    residency.releaseSample(1920, 1080);
    residency.releaseSample(1920, 1080);
    tracker.sample(1000);

    const report = tracker.report();
    expect(report.peak.decodedSamples).toBe(2);
    expect(report.peakAtFrame).toBe(500);
    expect(report.samples).toBe(3);
  });

  it("首尾两个采样都留着——只有峰值判不出'涨没涨'", () => {
    // "峰值 800MB 且早就稳住"和"峰值 800MB 且还在爬"是两个结论
    const tracker = new ResidencyTracker();
    tracker.sample(0);
    residency.retainSample(1920, 1080);
    tracker.sample(100);
    residency.retainSample(1920, 1080);
    tracker.sample(200);

    const report = tracker.report();
    expect(report.first?.decodedSamples).toBe(0);
    expect(report.last?.decodedSamples).toBe(2);
    // 首尾差为正 = 常驻量随帧号在爬，这正是长片会崩的形态
    expect(report.last!.estimatedBytes - report.first!.estimatedBytes).toBe(FRAME_1080P * 2);
  });

  it("一次都没采样时 report 不崩，给出当前快照", () => {
    expect(new ResidencyTracker().report().samples).toBe(0);
  });
});

describe("跨次导出不串味", () => {
  it("reset 归零，并把上一次的残留交回来", () => {
    residency.retainSample(1920, 1080);
    residency.openCursor();

    const leftover = residency.reset();
    // 上一次没还干净 —— 这个数要报出来，不能算到下一次头上
    expect(leftover).toEqual({ samples: 1, cursors: 1, inputs: 0 });
    expect(residency.snapshot().decodedSamples).toBe(0);
    expect(residency.snapshot().estimatedBytes).toBe(0);
  });

  it("干净结束时残留为零", () => {
    residency.retainSample(640, 360);
    residency.releaseSample(640, 360);
    expect(residency.reset()).toEqual({ samples: 0, cursors: 0, inputs: 0 });
  });
});

describe("formatBytes", () => {
  it("按量级切单位", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
