/**
 * 一级调色：亮度 / 对比度 / 饱和度 / 色相，编译成一个 5×4 色彩矩阵。
 *
 * 这个模块相对合成层的地位，和 `containRect` / `placeLayer` 相对几何是一样的——
 * **"这四个数变成什么颜色"只有这一处算**。理由和留边几何完全相同：两个后端各写
 * 一遍就会在「预览 / 导出一致性自检」上差出像素来，而调色的差异比几何更难看出来
 * （不是黑边高了 1px，是整片画面偏一点点）。
 *
 * ## 为什么是矩阵，不是四段 shader 代码
 *
 * 四个量各写一段 GLSL 的话，"算法"就活在 shader 里，只能靠跑 GPU 才能验。
 * 编译成矩阵之后，**同一份算法能在 JS 里跑**（`applyColorMatrix`），于是：
 *
 * - 语义有单测（不需要浏览器，和 `anim/keyframes.ts` 同一个理由）；
 * - Pixi spike 能断言「GPU 出来的颜色 == JS 算出来的颜色」，把 shader 钉在这份
 *   算法上。缺了这条，shader 写错了没有任何东西会报错——画面只是"看起来有点怪"。
 *
 * ## 语义对齐 CSS filter，不自创
 *
 * 亮度 / 对比度 / 饱和度都是**倍数，1 = 不变**；色相是**弧度，0 = 不变**
 * （合成层一律用弧度，见 D9，度数换算留在 UI 层）。矩阵系数直接取
 * CSS Filter Effects 规范里 `brightness()` / `contrast()` / `saturate()` /
 * `hue-rotate()` 的定义，亮度权重也用规范那组（0.213 / 0.715 / 0.072）。
 *
 * 好处是：这些数字有出处、可对照，而且将来若要在 Canvas2D 上用 `ctx.filter`
 * 做近似，同一组参数直接就能拼成滤镜字符串，不用再定义第二套语义。
 *
 * **在 sRGB（非线性）空间里算**，和 CSS filter 一致，不是线性光。物理上线性光更
 * "正确"，但那会和 CSS 的观感对不上，而且要在 shader 里多两次幂运算；一级调色
 * 是主观工具，可预期比物理正确重要。真要做线性光调色时这条要整体重来。
 *
 * ## 顺序是定死的
 *
 * **色相 → 饱和度 → 对比度 → 亮度**。顺序不能由调用方决定，否则同样的四个数字
 * 在两个地方会画出两张不同的画面——而这正是硬规则 2 要消灭的东西。
 *
 * 选这个顺序的理由：对比度绕 0.5 中灰做，亮度是纯增益。亮度放最后，"整体提亮"
 * 就是所见即所得；反过来先提亮再拉对比，提亮量会被对比度放大，滑块手感非线性。
 */

/**
 * 一级调色的四个量。**省略 = 不调**，所以 `undefined` 与"原样"同义。
 *
 * 和 `LayerTransform` 一样是稀疏的：改回缺省值要把字段删掉而不是留 `{brightness:1}`，
 * 这样"这个片段调过色没有"在数据层一眼可判（见 CLAUDE.md 的状态层约定）。
 */
export interface ColorAdjust {
  /** 增益倍数，1 = 不变。0 = 全黑。 */
  readonly brightness?: number;
  /** 绕 0.5 中灰的对比倍数，1 = 不变。0 = 全部压成中灰。 */
  readonly contrast?: number;
  /** 饱和度倍数，1 = 不变。0 = 灰度，>1 加艳。 */
  readonly saturation?: number;
  /** 色相旋转，**弧度**，0 = 不变。 */
  readonly hue?: number;
  /**
   * LUT 强度，0–1，1 = 完全套用。**片段没挂 LUT 时这个值没有意义。**
   *
   * 它住在这里而不是 `Clip.lut` 里，是为了白拿一整套关键帧机制——"看渐渐上来"
   * 是 LUT 最常见的用法，而这一组的打点 / 求值 / 撤销 / 检查器行全都是现成的。
   * 代价是 `ColorAdjust` 不再纯粹是"CSS filter 那四个量"，所以下面的
   * `colorMatrixOf` / `isDefaultColorMatrix` 都显式说明它们**只看前四个**。
   */
  readonly lutIntensity?: number;
}

