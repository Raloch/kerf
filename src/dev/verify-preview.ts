/**
 * 预览 / 导出一致性自检——硬规则 2 的回归护栏。
 *
 * "预览和导出画面不一致"是自研剪辑器最典型的翻车方式，而它**不会报错**：
 * 两条路径各自都能出画面，只有并排比对才看得出构图不同。所以这里做的是
 * 用同一份 EDL、同一帧号，分别走预览路径和导出路径，然后逐像素比较。
 *
 * 刻意用**方形输出**（正方形画布 + 16:9 源片）跑这个比对：这样两条路径都必须
 * 做等比缩放留边，黑边位置一旦不同就会被抓出来。如果输出比例恰好等于源片比例，
 * 缩放逻辑写错了也看不出来。
 *
 * 允许的差异只有一处：预览走 `video.currentTime` seek，可能落在相邻帧上
 * （硬规则 3 明确说预览不要求帧精确），因此比较主色调时留了容差，
 * 但**几何必须完全一致**——黑边位置差一个像素都算失败。
 *
 * 第二段（M2）验的是**图层变换和关键帧接进两条路径之后仍然一致**。它比第一段
 * 严格：几何来自变换求值，与 seek 精不精确无关，所以四条边必须逐帧完全相等，
 * 而且还要跟手算的位置对得上。另外专门断言"摆位逐帧在变"——变换要是被整条丢掉，
 * 两条路径同样是"一致"的，只比一致性抓不到这种错。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { makeSampleVideo } from "./make-sample";
import { probeFile } from "../media/probe";
import { runExport } from "../export/pipeline";
import { readExportFile, removeExportFile } from "../export/write-target";
import { createPreviewEngine } from "../preview/preview-engine";
import { singleClipTimeline, type Timeline } from "../edl/types";
import { frameDurationMicros, frameToMicros, MICROS_PER_SECOND } from "../time/timebase";
import { measure, type Bands } from "./measure";
import type { Check } from "./verify-m0";

/** 单帧比对结果的落盘文件名。 */
const VERIFY_OUT = "kerf-verify-preview.mp4";
/** 变换/关键帧比对的落盘文件名。 */
const VERIFY_XFORM_OUT = "kerf-verify-preview-xform.mp4";

/** 方形输出：让 16:9 素材必然产生上下黑边，从而能比较留边几何。 */
const OUT_SIZE = 320;
/** 取样帧：避开首尾，落在片段中段。 */
const PROBE_FRAME = 150;

/**
 * 关键帧比对用的动画：**静态缩放 0.5 + 只给 x 打关键帧**。
 *
 * 这样选是为了让期望位置全是整数。默认留边是 320×180 @ (0,70)，缩一半后
 * 160×90、中心 (160,160)、垂直方向恒定 y 115..205；x 从 -80 线性走到 +80，
 * 于是水平中心走 80 → 160 → 240，四条边在三个取样帧上都落在整像素。
 * 同时它还顺带验了 D10 那条"静态值与关键帧并存"——scale 是静态的，x 是动画的。
 */
const XFORM_FRAMES = 120;
const XFORM_PROBES = [0, 60, 120] as const;
/** 手算的期望边距：上/下/左/右。算式见上。 */
const XFORM_EXPECTED = [
  { top: 115, bottom: 115, left: 0, right: 160 },
  { top: 115, bottom: 115, left: 80, right: 80 },
  { top: 115, bottom: 115, left: 160, right: 0 },
] as const;

interface Edges {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

function worstEdgeDelta(a: Edges, b: Edges): number {
  return Math.max(
    Math.abs(a.top - b.top),
    Math.abs(a.bottom - b.bottom),
    Math.abs(a.left - b.left),
    Math.abs(a.right - b.right),
  );
}

function edgesText(b: Edges): string {
  return `${b.top}/${b.bottom}/${b.left}/${b.right}`;
}

/** 导出一段，再读回指定的几个输出帧并测量。 */
async function exportAndMeasure(
  timeline: Timeline,
  outFrames: readonly number[],
  name: string,
): Promise<Bands[]> {
  await removeExportFile(name);
  await runExport(
    {
      timeline,
      range: { inFrame: 0, outFrame: timeline.durationFrames },
      container: "mp4",
      videoBitrate: 8e6,
      audioBitrate: 128e3,
      audio: null,
      target: { kind: "opfs", name },
    },
    { onProgress: () => undefined, isCanceled: () => false },
  );

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(await readExportFile(name)) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("导出文件里没有视频轨");
    const sink = new VideoSampleSink(track);

    const canvas = document.createElement("canvas");
    canvas.width = OUT_SIZE;
    canvas.height = OUT_SIZE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("比对画布没有 2D 上下文");

    const out: Bands[] = [];
    for (const frame of outFrames) {
      // 取帧中点：落在帧起点会拿到前一帧
      const micros = frameToMicros(frame, timeline.fps) + frameDurationMicros(timeline.fps) / 2;
      const sample = await sink.getSample(micros / MICROS_PER_SECOND);
      if (!sample) throw new Error(`读不到导出结果第 ${frame} 帧`);
      const videoFrame = sample.toVideoFrame();
      try {
        ctx.clearRect(0, 0, OUT_SIZE, OUT_SIZE);
        ctx.drawImage(videoFrame, 0, 0);
      } finally {
        videoFrame.close();
        sample.close();
      }
      out.push(measure(ctx, OUT_SIZE, OUT_SIZE));
    }
    return out;
  } finally {
    input.dispose();
  }
}

