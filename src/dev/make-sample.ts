/**
 * 生成测试素材。
 *
 * M0 需要一个可重复的验证闭环，但仓库里不放视频文件（见 .gitignore）。
 * 这里用 mediabunny 合成一段带时间码水印和 1kHz 提示音的片子，
 * 于是"生成 → 导入 → trim → 导出 → 检查帧数/时长"整条链路可以自验证，
 * 而且每帧画面上有帧号，导出后能肉眼确认 trim 的起止帧对不对。
 */

import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import { framesToTimecode, frameToSeconds, frameDurationMicros, MICROS_PER_SECOND } from "../time/timebase";
import { FPS, type Rational } from "../time/rational";

export interface SampleOptions {
  readonly width?: number;
  readonly height?: number;
  readonly fps?: Rational;
  readonly durationFrames?: number;
  readonly withAudio?: boolean;
  /**
   * 音频长什么样。
   *
   * - `beeps`（缺省）：每秒一声 1kHz 短提示音，其余静音。**M0 自检第 17 项**
   *   （成片与素材的第一声位置差）靠的就是这个稀疏的起始沿，不要动它。
   * - `tone`：全程等幅 1kHz 连续音。量**增益包络**只能用它——稀疏提示音在
   *   半秒的淡化窗口里可能一声都没有，那时 RMS 全是 0，断言测的是运气。
   */
  readonly audioShape?: "beeps" | "tone";
}

export interface GeneratedSample {
  readonly file: File;
  readonly fps: Rational;
  readonly frames: number;
  readonly hasAudio: boolean;
}

export interface AudioSampleOptions {
  readonly seconds?: number;
  readonly sampleRate?: number;
  /** 声道数。默认 2——配乐通常是立体声，而混流要把它下混到输出声道数。 */
  readonly channels?: number;
  /**
   * 波形。语义与 `SampleOptions.audioShape` 相同。
   *
   * 判"取到了源片哪一刻"**只能用 `beeps`**：`tone` 全程都在响，从哪里取样听起来
   * 都一样，于是"裁过入点的片段取错了内容"这种错在连续音上完全测不出来。
   */
  readonly shape?: "tone" | "beeps";
}

export interface GeneratedAudioSample {
  readonly file: File;
  readonly seconds: number;
  readonly sampleRate: number;
  readonly channels: number;
}

/**
 * 生成一个**只有音轨**的素材（配乐 / 旁白）。
 *
 * 单独一个函数而不是给 `makeSampleVideo` 加个 `withVideo:false`：那样"生成的东西
 * 到底有没有画面"就成了参数的函数，而返回类型说不出来，调用方得自己记着。
 *
 * 全程等幅 1kHz 连续音，幅度与 `audioShape:"tone"` 相同（0.25），于是两种素材量到的
 * RMS 可以直接互相当参照。**起点是精确的静音 → 有声沿**（前 20ms 静音），
 * 自检靠它判"配乐被放到了第几帧"，见 `firstOnsetAfter`。
 */
export async function makeSampleAudio(
  options: AudioSampleOptions = {},
): Promise<GeneratedAudioSample> {
  const seconds = options.seconds ?? 2;
  const sampleRate = options.sampleRate ?? 44_100;
  const channels = options.channels ?? 2;

  const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"]);
  if (!audioCodec) throw new Error("本机没有可用的音频编码器，无法生成纯音频素材");

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128e3 });
  output.addAudioTrack(audioSource);
  await output.start();

  const length = Math.ceil(seconds * sampleRate);
  const audioCtx = new OfflineAudioContext({ numberOfChannels: channels, sampleRate, length });
  const buffer = audioCtx.createBuffer(channels, length, sampleRate);
  // 前 20ms 留静音：起始沿要是**素材自己的**，而不是"文件第一个样本"——
  // 后者会被编码器的 priming 爬升糊掉，量出来的位置偏早且偏移量不稳
  const leadSamples = Math.round(0.02 * sampleRate);
  const shape = options.shape ?? "tone";
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let n = leadSamples; n < length; n++) {
      const t = n / sampleRate;
      const on = shape === "tone" || t % 1 < 0.08;
      data[n] = on ? Math.sin(2 * Math.PI * 1000 * t) * 0.25 : 0;
    }
  }
  await audioSource.add(buffer);

  audioSource.close();
  const mimeType = await output.getMimeType();
  await output.finalize();

  const bytes = (output.target as BufferTarget).buffer;
  if (!bytes) throw new Error("纯音频素材生成失败：没有输出数据");

  const file = new File([new Uint8Array(bytes)], `kerf-music-${seconds}s.mp4`, { type: mimeType });
  return { file, seconds, sampleRate, channels };
}

