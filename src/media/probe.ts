/**
 * 素材探针：读元信息并建立 MediaSource。
 *
 * 帧率必须走"探测平均包速率 → 吸附成有理数"这条路：容器里的元数据帧率
 * 常常不可靠或缺失，而 computePacketStats() 给出的是浮点平均值，
 * 直接拿浮点值做帧运算就回到了浮点误差的老问题（CLAUDE.md 硬规则 1）。
 */

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { snapToKnownFps, type Rational, toNumber } from "../time/rational";
import type { MediaSource } from "../edl/types";

export interface ProbeResult {
  readonly source: MediaSource;
  /** 探测到的原始平均帧率，用于在 UI 上提示"已吸附"。 */
  readonly rawFps: number;
  /** 视频轨时长（秒），时间轴长度以此为准。 */
  readonly durationSeconds: number;
  /** 容器总时长（秒）。通常略长于视频轨，差值来自音频编码的 padding。 */
  readonly containerSeconds: number;
}

let sourceSeq = 0;

export async function probeFile(file: File): Promise<ProbeResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error("这个文件里没有视频轨，M0 只处理带视频的素材");
    if (!(await videoTrack.canDecode())) {
      const codec = await videoTrack.getCodec();
      throw new Error(`本机无法解码该视频编码：${codec ?? "未知"}`);
    }

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioDecodable = audioTrack ? await audioTrack.canDecode() : false;

    const [width, height, videoSeconds, containerSeconds, stats, videoCodec] = await Promise.all([
      videoTrack.getDisplayWidth(),
      videoTrack.getDisplayHeight(),
      // 关键：用**视频轨**时长，不能用容器总时长。
      // AAC 编码器会在音轨头尾加 priming/padding，音轨通常比视频轨长几帧，
      // 用 input.computeDuration() 会多算出末尾几帧空档（实测 300 帧素材会被算成 303 帧）。
      videoTrack.computeDuration(),
      input.computeDuration(),
      // 只采样前若干包推断帧率，避免为了拿帧率把整个文件读一遍
      videoTrack.computePacketStats(120),
      videoTrack.getCodec(),
    ]);

    const rawFps = stats.averagePacketRate;
    const fps: Rational = snapToKnownFps(rawFps);

    const source: MediaSource = {
      id: `src-${++sourceSeq}`,
      name: file.name,
      file,
      fps,
      width,
      height,
      // 视频轨时长 ≈ 帧数/帧率，所以用 round 而不是 ceil——ceil 会凭空多出一帧。
      // 想要绝对精确的帧数需要全量 computePacketStats()（packetCount 就是帧数），
      // 但那要扫完整个文件的包索引；M1 生成代理文件时顺带做，M0 不值得为此变慢。
      durationFrames: Math.max(1, Math.round((videoSeconds * fps.num) / fps.den)),
      hasAudio: audioDecodable,
      videoCodec,
      audioCodec: audioTrack ? await audioTrack.getCodec() : null,
    };

    return { source, rawFps, durationSeconds: videoSeconds, containerSeconds };
  } finally {
    // 探测用的 Input 用完即弃；导出时会重新打开自己的 Input
    input.dispose();
  }
}

/** 帧率是否被吸附过（原始值与有理数值不完全相等）。 */
export function wasFpsSnapped(result: ProbeResult): boolean {
  return Math.abs(toNumber(result.source.fps) - result.rawFps) > 1e-9;
}
