/**
 * 颜色字符串的解析与序列化。
 *
 * ## 为什么需要它
 *
 * 文字样式里的颜色（填充 / 描边 / 阴影）在 EDL 里是**字符串**，直接喂给
 * `ctx.fillStyle` / `strokeStyle` / `shadowColor`。字符串是对的：canvas 认它，
 * 换成 `{r,g,b,a}` 对象反而要在渲染时拼回去。但它带来两件事：
 *
 * 1. **界面要能编辑它。** `input[type=color]` 只吃 `#rrggbb`、**吐不出 alpha**，
 *    而阴影颜色不带 alpha 就没法用（默认就是半透明黑）。所以要把字符串拆成
 *    RGB 加不透明度两个控件，再拼回去。
 * 2. **认不出的字符串会静默失效。** `ctx.shadowColor = "乱码"` **不抛错**，
 *    赋值被整个忽略、保持上一个值——新建的上下文里那是透明黑，表现就是
 *    "阴影调了没反应"。所以编辑入口要能判"这个字符串我们认不认"（`isCssColor`），
 *    认不出就拒掉并给出原因，而不是写进 EDL 等渲染时静默丢掉。
 *
 * ## 只认这几种写法，不做完整的 CSS 颜色解析
 *
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` / `rgb(…)` / `rgba(…)`。
 * 具名颜色（`red`）、`hsl()`、`color()`、`currentColor` 一律不认——**认的范围就是
 * 我们自己写得出来的范围**（界面只产出这里的规范形式，缺省值也是）。完整 CSS 解析
 * 要么抄一张具名颜色表、要么借浏览器（`new Option().style.color = …`），前者是几百行
 * 只为了让手改 EDL 的人少打两个字，后者在 Worker 里没有 DOM、而这个模块要能在
 * node 里单测。
 *
 * ## 序列化定死一种形式
 *
 * 不透明时输出 `#rrggbb`，半透明时输出 `rgba(r, g, b, a)`。**不用 `#rrggbbaa`**：
 * 八位十六进制虽然现代浏览器都支持，但一旦某个环境不认，失败形态正是上面那条
 * "赋值被静默忽略"；`rgba()` 是最老最稳的写法，而且缺省值本来就是它。
 * 定死一种形式的另一个好处是同一个颜色永远给出同一个字符串——文字栅格缓存的键里
 * 带着整份样式，两种写法会变成两条缓存。
 */

/** r/g/b 是 0–255 的整数，a 是 0–1。 */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clampAlpha(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** 解析十六进制写法。长度只认 3 / 4 / 6 / 8。 */
function parseHex(hex: string): Rgba | null {
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const expand = (s: string): number => parseInt(s.length === 1 ? s + s : s, 16);
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = [...hex];
    return {
      r: expand(r!),
      g: expand(g!),
      b: expand(b!),
      a: a === undefined ? 1 : expand(a) / 255,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: expand(hex.slice(0, 2)),
      g: expand(hex.slice(2, 4)),
      b: expand(hex.slice(4, 6)),
      a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
    };
  }
  return null;
}

/** 解析 `rgb()` / `rgba()`。逗号和空格分隔都认（后者是 CSS Color 4 的写法）。 */
function parseFunctional(body: string): Rgba | null {
  // `rgb(0 0 0 / 0.5)` 这种斜杠写法里 alpha 在斜杠后面
  const [head, alphaPart] = body.split("/");
  const parts = head!.trim().split(/[\s,]+/).filter((p) => p !== "");
  const nums = [...parts, ...(alphaPart !== undefined ? [alphaPart.trim()] : [])];
  if (nums.length !== 3 && nums.length !== 4) return null;
  const values = nums.map((n) => Number(n));
  if (values.some((v) => !Number.isFinite(v))) return null;
  return {
    r: clampByte(values[0]!),
    g: clampByte(values[1]!),
    b: clampByte(values[2]!),
    a: values.length === 4 ? clampAlpha(values[3]!) : 1,
  };
}

/** 认得出就返回分量，认不出返回 null（见文件头："只认这几种写法"）。 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim();
  if (text.startsWith("#")) return parseHex(text.slice(1));
  const match = /^rgba?\((.*)\)$/i.exec(text);
  if (match) return parseFunctional(match[1]!);
  return null;
}

/** 这个字符串我们认不认。编辑入口用它挡住"写进去了但渲染时静默丢掉"的值。 */
export function isCssColor(value: string): boolean {
  return parseCssColor(value) !== null;
}

/** 十进制小数去掉多余的零：`0.60` → `0.6`，`1` → `1`。 */
function trimNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function toHex2(n: number): string {
  return clampByte(n).toString(16).padStart(2, "0");
}

/** 规范形式：不透明给 `#rrggbb`，半透明给 `rgba(r, g, b, a)`。见文件头。 */
export function formatCssColor(color: Rgba): string {
  const a = clampAlpha(color.a);
  if (a >= 1) return `#${toHex2(color.r)}${toHex2(color.g)}${toHex2(color.b)}`;
  return `rgba(${clampByte(color.r)}, ${clampByte(color.g)}, ${clampByte(color.b)}, ${trimNumber(a)})`;
}

/** 只取 RGB 的 `#rrggbb`——`input[type=color]` 只吃这一种，而且吐不出 alpha。 */
export function toHexRgb(color: Rgba): string {
  return `#${toHex2(color.r)}${toHex2(color.g)}${toHex2(color.b)}`;
}
