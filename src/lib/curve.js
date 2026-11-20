/**
 * Tone-curve math.
 *
 * A curve is represented as a list of [x, y] control points in the unit square,
 * sorted by x. The x=0 and x=1 endpoints are pinned horizontally (their y can be
 * moved so users can lift blacks / roll off whites), and interpolation is a
 * shape-preserving piecewise cubic (PCHIP) so the curve stays continuous and
 * does not oscillate when a point is dragged.
 */

export const MIN_POINT_GAP = 0.015;
export const MAX_POINTS = 16;
export const DEFAULT_CURVE = Object.freeze([
  [0, 0],
  [1, 1]
]);

export const CURVE_CHANNELS = [
  { key: 'master', label: '亮度', color: '#e9c46a' },
  { key: 'red', label: '红', color: '#ff6b6b' },
  { key: 'green', label: '绿', color: '#63d2a4' },
  { key: 'blue', label: '蓝', color: '#6aa9ff' }
];

export function cloneCurve(points) {
  return points.map(([x, y]) => [x, y]);
}

export function defaultCurveSet() {
  const out = {};
  for (const { key } of CURVE_CHANNELS) out[key] = cloneCurve(DEFAULT_CURVE);
  return out;
}

function isFinitePoint(point) {
  return (
    Array.isArray(point) &&
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Number.isFinite(point[1])
  );
}

/**
 * Strict validation for user edits. Returns the original ordering untouched on
 * failure so callers can keep the last valid curve.
 */
export function validateCurve(points, label = '曲线') {
  if (!Array.isArray(points)) {
    return { ok: false, error: `${label}数据无效：应为控制点数组。` };
  }
  if (points.length < 2) {
    return { ok: false, error: `${label}至少需要起点和终点两个控制点。` };
  }
  if (points.length > MAX_POINTS) {
    return { ok: false, error: `${label}最多支持 ${MAX_POINTS} 个控制点。` };
  }
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (!isFinitePoint(point)) {
      return { ok: false, error: `${label}第 ${i + 1} 个控制点格式无效。` };
    }
    const [x, y] = point;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      return { ok: false, error: `${label}控制点必须在 0–1 范围内（第 ${i + 1} 个为 ${x.toFixed(2)}, ${y.toFixed(2)}）。` };
    }
    if (i === 0 && Math.abs(x) > 1e-9) {
      return { ok: false, error: `${label}起点的横坐标必须为 0。` };
    }
    if (i === points.length - 1 && Math.abs(x - 1) > 1e-9) {
      return { ok: false, error: `${label}终点的横坐标必须为 1。` };
    }
    if (i > 0) {
      const gap = x - points[i - 1][0];
      if (gap <= 0) {
        return { ok: false, error: `${label}控制点的横坐标必须严格递增。` };
      }
      if (gap < MIN_POINT_GAP - 1e-9) {
        return {
          ok: false,
          error: `${label}相邻控制点至少相距 ${MIN_POINT_GAP.toFixed(3)}，请拉开一点。`
        };
      }
    }
  }
  return { ok: true, points: cloneCurve(points) };
}

/**
 * Tolerant normalization used when loading persisted projects: bad curves fall
 * back to linear instead of making the project unreadable.
 *
 * The output is guaranteed to satisfy the same invariants as `validateCurve`
 * (endpoints pinned to x=0/1, strictly increasing x, gaps ≥ MIN_POINT_GAP), so
 * a curve restored from disk can be edited without tripping validation.
 */
export function normalizeCurve(points) {
  const fallback = cloneCurve(DEFAULT_CURVE);
  if (!Array.isArray(points)) return { points: fallback, warning: null };
  const cleaned = [];
  for (const point of points) {
    if (!isFinitePoint(point)) continue;
    const x = Math.min(1, Math.max(0, point[0]));
    const y = Math.min(1, Math.max(0, point[1]));
    cleaned.push([x, y]);
  }
  if (cleaned.length < 2) return { points: fallback, warning: '曲线控制点不足，已恢复为线性曲线。' };

  cleaned.sort((a, b) => a[0] - b[0]);
  const result = [];
  for (const point of cleaned) {
    if (!result.length) {
      result.push([point[0], point[1]]);
      continue;
    }
    const prev = result[result.length - 1];
    if (point[0] - prev[0] < MIN_POINT_GAP - 1e-9) continue;
    result.push(point);
  }
  if (!result.length) return { points: fallback, warning: '曲线控制点无效，已恢复为线性曲线。' };

  // Pin the endpoints, then drop any interior point that is now too close to
  // the pinned endpoint.
  if (result[0][0] > 1e-9) result.unshift([0, result[0][1]]);
  else result[0][0] = 0;
  while (result.length > 2 && result[1][0] - result[0][0] < MIN_POINT_GAP - 1e-9) result.splice(1, 1);

  const last = result[result.length - 1];
  if (last[0] < 1 - 1e-9) result.push([1, last[1]]);
  else last[0] = 1;
  while (result.length > 2 && result[result.length - 1][0] - result[result.length - 2][0] < MIN_POINT_GAP - 1e-9) {
    result.splice(result.length - 2, 1);
  }

  if (result.length < 2) return { points: fallback, warning: '曲线控制点不足，已恢复为线性曲线。' };
  if (result.length > MAX_POINTS) {
    // Keep both endpoints and an even spread of interior points.
    const keep = [result[0]];
    const interior = result.slice(1, -1);
    const slots = MAX_POINTS - 2;
    for (let i = 0; i < slots; i += 1) {
      const index = Math.round((i / (slots - 1 || 1)) * (interior.length - 1));
      if (interior[index] && !keep.includes(interior[index])) keep.push(interior[index]);
    }
    keep.push(result[result.length - 1]);
    return { points: keep, warning: `控制点超过 ${MAX_POINTS} 个，已精简。` };
  }
  return { points: result, warning: null };
}

