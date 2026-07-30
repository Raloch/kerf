/**
 * 多轨音频混流。**必须在主线程跑**。
 *
 * `OfflineAudioContext` 在 Worker 里不可用（硬规则 6），所以导出的音频
 * 不能像视频那样整条留在 Worker 内：这里混出 PCM，再 transfer 进 Worker
 * 交给编码器。
 *
 * ## 为什么用 OfflineAudioContext 而不是自己加加减减
 *
 * 混音本身只是相加，难的是**重采样**：素材可能是 44.1k、48k 混着来，
 * 单声道和立体声混着来，而输出只有一个采样率和声道数。自己写重采样等于
 * 重新实现一遍 Web Audio 已经做对的事情（而且很容易在边界产生咔哒声）。
 * 把每个片段挂成 `AudioBufferSourceNode` 并 `start(时间轴位置)`，
 * 采样率转换、声道上混、叠加全由音频图完成。
 *
 * ## 分段产出，不再整条攒着（M3）
 *
 * 整条混完的峰值实测 **989MB / 30 分钟**，随片长线性涨，一小时约 2GB。而且
 * 峰值不止"最终 PCM"那一份——所有素材的解码结果要**同时**挂在音频图上等渲染，
 * `OfflineAudioContext` 的渲染目标是完整的另一整份。
 *
 * 所以这里改成**边混边交**：`createMixer()` 返回一个按段产出的迭代器，Worker
 * 那边消费完一段才拉下一段（`export/protocol.ts` 的 `audio-pull`）。于是同时
 * 活着的只有 1–2 段，峰值**与片长无关**。切段的算术在 `mix-segments.ts`，
 * 接缝为什么能做到样本精确也在那里。
 *
 * 这几项都接进了常驻量计量（`export/residency.ts` 的 `audioMixBytes`），
 * 所以上面这些不是估的，是能在导出面板上看到的数。
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input, type AudioSample } from "mediabunny";
import type { ClipId, RenderRange, SourceId, Timeline } from "../edl/types";
import { residency } from "../export/residency";
import { toNumber } from "../time/rational";
import { crossfadeCurve } from "./crossfade";
import { planAudioJobs, type AudioJob } from "./mix-plan";
import { planMixSegments, type MixSegment } from "./mix-segments";

/** AudioBuffer 的字节数：f32，每声道每帧 4 字节。 */
function bufferBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * 4;
}

/**
 * 混流输出采样率。
 *
 * 固定 48kHz 而不是跟随素材：AAC 和 Opus 都以 48k 为原生档位，
 * 跟随 44.1k 素材反而会在编码器里再重采样一次。
 */
export const MIX_SAMPLE_RATE = 48_000;
/** 混流输出声道数。M2 做环绕声之前固定立体声。 */
export const MIX_CHANNELS = 2;

/**
 * 整条混音的元信息。**在第一段 PCM 之前就要知道**——Worker 得先据此建音轨、
 * 探编码器延迟，那两件事都发生在逐帧循环开始之前。
 */
export interface MixHeader {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** 整条 PCM 的总样本数（每声道）。 */
  readonly frameCount: number;
  readonly segmentCount: number;
}

/**
 * 一段混好的 PCM。`channels` 里每项是一个声道（f32-planar 的一个平面）。
 *
 * **这是一份"交出去就没了"的数据**：`channels` 通常直接就是渲染结果的后备存储
 * （见 `takeChannels`），transfer 进 Worker 之后主线程这边会变成零长数组。
 * 所以拿到它就该立刻 post 走，不要在 post 之后再读——`frameCount` 之类的标量
 * 都在这个对象上另存了一份，正是为了 post 之后还能报数。
 */
export interface MixChunk {
  readonly index: number;
  /** 这一段在整条 PCM 里的起始样本，供 Worker 断言顺序与连续性。 */
  readonly startSample: number;
  readonly frameCount: number;
  readonly channels: readonly Float32Array[];
}

