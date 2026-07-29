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

import type { AvSource, ImageSource, Timeline } from "../edl/types";
import { microsToSeconds, visibleVideoClips, type VisibleClip } from "../edl/sampling";
import { createCompositor, type CompositorBackend } from "../compose/backend";
import type { ComposeLayer, ComposeSourceLayer, Compositor } from "../compose/compositor";
import { rasterizeText } from "../compose/text-raster";
import { decodeImage, decodedImage } from "../compose/image-store";
import { frameDurationMicros, MICROS_PER_SECOND } from "../time/timebase";
import type { Rational } from "../time/rational";

/** video 时间与期望时间的容许偏差（源片帧数）。超过就重新 seek 纠正。 */
const DRIFT_TOLERANCE_FRAMES = 3;

/**
 * 同时存活的 video 元素上限。
 *
 * 元素**按片段**建（见 `handleFor`），而片段数没有上界，所以必须淘汰。
 * 6 的来源：一条转场窗口里最多 2 层 × 多轨叠加时的常见轨数 3，再留一点余量。
 * 每个元素都握着一个解码器，放任不管会在长时间编辑后把解码器配额吃满。
 */
const MAX_VIDEO_HANDLES = 6;

/** 这一帧要对齐的一个 video 元素。`clipId` 是索引键，见 `handleFor`。 */
interface ActiveSource {
  /** 只可能是带画面的素材——它来自 `visibleVideoClips`，那里已经挡掉了纯音频素材。 */
  readonly source: AvSource;
  readonly clipId: string;
  readonly seekSeconds: number;
}

interface SourceHandle {
  readonly sourceId: string;
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
  /**
   * 引擎已销毁。`renderFrame` 里有两段 await（等素材、等 seek），Editor 卸载
   * （回首页、进自检）时正在飞的那一帧会在 await 之后才碰合成器——那时它已经
   * dispose，表现是每次切走都在 console 里刷「合成器已释放」。销毁后的帧直接
   * 不画（画布都已经摘了），不是吞错误：上下文丢失那条救援路径照旧。
   */
  let disposed = false;

  /** 拆掉一个 video 元素并回收它的 URL。 */
  function dropHandle(key: string): void {
    const handle = handles.get(key);
    if (!handle) return;
    handles.delete(key);
    handle.video.pause();
    handle.video.removeAttribute("src");
    handle.video.load();
    if (handle.ownsUrl) URL.revokeObjectURL(handle.url);
  }

