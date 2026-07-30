import { describe, expect, it } from "vitest";
import { FPS, rational, snapToKnownFps, toNumber, compare, equals } from "./rational";
import {
  FRAME_ALIGN_EPSILON_SECONDS,
  MAX_SAFE_FRAME,
  frameDurationMicros,
  frameToMicros,
  frameToMicrosScaled,
  frameToSeconds,
  framesToTimecode,
  microsToFrame,
  secondsToFrame,
  timecodeToFrames,
} from "./timebase";

describe("有理数", () => {
  it("构造时自动约简", () => {
    expect(rational(60000, 2002)).toEqual({ num: 30000, den: 1001 });
    expect(rational(50, 2)).toEqual({ num: 25, den: 1 });
  });

  it("符号归到分子", () => {
    expect(rational(1, -2)).toEqual({ num: -1, den: 2 });
  });

  it("拒绝非法输入", () => {
    expect(() => rational(1, 0)).toThrow();
    expect(() => rational(1.5, 2)).toThrow();
  });

  it("比较用交叉相乘，不受浮点影响", () => {
    // 30000/1001 与 29.97/1 极为接近，浮点比较容易判等
    expect(compare(FPS.ndf2997, rational(2997, 100))).toBe(1);
    expect(equals(rational(30000, 1001), rational(60000, 2002))).toBe(true);
  });
});

describe("帧率吸附", () => {
  it("把探测到的近似帧率吸附成有理数", () => {
    // mediabunny computePacketStats() 实际给出的形态
    expect(snapToKnownFps(29.970029970029973)).toEqual(FPS.ndf2997);
    expect(snapToKnownFps(23.976023976023978)).toEqual(FPS.ndf23976);
    expect(snapToKnownFps(59.94005994005994)).toEqual(FPS.ndf5994);
    expect(snapToKnownFps(30.000001)).toEqual(FPS.ntsc30);
    expect(snapToKnownFps(25)).toEqual(FPS.pal25);
  });

  it("29.97 吸附到 30000/1001 而不是 30/1", () => {
    // 容差 0.02 内 29.97 距 29.970029 更近，不能被 30 抢走
    expect(snapToKnownFps(29.97)).toEqual(FPS.ndf2997);
  });

  it("认不出的帧率退回整数分之一，不抛错", () => {
    expect(snapToKnownFps(37.5)).toEqual(rational(38, 1));
    expect(snapToKnownFps(0)).toEqual(FPS.ntsc30);
    expect(snapToKnownFps(NaN)).toEqual(FPS.ntsc30);
  });
});

