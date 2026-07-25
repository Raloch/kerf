/**
 * 有理数运算。
 *
 * 帧率必须用有理数表示，不能用浮点：29.97 实际是 30000/1001，
 * 用 29.97 近似做帧运算会累积误差，10 分钟视频足以让音画错位几帧。
 * 详见 CLAUDE.md 硬规则 1。
 */

export interface Rational {
  readonly num: number;
  readonly den: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/** 构造有理数，自动约简并把符号归到分子。 */
export function rational(num: number, den: number): Rational {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new Error(`有理数的分子分母必须是整数：${num}/${den}`);
  }
  if (den === 0) throw new Error("有理数分母不能为 0");
  const sign = den < 0 ? -1 : 1;
  const g = gcd(num, den) || 1;
  return { num: (sign * num) / g, den: (sign * den) / g };
}

export function toNumber(r: Rational): number {
  return r.num / r.den;
}

export function equals(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/** 比较 a 与 b，返回 -1 / 0 / 1。用交叉相乘避免浮点比较。 */
export function compare(a: Rational, b: Rational): number {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function invert(r: Rational): Rational {
  return rational(r.den, r.num);
}

/** 常见帧率。NDF 系列（23.976 / 29.97 / 59.94）分母都是 1001。 */
export const FPS = {
  film24: rational(24, 1),
  pal25: rational(25, 1),
  ntsc30: rational(30, 1),
  pal50: rational(50, 1),
  ntsc60: rational(60, 1),
  ndf23976: rational(24000, 1001),
  ndf2997: rational(30000, 1001),
  ndf5994: rational(60000, 1001),
} as const;

const KNOWN_FPS: readonly Rational[] = [
  FPS.film24,
  FPS.pal25,
  FPS.ntsc30,
  FPS.pal50,
  FPS.ntsc60,
  FPS.ndf23976,
  FPS.ndf2997,
  FPS.ndf5994,
  rational(15, 1),
  rational(48, 1),
  rational(100, 1),
  rational(120, 1),
];

/**
 * 把探测得到的近似帧率吸附到已知帧率。
 *
 * mediabunny 的 computePacketStats() 给出的是平均包速率（例如 29.970029970...），
 * 直接用这个浮点数做帧运算就回到了浮点误差的老问题，必须先吸附成有理数。
 * 吸附失败时退回 `round(approx)/1`，并由调用方决定是否提示用户。
 */
export function snapToKnownFps(approx: number, tolerance = 0.02): Rational {
  if (!Number.isFinite(approx) || approx <= 0) return FPS.ntsc30;
  let best: Rational | null = null;
  let bestDelta = Infinity;
  for (const candidate of KNOWN_FPS) {
    const delta = Math.abs(toNumber(candidate) - approx);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  if (best && bestDelta <= tolerance) return best;
  return rational(Math.max(1, Math.round(approx)), 1);
}

export function formatFps(r: Rational): string {
  const n = toNumber(r);
  // NDF 帧率按惯例显示两位小数（29.97），整数帧率不带小数
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
