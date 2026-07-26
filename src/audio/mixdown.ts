/**
 * 多轨音频混流。**必须在主线程跑**。
 *
 * `OfflineAudioContext` 在 Worker 里不可用（硬规则 6 已经写明），所以导出的音频
 * 不能像视频那样整条留在 Worker 内：这里把整个导出区间混成一段 PCM，
 * 再 transfer 进 Worker 交给编码器。
 *
 * ## 为什么用 OfflineAudioContext 而不是自己加加减减
 *
 * 混音本身只是相加，难的是**重采样**：素材可能是 44.1k、48k 混着来，
 * 单声道和立体声混着来，而输出只有一个采样率和声道数。自己写重采样等于
 * 重新实现一遍 Web Audio 已经做对的事情（而且很容易在边界产生咔哒声）。
 * 把每个片段挂成 `AudioBufferSourceNode` 并 `start(时间轴位置)`，
 * 采样率转换、声道上混、叠加全由音频图完成。
 *
 * ## 已知的内存边界
 *
 * 整个区间一次性混完，结果是 `声道数 × 帧数 × 4` 字节的 PCM：
 * 立体声 48kHz 下约 **23MB / 分钟**。10 分钟的项目约 230MB，能跑；
 * 一小时的项目会到 1.4GB，会炸。分段混流 + 边混边喂编码器才是终解，
 * 但那需要 Worker 反过来向主线程请求下一段，是一套请求／应答协议。
 * 留给 M3 的「长视频内存压力测试」一起做，这里先把边界写明。
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import type { RenderRange, Timeline } from "../edl/types";
import { microsToSeconds, sourceMicrosAt } from "../edl/sampling";
import { frameToMicros } from "../time/timebase";

/**
 * 混流输出采样率。
 *
 * 固定 48kHz 而不是跟随素材：AAC 和 Opus 都以 48k 为原生档位，
 * 跟随 44.1k 素材反而会在编码器里再重采样一次。
 */
export const MIX_SAMPLE_RATE = 48_000;
/** 混流输出声道数。M2 做环绕声之前固定立体声。 */
export const MIX_CHANNELS = 2;

/** 混好的 PCM。`channels` 里每项是一个声道（f32-planar 的一个平面）。 */
export interface MixedAudio {
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly frameCount: number;
  readonly channels: readonly Float32Array[];
}

/** 把 MixedAudio 里所有 PCM 的 ArrayBuffer 收集出来，用于 postMessage 的 transfer 列表。 */
export function mixedAudioTransferables(mixed: MixedAudio): Transferable[] {
  return mixed.channels.map((channel) => channel.buffer as ArrayBuffer);
}

/**
 * 把导出区间内所有未静音音频轨混成一段 PCM。没有可用音频时返回 null。
 *
 * @param onProgress 0–1，按片段数推进（解码是耗时项，混音本身很快）
 */
export async function mixdown(
  timeline: Timeline,
  range: RenderRange,
  onProgress?: (ratio: number) => void,
): Promise<MixedAudio | null> {
  const totalFrames = range.outFrame - range.inFrame;
  if (totalFrames <= 0) return null;

  // 收集所有与导出区间相交的音频片段
  const jobs: {
    readonly whenSeconds: number;
    readonly file: File;
    readonly srcStartSeconds: number;
    readonly srcEndSeconds: number;
  }[] = [];

  for (const track of timeline.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of track.clips) {
      // 文字片段没有声音——落到音频轨上是类型允许但 UI 造不出来的组合
      if (clip.kind !== "media") continue;
      const visibleIn = Math.max(clip.timelineIn, range.inFrame);
      const visibleOut = Math.min(clip.timelineOut, range.outFrame);
      if (visibleOut <= visibleIn) continue;
      const source = timeline.sources.find((s) => s.id === clip.sourceId);
      if (!source || !source.hasAudio) continue;

      jobs.push({
        whenSeconds: microsToSeconds(frameToMicros(visibleIn - range.inFrame, timeline.fps)),
        file: source.file,
        srcStartSeconds: microsToSeconds(
          sourceMicrosAt(clip, visibleIn, timeline.fps, source.fps),
        ),
        srcEndSeconds: microsToSeconds(
          sourceMicrosAt(clip, visibleOut, timeline.fps, source.fps),
        ),
      });
    }
  }

  if (jobs.length === 0) return null;

  const totalSeconds = microsToSeconds(frameToMicros(totalFrames, timeline.fps));
  const frameCount = Math.max(1, Math.round(totalSeconds * MIX_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(MIX_CHANNELS, frameCount, MIX_SAMPLE_RATE);

  let decoded = 0;
  let scheduled = 0;
  for (const job of jobs) {
    const pcm = await decodeRange(job.file, job.srcStartSeconds, job.srcEndSeconds);
    decoded++;
    onProgress?.(decoded / jobs.length);
    if (!pcm) continue;

    const node = ctx.createBufferSource();
    node.buffer = pcm;
    node.connect(ctx.destination);
    // 采样率不同由音频图重采样，单声道由音频图上混到立体声——都不用我们插手
    node.start(job.whenSeconds);
    scheduled++;
  }

  // 所有片段都解不出音频（编码不支持等）时不要产出一段静音轨，
  // 那会让用户以为"导出成功但没声音"是我们弄丢的
  if (scheduled === 0) return null;

  const rendered = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    // 复制一份：getChannelData 返回的数组由 AudioBuffer 持有，
    // 直接 transfer 会把它 detach，rendered 自己就坏了
    channels.push(new Float32Array(rendered.getChannelData(ch)));
  }

  return {
    sampleRate: rendered.sampleRate,
    numberOfChannels: rendered.numberOfChannels,
    frameCount: rendered.length,
    channels,
  };
}

/**
 * 解出某文件 [start, end) 区间的音频，按源片自身的采样率和声道数返回。
 *
 * 按 `sample.timestamp` 把每个解码块写到正确的偏移上，而不是顺序追加：
 * 音频包边界几乎不会正好落在区间端点上，顺序追加会让整段音频整体前移几毫秒，
 * 多个片段各偏一点，最终表现为音画不同步。
 */
async function decodeRange(
  file: File,
  startSeconds: number,
  endSeconds: number,
): Promise<AudioBuffer | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;

    const rate = await track.getSampleRate();
    const channelCount = await track.getNumberOfChannels();
    const frameCount = Math.max(1, Math.round((endSeconds - startSeconds) * rate));
    const out = new AudioBuffer({
      length: frameCount,
      numberOfChannels: channelCount,
      sampleRate: rate,
    });

    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(startSeconds, endSeconds)) {
      try {
        const buffer = sample.toAudioBuffer();
        let dstOffset = Math.round((sample.timestamp - startSeconds) * rate);
        let srcOffset = 0;
        let length = buffer.length;

        // 首个包通常在区间起点之前就开始了，要砍掉伸出去的那一截
        if (dstOffset < 0) {
          srcOffset = -dstOffset;
          length -= srcOffset;
          dstOffset = 0;
        }
        // 末个包通常越过区间终点
        length = Math.min(length, frameCount - dstOffset);
        if (length <= 0) continue;

        const usable = Math.min(channelCount, buffer.numberOfChannels);
        for (let ch = 0; ch < usable; ch++) {
          const src = buffer.getChannelData(ch).subarray(srcOffset, srcOffset + length);
          out.copyToChannel(src, ch, dstOffset);
        }
      } finally {
        sample.close();
      }
    }

    return out;
  } catch {
    // 单个素材解不出音频不该让整次导出失败，静默跳过并让上层继续
    return null;
  } finally {
    input.dispose();
  }
}