describe("帧号 ↔ 微秒", () => {
  it("整数帧率精确无误", () => {
    expect(frameToMicros(0, FPS.ntsc30)).toBe(0);
    expect(frameToMicros(30, FPS.ntsc30)).toBe(1_000_000);
    expect(frameToMicros(1, FPS.pal25)).toBe(40_000);
  });

  it("29.97 单帧为 33367μs（33366.66… 就近取整）", () => {
    expect(frameToMicros(1, FPS.ndf2997)).toBe(33_367);
    expect(frameDurationMicros(FPS.ndf2997)).toBe(33_367);
  });

  it("总时长按帧号直接算，不是单帧时长累乘", () => {
    // 单帧 33367μs × 30 = 1_001_010μs，但 30 帧真实时长是 1_001_000μs
    expect(frameDurationMicros(FPS.ndf2997) * 30).toBe(1_001_010);
    expect(frameToMicros(30, FPS.ndf2997)).toBe(1_001_000);

    // 10μs/秒 的偏差，一小时（107892 帧）累积到约 36ms，正好越过一帧的量级。
    // trim 点算错一帧就是肉眼可见的，所以时长一律用帧号直接换算，不许累乘。
    const oneHourFrames = 107_892;
    const naive = frameDurationMicros(FPS.ndf2997) * oneHourFrames;
    const exact = frameToMicros(oneHourFrames, FPS.ndf2997);
    expect(naive - exact).toBe(35_964);
    expect((naive - exact) / frameDurationMicros(FPS.ndf2997)).toBeGreaterThan(1);
  });

  it("往返转换在长时长下保持稳定", () => {
    // 10 万帧 ≈ 55 分钟 @29.97，逐帧验证 frame → micros → frame 不漂移
    for (let frame = 0; frame <= 100_000; frame += 7) {
      const micros = frameToMicros(frame, FPS.ndf2997);
      expect(microsToFrame(micros, FPS.ndf2997)).toBe(frame);
    }
  });

  it("秒边界的往返也不漂移", () => {
    for (const fps of [FPS.ndf2997, FPS.ndf23976, FPS.ndf5994, FPS.ntsc30]) {
      for (let frame = 0; frame < 5000; frame++) {
        expect(secondsToFrame(frameToSeconds(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it("拒绝超出整数精度的帧号", () => {
    expect(() => frameToMicros(MAX_SAFE_FRAME + 1, FPS.ndf2997)).toThrow(/超出安全范围/);
    expect(() => frameToMicros(Infinity, FPS.ntsc30)).toThrow();
  });
});

describe("为什么不能用浮点秒累加（回归护栏）", () => {
  it("浮点秒累加拿不到整数微秒，有理数路径逐帧零误差", () => {
    const fps = FPS.ndf2997;
    const totalFrames = 18_000; // 约 10 分钟

    // 错误做法：把"一帧的秒数"反复累加
    const naiveFrameSeconds = 1 / toNumber(fps);
    let naive = 0;
    for (let i = 0; i < totalFrames; i++) naive += naiveFrameSeconds;

    // 正确做法：帧号 → 微秒，一次换算
    const exactMicros = frameToMicros(totalFrames, fps);

    // 18000 帧 @30000/1001 = 600.6 秒，精确路径必然落在整数微秒上
    expect(exactMicros).toBe(600_600_000);
    expect(Number.isInteger(exactMicros)).toBe(true);
    // 浮点累加连整数微秒都保证不了，只能"接近"
    expect(Number.isInteger(naive * 1_000_000)).toBe(false);
    expect(naive * 1_000_000).toBeCloseTo(exactMicros, 0);

    // 关键断言：有理数路径逐帧误差恒为 0
    for (let i = 0; i <= totalFrames; i += 600) {
      expect(microsToFrame(frameToMicros(i, fps), fps)).toBe(i);
    }
  });

  it("用 round(fps) 当帧率会在 10 分钟内错位约 18 帧", () => {
    const totalFrames = 18_000;
    const exact = frameToMicros(totalFrames, FPS.ndf2997); // 30000/1001
    const wrong = frameToMicros(totalFrames, FPS.ntsc30); // 误用 30/1
    const driftFrames = Math.abs(exact - wrong) / frameDurationMicros(FPS.ndf2997);
    expect(Math.round(driftFrames)).toBe(18);
  });
});

describe("帧对齐容差（回归护栏：曾导致 trim 末帧少一帧）", () => {
  // 症状：导出源片 90–210 帧，帧数、时长、导出状态全部正常，
  // 但末帧内容是 frame 208 而不是 209——只有把导出文件读回来看画面才发现。
  const fps = FPS.ndf2997;

  /** 解码器给出的真值时间戳：未经微秒取整。 */
  const trueTimestamp = (frame: number) => (frame * fps.den) / fps.num;

  it("算出来的秒会比解码器的真值小，差值在亚微秒量级", () => {
    const frame = 209;
    const computed = frameToSeconds(frame, fps);
    const actual = trueTimestamp(frame);
    expect(actual).toBeGreaterThan(computed);
    expect(actual - computed).toBeLessThan(1e-6);
  });

  it("1 纳秒容差会漏掉本该推进的帧", () => {
    const frame = 209;
    const target = frameToSeconds(frame, fps);
    expect(trueTimestamp(frame) <= target + 1e-9).toBe(false);
  });

  it("FRAME_ALIGN_EPSILON_SECONDS 能覆盖取整误差", () => {
    for (let frame = 0; frame <= 20_000; frame++) {
      const target = frameToSeconds(frame, fps);
      expect(trueTimestamp(frame) <= target + FRAME_ALIGN_EPSILON_SECONDS).toBe(true);
    }
  });

  it("容差远小于帧长，不会误吞下一帧", () => {
    for (const rate of [FPS.ndf2997, FPS.ntsc60, rational(120, 1)]) {
      const frameSeconds = frameDurationMicros(rate) / 1e6;
      expect(FRAME_ALIGN_EPSILON_SECONDS).toBeLessThan(frameSeconds / 1000);
      // 下一帧不会落进容差窗口
      const target = frameToSeconds(10, rate);
      expect(trueTimestampFor(11, rate) <= target + FRAME_ALIGN_EPSILON_SECONDS).toBe(false);
    }
  });

  function trueTimestampFor(frame: number, rate: typeof fps): number {
    return (frame * rate.den) / rate.num;
  }
});

describe("时间码（NDF）", () => {
  it("按 round(fps) 计数", () => {
    expect(framesToTimecode(0, FPS.ndf2997)).toBe("00:00:00:00");
    expect(framesToTimecode(30, FPS.ndf2997)).toBe("00:00:01:00");
    expect(framesToTimecode(2400, FPS.ndf2997)).toBe("00:01:20:00");
    expect(framesToTimecode(29, FPS.ndf2997)).toBe("00:00:00:29");
  });

  it("25fps 用 25 作为进位基数", () => {
    expect(framesToTimecode(25, FPS.pal25)).toBe("00:00:01:00");
    expect(framesToTimecode(24, FPS.pal25)).toBe("00:00:00:24");
  });

  it("往返一致", () => {
    for (const fps of [FPS.ndf2997, FPS.pal25, FPS.ntsc60]) {
      for (let frame = 0; frame < 20_000; frame += 13) {
        expect(timecodeToFrames(framesToTimecode(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it("接受省略小时的写法", () => {
    expect(timecodeToFrames("01:20:00", FPS.ndf2997)).toBe(2400);
  });

  it("拒绝帧位溢出与格式错误", () => {
    expect(() => timecodeToFrames("00:00:00:30", FPS.ndf2997)).toThrow(/帧位超出/);
    expect(() => timecodeToFrames("abc", FPS.ndf2997)).toThrow();
    expect(() => timecodeToFrames("00:00", FPS.ndf2997)).toThrow();
  });

  it("负帧号保留符号", () => {
    expect(framesToTimecode(-30, FPS.ndf2997)).toBe("-00:00:01:00");
    expect(timecodeToFrames("-00:00:01:00", FPS.ndf2997)).toBe(-30);
  });
});

describe("帧号 → 微秒 × 有理数倍率（变速，D39）", () => {
  const ONE = { num: 1, den: 1 };

  it("**倍率为 1 时与 frameToMicros 逐值相同**", () => {
    // 这是承重的那一条：没变速的项目走的是 frameToMicros，两者必须完全一致，
    // 否则加变速会让 M0 那条音画同步断言开始漂，而漂的原因和变速毫无关系
    for (const fps of [FPS.ndf2997, FPS.ntsc30, FPS.pal25, FPS.film24]) {
      for (const f of [0, 1, 2, 29, 30, 1799, 54000, -30]) {
        expect(frameToMicrosScaled(f, fps, ONE)).toBe(frameToMicros(f, fps));
      }
    }
  });

  it("**只取整一次：1.5× 下步长恒定**", () => {
    // 取整两次（先 frameToMicros 再乘倍率）会让相邻差在 50000/50001 之间交替
    const steps = new Set<number>();
    for (let f = 1; f < 20; f++) {
      steps.add(
        frameToMicrosScaled(f, FPS.ntsc30, { num: 3, den: 2 }) -
          frameToMicrosScaled(f - 1, FPS.ntsc30, { num: 3, den: 2 }),
      );
    }
    expect([...steps]).toEqual([50_000]);
  });

  it("倍率照常生效，且负帧号对称", () => {
    expect(frameToMicrosScaled(30, FPS.ntsc30, { num: 2, den: 1 })).toBe(2_000_000);
    expect(frameToMicrosScaled(30, FPS.ntsc30, { num: 1, den: 2 })).toBe(500_000);
    expect(frameToMicrosScaled(-30, FPS.ntsc30, { num: 2, den: 1 })).toBe(-2_000_000);
  });

  it("乘积超出安全整数范围时**抛错，不静默算错**", () => {
    // 溢出的表现是位置突然偏几秒，而 Math.round 一个字都不说
    expect(() => frameToMicrosScaled(MAX_SAFE_FRAME, FPS.ndf2997, { num: 8, den: 1 })).toThrow(
      /超出安全范围/,
    );
    // 同一个帧号在原速下是合法的（证明拒绝来自倍率，不是来自帧号本身）
    expect(() => frameToMicrosScaled(MAX_SAFE_FRAME, FPS.ndf2997, ONE)).not.toThrow();
  });
});
