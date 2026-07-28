/**
 * 导出前的**环境体检**：在用户点导出之前回答"这台机器上这次导出能不能成"，
 * 并且**说出真正的那个原因**。
 *
 * ## 为什么不能只靠编码器探测
 *
 * `capability-probe.ts` 回答的是"能编哪个编码"，而它在环境不对时给出的答案是
 * **一串派生现象**：安全上下文不满足时 `VideoEncoder` 根本不存在，于是四个编码
 * 全报"不可用"，界面上写着"这个浏览器不能编码视频"——而真实原因是页面用
 * `http://192.168.x.x` 打开的（`localhost` 算安全上下文，局域网 IP 不算）。
 * 这个坑真机自检时踩过：读数是"这台设备不支持 WebCodecs"，实际换成 HTTPS 就好了。
 *
 * 所以这一层的核心不是"多探几个 API"，而是**把派生现象折叠回根因**：安全上下文
 * 不满足时只报那一条，不再报由它派生的四条。同这一轮查移动端那三道假墙的教训——
 * 别把派生现象当成独立读数。
 *
 * ## 阻断和提醒要分开，而且估算只能提醒
 *
 * "没有 WebCodecs"是硬阻断：导出不可能成。"存储空间可能不够"**只能是提醒**——
 * 它建立在码率 × 时长的估算上，而估算偏大时挡掉的是一次本来能成的导出。宁可让
 * 用户撞上一次失败（而且现在有清理入口和明确文案），也不要用一个估算去禁止。
 *
 * 判据本身是有价值的：Safari 在存储满时把失败报成 `The operation failed for an
 * unknown transient reason (e.g. out of memory)`，完全看不出是空间问题（见导出层
 * 约定）。提前说一句"预计要写 520MB，当前可用 180MB"，那次失败就有解释了。
 *
 * ## 决策是纯函数
 *
 * `findBlockers` 只吃事实、只吐结论，所以"安全上下文要折叠掉哪几条""什么时候
 * 才该看存储"这些取舍能单测。读事实那一半（`readEnvironment`）没法单测，
 * 但它只是一串 `typeof x !== "undefined"`。
 */

/** 环境事实。全部**只读一次就有答案**，不需要 mediabunny，所以可以静态 import。 */
export interface EnvironmentFacts {
  /**
   * 安全上下文。**这是根因级别的一条**：不满足时 WebCodecs 和 OPFS 都不存在，
   * 于是下面那些 `has*` 会集体为 false，而它们全是这一条的派生现象。
   */
  readonly secureContext: boolean;
  readonly hasVideoEncoder: boolean;
  readonly hasVideoDecoder: boolean;
  readonly hasAudioEncoder: boolean;
  /** 混音要用它，而它在 Worker 里不可用（硬规则 6），所以查的是主线程这一份。 */
  readonly hasOfflineAudioContext: boolean;
  /** OPFS。没有 picker 时成品**只能**走它，见导出层约定里的 `canPickSaveFile`。 */
  readonly hasOpfs: boolean;
  readonly canPickSaveFile: boolean;
  /** 存储配额与已用量，问不到时为 null（那时就不体检存储，而不是当成 0）。 */
  readonly quotaBytes: number | null;
  readonly usageBytes: number | null;
}

export async function readEnvironment(): Promise<EnvironmentFacts> {
  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    quotaBytes = estimate?.quota ?? null;
    usageBytes = estimate?.usage ?? null;
  } catch {
    // 问不到就是问不到，不猜。null 会让存储那条体检整个跳过
  }
  return {
    secureContext: typeof isSecureContext === "boolean" ? isSecureContext : false,
    hasVideoEncoder: typeof VideoEncoder !== "undefined",
    hasVideoDecoder: typeof VideoDecoder !== "undefined",
    hasAudioEncoder: typeof AudioEncoder !== "undefined",
    hasOfflineAudioContext: typeof OfflineAudioContext !== "undefined",
    hasOpfs: typeof navigator.storage?.getDirectory === "function",
    canPickSaveFile: typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker
      === "function",
    quotaBytes,
    usageBytes,
  };
}

/** 这次导出要用到什么。 */
export interface ExportNeeds {
  readonly audio: boolean;
  /** 预计要写多少字节。见 `estimateOutputBytes`。 */
  readonly estimatedBytes: number;
}

export interface Blocker {
  /**
   * `block` = 导出不可能成，禁掉按钮；`warn` = 大概能成但值得说一句。
   *
   * **估算出来的结论只能是 `warn`**，理由见文件头。
   */
  readonly severity: "block" | "warn";
  /** 一句话说是什么问题。 */
  readonly what: string;
  /** 出路。**不能为空**——纯置灰不解释就是黑箱（同 D3）。 */
  readonly wayOut: string;
}