/** 把一段 PCM 的 ArrayBuffer 收集出来，用于 postMessage 的 transfer 列表。 */
export function mixChunkTransferables(chunk: MixChunk): Transferable[] {
  return chunk.channels.map((channel) => channel.buffer as ArrayBuffer);
}

/**
 * 这批声道数组能不能**直接把所有权交出去**（transfer），而不必先拷一份。
 *
 * 两个前提，缺一不可：
 *
 * - **每个数组整块独占一个 ArrayBuffer**。若它是某个大 buffer 上的子视图，
 *   transfer 会把整块搬走，连带影响别的声道。
 * - **各声道不共用同一个 ArrayBuffer**。共用的话 transfer 列表里会出现重复项，
 *   `postMessage` 直接抛 DataCloneError——整次导出失败。
 *
 * Chrome 150 和 Safari 26.5 上实测两条都成立（`getChannelData()` 返回的就是
 * 那一个声道的完整后备存储，重复调用返回同一个 buffer）。但这是**规范灰区**：
 * Web Audio 只规定了 "acquire the content" 之后 `getChannelData()` 返回零长数组，
 * 没规定后备存储怎么摆。所以这里不假设，每次都当场验，不满足就退回拷贝。
 *
 * 抽成纯函数是为了能单测——真正的 `AudioBuffer` 在 node 里造不出来，而这段
 * "能不能搬"的判断恰恰是会写错的地方（漏判共用 buffer 就是线上抛异常）。
 */
export function channelsAreMovable(views: readonly Float32Array[]): boolean {
  const buffers = new Set<ArrayBufferLike>();
  for (const view of views) {
    if (view.byteOffset !== 0) return false;
    if (view.buffer.byteLength !== view.length * Float32Array.BYTES_PER_ELEMENT) return false;
    if (buffers.has(view.buffer)) return false;
    buffers.add(view.buffer);
  }
  return true;
}

/**
 * 取出渲染结果的各声道，**能直接交出所有权就直接交**。
 *
 * 上一版无条件拷了一份，理由写的是"getChannelData 返回的数组由 AudioBuffer 持有，
 * 直接 transfer 会把它 detach，rendered 自己就坏了"。前半句对，后半句是**多余的
 * 顾虑**——`rendered` 在这之后就没人要了，坏掉正好。
 *
 * 这一份不是记账上的虚数。Chrome 里量渲染进程 RSS：渲染完 +220MB（10 分钟立体声
 * 的一份 PCM），显式拷贝之后再 +220MB。也就是说 `getChannelData()` 本身不复制，
 * 而那句 `new Float32Array(...)` 是实打实的第二份。
 *
 * **分段之后这里多了一种必须拷的情况**：段两侧撑开的 pad 要丢掉，取的是渲染
 * 结果**中间那一截**，那必然是子视图。只有 pad 为零（整条只有一段，或首段
 * 左侧）且长度正好时才拿得到整块。
 *
 * 返回 `copied` 供计量用：退回拷贝时峰值会高一份，那必须在导出面板上看得见。
 */
function takeChannels(
  rendered: AudioBuffer,
  offset: number,
  length: number,
): { readonly channels: Float32Array[]; readonly copied: boolean } {
  const whole = offset === 0 && length === rendered.length;
  const views: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const plane = rendered.getChannelData(ch);
    views.push(whole ? plane : plane.subarray(offset, offset + length));
  }
  if (whole && channelsAreMovable(views)) return { channels: views, copied: false };
  return { channels: views.map((view) => new Float32Array(view)), copied: true };
}

/** 按段产出 PCM 的混音器。用完必须 `dispose()`。 */
export interface Mixer {
  readonly header: MixHeader;
  /** 按顺序产出下一段；产完返回 null。**必须串行调用**（共用解码池）。 */
  next(): Promise<MixChunk | null>;
  dispose(): void;
}

