/**
 * 主线程侧的导出入口。
 *
 * 主线程做三件 Worker 做不了的事：
 *
 * 1. **混音**——`OfflineAudioContext` 在 Worker 里不可用（硬规则 6）。
 * 2. **调保存位置的 picker**——必须在用户手势里同步调起，所以由调用方在点击
 *    回调里先拿到 `WriteTargetSpec` 再传进来。
 * 3. **OPFS 回退时触发下载**——Worker 里没有 DOM。
 *
 * 其余（解码、合成、编码、封装）全在 Worker，导出期间界面不卡。
 */

import type { MixChunk, Mixer } from "../audio/mixdown";
import type { RenderRange, Timeline } from "../edl/types";
import type { ContainerChoice } from "../media/capability";
import type {
  ExportDone,
  ExportProgress,
  ExportRequest,
  RunId,
  WorkerRequest,
  WorkerResponse,
} from "./protocol";
import { residency, ResidencyTracker } from "./residency";
import { downloadFromOpfs, type WriteTargetSpec } from "./write-target";

export interface ExportOptions {
  readonly timeline: Timeline;
  readonly range: RenderRange;
  readonly container: ContainerChoice;
  readonly videoBitrate: number;
  readonly audioBitrate: number;
  /** 关掉就完全不混音，成片没有音轨。 */
  readonly includeAudio: boolean;
  readonly target: WriteTargetSpec;
  /** 成品写完后自动触发下载（仅 OPFS 回退路径需要；picker 路径已经写进用户选的文件）。 */
  readonly autoDownload?: boolean;
  /**
   * 混音的段长（秒）。**只有自检会传**——缺省 10 秒，而自检素材只有几秒，
   * 不压小就只会跑出一段，分段路径等于完全没被走到。
   */
  readonly mixSegmentSeconds?: number;
}

export interface ExportHandle {
  /** 返回 null 表示用户取消。 */
  readonly done: Promise<ExportDone | null>;
  cancel(): void;
}

/**
 * 这一页正在跑的那次导出的编号；null 表示空闲。
 *
 * **同页只许一次导出**，而且要在**入口就挡掉**、给出能读懂的错误。
 *
 * 理由是实测撞出来的一次假读数：同一页里两次长片自检并行跑（一个来自 `?autorun=`，
 * 一个是手点的），于是
 *
 * - 后开那次把 `worker.onmessage` 覆盖掉，先开那次再也收不到进度，90 秒后把一次
 *   **正在正常推进**的导出判成"死等，停在 decode:V1 第 600/900 帧"；
 * - 紧接着它的看门狗发出 `cancel`，把**另一次**正在跑的导出掐了，那一档报
 *   "导出被取消"——而它自己谁也没取消。
 *
 * 两份读数都是假的，两边都不抛错，而我据此把"iPhone 上一个页面导不了几次"当成了
 * 设备的墙。挡住并发本身值这一道，让它**报错而不是串线**更值：串线的表现恰好长得
 * 像被测对象出问题。同 CLAUDE.md 那条"先确认量法和被测对象分开了"。
 *
 * `RunId` 那道认号是第二道防线，兜的是"上一次被放弃、它的 cancel 迟到"这种跨时间的串线。
 */
let activeRun: RunId | null = null;
let nextRunId = 1;

