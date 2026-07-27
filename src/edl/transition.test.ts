/**
 * 转场时间模型的单测。
 *
 * 这一层锁的是四类**不会报错、只会静默出错片**的错误：
 *
 * 1. **窗口不对称**——50% 那一刻漂离交界，用户刚调好的剪切点会随时长变化而移动。
 * 2. **借出超过一半**——两个相邻转场的窗口会重叠，某一帧上出现三层要混的画面。
 * 3. **孤儿转场仍然生效**——片段被拖开之后还按老交界画，画面里出现不该有的溶解。
 * 4. **定格帧数算错**——界面上报的余量提示与实际画面不符，比不报更坏。
 */

import { describe, expect, it } from "vitest";
import {
  MAX_TRANSITION_FRAMES,
  availableHandle,
  clampSourceMicros,
  frozenFrames,
  trackTransitionWindows,
  transitionAt,
  transitionProgress,
  transitionWindow,
  windowCovers,
} from "./transition";
import type { Clip, MediaClip, TextClip, Transition } from "./types";

const media = (over: Partial<MediaClip> = {}): MediaClip => ({
  id: "c1",
  kind: "media",
  sourceId: "s1",
  timelineIn: 0,
  timelineOut: 100,
  sourceIn: 0,
  ...over,
});

const text = (over: Partial<TextClip> = {}): TextClip => ({
  id: "t1",
  kind: "text",
  text: "标题",
  timelineIn: 0,
  timelineOut: 100,
  ...over,
});

const dissolve = (frames: number): Transition => ({ kind: "dissolve", frames });

/** 一对紧邻片段：A 占 [0,100)，B 占 [100,200)。 */
const pair = (aOver: Partial<MediaClip> = {}, bOver: Partial<MediaClip> = {}) => ({
  a: media({ id: "a", timelineIn: 0, timelineOut: 100, ...aOver }),
  b: media({ id: "b", timelineIn: 100, timelineOut: 200, sourceIn: 100, ...bOver }),
});

describe("transitionWindow", () => {
  it("窗口以交界为中心，左右各一半", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20));
    expect(w).toMatchObject({ junction: 100, startFrame: 90, endFrame: 110, frames: 20 });
  });

  it("奇数时长向下取偶，而不是把窗口摆歪", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(21));
    // 21 → half=10 → 20 帧；交界仍在正中
    expect(w).toMatchObject({ startFrame: 90, endFrame: 110, frames: 20 });
    expect(w!.junction - w!.startFrame).toBe(w!.endFrame - w!.junction);
  });

  it("两段不相邻时解不出窗口", () => {
    const { a } = pair();
    const far = media({ id: "b", timelineIn: 140, timelineOut: 200 });
    expect(transitionWindow(a, far, dissolve(20))).toBeNull();
  });

  it("每个片段最多借出自己长度的一半", () => {
    // B 只有 10 帧，最多借 5；A 很长也跟着被夹到 5
    const { a, b } = pair({}, { timelineOut: 110 });
    const w = transitionWindow(a, b, dissolve(40));
    expect(w).toMatchObject({ startFrame: 95, endFrame: 105, frames: 10 });
  });

  it("短到借不出一帧时返回 null，而不是零长窗口", () => {
    const a = media({ id: "a", timelineIn: 0, timelineOut: 1 });
    const b = media({ id: "b", timelineIn: 1, timelineOut: 50 });
    expect(transitionWindow(a, b, dissolve(20))).toBeNull();
  });

  it("时长低于 2 帧解不出窗口", () => {
    const { a, b } = pair();
    expect(transitionWindow(a, b, dissolve(1))).toBeNull();
    expect(transitionWindow(a, b, dissolve(0))).toBeNull();
    expect(transitionWindow(a, b, dissolve(-5))).toBeNull();
  });

  it("时长上限夹住手滑输入", () => {
    const { a, b } = pair({ timelineOut: 5000 }, { timelineIn: 5000, timelineOut: 10000 });
    const w = transitionWindow(a, b, dissolve(99999));
    expect(w!.frames).toBe(MAX_TRANSITION_FRAMES);
  });

  it("相邻的两个转场窗口永不重叠——这是「最多借一半」存在的理由", () => {
    // A[0,100) B[100,140) C[140,240)，B 两侧各挂一个长转场
    const a = media({ id: "a", timelineIn: 0, timelineOut: 100 });
    const b = media({ id: "b", timelineIn: 100, timelineOut: 140 });
    const c = media({ id: "c", timelineIn: 140, timelineOut: 240 });
    const w1 = transitionWindow(a, b, dissolve(200))!;
    const w2 = transitionWindow(b, c, dissolve(200))!;
    expect(w1.endFrame).toBeLessThanOrEqual(w2.startFrame);
  });
});

describe("transitionProgress", () => {
  it("取帧中点，两端都不到 0 和 1", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20))!;
    expect(transitionProgress(w, 90)).toBeCloseTo(0.025, 6);
    expect(transitionProgress(w, 109)).toBeCloseTo(0.975, 6);
  });

  it("交界帧落在 50% 之后的第一帧，窗口整体关于 0.5 对称", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20))!;
    for (let i = 0; i < 10; i++) {
      const left = transitionProgress(w, w.startFrame + i);
      const right = transitionProgress(w, w.endFrame - 1 - i);
      expect(left + right).toBeCloseTo(1, 10);
    }
  });

  it("逐帧单调递增", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20))!;
    let prev = -1;
    for (let f = w.startFrame; f < w.endFrame; f++) {
      const t = transitionProgress(w, f);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    expect(prev).toBeLessThan(1);
  });
});

