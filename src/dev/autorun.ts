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

type RunnerName = "m0" | "pixi" | "timeline" | "preview" | "device" | "length";

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
    return (await import("./verify-device")).runLengthReport(
      undefined,
      Number.isFinite(max) && max > 0 ? { maxSeconds: max } : undefined,
    );
  },
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
