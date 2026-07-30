import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import { clipSourceFrames, clipsUsingEffects } from "../edl/types";
import { videoTracksInDrawOrder } from "../edl/sampling";
import type { LutSource } from "../edl/types";
import type {
  AudioOnlySource,
  AvSource,
  ImageSource,
  Clip,
  MediaClip,
  MediaSource,
  TextClip,
  Timeline,
  Track,
  Transition,
} from "../edl/types";
import {
  addFont,
  addLut,
  addSource,
  renameProject,
  addTextClip,
  IMAGE_DEFAULT_SECONDS,
  clearKeyframes,
  computeDuration,
  findClip,
  junctionInfo,
  moveClip,
  moveKeyframe,
  removeClip,
  removeClips,
  clipsInBox,
  setTrackFlag,
  trackFlagLabel,
  moveClips,
  copyClips,
  pasteClips,
  duplicateClips,
  removeKeyframe,
  rippleDeleteClip,
  setClipColor,
  copyClip,
  duplicateClip,
  pasteClip,
  setClipPreservePitch,
  setClipSpeed,
  setClipVolume,
  staticValueOf,
  setClipLut,
  setClipTransform,
  setKeyframe,
  setTextContent,
  setTextStyle,
  snapDrag,
  snapFrame,
  snapTargets,
  setTransition,
  splitClipAt,
  trimClip,
} from "./operations";

// ---- 测试夹具 ----

function source(id: string, durationFrames = 1000): MediaSource {
  return {
    id,
    kind: "av",
    name: `${id}.mp4`,
    file: new File([], `${id}.mp4`),
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames,
    hasAudio: true,
    videoCodec: "avc",
    audioCodec: "aac",
  };
}

function clip(id: string, timelineIn: number, timelineOut: number, sourceIn = 0): MediaClip {
  return { id, kind: "media", sourceId: "src", timelineIn, timelineOut, sourceIn, name: id };
}

function textClip(id: string, timelineIn: number, timelineOut: number): TextClip {
  return { id, kind: "text", text: `${id} 的文字`, timelineIn, timelineOut, name: id };
}

/**
 * 断言取到的是素材片段，并把类型收窄。
 *
 * 判别联合下 `sourceIn` 只存在于 media 分支，测试里必须显式表态——
 * 用 `as MediaClip` 强转就等于把这层保护关掉，改错了也不会红。
 */
function media(clip: Clip | undefined): MediaClip {
  if (clip?.kind !== "media") throw new Error(`期望素材片段，实际是 ${clip?.kind ?? "undefined"}`);
  return clip;
}

function timeline(tracks: Track[], sourceDuration = 1000): Timeline {
  return {
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: computeDuration(tracks),
    tracks,
    sources: [source("src", sourceDuration)],
  };
}

/** V1 上两个相邻片段：[0,100) 和 [100,200)。 */
function twoClipTimeline(): Timeline {
  return timeline([
    { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    { id: "A1", kind: "audio", clips: [clip("m", 0, 200)] },
  ]);
}

describe("时间轴长度", () => {
  it("等于所有片段的最大出点", () => {
    expect(twoClipTimeline().durationFrames).toBe(200);
  });

  it("空时间轴长度为 0", () => {
    expect(computeDuration([{ id: "V1", kind: "video", clips: [] }])).toBe(0);
  });
});

describe("移动片段", () => {
  it("平移改时间轴位置，不改 sourceIn", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 100, 200, 50)] }]);
    const r = moveClip(t, "a", 30);
    expect(r.changed).toBe(true);
    const moved = media(findClip(r.timeline, "a")?.clip);
    expect(moved.timelineIn).toBe(130);
    expect(moved.timelineOut).toBe(230);
    expect(moved.sourceIn).toBe(50); // 关键：引用源片的位置不变
  });

  it("拒绝重叠", () => {
    const r = moveClip(twoClipTimeline(), "a", 50); // a 会压到 b 上
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("重叠");
    expect(findClip(r.timeline, "a")!.clip.timelineIn).toBe(0);
  });

  it("相邻但不重叠是允许的（左闭右开）", () => {
    // a=[0,100) 移到 [100,200) 会与 b 冲突；但把 b 移到 [200,300) 后 a 可以移到 [100,200)
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 200, 300)] },
    ]);
    const r = moveClip(t, "a", 100);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")!.clip.timelineOut).toBe(200);
  });

  it("默认把负位置夹到 0", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 10, 110)] }]);
    const r = moveClip(t, "a", -50);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")!.clip.timelineIn).toBe(0);
    expect(findClip(r.timeline, "a")!.clip.timelineOut).toBe(100); // 长度不变
  });

  it("精确设值模式下越界直接拒绝", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 10, 110)] }]);
    const r = moveClip(t, "a", -50, { clampToBounds: false });
    expect(r.changed).toBe(false);
  });

  it("跨轨道移动", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "V2", kind: "video", clips: [] },
    ]);
    const r = moveClip(t, "a", 0, { toTrack: "V2" });
    expect(r.changed).toBe(true);
    expect(r.timeline.tracks.find((x) => x.id === "V1")!.clips).toHaveLength(0);
    expect(r.timeline.tracks.find((x) => x.id === "V2")!.clips).toHaveLength(1);
  });

  it("不能把视频片段拖到音频轨", () => {
    const r = moveClip(twoClipTimeline(), "a", 0, { toTrack: "A1" });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("音频轨");
  });

  it("锁定轨道拒绝移动", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)], locked: true },
    ]);
    expect(moveClip(t, "a", 10).changed).toBe(false);
  });

  it("拒绝非整数位移", () => {
    expect(moveClip(twoClipTimeline(), "a", 1.5).reason).toContain("整数帧");
  });
});

describe("裁切", () => {
  it("裁入点时同步推进 sourceIn", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100, 20)] }]);
    const r = trimClip(t, "a", "in", 10);
    expect(r.changed).toBe(true);
    const c = media(findClip(r.timeline, "a")?.clip);
    expect(c.timelineIn).toBe(10);
    expect(c.sourceIn).toBe(30); // 少用源片开头 10 帧
    expect(c.timelineOut).toBe(100); // 出点不动
  });

  it("裁出点不改 sourceIn", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100, 20)] }]);
    const r = trimClip(t, "a", "out", -30);
    const c = media(findClip(r.timeline, "a")?.clip);
    expect(c.timelineOut).toBe(70);
    expect(c.sourceIn).toBe(20);
  });

  it("入点往左拖不能早于源片开头", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 50, 150, 5)] }]);
    const r = trimClip(t, "a", "in", -10); // 需要 sourceIn = -5
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("源片开头");
  });

  it("出点往右拖不能超过源片长度", () => {
    // 源片 1000 帧，片段用到 sourceIn=950 起的 50 帧，已到末尾
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 50, 950)] }], 1000);
    const r = trimClip(t, "a", "out", 10);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("源片末尾");
  });

  it("至少保留 1 帧", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 10)] }]);
    expect(trimClip(t, "a", "out", -10).changed).toBe(false);
    expect(trimClip(t, "a", "in", 10).changed).toBe(false);
    // 留 1 帧是允许的
    expect(trimClip(t, "a", "out", -9).changed).toBe(true);
  });

  it("裁切不能撞上邻居", () => {
    const r = trimClip(twoClipTimeline(), "a", "out", 20); // a 出点会伸进 b
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("重叠");
  });
});

describe("切分", () => {
  it("右半段的 sourceIn 跟着推进", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100, 10)] }]);
    const r = splitClipAt(t, "a", 40);
    expect(r.changed).toBe(true);
    const clips = r.timeline.tracks[0]!.clips;
    expect(clips).toHaveLength(2);
    const left = media(clips[0]);
    const right = media(clips[1]);
    expect(left.timelineIn).toBe(0);
    expect(left.timelineOut).toBe(40);
    expect(left.sourceIn).toBe(10);
    expect(right.timelineIn).toBe(40);
    expect(right.timelineOut).toBe(100);
    // 关键：右半段必须从源片第 50 帧开始，否则会重播左半段的内容
    expect(right.sourceIn).toBe(50);
  });

  it("切点落在边界上不产生空片段", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);
    expect(splitClipAt(t, "a", 0).changed).toBe(false);
    expect(splitClipAt(t, "a", 100).changed).toBe(false);
    expect(splitClipAt(t, "a", 150).changed).toBe(false);
  });

  it("切分后两段无缝相接，总长不变", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);
    const r = splitClipAt(t, "a", 33);
    const clips = r.timeline.tracks[0]!.clips;
    expect(clips[0]!.timelineOut).toBe(clips[1]!.timelineIn);
    expect(r.timeline.durationFrames).toBe(100);
  });
});

describe("删除", () => {
  it("普通删除留下空档", () => {
    const r = removeClip(twoClipTimeline(), "a");
    expect(r.changed).toBe(true);
    const v1 = r.timeline.tracks.find((t) => t.id === "V1")!;
    expect(v1.clips).toHaveLength(1);
    expect(v1.clips[0]!.timelineIn).toBe(100); // 空档保留
  });

  it("波纹删除把右侧左移填补", () => {
    const r = rippleDeleteClip(twoClipTimeline(), "a");
    const v1 = r.timeline.tracks.find((t) => t.id === "V1")!;
    expect(v1.clips[0]!.timelineIn).toBe(0);
    expect(v1.clips[0]!.timelineOut).toBe(100);
  });

  it("波纹删除不影响其他轨道", () => {
    const r = rippleDeleteClip(twoClipTimeline(), "a");
    const a1 = r.timeline.tracks.find((t) => t.id === "A1")!;
    expect(a1.clips[0]!.timelineIn).toBe(0);
    expect(a1.clips[0]!.timelineOut).toBe(200); // 音乐轨完全没动
  });
});

/**
 * 文字片段没有源素材，所以"源片够不够长"这类限制一律不适用。
 *
 * 这一组锁的是判别联合引入的分岔：漏掉一个分支不会报错，只会表现成
 * "字幕拖不长"（误用源片上限）或者"切开之后后半段文字没了"。
 */
describe("文字片段", () => {
  /** 字幕轨 T1 的 kind 是 "video"——轨道只分画面/声音，文字与否看片段自己。 */
  const titleTimeline = (): Timeline =>
    timeline([
      { id: "T1", kind: "video", clips: [textClip("t", 0, 100)] },
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 200)] },
    ]);

  it("裁入点只改时间轴占位，不带 sourceIn 字段", () => {
    const r = trimClip(titleTimeline(), "t", "in", 10);
    expect(r.changed).toBe(true);
    const c = findClip(r.timeline, "t")!.clip;
    expect(c.kind).toBe("text");
    expect(c.timelineIn).toBe(10);
    expect(c.timelineOut).toBe(100);
    expect(c).not.toHaveProperty("sourceIn");
  });

  it("入点往左拖不受源片开头限制，只受时间轴 0 限制", () => {
    const t = timeline([{ id: "T1", kind: "video", clips: [textClip("t", 5, 100)] }]);
    // 同样的操作放在 sourceIn=5 的素材片段上会被"已经到源片开头"拒绝
    expect(trimClip(t, "t", "in", -5).changed).toBe(true);
    expect(trimClip(t, "t", "in", -10).reason).toContain("时间轴起点");
  });

  it("出点可以拉到超过任何源片的长度", () => {
    // 源片只有 1000 帧；素材片段拉到 5000 会被"源片末尾"拒绝，文字不会
    const t = timeline([{ id: "T1", kind: "video", clips: [textClip("t", 0, 100)] }], 1000);
    const r = trimClip(t, "t", "out", 4900);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "t")!.clip.timelineOut).toBe(5000);
  });

  it("至少保留 1 帧，也不许撞邻居", () => {
    const t = timeline([
      { id: "T1", kind: "video", clips: [textClip("t", 0, 100), textClip("u", 100, 200)] },
    ]);
    expect(trimClip(t, "t", "out", -100).changed).toBe(false);
    expect(trimClip(t, "t", "out", 20).reason).toContain("重叠");
  });

  it("切分后两半都保留同一段文字，且不长出 sourceIn", () => {
    const r = splitClipAt(titleTimeline(), "t", 40);
    expect(r.changed).toBe(true);
    const clips = r.timeline.tracks.find((t) => t.id === "T1")!.clips;
    expect(clips).toHaveLength(2);
    expect(clips.map((c) => c.kind)).toEqual(["text", "text"]);
    expect(clips.map((c) => (c.kind === "text" ? c.text : null))).toEqual([
      "t 的文字",
      "t 的文字",
    ]);
    expect(clips[1]).not.toHaveProperty("sourceIn");
    expect(clips[0]!.timelineOut).toBe(40);
    expect(clips[1]!.timelineIn).toBe(40);
  });

  it("能在画面轨之间移动，但不能移到音频轨", () => {
    const t = timeline([
      { id: "T1", kind: "video", clips: [textClip("t", 0, 100)] },
      { id: "V2", kind: "video", clips: [] },
      { id: "A1", kind: "audio", clips: [] },
    ]);
    expect(moveClip(t, "t", 0, { toTrack: "V2" }).changed).toBe(true);
    expect(moveClip(t, "t", 0, { toTrack: "A1" }).changed).toBe(false);
  });

  it("和素材片段一样进时间轴总长的计算", () => {
    expect(
      computeDuration([{ id: "T1", kind: "video", clips: [textClip("t", 0, 320)] }]),
    ).toBe(320);
  });
});

