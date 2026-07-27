import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_TIMELINE, useTimeline } from "./timeline-store";
import { findClip } from "./operations";
import { FPS } from "../time/rational";
import type { MediaSource } from "../edl/types";

function source(durationFrames = 300): MediaSource {
  return {
    id: "src1",
    name: "test.mp4",
    file: new File([], "test.mp4"),
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames,
    hasAudio: true,
    videoCodec: "avc",
    audioCodec: "aac",
  };
}

/** 每个用例前把 store 重置到初始状态。 */
function reset(): void {
  useTimeline.setState({
    ...useTimeline.getInitialState(),
  });
}

describe("store 初始状态", () => {
  beforeEach(reset);

  it("空项目有 5 条预设轨道，磁吸默认开", () => {
    const s = useTimeline.getState();
    expect(s.timeline().tracks).toHaveLength(5);
    expect(s.timeline().durationFrames).toBe(0);
    expect(s.snapEnabled).toBe(true); // 决策 D2
    expect(s.canUndo()).toBe(false);
  });
});

describe("导入素材", () => {
  beforeEach(reset);

  it("视频铺到 V1、音频铺到 A1，并自动选中视频片段", () => {
    useTimeline.getState().loadSource(source(300));
    const s = useTimeline.getState();
    const t = s.timeline();

    expect(t.durationFrames).toBe(300);
    expect(t.tracks.find((x) => x.id === "V1")!.clips).toHaveLength(1);
    expect(t.tracks.find((x) => x.id === "A1")!.clips).toHaveLength(1);
    expect(t.tracks.find((x) => x.id === "V2")!.clips).toHaveLength(0);
    expect(s.selectedClipId).toBe("src1-v");
    expect(t.fps).toEqual(FPS.ndf2997);
  });

  it("导入是一步可撤销的操作", () => {
    useTimeline.getState().loadSource(source());
    expect(useTimeline.getState().canUndo()).toBe(true);
    useTimeline.getState().undo();
    expect(useTimeline.getState().timeline()).toEqual(EMPTY_TIMELINE);
  });
});

describe("播放头", () => {
  beforeEach(reset);

  it("夹在 [0, duration]，允许停在末尾", () => {
    useTimeline.getState().loadSource(source(300));
    const s = () => useTimeline.getState();

    s().setPlayhead(-10);
    expect(s().playhead).toBe(0);
    s().setPlayhead(9999);
    expect(s().playhead).toBe(300);
    s().setPlayhead(150.6);
    expect(s().playhead).toBe(151); // 取整成帧号
  });

  it("移动播放头不进撤销栈", () => {
    useTimeline.getState().loadSource(source());
    useTimeline.getState().setPlayhead(100);
    useTimeline.getState().undo();
    // 撤销撤掉的是"导入"，不是"移动播放头"
    expect(useTimeline.getState().timeline()).toEqual(EMPTY_TIMELINE);
  });
});

describe("拖拽与磁吸", () => {
  beforeEach(reset);

  it("落点在阈值内时吸到播放头", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300)); // V1: [0,300)
    s().setPlayhead(150);

    // 拖到 147，距播放头 150 差 3 帧（阈值 6 内）→ 应被吸到 150
    s().dragClipTo("src1-v", 147);
    expect(findClip(s().timeline(), "src1-v")!.clip.timelineIn).toBe(150);
  });

  it("落点吸到另一条轨道上片段的边界", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300)); // V1 与 A1 各有 [0,300)
    s().setPlayhead(0);

    // 拖到 297：A1 片段出点 300 在阈值内 → 吸到 300，两段首尾相接无缝隙
    s().dragClipTo("src1-v", 297);
    expect(findClip(s().timeline(), "src1-v")!.clip.timelineIn).toBe(300);
  });

  it("落点超出阈值时不吸附", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().setPlayhead(150);

    s().dragClipTo("src1-v", 130); // 距 150 有 20 帧，超出阈值 6
    expect(findClip(s().timeline(), "src1-v")!.clip.timelineIn).toBe(130);
  });

  it("一次拖拽的多个中间态合并成一步撤销", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));

    // 先腾出空间：把片段放到 V2 便于自由移动
    const clipId = "src1-v";
    s().dragClipTo(clipId, 10);
    s().dragClipTo(clipId, 20);
    s().dragClipTo(clipId, 30);
    expect(findClip(s().timeline(), clipId)!.clip.timelineIn).toBe(30);

    // 关键：三次中间态只需一次撤销就回到拖拽前
    s().undo();
    expect(findClip(s().timeline(), clipId)!.clip.timelineIn).toBe(0);
  });

  it("落点没变化时不产生历史条目", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    const before = s().history.past.length;
    s().dragClipTo("src1-v", 0); // 原地
    expect(s().history.past.length).toBe(before);
  });

  // 跨轨道是纯垂直移动，帧号一个都不变。"没动就不提交"的判断只看帧号时，
  // 整个跨轨落点会被静默丢掉——不移动、也不给拒绝原因
  it("同一帧号换轨道仍然要移动，不能当成没动", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300)); // V1: [0,300)
    s().dragClipTo("src1-v", 0, "V2");
    expect(findClip(s().timeline(), "src1-v")!.track.id).toBe("V2");
    expect(s().lastRejection).toBeNull();
  });

  it("同一帧号拖回原轨道仍然算没动", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    const before = s().history.past.length;
    s().dragClipTo("src1-v", 0, "V1");
    expect(s().history.past.length).toBe(before);
  });

  it("关掉磁吸后落点精确", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().toggleSnap();
    expect(s().snapEnabled).toBe(false);
    s().dragClipTo("src1-v", 3); // 距起点 3 帧，磁吸开着会被吸回 0
    expect(findClip(s().timeline(), "src1-v")!.clip.timelineIn).toBe(3);
  });
});

