/**
 * 波形解码：唯一需要 mediabunny 的那一半。
 *
 * 单独成文件的理由见 [waveform.ts](./waveform.ts) 文件头（同缩略图那一对）。
 *
 * ## 顺序解一遍，不 seek
 *
 * `AudioSampleSink.samples()` 从头顺序读到尾，一次 seek 都不做。这不只是快慢问题
 * ——Safari 上重新 seek 之后解码器吐出来的头几百毫秒**不完全正确**（幅度差 5.7%
 * 并逐段放大，见 CLAUDE.md 导出层约定里 `ClipAudioCursor` 那条）。波形只是给人看的，
 * 幅度差几个百分点没人看得出来，但没有任何理由去踩同一块地基。
 *
 * ## 峰值在主线程上算，但不会卡界面
 *
 * 解码本身由 WebCodecs 在自己的线程上做，主线程只做"遍历 Float32Array 求最大值"
 * 这一件事，每秒音频约几万个样本、几十微秒。`for await` 在每个包上让出事件循环，
 * 所以哪怕 30 分钟的音轨也不会攒成一次长任务。
 */

import { ALL_FORMATS, AudioSampleSink, BlobSource, Input } from "mediabunny";
import { bucketCountFor, type Waveform } from "./waveform";

/**
 * 解出一条源片的峰值包络。没有音轨、解不开、或时长为 0 时返回 `null`。
 *
 * **多声道取各声道的绝对最大值**，不是平均：波形要回答"这里有多响"，而某个声道
 * 独有的一声在平均之后会被另一个声道的静音削掉一半。
 */
export async function extractWaveform(file: File): Promise<Waveform | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;

    const durationSeconds = await track.computeDuration();
    if (!(durationSeconds > 0)) return null;

    const buckets = bucketCountFor(durationSeconds);
    const secondsPerBucket = durationSeconds / buckets;
    const peaks = new Float32Array(buckets);

    const sink = new AudioSampleSink(track);
    let any = false;
    for await (const sample of sink.samples()) {
      any = true;
      // **一个包只转一次 AudioBuffer**：放在声道循环里就是每声道各建一份，
      // 立体声直接翻倍。时长与声道数都从 buffer 上读，同 `mixdown.ts` 的用法
      const buffer = sample.toAudioBuffer();
      const start = sample.timestamp;
      sample.close();

      const frames = buffer.length;
      const rate = buffer.sampleRate;
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
          const bucket = Math.floor((start + i / rate) / secondsPerBucket);
          if (bucket < 0 || bucket >= buckets) continue;
          const v = Math.abs(data[i]!);
          if (v > peaks[bucket]!) peaks[bucket] = v;
        }
      }
    }
    if (!any) return null;

    return { peaks, secondsPerBucket, durationSeconds };
  } catch {
    return null;
  } finally {
    // Input 不持有解码器，但持有读取位置；显式丢掉免得挂着 Blob 引用
    void input;
  }
}
