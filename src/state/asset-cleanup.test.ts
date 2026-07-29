import { describe, expect, it } from "vitest";
import { FPS } from "../time/rational";
import type { SnapshotTimeline } from "./project-snapshot";
import {
  CLEANUP_MIN_AGE_MS,
  cleanupLabel,
  fontAssetKey,
  formatBytes,
  lutAssetKey,
  planCleanup,
  referencedAssetKeys,
  sourceAssetKey,
  storageLine,
  type AssetEntry,
} from "./asset-cleanup";

// ---- 夹具 ----

const NOW = 1_700_000_000_000;
const OLD = NOW - CLEANUP_MIN_AGE_MS - 1;
const FRESH = NOW - 1_000;

function timeline(over: Partial<SnapshotTimeline> = {}): SnapshotTimeline {
  return {
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: 0,
    tracks: [],
    sources: [],
    ...over,
  } as SnapshotTimeline;
}

function avMeta(id: string) {
  return {
    id,
    kind: "av" as const,
    name: `${id}.mp4`,
    fps: FPS.ndf2997,
    width: 1920,
    height: 1080,
    durationFrames: 300,
    hasAudio: false,
    videoCodec: "avc",
    audioCodec: null,
  };
}

function entry(key: string, bytes = 1024, writtenAt: number | null = OLD): AssetEntry {
  return { key, bytes, writtenAt };
}

// ---- 引用集合 ----

describe("引用集合要从所有项目算", () => {
  it("两个项目各自的素材都算被引用", () => {
    const a = timeline({ sources: [avMeta("s1")] });
    const b = timeline({ sources: [avMeta("s2")] });
    const keys = referencedAssetKeys([a, b]);
    expect([...keys].sort()).toEqual(["source:s1", "source:s2"]);
  });

  it("**漏传一个项目就会把它的素材当孤儿**", () => {
    // 这条断言存在的理由：漏一个项目就删一批，而误删的表现是"下次打开素材丢了"，
    // 全程不报错。所以调用方必须传全部快照，这里把后果钉出来
    const a = timeline({ sources: [avMeta("s1")] });
    const b = timeline({ sources: [avMeta("s2")] });
    const partial = referencedAssetKeys([a]); // 刻意漏掉 b
    const plan = planCleanup([entry(sourceAssetKey("s2"))], partial, NOW);
    expect(plan.removable).toHaveLength(1);
    // 传全了就不会被当孤儿
    expect(planCleanup([entry(sourceAssetKey("s2"))], referencedAssetKeys([a, b]), NOW).removable)
      .toHaveLength(0);
  });

  it("副本共享同一个 sourceId 时，删掉一个项目另一个还引用着它", () => {
    // 「制作副本」让两个项目共享 sourceId 是**对的**（File 是磁盘引用），
    // 所以"还有没有人用"只能全局回答
    const original = timeline({ sources: [avMeta("shared")] });
    const copy = timeline({ sources: [avMeta("shared")] });
    const afterDeletingCopy = referencedAssetKeys([original]);
    expect(afterDeletingCopy.has(sourceAssetKey("shared"))).toBe(true);
    expect(referencedAssetKeys([copy]).has(sourceAssetKey("shared"))).toBe(true);
  });

  it("LUT 和字体也算引用", () => {
    const t = timeline({
      luts: [{ id: "L1", name: "look.cube", size: 5 }],
      fonts: [{ family: "KerfFont-1", name: "n.ttf" }],
    });
    const keys = referencedAssetKeys([t]);
    expect(keys.has(lutAssetKey("L1"))).toBe(true);
    expect(keys.has(fontAssetKey("KerfFont-1"))).toBe(true);
  });

  it("导入了但一个片段都没放的素材**照样算被引用**", () => {
    // 按片段算会把它当孤儿删掉，而素材库里那一行还在——用户还能把它拖上时间轴
    const t = timeline({ sources: [avMeta("unused")], tracks: [] });
    expect(referencedAssetKeys([t]).has(sourceAssetKey("unused"))).toBe(true);
  });

  it("一个项目都没有时，什么都没被引用", () => {
    expect(referencedAssetKeys([]).size).toBe(0);
  });
});

// ---- 清理计划 ----

