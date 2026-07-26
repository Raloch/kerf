/**
 * 导出对话框：设置 → 进行中 → 完成三态。
 *
 * 按 design/kerf-editor-mockup.html 的定稿实现，几处刻意的设计（PLAN.md §6）：
 *
 * - **右侧先摊开「本机能力」再让用户选格式**（§6 界面原则）。客户端导出的成败
 *   取决于本机能力，用户点导出之前就该知道自己能导出什么。
 * - **缺 AAC 时禁掉 MP4，但把原因写在选项里**（决策 D3）。不静默降级成 WebM，
 *   也不用整体 `opacity` 压暗——那会把"为什么不可用"的说明一起压到读不清，
 *   所以只降级主标签和单选圈，说明文字保持完整对比度。
 * - **预设用场景词做主标签，参数留在同一行**（决策 D4）。
 *
 * 保存位置的 picker **必须在用户手势的同步链里调起**，所以它在「开始导出」的
 * 点击回调里第一件事就调，不能等 await 混音之后再调（那时手势已经过期，
 * 浏览器会抛 SecurityError）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startExport, type ExportHandle } from "../export/client";
import {
  DEFAULT_PRESET_ID,
  describePreset,
  estimateBytes,
  PRESETS,
  resolvePreset,
} from "../export/presets";
import type { ExportDone, ExportProgress } from "../export/protocol";
import { canPickSaveFile, pickWriteTarget } from "../export/write-target";
import type { ExportCapabilities } from "../media/capability";
import type { ContainerChoice } from "../media/capability";
import type { RenderRange, Timeline } from "../edl/types";
import { formatDuration, frameToSeconds } from "../time/timebase";
import { formatFps } from "../time/rational";
import { IconCheck, IconDownload, IconFolder, IconNo, IconWarn, IconX } from "./icons";

type Phase =
  | { readonly kind: "settings" }
  | { readonly kind: "running"; readonly progress: ExportProgress }
  | { readonly kind: "done"; readonly result: ExportDone }
  | { readonly kind: "error"; readonly message: string };

export interface ExportDialogProps {
  readonly timeline: Timeline;
  readonly caps: ExportCapabilities | null;
  /** 选中片段的区间，有选中时提供「只导选中片段」这条路。 */
  readonly selectedRange: RenderRange | null;
  readonly onClose: () => void;
}

