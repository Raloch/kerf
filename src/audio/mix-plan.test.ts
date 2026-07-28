/**
 * 混音排期的单测。
 *
 * 这里锁的是三件在端到端自检里**分不清是谁错了**的事：
 *
 * 1. 转场窗口把解码区间往两边撑开多少（撑不够 → 淡化只淡了一半，另一半是静音，
 *    听起来和"淡化时长设短了"一模一样）；
 * 2. 包络的起点、时长和进度区间（错半个窗口 → 接缝处音量歪，但仍然是条平滑曲线）；
 * 3. 素材余量不够时源片区间**允许越界**（夹住 → 定格；而定格音频是直流台阶，
 *    松开时"啪"一声）。
 *
 * `OfflineAudioContext` 在 node 里造不出来，所以这些必须在接线之前就验完。
 */

import { describe, expect, it } from "vitest";
import { planAudioJobs } from "./mix-plan";
import { crossfadeGain } from "./crossfade";
import { FPS } from "../time/rational";
import type { Clip, MediaClip, MediaSource, Timeline, Track, Transition } from "../edl/types";

const FRAME_SECONDS = 1001 / 30_000; // ndf2997 一帧

/**
 * 时间字段比到**微秒**，不比到双精度。
 *
 * 管线里的秒一律由 `microsToSeconds(frameToMicros(...))` 算出来，中间过一道
 * 整数微秒——那是硬规则 1 要的，不是精度损失。拿精确有理数去比会红在亚微秒上，
 * 而那个偏差是设计本身。10µs 是**一帧的三千分之一**，任何真会出问题的错
 * （差半个窗口、差一帧、差半帧）都比它大四个数量级以上。
 */
const US = 5;

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

function clip(
  id: string,
  timelineIn: number,
  timelineOut: number,
  sourceIn = 0,
  transitionIn?: Transition,
): MediaClip {
  return {
    id,
    kind: "media",
    sourceId: "src",
    timelineIn,
    timelineOut,
    sourceIn,
    ...(transitionIn ? { transitionIn } : {}),
  };
}

function timeline(clips: Clip[], extra: Partial<Track> = {}): Timeline {
  return {
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: 400,
    tracks: [{ id: "A1", kind: "audio", clips, ...extra } as Track],
    sources: [source("src")],
  };
}

const FULL = { inFrame: 0, outFrame: 400 };

/** 两段相邻音频，交界在 100，入场段挂 20 帧等功率淡化 → 窗口 [90, 110)。 */
function crossfadeTimeline(kind: "xfade-power" | "xfade-linear" = "xfade-power"): Timeline {
  return timeline([
    clip("a", 0, 100, 200),
    clip("b", 100, 200, 500, { kind, frames: 20 }),
  ]);
}

const jobOf = (jobs: ReturnType<typeof planAudioJobs>, id: string) => {
  const job = jobs.find((j) => j.clipId === id);
  if (!job) throw new Error(`没有排到片段 ${id}`);
  return job;
};

describe("没有转场时", () => {
  it("排期就是片段占位，增益恒 1、没有包络", () => {
    const jobs = planAudioJobs(timeline([clip("a", 0, 100, 200)]), FULL);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.baseGain).toBe(1);
    expect(jobs[0]?.ramps).toEqual([]);
    expect(jobs[0]?.whenSeconds).toBeCloseTo(0, US);
    expect(jobs[0]?.srcStartSeconds).toBeCloseTo(200 * FRAME_SECONDS, US);
    expect(jobs[0]?.srcEndSeconds).toBeCloseTo(300 * FRAME_SECONDS, US);
  });

  it("静音轨整条不排", () => {
    expect(planAudioJobs(timeline([clip("a", 0, 100)], { muted: true }), FULL)).toEqual([]);
  });

  it("文字片段不排——它没有声音", () => {
    const tl = timeline([
      { id: "t", kind: "text", text: "字", timelineIn: 0, timelineOut: 100 } as Clip,
    ]);
    expect(planAudioJobs(tl, FULL)).toEqual([]);
  });

  it("完全落在导出区间之外的片段不排", () => {
    const jobs = planAudioJobs(timeline([clip("a", 0, 100)]), { inFrame: 200, outFrame: 400 });
    expect(jobs).toEqual([]);
  });
});

