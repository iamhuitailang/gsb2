import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONFIG,
  comparePlans,
  digestConfig,
  normalizeConfig,
  normalizeEvents,
  schedule,
} from '../src/scheduler.js';
import { SAMPLES, getSample } from '../src/examples.js';
import { decisionsCsv, playbacksCsv, readmeText, configJson } from '../src/exporter.js';
import { zipStore, crc32 } from '../src/zip.js';

const cfg = (patch = {}) => normalizeConfig({ ...DEFAULT_CONFIG, ...patch });
const cat = (id, patch = {}) => {
  const base = DEFAULT_CONFIG.categories.find((c) => c.id === id);
  return { ...base, ...patch };
};

function withCategories(list, patch = {}) {
  return normalizeConfig({ ...DEFAULT_CONFIG, ...patch, categories: list });
}

/* ---------------------------------------------------------------- */
/* determinism & stability                                          */
/* ---------------------------------------------------------------- */

test('same inputs produce identical plans and digests', () => {
  const events = getSample('dense').events;
  const a = schedule(DEFAULT_CONFIG, events);
  const b = schedule(DEFAULT_CONFIG, events);
  assert.equal(a.outcomeDigest, b.outcomeDigest);
  assert.deepEqual(
    a.decisions.map((d) => [d.eventId, d.status, d.startMs, d.channel]),
    b.decisions.map((d) => [d.eventId, d.status, d.startMs, d.channel])
  );
});

test('event-sheet order is irrelevant when times differ', () => {
  const events = [
    { id: 'x', categoryId: 'coin', timeMs: 100 },
    { id: 'y', categoryId: 'sword', timeMs: 20 },
    { id: 'z', categoryId: 'ui', timeMs: 60 },
  ];
  const forward = schedule(cfg({ maxVoices: 1 }), events);
  const backward = schedule(cfg({ maxVoices: 1 }), [...events].reverse());
  assert.equal(forward.outcomeDigest, backward.outcomeDigest);
});

test('equal priority keeps sheet order at the same instant', () => {
  const categories = [
    cat('footstep', { priority: 2, durationMs: 300, cooldownMs: 0, cap: 1 }),
    cat('ui', { priority: 2, durationMs: 300, cooldownMs: 0, cap: 1 }),
  ];
  const config = withCategories(categories, { maxVoices: 1, maxDelayMs: 0, policy: 'drop' });
  const plan = schedule(config, [
    { id: 'a', categoryId: 'footstep', timeMs: 0 },
    { id: 'b', categoryId: 'ui', timeMs: 0 },
  ]);
  const a = plan.decisions.find((d) => d.eventId === 'a');
  const b = plan.decisions.find((d) => d.eventId === 'b');
  assert.equal(a.status, 'kept');
  assert.equal(b.status, 'dropped');
});

test('higher priority wins the same instant but the sheet order still breaks ties', () => {
  const categories = [
    cat('footstep', { priority: 1, durationMs: 300, cooldownMs: 0, cap: 1 }),
    cat('sword', { priority: 5, durationMs: 300, cooldownMs: 0, cap: 1 }),
  ];
  const config = withCategories(categories, { maxVoices: 1, maxDelayMs: 0, policy: 'drop' });
  const plan = schedule(config, [
    { id: 'low', categoryId: 'footstep', timeMs: 50 },
    { id: 'high', categoryId: 'sword', timeMs: 50 },
  ]);
  assert.equal(plan.decisions.find((d) => d.eventId === 'high').status, 'kept');
  assert.equal(plan.decisions.find((d) => d.eventId === 'low').status, 'dropped');
});

/* ---------------------------------------------------------------- */
/* channels, caps, cooldown                                         */
/* ---------------------------------------------------------------- */

test('channel limit is never exceeded by the audible segments', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const max = plan.config.maxVoices;
  for (const p of plan.playbacks) {
    const overlapping = plan.playbacks.filter(
      (q) => q.channel === p.channel && q.start < p.end - 0.25 && p.start < q.end - 0.25
    );
    assert.equal(overlapping.length, 1, `channel ${p.channel} double-booked at ${p.start}`);
  }
  assert.ok(plan.summary.peakVoices <= max);
});

