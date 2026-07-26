/**
 * 预设解析的单测。
 *
 * 锁死的是两条实测踩过的错误：
 *
 * 1. **码率没跟着实际分辨率走**。曾经把码率写死成「标准发布 = 10 Mbps」，
 *    640×360 的素材被限到 360p 后仍按 10 Mbps 编，白扔 5 倍字节；
 *    而按公式算的「存档母版」只有 2 Mbps，四个档位直接倒挂。
 * 2. **奇数尺寸**。H.264 的 4:2:0 要求宽高能被 2 整除，奇数在一些编码器上
 *    直接报错，在另一些上静默裁掉一行。
 * 3. **竖屏按长边封顶**。曾经按高度封顶，1080×1920 选「1080p」被压成
 *    608×1080——像素量只剩三分之一，而标签上仍写着 1080p。这条最阴险的地方是
 *    **原来的测试把错误行为断言死了**（`expect(r.width).toBe(608)`），
 *    改对反而会让测试变红。断言写的是"当前行为"而不是"应有行为"时，
 *    测试就从护栏变成了水泥。
 */

import { describe, expect, it } from "vitest";
import { describePreset, estimateBytes, PRESETS, resolvePreset } from "./presets";
import { FPS } from "../time/rational";

const byId = (id: string) => PRESETS.find((p) => p.id === id)!;

