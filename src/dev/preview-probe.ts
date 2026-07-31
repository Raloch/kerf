/**
 * 从预览引擎取一帧下来量——**两条自检共用的那一处**。
 *
 * ## 为什么不能直接 `await renderFrame()` 然后量
 *
 * `renderFrame` 内部对 seek 有一个 **400ms 的兜底**（`preview-engine.ts` 的 `seekTo`：
 * 素材还在加载时 `seeked` 事件可能不来，不兜底就会把界面永久挂住）。产品里那是对的
 * ——超时之后画一帧稍旧的画面是可接受的降级，下一次 rAF 会修正。
 *
 * 但**自检拿它当"画面已经就绪"的判据就不行**：真机上第一次 seek 一个刚创建的
 * video 元素**超过 400ms**，于是量到的是**空画布**。而空画布的读数是"四边留白各等于
 * 整个画布"（方形 320 输出上是 `320/320/320/320`），它长得**像"预览把摆位算错了"**。
 *
 * iPhone 17 / iOS 26 实测（2026-07-30）：预览一致性自检红 **10 条**，包括「上黑边高度
 * 一致」「裁剪后留边逐条相同」「带关键帧时的摆位落在手算的位置上」，而**导出侧全部
 * 正确**；多片段自检也红 1 条（帧 139 预览与导出色相差 **31°**，而 31 恰好等于上一个
 * 取样帧到这一帧的色相差——预览侧拿到的是**上一次**那张画面）。
 *
 * 三个交叉证据把根因钉在 seek 上，而不是合成或摆位：
 * - **文字层和图片层那几条全绿**——它们不走 `<video>` 元素
 * - **两分钟后跑的多片段自检预览侧几乎全对**——素材已经解码过一次，seek 快得多
 * - 桌面 Chrome 上把那个兜底**注入成 1ms**，26/26 当场掉到 **15/26** 且读数一字不差
 *   （`预览 320/320/320/320`）。那条注入从此就是这个缺陷的回归护栏
 *
 * ## 判据是"我要测的东西在那儿了"，不是"等够了没有"
 *
 * 所以这里不是把 400ms 调大——那只是换一个会在更慢的设备上再次失效的常量，而失效
 * 形态一模一样（同那条"容差定不下来的时候先怀疑量法"）。判据换成**画布上真的有
 * 内容**，没有就重画。推论：它**只能用在期望有内容的帧上**，空档帧本来就该是纯黑，
 * 那种帧要走 `expectBlank`。
 *
 * 重画是便宜的：`seekTo` 对"已经停在那儿了"有一条快路径，而 video 元素的 seek 在这
 * 期间是在后台继续走的，所以第二次 `renderFrame` 通常直接就把已就绪的那一帧画出来。
 *
 * ## 它保证"不是空画布"，**不保证"是对的那一帧"**——而这个边界补不上
 *
 * 判据是"非黑"，所以 seek 落在**别的位置**时它一样满足（画面是上一次那张，非黑）。
 * 补这一半就得知道"这一帧该是什么色相"，而**色相编码源片帧号正是被测对象**——
 * 拿它当重画判据会让那些断言恒成立（同 D46 那条"不许调 `containRect()` 当期望值"）。
 *
 * 所以分工是：这里消掉**空画布**那一类，"取错帧"交给调用方的色相断言，而它们判得出来。
 * 1ms 注入实验同时验了两半：修之前预览一致性 26/26 → **15/26**、形态是空画布
 * （`320/320/320/320`）；修之后 **27/27**（注入仍在生效），而多片段自检在同样的注入下
 * 红 3 条、形态换成了**色相差 48°/30°**——那是"画的是上一帧"，一句真话。
 * 真机上的形态是**前者**（video 元素刚建、还没解出任何画面，所以全黑），1ms 注入
 * 比它更极端：那让**每一次** seek 都超时，而真机只有首次慢。
 */

import { measure, type MeasureRegion } from "./measure";
import type { PreviewEngine } from "../preview/preview-engine";
import type { Timeline } from "../edl/types";

/**
 * "算画出来了"的最大通道下限。
 *
 * 24 = 判纯黑用的那个阈值（H.264 有损压缩后纯黑不会正好是 0，而预览这一侧是无损
 * 画布，所以这里其实很宽松）。语义是"超过纯黑的噪声地板"，不是"画得对不对"——
 * 对不对由调用方那些断言去判，这里只回答"还是不是一张空画布"。
 */
const PAINTED_MIN_CHANNEL = 24;
/** 最多重画几次。10 × 200ms = 2 秒上限，比真机上实测的首次 seek 耗时留足余量。 */
const PAINT_RETRIES = 10;
const PAINT_RETRY_MS = 200;

export interface PreviewProbe {
  /** 画好的那一帧，已经 drawImage 到一张干净的 2D 画布上（引擎画布是 WebGL 的）。 */
  readonly ctx: CanvasRenderingContext2D;
  /**
   * 重画了几次才有内容。0 = 第一次就有。
   *
   * **要报出来**：它是"这台设备的 seek 有多慢"的直接读数，而那正是这条量法存在的
   * 理由。桌面上恒为 0，真机上非 0——悄悄重试成功等于把这个事实藏起来（同那条
   * "只报峰值不报位置等于没报"）。
   */
  readonly attempts: number;
  /** 重画到上限仍然是空画布。那时断言该照常红，但报告里要能分清是哪一种红。 */
  readonly blank: boolean;
}

export async function probePreviewFrame(
  engine: PreviewEngine,
  timeline: Timeline,
  frame: number,
  size: number,
  options?: {
    readonly expectBlank?: boolean;
    /**
     * 在**这一块**上判"画出来了没有"，缺省是整幅。
     *
     * 必须能限定范围，否则判据会被**别的图层**满足：文字那一节的画面里文字是纯色
     * 实心块，整幅一测就非黑，于是视频背景还没画出来就返回了——那一节的「有文字时
     * 背景区的主色调仍然一致」照样假红（注入实验当场抓到，实测 93）。同那条
     * "给自检选取样区时要先问这块里除了被测对象还有什么"。
     */
    readonly paintedRegion?: MeasureRegion;
  },
): Promise<PreviewProbe> {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("探测画布没有 2D 上下文");

  for (let attempts = 0; ; attempts++) {
    await engine.renderFrame(timeline, frame);
    ctx.drawImage(engine.canvas as CanvasImageSource, 0, 0);
    // 空档帧本来就该是纯黑，重画一万次也还是纯黑——那不是"没画出来"
    if (options?.expectBlank) return { ctx, attempts, blank: false };
    const painted = options?.paintedRegion
      ? measure(ctx, size, size, options.paintedRegion)
      : measure(ctx, size, size);
    if (painted.maxChannel > PAINTED_MIN_CHANNEL) return { ctx, attempts, blank: false };
    if (attempts >= PAINT_RETRIES) return { ctx, attempts, blank: true };
    await new Promise((resolve) => setTimeout(resolve, PAINT_RETRY_MS));
  }
}

/** 一轮自检里所有取样帧的重画情况，汇总成一条诊断读数。 */
export function summarizeAttempts(probes: readonly PreviewProbe[]): string {
  const retried = probes.filter((p) => p.attempts > 0);
  const blank = probes.filter((p) => p.blank).length;
  const worst = probes.reduce((max, p) => Math.max(max, p.attempts), 0);
  if (retried.length === 0) return `${probes.length} 帧全部一次画出`;
  return (
    `${retried.length}/${probes.length} 帧要重画（最多 ${worst} 次）` +
    (blank > 0 ? ` · ${blank} 帧到上限仍是空画布` : "")
  );
}
