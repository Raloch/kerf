/**
 * shader 转场混合函数的单测。
 *
 * 这一层锁的是**语义**：进度走完两端要真的干净、边界位置对得上、羽化只发生在
 * 该发生的地方。"shader 有没有按这个语义算"单测够不着——那条由 Pixi spike 里的
 * GPU-vs-CPU 断言管（见 `transition-shader.ts` 文件头）。
 */

import { describe, expect, it } from "vitest";
import {
  isShaderTransition,
  mixTransition,
  SHADER_TRANSITION_KINDS,
  TRANSITION_CODES,
  TRANSITION_FEATHER,
  TRANSITION_FRAGMENT,
  type Rgba,
} from "./transition-shader";

const FROM: Rgba = { r: 1, g: 0, b: 0, a: 1 };
const TO: Rgba = { r: 0, g: 0, b: 1, a: 1 };

/** 原位取样版本（wipe / iris 用得到，slide 会退化成不位移）。 */
const at = (kind: "wipe" | "iris" | "slide", u: number, v: number, t: number) =>
  mixTransition(kind, FROM, TO, u, v, t);

/** 带位移取样：两层各自是一张"横向渐变"图，便于验证 slide 取到了哪一列。 */
const ramp = (base: Rgba) => (u: number): Rgba => ({ ...base, g: u });

const slideAt = (u: number, t: number) =>
  mixTransition("slide", FROM, TO, u, 0.5, t, {
    from: (su) => ramp(FROM)(su),
    to: (su) => ramp(TO)(su),
  });

describe("isShaderTransition", () => {
  it("dissolve 不是 shader 转场——它走图层不透明度，两个后端都能画", () => {
    expect(isShaderTransition("dissolve")).toBe(false);
  });

  it("三种擦除/推移都是", () => {
    for (const kind of SHADER_TRANSITION_KINDS) expect(isShaderTransition(kind)).toBe(true);
  });

  it("每一种都有分支号，且互不相同", () => {
    const codes = SHADER_TRANSITION_KINDS.map((k) => TRANSITION_CODES[k]);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("wipe", () => {
  it("t=0 时整屏还是出场层，t=1 时整屏已是入场层", () => {
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(at("wipe", u, 0.5, 0)).toEqual(FROM);
      expect(at("wipe", u, 0.5, 1)).toEqual(TO);
    }
  });

  it("边界在左侧时右边仍是出场层，反之亦然", () => {
    expect(at("wipe", 0.9, 0.5, 0.2)).toEqual(FROM);
    expect(at("wipe", 0.1, 0.5, 0.8)).toEqual(TO);
  });

  it("半程时边界落在画面中线附近", () => {
    // 羽化带中点就是 wipeEdge(0.5) = 0.5
    const m = at("wipe", 0.5, 0.5, 0.5);
    expect(m.r).toBeCloseTo(0.5, 6);
    expect(m.b).toBeCloseTo(0.5, 6);
  });

  it("只在羽化带内出现中间值，带外是纯的", () => {
    const edge = 0.5;
    const inside = at("wipe", edge - TRANSITION_FEATHER, 0.5, 0.5);
    const outside = at("wipe", edge + TRANSITION_FEATHER, 0.5, 0.5);
    expect(inside).toEqual(TO);
    expect(outside).toEqual(FROM);
  });

  it("与 y 无关——它是竖直的边界", () => {
    for (const v of [0, 0.3, 1]) expect(at("wipe", 0.42, v, 0.6)).toEqual(at("wipe", 0.42, 0.5, 0.6));
  });

  it("沿 x 单调：擦过去就不会擦回来", () => {
    let prev = -1;
    for (let u = 1; u >= 0; u -= 0.01) {
      const blue = at("wipe", u, 0.5, 0.5).b;
      expect(blue).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = blue;
    }
  });
});

describe("iris", () => {
  it("t=0 整屏出场，t=1 整屏入场（含四个角）", () => {
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) {
      expect(at("iris", u, v, 0)).toEqual(FROM);
      expect(at("iris", u, v, 1)).toEqual(TO);
    }
  });

  it("从中心向外张开：半程时中心已是入场层、角落还是出场层", () => {
    expect(at("iris", 0.5, 0.5, 0.5)).toEqual(TO);
    expect(at("iris", 0, 0, 0.5)).toEqual(FROM);
  });

  it("同一半径上处处相同——它是个圆，不是方", () => {
    const r = 0.3;
    const a = at("iris", 0.5 + r, 0.5, 0.55);
    const b = at("iris", 0.5, 0.5 + r, 0.55);
    const c = at("iris", 0.5 - r * Math.SQRT1_2, 0.5 - r * Math.SQRT1_2, 0.55);
    expect(b.b).toBeCloseTo(a.b, 6);
    expect(c.b).toBeCloseTo(a.b, 6);
  });

  it("角落是最后被覆盖的——归一化半径以角落为 1", () => {
    // 稍小于 1 的进度时角落还没被完全盖住
    expect(at("iris", 0, 0, 0.97).r).toBeGreaterThan(0);
  });
});

describe("slide", () => {
  it("t=0 时整屏取出场层的原位", () => {
    for (const u of [0, 0.5, 0.99]) expect(slideAt(u, 0).g).toBeCloseTo(u, 6);
  });

  it("t=1 时整屏取入场层的原位", () => {
    for (const u of [0.01, 0.5, 0.99]) {
      const px = slideAt(u, 1);
      expect(px.b).toBe(1);
      expect(px.g).toBeCloseTo(u, 6);
    }
  });

  it("半程时左半屏是出场层的右半、右半屏是入场层的左半", () => {
    // 屏幕 x=0.2 → 出场层的 0.7；x=0.8 → 入场层的 0.3
    const left = slideAt(0.2, 0.5);
    expect(left.r).toBe(1);
    expect(left.g).toBeCloseTo(0.7, 6);

    const right = slideAt(0.8, 0.5);
    expect(right.b).toBe(1);
    expect(right.g).toBeCloseTo(0.3, 6);
  });

  it("交界正好落在 1-t 上，且两侧内容连续（推移不该有跳变）", () => {
    const t = 0.4;
    const justLeft = slideAt(1 - t - 1e-6, t);
    const justRight = slideAt(1 - t + 1e-6, t);
    // 左边取到出场层的最右端（≈1），右边取到入场层的最左端（≈0）
    expect(justLeft.g).toBeCloseTo(1, 4);
    expect(justRight.g).toBeCloseTo(0, 4);
  });

  it("不产生中间混合色——推移是硬边界，任一像素只属于一层", () => {
    for (let u = 0; u < 1; u += 0.017) {
      const px = slideAt(u, 0.5);
      expect(px.r === 1 || px.b === 1).toBe(true);
      expect(px.r === 1 && px.b === 1).toBe(false);
    }
  });
});

describe("shader 与参照实现的对应", () => {
  it("分支号在 GLSL 里都有对应的分支", () => {
    // slide 是显式的 effect == 2，iris 是 effect == 1，wipe 落在 else
    expect(TRANSITION_FRAGMENT).toContain("effect == 2");
    expect(TRANSITION_FRAGMENT).toContain("effect == 1");
  });

  it("GLSL 里的 wipeEdge 与 JS 同式：系数是 1 + feather", () => {
    expect(TRANSITION_FRAGMENT).toContain("t * (1.0 + feather)");
  });

  it("羽化宽度只有一个来源——GLSL 从 uniform 读，不写死", () => {
    expect(TRANSITION_FRAGMENT).toContain("uFeather");
    expect(TRANSITION_FRAGMENT).not.toContain(String(TRANSITION_FEATHER));
  });
});
