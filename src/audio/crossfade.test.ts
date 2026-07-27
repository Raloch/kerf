/**
 * 交叉淡化增益曲线的单测。
 *
 * 这里锁的是**听感语义**，不是"函数返回了个数"：等功率的判据是两条曲线平方和
 * 恒为 1、等增益的判据是和恒为 1。两者写反、或把 sin 写成 cos、或把 `role` 的
 * 镜像方向搞反，都**画得出一条看起来很合理的曲线**，只是接缝处响一下或沉一下——
 * 而那种错在波形图上要盯着看才发现，跑一次导出根本听不出来。
 *
 * 中点那两条是最要紧的：它正是两种曲线唯一会被用错的地方（等功率 0.707 /
 * 等增益 0.5），也是 ±3dB 那个差异的所在。
 */

import { describe, expect, it } from "vitest";
import {
  AUDIO_TRANSITION_KINDS,
  crossfadeCurve,
  crossfadeCurvePoints,
  crossfadeGain,
  isAudioTransitionKind,
} from "./crossfade";

const HALF_ROOT2 = Math.SQRT1_2; // 0.70710678…

describe("crossfadeGain 端点", () => {
  for (const kind of AUDIO_TRANSITION_KINDS) {
    it(`${kind}：t=0 时出场满、入场静`, () => {
      expect(crossfadeGain(kind, "from", 0)).toBeCloseTo(1, 10);
      expect(crossfadeGain(kind, "to", 0)).toBeCloseTo(0, 10);
    });

    it(`${kind}：t=1 时出场静、入场满`, () => {
      expect(crossfadeGain(kind, "from", 1)).toBeCloseTo(0, 10);
      expect(crossfadeGain(kind, "to", 1)).toBeCloseTo(1, 10);
    });

    it(`${kind}：越界的进度被夹住，不外推成负增益或反相`, () => {
      expect(crossfadeGain(kind, "to", -0.5)).toBe(crossfadeGain(kind, "to", 0));
      expect(crossfadeGain(kind, "to", 1.5)).toBe(crossfadeGain(kind, "to", 1));
    });

    it(`${kind}：出场单调降、入场单调升`, () => {
      let prevFrom = Number.POSITIVE_INFINITY;
      let prevTo = Number.NEGATIVE_INFINITY;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const from = crossfadeGain(kind, "from", t);
        const to = crossfadeGain(kind, "to", t);
        expect(from).toBeLessThanOrEqual(prevFrom + 1e-12);
        expect(to).toBeGreaterThanOrEqual(prevTo - 1e-12);
        prevFrom = from;
        prevTo = to;
      }
    });

    it(`${kind}：两条曲线互为镜像（把进度翻过来就相等）`, () => {
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        expect(crossfadeGain(kind, "from", t)).toBeCloseTo(
          crossfadeGain(kind, "to", 1 - t),
          12,
        );
      }
    });
  }
});

describe("等功率 xfade-power", () => {
  it("平方和恒为 1——这就是「等功率」的定义", () => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const from = crossfadeGain("xfade-power", "from", t);
      const to = crossfadeGain("xfade-power", "to", t);
      expect(from * from + to * to).toBeCloseTo(1, 12);
    }
  });

  it("中点两侧都是 √2/2，不是 0.5", () => {
    // 写成 0.5 就变成等增益了：不相关素材上中点功率掉到 1/√2，即 −1.5dB
    expect(crossfadeGain("xfade-power", "from", 0.5)).toBeCloseTo(HALF_ROOT2, 12);
    expect(crossfadeGain("xfade-power", "to", 0.5)).toBeCloseTo(HALF_ROOT2, 12);
  });

  it("中点的振幅和是 √2——相关素材上这就是那 +3dB", () => {
    const sum =
      crossfadeGain("xfade-power", "from", 0.5) + crossfadeGain("xfade-power", "to", 0.5);
    expect(sum).toBeCloseTo(Math.SQRT2, 12);
  });
});

