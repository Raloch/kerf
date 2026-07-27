/**
 * 按输出帧号从一条视频轨上取帧。
 *
 * M1 的导出管道只认单个文件、单个 trim 区间。EDL 化之后一条轨上有多个片段、
 * 分别指向不同源片，取帧就成了一个有状态的顺序游标，这个类就是那些游标。
 *
 * ## 一条轨上可能同时有两个游标
 *
 * 转场窗口里出场和入场两个片段**同时出画**（见 `edl/transition.ts`），于是这一帧
 * 要从同一条轨上解出两帧。所以游标是一张 `clipId → cursor` 的表，而不是一个。
 * 两条推论：
 *
 * - **返回值按 clipId 索引，不是按轨**。装配图层时用 `visible.clip.id` 去取。
 * - **同源片的并发游标必须各自一份 `Input`**。Input 的 demuxer 有读取位置，
 *   两个游标共用一份会互相打乱拉包顺序——这正是"每条轨一份 Input"那条约定
 *   在轨内的翻版。所以 Input 改成**按源片分池借还**，池深天然被"一帧最多两层"
 *   限制在 2，不会随片段数增长。
 *
 * ## 几条不能违反的约定
 *
 * - **只能向前**。外层按输出帧号 0,1,2… 递增调用；倒着问会抛错而不是静默给错帧。
 *   顺序解码是硬规则 3 的前提，允许回退就等于允许 seek。
 * - **返回的 `VideoSample` 归 reader 所有，调用方不要 close**（硬规则 4）。
 *   时间轴帧率高于源片帧率时，同一个 sample 会被连续几个输出帧复用，
 *   谁都能关就必然出现 use-after-close。reader 在推进和 dispose 时统一关。
 * - **每个片段开一个新的 `samples()` 生成器**，不再需要时先 `.return()` 掉，
 *   否则解码器不释放，几个片段就把 WebCodecs 的解码器配额吃满。
 * - **解码区间要用 `clipRenderSpan()`**，不是片段占位。转场窗口跨过交界，
 *   出场片段要多解出点之后的一段、入场片段要多解入点之前的一段；按占位开区间
 *   的话那些帧解不出来，成片里转场的一侧是黑的（而预览是对的）。
 *
 * 片段起点几乎不会正好落在关键帧上，`VideoSampleSink.samples(start, end)`
 * 内部会回退到前一个关键帧解码再丢弃多余帧（硬规则 7），所以这里不需要
 * 自己处理 GOP 边界——但**必须**用 samples() 区间迭代，不能逐帧 getSample()。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { ClipId, MediaClip, RenderRange, Timeline, Track } from "../edl/types";
import { microsToSeconds, renderSourceMicros, trackClipsAt } from "../edl/sampling";
import { clipRenderSpan } from "../edl/transition";
import { FRAME_ALIGN_EPSILON_SECONDS, frameDurationMicros } from "../time/timebase";
import { residency } from "./residency";

/**
 * 解码帧的借出 / 归还都要记一笔。
 *
 * 记账点必须**贴着 close 写**，不能在外层"大概算一下每条轨两个"——那样算出来的
 * 是设计意图，不是实际持有量，而这个计量存在的意义恰恰是验证意图有没有被违反
 * （见 `residency.ts` 的文件头）。
 */
function retain(sample: VideoSample): VideoSample {
  residency.retainSample(sample.codedWidth, sample.codedHeight);
  return sample;
}

function release(sample: VideoSample | null): void {
  if (!sample) return;
  residency.releaseSample(sample.codedWidth, sample.codedHeight);
  sample.close();
}

interface ClipCursor {
  readonly clipId: ClipId;
  readonly sourceId: string;
  /** 借来的 Input，游标关掉时还回池里。 */
  readonly input: Input;
  readonly samples: AsyncGenerator<VideoSample, void, unknown>;
  /** 当前"覆盖该时刻"的帧，可能被多个输出帧复用。 */
  current: VideoSample | null;
  /** 预读的下一帧，用来判断 current 是否还该继续用。 */
  next: VideoSample | null;
  exhausted: boolean;
}

export class VideoTrackReader {
  /** 源片 → 空闲 Input 列表。借还制，见文件头。 */
  private readonly free = new Map<string, Input[]>();
  /** 开过的所有 Input，dispose 时统一销毁。 */
  private readonly all: Input[] = [];
  private readonly cursors = new Map<ClipId, ClipCursor>();
  private lastFrame = -1;

  constructor(
    private readonly timeline: Timeline,
    private readonly track: Track,
    private readonly range: RenderRange,
  ) {}

  /**
   * 取输出帧 `frame` 在本轨上要画的每一层画面，按 clipId 索引。
   *
   * 空档返回空表；转场窗口里返回两项。返回的 sample 归本对象所有，**不要 close**。
   */
  async samplesAt(frame: number): Promise<Map<ClipId, VideoSample>> {
    if (frame < this.lastFrame) {
      throw new Error(
        `取帧只能向前：轨 ${this.track.id} 已读到第 ${this.lastFrame} 帧，又被要求第 ${frame} 帧`,
      );
    }
    this.lastFrame = frame;

    // "这一帧要哪几个片段"只有 sampling.ts 一个答案，预览侧问的是同一个函数。
    // 文字片段没有源文件，它的画面由合成层现场生成，这里当空档跳过
    const wanted = trackClipsAt(this.track, frame).filter(
      (slice): slice is typeof slice & { clip: MediaClip } => slice.clip.kind === "media",
    );
    const wantedIds = new Set(wanted.map((slice) => slice.clip.id));

    // 不再需要的游标立刻关掉，让解码器和 Input 马上回到池里，而不是留着等下一次。
    // 空档轨也会走到这里——这正是"每帧都要问到每条轨"的意义（见 pipeline.ts）
    for (const id of [...this.cursors.keys()]) {
      if (!wantedIds.has(id)) await this.closeCursor(id);
    }

    const out = new Map<ClipId, VideoSample>();
    for (const slice of wanted) {
      const sample = await this.advance(slice.clip, frame, slice.transition !== undefined);
      if (sample) out.set(slice.clip.id, sample);
    }
    return out;
  }

