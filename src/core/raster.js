/**
 * 像素栅格操作：所有函数直接操作 RGBA 缓冲区（Uint8ClampedArray，长度 = w*h*4）。
 * 颜色统一用 [r, g, b, a]。
 */
import { hexToRgb } from './util.js';

export const TRANSPARENT = [0, 0, 0, 0];

export function createBuffer(width, height) {
  return new Uint8ClampedArray(width * height * 4);
}

export function cloneBuffer(buffer) {
  return new Uint8ClampedArray(buffer);
}

export function colorFromHex(hex, alpha = 255) {
  const rgb = hexToRgb(hex);
  if (!rgb) throw new Error(`无效颜色：${hex}`);
  return [rgb.r, rgb.g, rgb.b, alpha];
}

export function getPixel(buffer, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * 4;
  return [buffer[i], buffer[i + 1], buffer[i + 2], buffer[i + 3]];
}

/** 写入像素；超出边界时静默忽略。返回是否发生改变。 */
export function setPixel(buffer, width, height, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const i = (y * width + x) * 4;
  const [r, g, b, a] = color;
  if (
    buffer[i] === r &&
    buffer[i + 1] === g &&
    buffer[i + 2] === b &&
    buffer[i + 3] === a
  ) {
    return false;
  }
  buffer[i] = r;
  buffer[i + 1] = g;
  buffer[i + 2] = b;
  buffer[i + 3] = a;
  return true;
}

/**
 * 方形笔尖。大小为 1 时落在指针所在像素；偶数尺寸大致居中。
 * 返回实际改变的像素数。
 */
export function stamp(buffer, width, height, x, y, color, size = 1) {
  const s = Math.max(1, Math.round(size));
  const start = -Math.floor((s - 1) / 2);
  let changed = 0;
  for (let dy = 0; dy < s; dy += 1) {
    for (let dx = 0; dx < s; dx += 1) {
      if (setPixel(buffer, width, height, x + start + dx, y + start + dy, color)) {
        changed += 1;
      }
    }
  }
  return changed;
}

/** Bresenham 直线，逐点盖笔尖；包含两端。返回改变像素数。 */
export function drawLine(buffer, width, height, x0, y0, x1, y1, color, size = 1) {
  let x = Math.round(x0);
  let y = Math.round(y0);
  const endX = Math.round(x1);
  const endY = Math.round(y1);
  const dx = Math.abs(endX - x);
  const dy = -Math.abs(endY - y);
  const sx = x < endX ? 1 : -1;
  const sy = y < endY ? 1 : -1;
  let err = dx + dy;
  let changed = 0;
  for (;;) {
    changed += stamp(buffer, width, height, x, y, color, size);
    if (x === endX && y === endY) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return changed;
}

function colorsEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * 四连通油漆桶。精确匹配 RGBA（像素画通常没有抗锯齿）。
 * 返回改变的像素数。
 */
export function floodFill(buffer, width, height, startX, startY, color) {
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return 0;
  const target = getPixel(buffer, width, height, startX, startY);
  if (!target || colorsEqual(target, color)) return 0;

  const visited = new Uint8Array(width * height);
  const stack = [[startX, startY]];
  let changed = 0;
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    if (visited[index]) continue;
    visited[index] = 1;
    if (!colorsEqual(getPixel(buffer, width, height, x, y), target)) continue;
    if (setPixel(buffer, width, height, x, y, color)) changed += 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return changed;
}

/** 把 RGB 精确等于 oldRgb 的像素替换为 newRgb；保留原有 alpha，跳过全透明像素。 */
export function replaceRgb(buffer, oldRgb, newRgb) {
  // 新旧颜色相同则视为空操作：不要写入，也不要计入“已替换像素”，
  // 否则会生成内容未变的新缓冲区，污染撤销历史。
  if (
    oldRgb[0] === newRgb[0] &&
    oldRgb[1] === newRgb[1] &&
    oldRgb[2] === newRgb[2]
  ) {
    return 0;
  }
  let changed = 0;
  for (let i = 0; i < buffer.length; i += 4) {
    if (buffer[i + 3] === 0) continue;
    if (
      buffer[i] === oldRgb[0] &&
      buffer[i + 1] === oldRgb[1] &&
      buffer[i + 2] === oldRgb[2]
    ) {
      buffer[i] = newRgb[0];
      buffer[i + 1] = newRgb[1];
      buffer[i + 2] = newRgb[2];
      changed += 1;
    }
  }
  return changed;
}

export function fillRect(buffer, width, height, x, y, w, h, color) {
  let changed = 0;
  for (let py = y; py < y + h; py += 1) {
    for (let px = x; px < x + w; px += 1) {
      if (setPixel(buffer, width, height, px, py, color)) changed += 1;
    }
  }
  return changed;
}

/** 实心椭圆（含边界），用于程序绘制角色。 */
export function fillEllipse(buffer, width, height, cx, cy, rx, ry, color) {
  if (rx < 0 || ry < 0) return 0;
  let changed = 0;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const nx = (x - cx) / (rx || 1);
      const ny = (y - cy) / (ry || 1);
      if (nx * nx + ny * ny <= 1.0) {
        if (setPixel(buffer, width, height, x, y, color)) changed += 1;
      }
    }
  }
  return changed;
}

/** 椭圆的实心上半部（菌伞等）。 */
export function fillEllipseHalf(
  buffer,
  width,
  height,
  cx,
  cy,
  rx,
  ry,
  color,
  topOnly = true,
) {
  let changed = 0;
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y += 1) {
    if (topOnly && y > cy) continue;
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x += 1) {
      const nx = (x - cx) / (rx || 1);
      const ny = (y - cy) / (ry || 1);
      if (nx * nx + ny * ny <= 1.0) {
        if (setPixel(buffer, width, height, x, y, color)) changed += 1;
      }
    }
  }
  return changed;
}

/** 按 1px 步长画一条粗线（用于轮廓/表情）。 */
export function line(buffer, width, height, x0, y0, x1, y1, color) {
  return drawLine(buffer, width, height, x0, y0, x1, y1, color, 1);
}

/** 仅在目标像素已不透明时落笔，用于“阴影/高光只覆盖角色内部”。 */
export function setPixelIfOpaque(buffer, width, height, x, y, color) {
  const existing = getPixel(buffer, width, height, x, y);
  if (!existing || existing[3] === 0) return false;
  return setPixel(buffer, width, height, x, y, color);
}
