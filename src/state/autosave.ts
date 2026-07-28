/**
 * 自动存盘：把当前 EDL 定期写进 IndexedDB，标签页被杀之后能捡回来。
 *
 * ## 两个必须做对的时机
 *
 * **一、不能在恢复提示还挂着的时候开工。** 编辑器一挂载，store 里是那个空时间轴；
 * 这时要是自动存盘已经在跑，它会**当场把待恢复的快照覆盖成空的**——用户看着
 * "要不要恢复上次编辑"，而按下去已经什么都没有了。所以启动这件事由调用方在
 * **恢复决定做完之后**才做（见 `Editor.tsx`），这个模块自己不主动开工。
 *
 * **二、必须在页面转入后台时立刻冲一次。** 移动端"扛不住"的形态是操作系统直接
 * 杀掉标签页：没有异常、没有 `unload`、没有任何机会补写（长片自检那条 localStorage
 * 前置记录就是为这个加的，见 `dev/verify-device.ts`）。`visibilitychange → hidden`
 * 是我们能拿到的最后一个可靠信号，所以那一刻不等防抖、直接写。
 *
 * ## 为什么是防抖而不是节流
 *
 * 连续拖拽会每帧产出一个新 Timeline。要保住的是**停手之后那一份**，中间态一份都
 * 不值得写；节流会在拖拽途中写好几次，每次都是马上就作废的状态。代价是拖拽期间
 * 一直不落盘，由上面那条"转后台立刻冲"兜住。
 */

import { useTimeline } from "./timeline-store";
import { saveProject } from "./project-store";

/**
 * 停手多久之后落盘（毫秒）。
 *
 * 短到崩溃时丢的编辑可以忽略，长到一次拖拽只写一次。1 秒：连续拖拽的帧间隔远小于
 * 它，而人停手 1 秒后再崩掉，丢的是"最后一秒里没有任何操作"的那个状态。
 */
const DEBOUNCE_MS = 1_000;

export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 上一次落盘用的那份 Timeline。用引用比较——EDL 是不可变的，改了就是新对象。 */
  let saved = useTimeline.getState().timeline();
  let pending = false;

  const flush = (): void => {
    if (!pending) return;
    clearTimeout(timer);
    timer = undefined;
    pending = false;
    const state = useTimeline.getState();
    const timeline = state.timeline();
    saved = timeline;
    // 存不上不抛（配额满、隐私模式），原因记在 `lastPersistError()` 上
    void saveProject(timeline, state.playhead);
  };

  const unsubscribe = useTimeline.subscribe((state) => {
    const timeline = state.timeline();
    // **只认时间轴变化。** 播放头和选中不进撤销栈，也不该触发落盘——拖播放头
    // 每帧一次，那会让自动存盘变成整个编辑器最忙的东西
    if (timeline === saved) return;
    pending = true;
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  });

  // 转入后台立刻冲。`pagehide` 也挂上：桌面上关标签走的是它，而 iOS 上它不一定来
  const onHide = (): void => {
    if (document.visibilityState !== "visible") flush();
  };
  const onPageHide = (): void => flush();
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    // 停之前把欠着的那一份写掉：热更新和 React 严格模式的双挂载都会走到这里，
    // 而"卸载时丢掉最后一次编辑"在开发时表现成"改完代码刷新，编辑没了"
    flush();
    unsubscribe();
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onPageHide);
  };
}
