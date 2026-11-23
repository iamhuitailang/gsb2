/* 界面层：Canvas 渲染、控件交互、导出。所有状态都通过 engine.replay 重建。 */

const $ = (id) => document.getElementById(id);
const TEAM_COLOR = { A: '#4da3ff', B: '#ff6b6b' };
const PHASE_CN = { move: '移动阶段', vision: '视野阶段' };
const REASON_CN = {
  range: '超出视野半径',
  wall: '被墙挡住',
  'door:half': '被半开门挡住（可通过、挡视线）',
  'door:closed': '被关闭的门挡住',
  edge: '超出地图边界',
};
const MEM_TAG = {
  visible: ['当前可见', 'visible'],
  remembered: ['以前见过', 'remembered'],
  unknown: ['从未见过', 'unknown'],
};

const ui = {
  scIndex: 0,
  view: 'A',
  retention: true,
  step: 0,
  selected: null,
  playing: false,
  timer: null,
  state: null,
  dirty: true,
};

/* --------------------------- 状态重建 --------------------------- */

function scenario() { return SCENARIOS[ui.scIndex]; }

function ensureState() {
  if (ui.dirty || !ui.state) {
    ui.state = replay(scenario(), ui.step, { retention: ui.retention });
    ui.dirty = false;
  }
  return ui.state;
}

function markDirty() { ui.dirty = true; }

/* --------------------------- 画布渲染 --------------------------- */

const CELL = 42;
const cv = $('cv'), ctx = cv.getContext('2d');

function memColor(m) {
  if (!m) return '#0a0c11';
  if (m.state === 'visible') return '#f2e9c8';
  if (m.state === 'remembered') return '#5a6373';
  return '#0a0c11';
}

function doorAppearance(type) {
  // type: 'door:open' | 'door:half' | 'door:closed'
  if (type === 'door:open') return { fill: '#c9a85a', glyph: 'open' };
  if (type === 'door:half') return { fill: '#8a6d3b', glyph: 'half' };
  return { fill: '#6e5529', glyph: 'closed' };
}

function drawDoorGlyph(px, py, size, glyph) {
  const cx = px + size / 2, cy = py + size / 2;
  ctx.save();
  ctx.strokeStyle = '#1a1408';
  ctx.lineWidth = 2;
  if (glyph === 'open') {
    ctx.strokeRect(px + 6, py + 6, size - 12, size - 12);
  } else if (glyph === 'half') {
    ctx.fillStyle = '#1a1408';
    ctx.fillRect(cx - 3, py + 5, 6, size - 10); // 半扇门板
  } else {
    ctx.beginPath();
    ctx.moveTo(px + 7, py + 7); ctx.lineTo(px + size - 7, py + size - 7);
    ctx.moveTo(px + size - 7, py + 7); ctx.lineTo(px + 7, py + size - 7);
    ctx.stroke();
  }
  ctx.restore();
}

function drawUnit(cx, cy, r, team, id, alpha = 1, dashed = false) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = dashed ? 'rgba(0,0,0,.55)' : TEAM_COLOR[team];
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = TEAM_COLOR[team];
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = dashed ? TEAM_COLOR[team] : '#0d1220';
  ctx.font = 'bold 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(id, cx, cy + 0.5);
  ctx.restore();
}

function drawCrate(cx, cy, s, alpha = 1, dashed = false) {
  ctx.save();
  ctx.globalAlpha = alpha;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.fillStyle = dashed ? 'rgba(0,0,0,.55)' : '#b8923f';
  ctx.strokeStyle = '#e6c069';
  ctx.lineWidth = 1.5;
  const r = s / 2 - 7;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
  ctx.beginPath();
  ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r);
  ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r);
  ctx.stroke();
  ctx.restore();
}

