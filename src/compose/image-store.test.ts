/**
 * 图片解码尺寸的算术。
 *
 * 只测 `decodeSizeFor`——解码本身要 `createImageBitmap`，那是浏览器的东西，在
 * 端到端自检里验（见「预览 / 导出一致性自检」）。会算错的恰好是这段纯算术：
 * 按短边算而不是长边（把横幅缩成一条）、忘了保比例、或者把极端长宽比的短边算成 0
 * （`createImageBitmap` 收到 0 会抛，而那个抛发生在导入的时候，看不出是这里的错）。
 */

import { describe, expect, it } from "vitest";
import { decodeSizeFor, MAX_OVERSAMPLE } from "./image-store";

describe("图片解码尺寸", () => {
  it("不超上限时原样解，一个像素都不动", () => {
    expect(decodeSizeFor(1920, 1080, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
    // 正好等于上限也算不超
    const limit = MAX_OVERSAMPLE * 1920;
    expect(decodeSizeFor(limit, 100, 1920, 1080)).toEqual({ width: limit, height: 100 });
  });

  it("超了按**长边**缩到上限，并保持长宽比", () => {
    // 1080p 输出 → 上限 3840；6000×4000 缩成 3840×2560
    expect(decodeSizeFor(6000, 4000, 1920, 1080)).toEqual({ width: 3840, height: 2560 });
  });

  it("竖图同样按长边——按短边算会把它缩过头", () => {
    expect(decodeSizeFor(4000, 6000, 1920, 1080)).toEqual({ width: 2560, height: 3840 });
  });

  it("输出分辨率越小，上限越紧", () => {
    expect(decodeSizeFor(6000, 4000, 640, 360)).toEqual({ width: 1280, height: 853 });
  });

  it("极端长宽比的短边至少留 1 像素——0 会让 createImageBitmap 抛", () => {
    const { width, height } = decodeSizeFor(40_000, 3, 640, 360);
    expect(width).toBe(1280);
    expect(height).toBe(1);
  });
});
