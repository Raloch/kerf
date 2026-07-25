/**
 * 撤销栈：快照式，不是命令模式。
 *
 * PLAN.md §2 原本写的是"命令模式（每个操作实现 do/undo 一对）"，实现时改成快照栈：
 * 编辑操作已经是纯函数（`operations.ts`），且状态经 Immer 产出，未修改的子树共享引用，
 * 所以"存一份完整 Timeline"的实际内存开销只有被改动的那几个节点。
 * 命令模式要为每个操作额外写一遍反向逻辑，是双倍代码量和双倍出错面，
 * 换来的内存收益在这里并不存在。决策记录见 PLAN.md M1 小节。
 *
 * 两个必须有的行为：
 * - **合并**：一次拖拽会产生几十次状态变更，不合并的话用户要按几十次 ⌘Z 才能退回去。
 * - **容量上限**：长时间编辑不能让快照无限堆积。
 */

export interface HistoryEntry<T> {
  readonly state: T;
  /** 给 UI 显示"撤销 移动片段"用。 */
  readonly label: string;
}

export interface History<T> {
  readonly present: HistoryEntry<T>;
  readonly past: readonly HistoryEntry<T>[];
  readonly future: readonly HistoryEntry<T>[];
  /** 上一次提交的合并键与时间戳，用于判断能否合并。 */
  readonly lastKey: string | null;
  readonly lastAt: number;
  readonly limit: number;
}

export const DEFAULT_HISTORY_LIMIT = 200;
/** 同一合并键在这个窗口内的连续提交会被合并成一步。 */
export const COALESCE_WINDOW_MS = 600;

export function initHistory<T>(state: T, label = "初始状态", limit = DEFAULT_HISTORY_LIMIT): History<T> {
  return {
    present: { state, label },
    past: [],
    future: [],
    lastKey: null,
    lastAt: -Infinity,
    limit,
  };
}

export interface CommitOptions {
  readonly label: string;
  /**
   * 合并键。相同键且在时间窗口内的连续提交会替换栈顶而不是新增一条。
   * 拖拽用 `move:${clipId}` 这类带对象标识的键——不带标识会把"拖 A"和"拖 B"错误地合并。
   * 传 null 表示这一步不可合并（切分、删除这类离散操作）。
   */
  readonly coalesceKey?: string | null;
  /** 当前时间戳。显式传入而不是内部调 Date.now()，这样单测可控。 */
  readonly at?: number;
  readonly windowMs?: number;
}

/**
 * 提交一个新状态。
 *
 * 提交会清空 future——这是撤销栈的标准语义：撤销几步后再做新编辑，
 * 原来的"重做"分支就作废了。
 */
export function commit<T>(history: History<T>, next: T, options: CommitOptions): History<T> {
  const at = options.at ?? 0;
  const windowMs = options.windowMs ?? COALESCE_WINDOW_MS;
  const key = options.coalesceKey ?? null;

  const canCoalesce =
    key !== null &&
    history.lastKey === key &&
    at - history.lastAt <= windowMs &&
    history.future.length === 0;

  if (canCoalesce) {
    // 合并：只替换当前状态，不往 past 里压新条目
    return {
      ...history,
      present: { state: next, label: options.label },
      lastAt: at,
    };
  }

  const past = [...history.past, history.present];
  // 超出容量时丢弃最老的快照。丢的是"能撤到多远"，不是当前状态，安全。
  const trimmed = past.length > history.limit ? past.slice(past.length - history.limit) : past;

  return {
    present: { state: next, label: options.label },
    past: trimmed,
    future: [],
    lastKey: key,
    lastAt: at,
    limit: history.limit,
  };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (!previous) return history;
  return {
    ...history,
    present: previous,
    past: history.past.slice(0, -1),
    future: [history.present, ...history.future],
    // 撤销后清掉合并键：撤销之后紧接着的编辑不应该被合并进撤销前那一步
    lastKey: null,
    lastAt: -Infinity,
  };
}

export function redo<T>(history: History<T>): History<T> {
  const next = history.future[0];
  if (!next) return history;
  return {
    ...history,
    present: next,
    past: [...history.past, history.present],
    future: history.future.slice(1),
    lastKey: null,
    lastAt: -Infinity,
  };
}

/** 当前状态。 */
export function current<T>(history: History<T>): T {
  return history.present.state;
}

/** 给 UI 的撤销/重做提示文案，例如「撤销 移动片段」。 */
export function undoLabel<T>(history: History<T>): string | null {
  return canUndo(history) ? history.present.label : null;
}

export function redoLabel<T>(history: History<T>): string | null {
  return history.future[0]?.label ?? null;
}