describe("轨道开关", () => {
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 100)] },
    ]);
  const track = (t: Timeline, id: string) => t.tracks.find((x) => x.id === id)!;

  it("隐藏画面轨 / 静音音频轨", () => {
    const hidden = setTrackFlag(base(), "V1", "hidden", true);
    expect(hidden.changed).toBe(true);
    expect(track(hidden.timeline, "V1").hidden).toBe(true);

    const muted = setTrackFlag(base(), "A1", "muted", true);
    expect(track(muted.timeline, "A1").muted).toBe(true);
  });

  it("**关掉要把字段整个删掉**，不留 false", () => {
    const on = setTrackFlag(base(), "V1", "hidden", true).timeline;
    const off = setTrackFlag(on, "V1", "hidden", false).timeline;
    expect("hidden" in track(off, "V1")).toBe(false);
  });

  it("**锁定不能被「轨道已锁定」挡住**，否则锁上就再也解不开", () => {
    // 其他每个编辑操作都判 track.locked 并拒绝，这一个是唯一的例外
    const locked = setTrackFlag(base(), "V1", "locked", true).timeline;
    expect(track(locked, "V1").locked).toBe(true);
    const unlocked = setTrackFlag(locked, "V1", "locked", false);
    expect(unlocked.changed).toBe(true);
    expect("locked" in track(unlocked.timeline, "V1")).toBe(false);
  });

  it("锁定的轨道照样能静音 / 隐藏", () => {
    // 锁定管的是"改片段"，不管"这条轨参不参与成片"
    const locked = setTrackFlag(base(), "A1", "locked", true).timeline;
    expect(setTrackFlag(locked, "A1", "muted", true).changed).toBe(true);
  });

  it("**静音只能给音频轨、隐藏只能给画面轨**——存了不生效的字段是 D19 那一类", () => {
    expect(setTrackFlag(base(), "V1", "muted", true).reason).toMatch(/只有音频轨/);
    expect(setTrackFlag(base(), "A1", "hidden", true).reason).toMatch(/只有画面轨/);
  });

  it("值没变时既不算失败也不进历史（第三种结果）", () => {
    const r = setTrackFlag(base(), "V1", "hidden", false);
    expect(r.changed).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("找不到轨道时拒绝", () => {
    expect(setTrackFlag(base(), "没有这条轨", "locked", true).reason).toMatch(/找不到轨道/);
  });

  it("撤销栈的标签分开和关（「锁定」和「取消锁定」读起来完全不同）", () => {
    expect(trackFlagLabel("locked", true)).toBe("锁定");
    expect(trackFlagLabel("locked", false)).toBe("取消锁定");
    expect(trackFlagLabel("muted", true)).toBe("静音");
    expect(trackFlagLabel("hidden", false)).toBe("取消隐藏");
  });

  it("**隐藏之后下游真的不画它了**（判据在 sampling，这里只钉住字段被认）", () => {
    const hidden = setTrackFlag(base(), "V1", "hidden", true).timeline;
    expect(videoTracksInDrawOrder(hidden).map((t) => t.id)).not.toContain("V1");
    const shown = setTrackFlag(hidden, "V1", "hidden", false).timeline;
    expect(videoTracksInDrawOrder(shown).map((t) => t.id)).toContain("V1");
  });
});

describe("框选", () => {
  /** V1 上 a[0,100) b[200,300)，A1 上 m[50,150)。 */
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 200, 300)] },
      { id: "A1", kind: "audio", clips: [clip("m", 50, 150)] },
    ]);

  it("**碰到就算，不要求完全框住**", () => {
    // 要求完全框住的话，比可视区还长的片段永远选不中（只能先缩小时间轴）
    expect(clipsInBox(base(), { fromFrame: 50, toFrame: 60, trackIds: ["V1"] })).toEqual(["a"]);
  });

  it("只看给进来的那几条轨", () => {
    const box = { fromFrame: 0, toFrame: 300 };
    expect(clipsInBox(base(), { ...box, trackIds: ["V1"] })).toEqual(["a", "b"]);
    expect(clipsInBox(base(), { ...box, trackIds: ["A1"] })).toEqual(["m"]);
    expect(clipsInBox(base(), { ...box, trackIds: ["V1", "A1"] })).toEqual(["a", "b", "m"]);
    expect(clipsInBox(base(), { ...box, trackIds: [] })).toEqual([]);
    expect(clipsInBox(base(), { ...box, trackIds: ["没有这条轨"] })).toEqual([]);
  });

  it("**边界是左闭右开，和 `overlaps` 同一套**", () => {
    // 两处用不同的边界规则会让"框到贴边"时选中数忽多忽少
    expect(clipsInBox(base(), { fromFrame: 0, toFrame: 200, trackIds: ["V1"] })).toEqual(["a"]);
    expect(clipsInBox(base(), { fromFrame: 0, toFrame: 201, trackIds: ["V1"] })).toEqual(["a", "b"]);
    expect(clipsInBox(base(), { fromFrame: 100, toFrame: 200, trackIds: ["V1"] })).toEqual([]);
  });

  it("零宽的框（纯垂直拖动）选中它穿过的片段", () => {
    expect(clipsInBox(base(), { fromFrame: 60, toFrame: 60, trackIds: ["V1", "A1"] })).toEqual([
      "a",
      "m",
    ]);
  });

  it("零宽的框落在交界上时两边都不选中（左闭右开的必然结果）", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    ]);
    expect(clipsInBox(t, { fromFrame: 100, toFrame: 100, trackIds: ["V1"] })).toEqual([]);
  });

  it("小数边界照常算——UI 给的是像素换出来的浮点帧号", () => {
    expect(clipsInBox(base(), { fromFrame: 99.4, toFrame: 99.6, trackIds: ["V1"] })).toEqual(["a"]);
    expect(clipsInBox(base(), { fromFrame: 100.1, toFrame: 199.9, trackIds: ["V1"] })).toEqual([]);
  });

  it("**锁定轨道上的片段照样选中**，同 selectAll", () => {
    // 在选中这一步先筛一遍等于让用户看不见"那里还有东西"；能不能删由批量操作报
    const t = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    expect(clipsInBox(t, { fromFrame: 0, toFrame: 100, trackIds: ["V1"] })).toEqual(["a"]);
  });
});

describe("磁吸", () => {
  it("收集其他片段两端、播放头和起点", () => {
    const targets = snapTargets(twoClipTimeline(), ["a"], { playhead: 150 });
    expect(targets).toContain(0);
    expect(targets).toContain(100); // b 的入点
    expect(targets).toContain(200); // b 的出点
    expect(targets).toContain(150); // 播放头
  });

  it("排除被拖动片段自身，否则永远吸回原位", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 37, 137)] }]);
    expect(snapTargets(t, ["a"])).not.toContain(37);
    expect(snapTargets(t, [])).toContain(37);
  });

  // 整组拖拽时同伴也在移动，吸到它们的**原**位置是错的（表现是整组拖起来一顿一顿的）
  it("排除的是一组 id，整组拖拽时同伴的两端也不参与吸附", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 50), clip("b", 60, 90)] },
      { id: "V2", kind: "video", clips: [clip("c", 200, 240)] },
    ]);
    const targets = snapTargets(t, ["a", "b"]);
    expect(targets).not.toContain(60);
    expect(targets).not.toContain(90);
    // 不在组里的照常参与
    expect(targets).toContain(200);
    expect(targets).toContain(240);
  });

  it("阈值内吸附，阈值外不动", () => {
    expect(snapFrame(103, [100], 6)).toEqual({ frame: 100, snapped: true, target: 100 });
    expect(snapFrame(110, [100], 6)).toEqual({ frame: 110, snapped: false });
  });

  it("已经精确对齐时不报告为吸附（不该闪辅助线）", () => {
    expect(snapFrame(100, [100], 6)).toEqual({ frame: 100, snapped: false, target: 100 });
  });

  it("距离相同时取较小帧号，结果稳定", () => {
    expect(snapFrame(100, [95, 105], 6).frame).toBe(95);
    expect(snapFrame(100, [105, 95], 6).frame).toBe(95);
  });

  it("拖拽同时考虑两端：右端更近时按右端吸", () => {
    // 片段长 100，落点 48 → 右端 148 距离目标 150 只差 2，左端 48 距 0 差 48
    const r = snapDrag(48, 100, [0, 150], 6);
    expect(r.snapped).toBe(true);
    expect(r.frame).toBe(50); // 右端贴到 150
  });

  it("两端都不在阈值内则保持原位", () => {
    const r = snapDrag(500, 100, [0, 150], 6);
    expect(r).toEqual({ frame: 500, snapped: false });
  });

  it("只吸左端会留下缝隙——这里验证右端也参与", () => {
    // 若只吸左端，落点 44 不会被吸（距 0 有 44），右端 144 距 145 差 1 会被漏掉
    const r = snapDrag(44, 100, [145], 6);
    expect(r.frame).toBe(45);
  });
});

describe("不变量：编辑后同轨道永不重叠且有序", () => {
  it("一连串操作后仍然成立", () => {
    let t = twoClipTimeline();
    t = splitClipAt(t, "b", 150).timeline;
    t = trimClip(t, "a", "out", -20).timeline;
    t = moveClip(t, "a", 5).timeline;
    t = rippleDeleteClip(t, "b").timeline;

    for (const track of t.tracks) {
      const clips = track.clips;
      for (let i = 0; i < clips.length; i++) {
        expect(clips[i]!.timelineOut).toBeGreaterThan(clips[i]!.timelineIn);
        if (i > 0) {
          // 有序且不重叠
          expect(clips[i]!.timelineIn).toBeGreaterThanOrEqual(clips[i - 1]!.timelineOut);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 变换 / 关键帧 / 文字
// ---------------------------------------------------------------------------

/** 在 x 通道上按给定偏移打一串关键帧，值取 0/10/20…（只用来看偏移动没动）。 */
function animated(base: MediaClip, offsets: number[]): MediaClip {
  return { ...base, keyframes: { x: offsets.map((frame, i) => ({ frame, value: i * 10 })) } };
}

/** 取某片段 x 通道的关键帧偏移列表。 */
function offsetsOf(t: Timeline, id: string): number[] {
  return (findClip(t, id)?.clip.keyframes?.x ?? []).map((k) => k.frame);
}

describe("裁切与切分要平移关键帧（D10 的债）", () => {
  it("入点右移 10 帧，关键帧偏移减 10——动画贴住内容不滑走", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 0, 100, 20), [0, 30, 60])] },
    ]);
    const r = trimClip(t, "a", "in", 10);
    expect(r.changed).toBe(true);
    // 原本挂在"片段第 30 帧"上的动作，现在是这个片段的第 20 帧
    expect(offsetsOf(r.timeline, "a")).toEqual([-10, 20, 50]);
  });

  it("入点左移（拉长）反向平移", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 50, 150, 20), [0, 30])] },
    ]);
    expect(offsetsOf(trimClip(t, "a", "in", -5).timeline, "a")).toEqual([5, 35]);
  });

  it("平移出边界的关键帧保留不删——把入点拖回去动画要能原样回来", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 0, 100, 20), [0, 10])] },
    ]);
    const trimmed = trimClip(t, "a", "in", 40).timeline;
    expect(offsetsOf(trimmed, "a")).toEqual([-40, -30]);
    // 再拖回来，偏移完全复原
    expect(offsetsOf(trimClip(trimmed, "a", "in", -40).timeline, "a")).toEqual([0, 10]);
  });

  it("出点裁切不动关键帧——起点没变", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 0, 100, 20), [0, 30])] },
    ]);
    expect(offsetsOf(trimClip(t, "a", "out", -20).timeline, "a")).toEqual([0, 30]);
  });

  it("在时间轴上平移片段不动关键帧——偏移是相对的，这正是选相对偏移的理由", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 0, 100, 20), [0, 30])] },
    ]);
    expect(offsetsOf(moveClip(t, "a", 500).timeline, "a")).toEqual([0, 30]);
  });

  it("文字片段同样平移——这不是 media 分支专属", () => {
    const text: TextClip = {
      ...textClip("tt", 0, 100),
      keyframes: { opacity: [{ frame: 0, value: 0 }, { frame: 40, value: 1 }] },
    };
    const t = timeline([{ id: "T1", kind: "video", clips: [text] }]);
    const r = trimClip(t, "tt", "in", 15);
    expect((findClip(r.timeline, "tt")!.clip.keyframes?.opacity ?? []).map((k) => k.frame)).toEqual([
      -15, 25,
    ]);
  });

  it("切分：左半段原样，右半段减掉切掉的长度", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [animated(clip("a", 0, 100, 0), [0, 40, 80])] },
    ]);
    const r = splitClipAt(t, "a", 30);
    expect(r.changed).toBe(true);
    const right = findClip(r.timeline, "a")!.track.clips.find((c) => c.id !== "a")!;
    expect(offsetsOf(r.timeline, "a")).toEqual([0, 40, 80]);
    expect((right.keyframes?.x ?? []).map((k) => k.frame)).toEqual([-30, 10, 50]);
  });

  it("没有关键帧的片段裁切后仍然没有 keyframes 字段", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100, 20)] }]);
    const trimmed = findClip(trimClip(t, "a", "in", 10).timeline, "a")!.clip;
    expect("keyframes" in trimmed).toBe(false);
  });
});

