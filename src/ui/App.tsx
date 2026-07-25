/**
 * 顶层视图切换。
 *
 * M0 自检面板保留为独立视图，不是可以删掉的临时代码：
 * CLAUDE.md 要求改动导出管道或时间基之后必须跑它——帧数、时长、trim 起点
 * 出错时不会抛异常，只会静默产出错误的片子，单元测试也覆盖不到。
 */

import { useState } from "react";
import { Editor } from "./Editor";
import { M0Panel } from "./M0Panel";

type View = "editor" | "selfcheck";

export function App() {
  const [view, setView] = useState<View>("editor");

  return view === "editor" ? (
    <Editor onOpenSelfCheck={() => setView("selfcheck")} />
  ) : (
    <M0Panel onBack={() => setView("editor")} />
  );
}