export interface MixerOptions {
  /** 段长（秒）。只有自检会传——要在短素材上逼出多段。 */
  readonly segmentSeconds?: number;
  readonly padSeconds?: number;
  /**
   * 在**每段的峰值那一刻**回调，供调用方采一次常驻量。
   *
   * 不能让调用方在 `next()` 返回之后自己采：那时解码结果和渲染目标都已经销账，
   * 采到的是谷值不是峰值。而"分段之后峰值不随片长增长"正是这次改动要证明的事，
   * 采错了地方就等于没证。
   */
  readonly onSample?: () => void;
}

/**
 * 建一个分段混音器。这次导出没有任何可用音频时返回 null。
 *
 * "没有可用音频"分两层，都要在**产出第一段之前**判掉——Worker 得据此决定
 * 建不建音轨：
 *
 * 1. 排期为空（没有未静音的音频轨、或轨上片段都不带声音）；
 * 2. 排上了但**一个都解不出来**（编码格式不支持等）。第二层要真的问一次解码器，
 *    所以这里对每个**不同的源片**探一次。不探的话会产出一条整段静音的音轨，
 *    让用户以为"导出成功但没声音"是我们弄丢的。
 *
 * 探测按源片去重而不是按片段：一条 30 分钟时间轴上可能有上百个片段却只有
 * 几个源文件，按片段探就是上百次开文件。
 */
export async function createMixer(
  timeline: Timeline,
  range: RenderRange,
  options?: MixerOptions,
): Promise<Mixer | null> {
  if (range.outFrame <= range.inFrame) return null;

  const jobs = planAudioJobs(timeline, range);
  if (jobs.length === 0) return null;

  const fileOf = new Map(timeline.sources.map((s) => [s.id, s.file] as const));
  const decodable = await probeDecodableSources(new Set(jobs.map((j) => j.sourceId)), fileOf);
  if (decodable.size === 0) return null;

  const plan = planMixSegments(range, timeline.fps, MIX_SAMPLE_RATE, {
    ...(options?.segmentSeconds !== undefined ? { targetSeconds: options.segmentSeconds } : {}),
    ...(options?.padSeconds !== undefined ? { padSeconds: options.padSeconds } : {}),
  });

  // 相邻两段的源片区间重叠 2 × pad，游标要留够这么长的回看；多给半秒余量，
  // 免得包边界正好卡在临界上。
  //
  // **变速要乘进去**（D39）：pad 是**输出**帧数，而回看队列量的是**源片**秒数，
  // 2× 的片段在同样长的输出重叠里消耗两倍源片。漏乘的表现正是 D22 记过的那个——
  // 队列不够长时**除第一段外全部静音**，波形打出来是一排 0.000，而且不报错。
  // 取所有 job 里最大的那个速度而不是 `SPEED_RANGE.max`：后者会让没变速的项目
  // 也白留 8 倍的回看队列，而这个队列的长度直接是内存。
  const maxSpeed = jobs.reduce((m, job) => Math.max(m, job.speed ? toNumber(job.speed) : 1), 1);
  const backlogSeconds =
    ((2 * plan.padFrames * timeline.fps.den) / timeline.fps.num) * maxSpeed + 0.5;
  const pool = new ClipCursorPool(fileOf, backlogSeconds);
  let at = 0;

  return {
    header: {
      sampleRate: MIX_SAMPLE_RATE,
      numberOfChannels: MIX_CHANNELS,
      frameCount: plan.totalSamples,
      segmentCount: plan.segments.length,
    },
    async next(): Promise<MixChunk | null> {
      const segment = plan.segments[at];
      if (!segment) {
        await pool.disposeAll();
        return null;
      }
      at++;
      try {
        return await renderSegment(timeline, segment, decodable, pool, options?.onSample);
      } catch (error) {
        await pool.disposeAll();
        throw error;
      }
    },
    dispose(): void {
      void pool.disposeAll();
    },
  };
}