describe("静态变换", () => {
  const one = () => timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);

  it("设值后写进 transform", () => {
    const r = setClipTransform(one(), "a", { x: 40, scaleX: 1.5 });
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")!.clip.transform).toEqual({ x: 40, scaleX: 1.5 });
  });

  it("超范围的值被夹住，不是报错", () => {
    const r = setClipTransform(one(), "a", { opacity: 3, scaleY: -2 });
    expect(findClip(r.timeline, "a")!.clip.transform).toEqual({ scaleY: 0 });
    // opacity 夹回 1 就是缺省值，于是被归一化掉了
  });

  it("拒绝 NaN——它会一路传到 drawImage 把整层画没，且不报错", () => {
    const r = setClipTransform(one(), "a", { x: Number.NaN });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("有限数");
  });

  it("调回缺省值时把 transform 字段整个删掉，不留 { x: 0 }", () => {
    const set = setClipTransform(one(), "a", { x: 40 }).timeline;
    const back = setClipTransform(set, "a", { x: 0 }).timeline;
    expect("transform" in findClip(back, "a")!.clip).toBe(false);
  });

  it("显式传 undefined 表示清除这一项", () => {
    const set = setClipTransform(one(), "a", { x: 40, y: 20 }).timeline;
    const r = setClipTransform(set, "a", { x: undefined });
    expect(findClip(r.timeline, "a")!.clip.transform).toEqual({ y: 20 });
  });

  it("值没变时 changed:false 且**不给 reason**——那不是失败，不该弹提示", () => {
    const set = setClipTransform(one(), "a", { x: 40 }).timeline;
    const again = setClipTransform(set, "a", { x: 40 });
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("锁定轨道上改不动", () => {
    const t = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    expect(setClipTransform(t, "a", { x: 10 }).reason).toContain("锁定");
  });
});

describe("片段音量", () => {
  const one = () =>
    timeline([
      { id: "A1", kind: "audio", clips: [clip("a", 0, 100)] },
      { id: "T1", kind: "video", clips: [textClip("t", 0, 100)] },
    ]);

  it("设值后写进 volume", () => {
    const r = setClipVolume(one(), "a", 0.5);
    expect(media(findClip(r.timeline, "a")!.clip).volume).toBe(0.5);
  });

  it("超范围的值被夹住，不是拒绝", () => {
    expect(media(findClip(setClipVolume(one(), "a", 9).timeline, "a")!.clip).volume).toBe(2);
    expect(media(findClip(setClipVolume(one(), "a", -3).timeline, "a")!.clip).volume).toBe(0);
  });

  it("拒绝 NaN", () => {
    // NaN 会一路传到 GainNode，那一段整个静音且不报错
    const r = setClipVolume(one(), "a", Number.NaN);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("有限数");
  });

  it("调回 100% 时把 volume 字段整个删掉，不留 volume:1", () => {
    // 混音那边的恒等快路径判的是值，所以这不是正确性问题；但"这个片段调过音量
    // 没有"要能在数据层一眼看出来，重置按钮的可用状态也照着它判
    const set = setClipVolume(one(), "a", 0.3).timeline;
    const back = setClipVolume(set, "a", 1).timeline;
    expect("volume" in findClip(back, "a")!.clip).toBe(false);
  });

  it("值没变时 changed:false 且不给 reason", () => {
    // 滑块拖到边界后会持续发同一个值，当失败处理会让状态栏一直闪红字
    const set = setClipVolume(one(), "a", 0.5).timeline;
    const again = setClipVolume(set, "a", 0.5);
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("夹紧之后等于原值也算「值没变」", () => {
    // 已经在上限上还继续往上拖：夹紧后仍是 2，不该记一步撤销
    const set = setClipVolume(one(), "a", 2).timeline;
    const again = setClipVolume(set, "a", 5);
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("文字片段拒掉，不静默忽略", () => {
    const r = setClipVolume(one(), "t", 0.5);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("只有素材片段有音量");
  });

  it("锁定轨道上改不动", () => {
    const t = timeline([{ id: "A1", kind: "audio", locked: true, clips: [clip("a", 0, 100)] }]);
    expect(setClipVolume(t, "a", 0.5).reason).toContain("锁定");
  });

  it("能打关键帧，且不落到摆位/调色两组里", () => {
    const t = setKeyframe(one(), "a", "volume", 0, 0.3).timeline;
    const got = findClip(t, "a")!.clip;
    expect(got.keyframes?.volume).toEqual([{ frame: 0, value: 0.3 }]);
    expect("transform" in got).toBe(false);
    expect("color" in got).toBe(false);
  });

  it("关键帧的值同样被夹紧", () => {
    const t = setKeyframe(one(), "a", "volume", 0, 9).timeline;
    expect(findClip(t, "a")!.clip.keyframes?.volume?.[0]?.value).toBe(2);
  });

  it("文字片段打不了音量关键帧——通道表挂在 ClipBase 上，类型拦不住", () => {
    // 那条曲线永远不会被求值（文字片段没有音轨），留着就是"打了点没反应"
    const r = setKeyframe(one(), "t", "volume", 0, 0.5);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("只有素材片段有音量");
  });

  it("**关掉音量动画时值烘进 clip.volume，不是 transform 也不是 color**", () => {
    // 写死成 transform 的话会静默把 volume 塞进 LayerTransform：合成器不认识那个
    // 字段、混音器读不到这个值，表现是"关掉动画之后音量整个丢了"，而且不报错
    let t = setKeyframe(one(), "a", "volume", 0, 0.4).timeline;
    t = setKeyframe(t, "a", "volume", 50, 0.9).timeline;
    const cleared = clearKeyframes(t, "a", "volume", 0.65).timeline;
    const got = media(findClip(cleared, "a")!.clip);
    expect(got.volume).toBe(0.65);
    expect(got.keyframes).toBeUndefined();
    expect("transform" in got).toBe(false);
    expect("color" in got).toBe(false);
  });

  it("烘的值恰好是缺省 1 时，volume 字段整个删掉", () => {
    const t = setKeyframe(one(), "a", "volume", 0, 0.4).timeline;
    const cleared = clearKeyframes(t, "a", "volume", 1).timeline;
    expect("volume" in findClip(cleared, "a")!.clip).toBe(false);
  });

  it("staticValueOf 认三个地方，一处判据", () => {
    let t = setClipVolume(one(), "a", 0.5).timeline;
    t = setClipTransform(t, "a", { x: 40 }).timeline;
    t = setClipColor(t, "a", { hue: 1 }).timeline;
    const c = findClip(t, "a")!.clip;
    expect(staticValueOf(c, "volume")).toBe(0.5);
    expect(staticValueOf(c, "x")).toBe(40);
    expect(staticValueOf(c, "hue")).toBe(1);
    expect(staticValueOf(c, "opacity")).toBeUndefined();
    // 文字片段没有音量，取到的是 undefined 而不是抛错
    expect(staticValueOf(findClip(t, "t")!.clip, "volume")).toBeUndefined();
  });
});

describe("静态调色", () => {
  const one = () => timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);

  it("设值后写进 color，而不是 transform", () => {
    // 混进 transform 不会报错——合成器不认识那个字段，表现只是"调了色画面没变"
    const r = setClipColor(one(), "a", { saturation: 0, hue: 1 });
    const got = findClip(r.timeline, "a")!.clip;
    expect(got.color).toEqual({ saturation: 0, hue: 1 });
    expect("transform" in got).toBe(false);
  });

  it("超范围的值被夹住", () => {
    const r = setClipColor(one(), "a", { brightness: 99, contrast: -5 });
    expect(findClip(r.timeline, "a")!.clip.color).toEqual({ brightness: 4, contrast: 0 });
  });

  it("拒绝 NaN", () => {
    const r = setClipColor(one(), "a", { saturation: Number.NaN });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("有限数");
  });

  it("调回缺省值时把 color 字段整个删掉，不留 { brightness: 1 }", () => {
    const set = setClipColor(one(), "a", { brightness: 1.5 }).timeline;
    const back = setClipColor(set, "a", { brightness: 1 }).timeline;
    expect("color" in findClip(back, "a")!.clip).toBe(false);
  });

  it("值没变时 changed:false 且不给 reason", () => {
    const set = setClipColor(one(), "a", { saturation: 0.5 }).timeline;
    const again = setClipColor(set, "a", { saturation: 0.5 });
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("锁定轨道上改不动", () => {
    const t = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    expect(setClipColor(t, "a", { hue: 1 }).reason).toContain("锁定");
  });

  it("变换和调色互不干扰", () => {
    let t = setClipTransform(one(), "a", { x: 40 }).timeline;
    t = setClipColor(t, "a", { hue: 2 }).timeline;
    const got = findClip(t, "a")!.clip;
    expect(got.transform).toEqual({ x: 40 });
    expect(got.color).toEqual({ hue: 2 });
    // 重置一组不该动另一组
    const reset = setClipColor(t, "a", { hue: undefined }).timeline;
    expect(findClip(reset, "a")!.clip.transform).toEqual({ x: 40 });
    expect("color" in findClip(reset, "a")!.clip).toBe(false);
  });

  it("关掉调色属性的动画时，值烘进 color 而不是 transform", () => {
    // 写死成 transform 的话会静默把 brightness 塞进 LayerTransform：
    // 不报错，表现是"关掉动画之后调色整个丢了"
    const t = setKeyframe(one(), "a", "brightness", 0, 2).timeline;
    const cleared = clearKeyframes(t, "a", "brightness", 1.8).timeline;
    const got = findClip(cleared, "a")!.clip;
    expect(got.color).toEqual({ brightness: 1.8 });
    expect("transform" in got).toBe(false);
    expect("keyframes" in got).toBe(false);
  });
});

describe("字体", () => {
  const bytes = (): ArrayBuffer => new Uint8Array([0, 1, 2, 3]).buffer;
  const one = () =>
    timeline([{ id: "T1", kind: "video", clips: [textClip("t", 0, 100)] }]);

  it("导入后进 timeline.fonts", () => {
    const t = addFont(one(), { family: "KerfFont-1", name: "Impact.ttf", data: bytes() }).timeline;
    expect(t.fonts?.map((f) => f.name)).toEqual(["Impact.ttf"]);
  });

  it("同族名重复导入不产生历史条目", () => {
    const f = { family: "KerfFont-1", name: "Impact.ttf", data: bytes() };
    const t = addFont(one(), f).timeline;
    expect(addFont(t, f).changed).toBe(false);
  });

  it("挂一个项目里没有的自定义字体会被拒绝", () => {
    // 放过去的话渲染时 `rasterizeText` 会抛（那道断言是刻意的），
    // 而用户看到的是预览整个崩。同 `setClipLut` 那条
    const r = setTextStyle(one(), "t", { fontFamily: "KerfFont-nope" });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("没有这个字体");
  });

  it("系统字体族不受那道校验影响", () => {
    // 系统族名不需要注册，也就不该被"项目里有没有这个字体"卡住
    const r = setTextStyle(one(), "t", { fontFamily: '"Songti SC", serif' });
    expect(r.changed).toBe(true);
    expect((r.timeline.tracks[0]!.clips[0] as TextClip).style?.fontFamily).toBe('"Songti SC", serif');
  });

  it("导入之后就能挂上，片段只存族名不存字节", () => {
    let t = addFont(one(), { family: "KerfFont-1", name: "Impact.ttf", data: bytes() }).timeline;
    t = setTextStyle(t, "t", { fontFamily: "KerfFont-1" }).timeline;
    const clip = t.tracks[0]!.clips[0] as TextClip;
    expect(clip.style?.fontFamily).toBe("KerfFont-1");
    // 字节存进片段会让撤销栈里每一步都拷一份几 MB，同 LUT 那条
    expect(JSON.stringify(clip)).not.toContain("data");
  });
});

describe("LUT", () => {
  const lut = (id: string): LutSource => ({ id, name: id, size: 2, rgb: new Float32Array(24) });
  const one = () => timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);

  it("导入后进 timeline.luts", () => {
    const t = addLut(one(), lut("L1")).timeline;
    expect(t.luts?.map((l) => l.id)).toEqual(["L1"]);
  });

  it("同 id 重复导入不产生历史条目", () => {
    const t = addLut(one(), lut("L1")).timeline;
    expect(addLut(t, lut("L1")).changed).toBe(false);
  });

  it("挂上之后片段只存 id，不存表", () => {
    // 表存进片段会让撤销栈里每一步都拷一份几百 KB，而且"这些片段用的是同一张表"
    // 从数据上就看不出来了
    let t = addLut(one(), lut("L1")).timeline;
    t = setClipLut(t, "a", "L1").timeline;
    expect(findClip(t, "a")!.clip.lutId).toBe("L1");
    expect(JSON.stringify(findClip(t, "a")!.clip)).not.toContain("rgb");
  });

  it("挂一张项目里没有的 LUT 会被拒绝", () => {
    expect(setClipLut(one(), "a", "nope").reason).toContain("没有这张 LUT");
  });

  it("摘掉时把 lutId 字段整个删掉", () => {
    let t = addLut(one(), lut("L1")).timeline;
    t = setClipLut(t, "a", "L1").timeline;
    t = setClipLut(t, "a").timeline;
    expect("lutId" in findClip(t, "a")!.clip).toBe(false);
  });

  it("摘掉时**不动**强度——挂回去要和摘之前一样", () => {
    let t = addLut(one(), lut("L1")).timeline;
    t = setClipLut(t, "a", "L1").timeline;
    t = setClipColor(t, "a", { lutIntensity: 0.4 }).timeline;
    t = setClipLut(t, "a").timeline;
    expect(findClip(t, "a")!.clip.color).toEqual({ lutIntensity: 0.4 });
  });

  it("强度归一化：1 是缺省值，会被整个删掉", () => {
    const t = setClipColor(one(), "a", { lutIntensity: 1 });
    expect(t.changed).toBe(false);
  });

  it("强度夹在 0–1，外插一张查找表没有意义", () => {
    const t = setClipColor(one(), "a", { lutIntensity: 3 }).timeline;
    expect(findClip(t, "a")!.clip.color).toBeUndefined();
    const low = setClipColor(one(), "a", { lutIntensity: -1 }).timeline;
    expect(findClip(low, "a")!.clip.color).toEqual({ lutIntensity: 0 });
  });

  it("锁定轨道上挂不上", () => {
    const locked = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    const t = addLut(locked, lut("L1")).timeline;
    expect(setClipLut(t, "a", "L1").reason).toContain("锁定");
  });
});

describe("clipsUsingEffects", () => {
  it("只挂了 LUT、没调过色的片段也算数", () => {
    let t = addLut(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      { id: "L1", name: "L1", size: 2, rgb: new Float32Array(24) },
    ).timeline;
    t = setClipLut(t, "a", "L1").timeline;
    expect("color" in findClip(t, "a")!.clip).toBe(false);
    expect(clipsUsingEffects(t).map((c) => c.id)).toEqual(["a"]);
  });

  it("静态调色的片段算数", () => {
    const t = setClipColor(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      "a",
      { saturation: 0 },
    ).timeline;
    expect(clipsUsingEffects(t).map((c) => c.id)).toEqual(["a"]);
  });

  it("**只有关键帧、没有静态值**的片段也算数", () => {
    // 这是这个函数最容易写错的地方：那种片段的 color 字段根本不存在
    // （全缺省会被归一化删掉），只看 clip.color 会放行，用户拿到没调色的成片
    const t = setKeyframe(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      "a",
      "hue",
      0,
      1,
    ).timeline;
    expect("color" in findClip(t, "a")!.clip).toBe(false);
    expect(clipsUsingEffects(t).map((c) => c.id)).toEqual(["a"]);
  });

  it("只有摆位关键帧的片段不算数", () => {
    const t = setKeyframe(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      "a",
      "x",
      0,
      50,
    ).timeline;
    expect(clipsUsingEffects(t)).toEqual([]);
  });

  it("没调过色的项目返回空", () => {
    expect(clipsUsingEffects(timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]))).toEqual([]);
  });
});

describe("关键帧编辑", () => {
  const one = () => timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);

  it("乱序插入后仍按 frame 升序——valueAt 的前提", () => {
    let t = one();
    for (const frame of [50, 10, 30, 0]) {
      t = setKeyframe(t, "a", "x", frame, frame).timeline;
    }
    expect(offsetsOf(t, "a")).toEqual([0, 10, 30, 50]);
  });

  it("同一帧上再打一次是改值，不是插入第二个", () => {
    let t = setKeyframe(one(), "a", "x", 10, 5).timeline;
    t = setKeyframe(t, "a", "x", 10, 99).timeline;
    expect(findClip(t, "a")!.clip.keyframes?.x).toEqual([{ frame: 10, value: 99 }]);
  });

  it("改值时沿用已有缓动，显式传才覆盖", () => {
    let t = setKeyframe(one(), "a", "x", 0, 0, "ease-in").timeline;
    t = setKeyframe(t, "a", "x", 0, 20).timeline;
    expect(findClip(t, "a")!.clip.keyframes?.x?.[0]?.easing).toBe("ease-in");
    t = setKeyframe(t, "a", "x", 0, 20, "linear").timeline;
    expect(findClip(t, "a")!.clip.keyframes?.x?.[0]?.easing).toBe("linear");
  });

  it("关键帧上的值同样被夹住", () => {
    const t = setKeyframe(one(), "a", "opacity", 0, 5).timeline;
    expect(findClip(t, "a")!.clip.keyframes?.opacity?.[0]?.value).toBe(1);
  });

  it("拒绝非整数偏移", () => {
    expect(setKeyframe(one(), "a", "x", 1.5, 0).reason).toContain("整数帧");
  });

  it("删掉最后一个关键帧时 keyframes 字段整个消失", () => {
    // 留着 {} 的话，"这个片段有没有动画"就不能靠字段判断了
    const t = setKeyframe(one(), "a", "x", 10, 5).timeline;
    const r = removeKeyframe(t, "a", "x", 10);
    expect("keyframes" in findClip(r.timeline, "a")!.clip).toBe(false);
  });

  it("删不存在的关键帧要给出原因，不静默", () => {
    expect(removeKeyframe(one(), "a", "x", 10).reason).toContain("没有关键帧");
  });

  describe("移动关键帧（D10 留下的那笔债）", () => {
    const two = () => {
      let t = setKeyframe(one(), "a", "x", 10, 50, "ease-in").timeline;
      t = setKeyframe(t, "a", "x", 60, 200).timeline;
      return t;
    };

    it("值和缓动都跟着走", () => {
      // 缓动归**左端**关键帧所有、管的是它右边那一段（D10），所以它是这个关键帧
      // 自己的属性而不是位置的属性——留在原位就等于把两段曲线都改了
      const t = moveKeyframe(two(), "a", "x", 10, 30).timeline;
      expect(findClip(t, "a")!.clip.keyframes?.x).toEqual([
        { frame: 30, value: 50, easing: "ease-in" },
        { frame: 60, value: 200 },
      ]);
    });

    it("挪过另一个关键帧之后仍按 frame 升序——valueAt 的前提", () => {
      const t = moveKeyframe(two(), "a", "x", 10, 80).timeline;
      expect(offsetsOf(t, "a")).toEqual([60, 80]);
    });

    it("目标位置已有关键帧时拒绝，不覆盖", () => {
      // 覆盖会静默吃掉一个用户自己打的点，是"选了 A 拿到 B"
      const r = moveKeyframe(two(), "a", "x", 10, 60);
      expect(r.changed).toBe(false);
      expect(r.reason).toContain("已经有一个关键帧");
      expect(offsetsOf(r.timeline, "a")).toEqual([10, 60]);
    });

    it("原地不动是「值没变」，不是失败", () => {
      // 给了 reason 的话，拖到边界后状态栏会一直闪红字
      const r = moveKeyframe(two(), "a", "x", 10, 10);
      expect(r.changed).toBe(false);
      expect(r.reason).toBeUndefined();
    });

    it("源位置没有关键帧时给出原因", () => {
      expect(moveKeyframe(two(), "a", "x", 11, 20).reason).toContain("没有关键帧");
    });

    it("拒绝非整数目标", () => {
      expect(moveKeyframe(two(), "a", "x", 10, 20.5).reason).toContain("整数帧");
    });

    it("锁定轨道上拒绝", () => {
      let t = two();
      t = { ...t, tracks: t.tracks.map((tr) => ({ ...tr, locked: true })) };
      expect(moveKeyframe(t, "a", "x", 10, 20).reason).toContain("锁定");
    });

    it("允许挪到片段之外——那种偏移在数据上是合法的", () => {
      // D10 定的语义是片段外的关键帧保留不删、裁回去还能用。夹回范围是界面的事
      const t = moveKeyframe(two(), "a", "x", 10, -5).timeline;
      expect(offsetsOf(t, "a")).toEqual([-5, 60]);
    });

    it("只动被指名的那条通道", () => {
      let t = setKeyframe(two(), "a", "opacity", 10, 0.5).timeline;
      t = moveKeyframe(t, "a", "x", 10, 20).timeline;
      const channels = findClip(t, "a")!.clip.keyframes;
      expect(channels?.x?.map((k) => k.frame)).toEqual([20, 60]);
      expect(channels?.opacity?.map((k) => k.frame)).toEqual([10]);
    });
  });

  it("关闭动画时把当前值烘进静态变换，画面不跳走", () => {
    let t = setKeyframe(one(), "a", "x", 0, 0).timeline;
    t = setKeyframe(t, "a", "x", 50, 200).timeline;
    const r = clearKeyframes(t, "a", "x", 120);
    const after = findClip(r.timeline, "a")!.clip;
    expect("keyframes" in after).toBe(false);
    expect(after.transform).toEqual({ x: 120 });
  });

  it("不传烘焙值就只删关键帧", () => {
    const t = setKeyframe(one(), "a", "x", 0, 77).timeline;
    const after = findClip(clearKeyframes(t, "a", "x").timeline, "a")!.clip;
    expect("keyframes" in after).toBe(false);
    expect("transform" in after).toBe(false);
  });
});

describe("文字片段", () => {
  const one = () => timeline([{ id: "T1", kind: "video", clips: [textClip("tt", 0, 100)] }]);

  it("改内容", () => {
    const r = setTextContent(one(), "tt", "你好");
    expect(r.changed).toBe(true);
    const c = findClip(r.timeline, "tt")!.clip;
    expect(c.kind === "text" && c.text).toBe("你好");
  });

  it("素材片段上改文字要被拒", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);
    expect(setTextContent(t, "a", "x").reason).toContain("不是文字片段");
  });

  it("样式比例被夹在合理范围内", () => {
    const r = setTextStyle(one(), "tt", { fontSizeRatio: 9 });
    const c = findClip(r.timeline, "tt")!.clip;
    expect(c.kind === "text" && c.style?.fontSizeRatio).toBe(1);
  });

  it("清空最后一项样式时 style 字段整个消失", () => {
    const t = setTextStyle(one(), "tt", { color: "#ff0000" }).timeline;
    const r = setTextStyle(t, "tt", { color: undefined });
    expect("style" in findClip(r.timeline, "tt")!.clip).toBe(false);
  });

  it("同值重设不产生变更", () => {
    const t = setTextStyle(one(), "tt", { color: "#ff0000" }).timeline;
    const again = setTextStyle(t, "tt", { color: "#ff0000" });
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("认不出的颜色当场拒掉，不写进 EDL", () => {
    // `ctx.shadowColor = "乱码"` **不抛错**，赋值被整个忽略、保持上一个值，
    // 新建的上下文里那是透明黑——表现是"颜色调了没反应"。所以要在入口挡住
    for (const bad of ["papayawhip", "hsl(0 100% 50%)", "#12345"]) {
      const r = setTextStyle(one(), "tt", { shadowColor: bad });
      expect(r.changed).toBe(false);
      expect(r.reason).toContain("认不出这个颜色");
    }
  });

  it("三个颜色项都校验，不只阴影", () => {
    expect(setTextStyle(one(), "tt", { color: "red" }).changed).toBe(false);
    expect(setTextStyle(one(), "tt", { strokeColor: "red" }).changed).toBe(false);
  });

  it("带 alpha 的写法照常收下", () => {
    const t = setTextStyle(one(), "tt", { shadowColor: "rgba(255, 0, 0, 0.4)" });
    const c = findClip(t.timeline, "tt")!.clip;
    expect(c.kind === "text" && c.style?.shadowColor).toBe("rgba(255, 0, 0, 0.4)");
  });
});

describe("新建文字片段", () => {
  const layout = (): Timeline =>
    timeline([
      { id: "T1", kind: "video", clips: [] },
      { id: "V1", kind: "video", clips: [] },
      { id: "A1", kind: "audio", clips: [] },
    ]);

  it("默认落在最上面那条画面轨，并交回 id", () => {
    const r = addTextClip(layout(), { timelineIn: 30, durationFrames: 90, text: "标题" });
    expect(r.changed).toBe(true);
    expect(r.clipId).toBeTruthy();
    expect(findClip(r.timeline, r.clipId!)!.track.id).toBe("T1");
    expect(findClip(r.timeline, r.clipId!)!.clip.timelineOut).toBe(120);
  });

  it("最上面那条被占用时顺延到下一条画面轨", () => {
    const t = timeline([
      { id: "T1", kind: "video", clips: [textClip("old", 0, 100)] },
      { id: "V1", kind: "video", clips: [] },
      { id: "A1", kind: "audio", clips: [] },
    ]);
    const r = addTextClip(t, { timelineIn: 50, durationFrames: 30, text: "标题" });
    expect(findClip(r.timeline, r.clipId!)!.track.id).toBe("V1");
  });

  it("所有画面轨都放不下时给出原因，不静默", () => {
    const t = timeline([
      { id: "T1", kind: "video", clips: [textClip("x", 0, 100)] },
      { id: "V1", kind: "video", clips: [clip("y", 0, 100)] },
    ]);
    const r = addTextClip(t, { timelineIn: 50, durationFrames: 30, text: "标题" });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("重叠");
    expect(r.clipId).toBeUndefined();
  });

  it("指定音频轨要被拒——那儿的文字层没有含义，而且搬不走", () => {
    const r = addTextClip(layout(), {
      timelineIn: 0,
      durationFrames: 30,
      text: "x",
      trackId: "A1",
    });
    expect(r.reason).toContain("画面轨");
  });

  it("时长至少 1 帧", () => {
    const r = addTextClip(layout(), { timelineIn: 0, durationFrames: 0, text: "x" });
    expect(r.reason).toContain("1 帧");
  });
});

// ---------------------------------------------------------------------------
// 转场
// ---------------------------------------------------------------------------

describe("setTransition", () => {
  const adjacent = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200, 100)] },
    ]);
  const dissolve = (frames: number): Transition => ({ kind: "dissolve", frames });

  it("给紧邻的入场片段加转场", () => {
    const r = setTransition(adjacent(), "b", dissolve(20));
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toEqual(dissolve(20));
  });

  it("前面是空档时拒绝——没有可以溶解过来的东西", () => {
    const tl = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 80), clip("b", 100, 200)] },
    ]);
    const r = setTransition(tl, "b", dissolve(20));
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("没有紧邻");
  });

  it("时间轴上第一个片段拒绝", () => {
    const r = setTransition(adjacent(), "a", dissolve(20));
    expect(r.changed).toBe(false);
  });

  const audioAdjacent = () =>
    timeline([
      { id: "A1", kind: "audio", clips: [clip("a", 0, 100), clip("b", 100, 200, 100)] },
    ]);
  const xfade = (frames: number): Transition => ({ kind: "xfade-power", frames });

  it("画面转场落在音频轨上拒绝——那上面没有像素可混", () => {
    const r = setTransition(audioAdjacent(), "b", dissolve(20));
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("声音转场");
  });

  it("声音转场落在画面轨上也拒绝——两个方向都要挡", () => {
    const r = setTransition(adjacent(), "b", xfade(20));
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("画面转场");
  });

  it("音频轨上加交叉淡化", () => {
    const r = setTransition(audioAdjacent(), "b", xfade(20));
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toEqual(xfade(20));
  });

  it("两种淡化曲线可以互换，不会被当成「值没变」", () => {
    const power = setTransition(audioAdjacent(), "b", xfade(20)).timeline;
    const linear = setTransition(power, "b", { kind: "xfade-linear", frames: 20 });
    expect(linear.changed).toBe(true);
  });

  it("时长越界拒绝并给出范围", () => {
    expect(setTransition(adjacent(), "b", dissolve(1)).reason).toContain("帧之间");
    expect(setTransition(adjacent(), "b", dissolve(99999)).reason).toContain("帧之间");
  });

  it("素材余量不足**不**拒绝——最常见的用法恰恰一帧余量都没有", () => {
    // 源片只有 200 帧，两段各用 100 帧用满
    const tl = timeline(
      [{ id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200, 100)] }],
      200,
    );
    expect(setTransition(tl, "b", dissolve(20)).changed).toBe(true);
  });

  it("传 undefined 摘掉，且字段整个删掉不留 undefined", () => {
    const added = setTransition(adjacent(), "b", dissolve(20)).timeline;
    const removed = setTransition(added, "b").timeline;
    expect("transitionIn" in (findClip(removed, "b")!.clip as object)).toBe(false);
  });

  it("值没变时返回 changed:false 且不给 reason", () => {
    const added = setTransition(adjacent(), "b", dissolve(20)).timeline;
    const again = setTransition(added, "b", dissolve(20));
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });
});