function endpointsSlope(h0, h1, d0, d1) {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (m * d0 <= 0) return 0;
  if (d0 * d1 <= 0 && Math.abs(m) > Math.abs(3 * d0)) return 3 * d0;
  return m;
}

/**
 * Build a sampler for a validated curve. Slopes are computed once.
 *
 * Note: this function is also used on project data straight from localStorage
 * (for curve preview overlays), so it must tolerate degenerate input rather
 * than throwing inside a render frame.
 */
export function createCurveSampler(inputPoints) {
  const points = Array.isArray(inputPoints) && inputPoints.length >= 2 ? inputPoints : DEFAULT_CURVE;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const n = points.length;
  if (n === 2) {
    const slope = (ys[1] - ys[0]) / ((xs[1] - xs[0]) || 1);
    return function linear(x) {
      if (!Number.isFinite(x)) return 0;
      if (x <= xs[0]) return clamp01(ys[0]);
      if (x >= xs[1]) return clamp01(ys[1]);
      return clamp01(ys[0] + (x - xs[0]) * slope);
    };
  }
  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i += 1) {
    const dx = xs[i + 1] - xs[i];
    h.push(dx);
    delta.push(dx > 0 ? (ys[i + 1] - ys[i]) / dx : 0);
  }
  const slope = new Array(n).fill(0);
  slope[0] = endpointsSlope(h[0], h[1], delta[0], delta[1]);
  slope[n - 1] = endpointsSlope(h[n - 2], h[n - 3], delta[n - 2], delta[n - 3]);
  for (let i = 1; i < n - 1; i += 1) {
    const d0 = delta[i - 1];
    const d1 = delta[i];
    if (d0 === 0 || d1 === 0 || d0 * d1 < 0) {
      slope[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      slope[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
    }
  }

  return function sample(x) {
    if (!Number.isFinite(x)) return 0;
    if (x <= xs[0]) return clamp01(ys[0]);
    if (x >= xs[n - 1]) return clamp01(ys[n - 1]);
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const x0 = xs[lo];
    const x1 = xs[hi];
    const dx = x1 - x0;
    const t = (x - x0) / dx;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    const value = h00 * ys[lo] + h10 * dx * slope[lo] + h01 * ys[hi] + h11 * dx * slope[hi];
    return clamp01(value);
  };
}

export function curveValueAt(points, x) {
  return createCurveSampler(points)(x);
}

export function buildCurveLut(points, size = 256) {
  const sampler = createCurveSampler(points);
  const lut = new Float32Array(size);
  for (let i = 0; i < size; i += 1) lut[i] = sampler(i / (size - 1));
  return lut;
}

export function curveIsLinear(points) {
  return points.length === 2 && Math.abs(points[0][1]) < 1e-6 && Math.abs(points[1][1] - 1) < 1e-6;
}

export function addCurvePoint(points, x, y, label = '曲线') {
  const candidate = cloneCurve(points);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: `${label}新控制点坐标无效。` };
  }
  if (x <= MIN_POINT_GAP || x >= 1 - MIN_POINT_GAP) {
    return { ok: false, error: `${label}不能在端点附近添加控制点。` };
  }
  if (y < 0 || y > 1) {
    return { ok: false, error: `${label}新控制点的 Y 值必须在 0–1 之间。` };
  }
  if (candidate.length >= MAX_POINTS) {
    return { ok: false, error: `${label}最多支持 ${MAX_POINTS} 个控制点。` };
  }
  if (candidate.some((point) => Math.abs(point[0] - x) < MIN_POINT_GAP)) {
    return { ok: false, error: `${label}该位置附近已有控制点，请拉开一点。` };
  }
  candidate.push([x, y]);
  candidate.sort((a, b) => a[0] - b[0]);
  return validateCurve(candidate, label);
}

export function moveCurvePoint(points, index, x, y, label = '曲线') {
  if (!Number.isInteger(index) || index < 0 || index >= points.length) {
    return { ok: false, error: `${label}控制点索引无效。` };
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, error: `${label}控制点坐标无效。` };
  }
  if (y < 0 || y > 1) {
    return { ok: false, error: `${label}控制点的 Y 值必须在 0–1 之间。` };
  }
  const candidate = cloneCurve(points);
  const isEndpoint = index === 0 || index === points.length - 1;
  if (isEndpoint) {
    candidate[index][1] = y;
    return validateCurve(candidate, label);
  }
  const minX = candidate[index - 1][0] + MIN_POINT_GAP;
  const maxX = candidate[index + 1][0] - MIN_POINT_GAP;
  if (x < minX || x > maxX) {
    return {
      ok: false,
      error: `${label}控制点需与相邻点保持 ${MIN_POINT_GAP.toFixed(3)} 的间距（X 应在 ${minX.toFixed(2)}–${maxX.toFixed(2)}）。`
    };
  }
  candidate[index][0] = x;
  candidate[index][1] = y;
  return validateCurve(candidate, label);
}

export function removeCurvePoint(points, index, label = '曲线') {
  if (!Number.isInteger(index) || index <= 0 || index >= points.length - 1) {
    return { ok: false, error: `${label}起点和终点不能删除。` };
  }
  if (points.length <= 2) {
    return { ok: false, error: `${label}至少保留两个控制点。` };
  }
  const candidate = points.filter((_, i) => i !== index);
  return validateCurve(candidate, label);
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
