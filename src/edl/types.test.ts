/**
 * 素材的帧栅格。
 *
 * 会写错的就是这两个函数：纯音频素材没有自己的帧率，`sourceIn` 和时长都按**项目
 * 帧率**解释（见 `AudioOnlySource` 的文件头）。写错不报错，只表现成"裁一帧变成
 * 裁另一个长度"或者"波形整体拉伸"。
 */

import { describe, expect, it } from "vitest";
import {
  clipSourceFrames,
  clipSourceId,
  clipSpeed,
  isNormalSpeed,
  NORMAL_SPEED,
  scaleBySpeed,
  unscaleBySpeed,
  sourceDurationFrames,
  sourceGridFps,
  sourceHasPicture,
  type AudioOnlySource,
  type AvSource,
  type ImageSource,
  type MediaClip,
} from "./types";
import { FPS } from "../time/rational";

const av: AvSource = {
  id: "v",
  kind: "av",
  name: "v.mp4",
  file: new File([], "v.mp4"),
  fps: FPS.film24,
  width: 1920,
  height: 1080,
  durationFrames: 240,
  hasAudio: true,
  videoCodec: "avc",
  audioCodec: "aac",
};

const music: AudioOnlySource = {
  id: "m",
  kind: "audio",
  name: "m.mp3",
  file: new File([], "m.mp3"),
  hasAudio: true,
  audioCodec: "mp3",
  durationMicros: 10_000_000,
  sampleRate: 44_100,
  channels: 2,
};

describe("素材的帧栅格", () => {
  it("带画面的素材用它自己的帧率，和项目帧率无关", () => {
    expect(sourceGridFps(av, FPS.ndf2997)).toEqual(FPS.film24);
    expect(sourceDurationFrames(av, FPS.ndf2997)).toBe(240);
  });

  it("纯音频素材用项目帧率当栅格", () => {
    expect(sourceGridFps(music, FPS.ndf2997)).toEqual(FPS.ndf2997);
    expect(sourceGridFps(music, FPS.film24)).toEqual(FPS.film24);
  });

  it("纯音频素材的帧数随项目帧率变——10 秒在 24fps 下是 240 帧，30fps 下是 300 帧", () => {
    expect(sourceDurationFrames(music, FPS.film24)).toBe(240);
    expect(sourceDurationFrames(music, FPS.ntsc30)).toBe(300);
  });

  it("29.97 这种非整数帧率下向下取整，不能报出解不出内容的一帧", () => {
    // 10 秒 × 30000/1001 = 299.700…，取整必须是 299
    expect(sourceDurationFrames(music, FPS.ndf2997)).toBe(299);
  });

  it("极短的音频至少算 1 帧，不能是 0 帧的片段", () => {
    const blip: AudioOnlySource = { ...music, durationMicros: 1000 };
    expect(sourceDurationFrames(blip, FPS.ndf2997)).toBe(1);
  });
});

const photo: ImageSource = {
  id: "p",
  kind: "image",
  name: "p.png",
  file: new File([], "p.png"),
  hasAudio: false,
  audioCodec: null,
  width: 4000,
  height: 3000,
  mimeType: "image/png",
  frameCount: 1,
};

describe("图片素材", () => {
  it("源片长度没有上限——裁出点永远不该被它挡住", () => {
    expect(sourceDurationFrames(photo, FPS.ndf2997)).toBe(Number.POSITIVE_INFINITY);
    // 换个帧率也一样：它不是"多少帧"，而是"没有这个概念"
    expect(sourceDurationFrames(photo, FPS.film24)).toBe(Number.POSITIVE_INFINITY);
  });

  it("有画面，所以放得进画面轨", () => {
    expect(sourceHasPicture(photo)).toBe(true);
    expect(sourceHasPicture(av)).toBe(true);
    expect(sourceHasPicture(music)).toBe(false);
  });
});

