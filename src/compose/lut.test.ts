/**
 * `.cube` 解析与查表的单测。
 *
 * 这里锁的是三类"不会报错、只会让颜色悄悄不对"的错误：
 *
 * 1. **解析歪了**。`.cube` 的数据顺序是**红变化最快**，抄反成蓝最快照样能解出
 *    正确数量的值、照样能出画面，只是整个色彩空间被转置了。所以下面用一个
 *    "每个格点各不相同"的表来钉顺序，而不是用对称的表。
 * 2. **铺切片图时下标算错**。同上，错了也不报错。用恒等 LUT 兜住：
 *    恒等 LUT 查出来必须等于输入，任何一处下标或半纹素偏移写错都会打破它。
 * 3. **容错**。宁可抛错也不"尽力而为"——一个解歪了的 LUT 出的片子能播、颜色是错的。
 */

import { describe, expect, it } from "vitest";
import {
  buildLutTexture,
  identityLut,
  LUT_MAX_SIZE,
  parseCubeLut,
  sampleLutTexture,
  sampleLutTexture8,
} from "./lut";

/** 造一份 `.cube` 文本：`fn(r,g,b)` 收 0–1 的格点坐标，返回输出色。 */
function cube(size: number, fn: (r: number, g: number, b: number) => [number, number, number]): string {
  const lines = [`# generated`, `TITLE "test"`, `LUT_3D_SIZE ${size}`];
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const d = size - 1;
        const [or, og, ob] = fn(r / d, g / d, b / d);
        lines.push(`${or.toFixed(6)} ${og.toFixed(6)} ${ob.toFixed(6)}`);
      }
    }
  }
  return lines.join("\n");
}

describe("parseCubeLut", () => {
  it("读得出尺寸、标题和全部数据", () => {
    const lut = parseCubeLut(cube(3, (r, g, b) => [r, g, b]));
    expect(lut.size).toBe(3);
    expect(lut.title).toBe("test");
    expect(lut.rgb).toHaveLength(3 * 3 * 3 * 3);
  });

  it("数据顺序是红变化最快", () => {
    // 每个格点写一个能反推出 (r,g,b) 下标的值，抄反顺序就对不上
    const text = cube(2, (r, g, b) => [r, g, b]);
    const lut = parseCubeLut(text);
    // 第 2 个格点（下标 1）应当是 r=1,g=0,b=0
    expect([lut.rgb[3], lut.rgb[4], lut.rgb[5]]).toEqual([1, 0, 0]);
    // 第 3 个格点（下标 2）应当是 r=0,g=1,b=0
    expect([lut.rgb[6], lut.rgb[7], lut.rgb[8]]).toEqual([0, 1, 0]);
    // 第 5 个格点（下标 4）应当是 r=0,g=0,b=1
    expect([lut.rgb[12], lut.rgb[13], lut.rgb[14]]).toEqual([0, 0, 1]);
  });

  it("忽略注释、空行和多余空白", () => {
    const text = ["# hello", "", "   ", "LUT_3D_SIZE 2", ...Array.from({ length: 8 }, () => "  0.5   0.5\t0.5  ")].join("\n");
    const lut = parseCubeLut(text);
    expect(lut.size).toBe(2);
    expect([...lut.rgb].every((v) => v === 0.5)).toBe(true);
  });

  it("接受 0–1 的显式定义域", () => {
    const text = `LUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n` +
      Array.from({ length: 8 }, () => "0 0 0").join("\n");
    expect(parseCubeLut(text).size).toBe(2);
  });

  it("拒绝非 0–1 定义域——忽略它只会让颜色悄悄不对", () => {
    const text = `LUT_3D_SIZE 2\nDOMAIN_MAX 4 4 4\n` + Array.from({ length: 8 }, () => "0 0 0").join("\n");
    expect(() => parseCubeLut(text)).toThrow(/DOMAIN/);
  });

  it("拒绝一维 LUT", () => {
    expect(() => parseCubeLut("LUT_1D_SIZE 16\n0 0 0")).toThrow(/一维/);
  });

  it("没有 LUT_3D_SIZE 就报错", () => {
    expect(() => parseCubeLut("0 0 0\n1 1 1")).toThrow(/LUT_3D_SIZE/);
  });

  it("行数对不上就报错，而不是补零", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 2\n0 0 0\n1 1 1")).toThrow(/行数对不上/);
  });

  it("超过尺寸上限就报错，而不是截断", () => {
    const text = `LUT_3D_SIZE ${LUT_MAX_SIZE + 1}\n`;
    expect(() => parseCubeLut(text)).toThrow(new RegExp(String(LUT_MAX_SIZE)));
  });

  it("认不出的行直接报错", () => {
    expect(() => parseCubeLut("LUT_3D_SIZE 2\nBOGUS LINE HERE")).toThrow(/认不出/);
  });
});

