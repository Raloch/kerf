/**
 * 文字栅格化：把一段文字画成一张图，交给合成层当普通图层用。
 *
 * ## 为什么栅格化，而不是给两个后端各写一套文字渲染
 *
 * 合成层有两个后端（Canvas2D / PixiJS）。如果各自画文字，就等于在硬规则 2 上
 * 开一个新入口——两条渲染路径的字形、断行、描边宽度都可能不一样，而这类差异
 * **不会报错**，只会让成片的字幕比预览里粗一点、断行位置差一个字。
 * 这里只栅格化一次，两个后端都当 `{ kind: "image" }` 图层贴上去，
 * 字形一致就成了结构上的保证，而不是靠两边小心对齐。
 * （Pixi v8 的 `Text` 内部也是先用 Canvas2D 画成纹理，做法相同，但我们要的是
 * "预览和导出用同一份栅格结果"，所以自己来。）
 *
 * ## 为什么画在**输出尺寸**的画布上而不是紧贴文字的小画布上
 *
 * 合成层给每个图层的默认摆位是 `containRect()`——等比缩放**铺满**输出。
 * 那对视频是对的，对一张小小的文字位图就完全错了：一行字会被放大到糊满整屏。
 * 画在输出尺寸的透明画布上，`containRect` 就退化成 1:1，默认摆位天然正确，
 * 合成层一行都不用改（也就不用去动 D9 里那条恒等快路径的判定）。
 *
 * 于是**文字的位置和大小全部由 `LayerTransform` 表达**：文字在画布里恒定居中，
 * 想往下挪就给 `transform.y`，想放大就给 `scale`。定位机制只有一套，
 * 不存在"样式里的位置"和"变换里的位置"打架的可能。
 *
 * ## 尺寸一律用比例，不用绝对像素
 *
 * 字号和描边宽度都存"占输出高度的比例"。绝对像素会在换输出分辨率时全错——
 * 同一个项目导 1080p 和 720p，字幕不该一个正常一个巨大。理由与 D9 里
 * "变换用相对量"完全相同。
 *
 * ## 字体
 *
 * 只支持**系统字体族**。栅格化在主线程（预览）和 Worker（导出）里各跑一次，
 * 自定义 web 字体得在两个上下文里分别注册 `FontFace`，否则导出会静默回退到
 * 默认字体——那正是"预览和导出不一致"的经典形态。要支持自定义字体，
 * 必须先把字体文件同时喂给两边，再来放开这里。
 */

import { RasterCache } from "./raster-cache";

/** 文字样式。所有尺寸都是**占输出高度的比例**，理由见文件头。 */
export interface TextStyle {
  /** 字号 ÷ 输出高度。0.08 在 1080p 上约等于 86px。 */
  readonly fontSizeRatio?: number;
  /** 系统字体族。见文件头："只支持系统字体"。 */
  readonly fontFamily?: string;
  readonly fontWeight?: number;
  readonly color?: string;
  /** 描边宽度 ÷ 输出高度。省略或 0 = 不描边。字幕压在亮画面上时靠它保持可读。 */
  readonly strokeRatio?: number;
  readonly strokeColor?: string;
  /** 阴影模糊半径 ÷ 输出高度。省略或 0 = 不投影。 */
  readonly shadowRatio?: number;
  readonly shadowColor?: string;
  /** 多行时的对齐方式。 */
  readonly align?: "left" | "center" | "right";
  /** 行距 ÷ 字号。 */
  readonly lineHeight?: number;
  /** 自动断行的最大宽度 ÷ 输出宽度。 */
  readonly maxWidthRatio?: number;
}

/** 各样式项的默认值。检查器要显示"没设过时实际长什么样"，所以导出。 */
export const TEXT_STYLE_DEFAULTS = {
  fontSizeRatio: 0.08,
  fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
  fontWeight: 600,
  color: "#ffffff",
  strokeRatio: 0,
  strokeColor: "#000000",
  shadowRatio: 0,
  shadowColor: "rgba(0,0,0,0.6)",
  align: "center" as const,
  lineHeight: 1.25,
  maxWidthRatio: 0.86,
};

/**
 * 不能出现在行首的字符（避头）。
 *
 * 不做这一步的话，中文按字断行会把句号、逗号、右引号甩到下一行开头，
 * 一眼就看得出是程序断的而不是人排的。只收常见的那些，不追求完整的 UAX #14。
 */
const NO_LINE_START = "。，、；：？！）］｝」』〉》”’%·…—～!),.:;?]}";
/** 不能出现在行尾的字符（避尾）。 */
const NO_LINE_END = "（［｛「『〈《“‘([{";