test('category concurrency cap is respected', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  for (const catCfg of plan.config.categories) {
    const same = plan.playbacks.filter((p) => p.categoryId === catCfg.id);
    for (const p of same) {
      const at = p.start;
      const count = same.filter((q) => q.start <= at + 0.25 && at < q.end - 0.25).length;
      assert.ok(count <= catCfg.cap, `${catCfg.id} concurrency ${count} > cap ${catCfg.cap}`);
    }
  }
});

test('cooldown is enforced between starts of the same category', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const byCat = new Map();
  for (const p of [...plan.playbacks].sort((a, b) => a.start - b.start)) {
    const prev = byCat.get(p.categoryId);
    const cooldown = plan.config.categories.find((c) => c.id === p.categoryId).cooldownMs;
    if (prev != null) assert.ok(p.start - prev >= cooldown - 0.25);
    byCat.set(p.categoryId, p.start);
  }
});

test('plan never plays a dropped or muted event', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const played = new Set(plan.playbacks.map((p) => p.eventId));
  for (const d of plan.decisions) {
    if (d.status === 'dropped' || d.status === 'muted') {
      assert.ok(!played.has(d.eventId), `${d.eventId} is ${d.status} but has a playback`);
    } else {
      assert.ok(played.has(d.eventId), `${d.eventId} is ${d.status} but has no playback`);
    }
  }
});

test('delays never exceed the max delay', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  for (const d of plan.decisions) {
    assert.ok(d.delayMs <= plan.config.maxDelayMs + 0.25, `${d.eventId} delay ${d.delayMs}`);
  }
});

/* ---------------------------------------------------------------- */
/* preemption                                                       */
/* ---------------------------------------------------------------- */

test('preemption only targets strictly lower priority playing sounds', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const decision = new Map(plan.decisions.map((d) => [d.eventId, d]));
  for (const d of plan.decisions) {
    if (d.status !== 'preempted') continue;
    assert.ok(d.preemptedBy, 'preempted decision names its usurper');
    const attacker = decision.get(d.preemptedBy);
    assert.ok(attacker, 'attacker decision exists');
    assert.ok(attacker.priority > d.priority, 'attacker outranks victim');
    assert.ok(d.endMs <= d.preemptedAtMs + 0.25);
  }
});

test('a cut sound frees its channel at the cut instant', () => {
  const config = cfg({
    maxVoices: 1,
    maxDelayMs: 0,
    policy: 'steal',
    categories: [cat('footstep', { durationMs: 500 }), cat('sword', { durationMs: 120 })],
  });
  const plan = schedule(config, [
    { id: 'step', categoryId: 'footstep', timeMs: 0 },
    { id: 'slash', categoryId: 'sword', timeMs: 100 },
  ]);
  const step = plan.decisions.find((d) => d.eventId === 'step');
  const slash = plan.decisions.find((d) => d.eventId === 'slash');
  assert.equal(slash.status, 'kept');
  assert.equal(slash.channel, 1);
  assert.equal(step.status, 'preempted');
  assert.equal(step.endMs, 100);
  assert.deepEqual(slash.victims, ['step']);
});

test('steal policy leaves equal-priority sounds alone', () => {
  const config = cfg({
    maxVoices: 1,
    maxDelayMs: 0,
    policy: 'steal',
    categories: [
      cat('footstep', { durationMs: 500, priority: 2 }),
      cat('hit', { durationMs: 100, priority: 2 }),
    ],
  });
  const plan = schedule(config, [
    { id: 'step', categoryId: 'footstep', timeMs: 0 },
    { id: 'hit', categoryId: 'hit', timeMs: 100 },
  ]);
  assert.equal(plan.decisions.find((d) => d.eventId === 'step').status, 'kept');
  assert.equal(plan.decisions.find((d) => d.eventId === 'hit').status, 'dropped');
});

