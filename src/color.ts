namespace SamplerLab {
  // ---------- sRGB 传递函数（IEC 61966-2-1 近似式） ----------

  /** 存储值(sRGB 编码) -> 线性光 */
  export function srgbToLinear(c: number): number {
    c = clamp01(c);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  /** 线性光 -> 存储值(sRGB 编码) */
  export function linearToSrgb(c: number): number {
    c = Math.max(0, c);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  }

  // ---------- 两种像素混合 ----------

  export interface BlendInput {
    /** 各采样点最终颜色（已决深度，存储值空间） */
    sampleColors: RGB[];
    /** 各采样点是否被非背景面覆盖 */
    covered: boolean[];
    background: RGB;
  }

  const apply = (f: (c: RGB) => RGB, c: RGB): RGB => f(c);

  /** 方式一：直接对存储值做算术平均（含背景权重 1-覆盖率） */
  export function blendStored(input: BlendInput): RGB {
    const n = input.sampleColors.length;
    let r = 0;
    let g = 0;
    let b = 0;
    // 未覆盖采样点按背景计入，保证两种方式口径一致
    for (let i = 0; i < n; i++) {
      const c = input.covered[i] ? input.sampleColors[i] : input.background;
      r += c.r;
      g += c.g;
      b += c.b;
    }
    return rgb(r / n, g / n, b / n);
  }

  /** 方式二：先解码到线性光，按亮度物理平均，再编码回存储值 */
  export function blendLinear(input: BlendInput): RGB {
    const n = input.sampleColors.length;
    let r = 0;
    let g = 0;
    let b = 0;
    const lin = (c: RGB): RGB => ({ r: srgbToLinear(c.r), g: srgbToLinear(c.g), b: srgbToLinear(c.b) });
    for (let i = 0; i < n; i++) {
      const c = apply(lin, input.covered[i] ? input.sampleColors[i] : input.background);
      r += c.r;
      g += c.g;
      b += c.b;
    }
    return rgb(
      linearToSrgb(r / n),
      linearToSrgb(g / n),
      linearToSrgb(b / n),
    );
  }

  /** 两种结果的每通道差（以 8 位通道值为单位），便于量化核对 */
  export function channelDelta(a: RGB, b: RGB): { dr: number; dg: number; db: number } {
    return {
      dr: Math.round((a.r - b.r) * 255),
      dg: Math.round((a.g - b.g) * 255),
      db: Math.round((a.b - b.b) * 255),
    };
  }

  /** 相对亮度（线性空间），用于在检查器里标注颜色明暗 */
  export function relativeLuminance(c: RGB): number {
    return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
  }
}
