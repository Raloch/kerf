/**
 * M0 的验证面板。
 *
 * 刻意做得很朴素——M0 的交付物是"管道跑通且时间基正确"，不是界面。
 * 真正的编辑器 UI 在 M1 按 design/kerf-editor-mockup.html 实现。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { probeFile, wasFpsSnapped, type ProbeResult } from "../media/probe";
import { describeCapabilities, probeCapabilities, type ExportCapabilities } from "../media/capability";
import { singleClipTimeline } from "../edl/types";
import { downloadBytes, startExport, type ExportHandle } from "../export/client";
import type { ExportProgress } from "../export/protocol";
import { framesToTimecode, formatDuration, frameToSeconds } from "../time/timebase";
import { formatFps, toNumber } from "../time/rational";
// dev 工具走动态 import：只在点击时加载，不进主包
import type { VerifyResult } from "../dev/verify-m0";
import type { PreviewVerifyResult } from "../dev/verify-preview";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "exporting"; progress: ExportProgress }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function M0Panel({ onBack }: { readonly onBack: () => void }) {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [container, setContainer] = useState<"mp4" | "webm">("mp4");
  const [inFrame, setInFrame] = useState(0);
  const [outFrame, setOutFrame] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [pv, setPv] = useState<PreviewVerifyResult | null>(null);
  const handleRef = useRef<ExportHandle | null>(null);
  const firstFrameRef = useRef<HTMLCanvasElement>(null);
  const lastFrameRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!probe) return;
    probeCapabilities(probe.source.width, probe.source.height).then(setCaps).catch(() => setCaps(null));
  }, [probe]);

  const loadFile = useCallback(async (file: File) => {
    setStatus({ kind: "busy", label: "读取素材…" });
    try {
      const result = await probeFile(file);
      setProbe(result);
      setInFrame(0);
      setOutFrame(result.source.durationFrames);
      setStatus({ kind: "idle" });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const generateSample = useCallback(async () => {
    setStatus({ kind: "busy", label: "生成测试素材…" });
    try {
      const { makeSampleVideo } = await import("../dev/make-sample");
      const sample = await makeSampleVideo({ durationFrames: 300 });
      await loadFile(sample.file);
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, [loadFile]);

  const runVerify = useCallback(async () => {
    setVerify(null);
    setStatus({ kind: "busy", label: "运行 M0 自检（生成 → 探测 → trim 导出 → 读回断言）…" });
    try {
      const { verifyM0 } = await import("../dev/verify-m0");
      const result = await verifyM0({
        firstFrameCanvas: firstFrameRef.current ?? undefined,
        lastFrameCanvas: lastFrameRef.current ?? undefined,
      });
      setVerify(result);
      setStatus({
        kind: result.passed ? "done" : "error",
        text: result.passed
          ? `M0 自检通过：${result.checks.length} 项断言全部成立 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`
          : `M0 自检失败：${result.checks.filter((c) => !c.pass).length} 项断言不成立`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const runPreviewCheck = useCallback(async () => {
    setPv(null);
    setStatus({ kind: "busy", label: "运行预览／导出一致性自检（同一帧两条路径逐像素比对）…" });
    try {
      const { verifyPreviewMatchesExport } = await import("../dev/verify-preview");
      const result = await verifyPreviewMatchesExport();
      setPv(result);
      setStatus({
        kind: result.passed ? "done" : "error",
        text: result.passed
          ? `预览与导出画面一致：${result.checks.length} 项断言全部成立`
          : `不一致：${result.checks.filter((c) => !c.pass).length} 项断言失败`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const doExport = useCallback(async () => {
    if (!probe) return;
    const source = probe.source;
    const timeline = singleClipTimeline(source, { inFrame, outFrame });

    setStatus({
      kind: "exporting",
      progress: { stage: "prepare", encodedFrames: 0, totalFrames: timeline.durationFrames, elapsedMs: 0 },
    });

    const handle = startExport(
      {
        file: source.file,
        container,
        fps: source.fps,
        width: source.width,
        height: source.height,
        inFrame,
        outFrame,
        videoBitrate: 8e6,
        audioBitrate: 128e3,
        includeAudio: source.hasAudio,
      },
      (progress) => setStatus({ kind: "exporting", progress }),
    );
    handleRef.current = handle;

    try {
      const result = await handle.done;
      if (!result) {
        setStatus({ kind: "done", text: "已取消导出" });
        return;
      }
      const seconds = result.elapsedMs / 1000;
      const realtime = frameToSeconds(result.encodedFrames, source.fps) / seconds;
      const ext = container === "mp4" ? "mp4" : "webm";
      downloadBytes(result.bytes, `kerf-m0-${inFrame}-${outFrame}.${ext}`, result.mimeType);
      setStatus({
        kind: "done",
        text:
          `导出完成：${result.encodedFrames} 帧 · ${(result.bytes.byteLength / 1e6).toFixed(1)} MB · ` +
          `${seconds.toFixed(1)} 秒（${realtime.toFixed(2)}× 实时）· ` +
          `${result.audioIncluded ? "含音频" : "无音频"} · ${result.mimeType}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      handleRef.current = null;
    }
  }, [probe, container, inFrame, outFrame]);

  const source = probe?.source;
  const exporting = status.kind === "exporting";

  return (
    <main className="m0">
      <header>
        <button type="button" className="back" onClick={onBack}>
          ← 回到编辑器
        </button>
        <h1>Kerf · M0 管道验证</h1>
        <p className="lead">
          验证 decode → compose → encode → mux 全链路与时间基模型。
          编辑器界面在 M1 实现，见 <code>design/kerf-editor-mockup.html</code>。
        </p>
      </header>

      <section>
        <h2>1 · 素材</h2>
        <div className="row">
          <label className="file-btn">
            选择视频文件
            <input
              type="file"
              accept="video/*"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
              }}
            />
          </label>
          <button type="button" onClick={() => void generateSample()} disabled={exporting}>
            生成测试素材（300 帧 @29.97）
          </button>
        </div>

        {source && (
          <dl className="meta">
            <div><dt>文件</dt><dd>{source.name}</dd></div>
            <div><dt>分辨率</dt><dd>{source.width}×{source.height}</dd></div>
            <div>
              <dt>帧率</dt>
              <dd>
                {formatFps(source.fps)}（{source.fps.num}/{source.fps.den}）
                {probe && wasFpsSnapped(probe) && (
                  <span className="hint"> ← 已从探测值 {probe.rawFps.toFixed(6)} 吸附</span>
                )}
              </dd>
            </div>
            <div>
              <dt>时长</dt>
              <dd>
                {source.durationFrames} 帧 · {formatDuration(source.durationFrames, source.fps)} ·
                时间码 {framesToTimecode(source.durationFrames, source.fps)}
              </dd>
            </div>
            <div><dt>编码</dt><dd>{source.videoCodec ?? "未知"} / {source.audioCodec ?? "无音轨"}</dd></div>
          </dl>
        )}
      </section>

      {caps && (
        <section>
          <h2>2 · 本机能力</h2>
          <ul className="caps">
            {describeCapabilities(caps).map((line) => (
              <li key={line} className={line.includes("不") ? "bad" : "ok"}>{line}</li>
            ))}
          </ul>
          {!caps.aac && (
            <p className="warn">
              这个浏览器不能编码 AAC，MP4 会没有声音，因此 MP4 不可用——请导出 WebM。
              这是 PLAN.md 决策 D3 的实现：不静默降级，明确挡住并说明原因。
            </p>
          )}
        </section>
      )}

      {source && (
        <section>
          <h2>3 · 裁剪范围</h2>
          <div className="row">
            <label>
              入点（帧）
              <input
                type="number"
                min={0}
                max={Math.max(0, outFrame - 1)}
                value={inFrame}
                disabled={exporting}
                onChange={(e) => setInFrame(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label>
              出点（帧）
              <input
                type="number"
                min={inFrame + 1}
                max={source.durationFrames}
                value={outFrame}
                disabled={exporting}
                onChange={(e) => setOutFrame(Number(e.target.value) || 0)}
              />
            </label>
            <label>
              容器
              <select
                value={container}
                disabled={exporting}
                onChange={(e) => setContainer(e.target.value as "mp4" | "webm")}
              >
                <option value="mp4" disabled={caps ? !caps.mp4Video || (source.hasAudio && !caps.aac) : false}>
                  MP4{caps && source.hasAudio && !caps.aac ? "（缺 AAC，不可用）" : ""}
                </option>
                <option value="webm" disabled={caps ? !caps.webmVideo : false}>WebM</option>
              </select>
            </label>
          </div>
          <p className="hint">
            {framesToTimecode(inFrame, source.fps)} → {framesToTimecode(outFrame, source.fps)}
            {" · "}共 {Math.max(0, outFrame - inFrame)} 帧
            {" · "}{formatDuration(Math.max(0, outFrame - inFrame), source.fps)}
          </p>
        </section>
      )}

      {source && (
        <section>
          <h2>4 · 导出</h2>
          <div className="row">
            <button type="button" className="primary" onClick={() => void doExport()} disabled={exporting || outFrame <= inFrame}>
              开始导出
            </button>
            {exporting && (
              <button type="button" onClick={() => handleRef.current?.cancel()}>取消</button>
            )}
          </div>

          {status.kind === "exporting" && (
            <div className="progress">
              <div className="bar">
                <i style={{ width: `${(status.progress.encodedFrames / Math.max(1, status.progress.totalFrames)) * 100}%` }} />
              </div>
              <p className="mono">
                {stageLabel(status.progress.stage)} · {status.progress.encodedFrames}/{status.progress.totalFrames} 帧
                {status.progress.encodedFrames > 0 && (
                  <> · {((status.progress.encodedFrames / status.progress.elapsedMs) * 1000).toFixed(1)} fps</>
                )}
                {" · "}{(status.progress.elapsedMs / 1000).toFixed(1)} 秒
              </p>
            </div>
          )}
        </section>
      )}

      <section>
        <h2>M0 自检</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          一键跑完 生成 300 帧素材 → 探测 → 导出第 90–210 帧 → 读回断言。
          画面上有帧号水印，导出首帧应显示 <code>frame 90</code>，用来确认 trim 起点精确到帧。
        </p>
        <button type="button" onClick={() => void runVerify()} disabled={exporting || status.kind === "busy"}>
          运行 M0 自检
        </button>

        {verify && (
          <>
            <table className="checks">
              <tbody>
                {verify.checks.map((c) => (
                  <tr key={c.name} className={c.pass ? "ok" : "bad"}>
                    <td>{c.pass ? "✓" : "✕"}</td>
                    <td>{c.name}</td>
                    <td className="mono">{c.actual}</td>
                    <td className="mono dim">{c.pass ? "" : `期望 ${c.expected}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              导出 {(verify.exportedBytes / 1e6).toFixed(2)} MB · {verify.realtimeFactor.toFixed(2)}× 实时 ·
              自检总耗时 {(verify.elapsedMs / 1000).toFixed(1)} 秒
            </p>
          </>
        )}

        {/* 画布必须常驻 DOM：自检运行时才有帧可画，若放进 verify 条件里，
            那时元素还没挂载、ref 为 null，帧就画不上去（曾踩过） */}
        <div className="frames" style={{ display: verify ? "flex" : "none" }}>
          <figure>
            <canvas ref={firstFrameRef} />
            <figcaption>导出首帧（应为源片 frame 90）</figcaption>
          </figure>
          <figure>
            <canvas ref={lastFrameRef} />
            <figcaption>导出末帧（应为源片 frame 209）</figcaption>
          </figure>
        </div>
      </section>

      <section>
        <h2>预览 / 导出一致性自检</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          硬规则 2 的护栏：用同一份 EDL、同一帧号分别走预览（<code>video</code> seek）和导出
          （<code>VideoDecoder</code> 顺序解码）两条路径，再逐像素比对。刻意用方形输出跑，
          这样 16:9 素材必然产生上下黑边——黑边位置差一个像素就说明两条路径的缩放算法已经分叉。
        </p>
        <button type="button" onClick={() => void runPreviewCheck()} disabled={status.kind === "busy"}>
          运行一致性自检
        </button>

        {pv && (
          <>
            <table className="checks">
              <tbody>
                {pv.checks.map((c) => (
                  <tr key={c.name} className={c.pass ? "ok" : "bad"}>
                    <td>{c.pass ? "✓" : "✕"}</td>
                    <td>{c.name}</td>
                    <td className="mono">{c.actual}</td>
                    <td className="mono dim">{c.pass ? "" : `期望 ${c.expected}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              预览 上边 {pv.preview.top}px · 下边 {pv.preview.bottom}px · 主色 rgb(
              {pv.preview.meanR}, {pv.preview.meanG}, {pv.preview.meanB})
              <br />
              导出 上边 {pv.exported.top}px · 下边 {pv.exported.bottom}px · 主色 rgb(
              {pv.exported.meanR}, {pv.exported.meanG}, {pv.exported.meanB})
            </p>
          </>
        )}
      </section>

      {status.kind === "busy" && <p className="mono">{status.label}</p>}
      {status.kind === "done" && <p className="done mono">{status.text}</p>}
      {status.kind === "error" && <p className="error mono">{status.text}</p>}
    </main>
  );
}

function stageLabel(stage: ExportProgress["stage"]): string {
  switch (stage) {
    case "prepare": return "准备（探测能力、建编码器）";
    case "video": return "解码 → 合成 → 编码";
    case "finalize": return "封装写出";
  }
}
