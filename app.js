// app.js —— UI 层：场景编辑、画布渲染、时间轴拖动、逐步播放、批量试跑、锁路线对比
import {
  simulateRoute, sweep, diffSweeps, consistencyCheck,
  platformPos, doorState, superPeriod, fmt, EPS, REASONS,
} from './core.js';
import { demoScene, rescuePatch, cloneScene, applyPatch } from './scene.js';

// ---------- 应用状态 ----------
const state = {
  scene: cloneScene(demoScene),
  selected: { kind: 'platform', id: demoScene.platforms[0].id },
  t: 0,                 // 画面绝对时间
  t0: 0,                // 当前试跑出发时点
  sim: null,            // 当前 t0 的模拟结果
  sweepResult: null,    // 最近一次批量试跑
  playing: false,
  playTimer: null,
  currentStep: -1,      // 逐步播放高亮的步骤
  locked: false,
  baseline: null,       // 锁路线时的场景快照 + sweep 结果
  diff: null,
};

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const ctx = stage.getContext('2d');

// ---------- 工具 ----------
function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, 3200);
}
function findEntity(kind, id) {
  if (kind === 'platform') return state.scene.platforms.find((e) => e.id === id);
  if (kind === 'door') return state.scene.doors.find((e) => e.id === id);
  return state.scene.points.find((e) => e.id === id);
}
const entLabel = { walk: '走到', wait: '等待', ride: '搭乘' };

// ---------- 渲染：实体列表 ----------
function renderEntityList() {
  const list = $('entity-list');
  list.innerHTML = '';
  const groups = [
    { kind: 'platform', items: state.scene.platforms, cls: 'platform' },
    { kind: 'door', items: state.scene.doors, cls: 'door' },
    { kind: 'point', items: state.scene.points, cls: 'point' },
  ];
  for (const g of groups) {
    for (const ent of g.items) {
      const row = document.createElement('div');
      row.className = 'entity' + (state.selected.kind === g.kind && state.selected.id === ent.id ? ' active' : '');
      row.innerHTML = `<span>${ent.name}</span><span class="tag ${g.cls}">${g.kind === 'platform' ? '平台' : g.kind === 'door' ? '门' : '点'}</span>`;
      row.onclick = () => { state.selected = { kind: g.kind, id: ent.id }; renderAll(); };
      list.appendChild(row);
    }
  }
}

// ---------- 渲染：参数编辑器 ----------
function renderEditor() {
  const ed = $('editor');
  const ent = findEntity(state.selected.kind, state.selected.id);
  if (!ent) { ed.innerHTML = '<p class="hint">未选择实体。</p>'; return; }
  const lockWarn = state.locked && state.selected.kind === 'point'
    ? '<p class="readonly-hint">路线已锁定：等待点的时长字段只读。</p>' : '';

  const numField = (key, label, min, max, step) => `
    <div class="field">
      <label><span>${label}</span><span class="val" id="val-${key}">${ent[key]}</span></label>
      <input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${ent[key]}" />
    </div>`;

  let body = `<input type="text" data-key="name" value="${ent.name}" style="margin-bottom:10px;width:100%;background:var(--bg);border:1px solid var(--line);color:var(--text);border-radius:5px;padding:5px 7px" />`;
  if (state.selected.kind === 'platform' || state.selected.kind === 'door') {
    body += numField('period', '周期时长 (s)', 1, 30, 0.1);
    body += numField('phase', '起始相位 (s)', 0, ent.period, 0.1);
    body += numField('dwellA', 'A 端停靠/关闭 (s)', 0, ent.period / 2, 0.1);
    body += numField('dwellB', 'B 端停靠/开启 (s)', 0, ent.period / 2, 0.1);
  }
  ed.innerHTML = lockWarn + body;

  ed.querySelectorAll('input').forEach((input) => {
    input.addEventListener('input', () => {
      const key = input.dataset.key;
      if (key === 'name') { ent.name = input.value; renderEntityList(); return; }
      let v = parseFloat(input.value);
      if (key === 'phase') v = Math.min(v, ent.period);
      if (key === 'dwellA' || key === 'dwellB') {
        // 两段停靠之和不得占用整个周期（至少留一点移动时间）
        const other = key === 'dwellA' ? ent.dwellB : ent.dwellA;
        v = Math.max(0, Math.min(v, Math.max(0, ent.period - other - 0.2)));
      }
      ent[key] = v;
      const lbl = ed.querySelector(`#val-${key}`);
      if (lbl) lbl.textContent = Number(v).toFixed(1);
      invalidateResults();
      draw();
    });
  });
}

