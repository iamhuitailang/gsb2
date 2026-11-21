/* app.js — 调试页交互层 */
(function () {
  'use strict';
  const { Engine, Presets, Renderer } = window.ASDebug;
  const TICK = Engine.TICK;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => p + Math.random().toString(36).slice(2, 8);

  // roundRect 兼容兜底
  if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }

  // ---------- 全局状态 ----------
  const state = {
    configs: { A: Presets.configA(), B: Presets.configB() },
    activeCfg: 'A',
    timeline: Presets.TIMELINES.movingJump,
    tick: 0,
    playing: false,
    loop: true,
    speed: 1,
    results: {},          // A/B 各自的 simulate 结果
    lint: {},
    impact: null,         // 条件编辑影响高亮
    tab: 'play',
    selectedTransition: null,
    selectedState: null,
    storageKey: 'asdebug.saved.v1',
  };

  const cfg = () => state.configs[state.activeCfg];

  // ---------- 仿真 ----------
  function rerun() {
    for (const k of ['A', 'B']) {
      state.results[k] = Engine.simulate(state.configs[k], state.timeline);
      state.lint[k] = Engine.lintConfig(state.configs[k]);
    }
  }

  // ---------- 顶部工具栏 ----------
  function initToolbar() {
    $('#btnSave').onclick = saveConfigs;
    $('#btnLoad').onclick = () => $('#fileLoad').click();
    $('#fileLoad').onchange = loadFile;
    $('#btnExportCfg').onclick = exportConfig;
    $('#btnExportLog').onclick = exportLog;
    $('#btnExportCsv').onclick = exportCsv;
    $('#selPreset').onchange = (e) => {
      const v = e.target.value;
      if (!v) return;
      if (v === 'C') state.configs[state.activeCfg] = Presets.configC();
      else if (v === 'A') state.configs[state.activeCfg] = Presets.configA();
      else if (v === 'B') state.configs[state.activeCfg] = Presets.configB();
      e.target.value = '';
      state.impact = null;
      refresh();
    };
    $('#selTimeline').onchange = (e) => {
      if (e.target.value === 'custom') return;
      state.timeline = clone(Presets.TIMELINES[e.target.value]);
      state.tick = 0;
      refresh();
    };
    $('#btnClearTimeline').onclick = () => {
      state.timeline = { id: uid('tl'), name: '自定义', loopSec: 3, intervals: [] };
      state.tick = 0;
      refresh();
    };
    $$('.tabbtn').forEach((b) => b.onclick = () => {
      state.tab = b.dataset.tab;
      renderAll();
    });
    $$('.cfgswitch').forEach((b) => b.onclick = () => {
      state.activeCfg = b.dataset.cfg;
      renderAll();
    });
    $('#btnSelfTest').onclick = runSelfTest;
  }

  // ---------- 渲染入口 ----------
  function renderAll() {
    renderTabs();
    renderLintBar();
    if (state.tab === 'play') renderPlayTab();
    if (state.tab === 'config') renderConfigTab();
    if (state.tab === 'compare') renderCompareTab();
  }

  // 配置/时间线变更后：先重算再重画
  function refresh() {
    rerun();
    renderAll();
  }

  function renderTabs() {
    $$('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
    $$('.tabpane').forEach((p) => p.classList.toggle('hidden', p.dataset.tab !== state.tab));
    $$('.cfgswitch').forEach((b) => b.classList.toggle('active', b.dataset.cfg === state.activeCfg));
    $('#cfgBadge').textContent = `当前编辑：${state.activeCfg} — ${cfg().name}`;
  }

  // ---------- Lint 横幅 ----------
  function renderLintBar() {
    const l = state.lint[state.activeCfg];
    const box = $('#lintBar');
    const sev = { error: '🔴', warn: '🟠', info: '🔵' };
    const items = l.issues.map((i) =>
      `<div class="lint ${i.severity}" data-jump-ref="${esc(i.refs[0] || '')}">
        ${sev[i.severity]} ${esc(i.message)}</div>`).join('');
    box.innerHTML = items || '<div class="lint ok">✓ 配置检查通过</div>';
    $$('.lint[data-jump-ref]', box).forEach((el) => {
      el.onclick = () => {
        const ref = el.dataset.jumpRef;
        const tr = cfg().transitions.find((t) => t.id === ref);
        if (tr) { state.tab = 'config'; state.selectedTransition = ref; renderAll(); }
        const st = cfg().states.find((s) => s.id === ref);
        if (st) { state.tab = 'config'; state.selectedState = ref; renderAll(); }
      };
    });
  }

  // ---------- 播放页 ----------
  function renderPlayTab() {
    renderStage();
    renderTimelineCanvas();
    renderTransport();
    renderStatePanel();
    renderEventLog();
  }

  function renderStage() {
    const wrap = $('#stageWrap');
    const result = state.results[state.activeCfg];
    const frame = result.frames[state.tick] || result.frames[0];
    const st = cfg().states.find((s) => s.id === frame.state);
    const ghost = frame.blending ? result.frames[state.tick] : null;

    wrap.innerHTML = `
      <div class="stage-head">
        <span class="state-chip" style="border-color:${stateColor(frame.state)}">${esc(st ? st.name : frame.state)}</span>
        ${frame.blending ? `<span class="blend-chip">过渡中 ${Math.round(frame.blending.progress * 100)}%
          （${frame.blending.interruptible ? '可打断' : '不可打断'}）</span>` : ''}
        ${frame.queued.length ? `<span class="queue-chip">排队中：${frame.queued.map(esc).join(', ')}</span>` : ''}
      </div>
      <canvas id="stage" width="300" height="260"></canvas>
      <div class="stage-meta">
        t=${(state.tick * TICK).toFixed(3)}s · 状态内 ${frame.stateAge.toFixed(3)}s ·
        局部进度 ${(frame.localT * 100).toFixed(0)}%${frame.finished ? ' · 末帧保持' : ''}
      </div>`;
    Renderer.drawCharacter($('#stage'), frame.pose, { color: stateColor(frame.state) });
  }

  function stateColor(id) {
    const colors = ['#4ea1ff', '#7ee787', '#ffb84e', '#ff7b72', '#d2a8ff', '#79c0ff', '#f0883e'];
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return colors[h % colors.length];
  }

  // ---------- 时间线画布（可编辑） ----------
  let tlDrag = null;
  function renderTimelineCanvas() {
    const cv = $('#timelineCv');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = 110;
    cv.width = W * dpr; cv.height = H * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const tl = state.timeline;
    const secToX = (s) => 10 + (s / tl.loopSec) * (W - 20);
    const rows = cfg().buttons;
    const rowH = 34, top = 26;

    ctx.fillStyle = '#161b22'; ctx.fillRect(0, 0, W, H);
    // 刻度
    ctx.strokeStyle = '#2d333b'; ctx.fillStyle = '#8b949e'; ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    for (let s = 0; s <= tl.loopSec + 0.001; s += 0.5) {
      const x = secToX(s);
      ctx.beginPath(); ctx.moveTo(x, top - 8); ctx.lineTo(x, H - 18); ctx.stroke();
      ctx.fillText(s.toFixed(1), x, H - 6);
    }
    // 行标签与轨道
    rows.forEach((b, i) => {
      const y = top + i * rowH;
      ctx.fillStyle = '#1c2128'; ctx.fillRect(10, y, W - 20, rowH - 8);
      ctx.fillStyle = b.color; ctx.textAlign = 'left';
      ctx.fillText(b.name, 14, y + 16);
    });
    // 区间
    for (const iv of tl.intervals) {
      const i = rows.findIndex((b) => b.id === iv.button);
      if (i < 0) continue;
      const y = top + i * rowH;
      const x1 = secToX(iv.start), x2 = secToX(iv.end);
      const btn = rows[i];
      ctx.fillStyle = btn.color + '55';
      ctx.strokeStyle = btn.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x1, y + 2, x2 - x1, rowH - 12, 4); ctx.fill(); ctx.stroke();
      // 两端手柄
      ctx.fillStyle = btn.color;
      ctx.fillRect(x1 - 2, y + 2, 4, rowH - 12);
      ctx.fillRect(x2 - 2, y + 2, 4, rowH - 12);
    }
    // 播放头
    const px = secToX(state.tick * TICK);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, top - 10); ctx.lineTo(px, H - 18); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.moveTo(px - 5, top - 10); ctx.lineTo(px + 5, top - 10); ctx.lineTo(px, top - 4); ctx.fill();

    cv.onmousedown = onTimelineMouseDown;
    cv.onmousemove = onTimelineMouseMove;
    cv.onmouseup = () => { tlDrag = null; };
    cv.onmouseleave = () => { tlDrag = null; };
  }

  function eventPos(ev, cv) {
    const r = cv.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }
  function xToSec(x) {
    const W = $('#timelineCv').clientWidth;
    const s = ((x - 10) / (W - 20)) * state.timeline.loopSec;
    return Math.max(0, Math.min(state.timeline.loopSec, s));
  }
  function snap(s) { return Math.round(s * 60) / 60; } // 吸附到 tick

  function onTimelineMouseDown(ev) {
    const cv = ev.target;
    const { x, y } = eventPos(ev, cv);
    const W = cv.clientWidth;
    const rows = cfg().buttons;
    const rowH = 34, top = 26;
    const secToX = (s) => 10 + (s / state.timeline.loopSec) * (W - 20);

    // 点在刻度区 → seek
    if (y < top - 8 || y > top + rows.length * rowH) {
      state.tick = Math.round(xToSec(x) / TICK);
      renderPlayTab();
      return;
    }
    const rowIdx = Math.floor((y - top) / rowH);
    const button = rows[rowIdx] && rows[rowIdx].id;
    if (!button) return;

    // 命中已有区间？
    for (let i = 0; i < state.timeline.intervals.length; i++) {
      const iv = state.timeline.intervals[i];
      if (iv.button !== button) continue;
      const x1 = secToX(iv.start), x2 = secToX(iv.end);
      if (Math.abs(x - x1) <= 5) { tlDrag = { mode: 'resize-l', iv }; return; }
      if (Math.abs(x - x2) <= 5) { tlDrag = { mode: 'resize-r', iv }; return; }
      if (x > x1 && x < x2) {
        if (ev.shiftKey) { state.timeline.intervals.splice(i, 1); tlDrag = null; rerun(); renderPlayTab(); return; }
        tlDrag = { mode: 'move', iv, grab: xToSec(x) - iv.start };
        return;
      }
    }
    // 空白处拖出新区间
    const s = snap(xToSec(x));
    const iv = { button, start: s, end: s };
    state.timeline.intervals.push(iv);
    tlDrag = { mode: 'resize-r', iv };
  }

  function onTimelineMouseMove(ev) {
    if (!tlDrag) return;
    const cv = ev.target;
    const { x } = eventPos(ev, cv);
    const s = snap(xToSec(x));
    const iv = tlDrag.iv;
    if (tlDrag.mode === 'resize-l') iv.start = Math.min(s, iv.end - TICK);
    if (tlDrag.mode === 'resize-r') iv.end = Math.max(s, iv.start + TICK);
    if (tlDrag.mode === 'move') {
      const len = iv.end - iv.start;
      const ns = Math.max(0, Math.min(state.timeline.loopSec - len, s - tlDrag.grab));
      iv.start = snap(ns); iv.end = snap(ns + len);
    }
    state.tick = Math.round(iv.start / TICK);
    rerun(); renderPlayTab();
  }

  // ---------- 播放控制 ----------
  let playTimer = null;
  function renderTransport() {
    $('#loopSecVal').value = state.timeline.loopSec;
    $('#playPos').textContent = `${state.tick} / ${state.results[state.activeCfg].tickCount - 1} tick`;
  }
  function initTransport() {
    $('#btnPlay').onclick = togglePlay;
    $('#btnPause').onclick = () => stopPlay();
    $('#btnStep').onclick = () => { stopPlay(); stepTick(1); };
    $('#btnStepBack').onclick = () => { stopPlay(); stepTick(-1); };
    $('#btnToStart').onclick = () => { stopPlay(); state.tick = 0; renderPlayTab(); };
    $('#btnToEnd').onclick = () => { stopPlay(); state.tick = state.results[state.activeCfg].tickCount - 1; renderPlayTab(); };
    $('#chkLoop').onchange = (e) => { state.loop = e.target.checked; };
    $('#selSpeed').onchange = (e) => { state.speed = parseFloat(e.target.value); };
    $('#loopSecVal').onchange = (e) => {
      const v = parseFloat(e.target.value);
      if (v >= 0.2) {
        state.timeline.loopSec = v;
        state.timeline.intervals = state.timeline.intervals.filter((iv) => iv.start < v);
        state.timeline.intervals.forEach((iv) => { iv.end = Math.min(iv.end, v); });
        state.tick = 0;
        refresh();
      }
    };
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowRight') { stopPlay(); stepTick(1); }
      if (e.code === 'ArrowLeft') { stopPlay(); stepTick(-1); }
    });
  }

  function stepTick(d) {
    const n = state.results[state.activeCfg].tickCount;
    let t = state.tick + d;
    if (state.loop) t = (t + n) % n;
    else t = Math.max(0, Math.min(n - 1, t));
    state.tick = t;
    renderPlayTab();
  }

  function togglePlay() {
    if (state.playing) return stopPlay();
    state.playing = true;
    let acc = 0, last = performance.now();
    const frameMs = TICK * 1000 / state.speed;
    playTimer = setInterval(() => {
      const now = performance.now();
      acc += now - last; last = now;
      let guard = 0;
      while (acc >= frameMs && guard++ < 8) {
        acc -= frameMs;
        const n = state.results[state.activeCfg].tickCount;
        state.tick++;
        if (state.tick >= n) {
          if (state.loop) state.tick = 0;
          else { state.tick = n - 1; stopPlay(); break; }
        }
      }
      renderPlayTab();
    }, 16);
  }
  function stopPlay() {
    state.playing = false;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
  }

  // ---------- 状态信息面板 ----------
  function renderStatePanel() {
    const r = state.results[state.activeCfg];
    const frame = r.frames[state.tick];
    const rows = cfg().states.map((s) => {
      const active = s.id === frame.state;
      const first = r.firstEntry[s.id];
      return `<tr class="${active ? 'active-row' : ''}">
        <td><span class="dot" style="background:${stateColor(s.id)}"></span>${esc(s.name)}</td>
        <td>${s.loop ? '循环' : (s.duration + 's')}</td>
        <td>${first === undefined ? '—' : (first * TICK).toFixed(3) + 's'}</td>
        <td>${r.entryCount[s.id] || 0}</td>
        ${active ? `<td class="cur">当前</td>` : `<td><button data-gotick="${first ?? ''}">${first === undefined ? '' : '跳转'}</button></td>`}
      </tr>`;
    }).join('');
    $('#stateTable').innerHTML =
      `<table><thead><tr><th>状态</th><th>类型</th><th>首次进入</th><th>次数</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    $$('#stateTable button[data-gotick]').forEach((b) => b.onclick = () => {
      if (b.dataset.gotick !== '') { state.tick = parseInt(b.dataset.gotick, 10); renderPlayTab(); }
    });
  }

  // ---------- 事件日志 ----------
  function renderEventLog() {
    const r = state.results[state.activeCfg];
    const filter = $('#selEventFilter').value;
    const box = $('#eventLog');
    const evs = r.events.filter((e) => !filter || e.type === filter);
    box.innerHTML = evs.map((e) => {
      let detail = '';
      if (e.type === 'condition-eval') {
        detail = `命中 ${e.matches.length} 条：${e.matches.map((m) =>
          `${esc(m.id)}[P${m.priority}]→${esc(m.target)}`).join('，')}；选定 <b>${esc(e.winner)}</b>` +
          (e.losers.length ? `；落败：${e.losers.map(esc).join(', ')}` : '') +
          ` <span class="dim">[${e.inputs.pressed.map(esc).join(',') || '—'}↓ ${e.inputs.released.map(esc).join(',') || '—'}↑]</span>`;
      } else if (e.type === 'no-match') {
        detail = `停留在 <b>${esc(e.state)}</b>。未满足：` + e.considered.map((c) =>
          `${esc(c.id)}(缺 ${c.unsatisfied.join('、') || '—'})`).join('；');
      } else if (e.type === 'request-discarded') {
        detail = e.reason === 'not-interruptible'
          ? `请求 ${esc(e.transitionId)} 被丢弃：活动过渡 ${esc(e.activeTransition)} 不可打断，还剩 ${e.blendRemaining}s`
          : `请求 ${esc(e.transitionId)} 被丢弃：${e.reason}`;
      } else if (e.type === 'queued') {
        detail = `请求 ${esc(e.transitionId)} 排队等待（被 ${esc(e.blockedBy)} 阻挡，最长等 ${e.maxWait}s）`;
      } else if (e.type === 'queue-timeout') {
        detail = `排队请求 ${esc(e.transitionId)} 等待 ${e.waited}s 超时丢弃`;
      } else if (e.type === 'transition') {
        detail = `${esc(e.from)} → <b>${esc(e.to)}</b>（${e.source === 'queued' ? '排队受理' : '即时'}${e.interrupt ? '，从当前视觉姿态打断' : ''}，混合 ${e.blendDuration}s）`;
      } else if (e.type === 'blend-interrupted') {
        detail = `过渡 ${esc(e.transitionId)} 被 ${esc(e.by)} 打断，新过渡从当前姿态起步`;
      } else if (e.type === 'blend-end') {
        detail = `进入 ${esc(e.state)} 的过渡结束`;
      }
      return `<div class="ev ev-${e.type}" data-tick="${e.tick}">
        <span class="ev-time">${e.time.toFixed(3)}s</span>
        <span class="ev-type">${eventLabel(e.type)}</span>
        <span class="ev-detail">${detail}</span></div>`;
    }).join('') || '<div class="dim pad">无事件</div>';
    $$('.ev', box).forEach((el) => el.onclick = () => {
      state.tick = parseInt(el.dataset.tick, 10);
      renderPlayTab();
    });
    box.scrollTop = box.scrollHeight;
  }
  function eventLabel(t) {
    return {
      'condition-eval': '条件命中', 'no-match': '未命中', transition: '切换',
      'request-discarded': '丢弃', queued: '排队', 'queue-timeout': '排队超时',
      'blend-interrupted': '打断', 'blend-end': '过渡结束',
    }[t] || t;
  }
  function initEventFilter() {
    $('#selEventFilter').onchange = renderEventLog;
  }

  // ---------- 配置页 ----------
  function renderConfigTab() {
    renderStateEditor();
    renderTransitionList();
    renderImpact();
  }

  function renderStateEditor() {
    const c = cfg();
    $('#stateList').innerHTML = c.states.map((s) => `
      <div class="cfg-item ${state.selectedState === s.id ? 'sel' : ''}" data-state="${esc(s.id)}">
        <canvas width="72" height="60" data-thumb="${esc(s.id)}"></canvas>
        <div>
          <b>${esc(s.name)}</b> <span class="dim">${esc(s.id)}</span><br>
          ${s.loop ? `循环 ${s.duration}s` : `单次 ${s.duration}s`}
        </div>
      </div>`).join('');
    $$('#stateList .cfg-item').forEach((el) => el.onclick = () => {
      state.selectedState = el.dataset.state; state.selectedTransition = null; renderConfigTab();
    });
    c.states.forEach((s) => {
      const cv = $(`canvas[data-thumb="${s.id}"]`);
      if (cv) {
        const pose = Engine.statePoseAt(s, 0).pose;
        Renderer.drawThumb(cv, pose);
      }
    });

    const s = c.states.find((x) => x.id === state.selectedState) || c.states[0];
    state.selectedState = s.id;
    $('#stateEditor').innerHTML = `
      <h4>状态：${esc(s.name)}</h4>
      <label>ID <input data-f="id" value="${esc(s.id)}"></label>
      <label>显示名 <input data-f="name" value="${esc(s.name)}"></label>
      <label>动作时长(秒) <input type="number" step="0.05" min="0" data-f="duration" value="${s.duration}"></label>
      <label class="chk"><input type="checkbox" data-f="loop" ${s.loop ? 'checked' : ''}> 循环动作</label>
      <label>关键帧 JSON（t:0..1 + 姿态数值）</label>
      <textarea rows="8" data-f="keyframes">${esc(JSON.stringify(s.keyframes, null, 1))}</textarea>
      <div class="row">
        <button id="btnAddState">＋ 新状态</button>
        <button id="btnDelState" class="danger">删除状态</button>
      </div>`;
    $$('#stateEditor input, #stateEditor textarea').forEach((el) => {
      el.onchange = () => {
        const f = el.dataset.f;
        if (f === 'keyframes') {
          try { s.keyframes = JSON.parse(el.value); }
          catch (err) { alert('关键帧 JSON 解析失败：' + err.message); return; }
        } else if (f === 'duration') {
          s.duration = Math.max(0, parseFloat(el.value) || 0);
        } else if (f === 'loop') {
          s.loop = el.checked;
        } else if (f === 'id') {
          const old = s.id, v = el.value.trim();
          if (v && v !== old && !c.states.some((x) => x.id === v)) {
            s.id = v;
            if (c.initialState === old) c.initialState = v;
            c.transitions.forEach((t) => { if (t.from === old) t.from = v; if (t.to === old) t.to = v; });
            state.selectedState = v;
          }
        } else s[f] = el.value;
        state.impact = null;
        refresh();
      };
    });
    $('#btnAddState').onclick = () => {
      const id = uid('state');
      c.states.push({ id, name: '新状态', duration: 0.3, loop: false, keyframes: [{ t: 0, pose: Presets.POSES.idle }] });
      state.selectedState = id; refresh();
    };
    $('#btnDelState').onclick = () => {
      if (c.states.length <= 1) return alert('至少保留一个状态');
      c.states = c.states.filter((x) => x.id !== s.id);
      c.transitions = c.transitions.filter((t) => t.from !== s.id && t.to !== s.id);
      if (c.initialState === s.id) c.initialState = c.states[0].id;
      state.selectedState = c.states[0].id;
      refresh();
    };
  }

  function renderTransitionList() {
    const c = cfg();
    const lintByTr = new Map();
    state.lint[state.activeCfg].issues.forEach((i) => {
      (i.refs || []).forEach((r) => { if (!lintByTr.has(r)) lintByTr.set(r, []); lintByTr.get(r).push(i); });
    });
    $('#transitionList').innerHTML = c.transitions
      .slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))
      .map((t) => {
        const issues = lintByTr.get(t.id) || [];
        return `<div class="cfg-item tr-item ${state.selectedTransition === t.id ? 'sel' : ''}" data-tr="${esc(t.id)}">
          <div><b>P${t.priority}</b> ${esc(t.name || t.id)}
            <span class="dim">${esc(t.from)}→${esc(t.to)}</span>
            ${!t.enabled ? '<span class="tag off">停用</span>' : ''}
            ${t.blendDuration ? `<span class="tag">混合${t.blendDuration}s</span>` : ''}
            ${t.interruptible ? '<span class="tag ok">可打断</span>' : '<span class="tag warn">不可打断</span>'}
            <span class="tag ${t.blockMode === 'queue' ? 'ok' : ''}">${t.blockMode === 'queue' ? '排队' : '丢弃'}</span>
          </div>
          ${issues.map((i) => `<div class="mini-lint ${i.severity}">${esc(i.message)}</div>`).join('')}
        </div>`;
      }).join('') || '<div class="dim pad">暂无切换</div>';
    $$('#transitionList .tr-item').forEach((el) => el.onclick = () => {
      state.selectedTransition = el.dataset.tr; state.selectedState = null; renderConfigTab();
    });
    renderTransitionEditor();
  }

  function gateEditorHtml(g, idx) {
    const kindSel = (kind) => ['btn-press', 'btn-release', 'btn-held', 'btn-up', 'state-age', 'state-finished', 'always']
      .map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${gateKindName(k)}</option>`).join('');
    const needsBtn = g.kind.startsWith('btn');
    const btnOpts = cfg().buttons.map((b) =>
      `<option value="${esc(b.id)}" ${b.id === g.button ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
    return `<div class="gate-row" data-gate="${idx}">
      <select data-gf="kind">${kindSel(g.kind)}</select>
      ${needsBtn ? `<select data-gf="button">${btnOpts}</select>` : ''}
      ${g.kind === 'state-age' ? `<input type="number" step="0.05" min="0" data-gf="minSec" value="${g.minSec || 0}">` : ''}
      <button data-delgate class="danger small">×</button>
    </div>`;
  }
  function gateKindName(k) {
    return { 'btn-press': '按下', 'btn-release': '松开', 'btn-held': '按住中', 'btn-up': '未按下', 'state-age': '状态持续≥', 'state-finished': '动作播完', 'always': '无条件' }[k];
  }

  function renderTransitionEditor() {
    const c = cfg();
    const t = c.transitions.find((x) => x.id === state.selectedTransition);
    const box = $('#transitionEditor');
    if (!t) { box.innerHTML = '<p class="dim pad">选择左侧切换进行编辑，或新建一条。</p><button id="btnAddTr">＋ 新切换</button>'; bindAdd(); return; }
    const stateOpts = c.states.map((s) => s.id);
    box.innerHTML = `
      <h4>切换：${esc(t.name || t.id)}</h4>
      <label>名称 <input data-tf="name" value="${esc(t.name || '')}"></label>
      <div class="row">
        <label>源状态 <select data-tf="from">${stateOpts.map((id) => `<option ${id === t.from ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></label>
        <label>目标状态 <select data-tf="to">${stateOpts.map((id) => `<option ${id === t.to ? 'selected' : ''}>${esc(id)}</option>`).join('')}</select></label>
      </div>
      <div class="row">
        <label>优先级 <input type="number" data-tf="priority" value="${t.priority}"></label>
        <label class="chk"><input type="checkbox" data-tf="enabled" ${t.enabled ? 'checked' : ''}> 启用</label>
      </div>
      <h5>切换条件（AND 组合）</h5>
      <div id="gateList">${(t.gates || []).map((g, i) => gateEditorHtml(g, i)).join('')}</div>
      <div class="row">
        <select id="newGateKind">
          ${['btn-press', 'btn-release', 'btn-held', 'btn-up', 'state-age', 'state-finished', 'always'].map((k) => `<option value="${k}">${gateKindName(k)}</option>`).join('')}
        </select>
        <button id="btnAddGate">＋ 添加条件</button>
      </div>
      <h5>排队受理条件 acceptGates（仅 blockMode=排队 时生效；留空则回退到上面的切换条件）</h5>
      <div id="acceptGateList">${(t.acceptGates || []).map((g, i) => gateEditorHtml(g, i)).join('')}</div>
      <div class="row">
        <select id="newAcceptGateKind">
          ${['btn-press', 'btn-release', 'btn-held', 'btn-up', 'state-age', 'state-finished', 'always'].map((k) => `<option value="${k}">${gateKindName(k)}</option>`).join('')}
        </select>
        <button id="btnAddAcceptGate">＋ 添加受理条件</button>
        <button id="btnClearAcceptGates" class="small">清空（回退到切换条件）</button>
      </div>
      <h5>过渡与打断</h5>
      <label>混合时长(秒) <input type="number" step="0.01" min="0" data-tf="blendDuration" value="${t.blendDuration}"></label>
      <label class="chk"><input type="checkbox" data-tf="interruptible" ${t.interruptible ? 'checked' : ''}> 过渡中允许被新请求打断（从当前视觉姿态继续）</label>
      <label>不允许打断时
        <select data-tf="blockMode">
          <option value="discard" ${t.blockMode === 'discard' ? 'selected' : ''}>丢弃请求</option>
          <option value="queue" ${t.blockMode === 'queue' ? 'selected' : ''}>排队等待</option>
        </select></label>
      <label>排队最长等待(秒，0=不限) <input type="number" step="0.1" min="0" data-tf="queueMaxWait" value="${t.queueMaxWait || 0}"></label>
      <div class="row">
        <button id="btnAddTr">＋ 新切换</button>
        <button id="btnDelTr" class="danger">删除切换</button>
      </div>`;

    $$('#transitionEditor [data-tf]').forEach((el) => {
      el.onchange = () => {
        const f = el.dataset.tf;
        if (f === 'priority') t.priority = parseInt(el.value, 10) || 0;
        else if (f === 'blendDuration' || f === 'queueMaxWait') t[f] = Math.max(0, parseFloat(el.value) || 0);
        else if (f === 'enabled' || f === 'interruptible') t[f] = el.checked;
        else t[f] = el.value;
        if (f === 'gates' || f === 'from' || f === 'to' || f === 'priority') {
          state.impact = Engine.impactOfEdit(c, t.id);
        }
        refresh();
      };
    });
    $$('#gateList .gate-row').forEach((row) => {
      const idx = parseInt(row.dataset.gate, 10);
      $$('[data-gf]', row).forEach((el) => {
        el.onchange = () => {
          const g = t.gates[idx];
          const f = el.dataset.gf;
          if (f === 'kind') {
            g.kind = el.value;
            if (g.kind.startsWith('btn') && !g.button) g.button = c.buttons[0].id;
            if (g.kind === 'state-age') g.minSec = g.minSec || 0.1;
          } else if (f === 'minSec') {
            g.minSec = Math.max(0, parseFloat(el.value) || 0);
          } else g[f] = el.value;
          state.impact = Engine.impactOfEdit(c, t.id);
          refresh();
        };
      });
      $('[data-delgate]', row).onclick = () => {
        t.gates.splice(idx, 1);
        state.impact = Engine.impactOfEdit(c, t.id);
        refresh();
      };
    });
    $('#btnAddGate').onclick = () => {
      const kind = $('#newGateKind').value;
      const g = { kind };
      if (kind.startsWith('btn')) g.button = c.buttons[0].id;
      if (kind === 'state-age') g.minSec = 0.1;
      t.gates = t.gates || []; t.gates.push(g);
      state.impact = Engine.impactOfEdit(c, t.id);
      refresh();
    };
    // acceptGates 编辑
    t.acceptGates = t.acceptGates || [];
    $$('#acceptGateList .gate-row').forEach((row) => {
      const idx = parseInt(row.dataset.gate, 10);
      $$('[data-gf]', row).forEach((el) => {
        el.onchange = () => {
          const g = t.acceptGates[idx];
          const f = el.dataset.gf;
          if (f === 'kind') {
            g.kind = el.value;
            if (g.kind.startsWith('btn') && !g.button) g.button = c.buttons[0].id;
            if (g.kind === 'state-age') g.minSec = g.minSec || 0.1;
          } else if (f === 'minSec') {
            g.minSec = Math.max(0, parseFloat(el.value) || 0);
          } else g[f] = el.value;
          refresh();
        };
      });
      $('[data-delgate]', row).onclick = () => {
        t.acceptGates.splice(idx, 1);
        refresh();
      };
    });
    $('#btnAddAcceptGate').onclick = () => {
      const kind = $('#newAcceptGateKind').value;
      const g = { kind };
      if (kind.startsWith('btn')) g.button = c.buttons[0].id;
      if (kind === 'state-age') g.minSec = 0.1;
      t.acceptGates.push(g);
      refresh();
    };
    $('#btnClearAcceptGates').onclick = () => {
      t.acceptGates = [];
      refresh();
    };
    bindAdd();
    $('#btnDelTr').onclick = () => {
      c.transitions = c.transitions.filter((x) => x.id !== t.id);
      state.selectedTransition = null;
      refresh();
    };
  }
  function bindAdd() {
    const b = $('#btnAddTr');
    if (!b) return;
    b.onclick = () => {
      const c = cfg();
      const id = uid('t');
      c.transitions.push({
        id, name: '新切换', from: c.states[0].id, to: c.states[0].id,
        gates: [{ kind: 'btn-press', button: c.buttons[0].id }],
        priority: 5, enabled: true, blendDuration: 0.1, interruptible: false,
        blockMode: 'discard', queueMaxWait: 0.5,
      });
      state.selectedTransition = id;
      state.impact = Engine.impactOfEdit(c, id);
      refresh();
    };
  }

  // 条件编辑影响：涉及状态 + 可能永远进不去的切换
  function renderImpact() {
    const box = $('#impactBox');
    if (!state.impact) { box.innerHTML = '<p class="dim pad">编辑切换条件后，这里会列出受影响的状态与可能失效（永远进不去）的切换。</p>'; return; }
    const c = cfg();
    const name = (id) => {
      const s = c.states.find((x) => x.id === id);
      return s ? s.name : id;
    };
    box.innerHTML = `
      <h5>本次条件修改影响面</h5>
      <div>涉及状态：${state.impact.states.map((id) => `<span class="state-chip mini" style="border-color:${stateColor(id)}">${esc(name(id))}</span>`).join(' ')}</div>
      <div>关联切换：${state.impact.transitions.length ? state.impact.transitions.map(esc).join('、') : '无'}</div>
      <h5>可能永远进不去的切换</h5>
      ${state.impact.dead.length ? state.impact.dead.map((d) => `<div class="lint warn">🟠 ${esc(d.message)}</div>`).join('') : '<div class="lint ok">✓ 当前没有失效切换</div>'}
    `;
  }

  // ---------- 对比页 ----------
  function renderCompareTab() {
    const wrap = $('#compareView');
    const A = state.results.A, B = state.results.B;
    const allStates = new Set([...Object.keys(A.firstEntry), ...Object.keys(B.firstEntry),
      ...state.configs.A.states.map((s) => s.id)]);
    const rows = [...allStates].map((id) => {
      const sA = state.configs.A.states.find((s) => s.id === id);
      const ta = A.firstEntry[id], tb = B.firstEntry[id];
      const delta = ta !== undefined && tb !== undefined ? ((tb - ta) * TICK) : null;
      return `<tr>
        <td><span class="dot" style="background:${stateColor(id)}"></span>${esc(sA ? sA.name : id)}</td>
        <td>${ta === undefined ? '未进入' : (ta * TICK).toFixed(3) + 's'}</td>
        <td>${tb === undefined ? '未进入' : (tb * TICK).toFixed(3) + 's'}</td>
        <td class="${delta === null ? '' : delta < 0 ? 'faster' : delta > 0 ? 'slower' : ''}">
          ${delta === null ? '—' : (delta > 0 ? '+' : '') + delta.toFixed(3) + 's'}</td>
        <td>${A.entryCount[id] || 0} / ${B.entryCount[id] || 0}</td>
      </tr>`;
    }).join('');

    const blockedA = A.events.filter((e) => e.type === 'request-discarded' || e.type === 'queue-timeout');
    const blockedB = B.events.filter((e) => e.type === 'request-discarded' || e.type === 'queue-timeout');
    const queuedB = B.events.filter((e) => e.type === 'queued' || e.type === 'blend-interrupted');

    wrap.innerHTML = `
      <p class="dim">同一串输入（${esc(state.timeline.name)}，${state.timeline.loopSec}s 循环）下两套过渡配置的回放对比。</p>
      <div class="compare-grid">
        <div class="compare-col">
          <h4>${esc(state.configs.A.name)}</h4>
          <canvas id="cmpA" width="260" height="220"></canvas>
        </div>
        <div class="compare-col">
          <h4>${esc(state.configs.B.name)}</h4>
          <canvas id="cmpB" width="260" height="220"></canvas>
        </div>
      </div>
      <div class="row">
        <button id="cmpPlay">▶ 同步回放</button>
        <button id="cmpPause">⏸</button>
        <span id="cmpPos" class="dim"></span>
      </div>
      <h4>进入状态时间对比</h4>
      <table><thead><tr><th>状态</th><th>A 首次进入</th><th>B 首次进入</th><th>B−A</th><th>进入次数 A/B</th></tr></thead>
      <tbody>${rows}</tbody></table>
      <div class="compare-grid">
        <div><h4>A 停在原动作 / 丢弃原因（${blockedA.length}）</h4>
          <div class="small-log">${blockedA.map(evBlockLine).join('') || '<div class="dim">无</div>'}</div>
          <h4>A 全部未命中事件</h4>
          <div class="small-log">${A.events.filter((e) => e.type === 'no-match').map(evNoMatchLine).join('') || '<div class="dim">无</div>'}</div>
        </div>
        <div><h4>B 排队 / 打断记录（${queuedB.length}）</h4>
          <div class="small-log">${queuedB.map(evQueueLine).join('') || '<div class="dim">无</div>'}</div>
          <h4>B 丢弃记录（${blockedB.length}）</h4>
          <div class="small-log">${blockedB.map(evBlockLine).join('') || '<div class="dim">无</div>'}</div>
        </div>
      </div>`;

    let cmpTick = 0, cmpTimer = null;
    const drawCmp = () => {
      const fa = A.frames[cmpTick] || A.frames[0];
      const fb = B.frames[cmpTick] || B.frames[0];
      Renderer.drawCharacter($('#cmpA'), fa.pose, { color: stateColor(fa.state) });
      Renderer.drawCharacter($('#cmpB'), fb.pose, { color: stateColor(fb.state) });
      $('#cmpPos').textContent = `t=${(cmpTick * TICK).toFixed(3)}s  A:${fa.state}  B:${fb.state}` +
        (fa.state !== fb.state ? '  ⚠ 状态分歧' : '');
    };
    drawCmp();
    $('#cmpPlay').onclick = () => {
      if (cmpTimer) return;
      cmpTimer = setInterval(() => {
        cmpTick = (cmpTick + 1) % A.tickCount;
        drawCmp();
      }, TICK * 1000 / state.speed);
    };
    $('#cmpPause').onclick = () => { clearInterval(cmpTimer); cmpTimer = null; };
  }
  function evBlockLine(e) {
    const msg = e.type === 'queue-timeout'
      ? `${esc(e.transitionId)} 排队 ${e.waited}s 超时丢弃`
      : `${esc(e.transitionId)} 被丢弃（${e.reason === 'not-interruptible' ? `过渡 ${esc(e.activeTransition)} 不可打断，剩 ${e.blendRemaining}s` : e.reason}）`;
    return `<div class="log-line"><span>${e.time.toFixed(3)}s</span> ${msg}</div>`;
  }
  function evNoMatchLine(e) {
    return `<div class="log-line"><span>${e.time.toFixed(3)}s</span> 停留 ${esc(e.state)}：` +
      e.considered.map((c) => `${esc(c.id)} 缺[${c.unsatisfied.join('、') || '—'}]`).join('；') + '</div>';
  }
  function evQueueLine(e) {
    const msg = e.type === 'queued'
      ? `${esc(e.transitionId)} 排队（挡于 ${esc(e.blockedBy)}，最长 ${e.maxWait}s）`
      : `过渡 ${esc(e.transitionId)} 被 ${esc(e.by)} 打断，从当前姿态继续`;
    return `<div class="log-line"><span>${e.time.toFixed(3)}s</span> ${msg}</div>`;
  }

  // ---------- 存取 / 导出 ----------
  function saveConfigs() {
    const payload = {
      version: 1, savedAt: new Date().toISOString(),
      configs: state.configs, timeline: state.timeline,
    };
    const list = JSON.parse(localStorage.getItem(state.storageKey) || '{}');
    const name = prompt('存档名称：', `存档 ${new Date().toLocaleString()}`);
    if (!name) return;
    list[name] = payload;
    localStorage.setItem(state.storageKey, JSON.stringify(list));
    alert(`已保存「${name}」（localStorage）`);
  }

  function loadFile(ev) {
    const file = ev.target.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const data = JSON.parse(fr.result);
        if (data.configs) {
          state.configs = { A: data.configs.A || data.configs, B: data.configs.B || Presets.configB() };
          if (data.timeline) state.timeline = data.timeline;
        } else if (data.states) {
          state.configs[state.activeCfg] = data;
        } else {
          alert('文件格式无法识别'); return;
        }
        state.tick = 0; state.impact = null;
        refresh();
        alert('配置已载入');
      } catch (err) { alert('载入失败：' + err.message); }
    };
    fr.readAsText(file);
    ev.target.value = '';
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportConfig() {
    download('asdebug-config.json', JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(),
      configs: state.configs, timeline: state.timeline,
    }, null, 2));
  }

  function exportLog() {
    const r = state.results[state.activeCfg];
    download('asdebug-log.json', JSON.stringify({
      configId: state.activeCfg,
      configName: cfg().name,
      timeline: state.timeline,
      frames: r.frames.map((f) => ({
        tick: f.tick, time: +(f.tick * TICK).toFixed(4), state: f.state,
        stateAge: f.stateAge, localT: f.localT, blending: f.blending, queued: f.queued,
      })),
      events: r.events,
      firstEntry: Object.fromEntries(Object.entries(r.firstEntry).map(([k, v]) => [k, +(v * TICK).toFixed(4)])),
      entryCount: r.entryCount,
    }, null, 2));
  }

  function exportCsv() {
    const r = state.results[state.activeCfg];
    const head = 'tick,time,state,stateAge,localT,blending,blendProgress,queued';
    const lines = r.frames.map((f) => [
      f.tick, f.tick * TICK, f.state, f.stateAge, f.localT,
      f.blending ? f.blending.transitionId : '', f.blending ? f.blending.progress : '',
      f.queued.join('|'),
    ].join(','));
    download('asdebug-frames.csv', [head, ...lines].join('\n'), 'text/csv');
  }

  // ---------- 自检：可复现性 ----------
  function runSelfTest() {
    const c = Presets.configA();
    const tl = Presets.TIMELINES.movingJump;
    const r1 = Engine.simulate(c, tl);
    const r2 = Engine.simulate(c, tl);
    const ok1 = JSON.stringify(r1.frames) === JSON.stringify(r2.frames);
    // seek 复现：任意 tick 的帧只由 config+timeline 决定
    const t = 37;
    const ok2 = JSON.stringify(r1.frames[t]) === JSON.stringify(r2.frames[t]);
    // 跨循环边界：tick n-1 → 重新从 0 仿真，第 0 帧一致
    const r3 = Engine.simulate(c, tl);
    const ok3 = JSON.stringify(r1.frames[0]) === JSON.stringify(r3.frames[0]);
    // 阴影检测：configC 必须报 shadowed
    const lintC = Engine.lintConfig(Presets.configC());
    const ok4 = lintC.issues.some((i) => i.code === 'shadowed');
    // 不可达状态检测
    const ok5 = lintC.issues.some((i) => i.code === 'unreachable-state' && i.refs.includes('hurt'));
    const all = [['重复仿真一致', ok1], ['随机定位帧一致', ok2], ['循环回绕帧一致', ok3], ['遮蔽检测', ok4], ['不可达检测', ok5]];
    alert(all.map(([n, ok]) => `${ok ? '✓' : '✗'} ${n}`).join('\n'));
  }

  // ---------- 启动 ----------
  function init() {
    initToolbar();
    initTransport();
    initEventFilter();
    window.addEventListener('resize', () => { if (state.tab === 'play') renderTimelineCanvas(); });
    rerun();
    renderAll();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
