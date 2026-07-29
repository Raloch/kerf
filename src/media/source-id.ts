/**
 * 生成素材 id。
 *
 * ## 为什么不能用模块级递增计数器
 *
 * `let seq = 0; id = \`src-${++seq}\`` 看着够用，实际上**在崩溃恢复之后会撞 id**：
 * 计数器随页面加载重置回 0，而恢复回来的 `Timeline.sources` 里带着上一次会话的
 * `src-1` / `src-2`。于是恢复完再导入一个素材，它拿到的是 `src-1`——`addSource()`
 * 那道"这个素材已经在项目里了"当场把它拒掉，而用户导入的明明是个新文件。
 *
 * 这个坑在把导入从"载入"改成"追加"之前是**看不见**的：那时每次导入都把整条时间轴
 * 换掉、`sources` 永远只有一个，撞了也没人发现。实测就是这么撞出来的（导入两张图 →
 * 刷新 → 恢复 → 再导入一张 GIF → "已经在项目里了"）。
 *
 * 所以 id 必须**跨会话唯一**。`crypto.randomUUID()` 在主线程和 Worker 里都有，
 * 而且它会进快照——随机值在那里完全没问题（id 只用来相互引用，不需要可读或有序）。
 * 留一个可读前缀纯粹是为了看日志时能一眼分清是哪类素材。
 */

/** `av` / `audio` 素材。 */
export function newSourceId(): string {
  return `src-${uuid()}`;
}

/** 图片素材。前缀不同只为可读，两者共用同一个命名空间。 */
export function newImageSourceId(): string {
  return `src-img-${uuid()}`;
}

function uuid(): string {
  // `randomUUID` 只在安全上下文里有，而 WebCodecs / OPFS 也都要求安全上下文，
  // 所以走到这里时它必然存在。仍然留一条退路：撞 id 的代价是导入被拒，
  // 而"这个浏览器没有 randomUUID"不该让导入直接不可用
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
