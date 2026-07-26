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
import { findClip } from "../state/operations";
import { clipDuration } from "../edl/types";
import { formatDuration, framesToTimecode } from "../time/timebase";
import { formatFps } from "../time/rational";
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

  const importFile = useCallback(
    async (file: File) => {
      setBusy("读取素材…");
      setError(null);
      try {
        const { probeFile, wasFpsSnapped } = await import("../media/probe");
        const result = await probeFile(file);
        loadSource(result.source);
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

  const selected = selectedClipId ? findClip(timeline, selectedClipId) : undefined;
  const hasContent = timeline.durationFrames > 0;

  // 先落到 const 局部变量再判别：`selected.clip.kind` 这种属性路径的收窄
  // 进不到 `find()` 的回调里（TS 只对 const 变量保留收窄），在 JSX 里直接写会编译不过
  const selectedClip = selected?.clip;
  const selectedSourceName =
    selectedClip?.kind === "media"
      ? timeline.sources.find((s) => s.id === selectedClip.sourceId)?.name
      : undefined;

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
            {!selected ? (
              <p className="empty">未选中片段。点时间轴上的片段查看属性。</p>
            ) : (
              <>
                <div className="insp-hd">
                  <span
                    className="swatch"
                    style={{
                      background:
                        selected.clip.kind === "text"
                          ? "var(--c-text-hi)"
                          : selected.track.kind === "video"
                            ? "var(--c-video-hi)"
                            : "var(--c-audio-hi)",
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="n">
                      {selected.clip.name ??
                        (selected.clip.kind === "text" ? selected.clip.text : selectedSourceName) ??
                        selected.clip.id}
                    </div>
                    <div className="s">
                      {selected.clip.kind === "text"
                        ? "文字"
                        : selected.track.kind === "video"
                          ? "视频"
                          : "音频"}{" "}
                      · {selected.track.id}
                    </div>
                  </div>
                </div>
                <div className="grp-title">时间轴位置</div>
                <div className="fields">
                  <div className="f">
                    <label>入点</label>
                    <span className="val">
                      {framesToTimecode(selected.clip.timelineIn, timeline.fps)}
                    </span>
                  </div>
                  <div className="f">
                    <label>出点</label>
                    <span className="val">
                      {framesToTimecode(selected.clip.timelineOut, timeline.fps)}
                    </span>
                  </div>
                  <div className="f">
                    <label>时长</label>
                    <span className="val">
                      {clipDuration(selected.clip)} 帧 ·{" "}
                      {formatDuration(clipDuration(selected.clip), timeline.fps)}
                    </span>
                  </div>
                </div>
                {selected.clip.kind === "text" ? (
                  <>
                    <div className="grp-title">文字内容</div>
                    <div className="fields">
                      <div className="f">
                        <label>文本</label>
                        <span className="val">{selected.clip.text}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="grp-title">源片引用</div>
                    <div className="fields">
                      <div className="f">
                        <label>源起始帧</label>
                        <span className="val">{selected.clip.sourceIn}</span>
                      </div>
                      <div className="f">
                        <label>源时间码</label>
                        <span className="val">
                          {framesToTimecode(selected.clip.sourceIn, timeline.fps)}
                        </span>
                      </div>
                    </div>
                  </>
                )}
                <p className="empty">变换、速度、滤镜、音量包络在 M2 接入。</p>
              </>
            )}
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
