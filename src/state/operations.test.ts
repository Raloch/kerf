import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import { clipsUsingColor } from "../edl/types";
import type { Clip, MediaClip, MediaSource, TextClip, Timeline, Track } from "../edl/types";
import {
  addTextClip,
  clearKeyframes,
  computeDuration,
  findClip,
  moveClip,
  removeClip,
  removeKeyframe,
  rippleDeleteClip,
  setClipColor,
  setClipTransform,
  setKeyframe,
  setTextContent,
  setTextStyle,
  snapDrag,
  snapFrame,
  snapTargets,
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

describe("clipsUsingColor", () => {
  it("静态调色的片段算数", () => {
    const t = setClipColor(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      "a",
      { saturation: 0 },
    ).timeline;
    expect(clipsUsingColor(t).map((c) => c.id)).toEqual(["a"]);
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
    expect(clipsUsingColor(t).map((c) => c.id)).toEqual(["a"]);
  });

  it("只有摆位关键帧的片段不算数", () => {
    const t = setKeyframe(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]),
      "a",
      "x",
      0,
      50,
    ).timeline;
    expect(clipsUsingColor(t)).toEqual([]);
  });

  it("没调过色的项目返回空", () => {
    expect(clipsUsingColor(timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100)] }]))).toEqual([]);
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
