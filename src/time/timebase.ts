/**
 * 时间基：帧号 ↔ 微秒 ↔ 时间码。
 *
 * 项目内部只有两种时间表示：
 *   1. **帧号**（整数）—— 时间轴、EDL、UI 一律用帧号
 *   2. **微秒**（整数）—— 与 WebCodecs 交互时用
 *
 * 浮点秒只允许出现在一个地方：调用 mediabunny 的 API 时（它的接口以秒为单位）。
 * 那次转换是一次性除法，不参与累加，因此不会累积误差。
 * 禁止用浮点秒做帧运算，详见 CLAUDE.md 硬规则 1。
 */

import { type Rational, toNumber } from "./rational";

export const MICROS_PER_SECOND = 1_000_000;

/**
 * 帧对齐容差（秒）。
 *
 * 帧号换算成秒时做微秒取整，最大偏差 0.5μs；解码器给出的 sample.timestamp
 * 却是未取整的真值。两者直接比较会把"恰好等于"判成"还没到"，导致每个
 * trim 区间少推进一帧——实测导出源片 90–210 帧时，末帧会停在 frame 208。
 *
 * 取 1μs：远大于取整误差（0.5μs），又远小于任何真实帧长（120fps 也有 8.3ms），
 * 既能吸收舍入又不会误吞下一帧。凡是拿"算出来的秒"和"解码器给的秒"比较，
 * 都要带上这个容差。
 */
export const FRAME_ALIGN_EPSILON_SECONDS = 1e-6;

/**
 * 帧号安全上限。
 *
 * frameToMicros 内部会算 frame * den * 1e6，NDF 帧率 den = 1001，
 * 要保证乘积不超过 Number.MAX_SAFE_INTEGER (2^53-1 ≈ 9.007e15)：
 *   frame ≤ 9.007e15 / (1001 * 1e6) ≈ 8.99e6 帧 ≈ 83 小时 @29.97fps
 * 远超任何真实剪辑场景，但仍然显式校验，避免静默出错。
 */
export const MAX_SAFE_FRAME = 8_000_000;

function assertFrame(frame: number): void {
  if (!Number.isFinite(frame)) throw new Error(`帧号必须是有限数：${frame}`);
  if (Math.abs(frame) > MAX_SAFE_FRAME) {
    throw new Error(`帧号 ${frame} 超出安全范围（±${MAX_SAFE_FRAME}），会丢失整数精度`);
  }
}

/** 帧号 → 微秒（整数）。frame / fps 秒 = frame * den * 1e6 / num 微秒。 */
export function frameToMicros(frame: number, fps: Rational): number {
  assertFrame(frame);
  return Math.round((frame * fps.den * MICROS_PER_SECOND) / fps.num);
}

/**
 * 帧号 → 微秒，再乘一个有理数倍率，**全程只取整一次**（变速用，D39）。
 *
 * 不能写成 `Math.round(frameToMicros(f, fps) * num / den)`：那是取整两次，而两次
 * 取整的误差会**逐帧交替**。实测 30fps 下 1.5×，相邻两帧的源片位置差在
 * 50000µs 和 50001µs 之间跳（因为 `frameToMicros(1)=33333` 已经丢了 1/3 微秒，
 * 再乘 1.5 把它放大成 0.5 而 `round` 把 0.5 推上去）。落在画面上看不出来
 * （一帧有 33000µs 宽），落在音频上是每帧一个亚微秒相位抖动——同 `exactSeconds`
 * 那条"微秒取整在 48kHz 上是 0.048 个样本"，那次实测差了 5.22e-4。
 *
 * **乘法顺序不能改。** 先把三个小因子乘起来再乘 1e6：8_000_000 帧 × 1001 ×
 * 8（速度上限）≈ 6.4e10，再 × 1e6 就爆过 2^53 了，所以分子自己也要判一次安全范围
 * ——溢出的表现是位置突然错几秒，而 `Math.round` 不会抱怨。
 */
