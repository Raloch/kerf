import { describe, expect, it } from "vitest";
import {
  MIN_SAMPLE_FRAMES,
  predict,
  sampleFromExport,
  SAMPLE_MAX_AGE_MS,
  SLOW_FACTOR,
  type ThroughputSample,
} from "./throughput";

const NOW = 1_700_000_000_000;

/** iPhone 实测的那一档：1080p、54000 帧、243.2 秒（30 分钟片长 → 7.41× 实时）。 */
const IPHONE_1080P = sampleFromExport({
  encodedFrames: 54_000,
  elapsedMs: 243_200,
  backend: "pixi",
  width: 1920,
  height: 1080,
  at: NOW,
})!;

describe("从导出结果提样本", () => {
  it("算出每像素每帧的毫秒数", () => {
    expect(IPHONE_1080P.msPerPixelFrame).toBeCloseTo(243_200 / (1920 * 1080 * 54_000), 12);
    expect(IPHONE_1080P.backend).toBe("pixi");
    expect(IPHONE_1080P.pixels).toBe(1920 * 1080);
  });

  it("帧数太少的样本不要", () => {
    // 几十帧里固定开销（建编码器、探编码延迟、写容器索引）占大头，
    // 拿它缩放 30 分钟会离谱偏大——同"规模不对的基准量到的是固定开销"
    const tiny = sampleFromExport({
      encodedFrames: MIN_SAMPLE_FRAMES - 1,
      elapsedMs: 5000,
      backend: "pixi",
      width: 1920,
      height: 1080,
      at: NOW,
    });
    expect(tiny).toBeNull();
  });

  it("耗时或像素为 0 时不要（会算出 Infinity）", () => {
    const base = { encodedFrames: 900, backend: "pixi" as const, at: NOW };
    expect(sampleFromExport({ ...base, elapsedMs: 0, width: 1920, height: 1080 })).toBeNull();
    expect(sampleFromExport({ ...base, elapsedMs: 5000, width: 0, height: 1080 })).toBeNull();
  });
});

describe("按像素量缩放预测", () => {
  const target = (w: number, h: number, frames: number, seconds: number) => ({
    pixels: w * h,
    frames,
    durationSeconds: seconds,
    backend: "pixi" as const,
    now: NOW,
  });

  it("同分辨率同长度时预测回原耗时", () => {
    const p = predict(IPHONE_1080P, target(1920, 1080, 54_000, 1801.8));
    expect(p?.seconds).toBeCloseTo(243.2, 1);
    // 30 分钟片长跑 243 秒 = 0.135 倍片长，也就是 7.4× 实时
    expect(p?.factor).toBeCloseTo(0.135, 3);
    expect(p?.slow).toBe(false);
  });

  it("4K 是 1080p 的 4 倍像素，预测耗时也是 4 倍", () => {
    const p = predict(IPHONE_1080P, target(3840, 2160, 54_000, 1801.8));
    expect(p?.seconds).toBeCloseTo(243.2 * 4, 0);
    // 0.54 倍片长，仍然快于实时——1080p 有 7.4× 余量，4 倍之后还有 1.85×
    expect(p?.factor).toBeCloseTo(0.54, 2);
    expect(p?.slow).toBe(false);
  });

  it("一台只有 1080p 实时余量的机器，4K 会被判慢", () => {
    // 构造一个 1080p 恰好 1.35× 实时的样本（比 iPhone 慢 5.5 倍）
    const slowDevice: ThroughputSample = {
      ...IPHONE_1080P,
      msPerPixelFrame: IPHONE_1080P.msPerPixelFrame * 5.5,
    };
    const at1080 = predict(slowDevice, target(1920, 1080, 54_000, 1801.8));
    expect(at1080?.slow).toBe(false);
    const at4k = predict(slowDevice, target(3840, 2160, 54_000, 1801.8));
    // 0.74 × 4 = 2.97 倍片长，远过 SLOW_FACTOR
    expect(at4k?.factor).toBeGreaterThan(SLOW_FACTOR);
    expect(at4k?.slow).toBe(true);
  });

  it("警告线正好对着 iPhone 那个 0.66× 实时的读数", () => {
    // 0.66× 实时 = 耗时是片长的 1.515 倍，必须落在警告侧
    expect(1 / 0.66).toBeGreaterThan(SLOW_FACTOR);
    // 而 1× 实时不该报警——刚好跟得上不是问题
    expect(1.0).toBeLessThan(SLOW_FACTOR);
  });

  it("带上依据是哪一档量的", () => {
    const p = predict(IPHONE_1080P, target(3840, 2160, 100, 3.3));
    // 不说依据的预测没法让人判断可不可信
    expect(p?.basisPixels).toBe(1920 * 1080);
  });
});

describe("什么时候不预测", () => {
  const t = {
    pixels: 1920 * 1080,
    frames: 900,
    durationSeconds: 30,
    backend: "pixi" as const,
    now: NOW,
  };

  it("没有样本就什么都不说", () => {
    // 没有依据时的沉默比一个编出来的数字好
    expect(predict(null, t)).toBeNull();
  });

  it("后端不同不复用", () => {
    // Canvas2D 做不了 GPU 效果，两条路径的每帧成本不是同一个量级
    expect(predict({ ...IPHONE_1080P, backend: "canvas2d" }, t)).toBeNull();
  });

  it("样本过期不复用", () => {
    const stale = { ...IPHONE_1080P, at: NOW - SAMPLE_MAX_AGE_MS - 1 };
    expect(predict(stale, t)).toBeNull();
    // 刚好在窗口内还算
    expect(predict({ ...IPHONE_1080P, at: NOW - SAMPLE_MAX_AGE_MS + 1 }, t)).not.toBeNull();
  });

  it("目标片长为 0 时不预测（factor 会是 Infinity）", () => {
    expect(predict(IPHONE_1080P, { ...t, durationSeconds: 0 })).toBeNull();
    expect(predict(IPHONE_1080P, { ...t, frames: 0 })).toBeNull();
  });
});