describe("切分", () => {
  beforeEach(reset);

  it("选中片段时在播放头切分", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select("src1-v");
    s().setPlayhead(120);
    s().splitAtPlayhead();

    const v1 = s().timeline().tracks.find((t) => t.id === "V1")!;
    expect(v1.clips).toHaveLength(2);
    expect(v1.clips[0]!.timelineOut).toBe(120);
    const right = v1.clips[1]!;
    expect(right.kind).toBe("media");
    expect(right.kind === "media" && right.sourceIn).toBe(120);
  });

  it("未选中时切播放头下的所有轨道", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select(null);
    s().setPlayhead(150);
    s().splitAtPlayhead();

    expect(s().timeline().tracks.find((t) => t.id === "V1")!.clips).toHaveLength(2);
    expect(s().timeline().tracks.find((t) => t.id === "A1")!.clips).toHaveLength(2);
  });

  it("播放头不在任何片段内时给出拒绝原因", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select(null);
    s().setPlayhead(0); // 边界，不算内部
    s().splitAtPlayhead();
    expect(s().lastRejection).toContain("没有可切分");
  });
});

describe("删除", () => {
  beforeEach(reset);

  it("删除后清空选中", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select("src1-v");
    s().removeSelected();
    expect(s().selectedClipId).toBeNull();
    expect(s().timeline().tracks.find((t) => t.id === "V1")!.clips).toHaveLength(0);
  });

  it("没有选中时给出提示而不是静默", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select(null);
    s().removeSelected();
    expect(s().lastRejection).toContain("没有选中");
  });
});

describe("撤销的连带处理", () => {
  beforeEach(reset);

  it("撤销后清掉指向已不存在片段的选中", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().select("src1-v");
    s().splitAtPlayhead(); // 播放头 0，切不动
    s().setPlayhead(100);
    s().splitAtPlayhead();

    const rightId = s().timeline().tracks.find((t) => t.id === "V1")!.clips[1]!.id;
    s().select(rightId);
    expect(s().selectedClipId).toBe(rightId);

    // 撤销切分 → 右半段不再存在 → 选中必须被清掉，否则检查器会渲染空引用
    s().undo();
    expect(findClip(s().timeline(), rightId)).toBeUndefined();
    expect(s().selectedClipId).toBeNull();
  });

  it("撤销后播放头不超出新时长", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().setPlayhead(280);
    s().undo(); // 回到空时间轴，duration=0
    expect(s().playhead).toBe(0);
  });

  it("被拒绝的操作不进撤销栈", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    const before = s().history.past.length;

    s().moveClip("src1-v", -500, { clampToBounds: false }); // 越界，会被拒
    expect(s().lastRejection).toBeTruthy();
    expect(s().history.past.length).toBe(before);
  });

  it("成功操作清空上一次的拒绝提示", () => {
    const s = () => useTimeline.getState();
    s().loadSource(source(300));
    s().moveClip("src1-v", -500, { clampToBounds: false });
    expect(s().lastRejection).toBeTruthy();
    s().moveClip("src1-v", 10);
    expect(s().lastRejection).toBeNull();
  });
});

