/**
 * 掩码栅格化。
 *
 * 掩码使用“单通道类别索引”：
 *   0 = 背景
 *   1..N = 标签在项目标签列表中的顺序（与导出 JSON 的 categories[].index 一致）
 * 重叠标注按列表顺序绘制，后绘制的覆盖先绘制的（painter's order）。
 * 隐藏标注不参与掩码；锁定只是编辑约束，锁定的标注仍然导出。
 *
 * 采用像素中心采样，不做抗锯齿，保证掩码边界唯一、可复现。
 */

import { BACKGROUND_INDEX } from './model.js';

export function createMaskBuffer(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  return { width: w, height: h, data: new Uint8Array(w * h) };
}

function setPixel(buffer, x, y, value) {
  if (x < 0 || y < 0 || x >= buffer.width || y >= buffer.height) return;
  buffer.data[y * buffer.width + x] = value;
}

/** 扫描线填充多边形，even-odd 规则；value 为类别索引。 */
export function fillPolygonIndex(buffer, points, value) {
  if (!Array.isArray(points) || points.length < 3) return buffer;
  const { width, height } = buffer;
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
  const xs = [];
  for (let y = minY; y <= maxY; y += 1) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i];
      const [xj, yj] = points[j];
      if ((yi <= py && yj > py) || (yj <= py && yi > py)) {
        const x = xi + ((py - yi) * (xj - xi)) / (yj - yi);
        xs.push(x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const startX = Math.max(0, Math.ceil(xs[i] - 0.5));
      const endX = Math.min(width - 1, Math.ceil(xs[i + 1] - 0.5) - 1);
      for (let x = startX; x <= endX; x += 1) {
        buffer.data[y * width + x] = value;
      }
    }
  }
  return buffer;
}

/** 填充矩形，像素中心落在 [x, x+width) × [y, y+height) 内的像素。 */
export function fillRectIndex(buffer, rect, value) {
  const { width, height } = buffer;
  const x0 = Math.max(0, Math.ceil(rect.x - 0.5));
  const y0 = Math.max(0, Math.ceil(rect.y - 0.5));
  const x1 = Math.min(width - 1, Math.ceil(rect.x + rect.width - 0.5) - 1);
  const y1 = Math.min(height - 1, Math.ceil(rect.y + rect.height - 0.5) - 1);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      buffer.data[y * width + x] = value;
    }
  }
  return buffer;
}

export function labelIndexMap(labels) {
  const map = new Map();
  labels.forEach((label, i) => map.set(label.id, i + BACKGROUND_INDEX + 1));
  return map;
}

/**
 * 为一张图片生成类别索引掩码。
 * @returns {{ width, height, data, categories }}
 */
export function rasterizeImageMask(image, labels) {
  const buffer = createMaskBuffer(image.width, image.height);
  const indexOf = labelIndexMap(labels);
  for (const annotation of image.annotations) {
    if (annotation.hidden) continue;
    const value = indexOf.get(annotation.labelId);
    if (!value) continue;
    if (annotation.type === 'rect') {
      fillRectIndex(buffer, annotation.rect, value);
    } else if (annotation.type === 'polygon') {
      fillPolygonIndex(buffer, annotation.points, value);
    }
  }
  return {
    ...buffer,
    categories: labels.map((label, i) => ({
      index: i + 1,
      id: label.id,
      name: label.name,
      color: label.color,
    })),
  };
}

/** 彩色预览：背景保持深灰，类别使用标签颜色。 */
export function maskToPreviewRGBA(buffer, labels) {
  const rgba = new Uint8ClampedArray(buffer.width * buffer.height * 4);
  const colors = [null, ...labels.map((label) => parseHexColor(label.color))];
  for (let i = 0; i < buffer.data.length; i += 1) {
    const value = buffer.data[i];
    const color = colors[value] ?? [18, 20, 24];
    rgba[i * 4] = color[0];
    rgba[i * 4 + 1] = color[1];
    rgba[i * 4 + 2] = color[2];
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

export function parseHexColor(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  const number = Number.parseInt(full, 16);
  if (!Number.isFinite(number)) return [128, 128, 128];
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}
