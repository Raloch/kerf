/**
 * 按输出帧号从一条视频轨上取帧。
 *
 * M1 的导出管道只认单个文件、单个 trim 区间。EDL 化之后一条轨上有多个片段、
 * 分别指向不同源片，取帧就成了一个有状态的顺序游标，这个类就是那个游标。
 *
 * ## 几条不能违反的约定
 *
 * - **只能向前**。外层按输出帧号 0,1,2… 递增调用；倒着问会抛错而不是静默给错帧。
 *   顺序解码是硬规则 3 的前提，允许回退就等于允许 seek。
 * - **返回的 `VideoSample` 归 reader 所有，调用方不要 close**（硬规则 4）。
 *   时间轴帧率高于源片帧率时，同一个 sample 会被连续几个输出帧复用，
 *   谁都能关就必然出现 use-after-close。reader 在推进和 dispose 时统一关。
 * - **每个片段开一个新的 `samples()` 生成器**，切片段时先 `.return()` 掉旧的，
 *   否则解码器不释放，几个片段就把 WebCodecs 的解码器配额吃满。
 * - **每条轨自己一份 `Input`**，哪怕两条轨用同一个源文件。Input 内部的 demuxer
 *   是有读取位置的，两条轨交错拉包会互相打乱对方的顺序。多解析一次文件头很便宜。
 *
 * 片段起点几乎不会正好落在关键帧上，`VideoSampleSink.samples(start, end)`
 * 内部会回退到前一个关键帧解码再丢弃多余帧（硬规则 7），所以这里不需要
 * 自己处理 GOP 边界——但**必须**用 samples() 区间迭代，不能逐帧 getSample()。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type VideoSample } from "mediabunny";
import type { MediaClip, RenderRange, Timeline, Track } from "../edl/types";
import { microsToSeconds, sourceMicrosAt } from "../edl/sampling";
import { FRAME_ALIGN_EPSILON_SECONDS, frameDurationMicros } from "../time/timebase";

interface ClipCursor {
  readonly clipId: string;
  readonly samples: AsyncGenerator<VideoSample, void, unknown>;
  /** 当前"覆盖该时刻"的帧，可能被多个输出帧复用。 */
  current: VideoSample | null;
  /** 预读的下一帧，用来判断 current 是否还该继续用。 */
  next: VideoSample | null;
  exhausted: boolean;
}

export class VideoTrackReader {
  private readonly inputs = new Map<string, Input>();
  private cursor: ClipCursor | null = null;
  private lastFrame = -1;

  constructor(
    private readonly timeline: Timeline,
    private readonly track: Track,
    private readonly range: RenderRange,
  ) {}

  /**
   * 取输出帧 `frame` 在本轨上的画面。空档（该帧没有片段）返回 null。
   *
   * 返回值归本对象所有，**不要 close**。
   */
  async sampleAt(frame: number): Promise<VideoSample | null> {
    if (frame < this.lastFrame) {
      throw new Error(
        `取帧只能向前：轨 ${this.track.id} 已读到第 ${this.lastFrame} 帧，又被要求第 ${frame} 帧`,
      );
    }
    this.lastFrame = frame;

    const clip = clipCovering(this.track, frame);
    if (!clip) {
      // 空档：关掉游标，让解码器立刻释放，而不是留着等下一个片段
      await this.closeCursor();
      return null;
    }

    if (this.cursor?.clipId !== clip.id) {
      await this.closeCursor();
      this.cursor = await this.openCursor(clip);
    }
    const cursor = this.cursor;
    if (!cursor) return null;

    const source = this.timeline.sources.find((s) => s.id === clip.sourceId);
    if (!source) return null;
    const targetSeconds = microsToSeconds(
      sourceMicrosAt(clip, frame, this.timeline.fps, source.fps),
    );

    if (!cursor.current && !cursor.exhausted) {
      const first = await cursor.samples.next();
      if (first.done) {
        cursor.exhausted = true;
      } else {
        cursor.current = first.value;
      }
    }
    if (!cursor.current) return null;

    // 向前推进，直到 current 是"最后一个不晚于 target 的帧"。
    // 比较必须带容差：target 由帧号换算过整数微秒，而 sample.timestamp 是未取整
    // 的真值，直接比会把"恰好相等"判成"还没到"，末帧就少一帧（硬规则 1）。
    for (;;) {
      if (!cursor.next && !cursor.exhausted) {
        const step = await cursor.samples.next();
        if (step.done) {
          cursor.exhausted = true;
        } else {
          cursor.next = step.value;
        }
      }
      const next = cursor.next;
      if (next && next.timestamp <= targetSeconds + FRAME_ALIGN_EPSILON_SECONDS) {
        cursor.current?.close();
        cursor.current = next;
        cursor.next = null;
        continue;
      }
      break;
    }

    return cursor.current;
  }

  async dispose(): Promise<void> {
    await this.closeCursor();
    for (const input of this.inputs.values()) input.dispose();
    this.inputs.clear();
  }

  private async openCursor(clip: MediaClip): Promise<ClipCursor | null> {
    const source = this.timeline.sources.find((s) => s.id === clip.sourceId);
    if (!source) return null;

    let input = this.inputs.get(source.id);
    if (!input) {
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source.file) });
      this.inputs.set(source.id, input);
    }
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;

    // 只解这个片段真正露出来的那一段：片段可能被导出范围切掉头尾
    const visibleIn = Math.max(clip.timelineIn, this.range.inFrame);
    const visibleOut = Math.min(clip.timelineOut, this.range.outFrame);
    const startMicros = sourceMicrosAt(clip, visibleIn, this.timeline.fps, source.fps);
    // 末端加一源片帧的余量：samples(start, end) 是半开区间，末帧起点恰好等于 end
    // 时那一帧不会被吐出来，成片就少最后一帧
    const endMicros =
      sourceMicrosAt(clip, visibleOut, this.timeline.fps, source.fps) +
      frameDurationMicros(source.fps);

    const sink = new VideoSampleSink(videoTrack);
    return {
      clipId: clip.id,
      samples: sink.samples(microsToSeconds(startMicros), microsToSeconds(endMicros)),
      current: null,
      next: null,
      exhausted: false,
    };
  }

  private async closeCursor(): Promise<void> {
    const cursor = this.cursor;
    if (!cursor) return;
    this.cursor = null;
    cursor.current?.close();
    cursor.next?.close();
    // 让生成器走完 finally，释放它内部的 VideoDecoder
    await cursor.samples.return?.(undefined);
  }
}

/**
 * 该轨在该帧的**素材**片段。与 `clipAt` 同义，但只在导出路径用，保留独立以便加断言。
 *
 * 文字片段在这里当空档处理：这个类只负责"从源文件顺序解码"，文字层没有源文件。
 * 它的画面由合成层现场生成，取哪些文字层是 `visibleVideoClips` 的职责。
 */
function clipCovering(track: Track, frame: number): MediaClip | null {
  for (const clip of track.clips) {
    if (clip.kind !== "media") continue;
    if (frame >= clip.timelineIn && frame < clip.timelineOut) return clip;
  }
  return null;
}
