/**
 * 自动存盘：把当前项目的 EDL 定期写进 IndexedDB。快照就是项目本体（D37），
 * 所以这里写的不是"崩溃恢复的备份"，就是项目本身。
 *
 * ## 生命周期跟着"当前项目装好了没有"走（D37，改写自 D23）
 *
 * 判据是 store 里的 `projectId`：null = 没有项目装好（首页、装载中、刚被删掉）。
 * 它守着两个都不报错的陷阱：
 *
 * **一、不能在项目装进 store 之前开工。** 那时 store 里是空时间轴，早开一步就把
 * 要打开的项目**覆盖成空的**——卡片上写着 12 个片段，进去是空的（D23 的陷阱换了
 * 对象：「待恢复的快照」变成「要打开的项目」）。两道闸：调用方（Editor）只在项目
 * 装好后挂载，`flush` 自己也在 `projectId === null` 时拒写。
 *
 * **二、切项目不能串写。** 订阅回调和 `flush` 都从**同一次 `getState()`** 里取
 * 项目 id 和时间轴——两者由 `openProject()` 原子地一起换，所以"store 已是项目 B
 * 而这里还捏着项目 A 的 id"在结构上不存在。捏一个启动时传进来的 id 的写法，
 * 防抖 1 秒内切完项目就是 **A 的内容盖掉 B**，不报错。
 *
 * ## 必须在页面转入后台时立刻冲一次
 *
 * 移动端"扛不住"的形态是操作系统直接杀掉标签页：没有异常、没有 `unload`、没有
 * 任何机会补写。`visibilitychange → hidden` 是我们能拿到的最后一个可靠信号，
 * 所以那一刻不等防抖、直接写。`pagehide` 也挂上：桌面上关标签走的是它，
 * 而 iOS 上它不一定来。
 *
 * ## 为什么是防抖而不是节流
 *
 * 连续拖拽会每帧产出一个新 Timeline。要保住的是**停手之后那一份**，中间态一份都
 * 不值得写；节流会在拖拽途中写好几次，每次都是马上就作废的状态。代价是拖拽期间
 * 一直不落盘，由上面那条"转后台立刻冲"兜住。
 */

import { useTimeline } from "./timeline-store";
import { lastPersistError, saveProject } from "./project-store";

/**
 * 停手多久之后落盘（毫秒）。
 *
 * 短到崩溃时丢的编辑可以忽略，长到一次拖拽只写一次。1 秒：连续拖拽的帧间隔远小于
 * 它，而人停手 1 秒后再崩掉，丢的是"最后一秒里没有任何操作"的那个状态。
 */
const DEBOUNCE_MS = 1_000;

/**
 * 存盘读数，供顶栏那行「已保存 · N 秒前」/「存不进去了」显示（D37：失败态是
 * 这行字存在的全部理由——只会报成功的话它是个恒为真的装饰）。
 */
export interface SaveReadout {
  readonly status: "saved" | "failed";
  /** 最近一次成功落盘的时刻（毫秒）；这次会话里还没写过则为 null。 */
  readonly at: number | null;
  readonly reason: string | null;
}

export interface AutosaveHandle {
  /**
   * 立刻把欠着的那一份写掉。读的是**此刻** store 里的项目 id 和时间轴，
   * 所以「制作副本」之类"要读最新快照"的操作先 await 它再去读。
   */
  flush(): Promise<void>;
  /**
   * 不管欠不欠账，**强行再写一次**。
   *
   * 给"落盘失败 → 用户清理出空间"这条路用：失败那一次已经把欠账清掉了
   * （`pending` 归 false），此后没有新编辑就不会再写，于是横幅上那句"清出空间后会
   * 自动接着保存"在用户眼里成了假话——他清完了，红字还在。所以清理之后要retry 一次。
   */
  retry(): Promise<void>;
  /** 停止订阅。内部先 flush——卸载时丢掉最后一次编辑，开发时表现成"改完代码刷新，编辑没了"。 */
  stop(): void;
}

export function startAutosave(onReadout?: (readout: SaveReadout) => void): AutosaveHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次落盘用的那份 Timeline。用引用比较——EDL 是不可变的，改了就是新对象。 */
  let saved = useTimeline.getState().timeline();
  let pending = false;
  let lastOkAt: number | null = null;

  const write = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    pending = false;
    // **id 和时间轴取自同一份 state**，见文件头"切项目不能串写"
    const state = useTimeline.getState();
    // 项目已被关掉/删掉：欠着的那一份没有归属。写下去要么复活刚删掉的项目，
    // 要么把空时间轴写到别人头上——两种都比丢掉最后一秒的编辑坏得多
    if (state.projectId === null) return Promise.resolve();
    const timeline = state.timeline();
    saved = timeline;
    return saveProject(state.projectId, timeline, state.playhead).then((ok) => {
      if (ok) {
        lastOkAt = Date.now();
        onReadout?.({ status: "saved", at: lastOkAt, reason: null });
      } else {
        // 存不上不抛（配额满、隐私模式），原因报到读数上，由界面决定怎么说
        onReadout?.({ status: "failed", at: lastOkAt, reason: lastPersistError() });
      }
    });
  };

  const flush = (): Promise<void> => (pending ? write() : Promise.resolve());

  const unsubscribe = useTimeline.subscribe((state) => {
    // 项目没装好时的时间轴变化不欠账（`closeProject` 清空时间轴就是这种），
    // 否则那笔账会在下一个项目打开后被冲掉——写的还是对的内容，但纯属浪费
    if (state.projectId === null) return;
    const timeline = state.timeline();
    // **只认时间轴变化。** 播放头和选中不进撤销栈，也不该触发落盘——拖播放头
    // 每帧一次，那会让自动存盘变成整个编辑器最忙的东西
    if (timeline === saved) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), DEBOUNCE_MS);
  });

  // 转入后台立刻冲
  const onHide = (): void => {
    if (document.visibilityState !== "visible") void flush();
  };
  const onPageHide = (): void => void flush();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);

  return {
    flush,
    retry: write,
    stop() {
      // 停之前把欠着的那一份写掉：热更新和 React 严格模式的双挂载都会走到这里
      void flush();
      unsubscribe();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    },
  };
}
