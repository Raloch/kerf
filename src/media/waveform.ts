/**
 * 音频波形：时间轴片段上的振幅条。缓存 + 绘制，**不含解码**。
 *
 * 解码那半边在 [waveform-extract.ts](./waveform-extract.ts)，只在真的要解时动态
 * `import()`。理由和缩略图完全一样（见 thumbnails.ts 文件头）：`drawWaveform` 在
 * 同步渲染路径上，不能 await 一个动态 import；而只要它和解码不同模块，时间轴的
 * 静态 import 就不会把 mediabunny 拖进首屏 chunk。
 *
 * ## 和缩略图的两处不同
 *
 * - **解原片，不解代理。** 代理转码把音轨整个丢掉了（`proxy.worker.ts` 的
 *   `audio: { discard: true }`），所以这里没得选。好处是**不必等代理就绪**——
 *   音频解码比视频便宜得多（只解音轨的包），导入之后就能开始。
 * - **峰值按时间取桶，不按帧。** 波形是连续量，而源片帧率和时间轴帧率可以不同；
 *   用帧号取桶会让 25fps 素材放在 30fps 时间轴上时波形整体拉伸 20%（同"不要用
 *   `toSourceFrame()` 做取帧位置"那条）。
 *
 * ## 桶的大小
 *
 * 目标 200 桶/秒（5ms 一桶），总数上限 12 万——于是 10 分钟以内是满分辨率，
 * 更长的源片桶变粗。12 万个 f32 是 480KB，一个项目十几个源片也在可接受范围；
 * 而**桶数不随缩放变化**，那样拖一下缩放滑块就要重新解码一遍整条音轨。
 * 缩小时一个像素跨多个桶 → 取最大值（这正是峰值包络该有的样子）；放大时一个桶
 * 铺多个像素 → 看起来是方块，这是波形条在极限缩放下的常态，不是 bug。
 */

/** 一条源片的峰值包络。 */
export interface Waveform {
  /** 每个桶内的绝对峰值，0..1。 */
  readonly peaks: Float32Array;
  readonly secondsPerBucket: number;
  readonly durationSeconds: number;
}

/** 目标桶密度（桶/秒）。 */
export const BUCKETS_PER_SECOND = 200;
/** 桶数上限。超过之后桶变粗，而不是把数组撑大。 */
export const MAX_BUCKETS = 120_000;

/** 按目标密度和上限算这条音轨该分多少桶。至少 1 个。 */
export function bucketCountFor(durationSeconds: number): number {
  if (!(durationSeconds > 0)) return 1;
  return Math.max(1, Math.min(MAX_BUCKETS, Math.ceil(durationSeconds * BUCKETS_PER_SECOND)));
}

/**
 * 缓存。**值可以是 `null`**，表示"试过了，这个源片没有可解的音轨"——
 * 和"还没试过"必须区分开，否则每次重绘都会再发起一次解码。
 */
const cache = new Map<string, Waveform | null>();
const inflight = new Map<string, Promise<Waveform | null>>();

// dev 里挂到全局，同 `__kerfStore` / `__kerfResidency`：控制台里
// `import('/src/media/waveform.ts')` 会因为 Vite 的 HMR URL 带参数而拿到**另一个
// 模块实例**，于是读到的是一个从没被喂过的空缓存。这个坑已经踩过三次（store、
// 常驻量计量，以及这里——第一次验波形时读到 `settled: false` 查了半天）
if (import.meta.env.DEV) {
  (globalThis as { __kerfWaveform?: unknown }).__kerfWaveform = { cache, inflight };
}

export function cachedWaveform(sourceId: string): Waveform | null {
  return cache.get(sourceId) ?? null;
}

/** 这个源片是否已经问过了（不管有没有波形）。用来避免反复重试。 */
export function waveformSettled(sourceId: string): boolean {
  return cache.has(sourceId);
}

/** 解一条源片的波形。并发调用复用同一次解码。失败与"没有音轨"都记 `null`。 */
export async function buildWaveform(sourceId: string, file: File): Promise<Waveform | null> {
  if (cache.has(sourceId)) return cache.get(sourceId) ?? null;
  const pending = inflight.get(sourceId);
  if (pending) return pending;

  const task = run(file)
    .catch(() => null)
    .then((wave) => {
      // 失败也记进缓存：否则每次重绘都会对一个解不开的文件再试一次
      cache.set(sourceId, wave);
      return wave;
    })
    .finally(() => {
      inflight.delete(sourceId);
    });
  inflight.set(sourceId, task);
  return task;
}

async function run(file: File): Promise<Waveform | null> {
  const { extractWaveform } = await import("./waveform-extract");
  return extractWaveform(file);
}

/**
 * 区间 `[fromSeconds, toSeconds)` 内的峰值。
 *
 * 抽出来单独一个函数是因为**这里是唯一会算错的地方**：桶边界取整取错半个桶，
 * 表现只是"波形整体偏了一点"，没人看得出来；而区间退化成零宽（缩放到很大时
 * 相邻两个像素落在同一个桶里）如果返回 0，波形上会出现随机的空洞。
 * 所以**至少取一个桶**。
 */
