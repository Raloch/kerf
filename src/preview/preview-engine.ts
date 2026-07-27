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

import type { MediaSource, Timeline } from "../edl/types";
import { microsToSeconds, sourceCenterMicrosAt, visibleVideoClips } from "../edl/sampling";
import { createCompositor, type CompositorBackend } from "../compose/backend";
import type { ComposeLayer, Compositor } from "../compose/compositor";
import { rasterizeText } from "../compose/text-raster";
import { frameDurationMicros, MICROS_PER_SECOND } from "../time/timebase";
import type { Rational } from "../time/rational";

/** video 时间与期望时间的容许偏差（源片帧数）。超过就重新 seek 纠正。 */
const DRIFT_TOLERANCE_FRAMES = 3;

interface SourceHandle {
  readonly video: HTMLVideoElement;
  readonly url: string;
  ready: boolean;
  /** 原片 URL 是这里创建的，要负责 revoke；代理 URL 归 ProxyManager，不能碰。 */
  readonly ownsUrl: boolean;
}

export interface PreviewEngine {
  readonly canvas: HTMLCanvasElement;
  /**
   * 实际用上的渲染后端。
   *
   * 报出来是因为**它必须和导出侧一致**（硬规则 2）：一边 Pixi 一边 Canvas2D 时，
   * 今天只是留边差一个像素，接了滤镜之后就是"预览有效果、成片没有"。
   */
  readonly backend: CompositorBackend;
  /**
   * 就地改输出分辨率。
   *
   * **优先用它而不是"销毁引擎再建一个"**：后者会换掉画布（见工厂注释），
   * 顺带丢掉视频元素的解码状态，换分辨率时预览会黑一下再重新 seek。
   */
  resize(width: number, height: number): void;
  /**
   * 代理就绪后调用：换用代理文件重建对应的 video。
   *
   * 预览读代理、导出读原片——代理只为 seek 流畅，绝不影响成片画质。
   */
  useProxy(sourceId: string, proxyUrl: string): void;
  /** 渲染指定帧（暂停态用）。会等待 seek 完成，因此是异步的。 */
  renderFrame(timeline: Timeline, frame: number): Promise<void>;
  /** 播放态每帧调用：只采样 video 当前画面，不等待 seek。 */
  renderLive(timeline: Timeline, frame: number): void;
  /** 进入播放：把相关 video 对齐到该帧并开始走。 */
  startPlayback(timeline: Timeline, frame: number): Promise<void>;
  stopPlayback(): void;
  dispose(): void;
}

/**
 * 造预览引擎。**画布由引擎自己建并挂进 `container`，调用方不要自己传画布。**
 *
 * 两个理由，第二个是硬约束：
 *
 * 1. 一张画布只能有一种上下文类型，所以没法"先用 Canvas2D 顶着、Pixi 好了再换"
 *    ——因此这个工厂必须是异步的，调用方必须等。
 * 2. **Pixi 的 `renderer.destroy()` 会 `loseContext()`，那张画布之后再建渲染器
 *    会死循环**（实测 Chrome 150，标签页 100% CPU，不报错）。只要画布是外面传进来
 *    的，"销毁引擎再建一个"就迟早会撞上它——React 严格模式的双调用、改分辨率、
 *    热更新都会。让引擎自己拥有画布，每次重建都是**新的一张**，这类问题整类消失。
 *
 * 尺寸变化优先走 `compositor.resize()`（见 `resize`），只有换引擎才换画布。
 */
