import { describe, expect, it } from "vitest";
import { FPS, rational } from "../time/rational";
import type { AudioOnlySource, AvSource, ImageSource, MediaSource } from "../edl/types";
import {
  checkReplacement,
  describeSourceMeta,
  reidentifiedFrom,
  sourceSeconds,
  DURATION_TOLERANCE_SECONDS,
} from "./reidentify";
import type { SourceMeta } from "./project-snapshot";

// ---- 夹具 ----

function av(over: Partial<AvSource> = {}): AvSource {
  return {
    id: "src-v",
    kind: "av",
    name: "IMG_4821.MOV",
    file: new File([new Uint8Array(4)], "IMG_4821.MOV"),
    fps: FPS.pal25,
    width: 1920,
    height: 1080,
    // 25fps × 1800 帧 = 72 秒
    durationFrames: 1800,
    hasAudio: true,
    videoCodec: "avc",
    audioCodec: "aac",
    ...over,
  };
}

function music(over: Partial<AudioOnlySource> = {}): AudioOnlySource {
  return {
    id: "src-a",
    kind: "audio",
    name: "BGM.mp3",
    file: new File([new Uint8Array(4)], "BGM.mp3"),
    hasAudio: true,
    audioCodec: "mp3",
    durationMicros: 184_000_000, // 3:04
    sampleRate: 48_000,
    channels: 2,
    ...over,
  };
}

function photo(over: Partial<ImageSource> = {}): ImageSource {
  return {
    id: "src-i",
    kind: "image",
    name: "logo.png",
    file: new File([new Uint8Array(4)], "logo.png"),
    hasAudio: false,
    width: 800,
    height: 400,
    mimeType: "image/png",
    frameCount: 1,
    audioCodec: null,
    ...over,
  };
}

/** 快照里的样子：去掉 `file`。 */
function metaOf(source: MediaSource): SourceMeta {
  const { file: _file, ...meta } = source;
  return meta as SourceMeta;
}

const PROJECT_FPS = FPS.ndf2997;

// ---- 描述 ----

describe("离线素材的描述（文件读不回来也说得出它该是什么样）", () => {
  it("视频：尺寸 · 帧率 · 时长", () => {
    expect(describeSourceMeta(metaOf(av()), PROJECT_FPS)).toBe("1920×1080 · 25 fps · 1:12.0");
  });

  it("纯音频：采样率 · 声道 · 时长（时长按**项目**帧率派生）", () => {
    // 纯音频素材没有自己的栅格，栅格是派生的——所以这里必须用项目帧率，
    // 而派生只有 `sourceDurationFrames` 一处实现（这条断言同时钉住那个复用）
    expect(describeSourceMeta(metaOf(music()), PROJECT_FPS)).toBe("48.0kHz · 2 声道 · 3:04.0");
  });

  it("单声道说「单声道」，不说「1 声道」", () => {
    expect(describeSourceMeta(metaOf(music({ channels: 1 })), PROJECT_FPS)).toContain("单声道");
  });

  it("图片：尺寸 · 格式（没有时长）", () => {
    expect(describeSourceMeta(metaOf(photo()), PROJECT_FPS)).toBe("800×400 · PNG");
  });
});

describe("素材时长（秒）", () => {
  it("视频按自己的帧率算", () => {
    expect(sourceSeconds(metaOf(av()), PROJECT_FPS)).toBeCloseTo(72, 6);
  });

  it("音频按微秒算", () => {
    expect(sourceSeconds(metaOf(music()), PROJECT_FPS)).toBeCloseTo(184, 6);
  });

  it("图片没有时长", () => {
    expect(sourceSeconds(metaOf(photo()), PROJECT_FPS)).toBeNull();
  });
});

// ---- 校验 ----

