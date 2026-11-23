import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../js/model.js');
const J = require('../js/judge.js');
const D = require('../js/demo.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok   - ' + name);
  } catch (err) {
    console.error('FAIL - ' + name);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  }
}

/* 谱面：120 BPM 4/4 两小节，第 4 拍变速到 60 BPM（仍是 4/4）。
   长按从第 3 拍（1.5 s，变速前）跨到第 6 拍（4 s，变速后）——跨越变速点。 */
const demo = M.normalizeChart({
  title: '跨变速长按',
  sections: [
    { beat: 0, bpm: 120, sigNum: 4, sigDen: 4 },
    { beat: 4, bpm: 60, sigNum: 4, sigDen: 4 },
  ],
  notes: [
    { id: 'a', lane: 0, type: 'tap', beat: 1 },
    { id: 'b', lane: 1, type: 'tap', beat: 2 },
    { id: 'h', lane: 2, type: 'hold', beat: 3, durBeats: 3 },
    { id: 'c', lane: 3, type: 'tap', beat: 9 },
  ],
});

test('变速换算：120 BPM 段 0.5s/拍，60 BPM 段 1s/拍', () => {
  assert.equal(M.secondsAtBeat(demo, 0), 0);
  assert.ok(Math.abs(M.secondsAtBeat(demo, 4) - 2) < 1e-9);
  assert.ok(Math.abs(M.secondsAtBeat(demo, 8) - 6) < 1e-9);
  assert.ok(Math.abs(M.beatAtSeconds(demo, 6) - 8) < 1e-9);
});

test('跨变速长按的时长与尾部时间正确', () => {
  const notes = J.buildNotes(demo);
  const h = notes.find((n) => n.id === 'h');
  assert.ok(Math.abs(h.headTime - 1.5) < 1e-9, 'head 1.5s');
  assert.ok(Math.abs(h.tailTime - 4) < 1e-9, 'tail 4s');
  assert.ok(Math.abs(h.durSeconds - 2.5) < 1e-9, '2.5s');
});

test('时间轴小节线跨变速保持正确顺序', () => {
  const lines = M.barLines(demo, M.chartEndBeat(demo));
  for (let i = 1; i < lines.length; i += 1) {
    assert.ok(lines[i].time > lines[i - 1].time, '时间严格递增');
    assert.ok(lines[i].beat > lines[i - 1].beat, '拍号严格递增');
  }
  assert.ok(lines.some((l) => Math.abs(l.beat - 4) < 1e-9 && Math.abs(l.time - 2) < 1e-9));
  const label = M.barBeatLabel(demo, 5);
  assert.equal(label.bar, 2);
  assert.equal(label.beatInBar, 2);
});

test('相邻音符跨变速的顺序正确', () => {
  const v = M.validateChart(demo);
  assert.equal(v.ok, true);
  const crossing = v.pairs.filter((p) => p.crossesSection);
  assert.ok(crossing.length >= 1);
  assert.ok(crossing.every((p) => p.dt > 0));
});

test('窗口边界闭区间且早/晚不对称', () => {
  const w = { perfectMs: 30, earlyMs: 70, lateMs: 100, releaseGraceMs: 60 };
  assert.equal(J.judgeOffset(-30, w), 'success');
  assert.equal(J.judgeOffset(30, w), 'success');
  assert.equal(J.judgeOffset(-30.001, w), 'early');
  assert.equal(J.judgeOffset(-70, w), 'early');
  assert.equal(J.judgeOffset(-70.001, w), null);
  assert.equal(J.judgeOffset(100, w), 'late');
  assert.equal(J.judgeOffset(100.001, w), null);
});

test('点击命中、早/晚、漏拍', () => {
  const hit = J.evaluate(demo, [{ t: 0.5, lane: 0, kind: 'press' }], J.DEFAULT_WINDOWS.A);
  assert.equal(hit.notes.a.head.tier, 'success');
  assert.equal(hit.notes.b.head.state, 'miss');
  assert.equal(hit.notes.c.head.state, 'miss');
});

