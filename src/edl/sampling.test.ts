/**
 * 取样映射的单测。
 *
 * 这里锁死的是导出 EDL 化引入的两类新错误，它们都**不会报错**、只会静默出错片：
 *
 * 1. **源片帧率 ≠ 时间轴帧率**时的取帧位置。用帧号加减（`toSourceFrame`）算出来的
 *    位置在这种情况下是错的，成片播放速度会整体偏快或偏慢。
 * 2. **叠加轨的绘制顺序**。反转写错就是上层轨被下层盖住，画面看起来"少了一层"。
 */

import { describe, expect, it } from "vitest";
import {
  audioClipsAt,
  sourceCenterMicrosAt,
  sourceMicrosAt,
  videoTracksInDrawOrder,
  visibleVideoClips,
} from "./sampling";
import {
  toSourceFrame,
  type MediaClip,
  type MediaSource,
  type TextClip,
  type Timeline,
  type Track,
} from "./types";
import { FPS } from "../time/rational";
import { frameToMicros } from "../time/timebase";

const clip = (over: Partial<MediaClip> = {}): MediaClip => ({
  id: "c1",
  kind: "media",
  sourceId: "s1",
  timelineIn: 0,
  timelineOut: 100,
  sourceIn: 0,
  ...over,
});

const textClip = (over: Partial<TextClip> = {}): TextClip => ({
  id: "t1",
  kind: "text",
  text: "标题",
  timelineIn: 0,
  timelineOut: 100,
  ...over,
});

const source = (over: Partial<MediaSource> = {}): MediaSource => ({
  id: "s1",
  name: "a.mp4",
  file: new File([], "a.mp4"),
  fps: FPS.ntsc30,
  width: 1920,
  height: 1080,
  durationFrames: 300,
  hasAudio: true,
  videoCodec: "avc",
  audioCodec: "aac",
  ...over,
});

const timeline = (tracks: Track[], sources: MediaSource[], fps = FPS.ntsc30): Timeline => ({
  fps,
  width: 1920,
  height: 1080,
  durationFrames: 300,
  tracks,
  sources,
});

describe("sourceMicrosAt", () => {
  it("源片帧率与时间轴帧率相同时，与 toSourceFrame 的结果一致", () => {
    const c = clip({ timelineIn: 40, timelineOut: 140, sourceIn: 90 });
    for (const frame of [40, 41, 77, 139]) {
      const viaFrames = frameToMicros(toSourceFrame(c, frame), FPS.ntsc30);
      expect(sourceMicrosAt(c, frame, FPS.ntsc30, FPS.ntsc30)).toBe(viaFrames);
    }
  });

  it("源片 25fps 放到 30fps 时间轴上时按时间换算，不按帧号加减", () => {
    // sourceIn=50 @25fps = 2 秒；时间轴走 30 帧 @30fps = 1 秒 → 源片 3 秒
    const c = clip({ timelineIn: 0, sourceIn: 50 });
    expect(sourceMicrosAt(c, 30, FPS.ntsc30, FPS.pal25)).toBe(3_000_000);

    // 用帧号加减会算成源片第 80 帧 = 3.2 秒，慢 200ms——这就是那个静默 bug
    expect(frameToMicros(toSourceFrame(c, 30), FPS.pal25)).toBe(3_200_000);
  });

  it("29.97 NDF 下不产生浮点漂移", () => {
    const c = clip();
    // 30 帧 @30000/1001 = 30*1001/30000 秒 = 1.001 秒
    expect(sourceMicrosAt(c, 30, FPS.ndf2997, FPS.ndf2997)).toBe(1_001_000);
    // 一小时时间码（107892 帧）处仍是整数微秒，不是 3599.9999997 之类。
    // 值略小于 3.6e9 是 NDF 的应有表现：时间码比墙上时间走得慢约 3.6 秒
    expect(sourceMicrosAt(c, 107_892, FPS.ndf2997, FPS.ndf2997)).toBe(3_599_996_400);
  });

  it("片段起点不为 0 时，偏移只由 timelineIn 决定", () => {
    const c = clip({ timelineIn: 60, timelineOut: 160, sourceIn: 0 });
    expect(sourceMicrosAt(c, 60, FPS.ntsc30, FPS.ntsc30)).toBe(0);
    expect(sourceMicrosAt(c, 90, FPS.ntsc30, FPS.ntsc30)).toBe(1_000_000);
  });
});

describe("sourceCenterMicrosAt", () => {
  it("比帧起点多半个**源片**帧，而不是半个时间轴帧", () => {
    const c = clip();
    // 源片 25fps：半帧 = 20000μs；时间轴 30fps 的半帧是 16667μs，不能用后者
    expect(sourceCenterMicrosAt(c, 30, FPS.ntsc30, FPS.pal25)).toBe(1_000_000 + 20_000);
  });

  it("落在目标帧内部而不是边界上", () => {
    const c = clip();
    const start = sourceMicrosAt(c, 10, FPS.ntsc30, FPS.ntsc30);
    const next = sourceMicrosAt(c, 11, FPS.ntsc30, FPS.ntsc30);
    const center = sourceCenterMicrosAt(c, 10, FPS.ntsc30, FPS.ntsc30);
    expect(center).toBeGreaterThan(start);
    expect(center).toBeLessThan(next);
  });
});