test('queue policy never cuts; it waits or drops', () => {
  const config = cfg({
    maxVoices: 1,
    maxDelayMs: 600,
    policy: 'queue',
    categories: [cat('footstep', { durationMs: 300 }), cat('sword', { durationMs: 100 })],
  });
  const plan = schedule(config, [
    { id: 'step', categoryId: 'footstep', timeMs: 0 },
    { id: 'slash', categoryId: 'sword', timeMs: 100 },
  ]);
  assert.equal(plan.decisions.find((d) => d.eventId === 'step').status, 'kept');
  const slash = plan.decisions.find((d) => d.eventId === 'slash');
  assert.equal(slash.status, 'delayed');
  assert.equal(slash.startMs, 300);
});

test('drop policy neither waits nor steals', () => {
  const config = cfg({
    maxVoices: 1,
    maxDelayMs: 1000,
    policy: 'drop',
    categories: [cat('footstep', { durationMs: 300 }), cat('sword', { durationMs: 100 })],
  });
  const plan = schedule(config, [
    { id: 'step', categoryId: 'footstep', timeMs: 0 },
    { id: 'slash', categoryId: 'sword', timeMs: 100 },
  ]);
  const slash = plan.decisions.find((d) => d.eventId === 'slash');
  assert.equal(slash.status, 'dropped');
  assert.equal(slash.reasonCode, 'drop-policy');
});

test('a cooldown-shifted event does not steal', () => {
  const config = cfg({
    maxVoices: 2,
    maxDelayMs: 500,
    policy: 'steal',
    categories: [
      cat('coin', { durationMs: 400, cooldownMs: 300, priority: 2, cap: 1 }),
      cat('sword', { durationMs: 400, priority: 5 }),
    ],
  });
  const plan = schedule(config, [
    { id: 'coin1', categoryId: 'coin', timeMs: 0 },
    { id: 'sword1', categoryId: 'sword', timeMs: 150 },
    { id: 'coin2', categoryId: 'coin', timeMs: 120 }, // cooldown to 300
  ]);
  const coin2 = plan.decisions.find((d) => d.eventId === 'coin2');
  assert.equal(coin2.victims.length, 0, 'cooldown shift must not cut sword1');
});

/* ---------------------------------------------------------------- */
/* muting & comparison                                              */
/* ---------------------------------------------------------------- */

test('muting removes that category from playback and leaves others auditable', () => {
  const config = normalizeConfig({
    ...DEFAULT_CONFIG,
    categories: DEFAULT_CONFIG.categories.map((c) => (c.id === 'coin' ? { ...c, muted: true } : c)),
  });
  const events = getSample('dense').events;
  const plan = schedule(config, events);
  assert.ok(!plan.playbacks.some((p) => p.categoryId === 'coin'));
  for (const d of plan.decisions.filter((x) => x.categoryId === 'coin')) {
    assert.equal(d.status, 'muted');
  }
});

test('comparison reports every event whose status or timing moved', () => {
  const events = getSample('dense').events;
  const baseline = schedule(DEFAULT_CONFIG, events);
  const muted = normalizeConfig({
    ...DEFAULT_CONFIG,
    categories: DEFAULT_CONFIG.categories.map((c) =>
      c.id === 'footstep' ? { ...c, muted: true } : c
    ),
  });
  const current = schedule(muted, events);
  const cmp = comparePlans(baseline, current);
  assert.deepEqual(cmp.mutedCategoryIds, ['footstep']);
  assert.ok(cmp.affected.length > 0);
  for (const a of cmp.affected) {
    const before = baseline.decisions.find((d) => d.eventId === a.eventId);
    const after = current.decisions.find((d) => d.eventId === a.eventId);
    const moved =
      before.status !== after.status ||
      (before.startMs ?? -1) !== (after.startMs ?? -1) ||
      (before.endMs ?? -1) !== (after.endMs ?? -1);
    assert.ok(moved, `${a.eventId} listed but unchanged`);
  }
  // Footstep events themselves must be in the affected list.
  const footstepIds = events.filter((e) => e.categoryId === 'footstep').map((e) => e.id);
  for (const id of footstepIds) {
    assert.ok(cmp.affected.some((a) => a.eventId === id), `${id} missing from comparison`);
  }
});

