/**
 * 保音高变速的算法本体：时间伸缩（WSOLA）。
 *
 * 变速那一刀（**D39**）用的是 `AudioBufferSourceNode.playbackRate`，也就是重采样：
 * 2× 播出来时长对了、**音高跟着翻一倍**。这个模块换掉那一半——把源片在时间轴上
 * 拉长/压短而**不动频率**，做法是按块重叠相加（overlap-add），块的取用位置由
 * **波形相似度**挑（Waveform Similarity Overlap-Add）。
 *
 * ## 为什么它必须是"只向前 + 回看队列"，而不是一个纯函数
 *
 * 第一版想写成纯函数 `stretchRange(源片, 输出区间)`——任何输出区间都能独立算出来，
 * 于是分段混音（**D22**）怎么切都不影响结果。**做不到，而且这不是实现问题。**
 * 任何能听的时间伸缩都有一条**累积的对齐链**：第 k 块放在哪，取决于第 k−1 块实际
 * 落在了哪（要跟它的自然延续对上相位），而 k−1 又取决于 k−2。把链剪断的办法都试过一遍：
 *
 * - **按标称位置对齐**（忽略上一块的实际偏移）：偏移量最多差一个搜索半径，
 *   于是接缝处相位对不上——那正是要消掉的东西。
 * - **零交叉吸附**：两块都从上升零交叉开始，但接缝比的是"上一块往后 hop 个样本处"
 *   与"这一块的起点"，前者只有在 hop 恰是周期整数倍时才还落在零交叉上。不成立。
 * - **定期重启对齐链**（每 N 个输出样本重新起链）：重启点就是一次相位跳变。
 *   要让它不可闻就得把 N 放大，而 N 放大就意味着每次请求都要从 N 之前重算——
 *   预览一段只有 1 秒，重算 5 秒等于 5 倍开销，而相关搜索本身就是这里最贵的一步。
 *
 * 所以答案不是消掉链，是**给链一个只能向前的宿主**——而这个仓库里已经有一个一模一样的：
 * `ClipAudioCursor`（"一次 seek，之后只向前读"）。相邻两段的**输出**区间也重叠
 * 2×pad，所以伸缩器同样要留一条**输出侧**的回看队列，重叠那截从队列里给，链本身
 * 一步都不后退。于是"分段与不分段逐样本一致"这条断言（M0 里已有）结构性地成立：
 * 两种切法下链都从同一个锚点出发、按同一顺序推进，得到的就是同一串样本。
 *
 * **代价要说清楚**：链的起点是"第一次调用要产出的位置"。导出和预览从头播时锚点相同，
 * 所以两边逐样本一致；用户拖了播放头之后预览从新位置起链，与成片会差一个**不足一块**
 * 的相位（内容相同、听不出来）。这一条不能靠"再对齐一次"补——那就是把链接回去了。
 *
 * ## 输出边缘不做淡入，靠"第一块左半不加窗"
 *
 * 50% 重叠的周期 Hann 窗有 `w[n] + w[n + hop] ≡ 1`，所以内部区间的权重恒为 1、
 * 不需要除法。只有**整条的第一块**左半没有前驱，那里直接**原样拷贝源片**（权重 1）
 * 而不是加窗——加了窗就要除以 `w[n]`，而 `w[0] = 0`，第一个样本会变成 0/0。
 * 拷贝的接法是精确的：接缝处 `w[hop] = 1`、`w[0] = 0`，正好续上。
 *
 * ## 输出轴锚在"片段音频的起点"，所以位置可以是负数
 *
 * 锚点必须是**片段自己的**属性，不能是"这次导出第一次问到它的位置"：后者会随导出区间
 * 变，于是同一个项目导全片和导一段得到不同的相位。而片段向两侧转场借出的余量落在
 * `clip.timelineIn` **之前**（`clipRenderSpan()`），所以输出样本号会到负数——这里
 * 不拦它。拦了的表现是"带转场的片段一开保音高就在入场那一侧静音"。
 *
 * ## 倒放不做
 *
 * 同 D39：`VideoTrackReader` 的"取帧只能向前"是硬规则 3 的前提，负速度在这里
 * 直接报错，不留一条"音频能倒着放但画面不能"的岔路。
 */

import { type Rational } from "../time/rational";

/**
 * 分析窗长（秒）。30ms 是语音/音乐通用的取法：短于一个基音周期就无从谈相似度
 * （80Hz 的周期是 12.5ms），长过 50ms 则瞬态会被抹成"两次"。
 */
export const WINDOW_SECONDS = 0.03;

/**
 * 对齐搜索半径（秒）。要能覆盖一个最低基音周期（80Hz = 12.5ms）的一半以上，
 * 否则低音区找不到能对上的偏移；再大只是白花相关运算。
 */
