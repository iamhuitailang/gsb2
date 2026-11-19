import type { RasterImage } from './types.ts';

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/** Parse a `#rrggbb` color. Values stay in sRGB [0, 1]. */
export function hexToRgba(hex: string, alpha = 1): RGBA {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean, 16);
  if (clean.length !== 6 || Number.isNaN(value)) {
    throw new Error(`无法解析颜色 "${hex}"，需要 #rrggbb 格式`);
  }
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
    a: alpha,
  };
}

export function rgbaToHex(color: RGBA): string {
  const channel = (value: number): string =>
    Math.round(clamp01(value) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

export function createRaster(width: number, height: number): RasterImage {
  return {
    width,
    height,
    data: new Float32Array(width * height * 4),
  };
}

export function writePixel(
  image: RasterImage,
  x: number,
  y: number,
  red: number,
  green: number,
  blue: number,
  alpha: number,
): void {
  const index = (y * image.width + x) * 4;
  image.data[index] = red;
  image.data[index + 1] = green;
  image.data[index + 2] = blue;
  image.data[index + 3] = alpha;
}

export function readPixel(image: RasterImage, x: number, y: number): RGBA {
  const index = (y * image.width + x) * 4;
  const data = image.data;
  return {
    r: data[index] ?? 0,
    g: data[index + 1] ?? 0,
    b: data[index + 2] ?? 0,
    a: data[index + 3] ?? 1,
  };
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'difference';

export function blendChannel(base: number, blend: number, mode: BlendMode): number {
  switch (mode) {
    case 'normal':
      return blend;
    case 'multiply':
      return base * blend;
    case 'screen':
      return 1 - (1 - base) * (1 - blend);
    case 'overlay':
      return base < 0.5 ? 2 * base * blend : 1 - 2 * (1 - base) * (1 - blend);
    case 'add':
      return Math.min(1, base + blend);
    case 'difference':
      return Math.abs(base - blend);
  }
}
