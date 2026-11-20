import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orientationMatrix,
  mapPoint,
  uprightSize,
  describeOrientation
} from '../src/lib/orientation.js';

function apply(m, x, y) {
  return mapPoint(m, x, y);
}

test('orientation 1 keeps coordinates and dimensions', () => {
  const m = orientationMatrix(400, 200, 1);
  assert.deepEqual(apply(m, 0, 0), [0, 0]);
  assert.deepEqual(apply(m, 400, 200), [400, 200]);
  assert.deepEqual(uprightSize(400, 200, 1), { width: 400, height: 200 });
});

test('orientation 3 rotates 180° into the same footprint', () => {
  const m = orientationMatrix(400, 200, 3);
  assert.deepEqual(apply(m, 0, 0), [400, 200]);
  assert.deepEqual(apply(m, 400, 0), [0, 200]);
  assert.deepEqual(uprightSize(400, 200, 3), { width: 400, height: 200 });
});

test('orientation 6 rotates 90° clockwise and swaps dimensions', () => {
  const m = orientationMatrix(400, 200, 6);
  assert.deepEqual(uprightSize(400, 200, 6), { width: 200, height: 400 });
  // source top-left → upright top-right
  assert.deepEqual(apply(m, 0, 0), [200, 0]);
  // source top-right → upright bottom-right
  assert.deepEqual(apply(m, 400, 0), [200, 400]);
  // source bottom-left → upright top-left
  assert.deepEqual(apply(m, 0, 200), [0, 0]);
});

test('orientation 8 rotates 90° counter-clockwise and swaps dimensions', () => {
  const m = orientationMatrix(400, 200, 8);
  assert.deepEqual(uprightSize(400, 200, 8), { width: 200, height: 400 });
  assert.deepEqual(apply(m, 0, 0), [0, 400]);
  assert.deepEqual(apply(m, 400, 200), [200, 0]);
});

test('mirroring orientations stay inside the upright box', () => {
  for (const orientation of [2, 3, 4, 5, 6, 7, 8]) {
    const m = orientationMatrix(400, 200, orientation);
    const size = uprightSize(400, 200, orientation);
    for (const [x, y] of [[0, 0], [400, 0], [0, 200], [400, 200], [123, 45]]) {
      const [ux, uy] = apply(m, x, y);
      assert.ok(ux >= -1e-9 && ux <= size.width + 1e-9, `${orientation}: x ${ux}`);
      assert.ok(uy >= -1e-9 && uy <= size.height + 1e-9, `${orientation}: y ${uy}`);
    }
  }
});

test('all eight orientations are invertible (|det| = 1)', () => {
  for (let orientation = 1; orientation <= 8; orientation += 1) {
    const m = orientationMatrix(640, 480, orientation);
    const det = m[0] * m[3] - m[1] * m[2];
    assert.equal(Math.abs(det), 1, `orientation ${orientation}`);
  }
});

test('orientation labels are human readable', () => {
  assert.equal(describeOrientation(1), '正常（无旋转）');
  assert.match(describeOrientation(6), /顺时针 90°/);
  assert.match(describeOrientation(8), /逆时针 90°/);
});