describe("windowCovers", () => {
  it("左闭右开，与片段占位一致", () => {
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20))!;
    expect(windowCovers(w, 89)).toBe(false);
    expect(windowCovers(w, 90)).toBe(true);
    expect(windowCovers(w, 109)).toBe(true);
    expect(windowCovers(w, 110)).toBe(false);
  });
});

describe("frozenFrames", () => {
  it("余量充足时不定格", () => {
    // A 占源片 [0,100)，源片有 300 帧 → 出点后还有 200 帧余量
    const { a, b } = pair();
    const w = transitionWindow(a, b, dissolve(20))!;
    expect(frozenFrames(w, "from", 300)).toBe(0);
    expect(frozenFrames(w, "to", 300)).toBe(0);
  });

  it("两段满长素材相邻时两侧都全定格——这是最常见的情形", () => {
    const a = media({ id: "a", timelineIn: 0, timelineOut: 100, sourceIn: 0 });
    const b = media({ id: "b", timelineIn: 100, timelineOut: 200, sourceIn: 0 });
    const w = transitionWindow(a, b, dissolve(20))!;
    // 各需要 10 帧余量，A 的出点就是源片末尾、B 的入点就是源片开头
    expect(frozenFrames(w, "from", 100)).toBe(10);
    expect(frozenFrames(w, "to", 100)).toBe(10);
  });

  it("余量部分够时只定格差额", () => {
    const a = media({ id: "a", timelineIn: 0, timelineOut: 100, sourceIn: 0 });
    const b = media({ id: "b", timelineIn: 100, timelineOut: 200, sourceIn: 4 });
    const w = transitionWindow(a, b, dissolve(20))!;
    expect(frozenFrames(w, "from", 106)).toBe(4); // 需要 10，有 6
    expect(frozenFrames(w, "to", 300)).toBe(6); // 需要 10，有 4
  });

  it("文字片段永远不定格——它的画面是现场生成的", () => {
    const a = text({ id: "a", timelineIn: 0, timelineOut: 100 });
    const b = media({ id: "b", timelineIn: 100, timelineOut: 200, sourceIn: 0 });
    const w = transitionWindow(a as Clip, b, dissolve(20))!;
    expect(frozenFrames(w, "from", 0)).toBe(0);
  });
});

describe("availableHandle", () => {
  it("出场看出点之后，入场看入点之前", () => {
    const clip = media({ timelineIn: 0, timelineOut: 100, sourceIn: 30 });
    expect(availableHandle(clip, "from", 300)).toBe(170);
    expect(availableHandle(clip, "to", 300)).toBe(30);
  });

  it("不返回负数", () => {
    const clip = media({ timelineIn: 0, timelineOut: 100, sourceIn: 0 });
    expect(availableHandle(clip, "from", 50)).toBe(0);
  });
});

describe("clampSourceMicros", () => {
  it("负数夹到 0——入场片段在窗口前半段会算出负位置", () => {
    expect(clampSourceMicros(-33333, 1_000_000)).toBe(0);
  });

  it("超过末帧夹到末帧——出场片段在窗口后半段会越过源片末尾", () => {
    expect(clampSourceMicros(2_000_000, 1_000_000)).toBe(1_000_000);
  });

  it("范围内原样返回", () => {
    expect(clampSourceMicros(500_000, 1_000_000)).toBe(500_000);
  });
});

describe("trackTransitionWindows / transitionAt", () => {
  const track = (): Clip[] => [
    media({ id: "a", timelineIn: 0, timelineOut: 100 }),
    media({ id: "b", timelineIn: 100, timelineOut: 200, transitionIn: dissolve(20) }),
    media({ id: "c", timelineIn: 200, timelineOut: 300, transitionIn: dissolve(10) }),
  ];

  it("按交界排序列出所有生效窗口", () => {
    const got = trackTransitionWindows(track());
    expect(got.map((w) => w.junction)).toEqual([100, 200]);
  });

  it("片段乱序也能算对——占位才是真值来源", () => {
    const shuffled = [...track()].reverse();
    expect(trackTransitionWindows(shuffled).map((w) => w.junction)).toEqual([100, 200]);
  });

  it("孤儿转场被忽略：前驱被拖开就不再生效", () => {
    const clips: Clip[] = [
      media({ id: "a", timelineIn: 0, timelineOut: 80 }),
      media({ id: "b", timelineIn: 100, timelineOut: 200, transitionIn: dissolve(20) }),
    ];
    expect(trackTransitionWindows(clips)).toEqual([]);
  });

  it("第一个片段上的转场没有前驱，直接忽略", () => {
    const clips: Clip[] = [
      media({ id: "a", timelineIn: 0, timelineOut: 100, transitionIn: dissolve(20) }),
    ];
    expect(trackTransitionWindows(clips)).toEqual([]);
  });

  it("transitionAt 只在窗口内命中", () => {
    const clips = track();
    expect(transitionAt(clips, 89)).toBeNull();
    expect(transitionAt(clips, 90)?.junction).toBe(100);
    expect(transitionAt(clips, 109)?.junction).toBe(100);
    expect(transitionAt(clips, 110)).toBeNull();
    expect(transitionAt(clips, 196)?.junction).toBe(200);
  });
});
