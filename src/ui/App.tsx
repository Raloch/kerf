/**
 * 顶层视图切换：首页（默认）/ 剪辑台 / 自检面板。
 *
 * **默认落首页**（D37）：项目多于一个的那天，"打开就是上次那个"会变成"我不知道
 * 我在编辑哪一个"。打开与新建都在这里做——项目**装进 store 之后**才渲染剪辑台，
 * 于是"autosave 在项目装好之前开工"在结构上不存在（另一道闸在 autosave 自己身上，
 * 见 `state/autosave.ts` 文件头）。
 *
 * M0 自检面板保留为独立视图，不是可以删掉的临时代码：CLAUDE.md 要求改动导出管道
 * 或时间基之后必须跑它。它走 `lazy()`：面板拖着 mediabunny 的运行时（约 500KB），
 * 绝大多数会话根本不会打开这个视图。
 */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ProjectId } from "../state/project-snapshot";
import { EMPTY_TIMELINE, useTimeline } from "../state/timeline-store";
import { Editor } from "./Editor";
import { Home } from "./Home";

const M0Panel = lazy(() => import("./M0Panel").then((m) => ({ default: m.M0Panel })));

type View =
  | { readonly kind: "home" }
  | { readonly kind: "editor"; readonly note: string | null }
  | { readonly kind: "selfcheck" };

export function App() {
  const [view, setView] = useState<View>({ kind: "home" });

  // 回到首页时卸下当前项目。放在 effect 里而不是点击处：effect 跑在 Editor 卸载
  // **之后**，那次卸载收尾的 flush 还能从 store 里读到项目——先关再卸会把
  // 最后一秒的编辑丢掉（autosave 对 projectId === null 拒写）
  useEffect(() => {
    if (view.kind === "home") useTimeline.getState().closeProject();
  }, [view]);

  const openProject = useCallback(async (id: ProjectId) => {
    const { loadProject } = await import("../state/project-store");
    const found = await loadProject(id);
    if (!found) {
      // 打不开（版本不认/记录没了）留在首页。静默什么都不发生比报错更难排查，
      // 但首页的提示条归 Home 管；这里最少要把项目从"看起来能打开"里去掉
      window.alert("这个项目打不开了（记录已损坏或版本不认），它不会被修改。");
      return;
    }
    // id 和时间轴在同一次 set 里换（openProject 内部保证），autosave 不可能串写
    useTimeline.getState().openProject(id, found.timeline, found.playhead);
    setView({ kind: "editor", note: openNote(found) });
  }, []);

  const createProject = useCallback(async () => {
    const { newProjectId, saveProject } = await import("../state/project-store");
    const id = newProjectId();
    useTimeline.getState().openProject(id, EMPTY_TIMELINE, 0);
    // 先落一条记录：新建完立刻回首页也该看得见这个项目。存不上不拦路（隐私模式），
    // 失败态归顶栏那行存盘读数管
    void saveProject(id, EMPTY_TIMELINE, 0);
    setView({ kind: "editor", note: null });
  }, []);

  const closeSelfCheck = useCallback(() => {
    // 自检可以从首页或剪辑台进来；出去回到进来的那边——判据是 store 里有没有项目
    setView(
      useTimeline.getState().projectId !== null ? { kind: "editor", note: null } : { kind: "home" },
    );
  }, []);

  return view.kind === "editor" ? (
    <Editor
      onOpenSelfCheck={() => setView({ kind: "selfcheck" })}
      onBack={() => setView({ kind: "home" })}
      note={view.note}
    />
  ) : view.kind === "home" ? (
    <Home
      onOpen={(id) => void openProject(id)}
      onCreate={() => void createProject()}
      onOpenSelfCheck={() => setView({ kind: "selfcheck" })}
    />
  ) : (
    <Suspense
      fallback={
        <main className="m0">
          <p className="mono">加载自检面板…</p>
        </main>
      }
    >
      <M0Panel onBack={closeSelfCheck} />
    </Suspense>
  );
}

/**
 * 打开项目时"丢了什么"的说明。**必须说出来**：素材找不回来会连带移除片段，
 * 静默处理就是让用户在导出时才发现少了东西（同硬规则 10 那类"选了 A 拿到 B"）。
 * 被移除的结果要到第一次编辑落盘才写回去，所以"打开看一眼再关掉"不丢东西。
 */
function openNote(found: {
  readonly droppedSources: readonly { readonly name: string; readonly clips: number }[];
  readonly droppedLuts: readonly string[];
  readonly droppedFonts: readonly string[];
}): string | null {
  const lost = found.droppedSources.filter((d) => d.clips > 0);
  const notes = [
    ...lost.map((d) => `${d.name} 找不到了，用到它的 ${d.clips} 个片段已移除`),
    ...(found.droppedLuts.length > 0
      ? [`${found.droppedLuts.join("、")} 这几张 LUT 没读回来，相关片段的调色已退回不上表`]
      : []),
    ...(found.droppedFonts.length > 0
      ? [`${found.droppedFonts.join("、")} 这几个字体没装回来，相关文字已退回默认字体`]
      : []),
  ];
  return notes.length > 0 ? notes.join("；") : null;
}
