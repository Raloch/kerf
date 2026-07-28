/**
 * 预览出声。
 *
 * ## 为什么现在能做了，以及为什么之前是静音的
 *
 * M1 起预览刻意静音，理由写在 `preview-engine.ts` 的文件头：跟着 video 元素走的
 * 声音是错的——V1 和 A1 常来自同一文件，但用户可以把 A1 单独拖走或裁短，那时
 * "听起来对但实际不对"比没有声音更坏。要出声就必须有一个**按 EDL 的音频轨**独立
 * 排期的引擎。
 *
 * 现在有了：D22 把混音改成了"按段产出、按需拉取"的 `createMixer`，于是预览可以
 * **直接播导出会写进成片的那些字节**。
 *
 * ## 这就是硬规则 2 在音频上的护栏
 *
 * 画面那边靠共用 `compose()` 和取帧三函数；声音这边更强一层——预览不是"用同样的
 * 算法自己混一遍"，而是**跑同一个 `createMixer`、播它产出的同一段 PCM**。所以
 * 交叉淡化曲线、等功率还是等增益、片段增益、静音轨的处理，一件都不可能分叉，
 * 因为根本没有第二份实现。
 *
 * 唯一新增的、导出侧没有的东西是**把这些段排到实时时钟上**，而那部分的算术抽在
 * `audio-schedule.ts` 里单测（接缝逐样本相接、过去的段给出段内偏移、提前量够不够）。
 *
 * ## 主时钟不是这里
 *
 * 预览的主时钟是 `Preview.tsx` 那个 rAF（墙上时间 × 帧率），video 元素靠漂移纠正
 * 跟上它。声音**同样是被动跟随的一方**：偏离超过容差就整个重排一次
 * （`RESYNC_TOLERANCE_SECONDS`）。让声音当主时钟更专业，但那要重写现有的播放循环，
 * 而且 video 元素也得跟着改成被声音牵引——不是这一步该做的事。
 *
 * ## 音量只是预览的旋钮
 *
 * `setVolume` **不进 EDL、不影响导出**。把它做成项目属性就会变成"预览调小了、
 * 以为成片也小"那类误解，而真正的片段增益属于音量包络（还没做）。
 */

import type { RenderRange, Timeline } from "../edl/types";
import type { Mixer } from "../audio/mixdown";
import {
  chunkOffsetSeconds,
  chunkStartTime,
  driftedTooFar,
  needsMoreAudio,
  shouldSkip,
} from "./audio-schedule";

/**
 * 预览的混音段长（秒）。
 *
 * 比导出的 10 秒短得多：**起播延迟等于混第一段的时间**，而预览要求点下播放就出声。
 * 1 秒足够让一次混音的开销摊薄，又把首声延迟压到百毫秒级。
 */
const PREVIEW_SEGMENT_SECONDS = 1;

/**
 * 两次重新对齐之间至少隔多久（毫秒）。
 *
 * **这个下限是必须的，不是优化。** 实测撞过：自动播放策略下 `AudioContext` 停在
 * `suspended`，它的时钟几乎不走，而主时钟照常推进——于是漂移判据每一帧都成立，
 * 2.4 秒里建了 **25 个 AudioContext**，每个建完立刻被下一次重排关掉。Safari 对
 * 同时活着的 AudioContext 有硬上限（D22 踩过），这种风暴足以把页面搞死。
 *
 * 光有下限还不够，所以还有 `state !== "running"` 那道闸：时钟不走的时候重排
 * 一万次也对不齐，那不是漂移问题。两道一起才封住。
 */
const MIN_RESYNC_INTERVAL_MS = 1_000;

/**
 * 连着几次发现 context 起不来就彻底放弃出声。
 *
 * 起不来的原因通常是自动播放策略（没有用户手势）。反复 `resume()` 没有意义，
 * 而**安静地没有声音远好过一个不停自建自毁 AudioContext 的页面**。
 */
const MAX_RESUME_ATTEMPTS = 3;

