import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import type {
  Clip,
  FontSource,
  LutSource,
  MediaClip,
  MediaSource,
  TextClip,
  Timeline,
  Track,
} from "../edl/types";
import { computeDuration } from "./operations";
import {
  fromSnapshot,
  snapshotHasWork,
  SNAPSHOT_VERSION,
  toSnapshot,
  type ProjectSnapshot,
  type RestoreAssets,
} from "./project-snapshot";

// ---- 夹具 ----

function source(id: string, durationFrames = 1000): MediaSource {
  return {
    id,
    name: `${id}.mp4`,
    file: new File([`${id}`], `${id}.mp4`),
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames,
    hasAudio: true,
    videoCodec: "avc",
    audioCodec: "aac",
  };
}

function clip(id: string, timelineIn: number, timelineOut: number, sourceId = "src"): MediaClip {
  return { id, kind: "media", sourceId, timelineIn, timelineOut, sourceIn: 0, name: id };
}

function lut(id: string, size = 5): LutSource {
  return { id, name: `${id}.cube`, size, rgb: new Float32Array(size ** 3 * 3).fill(0.5) };
}

function font(family: string, name = `${family}.ttf`): FontSource {
  return { family, name, data: new Uint8Array([1, 2, 3, 4]).buffer };
}

function textClip(id: string, fontFamily?: string, extra?: Record<string, unknown>): TextClip {
  return {
    id,
    kind: "text",
    timelineIn: 0,
    timelineOut: 100,
    name: id,
    text: "字幕",
    ...(fontFamily !== undefined || extra !== undefined
      ? { style: { ...(fontFamily !== undefined ? { fontFamily } : {}), ...extra } }
      : {}),
  };
}

function timeline(
  tracks: Track[],
  sources = [source("src")],
  luts?: LutSource[],
  fonts?: FontSource[],
): Timeline {
  return {
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: computeDuration(tracks),
    tracks,
    sources,
    ...(luts !== undefined ? { luts } : {}),
    ...(fonts !== undefined ? { fonts } : {}),
  };
}

/** 把所有素材、LUT 和字体都完好交回来。 */
function allAssets(t: Timeline): RestoreAssets {
  return {
    files: new Map(t.sources.map((s) => [s.id, s.file])),
    luts: new Map((t.luts ?? []).map((l) => [l.id, l.rgb])),
    fonts: new Map((t.fonts ?? []).map((f) => [f.family, f.data])),
  };
}

const NO_ASSETS: RestoreAssets = { files: new Map(), luts: new Map(), fonts: new Map() };

describe("快照往返", () => {
  const original = timeline(
    [
      { id: "V1", kind: "video", clips: [clip("a", 0, 100), clip("b", 100, 200)] },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 200)] },
    ],
    [source("src")],
    [lut("L1")],
  );

  it("存下来的快照里没有 File，也没有查表数据", () => {
    const snap = toSnapshot(original, 42, 1000);
    // 这两条是这一层存在的理由：文件和查表数据单独存，快照才能随便重写
    expect(snap.timeline.sources[0]).not.toHaveProperty("file");
    expect(snap.timeline.luts?.[0]).not.toHaveProperty("rgb");
    // 元信息要全带上，否则恢复时得重新探针一遍
    expect(snap.timeline.sources[0]?.durationFrames).toBe(1000);
    expect(snap.timeline.luts?.[0]?.size).toBe(5);
  });

  it("资产齐全时逐字段恢复原样", () => {
    const snap = toSnapshot(original, 42, 1000);
    const r = fromSnapshot(snap, allAssets(original));
    expect(r.timeline).toEqual(original);
    expect(r.playhead).toBe(42);
    expect(r.droppedSources).toEqual([]);
    expect(r.droppedLuts).toEqual([]);
  });

  it("带上存盘时刻和播放头", () => {
    const snap = toSnapshot(original, 7, 1_700_000_000_000);
    expect(snap.savedAt).toBe(1_700_000_000_000);
    expect(snap.playhead).toBe(7);
    expect(snap.version).toBe(SNAPSHOT_VERSION);
  });

  it("没有 LUT 时字段整个不存在，不是 undefined", () => {
    const snap = toSnapshot(timeline([{ id: "V1", kind: "video", clips: [] }]), 0, 0);
    // exactOptionalPropertyTypes 下"字段存在但值是 undefined"是另一种类型，
    // 而下游判的是存在与否（同 CLAUDE.md 状态层那条"改回缺省值要把字段整个删掉"）
    expect("luts" in snap.timeline).toBe(false);
  });
});

describe("版本不认就拒掉", () => {
  it("版本号不同时抛错，而不是恢复出半坏的时间轴", () => {
    const snap = toSnapshot(timeline([{ id: "V1", kind: "video", clips: [] }]), 0, 0);
    const stale: ProjectSnapshot = { ...snap, version: SNAPSHOT_VERSION + 1 };
    expect(() => fromSnapshot(stale, NO_ASSETS)).toThrow(/版本不认/);
  });
});

