namespace SamplerLab {
  // ---------- 向量 / 数值小工具 ----------

  export const v2 = (x: number, y: number): Vec2 => ({ x, y });
  export const cloneV = (p: Vec2): Vec2 => ({ x: p.x, y: p.y });
  export const addV = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
  export const subV = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
  export const scaleV = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });

  export const rgb = (r: number, g: number, b: number): RGB => ({
    r: clamp01(r),
    g: clamp01(g),
    b: clamp01(b),
  });
  export const cloneRGB = (c: RGB): RGB => ({ r: c.r, g: c.g, b: c.b });
  export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
  export const clampByte = (x: number): number => (x < 0 ? 0 : x > 255 ? 255 : x);

  export const epsEqual = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) <= eps;
  export const epsEqualV = (a: Vec2, b: Vec2, eps = 1e-9): boolean =>
    epsEqual(a.x, b.x, eps) && epsEqual(a.y, b.y, eps);

  /**
   * 两倍有符号叉积面积 cross(B-A, C-A)。
   * 屏幕坐标 y 向下：结果 > 0 表示 A->B->C 为逆时针(CCW)。
   */
  export function cross2(a: Vec2, b: Vec2, c: Vec2): number {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  export function triBounds(v: [Vec2, Vec2, Vec2]): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of v) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  }

  /** 面积接近零的容差随三角形包围盒尺寸缩放，避免大坐标下绝对误差被吞掉 */
  export function areaEpsilon(v: [Vec2, Vec2, Vec2]): number {
    const b = triBounds(v);
    const diag = Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
    return Math.max(1e-7, 1e-7 * Math.max(1, diag * diag));
  }

  // ---------- 颜色展示 ----------

  export function rgbToHex(c: RGB): string {
    const f = (x: number) =>
      clampByte(Math.round(x * 255))
        .toString(16)
        .padStart(2, '0');
    return `#${f(c.r)}${f(c.g)}${f(c.b)}`.toUpperCase();
  }

  export function hexToRGB(hex: string): RGB {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`颜色格式不正确: ${hex}`);
    const n = parseInt(m[1], 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
  }

  /** 取整到 8 位通道，用于写 ImageData */
  export function toByteChannel(x: number): number {
    return clampByte(Math.round(x * 255));
  }

  export function rgbToCss(c: RGB): string {
    return `rgb(${toByteChannel(c.r)}, ${toByteChannel(c.g)}, ${toByteChannel(c.b)})`;
  }
}