export const SEARCH_SECONDS = 0.01;

/** 相似度比较的长度（秒）。不超过 hop——比过 hop 就把下一块的地盘也算进去了。 */
export const CORRELATION_SECONDS = 0.01;

/**
 * 一段样本。写成 `Float32Array<ArrayBuffer>` 而不是裸 `Float32Array`：后者默认是
 * `ArrayBufferLike`（含 `SharedArrayBuffer`），而 `AudioBuffer.copyToChannel()` 只收
 * 普通 `ArrayBuffer` 上的视图——用裸类型的话接线那一行才编译不过，而错在这里。
 */
export type Samples = Float32Array<ArrayBuffer>;

/** 源片的一段样本。`channels[c][0]` 对应绝对源片样本号 `origin`。 */
export interface StretchSource {
  readonly channels: readonly Samples[];
  readonly origin: number;
}

/** 闭开区间 `[from, to)`，单位是源片样本。 */
export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

export interface StretchOptions {
  /** 消耗源片的倍率：2 = 一秒输出吃掉两秒源片。恒等（`num === den`）走直通。 */
  readonly speed: Rational;
  /** 源片自身的采样率。输出也在这个采样率上，重采样到混音采样率是音频图的事。 */
  readonly sampleRate: number;
  readonly channelCount: number;
  /**
   * 输出侧回看队列的长度（样本）。取相邻两段输出区间的重叠量（2 × pad）。
   * 给 0 就意味着"调用方保证每次请求都从上次的终点接上"，重叠请求会直接报错。
   */
  readonly lookbackSamples?: number;
}

export interface TimeStretcher {
  readonly windowSamples: number;
  readonly hopSamples: number;
  readonly searchSamples: number;
  /**
   * 要产出 `[outStart, outEnd)` 需要哪一段源片。
   *
   * **必须在 `process` 之前问**，而且两次调用之间不能插进别的 `process`——
   * 它的答案依赖对齐链现在走到了哪一块。
   */
  sourceRangeFor(outStart: number, outEnd: number): SourceRange;
  /**
   * 产出 `[outStart, outEnd)` 的样本。
   *
   * `outStart` 可以落在上次请求的区间里（相邻两段重叠），那一截从回看队列里给；
   * 落在队列之外就报错——那是"链要往回走"，不是能补的事。
   */
  process(outStart: number, outEnd: number, source: StretchSource): Samples[];
}