describe("清理判据是「孤儿 + 够老」", () => {
  const referenced = new Set([sourceAssetKey("keep")]);

  it("有人引用的一律不动，哪怕很老", () => {
    const plan = planCleanup([entry(sourceAssetKey("keep"), 999, OLD)], referenced, NOW);
    expect(plan.removable).toHaveLength(0);
    expect(plan.tooYoung).toHaveLength(0);
  });

  it("孤儿且够老才可删", () => {
    const plan = planCleanup([entry(sourceAssetKey("gone"), 2048, OLD)], referenced, NOW);
    expect(plan.removable.map((e) => e.key)).toEqual(["source:gone"]);
    expect(plan.removableBytes).toBe(2048);
  });

  it("**孤儿但刚写入的不删**——那正是跨标签的危险窗口", () => {
    // 标签 A 刚导入素材（assets 已写、快照还没写），标签 B 回首页点清理
    const plan = planCleanup([entry(sourceAssetKey("justnow"), 512, FRESH)], referenced, NOW);
    expect(plan.removable).toHaveLength(0);
    expect(plan.tooYoung.map((e) => e.key)).toEqual(["source:justnow"]);
  });

  it("年龄闸的边界：恰好到点算够老，差一毫秒就不删", () => {
    // "够老"= 至少这么老，所以恰好等于阈值时可删；晚一毫秒写入的就留到下一轮
    const onEdge = NOW - CLEANUP_MIN_AGE_MS;
    expect(planCleanup([entry("source:x", 1, onEdge)], referenced, NOW).removable).toHaveLength(1);
    expect(planCleanup([entry("source:x", 1, onEdge + 1)], referenced, NOW).removable).toHaveLength(0);
  });

  it("**没有时间戳的旧记录：这一轮先别删，等回填**", () => {
    // 绝不能当成"没有时间戳 = 很老 = 可以删"——那会把加时间戳之前导入的
    // 所有素材一次删光，而且不报错
    const plan = planCleanup([entry(sourceAssetKey("legacy"), 4096, null)], referenced, NOW);
    expect(plan.removable).toHaveLength(0);
    expect(plan.tooYoung).toHaveLength(0);
    expect(plan.needsStamp.map((e) => e.key)).toEqual(["source:legacy"]);
    // 它一个字节都不算进"能清多少"——不然按钮上的数字是骗人的
    expect(plan.removableBytes).toBe(0);
  });

  it("没有时间戳但**有人引用**时，连回填都不必", () => {
    const plan = planCleanup([entry(sourceAssetKey("keep"), 1, null)], referenced, NOW);
    expect(plan.needsStamp).toHaveLength(0);
  });

  it("三种孤儿混在一起时各归各类", () => {
    const plan = planCleanup(
      [
        entry("source:a", 100, OLD),
        entry("source:b", 200, FRESH),
        entry("source:c", 400, null),
        entry(sourceAssetKey("keep"), 800, OLD),
      ],
      referenced,
      NOW,
    );
    expect(plan.removable.map((e) => e.key)).toEqual(["source:a"]);
    expect(plan.tooYoung.map((e) => e.key)).toEqual(["source:b"]);
    expect(plan.needsStamp.map((e) => e.key)).toEqual(["source:c"]);
    expect(plan.removableBytes).toBe(100);
  });
});

describe("清理按钮文案", () => {
  it("没东西可清时不摆按钮", () => {
    // 一个写着"0 项"的清理入口只会让人以为清理坏了
    expect(cleanupLabel(planCleanup([], new Set(), NOW))).toBeNull();
    expect(cleanupLabel(planCleanup([entry("source:x", 1, FRESH)], new Set(), NOW))).toBeNull();
  });

  it("有东西可清时报出项数和字节", () => {
    const plan = planCleanup(
      [entry("source:x", 1024 * 1024, OLD), entry("font:y", 1024 * 1024, OLD)],
      new Set(),
      NOW,
    );
    expect(cleanupLabel(plan)).toBe("清理没人用的 · 2 项 / 2.0 MB");
  });
});

// ---- 存储读数 ----

describe("存储读数：自己数，空态沉默", () => {
  it("**一个字节都没存时整条不出现**", () => {
    // quota 不是磁盘空间（跨浏览器语义不一致，必然被读成"磁盘剩多少"），
    // 而一个字节都没存时根本没有读数可报——编一个数字比沉默更坏（D25）
    expect(storageLine({ projectBytes: 0, assetBytes: 0 })).toBeNull();
  });

  it("有项目没字体时只报项目那一项", () => {
    const line = storageLine({ projectBytes: 2 * 1024 * 1024, assetBytes: 0 });
    expect(line).toContain("浏览器里存了 2.0 MB");
    expect(line).toContain("项目 2.0 MB");
    expect(line).not.toContain("字体");
  });

  it("**字体和 LUT 要单独报**，不能笼统说「素材不占浏览器存储」", () => {
    // File 是磁盘引用不占字节，但 LUT 的 rgb 和字体的字节是真存进 IndexedDB 的
    // （45³ LUT = 1.09MB，一个 CJK 字体 10–20MB）——不分项的话带字体的项目
    // 会显示 2MB 而实际占 20MB
    const line = storageLine({ projectBytes: 2 * 1024 * 1024, assetBytes: 16 * 1024 * 1024 });
    expect(line).toContain("浏览器里存了 18.0 MB");
    expect(line).toContain("项目 2.0 MB");
    expect(line).toContain("字体与 LUT 16.0 MB");
    // 并且要说清视频音频图片不占这里，否则用户会以为素材被复制进浏览器了
    expect(line).toContain("磁盘引用");
  });
});

describe("字节格式化", () => {
  it("按量级换单位", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("资产键只有一处定义", () => {
  it("三种资产的键前缀互不相同", () => {
    // 散在读写两侧各写一遍的话，清理侧算出来的引用集合会和存储侧差一个字，
    // 而那表现为"清理把所有素材都当成孤儿"——删光且不报错
    expect(sourceAssetKey("x")).toBe("source:x");
    expect(lutAssetKey("x")).toBe("lut:x");
    expect(fontAssetKey("x")).toBe("font:x");
  });
});
