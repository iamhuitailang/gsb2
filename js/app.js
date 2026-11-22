'use strict';
/* ============================================================
 * UI 层：画布渲染 / 播放控制 / 时点回溯 / 重跑校验 /
 *       双方案对比 / 工程与运行记录持久化
 * ============================================================ */

const $ = s => document.querySelector(s);
const cv = $('#cv'), ctx = cv.getContext('2d');
const cmpCv = $('#cmpCv'), cmpCtx = cmpCv.getContext('2d');

let sim = null;
let currentScenario = null;
let currentConfig = null;
let playing = false;
let speed = 1;
let maxTick = 0;          // 本次运行到达过的最远 tick（ frontier ）
let frontierHash = null;  // frontier 处的顺序哈希，用于重跑校验
let runRecorded = false;  // 本轮是否已写入运行记录
let acc = 0, lastTs = 0;

const LS_PROJ = 'waveSim.projects.v1';
const LS_RUNS = 'waveSim.runs.v1';

// ---------------- 场景装载 ----------------
function loadScenario(scenId, configOverride) {
  currentScenario = SCENARIOS.find(s => s.id === scenId) || SCENARIOS[0];
  currentConfig = configOverride || structuredClone(currentScenario.config);
  $('#seedInput').value = currentConfig.seed;
  $('#scenarioDesc').textContent = currentScenario.desc;
  $('#variantSel').innerHTML = currentScenario.variants
    .map(v => `<option value="${v.id}">${v.name}</option>`).join('');
  rebuildSim();
}

function rebuildSim() {
  sim = new Sim(currentConfig);
  maxTick = 0; frontierHash = sim.hash(); runRecorded = false;
  playing = false;
  $('#btnPlay').textContent = '▶ 播放';
  $('#configJson').value = JSON.stringify(currentConfig, null, 1);
  syncStaticUI();
  renderAll();
}

function syncStaticUI() {
  // 图例
  $('#legend').innerHTML = currentConfig.waves.map(w =>
    `<span class="item"><span class="sw" style="background:${w.color}"></span>${w.name}</span>`
  ).join('') + `<span class="item" style="color:var(--dim)">□=排队/移动 ●场内 数字=容量</span>`;
  renderPlanTable();
}

// ---------------- 播放主循环 ----------------
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  if (playing && !sim.done) {
    acc += dt * speed * TICKS_PER_SEC;
    let n = Math.floor(acc);
    acc -= n;
    n = Math.min(n, 300);
    while (n-- > 0 && !sim.done) {
      sim.step();
      if (sim.tick >= maxTick) {   // 到达/重新到达 frontier：刷新顺序哈希（回退改史后重放会覆盖）
        maxTick = sim.tick;
        frontierHash = sim.hash();
      }
    }
    if (sim.done) {
      playing = false;
      $('#btnPlay').textContent = '▶ 播放';
      recordRun('自然完成');
    }
    renderAll();
  }
}
requestAnimationFrame(frame);

// ---------------- 渲染 ----------------
function nodePos(id) { const n = sim.nodes[id]; return [n.x, n.y]; }

function drawEdge(e) {
  const [x1, y1] = nodePos(e.from), [x2, y2] = nodePos(e.to);
  const open = sim.edgeOpenAt(e, sim.tick / TICKS_PER_SEC);
  ctx.strokeStyle = open ? '#3a4356' : '#7a2b28';
  ctx.lineWidth = open ? 3 : 2;
  ctx.setLineDash(open ? [] : [6, 5]);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  ctx.setLineDash([]);
  // 容量与占用标注
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const cap = e.cap === Infinity ? '∞' : e.cap;
  ctx.fillStyle = open ? '#8b93a3' : '#e2554f';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${e.users.length}/${cap}${open ? '' : ' ✕'}`, mx, my - 8);
  if (!open) {
    ctx.fillStyle = '#e2554f';
    ctx.fillText('关闭', mx, my + 14);
  }
}

function drawNode(n) {
  if (n.type === 'field') {
    const rx = n.rx || 90, ry = n.ry || 60;
    ctx.fillStyle = '#1a2230';
    ctx.strokeStyle = '#3f5a80';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(n.x - rx, n.y - ry, rx * 2, ry * 2, 10); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#7fa6d9'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${n.label}（${countState('onfield')} 人）`, n.x, n.y - ry + 16);
    return;
  }
  ctx.fillStyle = n.type === 'entrance' ? '#c9a24b' : n.type === 'exit' ? '#7a8a9a' : '#5b6578';
  ctx.beginPath(); ctx.arc(n.x, n.y, n.type === 'junction' ? 7 : 12, 0, Math.PI * 2); ctx.fill();
  if (n.label) {
    ctx.fillStyle = '#c8cfdb'; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(n.label, n.x, n.y - 18);
  }
  if (n.type === 'exit') {
    ctx.fillStyle = '#8b93a3'; ctx.font = '11px sans-serif';
    ctx.fillText(`已离场 ${countState('departed')}`, n.x, n.y + 28);
  }
}

