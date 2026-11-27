import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planNormalization,
  pruneInfluences,
  withInfluenceWeight,
  withLock,
} from '../src/core/weights.js';

test('normalization keeps locked value and reports distributable remainder', () => {
  const influences = [
    { bone: 1, weight: 0.3 },
    { bone: 2, weight: 0.9 },
    { bone: 3, weight: 0.2 },
  ];
  const locks = { 2: 0.4 };
  const plan = planNormalization(influences, locks);
  assert.equal(plan.ok, true);
  assert.ok(Math.abs(plan.lockedTotal - 0.4) < 1e-9);
  assert.ok(Math.abs(plan.distributable - 0.6) < 1e-9);
  const byBone = Object.fromEntries(plan.values.map((v) => [v.bone, v.weight]));
  assert.ok(Math.abs(byBone[2] - 0.4) < 1e-9);
  assert.ok(Math.abs(byBone[1] - 0.36) < 1e-6);
  assert.ok(Math.abs(byBone[3] - 0.24) < 1e-6);
  assert.ok(Math.abs(plan.values.reduce((s, v) => s + v.weight, 0) - 1) < 1e-8);
});

test('locked total over one fails without mutating original vertex data', () => {
  const vertex = {
    id: 7,
    influences: [
      { bone: 1, weight: 0.6 },
      { bone: 2, weight: 0.4 },
    ],
    locks: { 1: 0.8, 2: 0.5 },
  };
  const snapshot = structuredClone(vertex);
  const plan = planNormalization(vertex.influences, vertex.locks);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'LOCKED_TOTAL_EXCEEDS_ONE');
  assert.deepEqual(vertex, snapshot);

  const edited = withLock(withInfluenceWeight(vertex, 1, 0.8), 2, 0.5);
  assert.equal(edited.influences[0].weight, 0.8);
  assert.deepEqual(vertex.influences[0].weight, 0.6, 'helper must not mutate input');
});

test('zero unlocked raw weights split remainder evenly', () => {
  const plan = planNormalization(
    [
      { bone: 1, weight: 0 },
      { bone: 2, weight: 0 },
    ],
    {},
  );
  assert.equal(plan.ok, true);
  assert.ok(Math.abs(plan.values[0].weight - 0.5) < 1e-8);
  assert.ok(Math.abs(plan.values[1].weight - 0.5) < 1e-8);
  assert.equal(plan.evenFallback, true);
});

test('cap two uses explicit tie order and reports discarded redistribution', () => {
  const influences = [
    { bone: 2, weight: 0.5 },
    { bone: 3, weight: 0.25 },
    { bone: 1, weight: 0.25 },
  ];
  const report = pruneInfluences(influences, 2, {
    boneOrder: [0, 1, 2, 3],
    boneCount: 4,
  });
  assert.deepEqual(report.retained.map((r) => r.bone), [2, 1]);
  assert.deepEqual(report.discarded.map((r) => r.bone), [3]);
  assert.ok(Math.abs(report.retained[0].afterWeight - 2 / 3) < 1e-6);
  assert.ok(Math.abs(report.retained[1].afterWeight - 1 / 3) < 1e-6);
  assert.equal(report.discarded[0].afterWeight, 0);
  assert.ok(report.tieGroup.includes(1) && report.tieGroup.includes(3));
});

test('invalid bone indices are ignored by capped valid influence report', () => {
  const report = pruneInfluences(
    [
      { bone: 1, weight: 0.55 },
      { bone: 99, weight: 0.45 },
    ],
    4,
    { boneCount: 4 },
  );
  assert.deepEqual(report.retained.map((r) => r.bone), [1]);
  assert.equal(report.ignored.some((x) => x.bone === 99), true);
  assert.ok(Math.abs(report.retained[0].afterWeight - 1) < 1e-8);
});
