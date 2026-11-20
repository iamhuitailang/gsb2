import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, applyEase } from '../dist/core/timeline.js';

const P = (x, y, z) => [x, y, z];

function sample() {
  return {
    fps: 30,
    loop: false,
    baseSpeed: 6,
    keys: [
      { id: 'k1', s: 0, hold: 1, speed: 1, ease: 'linear' },
      { id: 'k2', s: 0.5, hold: 2, speed: 2, ease: 'linear' },
      { id: 'k3', s: 1, hold: 0, speed: 1, ease: 'linear' },
    ],
  };
}

test('holds rest at the key position for exactly the requested time', () => {
  const timeline = new Timeline(sample(), 60, false);
  assert.equal(timeline.evaluate(0).phase, 'hold');
  assert.equal(timeline.evaluate(0.99).phase, 'hold');
  assert.equal(timeline.evaluate(0.99).s, 0);
  assert.equal(timeline.evaluate(1.01).phase, 'travel');
});

test('speeds change travel duration per segment', () => {
  const timeline = new Timeline(sample(), 60, false);
  // Segment 1: 30 world units at 6 u/s = 5s. Segment 2: 30 units at 12 u/s = 2.5s.
  const entries = timeline.entries;
  const seg1 = entries[0].travelEnd - entries[0].travelStart;
  const seg2 = entries[1].travelEnd - entries[1].travelStart;
  assert.ok(Math.abs(seg1 - 5) < 1e-6, `seg1 ${seg1}`);
  assert.ok(Math.abs(seg2 - 2.5) < 1e-6, `seg2 ${seg2}`);
  // Total = 1 + 5 + 2 + 2.5 = 10.5s
  assert.ok(Math.abs(timeline.duration - 10.5) < 1e-6, `duration ${timeline.duration}`);
});

test('evaluation is deterministic for the same time', () => {
  const timeline = new Timeline(sample(), 60, false);
  for (const t of [0, 0.75, 3.2, 6.1, 9.9, 10.5]) {
    const a = timeline.evaluate(t);
    const b = timeline.evaluate(t);
    assert.deepEqual(a, b);
  }
});

test('closed loops wrap s back into [0, 1)', () => {
  const keys = [
    { id: 'a', s: 0.1, hold: 0, speed: 1, ease: 'linear' },
    { id: 'b', s: 0.8, hold: 0, speed: 1, ease: 'linear' },
  ];
  const timeline = new Timeline({ fps: 30, loop: true, baseSpeed: 5, keys }, 50, true);
  for (let t = 0; t <= timeline.duration + 0.5; t += 0.05) {
    const state = timeline.evaluate(t);
    if (!Number.isFinite(state.s)) continue;
    assert.ok(state.s >= 0 && state.s < 1.0000001, `s out of range at t=${t}: ${state.s}`);
  }
});

test('scrubbing backwards then forwards reproduces identical poses', () => {
  const timeline = new Timeline(sample(), 60, false);
  const forward = [];
  for (let i = 0; i <= 40; i++) forward.push(timeline.evaluate((i / 40) * timeline.duration).s);
  const backward = [];
  for (let i = 40; i >= 0; i--) backward.unshift(timeline.evaluate((i / 40) * timeline.duration).s);
  assert.deepEqual(forward, backward);
});

test('easing is monotonic and clamped', () => {
  for (const ease of ['linear', 'easeIn', 'easeOut', 'easeInOut']) {
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = applyEase(ease, i / 20);
      assert.ok(v >= prev - 1e-9, `${ease} not monotonic at ${i}`);
      assert.ok(v >= 0 && v <= 1);
      prev = v;
    }
    assert.equal(applyEase(ease, -5), 0);
    assert.equal(applyEase(ease, 5), 1);
  }
});

test('a zero-length path still evaluates without NaN', () => {
  const timeline = new Timeline(
    { fps: 30, loop: false, baseSpeed: 5, keys: [{ id: 'a', s: 0, hold: 1, speed: 1, ease: 'linear' }] },
    0,
    false,
  );
  const state = timeline.evaluate(0.5);
  assert.ok(state.s === 0);
});