/**
 * 一个片段的音频**只向前推进的解码游标**。
 *
 * ## 为什么不能每段各自 seek 一次
 *
 * 最初的写法是每段都 `sink.samples(start, end)` 从头 seek 一次。Chrome 上没问题，
 * **Safari 上从第 9 段起画风突变**：波形相位分毫不差，幅度却差 5.7% 并逐段放大到
 * 26%。也就是说重新 seek 之后解码器吐出来的头几百毫秒**不完全正确**，而 Safari
 * 需要的预热远比一个 AAC 包（21ms）长——把 pad 从 0.167 秒加到 0.5 秒就全绿了。
 *
 * 但"加大 pad"是把正确性押在一个凑出来的常数上：它取决于浏览器、编解码器和素材，
 * 而错了不报错、只是成片音量在段边界上轻微起伏。所以改成**一次 seek、之后只向前
 * 读**——这样一个片段在整次导出里只被解一遍，段边界不再是解码重启点，分段与不
 * 分段的结果就成了**结构上**相同，而不是"pad 够大就相同"。
 *
 * 这正是导出层那条"取帧只能向前"在音频上的翻版，也是上一轮查 Safari 那 9.3ms
 * 时得到的同一条教训：**别把某个浏览器 seek 之后给的东西当成事实。**
 *
 * 按 `clipId` 而不是 `sourceId` 索引，则是"同源片的并发游标不能共用 demuxer"
 * 的翻版——两条轨引用同一个文件时，交错拉包会互相打乱读取位置。
 */
class ClipAudioCursor {
  private readonly input: Input;
  private sink: AudioSampleSink | null = null;
  private iterator: AsyncGenerator<AudioSample, void, unknown> | null = null;
  /**
   * 已解出、可能还要再用一次的包，按时间排序。
   *
   * **相邻两段的源片区间是重叠的**——每段两侧各撑 `padFrames`，所以后一段的起点
   * 落在前一段末尾之前。游标只能向前，重叠那截就必须留着；不留的表现是**除第一段
   * 外全部静音**（实测踩过，波形直接打印出一排 0.000）。
   *
   * 队列只保留 `backlogSeconds` 这么长的尾巴，所以它不随片长增长。
   */
  private readonly backlog: { readonly buffer: AudioBuffer; readonly timestamp: number }[] = [];
  private ended = false;
  private rate = 0;
  private channels = 0;

  constructor(
    file: File,
    /** 要留多长的回看，取相邻两段的重叠量（2 × pad）再加一点余量。 */
    private readonly backlogSeconds: number,
  ) {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    residency.openInput();
  }

