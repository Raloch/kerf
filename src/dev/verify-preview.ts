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
 *
 * 第三段（M2 后半段）验**一级调色**和 **LUT**，套路完全一样：一致 + 真的生效 +
 * 落在参照实现算出来的数上 + 没顺手挪动几何。"只在一个后端生效"和"被整层丢掉"
 * 是这一块最可能的两种静默失效，前者靠一致性抓、后者靠"画面必须变灰 / 通道必须
 * 轮换"抓——后一条尤其重要，LUT 套了没生效时画面看起来完全正常。
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { makeSampleVideo } from "./make-sample";
import { probeFile } from "../media/probe";
import { runExport } from "../export/pipeline";
import { readExportFile, removeExportFile } from "../export/write-target";
import { createPreviewEngine } from "../preview/preview-engine";
import { applyColorMatrix8, colorMatrixOf } from "../compose/color";
import { singleClipTimeline, type LutSource, type Timeline } from "../edl/types";
import { frameDurationMicros, frameToMicros, MICROS_PER_SECOND } from "../time/timebase";
import { measure, type Bands, type MeasureRegion } from "./measure";
import type { Check } from "./verify-m0";

/** 单帧比对结果的落盘文件名。 */
const VERIFY_OUT = "kerf-verify-preview.mp4";
/** 变换/关键帧比对的落盘文件名。 */
const VERIFY_XFORM_OUT = "kerf-verify-preview-xform.mp4";
/** 文字层比对的落盘文件名。 */
const VERIFY_TEXT_OUT = "kerf-verify-preview-text.mp4";
/** 调色比对的落盘文件名。 */
const VERIFY_COLOR_OUT = "kerf-verify-preview-color.mp4";
/** LUT 比对的落盘文件名。 */
const VERIFY_LUT_OUT = "kerf-verify-preview-lut.mp4";

/**
 * 比对用的 LUT：**红绿蓝轮换**（R←B、G←R、B←G）。
 *
 * 挑它有两个理由。它是**线性映射**，所以三线性插值处处精确，断言不必留插值容差；
 * 而且"通道换位"这件事一眼可判——LUT 最要命的失效是"套了但没生效"，
 * 那时画面看起来完全正常，只有拿原色比对才发现什么都没发生。
 */
function swapLut(size: number): { size: number; rgb: Float32Array } {
  const rgb = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const d = size - 1;
        rgb[i++] = b / d;
        rgb[i++] = r / d;
        rgb[i++] = g / d;
      }
    }
  }
  return { size, rgb };
}

/**
 * 比对用的调色：**只把饱和度打到 0**。
 *
 * 挑这一项是因为它有个不需要参照图就能判的后果——画面必须变灰（`chroma` 归零），
 * 于是"调色被整层丢掉"这种最要命的失效有个独立的判据。同时灰度值本身是
 * 亮度加权的确定数，能拿 `colorMatrixOf` 在 CPU 上算出来当真值比对。
 * 换成亮度或对比度就没有这个便利：调完仍然是彩色的，只能靠"和原来不一样"。
 */
const GRADE = { saturation: 0 } as const;

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

/**
 * 文字比对：文字块压在画面下三分之一。
 *
 * 用 `█` 而不是真实文案（**D6**）：实心块边缘少、面积大，位置偏一个像素就能被
 * 黑边扫描抓到；真实文案的抗锯齿边缘只会让容差两头为难。真实文案的排版质量
 * （断行、字重、描边）由 `text-raster.test.ts` 的断行单测 + 截图肉眼比对负责，
 * 不进数值断言。
 */
const TEXT_CONTENT = "███";
const TEXT_STYLE = { fontSizeRatio: 0.12, color: "#ffffff" } as const;
/**
 * 把文字块挪进**下方留边的黑区**（16:9 进方形 → 画面只占 y 70..250，下面 70px 是黑的）。
 *
 * 这一步很关键，第一版把文字放在 y 230 附近、与画面区重叠，结果两条文字断言
 * 都是**假通过**：那一带的非黑像素来自视频而不是文字，把文字整层删掉照样绿。
 * 挪进黑区后，区域里只剩文字，"非黑"和"四条边"才真的在量文字。
 *
 * 字号 0.12 × 320 = 38.4px，行高 1.25 → 块高 48；中心 160 + 125 = 285，
 * 于是块落在 y 261..309，与画面下沿 250 留了 11px 余量（够 H.264 的色度渗出）。
 */
const TEXT_OFFSET_Y = 125;
/** 背景取样区：画面区里避开文字的那一段。 */
const BG_REGION = { x: 0, y: 74, width: OUT_SIZE, height: 90 };
/** 文字取样区：只覆盖下方黑区，里面除了文字什么都没有。 */
const TEXT_REGION = { x: 0, y: 254, width: OUT_SIZE, height: 64 };

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

