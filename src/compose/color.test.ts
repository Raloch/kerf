/**
 * 色彩矩阵的单测。
 *
 * 这里锁的是四类"不会报错、只会让画面悄悄不对"的错误：
 *
 * 1. **恒等不是恒等**。缺省参数编出来的矩阵必须逐位等于单位阵——差一点点，
 *    "没调色的项目输出逐像素不变"这条保证就没了，而它是 D9 那条恒等快路径
 *    在调色维度上的对应物。
 * 2. **合成顺序反了**。`composeMatrix(a, b)` 是"先 a 后 b"，写反不报错，
 *    只会画出另一张画面。下面用"先提亮后拉对比"和反过来的结果不同来钉死。
 * 3. **饱和度/色相的权重抄错**。灰度化之后三个通道必须完全相等且等于亮度，
 *    权重打错一位小数只会让灰度画面偏一点色。
 * 4. **夹紧漏了**。GPU 写 8 位纹理时会夹，参照实现不夹的话自检在高饱和处
 *    必然误报，而那时会去怀疑 shader。
 */

import { describe, expect, it } from "vitest";
import {
  applyColorMatrix,
  applyColorMatrix8,
  brightnessMatrix,
  colorMatrixOf,
  composeMatrix,
  contrastMatrix,
  hueMatrix,
  IDENTITY_MATRIX,
  isDefaultColorMatrix,
  saturationMatrix,
  type ColorMatrix,
  type Rgba,
} from "./color";

const RED: Rgba = [1, 0, 0, 1];
const MID: Rgba = [0.5, 0.5, 0.5, 1];
const WHITE: Rgba = [1, 1, 1, 1];

/** 亮度权重，和实现里那组必须一致——这里重写一遍是刻意的对照。 */
const luma = ([r, g, b]: Rgba): number => 0.213 * r + 0.715 * g + 0.072 * b;

const closeTo = (m: ColorMatrix, expected: readonly number[]): void => {
  expect(m).toHaveLength(20);
  for (let i = 0; i < 20; i++) expect(m[i]!).toBeCloseTo(expected[i]!, 6);
};

describe("isDefaultColorMatrix", () => {
  it("没给、空对象、显式写缺省值，都算没调色", () => {
    expect(isDefaultColorMatrix()).toBe(true);
    expect(isDefaultColorMatrix({})).toBe(true);
    expect(isDefaultColorMatrix({ brightness: 1, contrast: 1, saturation: 1, hue: 0 })).toBe(true);
  });

  it("任一项动过就不算", () => {
    expect(isDefaultColorMatrix({ brightness: 1.01 })).toBe(false);
    expect(isDefaultColorMatrix({ contrast: 0.99 })).toBe(false);
    expect(isDefaultColorMatrix({ saturation: 0 })).toBe(false);
    expect(isDefaultColorMatrix({ hue: 0.001 })).toBe(false);
  });
});

describe("colorMatrixOf", () => {
  it("缺省参数编出单位阵本身（同一个对象）", () => {
    expect(colorMatrixOf()).toBe(IDENTITY_MATRIX);
    expect(colorMatrixOf({})).toBe(IDENTITY_MATRIX);
    expect(colorMatrixOf({ brightness: 1, hue: 0 })).toBe(IDENTITY_MATRIX);
  });

  it("单位阵作用在任何颜色上都原样返回", () => {
    for (const c of [RED, MID, WHITE, [0.3, 0.6, 0.9, 0.5] as Rgba]) {
      expect(applyColorMatrix(IDENTITY_MATRIX, c)).toEqual(c);
    }
  });

  it("只动一项时等于那一项自己的矩阵", () => {
    closeTo(colorMatrixOf({ brightness: 1.5 }), brightnessMatrix(1.5));
    closeTo(colorMatrixOf({ contrast: 0.5 }), contrastMatrix(0.5));
    closeTo(colorMatrixOf({ saturation: 0 }), saturationMatrix(0));
    closeTo(colorMatrixOf({ hue: 1 }), hueMatrix(1));
  });

  it("顺序定死为 色相 → 饱和度 → 对比度 → 亮度", () => {
    const adjust = { brightness: 1.4, contrast: 0.6, saturation: 1.8, hue: 0.7 };
    let expected: ColorMatrix = hueMatrix(0.7);
    expected = composeMatrix(expected, saturationMatrix(1.8));
    expected = composeMatrix(expected, contrastMatrix(0.6));
    expected = composeMatrix(expected, brightnessMatrix(1.4));
    closeTo(colorMatrixOf(adjust), expected);
  });

  it("顺序真的有影响——反过来算是另一张画面", () => {
    // 这条是上一条的护栏：如果两种顺序结果相同，上面那条断言就是空的
    const forward = composeMatrix(brightnessMatrix(2), contrastMatrix(2));
    const backward = composeMatrix(contrastMatrix(2), brightnessMatrix(2));
    expect(applyColorMatrix(forward, [0.25, 0.25, 0.25, 1])).not.toEqual(
      applyColorMatrix(backward, [0.25, 0.25, 0.25, 1]),
    );
  });
});