describe("指认校验：种类是硬拦，其余只是警告", () => {
  it("同一个文件重新指一遍：收下，一条警告都没有", () => {
    const check = checkReplacement(metaOf(av()), av(), PROJECT_FPS);
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings).toEqual([]);
  });

  it("拿音频去指认视频素材：**拒绝**", () => {
    // 这不是"换了一版素材"，是指错了文件——收下会让画面轨上的片段引用一个
    // 没有 fps/width 的素材，表现是代理去转一个没有视频轨的文件、合成器拿到 0×0
    const check = checkReplacement(metaOf(av()), music(), PROJECT_FPS);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("音频");
  });

  it("拿图片去指认视频素材：**拒绝**", () => {
    const check = checkReplacement(metaOf(av()), photo(), PROJECT_FPS);
    expect(check.ok).toBe(false);
  });

  it("拿视频去指认纯音频素材：**拒绝**", () => {
    const check = checkReplacement(metaOf(music()), av(), PROJECT_FPS);
    expect(check.ok).toBe(false);
  });

  it("尺寸不一样：收下，但要说一句（也许真重导了一版 720p）", () => {
    const check = checkReplacement(
      metaOf(av()),
      av({ width: 1280, height: 720 }),
      PROJECT_FPS,
    );
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings.some((w) => w.includes("尺寸不一样"))).toBe(true);
  });

  it("帧率不一样：收下，但要说一句", () => {
    const check = checkReplacement(
      metaOf(av()),
      // 30000/1001 上 2158 帧 ≈ 72.0 秒，把时长差压在容差内，让这条只测帧率
      av({ fps: FPS.ndf2997, durationFrames: 2158 }),
      PROJECT_FPS,
    );
    expect(check.ok).toBe(true);
    const warnings = check.ok ? check.warnings : [];
    expect(warnings.some((w) => w.includes("帧率不一样"))).toBe(true);
    expect(warnings.some((w) => w.includes("时长"))).toBe(false);
  });

  it("帧率**等价但写法不同**（25/1 与 50/2）不算不一样", () => {
    // 交叉相乘比较，不是逐字段比。逐字段比会把同一个帧率报成"不一样"，
    // 而那是个假警告——假警告比没有警告更坏（D24）
    const check = checkReplacement(
      metaOf(av()),
      av({ fps: rational(50, 2), durationFrames: 1800 }),
      PROJECT_FPS,
    );
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings).toEqual([]);
  });

  it("时长差在容差内不提（重导一遍差一两帧是编码噪声）", () => {
    // 25fps 下差 2 帧 = 0.08 秒 < 0.1
    const check = checkReplacement(metaOf(av()), av({ durationFrames: 1802 }), PROJECT_FPS);
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings).toEqual([]);
  });

  it("时长差超过容差要报出来，并写明差多少", () => {
    // 差 10 帧 = 0.4 秒，正是稿子里那句「时长差 0.4 秒，可能不是同一个文件」
    const check = checkReplacement(metaOf(av()), av({ durationFrames: 1810 }), PROJECT_FPS);
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings.some((w) => w.includes("时长差 0.4 秒"))).toBe(true);
  });

  it("容差是个真闸门：刚过线就报，没过线就不报", () => {
    const under = 0.5 * DURATION_TOLERANCE_SECONDS * 1_000_000;
    const over = 2 * DURATION_TOLERANCE_SECONDS * 1_000_000;
    const base = metaOf(music());
    const quiet = checkReplacement(base, music({ durationMicros: 184_000_000 + under }), PROJECT_FPS);
    const loud = checkReplacement(base, music({ durationMicros: 184_000_000 + over }), PROJECT_FPS);
    expect(quiet.ok && quiet.warnings).toEqual([]);
    expect(loud.ok && loud.warnings.some((w) => w.includes("时长差"))).toBe(true);
  });

  it("音频的采样率 / 声道数不一样也要说一句", () => {
    const check = checkReplacement(
      metaOf(music()),
      music({ sampleRate: 44_100, channels: 1 }),
      PROJECT_FPS,
    );
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings.some((w) => w.includes("采样率"))).toBe(true);
  });

  it("图片尺寸不一样也只是警告", () => {
    const check = checkReplacement(metaOf(photo()), photo({ width: 1600, height: 800 }), PROJECT_FPS);
    expect(check.ok).toBe(true);
    expect(check.ok && check.warnings.some((w) => w.includes("尺寸不一样"))).toBe(true);
  });
});

// ---- 收成指认结果 ----

describe("收成指认结果：探针的新 id 一律丢掉", () => {
  it("元数据换成新文件的，但 id 保住老的", () => {
    const probed = av({ id: "src-BRAND-NEW", name: "IMG_9999.mp4", width: 1280, height: 720 });
    const next = reidentifiedFrom("src-v", probed, ["尺寸不一样"]);
    // **EDL 引用的是 id**，用探针新生成的那个会让所有 sourceId 引用变成悬空的，
    // 而 resolveSource() 找不到就抛——表现是"指认完，打开就崩"
    expect(next.meta.id).toBe("src-v");
    // 其余字段全部来自新文件：只换文件不换元数据会留下一个陈旧的第二真值来源，
    // 而它错起来是静默的（取错帧、尾部几帧解不出来）
    expect(next.meta.kind === "av" && next.meta.width).toBe(1280);
    expect(next.meta.name).toBe("IMG_9999.mp4");
    expect(next.warnings).toEqual(["尺寸不一样"]);
  });

  it("文件被提出来，元数据里不再带它", () => {
    const next = reidentifiedFrom("src-v", av(), []);
    expect(next.file).toBeInstanceOf(File);
    expect("file" in next.meta).toBe(false);
  });
});
