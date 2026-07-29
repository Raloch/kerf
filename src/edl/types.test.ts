/**
 * 素材的帧栅格。
 *
 * 会写错的就是这两个函数：纯音频素材没有自己的帧率，`sourceIn` 和时长都按**项目
 * 帧率**解释（见 `AudioOnlySource` 的文件头）。写错不报错，只表现成"裁一帧变成
 * 裁另一个长度"或者"波形整体拉伸"。
 */

import { describe, expect, it } from "vitest";
import {
  clipSourceId,
  sourceDurationFrames,
  sourceGridFps,
  sourceHasPicture,
  type AudioOnlySource,
  type AvSource,
  type ImageSource,
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