export function createTimeStretcher(options: StretchOptions): TimeStretcher {
  const { speed, sampleRate, channelCount } = options;
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`采样率必须是正数：${sampleRate}`);
  }
  if (!Number.isInteger(channelCount) || channelCount <= 0) {
    throw new Error(`声道数必须是正整数：${channelCount}`);
  }
  if (!Number.isFinite(speed.num) || !Number.isFinite(speed.den)) {
    throw new Error(`速度必须是有限有理数：${speed.num}/${speed.den}`);
  }
  if (speed.num <= 0 || speed.den <= 0) {
    throw new Error(`速度必须为正（倒放不做，见文件头）：${speed.num}/${speed.den}`);
  }

  const passthrough = speed.num === speed.den;
  const hop = Math.max(1, Math.round((sampleRate * WINDOW_SECONDS) / 2));
  const windowSamples = hop * 2;
  const search = Math.max(1, Math.round(sampleRate * SEARCH_SECONDS));
  const corr = Math.max(1, Math.min(hop, Math.round(sampleRate * CORRELATION_SECONDS)));
  const lookback = Math.max(0, Math.floor(options.lookbackSamples ?? 0));

  // 周期 Hann：50% 重叠时 w[n] + w[n + hop] ≡ 1，所以内部不需要除权重
  const win = new Float32Array(windowSamples);
  for (let n = 0; n < windowSamples; n++) {
    win[n] = 0.5 * (1 - Math.cos((2 * Math.PI * n) / windowSamples));
  }

  /** 下一块的序号。null = 链还没起。 */
  let nextBlock: number | null = null;
  /** 已产出到哪个输出样本（闭开上界）。 */
  let producedEnd = 0;
  /** 链是从哪个输出样本起的。回看能给到哪儿要按它算，不能按 0 算——链可以从中间起。 */
  let chainStart = 0;
  /** 上一块右半加窗后的结果，等着和下一块左半相加。长度 hop。 */
  let carry: Samples[] | null = null;
  /** 上一块内容"往后 hop 个样本"起的那一小段（单声道），下一块要跟它对相位。 */
  let corrTarget: Samples | null = null;

  // 回看队列：一条滑动窗口，末端始终是 producedEnd。多留一个 window 是因为
  // 每次调用会产出到块边界，可能比请求的 outEnd 多出最多一个 hop
  const histLength = passthrough ? 0 : lookback + windowSamples;
  const hist: Samples[] = [];
  if (histLength > 0) {
    for (let ch = 0; ch < channelCount; ch++) hist.push(new Float32Array(histLength));
  }

  function nominalAt(block: number): number {
    return Math.round((block * hop * speed.num) / speed.den);
  }

  /**
   * 链从哪一块起。**不要往前多退一块。**
   *
   * 第一版写的是 `floor(outStart / hop) - 1`，理由是"请求的起点通常落在块中间，退一块
   * 让它落在已经重叠相加过的区间里"——而那和"第一块左半原样拷贝"是**同一条边的两个
   * 补偿**，叠起来就错了：退一块之后原样拷贝落在**上一块**上，于是起点那一截只有单块的
   * 加窗内容、被上升 Hann 衰减。原来靠 `Math.max(0, …)` 把它挡住了（outStart = 0 时退不动），
   * 放开负数位置之后立刻暴露，实测包络平整度从 1.0000 掉到 **0.6124**。
   */
  function firstBlockFor(outStart: number): number {
    return Math.floor(outStart / hop);
  }

  function assertRange(outStart: number, outEnd: number): void {
    if (!Number.isInteger(outStart) || !Number.isInteger(outEnd)) {
      throw new Error(`输出区间必须是整数样本号：[${outStart}, ${outEnd})`);
    }
    if (outEnd < outStart) throw new Error(`输出区间反了：[${outStart}, ${outEnd})`);
  }

  function sourceRangeFor(outStart: number, outEnd: number): SourceRange {
    assertRange(outStart, outEnd);
    if (passthrough) return { from: outStart, to: outEnd };
    const from = nextBlock ?? firstBlockFor(outStart);
    const last = Math.floor((outEnd - 1) / hop);
    if (outEnd <= outStart || last < from) {
      const at = nominalAt(from);
      return { from: at, to: at };
    }
    // 右端多留一个 window：既盖住最后一块自己的窗，也盖住它之后那段用来对相位的
    // corrTarget（hop + corr ≤ window，因为 corr ≤ hop）
    return { from: nominalAt(from) - search, to: nominalAt(last) + search + windowSamples };
  }

  function process(outStart: number, outEnd: number, source: StretchSource): Samples[] {
    assertRange(outStart, outEnd);
    if (source.channels.length !== channelCount) {
      throw new Error(`声道数不符：说好 ${channelCount}，给了 ${source.channels.length}`);
    }
    const length = outEnd - outStart;
    const out: Samples[] = [];
    for (let ch = 0; ch < channelCount; ch++) out.push(new Float32Array(length));
    if (length === 0) return out;

    if (passthrough) {
      // 原速一个样本都不动。同 `isNormalSpeed` / 恒等增益那条：这不是性能优化，
      // 是让"没开保音高的项目"连代码路径都和以前相同
      for (let ch = 0; ch < channelCount; ch++) {
        const src = source.channels[ch]!;
        const dst = out[ch]!;
        for (let i = 0; i < length; i++) {
          const idx = outStart + i - source.origin;
          dst[i] = idx >= 0 && idx < src.length ? src[idx]! : 0;
        }
      }
      return out;
    }

    // 回看：重叠那一截只能从队列里给，链不许后退
    if (nextBlock !== null && outStart < producedEnd) {
      const available = Math.min(histLength, producedEnd - chainStart);
      if (outStart < producedEnd - available) {
        throw new Error(
          `输出 ${outStart} 落在回看队列之外（队列只到 ${producedEnd - available}）——` +
            `伸缩链只能向前，把 lookbackSamples 调大或按顺序请求`,
        );
      }
      const upto = Math.min(outEnd, producedEnd);
      for (let ch = 0; ch < channelCount; ch++) {
        const h = hist[ch]!;
        const dst = out[ch]!;
        for (let i = outStart; i < upto; i++) {
          dst[i - outStart] = h[histLength - (producedEnd - i)]!;
        }
      }
      if (outEnd <= producedEnd) return out;
    }

    const mono = buildMono(source, channelCount);
    if (nextBlock === null) {
      nextBlock = firstBlockFor(outStart);
      producedEnd = nextBlock * hop;
      chainStart = producedEnd;
    }

    // 循环里用一个局部块号：写成 `const block = nextBlock` 再 `nextBlock = block + 1`
    // 会让 tsc 判成循环推断（TS7022，`block` 的类型间接引用了自己）
    let block = nextBlock;
    while (producedEnd < outEnd) {
      const place = placeBlock(block, mono, source.origin);
      const left = carry;
      const emitted: Samples[] = [];
      const nextCarry: Samples[] = [];
      for (let ch = 0; ch < channelCount; ch++) {
        const src = source.channels[ch]!;
        const head = new Float32Array(hop);
        const tail = new Float32Array(hop);
        for (let n = 0; n < hop; n++) {
          const a = sampleAt(src, source.origin, place + n);
          // 第一块左半原样拷贝：没有前驱可以凑出权重 1，而 w[0] = 0 会变成 0/0
          head[n] = left ? left[ch]![n]! + win[n]! * a : a;
          tail[n] = win[hop + n]! * sampleAt(src, source.origin, place + hop + n);
        }
        emitted.push(head);
        nextCarry.push(tail);
      }

      writeHistory(emitted);
      // 这一块内容往后 hop 处，就是下一块在输出上要接的位置
      corrTarget = sliceMono(mono, source.origin, place + hop, corr);
      carry = nextCarry;
      producedEnd = (block + 1) * hop;
      block += 1;

      // 落进本次请求区间的那部分抄出去
      const from = Math.max(outStart, producedEnd - hop);
      const to = Math.min(outEnd, producedEnd);
      for (let i = from; i < to; i++) {
        const src = i - (producedEnd - hop);
        for (let ch = 0; ch < channelCount; ch++) out[ch]![i - outStart] = emitted[ch]![src]!;
      }
    }
    nextBlock = block;

    return out;
  }

  /** 挑第 k 块从源片哪里取。第一块没有参照，就用标称位置。 */
  function placeBlock(block: number, mono: Samples, origin: number): number {
    const nominal = nominalAt(block);
    const target = corrTarget;
    if (!target) return nominal;

    let best = nominal;
    let bestScore = -Infinity;
    // 按 |δ| 从小到大试，于是打平时取最靠近标称位置的那个——顺序定死才谈得上
    // "分段与不分段逐样本一致"
    for (let step = 0; step <= search; step++) {
      for (const delta of step === 0 ? [0] : [-step, step]) {
        const score = similarity(mono, origin, nominal + delta, target);
        if (score > bestScore) {
          bestScore = score;
          best = nominal + delta;
        }
      }
    }
    return best;
  }

  /**
   * 归一化互相关。分母只取候选段自己的能量——参照段的能量在同一次搜索里是常数，
   * 除它不改变名次，白算一遍。
   */
  function similarity(
    mono: Samples,
    origin: number,
    at: number,
    target: Samples,
  ): number {
    let dot = 0;
    let energy = 0;
    for (let n = 0; n < target.length; n++) {
      const a = sampleAt(mono, origin, at + n);
      dot += a * target[n]!;
      energy += a * a;
    }
    if (energy <= 0) return 0;
    return dot / Math.sqrt(energy);
  }

  function sliceMono(
    mono: Samples,
    origin: number,
    at: number,
    count: number,
  ): Samples {
    const out = new Float32Array(count);
    for (let n = 0; n < count; n++) out[n] = sampleAt(mono, origin, at + n);
    return out;
  }

  function writeHistory(emitted: readonly Samples[]): void {
    if (histLength === 0) return;
    for (let ch = 0; ch < channelCount; ch++) {
      const h = hist[ch]!;
      h.copyWithin(0, hop);
      h.set(emitted[ch]!, histLength - hop);
    }
  }

  return {
    windowSamples,
    hopSamples: hop,
    searchSamples: search,
    sourceRangeFor,
    process,
  };
}

/**
 * 源片上不存在的位置一律当零。
 *
 * 区间伸出源片两端是常态（转场借余量、片段头尾），同 `ClipAudioCursor.read`：
 * 解不到的部分留成零 = 静音。这里报错的话，一个正常的片段头就会让整段混音倒下。
 */
function sampleAt(data: Samples, origin: number, at: number): number {
  const idx = at - origin;
  return idx >= 0 && idx < data.length ? data[idx]! : 0;
}

/**
 * 单声道混合，**只给对齐搜索用**。
 *
 * 相似度必须在混合信号上算：各声道各挑一个偏移的话，同一时刻的左右声道会来自源片
 * 不同位置，立体声像会左右乱晃——而每一路自己听都是对的。
 */
function buildMono(source: StretchSource, channelCount: number): Samples {
  const first = source.channels[0]!;
  if (channelCount === 1) return first;
  const mono = new Float32Array(first.length);
  for (let ch = 0; ch < channelCount; ch++) {
    const data = source.channels[ch]!;
    for (let i = 0; i < mono.length; i++) mono[i]! += data[i]! / channelCount;
  }
  return mono;
}
