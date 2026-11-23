/* 判定引擎：纯函数式、时间确定的模拟器。
   任何一次判定都只由（谱面, 输入事件序列, 窗口参数, 截止时刻）决定，
   因此从任意检查点恢复后继续跑，结果与整段重放完全一致。 */
(function (root, factory) {
  const model = (typeof module === 'object' && module.exports)
    ? require('./model.js')
    : root.RTModel;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RTJudge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  const EPS = 1e-9;
  const POINTS = { success: 100, early: 60, late: 60, holdBonus: 100 };

  const DEFAULT_WINDOWS = {
    A: { name: '窗口 A · 严格', perfectMs: 30, earlyMs: 70, lateMs: 70, releaseGraceMs: 60 },
    B: { name: '窗口 B · 宽松', perfectMs: 50, earlyMs: 120, lateMs: 100, releaseGraceMs: 100 },
  };

  const TIER_LABEL = { success: '成功', early: '早', late: '晚', miss: '漏拍' };
  const TAIL_LABEL = { complete: '完成', earlyRelease: '提前松开', holding: '按住中', miss: '漏拍' };

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }

  function normalizeWindows(w) {
    const src = w || {};
    const perfectMs = Math.max(0, num(src.perfectMs, 30));
    return {
      name: typeof src.name === 'string' ? src.name : '窗口',
      perfectMs,
      earlyMs: Math.max(perfectMs, num(src.earlyMs, 70)),
      lateMs: Math.max(perfectMs, num(src.lateMs, 70)),
      releaseGraceMs: Math.max(0, num(src.releaseGraceMs, 60)),
    };
  }

  /** 单个偏差（毫秒，输入时刻 − 目标时刻）→ 判定档；窗口边界全部闭区间。 */
  function judgeOffset(dtMs, windows) {
    const w = normalizeWindows(windows);
    if (Math.abs(dtMs) <= w.perfectMs + EPS) return 'success';
    if (dtMs < 0 && -dtMs <= w.earlyMs + EPS) return 'early';
    if (dtMs > 0 && dtMs <= w.lateMs + EPS) return 'late';
    return null;
  }

  function buildNotes(chart) {
    const notes = (chart && chart.notes ? chart.notes : []).map((n) => {
      const headTime = M.secondsAtBeat(chart, n.beat);
      const tailTime = n.type === 'hold'
        ? M.secondsAtBeat(chart, n.beat + n.durBeats)
        : headTime;
      return {
        id: n.id,
        lane: n.lane,
        type: n.type,
        beat: n.beat,
        durBeats: n.durBeats || 0,
        headTime,
        tailTime,
        durSeconds: Math.max(0, tailTime - headTime),
      };
    });
    notes.sort((a, b) =>
      a.headTime - b.headTime || a.lane - b.lane || a.id.localeCompare(b.id));
    return notes;
  }

  function normalizeEvents(events) {
    const list = [];
    const usedIds = new Set();
    (events || []).forEach((e, i) => {
      if (!e || (e.kind !== 'press' && e.kind !== 'release')) return;
      const t = num(e.t, NaN);
      if (!Number.isFinite(t)) return;
      const lane = Math.round(num(e.lane, 0));
      if (lane < 0 || lane > 3) return;
      // 输入 id 用于把判定结果映射回原始事件，必须唯一。
      let id = typeof e.id === 'string' && e.id ? e.id : 'ev' + i;
      while (usedIds.has(id)) id += '_';
      usedIds.add(id);
      list.push({
        t,
        rawT: num(e.rawT, t),
        lane,
        kind: e.kind,
        noteId: e.noteId || null,
        source: e.source || null,
        seq: i,
        id,
      });
    });
    list.sort((a, b) => a.t - b.t || a.seq - b.seq);
    return list;
  }

  function initialState(notes, events, windows, from) {
    const results = {};
    notes.forEach((n) => {
      results[n.id] = {
        id: n.id,
        lane: n.lane,
        type: n.type,
        beat: n.beat,
        durBeats: n.durBeats,
        headTime: n.headTime,
        tailTime: n.tailTime,
        durSeconds: n.durSeconds,
        head: null,
        tail: null,
      };
    });
    const base = {
      notes,
      results,
      events,
      windows: normalizeWindows(windows),
      combo: 0,
      maxCombo: 0,
      score: 0,
      timeline: [],
      stray: [],
      traces: [],
      active: {},
      laneHold: {},
      time: 0,
      cursor: 0,
    };
    if (from) {
      base.results = JSON.parse(JSON.stringify(from.results));
      base.combo = from.combo;
      base.maxCombo = from.maxCombo;
      base.score = from.score;
      base.stray = JSON.parse(JSON.stringify(from.stray || []));
      base.traces = JSON.parse(JSON.stringify(from.traces || []));
      base.timeline = JSON.parse(JSON.stringify(from.timeline || []));
      base.active = JSON.parse(JSON.stringify(from.active || {}));
      base.time = from.time;
      Object.keys(base.active).forEach((id) => {
        const a = base.active[id];
        base.laneHold[a.lane] = id;
      });
      // 跳过检查点时刻已经处理过的事件（含同一时刻的全部事件）。
      while (base.cursor < events.length && events[base.cursor].t <= from.time + EPS) {
        base.cursor += 1;
      }
    }
    return base;
  }

  function setOverall(run, id) {
    const r = run.results[id];
    if (!r.head) return 'pending';
    if (r.head.state === 'miss') return 'miss';
    if (r.type === 'tap') return r.head.tier;
    if (!r.tail) return 'holding';
    if (r.tail.state === 'complete') return r.head.tier;
    if (r.tail.state === 'earlyRelease') return 'earlyRelease';
    return 'pending';
  }

  function removeActive(run, id) {
    const a = run.active[id];
    if (!a) return;
    delete run.active[id];
    if (run.laneHold[a.lane] === id) delete run.laneHold[a.lane];
  }

  function timelinePush(run, entry) {
    run.timeline.push(Object.assign({ combo: run.combo, score: run.score }, entry));
  }

  function completeHold(run, id, atTime, via, inputSeq, inputId) {
    const r = run.results[id];
    if (!r || !r.head || r.head.state !== 'hit' || r.tail) return;
    const note = run.notes.find((n) => n.id === id);
    const tailTime = note ? note.tailTime : r.tailTime;
    r.tail = {
      state: 'complete',
      t: atTime,
      via,
      inputSeq: inputSeq == null ? null : inputSeq,
      inputId: inputId || null,
      tailTime,
      deltaMs: (atTime - tailTime) * 1000,
    };
    run.score += POINTS.holdBonus;
    run.combo += 1;
    run.maxCombo = Math.max(run.maxCombo, run.combo);
    removeActive(run, id);
    timelinePush(run, {
      t: atTime, noteId: id, part: 'tail', outcome: 'complete', dtMs: r.tail.deltaMs, via,
    });
  }

  function earlyReleaseHold(run, id, atTime, inputSeq, inputId) {
    const r = run.results[id];
    if (!r || !r.head || r.head.state !== 'hit' || r.tail) return;
    r.tail = {
      state: 'earlyRelease',
      t: atTime,
      inputSeq,
      inputId: inputId || null,
      tailTime: r.tailTime,
      deltaMs: (atTime - r.tailTime) * 1000,
      remainingMs: (r.tailTime - atTime) * 1000,
    };
    run.combo = 0;
    removeActive(run, id);
    timelinePush(run, {
      t: atTime, noteId: id, part: 'tail', outcome: 'earlyRelease',
      dtMs: r.tail.deltaMs, remainingMs: r.tail.remainingMs,
    });
  }

  function missHead(run, id, atTime) {
    const r = run.results[id];
    if (!r || r.head) return;
    r.head = { state: 'miss', tier: null, t: atTime, deadline: atTime, dtMs: null };
    run.combo = 0;
    timelinePush(run, { t: atTime, noteId: id, part: 'head', outcome: 'miss', dtMs: null });
  }

  /**
   * 处理到期事件：长按自动完成、头部超时漏拍。
   * 按真实到期时刻排序，保证连击/最高连击与整段重放一致。
   * inclusive=true 时包含 limit 这一刻（用于「推进到 target」的收尾）。
   */
  function flushExpiries(run, limit, inclusive) {
    const w = run.windows;
    const isDue = (at) => (inclusive ? at <= limit + EPS : at < limit - EPS);
    const due = [];
    Object.keys(run.active).forEach((id) => {
      const r = run.results[id];
      // 进行中的长按还没有 tail，直接按尾部时刻判断是否到期。
      if (r && isDue(r.tailTime)) due.push({ at: r.tailTime, kind: 'hold', id, order: 0 });
    });
    run.notes.forEach((n) => {
      const r = run.results[n.id];
      if (r && !r.head) {
        const deadline = n.headTime + w.lateMs / 1000;
        if (isDue(deadline)) due.push({ at: deadline, kind: 'miss', id: n.id, order: 1 });
      }
    });
    due.sort((a, b) => a.at - b.at || a.order - b.order || a.id.localeCompare(b.id));
    due.forEach((item) => {
      if (item.kind === 'hold') completeHold(run, item.id, item.at, 'auto');
      else missHead(run, item.id, item.at);
    });
  }

  function collectCandidates(run, ev) {
    const list = [];
    const reach = Math.max(run.windows.earlyMs, run.windows.lateMs) + 250;
    run.notes.forEach((n) => {
      if (n.lane !== ev.lane) return;
      const dtMs = (ev.t - n.headTime) * 1000;
      if (Math.abs(dtMs) > reach) return;
      const r = run.results[n.id];
      const tier = judgeOffset(dtMs, run.windows);
      let reason = 'ok';
      if (!r) reason = 'missing';
      else if (r.head) reason = r.head.state === 'miss' ? 'missed' : 'consumed';
      else if (run.active[n.id]) reason = 'consumed';
      else if (!tier) reason = 'out-of-window';
      list.push({ note: n, dtMs, tier, eligible: reason === 'ok', reason });
    });
    list.sort((a, b) => Math.abs(a.dtMs) - Math.abs(b.dtMs) ||
      a.note.headTime - b.note.headTime || a.note.id.localeCompare(b.note.id));
    return list;
  }

  function chooseCandidate(candidates) {
    let best = null;
    for (const c of candidates) {
      if (!c.eligible) continue;
      if (!best) { best = c; continue; }
      const a = Math.abs(c.dtMs);
      const b = Math.abs(best.dtMs);
      if (a < b - EPS) best = c;
      else if (Math.abs(a - b) <= EPS) {
        if (c.note.headTime < best.note.headTime - EPS) best = c;
        else if (Math.abs(c.note.headTime - best.note.headTime) <= EPS &&
          c.note.id.localeCompare(best.note.id) < 0) best = c;
      }
    }
    return best;
  }

  function handlePress(run, ev) {
    const trace = {
      t: ev.t, lane: ev.lane, seq: ev.seq, inputId: ev.id, kind: 'press',
      noteId: null, dtMs: null, tier: null, outcome: 'stray', candidates: [],
    };
    if (run.laneHold[ev.lane]) {
      run.stray.push({ t: ev.t, lane: ev.lane, kind: 'press', reason: 'lane-held', seq: ev.seq });
      trace.outcome = 'lane-held';
      run.traces.push(trace);
      return;
    }
    const candidates = collectCandidates(run, ev);
    const cand = chooseCandidate(candidates);
    trace.candidates = candidates.map((c) => ({
      noteId: c.note.id,
      dtMs: round3(c.dtMs),
      tier: c.tier,
      reason: c.reason,
      chosen: c === cand,
      lostTo: c !== cand && c.eligible && cand ? cand.note.id : null,
    }));
    if (!cand) {
      run.stray.push({ t: ev.t, lane: ev.lane, kind: 'press', reason: 'no-target', seq: ev.seq });
      trace.outcome = 'no-target';
      run.traces.push(trace);
      return;
    }
    const note = cand.note;
    const r = run.results[note.id];
    r.head = {
      state: 'hit',
      tier: cand.tier,
      t: ev.t,
      inputSeq: ev.seq,
      inputId: ev.id,
      noteIdHint: ev.noteId,
      dtMs: cand.dtMs,
      points: POINTS[cand.tier],
    };
    run.score += POINTS[cand.tier];
    trace.noteId = note.id;
    trace.dtMs = round3(cand.dtMs);
    trace.tier = cand.tier;
    trace.outcome = cand.tier;
    run.traces.push(trace);

    if (note.type === 'hold') {
      run.active[note.id] = {
        id: note.id, lane: note.lane, pressTime: ev.t, tier: cand.tier,
        dtMs: cand.dtMs, inputSeq: ev.seq,
      };
      run.laneHold[note.lane] = note.id;
      // 长按头部命中先不计连击，完成时再计。
      timelinePush(run, {
        t: ev.t, noteId: note.id, part: 'head', outcome: cand.tier,
        dtMs: cand.dtMs, hold: true,
      });
    } else {
      run.combo += 1;
      run.maxCombo = Math.max(run.maxCombo, run.combo);
      timelinePush(run, {
        t: ev.t, noteId: note.id, part: 'head', outcome: cand.tier, dtMs: cand.dtMs,
      });
    }
  }

  function handleRelease(run, ev) {
    const id = run.laneHold[ev.lane];
    const trace = {
      t: ev.t, lane: ev.lane, seq: ev.seq, inputId: ev.id, kind: 'release',
      noteId: id || null, outcome: 'stray', dtMs: null,
    };
    if (!id) {
      // 单点的抬手是正常操作，不算杂散输入；只在轨迹里留痕。
      trace.outcome = 'idle-release';
      run.traces.push(trace);
      return;
    }
    const r = run.results[id];
    const grace = run.windows.releaseGraceMs / 1000;
    trace.dtMs = round3((ev.t - r.tailTime) * 1000);
    if (ev.t >= r.tailTime - grace - EPS) {
      trace.outcome = 'complete';
      completeHold(run, id, Math.min(ev.t, r.tailTime), 'release', ev.seq, ev.id);
    } else {
      trace.outcome = 'earlyRelease';
      earlyReleaseHold(run, id, ev.t, ev.seq, ev.id);
    }
    run.traces.push(trace);
  }

  function advanceTo(run, target) {
    const events = run.events;
    while (run.cursor < events.length && events[run.cursor].t <= target + EPS) {
      const te = events[run.cursor].t;
      flushExpiries(run, te, false);
      while (run.cursor < events.length && Math.abs(events[run.cursor].t - te) <= EPS) {
        const ev = events[run.cursor];
        if (ev.kind === 'press') handlePress(run, ev);
        else handleRelease(run, ev);
        run.cursor += 1;
      }
      run.time = te;
    }
    // 收尾：把 target 及之前自然到期的结算掉。
    flushExpiries(run, target, true);
    run.time = Math.max(run.time, target);
    return run;
  }

  function capture(run) {
    return {
      version: 1,
      time: run.time,
      results: JSON.parse(JSON.stringify(run.results)),
      active: JSON.parse(JSON.stringify(run.active)),
      combo: run.combo,
      maxCombo: run.maxCombo,
      score: run.score,
      stray: JSON.parse(JSON.stringify(run.stray)),
      traces: JSON.parse(JSON.stringify(run.traces)),
      timeline: JSON.parse(JSON.stringify(run.timeline)),
    };
  }

  function maxScoreOf(notes) {
    return notes.reduce((sum, n) => sum + 100 + (n.type === 'hold' ? POINTS.holdBonus : 0), 0);
  }

  function finalize(run, endTime) {
    const noteList = run.notes.slice().sort((a, b) =>
      a.beat - b.beat || a.lane - b.lane || a.id.localeCompare(b.id));
    const results = {};
    let completedHolds = 0;
    noteList.forEach((n) => {
      const r = run.results[n.id];
      r.overall = setOverall(run, n.id);
      if (r.type === 'hold' && r.tail && r.tail.state === 'complete') completedHolds += 1;
      results[n.id] = r;
    });
    const maxScore = maxScoreOf(run.notes);
    return {
      notes: results,
      noteList: noteList.map((n) => results[n.id]),
      timeline: run.timeline.slice().sort((a, b) => a.t - b.t || a.noteId.localeCompare(b.noteId)),
      combo: run.combo,
      maxCombo: run.maxCombo,
      score: run.score,
      maxScore,
      accuracy: maxScore ? run.score / maxScore : 0,
      completedHolds,
      stray: run.stray,
      traces: run.traces.slice().sort((a, b) => a.t - b.t || a.seq - b.seq),
      active: run.active,
      time: endTime,
      windows: run.windows,
    };
  }

  /**
   * 完整求值。
   * @param {object} chart
   * @param {Array} events 输入事件（t 为秒）
   * @param {object} windows
   * @param {{endTime?:number, from?:object}} opts from 为 capture() 的快照
   */
  function evaluate(chart, events, windows, opts) {
    const options = opts || {};
    const notes = buildNotes(chart);
    const evs = normalizeEvents(events);
    const run = initialState(notes, evs, windows, options.from);
    const endTime = options.endTime != null
      ? options.endTime
      : M.secondsAtBeat(chart, M.chartEndBeat(chart)) + 0.5;
    advanceTo(run, endTime);
    return finalize(run, endTime);
  }

  /** 在 time 时刻截取可序列化快照（先把判定推进到该时刻）。 */
  function snapshotAt(chart, events, windows, time) {
    const notes = buildNotes(chart);
    const evs = normalizeEvents(events);
    const run = initialState(notes, evs, windows);
    advanceTo(run, Math.max(0, time));
    return capture(run);
  }

  function shiftEvents(events, biasMs) {
    const shift = num(biasMs, 0) / 1000;
    const usedIds = new Set();
    return (events || [])
      .filter((e) => e && (e.kind === 'press' || e.kind === 'release'))
      .map((e, i) => {
        let id = typeof e.id === 'string' && e.id ? e.id : 'ev' + i;
        while (usedIds.has(id)) id += '_';
        usedIds.add(id);
        return Object.assign({}, e, {
          id,
          rawT: num(e.rawT, num(e.t, 0)),
          t: num(e.t, 0) + shift,
          seq: i,
        });
      });
  }

  function outcomeOf(result) {
    return result ? result.overall || 'pending' : 'pending';
  }

  function nearestReleaseRaw(shifted, lane, tailTime) {
    let best = null;
    let bestDist = Infinity;
    shifted.forEach((e) => {
      if (e.kind !== 'release' || e.lane !== lane) return;
      const d = Math.abs(e.rawT - tailTime);
      if (d < bestDist) { bestDist = d; best = e.rawT; }
    });
    return best;
  }

  /** A/B 两套窗口的分歧，附原始偏差（未叠加模拟偏差的偏移）。 */
  function compareWindows(chart, events, windowsA, windowsB, biasMs, opts) {
    const shifted = shiftEvents(events, biasMs);
    const a = evaluate(chart, shifted, windowsA, opts);
    const b = evaluate(chart, shifted, windowsB, opts);
    const rawById = {};
    shifted.forEach((e) => { rawById[e.id] = e.rawT; });
    const rawAt = (id) => (id != null && rawById[id] != null ? rawById[id] : null);
    const allRows = [];
    const divergentNoteIds = [];
    const push = (row) => {
      row.divergent = row.a !== row.b;
      allRows.push(row);
      if (row.divergent && divergentNoteIds.indexOf(row.noteId) < 0) {
        divergentNoteIds.push(row.noteId);
      }
    };

    a.noteList.forEach((ra) => {
      const rb = b.notes[ra.id];
      if (!rb) return;
      const headA = ra.head ? (ra.head.state === 'miss' ? 'miss' : ra.head.tier) : 'pending';
      const headB = rb.head ? (rb.head.state === 'miss' ? 'miss' : rb.head.tier) : 'pending';
      const tailA = ra.tail ? ra.tail.state : 'pending';
      const tailB = rb.tail ? rb.tail.state : 'pending';

      let pressT = rawAt(ra.head && ra.head.inputId);
      if (pressT == null) pressT = rawAt(rb.head && rb.head.inputId);
      let pressMs = pressT != null ? (pressT - ra.headTime) * 1000 : null;
      if (pressMs == null && ra.head && ra.head.dtMs != null) pressMs = ra.head.dtMs;
      if (pressMs == null && rb.head && rb.head.dtMs != null) pressMs = rb.head.dtMs;
      push({
        noteId: ra.id,
        part: 'head',
        lane: ra.lane,
        headTime: ra.headTime,
        tailTime: ra.tailTime,
        rawMs: pressMs,
        effMs: pressMs == null ? null : pressMs + num(biasMs, 0),
        a: headA,
        b: headB,
      });

      if (ra.type !== 'hold') return;
      let rawT = rawAt(ra.tail && ra.tail.inputId);
      if (rawT == null) rawT = rawAt(rb.tail && rb.tail.inputId);
      if (rawT == null && ((ra.tail && ra.tail.via === 'release') ||
        (rb.tail && rb.tail.via === 'release'))) {
        rawT = nearestReleaseRaw(shifted, ra.lane, ra.tailTime);
      }
      const dtMs = rawT != null ? (rawT - ra.tailTime) * 1000 : null;
      push({
        noteId: ra.id,
        part: 'tail',
        lane: ra.lane,
        headTime: ra.headTime,
        tailTime: ra.tailTime,
        rawMs: dtMs,
        effMs: dtMs == null ? null : dtMs + num(biasMs, 0),
        a: tailA,
        b: tailB,
      });
    });

    return {
      a,
      b,
      rows: allRows.filter((r) => r.divergent),
      allRows,
      divergentNoteIds,
      biasMs: num(biasMs, 0),
    };
  }

  function summaryLine(result) {
    const c = { success: 0, early: 0, late: 0, miss: 0, pending: 0 };
    let tailComplete = 0;
    let tailEarly = 0;
    let holding = 0;
    result.noteList.forEach((r) => {
      if (!r.head) c.pending += 1;
      else if (r.head.state === 'miss') c.miss += 1;
      else if (r.head.tier) c[r.head.tier] += 1;
      if (r.type === 'hold') {
        if (r.tail && r.tail.state === 'complete') tailComplete += 1;
        else if (r.tail && r.tail.state === 'earlyRelease') tailEarly += 1;
        else if (r.head && r.head.state === 'hit' && !r.tail) holding += 1;
      }
    });
    return '头部 成功 ' + c.success + ' · 早 ' + c.early + ' · 晚 ' + c.late +
      ' · 漏拍 ' + c.miss + ' · 待判 ' + c.pending +
      ' ｜ 长按尾 完成 ' + tailComplete + ' · 早松 ' + tailEarly + ' · 按住 ' + holding;
  }

  return {
    POINTS,
    DEFAULT_WINDOWS,
    TIER_LABEL,
    TAIL_LABEL,
    normalizeWindows,
    judgeOffset,
    buildNotes,
    normalizeEvents,
    evaluate,
    snapshotAt,
    capture,
    shiftEvents,
    compareWindows,
    summaryLine,
    maxScoreOf,
    outcomeOf,
  };
});