/** 导出一段，再读回指定的几个输出帧并测量。`regions` 给了就按分区各测一份。 */
async function exportAndMeasure(
  timeline: Timeline,
  outFrames: readonly number[],
  name: string,
  regions?: readonly MeasureRegion[],
): Promise<Bands[][]> {
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

    const out: Bands[][] = [];
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
      out.push(
        regions
          ? regions.map((region) => measure(ctx, OUT_SIZE, OUT_SIZE, region))
          : [measure(ctx, OUT_SIZE, OUT_SIZE)],
      );
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
  const engine = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  let previewBands: Bands;
  try {
    // 不需要手动等待：renderFrame 内部会等素材就绪（ensureLoaded）。
    // 早先版本在这里 sleep 是无效的——video 元素是 renderFrame 时才按需创建的。
    await engine.renderFrame(timeline, PROBE_FRAME);
    previewBands = measureCanvas(engine.canvas as CanvasImageSource, OUT_SIZE);
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

  // ---- M2 后半段：一级调色在两条路径上是否一致，以及**是否真的生效** ----
  // 复用上面那份 EDL 和同一个取样帧，只加一层调色，于是 `previewBands` /
  // `exportedBands` 就是现成的"不调色"对照——省一次导出，而且两组数据的
  // 唯一差异确实只有调色这一件事
  const graded: Timeline = {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.kind !== "video"
        ? track
        : { ...track, clips: track.clips.map((clip) => ({ ...clip, color: GRADE })) },
    ),
  };

  const engineC = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  let gradedPreview: Bands;
  try {
    await engineC.renderFrame(graded, PROBE_FRAME);
    gradedPreview = measureCanvas(engineC.canvas as CanvasImageSource, OUT_SIZE);
  } finally {
    engineC.dispose();
  }

  const gradedExport = (
    await exportAndMeasure(
      { ...graded, durationFrames: PROBE_FRAME + 1 },
      [PROBE_FRAME],
      VERIFY_COLOR_OUT,
    )
  )[0]![0]!;

  // 1. 两条路径的调色结果一致。这是硬规则 2 在颜色维度上的落点——
  //    调色只在一个后端上生效、或者两边矩阵算得不一样，都在这里现形
  const gradeDelta = Math.max(
    Math.abs(gradedPreview.meanR - gradedExport.meanR),
    Math.abs(gradedPreview.meanG - gradedExport.meanG),
    Math.abs(gradedPreview.meanB - gradedExport.meanB),
  );
  checks.push(
    check(
      "调色后预览与导出的颜色一致（容差 24，容许 seek 落在相邻帧）",
      "≤ 24",
      String(gradeDelta),
      gradeDelta <= 24,
    ),
  );

  // 2. 调色**真的生效了**。少了这条，"调色被整层丢掉"时上一条照样通过——
  //    两条路径会一致地都不调色。和摆位那边第 3 条是同一类护栏
  checks.push(
    check(
      "调色确实生效（饱和度归零后画面变灰）",
      `原始彩度 ${previewBands.chroma} → 应 ≤ 4`,
      `预览 ${gradedPreview.chroma} · 导出 ${gradedExport.chroma}`,
      previewBands.chroma > 20 && gradedPreview.chroma <= 4 && gradedExport.chroma <= 4,
    ),
  );

  // 3. 灰度值落在**参照实现算出来的**那个数上。只判"变灰了"的话，权重抄错
  //    （或者 shader 在预乘 alpha 上算）仍然会变灰，只是灰得不对
  const [expectR] = applyColorMatrix8(colorMatrixOf(GRADE), [
    previewBands.meanR,
    previewBands.meanG,
    previewBands.meanB,
    255,
  ]);
  const lumaDelta = Math.abs(gradedExport.meanR - expectR);
  checks.push(
    check(
      "灰度值等于 colorMatrixOf() 在 CPU 上算出来的值（容差 8）",
      `${expectR}`,
      `${gradedExport.meanR}（差 ${lumaDelta}）`,
      lumaDelta <= 8,
    ),
  );

  // 4. 挂滤镜没有把图层挪位置。Pixi 给 sprite 挂 filter 会先渲进一张临时纹理
  //    再合成，摆位算错就会整体偏几个像素——而画面本身是对的，只看颜色抓不到
  const gradeEdgeDelta = worstEdgeDelta(gradedExport, exportedBands);
  checks.push(
    check(
      "调色不改变几何（黑边与不调色时完全相同）",
      "0px",
      gradeEdgeDelta === 0
        ? `完全相同（${edgesText(gradedExport)}）`
        : `差 ${gradeEdgeDelta}px · 调色 ${edgesText(gradedExport)} / 原始 ${edgesText(exportedBands)}`,
      gradeEdgeDelta === 0,
    ),
  );

  await removeExportFile(VERIFY_COLOR_OUT);

  // ---- M2 后半段：LUT 在两条路径上是否一致 ----
  // 套一张"红绿蓝轮换"的表：它是线性映射，三线性插值处处精确，而且**换了通道**
  // 这件事一眼可判——LUT 最要命的失效是"套了但没生效"，那时画面看起来完全正常
  const lut: LutSource = { id: "verify-lut", name: "swap", ...swapLut(9) };
  const luted: Timeline = {
    ...timeline,
    luts: [lut],
    tracks: timeline.tracks.map((track) =>
      track.kind !== "video"
        ? track
        : { ...track, clips: track.clips.map((clip) => ({ ...clip, lutId: lut.id })) },
    ),
  };

  const engineL = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  let lutPreview: Bands;
  try {
    await engineL.renderFrame(luted, PROBE_FRAME);
    lutPreview = measureCanvas(engineL.canvas as CanvasImageSource, OUT_SIZE);
  } finally {
    engineL.dispose();
  }

  const lutExport = (
    await exportAndMeasure(
      { ...luted, durationFrames: PROBE_FRAME + 1 },
      [PROBE_FRAME],
      VERIFY_LUT_OUT,
    )
  )[0]![0]!;

  // 1. 两条路径的查表结果一致
  const lutDelta = Math.max(
    Math.abs(lutPreview.meanR - lutExport.meanR),
    Math.abs(lutPreview.meanG - lutExport.meanG),
    Math.abs(lutPreview.meanB - lutExport.meanB),
  );
  checks.push(
    check(
      "套 LUT 后预览与导出的颜色一致（容差 24，容许 seek 落在相邻帧）",
      "≤ 24",
      String(lutDelta),
      lutDelta <= 24,
    ),
  );

  // 2. LUT **真的生效了**。这张表把 R←B、G←R、B←G，所以三个通道应当整体轮换；
  //    "套了但没生效"时上一条照样通过——两条路径会一致地都不套
  const swapped =
    Math.abs(lutExport.meanR - exportedBands.meanB) <= 24 &&
    Math.abs(lutExport.meanG - exportedBands.meanR) <= 24 &&
    Math.abs(lutExport.meanB - exportedBands.meanG) <= 24;
  checks.push(
    check(
      "LUT 确实生效（RGB 轮换成 BRG）",
      `原色 ${exportedBands.meanR},${exportedBands.meanG},${exportedBands.meanB} → 应为 ${exportedBands.meanB},${exportedBands.meanR},${exportedBands.meanG}`,
      `实际 ${lutExport.meanR},${lutExport.meanG},${lutExport.meanB}`,
      swapped,
    ),
  );

  // 3. 查表不改几何。挂第二个滤镜等于再渲一次临时纹理，摆位算错会整体偏几像素
  const lutEdgeDelta = worstEdgeDelta(lutExport, exportedBands);
  checks.push(
    check(
      "套 LUT 不改变几何（黑边与不套时完全相同）",
      "0px",
      lutEdgeDelta === 0
        ? `完全相同（${edgesText(lutExport)}）`
        : `差 ${lutEdgeDelta}px · LUT ${edgesText(lutExport)} / 原始 ${edgesText(exportedBands)}`,
      lutEdgeDelta === 0,
    ),
  );

  await removeExportFile(VERIFY_LUT_OUT);

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
  const engine2 = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  try {
    for (const frame of XFORM_PROBES) {
      await engine2.renderFrame(animated, frame);
      animatedPreview.push(measureCanvas(engine2.canvas as CanvasImageSource, OUT_SIZE));
    }
  } finally {
    engine2.dispose();
  }

  const animatedExport = (await exportAndMeasure(animated, XFORM_PROBES, VERIFY_XFORM_OUT)).map(
    (perRegion) => perRegion[0]!,
  );

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

  // ---- M2：文字层 + 分区测量（D6）----
  // 文字压在下三分之一，V1 的画面在上面。背景区继续做色相比对（文字进画面之后
  // 全幅平均色不再编码帧号，这正是 D6 要解决的问题），文字区单独看位置
  const titled: Timeline = {
    ...timeline,
    durationFrames: 2,
    tracks: [
      {
        id: "T1",
        kind: "video",
        clips: [
          {
            id: "title",
            kind: "text",
            text: TEXT_CONTENT,
            style: TEXT_STYLE,
            timelineIn: 0,
            timelineOut: 2,
            transform: { y: TEXT_OFFSET_Y },
          },
        ],
      },
      ...timeline.tracks
        .filter((t) => t.kind === "video")
        .map((t) => ({
          ...t,
          clips: t.clips.map((c) => ({ ...c, timelineIn: 0, timelineOut: 2 })),
        })),
    ],
  };

  const engine3 = await createPreviewEngine(document.createElement("div"), OUT_SIZE, OUT_SIZE);
  let previewBg: Bands;
  let previewText: Bands;
  let previewFull: Bands;
  try {
    await engine3.renderFrame(titled, 0);
    const ctx = probeContextOf(engine3.canvas as CanvasImageSource, OUT_SIZE);
    previewBg = measure(ctx, OUT_SIZE, OUT_SIZE, BG_REGION);
    previewText = measure(ctx, OUT_SIZE, OUT_SIZE, TEXT_REGION);
    previewFull = measure(ctx, OUT_SIZE, OUT_SIZE);
  } finally {
    engine3.dispose();
  }

  const [exportRegions] = await exportAndMeasure(titled, [0], VERIFY_TEXT_OUT, [
    BG_REGION,
    TEXT_REGION,
  ]);
  const exportBg = exportRegions![0]!;
  const exportText = exportRegions![1]!;

  // 1. 文字真的画出来了，而且两条路径都画了。
  //    "预览里有导出里没有"是硬规则 2 最经典的形态，而它不会报错
  checks.push(
    check(
      "文字层在两条路径上都画出来了",
      "都非黑",
      `预览最大通道 ${previewText.maxChannel} · 导出 ${exportText.maxChannel}`,
      previewText.maxChannel > 32 && exportText.maxChannel > 32,
    ),
  );

  // 2. 文字块的位置逐条边一致。栅格化只有一份（两条路径调同一个
  //    rasterizeText），所以这里差出像素只可能是摆位错了
  const textDelta = worstEdgeDelta(previewText, exportText);
  checks.push(
    check(
      "文字块在两条路径上的位置一致（分区内四条边）",
      "≤ 1px",
      textDelta === 0
        ? `完全相同（${edgesText(previewText)}）`
        : `差 ${textDelta}px · 预览 ${edgesText(previewText)} / 导出 ${edgesText(exportText)}`,
      textDelta <= 1,
    ),
  );

  // 3. 背景区的色相仍然可比。这是 D6 的核心：文字叠上去之后，靠"画面区平均色"
  //    判断取到源片第几帧的那套断言必须改成分区测量才继续成立
  const bgDelta = Math.max(
    Math.abs(previewBg.meanR - exportBg.meanR),
    Math.abs(previewBg.meanG - exportBg.meanG),
    Math.abs(previewBg.meanB - exportBg.meanB),
  );
  checks.push(
    check(
      "有文字时背景区的主色调仍然一致（容差 24，容许 seek 落在相邻帧）",
      "≤ 24",
      String(bgDelta),
      bgDelta <= 24,
    ),
  );

  // 4. 分区参数真的起作用了。如果 measure() 悄悄忽略了 region，上面第 3 条
  //    会退化成"比全幅平均色"——而那恰恰是被文字污染的那个量，可能碰巧也通过。
  //    这一条把"分区 ≠ 全幅"钉住，防止分区测量变成一个摆设
  const bgVsFull = Math.max(
    Math.abs(previewBg.meanR - previewFull.meanR),
    Math.abs(previewBg.meanG - previewFull.meanG),
    Math.abs(previewBg.meanB - previewFull.meanB),
  );
  checks.push(
    check(
      "分区测量确实只测了那一块（背景区平均色 ≠ 全幅平均色）",
      "> 4",
      `差 ${bgVsFull}（背景区 ${previewBg.meanR},${previewBg.meanG},${previewBg.meanB} / 全幅 ${previewFull.meanR},${previewFull.meanG},${previewFull.meanB}）`,
      bgVsFull > 4,
    ),
  );

  await removeExportFile(VERIFY_TEXT_OUT);

  return {
    checks,
    passed: checks.every((c) => c.pass),
    preview: previewBands,
    exported: exportedBands,
  };
}

/**
 * 把引擎画布上的内容读进一张 2D 探测画布再量。
 *
 * **不能直接对引擎画布 `getContext("2d")`**：接了 Pixi 后端之后那是一张 WebGL
 * 画布，一张画布只能有一种上下文类型，那句会返回 null（或在别的浏览器上抛错）。
 * 先 `drawImage` 到一张干净的 2D 画布上，量的还是同一批像素。
 */
function probeContextOf(source: CanvasImageSource, size: number): CanvasRenderingContext2D {
  const probe = document.createElement("canvas");
  probe.width = size;
  probe.height = size;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("探测画布没有 2D 上下文");
  ctx.drawImage(source, 0, 0);
  return ctx;
}

/** 分区测量要在同一份快照上量多次，所以拆成上面那个取上下文 + 这个便捷版。 */
function measureCanvas(source: CanvasImageSource, size: number): Bands {
  return measure(probeContextOf(source, size), size, size);
}