describe("变换与关键帧的 store 动作", () => {
  beforeEach(() => {
    reset();
    useTimeline.getState().loadSource(source(300));
  });

  it("改变换会进撤销栈", () => {
    useTimeline.getState().setClipTransform("src1-v", { x: 60 });
    expect(findClip(useTimeline.getState().timeline(), "src1-v")!.clip.transform).toEqual({ x: 60 });
    useTimeline.getState().undo();
    expect("transform" in findClip(useTimeline.getState().timeline(), "src1-v")!.clip).toBe(false);
  });

  it("连续拖同一个滑块合并成一步撤销", () => {
    const before = useTimeline.getState().history.past.length;
    for (const x of [10, 20, 30, 40]) useTimeline.getState().setClipTransform("src1-v", { x });
    expect(useTimeline.getState().history.past.length).toBe(before + 1);
  });

  it("换一个属性拖就是新的一步——合并键带属性名", () => {
    const before = useTimeline.getState().history.past.length;
    useTimeline.getState().setClipTransform("src1-v", { x: 10 });
    useTimeline.getState().setClipTransform("src1-v", { y: 10 });
    expect(useTimeline.getState().history.past.length).toBe(before + 2);
  });

  it("值没变时不产生历史条目，也不弹提示", () => {
    useTimeline.getState().setClipTransform("src1-v", { x: 10 });
    useTimeline.setState({ lastRejection: null });
    const before = useTimeline.getState().history.past.length;
    useTimeline.getState().setClipTransform("src1-v", { x: 10 });
    expect(useTimeline.getState().history.past.length).toBe(before);
    expect(useTimeline.getState().lastRejection).toBeNull();
  });

  it("打关键帧用的是**时间轴帧号**，内部换算成片段内偏移", () => {
    // 先把片段挪到 100 帧处，偏移与时间轴帧号就不再相等
    useTimeline.getState().moveClip("src1-v", 100);
    useTimeline.getState().setKeyframeAt("src1-v", "opacity", 150, 0.5);
    const kfs = findClip(useTimeline.getState().timeline(), "src1-v")!.clip.keyframes?.opacity;
    expect(kfs).toEqual([{ frame: 50, value: 0.5 }]);
  });

  it("删关键帧同样按时间轴帧号定位", () => {
    useTimeline.getState().moveClip("src1-v", 100);
    useTimeline.getState().setKeyframeAt("src1-v", "opacity", 150, 0.5);
    useTimeline.getState().removeKeyframeAt("src1-v", "opacity", 150);
    expect("keyframes" in findClip(useTimeline.getState().timeline(), "src1-v")!.clip).toBe(false);
  });

  it("在不同位置打关键帧不会被合并成一步", () => {
    const before = useTimeline.getState().history.past.length;
    useTimeline.getState().setKeyframeAt("src1-v", "x", 0, 0);
    useTimeline.getState().setKeyframeAt("src1-v", "x", 50, 100);
    expect(useTimeline.getState().history.past.length).toBe(before + 2);
  });
});

describe("新建文字片段", () => {
  beforeEach(() => {
    reset();
    useTimeline.getState().loadSource(source(300));
  });

  it("落在 T1 并自动选中，接着就能改内容", () => {
    useTimeline.getState().addTextClip({ timelineIn: 0, durationFrames: 60, text: "标题" });
    const s = useTimeline.getState();
    const created = s.selectedClipId!;
    expect(findClip(s.timeline(), created)!.track.id).toBe("T1");

    useTimeline.getState().setTextContent(created, "改过的标题");
    const clip = findClip(useTimeline.getState().timeline(), created)!.clip;
    expect(clip.kind === "text" && clip.text).toBe("改过的标题");
  });

  it("失败时不改选中", () => {
    useTimeline.getState().select("src1-v");
    useTimeline.getState().addTextClip({ timelineIn: 0, durationFrames: 0, text: "x" });
    expect(useTimeline.getState().selectedClipId).toBe("src1-v");
    expect(useTimeline.getState().lastRejection).toContain("1 帧");
  });

  it("撤销能把新建的文字片段收回去", () => {
    useTimeline.getState().addTextClip({ timelineIn: 0, durationFrames: 60, text: "标题" });
    const created = useTimeline.getState().selectedClipId!;
    useTimeline.getState().undo();
    expect(findClip(useTimeline.getState().timeline(), created)).toBeUndefined();
    // 撤销后选中不能指向已经不存在的片段
    expect(useTimeline.getState().selectedClipId).toBeNull();
  });
});