  /** 准备好解码器。这条轨解不了就返回 false，调用方跳过这个片段。 */
  async open(): Promise<boolean> {
    if (this.sink) return true;
    try {
      const track = await this.input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) return false;
      this.rate = await track.getSampleRate();
      this.channels = await track.getNumberOfChannels();
      this.sink = new AudioSampleSink(track);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读出 [start, end) 这段源片音频，按源片自身的采样率和声道数返回。
   *
   * **区间允许伸出源片两端**（转场借余量时必然如此，见 `mix-plan.ts` 文件头）。
   * 缓冲区按请求的完整长度开，解不到的那部分留成零 = 静音。所以向解码器要的是
   * 夹紧过的区间，而写回偏移仍按**未夹紧**的起点算——两处用同一个值会把前半段
   * 静音吃掉，表现是入场那一侧的淡入整体提前。
   */
  async read(startSeconds: number, endSeconds: number): Promise<AudioBuffer | null> {
    if (!this.sink) return null;
    const rate = this.rate;
    const frameCount = Math.max(1, Math.round((endSeconds - startSeconds) * rate));
    const out = new AudioBuffer({
      length: frameCount,
      numberOfChannels: this.channels,
      sampleRate: rate,
    });
    // 只在第一次 seek。之后一路向前，段边界不再是解码重启点
    this.iterator ??= this.sink.samples(Math.max(0, startSeconds));

    // 丢掉整个落在本段之前的（读请求的起点只会往前走）
    this.trimBefore(startSeconds);
    // 向前解到覆盖住 endSeconds 为止
    while (!this.ended && this.lastEnd() < endSeconds) {
      if (!(await this.pull())) break;
    }

    for (const packet of this.backlog) {
      const dstStart = Math.round((packet.timestamp - startSeconds) * rate);
      if (dstStart >= frameCount) break;
      const srcOffset = dstStart < 0 ? -dstStart : 0;
      const dstOffset = dstStart < 0 ? 0 : dstStart;
      const available = packet.buffer.length - srcOffset;
      if (available <= 0) continue;

      const writable = Math.min(available, frameCount - dstOffset);
      const usable = Math.min(this.channels, packet.buffer.numberOfChannels);
      for (let ch = 0; ch < usable; ch++) {
        const src = packet.buffer.getChannelData(ch).subarray(srcOffset, srcOffset + writable);
        out.copyToChannel(src, ch, dstOffset);
      }
    }

    // 只留下一段可能还要的那截尾巴
    this.trimBefore(endSeconds - this.backlogSeconds);
    return out;
  }

  /** 队列里最后一个包的结束时刻；空队列返回 -Infinity。 */
  private lastEnd(): number {
    const last = this.backlog[this.backlog.length - 1];
    return last ? last.timestamp + last.buffer.length / this.rate : -Infinity;
  }

  private trimBefore(cutoff: number): void {
    while (this.backlog.length > 0) {
      const head = this.backlog[0]!;
      if (head.timestamp + head.buffer.length / this.rate > cutoff) break;
      this.backlog.shift();
    }
  }

  /** 再解一个包进队列。解完了返回 false。 */
  private async pull(): Promise<boolean> {
    if (!this.iterator || this.ended) return false;
    const result = await this.iterator.next();
    if (result.done) {
      this.ended = true;
      return false;
    }
    const sample = result.value;
    try {
      this.backlog.push({ buffer: sample.toAudioBuffer(), timestamp: sample.timestamp });
    } finally {
      // AudioBuffer 是拷贝出来的，关掉 sample 不影响它（硬规则 4）
      sample.close();
    }
    return true;
  }

  /**
   * 关掉解码器和 demuxer。
   *
   * **必须 `return()` 迭代器**：`samples()` 没有传上界（我们不知道要读到哪），
   * mediabunny 的解码泵要等消费方主动收尾才会 `decoder.close()`。不收就是每个
   * 片段漏一个解码器，而漏解码器在几秒的自检片上完全看不出来。
   */
  async dispose(): Promise<void> {
    await this.iterator?.return();
    this.iterator = null;
    this.sink = null;
    this.backlog.length = 0;
    this.input.dispose();
    residency.closeInput();
  }
}

/**
 * 活着的解码游标。**不再用的立刻还回去**，于是池深被"一段里同时有声音的片段数"
 * 限住，不随片长增长——这正是分段要达到的效果，所以它接进计量（`openInputs`）。
 */
class ClipCursorPool {
  private readonly open = new Map<ClipId, ClipAudioCursor>();

  constructor(
    private readonly fileOf: ReadonlyMap<SourceId, File>,
    private readonly backlogSeconds: number,
  ) {}

  async acquire(clipId: ClipId, sourceId: SourceId): Promise<ClipAudioCursor | null> {
    const existing = this.open.get(clipId);
    if (existing) return existing;
    const file = this.fileOf.get(sourceId);
    if (!file) return null;
    const cursor = new ClipAudioCursor(file, this.backlogSeconds);
    this.open.set(clipId, cursor);
    if (await cursor.open()) return cursor;
    this.open.delete(clipId);
    await cursor.dispose();
    return null;
  }

  /** 把不在 `keep` 里的都关掉。 */
  async retainOnly(keep: ReadonlySet<ClipId>): Promise<void> {
    for (const [clipId, cursor] of [...this.open]) {
      if (keep.has(clipId)) continue;
      this.open.delete(clipId);
      await cursor.dispose();
    }
  }