test('一次输入不会同时消费两个音符', () => {
  const chart = M.normalizeChart({
    sections: [{ beat: 0, bpm: 120 }],
    notes: [
      { id: 'x', lane: 0, beat: 0 },
      { id: 'y', lane: 0, beat: 0.04 }, // 20ms 后
    ],
  });
  const t = M.secondsAtBeat(chart, 0.02);
  const r = J.evaluate(chart, [{ t, lane: 0, kind: 'press' }], J.DEFAULT_WINDOWS.B);
  const hits = [r.notes.x, r.notes.y].filter((n) => n.head && n.head.state === 'hit');
  assert.equal(hits.length, 1);
});

test('最近目标优先：点击落在两音符之间命中更近者', () => {
  const chart = M.normalizeChart({
    sections: [{ beat: 0, bpm: 120 }],
    notes: [
      { id: 'x', lane: 0, beat: 0 },
      { id: 'y', lane: 0, beat: 0.5 }, // 250ms
    ],
  });
  const t = 0.20; // 距 x 200ms（已超晚窗口并判漏拍），距 y 50ms（早）
  const r = J.evaluate(chart, [{ t, lane: 0, kind: 'press' }], J.DEFAULT_WINDOWS.B);
  assert.equal(r.notes.y.head.state, 'hit');
  assert.equal(r.notes.y.head.tier, 'success');
  assert.equal(r.notes.x.head.state, 'miss');
  // 轨迹里应记录另一个候选以及落选原因：x 已被判漏拍，不会被这次按下复活。
  const tr = r.traces.find((x) => x.kind === 'press');
  assert.equal(tr.noteId, 'y');
  assert.ok(tr.candidates.some((c) => c.noteId === 'x' && c.reason === 'missed'));
});

test('长按：完成、提前松开、按住中', () => {
  const w = J.DEFAULT_WINDOWS.A;
  const complete = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 4.0, lane: 2, kind: 'release' },
  ], w);
  assert.equal(complete.notes.h.tail.state, 'complete');
  assert.equal(complete.notes.h.overall, 'success');

  const early = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 2.5, lane: 2, kind: 'release' },
  ], w);
  assert.equal(early.notes.h.tail.state, 'earlyRelease');
  assert.equal(early.notes.h.overall, 'earlyRelease');

  const holding = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
  ], w, { endTime: 2.0 });
  assert.equal(holding.notes.h.overall, 'holding');
});

test('长按尾部宽限边界：恰好宽限算完成，宽限再多 1ms 算提前松开', () => {
  const w = { perfectMs: 30, earlyMs: 70, lateMs: 70, releaseGraceMs: 60 };
  const atGrace = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 4.0 - 0.060, lane: 2, kind: 'release' },
  ], w);
  assert.equal(atGrace.notes.h.tail.state, 'complete');
  const pastGrace = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 4.0 - 0.061, lane: 2, kind: 'release' },
  ], w);
  assert.equal(pastGrace.notes.h.tail.state, 'earlyRelease');
});

test('长按按住时占用轨道，越尾自动完成', () => {
  const r = J.evaluate(demo, [{ t: 1.5, lane: 2, kind: 'press' }], J.DEFAULT_WINDOWS.A);
  assert.equal(r.notes.h.tail.via, 'auto');
  assert.equal(r.notes.h.tail.state, 'complete');
  assert.ok(r.stray.some((s) => s.reason === 'lane-held') === false);
});

test('同轨二次按下在按住期间被判为杂散输入', () => {
  const r = J.evaluate(demo, [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 2.0, lane: 2, kind: 'press' },
  ], J.DEFAULT_WINDOWS.A);
  assert.ok(r.stray.some((s) => s.reason === 'lane-held'));
});

