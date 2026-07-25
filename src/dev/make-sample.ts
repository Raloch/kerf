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
}

export interface GeneratedSample {
  readonly file: File;
  readonly fps: Rational;
  readonly frames: number;
  readonly hasAudio: boolean;
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
    // 每秒一声 1kHz 短提示音，导出后可听出音画是否对齐
    const sampleRate = 48_000;
    const totalSeconds = frameToSeconds(frames, fps);
    const length = Math.ceil(totalSeconds * sampleRate);
    const audioCtx = new OfflineAudioContext({ numberOfChannels: 1, sampleRate, length });
    const buffer = audioCtx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    for (let n = 0; n < length; n++) {
      const t = n / sampleRate;
      const inBeep = t % 1 < 0.08;
      data[n] = inBeep ? Math.sin(2 * Math.PI * 1000 * t) * 0.25 : 0;
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