/**
 * 5×4 色彩矩阵，行主序 20 个数，布局与 SVG `feColorMatrix` / Pixi
 * `ColorMatrixFilter` 完全相同：
 *
 *     r' = m0*r  + m1*g  + m2*b  + m3*a  + m4
 *     g' = m5*r  + m6*g  + m7*b  + m8*a  + m9
 *     b' = m10*r + m11*g + m12*b + m13*a + m14
 *     a' = m15*r + m16*g + m17*b + m18*a + m19
 *
 * 第 5 列是**偏移**，与颜色同量纲（0–1），不是 0–255。
 */
export type ColorMatrix = readonly number[];

/** 亮度权重。取 CSS Filter Effects 规范那组，不是自选的。 */
const LUMA_R = 0.213;
const LUMA_G = 0.715;
const LUMA_B = 0.072;

export const IDENTITY_MATRIX: ColorMatrix = [
  1, 0, 0, 0, 0,
  0, 1, 0, 0, 0,
  0, 0, 1, 0, 0,
  0, 0, 0, 1, 0,
];

/** 每个量的缺省值。`operations.ts` 的取值范围从这里取 `fallback`，不另写一份。 */
export const COLOR_DEFAULTS: Required<ColorAdjust> = {
  brightness: 1,
  contrast: 1,
  saturation: 1,
  hue: 0,
  lutIntensity: 1,
};

/**
 * 一级调色那**四个量**动没动过。`lutIntensity` 不算——它走的是另一条渲染路径。
 *
 * 两个后端据此走"不挂色彩矩阵滤镜"的原路径——和 `isDefaultGeometry` 是同一件事，
 * 也同样**不是性能优化**：Pixi 里给 sprite 挂上 filter 会让它先渲进一张临时
 * 纹理再合成，重采样一次；没调色的图层必须和加调色之前走完全相同的路径，
 * 否则「没用调色的项目输出逐像素不变」这条保证就没了。
 */
export function isDefaultColorMatrix(color?: ColorAdjust): boolean {
  if (!color) return true;
  const { brightness = 1, contrast = 1, saturation = 1, hue = 0 } = color;
  return brightness === 1 && contrast === 1 && saturation === 1 && hue === 0;
}

/** LUT 强度，缺省 1（完全套用）。 */
export function lutIntensityOf(color?: ColorAdjust): number {
  return color?.lutIntensity ?? 1;
}

/**
 * 两个 5×4 矩阵相乘：返回"**先用 `first`，再用 `second`**"的等价矩阵。
 *
 * 参数顺序刻意是"作用顺序"而不是数学书写顺序（数学上这是 second · first）——
 * 调用点读起来是一条流水线，写反了不会报错，只会画出另一张画面。
 */
export function composeMatrix(first: ColorMatrix, second: ColorMatrix): ColorMatrix {
  const out: number[] = new Array<number>(20).fill(0);
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += second[row * 5 + k]! * first[k * 5 + col]!;
      out[row * 5 + col] = sum;
    }
    // 偏移列：second 作用在 first 的偏移上，再加自己的
    let offset = second[row * 5 + 4]!;
    for (let k = 0; k < 4; k++) offset += second[row * 5 + k]! * first[k * 5 + 4]!;
    out[row * 5 + 4] = offset;
  }
  return out;
}