describe("片段音量", () => {
  const withVolume = (volume: number | undefined, transition = false): Timeline => {
    const base = transition
      ? crossfadeTimeline()
      : timeline([clip("a", 0, 100, 200), clip("b", 100, 200, 500)]);
    const track = base.tracks[0]!;
    return {
      ...base,
      tracks: [
        {
          ...track,
          clips: track.clips.map((c) =>
            c.id === "b" && volume !== undefined ? { ...c, volume } : c,
          ),
        },
      ],
    };
  };

  it("没调过音量的片段是 1", () => {
    expect(jobOf(planAudioJobs(withVolume(undefined), FULL), "b").volume).toBe(1);
  });

  it("原样带出来，只作用在自己那个片段上", () => {
    const jobs = planAudioJobs(withVolume(0.25), FULL);
    expect(jobOf(jobs, "b").volume).toBe(0.25);
    expect(jobOf(jobs, "a").volume).toBe(1);
  });

  it("**不乘进 baseGain**——两个来源在这一层必须还分得开", () => {
    // 乘在一起之后"淡化进度算错了"和"音量传错了"在返回值上长得一模一样，
    // 而这一层唯一的用处就是让一条断言只因为一个原因红。相乘在 envelopeInput。
    //
    // **导出区间必须从窗口中间切过去**：整条导出时入场片段的 baseGain 恰好是 0
    // （窗口起点上的淡化曲线值），而 `0 × 音量` 还是 0——那个用例里把音量乘进去
    // 一个字节都看不出来。反向验证当场抓到了这一点。窗口 [90,110)，从 100 切
    // → 进度 0.5 → 等功率增益 sin(π/4)，一个既不是 0 也不是 1 的值
    const cut = { inFrame: 100, outFrame: 400 };
    const plain = jobOf(planAudioJobs(withVolume(undefined, true), cut), "b");
    const quiet = jobOf(planAudioJobs(withVolume(0.25, true), cut), "b");

    expect(plain.baseGain).toBeCloseTo(Math.SQRT1_2, 6); // 健康值，先钉住它不是 0/1
    expect(quiet.baseGain).toBe(plain.baseGain);
    expect(quiet.ramps).toEqual(plain.ramps);
    expect(quiet.volume).toBe(0.25);
  });

  it("音量为 0 的片段照常排期", () => {
    // 不顺手跳过：等价的做法是"静音就别解码了"，但那对**静态**音量才成立，
    // 做包络之后 volume 会随时间变，那时"这一刻是 0"完全不意味着整段是静音
    const jobs = planAudioJobs(withVolume(0), FULL);
    expect(jobOf(jobs, "b").volume).toBe(0);
    expect(jobs).toHaveLength(2);
  });
});

describe("解码区间要按 clipRenderSpan 撑开", () => {
  it("出场段向后多解半个窗口，入场段向前多解半个窗口", () => {
    const jobs = planAudioJobs(crossfadeTimeline(), FULL);
    const a = jobOf(jobs, "a");
    const b = jobOf(jobs, "b");

    // a 占位 [0,100)，窗口 [90,110) → 解到 110，源片多要 10 帧
    expect(a.srcEndSeconds).toBeCloseTo((200 + 110) * FRAME_SECONDS, US);
    // b 占位 [100,200)，窗口起点 90 → 从时间轴 90 起播，源片位置往前 10 帧
    expect(b.whenSeconds).toBeCloseTo(90 * FRAME_SECONDS, US);
    expect(b.srcStartSeconds).toBeCloseTo((500 - 10) * FRAME_SECONDS, US);
  });

  it("按占位开区间就会短掉那两段——这是「淡化只淡了一半」的形态", () => {
    // 反过来钉一下：撑开量正好是半个窗口，不是 0、也不是整个窗口
    const jobs = planAudioJobs(crossfadeTimeline(), FULL);
    const a = jobOf(jobs, "a");
    // 除回帧数会把微秒量化放大成 2e-5 帧，所以比到千分之一帧
    const extraFrames = a.srcEndSeconds / FRAME_SECONDS - (200 + 100);
    expect(extraFrames).toBeCloseTo(10, 3);
  });
});

describe("增益包络", () => {
  it("出场段淡出、入场段淡入，都盖住整个窗口", () => {
    const jobs = planAudioJobs(crossfadeTimeline(), FULL);
    const a = jobOf(jobs, "a");
    const b = jobOf(jobs, "b");

    expect(a.ramps).toHaveLength(1);
    expect(a.ramps[0]).toMatchObject({ role: "from", kind: "xfade-power" });
    expect(a.ramps[0]?.startSeconds).toBeCloseTo(90 * FRAME_SECONDS, US);
    expect(a.ramps[0]?.durationSeconds).toBeCloseTo(20 * FRAME_SECONDS, US);
    expect(a.ramps[0]?.fromProgress).toBe(0);
    expect(a.ramps[0]?.toProgress).toBe(1);

    expect(b.ramps).toHaveLength(1);
    expect(b.ramps[0]).toMatchObject({ role: "to", fromProgress: 0, toProgress: 1 });
    expect(b.ramps[0]?.startSeconds).toBeCloseTo(90 * FRAME_SECONDS, US);
  });

  it("出场段起始增益是 1，入场段是 0", () => {
    const jobs = planAudioJobs(crossfadeTimeline(), FULL);
    expect(jobOf(jobs, "a").baseGain).toBe(1);
    // 入场段的 PCM 恰好起于窗口起点，那一刻它该是全静的。
    // 写死 1 的表现是成片在转场开头"咔"一下
    expect(jobOf(jobs, "b").baseGain).toBe(0);
  });

  it("曲线采样点数跟着实际窗口走，不跟请求时长走", () => {
    // 请求 20 帧但入场段只有 6 帧长 → 窗口被夹到 6 帧
    const tl = timeline([
      clip("a", 0, 100, 200),
      clip("b", 100, 106, 500, { kind: "xfade-power", frames: 20 }),
    ]);
    const b = jobOf(planAudioJobs(tl, FULL), "b");
    expect(b.ramps[0]?.points).toBe(7);
    expect(b.ramps[0]?.durationSeconds).toBeCloseTo(6 * FRAME_SECONDS, US);
  });

  it("种类原样传下去，两种曲线不会在这一层被抹平", () => {
    const linear = planAudioJobs(crossfadeTimeline("xfade-linear"), FULL);
    expect(jobOf(linear, "b").ramps[0]?.kind).toBe("xfade-linear");
  });
});

