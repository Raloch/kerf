/**
 * 编辑器外壳：四区固定布局（左素材库 / 中预览 / 右检查器 / 下时间轴）。
 *
 * 布局按 design/kerf-editor-mockup.html 定稿实现，不做浮动面板——
 * 沿用 Premiere / Resolve / 剪映共有的骨架，用户不需要重新学（PLAN.md §6）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportCapabilities } from "../media/capability";
import { proxyManager } from "../media/proxy-client";
import type { ProxyInfo } from "../media/proxy";
import { useTimeline } from "../state/timeline-store";
// 只要类型：`autosave` 本身走动态 import，别把 IndexedDB 那一层拖进首屏
import type { AutosaveHandle, SaveReadout } from "../state/autosave";
import { UNNAMED_PROJECT } from "../state/project-snapshot";
// 纯函数、零运行时依赖，静态 import 不会把 IndexedDB 那层拖进首屏
import {
  bannerCopy,
  classifyPersistError,
  dismissBanner,
  nextBanner,
  NO_BANNER,
  topbarFailureText,
  type BannerState,
  type PersistFailure,
} from "../state/persist-status";
import { cleanupLabel, type CleanupPlan } from "../state/asset-cleanup";
import { findClip } from "../state/operations";
import { clipDuration, clipSourceId, sourceDurationFrames, type MediaSource } from "../edl/types";
import { formatDuration, framesToTimecode } from "../time/timebase";
import { formatFps } from "../time/rational";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { TimelinePanel } from "./Timeline";
import { ExportDialog } from "./ExportDialog";
import {
  IconBack,
  IconCaret,
  IconCheck,
  IconCopy,
  IconDownload,
  IconFilm,
  IconImage,
  IconMark,
  IconNo,
  IconPen,
  IconPlus,
  IconRedo,
  IconTrash,
  IconUndo,
  IconWarn,
  IconWave,
  IconX,
  IconBroom,
} from "./icons";
import "./editor.css";

/** 顶栏「已保存 · N 秒前」的口语化。悬停有精确时刻。 */
function savedAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return new Date(at).toLocaleTimeString();
}

