/* 内置示例：跨变速点的长按 + 同轨相邻的单点。
   输入记录里的时刻全部是「原始输入时刻」，判定时再叠加模拟偏差。 */
(function (root) {
  'use strict';

  const chart = {
    version: 1,
    title: '变速长按示例 · 120→80',
    sections: [
      { beat: 0, bpm: 120, sigNum: 4, sigDen: 4 },
      { beat: 8, bpm: 80, sigNum: 4, sigDen: 4 },
    ],
    notes: [
      { id: 't1', lane: 0, type: 'tap', beat: 2 },
      { id: 't2', lane: 1, type: 'tap', beat: 2.5 },
      { id: 'h1', lane: 2, type: 'hold', beat: 6, durBeats: 6 },
      { id: 't3', lane: 0, type: 'tap', beat: 14 },
      { id: 't4', lane: 1, type: 'tap', beat: 14.5 },
      // 同轨相邻单点：80 BPM 下相隔 0.16 拍 = 120 ms，两枚音都落在默认早/晚窗口中。
      { id: 't5', lane: 3, type: 'tap', beat: 10 },
      { id: 't6', lane: 3, type: 'tap', beat: 10.16 },
    ],
  };

  /* 输入偏差（毫秒，相对各音符目标时刻），由目标时刻直接换算成绝对时刻，
     保证示例在任何变速换算实现下都落在预期窗口里。
     单点只录「按下」；长按额外录「松开」。 */
  const offsets = [
    { noteId: 't1', lane: 0, kind: 'press', offsetMs: 0 },
    { noteId: 't2', lane: 1, kind: 'press', offsetMs: 40 },   // 窗口 A 判晚，窗口 B 判成功
    { noteId: 'h1', lane: 2, kind: 'press', offsetMs: -20 },   // 长按头部（变速前）
    // 松开在尾部前 80 ms：窗口 A 的尾宽限 60 ms 内算「提前松开」，
    // 窗口 B 的尾宽限 100 ms 内算「完成」——同一个输入、两种结论。
    { noteId: 'h1', lane: 2, kind: 'release', offsetMs: -80 },
    // 两个相邻单点（同轨，相隔 120 ms）：
    // 第一次按下 +60 ms 时，t5 是「晚 +60」、t6 是「早 −60」，距离相同 →
    // 按规则取目标更早的 t5，所以 t6 不会被同一次输入消费。
    { noteId: 't5', lane: 3, kind: 'press', offsetMs: 60 },
    { noteId: 't6', lane: 3, kind: 'press', offsetMs: 30 },
    { noteId: 't3', lane: 0, kind: 'press', offsetMs: 0 },
    // t4 故意没有任何输入 → 漏拍
  ];

  const Model = (typeof module === 'object' && module.exports)
    ? require('./model.js')
    : root.RTModel;

  function secondsAt(chartObj, noteId, tail) {
    const n = chartObj.notes.find((x) => x.id === noteId);
    if (!n) return 0;
    const beat = n.beat + (tail ? n.durBeats || 0 : 0);
    // 用应用自己的换算实现，保证示例与判定引擎完全一致。
    return Model.secondsAtBeat(chartObj, beat);
  }

  // 目标时刻（120 BPM 段 0.5s/拍，80 BPM 段 0.75s/拍）：
  // t1=1s t2=1.25s h1 头=3s 尾=7s t5=5.5s t6=5.62s t3=8.5s t4=8.875s
  function buildEvents(chartObj) {
    return offsets.map((o, i) => {
      const note = chartObj.notes.find((n) => n.id === o.noteId);
      const isTail = note && note.type === 'hold' && o.kind === 'release';
      const target = secondsAt(chartObj, o.noteId, isTail);
      const t = Math.round((target + o.offsetMs / 1000) * 1e6) / 1e6;
      return {
        id: 'demo-ev' + (i + 1),
        kind: o.kind,
        lane: o.lane,
        t,
        rawT: t,
        noteId: o.noteId,
        source: 'demo',
      };
    }).sort((a, b) => a.t - b.t
      || (a.kind === 'press' ? 0 : 1) - (b.kind === 'press' ? 0 : 1));
  }

  const events = buildEvents(chart);

  const checkpoints = [
    { time: 4.5, label: '变速点后 · 长按按住中' },
    { time: 6.7, label: '长按尾部前 · 待松开' },
  ];

  root.RTDemo = {
    chart: JSON.parse(JSON.stringify(chart)),
    events: JSON.parse(JSON.stringify(events)),
    checkpoints: checkpoints.slice(),
  };
  if (typeof module === 'object' && module.exports) module.exports = root.RTDemo;
})(typeof globalThis !== 'undefined' ? globalThis : this);
