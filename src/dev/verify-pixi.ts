/**
 * PixiJS spike 的主线程驱动——把 Worker 量到的数字变成断言。
 *
 * 这一组最初不是"回归自检"，验的是**换后端之前必须成立的前提**——那些前提
 * 已经在 2026-07-27 全部成立并完成迁移（D15 / D16），它们现在是回归护栏：
 * 上下文丢失、上下文预算、跨 task 清空、纹理复用，这几类失效模式只有 WebGL 才有，
 * 而且都不报错。
 *
 * 后加进来的**一级调色**（M2 后半段）也在这里，因为它同样只有跑真 GPU 才验得了：
 * 矩阵语义有单测，但"shader 有没有按那个矩阵算"单测够不着。
 *
 * 断言逻辑放在主线程而不是 Worker 里，是为了让"我们到底在要求什么"集中可读；
 * Worker 只负责跑和量（见 `verify-pixi.worker.ts` 的文件头）。
 */

import { hueDistance, type Bands } from "./measure";
import type { Check } from "./verify-m0";
import type { Edges, PixiProbeReport, PixiProbeResponse } from "./verify-pixi.worker";

/** Worker 里要起渲染器、编两遍、再解两遍，慢机器上给足时间。 */
const TIMEOUT_MS = 180_000;

/** 两个后端的留边允许差的像素数。0 最好，但 GPU 采样和 drawImage 的取整未必一致。 */
const BAND_TOLERANCE_PX = 1;
/** 编码经过 YUV 4:2:0 往返，纯色块的色相偏移应该远小于这个数。 */
const HUE_TOLERANCE_DEG = 12;
/** 两个后端之间的色彩差——比上面严，因为输入完全相同，只有光栅化路径不同。 */
const BACKEND_HUE_TOLERANCE_DEG = 8;
/**
 * Pixi 比 Canvas2D 慢多少算**出事了**。
 *
 * 原本是 1.5×，含义是"Pixi 是不是个坏主意"——那个提法的前提是**有得选**。
 * 但 M2 后半段的滤镜 / LUT / shader 转场在 Canvas2D 上根本做不了，所以真正的
 * 对比不是"慢"对"快"，而是"慢"对"没有这个功能"。慢多少是要记的账，不是卡口。
 *
 * 实测（720p 不缩放、合成 + 捕获 + 编码整段）：Chrome 150 **0.93×**、
 * Safari 26 **1.69×**（干净状态下重测过，不是上下文残留造成的）。
 * 所以这条线现在只用来抓**结构性**的错：已知的那一类是"每帧 `Texture.from()`
 * 新建 GPU 纹理"，它会慢一个数量级（见 CLAUDE.md 的合成层约定）。
 * 2.5 落在实测最差（1.69×）和数量级倒退（≈10×）之间，两边都留得下余量。
 */
const SLOWDOWN_LIMIT = 2.5;
/**
 * GPU 调色与 CPU 参照实现允许的逐通道差，单位是 8 位色阶。
 *
 * 0 是达不到的：shader 在 float 上算、写回 8 位纹理时舍入，而参照实现在 JS 里
 * 先算再 round，两条路的舍入点不同。2 相当于 0.8%，肉眼看不见；而所有会出问题的
 * 写法（预乘 alpha、偏移当 0–255、行列转置）差的都是几十上百，不会卡在这个量级。
 */
const COLOR_TOLERANCE = 2;
/**
 * LUT 查表的容差，比调色松一点。
 *
 * 多出来的误差来自**采样器的双线性过滤**：GPU 的插值权重只有有限位精度
 * （典型 8 位子纹素），而 CPU 参照用的是双精度浮点。这是硬件行为，不是 bug。
 * 3 相当于 1.2%；而会出问题的写法（半纹素偏移漏了、切片拼错、蓝方向没 lerp）
 * 差的都是几十上百，卡不到这个量级。
 */
