'use strict';
/*
 * 游戏移动同步本机演示（无真实网络，全部程序模拟）
 *
 * 三个角色同屏：
 *   本地预测（绿）：键盘输入立即生效，不等主机。
 *   主机确认（橙）：输入经"上行延迟/抖动/丢包"后才到达，主机按到达顺序模拟。
 *   远端观察（蓝）：另一个玩家看到的我们，只吃主机快照，做插值平滑；
 *                   另有灰色"直跳"对照视图，不平滑直接跳变。
 *
 * 修正（reconciliation）：主机快照带回已确认的输入序号 ack，
 *   本地把状态回滚到主机状态，再把 ack 之后所有未确认输入重放一遍。
 *   重复/乱序的快照（ack <= 已处理 ack）直接丢弃，不会把角色留在旧位置。
 *
 * 确定性：固定 60Hz 步长，网络随机性全部来自种子随机数；
 *   参数 + 种子 + 逐帧输入可完整复现一次运行（导出/导入 JSON 复查）。
 */

// ================= 常量 =================
const TICK_MS = 1000 / 60;   // 固定步长
const SPEED = 2.5;           // px / tick
const PS = 16;               // 玩家方块边长
const W = 640, H = 440;      // 场地
const WALLS = [{ x: 350, y: 120, w: 24, h: 300 }]; // 竖墙，上方留缺口
const INTERP_TICKS = 9;      // 远端插值延迟（150ms）
const STALE_TICKS = 45;      // 超过 750ms 没收到快照 → 数据过时

const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8; // 输入位掩码

