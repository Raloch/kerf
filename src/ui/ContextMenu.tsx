/**
 * 右键菜单：只管**定位和关闭**，菜单项由调用方给。
 *
 * 拆出来是因为这两件事才是有坑的部分，而它们和"菜单上有哪几项"完全无关：
 *
 * - **关闭要听 `pointerdown` 而不是 `click` / `pointerup`。** 右键的事件顺序是
 *   `pointerdown → contextmenu → pointerup`，菜单是在 `contextmenu` 上开的——那时开菜单
 *   的那次 `pointerdown` 已经过去了，所以监听 `pointerdown` 天然不会自己把自己关掉；
 *   而监听 `pointerup` 会被**同一次右键**的抬起立刻关掉，表现是"菜单闪一下就没了"。
 * - **落点要夹进视口，而且必须量过才知道夹多少。** 靠"估一个菜单宽度"去夹，改一次菜单项
 *   就会错；所以先按原始坐标渲染一次，再在 layout effect 里量出来往回挪（同一帧内完成，
 *   用户看不到跳）。
 * - **菜单自己的 `pointerdown` 不能冒泡出去**，否则点菜单项 = 先关掉菜单再触发 click，
 *   而 React 的 onClick 挂在一个已经被卸载的节点上就不会执行了。
 *
 * 不用原生 `<dialog>` / popover：那两个都带自己的焦点与关闭语义，而这里要的是"点别处就没了"，
 * 反而要把它们的行为一条条关掉。
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  readonly label: string;
  /** 灰掉的原因；给了就点不动，并且**把原因显示出来**（纯置灰不解释是黑箱，同 D3）。 */
  readonly disabledReason?: string;
  /** 分组线画在这一项**之前**。 */
  readonly separatorBefore?: boolean;
  readonly icon?: ReactNode;
  readonly onSelect: () => void;
}

/** 视口边缘留的余量，免得菜单贴边到看不清阴影。 */
const VIEWPORT_MARGIN = 6;

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  readonly onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  /**
   * 夹进视口。**算出来的落点只能依赖"原始坐标 + 菜单尺寸"，不能依赖当前落点。**
   *
   * 第一版是"量出来越界了就往回挪"，而它读的是**已经挪过**的矩形、比的又是原始 `x/y`：
   * 挪完之后下一轮发现"没越界"于是挪回原处，再下一轮又越界——两个值之间无限振荡，
   * React 当场报 `Maximum update depth exceeded`、组件崩掉（菜单根本不出现）。
   * 现在这个式子跑两次给同样的答案，是个不动点；`setPos` 用函数式更新并在相等时
   * 原样返回，于是它连一次多余的重渲染都不产生。
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const nx = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - width - VIEWPORT_MARGIN));
    const ny = Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - height - VIEWPORT_MARGIN));
    setPos((prev) => (prev.x === nx && prev.y === ny ? prev : { x: nx, y: ny }));
  }, [items, x, y]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // 菜单里面按下不算"点别处"。用 contains 而不是在菜单上 stopPropagation：
      // 后者会让"按在菜单上、拖到外面松手"这种操作留下一个关不掉的菜单
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // 滚动时关掉：菜单是 fixed 定位的，不关的话它会停在原地而底下的内容滑走，
    // 于是"右键的是哪个片段"这件事就对不上了
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onClose, { passive: true });
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <div
      className="ctxm"
      ref={ref}
      role="menu"
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
    >
      {items.map((item, i) => (
        <div key={item.label} className="ctxm-row">
          {item.separatorBefore && i > 0 && <div className="ctxm-sep" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabledReason !== undefined}
            title={item.disabledReason ?? ""}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="l">{item.label}</span>
            {item.disabledReason !== undefined && <span className="w">{item.disabledReason}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