export function ExportDialog({ timeline, caps, selectedRange, onClose }: ExportDialogProps) {
  const [container, setContainer] = useState<ContainerChoice>("mp4");
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [wholeTimeline, setWholeTimeline] = useState(true);
  const [baseName, setBaseName] = useState(() => defaultName(timeline));
  const [phase, setPhase] = useState<Phase>({ kind: "settings" });
  const handleRef = useRef<ExportHandle | null>(null);

  const hasAudio = timeline.tracks.some(
    (t) => t.kind === "audio" && !t.muted && t.clips.length > 0,
  );
  const aacMissing = caps !== null && !caps.aac;
  // 缺 AAC 只在"这次导出真的有音频"时才挡住 MP4：纯画面的片子导 MP4 没问题
  const mp4Blocked = caps !== null && (!caps.mp4Video || (hasAudio && !caps.aac));
  const webmBlocked = caps !== null && !caps.webmVideo;

  // MP4 被挡住时自动落到 WebM，但**不是静默降级**：MP4 选项就地写着原因，
  // 用户看到的是"MP4 不可用 + 已经帮你选了 WebM"，而不是点了 MP4 拿到 WebM
  useEffect(() => {
    if (mp4Blocked && container === "mp4" && !webmBlocked) setContainer("webm");
  }, [container, mp4Blocked, webmBlocked]);

  const range: RenderRange = useMemo(
    () =>
      wholeTimeline || !selectedRange
        ? { inFrame: 0, outFrame: timeline.durationFrames }
        : selectedRange,
    [selectedRange, timeline.durationFrames, wholeTimeline],
  );

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;
  const resolved = resolvePreset(preset, timeline.width, timeline.height, timeline.fps);
  const totalFrames = Math.max(0, range.outFrame - range.inFrame);
  const seconds = frameToSeconds(totalFrames, timeline.fps);
  const ext = container === "mp4" ? "mp4" : "webm";
  const filename = `${baseName || "kerf-export"}.${ext}`;

  const start = useCallback(async () => {
    // picker 要在手势里同步调起：这里是 onClick 的第一个 await 之前
    let target;
    try {
      target = await pickWriteTarget(filename, container);
    } catch {
      // 用户在保存对话框里按了取消，不算错误，留在设置态
      return;
    }

    setPhase({
      kind: "running",
      progress: { stage: "mix", encodedFrames: 0, totalFrames, elapsedMs: 0 },
    });

    // 预设可能要求比时间轴更低的分辨率：导出用的是套过预设的时间轴副本，
    // 原时间轴不动（改了会连预览一起变）
    const exportTimeline: Timeline = {
      ...timeline,
      width: resolved.width,
      height: resolved.height,
    };

    const handle = startExport(
      {
        timeline: exportTimeline,
        range,
        container,
        videoBitrate: resolved.videoBitrate,
        audioBitrate: resolved.audioBitrate,
        includeAudio: hasAudio,
        target,
      },
      (progress) => setPhase({ kind: "running", progress }),
    );
    handleRef.current = handle;

    try {
      const result = await handle.done;
      if (!result) {
        setPhase({ kind: "settings" });
        return;
      }
      setPhase({ kind: "done", result });
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      handleRef.current = null;
    }
  }, [container, filename, hasAudio, range, resolved, timeline, totalFrames]);

  // 导出中不允许 Esc 关掉：那样 Worker 还在跑，用户以为停了
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (phase.kind === "running") return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, phase.kind]);

  return (
    <div className="scrim">
      <div className="dlg" role="dialog" aria-modal="true" aria-label="导出">
        {phase.kind === "settings" && (
          <>
            <div className="dlg-hd">
              <span className="hd-ic">
                <IconDownload />
              </span>
              <h2>导出</h2>
              <button type="button" className="ib" aria-label="关闭" onClick={onClose}>
                <IconX />
              </button>
            </div>

            <div className="dlg-body">
              <div className="two">
                <div>
                  <div className="fld">
                    <div className="k">格式</div>
                    <div className="opt">
                      <FormatOption
                        checked={container === "mp4"}
                        disabled={mp4Blocked}
                        label="MP4"
                        sub="H.264 + AAC · 通用性最好"
                        tag={!mp4Blocked ? "推荐" : null}
                        why={
                          mp4Blocked
                            ? aacMissing && hasAudio
                              ? "这个浏览器不能编码 AAC，导出 MP4 会没有声音 · 改用 WebM，或换 Chrome / Safari"
                              : "本机没有可用的 MP4 视频编码器"
                            : null
                        }
                        onSelect={() => setContainer("mp4")}
                      />
                      <FormatOption
                        checked={container === "webm"}
                        disabled={webmBlocked}
                        label="WebM"
                        sub="VP9 + Opus · 体积更小"
                        tag={mp4Blocked && !webmBlocked ? "可用" : null}
                        why={webmBlocked ? "本机没有可用的 WebM 视频编码器" : null}
                        onSelect={() => setContainer("webm")}
                      />
                    </div>
                  </div>

                  <div className="row2">
                    <div className="fld">
                      <div className="k">预设</div>
                      <select
                        className="sel-box"
                        aria-label="预设"
                        value={presetId}
                        onChange={(e) => setPresetId(e.target.value)}
                      >
                        {PRESETS.map((p) => {
                          const r = resolvePreset(p, timeline.width, timeline.height, timeline.fps);
                          return (
                            <option key={p.id} value={p.id}>
                              {p.scene} · {describePreset(r, p)}
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    <div className="fld">
                      <div className="k">范围</div>
                      <select
                        className="sel-box"
                        aria-label="导出范围"
                        value={wholeTimeline ? "all" : "selection"}
                        onChange={(e) => setWholeTimeline(e.target.value === "all")}
                      >
                        <option value="all">
                          整条时间轴 · {formatDuration(timeline.durationFrames, timeline.fps)}
                        </option>
                        {selectedRange && (
                          <option value="selection">
                            选中片段 ·{" "}
                            {formatDuration(
                              selectedRange.outFrame - selectedRange.inFrame,
                              timeline.fps,
                            )}
                          </option>
                        )}
                      </select>
                    </div>
                  </div>

                  <div className="fld last">
                    <div className="k">保存到</div>
                    <div className="path">
                      <input
                        className="p"
                        aria-label="文件名"
                        value={baseName}
                        onChange={(e) => setBaseName(e.target.value)}
                      />
                      <span className="ext m">.{ext}</span>
                    </div>
                    <p className="fld-note">
                      {canPickSaveFile() ? (
                        <>
                          <IconFolder />
                          点「开始导出」后选保存位置，边编码边写盘
                        </>
                      ) : (
                        <>
                          <IconWarn />
                          这个浏览器没有保存对话框，成品先写进浏览器存储再触发下载
                        </>
                      )}
                    </p>
                  </div>
                </div>

                <div className="card">
                  <div className="ttl">本机能力</div>
                  <div className="cap-list">
                    <CapRow
                      ok={Boolean(caps?.mp4Video)}
                      label="MP4 视频编码"
                      value={caps?.mp4Video ?? "不可用"}
                    />
                    <CapRow
                      ok={Boolean(caps?.webmVideo)}
                      label="WebM 视频编码"
                      value={caps?.webmVideo ?? "不可用"}
                    />
                    <CapRow ok={Boolean(caps?.aac)} label="AAC 音频编码" value={caps?.aac ? "可用" : "不支持"} />
                    <CapRow ok={Boolean(caps?.opus)} label="Opus 音频编码" value={caps?.opus ? "可用" : "不支持"} />
                    <CapRow
                      ok={canPickSaveFile()}
                      label="流式写盘"
                      value={canPickSaveFile() ? "直写文件" : "先落浏览器存储"}
                      warn={!canPickSaveFile()}
                    />
                  </div>
                  <div className="est">
                    <div>
                      <span>输出</span>
                      <b>
                        {resolved.width}×{resolved.height}
                      </b>
                    </div>
                    <div>
                      <span>待编码</span>
                      <b>{totalFrames} 帧</b>
                    </div>
                    <div>
                      <span>时长</span>
                      <b>{formatDuration(totalFrames, timeline.fps)}</b>
                    </div>
                    <div>
                      <span>预计体积</span>
                      <b>~{(estimateBytes(resolved, seconds, hasAudio) / 1e6).toFixed(0)} MB</b>
                    </div>
                    <div>
                      <span>音频</span>
                      <b>{hasAudio ? "混流后写入" : "无音轨"}</b>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="dlg-foot">
              <span className="note">导出全程在本机完成，素材不会上传。</span>
              <button type="button" className="btn-ghost" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={totalFrames <= 0 || (mp4Blocked && webmBlocked)}
                onClick={() => void start()}
              >
                开始导出
              </button>
            </div>
          </>
        )}

        {phase.kind === "running" && (
          <RunningView
            progress={phase.progress}
            filename={filename}
            fps={timeline.fps}
            onCancel={() => handleRef.current?.cancel()}
          />
        )}

        {phase.kind === "done" && (
          <>
            <div className="dlg-hd">
              <span className="hd-ic ok">
                <IconCheck />
              </span>
              <h2>导出完成</h2>
              <button type="button" className="ib" aria-label="关闭" onClick={onClose}>
                <IconX />
              </button>
            </div>
            <div className="dlg-body">
              <div className="done-wrap">
                <div className="done-ic">
                  <IconCheck />
                </div>
                <div>
                  <div className="done-nm">{filename}</div>
                  <div className="done-meta m">
                    {(phase.result.bytesWritten / 1e6).toFixed(1)} MB · {resolved.width}×
                    {resolved.height} · {formatFps(timeline.fps)} fps ·{" "}
                    {phase.result.audioIncluded ? "含音频" : "无音频"} · 用时{" "}
                    {(phase.result.elapsedMs / 1000).toFixed(1)} 秒（
                    {(
                      frameToSeconds(phase.result.encodedFrames, timeline.fps) /
                      (phase.result.elapsedMs / 1000)
                    ).toFixed(2)}
                    × 实时）
                  </div>
                  <div className="done-meta m dim">
                    {phase.result.opfsName
                      ? "已写入浏览器存储并触发下载"
                      : "已写入你选择的文件"}
                    {" · "}
                    {phase.result.mimeType}
                  </div>
                </div>
              </div>
            </div>
            <div className="dlg-foot">
              <span className="note" />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPhase({ kind: "settings" })}
              >
                再导一份
              </button>
              <button type="button" className="btn-primary" onClick={onClose}>
                完成
              </button>
            </div>
          </>
        )}

        {phase.kind === "error" && (
          <>
            <div className="dlg-hd">
              <span className="hd-ic bad">
                <IconNo />
              </span>
              <h2>导出失败</h2>
              <button type="button" className="ib" aria-label="关闭" onClick={onClose}>
                <IconX />
              </button>
            </div>
            <div className="dlg-body">
              <p className="err-msg">{phase.message}</p>
            </div>
            <div className="dlg-foot">
              <span className="note">时间轴和素材没有受影响。</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setPhase({ kind: "settings" })}
              >
                返回设置
              </button>
              <button type="button" className="btn-primary" onClick={onClose}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 进行中：四段阶段指示 + 速度/剩余。 */
function RunningView({
  progress,
  filename,
  fps,
  onCancel,
}: {
  readonly progress: ExportProgress;
  readonly filename: string;
  readonly fps: Timeline["fps"];
  readonly onCancel: () => void;
}) {
  const stages: { readonly key: ExportProgress["stage"]; readonly label: string }[] = [
    { key: "mix", label: "混音" },
    { key: "prepare", label: "准备编码器" },
    { key: "video", label: "解码 → 合成 → 编码" },
    { key: "finalize", label: "封装写盘" },
  ];
  const currentIndex = stages.findIndex((s) => s.key === progress.stage);

  // 只有 video 阶段有可靠的分母；混音和准备阶段不假装有百分比
  const ratio =
    progress.stage === "video" || progress.stage === "finalize"
      ? progress.encodedFrames / Math.max(1, progress.totalFrames)
      : 0;
  const elapsedSeconds = progress.elapsedMs / 1000;
  const encodeFps = elapsedSeconds > 0 ? progress.encodedFrames / elapsedSeconds : 0;
  const realtime = elapsedSeconds > 0 ? frameToSeconds(progress.encodedFrames, fps) / elapsedSeconds : 0;
  const remaining =
    encodeFps > 0 ? (progress.totalFrames - progress.encodedFrames) / encodeFps : null;

  return (
    <>
      <div className="dlg-hd">
        <span className="hd-ic">
          <IconDownload />
        </span>
        <h2>正在导出</h2>
      </div>
      <div className="dlg-body">
        <div className="run-top">
          <span className="run-nm">{filename}</span>
          <span className="run-pct m">
            {Math.round(ratio * 100)}
            <small>%</small>
          </span>
        </div>
        <div className="bar">
          <i style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
        <div className="stages">
          {stages.map((s, i) => (
            <div
              key={s.key}
              className="stg"
              {...(i === currentIndex ? { "data-on": "1" } : {})}
              {...(i < currentIndex ? { "data-done": "1" } : {})}
            >
              {s.label}
            </div>
          ))}
        </div>
        <div className="run-nums">
          <div className="rn">
            <div className="k">已编码</div>
            <div className="v">
              {progress.encodedFrames}
              <small> / {progress.totalFrames}</small>
            </div>
          </div>
          <div className="rn">
            <div className="k">速度</div>
            <div className="v">
              {encodeFps.toFixed(0)}
              <small> fps · {realtime.toFixed(2)}×</small>
            </div>
          </div>
          <div className="rn">
            <div className="k">剩余</div>
            <div className="v">
              {remaining === null ? "—" : Math.ceil(remaining)}
              {remaining !== null && <small> 秒</small>}
            </div>
          </div>
          <div className="rn">
            <div className="k">已用</div>
            <div className="v">
              {elapsedSeconds.toFixed(0)}
              <small> 秒</small>
            </div>
          </div>
        </div>
      </div>
      <div className="dlg-foot">
        <span className="note">关闭标签页会中断导出。解码与编码都在 Worker 里，界面可以继续操作。</span>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          取消导出
        </button>
      </div>
    </>
  );
}

/**
 * 格式单选项。
 *
 * 不可用时**不用整体 opacity 压暗**（决策 D3）：那会把 `why` 里的原因说明一起
 * 压到读不清，而"为什么不可用"正是这一行最重要的信息。只降级主标签和单选圈。
 */
function FormatOption({
  checked,
  disabled,
  label,
  sub,
  tag,
  why,
  onSelect,
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly sub: string;
  readonly tag: string | null;
  readonly why: string | null;
  readonly onSelect: () => void;
}) {
  return (
    <div
      className="o"
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      {...(disabled ? { "data-off": "1" } : {})}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="radio" />
      <span>
        {label}
        <span className="sub">{sub}</span>
        {why && <span className="why">{why}</span>}
      </span>
      <span>{tag && <span className="tagr">{tag}</span>}</span>
    </div>
  );
}

function CapRow({
  ok,
  label,
  value,
  warn,
}: {
  readonly ok: boolean;
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}) {
  return (
    <div className={`cap ${warn ? "w" : ok ? "y" : "n"}`}>
      <span className="s">{warn ? <IconWarn /> : ok ? <IconCheck /> : <IconNo />}</span>
      {label}
      <em>{value}</em>
    </div>
  );
}

function defaultName(timeline: Timeline): string {
  const first = timeline.sources[0]?.name ?? "kerf-export";
  return first.replace(/\.[^.]+$/, "");
}