describe("composeMatrix", () => {
  it("和单位阵合成是恒等（两个方向）", () => {
    const m = colorMatrixOf({ contrast: 0.4, hue: 2 });
    closeTo(composeMatrix(m, IDENTITY_MATRIX), m);
    closeTo(composeMatrix(IDENTITY_MATRIX, m), m);
  });

  it("合成的结果等于依次作用（含偏移项）", () => {
    // 偏移项是最容易漏的：contrast 有截距，只做 4×4 相乘会把它丢掉
    const a = contrastMatrix(0.5);
    const b = brightnessMatrix(1.5);
    const combined = composeMatrix(a, b);
    for (const c of [RED, MID, WHITE, [0.1, 0.8, 0.4, 1] as Rgba]) {
      const stepwise = applyColorMatrix(b, applyColorMatrix(a, c));
      const fused = applyColorMatrix(combined, c);
      for (let i = 0; i < 4; i++) expect(fused[i]!).toBeCloseTo(stepwise[i]!, 6);
    }
  });
});

describe("brightness", () => {
  it("是纯增益，中灰乘 2 变 1.0", () => {
    expect(applyColorMatrix(brightnessMatrix(2), MID)).toEqual([1, 1, 1, 1]);
  });

  it("0 全黑，但 alpha 不动", () => {
    expect(applyColorMatrix(brightnessMatrix(0), [1, 0.5, 0.2, 0.4])).toEqual([0, 0, 0, 0.4]);
  });
});

describe("contrast", () => {
  it("中灰是不动点", () => {
    for (const c of [0, 0.5, 1, 2, 4]) {
      const out = applyColorMatrix(contrastMatrix(c), MID);
      expect(out[0]).toBeCloseTo(0.5, 6);
    }
  });

  it("0 把所有颜色压成中灰", () => {
    expect(applyColorMatrix(contrastMatrix(0), RED)).toEqual([0.5, 0.5, 0.5, 1]);
    expect(applyColorMatrix(contrastMatrix(0), [0, 0, 0, 1])).toEqual([0.5, 0.5, 0.5, 1]);
  });
});

describe("saturation", () => {
  it("0 时三通道相等且等于亮度", () => {
    for (const c of [RED, [0.2, 0.9, 0.4, 1] as Rgba, [0.05, 0.05, 0.8, 1] as Rgba]) {
      const [r, g, b] = applyColorMatrix(saturationMatrix(0), c);
      expect(r).toBeCloseTo(luma(c), 6);
      expect(g).toBeCloseTo(r, 6);
      expect(b).toBeCloseTo(r, 6);
    }
  });

  it("灰色调饱和度不变色", () => {
    for (const s of [0, 0.5, 2, 4]) {
      const out = applyColorMatrix(saturationMatrix(s), MID);
      expect(out[0]).toBeCloseTo(0.5, 6);
      expect(out[1]).toBeCloseTo(0.5, 6);
      expect(out[2]).toBeCloseTo(0.5, 6);
    }
  });
});

describe("hue", () => {
  it("转 0 是恒等", () => {
    closeTo(hueMatrix(0), IDENTITY_MATRIX);
  });

  it("转满一圈回到原处", () => {
    closeTo(hueMatrix(Math.PI * 2), IDENTITY_MATRIX);
  });

  it("灰色没有色相，转多少都不动", () => {
    for (const theta of [0.5, Math.PI / 2, Math.PI, 4]) {
      const out = applyColorMatrix(hueMatrix(theta), MID);
      expect(out[0]).toBeCloseTo(0.5, 6);
      expect(out[1]).toBeCloseTo(0.5, 6);
      expect(out[2]).toBeCloseTo(0.5, 6);
    }
  });

  it("转 120° 把红大致推向绿（近似矩阵，只断言主通道换位）", () => {
    const out = applyColorMatrix(hueMatrix((120 * Math.PI) / 180), RED);
    expect(out[1]).toBeGreaterThan(out[0]!);
    expect(out[1]).toBeGreaterThan(out[2]!);
  });
});

describe("applyColorMatrix", () => {
  it("RGB 夹到 [0,1]，alpha 原样带过", () => {
    // GPU 写 8 位纹理时会夹；参照实现不夹的话自检会在高饱和处误报
    const out = applyColorMatrix(brightnessMatrix(4), [0.9, 0.1, 0.5, 0.25]);
    expect(out).toEqual([1, 0.4, 1, 0.25]);
  });

  it("色相近似把颜色推出色域时也被夹住，不出现负数", () => {
    const m = colorMatrixOf({ saturation: 4, hue: 1 });
    for (const c of [RED, [0, 1, 0, 1] as Rgba, [0, 0, 1, 1] as Rgba]) {
      for (const v of applyColorMatrix(m, c)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("applyColorMatrix8", () => {
  it("8 位进 8 位出，恒等时原样", () => {
    expect(applyColorMatrix8(IDENTITY_MATRIX, [12, 200, 77, 255])).toEqual([12, 200, 77, 255]);
  });

  it("灰度化后三通道相等", () => {
    const [r, g, b] = applyColorMatrix8(saturationMatrix(0), [255, 0, 0, 255]);
    expect(g).toBe(r);
    expect(b).toBe(r);
    expect(r).toBe(Math.round(0.213 * 255));
  });
});