/** 判断是否是可以在其两侧断行的宽字符（CJK 汉字、假名、全角标点、emoji）。 */
function isBreakableWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x2600 && code <= 0x27bf) || // 杂项符号 + 装饰符
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首 + 汉字
    (code >= 0x3040 && code <= 0x30ff) || // 假名
    (code >= 0xac00 && code <= 0xd7af) || // 韩文音节
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0x1f000 && code <= 0x1faff) || // emoji
    (code >= 0x20000 && code <= 0x2ffff) // 汉字扩展区
  );
}

/**
 * 按**字素簇**切分，不是按码点。
 *
 * 码点切分能保住代理对（emoji 不会碎成两个乱码），但保不住 ZWJ 序列和组合符号：
 * 👨‍👩‍👧 是三个人 emoji 加两个零宽连接符，按码点切会散成三个人；
 * 带声调的越南语、泰语的组合符号同理。`Intl.Segmenter` 在项目的目标浏览器
 * （Chrome / Safari / Firefox）和 Node 里都有，直接用它就没有这一类问题。
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * 按宽度贪心断行。**纯函数**——宽度测量由调用方注入，所以它不需要画布，能单测。
 *
 * 把"怎么测字"和"怎么断行"分开是刻意的：断行的边界条件（一个字就超宽、
 * 避头尾、显式换行、连续空格）多到必须靠测试锁死，而 `measureText` 只能在
 * 浏览器里跑。注入一个假测量器就能把这些条件全覆盖掉。
 *
 * @param measureWidth 返回一段文字的宽度
 */
export function wrapText(
  text: string,
  maxWidth: number,
  measureWidth: (s: string) => number,
): string[] {
  const out: string[] = [];

  for (const paragraph of text.split("\n")) {
    if (paragraph === "") {
      // 显式空行要保留：用户敲的空行是排版的一部分
      out.push("");
      continue;
    }

    // 先切成"块"再逐块填行，不要逐字符判断能不能断。逐字符的写法在拉丁词
    // 中间发现超宽时已经没法退回上一个空格了，整个词会溢出边界
    let line = "";
    for (const chunk of tokenize(paragraph)) {
      if (line === "") {
        line = chunk;
        continue;
      }
      const candidate = line + chunk;
      // 行尾空白不算溢出，所以量的是 trimEnd 之后的宽度
      if (measureWidth(candidate.trimEnd()) <= maxWidth) {
        line = candidate;
        continue;
      }

      // 避头：新行不能以句号、逗号、右括号这类字符开头。让它挤在本行末尾
      // （宁可这一行略微超宽），这是中日排版里的"追い出し"
      if (startsWithForbidden(chunk)) {
        line = candidate;
        continue;
      }

      // 避尾：旧行不能以开括号、开引号结尾。这里要**把断点前移**，
      // 把行尾那些字符一起挪到下一行——只是"不在这里断"会让它们卡在行中间，
      // 行还照样超宽，等于两头都没落实
      const trailing = trailingForbidden(line);
      if (trailing !== "" && line.trimEnd().length > trailing.length) {
        out.push(line.trimEnd().slice(0, -trailing.length).trimEnd());
        line = trailing + chunk;
        continue;
      }

      out.push(line.trimEnd());
      // 换行后不留行首空白，否则下一行会莫名缩进
      line = chunk.trimStart();
    }
    out.push(line.trimEnd());
  }

  return out;
}

/**
 * 把一段文字切成"块"，块与块之间才允许断行。
 *
 * - 宽字符（汉字/假名/全角/emoji）各自成块——中文可以逐字断。
 * - 拉丁词整体成块——词内不断。
 * - 空白并到前一块的尾部，于是断点自然落在空白**之后**。
 */
function tokenize(paragraph: string): string[] {
  const chunks: string[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf !== "") {
      chunks.push(buf);
      buf = "";
    }
  };

  for (const char of graphemes(paragraph)) {
    if (/\s/.test(char)) {
      if (buf !== "") buf += char;
      else if (chunks.length > 0) chunks[chunks.length - 1] += char;
      else buf = char;
      continue;
    }
    // 空白结束了上一个块
    if (buf !== "" && /\s$/.test(buf)) flush();
    if (isBreakableWide(char)) {
      flush();
      chunks.push(char);
      continue;
    }
    buf += char;
  }
  flush();
  return chunks;
}

/** 这个块是不是以"不能出现在行首"的字符开头。 */
function startsWithForbidden(chunk: string): boolean {
  const first = graphemes(chunk)[0];
  return first !== undefined && NO_LINE_START.includes(first);
}

/** 行尾那一串"不能出现在行尾"的字符。没有则返回空串。 */
function trailingForbidden(line: string): string {
  const chars = graphemes(line.trimEnd());
  let i = chars.length;
  while (i > 0 && NO_LINE_END.includes(chars[i - 1]!)) i--;
  return chars.slice(i).join("");
}

/** 栅格化结果。`canvas` 尺寸等于输出尺寸，所以合成层的默认摆位就是 1:1。 */
export interface TextRaster {
  readonly canvas: OffscreenCanvas;
  readonly width: number;
  readonly height: number;
}

