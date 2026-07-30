/**
 * 时间伸缩（保音高变速）的单测。
 *
 * 这里锁的是三件**错了不报错**的事：
 *
 * 1. **分块与整块逐样本相同。** 混音是分段跑的（D22），段长导出 10 秒、预览 1 秒，
 *    而伸缩算法带一条累积的对齐链。链一旦被段边界打断，接缝上就是一次相位跳变——
 *    RMS 包络断言对它**完全免疫**（同 `sampleAlignFrames` 那条 24 样本碎块），
 *    听起来是每隔一段"咔"一下。这条断言是那件事在 node 里唯一的护栏。
 * 2. **音高真的没变。** 长度对了不等于做对了：把 `playbackRate` 那条重采样路径
 *    照抄过来，长度一样对、音高翻一倍。所以判据是**量出基频**，并且拿一条
 *    "抽样重采样"当对照——它必须给出两倍的频率，否则说明这个量法本身量不到音高。
 * 3. **各声道用同一个偏移。** 相似度在混合信号上算，各声道各挑一个偏移的表现是
 *    立体声像左右乱晃，而**每一路自己听都是对的**。
 *
 * 第 1 条和第 3 条都有反向验证记在各自的用例旁边；判"对齐有没有生效"的那一条
 * **换过一次判据**，理由见 `envelopeFlatness` 的注释——第一版量错了东西且假绿。
 */

import { describe, expect, it } from "vitest";
import { rational } from "../time/rational";
import {
  type StretchSource,
  type TimeStretcher,
  WINDOW_SECONDS,
  createTimeStretcher,
} from "./time-stretch";

const RATE = 48_000;
/**
 * 音高探针的频率。只要不整除就行，这一条不敏感。
 */
const PROBE_FREQ = 997;

/**
 * 失配最狠的那个频率——**由 hop 算出来，不写死**。
 *
 * 固定步长的重叠相加，接缝上两块的相位差是 `2π × f × hop / rate`（差的是 hop 而不是
 * hop × speed：块间距是 hop × speed，而重叠比的是"上一块往后 hop"和"这一块起点"）。
 * 所以它整除时**失配恒等于零**，把整个对齐搜索关掉断言照样全绿：实测 1000Hz 在
 * hop = 720 / 48kHz 上正好是 15.0，997Hz 是 14.955（关掉对齐只从 0.9970 掉到 0.9908），
 * 而落在 n + 0.5 上的频率是半个周期的失配、两块直接相消（1.0000 → 0.7071）。
 *
 * 第一版就是拿 1000Hz 当探针的，于是这条断言测的是运气。**写死一个频率还会烂掉**：
 * `WINDOW_SECONDS` 一改，hop 就变，那个数字不再是最坏情形而没人会发现。
 */
function cancellationFreq(hop: number, rate = RATE): number {
  return (rate / hop) * 4.5;
}

function sine(freq: number, count: number, amp = 0.5, rate = RATE): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 两个不成简单倍数关系的音叠起来：纯正弦上任何取块位置都对得上，测不出对齐 */
function chord(count: number): Float32Array {
  const a = sine(440, count, 0.35);
  const b = sine(617, count, 0.25);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = a[i]! + b[i]!;
  return out;
}

/** 按伸缩器自己要的源片区间喂给它，越界那部分交给它当零处理 */
function pull(
  stretcher: TimeStretcher,
  from: number,
  to: number,
  full: readonly Float32Array[],
): Float32Array[] {
  const range = stretcher.sourceRangeFor(from, to);
  const origin = Math.max(0, range.from);
  const end = Math.min(full[0]!.length, Math.max(origin, range.to));
  const source: StretchSource = {
    channels: full.map((ch) => ch.subarray(origin, end)),
    origin,
  };
  return stretcher.process(from, to, source);
}

/** 上升零交叉计数 → 基频（Hz）。纯音上足够准，且完全不依赖被测代码 */
function fundamental(x: Float32Array, rate = RATE): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1]! <= 0 && x[i]! > 0) crossings++;
  }
  return (crossings * rate) / x.length;
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (const v of x) sum += v * v;
  return Math.sqrt(sum / x.length);
}