export function frameToMicrosScaled(frame: number, fps: Rational, scale: Rational): number {
  assertFrame(frame);
  const num = frame * fps.den * scale.num;
  const den = fps.num * scale.den;
  if (Math.abs(num) > Number.MAX_SAFE_INTEGER / MICROS_PER_SECOND) {
    throw new Error(`帧号 ${frame} 在 ${scale.num}/${scale.den} 倍速下超出安全范围`);
  }
  return Math.round((num * MICROS_PER_SECOND) / den);
}

/** 微秒 → 帧号（就近取整）。 */
export function microsToFrame(micros: number, fps: Rational): number {
  if (!Number.isFinite(micros)) throw new Error(`微秒必须是有限数：${micros}`);
  return Math.round((micros * fps.num) / (fps.den * MICROS_PER_SECOND));
}

/**
 * 帧号 → 秒（浮点）。
 *
 * **仅用于调用以秒为单位的外部 API**（mediabunny 的 sink/source）。
 * 不要用返回值做累加或帧对齐运算。
 */
export function frameToSeconds(frame: number, fps: Rational): number {
  return frameToMicros(frame, fps) / MICROS_PER_SECOND;
}

/** 秒（浮点，通常来自外部 API）→ 帧号。 */
export function secondsToFrame(seconds: number, fps: Rational): number {
  return microsToFrame(Math.round(seconds * MICROS_PER_SECOND), fps);
}

/** 一帧的时长（微秒）。注意：这个值有舍入，不要用它乘以帧数去推算总时长。 */
export function frameDurationMicros(fps: Rational): number {
  return Math.round((fps.den * MICROS_PER_SECOND) / fps.num);
}

/** n 帧的总时长（微秒）。用 frameToMicros 直接算，避免"单帧时长 × 帧数"的累积舍入。 */
export function framesDurationMicros(frames: number, fps: Rational): number {
  return frameToMicros(frames, fps);
}

/** 秒数 → 帧数（向上取整，用于按时长分配帧预算）。 */
export function secondsToFrameCount(seconds: number, fps: Rational): number {
  return Math.ceil((seconds * fps.num) / fps.den);
}

/**
 * 帧号 → 时间码，非丢帧（NDF）计数。
 *
 * NDF 用 round(fps) 作为每秒帧数计数（29.97 按 30 计），所以时间码会比真实
 * 墙上时间走得慢：29.97fps 下 1 小时素材的结尾时间码约为 00:59:56:12。
 * 这是行业惯例，丢帧时间码（DF）留到需要与广播对接时再实现。
 */
export function framesToTimecode(frame: number, fps: Rational): string {
  assertFrame(frame);
  const base = Math.round(toNumber(fps));
  const sign = frame < 0 ? "-" : "";
  const abs = Math.abs(Math.round(frame));
  const ff = abs % base;
  const totalSeconds = Math.floor(abs / base);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

/** 时间码 → 帧号（NDF）。接受 `HH:MM:SS:FF`，也接受 `MM:SS:FF`。 */
export function timecodeToFrames(timecode: string, fps: Rational): number {
  const negative = timecode.trimStart().startsWith("-");
  const parts = timecode.replace("-", "").trim().split(":").map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`时间码格式非法：${timecode}`);
  }
  // 用显式索引取值：noUncheckedIndexedAccess 下数组解构会带上 undefined
  const at = (i: number): number => parts[i] ?? 0;
  let hh = 0;
  let mm = 0;
  let ss = 0;
  let ff = 0;
  if (parts.length === 4) {
    hh = at(0);
    mm = at(1);
    ss = at(2);
    ff = at(3);
  } else if (parts.length === 3) {
    mm = at(0);
    ss = at(1);
    ff = at(2);
  } else {
    throw new Error(`时间码格式非法：${timecode}`);
  }

  const base = Math.round(toNumber(fps));
  if (ff >= base) throw new Error(`时间码 ${timecode} 的帧位超出帧率上限 ${base}`);
  const frames = ((hh * 60 + mm) * 60 + ss) * base + ff;
  return negative ? -frames : frames;
}

/** 给 UI 用的紧凑时长文案，例如 `1:20.5`。 */
export function formatDuration(frames: number, fps: Rational): string {
  const micros = frameToMicros(frames, fps);
  const totalSeconds = micros / MICROS_PER_SECOND;
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds - mm * 60;
  return `${mm}:${ss.toFixed(1).padStart(4, "0")}`;
}
