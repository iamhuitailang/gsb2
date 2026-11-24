const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../js/dsp.js');

function mean(values) {
  return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
}

test('fixed sample is deterministic', () => {
  const a = D.buildScenario();
  const b = D.buildScenario();
  assert.equal(a.initial.lag, b.initial.lag);
  assert.equal(a.adaptive.events.lockedSample, b.adaptive.events.lockedSample);
  let diff = 0;
  for (let i = 0; i < a.adaptive.output.length; i += 997) {
    diff = Math.max(diff, Math.abs(a.adaptive.output[i] - b.adaptive.output[i]));
  }
  assert.equal(diff, 0);
});

test('initial GCC estimate finds both arrivals', () => {
  const s = D.buildScenario();
  assert.ok(Math.abs(s.initial.ms - 145) < 1.5);
  assert.ok(s.initial.confidence > 0.75);
  assert.ok(s.initial.secondMs != null);
  assert.ok(Math.abs((s.initial.secondMs - s.initial.ms) - 48) < 2);
  assert.ok(s.initial.preDb < -24 && s.initial.preDb > -34);
});

test('initial learning segment cancels echo', () => {
  const s = D.buildScenario();
  const learn = s.segments[0];
  assert.ok(learn.adaptiveErleDb > 20, `ERLE ${learn.adaptiveErleDb}`);
  assert.ok(learn.adaptiveOutRmsDb < -48);
});

test('double talk preserves short near-end syllables', () => {
  const s = D.buildScenario();
  const dt1 = s.segments[1];
  const dt2 = s.segments[3];
  for (const seg of [dt1, dt2]) {
    assert.ok(seg.adaptiveNearGain > 0.85 && seg.adaptiveNearGain < 1.15, `${seg.segment} gain ${seg.adaptiveNearGain}`);
    assert.ok(seg.adaptiveNearCorr > 0.9, `${seg.segment} corr ${seg.adaptiveNearCorr}`);
  }
});

test('continuous canceller tracks delay change; fixed canceller does not', () => {
  const s = D.buildScenario();
  const ev = s.adaptive.events;
  assert.ok(ev.detectedTime - ev.changeTime < 0.45);
  assert.ok(ev.lockedTime - ev.changeTime < 0.9);
  assert.ok(ev.reacquireSeconds < 0.55);

  const after = s.windows.filter((w) => w.time >= 9.0 && w.time <= 10.5);
  assert.ok(mean(after.map((w) => w.adaptiveErleDb)) > 28);
  assert.ok(mean(after.map((w) => w.fixedErleDb)) < 2);

  const dt2 = s.segments[3];
  assert.ok(dt2.adaptiveErleDb > 25);
  assert.ok(dt2.fixedErleDb < 0);
});

test('delay estimator remains accurate at a parameter extreme', () => {
  const s = D.buildScenario({
    delay1Ms: 80,
    delay2Ms: 330,
    reflectionDelayMs: 90,
    reflectionGain: 0.24,
    gain: 0.62
  });
  assert.ok(Math.abs(s.initial.ms - 80) < 2);
  assert.ok(Math.abs((s.initial.secondMs - s.initial.ms) - 90) < 3);
  assert.ok(s.adaptive.events.lockedTime - s.timeline.changeAt < 1.1);
});

test('WAV export has 16-bit PCM header and sample payload', () => {
  const s = D.buildScenario();
  const blob = D.encodeWav(s.adaptive.output, s.sampleRate);
  assert.equal(blob.type, 'audio/wav');
  assert.equal(blob.size, 44 + s.adaptive.output.length * 2);
});
