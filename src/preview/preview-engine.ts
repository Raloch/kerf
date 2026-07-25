/**
 * 预览引擎：按 EDL 在屏幕上放出某一帧，以及驱动播放。
 *
 * 与导出的分工（CLAUDE.md 硬规则 2、3）：
 *
 * |          | 取帧                       | 节奏                     |
 * |----------|----------------------------|--------------------------|
 * | 预览     | `HTMLVideoElement` seek    | rAF，丢帧无所谓          |
 * | 导出     | `VideoDecoder` 顺序解码    | 顺序驱动，每帧必渲染     |
 *
 * 两者**共用** `compose()` 和 `clipAt()`：画面构成、图层顺序、缩放留边完全一致。
 * 预览这边允许 seek 不帧精确（差一帧肉眼无感），但导出绝不允许。
 *
 * 播放时不逐帧 seek——每帧 seek 会卡死。做法是让 video 自己以 1× 播放，
 * rAF 只负责采样它当前的画面，并在偏离时间轴超过阈值时纠正一次。
 *
 * **音频**：M1 预览静音。V1 与 A1 虽然常来自同一文件，但用户可以把 A1 单独
 * 拖走或裁短，此时跟着 video 走的声音就是错的——宁可没有声音，也不要给
 * 用户一个"听起来对但实际不对"的预览。多轨音频预览要等独立的音频引擎。
 */

import { clipAt, toSourceFrame, type MediaSource, type Timeline } from "../edl/types";
import { createCanvas2DCompositor, type ComposeLayer, type Compositor } from "../compose/compositor";
import { frameDurationMicros, frameToSeconds, MICROS_PER_SECOND, secondsToFrame } from "../time/timebase";
import type { Rational } from "../time/rational";

/** video 时间与期望时间的容许偏差（帧）。超过就重新 seek 纠正。 */
const DRIFT_TOLERANCE_FRAMES = 3;

/**
 * seek 目标要落在帧的**中点**，不能是帧起点。
 *
 * 帧 N 覆盖 [N/fps, (N+1)/fps)。seek 到恰好等于左边界时，浏览器常常返回前一帧
 * （currentTime 精度 + "最近可解码位置"的实现差异），于是时间码显示 30
 * 而画面是 frame 29——暂停逐帧检查时一眼就能看出来。落在帧内部就没有这个歧义。
 */
function frameCenterSeconds(frame: number, fps: Parameters<typeof frameToSeconds>[1]): number {
  const half = frameDurationMicros(fps) / 2 / MICROS_PER_SECOND;
  return frameToSeconds(frame, fps) + half;
}

interface SourceHandle {
  readonly video: HTMLVideoElement;
  readonly url: string;
  ready: boolean;
}

export interface PreviewEngine {
  readonly canvas: HTMLCanvasElement;
  /** 渲染指定帧（暂停态用）。会等待 seek 完成，因此是异步的。 */
  renderFrame(timeline: Timeline, frame: number): Promise<void>;
  /** 播放态每帧调用：只采样 video 当前画面，不等待 seek。 */
  renderLive(timeline: Timeline, frame: number): void;
  /** 进入播放：把相关 video 对齐到该帧并开始走。 */
  startPlayback(timeline: Timeline, frame: number): Promise<void>;
  stopPlayback(): void;
  /** 输出分辨率变化时重建合成器。 */
  resize(width: number, height: number): void;
  dispose(): void;
}

