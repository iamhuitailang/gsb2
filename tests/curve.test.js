import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCurvePoint,
  buildCurveLut,
  clamp01,
  createCurveSampler,
  curveValueAt,
  DEFAULT_CURVE,
  MAX_POINTS,
  MIN_POINT_GAP,
  moveCurvePoint,
  normalizeCurve,
  removeCurvePoint,
  validateCurve
} from '../src/lib/curve.js';

const linear = DEFAULT_CURVE.map((p) => [...p]);

test('default curve is the identity', () => {
  for (let i = 0; i <= 20; i += 1) {
    const x = i / 20;
    assert.ok(Math.abs(curveValueAt(linear, x) - x) < 1e-9, `x=${x}`);
  }
});

test('multi-point curve stays continuous and within range', () => {
  const points = [
    [0, 0.02],
    [0.2, 0.16],
    [0.45, 0.55],
    [0.7, 0.82],
    [1, 0.98]
  ];
  const sampler = createCurveSampler(points);
  let previous = sampler(0);
  let maxJump = 0;
  for (let i = 1; i <= 2000; i += 1) {
    const value = sampler(i / 2000);
    maxJump = Math.max(maxJump, Math.abs(value - previous));
    assert.ok(value >= 0 && value <= 1);
    previous = value;
  }
  // A smooth curve sampled at 0.0005 steps must never jump by more than a few
  // 8-bit levels.
  assert.ok(maxJump < 3 / 255, `max jump ${maxJump}`);
});

test('dragging a point cannot create a discontinuity or reorder points', () => {
  let points = [
    [0, 0],
    [0.3, 0.4],
    [0.6, 0.6],
    [1, 1]
  ];
  let result = moveCurvePoint(points, 1, 0.42, 0.55);
  assert.equal(result.ok, true);
  points = result.points;
  assert.deepEqual(points.map((p) => p[0]), [0, 0.42, 0.6, 1]);
  const sampler = createCurveSampler(points);
  let last = sampler(0);
  for (let i = 1; i <= 1000; i += 1) {
    const value = sampler(i / 1000);
    assert.ok(Math.abs(value - last) < 0.02);
    last = value;
  }
});

test('moving a point past a neighbour is rejected and keeps the last valid value', () => {
  const points = [
    [0, 0],
    [0.3, 0.3],
    [0.6, 0.6],
    [1, 1]
  ];
  const result = moveCurvePoint(points, 1, 0.7, 0.5);
  assert.equal(result.ok, false);
  assert.match(result.error, /间距/);
  // original untouched
  assert.deepEqual(points, [
    [0, 0],
    [0.3, 0.3],
    [0.6, 0.6],
    [1, 1]
  ]);
});

test('endpoints are horizontally pinned but vertical is editable', () => {
  const points = [
    [0, 0],
    [0.5, 0.5],
    [1, 1]
  ];
  const lifted = moveCurvePoint(points, 0, 0.2, 0.1);
  assert.equal(lifted.ok, true);
  assert.deepEqual(lifted.points[0], [0, 0.1]);
  const liftedEnd = moveCurvePoint(points, 2, 0.9, 0.85);
  assert.equal(liftedEnd.ok, true);
  assert.deepEqual(liftedEnd.points[2], [1, 0.85]);
});

test('out-of-range y and non-numeric values are rejected with a message', () => {
  const points = [
    [0, 0],
    [0.5, 0.5],
    [1, 1]
  ];
  assert.equal(moveCurvePoint(points, 1, 0.5, 1.4).ok, false);
  assert.match(moveCurvePoint(points, 1, Number.NaN, 0.5).error, /无效/);
  assert.equal(validateCurve([[0, 0], [0.5, 0.5], [0.4, 0.2], [1, 1]]).ok, false);
  assert.equal(validateCurve([[0.1, 0], [1, 1]]).ok, false);
  assert.equal(validateCurve([[0, 0], [0.9, 1]]).ok, false);
  assert.equal(validateCurve('nope').ok, false);
});

test('points closer than MIN_POINT_GAP are rejected', () => {
  const points = [
    [0, 0],
    [0.5, 0.5],
    [1, 1]
  ];
  const tooClose = moveCurvePoint(points, 1, MIN_POINT_GAP / 2, 0.2);
  assert.equal(tooClose.ok, false);
  const added = addCurvePoint(points, MIN_POINT_GAP / 2, 0.5);
  assert.equal(added.ok, false);
});