function render() {
  const state = ensureState();
  const sc = scenario();
  const dpr = window.devicePixelRatio || 1;
  const W = sc.w * CELL, H = sc.h * CELL;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const isAdmin = ui.view === 'admin';
  const tm = isAdmin ? null : state.teams[ui.view];

  /* 1. 底色与地形（阵营视图只画记忆里存在的地形，unknown 保持全黑） */
  for (let y = 0; y < sc.h; y++) {
    for (let x = 0; x < sc.w; x++) {
      const px = x * CELL, py = y * CELL;
      const k = K(x, y);
      let type, m = null;
      if (isAdmin) {
        type = ['wall', 'door:open', 'door:half', 'door:closed'].includes(truthTypeOf(state, x, y))
          ? truthTypeOf(state, x, y) : 'floor';
        ctx.fillStyle = '#232a36';
      } else {
        m = tm.memory.get(k);
        ctx.fillStyle = memColor(m);
        type = m ? m.observedType : 'unknown';
      }
      ctx.fillRect(px, py, CELL, CELL);

      if (type === 'wall') {
        ctx.fillStyle = isAdmin ? '#39435a' : '#39435a';
        ctx.fillRect(px + 1, py + 1, CELL - 2, CELL - 2);
        ctx.strokeStyle = '#4d5a78';
        ctx.strokeRect(px + 3.5, py + 3.5, CELL - 7, CELL - 7);
      } else if (type && type.startsWith('door:')) {
        const ap = doorAppearance(type);
        ctx.fillStyle = ap.fill;
        ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
        drawDoorGlyph(px, py, CELL, ap.glyph);
      }

      // 网格线
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.strokeRect(px + .5, py + .5, CELL - 1, CELL - 1);

      // 记忆刷新角标：第 0 步初始视野不标注，只显示发生过刷新的格子
      if (!isAdmin && m && m.state !== 'unknown' && m.lastStep > 0) {
        const isMove = m.lastPhase === 'move';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = isMove ? '#2fe0a6' : '#b39ddb';
        ctx.fillText(isMove ? 'M' + m.lastStep : String(m.lastStep), px + CELL - 3, py + CELL - 3);
      }
    }
  }

  /* 2. 当前可见区域描边（仅阵营视图） */
  if (!isAdmin) {
    ctx.save();
    ctx.strokeStyle = TEAM_COLOR[ui.view] + '88';
    ctx.lineWidth = 2;
    for (const k of tm.fov) {
      const [x, y] = parseK(k);
      ctx.strokeRect(x * CELL + 1.5, y * CELL + 1.5, CELL - 3, CELL - 3);
    }
    ctx.restore();
  }

  /* 3. 单位 / 箱子 / 幽灵 */
  if (isAdmin) {
    for (const c of state.crates) drawCrate(c.x * CELL + CELL / 2, c.y * CELL + CELL / 2, CELL);
    for (const u of state.units) drawUnit(u.x * CELL + CELL / 2, u.y * CELL + CELL / 2, CELL / 2 - 8, u.team, u.id);
  } else {
    // 本队单位：按真实位置绘制
    for (const u of state.units.filter(u => u.team === ui.view)) {
      drawUnit(u.x * CELL + CELL / 2, u.y * CELL + CELL / 2, CELL / 2 - 8, u.team, u.id);
    }
    // 敌方单位与箱子：只按知识绘制；不在视野内 => 虚线幽灵 + 过期步数
    for (const [, kn] of tm.knowledge) {
      const [kx, ky] = kn.pos;
      const inSight = tm.fov.has(K(kx, ky));
      const cxp = kx * CELL + CELL / 2, cyp = ky * CELL + CELL / 2;
      if (kn.kind === 'crate') {
        drawCrate(cxp, cyp, CELL, inSight ? 1 : .85, !inSight);
      } else {
        drawUnit(cxp, cyp, CELL / 2 - 8, kn.team, kn.id, inSight ? 1 : .85, !inSight);
      }
      if (!inSight) {
        ctx.save();
        ctx.fillStyle = '#ffd27d';
        ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('👁' + kn.lastStep, cxp, cyp - CELL / 2 + 2);
        ctx.restore();
      }
    }
  }

  /* 4. 选中格高亮 */
  if (ui.selected) {
    const [sx, sy] = ui.selected;
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.strokeRect(sx * CELL + 2, sy * CELL + 2, CELL - 4, CELL - 4);
    ctx.restore();
  }
}

