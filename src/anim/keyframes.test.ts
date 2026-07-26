/**
 * 关键帧求值的单测。
 *
 * 这里锁的是三类"不会报错、只会让画面悄悄不对"的错误：
 *
 * 1. **区间外取值**。外推会让缩放冲到负数、不透明度越过 1，画面凭空翻转或消失。
 * 2. **端点归属**。关键帧那一帧本身该精确等于它的值；差一帧就是"动画晚一帧开始"，
 *    单个片段上看不出来，多个片段叠在一起就成了对不齐。
 * 3. **没打关键帧时必须原样返回 `base`**（尤其 `undefined`）。返回 `{}` 会让所有
 *    静态图层掉出合成器的恒等快路径，整体挪半个像素——见 PLAN.md 的 D9。
 *
 * 缓动的期望值是手算的：二次曲线在中点是 0.25 / 0.75 / 0.5，所以下面的断言
 * 写得出整数，不用 toBeCloseTo 掩盖问题。
 */

import { describe, expect, it } from "vitest";
import {
  ANIMATABLE_PROPERTIES,
  easeProgress,
  resolveTransform,
  valueAt,
  type Keyframe,
} from "./keyframes";

const kf = (frame: number, value: number, easing?: Keyframe["easing"]): Keyframe =>
  easing === undefined ? { frame, value } : { frame, value, easing };

describe("easeProgress", () => {
  it("两端固定：0 进 0 出，1 进 1 出", () => {
    for (const easing of ["linear", "ease-in", "ease-out", "ease-in-out"] as const) {
      expect(easeProgress(0, easing)).toBe(0);
      expect(easeProgress(1, easing)).toBe(1);
    }
  });

  it("中点的值是手算的整数，不用近似断言", () => {
    expect(easeProgress(0.5, "linear")).toBe(0.5);
    expect(easeProgress(0.5, "ease-in")).toBe(0.25); // t²
    expect(easeProgress(0.5, "ease-out")).toBe(0.75); // t(2-t)
    expect(easeProgress(0.5, "ease-in-out")).toBe(0.5);
  });

  it("ease-in 慢起、ease-out 快起，方向不能写反", () => {
    // 写反是最典型的缓动 bug，而"有缓动"这件事本身仍然成立，肉眼要盯着看才发现
    expect(easeProgress(0.25, "ease-in")).toBeLessThan(0.25);
    expect(easeProgress(0.25, "ease-out")).toBeGreaterThan(0.25);
  });

  it("ease-in-out 关于中点对称", () => {
    for (const t of [0.1, 0.25, 0.4]) {
      expect(easeProgress(t, "ease-in-out") + easeProgress(1 - t, "ease-in-out")).toBeCloseTo(1, 10);
    }
  });

  it("hold 全程保持左端值", () => {
    expect(easeProgress(0, "hold")).toBe(0);
    expect(easeProgress(0.99, "hold")).toBe(0);
  });

  it("超出 [0,1] 的进度被夹住，不外推", () => {
    expect(easeProgress(-1, "linear")).toBe(0);
    expect(easeProgress(2, "linear")).toBe(1);
    expect(easeProgress(2, "ease-in")).toBe(1);
  });

  it("不传缓动等于线性", () => {
    expect(easeProgress(0.3)).toBe(0.3);
  });
});