/**
 * 逐窗 RMS 的最小/最大之比——稳态音上它就是"包络平不平"。
 *
 * 这是失配唯一测得到的形态。第一版量的是**相邻样本的最大跳变**，理由写的是"相位
 * 跳变会在这里露出来"，而那是错的：重叠相加天生不产生单样本跳变（接缝是一段 Hann
 * 交叉淡化），失配表现为重叠区里两块相互抵消，也就是**幅度周期性塌陷**。实测把整个
 * 对齐搜索关掉，"最大跳变"那条纹丝不动，而这一条从 0.98 掉到 0.35。
 */
function envelopeFlatness(x: Float32Array, window: number): number {
  let lo = Infinity;
  let hi = 0;
  for (let at = 0; at + window <= x.length; at += window) {
    const level = rms(x.subarray(at, at + window));
    lo = Math.min(lo, level);
    hi = Math.max(hi, level);
  }
  return hi > 0 ? lo / hi : 0;
}

/**
 * 逐样本比对，报**第一个不同的下标和最大差值**，不用 `toEqual` 比整条数组。
 *
 * 不是风格问题：`toEqual` 在 96000 个元素上相等时很快，**一旦不等 vitest 要把整份
 * 差异漂亮打印出来**，跑几分钟不出结果——注入破坏之后"断言红了"看起来像死循环，
 * 而那是量法的问题不是被测代码的问题（实测踩过一次）。顺带也满足"两个读数相减得出
 * 结论时两个都要报出来"：这里印的是下标 + 两边的值。
 */
function expectIdentical(actual: readonly number[] | Float32Array, expected: readonly number[] | Float32Array): void {
  expect(actual.length).toBe(expected.length);
  let firstAt = -1;
  let worst = 0;
  let a = 0;
  let b = 0;
  for (let i = 0; i < actual.length; i++) {
    const delta = Math.abs(actual[i]! - expected[i]!);
    if (delta > 0 && firstAt < 0) firstAt = i;
    if (delta > worst) {
      worst = delta;
      a = actual[i]!;
      b = expected[i]!;
    }
  }
  expect({ firstAt, worst, a, b }).toEqual({ firstAt: -1, worst: 0, a: 0, b: 0 });
}

describe("参数校验", () => {
  it("倒放报错——取帧只能向前，不留音频能倒放的岔路", () => {
    expect(() => createTimeStretcher({ speed: rational(-2, 1), sampleRate: RATE, channelCount: 1 }))
      .toThrow(/倒放/);
  });

  it("采样率和声道数非法都报错", () => {
    expect(() => createTimeStretcher({ speed: rational(2, 1), sampleRate: 0, channelCount: 1 }))
      .toThrow(/采样率/);
    expect(() =>
      createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 0 }),
    ).toThrow(/声道数/);
  });

  it("给的声道数和说好的不符要报错，不是静默少一路", () => {
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 2 });
    expect(() => st.process(0, 100, { channels: [new Float32Array(400)], origin: 0 })).toThrow(
      /声道数不符/,
    );
  });

  it("窗长按采样率算，hop 是它的一半", () => {
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    expect(st.windowSamples).toBe(st.hopSamples * 2);
    expect(st.hopSamples).toBe(Math.round((RATE * WINDOW_SECONDS) / 2));
  });
});

describe("原速直通", () => {
  it("num === den 时一个样本都不动", () => {
    const src = chord(4000);
    const st = createTimeStretcher({ speed: rational(1, 1), sampleRate: RATE, channelCount: 1 });
    expectIdentical(pull(st, 0, 4000, [src])[0]!, src);
  });

  it("2/2 也算原速——判 === undefined 不够，同 isNormalSpeed", () => {
    const src = chord(2000);
    const st = createTimeStretcher({ speed: rational(2, 2), sampleRate: RATE, channelCount: 1 });
    // rational() 会约分成 1/1，这里要的就是"约分完等于 1 就必须走直通"
    expectIdentical(pull(st, 0, 2000, [src])[0]!, src);
  });
});

describe("长度与源片区间", () => {
  it("产出的样本数就是请求的样本数", () => {
    const src = chord(200_000);
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    expect(pull(st, 0, 33_333, [src])[0]!.length).toBe(33_333);
  });

  it("2× 下要的源片约是输出的两倍（外加窗和搜索的余量）", () => {
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    const range = st.sourceRangeFor(0, 48_000);
    const span = range.to - range.from;
    expect(span).toBeGreaterThan(96_000);
    expect(span).toBeLessThan(96_000 + 4 * st.windowSamples);
  });

  it("0.5× 下要的源片约是输出的一半", () => {
    const st = createTimeStretcher({ speed: rational(1, 2), sampleRate: RATE, channelCount: 1 });
    const range = st.sourceRangeFor(0, 48_000);
    expect(range.to - range.from).toBeGreaterThan(24_000);
    expect(range.to - range.from).toBeLessThan(24_000 + 4 * st.windowSamples);
  });
});