// engine 内部函数 truthType 未导出，这里用导出的 inspectCell 成本太高，直接复刻判断
function truthTypeOf(state, x, y) {
  const k = K(x, y);
  if (state.walls.has(k)) return 'wall';
  const d = state.doors.get(k);
  if (d) return 'door:' + d.state;
  return 'floor';
}

/* --------------------------- 选格追查面板 --------------------------- */

function renderInspector() {
  const el = $('inspector');
  if (!ui.selected) { el.innerHTML = '<span style="color:var(--muted)">尚未选择格子。</span>'; return; }
  const state = ensureState();
  const info = inspectCell(state, ui.selected[0], ui.selected[1]);
  let html = '';
  html += `<div class="kv"><span>格子</span><span>(${info.x}, ${info.y})</span></div>`;
  html += `<div class="kv"><span>真实地形（管理员事实）</span><span>${truthCn(info.truth)}</span></div>`;
  if (info.occupants.length) {
    html += `<div class="kv"><span>真实占据者</span><span>${info.occupants.map(o => o.id + (o.team ? '(' + o.team + ')' : '(箱子)')).join('、')}</span></div>`;
  }
  for (const team of ['A', 'B']) {
    const t = info.teams[team];
    const m = t.memory;
    const tag = m ? MEM_TAG[m.state] : MEM_TAG.unknown;
    html += `<div style="margin-top:8px;font-weight:600;color:${TEAM_COLOR[team]}">${team} 队视角</div>`;
    html += `<div class="kv"><span>记忆状态</span><span class="tag ${tag[1]}">${tag[0]}</span></div>`;
    if (m) {
      html += `<div class="kv"><span>记录的地形</span><span>${truthCn(m.observedType)}</span></div>`;
      html += `<div class="kv"><span>最后刷新</span><span>第 ${m.lastStep} 步 · ${PHASE_CN[m.lastPhase]}</span></div>`;
      html += `<div class="kv"><span>移动阶段途经</span><span>${m.moveRefreshStep ? '第 ' + m.moveRefreshStep + ' 步' : '无'}</span></div>`;
      html += `<div class="kv"><span>最后看见它的人</span><span>${m.lastSeenBy.join('、') || '—'}</span></div>`;
      html += `<div class="kv"><span>当前观察者</span><span>${m.seenByNow.length ? m.seenByNow.join('、') : '无（不在合并视野）'}</span></div>`;
    }
    html += '<div style="margin-top:4px">逐单位视线诊断：</div>';
    for (const d of t.diagnosis) {
      const good = !d.blocked;
      html += `<div class="diag-row ${good ? 'good' : 'bad'}">${d.unit} 于 (${d.from.join(',')})，距离 ${d.dist}：` +
        (good ? '视线贯通 ✔' : REASON_CN[d.reason] + (d.blockerCell ? `，遮挡格 (${d.blockerCell.join(',')})` : '') + ' ✘') + '</div>';
    }
    if (t.ghosts.length) {
      html += '<div style="margin-top:4px;color:#ffd27d">过期幽灵：</div>';
      for (const g of t.ghosts) {
        html += `<div class="diag-row bad">${g.id} 最后见于第 ${g.lastStep} 步此格；真实位置 (${g.livePos.join(',')})（该阵营无权知道，仅调试显示）</div>`;
      }
    }
  }
  el.innerHTML = html;
}

function truthCn(t) {
  if (t === 'wall') return '墙';
  if (t === 'floor') return '地板';
  if (t === 'door:open') return '门 · 全开';
  if (t === 'door:half') return '门 · 半开';
  if (t === 'door:closed') return '门 · 关闭';
  return '未知（从未见过）';
}

/* --------------------------- 日志面板 --------------------------- */