const LUT_TOLERANCE = 3;
/**
 * shader 转场的容差（每通道 0–255）。
 *
 * 两个输入都是纯色，所以取样精度不参与——剩下的只有 shader 里的浮点和一次
 * 8 位量化。实测为 0；给 2 是为了不被将来某个驱动的 round-to-even 差异误伤。
 */
const TRANSITION_TOLERANCE = 2;
/**
 * 羽化带上"确实被混过"的下限。
 *
 * 两层色差最大约 200，带中央的混合会离两边各 ~100。取 20 是按 D19 的教训定的：
 * 阈值要落在"坏掉时的 0"和"实测健康值"之间，而不是贴着后者。
 */
const FEATHER_MIN_MIX = 20;

export interface PixiVerifyResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
  readonly report: PixiProbeReport;
  readonly elapsedMs: number;
}

function check(name: string, expected: string, actual: string, pass: boolean): Check {
  return { name, expected, actual, pass };
}

/** 四条黑边里差得最远的那一条，用来把"摆位对不对"压成一个数。 */
function worstEdgeDelta(a: Edges | Bands, b: Edges | Bands): number {
  return Math.max(
    Math.abs(a.top - b.top),
    Math.abs(a.bottom - b.bottom),
    Math.abs(a.left - b.left),
    Math.abs(a.right - b.right),
  );
}