  /**
   * 取（或建）某个**片段**的 video 元素。
   *
   * **按 clipId 索引，不是按 sourceId。** 转场窗口里出场和入场两个片段常常来自
   * 同一个源文件（切开之后再溶解是最常见的用法），而它们要停在两个不同的时刻——
   * 共用一个元素时后写的 `currentTime` 会覆盖前一个，画面表现为转场两侧完全同帧。
   * 这和导出侧"同源片的并发游标要各自一份 Input"是同一件事。
   *
   * 代价是元素数量随片段数增长，所以配一个 LRU（见 `MAX_VIDEO_HANDLES`）。
   */
  function handleFor(source: AvSource, clipId: string): SourceHandle {
    const existing = handles.get(clipId);
    if (existing) {
      // Map 保持插入序，删了再塞就是"移到最近使用"
      handles.delete(clipId);
      handles.set(clipId, existing);
      return existing;
    }

    const video = document.createElement("video");
    // 有代理用代理（seek 快一个量级），没有才读原片
    const proxyUrl = proxies.get(source.id);
    const url = proxyUrl ?? URL.createObjectURL(source.file);
    video.src = url;
    video.muted = true; // 见文件头注释：M1 预览刻意静音
    video.playsInline = true;
    video.preload = "auto";
    const handle: SourceHandle = {
      sourceId: source.id,
      video,
      url,
      ready: false,
      ownsUrl: proxyUrl === undefined,
    };
    video.addEventListener("loadeddata", () => {
      handle.ready = true;
    });
    handles.set(clipId, handle);

    while (handles.size > MAX_VIDEO_HANDLES) {
      const oldest = handles.keys().next();
      if (oldest.done) break;
      dropHandle(oldest.value);
    }
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
   * seek 目标落在**帧中点**：seek 到帧的左边界时浏览器常常返回前一帧，
   * 于是时间码显示 30 而画面是 frame 29。
   *
   * 文字层走 `rasterizeText()`——**和导出侧调的是同一个函数、同一份缓存**，
   * 所以字形、断行、描边宽度一致是结构性的，不靠两边小心对齐（硬规则 2）。
   */
  function layersFor(
    timeline: Timeline,
    frame: number,
  ): { layers: ComposeLayer[]; active: ActiveSource[]; images: Set<ImageSource> } {
    const layers: ComposeLayer[] = [];
    const active: ActiveSource[] = [];
    /** 这一帧用到的图片素材，供 `renderFrame` 在画之前把它们解出来。 */
    const images = new Set<ImageSource>();

    /**
     * 一层 → 一个合成图层。素材还没就绪时返回 null（这一帧先不画它）。
     *
     * **顺带把该层要对齐的 video 记进 `active`**，所以转场里的两个输入也会被
     * seek——漏掉的话转场那几帧其中一层停在上一个位置，而且只在窗口里出现。
     */
    const toLayer = (visible: VisibleClip): ComposeSourceLayer | null => {
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
        if (!raster) return null;
        return {
          kind: "image",
          image: raster.canvas,
          width: raster.width,
          height: raster.height,
          ...looks,
        };
      }
      if (visible.kind === "image") {
        // 还没解好就这一帧先不画它，**完全同 video 元素的 `readyState < 2`**：
        // 暂停态由 `renderFrame` 先 await 解码再画（下面那个 `pending`），播放态
        // 跳过一帧无所谓。导出侧不能这么办（少一层是静默错），它靠
        // `prepareImages()` 在逐帧循环之前挡住，见 `compose/image-store.ts`
        images.add(visible.source);
        const entry = decodedImage(visible.source.id);
        if (!entry) return null;
        return {
          kind: "image",
          image: entry.bitmap,
          width: entry.width,
          height: entry.height,
          ...looks,
        };
      }
      const { source, clip } = visible;
      const handle = handleFor(source, clip.id);
      // seek 目标由 `visible.sourceMicros` 加半帧得到，**不重算**：转场窗口里
      // 那个值已经被夹回素材真实范围（余量不足时的定格），这里再算一遍就会
      // 在预览里 seek 到一个不存在的位置，而导出是对的
      active.push({
        source,
        clipId: clip.id,
        seekSeconds: microsToSeconds(
          visible.sourceMicros + Math.round(frameDurationMicros(source.fps) / 2),
        ),
      });

      // 用 readyState 而不是缓存的标志位：事件可能在我们订阅之前就已触发过
      if (handle.video.readyState < 2) return null;
      return {
        kind: "image",
        image: handle.video,
        width: source.width,
        height: source.height,
        ...looks,
      };
    };

    for (const entry of visibleVideoClips(timeline, frame)) {
      if (entry.kind === "transition") {
        // 两个输入都要 toLayer 一遍（于是两个 video 都进 active 被 seek），
        // 但只有两边都就绪才能画——只画一侧会让转场那几帧闪烁
        const from = toLayer(entry.from);
        const to = toLayer(entry.to);
        if (from && to) {
          layers.push({
            kind: "transition",
            from,
            to,
            progress: entry.progress,
            effect: entry.effect,
          });
        }
        continue;
      }
      const layer = toLayer(entry);
      if (layer) layers.push(layer);
    }
    return { layers, active, images };
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
    if (disposed) return;
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
      const { layers, active, images } = layersFor(timeline, frame);
      // 暂停态要等素材就绪 + seek 完成再画，否则显示的是上一次的画面或纯黑。
      // 图片走同一条等待：解码是异步的，而不等的话刚导入的那张图要等到下一次
      // 渲染才出现——而暂停时没有下一次
      await Promise.all([
        ...[...images].map((source) => decodeImage(source, compositor.width, compositor.height)),
        ...active.map(async ({ source, clipId, seekSeconds }) => {
          const handle = handleFor(source, clipId);
          await ensureLoaded(handle.video);
          await seekTo(handle.video, seekSeconds);
        }),
      ]);
      // await 期间引擎可能已经随 Editor 卸载销毁（回首页/进自检），见 `disposed`
      if (disposed) return;
      // seek 期间 handle.ready 可能才变 true，重新收集一次
      const fresh = layersFor(timeline, frame);
      await draw(fresh.layers.length > 0 ? fresh.layers : layers);
    },

    renderLive(timeline, frame) {
      const { layers, active } = layersFor(timeline, frame);

      // 漂移纠正：video 自己走，偏差超过阈值才拉回来，避免每帧 seek。
      // 容差按**源片**帧长算：慢速素材放到高帧率时间轴上时，3 个时间轴帧
      // 可能还不到源片的 1 帧，按时间轴帧算会导致每帧都判超差、每帧都 seek
      for (const { source, clipId, seekSeconds } of active) {
        const handle = handleFor(source, clipId);
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
        active.map(async ({ source, clipId, seekSeconds }) => {
          const handle = handleFor(source, clipId);
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
      // 丢掉这个源片已建的所有原片 video，下次取帧会用代理重建。
      // 元素按片段索引，所以同一个源片可能有好几个（见 handleFor）
      for (const [key, handle] of [...handles]) {
        if (handle.sourceId === sourceId) dropHandle(key);
      }
    },

    stopPlayback() {
      playing = false;
      for (const handle of handles.values()) handle.video.pause();
    },

    dispose() {
      disposed = true;
      playing = false;
      for (const key of [...handles.keys()]) dropHandle(key);
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