  async disposeAll(): Promise<void> {
    await this.retainOnly(new Set());
  }
}

/**
 * 每个源片探一次"这条音轨解得出来吗"。返回解得出来的那些。
 *
 * 只开 `Input` 读元信息，不解任何 PCM——这一步跑在导出开始之前，不该占内存。
 */
async function probeDecodableSources(
  sourceIds: ReadonlySet<SourceId>,
  fileOf: ReadonlyMap<SourceId, File>,
): Promise<Set<SourceId>> {
  const ok = new Set<SourceId>();
  for (const sourceId of sourceIds) {
    const file = fileOf.get(sourceId);
    if (!file) continue;
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track && (await track.canDecode())) ok.add(sourceId);
    } catch {
      // 单个素材探不动不该让整次导出失败——它只是不参与混音
    } finally {
      input.dispose();
    }
  }
  return ok;
}

/**
 * 渲染一段：按 pad 过的区间重新排一次期，混完只取中间那截。
 *
 * **排期按 pad 过的区间重算，而不是切整条的排期**。`planAudioJobs` 已经会处理
 * "导出区间从转场窗口中间切过去"——曲线从对应进度接上、`baseGain` 取那一刻的
 * 值（见 `mix-plan.ts`）。段边界和那个情形是同一回事，于是分段一行新的包络
 * 逻辑都不用写。这是 D19 把时间模型抽成纯函数之后的第三次回报。
 */
async function renderSegment(
  timeline: Timeline,
  segment: MixSegment,
  decodable: ReadonlySet<SourceId>,
  pool: ClipCursorPool,
  onSample?: () => void,
): Promise<MixChunk> {
  const jobs = planAudioJobs(timeline, {
    inFrame: segment.renderInFrame,
    outFrame: segment.renderOutFrame,
  }).filter((job) => decodable.has(job.sourceId));

  // 这一段用不到的片段先还回去，别让池子随片长长大
  await pool.retainOnly(new Set(jobs.map((j) => j.clipId)));

  const ctx = new OfflineAudioContext(
    MIX_CHANNELS,
    segment.renderLengthSamples,
    MIX_SAMPLE_RATE,
  );

  // 挂上音频图的解码结果在渲染完成前都不能释放，这里记着好在渲染后一次性还掉
  let scheduledBytes = 0;
  for (const job of jobs) {
    const cursor = await pool.acquire(job.clipId, job.sourceId);
    if (!cursor) continue;
    const pcm = await cursor.read(job.srcStartSeconds, job.srcEndSeconds);
    if (!pcm) continue;

    const node = ctx.createBufferSource();
    node.buffer = pcm;
    node.connect(envelopeInput(ctx, job));
    // 变速：源片区间已经是 `时长 × speed`（`sourceMicrosAt` 里做的），这里只把
    // "要在多短的时间里放完"告进音频图，两者相乘正好等于片段的占位。**原速不碰
    // 这个属性**——`playbackRate` 缺省就是 1，赋一遍在算术上无害，但那会让"没变速
    // 的项目连代码路径都和以前相同"这句话不再成立（同音量为 1 时一个采样点都不碰）。
    // 代价：声音**跟着变调**（这就是重采样），保音高是另一件事，界面上要说出来
    if (job.speed) node.playbackRate.value = toNumber(job.speed);
    // 采样率不同由音频图重采样，单声道由音频图上混到立体声——都不用我们插手
    node.start(job.whenSeconds);
    scheduledBytes += bufferBytes(pcm);
    residency.retainMixBytes(bufferBytes(pcm));
  }

  const rendered = await withRenderWatchdog(ctx.startRendering(), segment.index);
  releaseContext(ctx);
  const renderedBytes = bufferBytes(rendered);
  residency.retainMixBytes(renderedBytes);
  // 峰值就在这一刻（解码结果 + 渲染目标同时活着），采一下才看得到
  onSample?.();

  const { channels, copied } = takeChannels(
    rendered,
    segment.takeOffsetSamples,
    segment.takeLengthSamples,
  );
  const takenBytes = segment.takeLengthSamples * MIX_CHANNELS * 4;
  if (copied) residency.retainMixBytes(takenBytes);

  // **解码结果要到这里才销账，不是渲染一完成就销。** 它们还挂在
  // `AudioBufferSourceNode.buffer` 上，而那些节点由 `ctx` 引用着，`ctx` 活到函数返回。
  // 第一版在 startRendering() 之后就减掉了，于是峰值少报了整整一份——
  // 记账点必须贴着"最后一个引用消失"的地方写，不是贴着"逻辑上用完了"
  residency.releaseMixBytes(scheduledBytes + renderedBytes + (copied ? takenBytes : 0));
  // 交出去之前这一段还在主线程手上，换个名目继续记着
  residency.setAudioPcmBytes(takenBytes);

  return {
    index: segment.index,
    startSample: segment.outStartSample,
    frameCount: segment.takeLengthSamples,
    channels,
  };
}

