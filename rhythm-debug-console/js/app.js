/*!
 * app.js —— 调试台主控：谱面编辑、输入管理、确定性回放、
 * 检查点重放、双窗口对照、存档导入导出。
 * 判定逻辑全部来自 engine.js（纯函数），界面只做调度与呈现。
 */
(function () {
  'use strict';
  const E = window.Rhythm;
  const $ = (id) => document.getElementById(id);

  /* ---------------- 全局状态 ---------------- */
  const state = {
    chart: E.sampleChart(),
    inputs: [],
    windowsA: Object.assign({}, E.DEFAULT_WINDOWS_A),
    windowsB: Object.assign({}, E.DEFAULT_WINDOWS_B),
    result: null,          // 当前用窗口 A 的判定结果
    playing: false,
    rafId: null,
    startCtxAt: 0,         // AudioContext 时间
    startSimAt: 0,         // 对应的谱面秒数
    lastSimTime: 0,
    checkpoint: null,
    nextAudioIdx: 0,       // 下一个待出声的输入索引
    nextMetBeat: 0,        // 下一个节拍器拍号
    nextCueIdx: 0,         // 下一个提示音音符
    recordHeld: false,
  };
  const audio = new window.AudioEngine();
  let timeline;

  const STORAGE_PREFIX = 'rdc.save.';
  const SCHED_AHEAD = 0.12; // 音频预调度窗口（秒）

  /* ================================================================
   * 工具
   * ================================================================ */
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (kind || '');
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  function fmt(t) { return t == null ? '—' : (Math.round(t * 1000) / 1000).toFixed(3); }
  function dtPill(dt) {
    if (dt == null) return '<span class="dt-zero">—</span>';
    const cls = dt < -0.0001 ? 'dt-early' : dt > 0.0001 ? 'dt-late' : 'dt-zero';
    const sign = dt > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${dt.toFixed(1)}ms</span>`;
  }
  function badge(judgment, dt) {
    return `<span class="badge ${judgment}">${E.fullLabel(judgment, dt || 0)}</span>`;
  }
  function readWindows(prefix) {
    return {
      name: $('win-' + prefix + '-name').value,
      perfectMs: Number($('win-' + prefix + '-perfect').value),
      lateMs: Number($('win-' + prefix + '-late').value),
      releaseMs: Number($('win-' + prefix + '-release').value),
    };
  }

  /* ================================================================
   * 谱面 <-> 表单
   * ================================================================ */
  function syncChartForm() {
    $('chart-name').value = state.chart.name || '';
    $('chart-bpm').value = state.chart.initialBpm;
    $('chart-ts-num').value = (state.chart.timeSignature || [4, 4])[0];
    $('chart-ts-den').value = (state.chart.timeSignature || [4, 4])[1];
    renderSegTable();
    renderNoteTable();
    renderSkipBox();
  }

  function collectChart() {
    state.chart.name = $('chart-name').value;
    state.chart.initialBpm = Number($('chart-bpm').value);
    state.chart.timeSignature = [Number($('chart-ts-num').value) || 4, Number($('chart-ts-den').value) || 4];
    // 从表格读变速段
    state.chart.segments = [...$('seg-table').querySelectorAll('tbody tr')].map((tr) => ({
      beat: Number(tr.querySelector('.seg-beat').value),
      bpm: Number(tr.querySelector('.seg-bpm').value),
    })).filter((s) => s.beat > 0 && s.bpm > 0)
      .sort((a, b) => a.beat - b.beat);
    // 从表格读音符
    state.chart.notes = [...$('note-table').querySelectorAll('tbody tr')].map((tr) => {
      const n = {
        id: tr.querySelector('.note-id').value,
        type: tr.querySelector('.note-type').value,
        beat: Number(tr.querySelector('.note-beat').value),
        endBeat: tr.querySelector('.note-type').value === 'hold'
          ? Number(tr.querySelector('.note-end').value) : null,
      };
      return n;
    });
  }

  function renderSegTable() {
    const tb = $('seg-table').querySelector('tbody');
    const segs = state.chart.segments || [];
    tb.innerHTML = '';
    segs.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="seg-beat" type="number" step="0.5" value="${s.beat}"></td>
        <td><input class="seg-bpm" type="number" step="1" min="1" value="${s.bpm}"></td>
        <td class="seg-time"></td>
        <td><span class="row-del" title="删除">✕</span></td>`;
      tr.querySelector('.row-del').onclick = () => {
        state.chart.segments.splice(i, 1);
        afterChartChanged();
      };
      // 内联编辑只做软刷新，不重建表格，避免输入框失焦
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
        collectChart(); softRefresh();
      }));
      tb.appendChild(tr);
    });
    refreshSegTimes();
  }

  function refreshSegTimes() {
    const tl = E.buildTimeline(state.chart);
    $('seg-table').querySelectorAll('tbody tr').forEach((tr, i) => {
      const s = state.chart.segments[i];
      if (s) tr.querySelector('.seg-time').textContent = fmt(E.beatToTime(tl, s.beat)) + 's';
    });
  }

  function renderNoteTable() {
    const tb = $('note-table').querySelector('tbody');
    tb.innerHTML = '';
    (state.chart.notes || []).forEach((n, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input class="note-id" value="${n.id ?? ''}" style="width:52px"></td>
        <td>
          <select class="note-type">
            <option value="tap" ${n.type !== 'hold' ? 'selected' : ''}>单点</option>
            <option value="hold" ${n.type === 'hold' ? 'selected' : ''}>长按</option>
          </select>
        </td>
        <td><input class="note-beat" type="number" step="0.25" value="${n.beat}" style="width:62px"></td>
        <td><input class="note-end" type="number" step="0.25" value="${n.endBeat ?? ''}"
             style="width:62px" ${n.type === 'hold' ? '' : 'disabled'}></td>
        <td class="note-time"></td>
        <td><span class="row-del" title="删除">✕</span></td>`;
      tr.querySelector('.row-del').onclick = () => {
        state.chart.notes.splice(i, 1);
        afterChartChanged();
      };
      // 类型切换属于结构变化，整表重建；beat/id/endBeat 的内联编辑走软刷新
      tr.querySelector('.note-type').onchange = () => {
        collectChart();
        afterChartChanged();
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('change', () => {
        collectChart(); softRefresh();
      }));
      tb.appendChild(tr);
    });
    refreshNoteTimes();
  }

  function refreshNoteTimes() {
    const tl = E.buildTimeline(state.chart);
    const prepped = E.prepareNotes(state.chart, tl);
    const startById = new Map(prepped.map((n) => [String(n.id), n.startTime]));
    $('note-table').querySelectorAll('tbody tr').forEach((tr, i) => {
      const n = state.chart.notes[i];
      if (n) tr.querySelector('.note-time').textContent = fmt(startById.get(String(n.id))) + 's';
    });
  }

  function renderValidation() {
    const v = E.validateChart(state.chart);
    const box = $('validation');
    box.innerHTML =
      v.errors.map((m) => `<div class="err">✕ ${m}</div>`).join('') +
      v.warnings.map((m) => `<div class="warn">⚠ ${m}</div>`).join('');
    return v;
  }

  function renderSkipBox() {
    const box = $('sim-skips');
    const notes = E.prepareNotes(state.chart, E.buildTimeline(state.chart));
    box.innerHTML = notes.map((n) =>
      `<label><input type="checkbox" class="skip-chk" value="${n.id}"> ${n.id}</label>`).join('') ||
      '<span class="hint">暂无音符</span>';
  }

  /* 谱面结构性变化（增删/载入/程序化改 state）后的统一入口：
     state.chart 是唯一数据源，这里只重渲染 + 重新判定，绝不从 DOM 回读覆盖 state。 */
  function afterChartChanged() {
    renderValidation();
    renderSegTable();
    renderNoteTable();
    renderSkipBox();
    timeline.setData(state.chart, state.inputs, state.windowsA);
    rejudge();
  }

  /* 内联编辑（未增删行）：先把 DOM 字段收回 state，再刷新派生数据，保留表格 DOM 与输入焦点 */
  function softRefresh() {
    collectChart();
    renderValidation();
    refreshSegTimes();
    refreshNoteTimes();
    timeline.setData(state.chart, state.inputs, state.windowsA);
    rejudge();
  }

  /* ================================================================
   * 判定与结果呈现
   * ================================================================ */
  function rejudge() {
    const v = E.validateChart(state.chart);
    if (v.errors.length) {
      state.result = null;
      renderEvents();
      updateStats(null);
      return;
    }
    state.windowsA = readWindows('a');
    state.result = E.judge(state.chart, state.inputs, state.windowsA);
    timeline.setData(state.chart, state.inputs, state.windowsA);
    renderEvents();
    renderStrays();
    updateStats(state.result);
  }

  function renderEvents() {
    const tb = $('event-table').querySelector('tbody');
    if (!state.result) { tb.innerHTML = ''; return; }
    tb.innerHTML = state.result.events.map((ev) => {
      const dtCol = ev.dt == null ? '—' : dtPill(ev.dt);
      const kindName = {
        tap: '单点', 'hold-head': '长按头', 'hold-release': '长按尾', miss: '漏拍',
      }[ev.kind] || ev.kind;
      return `<tr>
        <td>${fmt(ev.time)}</td>
        <td>${ev.noteId}</td>
        <td>${kindName}</td>
        <td>${badge(ev.judgment, ev.dt || 0)}</td>
        <td>${dtCol}</td>
        <td>${ev.combo}</td>
        <td>+${ev.scoreDelta} / ${ev.totalScore}</td>
      </tr>`;
    }).join('');
  }

  function renderStrays() {
    const tb = $('stray-table').querySelector('tbody');
    const list = state.result ? state.result.strays : [];
    tb.innerHTML = list.length ? list.map((s) =>
      `<tr><td>${fmt(s.time)}</td><td>${s.type === 'down' ? 'down ▼' : 'up ▲'}</td><td>${s.reason}</td></tr>`
    ).join('') : '<tr><td colspan="3" class="hint">无</td></tr>';
  }

  function updateStats(r) {
    if (!r) {
      $('stat-score').textContent = '0';
      $('stat-combo').textContent = '0';
      $('stat-maxcombo').textContent = '0';
      $('stat-counts').innerHTML = '<b>—</b><span>判定计数</span>';
      return;
    }
    const s = r.summary;
    $('stat-score').textContent = s.score;
    $('stat-combo').textContent = '0';
    $('stat-maxcombo').textContent = s.maxCombo;
    $('stat-counts').innerHTML =
      `<b style="font-size:12px;line-height:1.7">
        <span style="color:var(--accent-2)">完美×${s.counts.perfect}</span><br>
        <span style="color:var(--accent)">良好×${s.counts.good}</span><br>
        <span style="color:var(--purple)">完成×${s.counts.complete}</span><br>
        <span style="color:#ff9f43">早松×${s.counts.early}</span><br>
        <span style="color:var(--danger)">漏拍×${s.counts.miss}</span>
      </b><span>判定计数</span>`;
  }

  /* ================================================================
   * 输入表
   * ================================================================ */
  function renderInputs() {
    const tb = $('input-table').querySelector('tbody');
    tb.innerHTML = state.inputs.map((inp, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><input class="inp-time" type="number" step="0.001" value="${inp.time.toFixed(3)}" style="width:78px"></td>
        <td>
          <select class="inp-type">
            <option value="down" ${inp.type === 'down' ? 'selected' : ''}>down ▼</option>
            <option value="up" ${inp.type === 'up' ? 'selected' : ''}>up ▲</option>
          </select>
        </td>
        <td><span class="row-del" title="删除">✕</span></td>
      </tr>`).join('');
    tb.querySelectorAll('.inp-time').forEach((el, i) =>
      el.addEventListener('change', () => {
        state.inputs[i].time = Math.max(0, Number(el.value));
        state.inputs.sort((a, b) => a.time - b.time);
        renderInputs(); rejudge();
      }));
    tb.querySelectorAll('.inp-type').forEach((el, i) =>
      el.addEventListener('change', () => { state.inputs[i].type = el.value; rejudge(); }));
    tb.querySelectorAll('.row-del').forEach((el, i) =>
      el.onclick = () => { state.inputs.splice(i, 1); renderInputs(); rejudge(); });
  }

  /* ================================================================
   * 模拟输入生成
   * ================================================================ */
  function generate() {
    const v = E.validateChart(state.chart);
    if (v.errors.length) { toast('谱面有错误，无法生成输入：' + v.errors[0], 'err'); return; }
    const skip = [...$('sim-skips').querySelectorAll('.skip-chk:checked')].map((c) => c.value);
    state.inputs = E.generateInputs(state.chart, {
      biasMs: Number($('sim-bias').value) || 0,
      jitterMs: Number($('sim-jitter').value) || 0,
      seed: Number($('sim-seed').value) || 1,
      holdEarlyMs: Number($('sim-hold-early').value) || 0,
      skip,
    });
    renderInputs();
    rejudge();
    toast(`已生成 ${state.inputs.length} 个输入事件（seed=${$('sim-seed').value}）`, 'ok');
  }

  /* ================================================================
   * 回放（确定性：输入与死线都按记录时刻触发，结果与离线 judge 一致）
   * ================================================================ */
  function play(fromTime) {
    const v = E.validateChart(state.chart);
    if (v.errors.length) { toast('谱面有错误，无法回放', 'err'); return; }
    stopPlayback(false);
    if (state.result == null) rejudge();
    const start = fromTime || 0;
    const ctx = audio.ensure();
    state.playing = true;
    state.startCtxAt = ctx.currentTime + 0.06;
    state.startSimAt = start;
    state.lastSimTime = start;
    state.nextAudioIdx = state.inputs.findIndex((e) => e.time >= start - 1e-9);
    if (state.nextAudioIdx === -1) state.nextAudioIdx = state.inputs.length;
    state.nextMetBeat = 0;
    state.nextCueIdx = 0;
    $('btn-play').textContent = '❚❚ 回放中';
    tick();
  }

  function stopPlayback(resetHead) {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    state.playing = false;
    audio.stopAll();
    $('btn-play').textContent = '▶ 回放';
    if (resetHead !== false) {
      state.lastSimTime = 0;
      timeline.setPlayhead(0);
      $('transport-info').textContent = 't = 0.000s';
      $('stat-combo').textContent = '0';
    }
  }

  function tick() {
    if (!state.playing) return;
    const ctx = audio.ensure();
    const sim = state.startSimAt + (ctx.currentTime - state.startCtxAt);
    state.lastSimTime = sim;
    scheduleAudio(sim);
    timeline.setPlayhead(sim);
    // 实时连击/分数（直接从离线结果切片，保证与最终判定逐值一致）
    if (state.result) {
      const snap = E.stateAt(state.result, sim);
      $('stat-combo').textContent = snap.combo;
      $('stat-score').textContent = snap.score;
    }
    $('transport-info').textContent = `t = ${fmt(sim)}s`;
    const maxT = chartEndTime();
    if (sim >= maxT + 0.4) { stopPlayback(false); return; }
    state.rafId = requestAnimationFrame(tick);
  }

  /** 预调度 [sim, sim+AHEAD] 内的所有声音。 */
  function scheduleAudio(sim) {
    const ctx = audio.ensure();
    const horizon = sim + SCHED_AHEAD;
    const mapAt = (t) => state.startCtxAt + (t - state.startSimAt);

    // 节拍器：每个整数拍。nextMetBeat 先跳到覆盖起点的第一拍，避免负时刻空转
    const segs = E.buildTimeline(state.chart);
    const beatsPerBar = (state.chart.timeSignature || [4, 4])[0];
    if (state.nextMetBeat === 0 && state.startSimAt > 0) {
      state.nextMetBeat = Math.max(0, Math.ceil(E.timeToBeat(segs, state.startSimAt) - 1e-9));
    }
    while (true) {
      const b = state.nextMetBeat;
      const t = E.beatToTime(segs, b);
      if (t > horizon) break;
      if (t >= sim - 1e-9) {
        const when = mapAt(t);
        if (when >= ctx.currentTime - 0.01) audio.metronome(when, b % beatsPerBar === 0);
      }
      state.nextMetBeat++;
      if (b > 100000) break;
    }

    // 音符提示音
    const notes = E.prepareNotes(state.chart, segs);
    while (state.nextCueIdx < notes.length && notes[state.nextCueIdx].startTime < state.startSimAt - 1e-9) {
      state.nextCueIdx++;
    }
    while (state.nextCueIdx < notes.length) {
      const n = notes[state.nextCueIdx];
      if (n.startTime > horizon) break;
      if (n.startTime >= sim - 1e-9) {
        const when = mapAt(n.startTime);
        if (when >= ctx.currentTime - 0.01) {
          if (n.type === 'tap') audio.cueTap(when);
          else audio.cueHoldHead(when);
        }
      }
      if (n.type === 'hold' && n.endTime <= horizon) {
        const when = mapAt(n.endTime);
        if (when >= ctx.currentTime - 0.01) audio.cueHoldEnd(when);
      }
      state.nextCueIdx++;
    }

    // 输入回放音 + 判定结果音（判定时刻取自离线结果，保证所见即所判）
    while (state.nextAudioIdx < state.inputs.length) {
      const inp = state.inputs[state.nextAudioIdx];
      if (inp.time > horizon) break;
      if (inp.time >= sim - 1e-9) {
        const when = mapAt(inp.time);
        if (when >= ctx.currentTime - 0.01) {
          // 输入本身的机械声用轻噪声
          audio.noise(when, 0.03, 0.12, inp.type === 'down' ? 1800 : 1200);
        }
      }
      state.nextAudioIdx++;
    }
    if (state.result) {
      for (const ev of state.result.events) {
        if (ev.time >= sim - 1e-9 && ev.time <= horizon && ev._sounded !== true) {
          const when = mapAt(ev.time);
          if (when >= ctx.currentTime - 0.01) audio.judgeSound(ev.judgment, when);
          ev._sounded = true;
        }
      }
    }
  }

  function chartEndTime() {
    const notes = E.prepareNotes(state.chart, E.buildTimeline(state.chart));
    return notes.reduce((m, n) => Math.max(m, n.endTime || n.startTime), 0);
  }

  /* ---------------- 检查点 ---------------- */
  function setCheckpoint() {
    state.checkpoint = state.lastSimTime || 0;
    timeline.setCheckpoint(state.checkpoint);
    toast(`检查点已设在 t=${fmt(state.checkpoint)}s`, 'ok');
  }

  function seekToCheckpoint() {
    if (state.checkpoint == null) { toast('还没有设置检查点', 'err'); return; }
    if (!state.result) { toast('当前谱面无法判定，请先修正校验错误', 'err'); return; }
    // 清掉判定事件上的发声标记，使重放时该时刻之后的声音重新触发
    state.result.events.forEach((e) => { e._sounded = false; });
    const snap = E.stateAt(state.result, state.checkpoint);
    $('stat-combo').textContent = snap.combo;
    $('stat-score').textContent = snap.score;
    play(state.checkpoint);
    toast(`从检查点 t=${fmt(state.checkpoint)}s 重放同一批输入`, 'ok');
  }

  /* ---------------- 手动录制 ---------------- */
  function toggleRecordKey() {
    if (!state.playing) {
      // 未回放时录制没有谱面时间基准
      toast('请先开始回放，再在回放过程中录制输入', 'err');
      return;
    }
    const t = round3(state.lastSimTime);
    if (!state.recordHeld) {
      state.inputs.push({ time: t, type: 'down' });
      state.recordHeld = true;
    } else {
      state.inputs.push({ time: t, type: 'up' });
      state.recordHeld = false;
    }
    state.inputs.sort((a, b) => a.time - b.time);
    renderInputs();
    rejudge();
  }
  const round3 = (x) => Math.round(x * 1000) / 1000;

  /* ================================================================
   * 双窗口对照
   * ================================================================ */
  function runCompare() {
    const v = E.validateChart(state.chart);
    if (v.errors.length) { toast('谱面有错误', 'err'); return; }
    state.windowsA = readWindows('a');
    state.windowsB = readWindows('b');
    const cmp = E.compareWindows(state.chart, state.inputs, state.windowsA, state.windowsB);
    $('compare-summary').innerHTML =
      `共 ${cmp.rows.length} 个音符，分歧 <b style="color:var(--warn)">${cmp.divergentCount}</b> 个　|　` +
      `A 总分 <b>${cmp.resultA.summary.score}</b> / 最大连击 ${cmp.resultA.summary.maxCombo}　` +
      `B 总分 <b>${cmp.resultB.summary.score}</b> / 最大连击 ${cmp.resultB.summary.maxCombo}`;

    const cell = (nr, part) => {
      const j = nr[part];
      if (!j) return part === 'head' ? '<span class="badge miss">漏拍</span>' : '—';
      return `${badge(j.judgment, j.dt)} ${dtPill(j.dt)}`;
    };
    $('compare-table').querySelector('tbody').innerHTML = cmp.rows.map((r) => `
      <tr class="${r.divergent ? 'divergent' : ''}">
        <td>${r.noteId}${r.type === 'hold' ? ' (长按)' : ''}</td>
        <td>${r.beat}</td>
        <td>${cell(r.a, 'head')}</td>
        <td>${cell(r.a, 'release')}</td>
        <td>${cell(r.b, 'head')}</td>
        <td>${cell(r.b, 'release')}</td>
      </tr>`).join('');
    // 对照后 A 窗口参数可能改变，刷新主判定
    rejudge();
    toast(cmp.divergentCount ? `发现 ${cmp.divergentCount} 个分歧音符，已高亮` : '两组窗口判定完全一致',
      cmp.divergentCount ? '' : 'ok');
  }

  /* ================================================================
   * 存档 / 文件
   * ================================================================ */
  function buildSave() {
    collectChart();
    return {
      format: 'rhythm-debug-console/v1',
      savedAt: new Date().toISOString(),
      chart: state.chart,
      inputs: state.inputs,
      windowsA: readWindows('a'),
      windowsB: readWindows('b'),
    };
  }

  function applySave(save) {
    if (!save || save.format !== 'rhythm-debug-console/v1' || !save.chart) {
      throw new Error('文件格式不识别（需要 rhythm-debug-console/v1）');
    }
    state.chart = save.chart;
    state.inputs = save.inputs || [];
    if (save.windowsA) Object.assign(state.windowsA, save.windowsA);
    if (save.windowsB) Object.assign(state.windowsB, save.windowsB);
    writeWindowInputs('a', state.windowsA);
    writeWindowInputs('b', state.windowsB);
    state.checkpoint = null;
    timeline.setCheckpoint(null);
    $('new-note-type').value = 'tap';
    $('new-note-beat').value = '';
    $('new-note-end').value = '';
    $('new-note-end').disabled = true;
    syncChartForm();
    renderInputs();
    afterChartChanged();
  }

  function writeWindowInputs(prefix, w) {
    $('win-' + prefix + '-name').value = w.name;
    $('win-' + prefix + '-perfect').value = w.perfectMs;
    $('win-' + prefix + '-late').value = w.lateMs;
    $('win-' + prefix + '-release').value = w.releaseMs;
  }

  function saveToStorage() {
    const save = buildSave();
    const key = STORAGE_PREFIX + (save.chart.name || '未命名') + '-' + Date.now();
    localStorage.setItem(key, JSON.stringify(save));
    renderSaveList();
    toast('已存入浏览器 localStorage', 'ok');
  }

  function renderSaveList() {
    const box = $('save-list');
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_PREFIX)).sort().reverse();
    if (!keys.length) { box.innerHTML = '<span class="hint">暂无存档</span>'; return; }
    box.innerHTML = keys.map((k) => {
      const save = JSON.parse(localStorage.getItem(k));
      const c = save.chart;
      return `<div class="save-item">
        <div><b>${c.name || '未命名'}</b></div>
        <div class="meta">${save.savedAt.replace('T', ' ').slice(0, 19)} ·
          ${(c.notes || []).length} 音符 · ${(save.inputs || []).length} 输入 ·
          ${(c.segments || []).length} 变速段</div>
        <div class="actions">
          <button class="btn btn-mini btn-primary act-load" data-k="${k}">载入</button>
          <button class="btn btn-mini act-replay" data-k="${k}">载入并一键回放</button>
          <button class="btn btn-mini danger act-del" data-k="${k}">删除</button>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('.act-load').forEach((b) => b.onclick = () => {
      try { applySave(JSON.parse(localStorage.getItem(b.dataset.k))); toast('存档已载入', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    });
    box.querySelectorAll('.act-replay').forEach((b) => b.onclick = () => {
      try { applySave(JSON.parse(localStorage.getItem(b.dataset.k))); setTimeout(() => play(0), 80); }
      catch (e) { toast(e.message, 'err'); }
    });
    box.querySelectorAll('.act-del').forEach((b) => b.onclick = () => {
      localStorage.removeItem(b.dataset.k); renderSaveList();
    });
  }

  function exportFile() {
    const save = buildSave();
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (save.chart.name || 'rhythm-chart').replace(/[\\/:*?"<>|\s]+/g, '_') + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('JSON 已导出', 'ok');
  }

  /* ================================================================
   * 事件绑定
   * ================================================================ */
  function bind() {
    // 谱面头字段：DOM 编辑，先收回 state 再刷新
    ['chart-name', 'chart-bpm', 'chart-ts-num', 'chart-ts-den'].forEach((id) =>
      $(id).addEventListener('change', softRefresh));

    $('btn-add-seg').onclick = () => {
      const lastBeat = (state.chart.segments || []).reduce((m, s) => Math.max(m, s.beat), 4);
      state.chart.segments = state.chart.segments || [];
      state.chart.segments.push({ beat: lastBeat + 4, bpm: (state.chart.segments.length ? 140 : state.chart.initialBpm + 40) });
      afterChartChanged();
    };

    $('btn-confirm-note').onclick = () => {
      const type = $('new-note-type').value;
      const beat = Number($('new-note-beat').value);
      const endBeat = Number($('new-note-end').value);
      if (!(beat >= 0)) { toast('请填写有效的 beat', 'err'); return; }
      if (type === 'hold' && !(endBeat > beat)) { toast('长按 endBeat 必须大于 beat', 'err'); return; }
      // state 是唯一数据源，直接追加；id 全局递增避免增删后撞 id
      const used = new Set((state.chart.notes || []).map((n) => String(n.id)));
      let seq = (state.chart.notes || []).length + 1;
      let id;
      do { id = 'n' + seq++; } while (used.has(id));
      state.chart.notes.push({ id, type, beat, endBeat: type === 'hold' ? endBeat : null });
      $('new-note-beat').value = '';
      $('new-note-end').value = '';
      afterChartChanged();
      const v = E.validateChart(state.chart);
      if (v.errors.length) toast('已加入，但谱面存在校验错误：' + v.errors[0], 'err');
    };
    $('new-note-type').onchange = (ev) => {
      $('new-note-end').disabled = ev.target.value !== 'hold';
    };

    // 模拟输入
    $('btn-generate').onclick = generate;
    $('btn-clear-inputs').onclick = () => {
      state.inputs = []; renderInputs(); rejudge(); toast('输入已清空');
    };

    // 窗口参数改动即刷新主判定窗显示
    ['a', 'b'].forEach((p) => ['name', 'perfect', 'late', 'release'].forEach((k) =>
      $('win-' + p + '-' + k).addEventListener('change', () => {
        if (p === 'a') rejudge();
      })));
    $('btn-compare').onclick = runCompare;

    // 回放
    $('btn-play').onclick = () => state.playing ? stopPlayback(true) : play(0);
    $('btn-stop').onclick = () => stopPlayback(true);
    $('btn-checkpoint-set').onclick = setCheckpoint;
    $('btn-checkpoint-seek').onclick = seekToCheckpoint;
    $('record-mode').onchange = (ev) => {
      if (!ev.target.checked) state.recordHeld = false;
    };

    // 时间轴拖动定位
    timeline.onSeek = (t) => {
      if (state.playing) {
        // 拖动即移动回放起点：从新位置继续
        if (state.result) state.result.events.forEach((e) => { e._sounded = false; });
        play(t);
      } else {
        state.lastSimTime = t;
        timeline.setPlayhead(t);
        $('transport-info').textContent = `t = ${fmt(t)}s`;
        if (state.result) {
          const snap = E.stateAt(state.result, t);
          $('stat-combo').textContent = snap.combo;
          $('stat-score').textContent = snap.score;
        }
      }
    };

    // 空格：录制模式下记录 down/up，否则播放/停止
    window.addEventListener('keydown', (ev) => {
      if (ev.code !== 'Space' || ev.repeat) return;
      const tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      ev.preventDefault();
      if ($('record-mode').checked) toggleRecordKey();
      else state.playing ? stopPlayback(true) : play(0);
    });

    // 存档
    $('btn-store-save').onclick = saveToStorage;
    $('btn-store-refresh').onclick = renderSaveList;
    $('btn-save-file').onclick = exportFile;
    $('btn-load-file').onclick = () => $('file-import').click();
    $('file-import').onchange = (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try { applySave(JSON.parse(reader.result)); toast(`已导入 ${file.name}`, 'ok'); }
        catch (e) { toast('导入失败：' + e.message, 'err'); }
      };
      reader.readAsText(file);
      ev.target.value = '';
    };

    // 示例
    $('btn-sample').onclick = () => loadExample(E.sampleChart(), true);
    $('btn-adjacent').onclick = () => loadExample(E.adjacentChart(), false);

    // 声音开关
    $('btn-sound').onclick = () => {
      audio.enabled = !audio.enabled;
      $('btn-sound').textContent = '声音:' + (audio.enabled ? '开' : '关');
      if (!audio.enabled) audio.stopAll();
    };

    // 引擎自测
    $('btn-selftest').onclick = () => {
      const r = E.selftest();
      if (r.pass) toast(`引擎自测全部通过（${r.results.length} 项）`, 'ok');
      else toast('自测失败：' + r.results.filter((x) => !x.pass).map((x) => x.name).join('；'), 'err');
    };

    // tabs
    document.querySelectorAll('.tab').forEach((t) => t.onclick = () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tab-pane').forEach((p) =>
        p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
    });

    window.addEventListener('resize', () => {
      timeline._resize(); timeline.draw();
    });
  }

  function loadExample(chart, withInputs) {
    stopPlayback(true);
    state.chart = chart;
    state.checkpoint = null;
    timeline.setCheckpoint(null);
    // 重置“新加音符”表单，避免残留值导致后续加入校验失败
    $('new-note-type').value = 'tap';
    $('new-note-beat').value = '';
    $('new-note-end').value = '';
    $('new-note-end').disabled = true;
    if (withInputs) {
      // 综合示例：整体偏晚 40ms、抖动 ±20ms，另让一个音符漏拍，便于观察分歧
      state.inputs = E.generateInputs(chart, { biasMs: 40, jitterMs: 20, seed: 7, skip: ['t5'] });
    } else {
      // 相邻单点：正中一个输入，演示一次输入不会算两次
      const notes = E.prepareNotes(chart, E.buildTimeline(chart));
      state.inputs = [
        { time: round3(notes[0].startTime + 0.075), type: 'down' },
        { time: round3(notes[0].startTime + 0.2), type: 'up' },
      ];
    }
    syncChartForm();
    renderInputs();
    afterChartChanged();
    toast('示例已载入，点“▶ 回放”或按空格一键走完', 'ok');
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    timeline = new window.Timeline($('timeline'), E);
    writeWindowInputs('a', state.windowsA);
    writeWindowInputs('b', state.windowsB);
    bind();
    syncChartForm();
    // 启动即生成一套示例输入，打开就能回放
    state.inputs = E.generateInputs(state.chart, { biasMs: 40, jitterMs: 20, seed: 7, skip: ['t5'] });
    renderInputs();
    afterChartChanged();
    renderSaveList();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