/* ---------------------------------------------------------------- */
/* samples                                                          */
/* ---------------------------------------------------------------- */

test('dense sample exercises every outcome', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const s = plan.summary;
  assert.ok(s.kept >= 1, 'dense keeps some sounds');
  assert.ok(s.delayed >= 1, 'dense delays some sounds');
  assert.ok(s.preempted >= 1, 'dense cuts some sounds');
  assert.ok(s.dropped >= 1, 'dense drops some sounds');
});

test('roomy sample plays every event under default settings', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('roomy').events);
  assert.equal(plan.summary.dropped, 0);
  assert.equal(plan.summary.delayed, 0);
  assert.equal(plan.summary.preempted, 0);
  assert.equal(plan.summary.kept, plan.summary.total);
});

test('both samples are registered with generated-sound categories', () => {
  assert.equal(SAMPLES.length, 2);
  for (const s of SAMPLES) {
    assert.ok(s.events.length > 5);
    for (const e of s.events) {
      assert.ok(DEFAULT_CONFIG.categories.some((c) => c.id === e.categoryId));
    }
  }
});

/* ---------------------------------------------------------------- */
/* config normalization                                             */
/* ---------------------------------------------------------------- */

test('normalizeConfig clamps bad values and keeps slots unique', () => {
  const config = normalizeConfig({
    maxVoices: 99,
    maxDelayMs: -10,
    policy: 'nonsense',
    categories: [
      { id: 'a', colorSlot: 0, durationMs: 9999, priority: 0, cap: 99 },
      { id: 'b', colorSlot: 0, durationMs: -5 },
    ],
  });
  assert.equal(config.maxVoices, 8);
  assert.equal(config.maxDelayMs, 0);
  assert.equal(config.policy, 'steal');
  assert.equal(config.categories[0].durationMs, 1200);
  assert.equal(config.categories[0].priority, 1);
  assert.equal(config.categories[0].cap, 4);
  assert.notEqual(config.categories[0].colorSlot, config.categories[1].colorSlot);
});

test('normalizeEvents repairs duplicate ids and clamps time', () => {
  const events = normalizeEvents([
    { id: 'dup', categoryId: 'coin', timeMs: -5 },
    { id: 'dup', categoryId: 'coin', timeMs: 999999 },
  ]);
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
  assert.equal(events[0].timeMs, 0);
  assert.equal(events[1].timeMs, 120000);
});

test('config digest ignores display-only fields but tracks audio fields', () => {
  const a = normalizeConfig(DEFAULT_CONFIG);
  const renamed = normalizeConfig({
    ...DEFAULT_CONFIG,
    categories: DEFAULT_CONFIG.categories.map((c, i) => (i === 0 ? { ...c, name: '改名' } : c)),
  });
  assert.equal(digestConfig(a), digestConfig(renamed));
  const louder = normalizeConfig({
    ...DEFAULT_CONFIG,
    categories: DEFAULT_CONFIG.categories.map((c, i) => (i === 0 ? { ...c, gain: 0.9 } : c)),
  });
  assert.notEqual(digestConfig(a), digestConfig(louder));
});

/* ---------------------------------------------------------------- */
/* exports                                                          */
/* ---------------------------------------------------------------- */

test('decisions CSV has one row per decision and mirrors the plan', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const csv = decisionsCsv(plan, comparePlans(plan, plan));
  const rows = csv.trim().split('\r\n');
  assert.equal(rows.length, plan.decisions.length + 1);
  const header = rows[0].split(',');
  assert.deepEqual(header.slice(0, 4), ['event_id', 'sheet_order', 'category_id', 'category_name']);
  const first = plan.decisions[0];
  assert.ok(rows[1].startsWith(`${first.eventId},`));
});

