import { describe, expect, it } from "vitest";
import {
  FONT_FAMILY_PREFIX,
  clearFontRegistry,
  isFontRegistered,
  isManagedFamily,
  newFontFamily,
} from "./font-registry";
import { cssFontFamily, TEXT_STYLE_DEFAULTS } from "./text-raster";

// 注册本身要浏览器（node 里没有 `FontFace`），所以这里只测能脱离浏览器的那一半：
// 族名的生成 / 判别，以及"没注册过就抛"那道断言。注册路径的实测见 PLAN.md 的 D31。

describe("族名", () => {
  it("我们生成的族名带前缀，系统族名不带", () => {
    expect(isManagedFamily(newFontFamily(1))).toBe(true);
    expect(isManagedFamily('"PingFang SC", sans-serif')).toBe(false);
    expect(isManagedFamily("Impact")).toBe(false);
  });

  it("同一毫秒里连着生成两个也不重名", () => {
    // 只靠时间戳的话，连着导入两个字体会拿到同一个族名——后一个直接把前一个顶掉，
    // 表现成"改了一个片段的字体，另一个也跟着变了"
    const a = newFontFamily(1000);
    const b = newFontFamily(1000);
    expect(a).not.toBe(b);
    expect(a.startsWith(FONT_FAMILY_PREFIX)).toBe(true);
  });
});

describe("没注册过就抛，不静默换字体", () => {
  it("系统族名原样通过", () => {
    expect(cssFontFamily('"PingFang SC", sans-serif')).toBe('"PingFang SC", sans-serif');
  });

  it("我们管的族名没注册过时抛错", () => {
    clearFontRegistry();
    const family = newFontFamily(2000);
    expect(isFontRegistered(family)).toBe(false);
    // 这是唯一能拦住"预览一种字、成片另一种字"的地方：`ctx.font` 认不出族名时
    // 不报错，只是换成兜底字体接着画
    expect(() => cssFontFamily(family)).toThrow(/没在这个上下文注册过/);
  });

  it("默认族名（系统无衬线那条链）不会被当成我们管的", () => {
    // 默认值同时也是自定义字体的兜底链，判错的话每一次栅格化都会抛
    expect(() => cssFontFamily(TEXT_STYLE_DEFAULTS.fontFamily)).not.toThrow();
  });
});
