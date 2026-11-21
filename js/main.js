import {
  TICK_RATE, DT, WORLD_W, WORLD_H, PLAYER_SIZE,
  LEVELS, levelConfig, levelHash, createState, step as simStep,
} from './sim.js';
import { makeRecording, validateRecording, Replay } from './recorder.js';

const $ = id => document.getElementById(id);

/* ================= 关卡 ================= */

const levelSelect = $('level-select');
const speedSlider = $('speed-slider');
for (const l of LEVELS) {
  const op = document.createElement('option');
  op.value = l.id;
  op.textContent = l.name;
  levelSelect.appendChild(op);
}
levelSelect.value = LEVELS[0].id;
speedSlider.value = LEVELS[0].speed;

function currentCfg() {
  return levelConfig(levelSelect.value, Number(speedSlider.value));
}

function refreshLevelUI() {
  const cfg = currentCfg();
  $('speed-value').textContent = `${cfg.speed} 单位/秒`;
  $('level-hash').textContent = levelHash(cfg);
  return cfg;
}

/* ================= 绘制 ================= */

function drawWorld(ctx, cfg, state, scale = 1) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.strokeStyle = '#1d232e';
  for (let x = 0; x <= WORLD_W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, WORLD_H); ctx.stroke(); }
  for (let y = 0; y <= WORLD_H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(WORLD_W, y); ctx.stroke(); }
  // 起点标记
  ctx.fillStyle = '#2f7a44';
  ctx.fillRect(cfg.start.x, cfg.start.y, PLAYER_SIZE, PLAYER_SIZE);
  // 障碍
  ctx.fillStyle = '#4a5568';
  for (const o of cfg.obstacles) ctx.fillRect(o.x, o.y, o.w, o.h);
  // 角色
  ctx.fillStyle = '#63b3ed';
  ctx.fillRect(state.x, state.y, PLAYER_SIZE, PLAYER_SIZE);
  ctx.fillStyle = '#1a365d';
  ctx.fillRect(state.x + 6, state.y + 6, 5, 5);
  ctx.fillRect(state.x + 13, state.y + 6, 5, 5);
}

/* ================= 实时演示 ================= */

const live = {
  canvas: $('live-canvas'),
  ctx: $('live-canvas').getContext('2d'),
  cfg: null,
  state: null,
  tick: 0,
  acc: 0,
  last: null,
  fpsCap: 0,          // 0 = 每个 rAF 都渲染
  lastRender: 0,
  renderTimes: [],
  recording: null,    // { events, startState } | null
  pendingDowns: new Set(), // 本逻辑帧内按下过的方向（快速点按也算按住一帧，与回放语义一致）
};

function liveReset() {
  live.cfg = refreshLevelUI();
  live.state = createState(live.cfg);
  live.tick = 0;
  live.acc = 0;
}

levelSelect.addEventListener('change', () => {
  const l = LEVELS.find(x => x.id === levelSelect.value);
  speedSlider.value = l.speed;
  stopRecordingIfAny(false);
  liveReset();
  refreshCompatBanner();
});
speedSlider.addEventListener('input', () => {
  stopRecordingIfAny(false);
  liveReset();
  refreshCompatBanner();
});
$('fps-cap').addEventListener('change', e => { live.fpsCap = Number(e.target.value); });

/* ---- 键盘输入：支持多键同按、快速点按、失焦松开 ---- */

const codeToDir = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
};
const pressedCodes = new Set();
let activeDirs = new Set();

function dirChanged(dir, down) {
  if (down) { live.state.keys.add(dir); live.pendingDowns.add(dir); }
  else live.state.keys.delete(dir);
  if (live.recording) {
    // 时间戳 = 已完成的逻辑帧数；同一帧内的多次变化按顺序保留（快速点按不丢）
    live.recording.events.push({ t: live.tick, k: dir, d: down ? 1 : 0 });
  }
}

function syncDirs() {
  const next = new Set([...pressedCodes].map(c => codeToDir[c]).filter(Boolean));
  for (const d of next) if (!activeDirs.has(d)) dirChanged(d, true);
  for (const d of activeDirs) if (!next.has(d)) dirChanged(d, false);
  activeDirs = next;
  $('live-keys').textContent = activeDirs.size ? [...activeDirs].join(' + ') : '无';
}

