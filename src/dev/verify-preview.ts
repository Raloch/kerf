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
 */

import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import { makeSampleVideo } from "./make-sample";
import { probeFile } from "../media/probe";
import { runExport } from "../export/pipeline";
import { createPreviewEngine } from "../preview/preview-engine";
import { singleClipTimeline } from "../edl/types";
import { frameToSeconds } from "../time/timebase";
import type { Check } from "./verify-m0";

/** 方形输出：让 16:9 素材必然产生上下黑边，从而能比较留边几何。 */
const OUT_SIZE = 320;
/** 取样帧：避开首尾，落在片段中段。 */
const PROBE_FRAME = 150;

interface Bands {
  readonly top: number;
  readonly bottom: number;
  readonly meanR: number;
  readonly meanG: number;
  readonly meanB: number;
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

/** 量出上下黑边高度，以及画面区的平均色。 */
function measure(ctx: CanvasRenderingContext2D, size: number): Bands {
  const { data } = ctx.getImageData(0, 0, size, size);
  const rowIsBlack = (y: number): boolean => {
    for (let x = 0; x < size; x += 4) {
      const i = (y * size + x) * 4;
      if (data[i]! + data[i + 1]! + data[i + 2]! > 24) return false;
    }
    return true;
  };

  let top = 0;
  while (top < size && rowIsBlack(top)) top++;
  let bottom = 0;
  while (bottom < size && rowIsBlack(size - 1 - bottom)) bottom++;

  // 只在画面区取平均色，避开黑边
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const y0 = Math.min(top + 4, size - 1);
  const y1 = Math.max(size - bottom - 4, y0 + 1);
  for (let y = y0; y < y1; y += 2) {
    for (let x = 4; x < size - 4; x += 2) {
      const i = (y * size + x) * 4;
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      n++;
    }
  }
  return {
    top,
    bottom,
    meanR: Math.round(r / Math.max(1, n)),
    meanG: Math.round(g / Math.max(1, n)),
    meanB: Math.round(b / Math.max(1, n)),
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
    previewBands = measure(pctx, OUT_SIZE);
  } finally {
    engine.dispose();
  }

  // ---- 导出路径：只导这一帧 ----
  const exported = await runExport(
    {
      file: probe.source.file,
      container: "mp4",
      fps: probe.source.fps,
      width: OUT_SIZE,
      height: OUT_SIZE,
      inFrame: PROBE_FRAME,
      outFrame: PROBE_FRAME + 1,
      videoBitrate: 8e6,
      audioBitrate: 128e3,
      includeAudio: false,
    },
    { onProgress: () => undefined, isCanceled: () => false },
  );
  checks.push(check("导出单帧成功", 1, exported.encodedFrames));

  // ---- 读回导出结果，解码首帧 ----
  const outFile = new File([new Uint8Array(exported.bytes)], "one-frame.mp4", {
    type: exported.mimeType,
  });
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
    exportedBands = measure(ectx, OUT_SIZE);
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

  return {
    checks,
    passed: checks.every((c) => c.pass),
    preview: previewBands,
    exported: exportedBands,
  };
}