describe("一个片段同时是入场和出场", () => {
  it("排出两段包络，按时间先后，中间那截增益回到 1", () => {
    const tl = timeline([
      clip("a", 0, 100, 200),
      clip("b", 100, 200, 500, { kind: "xfade-power", frames: 20 }),
      clip("c", 200, 300, 800, { kind: "xfade-power", frames: 20 }),
    ]);
    const b = jobOf(planAudioJobs(tl, FULL), "b");
    expect(b.ramps).toHaveLength(2);
    expect(b.ramps[0]).toMatchObject({ role: "to" });
    expect(b.ramps[1]).toMatchObject({ role: "from" });
    expect(b.ramps[0]?.startSeconds).toBeLessThan(b.ramps[1]?.startSeconds ?? 0);
    // D19 保证两个窗口不重叠——重叠的话 setValueCurveAtTime 会直接抛
    const firstEnd = (b.ramps[0]?.startSeconds ?? 0) + (b.ramps[0]?.durationSeconds ?? 0);
    expect(firstEnd).toBeLessThanOrEqual(b.ramps[1]?.startSeconds ?? 0);
    // 解码区间两头都撑开了
    expect(b.srcStartSeconds).toBeCloseTo((500 - 10) * FRAME_SECONDS, US);
    expect(b.srcEndSeconds).toBeCloseTo((500 + 110) * FRAME_SECONDS, US);
  });
});

describe("素材余量不足", () => {
  it("源片区间允许为负——那一段自然静音，不夹回 0（夹了就成了定格）", () => {
    // 入场段 sourceIn=0，窗口要它入点之前 10 帧，源片没有
    const tl = timeline([
      clip("a", 0, 100, 200),
      clip("b", 100, 200, 0, { kind: "xfade-power", frames: 20 }),
    ]);
    const b = jobOf(planAudioJobs(tl, FULL), "b");
    expect(b.srcStartSeconds).toBeCloseTo(-10 * FRAME_SECONDS, US);
    // 起播时刻仍是窗口起点：区间和时间轴位置必须一一对应，
    // 只夹一头会让整段音频平移，表现为音画不同步
    expect(b.whenSeconds).toBeCloseTo(90 * FRAME_SECONDS, US);
  });
});

describe("导出区间从窗口中间切过去", () => {
  it("曲线从那一刻的进度接上，起始增益取那个值", () => {
    // 窗口 [90,110)，从 100 开始导出 → 入场段进度从 0.5 起
    const jobs = planAudioJobs(crossfadeTimeline(), { inFrame: 100, outFrame: 400 });
    const b = jobOf(jobs, "b");
    expect(b.ramps).toHaveLength(1);
    expect(b.ramps[0]?.fromProgress).toBeCloseTo(0.5, 9);
    expect(b.ramps[0]?.toProgress).toBe(1);
    expect(b.ramps[0]?.startSeconds).toBeCloseTo(0, US);
    expect(b.ramps[0]?.durationSeconds).toBeCloseTo(10 * FRAME_SECONDS, US);
    expect(b.baseGain).toBeCloseTo(crossfadeGain("xfade-power", "to", 0.5), 9);
    expect(b.baseGain).toBeGreaterThan(0.5); // 不是 0，也不是 1
  });

  it("出场段被切在窗口之前时包络原样保留", () => {
    const jobs = planAudioJobs(crossfadeTimeline(), { inFrame: 50, outFrame: 400 });
    const a = jobOf(jobs, "a");
    expect(a.baseGain).toBe(1);
    expect(a.ramps[0]?.fromProgress).toBe(0);
    expect(a.ramps[0]?.startSeconds).toBeCloseTo(40 * FRAME_SECONDS, US);
  });
});

describe("画面转场落在音频轨上", () => {
  it("不排包络（归一化会先清掉，这里只是不信任它）", () => {
    const tl = timeline([
      clip("a", 0, 100, 200),
      clip("b", 100, 200, 500, { kind: "dissolve", frames: 20 }),
    ]);
    const jobs = planAudioJobs(tl, FULL);
    expect(jobOf(jobs, "a").ramps).toEqual([]);
    expect(jobOf(jobs, "b").ramps).toEqual([]);
    expect(jobOf(jobs, "b").baseGain).toBe(1);
  });
});
