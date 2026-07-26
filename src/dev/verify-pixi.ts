/**
 * PixiJS spike 的主线程驱动——把 Worker 量到的数字变成断言。
 *
 * 这不是第四个"回归自检"，它验的是**换渲染后端之前必须成立的前提**。
 * M2 的滤镜和 shader 转场要 GPU，而合成器同时被预览（主线程）和导出（Worker）
 * 依赖；这些前提里任何一条不成立，M2 的图层模型就得换个设计。所以它跑在
 * 写 M2 功能代码之前，而不是之后。
 *
 * 断言逻辑放在主线程而不是 Worker 里，是为了让"我们到底在要求什么"集中可读；
 * Worker 只负责跑和量（见 `verify-pixi.worker.ts` 的文件头）。
 */

import { hueDistance } from "./measure";
import type { Check } from "./verify-m0";
import type { PixiProbeReport, PixiProbeResponse } from "./verify-pixi.worker";

/** Worker 里要起渲染器、编两遍、再解两遍，慢机器上给足时间。 */
const TIMEOUT_MS = 180_000;

/** 两个后端的留边允许差的像素数。0 最好，但 GPU 采样和 drawImage 的取整未必一致。 */
const BAND_TOLERANCE_PX = 1;
/** 编码经过 YUV 4:2:0 往返，纯色块的色相偏移应该远小于这个数。 */
const HUE_TOLERANCE_DEG = 12;
/** 两个后端之间的色彩差——比上面严，因为输入完全相同，只有光栅化路径不同。 */
const BACKEND_HUE_TOLERANCE_DEG = 8;
/** Pixi 比 Canvas2D 慢多少算倒退。首次上 GPU 有固定开销，留 1.5 倍。 */
const SLOWDOWN_LIMIT = 1.5;

export interface PixiVerifyResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
  readonly report: PixiProbeReport;
  readonly elapsedMs: number;
}

function check(name: string, expected: string, actual: string, pass: boolean): Check {
  return { name, expected, actual, pass };
}

function runProbeWorker(): Promise<PixiProbeReport> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./verify-pixi.worker.ts", import.meta.url), {
      type: "module",
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`spike 超时（${TIMEOUT_MS / 1000} 秒）——Worker 里的渲染器可能卡在初始化`));
    }, TIMEOUT_MS);

    const finish = (fn: () => void) => {
      clearTimeout(timer);
      worker.terminate();
      fn();
    };

    worker.onmessage = (event: MessageEvent<PixiProbeResponse>) => {
      const message = event.data;
      if (message.type === "done") finish(() => resolve(message.report));
      else finish(() => reject(new Error(message.message)));
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "spike Worker 启动失败")));
    };

    worker.postMessage("start");
  });
}

