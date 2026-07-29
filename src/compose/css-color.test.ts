import { describe, expect, it } from "vitest";
import { formatCssColor, isCssColor, parseCssColor, toHexRgb } from "./css-color";

describe("解析", () => {
  it("六位十六进制", () => {
    expect(parseCssColor("#ff8800")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
  });

  it("三位十六进制按位复制展开，不是补零", () => {
    // `#f80` 是 `#ff8800` 而不是 `#0f0800`——补零会让所有简写颜色整体变暗
    expect(parseCssColor("#f80")).toEqual({ r: 255, g: 136, b: 0, a: 1 });
  });

  it("八位和四位十六进制带 alpha", () => {
    expect(parseCssColor("#00000080")?.a).toBeCloseTo(128 / 255, 5);
    expect(parseCssColor("#0008")?.a).toBeCloseTo(136 / 255, 5);
  });

  it("rgb() 和 rgba()", () => {
    expect(parseCssColor("rgb(10,20,30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor("rgba(0, 0, 0, 0.6)")).toEqual({ r: 0, g: 0, b: 0, a: 0.6 });
  });

  it("空格分隔和斜杠 alpha 也认（CSS Color 4 的写法）", () => {
    expect(parseCssColor("rgb(1 2 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor("rgb(1 2 3 / 0.25)")).toEqual({ r: 1, g: 2, b: 3, a: 0.25 });
  });

  it("越界的分量被夹住，而不是当成解析失败", () => {
    expect(parseCssColor("rgba(300, -5, 0, 2)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("前后空白不影响", () => {
    expect(parseCssColor("  #fff  ")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("认不出的一律返回 null，不猜", () => {
    // 认的范围就是我们自己写得出来的范围，见文件头
    for (const bad of ["red", "hsl(0 100% 50%)", "currentColor", "#12345", "#gg0000", "rgb(1,2)", "rgb(a,b,c)", ""]) {
      expect(parseCssColor(bad)).toBeNull();
    }
  });

  it("isCssColor 就是「解析得出来」", () => {
    expect(isCssColor("#000")).toBe(true);
    expect(isCssColor("papayawhip")).toBe(false);
  });
});

describe("序列化定死一种形式", () => {
  it("不透明给六位十六进制", () => {
    expect(formatCssColor({ r: 255, g: 136, b: 0, a: 1 })).toBe("#ff8800");
  });

  it("半透明给 rgba()，不给八位十六进制", () => {
    // 八位十六进制一旦某个环境不认，失败形态是"赋值被静默忽略"（见文件头）
    expect(formatCssColor({ r: 0, g: 0, b: 0, a: 0.6 })).toBe("rgba(0, 0, 0, 0.6)");
  });

  it("alpha 不留多余的零", () => {
    expect(formatCssColor({ r: 1, g: 2, b: 3, a: 0.5 })).toBe("rgba(1, 2, 3, 0.5)");
    expect(formatCssColor({ r: 1, g: 2, b: 3, a: 0 })).toBe("rgba(1, 2, 3, 0)");
  });

  it("同一个颜色永远给出同一个字符串", () => {
    // 文字栅格缓存的键里带着整份样式，两种写法会变成两条缓存
    const forms = ["#ff8800", "#f80", "rgb(255,136,0)", "rgb(255 136 0)"];
    const out = new Set(forms.map((f) => formatCssColor(parseCssColor(f)!)));
    expect([...out]).toEqual(["#ff8800"]);
  });

  it("往返一致", () => {
    for (const value of ["#ff8800", "rgba(0, 0, 0, 0.6)", "rgba(12, 34, 56, 0.25)"]) {
      expect(formatCssColor(parseCssColor(value)!)).toBe(value);
    }
  });

  it("toHexRgb 丢掉 alpha——input[type=color] 只吃这一种", () => {
    expect(toHexRgb({ r: 0, g: 0, b: 0, a: 0.6 })).toBe("#000000");
  });
});
