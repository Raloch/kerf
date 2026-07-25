/**
 * 编辑器外壳：四区固定布局（左素材库 / 中预览 / 右检查器 / 下时间轴）。
 *
 * 布局按 design/kerf-editor-mockup.html 定稿实现，不做浮动面板——
 * 沿用 Premiere / Resolve / 剪映共有的骨架，用户不需要重新学（PLAN.md §6）。
 */

import { useCallback, useEffect, useState } from "react";
import { probeFile, wasFpsSnapped } from "../media/probe";
import { probeCapabilities, type ExportCapabilities } from "../media/capability";
import { useTimeline } from "../state/timeline-store";
import { findClip } from "../state/operations";
import { clipDuration } from "../edl/types";
import { formatDuration, framesToTimecode } from "../time/timebase";
import { formatFps } from "../time/rational";
import { Preview } from "./Preview";
import { TimelinePanel } from "./Timeline";
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    probeCapabilities(timeline.width, timeline.height).then(setCaps).catch(() => setCaps(null));
  }, [timeline.width, timeline.height]);

  const importFile = useCallback(
    async (file: File) => {
      setBusy("读取素材…");
      setError(null);
      try {
        const result = await probeFile(file);
        loadSource(result.source);
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
  }, [playhead, redo, removeSelected, setPlayhead, splitAtPlayhead, undo]);

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
        <button type="button" className="btn-primary" disabled={!hasContent} title="M1 后续接入导出面板">
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

        <Preview />

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
                        selected.track.kind === "video" ? "var(--c-video-hi)" : "var(--c-audio-hi)",
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div className="n">
                      {selected.clip.name ??
                        timeline.sources.find((s) => s.id === selected.clip.sourceId)?.name ??
                        selected.clip.id}
                    </div>
                    <div className="s">
                      {selected.track.kind === "video" ? "视频" : "音频"} · {selected.track.id}
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
    </div>
  );
}
