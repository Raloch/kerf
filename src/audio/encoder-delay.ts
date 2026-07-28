/**
 * 测量音频编码器的**编码延迟**（priming / encoder delay），用来在喂 PCM 之前补偿掉它。
 *
 * ## 这是在修什么
 *
 * AAC 编码器的输出比输入晚若干个样本（MDCT 前瞻），而 WebCodecs 把这批 priming
 * 样本**标成从 t=0 开始**——`AudioEncoder` 输出的第一个 chunk 时间戳就是 0，
 * `decoderConfig` 里也没有任何字段说明延迟是多少。于是解回来的音频整体后移，
 * 实测 Chrome 150 与 Safari 26.5 **都是 2112 样本 = 44ms**。
 *
 * 正规的解法是让容器告诉播放器"跳过前 N 个解码样本"：MP4 里是 `elst` 的
 * `media_time`，Opus 里是 `OpusHead.pre_skip`。**Opus 那条 mediabunny 做了**
 * （实测 WebM/Opus 偏移为 0），**MP4/AAC 这条没有**——mediabunny 1.51 的 `edts`
 * 只会写"空编辑把整条轨往后推"，喂负时间戳也会被静默归零。
 *
 * 所以成片的前 44ms **必然**是 priming，这一段我们改变不了。能改变的只有喂什么进去：
 *
 * ```
 * 播放器在 k/RATE 播 dec[k]，而 dec[k] = fed[k−D]
 * 要让 pcm[k] 在 k/RATE 响  ⟹  fed[j] = pcm[j+D]   ← 把 PCM 头部丢掉 D 个样本
 * ```
 *
 * 代价是 `pcm[0..D)` 那 44ms 没了。它本来也只能落在 priming 区，**没有别的地方可去**；
 * 换来的是之后全程精确同步，而不是永远晚 44ms、且每导出一次再叠加一次。
 *
 * ## 为什么要测，不写死 2112
 *
 * 两个浏览器测出来一模一样，看着像常数。但这个值来自编码器实现（不同厂商、软/硬编、
 * 不同采样率都可能不同），而 WebCodecs 不暴露它——**写死就等于赌**，赌输的表现是
 * 音画偏移，不报错。测一次的代价是编解码 0.34 秒音频（几十毫秒），一次导出摊一次。
 *
 * 测不出来时返回 0，也就是退回未补偿的旧行为：宁可保持已知的 44ms，也不要按一个
 * 可疑的数去移。所以 `reason` 会一路报到导出结果里，而不是悄悄吞掉。
 */

/** 探测信号长度。要够长以让互相关峰值明确，又不必更长——这段是纯开销。 */
const PROBE_FRAMES = 16_384;
/** 延迟搜索上限（样本）。AAC 是 2112，留到 6000 足够覆盖离谱的实现。 */
const SEARCH_LIMIT = 6_000;
/** 参与互相关的窗口长度。 */
const CORRELATION_WINDOW = 4_096;
/** 低于这个相关性就认为没对上，实测 AAC 0.69–0.78、Opus 0.75–0.86。 */
const MIN_CORRELATION = 0.3;

export interface EncoderDelay {
  /** 应当从喂给编码器的 PCM 头部丢掉的帧数。测不出来时是 0。 */
  readonly samples: number;
  /**
   * 测这个延迟时用的采样率。
   *
   * 带着它是为了让"多少毫秒"能在**任何地方**算出来——导出面板要显示这个数，
   * 而面板不能 import `mixdown.ts` 拿 `MIX_SAMPLE_RATE`：那会把 mediabunny
   * 拖回首屏 chunk（已经踩过一次，见 CLAUDE.md 的首屏体积一节）。
   */
  readonly sampleRate: number;
  /** 互相关峰值的归一化强度，用来判断这个数可不可信。 */
  readonly correlation: number;
  /** 没测成时说明原因；测成了就是 undefined。 */
  readonly reason?: string;
}

/**
 * 确定性伪随机噪声。
 *
 * 用噪声而不是正弦或脉冲：正弦是周期的，互相关会在每个周期上都出峰，分不清是
 * 延迟 0 还是延迟一个周期；脉冲经过有损编码会被抹平。噪声的自相关是尖的。
 * 用固定种子而不是 `Math.random()`，是为了同一台机器上两次测量可比。
 */
export function probeNoise(length: number): Float32Array {
  const out = new Float32Array(length);
  let state = 12_345;
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    out[i] = ((state / 0x7fff_ffff) * 2 - 1) * 0.5;
  }
  return out;
}

/**
 * 找让 `decoded[lag..]` 与 `reference[0..]` 最相关的 `lag`，也就是延迟了多少个样本。
 *
 * 抽成纯函数是为了能单测——真正的 `AudioEncoder` 在 node 里没有，而这段"峰值在哪"
 * 的算术恰恰是会写错的地方（差一、归一化除以零、搜索窗口越界）。
 */
