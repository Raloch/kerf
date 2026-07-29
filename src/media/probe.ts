/**
 * 素材探针：读元信息并建立 MediaSource。
 *
 * 帧率必须走"探测平均包速率 → 吸附成有理数"这条路：容器里的元数据帧率
 * 常常不可靠或缺失，而 computePacketStats() 给出的是浮点平均值，
 * 直接拿浮点值做帧运算就回到了浮点误差的老问题（CLAUDE.md 硬规则 1）。
 *
 * ## 两种素材
 *
 * 有视频轨就是 `AvSource`，没有则退一步找音轨，成了就是 `AudioOnlySource`
 * （配乐、旁白）。**不是"没有视频轨就报错"**——那样音乐文件就永远进不来，
 * 而混流、波形、音量包络、交叉淡化早就都能用了，缺的只有入口。
 *
 * 两条路都要求对应的轨道**解得动**：解不动的素材进了 EDL 只会在导出时才炸，
 * 而那时用户已经剪完了。
 */

import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { snapToKnownFps, type Rational, toNumber } from "../time/rational";
import type { AudioOnlySource, AvSource, MediaSource } from "../edl/types";
import { newSourceId } from "./source-id";

export interface ProbeResult {
  readonly source: MediaSource;
  /** 探测到的原始平均帧率，用于在 UI 上提示"已吸附"。纯音频素材没有帧率，为 null。 */
  readonly rawFps: number | null;
  /** 主轨时长（秒），时间轴长度以此为准。 */
  readonly durationSeconds: number;
  /** 容器总时长（秒）。通常略长于视频轨，差值来自音频编码的 padding。 */
  readonly containerSeconds: number;
}

export async function probeFile(file: File): Promise<ProbeResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!videoTrack) return await probeAudioOnly(input, file, audioTrack);

    if (!(await videoTrack.canDecode())) {
      const codec = await videoTrack.getCodec();
      throw new Error(`本机无法解码该视频编码：${codec ?? "未知"}`);
    }

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

    const source: AvSource = {
      id: newSourceId(),
      kind: "av",
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

/**
 * 纯音频素材。
 *
 * 时长用**音轨**时长而不是 `input.computeDuration()`：理由和硬规则 8 那条同源，
 * 只是方向相反——这里音轨就是主轨，容器时长在纯音频文件上通常相等，但没必要
 * 依赖"通常"。
 *
 * **这个时长必然含编码器的 priming / padding**（AAC 实测约 48ms + 尾部补齐），
 * 所以一段 2.000 秒的 mp3 进来会是 2.069 秒、片段尾部多出几十毫秒静音。硬规则 8
 * 在带画面的素材上靠"用视频轨时长"绕开了这件事，而纯音频素材**没有第二条轨可以
 * 拿来校准**，只能接受。宁可多几十毫秒静音也不能少：截短会把素材真实的尾音剪掉，
 * 而那是听得出来的。
 */
async function probeAudioOnly(
  input: Input,
  file: File,
  audioTrack: Awaited<ReturnType<Input["getPrimaryAudioTrack"]>>,
): Promise<ProbeResult> {
  if (!audioTrack) {
    throw new Error("这个文件里既没有视频轨也没有音轨，认不出是什么素材");
  }
  if (!(await audioTrack.canDecode())) {
    const codec = await audioTrack.getCodec();
    throw new Error(`本机无法解码该音频编码：${codec ?? "未知"}`);
  }

  const [audioSeconds, containerSeconds, audioCodec] = await Promise.all([
    audioTrack.computeDuration(),
    input.computeDuration(),
    audioTrack.getCodec(),
  ]);

  const source: AudioOnlySource = {
    id: newSourceId(),
    kind: "audio",
    name: file.name,
    file,
    hasAudio: true,
    audioCodec,
    // 秒 → 微秒只在这一步取整（硬规则 1 允许微秒时间戳）；帧数是派生的，
    // 见 `sourceDurationFrames()`
    durationMicros: Math.max(1, Math.round(audioSeconds * 1_000_000)),
    sampleRate: audioTrack.sampleRate,
    channels: audioTrack.numberOfChannels,
  };

  return { source, rawFps: null, durationSeconds: audioSeconds, containerSeconds };
}

/** 带画面素材的探测结果，`source` 已经收窄。 */
export interface AvProbeResult extends ProbeResult {
  readonly source: AvSource;
  readonly rawFps: number;
}

/**
 * 探测一个**必须带画面**的素材，是纯音频文件就抛。
 *
 * 给自检和代理转码用：它们从生成的素材出发，"没有画面"是不可能的输入而不是一种
 * 情况。让它们自己写 `if (source.kind !== "av") throw` 就是把同一句话抄十遍，
 * 而抄漏一处的表现是 `undefined` 一路流到解码器。
 */
export async function probeAvFile(file: File): Promise<AvProbeResult> {
  const result = await probeFile(file);
  if (result.source.kind !== "av" || result.rawFps === null) {
    throw new Error(`${file.name} 里没有视频轨，这条路径要的是带画面的素材`);
  }
  return { ...result, source: result.source, rawFps: result.rawFps };
}

/** 帧率是否被吸附过（原始值与有理数值不完全相等）。 */
export function wasFpsSnapped(result: ProbeResult): boolean {
  if (result.rawFps === null || result.source.kind !== "av") return false;
  return Math.abs(toNumber(result.source.fps) - result.rawFps) > 1e-9;
}
