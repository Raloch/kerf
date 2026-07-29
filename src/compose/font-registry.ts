/**
 * 自定义字体的注册表：把 `FontSource` 的字节变成**本上下文**能用的 `FontFace`。
 *
 * ## 为什么必须两个上下文各注册一遍
 *
 * 文字栅格化在预览（主线程）和导出（Worker）里各跑一次（见 `text-raster.ts` 文件头）。
 * `FontFaceSet` 是**每个上下文一份**的：主线程 `document.fonts.add()` 不会让 Worker
 * 看见那个字体，而没看见时 `ctx.font = '40px "KerfFont-1"'` 会**静默回退**到兜底字体
 * ——预览里是用户选的字，成片里不是，两边都不抛错。这正是硬规则 2 要消灭的形态。
 *
 * ## 纪律：先注册，再进 EDL
 *
 * 导入时主线程先 `await face.load()` 成功才把字体 `addFont()` 进时间轴；崩溃恢复时
 * 在 `loadProject()` 里读完字节就注册，注册不成的当"拿不回来"（于是片段的字体退回
 * 兜底并报给用户）；导出在逐帧循环之前注册。于是"**EDL 里有的字体，本上下文一定
 * 注册过**"是结构性的，`rasterizeText` 那道断言只会在有人新开一条渲染路径时开火
 * ——那时它抛错，而不是静默换一种字。
 *
 * ## 为什么判据不是 `FontFaceSet.check()`
 *
 * 实测（Chrome 150 / Safari 26.5.2，主线程与 Worker 四种组合）：`check()` 对一个
 * **根本不存在**的族名同样返回 `true`——它只回答"匹配到的 face 有没有在加载中"，
 * 匹配不到任何 face 时按"系统字体兜着"算成 true。拿它当"我的字体生效了没有"就是
 * 把一个恒为真的量当读数（同 CLAUDE.md 那条"心跳固定带 audio，光靠它定位不到"）。
 * 唯一有效的判据是**量宽度**（`fontEffective`）。
 *
 * 但量宽度**只当诊断，不当闸门**：用户导入一个与兜底字体度量相同的字体时它会判成
 * "没生效"，而那种情形下两边输出本来就一样——把它当闸门就会挡掉一个本来能用的字体。
 * 真正的闸门是三件不会误判的事：这个上下文有没有 `FontFaceSet`、字节是不是字体
 * （`load()` 会抛）、要用的族名有没有注册过。
 */

import type { FontFamily, FontSource } from "../edl/types";

/**
 * 我们生成的族名的前缀。
 *
 * 存在的理由是**分得清"这个族名要不要我们注册"**：`"PingFang SC"` 之类的系统族名
 * 交给浏览器自己解析，而 `KerfFont-…` 没注册过就必须抛错而不是静默回退。
 */
export const FONT_FAMILY_PREFIX = "KerfFont-";

/** 这个族名是不是我们管的（需要注册才能用）。 */
export function isManagedFamily(family: string): boolean {
  return family.startsWith(FONT_FAMILY_PREFIX);
}

/** 同一毫秒里连着导入两个字体也要拿到不同族名，所以除了时间戳还带一个序号。 */
let familyCounter = 0;

/**
 * 生成一个新族名。`seed` 由调用方给（一般是 `Date.now()`）——同 LUT 的 id 生成，
 * 取当前时间这件事留在界面层，这里只负责拼。
 */
export function newFontFamily(seed: number): FontFamily {
  familyCounter += 1;
  return `${FONT_FAMILY_PREFIX}${seed}-${familyCounter}`;
}

/** 本上下文的 `FontFaceSet`：主线程是 `document.fonts`，Worker 是 `self.fonts`。 */
function fontFaceSet(): FontFaceSet | null {
  const scope = self as unknown as { fonts?: FontFaceSet };
  if (typeof document !== "undefined" && document.fonts) return document.fonts;
  return scope.fonts ?? null;
}

/** 这个上下文能不能注册自定义字体。实测 Chrome 150 / Safari 26.5.2 的 Worker 都能。 */
export function canRegisterFonts(): boolean {
  return typeof FontFace !== "undefined" && fontFaceSet() !== null;
}

const registered = new Map<FontFamily, FontFace>();

/** 本上下文注册过这个族名没有。`rasterizeText` 的断言读的就是它。 */
export function isFontRegistered(family: FontFamily): boolean {
  return registered.has(family);
}

/**
 * 注册一个字体。已经注册过就直接返回（导出每次开工都会把整份名单过一遍）。
 *
 * 抛错的三种情形都是**真的用不了**，不是误判：这个上下文没有 `FontFaceSet`、
 * 字节是空的、字节不是字体（`load()` 抛）。静默跳过任何一种就等于回到"预览一种字、
 * 成片另一种字"。
 */
export async function registerFont(font: FontSource): Promise<void> {
  if (registered.has(font.family)) return;
  const set = fontFaceSet();
  if (typeof FontFace === "undefined" || !set) {
    throw new Error(`这个上下文不支持自定义字体（没有 FontFaceSet），装不上「${font.name}」`);
  }
  if (font.data.byteLength === 0) {
    throw new Error(`字体「${font.name}」的字节是空的，装不上`);
  }
  const face = new FontFace(font.family, font.data);
  await face.load();
  set.add(face);
  registered.set(font.family, face);
}

/** 把一份名单全注册上。串行是刻意的：一个失败就抛，错误里带着是哪个字体。 */
export async function registerFonts(fonts: readonly FontSource[] | undefined): Promise<void> {
  for (const font of fonts ?? []) await registerFont(font);
}

/** 测试之间要隔离时清空。**不从 `FontFaceSet` 里摘**——那是浏览器全局状态。 */
export function clearFontRegistry(): void {
  registered.clear();
}

/** 度量差异明显的一串字：宽窄字母混排，比中文更容易在不同字体上量出不同宽度。 */
const METRIC_SAMPLE = "iiiiWWWW Hamburgefonstiv";
/** 一个一定不存在的族名，用来量"兜底字体"的宽度。 */
const ABSENT_FAMILY = "__kerf_absent_family__";

/**
 * 这个族名在本上下文**真的生效**了没有。`null` = 量不了（没有 `OffscreenCanvas`）。
 *
 * 只当诊断用，理由见文件头。自检和真机报告靠它把"注册成功"和"渲染时真用上了"
 * 分成两个读数——前者是 API 说的，后者是量出来的。
 */
export function fontEffective(family: FontFamily): boolean | null {
  if (typeof OffscreenCanvas === "undefined") return null;
  const ctx = new OffscreenCanvas(8, 8).getContext("2d");
  if (!ctx) return null;
  const widthOf = (name: string): number => {
    ctx.font = `600 40px "${name}", sans-serif`;
    return ctx.measureText(METRIC_SAMPLE).width;
  };
  return widthOf(family) !== widthOf(ABSENT_FAMILY);
}

// 模块级单例都要在 dev 挂全局，同 `__kerfStore` / `__kerfWaveform`（这个坑踩过三次）。
// 这里尤其需要：注册表**每个上下文一份**，而"Worker 里到底装上了没有"只能在那边读。
if (import.meta.env.DEV) {
  (globalThis as { __kerfFonts?: unknown }).__kerfFonts = {
    registered,
    isFontRegistered,
    fontEffective,
    canRegisterFonts,
  };
}