describe("片段引用哪个素材", () => {
  const base = { id: "c", timelineIn: 0, timelineOut: 10 } as const;

  it("素材片段和图片片段都给出 sourceId，文字片段给 null", () => {
    expect(clipSourceId({ ...base, kind: "media", sourceId: "s1", sourceIn: 0 })).toBe("s1");
    expect(clipSourceId({ ...base, kind: "image", sourceId: "s2" })).toBe("s2");
    expect(clipSourceId({ ...base, kind: "text", text: "x" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 变速的帧数换算（D39）
// ---------------------------------------------------------------------------

const mediaClip = (over: Partial<MediaClip> = {}): MediaClip => ({
  id: "c",
  kind: "media",
  sourceId: "v",
  timelineIn: 0,
  timelineOut: 100,
  sourceIn: 0,
  ...over,
});

describe("速度是不是原速", () => {
  it("没有字段就是原速", () => {
    expect(isNormalSpeed(mediaClip())).toBe(true);
    expect(clipSpeed(mediaClip())).toEqual(NORMAL_SPEED);
  });

  it("**没归一化的 1× 也算原速**", () => {
    // 判 `speed === undefined` 不够：{num:2,den:2} 从旧快照或别处构造出来时
    // 会掉出那条"不乘不除"的原路径，而它本该是原速
    expect(isNormalSpeed(mediaClip({ speed: { num: 2, den: 2 } }))).toBe(true);
    expect(isNormalSpeed(mediaClip({ speed: { num: 3, den: 2 } }))).toBe(false);
  });
});

describe("片段消耗多少源片帧", () => {
  it("原速下与占位帧数逐值相同", () => {
    // 这条钉的是"没变速的项目那道裁切判据一个字都不变"
    for (const frames of [1, 2, 37, 100, 999]) {
      expect(clipSourceFrames(mediaClip({ timelineOut: frames }))).toBe(frames);
    }
  });

  it("2× 下 50 帧占位消耗 99 帧源片", () => {
    // 末帧落在 sourceIn + (50-1)×2，所以是 98+1 而不是 100——多算那一帧
    // 就是"允许把出点拉到源片之外"
    expect(clipSourceFrames(mediaClip({ timelineOut: 50, speed: { num: 2, den: 1 } }))).toBe(99);
  });

  it("0.5× 下 100 帧占位只消耗 51 帧源片", () => {
    expect(clipSourceFrames(mediaClip({ timelineOut: 100, speed: { num: 1, den: 2 } }))).toBe(51);
  });

  it("非整数结果用 ceil：宁可少给一帧", () => {
    // 1.5× 下 4 帧占位要 (4-1)×1.5 = 4.5 → 5，+1 = 6
    expect(clipSourceFrames(mediaClip({ timelineOut: 4, speed: { num: 3, den: 2 } }))).toBe(6);
  });

  it("零长片段消耗 0 帧", () => {
    expect(clipSourceFrames(mediaClip({ timelineIn: 10, timelineOut: 10 }))).toBe(0);
  });
});

describe("时间轴帧 ↔ 源片帧的缩放", () => {
  it("原速两个方向都是恒等", () => {
    expect(scaleBySpeed(37, NORMAL_SPEED)).toBe(37);
    expect(unscaleBySpeed(37, NORMAL_SPEED)).toBe(37);
  });

  it("scaleBySpeed 就近取整，可以为负（转场要往入点之前借）", () => {
    expect(scaleBySpeed(10, { num: 2, den: 1 })).toBe(20);
    expect(scaleBySpeed(-10, { num: 2, den: 1 })).toBe(-20);
    expect(scaleBySpeed(3, { num: 3, den: 2 })).toBe(5); // 4.5 → 5
  });

  it("**unscaleBySpeed 用 floor，和 scaleBySpeed 刻意不对称**", () => {
    // 它回答"余量够不够"。多算一帧 = 报"余量够"而那一帧解不出来，
    // 表现是转场一侧静默定格而检查器说没事
    expect(unscaleBySpeed(30, { num: 2, den: 1 })).toBe(15);
    expect(unscaleBySpeed(31, { num: 2, den: 1 })).toBe(15);
    expect(unscaleBySpeed(5, { num: 3, den: 2 })).toBe(3); // 3.33 → 3
  });
});
