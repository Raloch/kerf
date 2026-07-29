/**
 * M0 的验证面板。
 *
 * 刻意做得很朴素——M0 的交付物是"管道跑通且时间基正确"，不是界面。
 * 真正的编辑器 UI 在 M1 按 design/kerf-editor-mockup.html 实现。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { probeAvFile, wasFpsSnapped, type AvProbeResult } from "../media/probe";
import { describeCapabilities, type ExportCapabilities } from "../media/capability";
import { probeCapabilities } from "../media/capability-probe";
import { singleClipTimeline } from "../edl/types";
import { startExport, type ExportHandle } from "../export/client";
import { pickWriteTarget } from "../export/write-target";
import type { ExportProgress } from "../export/protocol";
import { formatBytes } from "../export/residency";
import { framesToTimecode, formatDuration, frameToSeconds } from "../time/timebase";
import { formatFps, toNumber } from "../time/rational";
// dev 工具走动态 import：只在点击时加载，不进主包
import type { VerifyResult } from "../dev/verify-m0";
import type { PreviewVerifyResult } from "../dev/verify-preview";
import type { TimelineVerifyResult } from "../dev/verify-timeline";
import type { PixiVerifyResult } from "../dev/verify-pixi";
// 这一条是**值的**静态 import，而 `verify-device.ts` 顶层 import 了 mediabunny。
// 之所以没把那 500KB 拖进主 chunk：那个模块只定义函数和常量、没有顶层副作用，
// 于是 Rollup 把 mediabunny 摇掉了——**实测确认过**（主 chunk 前后逐字节相同，
// 判断方法见 CLAUDE.md「首屏体积」）。给 `verify-device.ts` 加任何顶层副作用都会
// 让这条失效，那时把 LENGTH_LADDER 挪进一个不碰 mediabunny 的小模块。
import { LENGTH_LADDER } from "../dev/verify-device";
import type { DeviceReport, LengthReport, LengthResult } from "../dev/verify-device";

type Status =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "exporting"; progress: ExportProgress }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

export function M0Panel({ onBack }: { readonly onBack: () => void }) {
  const [probe, setProbe] = useState<AvProbeResult | null>(null);
  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [container, setContainer] = useState<"mp4" | "webm">("mp4");
  const [inFrame, setInFrame] = useState(0);
  const [outFrame, setOutFrame] = useState(0);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [pv, setPv] = useState<PreviewVerifyResult | null>(null);
  const [tv, setTv] = useState<TimelineVerifyResult | null>(null);
  const [px, setPx] = useState<PixiVerifyResult | null>(null);
  const [dev, setDev] = useState<DeviceReport | null>(null);
  const [len, setLen] = useState<LengthReport | null>(null);
  /**
   * 已经跑完的档，**边跑边攒**。
   *
   * 和 `len` 分开：`len` 要等整轮返回才有，而"连导 N 次"这种用法下第 N 次卡住时，
   * 前 N−1 次的结果必须已经在屏幕上——不然人只能盯着一行状态文字等 90 秒空转超时，
   * 标签页真被系统杀掉时那些结果还会全部丢掉。
   */
  const [lenRows, setLenRows] = useState<LengthResult[]>([]);
  const [devStep, setDevStep] = useState<string>("");
  const [devCrash, setDevCrash] = useState<string | null>(null);
  const handleRef = useRef<ExportHandle | null>(null);
  const firstFrameRef = useRef<HTMLCanvasElement>(null);
  const lastFrameRef = useRef<HTMLCanvasElement>(null);

  // 上一次运行有没有被系统杀掉。**必须在开跑之前读**，新的一轮会把证据覆盖掉
  useEffect(() => {
    void import("../dev/verify-device").then((m) => setDevCrash(m.previousCrash()));
  }, []);

  useEffect(() => {
    if (!probe) return;
    probeCapabilities(probe.source.width, probe.source.height).then(setCaps).catch(() => setCaps(null));
  }, [probe]);

  const loadFile = useCallback(async (file: File) => {
    setStatus({ kind: "busy", label: "读取素材…" });
    try {
      const result = await probeAvFile(file);
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

  const runTimelineCheck = useCallback(async () => {
    setTv(null);
    setStatus({
      kind: "busy",
      label: "运行多片段一致性自检（两个片段 + 中间空档，整条导出后逐帧比对）…",
    });
    try {
      const { verifyTimelineConsistency } = await import("../dev/verify-timeline");
      const result = await verifyTimelineConsistency();
      setTv(result);
      setStatus({
        kind: result.passed ? "done" : "error",
        text: result.passed
          ? `多片段一致性通过：${result.checks.length} 项断言全部成立 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`
          : `不一致：${result.checks.filter((c) => !c.pass).length} 项断言失败`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const runPixiSpike = useCallback(async () => {
    setPx(null);
    setStatus({
      kind: "busy",
      label: "运行 PixiJS 后端 spike（Worker 里起 WebGL，与 Canvas2D 跑同一份输入）…",
    });
    try {
      const { verifyPixiBackend } = await import("../dev/verify-pixi");
      const result = await verifyPixiBackend();
      setPx(result);
      setStatus({
        kind: result.passed ? "done" : "error",
        text: result.passed
          ? `Pixi 后端可行：${result.checks.length} 项前提全部成立 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`
          : `${result.checks.filter((c) => !c.pass).length} 项前提不成立——M2 换后端前必须先解决`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const runDevice = useCallback(async () => {
    setDev(null);
    setDevStep("");
    setStatus({ kind: "busy", label: "真机自检：逐级往上试，最后几档可能很慢…" });
    try {
      const { runDeviceReport } = await import("../dev/verify-device");
      const report = await runDeviceReport(setDevStep);
      setDev(report);
      setDevCrash(report.diedAt);
      setStatus({
        kind: "done",
        text: `真机自检跑完：后端 ${report.backend} · 最高跑通 ${report.maxResolution ?? "无"}`,
      });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setDevStep("");
    }
  }, []);

  /**
   * `onlySeconds` 只跑那一档。
   *
   * **单档不是"图快"的选项，是唯一干净的那个变量。** 整条阶梯从头跑起时，跑到第 N 档
   * 已经背着前 N−1 档的资源账，于是"这一档本身扛不扛得住"问不出来。
   *
   * 曾拿"单独跑 10 分钟通过、阶梯里同一档 7.6 秒就 `Decoder failure`"当这条的实证，
   * **那个对比不作数**：阶梯那次跑在被并行自检污染的窗口里（见 `client.ts` 的
   * `activeRun`）。理由仍然成立，证据要重新取。
   */
  const runLength = useCallback(async (onlySeconds?: number, repeat?: number) => {
    setLen(null);
    setLenRows([]);
    setDevStep("");
    setStatus({
      kind: "busy",
      label: repeat
        ? `连导 ${repeat} 次（量一个页面能导几次）——别切走也别锁屏`
        : onlySeconds
          ? `长片自检：只跑这一档，别切走也别锁屏`
          : "长片自检：最后一档 30 分钟，整轮可能十几分钟…",
    });
    try {
      const { runLengthReport } = await import("../dev/verify-device");
      const report = await runLengthReport(setDevStep, {
        ...(onlySeconds !== undefined ? { onlySeconds } : {}),
        ...(repeat !== undefined ? { repeat } : {}),
        // 边跑边显示：卡在第 N 次时，前 N−1 次的结果必须已经在屏幕上了
        onRung: (r) => setLenRows((prev) => [...prev, r]),
      });
      setLen(report);
      setDevCrash(report.diedAt);
      // 手点的也发回 `.reports/`。屏幕上这份会被截图截断，而要看的恰恰是被截掉的
      // 那些诊断字段（停在哪一步、看门狗被冻住几次）。见 `postManualReport`
      void (await import("../dev/autorun")).postManualReport("length", report);
      setStatus({
        kind: "done",
        text: `长片自检跑完：最长跑通 ${report.maxLength ?? "无"} · 混音峰值倍率 ${report.mixPeakRatio?.toFixed(2) ?? "?"}`,
      });
    } catch (error) {
      const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      setStatus({ kind: "error", text });
      // 整轮没跑起来（不是某一档失败——那个由报告自己记）时更要留下痕迹
      void (await import("../dev/autorun")).postManualReport("length", { error: text });
    } finally {
      setDevStep("");
    }
  }, []);

  const copyLength = useCallback(async () => {
    if (!len) return;
    const { formatLengthReport } = await import("../dev/verify-device");
    try {
      await navigator.clipboard.writeText(formatLengthReport(len));
      setStatus({ kind: "done", text: "报告已复制到剪贴板" });
    } catch {
      setStatus({ kind: "done", text: "复制失败，请长按下面的文本自行复制" });
    }
  }, [len]);

  const copyDevice = useCallback(async () => {
    if (!dev) return;
    const { formatDeviceReport } = await import("../dev/verify-device");
    const text = formatDeviceReport(dev);
    try {
      await navigator.clipboard.writeText(text);
      setStatus({ kind: "done", text: "报告已复制到剪贴板" });
    } catch {
      // iOS 上剪贴板可能要用户手势，退回选中让人自己复制
      setStatus({ kind: "done", text: "复制失败，请长按下面的文本自行复制" });
    }
  }, [dev]);

  const doExport = useCallback(async () => {
    if (!probe) return;
    const source = probe.source;
    const timeline = singleClipTimeline(source, { inFrame, outFrame });
    const ext = container === "mp4" ? "mp4" : "webm";

    // picker 必须在点击的同步链里调起，所以放在最前面（见 write-target.ts）
    let target;
    try {
      target = await pickWriteTarget(`kerf-m0-${inFrame}-${outFrame}.${ext}`, container);
    } catch {
      setStatus({ kind: "done", text: "已取消：没有选择保存位置" });
      return;
    }

    setStatus({
      kind: "exporting",
      progress: { stage: "prepare", encodedFrames: 0, totalFrames: timeline.durationFrames, elapsedMs: 0 },
    });

    const handle = startExport(
      {
        timeline,
        range: { inFrame: 0, outFrame: timeline.durationFrames },
        container,
        videoBitrate: 8e6,
        audioBitrate: 128e3,
        includeAudio: source.hasAudio,
        target,
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
      setStatus({
        kind: "done",
        text:
          `导出完成：${result.encodedFrames} 帧 · ${(result.bytesWritten / 1e6).toFixed(1)} MB · ` +
          `${seconds.toFixed(1)} 秒（${realtime.toFixed(2)}× 实时）· ` +
          `${result.audioIncluded ? "含音频" : "无音频"} · ${result.mimeType} · ` +
          `${result.opfsName ? "已触发下载" : "已写入所选文件"}`,
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
          三个自检覆盖的都是<b>不会报错、只会静默产出错误片子</b>的问题：帧数少一帧、
          trim 起点偏一帧、跨片段边界读错源片位置、预览和导出画面不一致。
          单元测试覆盖不到，只有真跑一遍导出再读回比对才能发现。
          <br />
          改过导出管道、取样映射或合成层之后，请把三个都跑一遍。
        </p>
      </header>

      <section>
        <h2>素材</h2>
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

      <section>
        <h2>多片段一致性自检</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          单片段比对抓不住 EDL 化引入的那一类错误。这里造一条**两个片段 + 中间空档**的时间轴
          （时间轴 0–60 读源片 0–60，60–80 空档，80–140 读源片 <b>200–260</b>），整条导出一次，
          再对 7 个取样帧逐个比对预览与导出。素材背景色相随帧号线性渐变，所以色相直接编码了
          "取到的是源片第几帧"——跨片段边界如果没换游标，色相会差 140 度，任何容差都盖不住。
        </p>
        <button
          type="button"
          onClick={() => void runTimelineCheck()}
          disabled={exporting || status.kind === "busy"}
        >
          运行多片段一致性自检
        </button>

        {tv && (
          <>
            <table className="checks">
              <tbody>
                {tv.checks.map((c) => (
                  <tr key={c.name} className={c.pass ? "ok" : "bad"}>
                    <td>{c.pass ? "✓" : "✕"}</td>
                    <td>{c.name}</td>
                    <td className="mono">{c.actual}</td>
                    <td className="mono dim">{c.pass ? "" : `期望 ${c.expected}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="checks">
              <tbody>
                <tr className="dim">
                  <td>取样帧</td>
                  <td>位置</td>
                  <td className="mono">预览色相</td>
                  <td className="mono">导出色相</td>
                  <td className="mono">期望</td>
                  <td className="mono">留边 预览/导出</td>
                </tr>
                {tv.rows.map((r) => (
                  <tr key={r.frame}>
                    <td className="mono">{r.frame}</td>
                    <td>{r.label}</td>
                    <td className="mono">{r.previewBlack ? "黑" : `${r.previewHue}°`}</td>
                    <td className="mono">{r.exportedBlack ? "黑" : `${r.exportedHue}°`}</td>
                    <td className="mono dim">
                      {r.expectedHue === null ? "黑" : `${r.expectedHue}°`}
                    </td>
                    <td className="mono dim">
                      {r.previewBands} / {r.exportedBands}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              导出 {tv.encodedFrames} 帧 · {(tv.bytesWritten / 1e6).toFixed(2)} MB ·
              自检总耗时 {(tv.elapsedMs / 1000).toFixed(1)} 秒
            </p>
          </>
        )}
      </section>

      <section>
        <h2>真机自检（这台设备能跑到哪儿）</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          和上面四个不同：那四个问"代码对不对"，答案在所有机器上都该一样；这一个问
          <b>这台设备的上限在哪</b>，答案本来就因机而异。它<b>不进回归门禁</b>，
          只在需要一台新设备的数字时手跑——存在的理由是 PLAN.md §8 那两条一直没验的风险
          （iOS Safari 全未验、移动端导出分辨率要单独限制，而后者至今没有任何实测依据）。
          最后一步是<b>故意往死里逼</b>的：逐级升高输出分辨率直到扛不住。移动端"扛不住"
          往往不是抛异常而是整个标签页被系统杀掉，所以每一档动手之前先把"正在试 X"
          写进 localStorage——<b>崩溃也是一种测量结果，得留下痕迹</b>。真被杀了就重新
          打开这个页面，下面会显示死在哪一档。
        </p>
        {devCrash && (
          <p className="hint bad" style={{ margin: "0 0 12px" }}>
            ⚠️ 上一次运行死在 <b>{devCrash}</b>——标签页被系统杀掉，没留下结论。
            这台设备的导出上限就在这一档之下。
          </p>
        )}
        <button
          type="button"
          onClick={() => void runDevice()}
          disabled={exporting || status.kind === "busy"}
        >
          运行真机自检
        </button>
        <button
          type="button"
          onClick={() => void runLength()}
          disabled={exporting || status.kind === "busy"}
          style={{ marginLeft: 8 }}
        >
          运行长片自检（十几分钟）
        </button>
        {/* 单档按钮：整条阶梯跑到第 N 档时已经背着前 N−1 档的资源账，要问"这一档
            本身扛不扛得住"只能这么问。**一台设备上同时只许跑一轮**——同页并发会
            互相掐断并把对方判成死等（现在会明确报错，见 client.ts 的 activeRun），
            那正是"移动端的墙是导出次数"这个假结论的来源 */}
        <p className="hint" style={{ margin: "8px 0 4px" }}>
          只跑一档（<b>一台设备同时只跑一轮</b>——别在另一个标签里也开着 <code>?autorun=</code>）：
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {LENGTH_LADDER.map((s) => (
            <button
              key={s.seconds}
              type="button"
              onClick={() => void runLength(s.seconds)}
              disabled={exporting || status.kind === "busy"}
            >
              {s.label}
            </button>
          ))}
        </div>
        {/* 连导 N 次：把"次数"这个变量单独拎出来量。**它已经给出答案了**——iPhone
            上 24 次连导（8 × 3 轮）全过、吞吐死平，次数不是墙；在此之前"第 2、3 次
            就挂"看着像铁证，实为并发污染。留着是因为它便宜，换设备时先跑它 */}
        <p className="hint" style={{ margin: "8px 0 4px" }}>
          同一页里<b>连着导多次</b>（iPhone 实测 24 次全过、吞吐死平，30 秒一档约 5 秒）：
        </p>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[3, 8].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => void runLength(30, n)}
              disabled={exporting || status.kind === "busy"}
            >
              30 秒 × {n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void runLength(120, 5)}
            disabled={exporting || status.kind === "busy"}
          >
            2 分钟 × 5
          </button>
        </div>
        {devStep && <p className="hint mono" style={{ margin: "8px 0 0" }}>{devStep}</p>}

        {/* 跑的过程中就把已完成的档显示出来。卡住那一次之前的结果必须看得见——
            等整轮返回才显示的话，标签页被系统杀掉时它们会全部丢掉 */}
        {lenRows.length > 0 && !len && (
          <table className="checks" style={{ marginTop: 8 }}>
            <tbody>
              {lenRows.map((r, i) => (
                <tr key={i} className={r.ok ? "ok" : "bad"}>
                  <td>{r.ok ? "✓" : "✕"}</td>
                  <td>{r.label}</td>
                  <td className="mono">
                    {r.ok
                      ? `${(r.elapsedMs / 1000).toFixed(1)}s · ${r.realtime.toFixed(2)}× 实时 · ${r.decoded}`
                      : r.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {len && (
          <>
            <p className="hint" style={{ margin: "12px 0 4px" }}>
              长片自检：输出固定 1280×720，<b>只变片长</b>。它和上面那条阶梯是两根不同的轴
              ——那条扫"一帧有多大"（顶的是画布和编码器缓冲，一帧就到峰值），这条扫
              "有多少帧、多少音频"（顶的是随片长累积的东西）。两根一起扫的话，崩了都说
              不清是被哪一头顶掉的。<b>混音峰值倍率</b>是这根轴要的那个数：分段混流（D22）
              之后它应当接近 1，之前会跟片长同比例涨。
            </p>
            <table className="checks">
              <tbody>
                {len.rungs.map((r) => (
                  <tr key={r.label} className={r.ok ? "ok" : "bad"}>
                    <td>{r.ok ? "✓" : "✕"}</td>
                    <td>{r.label}（{r.clips} 片段）</td>
                    <td className="mono">
                      {(r.elapsedMs / 1000).toFixed(1)}s · {r.realtime.toFixed(2)}× 实时 ·
                      混音峰值 {r.mixPeakBytes === null ? "?" : formatBytes(r.mixPeakBytes)} ·
                      循环峰值 {r.loopPeakBytes === null ? "?" : formatBytes(r.loopPeakBytes)}@{r.loopPeakAtFrame ?? "?"} ·
                      {r.decoded} · {r.note}
                    </td>
                  </tr>
                ))}
                <tr className={len.mixPeakRatio !== null && len.mixPeakRatio < 1.5 ? "ok" : "bad"}>
                  <td>·</td>
                  <td>混音峰值倍率</td>
                  <td className="mono">
                    {len.mixPeakRatio === null ? "档数不够，画不出趋势" : `${len.mixPeakRatio.toFixed(2)}×（最短 → 最长）`}
                    {" · 最长跑通 "}{len.maxLength ?? "无"}
                  </td>
                </tr>
              </tbody>
            </table>
            <button type="button" onClick={() => void copyLength()} style={{ marginTop: 8 }}>
              复制长片报告
            </button>
          </>
        )}

        {dev && (
          <>
            <table className="checks">
              <tbody>
                <tr className={dev.env.secureContext ? "ok" : "bad"}>
                  <td>{dev.env.secureContext ? "✓" : "✕"}</td>
                  <td>安全上下文</td>
                  <td className="mono">{dev.env.secureContext ? "是" : "否——WebCodecs / OPFS 都没有，用 pnpm dev:device 走 HTTPS"}</td>
                </tr>
                <tr className={dev.supportsEffects ? "ok" : "bad"}>
                  <td>{dev.supportsEffects ? "✓" : "✕"}</td>
                  <td>合成后端</td>
                  <td className="mono">{dev.backend} — {dev.backendNote}</td>
                </tr>
                <tr>
                  <td>·</td>
                  <td>WebGL 上下文预算</td>
                  <td className="mono">{dev.contextBudget ?? "未触顶"} — {dev.contextNote}</td>
                </tr>
                {dev.ladder.map((r) => (
                  <tr key={r.label} className={r.ok ? "ok" : "bad"}>
                    <td>{r.ok ? "✓" : "✕"}</td>
                    <td>导出 {r.label}（{r.width}×{r.height}）</td>
                    <td className="mono">
                      {r.elapsedMs}ms · {r.decoded} · 管道报 {(r.bytes / 1024).toFixed(0)}KB /
                      重读 {r.rereadBytes === null ? "?" : (r.rereadBytes / 1024).toFixed(0)}KB · {r.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint" style={{ margin: "8px 0 0" }}>
              最高跑通 <b>{dev.maxResolution ?? "一档都没过"}</b>。源片固定 640×360、只放大输出，
              所以这里扫的是<b>输出侧</b>的上限；"能不能解 4K 素材"是另一根轴，没测。
              判据是<b>把成片解回来量宽高和帧数</b>，不是看字节数——iOS 上字节数五档全报
              16MB（正好是 mediabunny 的攒批阈值），拿它当代理会让"4K 导出成功"这个结论
              毫无证据。输出侧的内存没有 API 可问，<b>唯一的读数就是标签页活没活下来</b>。
            </p>
            <button type="button" onClick={() => void copyDevice()} style={{ marginTop: 8 }}>
              复制报告
            </button>
            <p className="mono dim" style={{ whiteSpace: "pre-wrap", fontSize: 11, marginTop: 8 }}>
              {dev.env.userAgent}
            </p>
          </>
        )}
      </section>

      <section>
        <h2>PixiJS 后端 spike（M2 前置）</h2>
        <p className="hint" style={{ margin: "0 0 12px" }}>
          这一项不是回归自检，是<b>换渲染后端之前必须成立的前提</b>。M2 的滤镜和 shader
          转场要 GPU，而合成器同时被预览（主线程）和导出（Worker）依赖。这里在 Worker 里
          起 Pixi 的 WebGL2 渲染器，和 Canvas2D 后端跑<b>同一份输入</b>，比对留边几何与色彩，
          并主动制造两个只有 WebGL 才有的失效模式：跨 task 后 drawing buffer 被清空，
          以及 GL 上下文丢失。后者在导出跑几分钟时会被切标签页或系统休眠触发，
          默认行为是渲染变成 no-op——也就是静默写出几百帧黑画面。
        </p>
        <button
          type="button"
          onClick={() => void runPixiSpike()}
          disabled={exporting || status.kind === "busy"}
        >
          运行 Pixi 后端 spike
        </button>

        {px && (
          <>
            <table className="checks">
              <tbody>
                {px.checks.map((c) => (
                  <tr key={c.name} className={c.pass ? "ok" : "bad"}>
                    <td>{c.pass ? "✓" : "✕"}</td>
                    <td>{c.name}</td>
                    <td className="mono">{c.actual}</td>
                    <td className="mono dim">{c.pass ? "" : `期望 ${c.expected}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="checks">
              <tbody>
                {/* 表头逐格 nowrap：最后一列较长，不加会把「取样帧」挤成竖排 */}
                <tr className="dim" style={{ whiteSpace: "nowrap" }}>
                  <td>取样帧</td>
                  <td className="mono">期望色相</td>
                  <td className="mono">Pixi</td>
                  <td className="mono">Canvas2D</td>
                  <td className="mono">留边 Pixi / Canvas2D</td>
                </tr>
                {px.report.frames.map((f) => (
                  <tr key={f.index}>
                    <td className="mono">{f.index}</td>
                    <td className="mono dim">{f.expectedHue}°</td>
                    <td className="mono">{f.pixi.hue}°</td>
                    <td className="mono">{f.canvas2d.hue}°</td>
                    <td className="mono dim">
                      {f.pixi.top}/{f.pixi.bottom} · {f.canvas2d.top}/{f.canvas2d.bottom}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              {px.report.contextVersion} · 封装 {px.report.container} / {px.report.codec} ·
              GPU 纹理 {px.report.textures.afterFirstFrame} → {px.report.textures.afterLastFrame}
              <br />
              吞吐 {px.report.perf.width}×{px.report.perf.height} × {px.report.perf.frames} 帧：
              Canvas2D {px.report.perf.canvas2dMs.toFixed(0)}ms · Pixi{" "}
              {px.report.perf.pixiMs.toFixed(0)}ms · Pixi 关掉 preserveDrawingBuffer{" "}
              {px.report.perf.pixiNoPreserveMs.toFixed(0)}ms
              <br />
              留边比对那组（320×320 × {px.report.frameCount} 帧）：Pixi{" "}
              {px.report.encodeMs.pixi.toFixed(0)}ms / Canvas2D{" "}
              {px.report.encodeMs.canvas2d.toFixed(0)}ms；纯合成（仅 CPU 提交）Pixi{" "}
              {px.report.composeMs.pixi.toFixed(0)}ms / Canvas2D{" "}
              {px.report.composeMs.canvas2d.toFixed(0)}ms
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
    case "mix": return "混音（主线程，OfflineAudioContext）";
    case "prepare": return "准备（探测能力、建编码器）";
    case "video": return "解码 → 合成 → 编码";
    case "finalize": return "封装写出";
  }
}
