import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import type { Clip, MediaSource, Timeline, Track } from "../edl/types";
import {
  computeDuration,
  findClip,
  moveClip,
  removeClip,
  rippleDeleteClip,
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

function clip(id: string, timelineIn: number, timelineOut: number, sourceIn = 0): Clip {
  return { id, sourceId: "src", timelineIn, timelineOut, sourceIn, name: id };
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
    const moved = findClip(r.timeline, "a")!.clip;
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
    expect(r.reason).toContain("另一种轨道");
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
    const c = findClip(r.timeline, "a")!.clip;
    expect(c.timelineIn).toBe(10);
    expect(c.sourceIn).toBe(30); // 少用源片开头 10 帧
    expect(c.timelineOut).toBe(100); // 出点不动
  });

  it("裁出点不改 sourceIn", () => {
    const t = timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 100, 20)] }]);
    const r = trimClip(t, "a", "out", -30);
    const c = findClip(r.timeline, "a")!.clip;
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
    expect(clips[0]!.timelineIn).toBe(0);
    expect(clips[0]!.timelineOut).toBe(40);
    expect(clips[0]!.sourceIn).toBe(10);
    expect(clips[1]!.timelineIn).toBe(40);
    expect(clips[1]!.timelineOut).toBe(100);
    // 关键：右半段必须从源片第 50 帧开始，否则会重播左半段的内容
    expect(clips[1]!.sourceIn).toBe(50);
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