window.addEventListener('keydown', e => {
  const dir = codeToDir[e.code];
  if (!dir || e.repeat) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  e.preventDefault();
  pressedCodes.add(e.code);
  syncDirs();
});
window.addEventListener('keyup', e => {
  if (!codeToDir[e.code]) return;
  pressedCodes.delete(e.code);
  syncDirs();
});
// 失去焦点 / 页面隐藏：松开全部按键，角色不能继续奔跑
function releaseAllKeys() {
  pressedCodes.clear();
  syncDirs();
}
window.addEventListener('blur', releaseAllKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAllKeys(); });

/* ---- 录制 ---- */

$('record-start').addEventListener('click', () => {
  releaseAllKeys();
  liveReset();
  live.recording = { events: [], startState: { x: live.state.x, y: live.state.y } };
  $('record-start').disabled = true;
  $('record-stop').disabled = false;
  $('record-status').textContent = '● 录制中……操作角色，停止后自动保存。';
});

function stopRecordingIfAny(save) {
  if (!live.recording) return;
  const rec = live.recording;
  live.recording = null;
  $('record-start').disabled = false;
  $('record-stop').disabled = true;
  if (!save) { $('record-status').textContent = '录制已取消（关卡已变更）。'; return; }
  // 收尾：仍按住的键在最后一帧统一松开，避免回放末尾带着按键状态结束
  for (const d of activeDirs) rec.events.push({ t: live.tick, k: d, d: 0 });
  releaseAllKeys();
  const name = `录制 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  const out = makeRecording(live.cfg, rec.startState, rec.events, live.tick, name);
  storePut(name, out);
  refreshRecSelect(name);
  $('record-status').textContent = `已保存「${name}」：${out.durationTicks} 帧 · ${out.events.length} 个事件。`;
}
$('record-stop').addEventListener('click', () => stopRecordingIfAny(true));

/* ================= 录制存储（localStorage，重开页面可复查） ================= */

const LS_KEY = 'gsb.replays.v1';
function storeAll() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; } }
function storeSave(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
function storePut(name, rec) { const s = storeAll(); s[name] = rec; storeSave(s); }
function storeDel(name) { const s = storeAll(); delete s[name]; storeSave(s); }

function refreshRecSelect(selectName) {
  const sel = $('rec-select');
  sel.innerHTML = '';
  const names = Object.keys(storeAll());
  for (const n of names) {
    const op = document.createElement('option');
    op.value = n;
    op.textContent = n;
    sel.appendChild(op);
  }
  if (selectName && names.includes(selectName)) sel.value = selectName;
  onRecSelected();
}

function currentRec() {
  const name = $('rec-select').value;
  return name ? storeAll()[name] : null;
}

/* ================= 回放 ================= */

const replayView = {
  canvas: $('replay-canvas'),
  ctx: $('replay-canvas').getContext('2d'),
  replay: null,
  playing: false,
  acc: 0,
  last: null,
};

function onRecSelected() {
  const rec = currentRec();
  replayView.playing = false;
  $('replay-play').textContent = '▶ 播放';
  if (!rec) {
    replayView.replay = null;
    $('rec-hash').textContent = '—';
    $('rec-duration').textContent = '—';
    $('rec-events').textContent = '—';
    $('replay-seek').max = 0;
    $('replay-seek').value = 0;
    $('replay-tick-label').textContent = '0 / 0';
    refreshCompatBanner();
    drawWorld(replayView.ctx, currentCfg(), createState(currentCfg()));
    return;
  }
  replayView.replay = new Replay(rec);
  $('rec-hash').textContent = rec.levelHash;
  $('rec-duration').textContent = `${rec.durationTicks} 帧 · ${(rec.durationTicks / TICK_RATE).toFixed(2)} s`;
  $('rec-events').textContent = rec.events.length;
  $('replay-seek').max = rec.durationTicks;
  $('replay-goto').max = rec.durationTicks;
  refreshCompatBanner();
  updateReplayView();
}

// 兼容性提示：录制里的关卡指纹 vs 当前关卡指纹
function refreshCompatBanner() {
  const banner = $('compat-banner');
  const rec = currentRec();
  if (!rec) { banner.classList.add('hidden'); return; }
  const cur = currentCfg();
  const curHash = levelHash(cur);
  banner.classList.remove('hidden');
  if (rec.levelHash === curHash) {
    banner.className = 'banner ok';
    banner.innerHTML = `✓ 与当前关卡兼容（指纹 ${curHash}）。`;
  } else {
    banner.className = 'banner bad';
    const rl = rec.level;
    banner.innerHTML =
      `⚠ 回放与当前关卡<b>不兼容</b>：障碍布局或移速已更改。<br>` +
      `录制时：${rl.name || rl.id} · ${rl.speed} 单位/秒（指纹 ${rec.levelHash}）<br>` +
      `当前：${cur.name} · ${cur.speed} 单位/秒（指纹 ${curHash}）<br>` +
      `回放将按<b>录制时的关卡快照</b>运行，结果仍然准确。`;
    const known = LEVELS.some(l => l.id === rl.id);
    if (known) {
      const btn = document.createElement('button');
      btn.textContent = '把当前关卡恢复为录制版本';
      btn.style.marginTop = '6px';
      btn.addEventListener('click', () => {
        levelSelect.value = rl.id;
        speedSlider.value = rl.speed;
        stopRecordingIfAny(false);
        liveReset();
        refreshCompatBanner();
      });
      banner.appendChild(document.createElement('br'));
      banner.appendChild(btn);
    }
  }
}

function updateReplayView() {
  const r = replayView.replay;
  if (!r) return;
  drawWorld(replayView.ctx, r.rec.level, r.state);
  $('replay-seek').value = r.tick;
  $('replay-tick-label').textContent = `${r.tick} / ${r.rec.durationTicks}（${(r.tick / TICK_RATE).toFixed(2)}s）`;
  if (r.done && replayView.playing) {
    replayView.playing = false;
    $('replay-play').textContent = '▶ 播放';
  }
}

$('replay-play').addEventListener('click', () => {
  const r = replayView.replay;
  if (!r) return;
  if (r.done) r.reset();          // 播完了再点 = 重新播放
  replayView.playing = !replayView.playing;
  replayView.acc = 0;
  replayView.last = null;
  $('replay-play').textContent = replayView.playing ? '⏸ 暂停' : '▶ 播放';
});
$('replay-step').addEventListener('click', () => {
  const r = replayView.replay;
  if (!r) return;
  replayView.playing = false;
  $('replay-play').textContent = '▶ 播放';
  r.stepOne();
  updateReplayView();
});
$('replay-seek').addEventListener('input', e => {
  const r = replayView.replay;
  if (!r) return;
  replayView.playing = false;
  $('replay-play').textContent = '▶ 播放';
  r.stepTo(Number(e.target.value));
  updateReplayView();
});
$('replay-goto-btn').addEventListener('click', () => {
  const r = replayView.replay;
  if (!r) return;
  const n = Number($('replay-goto').value);
  if (Number.isFinite(n)) {
    replayView.playing = false;
    $('replay-play').textContent = '▶ 播放';
    r.stepTo(n);
    updateReplayView();
  }
});

/* ---- 导入 / 导出 / 示例 / 删除 ---- */

$('rec-export').addEventListener('click', () => {
  const rec = currentRec();
  if (!rec) return;
  const blob = new Blob([JSON.stringify(rec, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${rec.name || 'replay'}.replay.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('rec-import').addEventListener('click', () => $('rec-file').click());
$('rec-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let rec;
  try { rec = JSON.parse(await file.text()); } catch { alert('导入失败：不是合法 JSON。'); return; }
  const err = validateRecording(rec);
  if (err) { alert(`导入失败：${err}`); return; }
  const name = rec.name && !storeAll()[rec.name] ? rec.name : `导入 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
  rec.name = name;
  storePut(name, rec);
  refreshRecSelect(name);
  // 选中后 refreshCompatBanner 会自动提示是否与当前关卡兼容
});

