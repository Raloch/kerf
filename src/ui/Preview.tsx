/**
 * 预览面板。
 *
 * 播放推进用有理数帧率换算墙上时间（`advanceFrames`），不累加浮点秒——
 * 累加会让长时间播放的播放头逐渐偏离真实时间（硬规则 1）。
 * 播放头本身仍以整数帧存入 store，小数部分留在本地 ref 里，
 * 否则每帧取整会让 29.97fps 的播放速度肉眼可见地偏慢。
 *
 * ## 播放状态是一个有符号倍率，不是布尔 + 数字
 *
 * `rate`：0 暂停、1 常速正放、负数倒放（J/K/L，**D49**）。判据全在 `preview/shuttle.ts`
 * 那些纯函数里，这一层只负责接线。**它刻意不进 store、不进撤销栈**——同播放头和选中，
 * 而且它比那两个更彻底：它连项目状态都不是，只是这台机器此刻在怎么看这条时间轴。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTimeline } from "../state/timeline-store";
import { createPreviewEngine, advanceFrames, type PreviewEngine } from "../preview/preview-engine";
import { createPreviewAudio, type PreviewAudio } from "../preview/audio-engine";
import { proxyManager } from "../media/proxy-client";
import { framesToTimecode } from "../time/timebase";
import {
  isNormalPlayback,
  isShuttling,
  shuttleLabel,
  shuttleStep,
} from "../preview/shuttle";
import { IconNext, IconPause, IconPlay, IconPrev } from "./icons";

export function Preview({ disabled = false }: { readonly disabled?: boolean } = {}) {
  const timeline = useTimeline((s) => s.timeline());
  const playhead = useTimeline((s) => s.playhead);
  const setPlayhead = useTimeline((s) => s.setPlayhead);

  // 画布由引擎自己建（见 preview-engine 的工厂注释），这里只给它一个容器
  const screenRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  /**
   * 变速倍率：0 暂停、1 常速正放、负数倒放。见文件头。
   *
   * `playing` 从它派生，**不另存一个布尔**——两个状态能构造出"playing 为真而倍率是 0"
   * 和"倍率是 4 而 playing 为假"这两种自相矛盾的组合，表现分别是"播放中画面纹丝不动"
   * 和"暂停了播放头还在跑"。
   */
  const [rate, setRate] = useState(0);
  const playing = rate !== 0;
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
    setRate(0);
    cancelAnimationFrame(rafId.current);
    engineRef.current?.stopPlayback();
    // 声音要一起停。留着的话暂停后还会继续响几秒——已经排进 AudioContext 的
    // 那些段不会因为 rAF 停了而不播
    audioRef.current?.stop();
    fractional.current = 0;
  }, []);

  /**
   * 换到某个倍率（0 就是停）。J/K/L、空格、播放按钮全部走这一条路。
   *
   * 三件事按顺序：落点、状态、两个跟随者（画面元素 / 声音）。
   */
  const shuttle = useCallback(
    (next: number) => {
      if (next === 0) {
        stop();
        return;
      }
      // 梯子两端夹紧之后按同一个键会给出同一档，那时什么都不该做——
      // 否则会白重排一次声音（听得见：断一下再接上）
      if (next === rate) return;
      const engine = engineRef.current;
      if (!engine || !hasContent) return;

      const current = useTimeline.getState().playhead;
      // 正放到了末尾再按播放 = 从头再放一遍。**倒放没有这一条**：到 0 帧还按 J
      // 的用户是想继续往前找，把他扔到末尾去是"选了 A 拿到 B"
      if (next < 0 && current <= 0) return;
      const from = next > 0 && current >= timeline.durationFrames ? 0 : current;
      if (from !== current) setPlayhead(from);

      // 上一档的亚帧余数属于上一档，换档就丢掉（尤其换方向时，留着会先反向吃掉一帧）
      fractional.current = 0;
      setRate(next);
      // 已经在放就不重走起播：`renderLive` 下一帧就会把新倍率写到每个元素上，
      // 而重走一次要 await seek + play，听觉和视觉上都是一次多余的停顿
      if (rate === 0) void engine.startPlayback(timeline, from, next);

      /*
        声音只在**常速正放**时出现（`isNormalPlayback`）。

        这不是"以后再补"，是这条链的形状决定的：预览播的是 `createMixer` 产出的、
        导出会写进成片的**同一份 PCM**（D26），而那份 PCM 的时间轴与墙上时间是 1:1。
        要在 2× 上出声就得让预览去混一份导出永远不会产出的 PCM（重采样或 WSOLA），
        那正好把 D26 那条"根本没有第二份实现"的护栏拆掉——而倒放连这条路都没有
        （伸缩器和解码游标都只能向前，硬规则 3 的前提）。

        所以变速时把声音停掉，并且**在界面上报出这一档**（`isShuttling`）——静默
        变哑就是硬规则 10。
      */
      if (isNormalPlayback(next)) {
        // **不 await**：混第一段要几十到几百毫秒，等它会让画面延迟起播，
        // 而声音自己会按 `originTime` 对齐到正确的位置
        void audioRef.current?.start(timeline, from).then((has) => setHasSound(has));
      } else {
        audioRef.current?.stop();
      }
    },
    [hasContent, rate, setPlayhead, stop, timeline],
  );

  // 播放循环。**倍率在依赖里**，所以换档会重启这个 effect——因此计时基准要在这里
  // 重置，不能留在起播那一处：不重置的话换档后第一帧的 elapsed 是从上一档最后一次
  // tick 算起的，倍率一乘就是一次可见的跳帧
  useEffect(() => {
    if (!playing) return;
    const engine = engineRef.current;
    if (!engine) return;
    lastTick.current = performance.now();

    const tick = (now: number) => {
      const elapsed = now - lastTick.current;
      lastTick.current = now;

      // 倍率乘在**这一处**：帧率换算仍是有理数，倍率只是缩放它（硬规则 1）
      const advance = advanceFrames(elapsed, timeline.fps) * rate + fractional.current;
      // `floor` 对负数同样成立：余数恒在 [0,1)，累加起来的总位移是精确的
      const wholeFrames = Math.floor(advance);
      fractional.current = advance - wholeFrames;

      const next = useTimeline.getState().playhead + wholeFrames;
      // 两端各自到头就停。**两条都要**：只判正向的话倒放到 0 帧会一直空转
      // （setPlayhead 夹在 0，rAF 永不停、声音也不会被停掉）
      if (rate > 0 && next >= timeline.durationFrames) {
        setPlayhead(timeline.durationFrames);
        engine.renderLive(timeline, timeline.durationFrames, rate);
        stop();
        return;
      }
      if (rate < 0 && next <= 0) {
        setPlayhead(0);
        engine.renderLive(timeline, 0, rate);
        stop();
        return;
      }
      // 倒放时 `wholeFrames` 是负数，所以判的是"有没有走"而不是"有没有往前走"
      if (wholeFrames !== 0) setPlayhead(next);
      engine.renderLive(timeline, next, rate);
      // 声音是被动跟随的一方：按需往前混，偏了就重排（同 video 的漂移纠正）。
      // **变速时一次都不能 tick**：`invalidate()` 之后它会拿着播放头自己重排，
      // 于是"变速中编辑一下"会让声音在 4× 上原速响起来
      if (isNormalPlayback(rate)) audioRef.current?.tick(next);
      rafId.current = requestAnimationFrame(tick);
    };

    rafId.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId.current);
  }, [playing, rate, setPlayhead, stop, timeline]);

  // 导出对话框开着时停下播放并交还解码器
  useEffect(() => {
    if (disabled && playing) stop();
  }, [disabled, playing, stop]);

  // 空格播放/暂停 + J/K/L 变速。都在这里接是因为**播放状态归这个组件持有**
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      // **带修饰键的一概不接**：⌘K 是切分（Editor.tsx），被这里当成"停"吃掉的话
      // 表现是"切分快捷键有时候不灵"，而两个处理器都挂在 window 上，谁先谁后不可靠
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "Space") {
        e.preventDefault();
        // 空格在变速中是"停"，不是"回到常速"——它一直就是播放/暂停那一个键
        playing ? stop() : shuttle(1);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === "l") {
        e.preventDefault();
        shuttle(shuttleStep(rate, 1));
        return;
      }
      if (key === "j") {
        e.preventDefault();
        shuttle(shuttleStep(rate, -1));
        return;
      }
      if (key === "k") {
        e.preventDefault();
        stop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [disabled, playing, rate, shuttle, stop]);

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
            title={playing ? "暂停 空格 / K" : "播放 空格 · L 快进 / J 倒放 / K 停"}
            onClick={() => (playing ? stop() : shuttle(1))}
            disabled={!hasContent}
          >
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <button type="button" className="ib" title="下一帧 →" onClick={() => step(1)} disabled={!hasContent}>
            <IconNext />
          </button>
          {/*
            静音开关。**只在这条时间轴真有声音时出现**——没有音轨时给一个永远
            没作用的按钮是纯噪声。它只管预览，不进 EDL、不影响导出（片段自己的
            增益是音量包络，`MediaClip.volume`），所以 title 里要写明这一点：
            否则"预览静音了成片是不是也没声音"会变成一个真实的疑问。
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
        {/*
          变速读数。**只在"不是常速正放"时出现**（`isShuttling`，和"要不要出声"是
          同一个判据的两面）：常速正放没有可报的，摆一个恒显示「1×」的读数只是噪声。

          这一条同时是"变速不出声"那个降级唯一看得见的地方——静默变哑就是硬规则 10。
          **只在这条时间轴真有声音时才提这件事**：给一条没有音轨的时间轴解释"为什么
          没声音"是句假话（同 D39 那条"给无声画面挂『声音会变调』"）。

          这个位置原来是一句已经过时的话（「预览静音 · 多轨音频预览需要独立音频引擎，
          M1 暂不提供」）——D26 之后预览一直是出声的，那行字从那天起就在骗人。
        */}
        {isShuttling(rate) && (
          <span
            className="chip sh"
            title={
              hasSound
                ? "变速时不出声：预览播的是导出会写进成片的那份 PCM，它只在常速正放时对得上"
                : "回到常速（空格）恢复正常播放"
            }
          >
            {shuttleLabel(rate)}
          </span>
        )}
        <span className="chip m">
          帧 {playhead} / {timeline.durationFrames}
        </span>
      </div>
    </div>
  );
}
