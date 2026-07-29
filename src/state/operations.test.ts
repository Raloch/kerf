import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import { clipsUsingEffects } from "../edl/types";
import type { LutSource } from "../edl/types";
import type {
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
  addTextClip,
  clearKeyframes,
  computeDuration,
  findClip,
  junctionInfo,
  moveClip,
  moveKeyframe,
  removeClip,
  removeKeyframe,
  rippleDeleteClip,
  setClipColor,
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

describe("磁吸", () => {
  it("收集其他片段两端、播放头和起点", () => {
    const targets = snapTargets(twoClipTimeline(), "a", { playhead: 150 });
    expect(targets).toContain(0);
    expect(targets).toContain(100); // b 的入点
    expect(targets).toContain(200); // b 的出点
    expect(targets).toContain(150); // 播放头
  });

  it("排除被拖动片段自身，否则永远吸回原位", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 37, 137)] }]);
    expect(snapTargets(t, "a")).not.toContain(37);
    expect(snapTargets(t, null)).toContain(37);
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
    expect(r.reason).toContain("没有音量");
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
    expect(r.reason).toContain("没有音量");
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
