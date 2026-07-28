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
import { createPreviewAudio, type PreviewAudio } from "../preview/audio-engine";
import { proxyManager } from "../media/proxy-client";
import { framesToTimecode } from "../time/timebase";
import { IconNext, IconPause, IconPlay, IconPrev } from "./icons";

export function Preview({ disabled = false }: { readonly disabled?: boolean } = {}) {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);

  // 画布由引擎自己建（见 preview-engine 的工厂注释），这里只给它一个容器
  const screenRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const [playing, setPlaying] = useState(false);
  // 引擎是异步造出来的，就绪时得把"暂停态重画"那条 effect 重新踢一次，
  // 否则首帧要等到用户下一次动播放头才出现
  const [engineReady, setEngineReady] = useState(0);

  /**
   * 预览音频引擎。**同步造**（只是一个对象，AudioContext 在 `start()` 里才建）——
   * 不能在挂载时就建 AudioContext：自动播放策略会让它以 suspended 出生，
   * 而且那样会在用户还没点播放时就占着一个音频设备。
   */
  const audioRef = useRef<PreviewAudio | null>(null);
  /** 这条时间轴有没有声音可放。没有就不显示音量控件——空控件是纯噪声。 */
  const [hasSound, setHasSound] = useState(false);
  const [muted, setMuted] = useState(false);

  // 播放头的小数部分：不进 store，但必须保留，否则每帧取整会让播放偏慢
  const fractional = useRef(0);
  const rafId = useRef(0);
  const lastTick = useRef(0);

  const hasContent = timeline.durationFrames > 0;

  // 音频引擎跟组件同生命周期。**编辑时序作废已排出去的声音**：时间轴换了对象，
  // 已经混好排进 AudioContext 的那几段就是旧内容了，留着会让人听到自己刚删掉的东西
  useEffect(() => {
    audioRef.current = createPreviewAudio();
    return () => {
      audioRef.current?.dispose();
      audioRef.current = null;
    };
  }, []);
  useEffect(() => {
    audioRef.current?.invalidate(timeline);
  }, [timeline]);
  useEffect(() => {
    audioRef.current?.setMuted(muted);
  }, [muted]);

  // 引擎**只建一次**，分辨率变化走下面的 resize。
  //
  // 异步：Pixi 后端要动态 import + 初始化渲染器。依赖列表刻意为空——把
  // width/height 放进来就会变成"改分辨率 = 销毁重建"，而重建要换画布、
  // 顺带丢掉视频元素的解码状态（见 preview-engine 的工厂注释）
  useEffect(() => {
    const container = screenRef.current;
    if (!container) return;
    let disposed = false;
    const { width, height } = useTimeline.getState().timeline();

    void createPreviewEngine(container, width, height).then((engine) => {
      // 这一轮已经被清理掉了（严格模式的双调用、或组件卸载）：造出来的引擎
      // 立刻还回去，否则它会攥着一个 WebGL 上下文不放，而上下文有预算（D15）
      if (disposed) {
        engine.dispose();
        return;
      }
      engineRef.current = engine;
      setEngineReady((n) => n + 1);
    });

    return () => {
      disposed = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, []);

  // 分辨率变化：就地 resize，不重建引擎
  useEffect(() => {
    engineRef.current?.resize(timeline.width, timeline.height);
  }, [engineReady, timeline.width, timeline.height]);

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
  }, [engineReady, hasContent, playhead, playing, timeline]);

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
    // 声音要一起停。留着的话暂停后还会继续响几秒——已经排进 AudioContext 的
    // 那些段不会因为 rAF 停了而不播
    audioRef.current?.stop();
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
    // 出声。**不 await**：混第一段要几十到几百毫秒，等它会让画面延迟起播，
    // 而声音自己会按 `originTime` 对齐到正确的位置
    void audioRef.current?.start(timeline, from).then((has) => setHasSound(has));
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
      // 声音是被动跟随的一方：按需往前混，偏了就重排（同 video 的漂移纠正）
      audioRef.current?.tick(next);
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
        <div className="screen" ref={screenRef}>
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
          {/*
            静音开关。**只在这条时间轴真有声音时出现**——没有音轨时给一个永远
            没作用的按钮是纯噪声。它只管预览，不进 EDL、不影响导出（片段增益是
            音量包络的事，还没做），所以 title 里要写明这一点：否则"预览静音了
            成片是不是也没声音"会变成一个真实的疑问。
          */}
          {hasSound && (
            <button
              type="button"
              className="ib"
              aria-pressed={muted}
              title={muted ? "取消静音（只影响预览，不影响导出）" : "静音预览（不影响导出）"}
              onClick={() => setMuted((m) => !m)}
            >
              {muted ? "🔇" : "🔊"}
            </button>
          )}
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