// ---------- 渲染：路线列表 ----------
function renderRouteList() {
  const ol = $('route-list');
  ol.innerHTML = '';
  state.scene.route.forEach((act, i) => {
    const li = document.createElement('li');
    if (state.currentStep === i) li.classList.add('active');
    let desc = '';
    if (act.type === 'walk') {
      const to = state.scene.points.find((p) => p.id === act.to);
      desc = `走到「${to?.name ?? act.to}」${act.allowWait ? '（可等门）' : '（硬闯）'}`;
    } else if (act.type === 'wait') {
      const wp = state.scene.points.find((p) => p.id === act.point);
      desc = `在「${wp?.name ?? act.point}」等待 ${act.duration}s`;
    } else {
      const pf = state.scene.platforms.find((p) => p.id === act.platform);
      const to = state.scene.points.find((p) => p.id === act.to);
      desc = `搭「${pf?.name ?? act.platform}」到「${to?.name ?? act.to}」`;
    }
    li.innerHTML = `<span class="idx">${i}</span><span class="desc">${desc}</span>
      <span class="mini">
        <button class="btn small" data-act="up" data-i="${i}">↑</button>
        <button class="btn small" data-act="down" data-i="${i}">↓</button>
        <button class="btn small" data-act="del" data-i="${i}">删</button>
      </span>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      if (state.locked) return;
      const i = +b.dataset.i;
      const route = state.scene.route;
      if (b.dataset.act === 'del') route.splice(i, 1);
      if (b.dataset.act === 'up' && i > 0) [route[i - 1], route[i]] = [route[i], route[i - 1]];
      if (b.dataset.act === 'down' && i < route.length - 1) [route[i + 1], route[i]] = [route[i], route[i + 1]];
      state.currentStep = -1;
      invalidateResults();
      renderAll();
    };
  });
  $('lock-state').textContent = state.locked ? '（已锁定）' : '';
}

// ---------- 画布渲染 ----------
function draw() {
  const W = stage.width, H = stage.height;
  ctx.clearRect(0, 0, W, H);
  // 背景网格
  ctx.strokeStyle = 'rgba(80,100,140,.12)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // 地面
  ctx.fillStyle = '#16233c';
  ctx.fillRect(0, 440, W, 40);

  // 等待点 / 路径点（标签统一放在点下方，避免与平台/门文字重叠）
  for (const p of state.scene.points) {
    ctx.fillStyle = p.kind === 'goal' ? '#2fbf71' : p.kind === 'start' ? '#4f8cff' : '#8fe0b4';
    ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#cdd8ee';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(p.name, p.x, p.y + 22);
    ctx.textAlign = 'left';
  }

  // 门（用高度表示开合）
  for (const d of state.scene.doors) {
    const st = doorState(d, state.t);
    const openH = st.f * d.h;
    ctx.fillStyle = '#3a2a18';
    ctx.fillRect(d.x - d.w / 2 - 3, d.y - d.h, d.w + 6, d.h + 6);
    ctx.fillStyle = st.open ? '#2fbf71' : '#d98e4b';
    // 门板从顶部垂下，开口在下方
    ctx.fillRect(d.x - d.w / 2, d.y - openH, d.w, openH);
    ctx.strokeStyle = '#f0b98a';
    ctx.strokeRect(d.x - d.w / 2, d.y - d.h, d.w, d.h);
    ctx.fillStyle = '#f0b98a';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${d.name} ${st.open ? '开' : '关'}`, d.x, d.y - d.h - 6);
    ctx.textAlign = 'left';
  }

  // 平台 + 轨迹
  for (const p of state.scene.platforms) {
    ctx.strokeStyle = 'rgba(110,168,254,.35)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath(); ctx.moveTo(p.ax, p.ay); ctx.lineTo(p.bx, p.by); ctx.stroke();
    ctx.setLineDash([]);
    const pos = platformPos(p, state.t);
    ctx.fillStyle = pos.moving ? '#8fbbff' : '#6ea8fe';
    ctx.fillRect(pos.x - 26, pos.y - 10, 52, 10);
    ctx.fillStyle = '#dbe8ff';
    ctx.font = '11px sans-serif';
    ctx.fillText(p.name, pos.x - 24, pos.y - 14);
    // A/B 端标记（放在端点内侧下方，避免与换乘点文字重叠）
    ctx.fillStyle = '#5a6b8c';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('A', p.ax - 22, p.ay + 4);
    ctx.fillText('B', p.bx + 12, p.by + 4);
  }

  // 角色（位置是 t 与 t0 的纯函数，拖动回放一致性由此保证）
  if (state.sim) {
    const ch = state.sim.charAt(state.t);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(ch.x, ch.y - 14, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1206';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(ch.state === 'ride' ? '乘' : ch.state === 'wait' ? '等' : '人', ch.x - 5, ch.y - 10);
  }

  // 当前步骤高亮连线
  if (state.currentStep >= 0 && state.sim?.steps[state.currentStep]) {
    const step = state.sim.steps[state.currentStep];
    ctx.strokeStyle = 'rgba(255,209,102,.8)';
    ctx.lineWidth = 2;
    for (const seg of step.segments ?? []) {
      if (seg.kind === 'ride') continue;
      ctx.beginPath();
      ctx.moveTo(seg.from?.x ?? seg.at?.x, (seg.from?.y ?? seg.at?.y) - 14);
      ctx.lineTo(seg.to?.x ?? seg.at?.x, (seg.to?.y ?? seg.at?.y) - 14);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
  }
  $('clock-t').textContent = fmt(state.t);
}

// ---------- 逐步播放详情 ----------
function renderStepDetail() {
  const box = $('step-detail');
  if (!state.sim) { box.innerHTML = '<p class="hint">选择出发时点后点「下一步」逐动作查看。</p>'; return; }
  if (state.currentStep < 0) {
    box.innerHTML = `<div class="step-card"><div class="st-title">准备出发</div>
      <div class="note">t0 = ${fmt(state.t0)}，共 ${state.scene.route.length} 个动作。</div></div>`;
    return;
  }
  const step = state.sim.steps[Math.min(state.currentStep, state.sim.steps.length - 1)];
  if (!step) { box.innerHTML = '<p class="hint">路线已结束。</p>'; return; }
  const failed = state.sim.failStep === step.index;
  box.innerHTML = `<div class="step-card">
    <div class="st-title">步骤 ${step.index} · ${entLabel[step.type]} ${failed ? '（中断点）' : ''}</div>
    ${(step.notes ?? []).map((n) => `<div class="note">• ${n}</div>`).join('')}
    ${(step.segments ?? []).map((s) => `<div class="seg">${segText(s)}</div>`).join('')}
    <div class="note" style="margin-top:6px">结束时刻：${fmt(step.endAt ?? 0)}</div>
  </div>`;
}
function segText(s) {
  if (s.kind === 'wait') return `等待 ${fmt(s.t0)} → ${fmt(s.t1)}`;
  if (s.kind === 'ride') return `搭乘移动 ${fmt(s.t0)} → ${fmt(s.t1)}（${s.fromSide}→${s.toSide}）`;
  return `行走 ${fmt(s.t0)} → ${fmt(s.t1)}`;
}

// ---------- 当前出发时点结论 ----------
function renderVerdict() {
  const box = $('verdict');
  if (!state.sim) { box.innerHTML = ''; return; }
  const r = state.sim;
  box.className = 'verdict ' + (r.ok ? 'good' : 'fail');
  box.innerHTML = `<div class="v-title">${r.ok ? '✓ 路线走通' : '✗ 路线中断'}</div>
    <div class="v-meta">原因：${r.reason}</div>
    ${r.ok ? `<div class="v-meta">走完时刻：${fmt(r.tEnd)}（历时 ${fmt(r.tEnd - r.t0)}）</div>`
      : `<div class="v-meta">中断于步骤 ${r.failStep}，时刻 ${fmt(r.failAt)}</div>`}`;
  const badges = $('badges');
  badges.innerHTML = `<div class="badge ${r.ok ? 'good' : 'fail'}">t0=${fmt(state.t0)}：${r.ok ? '成功' : r.reason}</div>`;
}

// ---------- 批量试跑结果 ----------
function runSweep() {
  const T = superPeriod(state.scene);
  state.sweepResult = sweep(state.scene, state.scene.route, { step: 0.1, horizon: state.scene.horizon });
  $('time-scrub').max = T;
  renderSweepStrip();
  renderSweepSummary();
}

function renderSweepStrip() {
  const strip = $('sweep-strip');
  strip.querySelectorAll('.cell').forEach((c) => c.remove());
  const marker = $('t0-marker');
  const r = state.sweepResult;
  if (!r) { if (marker) marker.style.display = 'none'; return; }
  const diffTags = state.diff?.tags;
  r.samples.forEach((s, k) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    if (diffTags) {
      cell.classList.add(diffTags[k] === 'gained' ? 'gain' : diffTags[k] === 'lost' ? 'lost' : s.ok ? 'same-ok' : 'same-bad');
    } else {
      cell.classList.add(s.ok ? 'ok' : 'bad');
    }
    cell.style.flex = '1 1 0';
    cell.title = `t0=${fmt(s.t0)} ${s.ok ? '可出发' : '失败：' + s.reason}`;
    cell.onclick = () => setT0(s.t0);
    strip.insertBefore(cell, marker);
  });
  updateT0Marker();
}

function updateT0Marker() {
  const marker = $('t0-marker');
  const r = state.sweepResult;
  if (!marker || !r) return;
  const pct = 100 * state.t0 / r.T;
  marker.style.display = 'block';
  marker.style.left = Math.min(100, Math.max(0, pct)) + '%';
}

function renderSweepSummary() {
  const r = state.sweepResult;
  if (!r) return;
  const pct = (100 * r.successCount / r.n).toFixed(1);
  $('sweep-summary').innerHTML = `
    <div class="stat"><div class="num">${pct}%</div><div class="lbl">可出发占比</div></div>
    <div class="stat"><div class="num">${r.windows.length}</div><div class="lbl">成功时段</div></div>
    <div class="stat"><div class="num">${r.n - r.successCount}</div><div class="lbl">失败样本</div></div>`;
  const winBox = $('windows');
  winBox.innerHTML = '<p class="hint" style="margin:0 0 6px">成功时间段（点击定位 t0）：</p>';
  for (const w of r.windows) {
    const d = document.createElement('div');
    d.className = 'win';
    d.innerHTML = `<span class="range">[${fmt(w.start)}, ${fmt(w.end)})</span> 宽 ${fmt(w.end - w.start)}`;
    d.onclick = () => setT0((w.start + w.end) / 2);
    winBox.appendChild(d);
  }
  const failBox = $('failures');
  failBox.innerHTML = '<p class="hint" style="margin:0 0 6px">最早失败点（按中断绝对时间）：</p>';
  for (const f of r.failures) {
    const d = document.createElement('div');
    d.className = 'fail';
    d.innerHTML = `<div class="reason">${f.reason}</div>
      <div class="meta">出现 ${f.count} 次；最早 t0=${fmt(f.earliest.t0)} → 步骤 ${f.earliest.step} 在 ${fmt(f.earliest.at)} 中断</div>`;
    d.onclick = () => setT0(f.earliest.t0);
    failBox.appendChild(d);
  }
}

// ---------- 锁路线 / 基线对比 ----------
function toggleLock() {
  if (!state.locked) {
    runSweep();
    state.locked = true;
    state.baseline = { scene: cloneScene(state.scene), sweep: state.sweepResult };
    state.diff = null;
    $('btn-lock').textContent = '解锁路线（回到编辑）';
    $('btn-lock').classList.remove('warn');
    toast('路线已锁定并记录基线，现在只能调平台/门参数');
  } else {
    state.locked = false;
    state.baseline = null;
    state.diff = null;
    state.sweepResult = null;
    $('diff-block').hidden = true;
    $('btn-lock').textContent = '锁住路线（记录基线）';
    $('btn-lock').classList.add('warn');
    toast('已解锁，路线恢复可编辑');
  }
  document.body.classList.toggle('locked', state.locked);
  invalidateResults();
  runSweep();
  setT0(state.t0);
  renderAll();
}

// 锁定状态下参数变化 → 重新试跑并与基线 diff
function rerunLockedDiff() {
  if (!state.locked || !state.baseline) return;
  const cur = sweep(state.scene, state.scene.route, { step: 0.1, horizon: state.scene.horizon });
  state.sweepResult = cur;
  state.diff = diffSweeps(state.baseline.sweep, cur);
  $('diff-block').hidden = false;
  $('diff-summary').innerHTML = `基线可出发 ${state.baseline.sweep.successCount} 个样本 → 当前 ${cur.successCount} 个；
    救回 <b style="color:var(--gain)">${state.diff.gained.length}</b> 段，丢失 <b style="color:var(--lost)">${state.diff.lost.length}</b> 段。`;
  const box = $('diff-segments');
  box.innerHTML = '';
  for (const seg of state.diff.segments) {
    const d = document.createElement('div');
    d.className = 'seg-row ' + seg.tag;
    d.innerHTML = `${seg.tag === 'gained' ? '🟢 救回' : '🔴 丢失'} <span class="range">[${fmt(seg.start)}, ${fmt(seg.end)})</span>`;
    d.onclick = () => setT0((seg.start + seg.end) / 2);
    box.appendChild(d);
  }
  renderSweepStrip();
  renderSweepSummary();
}

// ---------- 时间与 t0 控制 ----------
function setT0(t0) {
  state.t0 = t0;
  state.currentStep = -1;
  state.sim = simulateRoute(state.scene, state.scene.route, t0, state.scene.horizon);
  state.t = t0;
  $('time-scrub').value = t0;
  $('clock-t0').textContent = fmt(t0);
  updateT0Marker();
  draw();
  renderVerdict();
  renderStepDetail();
  renderRouteList();
}

function invalidateResults() {
  // 场景或路线变了，旧结果失效（锁定时保留基线，不丢）
  state.sim = null;
  state.sweepResult = null;
  state.diff = state.locked ? state.diff : null;
  if (!state.locked) { $('diff-block').hidden = true; }
  if (state.locked) rerunLockedDiff();
}

// ---------- 确定性自检 ----------
function runConsistency() {
  const res = consistencyCheck(state.scene, state.scene.route, state.t0, state.scene.horizon);
  if (res.ok) toast(`✓ 自检通过：${res.rows.length} 个时间点反复求值，平台/门/角色状态完全一致`);
  else toast('✗ 自检发现不一致，请检查', true);
}

// ---------- 播放控制 ----------
function togglePlay() {
  state.playing = !state.playing;
  $('btn-play').textContent = state.playing ? '⏸ 暂停' : '▶ 播放';
  if (state.playing) {
    let last = performance.now();
    const tick = (now) => {
      if (!state.playing) return;
      const dt = (now - last) / 1000; last = now;
      const T = superPeriod(state.scene);
      state.t = (state.t + dt) % T;
      $('time-scrub').value = state.t;
      draw();
      state.playTimer = requestAnimationFrame(tick);
    };
    state.playTimer = requestAnimationFrame(tick);
  } else if (state.playTimer) {
    cancelAnimationFrame(state.playTimer);
  }
}
function stepNext() {
  if (!state.sim) setT0(state.t0);
  const max = state.sim.steps.length - 1;
  state.currentStep = Math.min(max, state.currentStep + 1);
  const step = state.sim.steps[state.currentStep];
  if (step) { state.t = step.endAt; $('time-scrub').value = state.t; }
  draw(); renderStepDetail(); renderRouteList();
}
function stepPrev() {
  if (!state.sim) return;
  state.currentStep = Math.max(-1, state.currentStep - 1);
  if (state.currentStep < 0) state.t = state.t0;
  else state.t = state.sim.steps[state.currentStep].endAt;
  $('time-scrub').value = state.t;
  draw(); renderStepDetail(); renderRouteList();
}

// ---------- 增删路线动作 ----------
function addAction(type) {
  if (state.locked) return;
  const route = state.scene.route;
  if (type === 'walk') {
    const target = state.scene.points.find((p) => p.kind !== 'start') ?? state.scene.points[0];
    route.push({ type: 'walk', to: target.id, waitForDoor: state.scene.doors.slice(0, 1).map((d) => d.id), allowWait: true });
  } else if (type === 'wait') {
    const wp = state.scene.points.find((p) => p.kind === 'wait') ?? state.scene.points[0];
    route.push({ type: 'wait', point: wp.id, duration: 1 });
  } else {
    const pf = state.scene.platforms[0];
    const to = state.scene.points.find((p) => p.kind === 'dock') ?? state.scene.points[0];
    route.push({ type: 'ride', platform: pf.id, to: to.id, side: 'A' });
  }
  invalidateResults();
  renderAll();
}

// ---------- 一键救回 ----------
function applyRescue() {
  const rescued = applyPatch(state.scene, rescuePatch);
  state.scene = rescued;
  invalidateResults();
  runSweep();
  setT0(state.t0);
  renderAll();
  toast('已应用救回相位：仅改动上层平台 phase，路线未变');
}

// ---------- 整体重渲染 ----------
function renderAll() {
  renderEntityList();
  renderEditor();
  renderRouteList();
  if (!state.sweepResult) runSweep();
  if (!state.sim) setT0(state.t0);
  else { draw(); renderVerdict(); renderStepDetail(); }
  renderSweepStrip();
  renderSweepSummary();
  if (state.locked && state.diff) {
    $('diff-block').hidden = false;
  }
}

// ---------- 事件绑定 ----------
$('btn-reset').onclick = () => {
  state.scene = cloneScene(demoScene);
  state.locked = false; state.baseline = null; state.diff = null;
  state.t0 = 0; state.currentStep = -1;
  document.body.classList.remove('locked');
  $('btn-lock').textContent = '锁住路线（记录基线）';
  $('btn-lock').classList.add('warn');
  $('diff-block').hidden = true;
  invalidateResults();
  renderAll();
  toast('已重置为内置演示场景');
};
$('btn-rescue').onclick = applyRescue;
$('btn-consistency').onclick = runConsistency;
$('btn-lock').onclick = toggleLock;
$('btn-play').onclick = togglePlay;
$('btn-step-next').onclick = stepNext;
$('btn-step-prev').onclick = stepPrev;
$('btn-jump-t0').onclick = () => { state.t = state.t0; $('time-scrub').value = state.t; draw(); };
$('btn-add-walk').onclick = () => addAction('walk');
$('btn-add-wait').onclick = () => addAction('wait');
$('btn-add-ride').onclick = () => addAction('ride');
$('time-scrub').addEventListener('input', (e) => {
  state.t = parseFloat(e.target.value);
  draw();
});
// 拖动条来回拖到同一瞬间一致性：松开时强制重绘同一 t（纯函数，结果必然相同）
$('time-scrub').addEventListener('change', () => draw());

// ---------- 启动 ----------
renderAll();