/**
 * 一段渲染最多等多久（毫秒）。一段是 10 秒音频，正常远不到一秒。
 *
 * 取 60 秒不是为了卡性能，是为了把**永远不回来**和"这台机器慢"分开。
 */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * 给 `startRendering()` 加一道看门狗。**这不是防御式编程，是实测撞到的形态。**
 *
 * Safari 上导 30 分钟（180 段）时整个页面**死等**：主线程停在这个 promise 上、
 * Worker 停在等下一段上，**0% CPU、不抛错、不崩溃、进度条永远不动**。同一份代码
 * 在 Chrome 上四档全过。10 分钟（60 段）能过，所以是攒到一定段数之后 Safari 的
 * `OfflineAudioContext` 不再 resolve——显式 `close()` 只推迟了它，没有消除。
 *
 * 死等是所有失败形态里最坏的一种：用户既拿不到成品，也拿不到"为什么"，只能自己
 * 判断要等到什么时候。超时至少把它变成一条能读、能报、能查的错误（同硬规则 10
 * 那条"不静默降级"的精神）。**这不是修复**，真正的上限仍在，见 PLAN.md §8 风险 1。
 */
async function withRenderWatchdog(
  rendering: Promise<AudioBuffer>,
  segmentIndex: number,
): Promise<AudioBuffer> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      rendering,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `混音第 ${segmentIndex} 段渲染超过 ${RENDER_TIMEOUT_MS / 1000} 秒没有返回。` +
                `浏览器的音频上下文很可能已经不再工作（Safari 上导长片实测会这样），` +
                `请把导出范围缩短后重试。`,
            ),
          );
        }, RENDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 渲染完就把上下文还回去。**分段之后这一步是必需的，不是卫生习惯。**
 *
 * 分段意味着一次导出要建很多个 `OfflineAudioContext`（30 分钟按 10 秒切就是
 * 180 个），而 **Safari 对同时活着的 AudioContext 有硬上限**。靠 GC 回收赶不上
 * 建的速度：实测 Safari 上切 12 段时**第 9 段起渲染结果变成静音**（不抛错、
 * 不警告），切到更多段直接把页面卡死；Chrome 上同一份代码一路正常。
 *
 * `close()` 在规范里挂在 `AudioContext` 上、没有明确给 `OfflineAudioContext`，
 * 所以这里特性探测而不是直接调——拿不到就退回等 GC（那正是 Safari 会出问题的
 * 情形，但至少不多引入一个 TypeError）。
 */
function releaseContext(ctx: OfflineAudioContext): void {
  const closable = ctx as OfflineAudioContext & { close?: () => Promise<void> };
  if (typeof closable.close !== "function") return;
  // 不 await：`close()` 的 Promise 只表示"关完了"，而我们不依赖那个时刻；
  // 挂个 catch 免得某个浏览器上它 reject 成 unhandled rejection
  void closable.close().catch(() => undefined);
}