/**
 * 缓存。文字内容和样式在一个片段的整个时长里是常量，逐帧重新排版和描边
 * 会让导出慢一个量级（和"逐帧新建 GPU 纹理"是同一类错误）。
 *
 * 键里必须带输出尺寸：换分辨率后所有比例换算出的像素值都变了。
 *
 * 预算按**字节**而不是条数卡——这是修过的一个 bug：条数上限对分辨率一无所知，
 * 而每张栅格是输出尺寸的画布，同样 32 条在 720p 是 113MB、1080p 是 253MB。
 * 32MB 在 1080p 上约等于 4 张，4K 上不足 1 张（由下限兜底）。
 * 完整理由和淘汰策略见 `raster-cache.ts` 的文件头。
 */
const CACHE_BUDGET_BYTES = 32 * 1024 * 1024;
/** 预算再紧也保底留 2 张：同一帧上可能同时有字幕和标题，留不住就等于逐帧重排。 */
const CACHE_MIN_ENTRIES = 2;

const cache = new RasterCache<TextRaster>(CACHE_BUDGET_BYTES, CACHE_MIN_ENTRIES);

function cacheKey(text: string, style: TextStyle | undefined, width: number, height: number): string {
  return `${width}x${height} ${text} ${JSON.stringify(style ?? {})}`;
}

/**
 * 把文字画成一张输出尺寸的透明图。
 *
 * 同样的入参会拿到**同一个** `TextRaster`（缓存命中），因此预览和导出只要
 * 入参一致，栅格结果就逐像素一致。调用方不要修改返回的 canvas。
 */
export function rasterizeText(
  text: string,
  style: TextStyle | undefined,
  outWidth: number,
  outHeight: number,
): TextRaster | null {
  if (outWidth <= 0 || outHeight <= 0) return null;

  const key = cacheKey(text, style, outWidth, outHeight);
  const hit = cache.get(key);
  if (hit) return hit;

  const s = { ...TEXT_STYLE_DEFAULTS, ...style };
  const fontSize = s.fontSizeRatio * outHeight;
  if (!(fontSize > 0)) return null;

  const canvas = new OffscreenCanvas(outWidth, outHeight);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const font = `${s.fontWeight} ${fontSize}px ${s.fontFamily}`;
  ctx.font = font;
  const lines = wrapText(text, s.maxWidthRatio * outWidth, (str) => ctx.measureText(str).width);

  const lineHeight = fontSize * s.lineHeight;
  const blockHeight = lineHeight * lines.length;
  // 整块垂直居中；想挪位置用 transform.y，不要在这里加偏移（见文件头）
  const top = (outHeight - blockHeight) / 2;

  // textBaseline 用 middle 而不是 alphabetic：中西文混排时 alphabetic 基线
  // 会让两种字的视觉中心错开，而中文没有明显的基线概念
  ctx.textBaseline = "middle";
  ctx.textAlign = s.align === "left" ? "left" : s.align === "right" ? "right" : "center";
  const x =
    s.align === "left"
      ? (outWidth * (1 - s.maxWidthRatio)) / 2
      : s.align === "right"
        ? outWidth - (outWidth * (1 - s.maxWidthRatio)) / 2
        : outWidth / 2;

  if (s.shadowRatio > 0) {
    ctx.shadowColor = s.shadowColor;
    ctx.shadowBlur = s.shadowRatio * outHeight;
  }

  const strokeWidth = s.strokeRatio * outHeight;
  lines.forEach((line, index) => {
    const y = top + lineHeight * (index + 0.5);
    // 描边先画、填充后画：反过来的话描边会盖掉字形边缘，笔画看起来变细
    if (strokeWidth > 0) {
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = s.strokeColor;
      ctx.lineJoin = "round";
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = s.color;
    ctx.fillText(line, x, y);
  });

  const raster: TextRaster = { canvas, width: outWidth, height: outHeight };
  cache.set(key, raster);
  return raster;
}

/** 输出分辨率变了、或者测试之间要隔离时清缓存。 */
export function clearTextRasterCache(): void {
  cache.clear();
}

/**
 * 缓存当前占多少字节（RGBA 后备存储估算）。
 *
 * 这个数比直觉大得多：每张栅格都是**输出尺寸**的画布（D11 的选择，为了让
 * `containRect` 退化成 1:1），1080p 下单张就是 1920×1080×4 ≈ **7.9MB**。
 * 导出的常驻量计量读的就是它，见 `export/residency.ts`——按条数限流那一版
 * 正是被那个计量抓出来的。
 */
export function textRasterCacheBytes(): number {
  return cache.byteSize;
}

/** 缓存里现在有几张。与字节数一起报，才分得清"张数多"和"每张大"。 */
export function textRasterCacheCount(): number {
  return cache.size;
}
