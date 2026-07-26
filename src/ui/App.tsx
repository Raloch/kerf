/**
 * 顶层视图切换。
 *
 * M0 自检面板保留为独立视图，不是可以删掉的临时代码：
 * CLAUDE.md 要求改动导出管道或时间基之后必须跑它——帧数、时长、trim 起点
 * 出错时不会抛异常，只会静默产出错误的片子，单元测试也覆盖不到。
 *
 * 它走 `lazy()` 而不是静态 import：面板里的素材探针、能力探测、测试素材生成器
 * 全都拖着 mediabunny 的运行时（约 500KB），而绝大多数会话根本不会打开这个视图。
 */

import { lazy, Suspense, useState } from "react";
import { Editor } from "./Editor";

const M0Panel = lazy(() => import("./M0Panel").then((m) => ({ default: m.M0Panel })));

type View = "editor" | "selfcheck";

export function App() {
  const [view, setView] = useState<View>("editor");

  return view === "editor" ? (
    <Editor onOpenSelfCheck={() => setView("selfcheck")} />
  ) : (
    <Suspense fallback={<main className="m0"><p className="mono">加载自检面板…</p></main>}>
      <M0Panel onBack={() => setView("editor")} />
    </Suspense>
  );
}
