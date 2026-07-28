/**
 * 把一次导出的混音切成若干段,好让 PCM 边混边喂编码器,而不是整条攒在内存里。
 *
 * ## 为什么必须分段
 *
 * 整条混完的峰值实测 **989MB / 30 分钟**(桌面,优化前 1648MB),而且**全在主线程**
 * ——`OfflineAudioContext` 在 Worker 里不可用(硬规则 6)。这个数随片长线性涨,
 * 一小时约 2GB,移动端更早。它不是"最终 PCM 有多大"那一份而已:所有素材的解码
 * 结果要**同时**挂在音频图上等渲染,渲染目标是完整的另一整份。分段之后这两项
 * 都被段长限住,于是峰值与片长无关——那才是"能导一小时"的证明。
 *
 * ## 这个文件只做算术,不碰音频图
 *
 * 同 `mix-plan.ts` 那条理由:`OfflineAudioContext` 在 node 里造不出来,分段的
 * 边界算术要是混在接线里,就只能靠端到端自检去撞,撞到了还分不清是切错了还是
 * 接错了。而这里恰恰是最容易错的地方——错一个样本就是每段接缝处一声咔哒。
 *
 * ## 接缝为什么能做到样本精确:对齐量
 *
 * 段与段各自渲染一个 `OfflineAudioContext`,同一个片段会在相邻两段里各被排一次,
 * 起播时刻分别是 `绝对位置 − 段起点`。Web Audio 把 `start(when)` 落到**最近的
 * 采样点**上,所以只要两段的 `when` 相差**整数个输出样本**,两边就round到同一个
 * 相位,接缝逐样本连续;差一个非整数,两边各自取整,接缝就可能错开一个样本——
 * 20.8µs 的台阶,在连续波形上是一声轻微的咔哒,而 RMS 包络断言完全看不见。
 *
 * 一帧对应的输出样本数是 `sampleRate × den / num`,通常**不是整数**
 * (30000/1001 帧率下是 1601.6)。所以段边界不能取任意帧号,必须取
 * **`alignFrames` 的整数倍**——满足 `k × sampleRate × den / num` 为整数的最小 k,
 * 即 `num / gcd(num, sampleRate × den)`。29.97 下是 5,25 / 30 / 23.976 下都是 1。
 *
 * ## 两侧的 pad:重采样器要预热
 *
 * 对齐只解决"相位一致",解决不了**重采样瞬态**:44.1k 素材放进 48k 上下文要过
 * 一个多相滤波器,从中途起播时它的历史是零填充的,头几个样本是错的。所以每段
 * 实际渲染的区间往两侧各撑开 `padFrames`,渲染完只取中间那截——被丢掉的 pad
 * 正好把瞬态吃掉。pad 同样必须是 `alignFrames` 的整数倍,否则前面那条相位一致
 * 就断了。
 *
 * 素材本来就是 48k 时没有重采样、也就没有瞬态,但 pad 照撑不误:按素材采样率
 * 分岔会让"接缝有没有咔哒"取决于用户导入了什么文件,而那种 bug 无法复现。
 */

import { gcd, type Rational } from "../time/rational";
import type { RenderRange } from "../edl/types";

/**
 * 每段的目标时长。
 *
 * **这个数在两根都有上限的轴之间取平衡,不是"越小越好"。** 段越短,同时活着的
 * PCM 越少;但段数 = 一次导出要建多少个 `OfflineAudioContext`,那同样是有限资源。
 *
 * **试过 30 秒,没用,已改回。** 当时的推理是:Safari 上 10 秒/段导 30 分钟(180 段)
 * 会死等,而混音峰值只有 5.7MB,说明上下文那根轴花得太凶——拉到 30 秒能把 30 分钟
 * 压到 60 段。实测**照样死等**,而 10 秒/段的 10 分钟档同样是 60 段却能过。
 * **同样的上下文数一个过一个不过,所以段数不是那个变量,30 分钟这个长度本身才是。**
 * 那次改动的论证被自己的数据证伪，于是退回 10 秒——所有自检证据都是在这个值上取的。
 *
 * 真正的线索在别处：那次死等里 `mixdown.ts` 的渲染看门狗**没有触发**（它 60 秒
 * 没返回就抛，而那条错误链会一路 POST 出一份报告，18 分钟一份都没有），所以卡的
 * 地方不在混音，在 Worker 侧。详见 PLAN.md §8 风险 1。
 */
export const SEGMENT_TARGET_SECONDS = 10;

/**
 * 每段两侧撑开的时长,给重采样器预热用。
 *
 * 50ms 远大于任何实际重采样滤波器的核宽(通常几十个样本),取这么大是因为
 * 代价极低——pad 只影响解码和渲染的边角,不进最终 PCM。
 */
export const SEGMENT_PAD_SECONDS = 0.05;

/** 一段混音:渲染哪一截、取其中哪一段、落在整条 PCM 的什么位置。 */
export interface MixSegment {
  readonly index: number;
  /** 这一段**负责产出**的时间轴区间,左闭右开。段与段首尾相接,不重叠。 */
  readonly startFrame: number;
  readonly endFrame: number;
  /** **实际渲染**的区间:上面那截往两侧各撑 `padFrames`,已按导出区间夹紧。 */
  readonly renderInFrame: number;
  readonly renderOutFrame: number;
  /** 这一段在整条输出 PCM 里的绝对样本位置,左闭右开。 */
  readonly outStartSample: number;
  readonly outEndSample: number;
  /** 从渲染结果里取样本的起点 = 左侧 pad 的长度(样本)。首段为 0。 */
  readonly takeOffsetSamples: number;
  /** 要取多少样本 = `outEndSample − outStartSample`。 */
  readonly takeLengthSamples: number;
  /** 渲染上下文的长度(样本),即整个 pad 过的区间。 */
  readonly renderLengthSamples: number;
}