/** 增益。CSS `brightness(b)`。 */
export function brightnessMatrix(b: number): ColorMatrix {
  return [
    b, 0, 0, 0, 0,
    0, b, 0, 0, 0,
    0, 0, b, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/** 绕 0.5 中灰。CSS `contrast(c)`：斜率 c，截距 0.5(1−c)。 */
export function contrastMatrix(c: number): ColorMatrix {
  const t = 0.5 * (1 - c);
  return [
    c, 0, 0, 0, t,
    0, c, 0, 0, t,
    0, 0, c, 0, t,
    0, 0, 0, 1, 0,
  ];
}

/** CSS `saturate(s)`：在灰度矩阵与单位阵之间按 s 线性外插。 */
export function saturationMatrix(s: number): ColorMatrix {
  const ir = LUMA_R * (1 - s);
  const ig = LUMA_G * (1 - s);
  const ib = LUMA_B * (1 - s);
  return [
    ir + s, ig, ib, 0, 0,
    ir, ig + s, ib, 0, 0,
    ir, ig, ib + s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * CSS `hue-rotate(θ)`。
 *
 * 这不是真正的 HSL 色相旋转，而是规范定义的那个**线性近似**（绕 RGB 立方体的
 * 灰轴转）。饱和度极高的颜色转完可能落到色域外，靠后面 clamp 兜住——
 * 浏览器的 `hue-rotate` 也是这个行为，对齐它比"更正确"重要。
 */
export function hueMatrix(radians: number): ColorMatrix {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [
    LUMA_R + c * (1 - LUMA_R) + s * -LUMA_R,
    LUMA_G + c * -LUMA_G + s * -LUMA_G,
    LUMA_B + c * -LUMA_B + s * (1 - LUMA_B),
    0, 0,

    LUMA_R + c * -LUMA_R + s * 0.143,
    LUMA_G + c * (1 - LUMA_G) + s * 0.14,
    LUMA_B + c * -LUMA_B + s * -0.283,
    0, 0,

    LUMA_R + c * -LUMA_R + s * -(1 - LUMA_R),
    LUMA_G + c * -LUMA_G + s * LUMA_G,
    LUMA_B + c * (1 - LUMA_B) + s * LUMA_B,
    0, 0,

    0, 0, 0, 1, 0,
  ];
}

/**
 * 把四个量编译成一个矩阵。**顺序定死：色相 → 饱和度 → 对比度 → 亮度**（见文件头）。
 *
 * **只看前四个量**，`lutIntensity` 与矩阵无关（见 `ColorAdjust`）。
 * 恒等时返回 `IDENTITY_MATRIX` 这个**同一个对象**，调用方可以用引用相等做快判；
 * 但不要把它当唯一判据——`isDefaultColorMatrix` 才是。
 */
export function colorMatrixOf(color?: ColorAdjust): ColorMatrix {
  if (isDefaultColorMatrix(color)) return IDENTITY_MATRIX;
  const {
    brightness = 1,
    contrast = 1,
    saturation = 1,
    hue = 0,
  } = color ?? {};

  let m: ColorMatrix = IDENTITY_MATRIX;
  if (hue !== 0) m = composeMatrix(m, hueMatrix(hue));
  if (saturation !== 1) m = composeMatrix(m, saturationMatrix(saturation));
  if (contrast !== 1) m = composeMatrix(m, contrastMatrix(contrast));
  if (brightness !== 1) m = composeMatrix(m, brightnessMatrix(brightness));
  return m;
}

/** 0–1 归一化的直通 alpha 颜色。 */
export type Rgba = readonly [r: number, g: number, b: number, a: number];

/**
 * 在 CPU 上跑一遍矩阵。**这是给测试和自检用的参照实现**，渲染路径不走这里。
 *
 * 它存在的意义就是让 shader 有个可比对的真值：Pixi spike 里断言
 * 「GPU 出来的像素 == 这个函数算出来的像素」，shader 写错就会当场红。
 *
 * 输入输出都是**直通 alpha**（非预乘）的 0–1 值。RGB 结果夹到 [0,1]——
 * GPU 写进 8 位纹理时也会夹，不夹的话参照值和实测值在高饱和处必然对不上。
 */
export function applyColorMatrix(m: ColorMatrix, [r, g, b, a]: Rgba): Rgba {
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  return [
    clamp01(m[0]! * r + m[1]! * g + m[2]! * b + m[3]! * a + m[4]!),
    clamp01(m[5]! * r + m[6]! * g + m[7]! * b + m[8]! * a + m[9]!),
    clamp01(m[10]! * r + m[11]! * g + m[12]! * b + m[13]! * a + m[14]!),
    clamp01(m[15]! * r + m[16]! * g + m[17]! * b + m[18]! * a + m[19]!),
  ];
}

/** 便捷版：直接对 0–255 的整数通道跑一遍，返回四舍五入后的整数。自检用。 */
export function applyColorMatrix8(
  m: ColorMatrix,
  [r, g, b, a]: readonly [number, number, number, number],
): [number, number, number, number] {
  const out = applyColorMatrix(m, [r / 255, g / 255, b / 255, a / 255]);
  return [
    Math.round(out[0] * 255),
    Math.round(out[1] * 255),
    Math.round(out[2] * 255),
    Math.round(out[3] * 255),
  ];
}