  async dispose(): Promise<void> {
    for (const id of [...this.cursors.keys()]) await this.closeCursor(id);
    for (const input of this.all) {
      input.dispose();
      residency.closeInput();
    }
    this.all.length = 0;
    this.free.clear();
  }

  /** 把某个片段的游标推进到该帧，返回覆盖该时刻的帧。 */
  private async advance(
    clip: MediaClip,
    frame: number,
    inTransition: boolean,
  ): Promise<VideoSample | null> {
    let cursor = this.cursors.get(clip.id);
    if (!cursor) {
      cursor = (await this.openCursor(clip)) ?? undefined;
      if (!cursor) return null;
      this.cursors.set(clip.id, cursor);
    }

    const source = this.timeline.sources.find((s) => s.id === clip.sourceId);
    if (!source) return null;
    // 与装配图层时用的是**同一个函数**：转场窗口里越界的位置在这里也要夹住，
    // 两边夹法不同就会在转场里取到相邻的另一帧（见 sampling.ts 的注释）
    const targetSeconds = microsToSeconds(
      renderSourceMicros(clip, frame, this.timeline, source, inTransition),
    );

    if (!cursor.current && !cursor.exhausted) {
      const first = await cursor.samples.next();
      if (first.done) {
        cursor.exhausted = true;
      } else {
        cursor.current = retain(first.value);
      }
    }
    if (!cursor.current) return null;

    // 向前推进，直到 current 是"最后一个不晚于 target 的帧"。
    // 比较必须带容差：target 由帧号换算过整数微秒，而 sample.timestamp 是未取整
    // 的真值，直接比会把"恰好相等"判成"还没到"，末帧就少一帧（硬规则 1）。
    // target 被夹住不再前进时（余量不足的定格），这个循环自然停在最后一帧上
    for (;;) {
      if (!cursor.next && !cursor.exhausted) {
        const step = await cursor.samples.next();
        if (step.done) {
          cursor.exhausted = true;
        } else {
          cursor.next = retain(step.value);
        }
      }
      const next = cursor.next;
      if (next && next.timestamp <= targetSeconds + FRAME_ALIGN_EPSILON_SECONDS) {
        release(cursor.current);
        cursor.current = next;
        cursor.next = null;
        continue;
      }
      break;
    }

    return cursor.current;
  }

  private async openCursor(clip: MediaClip): Promise<ClipCursor | null> {
    const source = this.timeline.sources.find((s) => s.id === clip.sourceId);
    if (!source) return null;

    const input = this.borrowInput(source.id, source.file);
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      this.returnInput(source.id, input);
      return null;
    }

    // 只解这个片段真正露出来的那一段：片段可能被导出范围切掉头尾，
    // 也可能因为两侧的转场而**比自己的占位更长**（见 clipRenderSpan）
    const span = clipRenderSpan(this.track.clips, clip);
    const visibleIn = Math.max(span.firstFrame, this.range.inFrame);
    const visibleOut = Math.min(span.lastFrame, this.range.outFrame);
    // 越界的位置要夹回素材真实范围，否则 samples() 会拿到负的起点
    const startMicros = renderSourceMicros(clip, visibleIn, this.timeline, source, true);
    // 末端加一源片帧的余量：samples(start, end) 是半开区间，末帧起点恰好等于 end
    // 时那一帧不会被吐出来，成片就少最后一帧
    const endMicros =
      renderSourceMicros(clip, visibleOut, this.timeline, source, true) +
      frameDurationMicros(source.fps);

    const sink = new VideoSampleSink(videoTrack);
    residency.openCursor();
    return {
      clipId: clip.id,
      sourceId: source.id,
      input,
      samples: sink.samples(microsToSeconds(startMicros), microsToSeconds(endMicros)),
      current: null,
      next: null,
      exhausted: false,
    };
  }

  private async closeCursor(clipId: ClipId): Promise<void> {
    const cursor = this.cursors.get(clipId);
    if (!cursor) return;
    this.cursors.delete(clipId);
    release(cursor.current);
    release(cursor.next);
    // 让生成器走完 finally，释放它内部的 VideoDecoder
    await cursor.samples.return?.(undefined);
    residency.closeCursor();
    this.returnInput(cursor.sourceId, cursor.input);
  }

  /**
   * 借一份 Input。池里有空闲的就复用，否则新开一份。
   *
   * 复用而不是每个片段一份：一条轨上几十个片段常常来自同一个源文件，
   * 每个都开一份就是几十个 demuxer 同时活着。池深由"一帧最多两层"限住。
   */
  private borrowInput(sourceId: string, file: File): Input {
    const pool = this.free.get(sourceId);
    const reused = pool?.pop();
    if (reused) return reused;

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    this.all.push(input);
    residency.openInput();
    return input;
  }

  private returnInput(sourceId: string, input: Input): void {
    const pool = this.free.get(sourceId);
    if (pool) pool.push(input);
    else this.free.set(sourceId, [input]);
  }
}
