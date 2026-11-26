/*!
 * rhythm-debug-console / engine.js
 * 纯逻辑引擎：时间轴换算、谱面校验、判定、模拟输入生成、双窗口对照。
 * 不依赖任何浏览器 API，可直接在 Node 中 require 跑测试。
 * UMD：浏览器挂到 window.Rhythm，Node 走 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rhythm = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ============================================================
   * 1. 随机数（确定性 PRNG，保证同一 seed 生成的输入完全一致）
   * ============================================================ */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ============================================================
   * 2. 时间轴：拍号(beat) <-> 实际秒数(time)
   *    变速段 segments: [{beat, bpm}]，在 beat 处切换 BPM。
   *    分段线性：段内 beat 时长 = 60 / bpm 秒。
   * ============================================================ */
  function buildTimeline(chart) {
    const segs = [{ beat: 0, bpm: Number(chart.initialBpm) || 120, startTime: 0 }];
    const extra = (chart.segments || [])
      .filter((s) => s.beat > 0)
      .map((s) => ({ beat: s.beat, bpm: s.bpm }))
      .sort((a, b) => a.beat - b.beat);
    let t = 0;
    for (const s of extra) {
      const prev = segs[segs.length - 1];
      t += (s.beat - prev.beat) * (60 / prev.bpm);
      segs.push({ beat: s.beat, bpm: s.bpm, startTime: t });
    }
    return segs;
  }

  /** beat -> 秒。二分定位所在变速段。 */
  function beatToTime(segs, beat) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.startTime + (beat - s.beat) * (60 / s.bpm);
  }

  /** 秒 -> beat（逆映射，用于把输入位置折回拍号坐标显示）。 */
  function timeToBeat(segs, time) {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].startTime <= time) lo = mid;
      else hi = mid - 1;
    }
    const s = segs[lo];
    return s.beat + (time - s.startTime) / (60 / s.bpm);
  }

  /** 预处理：把每个音符换算出实际秒数，并按时间稳定排序。 */
  function prepareNotes(chart, segs) {
    return (chart.notes || []).map((n, i) => {
      const startTime = beatToTime(segs, n.beat);
      return {
        id: n.id != null && n.id !== '' ? String(n.id) : 'n' + (i + 1),
        type: n.type === 'hold' ? 'hold' : 'tap',
        beat: n.beat,
        endBeat: n.type === 'hold' ? n.endBeat : null,
        startTime,
        endTime: n.type === 'hold' ? beatToTime(segs, n.endBeat) : null,
        order: i,
      };
    }).sort((a, b) => a.startTime - b.startTime || a.order - b.order);
  }

  /* ============================================================
   * 3. 谱面校验
   * ============================================================ */
  function validateChart(chart) {
    const errors = [], warnings = [];
    if (!(Number(chart.initialBpm) > 0)) errors.push('初始 BPM 必须为正数');
    const segBeats = new Set();
    let lastBeat = 0;
    for (const s of chart.segments || []) {
      if (!(Number(s.bpm) > 0)) errors.push(`变速段 @beat ${s.beat} 的 BPM 必须为正数`);
      if (!(s.beat > 0)) errors.push('变速段 beat 必须大于 0');
      if (segBeats.has(s.beat)) errors.push(`beat ${s.beat} 处存在重复变速段`);
      if (s.beat <= lastBeat) errors.push('变速段必须按 beat 递增排列');
      segBeats.add(s.beat);
      lastBeat = s.beat;
    }
    const ids = new Set();
    const prepared = errors.length ? [] : prepareNotes(chart, buildTimeline(chart));
    for (const n of chart.notes || []) {
      if (n.id != null && n.id !== '' && ids.has(n.id)) errors.push(`音符 id 重复：${n.id}`);
      ids.add(n.id);
      if (!(n.beat >= 0)) errors.push(`音符 ${n.id ?? ''} 的 beat 不能为负`);
      if (n.type === 'hold' && !(n.endBeat > n.beat)) {
        errors.push(`长按 ${n.id ?? ''} 的 endBeat 必须大于 beat`);
      }
    }
    // 时间序一致性：beat 单调 => 秒数单调，跨变速段也不允许逆序
    for (let i = 1; i < prepared.length; i++) {
      if (prepared[i].startTime < prepared[i - 1].startTime) {
        errors.push(`音符 ${prepared[i].id} 时间早于前一个音符，顺序异常`);
      }
    }
    // 单键模型下的重叠提示（不禁止保存，但提示判定会互相影响）
    for (let i = 0; i < prepared.length; i++) {
      const a = prepared[i];
      if (a.type !== 'hold') continue;
      for (let j = 0; j < prepared.length; j++) {
        if (i === j) continue;
        const b = prepared[j];
        if (b.startTime > a.startTime && b.startTime < a.endTime) {
          warnings.push(`长按 ${a.id} 进行中出现音符 ${b.id}：单键模型下该音符会被漏拍/判为无效输入`);
        }
      }
    }
    return { errors, warnings };
  }

  /* ============================================================
   * 4. 判定窗口与判定等级
   *    窗口字段（毫秒）：
   *      perfectMs  完美窗口（含边界）
   *      lateMs     最迟/最早可判定窗口（含边界），超出即漏拍
   *      releaseMs  长按尾部容差：endTime-releaseMs 之后松开算完成
   *    判定等级：perfect 完美 / good 良好 / miss 漏拍 / early 提前松开
   *    方向：dt<0 早，dt>0 晚，dt=0 准。边界一律按“含”处理。
   * ============================================================ */
  const DEFAULT_WINDOWS_A = { name: 'A 标准窗', perfectMs: 50, lateMs: 150, releaseMs: 120 };
  const DEFAULT_WINDOWS_B = { name: 'B 宽松窗', perfectMs: 80, lateMs: 200, releaseMs: 160 };

  function normWindows(w) {
    return {
      name: w.name || '未命名窗口',
      perfectMs: Math.max(0, Number(w.perfectMs) || 0),
      lateMs: Math.max(0, Number(w.lateMs) || 0),
      releaseMs: Math.max(0, Number(w.releaseMs) || 0),
    };
  }

  /** 把秒级差值换算成毫秒并保留 3 位小数，避免浮点误差影响边界比较与显示。 */
  function dtMs(inputTime, noteTime) {
    return Math.round((inputTime - noteTime) * 1e6) / 1e3;
  }

  function gradeOf(dt, w) {
    const a = Math.abs(dt);
    if (a <= w.perfectMs) return 'perfect';
    if (a <= w.lateMs) return 'good';
    return 'miss';
  }

  function directionOf(dt) {
    if (dt < -0.0001) return '早';
    if (dt > 0.0001) return '晚';
    return '准';
  }

  const LABELS = {
    perfect: '完美',
    good: '良好',
    miss: '漏拍',
    early: '提前松开',
    complete: '完成',
  };

  /** 带方向的完整判定文案，如 “完美(早)”。 */
  function fullLabel(judgment, dt) {
    if (judgment === 'miss') return LABELS.miss;
    if (judgment === 'early') return LABELS.early;
    if (judgment === 'complete') return LABELS.complete;
    return LABELS[judgment] + '(' + directionOf(dt) + ')';
  }

  /* ============================================================
   * 5. 判定核心（纯函数）
   *
   * 规则总览：
   *  - 事件驱动：输入事件与“漏拍死线/长按自动完成”合成事件统一按时间排序；
   *    同一时刻先处理输入、再处理死线，保证窗口边界（含）始终可判。
   *  - 防重复计数：每个 down 输入最多匹配一个音符（取 |dt| 最小者，
   *    平局取时间更早的音符）；每个音符只接受第一个匹配输入。
   *  - 单键：键未松开时新的 down 记为无效输入，不会触发任何音符。
   *  - 长按：down 判头部；up 在 endTime-releaseMs 之后 => 完成，
   *    否则 => 提前松开（断连击）；全程没松 => endTime 自动完成。
   *  - 连击：非 miss 事件 +1，miss / 提前松开清零。
   * ============================================================ */
  function judge(chart, rawInputs, rawWindows) {
    const w = normWindows(rawWindows);
    const segs = buildTimeline(chart);
    const notes = prepareNotes(chart, segs);
    const inputs = (rawInputs || []).slice().sort((a, b) => a.time - b.time);

    const state = notes.map(() => ({
      status: 'idle', // idle | holding | done | missed | early
      head: null,     // {judgment, dt, inputIdx}
      release: null,  // {judgment, dt, inputIdx}
      inputIdx: null,
    }));

    const events = [];
    const strays = [];
    let combo = 0, maxCombo = 0, score = 0;
    let keyDown = false, activeHold = -1, autoCompleted = false;

    const counts = { perfect: 0, good: 0, miss: 0, early: 0, complete: 0 };

    function addCombo(judgment) {
      if (judgment === 'miss' || judgment === 'early') combo = 0;
      else combo += 1;
      if (combo > maxCombo) maxCombo = combo;
    }

    /** 基础分 + 连击奖励（连击奖励上限 50 连击，避免分差无限放大）。 */
    function emit(ev) {
      let base = 0;
      if (ev.kind === 'tap') {
        base = ev.judgment === 'perfect' ? 1000 : ev.judgment === 'good' ? 600 : 0;
      } else if (ev.kind === 'hold-head') {
        base = ev.judgment === 'perfect' ? 500 : ev.judgment === 'good' ? 300 : 0;
      } else if (ev.kind === 'hold-release' && ev.judgment === 'complete') {
        base = 500;
      }
      const bonus = (ev.judgment === 'miss' || ev.judgment === 'early') ? 0 : Math.min(combo, 50) * 10;
      score += base + bonus;
      counts[ev.judgment] = (counts[ev.judgment] || 0) + 1;
      events.push(Object.assign({}, ev, {
        combo, scoreDelta: base + bonus, totalScore: score,
      }));
    }

    /** 死线到期：窗口已过仍未被按下的音符 -> 漏拍。条件 deadline < t（边界含在窗口内）。 */
    function expireIdle(t) {
      for (let i = 0; i < notes.length; i++) {
        const st = state[i];
        if (st.status !== 'idle') continue;
        const deadline = notes[i].startTime + w.lateMs / 1000;
        if (deadline < t) {
          st.status = 'missed';
          addCombo('miss');
          emit({
            time: deadline, kind: 'miss', noteId: notes[i].id, noteIndex: i,
            judgment: 'miss', dt: null, inputIdx: null,
          });
        }
      }
    }

    // 合成事件：每个长按的 endTime 自动完成检查点
    const queue = [];
    inputs.forEach((inp, idx) => queue.push({ sort: 0, time: inp.time, kind: 'input', idx }));
    notes.forEach((n, i) => {
      if (n.type === 'hold') queue.push({ sort: 1, time: n.endTime, kind: 'hold-end', noteIndex: i });
    });
    queue.sort((a, b) => a.time - b.time || a.sort - b.sort);

    for (const ev of queue) {
      expireIdle(ev.time);

      if (ev.kind === 'input') {
        const inp = inputs[ev.idx];
        if (inp.type === 'down') {
          if (keyDown) {
            strays.push({ time: inp.time, type: 'down', inputIdx: ev.idx, reason: '按键尚未松开，重复 down 已忽略' });
            continue;
          }
          // 在所有 idle 且窗口覆盖该时刻的音符中，取 |dt| 最小；平局取更早的音符
          let best = -1, bestAbs = Infinity;
          for (let i = 0; i < notes.length; i++) {
            if (state[i].status !== 'idle') continue;
            const dt = dtMs(inp.time, notes[i].startTime);
            const abs = Math.abs(dt);
            if (abs > w.lateMs) continue;
            if (abs < bestAbs || (abs === bestAbs && i < best)) { best = i; bestAbs = abs; }
          }
          if (best === -1) {
            strays.push({ time: inp.time, type: 'down', inputIdx: ev.idx, reason: '判定窗口内没有可匹配的音符' });
            continue;
          }
          keyDown = true;
          autoCompleted = false;
          const dt = dtMs(inp.time, notes[best].startTime);
          const judgment = gradeOf(dt, w);
          state[best].inputIdx = ev.idx;
          state[best].head = { judgment, dt, inputIdx: ev.idx };
          addCombo(judgment);
          if (notes[best].type === 'tap') {
            state[best].status = 'done';
            emit({
              time: inp.time, kind: 'tap', noteId: notes[best].id, noteIndex: best,
              judgment, dt, inputIdx: ev.idx,
            });
          } else {
            state[best].status = 'holding';
            activeHold = best;
            emit({
              time: inp.time, kind: 'hold-head', noteId: notes[best].id, noteIndex: best,
              judgment, dt, inputIdx: ev.idx,
            });
          }
        } else {
          // up
          if (!keyDown) {
            strays.push({ time: inp.time, type: 'up', inputIdx: ev.idx, reason: '没有按下中的按键，up 已忽略' });
            continue;
          }
          keyDown = false;
          // 长按已到 endTime 自动完成、手指物理上仍按住：这个晚到的 up 静默释放，不算无效输入
          if (autoCompleted) { autoCompleted = false; continue; }
          if (activeHold === -1) continue; // 单点尾部的 up，无副作用
          const i = activeHold;
          activeHold = -1;
          const dt = dtMs(inp.time, notes[i].endTime);
          if (inp.time >= notes[i].endTime - w.releaseMs / 1000) {
            state[i].status = 'done';
            state[i].release = { judgment: 'complete', dt, inputIdx: ev.idx };
            addCombo('complete');
            emit({
              time: inp.time, kind: 'hold-release', noteId: notes[i].id, noteIndex: i,
              judgment: 'complete', dt, inputIdx: ev.idx,
            });
          } else {
            state[i].status = 'early';
            state[i].release = { judgment: 'early', dt, inputIdx: ev.idx };
            addCombo('early');
            emit({
              time: inp.time, kind: 'hold-release', noteId: notes[i].id, noteIndex: i,
              judgment: 'early', dt, inputIdx: ev.idx,
            });
          }
        }
      } else if (ev.kind === 'hold-end') {
        // 一直按住没松：到 endTime 自动完成（dt=0）。
        // 注意物理按键仍处于按住状态，保留 keyDown 并标记 autoCompleted，
        // 等真实 up 到达时静默释放，避免把正常抬键误报为无效输入。
        const i = ev.noteIndex;
        if (state[i].status === 'holding' && activeHold === i) {
          activeHold = -1;
          autoCompleted = true;
          state[i].status = 'done';
          state[i].release = { judgment: 'complete', dt: 0, inputIdx: null };
          addCombo('complete');
          emit({
            time: notes[i].endTime, kind: 'hold-release', noteId: notes[i].id, noteIndex: i,
            judgment: 'complete', dt: 0, inputIdx: null,
          });
        }
      }
    }
    // 收尾：剩余 idle 音符漏拍
    expireIdle(Infinity);

    const noteResults = notes.map((n, i) => ({
      id: n.id,
      type: n.type,
      beat: n.beat,
      endBeat: n.endBeat,
      startTime: n.startTime,
      endTime: n.endTime,
      status: state[i].status,
      head: state[i].head,
      release: state[i].release,
    }));

    return {
      windows: w,
      events,
      strays,
      noteResults,
      summary: {
        score,
        maxCombo,
        counts,
        totalNotes: notes.length,
      },
    };
  }

  /** 截止到 time 时刻的连击/分数快照（用于拖回检查点时显示当时状态）。 */
  function stateAt(result, time) {
    let combo = 0, score = 0, last = null;
    for (const ev of result.events) {
      if (ev.time > time) break;
      combo = ev.combo;
      score = ev.totalScore;
      last = ev;
    }
    return { combo, score, lastEvent: last };
  }

  /* ============================================================
   * 6. 模拟输入生成（确定性）
   *    opts: { biasMs, jitterMs, seed, skip:Set|array, holdEarlyMs, tapUpMs }
   * ============================================================ */
  function generateInputs(chart, opts) {
    const o = Object.assign({
      biasMs: 0, jitterMs: 0, seed: 1, skip: [], holdEarlyMs: 0, tapUpMs: 70,
    }, opts || {});
    const rnd = mulberry32(o.seed);
    const skip = new Set((o.skip || []).map(String));
    const notes = prepareNotes(chart, buildTimeline(chart));
    const out = [];
    for (const n of notes) {
      if (skip.has(n.id)) continue;
      const jitter = (rnd() * 2 - 1) * o.jitterMs;
      const downMs = Math.max(0, n.startTime * 1000 + o.biasMs + jitter);
      if (n.type === 'tap') {
        out.push({ time: downMs / 1000, type: 'down' });
        out.push({ time: (downMs + o.tapUpMs) / 1000, type: 'up' });
      } else {
        const endMs = o.holdEarlyMs > 0
          ? n.endTime * 1000 - o.holdEarlyMs
          : n.endTime * 1000 + jitter;
        out.push({ time: downMs / 1000, type: 'down' });
        out.push({ time: Math.max(downMs / 1000 + 0.02, endMs / 1000), type: 'up' });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /* ============================================================
   * 7. 两组窗口对照
   * ============================================================ */
  function compareWindows(chart, inputs, wA, wB) {
    const a = judge(chart, inputs, wA);
    const b = judge(chart, inputs, wB);
    const rows = a.noteResults.map((na, i) => {
      const nb = b.noteResults[i];
      const keyA = (na.head ? na.head.judgment + '@' + na.head.dt : 'miss') + '|' +
        (na.release ? na.release.judgment + '@' + na.release.dt : '-');
      const keyB = (nb.head ? nb.head.judgment + '@' + nb.head.dt : 'miss') + '|' +
        (nb.release ? nb.release.judgment + '@' + nb.release.dt : '-');
      return {
        noteId: na.id,
        type: na.type,
        beat: na.beat,
        startTime: na.startTime,
        a: na,
        b: nb,
        divergent: keyA !== keyB,
      };
    });
    return {
      resultA: a,
      resultB: b,
      rows,
      divergentCount: rows.filter((r) => r.divergent).length,
    };
  }

  /* ============================================================
   * 8. 内置示例（全部数据程序化生成，无外部资源）
   * ============================================================ */
  function sampleChart() {
    return {
      name: '综合示例：变速 + 跨变速长按 + 相邻单点',
      initialBpm: 100,
      timeSignature: [4, 4],
      segments: [{ beat: 8, bpm: 160 }], // beat 8 处 100 -> 160 BPM
      notes: [
        { id: 't1', type: 'tap', beat: 2 },
        { id: 't2', type: 'tap', beat: 4 },
        { id: 'h1', type: 'hold', beat: 6, endBeat: 10 }, // 跨越 beat 8 变速点
        { id: 't3', type: 'tap', beat: 11 },
        { id: 't4', type: 'tap', beat: 11.5 },             // 相邻单点：0.5 beat @160bpm = 187.5ms
        { id: 't5', type: 'tap', beat: 13 },
        { id: 't6', type: 'tap', beat: 15 },
      ],
    };
  }

  /** 相邻单点防重复计数专用小谱面：两音相距 150ms，宽窗下窗口互相重叠。 */
  function adjacentChart() {
    return {
      name: '防重复计数：相距 150ms 的相邻单点',
      initialBpm: 100,
      timeSignature: [4, 4],
      segments: [],
      notes: [
        { id: 'a1', type: 'tap', beat: 4 },
        { id: 'a2', type: 'tap', beat: 4.25 }, // 0.25 beat @100bpm = 150ms
      ],
    };
  }

  /* ============================================================
   * 9. 自测（浏览器与 Node 均可调用，返回结构化断言结果）
   * ============================================================ */
  function assert(cond, name, detail) {
    return { name, pass: !!cond, detail: detail || '' };
  }

  function selftest() {
    const r = [];

    // 9.1 变速换算
    const segs = buildTimeline({ initialBpm: 60, segments: [{ beat: 4, bpm: 120 }] });
    r.push(assert(Math.abs(beatToTime(segs, 4) - 4) < 1e-9, '变速点时间：beat4 @60bpm = 4.000s'));
    r.push(assert(Math.abs(beatToTime(segs, 5) - 4.5) < 1e-9, '变速后：beat5 = 4.500s（beat 时长 0.5s）'));
    r.push(assert(Math.abs(timeToBeat(segs, 4.5) - 5) < 1e-9, '逆映射 timeToBeat(4.5s) = beat5'));

    // 9.2 跨变速段顺序
    const chart = sampleChart();
    const prepped = prepareNotes(chart, buildTimeline(chart));
    let monotonic = prepped.every((n, i) => i === 0 || n.startTime >= prepped[i - 1].startTime);
    r.push(assert(monotonic, '变速前后音符时间严格保序'));
    const hold = prepped.find((n) => n.id === 'h1');
    r.push(assert(hold.startTime < beatToTime(buildTimeline(chart), 8) && hold.endTime > beatToTime(buildTimeline(chart), 8),
      '长按 h1 头尾分居变速点两侧', `start=${hold.startTime.toFixed(3)}s end=${hold.endTime.toFixed(3)}s`));

    // 9.3 窗口边界（含边界一致规则）
    const w = { perfectMs: 50, lateMs: 150, releaseMs: 120 };
    const c1 = { initialBpm: 120, segments: [], notes: [{ id: 'x', type: 'tap', beat: 4 }] };
    const at = (offsetMs) => [{ time: 2 + offsetMs / 1000, type: 'down' }, { time: 2.1, type: 'up' }];
    r.push(assert(judge(c1, at(50), w).noteResults[0].head.judgment === 'perfect', '边界含：dt=+50ms 判完美'));
    r.push(assert(judge(c1, at(-50), w).noteResults[0].head.judgment === 'perfect', '边界含：dt=-50ms 判完美'));
    r.push(assert(judge(c1, at(51), w).noteResults[0].head.judgment === 'good', 'dt=+51ms 降为良好'));
    r.push(assert(judge(c1, at(150), w).noteResults[0].head.judgment === 'good', '边界含：dt=+150ms 仍可判良好'));
    r.push(assert(judge(c1, at(151), w).noteResults[0].status === 'missed', 'dt=+151ms 漏拍'));

    // 9.4 一次输入不能同时算两次（窗口重叠场景）
    const c2 = adjacentChart();
    const tA1 = prepareNotes(c2, buildTimeline(c2))[0].startTime; // beat4 = 2.4s
    const wide = { perfectMs: 80, lateMs: 150, releaseMs: 120 };
    // 只给一个 down，落在两音正中（各距 75ms，都在 150ms 窗内）
    const oneDown = [{ time: tA1 + 0.075, type: 'down' }, { time: tA1 + 0.2, type: 'up' }];
    const j2 = judge(c2, oneDown, wide);
    const judged = j2.noteResults.filter((n) => n.status === 'done').length;
    const missed = j2.noteResults.filter((n) => n.status === 'missed').length;
    r.push(assert(judged === 1 && missed === 1, '重叠窗口中单个 down 只判一个音符，另一个漏拍',
      `judged=${judged} missed=${missed}`));
    r.push(assert(j2.noteResults[0].status === 'done', '平局取更早的音符 a1'));
    r.push(assert(j2.events.filter((e) => e.kind === 'tap').length === 1, '只产出一个判定事件'));

    // 9.5 长按：完成 / 提前松开 / 未松自动完成 / 头部漏拍
    const hc = { initialBpm: 120, segments: [], notes: [{ id: 'h', type: 'hold', beat: 2, endBeat: 4 }] };
    // beat2=1s, beat4=2s
    const ok = judge(hc, [{ time: 1, type: 'down' }, { time: 2, type: 'up' }], w);
    r.push(assert(ok.noteResults[0].status === 'done' && ok.noteResults[0].release.judgment === 'complete',
      '长按按住到尾部 => 完成'));
    const early = judge(hc, [{ time: 1, type: 'down' }, { time: 1.8, type: 'up' }], w); // 早 200ms > 120ms 容差
    r.push(assert(early.noteResults[0].status === 'early', '提前 200ms 松开 => 提前松开'));
    r.push(assert(early.summary.maxCombo === 1 && early.events.some((e) => e.combo === 0), '提前松开清零连击'));
    const noUp = judge(hc, [{ time: 1, type: 'down' }], w);
    r.push(assert(noUp.noteResults[0].status === 'done', '全程未松 => endTime 自动完成'));
    const headMiss = judge(hc, [], w);
    r.push(assert(headMiss.noteResults[0].status === 'missed', '头部无输入 => 整音漏拍'));
    // 尾部容差边界：endTime-120ms 松开应完成
    const edge = judge(hc, [{ time: 1, type: 'down' }, { time: 2 - 0.12, type: 'up' }], w);
    r.push(assert(edge.noteResults[0].release.judgment === 'complete', '松开容差边界（恰好 -120ms）=> 完成'));

    // 9.6 重复 down 防护
    const rep = judge(c1, [
      { time: 2, type: 'down' }, { time: 2.05, type: 'down' }, { time: 2.1, type: 'up' },
    ], w);
    r.push(assert(rep.strays.length === 1 && rep.strays[0].type === 'down', '键未松开时第二个 down 记为无效输入'));

    // 9.7 确定性：两次判定结果完全一致；前缀输入回放前缀事件一致
    const g = generateInputs(sampleChart(), { biasMs: 45, jitterMs: 25, seed: 7 });
    const jA = judge(sampleChart(), g, DEFAULT_WINDOWS_A);
    const jB = judge(sampleChart(), g, DEFAULT_WINDOWS_A);
    r.push(assert(JSON.stringify(jA) === JSON.stringify(jB), '同谱面同输入重复判定结果逐字节一致'));
    const cutoff = 3.0;
    const prefix = g.filter((e) => e.time <= cutoff);
    const jPrefix = judge(sampleChart(), prefix, DEFAULT_WINDOWS_A);
    // 只对照“输入触发”的判定事件（inputIdx !== null），漏拍死线属于全量回放的收尾事件
    const inputEvents = (res) => res.events.filter((e) => e.inputIdx !== null && e.time <= cutoff + 1e-9);
    r.push(assert(JSON.stringify(inputEvents(jPrefix)) === JSON.stringify(inputEvents(jA)),
      '检查点前缀回放：输入触发的判定/连击/分数与全量判定完全一致'));

    // 9.8 双窗口对照能发现分歧
    const cmp = compareWindows(sampleChart(), g, DEFAULT_WINDOWS_A, DEFAULT_WINDOWS_B);
    r.push(assert(cmp.divergentCount >= 1, '两组窗口存在分歧音符', `分歧数=${cmp.divergentCount}`));

    // 9.9 生成器同 seed 可复现
    const g2 = generateInputs(sampleChart(), { biasMs: 45, jitterMs: 25, seed: 7 });
    r.push(assert(JSON.stringify(g) === JSON.stringify(g2), '同 seed 的模拟输入完全可复现'));

    return {
      pass: r.every((x) => x.pass),
      results: r,
    };
  }

  return {
    mulberry32,
    buildTimeline,
    beatToTime,
    timeToBeat,
    prepareNotes,
    validateChart,
    normWindows,
    dtMs,
    gradeOf,
    directionOf,
    fullLabel,
    LABELS,
    judge,
    stateAt,
    generateInputs,
    compareWindows,
    sampleChart,
    adjacentChart,
    DEFAULT_WINDOWS_A,
    DEFAULT_WINDOWS_B,
    selftest,
  };
});