describe("分段不变性", () => {
  const src = chord(300_000);
  const speed = rational(3, 2);

  it("整块拉一次 == 分成不整齐的小块拉，逐样本相同", () => {
    const whole = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const once = pull(whole, 0, 96_000, [src])[0]!;

    // 4801 刻意不是 hop 的整数倍：块边界的账记错了才会在这里露出来
    const chunked = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const joined: number[] = [];
    for (let at = 0; at < 96_000; at += 4801) {
      const to = Math.min(96_000, at + 4801);
      joined.push(...Array.from(pull(chunked, at, to, [src])[0]!));
    }
    expectIdentical(joined, once);
  });

  it("段长换成 1 秒（预览）与 10 秒（导出）也逐样本相同", () => {
    const preview = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const exported = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const a: number[] = [];
    for (let at = 0; at < 96_000; at += RATE) {
      a.push(...Array.from(pull(preview, at, Math.min(96_000, at + RATE), [src])[0]!));
    }
    const b: number[] = [];
    for (let at = 0; at < 96_000; at += 10 * RATE) {
      b.push(...Array.from(pull(exported, at, Math.min(96_000, at + 10 * RATE), [src])[0]!));
    }
    expectIdentical(a, b);
  });

  it("重叠请求（相邻两段撑开 pad）由回看队列给出，和连续拉的结果一致", () => {
    const lookbackSamples = 16_000;
    const contiguous = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const reference = pull(contiguous, 0, 96_000, [src])[0]!;

    const overlapped = createTimeStretcher({
      speed,
      sampleRate: RATE,
      channelCount: 1,
      lookbackSamples,
    });
    const first = pull(overlapped, 0, 48_000, [src])[0]!;
    const second = pull(overlapped, 48_000 - lookbackSamples, 96_000, [src])[0]!;
    expectIdentical(first, reference.subarray(0, 48_000));
    expectIdentical(second, reference.subarray(48_000 - lookbackSamples, 96_000));
  });

  it("退得比回看队列还远要报错，不是悄悄从新位置起链", () => {
    const st = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1, lookbackSamples: 0 });
    pull(st, 0, 48_000, [src]);
    expect(() => pull(st, 0, 4_800, [src])).toThrow(/只能向前/);
  });

  it("从中间起链与从头推进过来，内容相同（相位可能差一块，这是已知取舍）", () => {
    const fromHead = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    pull(fromHead, 0, 48_000, [src]);
    const tail = pull(fromHead, 48_000, 96_000, [src])[0]!;

    const fromMiddle = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 1 });
    const seeked = pull(fromMiddle, 48_000, 96_000, [src])[0]!;

    expect(rms(seeked)).toBeCloseTo(rms(tail), 2);
  });
});

describe("音高", () => {
  it("2× 之后基频不变（重采样对照给出两倍，证明这个量法量得到音高）", () => {
    const src = sine(PROBE_FREQ, 300_000);
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    const stretched = pull(st, 0, RATE, [src])[0]!;
    expect(fundamental(stretched)).toBeGreaterThan(PROBE_FREQ - 15);
    expect(fundamental(stretched)).toBeLessThan(PROBE_FREQ + 15);

    // 对照：`playbackRate` 那条路（隔一个取一个）长度同样对，音高翻倍
    const resampled = new Float32Array(RATE);
    for (let i = 0; i < RATE; i++) resampled[i] = src[i * 2]!;
    expect(fundamental(resampled)).toBeGreaterThan(1900);
  });

  it("0.5× 之后基频也不变", () => {
    const src = sine(PROBE_FREQ, 60_000);
    const st = createTimeStretcher({ speed: rational(1, 2), sampleRate: RATE, channelCount: 1 });
    const stretched = pull(st, 0, 96_000, [src])[0]!;
    expect(fundamental(stretched)).toBeGreaterThan(PROBE_FREQ - 15);
    expect(fundamental(stretched)).toBeLessThan(PROBE_FREQ + 15);
  });

  it("响度基本不变（Hann 50% 重叠的权重恒为 1）", () => {
    const src = chord(300_000);
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    const stretched = pull(st, 0, RATE, [src])[0]!;
    expect(rms(stretched) / rms(src.subarray(0, 2 * RATE))).toBeGreaterThan(0.9);
    expect(rms(stretched) / rms(src.subarray(0, 2 * RATE))).toBeLessThan(1.1);
  });
});

