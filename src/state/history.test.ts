import { describe, expect, it } from "vitest";
import {
  canRedo,
  canUndo,
  commit,
  current,
  initHistory,
  redo,
  redoLabel,
  undo,
  undoLabel,
  type History,
} from "./history";

const step = (h: History<number>, value: number, key: string | null, at = 0) =>
  commit(h, value, { label: `设为 ${value}`, coalesceKey: key, at });

describe("撤销栈基础", () => {
  it("初始状态不能撤销也不能重做", () => {
    const h = initHistory(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(current(h)).toBe(0);
  });

  it("提交后可撤销，撤销回到上一状态", () => {
    let h = initHistory(0);
    h = step(h, 1, null);
    h = step(h, 2, null);
    expect(current(h)).toBe(2);

    h = undo(h);
    expect(current(h)).toBe(1);
    h = undo(h);
    expect(current(h)).toBe(0);
    expect(canUndo(h)).toBe(false);
  });

  it("重做沿原路返回", () => {
    let h = initHistory(0);
    h = step(h, 1, null);
    h = step(h, 2, null);
    h = undo(h);
    h = undo(h);
    expect(canRedo(h)).toBe(true);

    h = redo(h);
    expect(current(h)).toBe(1);
    h = redo(h);
    expect(current(h)).toBe(2);
    expect(canRedo(h)).toBe(false);
  });

  it("撤销后的新提交作废重做分支", () => {
    let h = initHistory(0);
    h = step(h, 1, null);
    h = step(h, 2, null);
    h = undo(h); // 回到 1
    h = step(h, 99, null);

    expect(current(h)).toBe(99);
    expect(canRedo(h)).toBe(false);
    h = undo(h);
    expect(current(h)).toBe(1);
  });

  it("撤销到底再撤销是空操作，不抛错", () => {
    let h = initHistory(0);
    h = undo(h);
    h = undo(h);
    expect(current(h)).toBe(0);
    expect(redo(redo(h))).toEqual(h);
  });
});

describe("合并（连续拖拽只算一步）", () => {
  it("同键同窗口内的连续提交合并成一步", () => {
    let h = initHistory(0);
    // 模拟一次拖拽产生的 5 次中间状态
    for (let i = 1; i <= 5; i++) h = step(h, i, "move:a", i * 10);

    expect(current(h)).toBe(5);
    // 关键：只需按一次撤销就回到拖拽前
    h = undo(h);
    expect(current(h)).toBe(0);
    expect(canUndo(h)).toBe(false);
  });

  it("超出时间窗口后不再合并", () => {
    let h = initHistory(0);
    h = step(h, 1, "move:a", 0);
    h = step(h, 2, "move:a", 5000); // 远超 600ms 窗口
    h = undo(h);
    expect(current(h)).toBe(1);
  });

  it("不同对象的拖拽不会互相合并", () => {
    let h = initHistory(0);
    h = step(h, 1, "move:a", 0);
    h = step(h, 2, "move:b", 10); // 换了片段
    h = undo(h);
    expect(current(h)).toBe(1);
  });

  it("coalesceKey 为 null 的操作永不合并", () => {
    let h = initHistory(0);
    h = step(h, 1, null, 0);
    h = step(h, 2, null, 1); // 时间上紧邻但不可合并
    h = undo(h);
    expect(current(h)).toBe(1);
  });

  it("撤销之后紧接的同键编辑不会被合并进撤销前那一步", () => {
    let h = initHistory(0);
    h = step(h, 1, "move:a", 0);
    h = undo(h); // 回到 0
    h = step(h, 7, "move:a", 10); // 时间窗口内、同键
    // 若错误合并，这里撤销会跳过 7 直接到 0 之前
    h = undo(h);
    expect(current(h)).toBe(0);
  });

  it("有重做分支时不合并（否则会悄悄吃掉重做）", () => {
    let h = initHistory(0);
    h = step(h, 1, "move:a", 0);
    h = step(h, 2, "other", 100);
    h = undo(h); // future 里有东西了
    h = step(h, 3, "move:a", 110);
    h = undo(h);
    expect(current(h)).toBe(1);
  });
});

describe("容量上限", () => {
  it("超出上限丢弃最老快照，当前状态不受影响", () => {
    let h = initHistory(0, "初始", 3);
    for (let i = 1; i <= 10; i++) h = step(h, i, null, i);

    expect(current(h)).toBe(10);
    expect(h.past).toHaveLength(3);

    // 只能撤回 3 步
    h = undo(h);
    h = undo(h);
    h = undo(h);
    expect(current(h)).toBe(7);
    expect(canUndo(h)).toBe(false);
  });
});

describe("UI 文案", () => {
  it("给出可撤销/可重做的操作名", () => {
    let h = initHistory(0);
    expect(undoLabel(h)).toBeNull();

    h = commit(h, 1, { label: "移动片段", coalesceKey: null });
    expect(undoLabel(h)).toBe("移动片段");

    h = undo(h);
    expect(redoLabel(h)).toBe("移动片段");
    expect(undoLabel(h)).toBeNull();
  });
});