test('playback CSV rows carry channel and audible window', () => {
  const plan = schedule(DEFAULT_CONFIG, getSample('dense').events);
  const rows = playbacksCsv(plan).trim().split('\r\n');
  assert.equal(rows.length, plan.playbacks.length + 1);
  for (const p of plan.playbacks) {
    const row = rows.find((r) => r.split(',')[1] === p.eventId);
    assert.ok(row, `row for ${p.eventId}`);
    const cells = row.split(',');
    assert.equal(Number(cells[0]), p.channel);
    assert.equal(Number(cells[6]), p.start);
    assert.equal(Number(cells[7]), p.end);
  }
});

test('session json is reloadable and keeps the outcome digest', () => {
  const events = getSample('dense').events;
  const plan = schedule(DEFAULT_CONFIG, events);
  const json = configJson(plan, normalizeEvents(events));
  assert.equal(json.outcomeDigest, plan.outcomeDigest);
  const replayed = schedule(json.settings, json.events);
  assert.equal(replayed.outcomeDigest, plan.outcomeDigest);
});

test('zip writer produces a valid archive with CRCs', () => {
  const bytes = zipStore([
    { name: 'a.txt', data: 'hello' },
    { name: 'nested/b.json', data: JSON.stringify({ ok: true }) },
  ]);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  // End-of-central-directory signature near the tail.
  const tail = bytes.slice(bytes.length - 22);
  assert.deepEqual([...tail.slice(0, 4)], [0x50, 0x4b, 0x05, 0x06]);
  const count = tail[8] | (tail[9] << 8);
  assert.equal(count, 2);
  assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
});

test('readme states rules and counts that match the plan', () => {
  const events = getSample('dense').events;
  const plan = schedule(DEFAULT_CONFIG, events);
  const text = readmeText(plan, normalizeEvents(events), comparePlans(plan, plan));
  assert.ok(text.includes(plan.outcomeDigest));
  assert.ok(text.includes(`保留:     ${plan.summary.kept}`));
  assert.ok(text.includes('抢占优先'));
});

/* ---------------------------------------------------------------- */
/* edge cases                                                       */
/* ---------------------------------------------------------------- */

test('unknown category is recorded as invalid, not silently played', () => {
  const plan = schedule(DEFAULT_CONFIG, [{ id: 'ghost', categoryId: 'nope', timeMs: 0 }]);
  const d = plan.decisions[0];
  assert.equal(d.status, 'dropped');
  assert.equal(d.reasonCode, 'drop-unknown');
  assert.equal(plan.playbacks.length, 0);
});

test('empty sheet yields an empty, valid plan', () => {
  const plan = schedule(DEFAULT_CONFIG, []);
  assert.equal(plan.summary.total, 0);
  assert.equal(plan.decisions.length, 0);
  assert.equal(plan.playbacks.length, 0);
  assert.ok(plan.totalMs > 0);
});

test('zero max delay turns any conflict into a drop', () => {
  const config = cfg({ maxVoices: 1, maxDelayMs: 0, policy: 'queue' });
  const plan = schedule(config, [
    { id: 'a', categoryId: 'footstep', timeMs: 0 },
    { id: 'b', categoryId: 'sword', timeMs: 10 },
  ]);
  assert.equal(plan.decisions.find((d) => d.eventId === 'b').status, 'dropped');
});

test('a preempted sound still counts as sounded but not full-length', () => {
  const config = cfg({
    maxVoices: 1,
    maxDelayMs: 0,
    policy: 'steal',
    categories: [cat('footstep', { durationMs: 400 }), cat('sword', { durationMs: 100 })],
  });
  const plan = schedule(config, [
    { id: 'step', categoryId: 'footstep', timeMs: 0 },
    { id: 'slash', categoryId: 'sword', timeMs: 50 },
  ]);
  assert.equal(plan.summary.preempted, 1);
  assert.equal(plan.summary.sounded, 2);
  assert.equal(plan.summary.fullLength, 1);
});