describe("valueAt", () => {
  it("没有关键帧返回 null——调用方据此保留静态值", () => {
    expect(valueAt([], 0)).toBeNull();
  });

  it("只有一个关键帧时全程恒定", () => {
    const one = [kf(10, 42)];
    expect(valueAt(one, 0)).toBe(42);
    expect(valueAt(one, 10)).toBe(42);
    expect(valueAt(one, 9999)).toBe(42);
  });

  it("首个关键帧之前保持首值，不往回外推", () => {
    const keys = [kf(10, 100), kf(20, 200)];
    expect(valueAt(keys, 0)).toBe(100);
    expect(valueAt(keys, 9)).toBe(100);
    expect(valueAt(keys, -50)).toBe(100);
  });

  it("末个关键帧之后保持末值，不继续外推", () => {
    const keys = [kf(10, 100), kf(20, 200)];
    expect(valueAt(keys, 20)).toBe(200);
    expect(valueAt(keys, 21)).toBe(200);
    expect(valueAt(keys, 9999)).toBe(200);
  });

  it("关键帧所在那一帧精确等于它的值", () => {
    const keys = [kf(0, 0), kf(10, 100), kf(30, 300)];
    expect(valueAt(keys, 0)).toBe(0);
    expect(valueAt(keys, 10)).toBe(100);
    expect(valueAt(keys, 30)).toBe(300);
  });

  it("区间内线性插值", () => {
    const keys = [kf(0, 0), kf(10, 100)];
    expect(valueAt(keys, 5)).toBe(50);
    expect(valueAt(keys, 1)).toBe(10);
    expect(valueAt(keys, 9)).toBe(90);
  });

  it("值可以递减，插值方向跟着反过来", () => {
    const keys = [kf(0, 100), kf(10, 0)];
    expect(valueAt(keys, 5)).toBe(50);
    expect(valueAt(keys, 2)).toBe(80);
  });

  it("三个以上关键帧时落进正确的区间", () => {
    const keys = [kf(0, 0), kf(10, 100), kf(30, 0)];
    expect(valueAt(keys, 5)).toBe(50); // 第一段升
    expect(valueAt(keys, 20)).toBe(50); // 第二段降，中点同样是 50
    expect(valueAt(keys, 25)).toBe(25);
  });

  it("缓动取的是**左端**关键帧的，不是右端的", () => {
    // 左 ease-in、右 ease-out：中点必须是 25（ease-in），不是 75
    const keys = [kf(0, 0, "ease-in"), kf(10, 100, "ease-out")];
    expect(valueAt(keys, 5)).toBe(25);
  });

  it("每段可以有不同缓动", () => {
    const keys = [kf(0, 0, "ease-in"), kf(10, 100, "linear"), kf(20, 200)];
    expect(valueAt(keys, 5)).toBe(25); // 第一段 ease-in
    expect(valueAt(keys, 15)).toBe(150); // 第二段线性
  });

  it("hold 段保持左值直到下一个关键帧那一帧才跳变", () => {
    const keys = [kf(0, 0, "hold"), kf(10, 100)];
    expect(valueAt(keys, 0)).toBe(0);
    expect(valueAt(keys, 5)).toBe(0);
    expect(valueAt(keys, 9)).toBe(0);
    expect(valueAt(keys, 10)).toBe(100); // 跳变发生在右端点上
  });

  it("同一帧上两个关键帧：后者胜，且不除零", () => {
    // 这是"跳变"的另一种写法，也兜住了升序前提被破坏时不至于算出负进度
    const keys = [kf(0, 0), kf(10, 100), kf(10, 500), kf(20, 500)];
    expect(valueAt(keys, 10)).toBe(500);
    expect(Number.isFinite(valueAt(keys, 10)!)).toBe(true);
  });

  it("负帧偏移不会让求值崩掉——裁入点后关键帧可能落到片段之前", () => {
    const keys = [kf(-20, 10), kf(0, 20), kf(20, 30)];
    expect(valueAt(keys, -30)).toBe(10);
    expect(valueAt(keys, -10)).toBe(15);
    expect(valueAt(keys, 0)).toBe(20);
  });
});

describe("resolveTransform", () => {
  it("没有关键帧通道时原样返回 base，包括 undefined", () => {
    // 关键：返回 undefined 才会走合成器的恒等快路径（D9），返回 {} 会让所有
    // 静态图层集体掉出快路径
    expect(resolveTransform(undefined, undefined, 0)).toBeUndefined();
    expect(resolveTransform(undefined, {}, 0)).toBeUndefined();
    expect(resolveTransform(undefined, { x: [] }, 0)).toBeUndefined();
    const base = { x: 10 };
    expect(resolveTransform(base, {}, 0)).toBe(base); // 同一个引用，没有多造对象
  });

  it("有关键帧的属性用求值结果覆盖静态值", () => {
    const out = resolveTransform({ x: 999 }, { x: [kf(0, 0), kf(10, 100)] }, 5);
    expect(out).toEqual({ x: 50 });
  });

  it("没打关键帧的属性保留静态值", () => {
    const out = resolveTransform(
      { x: 999, opacity: 0.5 },
      { x: [kf(0, 0), kf(10, 100)] },
      5,
    );
    expect(out).toEqual({ x: 50, opacity: 0.5 });
  });

  it("base 为空时只产出被动画的属性", () => {
    const out = resolveTransform(undefined, { opacity: [kf(0, 0), kf(10, 1)] }, 5);
    expect(out).toEqual({ opacity: 0.5 });
  });

  it("多个属性各自独立求值", () => {
    const out = resolveTransform(
      undefined,
      {
        x: [kf(0, 0), kf(10, 100)],
        scaleX: [kf(0, 1), kf(20, 2)],
        rotation: [kf(0, 0, "hold"), kf(10, Math.PI)],
      },
      5,
    );
    expect(out).toEqual({ x: 50, scaleX: 1.25, rotation: 0 });
  });

  it("不改动传入的 base 对象", () => {
    const base = { x: 1, y: 2 };
    resolveTransform(base, { x: [kf(0, 0), kf(10, 100)] }, 5);
    expect(base).toEqual({ x: 1, y: 2 });
  });

  it("六个可动画属性全都接得住", () => {
    const channels = Object.fromEntries(
      ANIMATABLE_PROPERTIES.map((p) => [p, [kf(0, 0), kf(10, 10)]]),
    );
    const out = resolveTransform(undefined, channels, 5)!;
    for (const property of ANIMATABLE_PROPERTIES) {
      expect(out[property]).toBe(5);
    }
  });
});
