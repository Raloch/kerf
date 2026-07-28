/**
 * 编辑器外壳：四区固定布局（左素材库 / 中预览 / 右检查器 / 下时间轴）。
 *
 * 布局按 design/kerf-editor-mockup.html 定稿实现，不做浮动面板——
 * 沿用 Premiere / Resolve / 剪映共有的骨架，用户不需要重新学（PLAN.md §6）。
 */

import { useCallback, useEffect, useState } from "react";
import type { ExportCapabilities } from "../media/capability";
import { proxyManager } from "../media/proxy-client";
import type { ProxyInfo } from "../media/proxy";
import { useTimeline } from "../state/timeline-store";
// 只要类型：`project-store` 本身走动态 import，别把 IndexedDB 那一层拖进首屏
import type { StoredProject } from "../state/project-store";
import { findClip } from "../state/operations";
import { clipDuration } from "../edl/types";
import { formatDuration, framesToTimecode } from "../time/timebase";
import { formatFps } from "../time/rational";
import { Inspector } from "./Inspector";
import { Preview } from "./Preview";
import { TimelinePanel } from "./Timeline";
import { ExportDialog } from "./ExportDialog";
import {
  IconCheck,
  IconDownload,
  IconFilm,
  IconMark,
  IconNo,
  IconPlus,
  IconRedo,
  IconUndo,
  IconWave,
} from "./icons";
import "./editor.css";