export function createPreviewEngine(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): PreviewEngine {
  let compositor: Compositor = createCanvas2DCompositor(width, height, canvas);
  const handles = new Map<string, SourceHandle>();
  let playing = false;

  function handleFor(source: MediaSource): SourceHandle {
    const existing = handles.get(source.id);
    if (existing) return existing;

    const video = document.createElement("video");
    const url = URL.createObjectURL(source.file);
    video.src = url;
    video.muted = true; // 见文件头注释：M1 预览刻意静音
    video.playsInline = true;
    video.preload = "auto";
    const handle: SourceHandle = { video, url, ready: false };
    video.addEventListener("loadeddata", () => {
      handle.ready = true;
    });
    handles.set(source.id, handle);
    return handle;
  }

  /**
   * 等素材可解码。
   *
   * 不等就 seek 会静默失败（readyState 为 0 时设 currentTime 不触发 seeked），
   * 结果是画一张纯黑——用户导入素材后立刻拖播放头就会遇到，而且不报任何错。
   */
  function ensureLoaded(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("error", finish);
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener("loadeddata", finish, { once: true });
      video.addEventListener("error", finish, { once: true });
      // 素材损坏或格式不支持时不能永久挂住 UI
      const timer = setTimeout(finish, 5000);
    });
  }

  /** 精确 seek：等 seeked 事件，超时后也返回（宁可画旧帧也不要卡住 UI）。 */
  function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
    if (Math.abs(video.currentTime - seconds) < 1e-4 && video.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        video.removeEventListener("seeked", finish);
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener("seeked", finish, { once: true });
      // 素材还在加载时 seek 可能不触发 seeked，兜个底
      const timer = setTimeout(finish, 400);
      video.currentTime = seconds;
    });
  }

  /**
   * 收集该帧要画的图层。
   *
   * 轨道数组按 z 序从上到下排列（T1 在最上），画的时候要反过来：
   * 先画底层再画上层，否则叠加轨会被主视频盖住。
   */
  function layersFor(
    timeline: Timeline,
    frame: number,
  ): { layers: ComposeLayer[]; active: { source: MediaSource; sourceFrame: number }[] } {
    const layers: ComposeLayer[] = [];
    const active: { source: MediaSource; sourceFrame: number }[] = [];

    for (const track of [...timeline.tracks].reverse()) {
      if (track.kind !== "video" || track.hidden) continue;
      const clip = clipAt(track, frame);
      if (!clip) continue;
      const source = timeline.sources.find((s) => s.id === clip.sourceId);
      if (!source) continue;

      const handle = handleFor(source);
      const sourceFrame = toSourceFrame(clip, frame);
      active.push({ source, sourceFrame });

      // 用 readyState 而不是缓存的标志位：事件可能在我们订阅之前就已触发过
      if (handle.video.readyState >= 2) {
        layers.push({
          kind: "image",
          image: handle.video,
          width: source.width,
          height: source.height,
        });
      }
    }
    return { layers, active };
  }

  return {
    canvas,

    async renderFrame(timeline, frame) {
      const { layers, active } = layersFor(timeline, frame);
      // 暂停态要等素材就绪 + seek 完成再画，否则显示的是上一次的画面或纯黑
      await Promise.all(
        active.map(async ({ source, sourceFrame }) => {
          const handle = handleFor(source);
          await ensureLoaded(handle.video);
          await seekTo(handle.video, frameCenterSeconds(sourceFrame, timeline.fps));
        }),
      );
      // seek 期间 handle.ready 可能才变 true，重新收集一次
      const fresh = layersFor(timeline, frame);
      compositor.composeFrame(fresh.layers.length > 0 ? fresh.layers : layers);
    },

    renderLive(timeline, frame) {
      const { layers, active } = layersFor(timeline, frame);

      // 漂移纠正：video 自己走，偏差超过阈值才拉回来，避免每帧 seek
      for (const { source, sourceFrame } of active) {
        const handle = handleFor(source);
        if (handle.video.readyState < 2) continue;
        const expected = frameCenterSeconds(sourceFrame, timeline.fps);
        const actualFrame = secondsToFrame(handle.video.currentTime, timeline.fps);
        if (Math.abs(actualFrame - sourceFrame) > DRIFT_TOLERANCE_FRAMES) {
          handle.video.currentTime = expected;
        }
      }
      compositor.composeFrame(layers);
    },

    async startPlayback(timeline, frame) {
      playing = true;
      const { active } = layersFor(timeline, frame);
      await Promise.all(
        active.map(async ({ source, sourceFrame }) => {
          const handle = handleFor(source);
          await ensureLoaded(handle.video);
          await seekTo(handle.video, frameCenterSeconds(sourceFrame, timeline.fps));
          if (!playing) return;
          // play() 在某些情况下会 reject（例如元素已被移除），静音播放不受自动播放策略限制
          await handle.video.play().catch(() => undefined);
        }),
      );
    },

    stopPlayback() {
      playing = false;
      for (const handle of handles.values()) handle.video.pause();
    },

    resize(nextWidth, nextHeight) {
      compositor.dispose();
      compositor = createCanvas2DCompositor(nextWidth, nextHeight, canvas);
    },

    dispose() {
      playing = false;
      for (const handle of handles.values()) {
        handle.video.pause();
        handle.video.removeAttribute("src");
        handle.video.load();
        URL.revokeObjectURL(handle.url);
      }
      handles.clear();
      compositor.dispose();
    },
  };
}

/** 播放时把墙上时间换算成帧号推进量。fps 用有理数，避免浮点累积。 */
export function advanceFrames(elapsedMs: number, fps: Rational): number {
  // elapsedMs/1000 秒 × fps = elapsedMs × num / (den × 1000) 帧
  return (elapsedMs * fps.num) / (fps.den * 1000);
}