function countState(st) {
  let k = 0;
  for (const c of sim.chars) if (c.state === st) k++;
  return k;
}

function drawChars() {
  // 排队：按节点分组，按放行顺序堆叠
  const queues = {};
  const onfield = [];
  for (const c of sim.chars) {
    if (c.state === 'queued') (queues[c.node] ??= []).push(c);
    else if (c.state === 'onfield') onfield.push(c);
  }
  for (const nodeId of Object.keys(queues)) {
    const q = queues[nodeId].sort((a, b) =>
      (sim.waveOf(a).priority - sim.waveOf(b).priority) || (a.queueSeq - b.queueSeq));
    const n = sim.nodes[nodeId];
    q.forEach((c, i) => {
      const col = i % 6, row = Math.floor(i / 6);
      square(n.x - 30 + col * 13, n.y + 16 + row * 13, c.color, true);
    });
    if (q.length) {
      ctx.fillStyle = '#f0c14f'; ctx.font = '11px monospace'; ctx.textAlign = 'left';
      ctx.fillText(`等${q.length}`, n.x + 14, n.y + 26);
    }
  }
  // 通道上
  for (const e of sim.edgeList) {
    const [x1, y1] = nodePos(e.from), [x2, y2] = nodePos(e.to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    e.users.forEach((cid, i) => {
      const c = sim.charMap[cid];
      const p = 1 - c.edgePos / c.edgeTime;
      const off = (i - (e.users.length - 1) / 2) * 10;
      square(x1 + dx * p + px * off, y1 + dy * p + py * off, c.color, false);
    });
  }
  // 场内：按入场顺序排网格
  onfield.sort((a, b) => a.enterTick - b.enterTick);
  const f = sim.nodes[sim.fieldNodeId()];
  const rx = f.rx || 90;
  const cols = Math.max(4, Math.floor((rx * 2 - 20) / 13));
  onfield.forEach((c, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    square(f.x - rx + 14 + col * 13, f.y - (f.ry || 60) + 26 + row * 13, c.color, false);
  });
}

function square(x, y, color, waiting) {
  ctx.fillStyle = color;
  ctx.fillRect(x - 5, y - 5, 10, 10);
  if (waiting) { ctx.strokeStyle = '#0c0e12'; ctx.lineWidth = 1; ctx.strokeRect(x - 5, y - 5, 10, 10); }
}

function drawClosuresBanner() {
  const t = sim.tick / TICKS_PER_SEC;
  const closed = sim.edgeList.filter(e => !sim.edgeOpenAt(e, t));
  if (!closed.length) return;
  ctx.fillStyle = 'rgba(226,85,79,0.9)';
  ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`⛔ 已关闭：${closed.map(e => e.id).join('、')}`, 12, 22);
}

function renderCanvas() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  sim.edgeList.forEach(drawEdge);
  Object.values(sim.nodes).forEach(drawNode);
  drawChars();
  drawClosuresBanner();
}