function edgesOf(b: Edges | Bands): string {
  return `上${b.top} 下${b.bottom} 左${b.left} 右${b.right}`;
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

  // ---- 5a. 丢了之后要救得回来 ----
  // 报错只解决了"不静默产出黑片"。生产里上下文丢失不是异常而是常态——用户切个
  // 标签页、系统睡一觉、驱动重置一次都会触发——每次都要求重开项目是不可接受的。
  // 断言比对**画面内容**而不只是"不黑"：GPU 资源在丢失时全部作废，Pixi 若没能
  // 重新上传纹理，画出来会是纯色或上一帧，那些同样不黑
  //
  // 恢复后画的是**另一帧**（不是丢失前那帧）：开着 preserveDrawingBuffer，画布会
  // 保留旧内容，重画同一帧的话即使"渲染其实没发生"也能量到正确色相——那条断言
  // 就是空的。命中新帧的色相才证明这一次渲染真的发生了
  const loss = report.contextLoss;
  const hueDrift = hueDistance(loss.afterHue, loss.afterExpectedHue);
  const staleBuffer = hueDistance(loss.afterHue, loss.beforeHue) <= 1;
  checks.push(
    check(
      "上下文丢失后 recover() 能救回来，且之后画的是新的一帧（不是残留的旧画面）",
      `恢复且色相命中新帧 ±${BACKEND_HUE_TOLERANCE_DEG}°`,
      loss.extensionAvailable
        ? `${loss.recoverDetail || "没跑到恢复这一步"} · 最大通道 ${loss.beforeMaxChannel} → ${loss.afterMaxChannel}`
        : "无法测试：浏览器不提供 WEBGL_lose_context",
      loss.extensionAvailable &&
        loss.recovered &&
        loss.afterMaxChannel > 32 &&
        hueDrift <= BACKEND_HUE_TOLERANCE_DEG &&
        // 两帧色相本来就该不同；相同说明画布上是丢失前的残留
        !staleBuffer,
    ),
  );

  // ---- 5b. 上下文预算：反复导出会不会把 WebGL 上下文用光 ----
  // Canvas2D 没有这个失效模式，是换后端新引入的风险。Safari 在这个 spike 里
  // 连报 "too many active WebGL contexts, the oldest context will be lost"。
  // 驱逐顺序是"最老先死"，所以**长命的那个**才是危险的——预览就是全场最老的
  const budget = report.contextBudget;
  checks.push(
    check(
      `连开 ${budget.cycles} 个合成器再销毁之后，新建的还画得出（WebGL 上下文预算）`,
      "画得出",
      `跑满 ${budget.survivedCycles}/${budget.cycles} 轮 · 最大通道 ${budget.freshMaxChannel}`,
      budget.survivedCycles === budget.cycles && budget.freshMaxChannel > 32,
    ),
  );
  //
  // 断言的是**生产架构**（复用一个常驻合成器，见 pipeline.ts 的 acquireCompositor），
  // 不是已经废弃的"每轮新建"。后者在 Safari 上必然把预览判死，拿它当断言就是一条
  // 永远红的检查——那只会训练人忽略整个面板。但那个数字正是"为什么必须复用"的
  // 证据，所以作为**对照**印在同一行里，连同"被驱逐之后救不救得回来"。
  //
  // 对照组救不回来这件事很关键：救得回来的话预览只是闪一下黑，复用就只是优化；
  // 救不回来意味着预览真的死了，复用是唯一解。实测 Safari 救不回来
  const churnNote =
    budget.churnLongLivedMaxChannel > 32
      ? "没被驱逐"
      : `被驱逐，${budget.churnLongLivedRecovered ? "但能救回来" : "且救不回来"}`;
  checks.push(
    check(
      `复用一个常驻合成器跑 ${budget.cycles} 轮，预览那个还活着（导出侧复用的验收）`,
      "画得出",
      `复用组最大通道 ${budget.reuseLongLivedMaxChannel}` +
        ` · 对照（每轮新建）：${churnNote}，最大通道 ${budget.churnLongLivedMaxChannel}`,
      budget.reuseLongLivedMaxChannel > 32,
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

  // ---- 9. 图层变换（M2 第 2 步）----
  // 分三条断言，因为三种错法的定位成本完全不同：
  //   两个后端都偏 → placeLayer 的算式错了（但两边一致，迁移时抓不到）
  //   只有一个后端偏 → 那个后端的摆法错了（anchor / 旋转中心 / slot 残留）
  // 合成一条只会告诉你"错了"，还得再手动拆一遍
  for (const backend of ["canvas2d", "pixi"] as const) {
    let worst = 0;
    let worstCase = "";
    for (const t of report.transforms) {
      const delta = worstEdgeDelta(t[backend], t.expected);
      if (delta > worst) {
        worst = delta;
        worstCase = `${t.name}：期望 ${edgesOf(t.expected)}，实际 ${edgesOf(t[backend])}`;
      }
    }
    checks.push(
      check(
        `变换后的摆位落在手算的位置上（${backend === "pixi" ? "Pixi" : "Canvas2D"}）`,
        `≤ ${BAND_TOLERANCE_PX}px`,
        worst === 0 ? "全部精确命中" : `最差 ${worst}px · ${worstCase}`,
        worst <= BAND_TOLERANCE_PX,
      ),
    );
  }

  let worstTransformBackend = 0;
  let worstTransformCase = "";
  for (const t of report.transforms) {
    const delta = worstEdgeDelta(t.pixi, t.canvas2d);
    if (delta > worstTransformBackend) {
      worstTransformBackend = delta;
      worstTransformCase = t.name;
    }
  }
  checks.push(
    check(
      "两个后端在带变换时摆位一致（换后端不改构图）",
      `≤ ${BAND_TOLERANCE_PX}px`,
      worstTransformBackend === 0
        ? `${report.transforms.length} 个用例全部一致`
        : `最差 ${worstTransformBackend}px（${worstTransformCase}）`,
      worstTransformBackend <= BAND_TOLERANCE_PX,
    ),
  );

  // 不透明度单独看：几何一致不代表混色一致，而半透明叠加是转场的基础
  const alphaCase = report.transforms.find((t) => t.name.includes("半透明"));
  const alphaDelta = alphaCase
    ? Math.max(
        Math.abs(alphaCase.pixi.meanR - alphaCase.canvas2d.meanR),
        Math.abs(alphaCase.pixi.meanG - alphaCase.canvas2d.meanG),
        Math.abs(alphaCase.pixi.meanB - alphaCase.canvas2d.meanB),
      )
    : Number.POSITIVE_INFINITY;
  checks.push(
    check(
      "两个后端的半透明混色一致（交叉溶解的基础）",
      "≤ 4",
      alphaCase ? String(alphaDelta) : "找不到半透明用例",
      alphaDelta <= 4,
    ),
  );

  // ---- 9b. 一级调色（M2 后半段）----
  // 这是滤镜能力的地基断言：**GPU 出来的像素 == colorMatrixOf() 在 CPU 上算的**。
  // 矩阵语义有单测，但"shader 有没有按这个矩阵算"单测够不着，而写错了不报错——
  // 在预乘 alpha 上算、偏移列当成 0–255、行列转置，三种都照样画得出图
  const gradedCases = report.colors.filter((c) => !c.name.startsWith("恒等"));
  let worstColor = 0;
  let worstColorCase = "";
  for (const c of gradedCases) {
    if (c.worst > worstColor) {
      worstColor = c.worst;
      worstColorCase = `${c.name}：期望 ${c.expected.join(",")}，实际 ${c.actual.join(",")}`;
    }
  }
  checks.push(
    check(
      "GPU 调色的结果等于 colorMatrixOf() 的参照实现",
      `≤ ${COLOR_TOLERANCE} / 255`,
      worstColor === 0
        ? `${gradedCases.length} 个用例逐通道完全相同`
        : `最差 ${worstColor} · ${worstColorCase}`,
      gradedCases.length > 0 && worstColor <= COLOR_TOLERANCE,
    ),
  );

  // 调色真的改变了画面。上一条在"滤镜整个没挂上"时也可能过——那时
  // actual == base，而参照值恰好接近 base 的用例（比如轻微调整）就看不出来
  const changed = gradedCases.filter(
    (c) => Math.max(...c.actual.map((v, i) => Math.abs(v - c.base[i]!))) > COLOR_TOLERANCE,
  ).length;
  checks.push(
    check(
      "每个调色用例都真的改变了像素（滤镜确实挂上了）",
      `${gradedCases.length} 个`,
      `${changed} 个 · 原色 ${gradedCases[0]?.base.join(",") ?? "-"}`,
      changed === gradedCases.length,
    ),
  );

  // 跟在调色之后的恒等帧必须一个字节不差地回到原色。滤镜是跨帧复用的槽位状态，
  // 忘了清就会把上一帧的调色画到这一帧头上——只在"某帧有调色、下一帧没有"时出现
  const identityAfter = report.colors.find((c) => c.name.startsWith("恒等"));
  const residue = identityAfter
    ? Math.max(...identityAfter.actual.map((v, i) => Math.abs(v - identityAfter.base[i]!)))
    : Number.POSITIVE_INFINITY;
  checks.push(
    check(
      "调色之后的恒等帧回到原色（跨帧不残留滤镜）",
      "0",
      identityAfter
        ? `差 ${residue}（原色 ${identityAfter.base.join(",")} → ${identityAfter.actual.join(",")}）`
        : "找不到恒等用例",
      residue === 0,
    ),
  );

  // ---- 9c. 3D LUT（M2 后半段）----
  // 比调色那三条更要紧：调色错了还能靠"画面偏绿了"看出来，LUT 本来就是用来把
  // 颜色改成另一样的，查歪了肉眼分不出来。半纹素偏移、切片拼接、蓝方向的手动
  // lerp，三处任何一处写错都只让颜色偏一点点
  const lutCases = report.luts.filter((c) => !c.name.startsWith("恒等（紧跟"));
  let worstLut = 0;
  let worstLutCase = "";
  for (const c of lutCases) {
    if (c.worst > worstLut) {
      worstLut = c.worst;
      worstLutCase = `${c.name}：期望 ${c.expected.join(",")}，实际 ${c.actual.join(",")}`;
    }
  }
  checks.push(
    check(
      "GPU 查表的结果等于 sampleLutTexture() 的参照实现",
      `≤ ${LUT_TOLERANCE} / 255`,
      worstLut === 0
        ? `${lutCases.length} 个用例逐通道完全相同`
        : `最差 ${worstLut} · ${worstLutCase}`,
      lutCases.length > 0 && worstLut <= LUT_TOLERANCE,
    ),
  );

  // 恒等 LUT 必须不改画面。这条最强——它不需要知道"应该"是什么颜色，
  // 任何一处半纹素偏移写错都会打破它，而那类错误在真实 LUT 上完全看不出来
  // 用 5³ 那张：半纹素偏移在小尺寸上会被放大到 17/255，17³ 上只有 4/255
  const identityCase = report.luts.find((c) => c.name.startsWith("恒等 LUT · 5³"));
  const identityDrift = identityCase
    ? Math.max(...identityCase.actual.map((v, i) => Math.abs(v - identityCase.base[i]!)))
    : Number.POSITIVE_INFINITY;
  checks.push(
    check(
      "恒等 LUT（5³）查完等于原色（查表这条路本身不改画面）",
      `≤ ${LUT_TOLERANCE}`,
      identityCase
        ? `差 ${identityDrift}（原色 ${identityCase.base.join(",")} → ${identityCase.actual.join(",")}）`
        : "找不到恒等 LUT 用例",
      identityDrift <= LUT_TOLERANCE,
    ),
  );

  // ---- shader 转场：双输入 shader 对上 CPU 参照 ----
  const trCases = report.transitions;
  const worstTransition = trCases.reduce((m, c) => Math.max(m, c.worst), 0);
  const worstTransitionCase = trCases.reduce(
    (worst, c) => (c.worst >= worst.worst ? c : worst),
    trCases[0] ?? { name: "（无）", worst: 0 },
  ).name;
  checks.push(
    check(
      "shader 转场：GPU 混出来的像素 == mixTransition() 的 CPU 参照",
      `≤ ${TRANSITION_TOLERANCE} / 255`,
      worstTransition === 0
        ? `${trCases.length} 个用例逐通道完全相同`
        : `最差 ${worstTransition} · ${worstTransitionCase}`,
      trCases.length > 0 && worstTransition <= TRANSITION_TOLERANCE,
    ),
  );

  // 羽化带上的点必须**既不是出场色也不是入场色**。没有这一条，把整个混合函数
  // 换成"永远返回入场层"时上面那条仍然可能绿——参照实现在带外也返回纯色，
  // 而带外的点占多数。同 D17 那条"摆位真的在变"、D19 那条"画面确实被混过"
  const feathered = trCases.filter((c) => c.name.includes("羽化带"));
  const leastMixed = feathered.reduce(
    (m, c) => Math.min(m, c.awayFromPure),
    Number.POSITIVE_INFINITY,
  );
  checks.push(
    check(
      "羽化带上的像素确实是混出来的（不等于任一纯层）",
      `≥ ${FEATHER_MIN_MIX} / 255`,
      feathered.length > 0 ? `最小 ${leastMixed}（${feathered.length} 个带内取样点）` : "没有带内取样点",
      feathered.length > 0 && leastMixed >= FEATHER_MIN_MIX,
    ),
  );

  // 三种效果都要真的不一样。全都退化成同一个分支（例如 uEffect 没传到）时，
  // 上面两条会因为参照实现也被同一个 kind 驱动而**一起错、于是一起绿**——
  // 不，参照是按用例自己的 kind 算的，所以那种情况上面会红。这一条兜的是另一头：
  // 三个分支恰好在取样点上给出同一个值，那说明取样点选得没有区分力
  //
  // **故障不进这一条**：它合法地会输出"纯的某一层"，于是完全可能和推移的入场侧
  // 取样点给出同一个像素——那是真值相同，不是取样点没区分力。把它算进来会得到
  // 一条时不时假红的断言，而假红比没有断言更坏。故障自己的区分力由下面那条
  // "同一进度上不同的带给出不同像素"管，那条更有针对性（钉的是哈希在起作用）。
  const byEffect = new Map<string, string>();
  for (const c of trCases) {
    const effect = c.name.split(" ·")[0]!;
    if (effect.startsWith("故障")) continue;
    byEffect.set(effect, c.actual.join(","));
  }
  checks.push(
    check(
      "擦除 / 圆形张开 / 推移在各自取样点上给出不同的像素（取样点有区分力）",
      `${byEffect.size} 组各不相同`,
      `${byEffect.size} 组：${[...byEffect.values()].join(" | ")}`,
      byEffect.size >= 3 && new Set(byEffect.values()).size === byEffect.size,
    ),
  );

  // 故障：**同一个进度上，不同的带要给出不同的像素。** 这一条钉的是整数哈希真的在
  // 起作用——哈希退化成常量（或者 uBlocks 没传到、整屏算成同一条带）时，三条带会
  // 一起翻，故障就变成了硬切，而"GPU == CPU 参照"仍然全绿（两边用同一个退化的哈希）。
  // 同 LUT 那条"通道真的轮换了"、D19 那条"画面确实被混过"
  const glitchBands = trCases.filter((c) => c.name.startsWith("故障 · t=0.5"));
  const distinctBands = new Set(glitchBands.map((c) => c.actual.join(",")));
  checks.push(
    check(
      "故障：同一进度上不同的带给出不同的像素（哈希真的在分带）",
      "≥ 2 种",
      `${glitchBands.length} 条带取到 ${distinctBands.size} 种像素：${[...distinctBands].join(" | ")}`,
      glitchBands.length >= 2 && distinctBands.size >= 2,
    ),
  );

  // 顺序：**先一级调色，再 LUT**。反过来的话上面两条都还是绿的，只有这条会红——
  // 参照值是按正序算的，倒过来的结果与它不同（调色不是与查表可交换的操作）
  const orderCase = report.luts.find((c) => c.name.startsWith("先调色再 LUT"));
  checks.push(
    check(
      "调色与 LUT 的应用顺序是「先调色再查表」",
      `≤ ${LUT_TOLERANCE}`,
      orderCase
        ? `差 ${orderCase.worst}（期望 ${orderCase.expected.join(",")}，实际 ${orderCase.actual.join(",")}）`
        : "找不到顺序用例",
      orderCase !== undefined && orderCase.worst <= LUT_TOLERANCE,
    ),
  );

  // 跟在 LUT 之后的恒等帧必须回到原色。同调色那条，钉的是跨帧不残留滤镜
  const afterLut = report.luts.find((c) => c.name.startsWith("恒等（紧跟"));
  const lutResidue = afterLut
    ? Math.max(...afterLut.actual.map((v, i) => Math.abs(v - afterLut.base[i]!)))
    : Number.POSITIVE_INFINITY;
  checks.push(
    check(
      "LUT 之后的恒等帧回到原色（跨帧不残留滤镜）",
      "0",
      afterLut
        ? `差 ${lutResidue}（原色 ${afterLut.base.join(",")} → ${afterLut.actual.join(",")}）`
        : "找不到用例",
      lutResidue === 0,
    ),
  );

  // ---- 10. 吞吐 ----
  // 用 720p 那组，不用上面 320×320 的：小画布上每帧固定开销占比过高，
  // 拿它的比值下结论会把 Pixi 判得过重
  const { perf } = report;
  const ratio = perf.pixiMs / Math.max(1, perf.canvas2dMs);
  const perFramePixi = perf.pixiMs / perf.frames;
  const perFrameCanvas = perf.canvas2dMs / perf.frames;
  checks.push(
    check(
      `${perf.width}×${perf.height} 整段（合成 + 捕获 + 编码）没有数量级的倒退`,
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
