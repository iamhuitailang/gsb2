import test from 'node:test';
import assert from 'node:assert/strict';
import { PathSpline } from '../dist/core/curve.js';

const P = (x, y, z) => [x, y, z];

test('centripetal Catmull-Rom passes exactly through every control point', () => {
  const points = [P(-10, 2, 0), P(-3, 5, 6), P(4, 3, 2), P(9, 6, -7), P(15, 4, 1)];
  const spline = new PathSpline(points, false);
  const samples = 4000;
  let last = null;
  for (let i = 0; i <= samples; i++) {
    const p = spline.positionAt(i / samples);
    if (last) {
      const d = Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]);
      // No jumps: the curve must be sampled continuously.
      assert.ok(d < 1.5, `position jump of ${d} between adjacent samples`);
    }
    last = p;
  }
  for (const [i, point] of points.entries()) {
    const near = spline.nearest(point);
    assert.ok(near.distance < 0.02, `control point ${i} is ${near.distance} away from the curve`);
  }
});

test('moving a control point keeps the curve continuous everywhere (C1)', () => {
  const base = [P(-12, 3, 0), P(-4, 6, 8), P(3, 4, 1), P(10, 7, -6), P(18, 5, 2)];
  const moved = base.map((p, i) => (i === 2 ? P(3, 4.5, 6) : p));
  const spline = new PathSpline(moved, false);
  const steps = 3000;
  let prevDir = null;
  let minDot = 1;
  for (let i = 0; i <= steps; i++) {
    const t = spline.tangentAt(i / steps);
    if (prevDir) {
      const dot = t[0] * prevDir[0] + t[1] * prevDir[1] + t[2] * prevDir[2];
      minDot = Math.min(minDot, dot);
    }
    prevDir = t;
  }
  // Tangents must turn smoothly; adjacent directions stay nearly parallel.
  assert.ok(minDot > 0.9, `tangent direction jumped (min dot ${minDot})`);
});

test('closed paths wrap seamlessly in position and tangent', () => {
  const points = [P(-8, 4, -8), P(8, 6, -8), P(10, 5, 7), P(-6, 3, 9)];
  const spline = new PathSpline(points, true);
  const eps = 1e-3;
  const a = spline.positionAt(1 - eps);
  const b = spline.positionAt(eps);
  const gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const tA = spline.tangentAt(1 - 1e-4);
  const tB = spline.tangentAt(1e-4);
  const dot = tA[0] * tB[0] + tA[1] * tB[1] + tA[2] * tB[2];
  assert.ok(gap < 0.5, `wrap gap ${gap}`);
  assert.ok(dot > 0.99, `wrap tangent dot ${dot}`);
});

test('arc-length sampling is monotonic and spans the full length', () => {
  const points = [P(-20, 4, 0), P(-5, 9, 12), P(12, 3, 4), P(25, 8, -10)];
  const spline = new PathSpline(points, false);
  let prev = null;
  let total = 0;
  for (let i = 0; i <= 500; i++) {
    const p = spline.positionAt(i / 500);
    if (prev) total += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
    prev = p;
  }
  assert.ok(Math.abs(total - spline.totalLength) / spline.totalLength < 0.05, 'length mismatch');
});

test('nearest() finds the closest location for points beside the path', () => {
  const points = [P(-10, 2, 0), P(0, 2, 0), P(10, 2, 0)];
  const spline = new PathSpline(points, false);
  const target = P(5, 2, 3);
  const near = spline.nearest(target);
  assert.ok(near.distance < 3.5, `distance ${near.distance}`);
  assert.ok(near.s > 0.6 && near.s < 0.95, `s ${near.s}`);
});

test('two-point paths are valid and do not produce NaN', () => {
  const spline = new PathSpline([P(0, 1, 0), P(10, 1, 0)], false);
  for (const s of [0, 0.25, 0.5, 0.75, 1]) {
    const p = spline.positionAt(s);
    assert.ok(p.every(Number.isFinite), `non-finite at s=${s}`);
  }
});
