/**
 * 常驻资源计量：数**我们自己攥着多少东西**，而不是问浏览器用了多少内存。
 *
 * ## 为什么不用浏览器的内存 API
 *
 * 两条路都走不通，而且第二条会给出**假的安全感**：
 *
 * - `performance.measureUserAgentSpecificMemory()` 需要 `crossOriginIsolated`，
 *   也就是 COOP/COEP 响应头。那套头会打断页面里的第三方脚本和跨域 iframe，
 *   PLAN.md §2 正是因为这个理由把 ffmpeg.wasm 多线程版排除在主路径之外。
 *   为了量内存去开它，等于用一个更大的约束换一个数字。
 * - `performance.memory`（Chrome 私有）只报 **JS 堆**。而导出的内存几乎**全部
 *   不在 JS 堆上**：`VideoSample` 持有解码后的画面（媒体/显存）、`OffscreenCanvas`
 *   的后备存储、解码器内部的重排缓冲。一条 30 分钟的片子可以把显存吃光而
 *   `usedJSHeapSize` 几乎不动。拿它当护栏，就是那种"跑得过但量错了对象"的基准。
 *
 * 所以主信号是**自己数**：每一类会长大的资源，在借出和归还的地方各记一笔。
 * 这样得到的数在所有浏览器上都一样，而且回答的正是真问题——
 * **常驻量随帧号增长吗？** 不增长，峰值就与片长无关，那才是"能导 30 分钟"的证明。
 * `performance.memory` 仍然采，但只当旁证，并且在类型上就写明它只含 JS 堆。
 *
 * ## 字节数是估算，不是实测
 *
 * 解码帧按 **4:2:0 8bit = 1.5 字节/像素**折算——这是绝大多数硬解的输出格式，
 * 但驱动可能给出别的布局（NV12 同样是 1.5，P010 就是 3）。这个数用来看**量级和
 * 趋势**，不要拿它跟任务管理器的数字对账。计数（几个 sample、几个游标）是精确的，
 * 字节是估的，两者都报出来，别把后者当权威。
 */

/** 4:2:0 8bit 每像素的字节数。见文件头"字节数是估算"。 */
const BYTES_PER_PIXEL_I420 = 1.5;

export interface ResidencySnapshot {
  /** 此刻活着的解码帧个数。按设计每条轨最多 2 个（current + next）。 */
  readonly decodedSamples: number;
  /** 这些解码帧的估算字节数。 */
  readonly decodedBytes: number;
  /** 打开着的解码游标数，每个背后是一个 VideoDecoder。按设计每条轨最多 1 个。 */
  readonly openCursors: number;
  /** 打开着的 demuxer（`Input`）数。每条轨每个源片一个，见 frame-reader 的约定。 */
  readonly openInputs: number;
  /** 文字栅格缓存占的字节。每张是**输出尺寸**的画布，1080p 下单张 8.3MB。 */
  readonly textRasterBytes: number;
  /** 混好的 PCM。这一项**随片长线性增长**。 */
  readonly audioPcmBytes: number;
  /**
   * 混音过程中同时活着的中间 buffer：各素材解出来的 PCM、`OfflineAudioContext`
   * 的渲染目标。**只在主线程的那份计量里非零**——混音跑在主线程（硬规则 6）。
   *
   * 这一项容易被忽略而它可能比最终 PCM 还大：所有素材的解码结果要**同时**挂在
   * 音频图上等渲染，渲染目标是另一整份，拷出来交给 Worker 时又是一份。
   */
  readonly audioMixBytes: number;
  /** 上面几项之和。 */
  readonly estimatedBytes: number;
  /** Chrome 私有的 JS 堆用量，拿不到就是 null。**不含解码帧和画布**，只是旁证。 */
  readonly jsHeapBytes: number | null;
}

/**
 * 一次测量里最值得留下的东西：峰值那一刻的完整快照 + 它发生在第几帧。
 *
 * 只留峰值不够——"峰值 800MB"和"峰值 800MB 且出现在第 3 帧之后就不再涨"
 * 是两个结论。所以同时留首尾两个采样点，让"有没有随帧号增长"能直接判。
 */
export interface ResidencyReport {
  readonly peak: ResidencySnapshot;
  readonly peakAtFrame: number;
  readonly first: ResidencySnapshot | null;
  readonly last: ResidencySnapshot | null;
  readonly samples: number;
}

function readJsHeap(): number | null {
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  const used = perf.memory?.usedJSHeapSize;
  return typeof used === "number" ? used : null;
}

/**
 * 全局计量器。
 *
 * 做成模块级单例而不是往调用链上传一个对象：借出和归还发生在
 * `frame-reader` 深处，为了记一笔账把它一路传下去，会让每一层都多一个参数。
 * 单例是**每个 JS 上下文一份**——Worker 里的导出和主线程的预览各数各的，
 * 这正是想要的：问的是"这次导出攥了多少"。
 */