describe("转场的孤儿清理", () => {
  const dissolve = (frames: number): Transition => ({ kind: "dissolve", frames });
  const withTransition = () =>
    timeline([
      {
        id: "V1",
        kind: "video",
        clips: [
          clip("a", 0, 100),
          { ...clip("b", 100, 200, 100), transitionIn: dissolve(20) },
        ],
      },
    ]);

  it("把入场片段拖开之后转场被清掉", () => {
    const r = moveClip(withTransition(), "b", 40);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toBeUndefined();
  });

  it("把出场片段裁短之后转场被清掉", () => {
    const r = trimClip(withTransition(), "a", "out", -20);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toBeUndefined();
  });

  it("删掉出场片段之后转场被清掉", () => {
    const r = removeClip(withTransition(), "a");
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toBeUndefined();
  });

  it("跨轨拖到音频轨会被移动本身拒绝，转场不受影响", () => {
    const tl = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [clip("a", 0, 100), { ...clip("b", 100, 200, 100), transitionIn: dissolve(20) }],
      },
      { id: "A1", kind: "audio", clips: [] },
    ]);
    const r = moveClip(tl, "b", 0, { toTrack: "A1" });
    expect(r.changed).toBe(false);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toEqual(dissolve(20));
  });

  it("种类和轨道对不上时清掉——画面转场混的是像素，音频轨上没有", () => {
    // 只有绕过 setTransition 直接造 EDL 才到得了这个状态（片段不能跨轨道种类拖），
    // 所以这条兜的是"将来某个新编辑操作忘了校验"
    const tl = timeline([
      {
        id: "A1",
        kind: "audio",
        clips: [clip("a", 0, 100), { ...clip("b", 100, 200, 100), transitionIn: dissolve(20) }],
      },
    ]);
    // withClips 在任意一次编辑后归一化，这里借移动触发
    const r = moveClip(tl, "a", 0, { toTrack: "A1" });
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toBeUndefined();
  });

  it("声音转场在音频轨上不会被清掉", () => {
    const tl = timeline([
      {
        id: "A1",
        kind: "audio",
        clips: [
          clip("a", 0, 100),
          { ...clip("b", 100, 200, 100), transitionIn: { kind: "xfade-power", frames: 20 } },
        ],
      },
    ]);
    const r = trimClip(tl, "a", "in", 10);
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toEqual({
      kind: "xfade-power",
      frames: 20,
    });
  });

  it("相邻关系还在时不清——只是片段太短解不出窗口也保留", () => {
    // B 只有 2 帧，20 帧的转场解出来只剩 2 帧，但字段要留着
    const tl = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [clip("a", 0, 100), { ...clip("b", 100, 102, 100), transitionIn: dissolve(20) }],
      },
    ]);
    const r = setClipTransform(tl, "b", { opacity: 0.5 });
    expect(findClip(r.timeline, "b")?.clip.transitionIn).toEqual(dissolve(20));
  });

  it("切分不会让右半段继承转场——否则按一下 ⌘K 就凭空多一个溶解", () => {
    const r = splitClipAt(withTransition(), "b", 150);
    const clips = r.timeline.tracks[0]!.clips;
    expect(clips.map((c) => c.transitionIn?.frames)).toEqual([undefined, 20, undefined]);
  });
});