$('rec-delete').addEventListener('click', () => {
  const name = $('rec-select').value;
  if (!name) return;
  if (!confirm(`删除录制「${name}」？`)) return;
  storeDel(name);
  refreshRecSelect();
});

// 生成“撞障碍再转向”示例：用当前关卡真实模拟生成，保证与该关卡兼容
function generateSample(cfg) {
  const events = [];
  const state = createState(cfg);
  let tick = 0;
  const press = k => { events.push({ t: tick, k, d: 1 }); state.keys.add(k); };
  const release = k => { events.push({ t: tick, k, d: 0 }); state.keys.delete(k); };
  const run = n => { for (let i = 0; i < n; i++) { simStep(state, cfg); tick++; } };

  press('right');
  // 一直向右，直到被障碍挡住（x 连续多帧不变）
  let still = 0;
  while (still < 12 && tick < TICK_RATE * 10) {
    const px = state.x;
    run(1);
    still = state.x === px ? still + 1 : 0;
  }
  release('right');
  press('up'); run(TICK_RATE);            // 转向：向上 1 秒
  release('up');
  press('left'); run(TICK_RATE / 2);      // 向左 0.5 秒
  press('down'); run(TICK_RATE / 4);      // 多键同按：左下斜走 0.25 秒
  release('left'); release('down');
  run(TICK_RATE / 2);                     // 结尾停半秒
  return makeRecording(cfg, { x: cfg.start.x, y: cfg.start.y }, events, tick, '示例：撞墙转向');
}