/**
 * 这个片段该接到哪儿：增益恒等就直接接总线，否则穿一个排好程的 `GainNode`。
 *
 * **恒等增益走原路径**，和合成层 `isDefaultGeometry` / `isDefaultColor` 完全同构
 * （CLAUDE.md 合成层约定）。这里也不是性能优化：多一级节点意味着多一次浮点乘法，
 * 而没有转场、也没调过音量的项目应该和加这些功能之前**逐样本一模一样**——否则
 * M0 自检里那条"成片与素材的第一声位置差"就会开始漂，而漂的原因和它们毫无关系。
 *
 * ## 两个增益来源合成一条链
 *
 * 淡化（`ramps`，交界处的形状）和音量（`volume`，整段的高低）是两个来源，但**只穿
 * 一个节点**：静态音量是个常数，把它乘进起始值和每条曲线的采样点上就是精确的
 * 合成，没有第二次浮点舍入。串两个 `GainNode` 也对，但那样"没调音量"的项目就
 * 多穿了一级恒等节点，上面那条逐样本一致的保证要靠"第二级也走快路径"来维持，
 * 判据从一个变成两个。
 *
 * **音量打了关键帧时仍然只穿一个节点**，因为排期那边已经把淡化 × 包络逐帧乘成了
 * 一条 `gainCurve`（理由见 `mix-plan.ts` 的 `AudioJob.gainCurve`）。这里的分支只是
 * "有合成曲线就只喂它"——同一段时间上喂两条 `setValueCurveAtTime` 会抛错，而
 * 那条曲线里已经含着淡化了，再喂一遍 `ramps` 等于把淡化乘两次。
 *
 * 两段包络可以直接顺序喂给同一个 `AudioParam`：D19 保证一个片段两侧的转场窗口
 * **永不重叠**（每个片段最多借出自己长度的一半），所以 `setValueCurveAtTime`
 * 不会撞上"曲线区间重叠"那个抛错。这条结构性保证在这里第二次收到回报。
 */
function envelopeInput(ctx: OfflineAudioContext, job: AudioJob): AudioNode {
  if (
    job.ramps.length === 0 &&
    job.baseGain === 1 &&
    job.volume === 1 &&
    job.gainCurve === undefined
  ) {
    return ctx.destination;
  }

  const gain = ctx.createGain();

  // 音量有包络时排期已经把淡化和音量乘成了一条曲线（见 `AudioJob.gainCurve`），
  // 这时**不能再喂 ramps**：同一段时间上两条 `setValueCurveAtTime` 会直接抛错，
  // 而且那条曲线里已经含着淡化了，再喂一遍等于乘两次
  const curve = job.gainCurve;
  if (curve) {
    gain.gain.setValueCurveAtTime(
      new Float32Array(curve.points),
      curve.startSeconds,
      curve.durationSeconds,
    );
    gain.connect(ctx.destination);
    return gain;
  }

  gain.gain.setValueAtTime(job.baseGain * job.volume, 0);
  for (const ramp of job.ramps) {
    const curve = crossfadeCurve(
      ramp.kind,
      ramp.role,
      ramp.fromProgress,
      ramp.toProgress,
      ramp.points,
    );
    // 音量为 1 时**一个采样点都不碰**，于是没调音量的项目里这条曲线与
    // 加音量之前逐位相同——`× 1` 在浮点上确实是恒等，但少走一遍循环
    // 也少一个"将来把这里改成别的算术"的机会
    if (job.volume !== 1) {
      for (let i = 0; i < curve.length; i++) curve[i]! *= job.volume;
    }
    gain.gain.setValueCurveAtTime(curve, ramp.startSeconds, ramp.durationSeconds);
  }
  gain.connect(ctx.destination);
  return gain;
}