export function peakBetween(wave: Waveform, fromSeconds: number, toSeconds: number): number {
  const { peaks, secondsPerBucket } = wave;
  if (peaks.length === 0) return 0;
  const first = Math.max(0, Math.min(peaks.length - 1, Math.floor(fromSeconds / secondsPerBucket)));
  const last = Math.max(first, Math.min(peaks.length - 1, Math.ceil(toSeconds / secondsPerBucket) - 1));
  let peak = 0;
  for (let i = first; i <= last; i++) {
    const v = peaks[i]!;
    if (v > peak) peak = v;
  }
  return peak;
}

export interface WaveformDrawOptions {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 片段引用源片的起点（秒）。裁切过的片段要从这里开始取，不是从 0。 */
  readonly sourceInSeconds: number;
  /** 片段在时间轴上占多长（换算成源片时间的秒数）。 */
  readonly lengthSeconds: number;
  readonly color: string;
}

/**
 * 把波形画进片段：上下镜像的峰值条。
 *
 * 只画绝对峰值再上下镜像，不存 min/max 两条：音频波形几乎对称，而镜像画法是
 * 剪辑器里的常规长相，省一半内存。真正需要看正负不对称的场合（直流偏移）不在
 * 时间轴条这个尺度上。
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  wave: Waveform,
  options: WaveformDrawOptions,
): void {
  const { widthPx, heightPx, sourceInSeconds, lengthSeconds, color } = options;
  if (widthPx <= 0 || heightPx <= 0 || wave.peaks.length === 0) return;

  const mid = heightPx / 2;
  const columns = Math.ceil(widthPx);
  ctx.fillStyle = color;
  for (let x = 0; x < columns; x++) {
    const from = sourceInSeconds + (x / widthPx) * lengthSeconds;
    const to = sourceInSeconds + ((x + 1) / widthPx) * lengthSeconds;
    const peak = peakBetween(wave, from, to);
    // 有信号就至少画一个像素高：0.001 的底噪画成 0 高会让"有声但很轻"看着像静音
    const half = peak > 0 ? Math.max(0.5, peak * mid) : 0;
    if (half > 0) ctx.fillRect(x, mid - half, 1, half * 2);
  }
}

export interface EnvelopeDrawOptions {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 片段长度（帧）。取样按帧走——关键帧只能落在整数帧上。 */
  readonly lengthFrames: number;
  /** 纵轴满量程。音量上限是 2，所以 100% 落在中间高度。 */
  readonly maxValue: number;
  /** 片段内第 `frameOffset` 帧的音量。 */
  readonly valueAt: (frameOffset: number) => number;
  readonly color: string;
  /** 100% 参考线的颜色；不给就不画。 */
  readonly referenceColor?: string;
}

/**
 * 在波形上画音量包络。
 *
 * **调用方决定画不画**——恒等音量（没关键帧、静态值是 1）时不该有线，否则每个
 * 片段上都横一条毫无信息的线。这里只管画。
 *
 * 纵轴是 0..`maxValue` 线性，于是 100% 落在中间高度，看着会"偏低"。所以配一条
 * 100% 参考线：包络的绝对高度本身没有意义，**相对参考线的位置才有**。用非线性
 * 刻度把 100% 顶到上面去更"好看"，但那样两个音量的高度差就不再对应它们的比值。
 *
 * 取样按**像素**走而不是按关键帧走：包络在关键帧之间可以有缓动（`valueAt` 会
 * 算进去），只连关键帧就画成了直线，而画面上看到的是折线、听到的是曲线。
 */
export function drawVolumeEnvelope(
  ctx: CanvasRenderingContext2D,
  options: EnvelopeDrawOptions,
): void {
  const { widthPx, heightPx, lengthFrames, maxValue, valueAt, color, referenceColor } = options;
  if (widthPx <= 0 || heightPx <= 0 || lengthFrames <= 0 || maxValue <= 0) return;

  const y = (value: number) => heightPx - (Math.min(value, maxValue) / maxValue) * heightPx;

  if (referenceColor !== undefined) {
    ctx.strokeStyle = referenceColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    // +0.5 让 1px 的线落在像素中心上，否则会被画成两行半透明
    ctx.moveTo(0, Math.round(y(1)) + 0.5);
    ctx.lineTo(widthPx, Math.round(y(1)) + 0.5);
    ctx.stroke();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const columns = Math.max(2, Math.ceil(widthPx));
  for (let x = 0; x <= columns; x++) {
    // 最后一列取 lengthFrames - 1：第 lengthFrames 帧已经不属于这个片段
    const offset = Math.min(lengthFrames - 1, (x / columns) * lengthFrames);
    const py = y(valueAt(offset));
    if (x === 0) ctx.moveTo(0, py);
    else ctx.lineTo((x / columns) * widthPx, py);
  }
  ctx.stroke();
}

export function clearWaveformCache(): void {
  cache.clear();
}