describe("接缝", () => {
  it("稳态音伸缩后包络是平的——失配会让重叠区相互抵消，听起来是周期性的抖", () => {
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    const src = sine(cancellationFreq(st.hopSamples), 300_000);
    const stretched = pull(st, 0, RATE, [src])[0]!;
    // 健康值 1.0000，关掉对齐是 0.7071（半周期失配、两块相消），界取中间
    expect(envelopeFlatness(stretched, st.hopSamples)).toBeGreaterThan(0.95);
    // 量法自证：没被伸缩的源片本身就是平的，所以这个界不是靠量法自己撑起来的
    expect(envelopeFlatness(src.subarray(0, RATE), st.hopSamples)).toBeGreaterThan(0.99);
  });

  it("和音（两个不整除的频率）伸缩后包络也是平的", () => {
    const src = chord(300_000);
    const st = createTimeStretcher({ speed: rational(3, 2), sampleRate: RATE, channelCount: 1 });
    const stretched = pull(st, 0, RATE, [src])[0]!;
    // 健康值 0.9016，关掉对齐是 0.7964。和音上对齐只能照顾一个分量，所以健康值本来
    // 就不到 1——正因如此这一条的余量比稳态音那条小，两条都留着
    expect(envelopeFlatness(stretched, st.hopSamples)).toBeGreaterThan(0.85);
  });
});

describe("声道", () => {
  it("所有声道共用一个偏移，而那个偏移来自声道的混合信号", () => {
    // 判据是**线性性**：偏移固定时，伸缩对源片是线性的。所以取 L = A+B、R = A−B，
    // 两者的混合恰好是 A；再单独伸缩一对 [A, A]（混合同样是 A，于是偏移逐块相同），
    // 就必须有 out_L + out_R === 2 × out_A。
    //
    // 两条纪律一次钉住：偏移**共用**（各挑一个的话 out_R 用的是 R 的偏移，等式立刻不成立），
    // 以及偏移取自**混合**（只看第 0 路的话 out_L / out_R 的偏移来自 L，也不成立）。
    //
    // 第一版用的是 R = L × 0.5，**测不到任何东西**：归一化相关是尺度不变的，所以
    // "每个声道各挑一个"挑出来的还是同一个偏移，注入破坏后 21 项全绿。同 CLAUDE.md
    // 那条"被乘以零的那个因子测不到"——这里被约掉的是那个系数。
    const count = 300_000;
    const a = sine(440, count, 0.35);
    const b = sine(617, count, 0.25);
    const left = new Float32Array(count);
    const right = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      left[i] = a[i]! + b[i]!;
      right[i] = a[i]! - b[i]!;
    }

    const speed = rational(3, 2);
    const mixed = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 2 });
    const [outLeft, outRight] = pull(mixed, 0, 48_000, [left, right]) as [
      Float32Array,
      Float32Array,
    ];
    const reference = createTimeStretcher({ speed, sampleRate: RATE, channelCount: 2 });
    const outA = pull(reference, 0, 48_000, [a, a])[0]!;

    let worst = 0;
    for (let i = 0; i < outA.length; i++) {
      worst = Math.max(worst, Math.abs(outLeft[i]! + outRight[i]! - 2 * outA[i]!));
    }
    // 健康值 1.19e-7（正好是 f32 的 ulp，也就是存储舍入本身）；把对齐搬进声道循环
    // 是 5.22e-1，只看第 0 路不看混合是 7.74e-1——两个失效模式都由这一条抓住
    expect(worst).toBeLessThan(1e-5);
  });
});

describe("源片之外", () => {
  it("区间伸出源片两端时当零，不抛——片段头尾和转场借余量都会这样", () => {
    const src = chord(4_000);
    const st = createTimeStretcher({ speed: rational(2, 1), sampleRate: RATE, channelCount: 1 });
    const out = pull(st, 0, 48_000, [src]);
    expect(out[0]!.length).toBe(48_000);
    // 源片只有 4000 个样本，2× 下 2000 个输出样本之后就没东西了
    expect(rms(out[0]!.subarray(0, 1_500))).toBeGreaterThan(0.01);
    expect(rms(out[0]!.subarray(10_000))).toBe(0);
  });
});