class ResidencyMeter {
  private samples = 0;
  private sampleBytes = 0;
  private cursors = 0;
  private inputs = 0;
  private audioPcmBytes = 0;
  private audioMixBytes = 0;
  /** 文字缓存的字节数由 text-raster 自己算，这里只存一个取值函数，避免反向依赖。 */
  private textRasterBytes: () => number = () => 0;

  retainSample(width: number, height: number): void {
    this.samples++;
    this.sampleBytes += Math.round(width * height * BYTES_PER_PIXEL_I420);
  }

  releaseSample(width: number, height: number): void {
    this.samples--;
    this.sampleBytes -= Math.round(width * height * BYTES_PER_PIXEL_I420);
  }

  openCursor(): void {
    this.cursors++;
  }
  closeCursor(): void {
    this.cursors--;
  }
  openInput(): void {
    this.inputs++;
  }
  closeInput(): void {
    this.inputs--;
  }

  setAudioPcmBytes(bytes: number): void {
    this.audioPcmBytes = bytes;
  }

  /** 混音中间 buffer 的借出 / 归还。传字节数，因为音频 buffer 的尺寸各不相同。 */
  retainMixBytes(bytes: number): void {
    this.audioMixBytes += bytes;
  }
  releaseMixBytes(bytes: number): void {
    this.audioMixBytes -= bytes;
  }

  bindTextRasterBytes(read: () => number): void {
    this.textRasterBytes = read;
  }

  /**
   * 归零。
   *
   * 每次导出开始时调一次：单例跨导出存活，上一次没归零的话这一次的
   * "常驻量随帧号增长吗"就会从一个非零基线开始，看起来像泄漏。
   * 反过来，**如果上一次结束后计数不是 0，那才是真泄漏**——所以先读后清，
   * 返回清零前的计数供调用方断言。
   */
  reset(): { samples: number; cursors: number; inputs: number } {
    const leftover = { samples: this.samples, cursors: this.cursors, inputs: this.inputs };
    this.samples = 0;
    this.sampleBytes = 0;
    this.cursors = 0;
    this.inputs = 0;
    this.audioPcmBytes = 0;
    this.audioMixBytes = 0;
    return leftover;
  }

  snapshot(): ResidencySnapshot {
    const textRasterBytes = this.textRasterBytes();
    return {
      decodedSamples: this.samples,
      decodedBytes: this.sampleBytes,
      openCursors: this.cursors,
      openInputs: this.inputs,
      textRasterBytes,
      audioPcmBytes: this.audioPcmBytes,
      audioMixBytes: this.audioMixBytes,
      estimatedBytes:
        this.sampleBytes + textRasterBytes + this.audioPcmBytes + this.audioMixBytes,
      jsHeapBytes: readJsHeap(),
    };
  }
}

export const residency = new ResidencyMeter();

/**
 * 开发期把计量器挂到全局，供控制台和实测脚本读**真实**那一份。
 *
 * 和 `__kerfStore` 是同一个坑的同一面：控制台里
 * `import('/src/export/residency.ts')` 会因为 Vite 的 HMR URL 带参数而拿到
 * **另一个模块实例**——那份从来没人喂过，读出来恒为 0，看起来像"计量没接上"。
 * 已经踩过一次：量 30 分钟混音时峰值报 0，查了才发现读的是另一个单例。
 *
 * Worker 里也会执行这段（`globalThis` 在 Worker 里是 self），于是导出侧的那份
 * 也能在 Worker 的控制台里读到。
 */
if (import.meta.env.DEV) {
  (globalThis as typeof globalThis & { __kerfResidency?: ResidencyMeter }).__kerfResidency =
    residency;
}

/**
 * 采样器：跟着导出的进度回调走，记峰值和首尾。
 *
 * 不自己起定时器——定时器在导出这种把线程占满的循环里本来就不准，而且会引入
 * 一个"测量本身影响被测对象"的问题。挂在已有的进度节流上（每 100ms 一次），
 * 与 §4 那条"把测量塞进已经会跑的路径"是同一个道理。
 */
export class ResidencyTracker {
  private peak: ResidencySnapshot | null = null;
  private peakAtFrame = 0;
  private first: ResidencySnapshot | null = null;
  private last: ResidencySnapshot | null = null;
  private count = 0;

  sample(frame: number): ResidencySnapshot {
    const snapshot = residency.snapshot();
    this.count++;
    this.first ??= snapshot;
    this.last = snapshot;
    if (!this.peak || snapshot.estimatedBytes > this.peak.estimatedBytes) {
      this.peak = snapshot;
      this.peakAtFrame = frame;
    }
    return snapshot;
  }

  report(): ResidencyReport {
    return {
      peak: this.peak ?? residency.snapshot(),
      peakAtFrame: this.peakAtFrame,
      first: this.first,
      last: this.last,
      samples: this.count,
    };
  }
}

/** 给界面用：把字节数说成人话。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
