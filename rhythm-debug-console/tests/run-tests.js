#!/usr/bin/env node
/**
 * 引擎自测：node tests/run-tests.js
 * 覆盖：变速换算、窗口边界、防重复计数、长按三态、确定性回放、双窗口分歧。
 */
const R = require('../js/engine.js');

let failed = 0;
const report = R.selftest();
for (const t of report.results) {
  console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}${t.detail ? '  [' + t.detail + ']' : ''}`);
  if (!t.pass) failed++;
}

// 额外的边界用例（内置自测之外）
function check(cond, name, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) failed++;
}

// 1. 跨变速长按的实际秒数换算（100bpm beat6->8, 160bpm beat8->10）
const chart = R.sampleChart();
const segs = R.buildTimeline(chart);
// beat6: 60/100*6 = 3.6s ; beat8: 4.8s ; beat10: 4.8 + 2*60/160 = 5.55s
check(Math.abs(R.beatToTime(segs, 6) - 3.6) < 1e-9, '跨变速长按起点 3.600s');
check(Math.abs(R.beatToTime(segs, 8) - 4.8) < 1e-9, '变速点 4.800s');
check(Math.abs(R.beatToTime(segs, 10) - 5.55) < 1e-9, '跨变速长按终点 5.550s');

// 2. 漏拍死线：两个紧邻音符，错过第一个的输入不该被第二个抢走
const c2 = R.adjacentChart();
const notes = R.prepareNotes(c2, R.buildTimeline(c2));
const w = { perfectMs: 50, lateMs: 100, releaseMs: 100 };
// 只在 a2 附近给输入；a1 应漏拍
const j = R.judge(c2, [
  { time: notes[1].startTime, type: 'down' },
  { time: notes[1].startTime + 0.1, type: 'up' },
], w);
check(j.noteResults[0].status === 'missed', '未被匹配的早音符到期漏拍');
check(j.noteResults[1].status === 'done', '晚音符正常判定');

// 3. 分数与连击公式
const c3 = {
  initialBpm: 120, segments: [],
  notes: [{ id: 'p1', type: 'tap', beat: 1 }, { id: 'p2', type: 'tap', beat: 2 }],
};
const inputs = [
  { time: 0.5, type: 'down' }, { time: 0.57, type: 'up' }, // beat1 = 0.5s perfect
  { time: 1.0, type: 'down' }, { time: 1.07, type: 'up' }, // beat2 = 1.0s perfect, combo 2
];
const r3 = R.judge(c3, inputs, w);
// 第1音 1000 + min(1,50)*10 = 1010；第2音 1000 + 2*10 = 1020；合计 2030
check(r3.summary.score === 2030, '分数=基础分+连击奖励', `score=${r3.summary.score}`);
check(r3.summary.maxCombo === 2, '最大连击 2');

// 4. 提前松开后，后续音符连击从 0 重新累计
const c4 = {
  initialBpm: 120, segments: [],
  notes: [
    { id: 'h', type: 'hold', beat: 1, endBeat: 2 },
    { id: 't', type: 'tap', beat: 3 },
  ],
};
const r4 = R.judge(c4, [
  { time: 0.5, type: 'down' }, { time: 0.7, type: 'up' },  // 提前松（尾部 1s，早 300ms）
  { time: 1.5, type: 'down' }, { time: 1.57, type: 'up' }, // beat3 = 1.5s perfect
], w);
check(r4.noteResults[0].status === 'early', '长按提前松开');
check(r4.noteResults[1].head.judgment === 'perfect' && r4.noteResults[1].head.combo === undefined, '后续音符仍可完美判定');
check(r4.summary.maxCombo === 1, '断连后最大连击重新从 1 计', `maxCombo=${r4.summary.maxCombo}`);

// 4b. 自动完成后晚到的 up 静默释放，不误报无效输入；未抬键又按 down 仍拦截
const hc2 = { initialBpm: 120, segments: [], notes: [{ id: 'h', type: 'hold', beat: 2, endBeat: 4 }] };
const lateUp = R.judge(hc2, [{ time: 1, type: 'down' }, { time: 2.02, type: 'up' }], w);
check(lateUp.noteResults[0].status === 'done', '自动完成后晚到 up 不影响完成判定');
check(lateUp.strays.length === 0, '自动完成后晚到 up 静默释放，不报无效输入', JSON.stringify(lateUp.strays));
const downAfterAuto = R.judge(hc2, [
  { time: 1, type: 'down' }, { time: 2.1, type: 'down' }, { time: 2.2, type: 'up' },
], w);
check(downAfterAuto.strays.some((s) => s.type === 'down'), '自动完成后未抬键又按 down 仍记为无效输入');

// 5. stateAt 快照
const snap = R.stateAt(r3, 0.9);
check(snap.combo === 1 && snap.score === 1010, '检查点快照 combo/分数正确', JSON.stringify(snap));

// 6. 输入排序乱序传入也能得到同样结果
const shuffled = inputs.slice().reverse();
const r6 = R.judge(c3, shuffled, w);
check(JSON.stringify(r6.events) === JSON.stringify(r3.events), '乱序输入内部排序后结果一致');

// 7. 校验器
const bad = R.validateChart({
  initialBpm: 120,
  segments: [{ beat: 4, bpm: -10 }],
  notes: [{ id: 'x', type: 'hold', beat: 2, endBeat: 1 }],
});
check(bad.errors.length >= 2, '校验器拦截负 BPM 与非法长按', bad.errors.join(' / '));

console.log(`\n${failed === 0 ? 'ALL GREEN' : failed + ' FAILED'}`);
process.exit(failed ? 1 : 0);
