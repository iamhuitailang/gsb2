const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../model.js');

function preset(id) {
  return V.presets().find((p) => p.id === id);
}

test('simulation is deterministic for identical config and input', () => {
  const p = preset('cross-curve');
  const a = V.simulate(p.config, p.frames, p.config.setupA);
  const b = V.simulate(p.config, p.frames, p.config.setupA);
  assert.deepEqual(a.samples, b.samples);
  assert.deepEqual(a.events, b.events);
});

test('cross-surface curve reports front axle crossing before rear', () => {
  const p = preset('cross-curve');
  const r = V.simulate(p.config, p.frames, p.config.setupA);
  const enters = r.events.filter((e) => e.type === 'surface-crossing' && e.direction === 'enter');
  assert.equal(enters[0].axle, 'F');
  assert.equal(enters[1].axle, 'R');
  assert.ok(enters[0].highToLow);
  assert.ok(enters[1].time > enters[0].time);
  assert.ok(r.summary.firstLoss, 'expected a detected first loss of grip');
});

test('dry full braking detects front axle first in the tuned sample', () => {
  const p = preset('dry-brake');
  const r = V.simulate(p.config, p.frames, p.config.setupA);
  assert.equal(r.summary.firstLoss?.axle, 'F');
  assert.ok(r.summary.endSpeedKmh < 0.2);
});

test('low-speed full-throttle launch loses the driven rear axle first', () => {
  const p = preset('low-launch');
  const r = V.simulate(p.config, p.frames, p.config.setupA);
  assert.equal(r.summary.firstLoss?.axle, 'R');
  assert.ok(r.summary.firstLoss.time < 0.2);
});

test('exported JSON can be recomputed with matching end state and events', () => {
  const p = preset('cross-curve');
  const a = V.simulate(p.config, p.frames, p.config.setupA);
  const b = V.simulate(p.config, p.frames, p.config.setupB);
  const json = JSON.parse(JSON.stringify(V.makeTestCaseExport({ config: p.config }, p.frames, a, b)));
  const verified = V.verifyImported(json);
  assert.equal(verified.checks.length, 2);
  for (const check of verified.checks) {
    assert.equal(check.sampleCountMatch, true);
    assert.ok(check.endPositionError < 0.02);
    assert.ok(check.endSpeedError < 0.03);
    assert.equal(check.eventsMatch, true);
  }
});
