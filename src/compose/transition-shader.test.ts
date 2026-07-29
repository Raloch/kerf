/**
 * shader 转场混合函数的单测。
 *
 * 这一层锁的是**语义**：进度走完两端要真的干净、边界位置对得上、羽化只发生在
 * 该发生的地方。"shader 有没有按这个语义算"单测够不着——那条由 Pixi spike 里的
 * GPU-vs-CPU 断言管（见 `transition-shader.ts` 文件头）。
 */

import { describe, expect, it } from "vitest";
import {
  GLITCH_BLOCKS,
  GLITCH_SHIFT,
  GLITCH_WINDOW,
  hashUnit,
  isShaderTransition,
  mixTransition,
  pcgHash,
  SHADER_TRANSITION_KINDS,
  TRANSITION_CODES,
  TRANSITION_FEATHER,
  TRANSITION_FRAGMENT,
  type Rgba,
} from "./transition-shader";

/**
 * 剥掉行注释之后的 GLSL 源码。
 *
 * "GLSL 里不许出现 X" 这类断言必须看**代码**：第一版直接搜整份源码，结果被
 * shader 里那句「不要换回 fract(sin(x)*43758.5453)」的注释命中——一条警告不要
 * 用它的注释，被当成了用了它。同 CLAUDE.md 那条"先确认量法量的是被测对象"。
 */
const GLSL_CODE = TRANSITION_FRAGMENT.replace(/\/\/[^\n]*/g, "");

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
    expect(GLSL_CODE).not.toContain(String(TRANSITION_FEATHER));
  });
});

// ---------------------------------------------------------------------------
// 故障
// ---------------------------------------------------------------------------

/** 两层各自是横向渐变，于是"取到了哪一列"能从颜色读出来。 */
const glitchAt = (u: number, v: number, t: number) =>
  mixTransition("glitch", FROM, TO, u, v, t, {
    from: (su) => ramp(FROM)(su),
    to: (su) => ramp(TO)(su),
  });

/** 这一点取的是入场层吗（渐变图的 r 通道区分两层）。 */
const tookTo = (u: number, v: number, t: number) => glitchAt(u, v, t).r === 0;

