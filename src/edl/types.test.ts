/**
 * 素材的帧栅格。
 *
 * 会写错的就是这两个函数：纯音频素材没有自己的帧率，`sourceIn` 和时长都按**项目
 * 帧率**解释（见 `AudioOnlySource` 的文件头）。写错不报错，只表现成"裁一帧变成
 * 裁另一个长度"或者"波形整体拉伸"。
 */

import { describe, expect, it } from "vitest";
import {
  clipPreservesPitch,
  clipSourceFrames,
  clipSourceId,
  clipSpeed,
  isNormalSpeed,
  NORMAL_SPEED,
  scaleBySpeed,
  unscaleBySpeed,
  sourceDurationFrames,
  sourceGridFps,
  sourceTimelineFrames,
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

describe("要不要走保音高的时间伸缩", () => {
  it("两个条件都要：开关开着，而且速度不是原速", () => {
    expect(clipPreservesPitch(mediaClip())).toBe(false);
    expect(clipPreservesPitch(mediaClip({ speed: { num: 2, den: 1 } }))).toBe(false);
    // **开着但原速** → 仍然要走那条"不乘不除"的原路径。少判这一条不报错（伸缩器
    // 自己对原速也直通），但"没变速的项目连代码路径都相同"这句话就不成立了
    expect(clipPreservesPitch(mediaClip({ preservePitch: true }))).toBe(false);
    expect(
      clipPreservesPitch(mediaClip({ preservePitch: true, speed: { num: 2, den: 2 } })),
    ).toBe(false);
    expect(
      clipPreservesPitch(mediaClip({ preservePitch: true, speed: { num: 2, den: 1 } })),
    ).toBe(true);
  });
});

describe("片段消耗多少源片帧", () => {
  /** 缺省两把尺子：源片帧率就等于项目帧率——绝大多数项目的形态。 */
  const same = { timelineFps: FPS.ntsc30, sourceFps: FPS.ntsc30 };

  it("原速同栅格下与占位帧数逐值相同", () => {
    // 这条钉的是"没变速的项目那道裁切判据一个字都不变"
    for (const frames of [1, 2, 37, 100, 999]) {
      expect(clipSourceFrames(mediaClip({ timelineOut: frames }), same)).toBe(frames);
    }
  });

  it("2× 下 50 帧占位消耗 99 帧源片", () => {
    // 末帧落在 sourceIn + (50-1)×2，所以是 98+1 而不是 100——多算那一帧
    // 就是"允许把出点拉到源片之外"
    expect(clipSourceFrames(mediaClip({ timelineOut: 50, speed: { num: 2, den: 1 } }), same)).toBe(99);
  });

  it("0.5× 下 100 帧占位只消耗 51 帧源片", () => {
    expect(clipSourceFrames(mediaClip({ timelineOut: 100, speed: { num: 1, den: 2 } }), same)).toBe(51);
  });

  it("非整数结果用 ceil：宁可少给一帧", () => {
    // 1.5× 下 4 帧占位要 (4-1)×1.5 = 4.5 → 5，+1 = 6
    expect(clipSourceFrames(mediaClip({ timelineOut: 4, speed: { num: 3, den: 2 } }), same)).toBe(6);
  });

  it("零长片段消耗 0 帧", () => {
    expect(clipSourceFrames(mediaClip({ timelineIn: 10, timelineOut: 10 }), same)).toBe(0);
  });

  // ---- 源片帧率 ≠ 项目帧率 ----
  //
  // 这几条钉的是"两把尺子"。`sourceIn` 和 `sourceDurationFrames()` 在源片栅格上，
  // 占位在项目帧率上，混着相减只在两者相等时恰好对——而那是绝大多数项目的形态。

  it("**25fps 素材在 30fps 时间轴上，450 帧占位只吃掉 375 帧源片**", () => {
    const grids = { timelineFps: FPS.ntsc30, sourceFps: FPS.pal25 };
    expect(clipSourceFrames(mediaClip({ timelineOut: 450 }), grids)).toBe(375);
  });

  it("**60fps 素材反过来：300 帧占位吃掉 600 帧源片**", () => {
    const grids = { timelineFps: FPS.ntsc30, sourceFps: FPS.ntsc60 };
    expect(clipSourceFrames(mediaClip({ timelineOut: 300 }), grids)).toBe(600);
  });

  it("换栅格与变速叠加时只在最后换一次尺子", () => {
    const grids = { timelineFps: FPS.ntsc30, sourceFps: FPS.pal25 };
    // 150 帧占位 @2× 走过 (150-1)×2+1 = 299 个时间轴帧 → ceil(299×25/30) = 250
    expect(
      clipSourceFrames(mediaClip({ timelineOut: 150, speed: { num: 2, den: 1 } }), grids),
    ).toBe(250);
  });

  it("定格恒为 1 帧，与两把尺子无关", () => {
    // 定格判在换算之前：一帧就是一帧，换尺子换不出第二帧来
    for (const sourceFps of [FPS.pal25, FPS.ntsc60, FPS.ndf23976]) {
      expect(
        clipSourceFrames(mediaClip({ timelineOut: 999, freeze: true }), {
          timelineFps: FPS.ntsc30,
          sourceFps,
        }),
      ).toBe(1);
    }
  });
});

describe("素材铺在时间轴上占多少帧（sourceTimelineFrames）", () => {
  it("**源片帧率等于项目帧率时就是源片帧数本身**", () => {
    expect(sourceTimelineFrames(av, FPS.film24)).toBe(240);
  });

  it("25fps 素材进 30fps 项目占 450 帧，60fps 进 30fps 占 300 帧", () => {
    const at = (fps: typeof FPS.pal25, durationFrames: number) =>
      sourceTimelineFrames({ ...av, fps, durationFrames }, FPS.ntsc30);
    expect(at(FPS.pal25, 375)).toBe(450); // 15 秒还是 15 秒
    expect(at(FPS.ntsc60, 600)).toBe(300); // 10 秒还是 10 秒
  });

  it("**它和 `sourceDurationFrames` 是两个量**", () => {
    const slow = { ...av, fps: FPS.pal25, durationFrames: 375 };
    expect(sourceDurationFrames(slow, FPS.ntsc30)).toBe(375); // 源片栅格
    expect(sourceTimelineFrames(slow, FPS.ntsc30)).toBe(450); // 时间轴栅格
  });

  it("纯音频素材两个函数给同一个数——它的栅格本来就是项目帧率", () => {
    expect(sourceTimelineFrames(music, FPS.ntsc30)).toBe(sourceDurationFrames(music, FPS.ntsc30));
  });

  it("图片没有长度，仍然是 Infinity", () => {
    expect(sourceTimelineFrames(photo, FPS.ntsc30)).toBe(Number.POSITIVE_INFINITY);
  });

  it("短到铺不满一帧时至少给 1 帧，不给 0", () => {
    // 0 帧的片段落地就是非法状态（`trimmedClip` 那道"至少保留 1 帧"）
    expect(sourceTimelineFrames({ ...av, fps: FPS.ntsc60, durationFrames: 1 }, FPS.ntsc30)).toBe(1);
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
