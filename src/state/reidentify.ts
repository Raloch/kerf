/**
 * 离线素材的指认（D37 第 2 刀）。**纯函数：不碰 IndexedDB，也不碰 mediabunny。**
 *
 * 打开项目时读不动的素材（文件被移走 / 改名 / 改过内容）停在指认页，让用户重新指
 * 一份文件。**离线状态只存在于"打开项目"这一刻，永不进 EDL**——看着更自然的做法是
 * 给 `MediaSource` 加一个 `offline` 分支、片段留着渲染成占位，那要动合成层、导出层、
 * reader、波形、代理五处，每一处都要回答"这一层没有画面怎么办"，而 `resolveSource()`
 * 找不到就抛正是 D23 立起来的护栏。拦在打开这一刻，下游一行都不用改。
 *
 * ## 按 `sourceId` 配对，不按顺序
 *
 * 指认结果一律以 `sourceId` 为键。列表可以排序、可以过滤，**顺序不是身份**——按下标
 * 配对的写法在用户先指第二个再指第一个时就把 X 的文件配给了 Y，而那表现为"画面全错"
 * 且不报错（D37 列的第三个失败形态）。`withReplacedSources` 是这条的落点：它遍历
 * 快照里的 `sources` 并**按 id 查表**，所以传进来的顺序对结果没有任何影响。
 *
 * ## 种类不同是拒绝，尺寸 / 帧率 / 时长不同只是警告
 *
 * "也许他真的换了一版素材"只对**同一种**素材成立：换个分辨率重导一遍很常见。
 * 而拿一个 MP3 去指认一个视频素材是**指错了文件**，不是换了一版——那会让画面轨上的
 * 片段引用一个没有 `fps` / `width` 的素材（`AvSource` 那道类型收窄在运行时被破坏），
 * 表现是代理去转一个没有视频轨的文件、合成器拿到 0×0 的图层。所以种类必须一致。
 *
 * ## 指认到的文件，元数据要跟着换（`id` 不变）
 *
 * 快照里的 `SourceMeta` 记的是**上一个文件**的帧率 / 尺寸 / 时长。只换 `file` 不换
 * 元数据的话，那份记录就成了一个陈旧的第二真值来源，而它错起来是静默的：
 * `sourceGridFps()` 用记着的 25fps 去换算一个 30fps 的文件，`sourceMicrosAt` 于是
 * 取到**另一个时刻**的画面；`durationFrames` 比真实文件长时，尾部几帧解不出来、
 * 那一层画面直接消失。所以指认成功时 `file` 和元数据**必须成对**换掉，只有 `id`
 * 保留——EDL 引用的是 id，它才是身份。
 *
 * 代价要写明：`sourceIn` 是**老栅格**上的帧号，换成新帧率之后同一个数指向的时刻会变
 * （25fps 上的第 750 帧是第 30 秒，30fps 上是第 25 秒）。我们**不**顺手换算它——那是
 * 一次用户没要求的编辑，而帧率不一致已经作为警告说出去了。真要做也是另一刀的事。
 */

import type { Rational } from "../time/rational";
import { formatFps, toNumber } from "../time/rational";
import type { MediaSource, SourceId } from "../edl/types";
import { formatDuration } from "../time/timebase";
import { sourceDurationFrames } from "../edl/types";
import type { SourceMeta } from "./project-snapshot";

/**
 * 时长差多少才值得说一句（秒）。
 *
 * 重导一遍常常差一两帧（30fps 下 33ms），那是编码的噪声不是"换了个文件"。0.1 秒
 * 约合 3 帧：小于它不提，大于它按稿子那句「时长差 0.4 秒，可能不是同一个文件」报出来。
 */
export const DURATION_TOLERANCE_SECONDS = 0.1;

/** 一个读不动的素材，连带它牵着多少片段。 */
export interface MissingSource {
  readonly meta: SourceMeta;
  /**
   * 引用它的片段数。**跳过它就会丢掉这么多片段**，所以这个数要显示出来——
   * "丢 1 段"和"丢 23 段"是两个完全不同的决定。
   */
  readonly clips: number;
}

/**
 * 素材时长（秒）。图片没有时长，返回 null。
 *
 * 浮点秒只用于**显示和给人看的容差比较**，一帧运算都不做（硬规则 1）：纯音频素材
 * 的帧数仍由 `sourceDurationFrames` 按项目帧率派生，那条派生没被绕过。
 */
export function sourceSeconds(meta: SourceMeta, projectFps: Rational): number | null {
  if (meta.kind === "image") return null;
  if (meta.kind === "audio") return meta.durationMicros / 1_000_000;
  return meta.durationFrames / toNumber(meta.fps);
}

/**
 * "这个文件应该是什么样"的一行描述，显示在指认行上。
 *
 * 快照里的 `SourceMeta` 本来就存着尺寸 / 帧率 / 时长（分配式 `Omit` 保住了它们，
 * 见 D35），所以这一行不需要读任何文件——**离线素材恰恰是读不到的那个**。
 */