export async function createPreviewEngine(
  container: HTMLElement,
  width: number,
  height: number,
): Promise<PreviewEngine> {
  const canvas = document.createElement("canvas");
  container.appendChild(canvas);
  let created;
  try {
    created = await createCompositor(width, height, { target: canvas });
  } catch (error) {
    canvas.remove();
    throw error;
  }
  const compositor: Compositor = created.compositor;
  const handles = new Map<string, SourceHandle>();
  /** sourceId → 代理 blob URL。有代理就用它，没有才回退原片。 */
  const proxies = new Map<string, string>();
  let playing = false;

  function handleFor(source: MediaSource): SourceHandle {
    const existing = handles.get(source.id);
    if (existing) return existing;

    const video = document.createElement("video");
    // 有代理用代理（seek 快一个量级），没有才读原片
    const proxyUrl = proxies.get(source.id);
    const url = proxyUrl ?? URL.createObjectURL(source.file);
    video.src = url;
    video.muted = true; // 见文件头注释：M1 预览刻意静音
    video.playsInline = true;
    video.preload = "auto";
    const handle: SourceHandle = { video, url, ready: false, ownsUrl: proxyUrl === undefined };
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
   * "该画哪个片段、按什么顺序、读源片哪一刻"全部委托给 `visibleVideoClips()`，
   * 导出管道走同一个函数。这一层**不允许**自己判断可见性或算源片位置——
   * 那样预览和导出就是两套取帧逻辑，而共用 compose() 只能保证画法一致（硬规则 2）。
   *
   * seek 目标用 `sourceCenterMicrosAt`（帧中点）：seek 到帧的左边界时浏览器常常
   * 返回前一帧，于是时间码显示 30 而画面是 frame 29。
   *
   * 文字层走 `rasterizeText()`——**和导出侧调的是同一个函数、同一份缓存**，
   * 所以字形、断行、描边宽度一致是结构性的，不靠两边小心对齐（硬规则 2）。
   */
  function layersFor(
    timeline: Timeline,
    frame: number,
  ): { layers: ComposeLayer[]; active: { source: MediaSource; seekSeconds: number }[] } {
    const layers: ComposeLayer[] = [];
    const active: { source: MediaSource; seekSeconds: number }[] = [];

    for (const visible of visibleVideoClips(timeline, frame)) {
      // 摆位和调色都来自 visibleVideoClips，这一层一个都不自己算——
      // 导出侧拿的是同一份（硬规则 2 的第二个落点，见 edl/sampling.ts）
      const looks = {
        ...(visible.transform ? { transform: visible.transform } : {}),
        ...(visible.color ? { color: visible.color } : {}),
        ...(visible.lut ? { lut: visible.lut } : {}),
      };
      if (visible.kind === "text") {
        const raster = rasterizeText(
          visible.clip.text,
          visible.clip.style,
          compositor.width,
          compositor.height,
        );
        if (raster) {
          layers.push({
            kind: "image",
            image: raster.canvas,
            width: raster.width,
            height: raster.height,
            ...looks,
          });
        }
        continue;
      }
      const { source, clip } = visible;
      const handle = handleFor(source);
      active.push({
        source,
        seekSeconds: microsToSeconds(
          sourceCenterMicrosAt(clip, frame, timeline.fps, source.fps),
        ),
      });

      // 用 readyState 而不是缓存的标志位：事件可能在我们订阅之前就已触发过
      if (handle.video.readyState >= 2) {
        layers.push({
          kind: "image",
          image: handle.video,
          width: source.width,
          height: source.height,
          ...looks,
        });
      }
    }
    return { layers, active };
  }

  /**
   * 画一帧，丢了上下文就先救再画。
   *
   * 预览是**全场最老的那个** WebGL 上下文，切标签页、系统休眠、驱动重置都会
   * 让它被收走；而 D15 量过：被上下文预算驱逐的那种救不回来。所以这里救得回来
   * 就接着画，救不回来就**保持上一帧不动**而不是抛到 React 里——用户看到的是
   * 画面停住，不是整个界面炸掉。真正的治本在导出侧不再抢上下文（D15）。
   */
  async function draw(layers: readonly ComposeLayer[]): Promise<void> {
    try {
      compositor.composeFrame(layers);
    } catch (error) {
      if (!compositor.isContextLost()) throw error;
      if (await compositor.recover()) compositor.composeFrame(layers);
    }
  }

  return {
    canvas,
    backend: created.backend,

    resize(nextWidth, nextHeight) {
      compositor.resize(nextWidth, nextHeight);
    },

    async renderFrame(timeline, frame) {
      const { layers, active } = layersFor(timeline, frame);
      // 暂停态要等素材就绪 + seek 完成再画，否则显示的是上一次的画面或纯黑
      await Promise.all(
        active.map(async ({ source, seekSeconds }) => {
          const handle = handleFor(source);
          await ensureLoaded(handle.video);
          await seekTo(handle.video, seekSeconds);
        }),
      );
      // seek 期间 handle.ready 可能才变 true，重新收集一次
      const fresh = layersFor(timeline, frame);
      await draw(fresh.layers.length > 0 ? fresh.layers : layers);
    },

    renderLive(timeline, frame) {
      const { layers, active } = layersFor(timeline, frame);

      // 漂移纠正：video 自己走，偏差超过阈值才拉回来，避免每帧 seek。
      // 容差按**源片**帧长算：慢速素材放到高帧率时间轴上时，3 个时间轴帧
      // 可能还不到源片的 1 帧，按时间轴帧算会导致每帧都判超差、每帧都 seek
      for (const { source, seekSeconds } of active) {
        const handle = handleFor(source);
        if (handle.video.readyState < 2) continue;
        const tolerance =
          (DRIFT_TOLERANCE_FRAMES * frameDurationMicros(source.fps)) / MICROS_PER_SECOND;
        if (Math.abs(handle.video.currentTime - seekSeconds) > tolerance) {
          handle.video.currentTime = seekSeconds;
        }
      }
      // 播放态不能 await（rAF 回调是同步的），丢了上下文就先画不出来，
      // 由下一次 renderFrame（暂停/scrub）去救。播放中黑一下远好过卡住整个循环
      if (!compositor.isContextLost()) compositor.composeFrame(layers);
    },

    async startPlayback(timeline, frame) {
      playing = true;
      const { active } = layersFor(timeline, frame);
      await Promise.all(
        active.map(async ({ source, seekSeconds }) => {
          const handle = handleFor(source);
          await ensureLoaded(handle.video);
          await seekTo(handle.video, seekSeconds);
          if (!playing) return;
          // play() 在某些情况下会 reject（例如元素已被移除），静音播放不受自动播放策略限制
          await handle.video.play().catch(() => undefined);
        }),
      );
    },

    useProxy(sourceId, proxyUrl) {
      if (proxies.get(sourceId) === proxyUrl) return;
      proxies.set(sourceId, proxyUrl);
      // 丢掉已建的原片 video，下次取帧会用代理重建
      const existing = handles.get(sourceId);
      if (existing) {
        existing.video.pause();
        existing.video.removeAttribute("src");
        existing.video.load();
        if (existing.ownsUrl) URL.revokeObjectURL(existing.url);
        handles.delete(sourceId);
      }
    },

    stopPlayback() {
      playing = false;
      for (const handle of handles.values()) handle.video.pause();
    },

    dispose() {
      playing = false;
      for (const handle of handles.values()) {
        handle.video.pause();
        handle.video.removeAttribute("src");
        handle.video.load();
        if (handle.ownsUrl) URL.revokeObjectURL(handle.url);
      }
      handles.clear();
      compositor.dispose();
      // 画布是这个引擎建的，销毁时一并摘掉。**不能留着给下一个引擎用**——
      // Pixi 销毁渲染器时丢掉了它的 GL 上下文，在这张画布上再建会死循环
      canvas.remove();
    },
  };
}

/** 播放时把墙上时间换算成帧号推进量。fps 用有理数，避免浮点累积。 */
export function advanceFrames(elapsedMs: number, fps: Rational): number {
  // elapsedMs/1000 秒 × fps = elapsedMs × num / (den × 1000) 帧
  return (elapsedMs * fps.num) / (fps.den * 1000);
}
