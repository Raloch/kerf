/**
 * 把一个 Web Audio 图的输出**无损**抓成 PCM，供自检和导出那份 PCM 对拍。
 *
 * ## 为什么是 AudioWorklet，不是 MediaRecorder
 *
 * `MediaRecorder` 会编码（Opus / AAC），那是有损的——拿它去和导出的 PCM 比就只能
 * 比包络，而这条自检要判的恰恰是"某一段被放到了错的位置"，那种错误在包络上看不见。
 * Worklet 拿到的是 `Float32Array` 的原始块，直通输出的同时抄一份，逐样本可比。
 *
 * `createScriptProcessor` 也能拿到原始块，但它跑在主线程上：自检期间主线程还在
 * 解码、混音、跑 rAF，丢块是常态，而丢一块在逐样本比对里就是一次假红。
 *
 * ## 为什么在 processor 里攒着、只发一次
 *
 * 一块是 128 样本，一秒 375 块。逐块 postMessage 能跑，但那是往一条正在被自检压满的
 * 主线程上再压 375 条消息/秒，本身就会影响被测对象（预览的 tick 也在主线程上）。
 * 所以 processor 里预分配一段线性缓冲，写满为止，收到 `dump` 才一次性发回来。
 */

/** processor 源码。用 Blob URL 注册，避免为一个自检文件单独配一条构建产物。 */
const PROCESSOR_SOURCE = `
class KerfTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.capacity = opts.capacity || 48000 * 10;
    this.channelCount = opts.channelCount || 2;
    this.buffers = [];
    for (let ch = 0; ch < this.channelCount; ch++) this.buffers.push(new Float32Array(this.capacity));
    this.written = 0;
    /** 第一块对应的 context 样本位置，供调用方把采集缓冲映射回 context 时间。 */
    this.startFrame = -1;
    this.port.onmessage = (event) => {
      if (event.data !== "dump") return;
      const channels = this.buffers.map((b) => b.slice(0, this.written));
      this.port.postMessage({ startFrame: this.startFrame, written: this.written, channels });
    };
  }
  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const blockSize = output.length > 0 ? output[0].length : 128;
    if (this.startFrame < 0) this.startFrame = currentFrame;
    for (let ch = 0; ch < output.length; ch++) {
      const src = input[ch];
      // 上游没有活着的源时 Chrome 给的 input 是空数组——那时输出保持静音，
      // 采集缓冲里也该是静音，不能跳过（跳过就会把时间轴压缩）
      if (src) output[ch].set(src);
    }
    if (this.written < this.capacity) {
      const room = Math.min(blockSize, this.capacity - this.written);
      for (let ch = 0; ch < this.channelCount; ch++) {
        const src = input[ch];
        if (src) this.buffers[ch].set(src.subarray(0, room), this.written);
      }
      this.written += room;
    }
    return true;
  }
}
registerProcessor("kerf-tap", KerfTapProcessor);
`;

export interface AudioTap {
  /** 已经抓了多少样本（每声道）。 */
  captured(): number;
  /**
   * 取回抓到的 PCM。`startFrame` 是第一个样本对应的 context 样本位置。
   *
   * **超时返回空**，绝不死等：context 被关掉之后 worklet 就再也不回话了（自检建立
   * 过程中真踩过），而死等会让整条 M0 永远出不来报告——那比一条红断言坏得多。
   */
  dump(timeoutMs?: number): Promise<{
    readonly startFrame: number;
    readonly channels: readonly Float32Array[];
    readonly timedOut: boolean;
  }>;
  dispose(): void;
}

/**
 * 在 `output → destination` 之间插一个采集节点。
 *
 * **要先把 output 原来那条连线摘掉**，否则声音会同时经过采集节点和原路径到达
 * destination，听起来是两倍音量——而采集到的仍然是对的，于是这个错误在读数上
 * 完全看不见（只有耳朵能发现）。
 */
export async function tapAudioOutput(
  context: AudioContext,
  output: AudioNode,
  options: { readonly channelCount: number; readonly seconds: number },
): Promise<AudioTap> {
  const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const capacity = Math.ceil(context.sampleRate * options.seconds);
  const node = new AudioWorkletNode(context, "kerf-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [options.channelCount],
    channelCount: options.channelCount,
    channelCountMode: "explicit",
    processorOptions: { capacity, channelCount: options.channelCount },
  });

  output.disconnect();
  output.connect(node);
  node.connect(context.destination);

  // 采集进度：processor 每块都会更新自己的计数，但主线程只在 dump 时才知道。
  // 用 context 时钟估算就够了——它只用来决定"抓够了没有"
  const startedAt = context.currentTime;
  return {
    captured: () => Math.max(0, Math.round((context.currentTime - startedAt) * context.sampleRate)),
    dump: (timeoutMs = 3000) =>
      new Promise((resolve) => {
        const empty = Array.from({ length: options.channelCount }, () => new Float32Array(0));
        const timer = setTimeout(
          () => resolve({ startFrame: -1, channels: empty, timedOut: true }),
          timeoutMs,
        );
        node.port.onmessage = (event: MessageEvent) => {
          clearTimeout(timer);
          const data = event.data as {
            startFrame: number;
            written: number;
            channels: Float32Array[];
          };
          resolve({ startFrame: data.startFrame, channels: data.channels, timedOut: false });
        };
        node.port.postMessage("dump");
      }),
    dispose: () => {
      node.disconnect();
    },
  };
}

/**
 * 第一个越过阈值的样本位置。找不到返回 -1。
 *
 * 用**起始沿**而不是互相关来对齐，理由是被测信号周期性太强：连续正弦的自相关在
 * 每个周期上都有一个同样高的峰（1kHz 在 48k 上是 48 个样本一个），互相关给出的
 * "最佳偏移"根本不唯一。而"静音 → 有声"这个沿在半秒的搜索窗里是唯一的。
 * M0 量编码延迟用的也是这个办法。
 */
export function firstOnset(samples: Float32Array, threshold = 0.05): number {
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) > threshold) return i;
  }
  return -1;
}

export interface DiffResult {
  readonly worst: number;
  readonly worstAt: number;
  readonly compared: number;
}

/** 逐样本比对 `a[i]` 与 `b[offset + i]`，报最大差和它的位置。 */
export function diffAt(
  a: readonly Float32Array[],
  b: readonly Float32Array[],
  offset: number,
  length: number,
): DiffResult {
  let worst = 0;
  let worstAt = -1;
  const channels = Math.min(a.length, b.length);
  for (let ch = 0; ch < channels; ch++) {
    const x = a[ch]!;
    const y = b[ch]!;
    for (let i = 0; i < length; i++) {
      const d = Math.abs(x[i]! - y[offset + i]!);
      if (d > worst) {
        worst = d;
        worstAt = i;
      }
    }
  }
  return { worst, worstAt, compared: length * channels };
}
