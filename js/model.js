/* 谱面模型：拍号/变速 → 真实秒数，以及小节线与顺序校验。
   浏览器下挂到 window.RTModel；Node 下可 require，供测试使用。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RTModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EPS = 1e-7;
  const DEFAULT_SECTION = { beat: 0, bpm: 120, sigNum: 4, sigDen: 4 };

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

  /* ---------- 谱面规整 ---------- */

  function normalizeChart(input) {
    const src = input || {};
    const out = {
      version: 1,
      title: typeof src.title === 'string' && src.title.trim()
        ? src.title.trim().slice(0, 120) : '未命名谱面',
      sections: [],
      notes: [],
    };

    const rawSections = Array.isArray(src.sections) ? src.sections : [];
    rawSections.forEach((s) => {
      const sigNum = Math.round(num(s.sigNum, 4));
      const sigDen = Math.round(num(s.sigDen, 4));
      out.sections.push({
        beat: Math.max(0, num(s.beat, 0)),
        bpm: Math.max(1, num(s.bpm, 120)),
        sigNum: sigNum >= 1 && sigNum <= 16 ? sigNum : 4,
        sigDen: sigDen >= 1 && sigDen <= 16 ? sigDen : 4,
      });
    });
    if (!out.sections.length) out.sections.push(Object.assign({}, DEFAULT_SECTION));

    out.sections.sort((a, b) => a.beat - b.beat);
    // 第一段始终从 0 拍开始；同拍号位置的后续段只保留最后一个。
    out.sections[0].beat = 0;
    const dedup = [];
    for (const s of out.sections) {
      if (dedup.length && Math.abs(s.beat - dedup[dedup.length - 1].beat) < 1e-4) {
        dedup[dedup.length - 1] = s;
      } else {
        dedup.push(s);
      }
    }
    out.sections = dedup;

    const usedIds = new Set();
    let autoId = 0;
    const rawNotes = Array.isArray(src.notes) ? src.notes : [];
    for (const n of rawNotes) {
      const type = n && n.type === 'hold' ? 'hold' : 'tap';
      // id 会进入 HTML 属性与对象键：只允许安全字符，其余一律重新生成。
      let id = n && typeof n.id === 'string' ? n.id.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) id = '';
      while (!id || usedIds.has(id)) {
        autoId += 1;
        id = 'n' + autoId;
      }
      usedIds.add(id);
      const lane = Math.round(num(n && n.lane, 0));
      out.notes.push({
        id,
        lane: lane >= 0 && lane <= 3 ? lane : 0,
        type,
        beat: Math.max(0, num(n && n.beat, 0)),
        durBeats: type === 'hold' ? Math.max(0.0625, num(n && n.durBeats, 1)) : 0,
      });
    }
    out.notes.sort((a, b) => a.beat - b.beat || a.lane - b.lane || a.id.localeCompare(b.id));
    return out;
  }

  function emptyChart() {
    return normalizeChart({
      title: '新谱面',
      sections: [{ beat: 0, bpm: 120, sigNum: 4, sigDen: 4 }],
      notes: [],
    });
  }

  /* ---------- 变速换算 ---------- */

  function getSections(chart) {
    const src = chart && Array.isArray(chart.sections) && chart.sections.length
      ? chart.sections
      : [DEFAULT_SECTION];
    const sections = src
      .map((s) => ({
        beat: Math.max(0, num(s.beat, 0)),
        bpm: Math.max(1, num(s.bpm, 120)),
        sigNum: Math.max(1, Math.round(num(s.sigNum, 4))),
        sigDen: Math.max(1, Math.round(num(s.sigDen, 4))),
      }))
      .sort((a, b) => a.beat - b.beat);
    sections[0].beat = 0;
    return sections;
  }

  function sectionTimes(sections) {
    const times = [];
    let t = 0;
    for (let i = 0; i < sections.length; i += 1) {
      if (i > 0) {
        const prev = sections[i - 1];
        t += (sections[i].beat - prev.beat) * (60 / prev.bpm);
      }
      times.push(t);
    }
    return times;
  }

  function sectionIndexAt(sections, beat) {
    let idx = 0;
    for (let i = 0; i < sections.length; i += 1) {
      if (beat + EPS >= sections[i].beat) idx = i;
      else break;
    }
    return idx;
  }

  function barLength(section) {
    return section.sigNum * (4 / section.sigDen);
  }

  /** 拍号位置（以四分音符为 1 拍）→ 秒 */
  function secondsAtBeat(chart, beat) {
    const sections = getSections(chart);
    const starts = sectionTimes(sections);
    const b = num(beat, 0);
    const idx = sectionIndexAt(sections, b);
    const s = sections[idx];
    return starts[idx] + (b - s.beat) * (60 / s.bpm);
  }

  /** 秒 → 拍号位置（在当前变速段内反解） */
  function beatAtSeconds(chart, seconds) {
    const sections = getSections(chart);
    const starts = sectionTimes(sections);
    const sec = num(seconds, 0);
    let idx = 0;
    for (let i = 0; i < sections.length; i += 1) {
      if (sec + EPS >= starts[i]) idx = i;
      else break;
    }
    const s = sections[idx];
    return s.beat + (sec - starts[idx]) * (s.bpm / 60);
  }

  /** 每小节的起点（含跨变速后的小节编号） */
  function barLines(chart, maxBeat) {
    const sections = getSections(chart);
    const limit = num(maxBeat, chartEndBeat(chart));
    const lines = [];
    let barNo = 1;
    for (let i = 0; i < sections.length && lines.length < 4000; i += 1) {
      const s = sections[i];
      const len = barLength(s);
      const nextBeat = i + 1 < sections.length ? sections[i + 1].beat : limit;
      // 用 k * len 而不是累加，避免长谱面上的浮点漂移。
      const count = Math.max(0, Math.ceil((nextBeat - s.beat) / len - 1e-9));
      for (let k = 0; k < count && lines.length < 4000; k += 1) {
        const b = s.beat + k * len;
        if (b >= nextBeat - EPS) break;
        lines.push({
          beat: b,
          time: secondsAtBeat(chart, b),
          bar: barNo,
          sectionIndex: i,
          section: s,
          isSectionStart: k === 0,
        });
        barNo += 1;
      }
    }
    return lines;
  }

  /** 小节编号：第 N 小节、第 X 拍（1 起） */
  function barBeatLabel(chart, beat) {
    const sections = getSections(chart);
    const b = num(beat, 0);
    const idx = sectionIndexAt(sections, b);
    const s = sections[idx];
    const len = barLength(s);
    let barNo = 1;
    for (let j = 0; j < idx; j += 1) {
      const sj = sections[j];
      const nb = sections[j + 1].beat;
      barNo += Math.max(0, Math.ceil((nb - sj.beat) / barLength(sj) - 1e-9));
    }
    const k = Math.max(0, Math.floor((b - s.beat) / len + 1e-9));
    barNo += k;
    const barStart = s.beat + k * len;
    const beatInBar = b - barStart + 1;
    return {
      bar: barNo,
      beatInBar,
      sectionIndex: idx,
      section: s,
      label: '第 ' + barNo + ' 小节 · 第 ' + fmtBeat(beatInBar) + ' 拍',
    };
  }

  function fmtBeat(v) {
    const n = Math.round(v * 100) / 100;
    return Number.isInteger(n) ? String(n) : String(n).replace(/0+$/, '').replace(/\.$/, '');
  }

  /** 节拍刻度：用于时间轴细分线与节拍音 */
  function beatTicks(chart, maxBeat) {
    const sections = getSections(chart);
    const limit = num(maxBeat, chartEndBeat(chart));
    const ticks = [];
    for (let i = 0; i < sections.length && ticks.length < 8000; i += 1) {
      const s = sections[i];
      const step = 4 / s.sigDen;
      const len = barLength(s);
      const nextBeat = i + 1 < sections.length ? sections[i + 1].beat : limit;
      const count = Math.max(0, Math.ceil((nextBeat - s.beat) / step - 1e-9));
      for (let k = 0; k < count && ticks.length < 8000; k += 1) {
        const b = s.beat + k * step;
        if (b >= nextBeat - EPS) break;
        const inBar = ((k * step) % len + len) % len;
        const isDown = inBar < EPS || Math.abs(inBar - len) < EPS;
        ticks.push({
          beat: b,
          time: secondsAtBeat(chart, b),
          sectionIndex: i,
          accent: isDown,
          downbeat: isDown,
        });
      }
    }
    return ticks;
  }

  function chartEndBeat(chart) {
    const sections = getSections(chart);
    const last = sections[sections.length - 1];
    let end = Math.max(8, last.beat + barLength(last));
    for (const n of (chart && chart.notes) || []) {
      const tail = num(n.beat, 0) + (n.type === 'hold' ? num(n.durBeats, 0) : 0);
      end = Math.max(end, tail + 2);
    }
    return Math.ceil(end * 4) / 4;
  }

  function chartEndSeconds(chart) {
    return secondsAtBeat(chart, chartEndBeat(chart));
  }

  /* ---------- 顺序与合法性 ---------- */

  /** 相邻音符在时间轴上的顺序校验（跨变速的相邻对被标出） */
  function orderPairs(chart) {
    const notes = (chart && chart.notes ? chart.notes : []).slice()
      .sort((a, b) => a.beat - b.beat || a.lane - b.lane || a.id.localeCompare(b.id));
    const sections = getSections(chart);
    const pairs = [];
    for (let i = 1; i < notes.length; i += 1) {
      const a = notes[i - 1];
      const b = notes[i];
      const ta = secondsAtBeat(chart, a.beat);
      const tb = secondsAtBeat(chart, b.beat);
      const sa = sectionIndexAt(sections, a.beat);
      const sb = sectionIndexAt(sections, b.beat);
      pairs.push({
        a,
        b,
        ta,
        tb,
        dt: tb - ta,
        crossesSection: sa !== sb,
        ok: tb >= ta - EPS,
      });
    }
    return pairs;
  }

  function validateChart(chart) {
    const issues = [];
    const sections = getSections(chart);
    const notes = (chart && chart.notes) || [];
    const add = (level, message) => issues.push({ level, message });

    if (!sections.length) add('error', '至少需要一个变速段');
    sections.forEach((s, i) => {
      if (!(s.bpm > 0)) add('error', '第 ' + (i + 1) + ' 段的 BPM 必须大于 0');
      if (i > 0) {
        const prev = sections[i - 1];
        const len = barLength(prev);
        const offset = (s.beat - prev.beat) / len;
        if (Math.abs(offset - Math.round(offset)) > 1e-4) {
          add('warn', '变速点 ' + fmtBeat(s.beat) + ' 拍不在前一段的小节线上（第 ' +
            fmtBeat(Math.floor(offset) + 1) + ' 小节第 ' + fmtBeat((offset % 1) * len + 1) + ' 拍）');
        }
      }
    });

    const laneHolds = new Map();
    notes.forEach((n) => {
      if (n.beat < -EPS) add('error', '音符 ' + n.id + ' 的拍号小于 0');
      if (!(n.lane >= 0 && n.lane <= 3)) add('error', '音符 ' + n.id + ' 的轨道超出 0–3');
      if (n.type === 'hold' && !(n.durBeats > 0)) add('error', '长按 ' + n.id + ' 的时长为 0');
      if (n.type === 'hold') {
        const tail = n.beat + n.durBeats;
        const prev = laneHolds.get(n.lane);
        if (prev && prev.beat + prev.durBeats > n.beat + EPS) {
          add('warn', '轨道 ' + (n.lane + 1) + ' 的两个长按重叠（' + prev.id + ' 与 ' + n.id + '）');
        }
        laneHolds.set(n.lane, n);
        if (secondsAtBeat(chart, tail) <= secondsAtBeat(chart, n.beat) + EPS) {
          add('error', '长按 ' + n.id + ' 的结束时间不晚于开始时间');
        }
      }
    });

    const pairs = orderPairs(chart);
    const badPairs = pairs.filter((p) => !p.ok);
    if (badPairs.length) add('error', '有 ' + badPairs.length + ' 对相邻音符的时间顺序错误');
    const crossings = pairs.filter((p) => p.crossesSection);
    if (crossings.length) {
      add('info', crossings.length + ' 对相邻音符跨越变速点：' +
        crossings.slice(0, 3).map((p) => p.a.id + '→' + p.b.id).join('，') +
        (crossings.length > 3 ? ' …' : ''));
    }
    return {
      ok: !issues.some((i) => i.level === 'error'),
      issues,
      pairs,
      crossings,
    };
  }

  return {
    EPS,
    DEFAULT_SECTION,
    clone,
    num,
    normalizeChart,
    emptyChart,
    getSections,
    sectionTimes,
    sectionIndexAt,
    barLength,
    secondsAtBeat,
    beatAtSeconds,
    barLines,
    barBeatLabel,
    fmtBeat,
    beatTicks,
    chartEndBeat,
    chartEndSeconds,
    orderPairs,
    validateChart,
  };
});
