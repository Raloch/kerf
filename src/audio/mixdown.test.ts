/**
 * `channelsAreMovable` 的单测。
 *
 * 这个判断决定混音结果是**直接把所有权交给 Worker**还是先拷一份。判错的代价
 * 不对称：判"不能搬"只是多占一份内存（30 分钟立体声 660MB），判"能搬"而实际
 * 不能，会在 `postMessage` 那一行抛 DataCloneError，**整次导出失败**。
 *
 * 所以这里锁的是两个前提各自的反例——真正的 `AudioBuffer` 在 node 里造不出来，
 * 但这段判断只看 TypedArray 的形状，用普通 Float32Array 就能把两条都摆出来。
 */

import { describe, expect, it } from "vitest";
import { channelsAreMovable } from "./mixdown";

/** 造一个整块独占自己 ArrayBuffer 的声道，就像 getChannelData() 实测返回的那样。 */
const whole = (length: number) => new Float32Array(length);

describe("channelsAreMovable", () => {
  it("各声道整块独占自己的 buffer → 可以搬", () => {
    expect(channelsAreMovable([whole(1024), whole(1024)])).toBe(true);
  });

  it("单声道也可以搬", () => {
    expect(channelsAreMovable([whole(48_000)])).toBe(true);
  });

  it("共用一个 buffer → 不能搬（transfer 列表会出现重复项，postMessage 直接抛）", () => {
    const shared = new ArrayBuffer(1024 * 4 * 2);
    const a = new Float32Array(shared, 0, 1024);
    const b = new Float32Array(shared, 1024 * 4, 1024);
    expect(channelsAreMovable([a, b])).toBe(false);
    // 第二个声道单看是"偏移不为 0"，第一个声道单看**完全正常**——
    // 所以只检查偏移是不够的，必须真的去比 buffer 身份
    expect(a.byteOffset).toBe(0);
  });

  it("同一个数组被列了两次 → 不能搬（同样是重复项）", () => {
    const a = whole(1024);
    expect(channelsAreMovable([a, a])).toBe(false);
  });

  it("是子视图（偏移不为 0）→ 不能搬，会连带把整块搬走", () => {
    const backing = new ArrayBuffer(1024 * 4);
    const view = new Float32Array(backing, 16, 8);
    expect(channelsAreMovable([view])).toBe(false);
  });

  it("偏移为 0 但 buffer 比视图长 → 不能搬，后面那截不属于这个声道", () => {
    const backing = new ArrayBuffer(1024 * 4);
    const view = new Float32Array(backing, 0, 8);
    expect(channelsAreMovable([view])).toBe(false);
  });
});