export interface PreviewAudio {
  /**
   * 从某一帧开始出声。已经在播就先停掉再重排。
   *
   * 返回值表示这次有没有声音可放（时间轴上没有可用音频时是 false）——
   * 界面据此决定要不要显示音量控件。
   */
  start(timeline: Timeline, fromFrame: number): Promise<boolean>;
  stop(): void;
  /**
   * 主时钟走到了这一帧。每帧调（在 rAF 里），负责按需往前混、以及漂移纠正。
   *
   * **必须是同步的**：它在 rAF 回调里被调用。真正的混音由内部异步推进，
   * 这里只负责判断"要不要开始混下一段"。
   */
  tick(frame: number): void;
  /**
   * 时间轴变了：已经排出去的声音作废。
   *
   * 要带上新的时间轴——**播放中的编辑必须能自己恢复**。只作废不重排的话，
   * 拖一下片段就永久静音到下次重新点播放，而画面还在正常走：那是"预览有声音"
   * 这个功能最容易被当成 bug 的形态。重排发生在下一次 `tick`（那时才知道播放头
   * 走到哪了）。
   */
  invalidate(timeline: Timeline): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

interface Session {
  readonly mixer: Mixer;
  readonly context: AudioContext;
  readonly gain: GainNode;
  /**
   * 整条 PCM 第 0 个样本对应的 AudioContext 时刻，以及那一刻的播放头。
   *
   * **在第一次 `tick` 里才定，不在 `start` 里定。** 早先是建完混音器就地锚定，
   * 而 `createMixer` 要探一遍解码器、耗时几十到几百毫秒——那段时间里主时钟已经
   * 往前走了，于是音频原点天生就落后主时钟一个"建混音器的耗时"。表现是漂移判据
   * **从第一帧起就成立**、每秒重排一次（实测 2.5 秒里 4 次，正好卡在重排下限上）。
   * 在第一次 tick 里锚定，两个时钟就是同一时刻对齐的，没有这个系统性偏差。
   */
  originTime: number;
  startFrame: number;
  anchored: boolean;
  readonly sampleRate: number;
  readonly fps: { readonly num: number; readonly den: number };
  /** 已经排到的样本位置（不含）。 */
  scheduledUntil: number;
  /** 正在混下一段，避免重入——`Mixer.next()` 必须串行调用。 */
  pulling: boolean;
  done: boolean;
  readonly sources: AudioBufferSourceNode[];
}

export function createPreviewAudio(): PreviewAudio {
  let session: Session | null = null;
  let volume = 1;
  let muted = false;
  /** 当前时间轴，重排时要用。 */
  let currentTimeline: Timeline | null = null;
  /** 正在重排：避免 tick 里连着触发好几次。 */
  let restarting = false;
  /** 内容作废了，等下一次 tick 拿着播放头重排。 */
  let stale = false;
  /** 上一次重新对齐的时刻，用来给重排设下限。 */
  let lastResyncAt = 0;
  /** context 起不来的次数。到上限就彻底放弃，见 `MAX_RESUME_ATTEMPTS`。 */
  let resumeFailures = 0;
  /** 这一页已经放弃出声了（context 起不来）。 */
  let givenUp = false;

  const applyGain = (): void => {
    if (session) session.gain.gain.value = muted ? 0 : volume;
  };

  const teardown = (): void => {
    if (!session) return;
    for (const node of session.sources) {
      try {
        node.stop();
      } catch {
        // 没 start 过的 stop 会抛，无所谓
      }
      node.disconnect();
    }
    session.mixer.dispose();
    // **必须显式关。** Safari 对同时活着的 AudioContext 有硬上限，靠 GC 赶不上
    // 建的速度（D22 踩过：切 12 段时第 9 段起渲染结果直接变成静音）。预览会因为
    // 每次 seek / 每次编辑而重建 session，比导出更容易撞上
    void session.context.close().catch(() => undefined);
    session = null;
  };

  const frameToSeconds = (frames: number, fps: { num: number; den: number }): number =>
    (frames * fps.den) / fps.num;

  /** 拉一段混好的 PCM 排进去。串行——`Mixer.next()` 不允许并发。 */
  const pump = async (): Promise<void> => {
    const s = session;
    // 没锚定就没有原点，排不出 `when`——等第一次 tick
    if (!s || !s.anchored || s.pulling || s.done) return;
    s.pulling = true;
    try {
      while (session === s && !s.done) {
        const nowSample = Math.max(
          0,
          (s.context.currentTime - s.originTime) * s.sampleRate,
        );
        if (!needsMoreAudio(s.scheduledUntil, nowSample, s.sampleRate)) break;

        const chunk = await s.mixer.next();
        // 期间可能已经被 seek / 编辑掉了；那时这段 PCM 直接丢掉
        if (session !== s) return;
        if (!chunk) {
          s.done = true;
          break;
        }

        s.scheduledUntil = chunk.startSample + chunk.frameCount;
        const now = s.context.currentTime;
        if (shouldSkip(s.originTime, chunk.startSample, chunk.frameCount, s.sampleRate, now)) {
          // 整段都过去了（混得比播得慢）。**只跳整段过去的**——半过去的要靠
          // offset 从中间接上，丢掉整段会在声音里留一个洞
          continue;
        }

        const buffer = s.context.createBuffer(
          chunk.channels.length,
          chunk.frameCount,
          s.sampleRate,
        );
        for (let ch = 0; ch < chunk.channels.length; ch++) {
          // `copyToChannel` 的类型要求 `Float32Array<ArrayBuffer>`，而 MixChunk 的
          // 声道声明成 `ArrayBufferLike`（可能是 SharedArrayBuffer）。混音器产出的
          // 一定是普通 ArrayBuffer——它来自 `AudioBuffer.getChannelData()
          buffer.copyToChannel(chunk.channels[ch] as Float32Array<ArrayBuffer>, ch);
        }
        const node = s.context.createBufferSource();
        node.buffer = buffer;
        node.connect(s.gain);
        const offset = chunkOffsetSeconds(s.originTime, chunk.startSample, s.sampleRate, now);
        // `when` 从原点独立算出，不递推——见 `audio-schedule.ts`
        node.start(Math.max(now, chunkStartTime(s.originTime, chunk.startSample, s.sampleRate)), offset);
        s.sources.push(node);
        // 播完就摘掉，否则一条长片会攒上百个节点
        node.onended = () => {
          node.disconnect();
          const i = s.sources.indexOf(node);
          if (i >= 0) s.sources.splice(i, 1);
        };
      }
    } catch {
      // 混音炸了就安静下来。**不能让它把播放也搞停**——画面还在正常走，
      // 而"这条片子没声音"远好过"点了播放整个卡住"
      if (session === s) s.done = true;
    } finally {
      if (session === s) s.pulling = false;
    }
  };

  const startAt = async (timeline: Timeline, fromFrame: number): Promise<boolean> => {
    if (givenUp) return false;
    teardown();
    currentTimeline = timeline;
    stale = false;
    resumeFailures = 0;
    const range: RenderRange = { inFrame: fromFrame, outFrame: timeline.durationFrames };
    if (range.outFrame <= range.inFrame) return false;

    const { createMixer } = await import("../audio/mixdown");
    const mixer = await createMixer(timeline, range, {
      segmentSeconds: PREVIEW_SEGMENT_SECONDS,
    });
    if (!mixer) return false;

    const context = new AudioContext({ sampleRate: mixer.header.sampleRate });
    // 自动播放策略：点播放是用户手势，但 context 可能仍以 suspended 出生
    await context.resume().catch(() => undefined);
    const gain = context.createGain();
    gain.connect(context.destination);

    session = {
      mixer,
      context,
      gain,
      // 锚定推迟到第一次 tick，见 `Session.originTime`
      originTime: 0,
      startFrame: fromFrame,
      anchored: false,
      sampleRate: mixer.header.sampleRate,
      fps: timeline.fps,
      scheduledUntil: 0,
      pulling: false,
      done: false,
      sources: [],
    };
    applyGain();
    return true;
  };

  return {
    start: startAt,

    stop() {
      teardown();
      // 停了就不该再自动重排：下一次出声一定经过 `start`
      stale = false;
    },

    tick(frame) {
      // 编辑过之后在这里恢复：`invalidate` 只知道新内容，不知道播到哪了
      if (stale && currentTimeline && !restarting) {
        stale = false;
        restarting = true;
        const timeline = currentTimeline;
        void startAt(timeline, frame)
          .then((has) => void has)
          .finally(() => {
            restarting = false;
          });
        return;
      }
      const s = session;
      if (!s) return;

      /*
        **时钟不走就不要谈漂移。** context 停在 `suspended`（自动播放策略最常见）
        时它的 `currentTime` 几乎不动，而主时钟照常推进，于是漂移判据每帧都成立
        ——实测那会在 2.4 秒里建 25 个 AudioContext，每个立刻被下一次重排关掉。
        重排一万次也对不齐，因为问题不是漂移。试着唤醒几次，不行就安静放弃。
      */
      if (s.context.state !== "running") {
        if (resumeFailures >= MAX_RESUME_ATTEMPTS) {
          // 彻底放弃：把 session 拆掉，别让一个永远不响的 context 挂在那里
          givenUp = true;
          teardown();
          return;
        }
        resumeFailures++;
        void s.context.resume().catch(() => undefined);
        return;
      }
      resumeFailures = 0;

      // 第一次 tick 才锚定：这一刻主时钟和音频时钟是同一个瞬间，没有
      // "建混音器耗时"那个系统性偏差（见 `Session.originTime`）
      if (!s.anchored) {
        s.anchored = true;
        s.startFrame = frame;
        // 留一点起播余量，让第一段有时间混出来再响
        s.originTime = s.context.currentTime + 0.05;
        void pump();
        return;
      }

      // 声音是被动跟随的一方，同 video 元素的漂移纠正
      const expected = frameToSeconds(frame - s.startFrame, s.fps);
      const audioSeconds = s.context.currentTime - s.originTime;
      if (audioSeconds > 0 && driftedTooFar(expected, audioSeconds)) {
        // 重排有下限：没有它，任何持续性的偏差都会变成 AudioContext 风暴
        const now = performance.now();
        if (!restarting && currentTimeline && now - lastResyncAt >= MIN_RESYNC_INTERVAL_MS) {
          lastResyncAt = now;
          restarting = true;
          const timeline = currentTimeline;
          void startAt(timeline, frame).finally(() => {
            restarting = false;
          });
        }
        return;
      }
      void pump();
    },

    invalidate(timeline) {
      teardown();
      currentTimeline = timeline;
      stale = true;
    },

    setVolume(next) {
      volume = Math.max(0, Math.min(1, next));
      applyGain();
    },

    setMuted(next) {
      muted = next;
      applyGain();
    },

    dispose() {
      teardown();
      currentTimeline = null;
    },
  };
}
