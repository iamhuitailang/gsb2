/** 生成像素风的程序化样图与测试用数据（无外部依赖）。 */
import { encodeRgbaPng } from '../src/png.js';

export function makeGradient(width = 320, height = 200) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const u = x / (width - 1);
      const v = y / (height - 1);
      rgba[i] = Math.round(255 * u);
      rgba[i + 1] = Math.round(255 * (1 - v));
      rgba[i + 2] = Math.round(255 * (1 - u * 0.5) * v);
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function makeTransparentEdge(size = 64) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const cx = size / 2 - 0.5;
  const cy = size / 2 - 0.5;
  const radius = size / 2 - 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      const coverage = Math.max(0, Math.min(1, radius + 0.5 - d));
      if (coverage <= 0) continue;
      rgba[i] = 240;
      rgba[i + 1] = 120;
      rgba[i + 2] = 60;
      rgba[i + 3] = Math.round(255 * coverage);
    }
  }
  return { width: size, height: size, rgba };
}

export function makeSolid(width, height, r, g, b, a = 255) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = a;
  }
  return { width, height, rgba };
}

export async function pngOf(image) {
  return encodeRgbaPng(image.rgba, image.width, image.height);
}