describe("junctionInfo", () => {
  const dissolve = (frames: number): Transition => ({ kind: "dissolve", frames });

  it("余量充足时不报定格", () => {
    const tl = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [clip("a", 0, 100, 200), { ...clip("b", 100, 200, 400), transitionIn: dissolve(20) }],
      },
    ]);
    expect(junctionInfo(tl, "b")).toMatchObject({
      effectiveFrames: 20,
      shortfall: { from: 0, to: 0 },
    });
  });

  it("两段满长素材相邻时两侧都报满定格", () => {
    const tl = timeline(
      [
        {
          id: "V1",
          kind: "video",
          clips: [clip("a", 0, 100, 0), { ...clip("b", 100, 200, 0), transitionIn: dissolve(20) }],
        },
      ],
      100,
    );
    expect(junctionInfo(tl, "b")).toMatchObject({
      effectiveFrames: 20,
      shortfall: { from: 10, to: 10 },
    });
  });

  it("报的是**实际**窗口长度，不是用户输入的时长", () => {
    // B 只有 10 帧 → 最多借 5 → 实际 10 帧，而不是输入的 40
    const tl = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [clip("a", 0, 100, 200), { ...clip("b", 100, 110, 400), transitionIn: dissolve(40) }],
      },
    ]);
    expect(junctionInfo(tl, "b")?.effectiveFrames).toBe(10);
  });

  it("没有前驱时给出 previous:null，界面据此禁掉添加", () => {
    const tl = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]);
    expect(junctionInfo(tl, "a")).toMatchObject({ previous: null, transition: null });
  });
});

// ---------------------------------------------------------------------------
// 导入素材
// ---------------------------------------------------------------------------

describe("导入素材", () => {
  /** 空项目的轨道布局，顺序与 `EMPTY_TIMELINE` 一致（T1 在最上）。 */
  const emptyLayout = (): Timeline => ({
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: 0,
    tracks: [
      { id: "T1", kind: "video", clips: [] },
      { id: "V2", kind: "video", clips: [] },
      { id: "V1", kind: "video", clips: [] },
      { id: "A1", kind: "audio", clips: [] },
      { id: "A2", kind: "audio", clips: [] },
    ],
    sources: [],
  });

  const video = (id: string, over: Partial<AvSource> = {}): AvSource => ({
    ...source(id, 300),
    ...over,
  }) as AvSource;

  const music = (id: string, over: Partial<AudioOnlySource> = {}): AudioOnlySource => ({
    id,
    kind: "audio",
    name: `${id}.mp3`,
    file: new File([], `${id}.mp3`),
    hasAudio: true,
    audioCodec: "mp3",
    durationMicros: 10_000_000,
    sampleRate: 44_100,
    channels: 2,
    ...over,
  });

  const trackClips = (tl: Timeline, id: string) => tl.tracks.find((t) => t.id === id)!.clips;

  it("带音轨的画面素材同时铺到 V1 和 A1，两个片段起点相同", () => {
    const r = addSource(emptyLayout(), { source: video("v1"), timelineIn: 0 });
    expect(r.changed).toBe(true);
    expect(trackClips(r.timeline, "V1")).toHaveLength(1);
    expect(trackClips(r.timeline, "A1")).toHaveLength(1);
    expect(trackClips(r.timeline, "V1")[0]!.timelineIn).toBe(
      trackClips(r.timeline, "A1")[0]!.timelineIn,
    );
    // **画面轨的候选顺序是自下而上**：素材该落在 V1，不是最上面的字幕轨
    expect(trackClips(r.timeline, "T1")).toHaveLength(0);
    expect(r.clipIds).toEqual(["v1-v", "v1-a"]);
  });

  it("纯音频素材只铺音频轨，一个画面片段都不产生", () => {
    const r = addSource(emptyLayout(), { source: music("m1"), timelineIn: 0 });
    expect(r.changed).toBe(true);
    expect(trackClips(r.timeline, "A1")).toHaveLength(1);
    expect(trackClips(r.timeline, "V1")).toHaveLength(0);
    expect(r.clipIds).toEqual(["m1-a"]);
    // 长度按项目帧率派生：10 秒 × 30000/1001 = 299 帧
    expect(trackClips(r.timeline, "A1")[0]!.timelineOut).toBe(299);
  });

  it("第二次导入是**追加**，不会把第一次的编辑清掉", () => {
    const first = addSource(emptyLayout(), { source: video("v1"), timelineIn: 0 });
    const second = addSource(first.timeline, { source: music("m1"), timelineIn: 0 });
    expect(second.changed).toBe(true);
    expect(second.timeline.sources.map((s) => s.id)).toEqual(["v1", "m1"]);
    // 视频的画面和声音都还在原处
    expect(trackClips(second.timeline, "V1")).toHaveLength(1);
    expect(trackClips(second.timeline, "A1")).toHaveLength(1);
    // 配乐落到 A2（A1 被视频的音轨占了），而不是顶掉它
    expect(trackClips(second.timeline, "A2")).toHaveLength(1);
    expect(trackClips(second.timeline, "A2")[0]!.id).toBe("m1-a");
  });

  it("放在播放头处：起点就是传进来的那一帧", () => {
    const r = addSource(emptyLayout(), { source: music("m1"), timelineIn: 120 });
    expect(trackClips(r.timeline, "A1")[0]!.timelineIn).toBe(120);
    expect(trackClips(r.timeline, "A1")[0]!.timelineOut).toBe(120 + 299);
  });

  it("空时间轴时项目帧率和画布跟着画面素材走", () => {
    const r = addSource(emptyLayout(), {
      source: video("v1", { fps: FPS.film24, width: 640, height: 360 }),
      timelineIn: 0,
    });
    expect(r.timeline.fps).toEqual(FPS.film24);
    expect(r.timeline.width).toBe(640);
    expect(r.timeline.height).toBe(360);
  });

  it("时间轴上已经有片段时**绝不**改项目帧率——那会把所有音频片段的入点重新解释一遍", () => {
    const first = addSource(emptyLayout(), { source: music("m1"), timelineIn: 0 });
    const second = addSource(first.timeline, {
      source: video("v1", { fps: FPS.film24, width: 640, height: 360 }),
      timelineIn: 0,
    });
    expect(second.timeline.fps).toEqual(FPS.ndf2997);
    expect(second.timeline.width).toBe(1920);
    // 配乐的占位一帧都没动
    expect(trackClips(second.timeline, "A1")[0]!.timelineOut).toBe(299);
  });

  it("纯音频素材不会改项目帧率，哪怕时间轴是空的", () => {
    const r = addSource(emptyLayout(), { source: music("m1"), timelineIn: 0 });
    expect(r.timeline.fps).toEqual(FPS.ndf2997);
    expect(r.timeline.width).toBe(1920);
  });

  it("音频放不下时整体拒绝，不允许「画面放下了、声音挪到别处」", () => {
    const tl = emptyLayout();
    const blocked: Timeline = {
      ...tl,
      tracks: tl.tracks.map((t) =>
        t.kind === "audio" ? { ...t, clips: [clip(`${t.id}-old`, 0, 400)] } : t,
      ),
      sources: [source("src", 1000)],
    };
    const r = addSource(blocked, { source: video("v1"), timelineIn: 0 });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("音频轨");
    // 画面片段和素材都不能留下——半成品比失败更坏
    expect(trackClips(r.timeline, "V1")).toHaveLength(0);
    expect(r.timeline.sources.map((s) => s.id)).toEqual(["src"]);
  });

  const photo = (id: string, over: Partial<ImageSource> = {}): ImageSource => ({
    id,
    kind: "image",
    name: `${id}.png`,
    file: new File([], `${id}.png`),
    hasAudio: false,
    audioCodec: null,
    width: 1200,
    height: 800,
    mimeType: "image/png",
    frameCount: 1,
    ...over,
  });

  it("图片落在画面轨上，长度是缺省秒数（它没有源片长度）", () => {
    const r = addSource(emptyLayout(), { source: photo("p1"), timelineIn: 0 });
    expect(r.changed).toBe(true);
    const clips = trackClips(r.timeline, "V1");
    expect(clips).toHaveLength(1);
    // 29.97 下 5 秒 = 150 帧（round(5 × 30000/1001)）
    expect(clips[0]!.timelineOut - clips[0]!.timelineIn).toBe(
      Math.round((IMAGE_DEFAULT_SECONDS * 30000) / 1001),
    );
    expect(r.clipIds).toEqual(["p1-i"]);
  });

  it("图片片段是 `kind:\"image\"`，而且**没有 sourceIn**", () => {
    const r = addSource(emptyLayout(), { source: photo("p1"), timelineIn: 0 });
    const clip = trackClips(r.timeline, "V1")[0]!;
    expect(clip.kind).toBe("image");
    expect("sourceIn" in clip).toBe(false);
  });

  it("图片不产生音频片段", () => {
    const r = addSource(emptyLayout(), { source: photo("p1"), timelineIn: 0 });
    expect(trackClips(r.timeline, "A1")).toHaveLength(0);
    expect(trackClips(r.timeline, "A2")).toHaveLength(0);
  });

  it("图片**不改**项目帧率和画布，哪怕时间轴是空的", () => {
    // 它没有帧率可给；而画布跟着一张图走会让"导入一张竖图"把整个项目变成竖屏
    const r = addSource(emptyLayout(), {
      source: photo("p1", { width: 800, height: 1200 }),
      timelineIn: 0,
    });
    expect(r.timeline.fps).toEqual(FPS.ndf2997);
    expect(r.timeline.width).toBe(1920);
    expect(r.timeline.height).toBe(1080);
  });

  it("V1 被占时顺延到 V2，不会跑到最上面的字幕轨", () => {
    const first = addSource(emptyLayout(), { source: photo("p1"), timelineIn: 0 });
    const second = addSource(first.timeline, { source: photo("p2"), timelineIn: 0 });
    expect(trackClips(second.timeline, "V2")).toHaveLength(1);
    expect(trackClips(second.timeline, "T1")).toHaveLength(0);
  });

  it("同一个素材 id 不能进两次", () => {
    const first = addSource(emptyLayout(), { source: video("v1"), timelineIn: 0 });
    const again = addSource(first.timeline, { source: video("v1"), timelineIn: 400 });
    expect(again.changed).toBe(false);
    expect(again.reason).toContain("已经在项目里");
  });

  it("起点必须是非负整数帧", () => {
    expect(addSource(emptyLayout(), { source: music("m"), timelineIn: -1 }).reason).toContain(
      "非负整数帧",
    );
    expect(addSource(emptyLayout(), { source: music("m"), timelineIn: 1.5 }).reason).toContain(
      "非负整数帧",
    );
  });

  it("锁定的轨道会被跳过", () => {
    const tl = emptyLayout();
    const locked: Timeline = {
      ...tl,
      tracks: tl.tracks.map((t) => (t.id === "A1" ? { ...t, locked: true } : t)),
    };
    const r = addSource(locked, { source: music("m1"), timelineIn: 0 });
    expect(trackClips(r.timeline, "A2")).toHaveLength(1);
    expect(trackClips(r.timeline, "A1")).toHaveLength(0);
  });
});