test('重放确定性：检查点恢复与整体重放一致', () => {
  const events = [
    { t: 0.5, lane: 0, kind: 'press' },
    { t: 1.0, lane: 1, kind: 'press' },
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 2.5, lane: 2, kind: 'release' },
    { t: 7.0, lane: 3, kind: 'press' },
  ];
  const w = J.DEFAULT_WINDOWS.B;
  const full = J.evaluate(demo, events, w);
  const fingerprint = (res) => res.noteList.map((n) => [
    n.id, n.overall || 'pending',
    n.head ? n.head.state + ':' + (n.head.tier || '') : '',
    n.tail ? n.tail.state : '',
  ].join('|')).join(',');
  for (const cp of [0, 0.5, 1.0, 1.5, 2.4, 2.5, 3.9, 4.0, 5.0, 7.0]) {
    const snap = J.snapshotAt(demo, events, w, cp);
    const resumed = J.evaluate(demo, events, w, { from: snap });
    assert.equal(resumed.score, full.score, 'score @' + cp);
    assert.equal(resumed.combo, full.combo, 'combo @' + cp);
    assert.equal(resumed.maxCombo, full.maxCombo, 'maxCombo @' + cp);
    assert.equal(fingerprint(resumed), fingerprint(full), 'outcomes @' + cp);
  }
});

test('检查点恰在长按尾部：恢复后不会重复结算', () => {
  const w = J.DEFAULT_WINDOWS.A;
  const events = [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 4.0, lane: 2, kind: 'release' },
  ];
  const full = J.evaluate(demo, events, w);
  const snap = J.snapshotAt(demo, events, w, 4.0);
  const resumed = J.evaluate(demo, events, w, { from: snap });
  assert.equal(resumed.score, full.score);
  assert.equal(resumed.maxCombo, full.maxCombo);
  assert.equal(resumed.notes.h.tail.state, 'complete');
});

test('确定性重放不依赖事件顺序输入', () => {
  const w = J.DEFAULT_WINDOWS.A;
  const events = [
    { t: 1.5, lane: 2, kind: 'press' },
    { t: 0.5, lane: 0, kind: 'press' },
    { t: 4.0, lane: 2, kind: 'release' },
  ];
  const a = J.evaluate(demo, events, w);
  const b = J.evaluate(demo, events.slice().reverse(), w);
  assert.equal(a.score, b.score);
  assert.equal(a.maxCombo, b.maxCombo);
});

test('模拟偏差改变判定，对照组标出分歧与原始偏差', () => {
  const w = J.DEFAULT_WINDOWS.A;
  const events = [{ t: 0.5, lane: 0, kind: 'press', id: 'e1', noteId: 'a' }];
  const cmp0 = J.compareWindows(demo, events, w, J.DEFAULT_WINDOWS.B, 0);
  assert.equal(cmp0.rows.length, 0);
  // 偏差 +90ms：A 窗口（晚 70）超窗漏拍，B 窗口（晚 100）判晚
  const cmp = J.compareWindows(demo, events, w, J.DEFAULT_WINDOWS.B, 90);
  assert.equal(cmp.a.notes.a.head.state, 'miss');
  assert.equal(cmp.b.notes.a.head.tier, 'late');
  const row = cmp.rows.find((r) => r.noteId === 'a' && r.part === 'head');
  assert.ok(row, '应报告分歧音符');
  assert.ok(Math.abs(row.rawMs - 0) < 1e-6, '原始偏差为 0');
  assert.ok(Math.abs(row.effMs - 90) < 1e-6, '有效偏差为 90');
  assert.ok(cmp.divergentNoteIds.indexOf('a') >= 0);
});

test('内置示例：结构完整，跨变速长按 + 同轨相邻单点', () => {
  const chart = M.normalizeChart(D.chart);
  assert.equal(M.validateChart(chart).ok, true);
  const hold = chart.notes.find((n) => n.type === 'hold');
  assert.ok(hold, '应有长按');
  const sections = M.getSections(chart);
  assert.ok(sections.length >= 2, '应有变速');
  const headBeat = hold.beat;
  const tailBeat = hold.beat + hold.durBeats;
  assert.ok(headBeat < sections[1].beat && tailBeat > sections[1].beat, '长按跨越变速点');
  const lane3 = chart.notes.filter((n) => n.lane === 3).sort((a, b) => a.beat - b.beat);
  assert.ok(lane3.length >= 2);
  assert.ok(M.secondsAtBeat(chart, lane3[1].beat) - M.secondsAtBeat(chart, lane3[0].beat) < 0.2,
    '两个单点相邻');
});