describe("videoTracksInDrawOrder", () => {
  it("反转成从底到顶：tracks 里靠前的是上层，要最后画", () => {
    const tl = timeline(
      [
        { id: "V2", kind: "video", clips: [] },
        { id: "V1", kind: "video", clips: [] },
      ],
      [source()],
    );
    expect(videoTracksInDrawOrder(tl).map((t) => t.id)).toEqual(["V1", "V2"]);
  });

  it("跳过音频轨和隐藏轨", () => {
    const tl = timeline(
      [
        { id: "V2", kind: "video", clips: [], hidden: true },
        { id: "V1", kind: "video", clips: [] },
        { id: "A1", kind: "audio", clips: [] },
      ],
      [source()],
    );
    expect(videoTracksInDrawOrder(tl).map((t) => t.id)).toEqual(["V1"]);
  });
});

describe("visibleVideoClips", () => {
  const twoLayers = (): Timeline =>
    timeline(
      [
        { id: "V2", kind: "video", clips: [clip({ id: "top", timelineIn: 50, timelineOut: 150 })] },
        { id: "V1", kind: "video", clips: [clip({ id: "base", timelineIn: 0, timelineOut: 200 })] },
      ],
      [source()],
    );

  it("两层都覆盖时，底层在前", () => {
    const got = visibleVideoClips(twoLayers(), 100);
    expect(got.map((v) => v.clip.id)).toEqual(["base", "top"]);
  });

  it("只有底层覆盖时只返回底层", () => {
    const got = visibleVideoClips(twoLayers(), 20);
    expect(got.map((v) => v.clip.id)).toEqual(["base"]);
  });

  it("空档返回空数组——合成器据此画纯黑", () => {
    const tl = timeline(
      [{ id: "V1", kind: "video", clips: [clip({ timelineIn: 0, timelineOut: 50 })] }],
      [source()],
    );
    expect(visibleVideoClips(tl, 60)).toEqual([]);
  });

  it("片段引用了不存在的素材时跳过，而不是抛错中断整帧", () => {
    const tl = timeline(
      [{ id: "V1", kind: "video", clips: [clip({ sourceId: "missing" })] }],
      [source()],
    );
    expect(visibleVideoClips(tl, 10)).toEqual([]);
  });

  it("带上该帧对应的源片时刻", () => {
    const tl = timeline(
      [{ id: "V1", kind: "video", clips: [clip({ timelineIn: 0, sourceIn: 30 })] }],
      [source()],
    );
    const got = visibleVideoClips(tl, 30)[0];
    expect(got?.kind).toBe("media");
    expect(got?.kind === "media" && got.sourceMicros).toBe(2_000_000);
  });

  // 文字层没有源片可查。这几条锁死的是那颗地雷：字幕轨的 kind 是 "video"，
  // 一放文字进去就会被当视频轨，然后拿 sourceId 去查素材——判别联合之前
  // 这里会静默丢掉整层，而不是报错
  it("文字片段作为图层返回，不去查源片", () => {
    const tl = timeline(
      [{ id: "T1", kind: "video", clips: [textClip({ id: "title" })] }],
      [source()],
    );
    expect(visibleVideoClips(tl, 10)).toEqual([
      { kind: "text", trackId: "T1", clip: textClip({ id: "title" }) },
    ]);
  });

  it("文字层和素材层按同一个 z 序混排：字幕轨在最上面，最后画", () => {
    const tl = timeline(
      [
        { id: "T1", kind: "video", clips: [textClip({ id: "title", timelineIn: 0, timelineOut: 200 })] },
        { id: "V2", kind: "video", clips: [clip({ id: "top", timelineIn: 50, timelineOut: 150 })] },
        { id: "V1", kind: "video", clips: [clip({ id: "base", timelineIn: 0, timelineOut: 200 })] },
      ],
      [source()],
    );
    const got = visibleVideoClips(tl, 100);
    expect(got.map((v) => v.clip.id)).toEqual(["base", "top", "title"]);
    expect(got.map((v) => v.kind)).toEqual(["media", "media", "text"]);
  });

  it("素材源片缺失时只丢那一层，文字层照旧返回", () => {
    const tl = timeline(
      [
        { id: "T1", kind: "video", clips: [textClip({ id: "title" })] },
        { id: "V1", kind: "video", clips: [clip({ id: "orphan", sourceId: "missing" })] },
      ],
      [source()],
    );
    expect(visibleVideoClips(tl, 10).map((v) => v.clip.id)).toEqual(["title"]);
  });
});

describe("audioClipsAt", () => {
  it("跳过静音轨", () => {
    const tl = timeline(
      [
        { id: "A1", kind: "audio", clips: [clip({ id: "a1" })] },
        { id: "A2", kind: "audio", clips: [clip({ id: "a2" })], muted: true },
      ],
      [source()],
    );
    expect(audioClipsAt(tl, 10).map((v) => v.clip.id)).toEqual(["a1"]);
  });

  it("不返回视频轨", () => {
    const tl = timeline(
      [
        { id: "V1", kind: "video", clips: [clip({ id: "v1" })] },
        { id: "A1", kind: "audio", clips: [clip({ id: "a1" })] },
      ],
      [source()],
    );
    expect(audioClipsAt(tl, 10).map((v) => v.clip.id)).toEqual(["a1"]);
  });

  it("跳过落在音频轨上的文字片段——它没有声音可混", () => {
    const tl = timeline(
      [
        { id: "A1", kind: "audio", clips: [textClip({ id: "t" })] },
        { id: "A2", kind: "audio", clips: [clip({ id: "a2" })] },
      ],
      [source()],
    );
    expect(audioClipsAt(tl, 10).map((v) => v.clip.id)).toEqual(["a2"]);
  });
});
