/**
 * 3D LUT：解析 `.cube` 文件、铺成一张 2D 查找纹理、并给出一份 CPU 参照实现。
 *
 * 和 `color.ts` 是同一个套路，理由也相同（见 D17）：**算法只有一处，而且那一处
 * 能在 JS 里跑**。LUT 的查表 + 插值必须写进 shader，但同一套算术在这里也实现一遍
 * （`sampleLutTexture`），于是 Pixi spike 能断言「GPU 查出来的颜色 == CPU 查出来的」。
 * 缺了这条，shader 里任何一个 half-texel 偏移写错都不会报错——画面只是"看着不太对"，
 * 而 LUT 本来就是用来把画面改成"不太一样"的，肉眼根本分不出来。
 *
 * ## 为什么铺成 2D 纹理，不用 sampler3D
 *
 * WebGL2 有 3D 纹理，但 Pixi 的纹理体系是围绕 2D 建的，塞一张 3D 纹理进去要绕开
 * 它的资源管理（而资源管理正是"每帧不新建纹理"那条约束的落点）。2D 切片图是这件事
 * 的通行做法，代价只是 shader 里要自己 lerp 蓝色方向那一维。
 *
 * 布局：**一行 N 个切片**，纹理尺寸 `N*N × N`。切片序号 = 蓝，切片内 x = 红、y = 绿。
 * 红绿两维的插值直接交给采样器的双线性过滤，蓝那一维在 shader 里手动 mix。
 *
 * ## 尺寸上限 45
 *
 * WebGL2 只保证 `MAX_TEXTURE_SIZE ≥ 2048`，而这个布局的宽度是 N²，所以 N ≤ 45。
 * 常见的 17 / 25 / 32 / 33 全在里面；64³ 会被明确拒绝而不是悄悄截断——
 * 截断出来的片子能播、颜色是错的，属于最不能接受的那类失败。
 *
 * ## 8 位纹理，不是浮点
 *
 * 浮点纹理的线性过滤在 WebGL2 上要 `OES_texture_float_linear`，不保证有；而 LUT
 * 的输出最终也要落到 8 位成片上。**CPU 参照实现读的是同一份 8 位像素**，所以
 * "GPU 和 CPU 对不对得上"这个断言不会被量化误差污染——两边量化的是同一个数。
 */

/** 纹理宽度是 `size²`，而 WebGL2 只保证 2048。见文件头。 */
export const LUT_MAX_SIZE = 45;
/** 小于这个尺寸的 LUT 精度太差，多半是文件坏了。 */
export const LUT_MIN_SIZE = 2;

/**
 * 一张立方体的**渲染所需的全部内容**。`rgb` 按 `.cube` 的原始顺序：
 * **红变化最快**，然后绿，最后蓝。
 *
 * 刻意只有这两个字段：合成层不该认识 id、文件名这些 EDL 的索引概念，
 * 于是 `edl/types.ts` 的 `LutSource` 天然满足它，不需要在两层之间做转换。
 */
export interface LutTable {
  readonly size: number;
  /** 长度 `size³ × 3`，值域 0–1（未夹紧，`.cube` 允许超出）。 */
  readonly rgb: Float32Array;
}

/** 解析结果：表 + 文件里的元信息。 */
export interface LutData extends LutTable {
  /** 文件里的 `TITLE`，没有则为空串。 */
  readonly title: string;
}

/** 铺好的 2D 查找纹理。RGBA8，alpha 恒为 255。 */
export interface LutTexture {
  readonly size: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 解析 `.cube`（Adobe / Iridas）。失败一律抛错，**不做"尽力而为"的容错**：
 * 一个解歪了的 LUT 照样能出画面，只是颜色不对，而那正是没人会发现的失败。
 */
export function parseCubeLut(text: string): LutData {
  let size = -1;
  let title = "";
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const upper = line.toUpperCase();
    if (upper.startsWith("TITLE")) {
      title = line.slice(5).trim().replace(/^"|"$/g, "");
      continue;
    }
    if (upper.startsWith("LUT_1D_SIZE")) {
      throw new Error("这是一维 LUT（LUT_1D_SIZE），只支持三维 LUT（LUT_3D_SIZE）");
    }
    if (upper.startsWith("LUT_3D_SIZE")) {
      size = Number.parseInt(line.slice(11).trim(), 10);
      continue;
    }
    if (upper.startsWith("DOMAIN_MIN")) {
      domainMin = triple(line.slice(10), "DOMAIN_MIN");
      continue;
    }
    if (upper.startsWith("DOMAIN_MAX")) {
      domainMax = triple(line.slice(10), "DOMAIN_MAX");
      continue;
    }
    // 其余行只能是数据行
    const parts = line.split(/\s+/);
    if (parts.length !== 3) throw new Error(`认不出这一行：「${line}」`);
    for (const part of parts) {
      const n = Number(part);
      if (!Number.isFinite(n)) throw new Error(`认不出这一行：「${line}」`);
      values.push(n);
    }
  }