// ---------------- 计划表（计划 vs 实际） ----------------
function renderPlanTable() {
  let html = '<table><tr><th>批次</th><th>人数</th><th>入口</th><th>触发条件（计划）</th>' +
    '<th>状态</th><th>实际触发</th><th>首/末入场</th><th>等待 均/最大</th></tr>';
  for (const w of sim.waves) {
    html += `<tr class="wavehead"><td colspan="8"><span class="sw" style="background:${w.color};width:10px;height:10px;display:inline-block;border-radius:2px;margin-right:5px"></span>${w.name}（优先级 ${w.priority}）</td></tr>`;
    for (const b of sim.batches.filter(b => b.waveId === w.id)) {
      const recs = sim.records.filter(r => r.batch === b.id && r.entered != null);
      const waits = recs.map(r => r.wait);
      const avg = waits.length ? (waits.reduce((a, x) => a + x, 0) / waits.length / TICKS_PER_SEC).toFixed(1) : '—';
      const mx = waits.length ? (Math.max(...waits) / TICKS_PER_SEC).toFixed(1) : '—';
      const first = recs.length ? fmtT(Math.min(...recs.map(r => r.entered))) : '—';
      const last = recs.length ? fmtT(Math.max(...recs.map(r => r.entered))) : '—';
      const st = b.state === 'pending' ? '等待触发' : b.state === 'done' ? '✅ 全部入场' : `入场中 ${b.arrived}/${b.count}`;
      html += `<tr><td>${b.id}</td><td class="num">${b.count}</td><td>${b.entrance}</td>` +
        `<td>${triggerDesc(b.trigger)}</td><td>${st}</td>` +
        `<td>${b.triggerTick != null ? fmtT(b.triggerTick) : '—'}</td>` +
        `<td>${first} / ${last}</td><td>${avg}s / ${mx}s</td></tr>`;
    }
  }
  $('#planTable').innerHTML = html + '</table>';
}

// ---------------- 实际记录 ----------------
function renderLog() {
  const f = $('#logFilter').value;
  const box = $('#eventLog');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.innerHTML = sim.events
    .filter(e => !f || (f === 'edge' ? e.type.startsWith('edge') : e.type === f))
    .map(e => `<div class="ev ev-${e.type}"><span class="t">${fmtT(e.tick)}</span>${e.text}</div>`)
    .join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderCharTable() {
  let html = '<table><tr><th>角色</th><th>批次</th><th>排队</th><th>入场</th><th>离场</th><th>等待</th></tr>';
  for (const r of sim.records) {
    if (r.queued == null && r.entered == null) continue;
    html += `<tr><td>${r.id}</td><td>${r.batch}</td>` +
      `<td>${r.queued != null ? fmtT(r.queued) : '—'}</td>` +
      `<td>${r.entered != null ? fmtT(r.entered) : '—'}</td>` +
      `<td>${r.exited != null ? fmtT(r.exited) : '—'}</td>` +
      `<td>${r.wait != null ? (r.wait / TICKS_PER_SEC).toFixed(1) + 's' : '—'}</td></tr>`;
  }
  $('#charTable').innerHTML = html + '</table>';
}

// ---------------- 关键时点 ----------------
function renderCheckpoints() {
  const sel = $('#checkpointSel');
  const cur = sel.value;
  const cps = [];
  for (const e of sim.events) {
    if (['trigger', 'edge-close', 'edge-open', 'done'].includes(e.type))
      cps.push({ tick: e.tick, label: `${fmtT(e.tick)} ${e.text}` });
  }
  if (sim.peak.waiting > 0)
    cps.push({ tick: sim.peak.tick, label: `${fmtT(sim.peak.tick)} 等待峰值 ${sim.peak.waiting} 人` });
  cps.sort((a, b) => a.tick - b.tick);
  sel.innerHTML = '<option value="">— 跳转 —</option>' +
    cps.map(c => `<option value="${c.tick}">${c.label}</option>`).join('');
  if (cur) sel.value = cur;
}

// ---------------- 总渲染 ----------------
let lastRenderedTick = -1;
function renderAll() {
  renderCanvas();
  if (sim.tick === lastRenderedTick) return;
  lastRenderedTick = sim.tick;
  $('#timeLabel').textContent = `t = ${fmtT(sim.tick)}${sim.done ? '（完成）' : ''}`;
  $('#hashLabel').textContent = `顺序哈希 ${sim.hash()} | 等待 ${countState('queued')} | 场内 ${countState('onfield')} | 峰值 ${sim.peak.waiting}@${fmtT(sim.peak.tick)}`;
  const sl = $('#seekSlider');
  sl.max = maxTick;
  if (document.activeElement !== sl) sl.value = sim.tick;
  renderPlanTable();
  renderLog();
  renderCharTable();
  renderCheckpoints();
}

// ---------------- 控制 ----------------
$('#btnPlay').onclick = () => {
  playing = !playing;
  $('#btnPlay').textContent = playing ? '⏸ 暂停' : '▶ 播放';
};
$('#btnStep').onclick = () => { playing = false; $('#btnPlay').textContent = '▶ 播放'; stepN(1); };
$('#btnStep1s').onclick = () => { playing = false; $('#btnPlay').textContent = '▶ 播放'; stepN(TICKS_PER_SEC); };
function stepN(n) {
  for (let i = 0; i < n && !sim.done; i++) {
    sim.step();
    if (sim.tick >= maxTick) { maxTick = sim.tick; frontierHash = sim.hash(); }
  }
  if (sim.done) recordRun('自然完成');
  renderAll();
}
$('#btnRestart').onclick = () => {
  sim.reset();
  maxTick = 0; frontierHash = sim.hash(); runRecorded = false;
  playing = false; $('#btnPlay').textContent = '▶ 播放';
  renderAll();
  setStatus('已重置');
};
$('#speedSel').onchange = e => { speed = +e.target.value; };
$('#seedInput').onchange = e => {
  currentConfig.seed = +e.target.value || 0;
  rebuildSim();
  setStatus('种子已更新并重建模拟');
};
$('#scenarioSel').onchange = e => loadScenario(e.target.value);

// 时点回溯：拖动滑块 / 选择关键时点
$('#seekSlider').oninput = e => {
  const target = +e.target.value;
  sim.seek(target);
  renderAll();
};
$('#checkpointSel').onchange = e => {
  if (!e.target.value) return;
  sim.seek(+e.target.value);
  renderAll();
  e.target.value = '';
};

// 重跑校验：从头重放到 frontier，比较顺序哈希
$('#btnRerun').onclick = () => {
  const closures = structuredClone(sim.runtimeClosures);
  const fresh = new Sim(currentConfig);
  fresh.runtimeClosures = closures;
  fresh.runTo(maxTick);
  const h2 = fresh.hash();
  const ok = h2 === frontierHash;
  setStatus(ok
    ? `✅ 重跑复现一致：t=${fmtT(maxTick)} 处顺序哈希 ${h2}`
    : `❌ 复现不一致！原 ${frontierHash} vs 重跑 ${h2}`);
  // 用重放结果替换当前状态，继续从 frontier 前进
  sim = fresh;
  recordRun(ok ? '重跑校验一致' : '重跑校验不一致');
  renderAll();
};

// 画布点击：命中通道则手动关/开
cv.addEventListener('click', ev => {
  const r = cv.getBoundingClientRect();
  const x = (ev.clientX - r.left) * (cv.width / r.width);
  const y = (ev.clientY - r.top) * (cv.height / r.height);
  let best = null, bestD = 10;
  for (const e of sim.edgeList) {
    const [x1, y1] = nodePos(e.from), [x2, y2] = nodePos(e.to);
    const d = distToSeg(x, y, x1, y1, x2, y2);
    if (d < bestD) { bestD = d; best = e; }
  }
  if (best) {
    sim.toggleEdge(best.id);
    renderAll();
    setStatus(`通道 ${best.id} 已${sim.edgeOpenAt(best, sim.tick / TICKS_PER_SEC) ? '恢复' : '关闭'}（t=${fmtT(sim.tick)}）`);
  }
});
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// 标签页
document.querySelectorAll('#tabs button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
  };
});
$('#logFilter').onchange = renderLog;

