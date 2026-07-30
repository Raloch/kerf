/**
 * J / K / L 变速播放的**判据**：按一下键之后倍率变成多少、这一档要不要出声、
 * video 元素该以多快走。纯函数，只认数字，和 rAF、AudioContext、DOM 都无关。
 *
 * 抽出来的理由和 `audio-schedule.ts` 一样：会写错的是**这几条算术和它们的边界**
 * （梯子两端夹紧、跨过零、倍率与片段速度相乘、倒放要退化成什么），而它们长在
 * 一个 rAF 循环 + 一个音频引擎中间，在浏览器里逐档手点是唯一的验法。
 *
 * ## 倍率是一个有符号数，0 就是暂停
 *
 * 不设 `playing: boolean` + `rate: number` 两个状态：那样"playing 为真而 rate 是 0"
 * 和"playing 为假而 rate 是 4"两种自相矛盾的组合都构造得出来，而它们的表现分别是
 * "播放中画面纹丝不动"和"暂停了播放头还在跑"。一个有符号数把这两种状态整个消掉。
 *
 * ## 梯子上没有 0，暂停只由 K 给
 *
 * L 往右一格、J 往左一格，两端夹紧；0 不在梯子上，所以 `LADDER.indexOf(0)` 为 -1，
 * 于是从暂停按 L 得到 +1、按 J 得到 -1（见 `shuttleStep` 里那一行）。这不是巧合
 * 而是刻意的：暂停在梯子上会让"1× 正放按一下 J"落到暂停而不是倒放，而那一下
 * 用户要的是往回看——K 才是停。
 */

/**
 * 有符号倍率梯子。绝对值那四档（1 / 2 / 4 / 8）是 NLE 的通行约定，
 * 用户的手指记的是"按几下 L"，不是具体倍数。
 *
 * 上限 8 而不是 16：**再快就已经不是"看内容"而是"找位置"**，而找位置有更好的工具
 * （拖播放头、缩放时间轴）。而且倒放那一档是逐帧 seek（见 `elementPlaybackRate`），
 * 8× 时一帧要跨 8 帧素材，再高就只是在丢帧。
 */
const LADDER = [-8, -4, -2, -1, 1, 2, 4, 8] as const;

/** 梯子上的绝对倍率，给界面和测试引用（不含方向）。 */
export const SHUTTLE_RATES = [1, 2, 4, 8] as const;

/** 倍率上限的绝对值。 */
export const MAX_SHUTTLE_RATE = 8;

/**
 * 按一下 L（`direction` 为 1）或 J（`direction` 为 -1）之后的倍率。
 *
 * **对向的那个键是"退一档"，不是"立刻反向"。** 4× 正放按 J 得到 2× 正放，
 * 一路退过 1× 才到 -1×。这是 Premiere / FCP / Avid / Resolve 四家一致的行为，
 * 也是唯一能"减速"的办法——若 J 直接跳到 -1×，从 8× 慢下来就无路可走。
 *
 * 不在梯子上的值（0，或快照/脏数据给的怪值）一律当"从暂停起步"，返回 ±1。
 */
export function shuttleStep(current: number, direction: 1 | -1): number {
  const index = LADDER.indexOf(current as (typeof LADDER)[number]);
  if (index < 0) return direction;
  const next = Math.min(LADDER.length - 1, Math.max(0, index + direction));
  return LADDER[next] as number;
}

/**
 * 这一档是不是"常速正放"。
 *
 * **声音要不要出、界面要不要报，是同一个判据的两面**，所以只有这一个函数：
 * 声音只在常速正放时出现（理由见 `Preview.tsx` 那段注释和 D49），而界面上要报出的
 * 恰恰是"不是常速正放"那些档。写成两个谓词就会漂——漂了的表现是**静音了但界面
 * 没说**，也就是硬规则 10 那种静默降级。
 */
export function isNormalPlayback(rate: number): boolean {
  return rate === 1;
}

/** 这一档要不要在界面上报出来：在放、而且不是常速正放。 */
export function isShuttling(rate: number): boolean {
  return rate !== 0 && !isNormalPlayback(rate);
}

/** 倍率读数，如「快进 4×」「倒放 2×」。常速正放和暂停都不该问这个函数。 */
export function shuttleLabel(rate: number): string {
  return `${rate < 0 ? "倒放" : "快进"} ${Math.abs(rate)}×`;
}

/**
 * video 元素的 `playbackRate` 上限。
 *
 * 浏览器对它有支持范围（Blink 是 [0.0625, 16]），超出会抛。我们自己最大只到
 * 8× 倍率 × 8× 片段速度 = 64，所以这个夹紧只在那个荒唐角落里生效，代价是
 * 那时元素跟不上、退回逐帧 seek（漂移纠正会接手），而不是整条播放循环抛异常。
 */
const MAX_ELEMENT_RATE = 16;

/**
 * 这个 video 元素每秒该往前走多少**源片**秒。
 *
 * 三个因子相乘：变速倍率 × 片段速度（D39）× 定格与否（D48）。三者少一个都不报错：
 *
 * - 漏掉倍率：8× 快进时元素仍以 1× 走，漂移纠正每帧把它拽一次，画面变成一顿一顿的。
 * - 漏掉片段速度：2× 的片段在预览里每 3 个源片帧被拽回一次（这条**在做变速那一轮
 *   就存在**，靠漂移纠正兜着，只是没人认出来）。
 * - 漏掉定格：定格片段的元素照常往前走，而期望位置恒定，于是**播放中的定格片段是
 *   "走 3 帧、跳回来、再走 3 帧"**——它在暂停态和成片里都对，只有播放中不对，
 *   而那正是用户最先看的地方（D48 欠的债，这一刀补上）。
 *
 * **负数取 0**：没有任何浏览器实现负的 `playbackRate`，所以倒放只能靠逐帧 seek。
 * 返回 0 让元素停住，剩下的交给 `renderLive` 那条"元素自己不走时容差没有意义"的分支
 * ——两件事必须配对，只做一半的表现是倒放时画面每 3 帧才动一下（10fps 的顿）。
 */
export function elementPlaybackRate(
  shuttleRate: number,
  sourceSpeed: number,
  frozen: boolean,
): number {
  if (frozen) return 0;
  return Math.min(MAX_ELEMENT_RATE, Math.max(0, shuttleRate * sourceSpeed));
}
