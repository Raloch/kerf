/**
 * 预览出声的**排期算术**：一段混好的 PCM 该在 `AudioContext` 的哪一刻响，
 * 以及要不要再往前混一段。纯函数，好让这两件事能单测。
 *
 * 会写错的就是这两件：
 *
 * - **段与段之间不能有缝也不能重叠。** 缝是一声咔哒，重叠是一段变响——两者都
 *   不抛错，而且在几秒的素材上几乎听不出来。判据必须是"第 k+1 段的起点恰好等于
 *   第 k 段的终点"，逐样本相等，不能用"差得够小"（同混音分段那条"接缝错开一个
 *   样本 = 一声轻微咔哒，而 RMS 包络断言对它完全免疫"）。
 * - **预混多少才够。** 混得太少会断音，太多就把 D22 好不容易砍掉的峰值又堆回来。
 *
 * ## 为什么用 `startSample` 而不是"上一段结束的时刻"
 *
 * 每段自带它在整条 PCM 里的绝对起始样本（`MixChunk.startSample`），所以每段的
 * `when` 都能**独立**从原点算出来。累加"上一段多长"会让浮点误差逐段积累，而
 * 一条 30 分钟的时间轴有上百段。这和"帧运算一律用整数帧号"是同一条纪律：
 * 能从原点算的就不要递推。
 */

/** 预混提前量（秒）。够盖住一次混音的耗时，又不至于把内存堆回去。 */
export const LOOKAHEAD_SECONDS = 4;

/**
 * 音画偏离多少就把声音重新对一次（秒）。
 *
 * 预览的主时钟是 `Preview.tsx` 里那个 rAF（墙上时间 × 帧率），video 元素靠
 * 漂移纠正跟上它；声音同样是被动跟随的一方，所以做法一致。80ms 的来源：
 * 音画不同步在 100ms 上下开始明显可感，而重新对齐要重启混音、代价不小，
 * 所以定在刚刚可感之前而不是越小越好——频繁重启比一点偏移更难听。
 */
export const RESYNC_TOLERANCE_SECONDS = 0.08;

/**
 * 第 `index` 段（起始样本 `startSample`）该在 `AudioContext` 的哪一刻开始播。
 *
 * `originTime` 是"整条 PCM 的第 0 个样本对应的 AudioContext 时刻"。它可以是过去
 * 的时刻——那时前面几段已经错过了，调用方据此跳过（见 `shouldSkip`）。
 */
export function chunkStartTime(
  originTime: number,
  startSample: number,
  sampleRate: number,
): number {
  return originTime + startSample / sampleRate;
}

/**
 * 这一段已经完全过去了吗（连尾巴都在 `now` 之前）。
 *
 * 部分过去的段**不能跳过**：那会在声音里留一个洞。Web Audio 的
 * `start(when, offset)` 能从中间接上，所以调用方应当算出 `offset` 而不是丢掉整段。
 */
export function shouldSkip(
  originTime: number,
  startSample: number,
  frameCount: number,
  sampleRate: number,
  now: number,
): boolean {
  return chunkStartTime(originTime, startSample + frameCount, sampleRate) <= now;
}

/**
 * 一段的播放偏移：`now` 已经越过这一段起点时，要从段内第几秒开始播。
 *
 * 只在"刚开播、第一段的起点已经略微过去"时非零。返回 0 表示整段都还没到。
 */
export function chunkOffsetSeconds(
  originTime: number,
  startSample: number,
  sampleRate: number,
  now: number,
): number {
  return Math.max(0, now - chunkStartTime(originTime, startSample, sampleRate));
}

/**
 * 还要不要再拉一段来混。
 *
 * `scheduledUntilSample` 是已经排到的样本位置（不含）；`nowSample` 是此刻播到哪。
 * 两者都用样本而不是秒——它们来自同一个 `sampleRate`，用整数比较不会有边界抖动。
 */
export function needsMoreAudio(
  scheduledUntilSample: number,
  nowSample: number,
  sampleRate: number,
): boolean {
  return scheduledUntilSample - nowSample < LOOKAHEAD_SECONDS * sampleRate;
}

/**
 * 声音跑偏了没有。
 *
 * `expectedSeconds` 是主时钟（播放头）说的位置，`audioSeconds` 是声音实际播到的
 * 位置，都相对导出区间的起点。超过容差就该重新对齐。
 */
export function driftedTooFar(expectedSeconds: number, audioSeconds: number): boolean {
  return Math.abs(expectedSeconds - audioSeconds) > RESYNC_TOLERANCE_SECONDS;
}

/**
 * 相邻两段接得上吗。**只给单测和自检用**，产品代码不需要它——
 * 但"接缝对不对"正是这一层唯一会静默出错的地方，所以判据要写成一个可断言的函数。
 */
export function segmentsContiguous(
  chunks: readonly { readonly startSample: number; readonly frameCount: number }[],
): boolean {
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1]!;
    const here = chunks[i]!;
    // 逐样本相等，不留容差：差一个样本就是一声咔哒，而它听起来像"素材本身有杂音"
    if (prev.startSample + prev.frameCount !== here.startSample) return false;
  }
  return true;
}