export function describeSourceMeta(meta: SourceMeta, projectFps: Rational): string {
  if (meta.kind === "av") {
    return [
      `${meta.width}×${meta.height}`,
      `${formatFps(meta.fps)} fps`,
      formatDuration(meta.durationFrames, meta.fps),
    ].join(" · ");
  }
  if (meta.kind === "image") {
    return [
      `${meta.width}×${meta.height}`,
      meta.mimeType.replace(/^image\//, "").toUpperCase(),
    ].join(" · ");
  }
  return [
    `${(meta.sampleRate / 1000).toFixed(1)}kHz`,
    meta.channels === 1 ? "单声道" : `${meta.channels} 声道`,
    formatDuration(sourceDurationFrames(meta, projectFps), projectFps),
  ].join(" · ");
}

/** 素材种类的人话，只用于错误文案。 */
function kindLabel(kind: MediaSource["kind"]): string {
  return kind === "av" ? "视频" : kind === "audio" ? "音频" : "图片";
}

export type ReplacementCheck =
  /** 收下。`warnings` 非空表示"看着不像同一个文件"，**仍然收下**（也许真换了一版）。 */
  | { readonly ok: true; readonly warnings: readonly string[] }
  /** 拒绝。种类不一致——那不是"换了一版"，是指错了文件。 */
  | { readonly ok: false; readonly reason: string };

/**
 * 用户指进来的文件对不对得上快照的记录。
 *
 * **警告是给用户的，不是护栏**（D37）：尺寸 / 帧率 / 时长不一致照样收下，因为
 * "我重导了一版 720p 的"是完全正常的事。唯一的硬拦是种类，理由见文件头。
 */
export function checkReplacement(
  meta: SourceMeta,
  probed: MediaSource,
  projectFps: Rational,
): ReplacementCheck {
  if (meta.kind !== probed.kind) {
    return {
      ok: false,
      reason: `这是${kindLabel(probed.kind)}文件，而「${meta.name}」是${kindLabel(meta.kind)}素材，换个文件试试`,
    };
  }

  const warnings: string[] = [];
  if (meta.kind === "av" && probed.kind === "av") {
    if (meta.width !== probed.width || meta.height !== probed.height) {
      warnings.push(`尺寸不一样（记录是 ${meta.width}×${meta.height}，这个文件是 ${probed.width}×${probed.height}）`);
    }
    if (meta.fps.num * probed.fps.den !== probed.fps.num * meta.fps.den) {
      warnings.push(`帧率不一样（记录是 ${formatFps(meta.fps)}，这个文件是 ${formatFps(probed.fps)}）`);
    }
  }
  if (meta.kind === "image" && probed.kind === "image") {
    if (meta.width !== probed.width || meta.height !== probed.height) {
      warnings.push(`尺寸不一样（记录是 ${meta.width}×${meta.height}，这个文件是 ${probed.width}×${probed.height}）`);
    }
  }
  if (meta.kind === "audio" && probed.kind === "audio") {
    if (meta.sampleRate !== probed.sampleRate || meta.channels !== probed.channels) {
      warnings.push(
        `采样率或声道数不一样（记录是 ${(meta.sampleRate / 1000).toFixed(1)}kHz/${meta.channels}，这个文件是 ${(probed.sampleRate / 1000).toFixed(1)}kHz/${probed.channels}）`,
      );
    }
  }

  const was = sourceSeconds(meta, projectFps);
  const now = sourceSeconds(probed, projectFps);
  if (was !== null && now !== null) {
    const delta = Math.abs(now - was);
    if (delta > DURATION_TOLERANCE_SECONDS) {
      warnings.push(`时长差 ${delta.toFixed(1)} 秒，可能不是同一个文件`);
    }
  }

  return { ok: true, warnings };
}

/** 一份指认结果：用户挑的文件 + 探针读出来的元数据（**已经换上老 id**）。 */
export interface Reidentified {
  readonly file: File;
  /** 新文件的元数据，`id` 是老的那个——EDL 引用的是 id，它才是身份。 */
  readonly meta: SourceMeta;
  /** 校验出来的"看着不像同一个文件"，只用于显示。 */
  readonly warnings: readonly string[];
}

/**
 * 把探针给出的素材收成一份指认结果：**丢掉探针新生成的 id，换上要替换的那个**。
 *
 * 探针每次都会 `newSourceId()`，用它的话 EDL 里所有 `sourceId` 引用就全成了悬空的，
 * 而 `resolveSource()` 找不到会抛——表现是"指认完，打开就崩"。
 */
export function reidentifiedFrom(
  id: SourceId,
  probed: MediaSource,
  warnings: readonly string[],
): Reidentified {
  const { file, ...rest } = probed;
  return { file, meta: { ...rest, id } as SourceMeta, warnings };
}
