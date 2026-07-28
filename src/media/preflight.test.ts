import { describe, expect, it } from "vitest";
import {
  estimateOutputBytes,
  findBlockers,
  type EnvironmentFacts,
  type ExportNeeds,
} from "./preflight";

/** 一切正常的环境：所有体检都该沉默。 */
const HEALTHY: EnvironmentFacts = {
  secureContext: true,
  hasVideoEncoder: true,
  hasVideoDecoder: true,
  hasAudioEncoder: true,
  hasOfflineAudioContext: true,
  hasOpfs: true,
  canPickSaveFile: true,
  quotaBytes: 10e9,
  usageBytes: 1e9,
};

const NEEDS: ExportNeeds = { audio: true, estimatedBytes: 100e6 };

describe("健康环境", () => {
  it("一条都不报", () => {
    expect(findBlockers(HEALTHY, NEEDS)).toEqual([]);
  });

  it("没有 picker 但空间充足也不报", () => {
    expect(findBlockers({ ...HEALTHY, canPickSaveFile: false }, NEEDS)).toEqual([]);
  });
});

describe("安全上下文是根因，派生现象要折叠掉", () => {
  /**
   * 这一组是这个模块存在的理由。非安全上下文里 WebCodecs 和 OPFS 全都不存在，
   * 于是"没有 VideoEncoder""没有 OPFS"会同时成立——但它们都是同一件事的派生。
   * 真机上正是被这串派生现象骗过，结论写成了"这台设备不支持 WebCodecs"。
   */
  const insecure: EnvironmentFacts = {
    ...HEALTHY,
    secureContext: false,
    hasVideoEncoder: false,
    hasVideoDecoder: false,
    hasAudioEncoder: false,
    hasOpfs: false,
    canPickSaveFile: false,
  };

  it("只报一条，不报由它派生的那几条", () => {
    const found = findBlockers(insecure, NEEDS);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("block");
  });

  it("那一条要指向真正该做的事，而不是“换浏览器”", () => {
    const [only] = findBlockers(insecure, NEEDS);
    // 出路必须提到 HTTPS/localhost——踩过的那次，读数是"设备不支持"而实际换个
    // scheme 就好了。只说"换用较新的浏览器"等于把人指向错误的方向
    expect(only?.wayOut).toMatch(/HTTPS|localhost/);
    // 也要点明局域网地址这个具体陷阱
    expect(only?.wayOut).toMatch(/192\.168|局域网/);
  });
});

describe("编解码器缺失", () => {
  it("缺编码器就阻断", () => {
    const found = findBlockers({ ...HEALTHY, hasVideoEncoder: false }, NEEDS);
    expect(found.map((b) => b.severity)).toEqual(["block"]);
  });

  it("缺解码器同样阻断——导出取帧必须顺序解码", () => {
    // 硬规则 3：不能退回 video.currentTime seek
    const found = findBlockers({ ...HEALTHY, hasVideoDecoder: false }, NEEDS);
    expect(found.map((b) => b.severity)).toEqual(["block"]);
  });

  it("每一条都必须带出路", () => {
    const found = findBlockers(
      { ...HEALTHY, hasVideoEncoder: false, hasAudioEncoder: false },
      NEEDS,
    );
    // 纯置灰不解释就是黑箱（D3）
    expect(found.length).toBeGreaterThan(0);
    for (const b of found) {
      expect(b.what.length).toBeGreaterThan(0);
      expect(b.wayOut.length).toBeGreaterThan(0);
    }
  });
});

describe("音频相关的只在这次导出要声音时才报", () => {
  const silent: ExportNeeds = { audio: false, estimatedBytes: 100e6 };

  it("不导声音时，缺音频编码器无所谓", () => {
    expect(findBlockers({ ...HEALTHY, hasAudioEncoder: false }, silent)).toEqual([]);
  });

  it("不导声音时，缺 OfflineAudioContext 也无所谓", () => {
    expect(findBlockers({ ...HEALTHY, hasOfflineAudioContext: false }, silent)).toEqual([]);
  });

  it("要声音时，缺 OfflineAudioContext 阻断（混音做不了）", () => {
    const found = findBlockers({ ...HEALTHY, hasOfflineAudioContext: false }, NEEDS);
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("block");
  });
});

describe("成品没地方写", () => {
  it("既没有 picker 也没有 OPFS 时阻断", () => {
    const found = findBlockers(
      { ...HEALTHY, canPickSaveFile: false, hasOpfs: false },
      NEEDS,
    );
    expect(found.some((b) => b.severity === "block")).toBe(true);
  });

  it("有 picker 时缺 OPFS 不算问题", () => {
    // 走 picker 时直接写用户选的文件，OPFS 在不在都无所谓
    expect(findBlockers({ ...HEALTHY, canPickSaveFile: true, hasOpfs: false }, NEEDS)).toEqual([]);
  });
});

describe("存储余量", () => {
  const tight: EnvironmentFacts = {
    ...HEALTHY,
    canPickSaveFile: false,
    quotaBytes: 200e6,
    usageBytes: 120e6, // 剩 80MB，而预计要写 100MB
  };

  it("余量不够时提醒，**不阻断**", () => {
    const found = findBlockers(tight, NEEDS);
    expect(found).toHaveLength(1);
    // 这一条建立在码率 × 时长的估算上，估算偏大时阻断掉的是一次本来能成的导出
    expect(found[0]?.severity).toBe("warn");
  });

  it("提醒里要同时给出预计大小和可用空间", () => {
    const [warn] = findBlockers(tight, NEEDS);
    // 只说"空间可能不够"分不清是差一点还是差十倍。同 M0 那条"两个操作数都要印出来"
    expect(warn?.what).toMatch(/100MB/);
    expect(warn?.what).toMatch(/80MB/);
  });

  it("走 picker 时不看站点配额——写的不是这里", () => {
    expect(findBlockers({ ...tight, canPickSaveFile: true }, NEEDS)).toEqual([]);
  });

  it("问不到配额时整个跳过，不当成 0", () => {
    // 把"问不到"当成 0 会在一堆正常环境上弹假警告，而假警告比没有警告更坏
    const unknown = { ...tight, quotaBytes: null, usageBytes: null };
    expect(findBlockers(unknown, NEEDS)).toEqual([]);
  });

  it("余量充裕时不提醒", () => {
    const roomy = { ...tight, quotaBytes: 10e9, usageBytes: 1e9 };
    expect(findBlockers(roomy, NEEDS)).toEqual([]);
  });

  it("预计大小为 0（还没算出来）时不提醒", () => {
    expect(findBlockers(tight, { audio: true, estimatedBytes: 0 })).toEqual([]);
  });
});

describe("成品大小估算", () => {
  it("码率乘时长，带一点容器开销", () => {
    // 10 Mbps + 128 kbps 跑 60 秒 = 607.68 Mbit ≈ 75.96 MB，×1.02
    expect(estimateOutputBytes(60, 10e6, 128e3)).toBe(77_479_200);
  });

  it("宁可算大一点——它只用来提醒，不用来禁止", () => {
    const exact = ((10e6 + 128e3) * 60) / 8;
    expect(estimateOutputBytes(60, 10e6, 128e3)).toBeGreaterThan(exact);
  });

  it("时长为负时按 0 算，不返回负数", () => {
    expect(estimateOutputBytes(-5, 10e6, 128e3)).toBe(0);
  });
});