export async function verifyPixiBackend(): Promise<PixiVerifyResult> {
  const startedAt = performance.now();
  const report = await runProbeWorker();
  const checks: Check[] = [];

  // ---- 1. Worker 里起得来，而且真的是 WebGL2 ----
  checks.push(
    check(
      "Worker 里起得来渲染器，且锁在 WebGL2",
      "WebGL 2.x",
      report.contextVersion,
      /WebGL 2/i.test(report.contextVersion),
    ),
  );

  // ---- 2. 纹理复用 ----
  const { afterFirstFrame, afterLastFrame } = report.textures;
  checks.push(
    check(
      `GPU 纹理数不随帧数增长（跑了 ${report.frameCount} 帧）`,
      `第 1 帧与第 ${report.frameCount} 帧相同`,
      `${afterFirstFrame} → ${afterLastFrame}`,
      afterFirstFrame > 0 && afterFirstFrame === afterLastFrame,
    ),
  );

  // ---- 3. Pixi 画布 → 编码器 → 读回，不是黑的 ----
  const darkest = Math.min(...report.frames.map((f) => f.pixi.maxChannel));
  checks.push(
    check(
      "Pixi 渲染的画面被编码器正确捕获（读回不是黑帧）",
      "> 32",
      String(darkest),
      darkest > 32,
    ),
  );

  // ---- 4. drawing buffer 跨 task 存活 ----
  checks.push(
    check(
      "跨 task 后画布内容仍在（preserveDrawingBuffer 生效）",
      "内容仍在",
      report.drawingBuffer.survivedTaskBoundary
        ? `仍在，最大通道 ${report.drawingBuffer.maxChannel}`
        : `已被清空，最大通道 ${report.drawingBuffer.maxChannel}`,
      report.drawingBuffer.survivedTaskBoundary,
    ),
  );

  // ---- 5. 上下文丢失要报错，不能静默出黑帧 ----
  checks.push(
    check(
      "GL 上下文丢失后 composeFrame 抛错，而不是静默出黑帧",
      "抛错",
      report.contextLoss.extensionAvailable
        ? report.contextLoss.detail
        : "无法测试：浏览器不提供 WEBGL_lose_context",
      report.contextLoss.extensionAvailable && report.contextLoss.threwAfterLoss,
    ),
  );

  // ---- 6. 取到的确实是对应帧（色相编码帧号）----
  let worstHue = 0;
  let worstHueFrame = -1;
  for (const frame of report.frames) {
    const delta = hueDistance(frame.pixi.hue, frame.expectedHue);
    if (delta > worstHue) {
      worstHue = delta;
      worstHueFrame = frame.index;
    }
  }
  checks.push(
    check(
      "Pixi 画出的是正确的那一帧（色相编码帧号）",
      `≤ ${HUE_TOLERANCE_DEG}°`,
      `最差第 ${worstHueFrame} 帧，差 ${worstHue}°`,
      worstHue <= HUE_TOLERANCE_DEG,
    ),
  );

  // ---- 7. 两个后端的留边几何 ----
  let worstBand = 0;
  for (const frame of report.frames) {
    worstBand = Math.max(
      worstBand,
      Math.abs(frame.pixi.top - frame.canvas2d.top),
      Math.abs(frame.pixi.bottom - frame.canvas2d.bottom),
    );
  }
  checks.push(
    check(
      "两个后端的留边几何一致（换后端不改构图）",
      `≤ ${BAND_TOLERANCE_PX}px`,
      `${worstBand}px`,
      worstBand <= BAND_TOLERANCE_PX,
    ),
  );
  checks.push(
    check(
      "确实产生了留边（方形输出 + 16:9 源片）",
      "> 0",
      `${report.frames[0]?.pixi.top ?? 0}px`,
      (report.frames[0]?.pixi.top ?? 0) > 0 && (report.frames[0]?.pixi.bottom ?? 0) > 0,
    ),
  );

  // ---- 8. 两个后端的色彩 ----
  let worstBackendHue = 0;
  for (const frame of report.frames) {
    worstBackendHue = Math.max(worstBackendHue, hueDistance(frame.pixi.hue, frame.canvas2d.hue));
  }
  checks.push(
    check(
      "两个后端的画面色彩一致（换后端不改颜色）",
      `≤ ${BACKEND_HUE_TOLERANCE_DEG}°`,
      `${worstBackendHue}°`,
      worstBackendHue <= BACKEND_HUE_TOLERANCE_DEG,
    ),
  );

  // ---- 9. 吞吐 ----
  // 用 720p 那组，不用上面 320×320 的：小画布上每帧固定开销占比过高，
  // 拿它的比值下结论会把 Pixi 判得过重
  const { perf } = report;
  const ratio = perf.pixiMs / Math.max(1, perf.canvas2dMs);
  const perFramePixi = perf.pixiMs / perf.frames;
  const perFrameCanvas = perf.canvas2dMs / perf.frames;
  checks.push(
    check(
      `${perf.width}×${perf.height} 整段（合成 + 捕获 + 编码）耗时相对 Canvas2D 没有倒退`,
      `≤ ${SLOWDOWN_LIMIT}×`,
      `${ratio.toFixed(2)}× · 每帧 Pixi ${perFramePixi.toFixed(1)}ms / Canvas2D ${perFrameCanvas.toFixed(1)}ms`,
      ratio <= SLOWDOWN_LIMIT,
    ),
  );
  // 不是断言，是记账：知道这个选项要多少钱，才谈得上要不要换掉它
  const preserveCost = perf.pixiMs - perf.pixiNoPreserveMs;
  checks.push(
    check(
      "preserveDrawingBuffer 的开销不构成换掉它的理由",
      "< 25%",
      `${((preserveCost / Math.max(1, perf.pixiNoPreserveMs)) * 100).toFixed(0)}% · 每帧 ${(preserveCost / perf.frames).toFixed(2)}ms`,
      preserveCost / Math.max(1, perf.pixiNoPreserveMs) < 0.25,
    ),
  );

  return {
    checks,
    passed: checks.every((c) => c.pass),
    report,
    elapsedMs: performance.now() - startedAt,
  };
}
