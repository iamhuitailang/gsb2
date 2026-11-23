/* 内置示例曲：8 小节，含中途变速（120 -> 90）与变拍（4/4 -> 3/4），钢琴 + 鼓组双轨 */
const Demo = (() => {
  function build() {
    const p = Model.createProject();
    p.name = '示例：变速变拍短曲';
    p.lengthMeasures = 8;
    p.tempoMap = [
      { tick: 0, bpm: 120 },
      { tick: 7680, bpm: 90 }, // 第 5 小节起
    ];
    p.timeSigs = [
      { tick: 0, num: 4, den: 4 },
      { tick: 7680, num: 3, den: 4 }, // 第 5 小节起
    ];
    p.tracks = [];

    const piano = Model.createTrack('Piano', 'piano');
    const drums = Model.createTrack('Drums', 'drums');
    p.tracks.push(piano, drums);

    const Q = Model.PPQ;          // 480
    const bar4 = 4 * Q;           // 4/4 小节 = 1920
    const bar3 = 3 * Q;           // 3/4 小节 = 1440
    const barStart = m => (m < 4 ? m * bar4 : 4 * bar4 + (m - 4) * bar3);

    // --- 钢琴：前 4 小节分解和弦（Am F C G），后 4 小节 3/4 旋律 ---
    const chords = [
      [57, 60, 64], // Am
      [53, 57, 60], // F
      [48, 52, 55], // C
      [55, 59, 62], // G
    ];
    chords.forEach((chord, m) => {
      const base = barStart(m);
      for (let b = 0; b < 8; b++) {
        Model.newNote(piano, base + b * (Q / 2), chord[b % 3], Q / 2 - 10, 80);
      }
    });
    const melody = [
      // [小节, 拍内偏移(拍), 音高, 时值(拍)]
      [0, 0, 76, 1], [0, 1, 74, 1], [0, 2, 72, 2],
      [1, 0, 74, 1], [1, 1, 76, 1], [1, 2, 77, 2],
      [2, 0, 79, 1.5], [2, 1.5, 77, 0.5], [2, 2, 76, 1], [2, 3, 74, 1],
      [3, 0, 72, 2], [3, 2, 69, 2],
      // 3/4 段落
      [4, 0, 69, 1], [4, 1, 72, 1], [4, 2, 76, 1],
      [5, 0, 74, 2], [5, 2, 71, 1],
      [6, 0, 72, 1], [6, 1, 74, 1], [6, 2, 76, 1],
      [7, 0, 76, 3],
    ];
    for (const [m, off, pitch, len] of melody) {
      Model.newNote(piano, barStart(m) + Math.round(off * Q), pitch, Math.round(len * Q) - 10, 100);
    }

    // --- 鼓组：4/4 段 kick 1/3、snare 2/4、8 分踩镲；3/4 段改为 3 拍 pattern ---
    for (let m = 0; m < 4; m++) {
      const base = barStart(m);
      Model.newNote(drums, base, 36, Q / 4, 110);
      Model.newNote(drums, base + 2 * Q, 36, Q / 4, 100);
      Model.newNote(drums, base + Q, 38, Q / 4, 95);
      Model.newNote(drums, base + 3 * Q, 38, Q / 4, 95);
      for (let b = 0; b < 8; b++) {
        Model.newNote(drums, base + b * (Q / 2), 42, Q / 8, b % 2 ? 55 : 75);
      }
    }
    for (let m = 4; m < 8; m++) {
      const base = barStart(m);
      Model.newNote(drums, base, 36, Q / 4, 105);
      Model.newNote(drums, base + Q, 42, Q / 8, 70);
      Model.newNote(drums, base + 2 * Q, 38, Q / 4, 90);
      for (let b = 0; b < 6; b++) {
        Model.newNote(drums, base + b * (Q / 2), 42, Q / 8, b % 2 ? 50 : 70);
      }
    }
    Model.newNote(drums, barStart(7), 49, Q, 100); // 结尾镲

    return p;
  }

  return { build };
})();