describe("素材找不回来", () => {
  const t = timeline(
    [
      {
        id: "V1",
        kind: "video",
        clips: [clip("a", 0, 100, "gone"), clip("b", 100, 200, "kept")],
      },
      { id: "A1", kind: "audio", clips: [clip("m", 0, 60, "gone")] },
    ],
    [source("gone"), source("kept")],
  );
  const snap = toSnapshot(t, 150, 0);
  const partial: RestoreAssets = {
    files: new Map([["kept", source("kept").file]]),
    luts: new Map(),
    fonts: new Map(),
  };

  it("引用它的片段被移除，其余片段留下", () => {
    const r = fromSnapshot(snap, partial);
    const ids = r.timeline.tracks.flatMap((tr) => tr.clips.map((c) => c.id));
    // a 和 m 用的是 gone，必须走；b 用的是 kept，必须留
    expect(ids).toEqual(["b"]);
  });

  it("素材本身也不留在 sources 里", () => {
    const r = fromSnapshot(snap, partial);
    expect(r.timeline.sources.map((s) => s.id)).toEqual(["kept"]);
  });

  it("报出丢了哪个素材、连带走了几个片段", () => {
    const r = fromSnapshot(snap, partial);
    // **必须报**：用户丢了两个片段而软件一声不响，是数据层的"选了 A 拿到 B"
    expect(r.droppedSources).toEqual([{ name: "gone.mp4", clips: 2 }]);
  });

  it("没被用到的素材丢了也报，但片段数是 0", () => {
    const unused = timeline(
      [{ id: "V1", kind: "video", clips: [clip("b", 0, 100, "kept")] }],
      [source("gone"), source("kept")],
    );
    const r = fromSnapshot(toSnapshot(unused, 0, 0), partial);
    // "没用到"和"丢了三段"是两个结论，不能都缩成一句"有素材丢了"
    expect(r.droppedSources).toEqual([{ name: "gone.mp4", clips: 0 }]);
    expect(r.timeline.tracks[0]?.clips).toHaveLength(1);
  });

  it("时间轴总长跟着重算", () => {
    const r = fromSnapshot(snap, partial);
    // 原本 200（b 的出点）——这里 b 还在，所以仍是 200
    expect(r.timeline.durationFrames).toBe(200);
  });

  it("片段全没了之后总长归 0，播放头跟着夹回 0", () => {
    const r = fromSnapshot(snap, NO_ASSETS);
    expect(r.timeline.durationFrames).toBe(0);
    // 播放头留在时间轴外面会让预览一开始就是黑的，看着像恢复失败
    expect(r.playhead).toBe(0);
  });

  it("删掉前驱之后，后继片段的转场被清掉", () => {
    const withTransition = timeline(
      [
        {
          id: "V1",
          kind: "video",
          clips: [
            clip("a", 0, 100, "gone"),
            { ...clip("b", 100, 200, "kept"), transitionIn: { kind: "dissolve", frames: 20 } },
          ],
        },
      ],
      [source("gone"), source("kept")],
    );
    const r = fromSnapshot(toSnapshot(withTransition, 0, 0), partial);
    const b = r.timeline.tracks[0]?.clips[0];
    // 转场挂在入场片段上、相邻关系不由类型保证。前驱被移除之后留着它就是
    // "界面显示有转场、画面上没有"，而两边都不报错
    expect(b?.id).toBe("b");
    expect(b?.transitionIn).toBeUndefined();
  });
});

describe("LUT 找不回来（和素材不对称）", () => {
  const t = timeline(
    [
      {
        id: "V1",
        kind: "video",
        clips: [{ ...clip("a", 0, 100), lutId: "L1" }, clip("b", 100, 200)],
      },
    ],
    [source("src")],
    [lut("L1")],
  );
  const snap = toSnapshot(t, 0, 0);
  const noLut: RestoreAssets = {
    files: new Map([["src", source("src").file]]),
    luts: new Map(),
    fonts: new Map(),
  };

  it("片段保留，只清掉 lutId", () => {
    const r = fromSnapshot(snap, noLut);
    const clips = r.timeline.tracks[0]?.clips ?? [];
    // 素材没了片段不能渲染（resolveSource 会抛），LUT 没了片段照样渲染——
    // 所以这里删字段而不是删片段
    expect(clips.map((c) => c.id)).toEqual(["a", "b"]);
    expect(clips[0]?.lutId).toBeUndefined();
  });

  it("清掉的是字段本身，不是赋 undefined", () => {
    const r = fromSnapshot(snap, noLut);
    const a = r.timeline.tracks[0]?.clips[0] as Clip;
    expect("lutId" in a).toBe(false);
  });

  it("报出丢了哪张表", () => {
    const r = fromSnapshot(snap, noLut);
    expect(r.droppedLuts).toEqual(["L1.cube"]);
    // 一张都没剩时 luts 字段整个不存在
    expect("luts" in r.timeline).toBe(false);
  });
});

