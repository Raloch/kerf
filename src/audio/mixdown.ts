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
 * 立体声 48kHz 下约 **23MB / 分钟**。
 *
 * 但**峰值不止这一份**，这是量过之后才看清的：
 *
 * 1. 所有素材的解码结果要**同时**挂在音频图上等渲染（`node.buffer`），
 *    它们按**源片自己的**采样率和声道数占内存，加起来可能比输出还大；
 * 2. `OfflineAudioContext` 的渲染目标是完整的另一份。
 *
 * 曾经还有第三份——把渲染结果拷出来再交给 Worker。那一份已经去掉了，
 * 见下面 `takeChannels`。
 *
 * 剩下的 1、2 只能靠**分段混流**（边混边喂编码器）削掉，那需要 Worker 反过来
 * 向主线程请求下一段，是一套请求／应答协议，留给 M3。在那之前一小时的项目
 * 峰值仍会到 2.8GB 上下，**炸的位置比"最终 PCM 1.4GB"这个数暗示的更早**。
 *
 * 这几项都接进了常驻量计量（`export/residency.ts` 的 `audioMixBytes`），
 * 所以上面这些不是估的，是能在导出面板上看到的数。
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import type { RenderRange, Timeline } from "../edl/types";
import { microsToSeconds, sourceMicrosAt } from "../edl/sampling";
import { residency } from "../export/residency";
import { frameToMicros } from "../time/timebase";

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
 * 混好的 PCM。`channels` 里每项是一个声道（f32-planar 的一个平面）。
 *
 * **这是一份"交出去就没了"的数据**：`channels` 通常直接就是渲染结果的后备存储
 * （见 `takeChannels`），transfer 进 Worker 之后主线程这边会变成零长数组。
 * 所以拿到它就该立刻 post 走，不要在 post 之后再读——`frameCount` 之类的标量
 * 都在这个对象上另存了一份，正是为了 post 之后还能报数。
 */
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
 * 返回 `copied` 供计量用：退回拷贝时峰值会高一份，那必须在导出面板上看得见，
 * 否则就成了"某个浏览器上悄悄多占 660MB"。
 */
function takeChannels(rendered: AudioBuffer): {
  readonly channels: Float32Array[];
  readonly copied: boolean;
} {
  const views: Float32Array[] = [];
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    views.push(rendered.getChannelData(ch));
  }
  if (channelsAreMovable(views)) return { channels: views, copied: false };
  return { channels: views.map((view) => new Float32Array(view)), copied: true };
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
  // 挂上音频图的解码结果在渲染完成前都不能释放，这里记着好在渲染后一次性还掉
  let scheduledBytes = 0;
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
    scheduledBytes += bufferBytes(pcm);
    residency.retainMixBytes(bufferBytes(pcm));
  }

  // 所有片段都解不出音频（编码不支持等）时不要产出一段静音轨，
  // 那会让用户以为"导出成功但没声音"是我们弄丢的
  if (scheduled === 0) {
    residency.releaseMixBytes(scheduledBytes);
    return null;
  }

  const rendered = await ctx.startRendering();
  const renderedBytes = bufferBytes(rendered);
  residency.retainMixBytes(renderedBytes);
  // 峰值就在这一刻（解码结果 + 渲染目标同时活着），采一下才看得到
  onProgress?.(1);

  const { channels, copied } = takeChannels(rendered);
  // 退回拷贝的浏览器上这里会再顶起一份，必须让它出现在计量里
  if (copied) residency.retainMixBytes(renderedBytes);
  onProgress?.(1);

  // **解码结果要到这里才销账，不是渲染一完成就销。** 它们还挂在
  // `AudioBufferSourceNode.buffer` 上，而那些节点由 `ctx` 引用着，`ctx` 活到函数返回。
  // 第一版在 startRendering() 之后就减掉了，于是峰值少报了整整一份——
  // 记账点必须贴着"最后一个引用消失"的地方写，不是贴着"逻辑上用完了"
  residency.releaseMixBytes(scheduledBytes + renderedBytes + (copied ? renderedBytes : 0));
  // 交出去之前这份 PCM 还在主线程手上，换个名目继续记着
  residency.setAudioPcmBytes(renderedBytes);

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