$('rec-sample').addEventListener('click', () => {
  const rec = generateSample(currentCfg());
  storePut(rec.name, rec);
  refreshRecSelect(rec.name);
});

/* ================= 双帧率并排校验 ================= */

const cmp = {
  a: { canvas: $('cmp-a'), ctx: $('cmp-a').getContext('2d') },
  b: { canvas: $('cmp-b'), ctx: $('cmp-b').getContext('2d') },
  stopFns: [],
};

function stopCompare() {
  for (const f of cmp.stopFns) f();
  cmp.stopFns = [];
}

// 一侧的驱动器：scheduler 决定渲染节奏，模拟始终按固定步长追帧
function runSide(side, rec, schedule, tickEl, fpsEl) {
  const replay = new Replay(rec);
  const log = [];                 // 每个逻辑帧结束后的位置
  let acc = 0, last = null, stopped = false;
  const renderTimes = [];

  const advance = now => {
    if (stopped) return;
    if (last == null) last = now;
    acc += Math.min((now - last) / 1000, 0.25);
    last = now;
    while (acc >= DT && !replay.done) {
      replay.stepOne();
      log.push({ x: replay.state.x, y: replay.state.y });
      acc -= DT;
    }
    if (replay.done) acc = 0;
    drawWorld(side.ctx, rec.level, replay.state, side.canvas.width / WORLD_W);
    renderTimes.push(now);
    while (renderTimes.length && renderTimes[0] < now - 1000) renderTimes.shift();
    tickEl.textContent = replay.tick;
    fpsEl.textContent = renderTimes.length;
    checkDivergence();
    if (!replay.done) schedule(advance);
    else finishIfBothDone();
  };
  schedule(advance);
  return {
    get log() { return log; },
    get done() { return replay.done; },
    stop() { stopped = true; },
  };
}

let cmpSides = null;
let cmpChecked = 0;
let cmpFinished = false;

function checkDivergence() {
  if (!cmpSides || cmpFinished) return;
  const { A, B, rec } = cmpSides;
  const n = Math.min(A.log.length, B.log.length);
  for (let i = cmpChecked; i < n; i++) {
    const pa = A.log[i], pb = B.log[i];
    if (pa.x !== pb.x || pa.y !== pb.y) {
      cmpFinished = true;
      stopCompare();
      const prevEvents = rec.events.filter(e => e.t <= i).slice(-5);
      const evText = prevEvents.length
        ? prevEvents.map(e => `第 ${e.t} 帧 ${e.d ? '按下' : '松开'} ${e.k}`).join('；')
        : '（此前无任何输入事件）';
      showCompareResult('bad',
        `✗ 首次分歧出现在第 ${i + 1} 逻辑帧：<br>` +
        `A 位置 (${pa.x.toFixed(3)}, ${pa.y.toFixed(3)})，B 位置 (${pb.x.toFixed(3)}, ${pb.y.toFixed(3)})<br>` +
        `分歧前的操作：${evText}`);
      return;
    }
  }
  cmpChecked = n;
}