describe("字体找不回来（同 LUT 那条不对称，但必须清）", () => {
  const t = timeline(
    [
      {
        id: "T1",
        kind: "video",
        clips: [textClip("t1", "KerfFont-1", { color: "#ff0000" }), textClip("t2", "KerfFont-1")],
      },
    ],
    [source("src")],
    undefined,
    [font("KerfFont-1")],
  );
  const snap = toSnapshot(t, 0, 0);
  const noFont: RestoreAssets = {
    files: new Map([["src", source("src").file]]),
    luts: new Map(),
    fonts: new Map(),
  };

  it("存下来的快照里没有字体字节", () => {
    // 快照每次编辑都重写，而一个 CJK 字体动辄 10–20MB
    expect(snap.timeline.fonts?.[0]).not.toHaveProperty("data");
    expect(snap.timeline.fonts?.[0]?.name).toBe("KerfFont-1.ttf");
  });

  it("资产齐全时逐字段恢复原样", () => {
    expect(fromSnapshot(snap, allAssets(t)).timeline).toEqual(t);
  });

  it("片段保留，但 fontFamily **必须**清掉", () => {
    const r = fromSnapshot(snap, noFont);
    const clips = r.timeline.tracks[0]?.clips ?? [];
    expect(clips.map((c) => c.id)).toEqual(["t1", "t2"]);
    // 留着的话渲染时 rasterizeText 会抛（那道断言是刻意的），
    // 表现成"恢复完预览就崩"——这是它和 lutId 唯一的差别
    expect((clips[0] as TextClip).style?.fontFamily).toBeUndefined();
  });

  it("样式里其余项留着，清掉的是字段本身", () => {
    const t1 = fromSnapshot(snap, noFont).timeline.tracks[0]?.clips[0] as TextClip;
    expect(t1.style?.color).toBe("#ff0000");
    expect("fontFamily" in (t1.style ?? {})).toBe(false);
  });

  it("样式里只有字体时，style 整个删掉而不是留一个空对象", () => {
    const t2 = fromSnapshot(snap, noFont).timeline.tracks[0]?.clips[1] as TextClip;
    // 同状态层那条"改回缺省值要把字段整个删掉"：留 `{}` 会让
    // "这个片段动过样式没有"在数据层看不出来
    expect("style" in t2).toBe(false);
  });

  it("报出丢了哪个字体，一个都没剩时字段整个不存在", () => {
    const r = fromSnapshot(snap, noFont);
    expect(r.droppedFonts).toEqual(["KerfFont-1.ttf"]);
    expect("fonts" in r.timeline).toBe(false);
  });

  it("LUT 和字体同时丢了，两条规则都要生效", () => {
    // 一条命中就 continue 的写法会让先判的那条把另一条挡掉，而且不报错
    const both = timeline(
      [{ id: "T1", kind: "video", clips: [{ ...textClip("t1", "KerfFont-1"), lutId: "L1" }] }],
      [source("src")],
      [lut("L1")],
      [font("KerfFont-1")],
    );
    const r = fromSnapshot(toSnapshot(both, 0, 0), noFont);
    const t1 = r.timeline.tracks[0]?.clips[0] as TextClip;
    expect("lutId" in t1).toBe(false);
    expect("style" in t1).toBe(false);
    expect(r.droppedLuts).toEqual(["L1.cube"]);
    expect(r.droppedFonts).toEqual(["KerfFont-1.ttf"]);
  });

  it("系统字体族不受影响", () => {
    const sys = timeline(
      [{ id: "T1", kind: "video", clips: [textClip("t1", '"PingFang SC", sans-serif')] }],
      [source("src")],
    );
    const t1 = fromSnapshot(toSnapshot(sys, 0, 0), noFont).timeline.tracks[0]?.clips[0] as TextClip;
    // 系统族名不需要注册，也就不存在"找不回来"
    expect(t1.style?.fontFamily).toBe('"PingFang SC", sans-serif');
  });
});

describe("值不值得提议恢复", () => {
  it("有片段才算有编辑成果", () => {
    const withClip = toSnapshot(
      timeline([{ id: "V1", kind: "video", clips: [clip("a", 0, 10)] }]),
      0,
      0,
    );
    expect(snapshotHasWork(withClip)).toBe(true);
  });

  it("导入了素材但一个片段都没放，不值得问", () => {
    // 恢复它等于什么都没恢复，而弹一句"要不要恢复上次编辑"是纯噪声
    const empty = toSnapshot(timeline([{ id: "V1", kind: "video", clips: [] }]), 0, 0);
    expect(snapshotHasWork(empty)).toBe(false);
  });
});