export function Editor({
  onOpenSelfCheck,
  onBack,
  note,
}: {
  readonly onOpenSelfCheck: () => void;
  readonly onBack: () => void;
  /** 打开项目时"丢了什么"的说明（App 算好传进来），显示一次、可关。 */
  readonly note: string | null;
}) {
  const timeline = useTimeline((s) => s.timeline());
  const projectId = useTimeline((s) => s.projectId);
  const playhead = useTimeline((s) => s.playhead);
  const selectedClipIds = useTimeline((s) => s.selectedClipIds);
  const lastRejection = useTimeline((s) => s.lastRejection);
  const dragHint = useTimeline((s) => s.dragHint);
  const addSource = useTimeline((s) => s.addSource);
  const renameProject = useTimeline((s) => s.renameProject);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const undo = useTimeline((s) => s.undo);
  const redo = useTimeline((s) => s.redo);
  const canUndo = useTimeline((s) => s.canUndo());
  const canRedo = useTimeline((s) => s.canRedo());
  const undoLabel = useTimeline((s) => s.undoLabel());
  const redoLabel = useTimeline((s) => s.redoLabel());
  const splitAtPlayhead = useTimeline((s) => s.splitAtPlayhead);
  const copySelected = useTimeline((s) => s.copySelected);
  const paste = useTimeline((s) => s.paste);
  const duplicateSelected = useTimeline((s) => s.duplicateSelected);
  const removeSelected = useTimeline((s) => s.removeSelected);
  const removeSource = useTimeline((s) => s.removeSource);
  const selectAll = useTimeline((s) => s.selectAll);
  const select = useTimeline((s) => s.select);

  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  /** 打开项目时的"丢了什么"说明。显示一次，用户关掉就没了。 */
  const [notice, setNotice] = useState<string | null>(note);
  /** 存盘读数。刚装进来的项目本来就是从盘上读的（新建的也先落了一条），所以初始是"已保存"。 */
  const [readout, setReadout] = useState<SaveReadout>({ status: "saved", at: null, reason: null });
  /**
   * 落盘失败横幅。**只在"正常 → 失败"的沿上弹一次**，状态机是纯函数（`persist-status.ts`）
   * ——防抖 1 秒意味着失败每秒重演，按次弹就是风暴。
   */
  const [banner, setBanner] = useState<BannerState>(NO_BANNER);
  /** 横幅上那个清理按钮要显示的计划。只在横幅出现时才去量。 */
  const [cleanup, setCleanup] = useState<CleanupPlan | null>(null);
  /** 「N 秒前」要走表。5 秒一格，比它细就得每秒重渲整个顶栏。 */
  const [clock, setClock] = useState(() => Date.now());
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const autosaveRef = useRef<AutosaveHandle | null>(null);

  // 能力探测和素材探针都动态 import：它们各自拖着 mediabunny 的运行时，
  // 静态 import 会把约 500KB 塞进首屏 chunk，而两者都是"页面出来之后"才需要的。
  useEffect(() => {
    let stale = false;
    void import("../media/capability-probe")
      .then(({ probeCapabilities }) => probeCapabilities(timeline.width, timeline.height))
      .then((next) => {
        if (!stale) setCaps(next);
      })
      .catch(() => {
        if (!stale) setCaps(null);
      });
    return () => {
      stale = true;
    };
  }, [timeline.width, timeline.height]);

  /**
   * 每次落盘尝试都过一遍状态机。**读数和横幅要在同一个回调里更新**：分两处的话
   * "这一期弹过了没有"和"现在是失败态"会各自变化，中间那一帧就可能重新弹一次。
   */
  const onReadout = useCallback((next: SaveReadout) => {
    setReadout(next);
    setBanner((prev) => nextBanner(prev, next.status === "saved"));
  }, []);

  /**
   * 自动存盘跟着剪辑台的生命周期走（D37，改写自 D23 的三态）：App 只在项目
   * **装进 store 之后**才渲染这里，所以挂载即可开工——"空时间轴把项目覆盖成空的"
   * 由这个顺序挡第一道，autosave 自己对 `projectId === null` 拒写挡第二道。
   * 卸载时 `stop()` 会先把欠着的那一份 flush 掉（此刻 store 还装着本项目）。
   */
  useEffect(() => {
    let stopped = false;
    let handle: AutosaveHandle | undefined;
    void import("../state/autosave").then(({ startAutosave }) => {
      // 挂载已经被撤销（严格模式双挂载/极快的视图切换）就别再订阅，孤儿订阅没人停
      if (stopped) return;
      handle = startAutosave(onReadout);
      autosaveRef.current = handle;
    });
    return () => {
      stopped = true;
      handle?.stop();
      autosaveRef.current = null;
    };
  }, [onReadout]);

  // 横幅出现时才去量"能清掉多少"。这不是每帧都要的读数，而且它要扫全部项目的引用
  useEffect(() => {
    if (!banner.showing) {
      setCleanup(null);
      return;
    }
    let stale = false;
    void import("../state/project-store")
      .then(({ measureStorage }) => measureStorage())
      .then(({ plan }) => {
        if (!stale) setCleanup(plan);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [banner.showing]);

  /**
   * 清理没人用的资产，然后**立刻重试一次落盘**。
   *
   * 不重试的话红字会一直挂着——失败那一次已经把欠账清掉了，此后没有新编辑就不会
   * 再写，于是横幅上"清出空间后会自动接着保存"在用户眼里是假话（见 `autosave.ts`）。
   */
  const runCleanupNow = useCallback(async () => {
    if (!cleanup) return;
    const { runCleanup } = await import("../state/project-store");
    const { removed, bytes } = await runCleanup(cleanup);
    setCleanup(null);
    const { formatBytes } = await import("../state/asset-cleanup");
    setBusy(removed > 0 ? `已清理 ${removed} 项 · ${formatBytes(bytes)}` : "没有可清理的");
    setTimeout(() => setBusy(null), 4000);
    await autosaveRef.current?.retry();
  }, [cleanup]);

  // 「已保存 · N 秒前」走表
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  // 点项目菜单外面就收起
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  // 代理状态：素材库要显示进度，预览要在就绪时切过去
  useEffect(
    () =>
      proxyManager.subscribe((sourceId, info) => {
        setProxies((prev) => ({ ...prev, [sourceId]: info }));
      }),
    [],
  );

  // 导入的素材都排队生成代理（已在 OPFS 里的会直接命中缓存）
  useEffect(() => {
    for (const source of timeline.sources) void proxyManager.request(source);
  }, [timeline.sources]);

  const projectName = timeline.name ?? UNNAMED_PROJECT;
  /** 失败的根因；不在失败态时是 null。顶栏红字和横幅文案都从它来，只有一个真值来源。 */
  const failure = readout.status === "failed" ? classifyPersistError(readout.reason) : null;

  const commitRename = useCallback(
    (raw: string) => {
      setRenaming(false);
      const name = raw.trim();
      // 空白当取消，不当"清掉名字"——清掉会让下一次导入素材悄悄改名（见 operations.ts）
      if (name.length === 0) return;
      renameProject(name);
    },
    [renameProject],
  );

  const duplicate = useCallback(async () => {
    if (projectId === null) return;
    // 副本要含最后一秒的编辑：先把欠着的 flush 掉再去读快照
    await autosaveRef.current?.flush();
    const { duplicateProject } = await import("../state/project-store");
    const copy = await duplicateProject(projectId);
    if (copy) {
      setBusy(`已创建「${copy.name ?? "副本"}」，回首页可以打开`);
      setTimeout(() => setBusy(null), 4000);
    } else {
      setError("制作副本失败");
    }
  }, [projectId]);

  const removeProject = useCallback(async () => {
    if (projectId === null) return;
    const clips = timeline.tracks.reduce((n, t) => n + t.clips.length, 0);
    // 删除给一次确认，写明片段数；没有回收站，删了就是删了（D37）
    if (!window.confirm(`删除「${projectName}」？${clips} 个片段会一起删除，删了就是删了。`)) {
      return;
    }
    // **先卸下项目再删**：卸载收尾那次 flush 对 projectId === null 拒写，
    // 顺序反过来的话 flush 会把刚删掉的项目原样写回去（复活）
    useTimeline.getState().closeProject();
    const { deleteProject } = await import("../state/project-store");
    await deleteProject(projectId);
    onBack();
  }, [projectId, projectName, timeline, onBack]);

  const importFile = useCallback(
    async (file: File) => {
      setBusy("读取素材…");
      setError(null);
      try {
        // 图片走**另一个探针**，它一行 mediabunny 都不用——导入一张 PNG 不该把
        // 那 500KB 拖进来（见 `media/image-probe.ts` 的文件头）
        const { looksLikeImage } = await import("../media/image-probe");
        if (looksLikeImage(file)) {
          const { probeImageFile } = await import("../media/image-probe");
          const { source } = await probeImageFile(file);
          addSource(source);
          void import("../state/project-store").then(({ putSourceAsset }) =>
            putSourceAsset(source),
          );
          setBusy(null);
          return;
        }
        const { probeFile, wasFpsSnapped } = await import("../media/probe");
        const result = await probeFile(file);
        addSource(result.source);
        // 素材文件单独收进资产库，**导入时一次**——快照每次编辑都重写，把几百 MB
        // 的 File 混在里面会让自动存盘变成最慢的那一步（见 `project-store.ts`）
        void import("../state/project-store").then(({ putSourceAsset }) =>
          putSourceAsset(result.source),
        );
        void proxyManager.request(result.source);
        if (wasFpsSnapped(result) && result.source.kind === "av" && result.rawFps !== null) {
          // 帧率被吸附过要告知：它决定了后续所有帧运算
          setBusy(
            `已把探测帧率 ${result.rawFps.toFixed(4)} 吸附为 ${formatFps(result.source.fps)}`,
          );
          setTimeout(() => setBusy(null), 4000);
        } else {
          setBusy(null);
        }
      } catch (e) {
        setBusy(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [addSource],
  );

  // 编辑相关快捷键。空格（播放/暂停）由 Preview 自己接，它持有播放状态
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // 导出对话框开着时不响应编辑快捷键：⌫ 会删掉正在导出的片段，
      // 而 Worker 拿的是发起时的 EDL 快照，用户会看到"删了但成片里还有"
      if (exportOpen) return;

      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        splitAtPlayhead();
        return;
      }
      // ⌘C / ⌘V / ⌘D。**要 preventDefault**：⌘C 会把编辑器里的选区（这里没有）交给
      // 系统剪贴板、⌘D 在浏览器里是"加书签"，两者都会让快捷键看起来"有时候不灵"
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        paste();
        return;
      }
      if (meta && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelected();
        return;
      }
      // ⌘A 全选片段。**要 preventDefault**：否则浏览器会把整个页面的文字选上，
      // 于是界面被蓝底盖住一片，而选中的片段也确实变了——看起来像"选中把界面搞坏了"
      if (meta && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return;
      }
      // Esc 取消选中。多选之后特别需要它：⌘ 点选反选一个个取消太慢，
      // 而"点空白处清空"这条路还不存在（时间轴空白区目前不接指针事件）
      if (e.key === "Escape") {
        select(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        removeSelected(e.shiftKey);
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlayhead(playhead - (e.shiftKey ? 10 : 1));
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlayhead(playhead + (e.shiftKey ? 10 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    copySelected,
    duplicateSelected,
    exportOpen,
    paste,
    playhead,
    redo,
    select,
    selectAll,
    removeSelected,
    setPlayhead,
    splitAtPlayhead,
    undo,
  ]);

  // 检查器自己从 store 读选中片段；这里留一份是给状态栏和导出范围用的
  const selected = selectedClipIds.length === 1 ? findClip(timeline, selectedClipIds[0]!) : undefined;
  /**
   * 选中区间：多选时是**整组的跨度**（最早的入点到最晚的出点）。
   *
   * 中间的空档也算进来，而这是对的——导出的是一段连续时间，不是几个片段的并集。
   * 报的是"这些片段占了哪一段"，而导出面板上那一行同时印着帧数，所以跨度里含空档
   * 这件事看得见。
   */
  const selectedRange = useMemo(() => {
    const clips = selectedClipIds
      .map((id) => findClip(timeline, id)?.clip)
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    if (clips.length === 0) return null;
    return {
      inFrame: Math.min(...clips.map((c) => c.timelineIn)),
      outFrame: Math.max(...clips.map((c) => c.timelineOut)),
    };
  }, [selectedClipIds, timeline]);
  const hasContent = timeline.durationFrames > 0;

  /**
   * 每个素材被几个片段引用——素材行删除按钮的提示和确认框都要这个数。
   * 判据问 `clipSourceId()`：图片片段同样带 `sourceId`，散写 `kind === "media"` 会漏掉它。
   */
  const sourceRefs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const track of timeline.tracks) {
      for (const clip of track.clips) {
        const id = clipSourceId(clip);
        if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return counts;
  }, [timeline]);

  const confirmRemoveSource = useCallback(
    (source: MediaSource, refs: number) => {
      // 没有片段引用时直接删（撤销一步就回得来）；有片段时先确认——素材行上那个
      // 按钮只是一下点击，误触的代价是时间轴上几个片段同时消失。锁定轨道上的引用
      // 会被纯函数整体拒绝并报到状态栏（removeSource），这里不重复判
      if (
        refs > 0 &&
        !window.confirm(
          `删掉素材「${source.name}」？引用它的 ${refs} 个片段会一起删除（可以撤销）。`,
        )
      ) {
        return;
      }
      removeSource(source.id);
    },
    [removeSource],
  );

  return (
    <div className="ed">
      {/* ---------- 顶栏 ---------- */}
      <div className="ed-top">
        <div className="brand">
          <IconMark className="mark" />
          <b>KERF</b>
        </div>
        {/* 项目名是入口不是死文字；第二行说的是**存盘状态**——分辨率在状态栏已经有了（D37） */}
        <div className="proj">
          {renaming ? (
            <>
              <span className="rename">
                <input
                  defaultValue={projectName}
                  autoFocus
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename((e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  onBlur={() => setRenaming(false)}
                />
              </span>
              <span className="sub">回车确认 · Esc 取消</span>
            </>
          ) : (
            <>
              <button
                type="button"
                className="pbtn"
                onClick={() => setMenuOpen((open) => !open)}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <span className="name">{projectName}</span>
                <span className="caret">
                  <IconCaret />
                </span>
              </button>
              <span
                className={`sub${failure ? " bad" : ""}`}
                title={
                  failure
                    ? (readout.reason ?? undefined)
                    : readout.at
                      ? new Date(readout.at).toLocaleString()
                      : undefined
                }
              >
                {/* 失败态把派生现象折叠回根因（D24）：配额满和隐私模式的出路完全不同 */}
                {failure
                  ? topbarFailureText(failure)
                  : readout.at
                    ? `已保存 · ${savedAgo(readout.at, clock)}`
                    : "已保存"}
              </span>
              {menuOpen && (
                <div className="menu" onPointerDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onBack();
                    }}
                  >
                    <IconBack />
                    返回首页
                  </button>
                  <hr />
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      setRenaming(true);
                    }}
                  >
                    <IconPen />
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      void duplicate();
                    }}
                  >
                    <IconCopy />
                    制作副本
                  </button>
                  <hr />
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setMenuOpen(false);
                      void removeProject();
                    }}
                  >
                    <IconTrash />
                    删除项目
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div className="ico-row" style={{ marginLeft: 6 }}>
          <button
            type="button"
            className="ib"
            title={canUndo ? `撤销 ${undoLabel ?? ""} ⌘Z` : "没有可撤销的操作"}
            disabled={!canUndo}
            onClick={undo}
          >
            <IconUndo />
          </button>
          <button
            type="button"
            className="ib"
            title={canRedo ? `重做 ${redoLabel ?? ""} ⇧⌘Z` : "没有可重做的操作"}
            disabled={!canRedo}
            onClick={redo}
          >
            <IconRedo />
          </button>
        </div>

        <div className="spacer" />

        <button type="button" className="chip-btn" onClick={onOpenSelfCheck}>
          M0 自检
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!hasContent}
          title={hasContent ? "导出成片" : "先导入素材"}
          onClick={() => setExportOpen(true)}
        >
          <IconDownload />
          导出
        </button>
      </div>

      {/*
        打开项目时"丢了什么"的说明（App 算好传进来）。**必须说出来**：素材找不回来
        会连带移除片段，静默处理就是让用户在导出时才发现少了东西（同硬规则 10）。
        "上次崩过"那类说法没有判据、已随项目化删掉（D37）——快照就是项目本体。
      */}
      {notice && (
        <div className="ed-recover warn">
          <span>{notice}</span>
          <button type="button" className="chip-btn" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}

      {/*
        落盘失败横幅：**这一稿唯一新增的真警告**，也是顶栏那行「已保存 · N 秒前」
        存在的全部理由——没有失败态的话它只是个恒为真的装饰（同 `FontFaceSet.check()`
        那类假读数）。只在"正常 → 失败"的沿上弹一次，写成功自动消失（状态机在
        `persist-status.ts`），关掉之后这一期不再弹而顶栏红字**照旧留着**——失败还在。
        文案由纯函数生成，所以"改动不会被保住"这句过头话钉得住不会溜回来。
      */}
      {banner.showing && failure && <SaveBanner
        failure={failure}
        plan={cleanup}
        onCleanup={() => void runCleanupNow()}
        onDismiss={() => setBanner(dismissBanner)}
      />}

      {/* ---------- 三栏 ---------- */}
      <div className="ed-body">
        <div className="pane left">
          <div className="pane-hd">
            <h3>素材</h3>
          </div>
          <div className="pane-body">
            {timeline.sources.length === 0 ? (
              <p className="empty">
                还没有素材。导入视频、音频或图片开始，或用顶栏的「M0 自检」生成测试素材。
              </p>
            ) : (
              <div className="assets">
                {/* 行是 div 不是 button：里面要放真正的删除按钮，button 套 button 是非法标记 */}
                {timeline.sources.map((source) => (
                  <div className="asset" key={source.id} title={source.name}>
                    <span className="thumb">
                      {source.kind === "av" ? (
                        <IconFilm />
                      ) : source.kind === "image" ? (
                        <IconImage />
                      ) : (
                        <IconWave />
                      )}
                    </span>
                    <span>
                      <span className="nm">{source.name}</span>
                      <span className="meta">
                        {source.kind === "av" ? (
                          <>
                            {source.width}×{source.height} · {formatFps(source.fps)} ·{" "}
                            {formatDuration(source.durationFrames, source.fps)}
                          </>
                        ) : source.kind === "image" ? (
                          // 图片没有时长（想占多久都行），所以这里只报尺寸和格式。
                          // 动图要说出来：我们只画第一帧，静默处理就是硬规则 10
                          <>
                            {source.width}×{source.height} ·{" "}
                            {source.mimeType.replace(/^image\//, "").toUpperCase()}
                            {source.frameCount !== null && source.frameCount > 1
                              ? ` · 动图 ${source.frameCount} 帧，只用第一帧`
                              : ""}
                          </>
                        ) : (
                          // 纯音频素材按项目帧率数帧（它没有自己的栅格，见 `sourceGridFps`），
                          // 所以时长要用同一个帧率格式化，否则显示的秒数和时间轴上的占位不一致
                          <>
                            {(source.sampleRate / 1000).toFixed(1)}kHz ·{" "}
                            {source.channels === 1 ? "单声道" : `${source.channels} 声道`} ·{" "}
                            {formatDuration(
                              sourceDurationFrames(source, timeline.fps),
                              timeline.fps,
                            )}
                          </>
                        )}
                      </span>
                      <ProxyBadge info={proxies[source.id]} />
                    </span>
                    <button
                      type="button"
                      className="ib sm del"
                      title={
                        (sourceRefs.get(source.id) ?? 0) > 0
                          ? `删除素材（时间轴上引用它的 ${sourceRefs.get(source.id)} 个片段会一起删除）`
                          : "删除素材"
                      }
                      onClick={() => confirmRemoveSource(source, sourceRefs.get(source.id) ?? 0)}
                    >
                      <IconTrash />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="pool-foot">
            <label className="file-btn">
              <IconPlus />
              导入素材
              <input
                type="file"
                // 音频也收：配乐和旁白是纯音频文件，而混流、波形、音量包络、
                // 交叉淡化早就都能用了，此前缺的只有这个入口（见 `probeFile`）
                accept="video/*,audio/*,image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void importFile(file);
                  e.target.value = ""; // 允许重复导入同一文件
                }}
              />
            </label>
          </div>
        </div>

        {/* 导出时禁掉预览播放：预览和导出会抢同一批解码器，
            而且用户此时的注意力在进度上，播放只会拖慢导出 */}
        <Preview disabled={exportOpen} />

        <div className="pane right">
          <div className="pane-hd">
            <h3>检查器</h3>
          </div>
          <div className="pane-body">
            <Inspector />
          </div>
        </div>
      </div>

      {/* ---------- 时间轴 ---------- */}
      <TimelinePanel />

      {/* ---------- 状态栏 ---------- */}
      <div className="ed-foot">
        <span className="m">
          {framesToTimecode(playhead, timeline.fps)} · 帧 {playhead}
        </span>
        <span className="sel">
          {/* 拖拽提示优先：它是正在进行的操作的实时反馈 */}
          {dragHint ? (
            <span className="reject">{dragHint}</span>
          ) : error ? (
            <span className="reject">{error}</span>
          ) : lastRejection ? (
            <span className="reject">{lastRejection}</span>
          ) : busy ? (
            busy
          ) : selected ? (
            `${selected.clip.name ?? selected.clip.id} · ${selected.track.id} · ${clipDuration(selected.clip)}f`
          ) : selectedClipIds.length > 1 ? (
            `已选中 ${selectedClipIds.length} 个片段${selectedRange ? ` · 跨 ${selectedRange.outFrame - selectedRange.inFrame}f` : ""}`
          ) : (
            "未选中片段"
          )}
        </span>
        <div className="spacer" />
        <div className="caps">
          {caps ? (
            <>
              <i className={caps.mp4Video ? "y" : "n"}>
                {caps.mp4Video ? <IconCheck /> : <IconNo />}
                {caps.mp4Video ? `${caps.mp4Video} 硬编` : "无 MP4 编码器"}
              </i>
              <i className={caps.aac ? "y" : "n"}>
                {caps.aac ? <IconCheck /> : <IconNo />}
                AAC
              </i>
            </>
          ) : (
            <i>探测编码能力…</i>
          )}
          <i>
            <IconWave />
            {timeline.tracks.length} 轨
          </i>
        </div>
      </div>

      {exportOpen && (
        <ExportDialog
          timeline={timeline}
          caps={caps}
          selectedRange={selectedRange}
          onClose={() => setExportOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 落盘失败横幅。形态同 `.ed-recover`（D23 验过 `flex: 0 0 auto` 不挤三栏），
 * 色调用 `--bad`——这是数据丢失级别的警告，不是 D19 那种"看得见的降级"。
 */
function SaveBanner({
  failure,
  plan,
  onCleanup,
  onDismiss,
}: {
  readonly failure: PersistFailure;
  readonly plan: CleanupPlan | null;
  readonly onCleanup: () => void;
  readonly onDismiss: () => void;
}) {
  const copy = bannerCopy(failure);
  // 没东西可清就不摆按钮：一个写着"0 项"的清理入口只会让人以为清理坏了
  const label = plan ? cleanupLabel(plan) : null;
  return (
    <div className="ed-savebar">
      <IconWarn />
      <span className="msg">
        <b>{copy.headline}</b>
        {copy.advice}
      </span>
      {copy.offerCleanup && label && (
        <button type="button" className="chip-btn" onClick={onCleanup}>
          <IconBroom />
          {label}
        </button>
      )}
      <button type="button" className="ib" aria-label="知道了" onClick={onDismiss}>
        <IconX />
      </button>
    </div>
  );
}

/**
 * 代理状态徽标。
 *
 * 这个状态要露出来，因为它解释了用户能观察到的行为：刚导入时预览读原片、
 * 拖播放头会卡；代理就绪后忽然变流畅。不显示的话这变化像是随机的。
 */
function ProxyBadge({ info }: { readonly info: ProxyInfo | undefined }) {
  if (!info || info.status === "none") return null;
  if (info.status === "ready") {
    return (
      <span className="px ok" title="预览走 720p 代理，导出仍读原片">
        <span className="dot" />
        代理就绪
      </span>
    );
  }
  if (info.status === "working") {
    return (
      <>
        <span className="px work">
          <span className="dot pulse" />
          生成代理 {Math.round(info.progress * 100)}%
        </span>
        <span className="mini-bar">
          <i style={{ width: `${Math.round(info.progress * 100)}%` }} />
        </span>
      </>
    );
  }
  if (info.status === "queued") {
    return (
      <span className="px wait">
        <span className="dot" />
        排队中
      </span>
    );
  }
  return (
    <span className="px bad" title={info.reason ?? ""}>
      <span className="dot" />
      代理失败，预览读原片
    </span>
  );
}