export function bestLag(
  reference: Float32Array,
  decoded: Float32Array,
  searchLimit = SEARCH_LIMIT,
  window = CORRELATION_WINDOW,
): { lag: number; correlation: number } {
  const usable = Math.min(window, reference.length, decoded.length - searchLimit);
  if (usable <= 0) return { lag: 0, correlation: 0 };

  let bestLagValue = 0;
  let bestDot = -Infinity;
  for (let lag = 0; lag < searchLimit; lag++) {
    let dot = 0;
    // 隔一个样本取一次：峰值位置不受影响，代价减半
    for (let i = 0; i < usable; i += 2) dot += reference[i]! * decoded[lag + i]!;
    if (dot > bestDot) {
      bestDot = dot;
      bestLagValue = lag;
    }
  }

  let refEnergy = 0;
  let decEnergy = 0;
  for (let i = 0; i < usable; i += 2) {
    refEnergy += reference[i]! * reference[i]!;
    decEnergy += decoded[bestLagValue + i]! * decoded[bestLagValue + i]!;
  }
  const denom = Math.sqrt(refEnergy * decEnergy);
  return { lag: bestLagValue, correlation: denom > 0 ? bestDot / denom : 0 };
}

/** 同一份配置只测一次。Worker 每次导出新建，所以实际是"每次导出一次"。 */
const cache = new Map<string, Promise<EncoderDelay>>();

const noDelay = (sampleRate: number, reason: string): EncoderDelay => ({
  samples: 0,
  sampleRate,
  correlation: 0,
  reason,
});

export function measureEncoderDelay(config: AudioEncoderConfig): Promise<EncoderDelay> {
  const key = `${config.codec}|${config.sampleRate}|${config.numberOfChannels}|${config.bitrate ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pending = runMeasurement(config).catch(
    (error: unknown): EncoderDelay =>
      noDelay(
        config.sampleRate,
        `延迟测量失败：${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  cache.set(key, pending);
  return pending;
}

/** 仅供测试用：清掉缓存。 */
export function resetEncoderDelayCache(): void {
  cache.clear();
}

async function runMeasurement(config: AudioEncoderConfig): Promise<EncoderDelay> {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") {
    return noDelay(config.sampleRate, "此环境没有 WebCodecs 音频编解码器");
  }

  const channels = config.numberOfChannels;
  const reference = probeNoise(PROBE_FRAMES);

  const packets: { chunk: EncodedAudioChunk; config: AudioDecoderConfig | undefined }[] = [];
  const encoder = new AudioEncoder({
    output: (chunk, meta) => packets.push({ chunk, config: meta?.decoderConfig }),
    // 编码器的异步错误由下面的 flush() 抛出，这里不能把它吞掉
    error: () => undefined,
  });
  encoder.configure(config);

  // **关在 finally 里，不能只关成功那一路。** `flush()` 正是异步编码错误的出口
  // （上面的 `error` 回调刻意不吞），所以"抛了"是这里的常规路径之一；而 WebCodecs
  // 的编码器是操作系统级资源，漏一个就少一份预算。这个探针**每次导出都跑一遍**，
  // 于是一次失败的导出会让下一次的余量更少——同"每个 VideoFrame 都必须 close"
  // （硬规则 4）、`OfflineAudioContext` 要显式 `close()`（D22）、WebGL 上下文要复用
  // （D15）是同一条：这类资源一律显式释放，不指望 GC。
  try {
    const STEP = 1024;
    for (let offset = 0; offset < PROBE_FRAMES; offset += STEP) {
      const length = Math.min(STEP, PROBE_FRAMES - offset);
      // f32-planar：各声道依次排列，每个声道都喂同一份噪声
      const data = new Float32Array(length * channels);
      for (let ch = 0; ch < channels; ch++) {
        data.set(reference.subarray(offset, offset + length), ch * length);
      }
      const audioData = new AudioData({
        format: "f32-planar",
        sampleRate: config.sampleRate,
        numberOfFrames: length,
        numberOfChannels: channels,
        timestamp: Math.round((offset / config.sampleRate) * 1e6),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }

  const first = packets[0];
  if (!first?.config) {
    return noDelay(config.sampleRate, "编码器没有给出 decoderConfig，无法解回来比对");
  }

  const planes: Float32Array[] = [];
  let decodedFrames = 0;
  const decoder = new AudioDecoder({
    output: (data) => {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
      planes.push(plane);
      decodedFrames += plane.length;
      data.close();
    },
    error: () => undefined,
  });
  // 同上：`configure` 会因为配置不受支持而抛，`flush` 会把异步解码错误抛出来，
  // 两条都必须走到 close
  try {
    decoder.configure(first.config);
    for (const { chunk } of packets) decoder.decode(chunk);
    await decoder.flush();
  } finally {
    if (decoder.state !== "closed") decoder.close();
  }

  const decoded = new Float32Array(decodedFrames);
  let cursor = 0;
  for (const plane of planes) {
    decoded.set(plane, cursor);
    cursor += plane.length;
  }

  const { lag, correlation } = bestLag(reference, decoded);
  if (correlation < MIN_CORRELATION) {
    return noDelay(
      config.sampleRate,
      `延迟测量相关性过低（${correlation.toFixed(2)}），不敢按它移`,
    );
  }
  if (lag >= SEARCH_LIMIT - 1) {
    return noDelay(config.sampleRate, `延迟测量顶到搜索上限（${lag}），结果不可信`);
  }
  return { samples: lag, sampleRate: config.sampleRate, correlation };
}