describe("裁切纯音频片段", () => {
  const withMusic = (): Timeline => ({
    fps: FPS.ntsc30,
    width: 1920,
    height: 1080,
    durationFrames: 100,
    tracks: [{ id: "A1", kind: "audio", clips: [clip("m", 0, 100)] }],
    sources: [
      {
        id: "src",
        kind: "audio",
        name: "m.mp3",
        file: new File([], "m.mp3"),
        hasAudio: true,
        audioCodec: "mp3",
        // 5 秒，30fps 下正好 150 帧
        durationMicros: 5_000_000,
        sampleRate: 44_100,
        channels: 2,
      },
    ],
  });

  it("出点最多拉到派生出来的源片末尾（5 秒 × 30fps = 150 帧）", () => {
    expect(trimClip(withMusic(), "m", "out", 50).changed).toBe(true);
    const over = trimClip(withMusic(), "m", "out", 51);
    expect(over.changed).toBe(false);
    expect(over.reason).toContain("源片末尾");
  });
});

describe("裁切图片片段", () => {
  const withPhoto = (): Timeline => ({
    fps: FPS.ntsc30,
    width: 1920,
    height: 1080,
    durationFrames: 100,
    tracks: [
      {
        id: "V1",
        kind: "video",
        clips: [{ id: "p", kind: "image", sourceId: "src", timelineIn: 0, timelineOut: 100 }],
      },
    ],
    sources: [
      {
        id: "src",
        kind: "image",
        name: "p.png",
        file: new File([], "p.png"),
        hasAudio: false,
        audioCodec: null,
        width: 1200,
        height: 800,
        mimeType: "image/png",
        frameCount: 1,
      },
    ],
  });

  it("出点想拉多长都行——图片没有「源片末尾」", () => {
    const r = trimClip(withPhoto(), "p", "out", 100_000);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "p")!.clip.timelineOut).toBe(100_100);
  });

  it("裁入点不碰 sourceIn（它根本没有），但仍然平移关键帧", () => {
    const tl = withPhoto();
    const withKeys = {
      ...tl,
      tracks: tl.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) => ({ ...c, keyframes: { opacity: [{ frame: 20, value: 0.5 }] } })),
      })),
    } as Timeline;
    const r = trimClip(withKeys, "p", "in", 10);
    expect(r.changed).toBe(true);
    const clip = findClip(r.timeline, "p")!.clip;
    expect("sourceIn" in clip).toBe(false);
    // 起点右移 10 帧，关键帧偏移跟着减 10（同素材片段，见 shiftKeyframes）
    expect(clip.keyframes?.opacity?.[0]?.frame).toBe(10);
  });

  it("切分不给右半段推进 sourceIn", () => {
    const r = splitClipAt(withPhoto(), "p", 40);
    expect(r.changed).toBe(true);
    const halves = r.timeline.tracks[0]!.clips;
    expect(halves).toHaveLength(2);
    for (const half of halves) {
      expect(half.kind).toBe("image");
      expect("sourceIn" in half).toBe(false);
    }
    expect(halves[1]!.timelineIn).toBe(40);
  });

  it("图片片段没有音量", () => {
    const r = setClipVolume(withPhoto(), "p", 0.5);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("只有素材片段有音量");
  });
});

describe("项目名（D37）", () => {
  const emptyLayout = (): Timeline => ({
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: 0,
    tracks: [
      { id: "V1", kind: "video", clips: [] },
      { id: "A1", kind: "audio", clips: [] },
    ],
    sources: [],
  });

  it("导入第一个素材时自动用素材名", () => {
    const r = addSource(emptyLayout(), { source: source("v1", 300), timelineIn: 0 });
    expect(r.changed).toBe(true);
    expect(r.timeline.name).toBe("v1.mp4");
    // 自动取名不算"用户给的"
    expect(r.timeline.namedByUser).toBeUndefined();
  });

  it("自动取名只做一次：第二个素材不改名", () => {
    const first = addSource(emptyLayout(), { source: source("v1", 300), timelineIn: 0 });
    const second = addSource(first.timeline, {
      source: { ...source("v2", 300), id: "v2", name: "v2.mp4" },
      timelineIn: 400,
    });
    expect(second.changed).toBe(true);
    expect(second.timeline.name).toBe("v1.mp4");
  });

  it("用户重命名过之后，导入素材不再自动改名", () => {
    const named = renameProject(emptyLayout(), "婚礼粗剪");
    expect(named.changed).toBe(true);
    expect(named.timeline.name).toBe("婚礼粗剪");
    expect(named.timeline.namedByUser).toBe(true);
    const r = addSource(named.timeline, { source: source("v1", 300), timelineIn: 0 });
    expect(r.changed).toBe(true);
    // 少这个条件的表现是"我改了名字，导入一个素材，名字被改回去了"
    expect(r.timeline.name).toBe("婚礼粗剪");
  });

  it("导入被拒时名字不动", () => {
    const r = addSource(emptyLayout(), { source: source("v1", 300), timelineIn: -1 });
    expect(r.changed).toBe(false);
    expect(r.timeline.name).toBeUndefined();
  });

  it("重命名去掉首尾空白；空白名拒绝而不是清空", () => {
    const ok = renameProject(emptyLayout(), "  成片 v2  ");
    expect(ok.changed).toBe(true);
    expect(ok.timeline.name).toBe("成片 v2");

    const blank = renameProject(emptyLayout(), "   ");
    expect(blank.changed).toBe(false);
    expect(blank.reason).toContain("空白");
  });

  it("重命名成同一个名字是'值没变'，不进撤销栈也不算失败", () => {
    const named = renameProject(emptyLayout(), "成片").timeline;
    const again = renameProject(named, "成片");
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("把自动取的名原样确认一遍也算一次编辑：从此它是用户给的", () => {
    const auto = addSource(emptyLayout(), { source: source("v1", 300), timelineIn: 0 }).timeline;
    const confirmed = renameProject(auto, "v1.mp4");
    // 名字字符串没变，但 namedByUser 变了——这次提交护住"以后不再自动改名"
    expect(confirmed.changed).toBe(true);
    expect(confirmed.timeline.namedByUser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 变速（D39）
// ---------------------------------------------------------------------------

const SPEED_2X = { num: 2, den: 1 };
const SPEED_HALF = { num: 1, den: 2 };

function speedTimeline(sourceDuration = 1000): Timeline {
  return timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }], sourceDuration);
}

describe("setClipSpeed：保内容、改长度", () => {
  it("2× 让片段占位减半，源片跨度不变", () => {
    const r = setClipSpeed(speedTimeline(), "a", SPEED_2X);
    expect(r.changed).toBe(true);
    const c = media(findClip(r.timeline, "a")?.clip);
    expect(c.timelineIn).toBe(0);
    expect(c.timelineOut).toBe(50);
    expect(c.speed).toEqual(SPEED_2X);
    // 50 帧 × 2 = 原来那 100 帧内容（末帧算法见 clipSourceFrames）
    expect(clipSourceFrames(c)).toBe(99);
  });

  it("0.5× 让片段占位翻倍", () => {
    const c = media(findClip(setClipSpeed(speedTimeline(), "a", SPEED_HALF).timeline, "a")?.clip);
    expect(c.timelineOut).toBe(200);
    expect(c.speed).toEqual(SPEED_HALF);
  });

  it("**改回 1× 要把字段整个删掉**，不留 {num:1,den:1}", () => {
    // 取帧那条"不乘不除"的原路径判的是这个字段，见 MediaClip.speed
    const fast = setClipSpeed(speedTimeline(), "a", SPEED_2X).timeline;
    const back = setClipSpeed(fast, "a", { num: 1, den: 1 }).timeline;
    const c = media(findClip(back, "a")?.clip);
    expect("speed" in c).toBe(false);
    // 长度也回到原样
    expect(c.timelineOut).toBe(100);
  });

  it("从 2× 改到 4×：新长度按老速度算，不是按原始长度", () => {
    const fast = setClipSpeed(speedTimeline(), "a", SPEED_2X).timeline; // 50 帧
    const faster = setClipSpeed(fast, "a", { num: 4, den: 1 }).timeline;
    expect(media(findClip(faster, "a")?.clip).timelineOut).toBe(25);
  });

  it("倍数会归一化（4/2 就是 2×）", () => {
    const c = media(findClip(setClipSpeed(speedTimeline(), "a", { num: 4, den: 2 }).timeline, "a")?.clip);
    expect(c.speed).toEqual(SPEED_2X);
  });

  it("同一个速度再设一次是「值没变」，不是失败", () => {
    const fast = setClipSpeed(speedTimeline(), "a", SPEED_2X).timeline;
    const again = setClipSpeed(fast, "a", SPEED_2X);
    expect(again.changed).toBe(false);
    expect(again.reason).toBeUndefined();
  });

  it("**放不下就拒绝，不隐式推走后面的片段**", () => {
    // 变慢要变长，撞到后面那个片段。静默波纹是"选了 A 拿到 B"
    const tl = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    ]);
    const r = setClipSpeed(tl, "a", SPEED_HALF);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("放不下");
    // 后面那个片段一个字段都没动
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(100);
  });

  it("倒放和 0 一律拒绝", () => {
    for (const bad of [{ num: -2, den: 1 }, { num: 0, den: 1 }, { num: 1, den: -2 }]) {
      const r = setClipSpeed(speedTimeline(), "a", bad);
      expect(r.changed).toBe(false);
      expect(r.reason).toContain("正数");
    }
  });

  it("超出范围拒绝，不夹紧", () => {
    // 夹紧的话用户输入 100× 会拿到 8×，而输入框里还写着 100
    const r = setClipSpeed(speedTimeline(), "a", { num: 100, den: 1 });
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("速度只支持");
  });

  it("文字片段不能变速", () => {
    const tl = timeline([{ id: "T1", kind: "video", clips: [textClip("t", 0, 100)] }]);
    expect(setClipSpeed(tl, "t", SPEED_2X).reason).toContain("只有素材片段");
  });

  it("锁定轨道上不能变速", () => {
    const tl = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)], locked: true },
    ]);
    expect(setClipSpeed(tl, "a", SPEED_2X).reason).toContain("锁定");
  });

  it("关键帧**不跟着缩**", () => {
    // 偏移相对片段起点、单位是时间轴帧，属于时间轴侧。缩了的话"第 10 帧放大"
    // 会变成一个用户没打过的位置
    const tl = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [{ ...clip("a", 0, 100), keyframes: { scaleX: [{ frame: 10, value: 1.2 }] } }],
      },
    ]);
    const c = media(findClip(setClipSpeed(tl, "a", SPEED_2X).timeline, "a")?.clip);
    expect(c.keyframes?.scaleX?.[0]?.frame).toBe(10);
  });
});