describe("恒等 LUT", () => {
  // 恒等是最强的护栏：下标、半纹素偏移、切片拼接任何一处错了，它都不再恒等，
  // 而在一个真实 LUT 上这些错误完全看不出来——谁也不知道它"应该"是什么颜色
  for (const size of [2, 5, 17, 33]) {
    it(`size ${size} 上查表结果等于输入`, () => {
      const tex = buildLutTexture(identityLut(size));
      for (const c of [
        [0, 0, 0],
        [1, 1, 1],
        [0.25, 0.5, 0.75],
        [0.13, 0.87, 0.42],
        [1, 0, 0.5],
      ] as const) {
        const out = sampleLutTexture(tex, c);
        for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i]!, 2);
      }
    });
  }
});

describe("buildLutTexture", () => {
  it("尺寸是 N² × N", () => {
    const tex = buildLutTexture(identityLut(17));
    expect(tex.width).toBe(17 * 17);
    expect(tex.height).toBe(17);
    expect(tex.pixels).toHaveLength(17 * 17 * 17 * 4);
  });

  it("切片序号是蓝、切片内 x 是红、y 是绿", () => {
    // 用一个把 (r,g,b) 编码进输出的表，直接读像素反推布局
    const size = 4;
    const lut = parseCubeLut(cube(size, (r, g, b) => [r, g, b]));
    const tex = buildLutTexture(lut);
    const at = (x: number, y: number): number[] => {
      const i = (y * tex.width + x) * 4;
      return [tex.pixels[i]!, tex.pixels[i + 1]!, tex.pixels[i + 2]!];
    };
    // b=2 那个切片、切片内 r=1、g=3 → 应当读到 (1/3, 1, 2/3) × 255
    expect(at(2 * size + 1, 3)).toEqual([85, 255, 170]);
  });

  it("超出 0–1 的表项被夹住（.cube 允许写超出范围的值）", () => {
    const text = "LUT_3D_SIZE 2\n" + Array.from({ length: 8 }, () => "-1 2 0.5").join("\n");
    const tex = buildLutTexture(parseCubeLut(text));
    expect([tex.pixels[0], tex.pixels[1], tex.pixels[2]]).toEqual([0, 255, 128]);
  });
});

describe("sampleLutTexture", () => {
  it("通道互换是线性映射，插值处处精确", () => {
    // 线性表下三线性插值是精确的，所以可以用严格容差断言，不用"差不多"
    const tex = buildLutTexture(parseCubeLut(cube(9, (r, g, b) => [b, r, g])));
    for (const c of [
      [0.2, 0.4, 0.6],
      [0.75, 0.125, 0.5],
      [1, 0, 0],
    ] as const) {
      const out = sampleLutTexture(tex, c);
      expect(out[0]).toBeCloseTo(c[2]!, 2);
      expect(out[1]).toBeCloseTo(c[0]!, 2);
      expect(out[2]).toBeCloseTo(c[1]!, 2);
    }
  });

  it("输入超出 0–1 时夹住，不越出表外", () => {
    const tex = buildLutTexture(identityLut(5));
    expect(sampleLutTexture(tex, [-1, 2, 0.5])[0]).toBeCloseTo(0, 2);
    expect(sampleLutTexture(tex, [-1, 2, 0.5])[1]).toBeCloseTo(1, 2);
  });
});

describe("sampleLutTexture8 的强度混合", () => {
  const tex = buildLutTexture(parseCubeLut(cube(9, () => [0, 0, 0])));

  it("强度 1 = 完全套用", () => {
    expect(sampleLutTexture8(tex, [200, 100, 50], 1)).toEqual([0, 0, 0]);
  });

  it("强度 0 = 原样返回（此时不该挂滤镜，这条是语义护栏）", () => {
    expect(sampleLutTexture8(tex, [200, 100, 50], 0)).toEqual([200, 100, 50]);
  });

  it("强度 0.5 = 走一半", () => {
    expect(sampleLutTexture8(tex, [200, 100, 50], 0.5)).toEqual([100, 50, 25]);
  });
});
