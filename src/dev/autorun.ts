/**
 * 让自检**把结果发回开发服务器**，而不是只印在屏幕上。
 *
 * 起因是真机调试的往返成本。手机上跑完自检，结果只能截图或长按复制再发过来——
 * 一次往返几分钟，而排一个"音频晚了 9.3ms"这类问题需要来回好几次。更糟的是
 * 截图会**丢掉诊断字段**：真正要看的往往不是那条断言红没红，而是它旁边那些数
 * （测出来的编码延迟是几、相关性多少），而那些在小屏上经常被截断。
 *
 * 用法：打开 `?autorun=m0`（或 `pixi` / `timeline` / `preview` / `device`），
 * 页面自己跑完并 POST 到 `/__report`，落到项目下 `.reports/`（已 gitignore）。
 * 加 `&keep=1` 可以不自动关，方便同时看屏幕。
 *
 * **只在 dev 生效**：接收端是 Vite 的中间件，`vite build` 出来的产物里根本没有
 * 那个路由，而这个模块本身由 `main.tsx` 用 `import.meta.env.DEV` 挡住。
 */

const ENDPOINT = "/__report";

type RunnerName = "m0" | "pixi" | "timeline" | "preview" | "device" | "length" | "clear";

interface CheckLike {
  readonly name: string;
  readonly pass: boolean;
  readonly expected?: string;
  readonly actual?: string;
}

/**
 * 各个自检的入口。名字和文件对不上是历史原因（`verifyM0` / `verifyTimelineConsistency`
 * / `verifyPreviewMatchesExport` / `verifyPixiBackend`），所以这里显式列一张表，
 * 而不是靠拼字符串猜函数名——猜错的表现是"跑了但什么也没发生"。
 */
const RUNNERS: Record<RunnerName, (params: URLSearchParams) => Promise<unknown>> = {
  m0: async () => (await import("./verify-m0")).verifyM0(),
  pixi: async () => (await import("./verify-pixi")).verifyPixiBackend(),
  timeline: async () => (await import("./verify-timeline")).verifyTimelineConsistency(),
  preview: async () => (await import("./verify-preview")).verifyPreviewMatchesExport(),
  device: async () => (await import("./verify-device")).runDeviceReport(),
  /**
   * `&max=<秒>` 只跑到那一档为止。
   *
   * 不只是图快：长片这根轴上最坏的形态是**整个页面死等**（主线程停在一个永不
   * resolve 的 promise 上，0% CPU、没有报错、没有崩溃）。那时唯一能把
   * "上一次死在哪一档"取出来的办法，就是跑一轮**短到一定能跑完**的，
   * 让它把 localStorage 里那条记录读出来带回报告。
   */
  length: async (params) => {
    const max = Number(params.get("max"));
    const only = Number(params.get("only"));
    const repeat = Number(params.get("repeat"));
    return (await import("./verify-device")).runLengthReport(undefined, {
      ...(Number.isFinite(max) && max > 0 ? { maxSeconds: max } : {}),
      // `&only=<秒>` 只跑那一档。配合刷新页面用，是把"跨档累积"和"这一档太长"
      // 分开的唯一办法——从头跑起时，跑到第 N 档已经背着前 N−1 档的资源账
      ...(Number.isFinite(only) && only > 0 ? { onlySeconds: only } : {}),
      // `&repeat=<n>` 把同一档在**同一个页面里**连着导 n 次，量"一个页面能导几次"。
      // 答案已经量出来了：iPhone 上 30 秒档 24 次连导全过、吞吐死平，**次数不是墙**
      // （在此之前"第 2、3 次就挂"看着像铁证，实为并发污染）。配 `&only=30` 最省时间
      ...(Number.isFinite(repeat) && repeat > 1 ? { repeat } : {}),
    });
  },
  /**
   * 不是自检，是**清场**：把 OPFS 导出目录里的残留删掉。
   *
   * 长片自检被中断（标签页被杀 / 判死等之后放弃那次导出）会留下半写的成品，
   * 一个几百 MB。攒几次之后下一轮自检会在 `createWritable()` 上直接失败，而
   * Safari 把它报成"unknown transient reason (e.g. out of memory)"——完全看不出
   * 是存储满了。踩过一次，于是留一条能从命令行调的口子。
   */
  clear: async () => (await import("../export/write-target")).clearExportStorage(),
};

function isRunnerName(value: string): value is RunnerName {
  return value in RUNNERS;
}

/** 把结果压成"哪些红了"的摘要，好在服务器那头一眼看出结论。 */
function summarize(result: unknown): unknown {
  const checks = (result as { checks?: readonly CheckLike[] } | null)?.checks;
  if (!Array.isArray(checks)) return { note: "这个自检不返回 checks 数组" };
  return {
    total: checks.length,
    passed: checks.filter((c) => c.pass).length,
    failed: checks
      .filter((c) => !c.pass)
      .map((c) => ({ name: c.name, expected: c.expected, actual: c.actual })),
  };
}

async function post(body: unknown): Promise<void> {
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // 发不回去不该让页面报错——屏幕上还有一份
  }
}

/**
 * 把一份**手点出来的**结果也发回开发服务器。
 *
 * `?autorun=` 省掉的是"开浏览器 + 截图 + 人工转录"，但它在手机上有个致命缺点：
 * 页面从头到尾没有反馈，人在手机前面看着就是"点了没反应"。于是长片轴实际是手点的，
 * 而手点的结果只在屏幕上——**完整诊断字段照样要靠截图，而截图恰恰会截断它们**。
 *
 * 踩过一次而且代价不小：一轮阶梯失败的原因只有截图上那句"导出被取消"，而真正的
 * 证据（同一时刻另一轮自检正在并行跑）是从**别的**报告文件的时间戳里挖出来的——
 * 要是那一轮也留了报告，两份读数一对时间就完了。名字用 ASCII，服务器那头直接
 * 拿它拼文件名。
 */
export async function postManualReport(name: string, result: unknown): Promise<void> {
  await post({
    name: `${name}-manual`,
    userAgent: navigator.userAgent,
    manual: true,
    summary: summarize(result),
    result,
  });
}

/**
 * 如果 URL 上带了 `?autorun=`，就跑那个自检并把结果发回去。
 *
 * 结果里**同时**带摘要和完整对象：摘要用来一眼看结论，完整对象保住所有诊断字段，
 * 因为"下次真机跑要看哪个数"往往是看到这次结果之后才知道的。
 */
export async function maybeAutorun(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const name = params.get("autorun");
  if (!name) return;
  if (!isRunnerName(name)) {
    await post({ name, error: `未知的自检名，可选：${Object.keys(RUNNERS).join(" / ")}` });
    return;
  }

  const startedAt = performance.now();
  try {
    const result = await RUNNERS[name](params);
    await post({
      name,
      userAgent: navigator.userAgent,
      elapsedMs: Math.round(performance.now() - startedAt),
      summary: summarize(result),
      result,
    });
  } catch (error) {
    await post({
      name,
      userAgent: navigator.userAgent,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
}
