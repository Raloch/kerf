/**
 * 留边几何与图层变换的单测。
 *
 * 这两组数是**手算的**，不是拿被测函数算出来再回填的——期望值来自被测代码就等于
 * 只断言"函数没变过"，改错了照样绿。所以下面每个用例的注释都写出算式。
 *
 * 为什么值得单测：`containRect` 是留边几何的唯一来源，`placeLayer` 是变换语义的
 * 唯一来源，两个后端都从这里取数。它们错了不会报错——只会让成片构图偏掉，
 * 而"预览 / 导出一致性自检"两条路径用的是同一份错数，抓不到。
 */

import { describe, expect, it } from "vitest";
import { containRect, isDefaultGeometry, placeLayer } from "./compositor";

describe("containRect", () => {
  it("16:9 源片进方形画布：按宽度贴满，上下留边", () => {
    // 640×360 → 320×320：scale = min(320/640, 320/360) = 0.5
    // 画面 320×180，上下各留 (320-180)/2 = 70
    expect(containRect(640, 360, 320, 320)).toEqual({ dx: 0, dy: 70, width: 320, height: 180 });
  });

  it("竖屏源片进方形画布：按高度贴满，左右留边", () => {
    // 1080×1920 → 320×320：scale = min(320/1080, 320/1920) = 0.16666…
    // 画面 180×320，左右各留 70
    const rect = containRect(1080, 1920, 320, 320)!;
    expect(rect.dy).toBe(0);
    expect(rect.height).toBe(320);
    expect(rect.width).toBeCloseTo(180, 10);
    expect(rect.dx).toBeCloseTo(70, 10);
  });

  it("比例相同时铺满，不留边", () => {
    expect(containRect(1920, 1080, 640, 360)).toEqual({ dx: 0, dy: 0, width: 640, height: 360 });
  });

  it("源片尺寸非法时返回 null，而不是零尺寸矩形", () => {
    // 零尺寸矩形会让调用方画出一个不可见但仍占 draw call 的图层
    expect(containRect(0, 360, 320, 320)).toBeNull();
    expect(containRect(640, 0, 320, 320)).toBeNull();
    expect(containRect(-1, 360, 320, 320)).toBeNull();
  });
});

describe("isDefaultGeometry", () => {
  it("没有变换、空变换、以及各项都是默认值时都算没动几何", () => {
    expect(isDefaultGeometry(undefined)).toBe(true);
    expect(isDefaultGeometry({})).toBe(true);
    expect(isDefaultGeometry({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 })).toBe(true);
  });

  it("只改不透明度仍然算没动几何——它不该把图层踢出快路径", () => {
    expect(isDefaultGeometry({ opacity: 0.5 })).toBe(true);
  });

  it("位移、缩放、旋转任意一项非默认就不算", () => {
    expect(isDefaultGeometry({ x: 1 })).toBe(false);
    expect(isDefaultGeometry({ y: -1 })).toBe(false);
    expect(isDefaultGeometry({ scaleX: 1.0001 })).toBe(false);
    expect(isDefaultGeometry({ scaleY: 0.5 })).toBe(false);
    expect(isDefaultGeometry({ rotation: 0.0001 })).toBe(false);
  });
});

describe("placeLayer", () => {
  /** 16:9 进方形：320×180 @ (0,70)，中心 (160,160)。下面所有用例都基于它。 */
  const fit = containRect(640, 360, 320, 320)!;

  it("不给变换时就是默认留边位置，中心在画布中心", () => {
    expect(placeLayer(fit)).toEqual({
      centerX: 160,
      centerY: 160,
      width: 320,
      height: 180,
      rotation: 0,
      opacity: 1,
    });
  });

  it("缩放是相对默认尺寸的倍数，且绕中心缩——中心不动", () => {
    // 320×180 的一半 = 160×90，中心仍在 (160,160)
    const p = placeLayer(fit, { scaleX: 0.5, scaleY: 0.5 });
    expect(p.width).toBe(160);
    expect(p.height).toBe(90);
    expect(p.centerX).toBe(160);
    expect(p.centerY).toBe(160);
  });

  it("位移是输出像素，叠加在默认中心上", () => {
    // 中心 (160,160) + (40,-30) = (200,130)
    const p = placeLayer(fit, { x: 40, y: -30 });
    expect(p.centerX).toBe(200);
    expect(p.centerY).toBe(130);
    // 位移不改尺寸
    expect(p.width).toBe(320);
    expect(p.height).toBe(180);
  });

  it("缩放和位移同时给：先按默认中心缩，再整体挪", () => {
    // 画中画拖到右下角的典型用法：缩到 1/4，中心挪到 (240,240)
    const p = placeLayer(fit, { scaleX: 0.25, scaleY: 0.25, x: 80, y: 80 });
    expect(p).toEqual({
      centerX: 240,
      centerY: 240,
      width: 80,
      height: 45,
      rotation: 0,
      opacity: 1,
    });
  });

  it("旋转原样透传，不参与位置计算——绕中心转由后端实现", () => {
    const p = placeLayer(fit, { rotation: Math.PI / 2 });
    expect(p.rotation).toBe(Math.PI / 2);
    expect(p.centerX).toBe(160);
    expect(p.centerY).toBe(160);
  });

  it("不透明度默认 1，给了就透传", () => {
    expect(placeLayer(fit).opacity).toBe(1);
    expect(placeLayer(fit, { opacity: 0 }).opacity).toBe(0);
    expect(placeLayer(fit, { opacity: 0.35 }).opacity).toBe(0.35);
  });

  it("恒等变换的左上角要精确回到 containRect 的位置", () => {
    // 后端的快路径依赖这条：中心 - 半宽 必须等于 rect.dx，否则"没用变换的项目
    // 画面一个像素都不变"就不成立（这也是为什么快路径不走 translate）
    const p = placeLayer(fit, {});
    expect(p.centerX - p.width / 2).toBe(fit.dx);
    expect(p.centerY - p.height / 2).toBe(fit.dy);
  });
});