// ================= 确定性随机 =================
// mulberry32，状态只是一个整数，方便随快照保存/恢复
function rngNext(r) {
  r.state |= 0; r.state = (r.state + 0x6D2B79F5) | 0;
  let t = Math.imul(r.state ^ (r.state >>> 15), 1 | r.state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ================= 移动与碰撞（本地与主机共用同一套） =================
function maskDelta(mask) {
  let dx = (mask & RIGHT ? 1 : 0) - (mask & LEFT ? 1 : 0);
  let dy = (mask & DOWN ? 1 : 0) - (mask & UP ? 1 : 0);
  if (dx !== 0 && dy !== 0) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  return [dx * SPEED, dy * SPEED];
}
function overlaps(x, y, w) {
  return x < w.x + w.w && x + PS > w.x && y < w.y + w.h && y + PS > w.y;
}
function tryMove(x, y, mask) {
  const [dx, dy] = maskDelta(mask);
  let nx = Math.min(Math.max(x + dx, 0), W - PS);
  for (const w of WALLS) if (overlaps(nx, y, w)) nx = dx > 0 ? w.x - PS : w.x + w.w;
  let ny = Math.min(Math.max(y + dy, 0), H - PS);
  for (const w of WALLS) if (overlaps(nx, ny, w)) ny = dy > 0 ? w.y - PS : w.y + w.h;
  return [nx, ny];
}

// ================= 全局状态 =================
// S 里全部是"当前指针"，每帧整体 structuredClone 存进 SNAPS，可任意回跳。
let S = null;
// 只追加的全局记录（快照里只存长度，回跳时改长度指针即可）
let HIST = [];    // 本地输入历史 {seq, mask}
let CORR = [];    // 修正记录
let FLASH = [];   // 修正连线特效
let INCHG = [];   // 实时模式的输入变化 {t, mask}
let PARAMEV = []; // 参数修改事件 {t, k, v}
let SNAPS = [];   // 每帧完整状态
let S0 = null;    // 初始条件 {seed, params, start}，用于导出复现

const DEFAULT_PARAMS = {
  upLat: 100, upJit: 20, upLoss: 0.02,       // 上行：本地 → 主机
  downLat: 100, downJit: 20, downLoss: 0.02, // 下行：主机 → 本地/远端
  snapEvery: 3,                              // 主机快照间隔（20Hz）
};

function resetSim(seed, params, start, mode) {
  S = {
    tick: 0,
    rng: { state: seed >>> 0 },
    params: Object.assign({}, params),
    mode,                       // 'live' 实时键盘 | 'replay' 脚本回放
    client: { x: start[0], y: start[1], seq: 0, lastAck: 0 },
    server: { x: start[0], y: start[1], tick: 0, lastSeq: 0, sinceSnap: 0 },
    up: [], downClient: [], downRemote: [], // 三条"在途消息"队列
    ord: 0,
    rbuf: [],                   // 远端收到的快照缓冲
    drops: { up: 0, downClient: 0, downRemote: 0 },
    histLen: 0, corrLen: 0, flashLen: 0, inChgLen: 0, paramEvLen: 0,
  };
  HIST = []; CORR = []; FLASH = []; INCHG = []; PARAMEV = [];
  S0 = { seed, params: Object.assign({}, params), start: start.slice() };
  SNAPS = [structuredClone(S)];
  lastMask = 0;
}

// ================= 网络模拟 =================
// 丢包与抖动都走种子随机数，调用顺序固定 → 可复现
function chanSend(q, msg, lat, jit, loss) {
  if (rngNext(S.rng) < loss) return false;
  const j = (rngNext(S.rng) * 2 - 1) * jit;
  const dt = Math.max(0, Math.round((lat + j) / TICK_MS));
  q.push({ deliver: S.tick + dt, ord: S.ord++, msg });
  return true;
}
function takeDue(q) {
  const due = [], rest = [];
  for (const m of q) (m.deliver <= S.tick ? due : rest).push(m);
  due.sort((a, b) => a.deliver - b.deliver || a.ord - b.ord);
  q.length = 0; q.push(...rest);
  return due;
}

// ================= 主机快照 → 本地修正 =================
function reconcile(snap) {
  const c = S.client;
  if (snap.ack <= c.lastAck) return; // 重复/乱序确认：直接丢弃
  c.lastAck = snap.ack;
  const preX = c.x, preY = c.y;
  // 回滚到主机状态，重放所有未确认输入
  let x = snap.x, y = snap.y;
  const replayed = [];
  for (let i = 0; i < S.histLen; i++) {
    const h = HIST[i];
    if (h.seq > snap.ack) { [x, y] = tryMove(x, y, h.mask); replayed.push(h.seq); }
  }
  c.x = x; c.y = y;
  const err = Math.hypot(preX - x, preY - y);
  if (err > 0.5) { // 只记录看得见的修正
    pushCorr({
      tick: S.tick + 1, ack: snap.ack, sTick: snap.sTick, err,
      preX, preY, postX: x, postY: y, svX: snap.x, svY: snap.y, replayed,
    });
    pushFlash({ tick: S.tick, x1: preX, y1: preY, x2: x, y2: y });
  }
}
function pushCorr(e) { if (S.corrLen < CORR.length) CORR.length = S.corrLen; CORR.push(e); S.corrLen = CORR.length; }
function pushFlash(e) { if (S.flashLen < FLASH.length) FLASH.length = S.flashLen; FLASH.push(e); S.flashLen = FLASH.length; }

function remoteRecv(snap) {
  const b = S.rbuf;
  if (b.length === 0 || snap.sTick > b[b.length - 1].sTick) {
    b.push({ sTick: snap.sTick, x: snap.x, y: snap.y, arr: S.tick });
  }
}

// ================= 一帧模拟 =================
function stepSim(mask) {
  const p = S.params, c = S.client, sv = S.server;

  // 1) 本地预测：输入立即生效，并发给主机
  c.seq++;
  if (S.histLen < HIST.length) HIST.length = S.histLen;
  HIST.push({ seq: c.seq, mask }); S.histLen = HIST.length;
  [c.x, c.y] = tryMove(c.x, c.y, mask);
  if (!chanSend(S.up, { seq: c.seq, mask }, p.upLat, p.upJit, p.upLoss)) S.drops.up++;

  // 2) 主机收到输入：只接受 seq 递增的（晚到/重复直接丢弃），按到达顺序应用
  for (const m of takeDue(S.up)) {
    if (m.msg.seq > sv.lastSeq) {
      sv.lastSeq = m.msg.seq;
      [sv.x, sv.y] = tryMove(sv.x, sv.y, m.msg.mask);
    }
  }

  // 3) 主机按固定频率发快照（本地、远端各走一条独立下行通道）
  sv.tick++; sv.sinceSnap++;
  if (sv.sinceSnap >= p.snapEvery) {
    sv.sinceSnap = 0;
    const snap = { ack: sv.lastSeq, x: sv.x, y: sv.y, sTick: sv.tick };
    if (!chanSend(S.downClient, Object.assign({}, snap), p.downLat, p.downJit, p.downLoss)) S.drops.downClient++;
    if (!chanSend(S.downRemote, Object.assign({}, snap), p.downLat, p.downJit, p.downLoss)) S.drops.downRemote++;
  }

  // 4) 本地收到快照 → 修正
  for (const m of takeDue(S.downClient)) reconcile(m.msg);
  // 5) 远端收到快照 → 进插值缓冲
  for (const m of takeDue(S.downRemote)) remoteRecv(m.msg);
}

// ================= 输入 =================
const keysDown = new Set();
let lastMask = 0;
let replayMasks = null; // 回放模式：逐帧掩码数组
let replayDuration = 0;

function liveMask() {
  let m = 0;
  if (keysDown.has('ArrowUp')) m |= UP;
  if (keysDown.has('ArrowDown')) m |= DOWN;
  if (keysDown.has('ArrowLeft')) m |= LEFT;
  if (keysDown.has('ArrowRight')) m |= RIGHT;
  return m;
}
function recordInput(mask) {
  if (mask === lastMask) return;
  if (S.inChgLen < INCHG.length) INCHG.length = S.inChgLen;
  INCHG.push({ t: S.tick, mask }); S.inChgLen = INCHG.length;
  lastMask = mask;
}
function applyParamEvents() {
  for (const e of PARAMEV) if (e.t === S.tick) S.params[e.k] = e.v;
}

function doStep() {
  applyParamEvents();
  const mask = S.mode === 'replay'
    ? (S.tick < replayMasks.length ? replayMasks[S.tick] : 0)
    : liveMask();
  if (S.mode === 'live') recordInput(mask);
  stepSim(mask);
  S.tick++;
  if (SNAPS.length > S.tick) SNAPS.length = S.tick; // 回跳后又走了新未来 → 截断旧未来
  SNAPS.push(structuredClone(S));
}

function seek(t) {
  t = Math.max(0, Math.min(t, SNAPS.length - 1));
  S = structuredClone(SNAPS[t]);
  lastMask = S.inChgLen > 0 ? INCHG[S.inChgLen - 1].mask : 0;
}

// ================= 远端视图（插值 / 直跳 / 过时） =================
function remoteView() {
  const buf = S.rbuf;
  if (!buf.length) return null;
  const newest = buf[buf.length - 1];
  const stale = (S.tick - newest.arr) > STALE_TICKS;
  // 渲染时钟：最新快照的服务器帧 - 插值延迟，随后跟本地时钟前进
  let rt = newest.sTick - INTERP_TICKS + (S.tick - newest.arr);
  if (rt > newest.sTick) rt = newest.sTick;
  let a = buf[0], b = null;
  for (let i = buf.length - 1; i > 0; i--) {
    if (buf[i - 1].sTick <= rt) { a = buf[i - 1]; b = buf[i]; break; }
  }
  let x, y;
  if (b && b.sTick > a.sTick) {
    const t = (rt - a.sTick) / (b.sTick - a.sTick);
    x = a.x + (b.x - a.x) * t; y = a.y + (b.y - a.y) * t;
  } else { x = a.x; y = a.y; }
  return { x, y, ft: rt, stale, rawX: newest.x, rawY: newest.y, rawFt: newest.sTick };
}

// ================= 场景：保存 / 加载 / 内置示例 =================
function exportScenario(name) {
  return {
    name,
    seed: S0.seed,
    params: S0.params,
    start: S0.start,
    duration: S.tick,
    inputs: INCHG.slice(0, S.inChgLen),
    paramEvents: PARAMEV.slice(0, S.paramEvLen),
  };
}
function loadScenario(sc) {
  resetSim(sc.seed, sc.params, sc.start, 'replay');
  INCHG = (sc.inputs || []).slice();
  S.inChgLen = INCHG.length;
  PARAMEV = (sc.paramEvents || []).slice();
  S.paramEvLen = PARAMEV.length;
  replayDuration = sc.duration;
  replayMasks = new Array(sc.duration).fill(0);
  let cur = 0;
  for (const ch of INCHG) { cur = ch.mask; for (let t = ch.t; t < sc.duration; t++) replayMasks[t] = cur; }
  lastMask = 0;
}

// 内置示例 1：正常走动（低延迟低丢包，修正几乎不可见）
const PRESET_WALK = {
  name: 'walk-正常走动',
  seed: 7,
  params: { upLat: 70, upJit: 15, upLoss: 0.01, downLat: 90, downJit: 25, downLoss: 0.01, snapEvery: 3 },
  start: [40, 360],
  duration: 420,
  inputs: [
    { t: 15, mask: 8 },  // 向右
    { t: 130, mask: 9 }, // 向右上
    { t: 210, mask: 1 }, // 向上
    { t: 280, mask: 0 }, // 停
  ],
  paramEvents: [],
};
// 内置示例 2：碰墙（高延迟高丢包，顶墙滑行时修正明显）
const PRESET_WALL = {
  name: 'wall-碰墙偏差',
  seed: 21,
  params: { upLat: 120, upJit: 40, upLoss: 0.10, downLat: 140, downJit: 40, downLoss: 0.05, snapEvery: 3 },
  start: [60, 300],
  duration: 460,
  inputs: [
    { t: 10, mask: 8 },  // 向右撞墙
    { t: 130, mask: 9 }, // 顶着墙向上滑
    { t: 260, mask: 1 }, // 翻过墙顶向上
    { t: 330, mask: 0 }, // 停
  ],
  paramEvents: [],
};

// ================= 以下为本机 UI（浏览器环境才执行） =================
function init() {
  const cv = document.getElementById('cv');
  const ctx = cv.getContext('2d');
  const el = id => document.getElementById(id);
  let paused = false;
  let showGhost = true;
  let selCorr = -1;
  let renderedCorrLen = -1;

  resetSim(1, DEFAULT_PARAMS, [60, 300], 'live');

  const PARAM_KEYS = [
    ['upLat', '上行延迟', 'Q/A', 10, 'ms'], ['upJit', '上行抖动', 'W/S', 5, 'ms'],
    ['upLoss', '上行丢包', 'E/D', 0.01, ''], ['downLat', '下行延迟', 'R/F', 10, 'ms'],
    ['downJit', '下行抖动', 'T/G', 5, 'ms'], ['downLoss', '下行丢包', 'Y/H', 0.01, ''],
  ];
  const KEYMAP = { q: ['upLat', 1], a: ['upLat', -1], w: ['upJit', 1], s: ['upJit', -1],
    e: ['upLoss', 1], d: ['upLoss', -1], r: ['downLat', 1], f: ['downLat', -1],
    t: ['downJit', 1], g: ['downJit', -1], y: ['downLoss', 1], h: ['downLoss', -1] };

  function adjustParam(k, dir) {
    const def = PARAM_KEYS.find(p => p[0] === k);
    let v = S.params[k] + def[3] * dir;
    v = k.endsWith('Loss') ? Math.min(Math.max(v, 0), 0.5) : Math.max(v, 0);
    v = Math.round(v * 1000) / 1000;
    if (S.paramEvLen < PARAMEV.length) PARAMEV.length = S.paramEvLen;
    PARAMEV.push({ t: S.tick, k, v }); S.paramEvLen = PARAMEV.length;
    S.params[k] = v;
  }

  function fmtMask(m) {
    const s = [];
    if (m & UP) s.push('↑'); if (m & DOWN) s.push('↓');
    if (m & LEFT) s.push('←'); if (m & RIGHT) s.push('→');
    return s.join('') || '·';
  }

  function drawEntity(x, y, color, label, dashed) {
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.strokeRect(x, y, PS, PS);
    ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.font = '11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(label, x + PS / 2, y + PS + 12);
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#161a22'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2a3040'; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    for (const w of WALLS) { ctx.fillStyle = '#4a5164'; ctx.fillRect(w.x, w.y, w.w, w.h); }

    // 修正连线特效（40 帧内淡出）
    for (let i = 0; i < S.flashLen; i++) {
      const f = FLASH[i], age = S.tick - f.tick;
      if (age < 0 || age > 40) continue;
      ctx.strokeStyle = `rgba(255,80,80,${1 - age / 40})`; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(f.x1 + PS / 2, f.y1 + PS / 2); ctx.lineTo(f.x2 + PS / 2, f.y2 + PS / 2); ctx.stroke();
    }

    const rv = remoteView();
    if (rv && showGhost) // 对照：直跳不平滑
      drawEntity(rv.rawX, rv.rawY, '#7f8c9b', `直跳 f${rv.rawFt}`, true);
    if (rv) { // 远端平滑插值
      drawEntity(rv.x, rv.y, rv.stale ? '#5a6b80' : '#3498db', `远端 f≈${rv.ft.toFixed(0)}`, false);
      if (rv.stale) {
        ctx.fillStyle = '#ff5555'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('数据过时', rv.x + PS / 2, rv.y - 6);
      }
    }
    drawEntity(S.server.x, S.server.y, '#e67e22', `主机 f${S.server.tick}`, false);
    drawEntity(S.client.x, S.client.y, '#2ecc71', `本地 f${S.tick}`, false);

    // 选中的修正：画出当时的主机位置与修正前后位置
    if (selCorr >= 0 && selCorr < S.corrLen) {
      const c = CORR[selCorr];
      if (c.tick === S.tick) {
        ctx.strokeStyle = '#ff5555'; ctx.setLineDash([3, 3]);
        ctx.strokeRect(c.svX - 3, c.svY - 3, PS + 6, PS + 6);
        ctx.strokeRect(c.preX - 6, c.preY - 6, PS + 12, PS + 12);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff5555'; ctx.textAlign = 'left';
        ctx.fillText(`修正#${selCorr + 1}: 虚线大框=预测位置 小框=主机状态`, 8, H - 10);
      }
    }
    updateHud();
  }

  function updateHud() {
    el('status').textContent =
      `帧 ${S.tick} | ${S.mode === 'live' ? '实时操作' : '脚本回放'} | ${paused ? '已暂停' : '运行中'}` +
      ` | 丢包计数 上${S.drops.up} 下(本地)${S.drops.downClient} 下(远端)${S.drops.downRemote}` +
      (S.mode === 'replay' && S.tick >= replayDuration ? ' | 回放结束' : '');
    el('params').innerHTML = PARAM_KEYS.map(([k, name, keys, , unit]) => {
      const v = k.endsWith('Loss') ? (S.params[k] * 100).toFixed(0) + '%' : S.params[k] + unit;
      return `<tr><td>${name}</td><td class="v">${v}</td><td class="k">${keys}</td></tr>`;
    }).join('') + `<tr><td>快照间隔</td><td class="v">${S.params.snapEvery}帧</td><td class="k">固定</td></tr>`;

    if (renderedCorrLen !== S.corrLen) {
      renderedCorrLen = S.corrLen;
      el('corrList').innerHTML = CORR.slice(0, S.corrLen).map((c, i) =>
        `<li data-i="${i}" class="${i === selCorr ? 'sel' : ''}">` +
        `#${i + 1} 帧${c.tick} 差${c.err.toFixed(1)}px 确认seq${c.ack} 重放${c.replayed.length}个输入</li>`
      ).join('') || '<li class="dim">（暂无修正：丢包/乱序导致分歧时会出现在这里）</li>';
      el('corrList').querySelectorAll('li[data-i]').forEach(li =>
        li.onclick = () => { selCorr = +li.dataset.i; jumpToCorr(); });
    }
    if (selCorr >= 0 && selCorr < S.corrLen) {
      const c = CORR[selCorr];
      el('corrDetail').textContent =
        `修正 #${selCorr + 1} @帧${c.tick}：主机确认到 seq=${c.ack}（主机帧${c.sTick}）\n` +
        `位置差 ${c.err.toFixed(2)}px　主机状态(${c.svX.toFixed(1)},${c.svY.toFixed(1)})\n` +
        `预测(${c.preX.toFixed(1)},${c.preY.toFixed(1)}) → 修正后(${c.postX.toFixed(1)},${c.postY.toFixed(1)})\n` +
        `生效的未确认输入：${c.replayed.length ? c.replayed.map(s => '#' + s).join(' ') : '（无）'}`;
    } else {
      el('corrDetail').textContent = '用 [ ] 选择修正记录，按 C 跳转到该帧查看来源。';
    }
  }

  function jumpToCorr() {
    if (selCorr < 0 || selCorr >= S.corrLen) return;
    paused = true;
    seek(CORR[selCorr].tick);
    renderedCorrLen = -1;
  }

  function download(name, obj) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    a.download = name; a.click();
    URL.revokeObjectURL(a.href);
  }

  document.addEventListener('keydown', ev => {
    const k = ev.key.toLowerCase();
    if (ev.key.startsWith('Arrow') || ev.key === ' ') ev.preventDefault();
    if (ev.key.startsWith('Arrow')) { keysDown.add(ev.key); return; }
    if (ev.repeat) return;
    if (k in KEYMAP) { adjustParam(...KEYMAP[k]); return; }
    switch (k) {
      case ' ': paused = !paused; break;
      case '.': if (paused) { doStep(); } break;
      case ',': if (paused) { seek(S.tick - 1); renderedCorrLen = -1; } break;
      case '[': if (S.corrLen > 0) { selCorr = (selCorr - 1 + S.corrLen) % S.corrLen; renderedCorrLen = -1; } break;
      case ']': if (S.corrLen > 0) { selCorr = (selCorr + 1) % S.corrLen; renderedCorrLen = -1; } break;
      case 'c': jumpToCorr(); break;
      case 'x': showGhost = !showGhost; break;
      case 'p': download(`scenario-${S0.seed}-f${S.tick}.json`, exportScenario('manual')); break;
      case '0': resetSim(1, DEFAULT_PARAMS, [60, 300], 'live'); selCorr = -1; renderedCorrLen = -1; break;
      case '1': loadScenario(PRESET_WALK); paused = false; selCorr = -1; renderedCorrLen = -1; break;
      case '2': loadScenario(PRESET_WALL); paused = false; selCorr = -1; renderedCorrLen = -1; break;
    }
  });
  document.addEventListener('keyup', ev => { if (ev.key.startsWith('Arrow')) keysDown.delete(ev.key); });

  el('btnWalk').onclick = () => { loadScenario(PRESET_WALK); paused = false; selCorr = -1; renderedCorrLen = -1; };
  el('btnWall').onclick = () => { loadScenario(PRESET_WALL); paused = false; selCorr = -1; renderedCorrLen = -1; };
  el('btnReset').onclick = () => { resetSim(1, DEFAULT_PARAMS, [60, 300], 'live'); selCorr = -1; renderedCorrLen = -1; };
  el('btnExport').onclick = () => download(`scenario-${S0.seed}-f${S.tick}.json`, exportScenario('manual'));
  el('fileInput').onchange = ev => {
    const f = ev.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { loadScenario(JSON.parse(rd.result)); paused = false; selCorr = -1; renderedCorrLen = -1; }
      catch (e) { alert('场景文件解析失败: ' + e.message); }
    };
    rd.readAsText(f);
    ev.target.value = '';
  };

  // 主循环：真实时间驱动，固定步长推进
  let acc = 0, last = performance.now();
  function loop(now) {
    acc += now - last; last = now;
    if (!paused) {
      let n = 0;
      while (acc >= TICK_MS && n < 5) {
        if (S.mode === 'replay' && S.tick >= replayDuration) { paused = true; break; }
        doStep(); acc -= TICK_MS; n++;
      }
      if (n === 5) acc = 0;
    } else acc = 0;
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

// Node 冒烟测试钩子（浏览器里忽略）
globalThis.DEMO = {
  resetSim, loadScenario, doStep, seek, remoteView, tryMove,
  PRESET_WALK, PRESET_WALL, DEFAULT_PARAMS,
  get S() { return S; }, get CORR() { return CORR; }, get SNAPS() { return SNAPS; },
};
if (typeof document !== 'undefined') init();