// ---------------- 对比（要求 5） ----------------
function headlessRun(cfg) {
  const s = new Sim(cfg, { snapshots: false });
  s.runTo(Infinity, 20000);
  return s;
}

$('#btnCompare').onclick = () => {
  const variant = currentScenario.variants.find(v => v.id === $('#variantSel').value);
  if (!variant) { setStatus('该场景没有对比方案'); return; }
  const cfgA = structuredClone(currentConfig);
  const cfgB = structuredClone(currentConfig);
  cfgB.waves = structuredClone(variant.waves);
  const A = headlessRun(cfgA), B = headlessRun(cfgB);

  const sumWait = s => s.records.reduce((a, r) => a + (r.wait || 0), 0) / TICKS_PER_SEC;
  const doneT = s => fmtT(s.tick);
  $('#compareSummary').innerHTML =
    `<div><b style="color:#e2554f">A 当前计划</b>：等待峰值 <span class="pk">${A.peak.waiting} 人</span> @ ${fmtT(A.peak.tick)}，` +
    `总等待 ${sumWait(A).toFixed(0)} 人·秒，全部入场完成于 ${doneT(A)}${A.done ? '' : '（未跑完）'}</div>` +
    `<div><b style="color:#3f8fe2">B ${variant.name}</b>：等待峰值 <span class="pk">${B.peak.waiting} 人</span> @ ${fmtT(B.peak.tick)}，` +
    `总等待 ${sumWait(B).toFixed(0)} 人·秒，全部入场完成于 ${doneT(B)}${B.done ? '' : '（未跑完）'}</div>` +
    `<div style="color:var(--ok)">峰值差 ${A.peak.waiting - B.peak.waiting} 人（正数 = B 更平缓）</div>`;

  drawCompareChart(A, B);

  // 批次对照表
  const batchInfo = s => {
    const m = {};
    for (const b of s.batches) {
      const recs = s.records.filter(r => r.batch === b.id && r.entered != null);
      m[b.id] = {
        trig: b.triggerTick, done: b.doneTick,
        maxWait: recs.length ? Math.max(...recs.map(r => r.wait)) : null,
      };
    }
    return m;
  };
  const ia = batchInfo(A), ib = batchInfo(B);
  let html = '<table><tr><th>批次</th><th>A触发</th><th>A末人入场</th><th>A最大等待</th>' +
    '<th>B触发</th><th>B末人入场</th><th>B最大等待</th></tr>';
  for (const id of Object.keys(ia)) {
    const a = ia[id], b = ib[id] || {};
    html += `<tr><td>${id}</td>` +
      `<td>${a.trig != null ? fmtT(a.trig) : '—'}</td><td>${a.done != null ? fmtT(a.done) : '—'}</td>` +
      `<td>${a.maxWait != null ? (a.maxWait / TICKS_PER_SEC).toFixed(1) + 's' : '—'}</td>` +
      `<td>${b.trig != null ? fmtT(b.trig) : '—'}</td><td>${b.done != null ? fmtT(b.done) : '—'}</td>` +
      `<td>${b.maxWait != null ? (b.maxWait / TICKS_PER_SEC).toFixed(1) + 's' : '—'}</td></tr>`;
  }
  $('#compareTable').innerHTML = html + '</table>';
  setStatus('对比完成');
};