export interface MixSegmentPlan {
  readonly sampleRate: number;
  /** 整条输出 PCM 的样本数。等于各段 `takeLengthSamples` 之和。 */
  readonly totalSamples: number;
  /** 段边界与 pad 都必须是它的整数倍,见文件头"对齐量"。 */
  readonly alignFrames: number;
  readonly padFrames: number;
  readonly segments: readonly MixSegment[];
}

/**
 * 段边界的对齐量:多少帧才对应**整数个**输出样本。
 *
 * `k × sampleRate × den / num ∈ ℤ` 的最小正整数 k。取 `num / gcd(num, sampleRate × den)`。
 */
export function sampleAlignFrames(fps: Rational, sampleRate: number): number {
  return fps.num / gcd(fps.num, sampleRate * fps.den);
}

/**
 * 帧数 → 输出样本数,**用整数算术**,不经过秒也不经过微秒。
 *
 * 走浮点秒会在长片上累积误差(硬规则 1);走微秒会被 `frameToMicros` 的取整
 * 咬掉,而段边界差一个样本就是一声咔哒。`frames × sampleRate × den` 在
 * `MAX_SAFE_FRAME`(8e6)× 48000 × 1001 ≈ 3.8e14 上仍然在 2^53 以内。
 *
 * `frames` 是 `alignFrames` 的整数倍时结果精确;否则四舍五入(只用于整条的总长)。
 */
export function framesToSamples(frames: number, fps: Rational, sampleRate: number): number {
  return Math.round((frames * sampleRate * fps.den) / fps.num);
}

/** 往上取到 `align` 的整数倍,至少一份。 */
function ceilToMultiple(value: number, align: number): number {
  return Math.max(align, Math.ceil(value / align) * align);
}

/**
 * 把导出区间切成若干段。区间为空时返回空段列表(`totalSamples` 为 0)。
 *
 * 段长与 pad 都吸附到 `alignFrames` 的整数倍。末段可以短于段长,也可以短于 pad
 * ——pad 在两端会被导出区间夹掉,那是对的:整条的第一个样本和最后一个样本不存在
 * "外面还有内容"这回事。
 */
export function planMixSegments(
  range: RenderRange,
  fps: Rational,
  sampleRate: number,
  options?: { readonly targetSeconds?: number; readonly padSeconds?: number },
): MixSegmentPlan {
  const alignFrames = sampleAlignFrames(fps, sampleRate);
  const fpsValue = fps.num / fps.den;
  const targetSeconds = options?.targetSeconds ?? SEGMENT_TARGET_SECONDS;
  const padSeconds = options?.padSeconds ?? SEGMENT_PAD_SECONDS;
  const segFrames = ceilToMultiple(targetSeconds * fpsValue, alignFrames);
  const padFrames = ceilToMultiple(padSeconds * fpsValue, alignFrames);

  const totalFrames = range.outFrame - range.inFrame;
  if (totalFrames <= 0) {
    return { sampleRate, totalSamples: 0, alignFrames, padFrames, segments: [] };
  }

  const totalSamples = Math.max(1, framesToSamples(totalFrames, fps, sampleRate));
  const segments: MixSegment[] = [];

  for (let offset = 0, index = 0; offset < totalFrames; offset += segFrames, index++) {
    const startFrame = range.inFrame + offset;
    const endFrame = Math.min(range.outFrame, startFrame + segFrames);
    const renderInFrame = Math.max(range.inFrame, startFrame - padFrames);
    const renderOutFrame = Math.min(range.outFrame, endFrame + padFrames);

    const outStartSample = framesToSamples(offset, fps, sampleRate);
    // 末段的右端点用 totalSamples,而不是再算一次——那样在非对齐的总长上会差
    // 一个样本,表现为成片末尾多/少一个样本,且只在某些帧率上出现
    const outEndSample =
      endFrame === range.outFrame
        ? totalSamples
        : framesToSamples(endFrame - range.inFrame, fps, sampleRate);
    const takeOffsetSamples = framesToSamples(startFrame - renderInFrame, fps, sampleRate);
    const renderLengthSamples = Math.max(
      1,
      framesToSamples(renderOutFrame - renderInFrame, fps, sampleRate),
    );

    segments.push({
      index,
      startFrame,
      endFrame,
      renderInFrame,
      renderOutFrame,
      outStartSample,
      outEndSample,
      takeOffsetSamples,
      // 夹一道:末段的总长走的是 round 而不是精确整除,理论上可能比渲染出来的
      // 长一个样本。宁可少取一个样本(补零),也不要越界读
      takeLengthSamples: Math.min(
        outEndSample - outStartSample,
        renderLengthSamples - takeOffsetSamples,
      ),
      renderLengthSamples,
    });
  }

  return { sampleRate, totalSamples, alignFrames, padFrames, segments };
}