function finishIfBothDone() {
  if (!cmpSides || cmpFinished) return;
  const { A, B, rec } = cmpSides;
  if (!A.done || !B.done) return;
  checkDivergence();          // 最后一轮比对；发现分歧会置 cmpFinished 并报告
  if (cmpFinished) return;    // 分歧已报告
  cmpFinished = true;
  stopCompare();
  showCompareResult('ok',
    `✓ 校验通过：${rec.durationTicks} 个逻辑帧在两种渲染调度下逐帧一致（共比对 ${cmpChecked} 帧）。`);
}

function showCompareResult(kind, html) {
  const el = $('compare-result');
  el.className = `banner ${kind}`;
  el.innerHTML = html;
}

function startCompare(injectFault) {
  const rec = currentRec();
  if (!rec) { showCompareResult('bad', '请先在「回放」区选择一段录制。'); return; }
  stopCompare();
  cmpChecked = 0;
  cmpFinished = false;
  $('compare-result').classList.add('hidden');

  // B 侧使用 24fps + 随机抖动的定时器调度；注入误差时给 B 换一个移速略有偏差的关卡
  const recB = injectFault
    ? { ...rec, level: { ...rec.level, speed: rec.level.speed * 1.01 } }
    : rec;

  // A 侧跟随屏幕刷新率；B 侧 24fps 定时器 + 随机抖动。模拟都按固定步长追帧。
  const sideA = runSide(cmp.a, rec,
    cb => requestAnimationFrame(cb),
    $('cmp-a-tick'), $('cmp-a-fps'));

  const sideB = runSide(cmp.b, recB,
    cb => setTimeout(() => cb(performance.now()), 1000 / 24 + Math.random() * 25),
    $('cmp-b-tick'), $('cmp-b-fps'));

  cmpSides = { A: sideA, B: sideB, rec };
  cmp.stopFns = [() => sideA.stop(), () => sideB.stop()];
  if (injectFault) {
    showCompareResult('bad', '已给 B 侧注入 1% 移速误差，观察首次分歧报告……');
  }
}

$('compare-start').addEventListener('click', () => startCompare(false));
$('compare-fault').addEventListener('click', () => startCompare(true));

/* ================= 主循环 ================= */

function frame(now) {
  // 实时演示：模拟始终追帧，渲染按 fpsCap 节流
  if (live.last == null) live.last = now;
  live.acc += Math.min((now - live.last) / 1000, 0.25);
  live.last = now;
  while (live.acc >= DT) {
    // 本帧内按下过的方向计入本帧输入（快速点按不丢），与 Replay.stepOne 语义一致
    if (live.pendingDowns.size) {
      const finalKeys = live.state.keys;
      live.state.keys = new Set([...finalKeys, ...live.pendingDowns]);
      simStep(live.state, live.cfg);
      live.state.keys = finalKeys;
      live.pendingDowns.clear();
    } else {
      simStep(live.state, live.cfg);
    }
    live.tick++;
    live.acc -= DT;
  }
  const minInterval = live.fpsCap > 0 ? 1000 / live.fpsCap : 0;
  if (now - live.lastRender >= minInterval) {
    live.lastRender = now;
    drawWorld(live.ctx, live.cfg, live.state);
    live.renderTimes.push(now);
    while (live.renderTimes.length && live.renderTimes[0] < now - 1000) live.renderTimes.shift();
    $('live-fps').textContent = live.renderTimes.length;
    $('live-tick').textContent = live.tick;
    $('live-time').textContent = (live.tick / TICK_RATE).toFixed(2);
  }

  // 回放播放
  const rv = replayView;
  if (rv.playing && rv.replay) {
    if (rv.last == null) rv.last = now;
    rv.acc += Math.min((now - rv.last) / 1000, 0.25);
    rv.last = now;
    while (rv.acc >= DT && !rv.replay.done) {
      rv.replay.stepOne();
      rv.acc -= DT;
    }
    if (rv.replay.done) rv.acc = 0;
    updateReplayView();
  } else {
    rv.last = null;
  }

  requestAnimationFrame(frame);
}

/* ================= 启动 ================= */

liveReset();
// 首次使用自动生成一段“撞墙转向”示例，重开页面也能复查
if (Object.keys(storeAll()).length === 0) {
  const rec = generateSample(currentCfg());
  storePut(rec.name, rec);
}
refreshRecSelect();
requestAnimationFrame(frame);
