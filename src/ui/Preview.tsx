/**
 * 预览面板。
 *
 * 播放推进用有理数帧率换算墙上时间（`advanceFrames`），不累加浮点秒——
 * 累加会让长时间播放的播放头逐渐偏离真实时间（硬规则 1）。
 * 播放头本身仍以整数帧存入 store，小数部分留在本地 ref 里，
 * 否则每帧取整会让 29.97fps 的播放速度肉眼可见地偏慢。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTimeline } from "../state/timeline-store";
import { createPreviewEngine, advanceFrames, type PreviewEngine } from "../preview/preview-engine";
import { proxyManager } from "../media/proxy-client";
import { framesToTimecode } from "../time/timebase";
import { IconNext, IconPause, IconPlay, IconPrev } from "./icons";

export function Preview({ disabled = false }: { readonly disabled?: boolean } = {}) {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const [playing, setPlaying] = useState(false);

  // 播放头的小数部分：不进 store，但必须保留，否则每帧取整会让播放偏慢
  const fractional = useRef(0);
  const rafId = useRef(0);
  const lastTick = useRef(0);

  const hasContent = timeline.durationFrames > 0;

  // 引擎跟随输出分辨率重建
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    engineRef.current?.dispose();
    engineRef.current = createPreviewEngine(canvas, timeline.width, timeline.height);
    return () => {
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [timeline.width, timeline.height]);

  // 暂停态：播放头或 EDL 变化就重画（scrub、逐帧、撤销、拖拽落下都会走到这里）
  useEffect(() => {
    if (playing || !hasContent) return;
    const engine = engineRef.current;
    if (!engine) return;
    let cancelled = false;
    void engine.renderFrame(timeline, playhead).then(() => {
      if (cancelled) return;
    });
    return () => {
      cancelled = true;
    };
  }, [hasContent, playhead, playing, timeline]);

  // 代理就绪 → 预览换用代理（seek 快一个量级），并立刻重画当前帧
  useEffect(
    () =>
      proxyManager.subscribe((sourceId, info) => {
        if (info.status !== "ready" || !info.url) return;
        const engine = engineRef.current;
        if (!engine) return;
        engine.useProxy(sourceId, info.url);
        if (!playing) {
          void engine.renderFrame(useTimeline.getState().timeline(), useTimeline.getState().playhead);
        }
      }),
    [playing],
  );

  const stop = useCallback(() => {
    setPlaying(false);
    cancelAnimationFrame(rafId.current);
    engineRef.current?.stopPlayback();
    fractional.current = 0;
  }, []);

  const start = useCallback(() => {
    const engine = engineRef.current;
    if (!engine || !hasContent) return;
    // 播到末尾再按播放，从头开始
    const from = playhead >= timeline.durationFrames ? 0 : playhead;
    if (from !== playhead) setPlayhead(from);

    setPlaying(true);
    fractional.current = 0;
    lastTick.current = performance.now();
    void engine.startPlayback(timeline, from);
  }, [hasContent, playhead, setPlayhead, timeline]);

  // 播放循环
  useEffect(() => {
    if (!playing) return;
    const engine = engineRef.current;
    if (!engine) return;

    const tick = (now: number) => {
      const elapsed = now - lastTick.current;
      lastTick.current = now;

      const advance = advanceFrames(elapsed, timeline.fps) + fractional.current;
      const wholeFrames = Math.floor(advance);
      fractional.current = advance - wholeFrames;

      const next = useTimeline.getState().playhead + wholeFrames;
      if (next >= timeline.durationFrames) {
        setPlayhead(timeline.durationFrames);
        engine.renderLive(timeline, timeline.durationFrames);
        stop();
        return;
      }
      if (wholeFrames > 0) setPlayhead(next);
      engine.renderLive(timeline, next);
      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [playing, setPlayhead, stop, timeline]);

  // 导出对话框开着时停下播放并交还解码器
  useEffect(() => {
    if (disabled && playing) stop();
  }, [disabled, playing, stop]);

  // 空格播放/暂停
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.code !== "Space") return;
      e.preventDefault();
      playing ? stop() : start();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, playing, start, stop]);

  const step = useCallback(
    (delta: number) => {
      if (playing) stop();
      setPlayhead(useTimeline.getState().playhead + delta);
    },
    [playing, setPlayhead, stop],
  );

  return (
    <div className="stage">
      <div className="stage-wrap">
        <div className="screen">
          <canvas ref={canvasRef} />
          {!hasContent && <div className="placeholder">导入素材后在此预览</div>}
        </div>
      </div>
      <div className="stage-bar">
        <div className="transport">
          <button type="button" className="ib" title="上一帧 ←" onClick={() => step(-1)} disabled={!hasContent}>
            <IconPrev />
          </button>
          <button
            type="button"
            className="ib"
            title={playing ? "暂停 空格" : "播放 空格"}
            onClick={() => (playing ? stop() : start())}
            disabled={!hasContent}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="ib" title="下一帧 →" onClick={() => step(1)} disabled={!hasContent}>
            <IconNext />
          </button>
        </div>
        <div className="tc">
          <b>{framesToTimecode(playhead, timeline.fps)}</b>{" "}
          <span>/ {framesToTimecode(timeline.durationFrames, timeline.fps)}</span>
        </div>
        <div className="spacer" />
        {/* 预览静音是刻意的：多轨音频预览要等独立音频引擎，见 preview-engine.ts */}
        <span className="chip" title="多轨音频预览需要独立的音频引擎，M1 暂不提供">
          预览静音
        </span>
        <span className="chip m">
          帧 {playhead} / {timeline.durationFrames}
        </span>
      </div>
    </div>
  );
}
