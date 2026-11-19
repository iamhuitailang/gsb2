/**
 * 极简 RGBA 光栅绘图，用于在浏览器和 Node 中生成同一份示例图片。
 * 仅实现示例需要的图元；所有函数都直接写入 Uint8ClampedArray。
 */

export function createCanvasBuffer(width, height, background = [12, 14, 18, 255]) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = background[0];
    rgba[i * 4 + 1] = background[1];
    rgba[i * 4 + 2] = background[2];
    rgba[i * 4 + 3] = background[3];
  }
  return { width, height, rgba };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function blendPixel(buffer, x, y, color) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  const i = (y * buffer.width + x) * 4;
  const alpha = (color[3] ?? 255) / 255;
  if (alpha >= 1) {
    buffer.rgba[i] = color[0];
    buffer.rgba[i + 1] = color[1];
    buffer.rgba[i + 2] = color[2];
    buffer.rgba[i + 3] = 255;
    return;
  }
  const inv = 1 - alpha;
  buffer.rgba[i] = color[0] * alpha + buffer.rgba[i] * inv;
  buffer.rgba[i + 1] = color[1] * alpha + buffer.rgba[i + 1] * inv;
  buffer.rgba[i + 2] = color[2] * alpha + buffer.rgba[i + 2] * inv;
  buffer.rgba[i + 3] = 255;
}

export function fill(buffer, color) {
  for (let y = 0; y < buffer.height; y += 1) {
    for (let x = 0; x < buffer.width; x += 1) {
      blendPixel(buffer, x, y, color);
    }
  }
  return buffer;
}

export function verticalGradient(buffer, top, bottom, y0 = 0, y1 = buffer.height) {
  const span = Math.max(1, y1 - y0);
  for (let y = Math.max(0, y0); y < Math.min(buffer.height, y1); y += 1) {
    const t = (y - y0) / span;
    const color = [
      top[0] + (bottom[0] - top[0]) * t,
      top[1] + (bottom[1] - top[1]) * t,
      top[2] + (bottom[2] - top[2]) * t,
      255,
    ];
    for (let x = 0; x < buffer.width; x += 1) blendPixel(buffer, x, y, color);
  }
  return buffer;
}

export function fillRect(buffer, x, y, w, h, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(buffer.width, Math.round(x + w));
  const y1 = Math.min(buffer.height, Math.round(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) blendPixel(buffer, px, py, color);
  }
  return buffer;
}

export function fillRoundedRect(buffer, x, y, w, h, radius, color) {
  const r = Math.min(radius, w / 2, h / 2);
  for (let py = Math.max(0, Math.floor(y)); py < Math.min(buffer.height, Math.ceil(y + h)); py += 1) {
    for (let px = Math.max(0, Math.floor(x)); px < Math.min(buffer.width, Math.ceil(x + w)); px += 1) {
      const dx = Math.max(x + r - px, 0, px - (x + w - r));
      const dy = Math.max(y + r - py, 0, py - (y + h - r));
      if (dx * dx + dy * dy <= r * r) blendPixel(buffer, px, py, color);
    }
  }
  return buffer;
}

export function fillCircle(buffer, cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let py = Math.max(0, Math.floor(cy - radius)); py <= Math.min(buffer.height - 1, Math.ceil(cy + radius)); py += 1) {
    for (let px = Math.max(0, Math.floor(cx - radius)); px <= Math.min(buffer.width - 1, Math.ceil(cx + radius)); px += 1) {
      const dx = px + 0.5 - cx;
      const dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) blendPixel(buffer, px, py, color);
    }
  }
  return buffer;
}

export function fillEllipse(buffer, cx, cy, rx, ry, color) {
  for (let py = Math.max(0, Math.floor(cy - ry)); py <= Math.min(buffer.height - 1, Math.ceil(cy + ry)); py += 1) {
    for (let px = Math.max(0, Math.floor(cx - rx)); px <= Math.min(buffer.width - 1, Math.ceil(cx + rx)); px += 1) {
      const dx = (px + 0.5 - cx) / rx;
      const dy = (py + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) blendPixel(buffer, px, py, color);
    }
  }
  return buffer;
}

export function fillPolygon(buffer, points, color) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(buffer.height - 1, Math.ceil(maxY));
  const xs = [];
  for (let py = y0; py <= y1; py += 1) {
    const cy = py + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if ((yi <= cy && yj > cy) || (yj <= cy && yi > cy)) {
        xs.push(xi + ((cy - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let px = Math.max(0, Math.ceil(xs[i] - 0.5)); px <= Math.min(buffer.width - 1, Math.ceil(xs[i + 1] - 0.5) - 1); px += 1) {
        blendPixel(buffer, px, py, color);
      }
    }
  }
  return buffer;
}

export function strokeLine(buffer, x0, y0, x1, y1, thickness, color) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= steps; i += 1) {
    const t = steps === 0 ? 0 : i / steps;
    fillCircle(buffer, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, thickness / 2, color);
  }
  return buffer;
}

/** 在矩形区域内撒点，模拟纹理/噪点。 */
export function scatterDots(buffer, width, height, x, y, w, h, color, count, seed = 1) {
  const random = mulberry32(seed);
  for (let i = 0; i < count; i += 1) {
    const px = x + random() * w;
    const py = y + random() * h;
    fillCircle(buffer, px, py, width + random() * height, color);
  }
  return buffer;
}