test('内置示例：窗口 A/B 判定与分歧符合预期', () => {
  const chart = M.normalizeChart(D.chart);
  const cmp = J.compareWindows(chart, D.events, J.DEFAULT_WINDOWS.A, J.DEFAULT_WINDOWS.B, 0);
  // 头部 t2：A 晚、B 成功；长按尾部：A 提前松开、B 完成
  assert.equal(cmp.a.notes.t2.head.tier, 'late');
  assert.equal(cmp.b.notes.t2.head.tier, 'success');
  assert.equal(cmp.a.notes.h1.tail.state, 'earlyRelease');
  assert.equal(cmp.b.notes.h1.tail.state, 'complete');
  assert.ok(cmp.divergentNoteIds.indexOf('t2') >= 0);
  assert.ok(cmp.divergentNoteIds.indexOf('h1') >= 0);
  // 两个相邻单点各自命中
  assert.equal(cmp.a.notes.t5.head.state, 'hit');
  assert.equal(cmp.a.notes.t6.head.state, 'hit');
  assert.equal(cmp.a.notes.t5.head.noteIdHint, 't5');
  // t4 无输入 → 两边都漏拍
  assert.equal(cmp.a.notes.t4.head.state, 'miss');
  assert.equal(cmp.b.notes.t4.head.state, 'miss');
  // 长按头在变速前、尾在变速后
  const notes = J.buildNotes(chart);
  const h = notes.find((n) => n.id === 'h1');
  assert.ok(Math.abs(h.headTime - 3) < 1e-9);
  assert.ok(Math.abs(h.tailTime - 7) < 1e-9);
  assert.ok(Math.abs(h.durSeconds - 4) < 1e-9);
});

test('内置示例：每个检查点的重放都与整段一致', () => {
  const chart = M.normalizeChart(D.chart);
  const full = J.evaluate(chart, D.events, J.DEFAULT_WINDOWS.A);
  D.checkpoints.forEach((cp) => {
    const snap = J.snapshotAt(chart, D.events, J.DEFAULT_WINDOWS.A, cp.time);
    const resumed = J.evaluate(chart, D.events, J.DEFAULT_WINDOWS.A, { from: snap });
    assert.equal(resumed.score, full.score, 'score @' + cp.time);
    assert.equal(resumed.maxCombo, full.maxCombo, 'maxCombo @' + cp.time);
    assert.equal(resumed.combo, full.combo, 'combo @' + cp.time);
  });
});

test('保存/载入：JSON 往返后判定一致', () => {
  const events = [{ t: 1.0, lane: 0, kind: 'press' }];
  const payload = JSON.stringify({ chart: demo, events, windows: J.DEFAULT_WINDOWS });
  const back = JSON.parse(payload);
  const a = J.evaluate(demo, events, J.DEFAULT_WINDOWS.A);
  const b = J.evaluate(M.normalizeChart(back.chart), back.events, back.windows.A);
  assert.equal(a.score, b.score);
  assert.equal(a.notes.a.head.tier, b.notes.a.head.tier);
});

test('空谱面与非法输入不崩溃', () => {
  const empty = M.emptyChart();
  const r = J.evaluate(empty, [], J.DEFAULT_WINDOWS.A);
  assert.equal(r.score, 0);
  const messy = M.normalizeChart({ sections: [], notes: [{ type: 'hold', beat: -5, lane: 9, durBeats: -2 }] });
  assert.equal(messy.sections.length, 1);
  assert.ok(messy.notes[0].lane <= 3);
  J.evaluate(messy, [{ t: NaN, lane: 0, kind: 'press' }], J.DEFAULT_WINDOWS.A);
});

console.log('\n' + passed + ' 项通过');