function drawCompareChart(A, B) {
  const W = cmpCv.width, H = cmpCv.height, padL = 34, padB = 22, padT = 14, padR = 8;
  cmpCtx.clearRect(0, 0, W, H);
  const maxT = Math.max(A.metrics.length, B.metrics.length, 1);
  const maxW = Math.max(A.peak.waiting, B.peak.waiting, 1);
  const X = t => padL + (W - padL - padR) * (t / maxT);
  const Y = v => H - padB - (H - padT - padB) * (v / maxW);
  // 轴
  cmpCtx.strokeStyle = '#333a48'; cmpCtx.lineWidth = 1;
  cmpCtx.beginPath(); cmpCtx.moveTo(padL, padT); cmpCtx.lineTo(padL, H - padB); cmpCtx.lineTo(W - padR, H - padB); cmpCtx.stroke();
  cmpCtx.fillStyle = '#8b93a3'; cmpCtx.font = '10px monospace'; cmpCtx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const t = Math.round(maxT * i / 4);
    cmpCtx.fillText(fmtT(t), X(t), H - 8);
  }
  cmpCtx.textAlign = 'right';
  for (let v = 0; v <= maxW; v += Math.max(1, Math.round(maxW / 4)))
    cmpCtx.fillText(v, padL - 4, Y(v) + 3);
  // 曲线
  const plot = (s, color) => {
    cmpCtx.strokeStyle = color; cmpCtx.lineWidth = 1.5;
    cmpCtx.beginPath();
    s.metrics.forEach((m, i) => { i ? cmpCtx.lineTo(X(m.t), Y(m.waiting)) : cmpCtx.moveTo(X(m.t), Y(m.waiting)); });
    cmpCtx.stroke();
    // 峰值标记
    cmpCtx.fillStyle = color;
    cmpCtx.beginPath(); cmpCtx.arc(X(s.peak.tick), Y(s.peak.waiting), 3.5, 0, Math.PI * 2); cmpCtx.fill();
    cmpCtx.fillText(`${s.peak.waiting}@${fmtT(s.peak.tick)}`, X(s.peak.tick), Y(s.peak.waiting) - 6);
  };
  plot(A, '#e2554f');
  plot(B, '#3f8fe2');
  cmpCtx.fillStyle = '#e2554f'; cmpCtx.textAlign = 'left'; cmpCtx.fillText('— A 当前', padL + 6, padT + 4);
  cmpCtx.fillStyle = '#3f8fe2'; cmpCtx.fillText('— B 方案', padL + 70, padT + 4);
}