describe("变速片段的裁切与切分", () => {
  function fast(): Timeline {
    return timeline([
      { id: "V1", kind: "video", clips: [{ ...clip("a", 0, 50), speed: SPEED_2X }] },
    ]);
  }

  it("裁入点：时间轴裁 1 帧，源片跳 2 帧", () => {
    const c = media(findClip(trimClip(fast(), "a", "in", 10).timeline, "a")?.clip);
    expect(c.timelineIn).toBe(10);
    expect(c.sourceIn).toBe(20);
  });

  it("裁出点：**源片够不够长要按速度算**", () => {
    // 源片只有 120 帧，2× 下 100 帧占位就要 199 帧源片——漏乘的表现是
    // 允许拉出去，而那几帧解不出来 = 那一层画面静默消失
    const tl = timeline(
      [{ id: "V1", kind: "video", clips: [{ ...clip("a", 0, 50), speed: SPEED_2X }] }],
      120,
    );
    const r = trimClip(tl, "a", "out", 20);
    expect(r.changed).toBe(false);
    expect(r.reason).toContain("源片末尾");
    // 原速的同一个片段拉得出去（证明拒绝来自速度，不是来自别的边界）
    const slow = timeline(
      [{ id: "V1", kind: "video", clips: [clip("a", 0, 50)] }],
      120,
    );
    expect(trimClip(slow, "a", "out", 20).changed).toBe(true);
  });

  it("切分：右半段的源片起点按速度推进", () => {
    const r = splitClipAt(fast(), "a", 20);
    const halves = r.timeline.tracks[0]!.clips.map((c) => media(c));
    const right = halves.find((c) => c.timelineIn === 20)!;
    expect(right.sourceIn).toBe(40);
    expect(right.speed).toEqual(SPEED_2X);
  });
});

describe("setClipPreservePitch：只换算法，不动长度", () => {
  it("开关不改长度也不动速度", () => {
    const fast = setClipSpeed(speedTimeline(), "a", SPEED_2X).timeline;
    const on = setClipPreservePitch(fast, "a", true);
    expect(on.changed).toBe(true);
    const c = media(findClip(on.timeline, "a")?.clip);
    expect(c.preservePitch).toBe(true);
    expect(c.timelineOut).toBe(50);
    expect(c.speed).toEqual(SPEED_2X);
  });

  it("**关掉要把字段整个删掉**，不留 preservePitch: false", () => {
    const on = setClipPreservePitch(speedTimeline(), "a", true).timeline;
    const off = setClipPreservePitch(on, "a", false).timeline;
    expect("preservePitch" in media(findClip(off, "a")?.clip)).toBe(false);
  });

  it("原速下也能开——那是用户表达过的偏好，调回 1× 不该把它清掉", () => {
    // 调到 2× → 开保音高 → 调回 1× → 再调到 2×，勾选必须还在
    const on = setClipPreservePitch(setClipSpeed(speedTimeline(), "a", SPEED_2X).timeline, "a", true)
      .timeline;
    const back = setClipSpeed(on, "a", { num: 1, den: 1 }).timeline;
    expect(media(findClip(back, "a")?.clip).preservePitch).toBe(true);
    const again = setClipSpeed(back, "a", SPEED_2X).timeline;
    expect(media(findClip(again, "a")?.clip).preservePitch).toBe(true);
  });

  it("值没变时既不进撤销栈也不算失败", () => {
    const r = setClipPreservePitch(speedTimeline(), "a", false);
    expect(r.changed).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("无音轨的素材上拒绝——设了没反应比拒绝更难查", () => {
    // 显式造一个 AvSource：`{...source(), hasAudio:false}` 会把判别联合摊平成
    // "共有字段"，编译不过（同 D35 那条分配式 Omit）
    const silent: Timeline = {
      ...speedTimeline(),
      sources: [
        {
          id: "src",
          kind: "av",
          name: "src.mp4",
          file: new File([], "src.mp4"),
          fps: FPS.ndf2997,
          width: 1920,
          height: 1080,
          durationFrames: 1000,
          hasAudio: false,
          videoCodec: "avc",
          audioCodec: null,
        },
      ],
    };
    expect(setClipPreservePitch(silent, "a", true).reason).toMatch(/没有音轨/);
  });

  it("文字片段拒绝", () => {
    const withText = addTextClip(speedTimeline(), { timelineIn: 200, durationFrames: 90, text: "字" });
    const textId = withText.clipId!;
    expect(setClipPreservePitch(withText.timeline, textId, true).reason).toMatch(/只有素材片段/);
  });

  it("锁定轨道上拒绝", () => {
    const locked = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    expect(setClipPreservePitch(locked, "a", true).reason).toMatch(/锁定/);
  });
});

describe("复制 / 粘贴 / 副本", () => {
  /** V1 上一个片段 [0,100)，A1 上一个 [0,200)。 */
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 200)] },
    ]);
  const entryOf = (t: Timeline, id: string) => {
    const e = copyClip(t, id);
    if (!e) throw new Error(`复制不到 ${id}`);
    return e;
  };

  it("复制带上原轨道——粘贴要落回同一条轨，而片段自己看不出轨道种类", () => {
    expect(copyClip(base(), "缺")).toBeNull();
    const e = entryOf(base(), "m");
    expect(e.trackId).toBe("A1");
    expect(e.trackKind).toBe("audio");
    expect(e.clip.id).toBe("m");
  });

  it("粘到播放头处，换一个新 id", () => {
    const t = base();
    const r = pasteClip(t, entryOf(t, "a"), 300);
    expect(r.changed).toBe(true);
    expect(r.clipId).toBeDefined();
    expect(r.clipId).not.toBe("a");
    const pasted = findClip(r.timeline, r.clipId!)?.clip;
    expect(pasted?.timelineIn).toBe(300);
    expect(pasted?.timelineOut).toBe(400);
    // 原片段一个字段都没动
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(0);
  });

  it("**连粘三次得到三个不同的片段**", () => {
    // 模块级计数器在页面刷新之后才出错，这里是当场就错——所以这条断言比
    // `newClipId` 那条更近：同一次会话里就必须唯一
    let t = base();
    const entry = entryOf(t, "a");
    const ids: string[] = [];
    for (const at of [300, 500, 700]) {
      const r = pasteClip(t, entry, at);
      expect(r.changed).toBe(true);
      ids.push(r.clipId!);
      t = r.timeline;
    }
    expect(new Set(ids).size).toBe(3);
    expect(t.tracks.find((x) => x.id === "V1")?.clips).toHaveLength(4);
  });

  it("**`transitionIn` 必须整个删掉**，而判据是粘在某个片段**紧后面**", () => {
    // 落点放远了这条断言就没有牙齿：`withClips` 的 `dropOrphanTransitions` 会把断了
    // 交界的转场清掉，于是"忘了删"和"删了"输出相同（实测注入之后全绿）。真正的失效
    // 形态是**新片段紧接着另一个片段**——那时交界成立、归一化不会动它，用户就凭空
    // 多一个自己没加过的溶解，还刚好在新落点上（同 `splitClipAt` 右半段那条）。
    // ⌘D 的落点恰恰永远是"紧后面"，所以这里两条都测。
    const t = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [
          clip("a", 0, 100),
          { ...clip("b", 100, 200), transitionIn: { kind: "dissolve", frames: 20 } },
        ],
      },
    ]);
    const e = entryOf(t, "b");
    expect(e.clip.transitionIn).toBeDefined();

    // 粘在 b 的紧后面：交界成立
    const pastedNext = pasteClip(t, e, 200);
    expect(pastedNext.changed).toBe(true);
    expect("transitionIn" in findClip(pastedNext.timeline, pastedNext.clipId!)!.clip).toBe(false);

    // 副本同理，而它的落点**只可能**是紧后面
    const dup = duplicateClip(t, "b");
    expect(dup.changed).toBe(true);
    expect("transitionIn" in findClip(dup.timeline, dup.clipId!)!.clip).toBe(false);

    // 粘到空地上也不许有（这一条弱，归一化本来也会清掉，留着当第二道）
    const far = pasteClip(t, e, 400);
    expect("transitionIn" in findClip(far.timeline, far.clipId!)!.clip).toBe(false);
  });

  it("关键帧、变换、调色、速度、音量全部照抄，关键帧偏移不动", () => {
    let t = base();
    t = setKeyframe(t, "a", "scaleX", 10, 1.5).timeline;
    t = setKeyframe(t, "a", "scaleX", 60, 2).timeline;
    t = setClipTransform(t, "a", { rotation: 0.5 }).timeline;
    t = setClipColor(t, "a", { brightness: 1.2 }).timeline;
    t = setClipVolume(t, "a", 0.4).timeline;
    t = setClipSpeed(t, "a", SPEED_2X).timeline;

    const r = pasteClip(t, entryOf(t, "a"), 300);
    const pasted = media(findClip(r.timeline, r.clipId!)?.clip);
    expect(pasted.keyframes?.scaleX?.map((k: { frame: number }) => k.frame)).toEqual([10, 60]);
    expect(pasted.transform?.rotation).toBe(0.5);
    expect(pasted.color?.brightness).toBe(1.2);
    expect(pasted.volume).toBe(0.4);
    expect(pasted.speed).toEqual(SPEED_2X);
    expect(pasted.sourceIn).toBe(0);
  });

  it("放不下就拒绝，并报出挡路的是谁——不隐式挪走别人也不换轨道", () => {
    const t = base();
    const r = pasteClip(t, entryOf(t, "a"), 50);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/放不下/);
    // 一个字节都没写进去
    expect(r.timeline).toBe(t);
  });

  it("锁定轨道、原轨道消失、落点非法都拒绝", () => {
    const locked = timeline([
      { id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] },
    ]);
    expect(pasteClip(locked, entryOf(locked, "a"), 300).reason).toMatch(/锁定/);

    const t = base();
    const e = entryOf(t, "a");
    expect(pasteClip(t, { ...e, trackId: "没有这条轨" }, 300).reason).toMatch(/已经不在了/);
    expect(pasteClip(t, { ...e, trackKind: "audio" }, 300).reason).toMatch(/种类变了/);
    expect(pasteClip(t, e, -1).reason).toMatch(/非负整数/);
    expect(pasteClip(t, e, 1.5).reason).toMatch(/非负整数/);
  });

  it("**素材不在当前项目里要拒绝**——粘过去下次打开就崩", () => {
    const t = base();
    const e = entryOf(t, "a");
    // 模拟跨项目：目标项目里没有这个素材（剪贴板活过 openProject）
    const other: Timeline = { ...t, sources: [] };
    const r = pasteClip(other, e, 300);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/不在当前项目里/);
  });

  it("文字片段也能粘，样式跟着走（它没有 sourceId，那条素材检查要放它过去）", () => {
    const added = addTextClip(base(), { timelineIn: 300, durationFrames: 60, text: "标题" });
    const t = setTextStyle(added.timeline, added.clipId!, { color: "#ff0000" }).timeline;
    const r = pasteClip(t, entryOf(t, added.clipId!), 500);
    expect(r.reason).toBeUndefined();
    const pasted = findClip(r.timeline, r.clipId!)?.clip;
    expect(pasted?.kind).toBe("text");
    if (pasted?.kind !== "text") throw new Error("粘出来的不是文字片段");
    expect(pasted.text).toBe("标题");
    expect(pasted.style?.color).toBe("#ff0000");
  });

  it("副本落在原片段的出点上（紧接着它），不取播放头", () => {
    const r = duplicateClip(base(), "a");
    expect(r.changed).toBe(true);
    const copy = findClip(r.timeline, r.clipId!)?.clip;
    expect(copy?.timelineIn).toBe(100);
    expect(copy?.timelineOut).toBe(200);
  });

  it("紧接着的位置被占住时副本被拒", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    ]);
    expect(duplicateClip(t, "a").reason).toMatch(/放不下/);
    expect(duplicateClip(t, "缺").reason).toMatch(/找不到片段/);
  });
});