describe("等增益 xfade-linear", () => {
  it("和恒为 1——这就是「等增益」的定义", () => {
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const from = crossfadeGain("xfade-linear", "from", t);
      const to = crossfadeGain("xfade-linear", "to", t);
      expect(from + to).toBeCloseTo(1, 12);
    }
  });

  it("中点两侧都是 0.5", () => {
    expect(crossfadeGain("xfade-linear", "from", 0.5)).toBeCloseTo(0.5, 12);
    expect(crossfadeGain("xfade-linear", "to", 0.5)).toBeCloseTo(0.5, 12);
  });

  it("中点的平方和是 0.5——不相关素材上这就是那 −1.5dB", () => {
    const from = crossfadeGain("xfade-linear", "from", 0.5);
    const to = crossfadeGain("xfade-linear", "to", 0.5);
    expect(from * from + to * to).toBeCloseTo(0.5, 12);
  });

  it("和等功率在中点确实不同（两条曲线没被写成同一条）", () => {
    expect(
      Math.abs(
        crossfadeGain("xfade-power", "to", 0.5) - crossfadeGain("xfade-linear", "to", 0.5),
      ),
    ).toBeGreaterThan(0.2);
  });
});

describe("crossfadeCurve", () => {
  it("点数 = 帧数 + 1，两端各含", () => {
    expect(crossfadeCurvePoints(16)).toBe(17);
    expect(crossfadeCurvePoints(2)).toBe(3);
  });

  it("窗口退化时仍给得出两个点——setValueCurveAtTime 少于 2 个点会抛", () => {
    expect(crossfadeCurvePoints(0)).toBe(2);
    expect(crossfadeCurvePoints(-5)).toBe(2);
    expect(crossfadeCurve("xfade-power", "to", 0, 1, 1)).toHaveLength(2);
  });

  // 曲线是 Float32Array（`setValueCurveAtTime` 要的就是它），所以和双精度的
  // 参照值比只能比到 f32 的分辨率。1e-6 仍相当于 −120dB，抓得住任何实际的错
  const F32 = 6;

  it("整段窗口：首尾正好是 0 和 1", () => {
    const curve = crossfadeCurve("xfade-power", "to", 0, 1, 17);
    expect(curve).toHaveLength(17);
    expect(curve[0]).toBeCloseTo(0, F32);
    expect(curve[16]).toBeCloseTo(1, F32);
  });

  it("每一点都落在 crossfadeGain 上——曲线只是它的采样，不是另一份实现", () => {
    const points = 9;
    for (const kind of AUDIO_TRANSITION_KINDS) {
      const curve = crossfadeCurve(kind, "from", 0, 1, points);
      for (let i = 0; i < points; i++) {
        expect(curve[i]).toBeCloseTo(crossfadeGain(kind, "from", i / (points - 1)), F32);
      }
    }
  });

  it("被导出区间切掉一头时，曲线从那个进度接上而不是从 0 重来", () => {
    // 从窗口 40% 处开始导出：入场层的起点应该已经是 0.4 的增益，不是 0。
    // 从 0 重来的表现是成片开头凭空多一段淡入
    const curve = crossfadeCurve("xfade-power", "to", 0.4, 1, 7);
    expect(curve[0]).toBeCloseTo(crossfadeGain("xfade-power", "to", 0.4), F32);
    expect(curve[0]).toBeGreaterThan(0.5);
    expect(curve[6]).toBeCloseTo(1, F32);
  });
});

describe("isAudioTransitionKind", () => {
  it("认得两种淡化", () => {
    expect(isAudioTransitionKind("xfade-power")).toBe(true);
    expect(isAudioTransitionKind("xfade-linear")).toBe(true);
  });

  it("四种画面转场都不算——它们混的是像素", () => {
    for (const kind of ["dissolve", "wipe", "iris", "slide"] as const) {
      expect(isAudioTransitionKind(kind)).toBe(false);
    }
  });
});