test('adding points keeps sorted order and enforces the point cap', () => {
  let points = linear;
  let result = addCurvePoint(points, 0.5, 0.6);
  assert.equal(result.ok, true);
  points = result.points;
  assert.deepEqual(points, [
    [0, 0],
    [0.5, 0.6],
    [1, 1]
  ]);
  result = addCurvePoint(points, 0.25, 0.2);
  assert.equal(result.ok, true);
  assert.deepEqual(result.points.map((p) => p[0]), [0, 0.25, 0.5, 1]);

  let crowded = linear;
  for (let i = 1; i <= MAX_POINTS - 2; i += 1) {
    const next = addCurvePoint(crowded, i / (MAX_POINTS - 1), i / (MAX_POINTS - 1));
    assert.equal(next.ok, true, `added ${i}`);
    crowded = next.points;
  }
  assert.equal(crowded.length, MAX_POINTS);
  const overflow = addCurvePoint(crowded, 17 / 32, 0.5);
  assert.equal(overflow.ok, false);
  assert.match(overflow.error, /最多/);
});

test('removing points keeps at least the endpoints', () => {
  const points = [
    [0, 0],
    [0.3, 0.2],
    [0.7, 0.8],
    [1, 1]
  ];
  const result = removeCurvePoint(points, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.points, [
    [0, 0],
    [0.7, 0.8],
    [1, 1]
  ]);
  assert.equal(removeCurvePoint(result.points, 0).ok, false);
  assert.equal(removeCurvePoint(result.points, 2).ok, false);
});

test('PCHIP does not overshoot on a plateau (no ringing when dragging)', () => {
  const points = [
    [0, 0],
    [0.3, 0.5],
    [0.5, 0.5],
    [0.7, 0.5],
    [1, 1]
  ];
  const sampler = createCurveSampler(points);
  for (let i = 0; i <= 1000; i += 1) {
    const x = i / 1000;
    const value = sampler(x);
    assert.ok(value >= -1e-9 && value <= 1 + 1e-9, `out of range at ${x}`);
  }
  // between 0.3 and 0.7 the curve must not exceed the plateau's y
  for (let x = 0.305; x < 0.695; x += 0.01) {
    assert.ok(sampler(x) <= 0.5 + 1e-9, `overshoot at ${x}: ${sampler(x)}`);
  }
});

test('LUT has 256 entries, starts at y0 and ends at y1', () => {
  const points = [
    [0, 0.1],
    [0.5, 0.6],
    [1, 0.9]
  ];
  const lut = buildCurveLut(points);
  assert.equal(lut.length, 256);
  assert.ok(Math.abs(lut[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(lut[255] - 0.9) < 1e-6);
  for (let i = 1; i < 256; i += 1) {
    assert.ok(lut[i] >= 0 && lut[i] <= 1);
  }
});

test('tolerant loader recovers usable curves from damaged project data', () => {
  assert.deepEqual(normalizeCurve([[0, 0], [1, 1]]).points, [
    [0, 0],
    [1, 1]
  ]);
  const clamped = normalizeCurve([
    [0.2, -1],
    [0.5, 0.5],
    [1.4, 2]
  ]);
  assert.deepEqual(clamped.points[0], [0, 0]);
  assert.deepEqual(clamped.points[clamped.points.length - 1], [1, 1]);
  const fallback = normalizeCurve([[0.5, 0.5]]);
  assert.equal(fallback.points.length, 2);
  assert.ok(fallback.warning);
  const deduped = normalizeCurve([
    [0, 0],
    [0.5, 0.4],
    [0.5, 0.6],
    [1, 1]
  ]);
  assert.equal(deduped.points.length, 3);
});

test('clamp01 handles NaN-free edges', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(3), 1);
  assert.equal(clamp01(0.4), 0.4);
});

test('every normalized curve passes strict validation (round-trip safety)', () => {
  const inputs = [
    [[0, 0], [1, 1]],
    [[0.2, -1], [0.5, 0.5], [1.4, 2]],
    [[0.5, 0.5]],
    [[0, 0], [0.5, 0.4], [0.5, 0.6], [1, 1]],
    [[0, 0], [0.005, 0.2], [0.01, 0.3], [0.02, 0.4], [1, 1]],
    [[0, 0], [0.995, 0.8], [0.998, 0.9], [1, 1]],
    [[-1, 0], [0.5, 0.5], [2, 1]],
    Array.from({ length: 30 }, (_, i) => [i / 29, i / 29]),
    [[0, 0], [Number.NaN, 0.5], [1, 1]],
    [[0, 0], [0.3, 0.2], [0.31, 0.3], [1, 1]]
  ];
  for (const input of inputs) {
    const { points } = normalizeCurve(input);
    const check = validateCurve(points);
    assert.equal(check.ok, true, `normalized ${JSON.stringify(input)} → ${JSON.stringify(points)}: ${check.error}`);
    assert.ok(points.length <= MAX_POINTS);
  }
});

test('normalized curves keep their endpoints pinned at x = 0 and x = 1', () => {
  const { points } = normalizeCurve([[0.4, 0.2], [0.6, 0.7]]);
  assert.equal(points[0][0], 0);
  assert.equal(points[points.length - 1][0], 1);
});