describe("多选：整组平移", () => {
  /** V1 上 a[0,100) b[200,300)，V2 上 c[400,500)。 */
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 200, 300)] },
      { id: "V2", kind: "video", clips: [clip("c", 400, 500)] },
    ]);

  it("整组同一个位移，跨轨道也一起动", () => {
    const r = moveClips(base(), ["a", "b", "c"], 50);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(50);
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(250);
    expect(findClip(r.timeline, "c")?.clip.timelineIn).toBe(450);
    // 轨道没变
    expect(findClip(r.timeline, "c")?.track.id).toBe("V2");
  });

  it("**移动中的片段之间不算重叠**——否则整组右移一格就撞上自己的同伴", () => {
    // a[0,100) b[100,200) 紧邻。右移 10 帧时 a 的新位置 [10,110) 压在 b 的**原**位置上，
    // 而 b 也在移动。把移动集合排掉是这条的全部内容，漏掉的表现是"多选之后拖不动"
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    ]);
    const r = moveClips(t, ["a", "b"], 10);
    expect(r.reason).toBeUndefined();
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(10);
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(110);
  });

  it("**任何一个放不下就整组拒绝**，一个字段都不改", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 200, 300)] },
      { id: "V2", kind: "video", clips: [clip("c", 400, 500), { ...clip("blocker", 500, 600), name: "拦路的" }] },
    ]);
    const r = moveClips(t, ["a", "b", "c"], 100);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/拦路的/);
    // 原时间轴原样返回
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(0);
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(200);
  });

  it("**夹紧是整组一起挪，不是把越界的各自压到 0**", () => {
    // 各自压到 0 会让 a 和 b 都落在 0、叠成一堆——正是"相对位置就是内容"被破坏的形态。
    // a[30,130) b[200,300) 左移 50：只能挪 30，于是 a 落 0 而 b 落 170（间距 170 不变）
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 30, 130), clip("b", 200, 300)] },
    ]);
    const r = moveClips(t, ["a", "b"], -50);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(0);
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(170);
  });

  it("已经贴着 0 还往左拖：夹紧之后位移是 0，算「值没变」不算失败", () => {
    // 不写这条的话上面那句"夹紧"很容易被实现成"夹到 0 再照常提交"，于是每一次
    // 拖不动的拖拽都进一条空历史
    const r = moveClips(base(), ["a", "b"], -50);
    expect(r.changed).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("clampToBounds:false 时越界直接拒", () => {
    const r = moveClips(base(), ["a", "b"], -50, { clampToBounds: false });
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/起点之前/);
  });

  it("锁定轨道上的片段让整组被拒", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "V2", kind: "video", locked: true, label: "叠加", clips: [clip("c", 400, 500)] },
    ]);
    const r = moveClips(t, ["a", "c"], 10);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/锁定/);
  });

  it("**只有一个 id 时逐字段等于 `moveClip`**——多选退化成一个必须和没多选过一样", () => {
    const one = moveClips(base(), ["a"], 40);
    const plain = moveClip(base(), "a", 40);
    expect(one.changed).toBe(plain.changed);
    expect(one.timeline).toEqual(plain.timeline);
    // 被拒时也一样（40+100 会压到 b[200,300)？不会——所以这里用一个真撞上的位移）
    expect(moveClips(base(), ["a"], 150).reason).toBe(moveClip(base(), "a", 150).reason);
  });

  it("位移为 0 时不算失败也不进历史（第三种结果）", () => {
    const r = moveClips(base(), ["a", "b"], 0);
    expect(r.changed).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("重复 id 只算一次", () => {
    const r = moveClips(base(), ["a", "a", "b"], 10);
    expect(r.changed).toBe(true);
    expect(findClip(r.timeline, "a")?.clip.timelineIn).toBe(10);
  });

  it("找不到片段时整组拒绝", () => {
    expect(moveClips(base(), ["a", "缺"], 10).reason).toMatch(/找不到片段/);
    expect(moveClips(base(), [], 10).reason).toMatch(/没有选中/);
    expect(moveClips(base(), ["a", "b"], 1.5).reason).toMatch(/整数帧/);
  });
});

describe("多选：批量删除", () => {
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200), clip("c", 200, 300)] },
    ]);

  it("一次删掉多个", () => {
    const r = removeClips(base(), ["a", "c"]);
    expect(r.changed).toBe(true);
    expect(r.done).toBe(2);
    expect(r.total).toBe(2);
    expect(r.skippedReason).toBeUndefined();
    expect(findClip(r.timeline, "a")).toBeUndefined();
    expect(findClip(r.timeline, "b")?.clip.timelineIn).toBe(100);
  });

  it("**波纹删除多个：每一步从当前时间轴重读位置**", () => {
    const r = removeClips(base(), ["a", "b"], true);
    expect(r.changed).toBe(true);
    expect(r.done).toBe(2);
    // 各自左移自己的长度，c 最终回到 0
    expect(findClip(r.timeline, "c")?.clip.timelineIn).toBe(0);
  });

  it("波纹删除的顺序不影响结果（几个删除彼此可交换）", () => {
    const forward = removeClips(base(), ["a", "b"], true).timeline;
    const backward = removeClips(base(), ["b", "a"], true).timeline;
    expect(findClip(forward, "c")?.clip.timelineIn).toBe(findClip(backward, "c")?.clip.timelineIn);
  });

  it("**部分成功是合法结果，而它走 `skippedReason` 不走 `reason`**", () => {
    // 走 reason 的话 `apply()` 在 changed:true 时根本不看它，用户会看到 1 个消失、
    // 1 个还在，而软件一个字都没说
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100)] },
      { id: "V2", kind: "video", locked: true, clips: [clip("c", 400, 500)] },
    ]);
    const r = removeClips(t, ["a", "c"]);
    expect(r.changed).toBe(true);
    expect(r.done).toBe(1);
    expect(r.total).toBe(2);
    expect(r.reason).toBeUndefined();
    expect(r.skippedReason).toMatch(/2 个片段里有 1 个没删/);
    expect(r.skippedReason).toMatch(/锁定/);
    expect(findClip(r.timeline, "a")).toBeUndefined();
    expect(findClip(r.timeline, "c")).toBeDefined();
  });

  it("一个都没删成才算失败，原因走 reason", () => {
    const t = timeline([{ id: "V1", kind: "video", locked: true, clips: [clip("a", 0, 100)] }]);
    const r = removeClips(t, ["a"]);
    expect(r.changed).toBe(false);
    expect(r.done).toBe(0);
    expect(r.reason).toMatch(/锁定/);
    expect(removeClips(base(), []).reason).toMatch(/没有选中/);
  });
});

describe("多选：批量复制 / 粘贴 / 副本", () => {
  /** V1 上 a[0,100) b[200,300)，A1 上 m[0,50)。 */
  const base = () =>
    timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 200, 300)] },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 50)] },
    ]);

  it("**复制按 `timelineIn` 升序，不按选择顺序**", () => {
    // 按点选顺序存的话，先点右边再点左边就会得到另一个锚点，同一组片段粘出来落在
    // 不同位置——而两次操作看起来完全一样
    const entries = copyClips(base(), ["b", "a"]);
    expect(entries.map((e) => e.clip.id)).toEqual(["a", "b"]);
  });

  it("找不到的悄悄跳过，重复 id 只算一次", () => {
    expect(copyClips(base(), ["a", "缺", "a"]).map((e) => e.clip.id)).toEqual(["a"]);
  });

  it("**粘贴：组的开头对齐播放头，组内相对位置保留**", () => {
    const t = base();
    const r = pasteClips(t, copyClips(t, ["a", "b"]), 500);
    expect(r.changed).toBe(true);
    expect(r.clipIds).toHaveLength(2);
    const [first, second] = r.clipIds!.map((id) => findClip(r.timeline, id)!.clip);
    expect(first!.timelineIn).toBe(500); // 最早那个落在播放头
    expect(second!.timelineIn).toBe(700); // 200 帧的间隔原样保留
    expect(second!.timelineOut).toBe(800);
  });

  it("**偏移按'离组内最早那个多远'算，不是各自的绝对帧号**", () => {
    // 用绝对帧号的话粘贴会无视播放头、直接粘回原处（而单个片段时完全正常，
    // 因为那时锚点就是它自己）——同 D35 那个被乘以零的因子
    const t = base();
    const r = pasteClips(t, copyClips(t, ["b"]), 400);
    expect(findClip(r.timeline, r.clipIds![0]!)?.clip.timelineIn).toBe(400);
  });

  it("跨轨道的一组各自回到自己那条轨", () => {
    const t = base();
    const r = pasteClips(t, copyClips(t, ["a", "m"]), 600);
    const tracks = r.clipIds!.map((id) => findClip(r.timeline, id)!.track.id);
    expect(new Set(tracks)).toEqual(new Set(["V1", "A1"]));
  });

  it("**任何一个放不下就整组拒绝，原时间轴原样返回**", () => {
    const t = base();
    // 粘到 150：a 的副本落 [150,250)，b 的副本落 [350,450)——前者压在 b[200,300) 上
    const r = pasteClips(t, copyClips(t, ["a", "b"]), 150);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/放不下/);
    expect(t.tracks[0]!.clips).toHaveLength(2);
    expect(r.timeline.tracks[0]!.clips).toHaveLength(2);
  });

  it("**新片段之间互相重叠也会被拦**（逐个插，后面的看得见前面的）", () => {
    // 造一个"两份同一个片段"的剪贴板：绝对帧号相同 ⇒ 偏移都是 0 ⇒ 两个副本落在同一处
    const t = base();
    const one = copyClips(t, ["a"]);
    const r = pasteClips(t, [...one, ...one], 500);
    expect(r.changed).toBe(false);
    expect(r.reason).toMatch(/放不下/);
  });

  it("空剪贴板 / 非法落点被拒", () => {
    const t = base();
    expect(pasteClips(t, [], 100).reason).toMatch(/剪贴板是空的/);
    expect(pasteClips(t, copyClips(t, ["a"]), -1).reason).toMatch(/非负整数/);
    expect(pasteClips(t, copyClips(t, ["a"]), 1.5).reason).toMatch(/非负整数/);
  });

  it("**副本：整组往后平移'组的跨度'**，相邻的几个也放得下", () => {
    // 各自取自己的出点会让 A 的副本正好落在 B 头上，于是"选中相邻几个按 ⌘D"永远失败
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
    ]);
    const r = duplicateClips(t, ["a", "b"]);
    expect(r.changed).toBe(true);
    const copies = r.clipIds!.map((id) => findClip(r.timeline, id)!.clip);
    expect(copies.map((c) => c.timelineIn)).toEqual([200, 300]);
  });

  it("**单个片段时和 `duplicateClip` 落在同一处**（跨度退化成它自己的长度）", () => {
    const one = duplicateClip(base(), "a");
    const many = duplicateClips(base(), ["a"]);
    const a = findClip(one.timeline, one.clipId!)!.clip;
    const b = findClip(many.timeline, many.clipIds![0]!)!.clip;
    expect([b.timelineIn, b.timelineOut]).toEqual([a.timelineIn, a.timelineOut]);
    expect(b.timelineIn).toBe(100);
  });

  it("组里有空档时空档跟着走", () => {
    // a[0,100) b[200,300)：跨度 300，所以副本落 300 / 500，中间那 100 帧空档还在
    const r = duplicateClips(base(), ["a", "b"]);
    const copies = r.clipIds!.map((id) => findClip(r.timeline, id)!.clip);
    expect(copies.map((c) => c.timelineIn)).toEqual([300, 500]);
  });

  it("放不下就整组拒绝；空选中和已不在的片段也拒绝", () => {
    const t = timeline([
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), { ...clip("b", 100, 200), name: "拦路的" }] },
    ]);
    // a 的副本要落 [200,300)（跨度 200），而 b 的副本落 [300,400)——都空着，所以这一组能过
    expect(duplicateClips(t, ["a", "b"]).changed).toBe(true);
    // 只选 a：跨度是它自己的 100，副本落 [100,200) 正好撞上 b
    expect(duplicateClips(t, ["a"]).reason).toMatch(/放不下/);
    expect(duplicateClips(t, []).reason).toMatch(/没有选中/);
    expect(duplicateClips(t, ["a", "缺"]).reason).toMatch(/已经不在了/);
  });

  it("**副本也要把 `transitionIn` 删掉**，而整组的落点永远紧接着组尾", () => {
    const t = timeline([
      {
        id: "V1",
        kind: "video",
        clips: [
          clip("a", 0, 100),
          { ...clip("b", 100, 200), transitionIn: { kind: "dissolve", frames: 20 } },
        ],
      },
    ]);
    const r = duplicateClips(t, ["a", "b"]);
    expect(r.changed).toBe(true);
    for (const id of r.clipIds!) {
      expect("transitionIn" in findClip(r.timeline, id)!.clip).toBe(false);
    }
  });
});

describe("新片段 id 不是模块级计数器", () => {
  it("文字片段的 id 不长成 `text-<小整数>`", () => {
    // 判据刻意是**形状**而不是"两次不同"：计数器同样满足"两次不同"，而它真正的
    // 毛病是跨会话——打开一个存过的项目（快照里带着上一次会话的 `text-1`）再新建
    // 一个，新的也叫 `text-1`，而 `replaceClip` 按 id 映射会把两个一起改（D36 那条
    // 长在片段上的版本）。单测造不出"上一次会话"，所以直接钉住 id 的形状
    const first = addTextClip(twoClipTimeline(), { timelineIn: 300, durationFrames: 60, text: "甲" });
    expect(first.clipId).not.toMatch(/^text-\d+$/);
    const second = addTextClip(first.timeline, { timelineIn: 400, durationFrames: 60, text: "乙" });
    expect(second.clipId).not.toBe(first.clipId);
  });
});
