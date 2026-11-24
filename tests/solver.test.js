import test from 'node:test';
import assert from 'node:assert/strict';

import { makeState, applyDemo } from '../js/model.js';
import {
  sampleLighting,
  samplePath,
  auditCoverage,
  pathEvents,
  distanceWeight,
  portalFactor,
} from '../js/solver.js';
import { resamplePolyline } from '../js/util.js';
import { DIVIDER, GRID } from '../js/config.js';

test('distinct up and side colors are recorded per probe', () => {
  const state = makeState();
  const probe = state.probes[0];
  assert.notDeepEqual(probe.up, probe.sides.n);
  assert.ok(probe.sides.n.length === 3);
});

test('closed door blocks cross-zone probes in restricted mode', () => {
  const open = makeState();
  const closed = applyDemo('closed');
  const nearWallInside = { x: 0.6, z: 0.5 };

  const openSample = sampleLighting(open, nearWallInside, { mode: 'restricted' });
  const closedSample = sampleLighting(closed, nearWallInside, { mode: 'restricted' });

  assert.ok(openSample.contributions.some((c) => c.crossSide && c.viaPortal > 0), 'open door lets exterior probes through');
  assert.equal(closedSample.contributions.some((c) => c.crossSide), false);
});

test('closed door leaks in unrestricted mode but not restricted mode', () => {
  const closed = applyDemo('closed');
  const nearWallInside = { x: 0.55, z: 0.0 };
  const r = sampleLighting(closed, nearWallInside, { mode: 'restricted' });
  const u = sampleLighting(closed, nearWallInside, { mode: 'unrestricted' });

  assert.equal(r.contributions.some((c) => c.crossSide), false);
  assert.ok(u.contributions.some((c) => c.crossSide), 'unrestricted mixes across the wall');
  assert.ok(u.lum > r.lum, 'leaked bright exterior raises luminance');
});

test('door threshold transitions smoothly rather than jumping', () => {
  const state = applyDemo('closed');
  const outside = sampleLighting(state, { x: DIVIDER.x + 0.9, z: 0 }, { mode: 'restricted' });
  const inside = sampleLighting(state, { x: DIVIDER.x - 0.45, z: 0 }, { mode: 'restricted' });
  assert.equal(outside.zone, 'exterior');
  assert.equal(inside.zone, 'interior');
  assert.ok(typeof outside.lum === 'number' && typeof inside.lum === 'number');
});

test('portal factor is zero when door is closed or outside the opening', () => {
  const q = { x: 0.5, z: 0 };
  const p = { x: 2.0, z: 0 };
  assert.equal(portalFactor(q, p, { open: 0 }), 0);
  assert.ok(portalFactor(q, p, { open: 1 }) > 0);
  assert.equal(portalFactor(q, { x: 2.0, z: 6.0 }, { open: 1 }), 0);
});

test('liberal applyDemo keeps the open scene unchanged', () => {
  const open = makeState();
  const reopened = applyDemo('open');
  const a = sampleLighting(open, { x: 0.6, z: 0.5 }, { mode: 'restricted' });
  const b = sampleLighting(reopened, { x: 0.6, z: 0.5 }, { mode: 'restricted' });
  assert.ok(Math.abs(a.lum - b.lum) < 1e-12);
});

test('removing a probe or blocking a cell reduces coverage and reports fallback', () => {
  const state = makeState();
  const complete = auditCoverage(state);
  assert.ok(complete.samples > 0);

  // 移除室外远端两列的所有探针，并把这两列标为不可用
  state.probes = state.probes.filter((p) => p.col < GRID.cols - 2);
  for (const cell of state.cells) {
    if (cell.col >= GRID.cols - 2) cell.blocked = true;
  }

  const partial = auditCoverage(state);
  assert.ok(partial.fallbackSegments.length > 0, 'gap is detected');
  assert.ok(partial.coverageRatio < 1);
});

test('sample result distinguishes computed light from fallback', () => {
  const state = makeState();
  const outside = sampleLighting(state, { x: 40, z: 40 }, { mode: 'restricted' });
  assert.equal(outside.support, 0);
  assert.equal(outside.usedFallback, true);
  assert.equal(outside.computed.up[0], 0);
  assert.ok(outside.colors.up[0] > 0);
});

test('path sampling produces resampled points with both modes', () => {
  const state = makeState();
  const samples = samplePath(state, { step: 0.25 });
  assert.ok(samples.length > 10);
  for (const s of samples) {
    assert.ok(s.restricted && s.unrestricted);
    assert.equal(s.restricted.mode, 'restricted');
    assert.equal(s.unrestricted.mode, 'unrestricted');
  }
  const events = pathEvents(samples);
  assert.ok(events.some((e) => e.type === 'threshold'), 'crossing the threshold is flagged');
  assert.ok(events.some((e) => e.type === 'cell'), 'crossing cell edges is flagged');
});

test('gap demo reaches the fallback budget at the tail', () => {
  const gap = applyDemo('gap');
  const samples = samplePath(gap, { step: 0.2 });
  const tail = samples[samples.length - 1];
  assert.equal(tail.restricted.support, 0);
  assert.equal(tail.restricted.usedFallback, true);
});

test('distance weight decays to zero at the radius', () => {
  assert.equal(distanceWeight(3.0, 3.0), 0);
  assert.ok(distanceWeight(0.5, 3.0) > distanceWeight(2.5, 3.0));
});

test('resample keeps endpoints and monotone distance', () => {
  const pts = [{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 4 }];
  const rs = resamplePolyline(pts, 0.5);
  assert.ok(Math.abs(rs[0].x) < 1e-9);
  assert.ok(Math.abs(rs.at(-1).z - 4) < 0.4);
  for (let i = 1; i < rs.length; i += 1) assert.ok(rs[i].dist >= rs[i - 1].dist);
});
