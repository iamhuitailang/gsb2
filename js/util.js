// 通用工具：颜色、数学、折线重采样。

export const TAU = Math.PI * 2;

export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

export function hexToRgb(hex) {
  const s = String(hex).replace('#', '').trim();
  const full = s.length === 3 ? s.split('').map((ch) => ch + ch).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [0, 0, 0];
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

export function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
}

export function rgbToCss(rgb, alpha = 1) {
  const c = rgb.map((v) => Math.round(clamp(v) * 255));
  return alpha >= 1 ? `rgb(${c[0]} ${c[1]} ${c[2]})` : `rgb(${c[0]} ${c[1]} ${c[2]} / ${alpha})`;
}

export function luminance(rgb) {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function scaleRgb(a, k) {
  return [a[0] * k, a[1] * k, a[2] * k];
}

export function addRgb(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function cloneRgb(a) {
  return [a[0], a[1], a[2]];
}

export function deepClone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

/** 确定性伪随机，用于给默认探针一点自然差异。 */
export function hash01(a, b = 0, c = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

export function formatNumber(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export function formatPct(n, digits = 0) {
  return Number.isFinite(n) ? `${(n * 100).toFixed(digits)}%` : '—';
}

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  }
  return total;
}

/**
 * 按固定步长重采样折线，保留累计距离。至少返回两个点。
 */
export function resamplePolyline(points, step = 0.1) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (points.length === 1) return [{ x: points[0].x, z: points[0].z, dist: 0 }];

  const total = polylineLength(points);
  const count = Math.max(2, Math.ceil(total / step) + 1);
  const out = [];
  let seg = 0;
  let segStart = 0;
  let segLen = Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z);

  for (let i = 0; i < count; i += 1) {
    const target = (total * i) / (count - 1);
    while (seg < points.length - 2 && target > segStart + segLen) {
      segStart += segLen;
      seg += 1;
      segLen = Math.hypot(points[seg + 1].x - points[seg].x, points[seg + 1].z - points[seg].z);
    }
    const t = segLen > 1e-9 ? clamp((target - segStart) / segLen, 0, 1) : 0;
    const a = points[seg];
    const b = points[seg + 1];
    out.push({ x: lerp(a.x, b.x, t), z: lerp(a.z, b.z, t), dist: target });
  }
  return out;
}

/** 距离折线上最近的一点，返回位置与路径距离。 */
export function nearestOnPolyline(points, p) {
  if (!points || points.length < 2) return { x: p.x, z: p.z, dist: 0, segment: 0 };
  let best = { x: points[0].x, z: points[0].z, dist: 0, segment: 0, d2: Infinity };
  let acc = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-9 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / len2, 0, 1) : 0;
    const x = a.x + dx * t;
    const z = a.z + dz * t;
    const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d2 < best.d2) {
      best = { x, z, dist: acc + Math.sqrt(len2) * t, segment: i - 1, d2 };
    }
    acc += Math.sqrt(len2);
  }
  return best;
}