describe("PCG 整数哈希", () => {
  it("是纯函数，同一个输入恒定给同一个值", () => {
    expect(pcgHash(0)).toBe(pcgHash(0));
    expect(pcgHash(12345)).toBe(pcgHash(12345));
  });

  it("输出落在 uint32 范围内——每一步都拉回无符号", () => {
    // 少一个 `>>> 0` 的表现是符号位泄漏进后续移位，只影响一部分输入，
    // 画面上"随机得挺像"，只有和 GPU 对拍才发现
    for (let i = 0; i < 64; i++) {
      const h = pcgHash(i);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("相邻输入给出不相关的输出——这是它能当「随机」用的前提", () => {
    // 顺带挡住"哈希退化成恒等/线性"这类改坏：那时相邻带的翻转时刻会单调排列，
    // 故障就变成了一道从上往下的擦除
    const units = Array.from({ length: GLITCH_BLOCKS }, (_, i) => hashUnit(pcgHash(i)));
    expect(new Set(units).size).toBe(GLITCH_BLOCKS);
    const sorted = [...units].sort((a, b) => a - b);
    expect(units).not.toEqual(sorted);
    expect(units).not.toEqual([...sorted].reverse());
  });

  it("归一化落在 [0,1)，且只用高 24 位（两边才逐位相同）", () => {
    for (let i = 0; i < 64; i++) {
      const unit = hashUnit(pcgHash(i));
      expect(unit).toBeGreaterThanOrEqual(0);
      expect(unit).toBeLessThan(1);
      // 24 位定点：乘 2²⁴ 必须是整数，否则说明用了低位、GPU 那边会多一次舍入
      expect(Number.isInteger(unit * 16777216)).toBe(true);
    }
  });
});

describe("故障效果", () => {
  it("t=0 时整屏是纯的出场层，而且不位移", () => {
    // 位移不归零的表现是转场第一帧画面突然错位一下（同 wipeEdge 那条）
    for (let band = 0; band < GLITCH_BLOCKS; band++) {
      const v = (band + 0.5) / GLITCH_BLOCKS;
      expect(tookTo(0.42, v, 0)).toBe(false);
      expect(glitchAt(0.42, v, 0).g).toBeCloseTo(0.42, 9);
    }
  });

  it("t=1 时整屏是纯的入场层，而且不位移", () => {
    for (let band = 0; band < GLITCH_BLOCKS; band++) {
      const v = (band + 0.5) / GLITCH_BLOCKS;
      expect(tookTo(0.42, v, 1)).toBe(true);
      expect(glitchAt(0.42, v, 1).g).toBeCloseTo(0.42, 9);
    }
  });

  it("中途各条带进度不同——这正是「故障」的样子", () => {
    // 全部同时翻转就退化成硬切了。取 t=0.5 时应当两种带都有
    const took = Array.from({ length: GLITCH_BLOCKS }, (_, band) =>
      tookTo(0.5, (band + 0.5) / GLITCH_BLOCKS, 0.5),
    );
    expect(took).toContain(true);
    expect(took).toContain(false);
  });

  it("同一条带内所有 v 的行为一致，跨带才变", () => {
    // 带号用 floor(v * BLOCKS)：算错成 round 会让带边界偏半条
    const inBand = [0.001, 0.03, 0.062];
    const first = tookTo(0.5, inBand[0]!, 0.5);
    for (const v of inBand) expect(tookTo(0.5, v, 0.5)).toBe(first);
  });

  it("窗口中点附近位移最大，两端为 0", () => {
    // 找一条带，量它自己窗口内的位移。翻转时刻 = hashUnit(hash(band))*(1-window)
    const band = 3;
    const v = (band + 0.5) / GLITCH_BLOCKS;
    const flipAt = hashUnit(pcgHash(band)) * (1 - GLITCH_WINDOW);
    const shiftAt = (local: number) => glitchAt(0.5, v, flipAt + local * GLITCH_WINDOW).g - 0.5;

    expect(Math.abs(shiftAt(0))).toBeCloseTo(0, 9);
    expect(Math.abs(shiftAt(1))).toBeCloseTo(0, 9);
    // 中点幅度 = GLITCH_SHIFT × |dir|
    const dir = hashUnit(pcgHash(band + 9781)) * 2 - 1;
    expect(shiftAt(0.5)).toBeCloseTo(GLITCH_SHIFT * dir, 9);
  });

  it("位移夹在 [0,1]，不会取到纹理外", () => {
    // 夹到边缘而不是取透明：越界取透明会在每条带两侧留黑边
    for (let band = 0; band < GLITCH_BLOCKS; band++) {
      const v = (band + 0.5) / GLITCH_BLOCKS;
      for (const t of [0.2, 0.4, 0.5, 0.6, 0.8]) {
        for (const u of [0, 0.01, 0.99, 1]) {
          const g = glitchAt(u, v, t).g;
          expect(g).toBeGreaterThanOrEqual(0);
          expect(g).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("v 超出 [0,1] 时不会算出负的带号", () => {
    // 浮点误差让 v 落到 -1e-9 时，floor(v*16) = -1 → 哈希输入变成 2³²-1，
    // 那一行于是取一条完全不同的带（表现是画面最上/最下一行闪一下）
    expect(() => glitchAt(0.5, -0.001, 0.5)).not.toThrow();
    expect(tookTo(0.5, -0.001, 0.5)).toBe(tookTo(0.5, 0.001, 0.5));
    expect(tookTo(0.5, 1.001, 0.5)).toBe(tookTo(0.5, 0.999, 0.5));
  });
});

describe("故障的 GLSL 与参照实现对应", () => {
  it("哈希在 GLSL 里是整数运算，没有 sin", () => {
    // 换回 fract(sin(x)*43758.5453) 就会让 GPU-vs-CPU 断言失去意义
    expect(GLSL_CODE).toContain("747796405u");
    expect(GLSL_CODE).toContain("277803737u");
    expect(GLSL_CODE).not.toContain("sin(");
    expect(GLSL_CODE).not.toContain("43758");
  });

  it("归一化只取高 24 位", () => {
    expect(TRANSITION_FRAGMENT).toContain("h >> 8u");
    expect(TRANSITION_FRAGMENT).toContain("16777216.0");
    expect(GLSL_CODE).not.toContain("4294967296.0");
  });

  it("三个故障常量都从 uniform 读，不写死", () => {
    for (const name of ["uBlocks", "uWindow", "uShift"]) {
      expect(TRANSITION_FRAGMENT).toContain(name);
    }
    expect(GLSL_CODE).not.toContain(String(GLITCH_SHIFT));
    expect(GLSL_CODE).not.toContain(String(GLITCH_WINDOW));
  });

  it("幅度用抛物线，不用 sin", () => {
    expect(TRANSITION_FRAGMENT).toContain("4.0 * local * (1.0 - local)");
  });

  it("有 effect == 3 这条分支", () => {
    expect(TRANSITION_FRAGMENT).toContain("effect == 3");
  });
});
