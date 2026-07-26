/**
 * 断行的单测。
 *
 * `wrapText` 把"怎么测字"注入进来，所以它不需要画布就能测——这正是把测量
 * 拆出去的目的。下面用**每个字符宽 10** 的假测量器，于是"宽度 55"就等于
 * "最多 5 个字符"，期望值全是能数出来的。
 *
 * 锁的是三类肉眼一看就知道错、但不会报错的排版失败：
 *
 * 1. **拉丁词被劈开**或者反过来**整个词溢出边界**。逐字符判断能不能断的写法
 *    在词中间发现超宽时已经退不回上一个空格了，只能让它溢出。
 * 2. **标点跑到行首**（。，！）或者开引号留在行尾——一眼就看出是程序断的。
 * 3. **代理对被劈成两半**。emoji 和扩展区汉字按 UTF-16 码元切就会碎成乱码。
 */

import { describe, expect, it } from "vitest";
import { wrapText } from "./text-raster";

/** 每个字符宽 10 的假测量器。用 Array.from 数，与被测代码同样按码点计。 */
const fixed = (s: string): number => Array.from(s).length * 10;

/** 便于读断言：把行数组写成 "a|b|c"。 */
const joined = (text: string, maxWidth: number): string =>
  wrapText(text, maxWidth, fixed).join("|");

describe("wrapText 中文", () => {
  it("按字断行", () => {
    expect(joined("一二三四五六七", 30)).toBe("一二三|四五六|七");
  });

  it("刚好放得下时不断行", () => {
    expect(joined("一二三", 30)).toBe("一二三");
  });

  it("宽度只够一个字时每行一个字，不会死循环", () => {
    expect(joined("一二三", 10)).toBe("一|二|三");
  });

  it("宽度比一个字还窄时仍然逐字输出，不丢字", () => {
    // 第一个字放不下也必须放——否则会陷入"永远断行但永远放不进"的死循环
    expect(joined("一二", 5)).toBe("一|二");
  });
});

describe("wrapText 避头尾", () => {
  it("句号不许跑到行首，宁可让它挤在上一行", () => {
    // 断在"。"之前会让下一行以句号开头
    expect(joined("一二三。四", 30)).toBe("一二三。|四");
  });

  it("逗号、问号同样不许在行首", () => {
    expect(joined("一二三，四", 30)).toBe("一二三，|四");
    expect(joined("一二三？四", 30)).toBe("一二三？|四");
  });

  it("开引号不许留在行尾", () => {
    // 断在"四"之前会让上一行以"（"结尾
    expect(joined("一二（四五", 30)).toBe("一二|（四五");
  });
});

describe("wrapText 拉丁文", () => {
  it("在空格处断，不劈开单词", () => {
    expect(joined("hello world", 60)).toBe("hello|world");
  });

  it("单个词比整行还宽时允许溢出，但绝不劈开", () => {
    // 劈开会产生 "extraordi|narily" 这种读不出来的结果；溢出至少还认得
    expect(joined("extraordinarily", 50)).toBe("extraordinarily");
  });

  it("超宽的词不会把后面的词也拖上同一行", () => {
    expect(joined("extraordinarily long", 50)).toBe("extraordinarily|long");
  });

  it("行尾空格不算溢出", () => {
    // "ab " 是 3 个字符宽 30，但可见部分只有 20
    expect(joined("ab cd", 20)).toBe("ab|cd");
  });

  it("换行后不留行首空格", () => {
    for (const line of wrapText("aa bb cc", 20, fixed)) {
      expect(line).not.toMatch(/^\s/);
    }
  });
});

describe("wrapText 混排与显式换行", () => {
  it("中英混排在两种断点上都能断", () => {
    // "中文 abc" 可见宽度 7 字符 = 70，正好放得下；再加"中"就是 90，超了
    expect(joined("中文 abc 中文", 70)).toBe("中文 abc|中文");
  });

  it("汉字与拉丁词之间可以断", () => {
    expect(joined("中abc", 20)).toBe("中|abc");
  });

  it("显式 \\n 强制换行", () => {
    expect(joined("一二\n三四", 100)).toBe("一二|三四");
  });

  it("显式换行的每一段各自再按宽度断", () => {
    expect(joined("一二三四\n五六", 20)).toBe("一二|三四|五六");
  });

  it("保留用户敲的空行", () => {
    expect(joined("一\n\n二", 100)).toBe("一||二");
  });
});

describe("wrapText 代理对", () => {
  it("emoji 不会被劈成两半", () => {
    // "😀" 是一个码点两个码元，按码元切会得到两个乱码字符
    const lines = wrapText("😀😀😀", 20, fixed);
    expect(lines).toEqual(["😀😀", "😀"]);
    for (const line of lines) expect(line).not.toContain("�");
  });

  it("扩展区汉字按码点计数", () => {
    // U+20B9F 是一个码点、两个码元
    expect(wrapText("\u{20B9F}\u{20B9F}", 10, fixed)).toEqual(["\u{20B9F}", "\u{20B9F}"]);
  });

  it("ZWJ 合成的 emoji 不会被拆散", () => {
    // 👨‍👩‍👧 是三个人 emoji 加两个零宽连接符。按码点切会散成三个人，
    // 所以这里必须按**字素簇**切（Intl.Segmenter），不是 Array.from
    const family = "👨‍👩‍👧";
    const lines = wrapText(family + family, 10, () => 20);
    expect(lines).toEqual([family, family]);
  });
});

describe("wrapText 边界输入", () => {
  it("空字符串产出一个空行，不产出零行", () => {
    // 返回 [] 会让调用方算出块高 0，整段文字消失
    expect(wrapText("", 100, fixed)).toEqual([""]);
  });

  it("只有空格时不崩", () => {
    expect(wrapText("   ", 100, fixed)).toEqual([""]);
  });

  it("宽度为 0 时不死循环", () => {
    expect(wrapText("一二", 0, fixed)).toEqual(["一", "二"]);
  });
});