function renderLog() {
  const state = ensureState();
  const el = $('log');
  if (!state.logs.length) { el.innerHTML = '<span style="color:var(--muted)">第 0 步：初始视野已结算，点击“前进”开始演示。</span>'; return; }
  let html = '<div class="step-head">第 0 步：初始视野结算</div>';
  for (const l of state.logs) {
    html += `<div class="step-head">第 ${l.step} 步${l.label ? ' — ' + escapeHtml(l.label) : ''}</div>`;
    for (const e of l.events) {
      html += `<div class="evt ${e.phase}"><span class="tag ${e.phase === 'move' ? 'move' : e.phase === 'door' ? 'door' : 'vision'}">${PHASE_CN[e.phase] || '门阶段'}</span> ${escapeHtml(e.text)}</div>`;
    }
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* --------------------------- 控件 --------------------------- */

function renderAll() {
  render();
  renderInspector();
  renderLog();
  const state = ensureState();
  $('stepLabel').textContent = `第 ${state.step} / ${state.script.length} 步`;
  $('slider').max = state.script.length;
  $('slider').value = state.step;
  $('btnBack').disabled = state.step === 0;
  $('btnNext').disabled = state.step >= state.script.length;
  document.querySelectorAll('.view-tabs button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === ui.view));
}

function gotoStep(n) {
  const sc = scenario();
  ui.step = Math.max(0, Math.min(sc ? compileScenario(sc).length : 0, n));
  ui.selected = null;
  markDirty();
  renderAll();
}

function initScenarioSelect() {
  const sel = $('scenario');
  sel.innerHTML = SCENARIOS.map((s, i) => `<option value="${i}">${s.name}</option>`).join('');
  sel.value = String(ui.scIndex);
}

function loadScenario() {
  // 不重置 ui.step / ui.selected：URL 参数可指定初始步与选中格；
  // 手动切换场景时由 change 监听处的 gotoStep(0) 负责归零
  ui.playing = false; stopPlay();
  const sc = scenario();
  $('scnName').textContent = sc.name;
  $('scnDesc').textContent = sc.desc;
  $('hashResult').textContent = '';
  $('hashResult').className = 'hash-result';
  markDirty();
  renderAll();
}

function stopPlay() {
  if (ui.timer) { clearInterval(ui.timer); ui.timer = null; }
  ui.playing = false;
  $('btnPlay').textContent = '▶ 自动播放';
}

function togglePlay() {
  if (ui.playing) { stopPlay(); return; }
  const state = ensureState();
  if (state.step >= state.script.length) gotoStep(0);
  ui.playing = true;
  $('btnPlay').textContent = '⏸ 暂停';
  ui.timer = setInterval(() => {
    const s = ensureState();
    if (s.step >= s.script.length) { stopPlay(); return; }
    gotoStep(ui.step + 1);
  }, 950);
}

function download(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* 确定性校验：增量推进 vs 两次独立从头重放，逐步比对哈希；顺带检查非法移动 */
function runVerify() {
  const sc = scenario();
  const lines = [];
  let ok = true;

  // 第 0 步
  const inc0 = createState(sc, { retention: ui.retention });
  const r0 = replay(sc, 0, { retention: ui.retention });
  const h0a = stateHash(inc0), h0b = stateHash(r0);
  lines.push(`step 0: create=${h0a} replay=${h0b} ${h0a === h0b ? 'OK' : 'MISMATCH'}`);
  if (h0a !== h0b) ok = false;

  const inc = createState(sc, { retention: ui.retention });
  for (let i = 0; i < inc.script.length; i++) {
    const ev = inc.script[i];
    // 非法移动检查：目标格不能是墙或关闭的门
    for (const mv of ev.moves) {
      const e = inc.units.find(u => u.id === mv.id) || inc.crates.find(c => c.id === mv.id);
      const tx = e.x + mv.dx, ty = e.y + mv.dy;
      const t = truthTypeOf(inc, tx, ty);
      if (t === 'wall' || t === 'door:closed') {
        ok = false;
        lines.push(`step ${i + 1}: 非法移动 ${mv.id} 进入 ${t} (${tx},${ty})`);
      }
    }
    applyStep(inc, ev);
    const r1 = replay(sc, i + 1, { retention: ui.retention });
    const r2 = replay(sc, i + 1, { retention: ui.retention });
    const hInc = stateHash(inc), h1 = stateHash(r1), h2 = stateHash(r2);
    const stepOk = hInc === h1 && h1 === h2;
    if (!stepOk) ok = false;
    lines.push(`step ${i + 1}: incremental=${hInc} replay#1=${h1} replay#2=${h2} ${stepOk ? 'OK' : 'MISMATCH'}`);
  }
  const el = $('hashResult');
  el.className = 'hash-result ' + (ok ? 'ok' : 'fail');
  el.textContent = (ok ? '✔ 确定性校验通过：回退后再走每一步结果完全一致。\n' : '✘ 存在不一致：\n') + lines.join('\n');
}

/* --------------------------- 事件绑定 --------------------------- */

function bind() {
  $('scenario').addEventListener('change', e => {
    ui.scIndex = Number(e.target.value);
    ui.step = 0; ui.selected = null;
    loadScenario();
  });
  $('retention').addEventListener('change', e => { ui.retention = e.target.checked; markDirty(); renderAll(); });
  document.querySelectorAll('.view-tabs button').forEach(b =>
    b.addEventListener('click', () => { ui.view = b.dataset.view; renderAll(); }));
  $('btnReset').addEventListener('click', () => { stopPlay(); gotoStep(0); });
  $('btnBack').addEventListener('click', () => { stopPlay(); gotoStep(ui.step - 1); });
  $('btnNext').addEventListener('click', () => { stopPlay(); gotoStep(ui.step + 1); });
  $('btnPlay').addEventListener('click', togglePlay);
  $('slider').addEventListener('input', e => { stopPlay(); gotoStep(Number(e.target.value)); });

  cv.addEventListener('click', e => {
    const rect = cv.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / CELL);
    const y = Math.floor((e.clientY - rect.top) / CELL);
    const sc = scenario();
    if (x >= 0 && y >= 0 && x < sc.w && y < sc.h) {
      ui.selected = [x, y];
      renderAll();
    }
  });

  $('expA').addEventListener('click', () =>
    download(`view_teamA_step${ensureState().step}.json`, exportTeamView(ensureState(), 'A')));
  $('expB').addEventListener('click', () =>
    download(`view_teamB_step${ensureState().step}.json`, exportTeamView(ensureState(), 'B')));
  $('expLog').addEventListener('click', () =>
    download(`step_record_${scenario().id}.json`, exportStepRecord(ensureState())));
  $('verify').addEventListener('click', runVerify);

  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') { stopPlay(); gotoStep(ui.step - 1); }
    else if (e.key === 'ArrowRight') { stopPlay(); gotoStep(ui.step + 1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
}

initScenarioSelect();
bind();
applyUrlParams(); // 必须在 loadScenario 之前设置 ui.step/view/selected
loadScenario();

/* 截图/演示用 URL 参数：?scn=door-close&step=5&view=A&retain=0&cell=5,4
   仅影响初始展示，不改变任何引擎规则 */
function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const scn = q.get('scn');
  if (scn !== null) {
    const idx = SCENARIOS.findIndex(s => s.id === scn);
    if (idx >= 0) {
      ui.scIndex = idx;
      $('scenario').value = String(idx);
    }
  }
  if (q.get('retain') === '0') {
    ui.retention = false;
    $('retention').checked = false;
  }
  const view = q.get('view');
  if (['A', 'B', 'admin'].includes(view)) {
    ui.view = view;
    document.querySelectorAll('.view-tabs button').forEach(b =>
      b.classList.toggle('active', b.dataset.view === view));
  }
  const step = Number(q.get('step'));
  if (Number.isFinite(step) && step > 0) ui.step = step;
  const cell = q.get('cell');
  if (cell && /^\d+,\d+$/.test(cell)) ui.selected = cell.split(',').map(Number);
}