// ---------------- 工程与运行记录（要求 5） ----------------
function loadLS(k, dflt) { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } }
function saveLS(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function recordRun(note) {
  if (runRecorded && note === '自然完成') return;
  runRecorded = true;
  const runs = loadLS(LS_RUNS, []);
  runs.unshift({
    ts: new Date().toLocaleString(), scenario: currentScenario.id,
    seed: currentConfig.seed, ticks: maxTick, hash: frontierHash,
    peak: sim.peak.waiting, peakAt: fmtT(sim.peak.tick), note,
  });
  saveLS(LS_RUNS, runs.slice(0, 50));
  renderRuns();
}

function renderRuns() {
  const runs = loadLS(LS_RUNS, []);
  $('#runList').innerHTML = runs.length
    ? runs.map(r => `<div class="run">[${r.ts}] ${r.scenario} 种子${r.seed} ` +
        `<span class="h">${r.hash}</span> 峰值${r.peak}@${r.peakAt} ${r.note}</div>`).join('')
    : '<div style="color:var(--dim)">暂无记录</div>';
}

function renderProjects() {
  const projs = loadLS(LS_PROJ, []);
  $('#projList').innerHTML = projs.length
    ? projs.map((p, i) => `<div class="proj"><span class="name">${p.name} <span class="badge">${p.scenario}</span> <span style="color:var(--dim)">${p.savedAt}</span></span>` +
        `<button class="mini" data-load="${i}">载入</button><button class="mini" data-del="${i}">删除</button></div>`).join('')
    : '<div style="color:var(--dim)">暂无已存工程</div>';
  $('#projList').querySelectorAll('[data-load]').forEach(b => b.onclick = () => {
    const p = loadLS(LS_PROJ, [])[+b.dataset.load];
    $('#scenarioSel').value = p.scenario;
    loadScenario(p.scenario, structuredClone(p.config));
    setStatus(`已载入工程「${p.name}」`);
  });
  $('#projList').querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const projs2 = loadLS(LS_PROJ, []);
    projs2.splice(+b.dataset.del, 1);
    saveLS(LS_PROJ, projs2);
    renderProjects();
  });
}

$('#btnSaveProj').onclick = () => {
  const name = $('#projName').value.trim() || `工程-${new Date().toLocaleTimeString()}`;
  const projs = loadLS(LS_PROJ, []);
  projs.unshift({ name, scenario: currentScenario.id, config: currentConfig, savedAt: new Date().toLocaleString() });
  saveLS(LS_PROJ, projs.slice(0, 30));
  renderProjects();
  setStatus(`工程「${name}」已保存`);
};
$('#btnClearRuns').onclick = () => { saveLS(LS_RUNS, []); renderRuns(); };

$('#btnExport').onclick = () => {
  const data = { config: currentConfig, scenario: currentScenario.id, runs: loadLS(LS_RUNS, []) };
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wave-sim-${currentScenario.id}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('#btnImport').onclick = () => $('#importFile').click();
$('#importFile').onchange = ev => {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      const scen = SCENARIOS.find(s => s.id === data.scenario) ? data.scenario : currentScenario.id;
      $('#scenarioSel').value = scen;
      loadScenario(scen, data.config);
      setStatus('导入成功');
    } catch (err) { setStatus('导入失败：' + err.message); }
  };
  reader.readAsText(f);
  ev.target.value = '';
};

$('#btnApplyConfig').onclick = () => {
  try {
    const cfg = JSON.parse($('#configJson').value);
    currentConfig = cfg;
    $('#seedInput').value = cfg.seed;
    rebuildSim();
    $('#configMsg').textContent = '已应用';
    setStatus('配置已应用并重建模拟');
  } catch (err) {
    $('#configMsg').textContent = 'JSON 错误：' + err.message;
  }
};

// ---------------- 状态栏 ----------------
function setStatus(msg) { $('#statusBar').textContent = msg; }

// ---------------- 启动 ----------------
$('#scenarioSel').innerHTML = SCENARIOS.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
loadScenario(SCENARIOS[0].id);
renderProjects();
renderRuns();
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target === document.body) {
    e.preventDefault();
    $('#btnPlay').click();
  }
});