describe("resolvePreset", () => {
  it("1080p 源片下各档位的码率接近设计稿标注的量级", () => {
    const at = (id: string) => resolvePreset(byId(id), 1920, 1080, FPS.ntsc30);
    expect(Math.round(at("standard").videoBitrate / 1e6)).toBe(10);
    expect(Math.round(at("high").videoBitrate / 1e6)).toBe(16);
    expect(Math.round(at("master").videoBitrate / 1e6)).toBe(20);
    // 快速分享靠降分辨率省体积，码率自然更低
    expect(at("fast").videoBitrate).toBeLessThan(at("standard").videoBitrate);
  });

  it("只降不升：360p 源片选 1080p 预设仍然输出 360p", () => {
    const r = resolvePreset(byId("standard"), 640, 360, FPS.ntsc30);
    expect(r.height).toBe(360);
    expect(r.width).toBe(640);
  });

  it("低分辨率源片下码率跟着降，不会白扔字节", () => {
    const small = resolvePreset(byId("standard"), 640, 360, FPS.ntsc30);
    const big = resolvePreset(byId("standard"), 1920, 1080, FPS.ntsc30);
    // 像素数差 9 倍，码率也该差约 9 倍，而不是同为 10 Mbps
    expect(small.videoBitrate).toBeLessThan(big.videoBitrate / 5);
  });

  it("任何源片尺寸下四个档位的码率都单调递增，不倒挂", () => {
    for (const [w, h] of [
      [1920, 1080],
      [640, 360],
      [3840, 2160],
      [1080, 1920],
    ] as const) {
      const rates = ["fast", "standard", "high", "master"].map(
        (id) => resolvePreset(byId(id), w, h, FPS.ntsc30).videoBitrate,
      );
      for (let i = 1; i < rates.length; i++) {
        expect(rates[i]!, `${w}×${h} 第 ${i} 档`).toBeGreaterThan(rates[i - 1]!);
      }
    }
  });

  it("竖屏 1080×1920 选「1080p」原样输出，不被压成 608×1080", () => {
    // 这条曾经断言的正是错误行为（expect(width).toBe(608)）。按高度封顶会让
    // 竖屏只剩三分之一像素，而标签上还写着 1080p——竖屏语境里 1080p 是短边 1080
    const r = resolvePreset(byId("standard"), 1080, 1920, FPS.ntsc30);
    expect(r.width).toBe(1080);
    expect(r.height).toBe(1920);
  });

  it("横竖屏在同一预设下得到相同的像素量（短边口径的定义）", () => {
    const landscape = resolvePreset(byId("standard"), 1920, 1080, FPS.ntsc30);
    const portrait = resolvePreset(byId("standard"), 1080, 1920, FPS.ntsc30);
    expect(landscape.width * landscape.height).toBe(portrait.width * portrait.height);
    // 码率也该一样：同样的像素量、同样的画质档位
    expect(portrait.videoBitrate).toBe(landscape.videoBitrate);
  });

  it("超过上限的竖屏按短边缩，不变形", () => {
    // 真实素材尺寸（一次实际导出里出现过 1232×2160）
    const r = resolvePreset(byId("standard"), 1232, 2160, FPS.ntsc30);
    expect(r.width).toBe(1080);
    // 2160 * 1080/1232 = 1893.5 → 四舍五入 1894，已是偶数
    expect(r.height).toBe(1894);
    // 长宽比偏差不超过 1 像素
    expect(Math.abs(r.width / r.height - 1232 / 2160)).toBeLessThan(0.001);
  });

  it("竖屏的档位标签写短边，不写长边", () => {
    const preset = byId("standard");
    const portrait = describePreset(resolvePreset(preset, 1080, 1920, FPS.ntsc30), preset);
    expect(portrait).toMatch(/^1080p · /); // 不是 1920p
    // 同一预设下横竖屏的标签应当完全一致——像素量相同，档位相同。
    // 不写死码率数字：那是 bitsPerPixel 常数的函数，改档位不该让这条变红
    expect(portrait).toBe(describePreset(resolvePreset(preset, 1920, 1080, FPS.ntsc30), preset));
  });

  it("尺寸非法时抛错，不产出 NaN 分辨率", () => {
    // NaN 会一路流进 VideoEncoder 的 config，报错和真正的原因隔好几层
    for (const [w, h] of [
      [0, 1080],
      [1920, 0],
      [-1920, 1080],
      [Number.NaN, 1080],
    ] as const) {
      expect(() => resolvePreset(byId("standard"), w, h, FPS.ntsc30), `${w}×${h}`).toThrow();
    }
  });

  it("输出尺寸一律偶数（H.264 的 4:2:0 要求）", () => {
    // 1921×1081 这种奇数源片来自某些截屏工具
    for (const preset of PRESETS) {
      const r = resolvePreset(preset, 1921, 1081, FPS.ntsc30);
      expect(r.width % 2, `${preset.id} 宽`).toBe(0);
      expect(r.height % 2, `${preset.id} 高`).toBe(0);
    }
  });

  it("帧率越高码率越高（同分辨率下 60fps 要比 30fps 多一倍）", () => {
    const a = resolvePreset(byId("standard"), 1920, 1080, FPS.ntsc30);
    const b = resolvePreset(byId("standard"), 1920, 1080, FPS.ntsc60);
    expect(b.videoBitrate / a.videoBitrate).toBeCloseTo(2, 1);
  });
});

describe("describePreset", () => {
  it("母版显示「与源片一致」而不是具体分辨率", () => {
    const preset = byId("master");
    const r = resolvePreset(preset, 1920, 1080, FPS.ntsc30);
    expect(describePreset(r, preset)).toBe("与源片一致 · 20 Mbps");
  });

  it("小码率保留一位小数，避免几个档位显示成同一个数", () => {
    const labels = PRESETS.map((p) =>
      describePreset(resolvePreset(p, 640, 360, FPS.ntsc30), p),
    );
    expect(new Set(labels).size).toBe(PRESETS.length);
  });
});

describe("estimateBytes", () => {
  it("按码率乘时长算，含音频时把音频码率也算进去", () => {
    const r = resolvePreset(byId("standard"), 1920, 1080, FPS.ntsc30);
    const withAudio = estimateBytes(r, 10, true);
    const withoutAudio = estimateBytes(r, 10, false);
    expect(withAudio).toBeGreaterThan(withoutAudio);
    expect(withoutAudio).toBe(Math.round((r.videoBitrate * 10) / 8));
  });
});
