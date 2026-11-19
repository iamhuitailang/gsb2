import type { Curve, CurvePoint, Easing } from './types.ts';
import { clamp } from './rng.ts';

const EASING: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  smoothstep: (t) => t * t * (3 - 2 * t),
};

export function isEasing(value: unknown): value is Easing {
  return typeof value === 'string' && value in EASING;
}

export function applyEasing(easing: Easing, t: number): number {
  const fn = EASING[easing] ?? EASING.linear;
  return fn(clamp(t, 0, 1));
}

/** 曲线求值；点需已按 t 排序。区间外取端点值。 */
export function evalCurve(curve: Curve, u: number): number {
  const points = curve.points;
  if (points.length === 0) return 0;
  const t = clamp(u, 0, 1);
  const first = points[0];
  if (t <= first.t) return first.v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-9) return b.v;
      const k = applyEasing(curve.interpolation, (t - a.t) / span);
      return a.v + (b.v - a.v) * k;
    }
  }
  return last.v;
}

/** 在 [0,1] 上等距抽样，用于曲线缩略图或离线预览。 */
export function sampleCurve(curve: Curve, count = 96): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(evalCurve(curve, i / (count - 1)));
  return out;
}

export function normalizeCurvePoints(points: CurvePoint[]): CurvePoint[] {
  return points
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: clamp(p.t, 0, 1), v: p.v }))
    .sort((a, b) => a.t - b.t);
}

/** 曲线值域，用于编辑区纵轴缩放。 */
export function curveExtent(curve: Curve): [number, number] {
  let min = 0;
  let max = 1;
  for (const p of curve.points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  return [min, max];
}
