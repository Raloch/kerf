import { describe, expect, it } from "vitest";
import {
  bannerCopy,
  classifyPersistError,
  dismissBanner,
  nextBanner,
  NO_BANNER,
  topbarFailureText,
} from "./persist-status";

describe("把落盘失败折叠回根因", () => {
  it("配额满", () => {
    expect(classifyPersistError("QuotaExceededError: The quota has been exceeded.")).toBe("quota");
    expect(classifyPersistError("配额不够了 quota")).toBe("quota");
  });

  it("IndexedDB 用不了（隐私模式）", () => {
    expect(classifyPersistError("此环境没有 IndexedDB")).toBe("unavailable");
    expect(classifyPersistError("打不开 IndexedDB")).toBe("unavailable");
  });

  it("认不出来就是 unknown，不猜", () => {
    // 猜错的代价是给出一条走不通的出路（"去清理"而其实是隐私模式），
    // 比只说"存不进去"更坏
    expect(classifyPersistError("IndexedDB 事务被中止")).not.toBe("quota");
    expect(classifyPersistError("说不清的错")).toBe("unknown");
    expect(classifyPersistError(null)).toBe("unknown");
  });

  it("顶栏红字每一种根因都有一句，且都收得短", () => {
    for (const failure of ["quota", "unavailable", "unknown"] as const) {
      const text = topbarFailureText(failure);
      expect(text.length).toBeGreaterThan(0);
      // 顶栏那排按钮挤不掉的长度
      expect(text.length).toBeLessThanOrEqual(16);
    }
  });
});

describe("横幅文案", () => {
  it("**绝不说「改动不会被保住」这类话**", () => {
    // flush 写的是整份 timeline 不是增量，失败期间的编辑都还在内存里，清出空间后
    // 下一次防抖写会全部补上——说成永久丢失，用户会慌着关页面重开，那才是真丢
    for (const failure of ["quota", "unavailable", "unknown"] as const) {
      const { headline, advice } = bannerCopy(failure);
      const all = headline + advice;
      expect(all).not.toMatch(/不会被保住|保不住|已丢失|丢失了|无法保存改动/);
    }
  });

  it("配额满：出路是清理，而且明说别关标签", () => {
    const copy = bannerCopy("quota");
    expect(copy.offerCleanup).toBe(true);
    expect(copy.advice).toContain("别关这个标签");
    expect(copy.advice).toContain("自动接着保存");
  });

  it("配额数字问不到就不带数字", () => {
    // 同 D24 那条"配额问不到整条跳过"：编一个数字比沉默更坏
    expect(bannerCopy("quota").headline).toBe("改动暂时存不进浏览器（存储空间不足）。");
    expect(bannerCopy("quota", "上限约 2 GB").headline).toContain("上限约 2 GB");
  });

  it("隐私模式：出路是换窗口，**不给清理入口**", () => {
    const copy = bannerCopy("unavailable");
    // 库根本打不开，清理毫无用处——摆一个按钮就是给一条走不通的出路
    expect(copy.offerCleanup).toBe(false);
    expect(copy.advice).toContain("换一个普通窗口");
  });

  it("认不出根因时不编原因，也不给清理入口", () => {
    expect(bannerCopy("unknown").offerCleanup).toBe(false);
  });
});

describe("横幅状态机（正常/失败 × 弹过/没弹）", () => {
  it("第一次失败弹出来——这就是「沿」", () => {
    const next = nextBanner(NO_BANNER, false);
    expect(next).toEqual({ showing: true, announced: true });
  });

  it("同一失败期第二次失败**不再弹**", () => {
    // 自动存盘防抖 1 秒，失败会每秒重演；按次弹就是风暴
    // （同 D34 那条"给错误加限流会把风暴变成周期性抽动"）
    const first = nextBanner(NO_BANNER, false);
    const second = nextBanner(first, false);
    expect(second).toBe(first);
  });

  it("用户关掉之后，同一期的后续失败不会把它弹回来", () => {
    const shown = nextBanner(NO_BANNER, false);
    const dismissed = dismissBanner(shown);
    expect(dismissed).toEqual({ showing: false, announced: true });
    // showing 和 announced 合成一个布尔的话，关掉的横幅会在 1 秒后原地复活
    expect(nextBanner(dismissed, false)).toEqual({ showing: false, announced: true });
  });

  it("写成功一次就整个复位，**再失败算新的沿**", () => {
    const dismissed = dismissBanner(nextBanner(NO_BANNER, false));
    const recovered = nextBanner(dismissed, true);
    expect(recovered).toEqual(NO_BANNER);
    // 复位之后再失败要重新弹——否则"清理完又满了"这一次就没人告诉用户
    expect(nextBanner(recovered, false)).toEqual({ showing: true, announced: true });
  });

  it("一直成功就一直不弹", () => {
    let state = NO_BANNER;
    for (let i = 0; i < 5; i++) state = nextBanner(state, true);
    expect(state).toEqual(NO_BANNER);
  });

  it("一段失败期里只弹一次，哪怕失败了 60 次", () => {
    let state = NO_BANNER;
    let shownTimes = 0;
    for (let i = 0; i < 60; i++) {
      const before = state.showing;
      state = nextBanner(state, false);
      if (!before && state.showing) shownTimes += 1;
    }
    expect(shownTimes).toBe(1);
  });
});