  if (size < 0) throw new Error("文件里没有 LUT_3D_SIZE");
  if (size < LUT_MIN_SIZE || size > LUT_MAX_SIZE) {
    throw new Error(
      `LUT_3D_SIZE 是 ${size}，只支持 ${LUT_MIN_SIZE}–${LUT_MAX_SIZE}` +
        `（纹理宽度是尺寸的平方，而 WebGL2 只保证 2048）`,
    );
  }
  // 非 0–1 定义域改的是**输入**的映射，没法烘进表里。直接拒绝而不是忽略——
  // 忽略掉画出来的颜色是错的，且不报错
  if (domainMin.some((v) => v !== 0) || domainMax.some((v) => v !== 1)) {
    throw new Error("暂不支持 DOMAIN_MIN / DOMAIN_MAX 不是 0–1 的 LUT");
  }

  const expected = size * size * size * 3;
  if (values.length !== expected) {
    throw new Error(`数据行数对不上：LUT_3D_SIZE ${size} 需要 ${expected / 3} 行，实际 ${values.length / 3} 行`);
  }

  return { size, rgb: Float32Array.from(values), title };
}

function triple(rest: string, label: string): [number, number, number] {
  const parts = rest.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`${label} 需要三个数`);
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

/**
 * 铺成 2D 切片图：一行 N 个切片，纹理 `N*N × N`。
 *
 * 切片序号 = 蓝，切片内 x = 红、y = 绿。这个约定 shader 和 `sampleLutTexture`
 * 都依赖，改动要三处一起改——所以三处都只从这个函数的注释取定义。
 */
export function buildLutTexture(lut: LutTable): LutTexture {
  const { size, rgb } = lut;
  const width = size * size;
  const height = size;
  const pixels = new Uint8ClampedArray(width * height * 4);

  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        // .cube 的顺序：红变化最快
        const src = (r + g * size + b * size * size) * 3;
        const x = b * size + r;
        const dst = (g * width + x) * 4;
        pixels[dst] = Math.round(clamp01(rgb[src]!) * 255);
        pixels[dst + 1] = Math.round(clamp01(rgb[src + 1]!) * 255);
        pixels[dst + 2] = Math.round(clamp01(rgb[src + 2]!) * 255);
        pixels[dst + 3] = 255;
      }
    }
  }
  return { size, width, height, pixels };
}

