/* 无依赖自检：加载引擎与示例，验证几条关键不变量。
   用法：node tests/smoke.mjs */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../js/model.js');
const J = require('../js/judge.js');
const D = require('../js/demo.js');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('ok   - ' + name);
  } catch (err) {
    failures += 1;
    console.error('FAIL - ' + name);
    console.error(err && err.message ? err.message : err);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' expected ' + JSON.stringify(b)
    + ', got ' + JSON.stringify(a));
}
function near(a, b, eps, msg) {
  if (Math.abs(a - b) > (eps == null ? 1e-9 : eps)) {
    throw new Error((msg || '') + ' expected ≈' + b + ', got ' + a);
  }
}

const chart = M.normalizeChart(D.chart);
const events = D.events;
const wA = J.DEFAULT_WINDOWS.A;
const wB = J.DEFAULT_WINDOWS.B;

check('demo chart is valid', function () {
  eq(M.validateChart(chart).ok, true);
});

check('both demo checkpoints replay identically', function () {
  const full = J.evaluate(chart, events, wA);
  D.checkpoints.forEach(function (cp) {
    const snap = J.snapshotAt(chart, events, wA, cp.time);
    const resumed = J.evaluate(chart, events, wA, { from: snap });
    eq(resumed.score, full.score, 'score @' + cp.time);
    eq(resumed.maxCombo, full.maxCombo, 'maxCombo @' + cp.time);
    eq(resumed.combo, full.combo, 'combo @' + cp.time);
  });
});

check('hold crosses the tempo change', function () {
  const notes = J.buildNotes(chart);
  const h = notes.filter(function (n) { return n.id === 'h1'; })[0];
  near(h.headTime, 3, 1e-9, 'head');
  near(h.tailTime, 7, 1e-9, 'tail');
});

check('A vs B diverges on t2 and h1', function () {
  const cmp = J.compareWindows(chart, events, wA, wB, 0);
  eq(cmp.a.notes.t2.head.tier, 'late');
  eq(cmp.b.notes.t2.head.tier, 'success');
  eq(cmp.a.notes.h1.tail.state, 'earlyRelease');
  eq(cmp.b.notes.h1.tail.state, 'complete');
  if (cmp.divergentNoteIds.indexOf('t2') < 0) throw new Error('t2 not flagged');
  if (cmp.divergentNoteIds.indexOf('h1') < 0) throw new Error('h1 not flagged');
});

check('adjacent taps each consume their own press', function () {
  const r = J.evaluate(chart, events, wA);
  eq(r.notes.t5.head.state, 'hit');
  eq(r.notes.t6.head.state, 'hit');
});

check('bias shifts judgement and reports raw offset', function () {
  // t1 目标 1.000s；+90ms 后 A 窗口（晚 70）超窗，B 窗口（晚 100）判晚。
  const ev = [{ t: 1.0, lane: 0, kind: 'press', id: 'e1' }];
  const cmp = J.compareWindows(chart, ev, wA, wB, 90);
  eq(cmp.a.notes.t1.head.state, 'miss');
  eq(cmp.b.notes.t1.head.state, 'hit');
  const row = cmp.rows.filter(function (x) {
    return x.noteId === 't1' && x.part === 'head';
  })[0];
  if (!row) throw new Error('no divergence row');
  near(row.rawMs, 0, 1e-6, 'raw');
  near(row.effMs, 90, 1e-6, 'eff');
});

if (failures) {
  console.error('\n' + failures + ' 项失败');
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
