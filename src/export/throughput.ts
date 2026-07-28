/**
 * 这台机器导出有多快，以及**照这个速度这次要跑多久**。
 *
 * ## 为什么是"量"而不是"认设备"
 *
 * 要解决的问题很具体：iPhone 上 2160p 实测只有 **0.66× 实时**（1080p 有 3× 余量），
 * 于是一条 30 分钟的 4K 片子要把手机按住 45 分钟、发烫、而且离"切去别的标签就被
 * 节流"只差一步。用户该在点下去**之前**知道这件事。
 *
 * 直觉做法是按设备分档（UA 里有没有 iPhone、`hardwareConcurrency` 是不是 ≤4），
 * **但那测的不是被测对象**：真正的变量是吞吐，而同一个"移动端"标签下有 iPad Pro
 * 也有五年前的千元机，桌面这边也有比手机更慢的老笔记本。按 UA 分档会在快设备上
 * 白拦、在慢设备上放过去，两种错都不报警。同 CLAUDE.md 那条"别把某个浏览器给的
 * 元数据当成事实"。
 *
 * 所以改成**记住这台机器真实跑出来的速度**：每次导出结束都有 `encodedFrames` /
 * `elapsedMs` / 输出尺寸 / 后端，攒成一个样本存起来，下次按像素量缩放去预测。
 * 第一次导出没有样本，那就**什么都不说**——没有依据时的沉默比一个编出来的数字好。
 *
 * ## 只提醒，不封顶
 *
 * 不做"移动端禁止 4K"这种硬封顶，两个理由：
 *
 * 1. **静默把 4K 换成 1080p 就是硬规则 10 那件事**（用户点了 A 拿到 B）。要封就得
 *    像 D3 那样置灰加解释，而封顶的依据是一个**预测**——
 * 2. **预测错的时候，封顶挡掉的是一次本来能成的导出。** 同 D24 刚定下的那条：
 *    估算出来的结论只能提醒。
 *
 * 相应地警告线定得很松（`SLOW_FACTOR`）：模型只是"每像素每帧的耗时在同一台机器上
 * 大致恒定"，它有误差，所以只在**慢到量级不对**时才开口。
 */

import type { CompositorBackend } from "../compose/backend";

/** 一次导出跑出来的速度。 */
export interface ThroughputSample {
  /** 每一"像素·帧"花了多少毫秒。这是跨分辨率缩放的那个量。 */
  readonly msPerPixelFrame: number;
  /** 量这个数时的输出像素量，只用于展示"依据是哪一档"。 */
  readonly pixels: number;
  readonly frames: number;
  /**
   * 哪个后端量的。**不能跨后端复用**：Canvas2D 做不了 GPU 效果，两条路径的
   * 每帧成本不是同一个量级（spike 实测比值 0.93×–1.69×，而那是同一个后端对比）。
   */
  readonly backend: CompositorBackend;
  /** 量到的时刻（毫秒），太老的样本要作废——机器会换、浏览器会更新。 */
  readonly at: number;
}

/** 样本多久算过期（毫秒）。30 天：机器和浏览器都可能变了。 */
export const SAMPLE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/**
 * 预测慢到什么程度才开口。
 *
 * 判据是"预计耗时 ÷ 片长"：1.0 就是刚好实时。定在 1.5 而不是 1.0，因为模型只是
 * 个线性缩放、误差不小，而**假警告比没有警告更坏**（同 D24 那条配额问不到就跳过）。
 * iPhone 上 2160p 实测 0.66× 实时，也就是耗时是片长的 1.5 倍——正好落在线上，
 * 而那恰恰是这条警告要抓的那个场景。
 */
export const SLOW_FACTOR = 1.5;

/**
 * 从一次导出结果里提出样本。**跑得太短的不要**。
 *
 * 几十帧的导出里固定开销（建编码器、探编码延迟、写容器索引）占了大头，拿它去缩放
 * 一条 30 分钟的片子会离谱地偏大——同 CLAUDE.md 那条"规模不对的基准量到的是固定
 * 开销，不是被测对象"（Pixi spike 第一版在 320×320 上量出 2.11× 的教训）。
 */
export const MIN_SAMPLE_FRAMES = 120;

export function sampleFromExport(done: {
  readonly encodedFrames: number;
  readonly elapsedMs: number;
  readonly backend: CompositorBackend;
  readonly width: number;
  readonly height: number;
  readonly at: number;
}): ThroughputSample | null {
  const pixels = done.width * done.height;
  if (done.encodedFrames < MIN_SAMPLE_FRAMES) return null;
  if (!(done.elapsedMs > 0) || !(pixels > 0)) return null;
  return {
    msPerPixelFrame: done.elapsedMs / (pixels * done.encodedFrames),
    pixels,
    frames: done.encodedFrames,
    backend: done.backend,
    at: done.at,
  };
}

export interface Prediction {
  readonly seconds: number;
  /** 预计耗时是片长的几倍。1 以下是快于实时。 */
  readonly factor: number;
  /** 慢到该说一句了。判据见 `SLOW_FACTOR`。 */
  readonly slow: boolean;
  /** 依据是哪一档量出来的，写在提示里——不说依据的预测没法让人判断可不可信。 */
  readonly basisPixels: number;
}

/**
 * 按样本预测这次导出要多久。样本缺失 / 过期 / 后端不同 → 返回 null（什么都不说）。
 *
 * **后端必须一致**才复用，理由见 `ThroughputSample.backend`。
 */
export function predict(
  sample: ThroughputSample | null,
  target: {
    readonly pixels: number;
    readonly frames: number;
    readonly durationSeconds: number;
    readonly backend: CompositorBackend;
    readonly now: number;
  },
): Prediction | null {
  if (!sample) return null;
  if (sample.backend !== target.backend) return null;
  if (target.now - sample.at > SAMPLE_MAX_AGE_MS) return null;
  if (!(target.pixels > 0) || !(target.frames > 0) || !(target.durationSeconds > 0)) return null;

  const seconds = (sample.msPerPixelFrame * target.pixels * target.frames) / 1000;
  const factor = seconds / target.durationSeconds;
  return { seconds, factor, slow: factor >= SLOW_FACTOR, basisPixels: sample.pixels };
}

// ---- 存取 ----

const KEY = "kerf:throughput";

/**
 * 存在 localStorage 而不是 IndexedDB：它是**这台机器的一个数**，不是项目数据，
 * 而且导出面板渲染时要同步读得到。放进崩溃恢复那个库会让"设备指标"和"用户作品"
 * 混在一处，清项目时顺手把它删掉。
 */
export function loadSample(): ThroughputSample | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const s = parsed as Partial<ThroughputSample>;
    // 逐字段验：localStorage 里的东西没有类型，坏样本会一路流成 NaN 秒数
    if (typeof s.msPerPixelFrame !== "number" || !(s.msPerPixelFrame > 0)) return null;
    if (typeof s.pixels !== "number" || typeof s.frames !== "number") return null;
    if (typeof s.at !== "number") return null;
    if (s.backend !== "pixi" && s.backend !== "canvas2d") return null;
    return {
      msPerPixelFrame: s.msPerPixelFrame,
      pixels: s.pixels,
      frames: s.frames,
      backend: s.backend,
      at: s.at,
    };
  } catch {
    return null;
  }
}

export function saveSample(sample: ThroughputSample): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sample));
  } catch {
    // 存不上就是下次没有预测，不该影响导出
  }
}