export function Editor({ onOpenSelfCheck }: { readonly onOpenSelfCheck: () => void }) {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const selectedClipId = useTimeline((s) => s.selectedClipId);
  const lastRejection = useTimeline((s) => s.lastRejection);
  const dragHint = useTimeline((s) => s.dragHint);
  const loadSource = useTimeline((s) => s.loadSource);
  const restoreProject = useTimeline((s) => s.restoreProject);
  const setPlayhead = useTimeline((s) => s.setPlayhead);
  const undo = useTimeline((s) => s.undo);
  const redo = useTimeline((s) => s.redo);
  const canUndo = useTimeline((s) => s.canUndo());
  const canRedo = useTimeline((s) => s.canRedo());
  const undoLabel = useTimeline((s) => s.undoLabel());
  const redoLabel = useTimeline((s) => s.redoLabel());
  const splitAtPlayhead = useTimeline((s) => s.splitAtPlayhead);
  const removeSelected = useTimeline((s) => s.removeSelected);

  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [proxies, setProxies] = useState<Record<string, ProxyInfo>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  /**
   * 崩溃恢复的三个状态：还在问 IndexedDB（`undefined`）、没有可恢复的（`null`）、
   * 有一份待用户表态（`StoredProject`）。
   *
   * 三态而不是"有/没有"：自动存盘**必须等这个决定做完**才能开工，而"还没问出来"
   * 和"问出来没有"在那件事上是两种处理。搞混的后果是空时间轴当场把待恢复的快照
   * 覆盖掉——用户看着提示，按下去已经什么都没有了。见 `autosave.ts` 文件头。
   */
  const [recover, setRecover] = useState<StoredProject | null | undefined>(undefined);
  const [recoverNote, setRecoverNote] = useState<string | null>(null);

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

  // 挂载时先问一次"上次崩了吗"。**在这之前一个字节都不能往回写**，理由见 `recover`
  useEffect(() => {
    let stale = false;
    void import("../state/project-store")
      .then(({ loadProject }) => loadProject())
      .then((found) => {
        if (!stale) setRecover(found);
      })
      .catch(() => {
        // 读不出来就当没存过：崩溃恢复失效不该拦住用户开始编辑
        if (!stale) setRecover(null);
      });
    return () => {
      stale = true;
    };
  }, []);

  /**
   * **只有 `recover === null` 才开自动存盘**，也就是"没有待决定的恢复"。
   *
   * 另两个状态都不能开，而且理由是同一个：`undefined`（还在问）和一份待表态的快照，
   * 这两个时刻 store 里都是那个空时间轴，存下去就把待恢复的快照冲成空的。
   * 用户点了恢复或不恢复之后，两条路都把它置成 null，自动存盘随之开工。
   */
  useEffect(() => {
    if (recover !== null) return;
    let stop: (() => void) | undefined;
    void import("../state/autosave").then(({ startAutosave }) => {
      stop = startAutosave();
    });
    return () => stop?.();
  }, [recover]);

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

  /**
   * 真正救回来了几个片段，以及丢了哪些素材。
   *
   * **不能拿快照里的片段数当这个数**：素材读不回来的片段已经被 `fromSnapshot`
   * 移除了（留着会让预览崩，见 `project-snapshot.ts`），所以"存的时候有 12 个"
   * 和"现在能给你 12 个"是两件事。为 0 时连问都不该问。
   */
  const recoverable = recover
    ? recover.timeline.tracks.reduce((n, t) => n + t.clips.length, 0)
    : 0;
  const lostNames = recover
    ? recover.droppedSources.filter((d) => d.clips > 0).map((d) => d.name)
    : [];

  /** 接受恢复。素材已经在 `loadProject()` 里验过读得动了，这里只是装回 store。 */
  const acceptRecover = useCallback(() => {
    if (!recover) return;
    restoreProject(recover.timeline, recover.playhead);
    // **丢了什么必须说出来。** 素材找不回来会连带移除片段，静默处理就是让用户
    // 在导出时才发现少了东西（同硬规则 10 那类"选了 A 拿到 B"）
    const lost = recover.droppedSources.filter((d) => d.clips > 0);
    const notes = [
      ...lost.map((d) => `${d.name} 找不到了，用到它的 ${d.clips} 个片段已移除`),
      ...(recover.droppedLuts.length > 0
        ? [`${recover.droppedLuts.join("、")} 这几张 LUT 没读回来，相关片段的调色已退回不上表`]
        : []),
    ];
    setRecoverNote(notes.length > 0 ? notes.join("；") : null);
    setRecover(null);
  }, [recover, restoreProject]);

  const discardRecover = useCallback(() => {
    // **真删。** 只是不用它的话，下次打开又会问一遍同一个已经被拒绝过的项目
    void import("../state/project-store").then(({ clearProject }) => clearProject());
    setRecover(null);
  }, []);

  const importFile = useCallback(
    async (file: File) => {
      setBusy("读取素材…");
      setError(null);
      try {
        const { probeFile, wasFpsSnapped } = await import("../media/probe");
        const result = await probeFile(file);
        loadSource(result.source);
        // 素材文件单独收进资产库，**导入时一次**——快照每次编辑都重写，把几百 MB
        // 的 File 混在里面会让自动存盘变成最慢的那一步（见 `project-store.ts`）
        void import("../state/project-store").then(({ putSourceAsset }) =>
          putSourceAsset(result.source),
        );
        void proxyManager.request(result.source);
        if (wasFpsSnapped(result)) {
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
    [loadSource],
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
  }, [exportOpen, playhead, redo, removeSelected, setPlayhead, splitAtPlayhead, undo]);

  // 检查器自己从 store 读选中片段；这里留一份是给状态栏和导出范围用的
  const selected = selectedClipId ? findClip(timeline, selectedClipId) : undefined;
  const hasContent = timeline.durationFrames > 0;

  return (
    <div className="ed">
      {/* ---------- 顶栏 ---------- */}
      <div className="ed-top">
        <div className="brand">
          <IconMark className="mark" />
          <b>KERF</b>
        </div>
        <div className="proj">
          <span className="name">{timeline.sources[0]?.name ?? "未命名项目"}</span>
          <span className="sub">
            {hasContent
              ? `${timeline.width}×${timeline.height} · ${formatFps(timeline.fps)} fps`
              : "还没有素材"}
          </span>
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
        崩溃恢复。**问而不是直接恢复**：Kerf 只有一个隐含项目、没有项目列表，
        静默替换会让"打开就是上次的样子"和"恢复错了一份陈旧项目"分不开，而且素材
        找不回来时必须有个地方说这件事。同硬规则 10 的做法——降级要标注，不必禁止。
      */}
      {recover && (
        <div className={`ed-recover${recoverable === 0 ? " warn" : ""}`}>
          {recoverable === 0 ? (
            /*
              一个片段都救不回来时**不能还问"要不要恢复"**：按下去得到一个空时间轴，
              而提示刚说过"上次的编辑没有正常结束"，读起来像恢复失败了。这一支照样
              要说清楚原因——静默丢掉才是最坏的，用户既失去了项目也不知道为什么。
            */
            <>
              <span>
                上次的编辑（{new Date(recover.savedAt).toLocaleString()}）恢复不了：
                {lostNames.length > 0
                  ? `用到的素材已经找不到了（${lostNames.join("、")}）`
                  : "里面已经没有片段了"}
              </span>
              <button type="button" className="chip-btn" onClick={discardRecover}>
                知道了
              </button>
            </>
          ) : (
            <>
              <span>
                上次的编辑没有正常结束（{new Date(recover.savedAt).toLocaleString()}，
                {recoverable} 个片段）
                {lostNames.length > 0 && ` · 其中有素材找不回来了，恢复时会说明`}
              </span>
              <button type="button" className="btn-primary" onClick={acceptRecover}>
                恢复
              </button>
              <button type="button" className="chip-btn" onClick={discardRecover}>
                不恢复
              </button>
            </>
          )}
        </div>
      )}
      {recoverNote && (
        <div className="ed-recover warn">
          <span>{recoverNote}</span>
          <button type="button" className="chip-btn" onClick={() => setRecoverNote(null)}>
            知道了
          </button>
        </div>
      )}

      {/* ---------- 三栏 ---------- */}
      <div className="ed-body">
        <div className="pane left">
          <div className="pane-hd">
            <h3>素材</h3>
          </div>
          <div className="pane-body">
            {timeline.sources.length === 0 ? (
              <p className="empty">还没有素材。导入一个视频文件开始，或用顶栏的「M0 自检」生成测试素材。</p>
            ) : (
              <div className="assets">
                {timeline.sources.map((source) => (
                  <button type="button" className="asset" key={source.id} title={source.name}>
                    <span className="thumb">
                      <IconFilm />
                    </span>
                    <span>
                      <span className="nm">{source.name}</span>
                      <span className="meta">
                        {source.width}×{source.height} · {formatFps(source.fps)} ·{" "}
                        {formatDuration(source.durationFrames, source.fps)}
                      </span>
                      <ProxyBadge info={proxies[source.id]} />
                    </span>
                  </button>
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
                accept="video/*"
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
          selectedRange={
            selected
              ? { inFrame: selected.clip.timelineIn, outFrame: selected.clip.timelineOut }
              : null
          }
          onClose={() => setExportOpen(false)}
        />
      )}
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