export interface PreviewVerifyResult {
  readonly checks: readonly Check[];
  readonly passed: boolean;
  readonly preview: Bands;
  readonly exported: Bands;
}

function check(name: string, expected: unknown, actual: unknown, pass?: boolean): Check {
  return {
    name,
    expected: String(expected),
    actual: String(actual),
    pass: pass ?? String(expected) === String(actual),
  };
}

export async function verifyPreviewMatchesExport(): Promise<PreviewVerifyResult> {
  const checks: Check[] = [];

  // ---- 准备素材与 EDL ----
  const sample = await makeSampleVideo({ durationFrames: 300, withAudio: false });
  const probe = await probeFile(sample.file);
  const timeline = {
    ...singleClipTimeline(probe.source),
    width: OUT_SIZE,
    height: OUT_SIZE,
  };

  // ---- 预览路径 ----
  const previewCanvas = document.createElement("canvas");
  const engine = createPreviewEngine(previewCanvas, OUT_SIZE, OUT_SIZE);
  let previewBands: Bands;
  try {
    // 不需要手动等待：renderFrame 内部会等素材就绪（ensureLoaded）。
    // 早先版本在这里 sleep 是无效的——video 元素是 renderFrame 时才按需创建的。
    await engine.renderFrame(timeline, PROBE_FRAME);
    const pctx = previewCanvas.getContext("2d");
    if (!pctx) throw new Error("预览画布没有 2D 上下文");
    previewBands = measure(pctx, OUT_SIZE, OUT_SIZE);
  } finally {
    engine.dispose();
  }

  // ---- 导出路径：只导这一帧 ----
  await removeExportFile(VERIFY_OUT);
  const exported = await runExport(
    {
      timeline,
      range: { inFrame: PROBE_FRAME, outFrame: PROBE_FRAME + 1 },
      container: "mp4",
      videoBitrate: 8e6,
      audioBitrate: 128e3,
      audio: null,
      target: { kind: "opfs", name: VERIFY_OUT },
    },
    { onProgress: () => undefined, isCanceled: () => false },
  );
  checks.push(check("导出单帧成功", 1, exported.encodedFrames));

  // ---- 读回导出结果，解码首帧 ----
  const outFile = await readExportFile(VERIFY_OUT);
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(outFile) });
  let exportedBands: Bands;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("导出文件里没有视频轨");
    const sink = new VideoSampleSink(track);
    const first = await sink.getSample(0);
    if (!first) throw new Error("读不出导出文件的首帧");

    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = OUT_SIZE;
    exportCanvas.height = OUT_SIZE;
    const ectx = exportCanvas.getContext("2d");
    if (!ectx) throw new Error("导出比对画布没有 2D 上下文");
    const frame = first.toVideoFrame();
    try {
      ectx.drawImage(frame, 0, 0);
    } finally {
      frame.close();
      first.close();
    }
    exportedBands = measure(ectx, OUT_SIZE, OUT_SIZE);
  } finally {
    input.dispose();
  }

  // ---- 比较 ----
  // 几何必须完全一致：黑边差 1px 就说明两条路径的缩放算法不同
  checks.push(
    check(
      "上黑边高度一致（几何）",
      previewBands.top,
      exportedBands.top,
      previewBands.top === exportedBands.top,
    ),
  );
  checks.push(
    check(
      "下黑边高度一致（几何）",
      previewBands.bottom,
      exportedBands.bottom,
      previewBands.bottom === exportedBands.bottom,
    ),
  );
  checks.push(
    check(
      "确实产生了留边（方形输出 + 16:9 源片）",
      "> 0",
      `${previewBands.top}px`,
      previewBands.top > 0 && previewBands.bottom > 0,
    ),
  );

  // 主色调留容差：预览 seek 可能落到相邻帧，测试素材每帧 hue 变化约 1 度
  const dr = Math.abs(previewBands.meanR - exportedBands.meanR);
  const dg = Math.abs(previewBands.meanG - exportedBands.meanG);
  const db = Math.abs(previewBands.meanB - exportedBands.meanB);
  const maxDelta = Math.max(dr, dg, db);
  checks.push(
    check(
      "画面主色调一致（容差 24，容许 seek 落在相邻帧）",
      "≤ 24",
      String(maxDelta),
      maxDelta <= 24,
    ),
  );

  // ---- M2：图层变换 + 关键帧在两条路径上是否一致 ----
  // 单独造一份带动画的 EDL，不动上面那份：上面几条断言的期望值依赖"没有变换"，
  // 混进同一条时间轴会让两组断言互相污染
  const animated: Timeline = {
    ...timeline,
    durationFrames: XFORM_FRAMES + 1,
    tracks: timeline.tracks.map((track) =>
      track.kind !== "video"
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => ({
              ...clip,
              timelineOut: Math.min(clip.timelineOut, XFORM_FRAMES + 1),
              transform: { scaleX: 0.5, scaleY: 0.5 },
              keyframes: { x: [{ frame: 0, value: -80 }, { frame: XFORM_FRAMES, value: 80 }] },
            })),
          },
    ),
  };

  const animatedPreview: Bands[] = [];
  const engine2 = createPreviewEngine(document.createElement("canvas"), OUT_SIZE, OUT_SIZE);
  try {
    const ctx = engine2.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("预览画布没有 2D 上下文");
    for (const frame of XFORM_PROBES) {
      await engine2.renderFrame(animated, frame);
      animatedPreview.push(measure(ctx, OUT_SIZE, OUT_SIZE));
    }
  } finally {
    engine2.dispose();
  }

  const animatedExport = await exportAndMeasure(animated, XFORM_PROBES, VERIFY_XFORM_OUT);

  // 1. 两条路径逐帧一致。几何来自变换求值，与 seek 精不精确无关，所以要求完全相等
  let worstPair = 0;
  let worstPairAt = -1;
  XFORM_PROBES.forEach((frame, i) => {
    const delta = worstEdgeDelta(animatedPreview[i]!, animatedExport[i]!);
    if (delta > worstPair) {
      worstPair = delta;
      worstPairAt = frame;
    }
  });
  checks.push(
    check(
      "带关键帧时预览与导出的摆位逐帧一致",
      "0px",
      worstPair === 0
        ? `${XFORM_PROBES.length} 帧全部相同`
        : `第 ${worstPairAt} 帧差 ${worstPair}px`,
      worstPair === 0,
    ),
  );

  // 2. 跟手算的位置对得上。只比一致性的话，两边同时算错也能过
  let worstExpected = 0;
  let worstExpectedText = "";
  XFORM_PROBES.forEach((frame, i) => {
    for (const [label, bands] of [
      ["预览", animatedPreview[i]!],
      ["导出", animatedExport[i]!],
    ] as const) {
      const delta = worstEdgeDelta(bands, XFORM_EXPECTED[i]!);
      if (delta > worstExpected) {
        worstExpected = delta;
        worstExpectedText = `第 ${frame} 帧${label} 期望 ${edgesText(XFORM_EXPECTED[i]!)}，实际 ${edgesText(bands)}`;
      }
    }
  });
  checks.push(
    check(
      "带关键帧时的摆位落在手算的位置上（上/下/左/右）",
      "0px",
      worstExpected === 0 ? "两条路径全部精确命中" : `最差 ${worstExpected}px · ${worstExpectedText}`,
      worstExpected === 0,
    ),
  );

  // 3. 动画真的在动。变换被整条丢掉时上面两条**也会通过**——两条路径会一致地
  //    都不应用变换，而"期望值"这条只有在丢掉后位置恰好等于期望时才会漏，
  //    所以这条兜的是"求值返回了常量"这类错
  const moved = new Set(animatedExport.map((b) => b.left)).size;
  checks.push(
    check(
      "关键帧确实逐帧改变摆位（不是被求值成常量）",
      `${XFORM_PROBES.length} 个不同的水平位置`,
      `${moved} 个（${animatedExport.map((b) => b.left).join(" → ")}）`,
      moved === XFORM_PROBES.length,
    ),
  );

  await removeExportFile(VERIFY_XFORM_OUT);

  return {
    checks,
    passed: checks.every((c) => c.pass),
    preview: previewBands,
    exported: exportedBands,
  };
}