export async function makeSampleVideo(options: SampleOptions = {}): Promise<GeneratedSample> {
  const width = options.width ?? 640;
  const height = options.height ?? 360;
  const fps = options.fps ?? FPS.ndf2997;
  const frames = options.durationFrames ?? 300; // 约 10 秒
  const wantAudio = options.withAudio ?? true;

  const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height });
  if (!videoCodec) throw new Error("本机没有可用的视频编码器，无法生成测试素材");
  const audioCodec = wantAudio
    ? await getFirstEncodableAudioCodec(["aac", "opus"])
    : null;

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("拿不到 2D 上下文");

  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const videoSource = new CanvasSource(canvas, { codec: videoCodec, bitrate: 2e6 });
  output.addVideoTrack(videoSource, { frameRate: fps.num / fps.den });

  let audioSource: AudioBufferSource | null = null;
  if (audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 128e3 });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const frameDurationSeconds = frameDurationMicros(fps) / MICROS_PER_SECOND;

  for (let i = 0; i < frames; i++) {
    // 背景色随帧号渐变，方便肉眼判断导出的起止位置
    const hue = Math.round((i / frames) * 300);
    ctx.fillStyle = `hsl(${hue} 55% 22%)`;
    ctx.fillRect(0, 0, width, height);

    // 每秒一条竖线扫过，用来核对时间轴
    const sweepX = ((i % Math.round(fps.num / fps.den)) / (fps.num / fps.den)) * width;
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fillRect(sweepX, 0, 3, height);

    ctx.fillStyle = "#fff";
    ctx.font = `600 ${Math.round(height / 8)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(framesToTimecode(i, fps), width / 2, height / 2 - height / 10);
    ctx.font = `400 ${Math.round(height / 14)}px monospace`;
    ctx.fillText(`frame ${i}`, width / 2, height / 2 + height / 8);

    await videoSource.add(frameToSeconds(i, fps), frameDurationSeconds, i === 0 ? { keyFrame: true } : undefined);
  }

  if (audioSource) {
    const shape = options.audioShape ?? "beeps";
    const sampleRate = 48_000;
    const totalSeconds = frameToSeconds(frames, fps);
    const length = Math.ceil(totalSeconds * sampleRate);
    const audioCtx = new OfflineAudioContext({ numberOfChannels: 1, sampleRate, length });
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let n = 0; n < length; n++) {
      const t = n / sampleRate;
      // beeps：每秒一声 1kHz 短提示音，导出后可听出音画是否对齐
      const on = shape === "tone" || t % 1 < 0.08;
      data[n] = on ? Math.sin(2 * Math.PI * 1000 * t) * 0.25 : 0;
    }
    await audioSource.add(buffer);
  }

  videoSource.close();
  audioSource?.close();
  const mimeType = await output.getMimeType();
  await output.finalize();

  const bytes = (output.target as BufferTarget).buffer;
  if (!bytes) throw new Error("测试素材生成失败：没有输出数据");

  const file = new File([new Uint8Array(bytes)], `kerf-sample-${frames}f.mp4`, { type: mimeType });
  return { file, fps, frames, hasAudio: audioSource !== null };
}
