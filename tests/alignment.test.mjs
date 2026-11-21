import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_ALIGNMENT,
  centeredAlignment,
  comparisonBounds,
  invertMatrix,
  mapPoint,
  matrixFromAlignment,
  rotateAroundPivot,
  scaleAroundPivot,
  solveSimilarity,
  transformedBounds,
} from '../src/core/alignment.js';

test('matrix maps B pixels through scale and translation', () => {
  const alignment = { tx: 10, ty: -4, scale: 2, rotation: 0 };
  const mapped = mapPoint(alignment, 3, 5);
  assert.equal(mapped.x, 16);
  assert.equal(mapped.y, 6);
});

test('matrix rotation is applied before translation', () => {
  const alignment = { tx: 100, ty: 0, scale: 1, rotation: Math.PI / 2 };
  const mapped = mapPoint(alignment, 10, 0);
  assert.ok(Math.abs(mapped.x - 100) < 1e-9);
  assert.ok(Math.abs(mapped.y - 10) < 1e-9);
});

test('invertMatrix round-trips a point', () => {
  const alignment = { tx: 17.5, ty: -9, scale: 1.37, rotation: 0.41 };
  const m = matrixFromAlignment(alignment);
  const inv = invertMatrix(m);
  const p = mapPoint(alignment, 42, 88);
  const back = {
    x: inv.a * p.x + inv.c * p.y + inv.e,
    y: inv.b * p.x + inv.d * p.y + inv.f,
  };
  assert.ok(Math.abs(back.x - 42) < 1e-9);
  assert.ok(Math.abs(back.y - 88) < 1e-9);
});

test('centeredAlignment centres a smaller B inside A', () => {
  const al = centeredAlignment(1000, 800, 500, 400);
  assert.equal(al.tx, 250);
  assert.equal(al.ty, 200);
  assert.equal(al.scale, 1);
});

test('transformedBounds covers rotated corners', () => {
  const al = { tx: 0, ty: 0, scale: 1, rotation: Math.PI / 2 };
  const b = transformedBounds(al, 100, 50);
  assert.ok(Math.abs(b.minX + 50) < 1e-9);
  assert.ok(Math.abs(b.maxX) < 1e-9);
  assert.ok(Math.abs(b.maxY - 100) < 1e-9);
});

test('comparisonBounds unions A and aligned B', () => {
  const al = { tx: -100, ty: 20, scale: 1, rotation: 0 };
  const b = comparisonBounds(500, 400, al, 200, 100);
  assert.equal(b.minX, -100);
  assert.equal(b.maxX, 500);
  assert.equal(b.minY, 0);
  assert.equal(b.maxY, 400);
});

test('solveSimilarity recovers an exact similarity transform', () => {
  const truth = { tx: 32, ty: -18, scale: 1.25, rotation: 0.12 };
  const bPoints = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 300 },
    { x: 0, y: 300 },
  ];
  const pairs = bPoints.map((p) => {
    const a = mapPoint(truth, p.x, p.y);
    return { ax: a.x, ay: a.y, bx: p.x, by: p.y };
  });
  const fit = solveSimilarity(pairs);
  assert.equal(fit.ok, true);
  assert.equal(fit.count, 4);
  assert.ok(fit.rms < 1e-6);
  assert.ok(Math.abs(fit.alignment.scale - truth.scale) < 1e-9);
  assert.ok(Math.abs(fit.alignment.rotation - truth.rotation) < 1e-9);
  assert.ok(Math.abs(fit.alignment.tx - truth.tx) < 1e-9);
  assert.ok(Math.abs(fit.alignment.ty - truth.ty) < 1e-9);
});

test('solveSimilarity rejects fewer than two points', () => {
  const fit = solveSimilarity([{ ax: 0, ay: 0, bx: 0, by: 0 }]);
  assert.equal(fit.ok, false);
  assert.match(fit.error, /2/);
});

test('solveSimilarity rejects coincident B points', () => {
  const fit = solveSimilarity([
    { ax: 0, ay: 0, bx: 5, by: 5 },
    { ax: 10, ay: 10, bx: 5, by: 5 },
  ]);
  assert.equal(fit.ok, false);
});

test('least-squares tolerates noisy correspondences', () => {
  const pairs = [
    { ax: 100, ay: 100, bx: 0, by: 0 },
    { ax: 400, ay: 102, bx: 300, by: 0 },
    { ax: 398, ay: 397, bx: 300, by: 300 },
    { ax: 101, ay: 399, bx: 0, by: 300 },
  ];
  const fit = solveSimilarity(pairs);
  assert.equal(fit.ok, true);
  assert.ok(fit.rms < 3);
  assert.ok(Math.abs(fit.alignment.scale - 1) < 0.02);
});

test('scaleAroundPivot keeps the pivot fixed', () => {
  const start = { tx: 40, ty: 10, scale: 1, rotation: 0.3 };
  const pivot = { x: 120, y: 80 };
  const before = mapPoint(start, pivot.x, pivot.y);
  const next = scaleAroundPivot(start, 2.2, pivot);
  const after = mapPoint(next, pivot.x, pivot.y);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.ok(Math.abs(next.scale - 2.2) < 1e-9);
});

test('rotateAroundPivot keeps the pivot fixed', () => {
  const start = { tx: -15, ty: 22, scale: 1.4, rotation: 0 };
  const pivot = { x: 60, y: 40 };
  const before = mapPoint(start, pivot.x, pivot.y);
  const next = rotateAroundPivot(start, 0.8, pivot);
  const after = mapPoint(next, pivot.x, pivot.y);
  assert.ok(Math.abs(before.x - after.x) < 1e-9);
  assert.ok(Math.abs(before.y - after.y) < 1e-9);
  assert.ok(Math.abs(next.rotation - 0.8) < 1e-9);
});

test('defaults are a no-op transform', () => {
  assert.deepEqual(DEFAULT_ALIGNMENT, {
    tx: 0,
    ty: 0,
    scale: 1,
    rotation: 0,
  });
});