export function startExport(
  options: ExportOptions,
  onProgress: (progress: ExportProgress) => void,
): ExportHandle {
  if (activeRun !== null) {
    return {
      done: Promise.reject(
        new Error(
          `这一页已经有一次导出在跑（第 ${activeRun} 次）。同页并行导出会互相掐断、` +
            `并把对方的进度判成死等，所以这里直接拒掉。等它跑完，或者刷新页面。`,
        ),
      ),
      cancel: () => undefined,
    };
  }
  const runId = nextRunId++;
  activeRun = runId;

  const totalFrames = options.range.outFrame - options.range.inFrame;
  let canceled = false;
  let worker: Worker | null = null;
  /** 由 `runInWorker` 装上：发取消 + 宽限期内没反应就把 Worker 掐掉。 */
  let requestCancel: (() => void) | null = null;

  const done = (async (): Promise<ExportDone | null> => {
    // ---- 阶段 1：建混音器，拿到元信息 ----
    // 动态 import：mixdown 拖着 mediabunny 的运行时（约 500KB），
    // 静态 import 会让它经由导出对话框回到首屏 chunk（实测踩过一次）
    const { createMixer, mixChunkTransferables } = await import("../audio/mixdown");

    // 混音的常驻量要**主线程自己量**：计量器每个 JS 上下文一份，Worker 那份
    // 看不到这一段。而混音恰恰是长片最可能先崩的地方——分段之前它要一次性把
    // 整条时间轴的 PCM 分配出来，30 分钟实测峰值 989MB（见 mixdown.ts 文件头）
    const mixTracker = new ResidencyTracker();
    residency.reset();
    const sampleMix = () => mixTracker.sample(0);

    onProgress({
      stage: "mix",
      encodedFrames: 0,
      totalFrames,
      elapsedMs: 0,
      residency: residency.snapshot(),
    });
    // 这一步只探"有没有解得出来的音轨"并排期，不解 PCM——真正的混音跟着
    // Worker 的 `audio-pull` 一段一段地跑
    const mixer = options.includeAudio
      ? await createMixer(options.timeline, options.range, {
          onSample: sampleMix,
          ...(options.mixSegmentSeconds !== undefined
            ? { segmentSeconds: options.mixSegmentSeconds }
            : {}),
        })
      : null;
    sampleMix();
    if (canceled) {
      mixer?.dispose();
      return null;
    }

    // ---- 阶段 2：交给 Worker，边编码边喂段 ----
    const request: ExportRequest = {
      timeline: options.timeline,
      range: options.range,
      container: options.container,
      videoBitrate: options.videoBitrate,
      audioBitrate: options.audioBitrate,
      audio: mixer?.header ?? null,
      target: options.target,
    };

    let result: ExportDone | null;
    try {
      result = await runInWorker(
        runId,
        request,
        mixer,
        mixChunkTransferables,
        sampleMix,
        onProgress,
        (w, cancelIt) => {
          worker = w;
          requestCancel = cancelIt;
          // 混音期间用户就点了取消
          if (canceled) cancelIt();
        },
      );
    } finally {
      mixer?.dispose();
      residency.setAudioPcmBytes(0);
      sampleMix();
    }

    if (!result) return null;
    // Worker 报的 residency 只覆盖导出循环，混音那一段挂在这里合并回去
    const merged: ExportDone = { ...result, mixResidency: mixTracker.report() };

    // ---- 阶段 3：OPFS 回退路径把成品交给浏览器下载 ----
    if (result.opfsName && options.autoDownload !== false) {
      await downloadFromOpfs(result.opfsName, result.mimeType);
    }
    return merged;
  })();

  // **成功 / 失败 / 取消三条路都要放锁**，否则一次失败的导出会让这一页从此
  // 全被上面那句"已经有一次导出在跑"顶掉——那正是常驻 Worker 那个坑的翻版
  const released = done.finally(() => {
    if (activeRun === runId) activeRun = null;
  });
  // `finally` 派生出来的这条链要是没人接就会成为 unhandled rejection
  released.catch(() => undefined);

  return {
    done: released,
    cancel() {
      canceled = true;
      requestCancel?.();
    },
  };
}

/**
 * 多久没有推进就在界面上说一句（毫秒）。
 *
 * **只是提示，不会让导出失败**，理由见 `ExportProgress.stalledMs`：Safari 后台
 * 标签的节流会让长片正常地停住好几分钟，自动判死会把"导出期间切去干别的"变成
 * 导出失败。所以这个数只要"大于任何一步的正常耗时"就够——最长的一步是收尾时
 * 写 mp4 索引（`mux-finalize`），30 分钟的片子在那里停十几秒是正常的。
 */
const STALL_HINT_MS = 60_000;

/**
 * 点了取消之后，等 Worker 认账多久（毫秒）。
 *
 * 正常情况下逐帧循环每帧都查一次取消标志，一帧之内就回话，5 秒是极宽的余量。
 * 到点还没回话说明它卡在一个看不到那个标志的 await 上，只能掐掉——见 `requestCancel`。
 */
const CANCEL_GRACE_MS = 5_000;

/**
 * 常驻导出 Worker。**跨导出复用，不再一次一个。**
 *
 * 换 Pixi 之后合成器是个 WebGL 上下文，而浏览器对同时存活的上下文有预算、
 * 超了驱逐**最老的那个**——最老的正是预览。每导出一次就建一个新上下文，
 * Safari 上十几轮就把预览判死，而且**救不回来**（spike 量过：被预算驱逐的
 * 上下文 `recover()` 会超时）。所以合成器必须常驻，而合成器住在 Worker 里，
 * Worker 就得跟着常驻。
 *
 * 出错的那个不留：Worker 抛到顶层之后内部状态不可知，terminate 掉换新的。
 * 正常结束和取消都保留。
 */
let sharedWorker: Worker | null = null;

function getWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  sharedWorker = new Worker(new URL("./export.worker.ts", import.meta.url), {
    type: "module",
    name: "kerf-export",
  });
  return sharedWorker;
}

function discardWorker(worker: Worker): void {
  if (sharedWorker === worker) sharedWorker = null;
  worker.terminate();
}

/**
 * 让常驻 Worker 放掉合成器画布，但**保留 Worker 本身**。
 *
 * 关掉导出面板时调。销毁 Worker 会连渲染上下文一起销毁，下次导出又要新建一个——
 * 正是上面要避免的事。
 */
export function releaseExportResources(): void {
  sharedWorker?.postMessage({ type: "release" } satisfies WorkerRequest);
}

function runInWorker(
  runId: RunId,
  request: ExportRequest,
  mixer: Mixer | null,
  transferablesOf: (chunk: MixChunk) => Transferable[],
  sampleMix: () => void,
  onProgress: (progress: ExportProgress) => void,
  onReady: (worker: Worker, requestCancel: () => void) => void,
): Promise<ExportDone | null> {
  const worker = getWorker();
  let settled = false;
  /**
   * 混音是串行的（`Mixer.next()` 共用一个解码池），而 `audio-pull` 是消息驱动的
   * ——预取会让两条请求挨得很近。用一条 Promise 链把它们排成队，比在 `next()`
   * 里加锁简单，也不需要 mixer 知道有并发这回事。
   */
  let mixQueue: Promise<void> = Promise.resolve();
  /**
   * 混音炸了要让**整次导出**失败，不能当成"音频到此为止"——后者会静默产出一条
   * 被截短的音轨（硬规则 10 那类"选了 A 拿到 B"）。所以错误既发给 Worker（叫醒
   * 它那个 await），也留在这里：Worker 走取消路径回来时用它替掉"用户取消"。
   */
  let mixError: Error | null = null;

  const answerPull = (index: number): void => {
    mixQueue = mixQueue.then(async () => {
      if (mixError) {
        worker.postMessage({
          type: "audio-chunk",
          runId,
          index,
          chunk: null,
          error: mixError.message,
        });
        return;
      }
      try {
        const chunk = (await mixer?.next()) ?? null;
        if (chunk && chunk.index !== index) {
          throw new Error(`音频分段乱序：要第 ${index} 段，混出来的是第 ${chunk.index} 段`);
        }
        sampleMix();
        const message: WorkerRequest = { type: "audio-chunk", runId, index, chunk };
        // PCM 每段几 MB，transfer 而不是结构化克隆——克隆会整份复制一遍。
        // post 之后 `chunk.channels` 在主线程这边就是零长数组了，不能再读
        worker.postMessage(message, chunk ? transferablesOf(chunk) : []);
        residency.setAudioPcmBytes(0);
        sampleMix();
      } catch (error) {
        mixError = error instanceof Error ? error : new Error(String(error));
        worker.postMessage({
          type: "audio-chunk",
          runId,
          index,
          chunk: null,
          error: mixError.message,
        });
      }
    });
  };

  /**
   * 盯"有没有推进"，不盯"有没有收到消息"。
   *
   * Worker 每秒一条心跳（`ExportProgress.heartbeat`），拿消息到达当判据的话永远
   * 不会超时。推进的定义是 `encodedFrames` 或 `marker` 变了——两者都不变就是
   * 真的停在同一步上。
   *
   * **页面不可见时不计**：那时停住是 Safari 节流的正常结果，不是故障。
   */
  let lastAdvanceAt = performance.now();
  let lastKey = "";
  let lastProgress: ExportProgress | null = null;

  const noteProgress = (progress: ExportProgress): void => {
    const key = `${progress.stage}/${progress.marker ?? ""}/${progress.encodedFrames}`;
    if (key !== lastKey) {
      lastKey = key;
      lastAdvanceAt = performance.now();
    }
    lastProgress = progress;
    const hidden = typeof document !== "undefined" && document.visibilityState !== "visible";
    const stalledMs = performance.now() - lastAdvanceAt;
    onProgress(
      !hidden && stalledMs >= STALL_HINT_MS ? { ...progress, stalledMs } : progress,
    );
  };

  // 心跳停了就再也没有消息能带上提示了（同步卡死，或者页面刚从后台回来），
  // 所以主线程自己也定时看一眼，拿最后那条进度补一发。
  //
  // 顺带它还是**唯一能自证"我们刚才根本没在看"的东西**：`visibilityState` 靠的是
  // 收得到 `visibilitychange`，而被挂起的那一侧可能收不到（实测 iPhone 报出过
  // "此刻可见、隐藏过 0 次"的死等，而那时页面确实不可见）。定时器的跳间隔不受这个
  // 影响——被冻住时它不跳。所以一跳隔得太久就把"没推进"的计时重新起算，
  // 别把挂起时长算成停滞。详见 `verify-device.ts` 的 `TICK_STARVED_MS`
  let lastTick = performance.now();
  const stallTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap > 15_000) {
      lastAdvanceAt = now;
      return;
    }
    if (!lastProgress) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    const stalledMs = now - lastAdvanceAt;
    if (stalledMs >= STALL_HINT_MS) onProgress({ ...lastProgress, stalledMs });
  }, 5_000);

  let cancelGrace: ReturnType<typeof setTimeout> | undefined;
  let rejectRun: ((error: Error) => void) | null = null;

  /**
   * 发取消，并且**给它一个宽限期**；到点还没回话就把 Worker 掐掉。
   *
   * 不这么做的后果是实测撞出来的：Worker 卡在一个不看取消标志的 await 上时
   * （注入一个永不 resolve 的 await 就是这个形态）它永远不会回话，而
   * `export.worker.ts` 里的 `running` 还是 true——于是**这一页之后每一次导出都会被
   * "已有导出任务在进行中"顶掉**。那是常驻 Worker 的代价：一次卡死污染整个会话。
   *
   * 直接的后果是界面上那句"取消掉再试"会是假话。掐掉换新的（`discardWorker`），
   * 那句话才成立。原本只有 `onerror` 会换 Worker，而死等根本不抛错。
   */
  const requestCancel = (): void => {
    if (settled) return;
    worker.postMessage({ type: "cancel", runId } satisfies WorkerRequest);
    if (cancelGrace !== undefined) return;
    cancelGrace = setTimeout(() => {
      if (settled) return;
      settled = true;
      discardWorker(worker);
      rejectRun?.(new Error("导出没有响应取消，已强制结束。再导一次会用一个新的后台线程。"));
    }, CANCEL_GRACE_MS);
  };

  /**
   * 监听器**按次挂、按次摘**，不用 `worker.onmessage =`。
   *
   * 赋值式的单槽位在常驻 Worker 上是个静默陷阱：后开的一次会把先开那次的
   * handler 顶掉，先开那次于是"再也收不到消息"，而它的判据是"多久没推进"——
   * 结果把一次正在正常跑的导出报成死等。实测撞过（见 `activeRun` 的注释）。
   * 现在同页并发已经在入口被拒，但监听器仍然按次隔离：那道锁靠的是我们自己
   * 记的一个变量，而这一层不需要谁记对。
   */
  let detach = (): void => undefined;

  const promise = new Promise<ExportDone | null>((resolve, reject) => {
    rejectRun = reject;
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      // 不是这一次的消息一律丢掉，理由见 `protocol.ts` 的 `RunId`
      if (message.runId !== runId) return;
      switch (message.type) {
        case "progress":
          noteProgress(message.progress);
          break;
        case "audio-pull":
          answerPull(message.index);
          break;
        case "done":
          settled = true;
          resolve(message.result);
          break;
        case "canceled":
          settled = true;
          // 混音失败会让 Worker 那边的 await 抛 ExportCanceled，于是它回的是
          // "canceled"。那不是用户取消，要把真正的原因报出去
          if (mixError) reject(mixError);
          else resolve(null);
          break;
        case "error":
          settled = true;
          // 业务错误（编码器不可用、写盘失败等）由管道自己收拾干净，
          // Worker 仍然可用，留着它——常驻的意义就在这里
          reject(mixError ?? new Error(message.message));
          break;
      }
    };

    // 顶层错误没有 runId 可认（不是我们发的消息），但它意味着 Worker 整个不能再用，
    // 所以归给此刻在跑的那一次就是对的
    const onError = (event: ErrorEvent) => {
      if (settled) return;
      settled = true;
      // 这条是**没被捕获**的顶层错误，Worker 内部状态不可知，不能再用
      discardWorker(worker);
      reject(new Error(event.message || "导出 Worker 异常退出"));
    };

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    detach = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
    };
  });

  // Worker 跨导出存活，这两个定时器和这对监听器都不能跟着活下去
  promise
    .finally(() => {
      clearInterval(stallTimer);
      clearTimeout(cancelGrace);
      detach();
    })
    .catch(() => undefined);

  const startMessage: WorkerRequest = { type: "start", runId, request };
  worker.postMessage(startMessage);
  onReady(worker, requestCancel);

  return promise;
}
