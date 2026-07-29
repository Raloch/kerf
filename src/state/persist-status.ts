/**
 * 落盘失败的读数与显眼度（D37 第 3 刀）。**纯函数，不碰 IndexedDB 也不碰界面。**
 *
 * ## 为什么需要两级，而且都需要
 *
 * 失败是**持续状态**（配额满了不会自己好），所以要有常驻读数——顶栏那行红字。
 * 但数据丢失级别的警告不能只靠一行 10.5px 小字，所以还要在"正常 → 失败"的**沿**上
 * 弹一条横幅。**同一持续失败期内只弹一次**：自动存盘防抖 1 秒，失败会每秒重演，
 * 按次弹就是风暴（同 D34 那条"给错误加限流会把风暴变成周期性抽动"）。写成功一次
 * 之后横幅消失、顶栏回「已保存」，再失败算**新的沿**。
 *
 * 这个 2×2 状态机（正常/失败 × 弹过/没弹）就是这个文件存在的理由：它可单测，
 * 而"横幅弹了几次"在浏览器里靠肉眼数是数不清的。
 *
 * ## 文案不许说"改动不会被保住"
 *
 * `flush` 写的是**整份 timeline 不是增量**，失败期间的编辑都还在内存里，清出空间后
 * 下一次防抖写会**全部补上**——只有关掉标签才真丢。说成永久丢失，用户会慌着关页面
 * 重开，**那才是真丢**。所以文案由这里生成（而不是散在组件里），措辞才钉得住。
 *
 * ## 失败要折叠回根因（D24）
 *
 * 配额满是**运行时**才出现的，出路是清理；隐私模式下 IndexedDB 根本打不开，那是
 * 从第一次写就注定的**能力性事实**，出路是"换个窗口"，而且不该等用户编辑半天才说
 * ——首页进来就要提示。两者派生现象相同（都是"存不进去"），出路完全不同。
 */

/** 落盘失败的根因。派生现象都是"存不进去"，但出路不同。 */
export type PersistFailure =
  /** 配额满。运行时出现，出路是清理没人用的资产。 */
  | "quota"
  /** IndexedDB 用不了（隐私模式 / 被策略禁掉）。从第一次写就注定，出路是换窗口。 */
  | "unavailable"
  /** 其它。不编原因，只说存不进去。 */
  | "unknown";

/**
 * 把错误消息折叠回根因。
 *
 * 判据只认**结构性的证据**：`QuotaExceededError` 这个名字、以及我们自己在
 * `openDb()` 里抛的那句"此环境没有 IndexedDB"。**不做模糊猜测**——猜错的代价是
 * 给出一条走不通的出路（"去清理" 而其实是隐私模式），比只说"存不进去"更坏。
 */
export function classifyPersistError(message: string | null): PersistFailure {
  if (message === null) return "unknown";
  const lower = message.toLowerCase();
  if (lower.includes("quotaexceeded") || lower.includes("quota")) return "quota";
  if (message.includes("没有 IndexedDB") || lower.includes("indexeddb")) return "unavailable";
  return "unknown";
}

/** 顶栏那行常驻红字。**收得短**——真顶栏那排按钮挤不掉的长度。 */
export function topbarFailureText(failure: PersistFailure): string {
  switch (failure) {
    case "quota":
      return "存不进去了 · 空间不足";
    case "unavailable":
      return "存不进去了 · 这个窗口不保存";
    default:
      return "存不进去了";
  }
}

export interface BannerCopy {
  /** 加粗的那半句：出了什么事。 */
  readonly headline: string;
  /** 后半句：**用户现在该怎么办**。绝不说"改动不会被保住"。 */
  readonly advice: string;
  /** 出路是不是"清理没人用的资产"——只有配额满才是。 */
  readonly offerCleanup: boolean;
}

/**
 * 横幅文案。
 *
 * `quotaHint` 是"总共能存多少"这类补充说明，**问不到就不带数字**（同 D24 那条
 * "配额问不到整条跳过"）——编一个数字比沉默更坏。
 */
export function bannerCopy(failure: PersistFailure, quotaHint?: string): BannerCopy {
  if (failure === "unavailable") {
    return {
      headline: "这个窗口里项目不会被保存。",
      // 隐私模式下清理毫无用处（库根本打不开），所以这一支不给清理入口
      advice: "浏览器不让这个窗口用本地存储（无痕模式或被策略禁掉了）。换一个普通窗口打开就能正常保存。",
      offerCleanup: false,
    };
  }
  if (failure === "quota") {
    return {
      headline: `改动暂时存不进浏览器（存储空间不足${quotaHint ? `，${quotaHint}` : ""}）。`,
      // **不说"改动不会被保住"**：整份 timeline 每次都重写，清出空间后会全部补上
      advice: "别关这个标签——改动都还在，清出空间后会自动接着保存。",
      offerCleanup: true,
    };
  }
  return {
    headline: "改动暂时存不进浏览器。",
    advice: "别关这个标签——改动都还在，恢复之后会自动接着保存。",
    offerCleanup: false,
  };
}

/**
 * 横幅的状态。
 *
 * `announced` 是"这一段失败期已经弹过了"，它和 `showing` **必须分开**：用户点了
 * "知道了"之后 `showing` 变 false 而 `announced` 仍是 true，于是下一秒的同一个失败
 * 不会把它再弹回来。合成一个布尔的话，关掉的横幅会在 1 秒后原地复活。
 */
export interface BannerState {
  readonly showing: boolean;
  readonly announced: boolean;
}

export const NO_BANNER: BannerState = { showing: false, announced: false };

/**
 * 来了一次落盘读数之后，横幅该变成什么样。
 *
 * - 写成功 → 整个复位（横幅消失，**下一次失败算新的沿**）
 * - 失败且这一期没弹过 → 弹（这就是"沿"）
 * - 失败且弹过 → 原样不动，**不重新弹**
 */
export function nextBanner(prev: BannerState, ok: boolean): BannerState {
  if (ok) return NO_BANNER;
  if (prev.announced) return prev;
  return { showing: true, announced: true };
}

/** 用户点了"知道了"。这一期不再弹，但顶栏那行红字**照旧留着**——失败还在。 */
export function dismissBanner(prev: BannerState): BannerState {
  return { showing: false, announced: true };
}