/** 双线性取一个像素（0–1 浮点），坐标是**纹素坐标**，与采样器的行为一致。 */
function bilinear(tex: LutTexture, x: number, y: number): [number, number, number] {
  const x0 = Math.floor(x - 0.5);
  const y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0;
  const fy = y - 0.5 - y0;
  const at = (px: number, py: number, c: number): number => {
    const cx = Math.min(tex.width - 1, Math.max(0, px));
    const cy = Math.min(tex.height - 1, Math.max(0, py));
    return tex.pixels[(cy * tex.width + cx) * 4 + c]! / 255;
  };
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/**
 * CPU 参照实现：**与 `LUT_FRAGMENT` 里那段 GLSL 是同一套算术**。
 *
 * 半纹素偏移（`+ 0.5`）和"红方向只在切片内 size-1 个像素中心之间走"这两件事是
 * 这段代码里最容易写错、也最不会报错的地方：错了只会让颜色整体偏一点，
 * 而 LUT 的用途本来就是让颜色偏一点。所以它必须有个能对拍的另一份实现。
 *
 * @param rgb 0–1 直通 alpha 的输入色
 */
export function sampleLutTexture(tex: LutTexture, rgb: readonly [number, number, number]): [number, number, number] {
  const size = tex.size;
  const r = clamp01(rgb[0]);
  const g = clamp01(rgb[1]);
  const b = clamp01(rgb[2]);

  // 红：落在切片内第 0 到第 size-1 个像素的**中心**之间，不越出切片边界
  const xInSlice = 0.5 + r * (size - 1);
  // 绿：纹理高度恰好是 size，同样落在像素中心之间
  const y = 0.5 + g * (size - 1);

  const bScaled = b * (size - 1);
  const slice0 = Math.min(size - 1, Math.floor(bScaled));
  const slice1 = Math.min(size - 1, slice0 + 1);
  const t = bScaled - slice0;

  const c0 = bilinear(tex, slice0 * size + xInSlice, y);
  const c1 = bilinear(tex, slice1 * size + xInSlice, y);
  return [
    c0[0] + (c1[0] - c0[0]) * t,
    c0[1] + (c1[1] - c0[1]) * t,
    c0[2] + (c1[2] - c0[2]) * t,
  ];
}

/** 同上，8 位进 8 位出。自检与测试用。 */
export function sampleLutTexture8(
  tex: LutTexture,
  rgb: readonly [number, number, number],
  intensity = 1,
): [number, number, number] {
  const src: [number, number, number] = [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
  const out = sampleLutTexture(tex, src);
  return [
    Math.round((src[0] + (out[0] - src[0]) * intensity) * 255),
    Math.round((src[1] + (out[1] - src[1]) * intensity) * 255),
    Math.round((src[2] + (out[2] - src[2]) * intensity) * 255),
  ];
}

/**
 * 恒等 LUT——输出等于输入。给自检当对照组用。
 *
 * 它的价值在于**证明查表这条路本身不改变画面**：如果半纹素偏移写错了，恒等 LUT
 * 也会把画面改掉，而那种错误在真实 LUT 上完全看不出来（谁知道它"应该"是什么颜色）。
 */
export function identityLut(size: number): LutData {
  const rgb = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        rgb[i++] = r / (size - 1);
        rgb[i++] = g / (size - 1);
        rgb[i++] = b / (size - 1);
      }
    }
  }
  return { size, rgb, title: "identity" };
}

/**
 * 片元着色器。**这段算术必须和 `sampleLutTexture` 一模一样**，
 * Pixi spike 里那条「GPU == CPU」的断言就是在钉这件事。
 *
 * 输入纹理是预乘 alpha 的（Pixi 的渲染目标一律预乘），所以查表前要先反预乘——
 * LUT 是对**颜色**查表，不是对"颜色乘以透明度"查表。这一步漏掉的话，半透明
 * 图层的调色会随透明度变化，而不透明图层完全正常，是最难复现的那种。
 */
export const LUT_FRAGMENT = `#version 300 es
precision highp float;

in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;
uniform sampler2D uLut;
uniform float uLutSize;
uniform float uIntensity;

vec3 lookup(vec3 rgb) {
  float size = uLutSize;
  float texWidth = size * size;

  // 红：切片内第 0 到第 size-1 个像素的中心之间
  float xInSlice = 0.5 + rgb.r * (size - 1.0);
  float y = (0.5 + rgb.g * (size - 1.0)) / size;

  float bScaled = rgb.b * (size - 1.0);
  float slice0 = min(size - 1.0, floor(bScaled));
  float slice1 = min(size - 1.0, slice0 + 1.0);
  float t = bScaled - slice0;

  vec3 c0 = texture(uLut, vec2((slice0 * size + xInSlice) / texWidth, y)).rgb;
  vec3 c1 = texture(uLut, vec2((slice1 * size + xInSlice) / texWidth, y)).rgb;
  return mix(c0, c1, t);
}

void main(void) {
  vec4 src = texture(uTexture, vTextureCoord);
  // 反预乘再查表，查完再乘回去。见上面的注释
  vec3 straight = src.a > 0.0 ? src.rgb / src.a : src.rgb;
  vec3 graded = mix(straight, lookup(clamp(straight, 0.0, 1.0)), uIntensity);
  finalColor = vec4(graded * src.a, src.a);
}
`;

/** 顶点着色器：Pixi v8 filter 的标准全屏三角形。 */
export const LUT_VERTEX = `#version 300 es
precision highp float;

in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition(void) {
  vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord(void) {
  return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void) {
  gl_Position = filterVertexPosition();
  vTextureCoord = filterTextureCoord();
}
`;