/**
 * 预计成品字节数。
 *
 * 码率 × 时长，加 2% 容器开销。粗糙是刻意的：它只用来在"可用空间只剩一点"时
 * 提个醒，而不用来禁止任何事（文件头）。所以宁可算得略大。
 */
export function estimateOutputBytes(
  seconds: number,
  videoBitrate: number,
  audioBitrate: number,
): number {
  const bits = (videoBitrate + audioBitrate) * Math.max(0, seconds);
  return Math.round((bits / 8) * 1.02);
}

/** 空间余量低于预计成品的这个倍数就提醒。1.2：写的时候还要留点周转。 */
const STORAGE_MARGIN = 1.2;

export function findBlockers(facts: EnvironmentFacts, needs: ExportNeeds): Blocker[] {
  /**
   * **安全上下文不满足时只报这一条。**
   *
   * WebCodecs 和 OPFS 在非安全上下文里根本不存在，所以再报"没有 VideoEncoder"
   * 是把同一件事说四遍，而且四遍里没有一遍指向真正该做的事（换成 HTTPS 或
   * localhost）。真机自检时正是被这串派生现象骗过：结论写成"这台设备不支持"。
   */
  if (!facts.secureContext) {
    return [
      {
        severity: "block",
        what: "这个页面不是安全上下文，浏览器不会提供 WebCodecs 和 OPFS——导出用到的所有底层能力都不存在。",
        wayOut:
          "用 HTTPS 打开，或者用 localhost。注意 http://192.168.x.x 这样的局域网地址不算安全上下文，" +
          "表现会像“这台设备不支持导出”。",
      },
    ];
  }

  const blockers: Blocker[] = [];

  // 编解码器：解码同样是硬前提——导出取帧必须顺序解码（硬规则 3）
  if (!facts.hasVideoEncoder || !facts.hasVideoDecoder) {
    blockers.push({
      severity: "block",
      what: "这个浏览器没有 WebCodecs 的视频编解码器。",
      wayOut: "换用较新的 Chrome / Edge / Safari。导出在本机完成，没有服务端转码这条路。",
    });
  }

  if (needs.audio && !facts.hasAudioEncoder) {
    blockers.push({
      severity: "block",
      what: "这个浏览器没有音频编码器，而这次导出包含声音。",
      wayOut: "关掉音频只导画面，或者换用较新的浏览器。",
    });
  }

  if (needs.audio && !facts.hasOfflineAudioContext) {
    blockers.push({
      severity: "block",
      what: "这个浏览器没有 OfflineAudioContext，多轨混音做不了。",
      wayOut: "关掉音频只导画面，或者换用较新的浏览器。",
    });
  }

  /**
   * 没有 picker 时成品**只能**写 OPFS，所以那时 OPFS 缺失是硬阻断；
   * 有 picker 时我们直接写用户选的文件，OPFS 在不在都无所谓。
   */
  if (!facts.canPickSaveFile && !facts.hasOpfs) {
    blockers.push({
      severity: "block",
      what: "这个浏览器既没有保存对话框，也没有 OPFS，成品没有地方可写。",
      wayOut: "换用较新的浏览器。导出结果是流式写盘的（硬规则 9），没有“先攒成内存里的一整块”这条退路。",
    });
  }

  /**
   * 存储余量。只在**成品要写 OPFS**时看——走 picker 时写的是用户自己选的位置，
   * 那里的空间不是我们能问的（`navigator.storage` 只报站点配额）。
   *
   * 问不到配额（`null`）就整个跳过，不要把"问不到"当成 0：那会在一堆正常环境上
   * 弹一句假警告，而假警告比没有警告更坏——用户很快就学会无视它。
   */
  if (
    !facts.canPickSaveFile &&
    facts.quotaBytes !== null &&
    facts.usageBytes !== null &&
    needs.estimatedBytes > 0
  ) {
    const free = facts.quotaBytes - facts.usageBytes;
    if (free < needs.estimatedBytes * STORAGE_MARGIN) {
      blockers.push({
        severity: "warn",
        what:
          `预计成品约 ${formatBytes(needs.estimatedBytes)}，而这个站点当前可用空间约 ` +
          `${formatBytes(Math.max(0, free))}，可能写不下。`,
        // Safari 把存储满报成 "unknown transient reason (e.g. out of memory)"，
        // 完全看不出是空间问题——提前说一句，那次失败才有解释
        wayOut: "先清掉下面列出的导出残留，或者降低分辨率/码率。空间不足时的报错通常看不出是空间问题。",
      });
    }
  }

  return blockers;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)}MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))}KB`;
}
