// app.js — 页面交互层:量化对照、波形绘制、试听、WAV 导出回读。
import {
  mulberry32, quantizeSignal, blockStats, encodeWav, decodeWav,
  generateSignal, histogram,
} from './dsp.js';

/* ================= 状态 ================= */

const BIT_CHOICES = [1, 2, 3, 4, 6, 8, 12, 16];

const state = {
  source: null,                 // {name, sampleRate, channels, segments}
  active: 'A',
  settings: {
    A: { bits: 4, mode: 'tpdf', amp: 1, seed: 20261128, lock: true },
    B: { bits: 8, mode: 'off', amp: 1, seed: 20261128, lock: true },
  },
  results: { A: null, B: null }, // 每侧 quantizeSignal 的完整结果(所有声道)
  channel: 0,
  view: { s0: 0, s1: 0 },       // 当前可视样本区间
  cursor: null,                 // 游标样本号
  yZoom: 1,
  blockMs: 50,
  showHistErr: true,
  masterGainDb: -6,
  errGain: 8,
  loop: false,
  hover: null,
};

const $ = (id) => document.getElementById(id);
const fmt = (x, d = 4) => (Number.isFinite(x) ? x.toFixed(d) : '∞');
const db = (x) => (x <= 0 ? '-∞' : (20 * Math.log10(x)).toFixed(1) + ' dBFS');

/* ================= 初始化控件 ================= */

function fillBitSelects() {
  for (const side of ['A', 'B']) {
    const sel = $(`bits-${side}`);
    sel.innerHTML = '';
    for (const b of BIT_CHOICES) {
      const o = document.createElement('option');
      o.value = String(b);
      o.textContent = `${b} 位`;
      o.selected = b === state.settings[side].bits;
      sel.appendChild(o);
    }
  }
}

function settingsToForm(side) {
  const s = state.settings[side];
  $(`bits-${side}`).value = String(s.bits);
  $(`mode-${side}`).value = s.mode;
  $(`amp-${side}`).value = String(s.amp);
  $(`seed-${side}`).value = String(s.seed);
  $(`lock-${side}`).checked = s.lock;
}

function formToSettings(side) {
  const s = state.settings[side];
  s.bits = Number($(`bits-${side}`).value);
  s.mode = $(`mode-${side}`).value;
  s.amp = Number($(`amp-${side}`).value);
  s.seed = Number($(`seed-${side}`).value) >>> 0;
  s.lock = $(`lock-${side}`).checked;
}

function settingLabel(side) {
  const s = state.settings[side];
  const modeName = { off: '直接量化', rpdf: 'RPDF 扰动', tpdf: 'TPDF 扰动' }[s.mode];
  return s.mode === 'off'
    ? `${s.bits} 位 · ${modeName}`
    : `${s.bits} 位 · ${modeName} ${s.amp} LSB · seed ${s.seed}`;
}

/* ================= 量化重算 ================= */

function recomputeSide(side) {
  if (!state.source) return;
  state.results[side] = quantizeSignal(
    state.source.channels,
    state.settings[side].bits,
    state.settings[side]
  );
}

function recomputeAll() {
  if (!state.source) return;
  recomputeSide('A');
  recomputeSide('B');
}

function curResult() {
  return state.results[state.active]?.[state.channel];
}

function curOrig() {
  return state.source.channels[state.channel];
}

/* ================= 载入信号 ================= */

function loadSource(src, keepView = false) {
  state.source = src;
  if (state.channel >= src.channels.length) state.channel = 0;
  const n = src.channels[0].length;
  if (!keepView) {
    state.view = { s0: 0, s1: n };
    state.cursor = null;
  } else {
    state.view.s1 = Math.min(state.view.s1, n);
    if (state.cursor != null) state.cursor = Math.min(state.cursor, n - 1);
  }
  // 声道选择
  const chSel = $('channel-sel');
  chSel.innerHTML = '';
  for (let c = 0; c < src.channels.length; c++) {
    const o = document.createElement('option');
    o.value = String(c);
    o.textContent = src.channels.length === 1 ? '1(单声道)' : `声道 ${c + 1}`;
    chSel.appendChild(o);
  }
  chSel.value = String(state.channel);

  const info = `${src.name} · ${src.sampleRate} Hz · ${src.channels.length} 声道 · ${src.duration?.toFixed(2) ?? (n / src.sampleRate).toFixed(2)} s · ${n} 采样`;
  $('source-info').textContent = info;
  recomputeAll();
  refreshAll();
}

async function handleWavFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const dec = decodeWav(buf);
    loadSource({
      name: file.name,
      sampleRate: dec.sampleRate,
      channels: dec.channels,
      segments: [],
      duration: dec.duration,
    });
    flashOk(`已载入 ${file.name}:${dec.numChannels} 声道 / ${dec.bitsPerSample} 位`);
  } catch (err) {
    alert(`WAV 载入失败:${err.message}`);
  }
}

/* ================= 指标砖 ================= */

function refreshTiles() {
  const r = curResult();
  if (!r) return;
  const st = r.stats;
  const n = st.n;
  $('t-changed').textContent = `${st.changed} (${(st.changedPct * 100).toFixed(2)}%)`;
  $('t-rms').textContent = fmt(st.rmsErrLsb, 3);
  $('t-max').textContent = fmt(st.maxAbsErrLsb, 3);
  $('t-bias').textContent = fmt(st.meanErrLsb, 4);
  $('t-snr').textContent = Number.isFinite(st.snrDb) ? fmt(st.snrDb, 1) : '∞';
  // 越界夹断(双向合计)与压轨(双向合计及占比),两组语义分开
  const clipped = st.clipHi + st.clipLo;
  const railed = st.railPos + st.railNeg;
  $('t-cliphi').textContent = String(clipped);
  $('t-cliplo').textContent = `${st.railPos} / ${st.railNeg}`;
  $('t-rail').textContent = `${railed} (${((railed / n) * 100).toFixed(1)}%)`;
  // 只有真正越界夹断才给暖色;低位模式下“全程在轨”是正常现象,不报警
  document.querySelectorAll('.tile.clip').forEach((el) => el.classList.remove('warn'));
  if (clipped > 0) $('t-cliphi').parentElement.classList.add('warn');
  $('hash-label').textContent =
    `整数码校验和 FNV-1a:0x${st.hash.toString(16).padStart(8, '0')} · ${settingLabel(state.active)}`;
  $('name-A').textContent = settingLabel('A');
  $('name-B').textContent = settingLabel('B');
  $('active-label').textContent = state.active;
  $('box-A').classList.toggle('active', state.active === 'A');
  $('box-B').classList.toggle('active', state.active === 'B');
}

/* ================= 画布工具 ================= */

function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const rect = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = cv.height; // 属性高度作为 CSS 逻辑高度
  cv.style.height = `${h}px`;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawGrid(ctx, w, h, yZoom) {
  ctx.strokeStyle = getCss('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75]) {
    const y = f * h;
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();
  // 零轴
  ctx.strokeStyle = getCss('--baseline');
  ctx.beginPath();
  ctx.moveTo(0, h / 2 + 0.5);
  ctx.lineTo(w, h / 2 + 0.5);
  ctx.stroke();
  // 纵向刻度标注
  ctx.fillStyle = getCss('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  const topVal = 1 / yZoom;
  ctx.fillText(`+${topVal.toExponential(topVal < 0.01 ? 1 : 2)}`, 4, 12);
  ctx.fillText('0', 4, h / 2 - 3);
  ctx.fillText(`−${topVal.toExponential(topVal < 0.01 ? 1 : 2)}`, 4, h - 4);
}

function getCss(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// 在区间内逐像素取 min/max 包络
function envelope(sig, s0, s1, w) {
  const mins = new Float32Array(w);
  const maxs = new Float32Array(w);
  const span = Math.max(1, s1 - s0);
  for (let px = 0; px < w; px++) {
    const a = s0 + Math.floor((px / w) * span);
    const b = Math.max(a + 1, s0 + Math.floor(((px + 1) / w) * span));
    let mn = Infinity, mx = -Infinity;
    for (let i = a; i < b && i < s1; i++) {
      const v = sig[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    mins[px] = mn === Infinity ? 0 : mn;
    maxs[px] = mx === -Infinity ? 0 : mx;
  }
  return { mins, maxs };
}

function plotEnvelope(ctx, sig, s0, s1, w, h, color, yZoom) {
  const { mins, maxs } = envelope(sig, s0, s1, w);
  const yOf = (v) => h / 2 - (v * yZoom) * (h / 2);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const yHi = yOf(maxs[px]);
    const yLo = yOf(mins[px]);
    ctx.rect(px, yHi, 1, Math.max(1, yLo - yHi));
  }
  ctx.fill();
}

function plotLine(ctx, sig, s0, s1, w, h, color, yZoom) {
  const yOf = (v) => h / 2 - (v * yZoom) * (h / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  const span = Math.max(1, s1 - s0);
  for (let px = 0; px < w; px++) {
    const i = Math.min(s1 - 1, s0 + Math.floor((px / w) * span));
    const y = yOf(sig[i]);
    if (px === 0) ctx.moveTo(px, y);
    else ctx.lineTo(px, y);
  }
  ctx.stroke();
}

/* ================= 失真段底色 ================= */

// 逐像素统计误差强度(0..1,按 1 LSB 归一),失真色带按强度上透明色,
// 避免近静音处的微小翻码把整屏涂满。
function distortionIntensity(orig, recon, s0, s1, w, half) {
  const span = Math.max(1, s1 - s0);
  const intensity = new Float32Array(w);
  for (let px = 0; px < w; px++) {
    const a = s0 + Math.floor((px / w) * span);
    const b = Math.max(a + 1, s0 + Math.floor(((px + 1) / w) * span));
    let maxLsb = 0;
    for (let i = a; i < b && i < s1; i++) {
      const e = Math.abs(recon[i] - orig[i]) * half;
      if (e > maxLsb) maxLsb = e;
    }
    // 0.15 LSB 起才显色,1 LSB 饱和;无翻码处完全透明
    intensity[px] = Math.min(1, Math.max(0, (maxLsb - 0.15) / 0.85));
  }
  return intensity;
}

function paintRegions(ctx, intensity, h) {
  const base = getCss('--clip-line');
  for (let px = 0; px < intensity.length; px++) {
    const a = intensity[px];
    if (a <= 0) continue;
    ctx.fillStyle = hexWithAlpha(base, 0.10 + 0.28 * a);
    ctx.fillRect(px, 0, 1, h);
  }
}

function hexWithAlpha(hex, alpha) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16);
  const g = parseInt(m.slice(2, 4), 16);
  const b = parseInt(m.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

// 概览专用:按像素内误差 RMS(LSB)上色,0.1 LSB 以下不显色,避免整柱满屏。
function paintOverviewBands(ctx, orig, recon, n, w, half, h) {
  const base = getCss('--clip-line');
  for (let px = 0; px < w; px++) {
    const a = Math.floor((px / w) * n);
    const b = Math.max(a + 1, Math.floor(((px + 1) / w) * n));
    let sq = 0, cnt = 0;
    for (let i = a; i < b && i < n; i++) {
      const e = (recon[i] - orig[i]) * half;
      sq += e * e;
      cnt++;
    }
    const rms = Math.sqrt(sq / Math.max(1, cnt));
    if (rms < 0.1) continue;
    const alpha = Math.min(0.30, 0.06 + 0.24 * Math.min(1, (rms - 0.1) / 0.4));
    ctx.fillStyle = hexWithAlpha(base, alpha);
    ctx.fillRect(px, 0, 1, h);
  }
}

function drawSegmentBoundaries(ctx, w, h, s0, s1) {
  const segs = state.source.segments;
  if (!segs?.length) return;
  const sr = state.source.sampleRate;
  const span = Math.max(1, s1 - s0);
  ctx.strokeStyle = getCss('--baseline');
  ctx.setLineDash([5, 4]);
  ctx.fillStyle = getCss('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  for (const seg of segs) {
    const x = ((seg.start * sr - s0) / span) * w;
    if (x < 0 || x > w) continue;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
    ctx.fillText(seg.name, Math.min(x + 5, w - 90), 12);
  }
  ctx.setLineDash([]);
}

/* ================= 三个主画布 ================= */

function drawOverview() {
  const cv = $('overview');
  const { ctx, w, h } = fitCanvas(cv);
  if (!state.source) return;
  const orig = curOrig();
  const recon = curResult().recon;
  const n = orig.length;
  drawGrid(ctx, w, h, 1);
  // 概览像素覆盖大量采样,平均误差会被稀释;用 RMS 强度而非单点最大误差
  paintOverviewBands(ctx, orig, recon, n, w, curResult().stats.half, h);
  plotEnvelope(ctx, orig, 0, n, w, h, getCss('--series-orig'), 1);
  // 当前视窗
  const { s0, s1 } = state.view;
  const x0 = (s0 / n) * w, x1 = (s1 / n) * w;
  ctx.strokeStyle = getCss('--text-2');
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x0, 1, Math.max(2, x1 - x0), h - 2);
  if (state.cursor != null) drawCursor(ctx, (state.cursor / n) * w, h);
  ctx.fillStyle = getCss('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('全片概览(点击/拖拽定位)', w - 6, 12);
}

function drawWaveform() {
  const cv = $('waveform');
  const { ctx, w, h } = fitCanvas(cv);
  if (!state.source) return;
  const orig = curOrig();
  const recon = curResult().recon;
  const { s0, s1 } = state.view;
  drawGrid(ctx, w, h, state.yZoom);
  paintRegions(ctx, distortionIntensity(orig, recon, s0, s1, w, curResult().stats.half), h);
  drawSegmentBoundaries(ctx, w, h, s0, s1);
  const span = s1 - s0;
  if (span <= w * 2) {
    // 样本数接近像素时画阶梯线,真实展示量化台阶
    plotStairs(ctx, orig, s0, s1, w, h, getCss('--series-orig'), state.yZoom);
    plotStairs(ctx, recon, s0, s1, w, h, getCss('--series-recon'), state.yZoom, 1.6);
  } else {
    plotEnvelope(ctx, orig, s0, s1, w, h, getCss('--series-orig'), state.yZoom);
    plotEnvelope(ctx, recon, s0, s1, w, h, getCss('--series-recon'), state.yZoom);
  }
  if (state.cursor != null) {
    const x = sampleToPx(state.cursor, w);
    drawCursor(ctx, x, h);
    drawSampleDots(ctx, x);
  }
}

function plotStairs(ctx, sig, s0, s1, w, h, color, yZoom, lw = 1.2) {
  const yOf = (v) => h / 2 - (v * yZoom) * (h / 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.beginPath();
  const span = Math.max(1, s1 - s0);
  let prevY = null;
  for (let px = 0; px < w; px++) {
    const i = Math.min(s1 - 1, s0 + Math.floor((px / w) * span));
    const y = yOf(sig[i]);
    if (prevY === null) { ctx.moveTo(px, y); }
    else { ctx.lineTo(px, prevY); ctx.lineTo(px, y); }
    prevY = y;
  }
  ctx.stroke();
}

function drawError() {
  const cv = $('error-canvas');
  const { ctx, w, h } = fitCanvas(cv);
  if (!state.source) return;
  const orig = curOrig();
  const r = curResult();
  const { s0, s1 } = state.view;
  const err = new Float32Array(s1 - s0);
  for (let i = s0; i < s1; i++) err[i - s0] = r.recon[i] - orig[i];
  // 误差面板自动按当前最大误差定标,并保留 LSB 参考线
  drawGrid(ctx, w, h, 1);
  paintRegions(ctx, distortionIntensity(orig, r.recon, s0, s1, w, r.stats.half), h);
  // LSB 高度参考线(±1 LSB 浮点幅度)
  const lsb = 1 / r.stats.half;
  const yOf = (v) => h / 2 - (v / (lsb * 2)) * (h / 2);
  ctx.strokeStyle = getCss('--baseline');
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, yOf(lsb) + 0.5); ctx.lineTo(w, yOf(lsb) + 0.5);
  ctx.moveTo(0, yOf(-lsb) + 0.5); ctx.lineTo(w, yOf(-lsb) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  // 误差包络(按 ±2 LSB 定标)
  plotEnvelope(ctx, err, 0, err.length, w, h, getCss('--series-err'), 1 / (lsb * 2));
  ctx.fillStyle = getCss('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('+1 LSB', 4, yOf(lsb) - 3);
  ctx.fillText('−1 LSB', 4, yOf(-lsb) + 12);
  if (state.cursor != null) drawCursor(ctx, sampleToPx(state.cursor, w), h);
}

function drawCursor(ctx, x, h) {
  ctx.strokeStyle = getCss('--text');
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x + 0.5, 0);
  ctx.lineTo(x + 0.5, h);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawSampleDots(ctx, x) {
  const r = curResult();
  const i = state.cursor;
  const h = $('waveform').getBoundingClientRect().height;
  const yOf = (v) => h / 2 - (v * state.yZoom) * (h / 2);
  const dots = [
    [curOrig()[i], getCss('--series-orig')],
    [r.recon[i], getCss('--series-recon')],
  ];
  for (const [v, c] of dots) {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(x, yOf(v), 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/* ================= 直方图 ================= */

function drawHist() {
  const cv = $('hist');
  const { ctx, w, h } = fitCanvas(cv);
  if (!state.source) return;
  const orig = curOrig();
  const recon = curResult().recon;
  const bins = 100;
  const ho = histogram(orig, bins);
  const hr = histogram(recon, bins);
  const maxCount = Math.max(1, ...ho, ...hr);
  const logMax = Math.log10(maxCount + 1);
  const yOf = (c) => h - 6 - (Math.log10(c + 1) / logMax) * (h - 22);
  const bw = w / bins;

  ctx.strokeStyle = getCss('--grid');
  ctx.beginPath();
  ctx.moveTo(0, h - 6 + 0.5); ctx.lineTo(w, h - 6 + 0.5);
  ctx.stroke();

  for (let b = 0; b < bins; b++) {
    const x = b * bw;
    // 原音(蓝,左半柱)
    ctx.fillStyle = getCss('--series-orig');
    ctx.fillRect(x, yOf(ho[b]), bw * 0.45, h - 6 - yOf(ho[b]));
    // 还原(橙,右半柱)
    ctx.fillStyle = getCss('--series-recon');
    ctx.fillRect(x + bw * 0.48, yOf(hr[b]), bw * 0.45, h - 6 - yOf(hr[b]));
  }
  // 误差分布叠加为阶梯轮廓
  if (state.showHistErr) {
    const he = histogram(makeErrView(), bins);
    ctx.strokeStyle = getCss('--series-err');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let b = 0; b < bins; b++) {
      const x = b * bw;
      const y = yOf(he[b]);
      if (b === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = getCss('--muted');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('−1', 4, h - 8);
  ctx.textAlign = 'center';
  ctx.fillText('0', w / 2, h - 8);
  ctx.textAlign = 'right';
  ctx.fillText('+1', w - 4, h - 8);
  ctx.textAlign = 'left';
  ctx.fillText('对数计数', 6, 12);
}

function makeErrView() {
  const orig = curOrig();
  const recon = curResult().recon;
  const out = new Float32Array(orig.length);
  for (let i = 0; i < out.length; i++) out[i] = recon[i] - orig[i];
  return out;
}

/* ================= 坐标换算 / 交互 ================= */

function pxToSample(px, w) {
  const { s0, s1 } = state.view;
  return Math.round(s0 + (px / w) * (s1 - s0));
}
function sampleToPx(s, w) {
  const { s0, s1 } = state.view;
  return ((s - s0) / Math.max(1, s1 - s0)) * w;
}

function attachCanvasNav() {
  for (const cv of [$('waveform'), $('error-canvas')]) {
    let dragging = false;
    cv.addEventListener('pointerdown', (e) => {
      dragging = true;
      cv.setPointerCapture(e.pointerId);
      seekFromEvent(e, cv);
    });
    cv.addEventListener('pointermove', (e) => {
      const rect = cv.getBoundingClientRect();
      state.hover = { x: e.clientX, y: e.clientY, cv, px: e.clientX - rect.left };
      if (dragging) seekFromEvent(e, cv);
      updateTooltip();
    });
    cv.addEventListener('pointerup', () => { dragging = false; });
    cv.addEventListener('pointerleave', () => { state.hover = null; hideTooltip(); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.6 : 1 / 1.6;
      zoomView(factor, e, cv);
    }, { passive: false });
  }
  // 概览:点击/拖拽平移视窗
  const ov = $('overview');
  let ovDrag = false;
  ov.addEventListener('pointerdown', (e) => { ovDrag = true; overviewSeek(e, ov); });
  ov.addEventListener('pointermove', (e) => { if (ovDrag) overviewSeek(e, ov); });
  ov.addEventListener('pointerup', () => { ovDrag = false; });
}

function seekFromEvent(e, cv) {
  const rect = cv.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const w = rect.width;
  state.cursor = Math.max(state.view.s0, Math.min(state.view.s1 - 1, pxToSample(px, w)));
  redrawPlots();
  updateTooltip();
}

function overviewSeek(e, cv) {
  const rect = cv.getBoundingClientRect();
  const n = curOrig().length;
  const frac = (e.clientX - rect.left) / rect.width;
  const center = Math.round(frac * n);
  const half = Math.max(16, (state.view.s1 - state.view.s0) / 2);
  state.view.s0 = Math.max(0, Math.round(center - half));
  state.view.s1 = Math.min(n, Math.round(center + half));
  if (state.cursor != null) state.cursor = Math.min(Math.max(state.cursor, state.view.s0), state.view.s1 - 1);
  redrawPlots();
  updateViewLabel();
}

function zoomView(factor, e, cv) {
  const n = curOrig().length;
  const rect = cv.getBoundingClientRect();
  // 无事件(按钮触发)时以视窗中心为锚点
  const frac = e ? (e.clientX - rect.left) / rect.width : 0.5;
  const anchor = pxToSample(frac * rect.width, rect.width);
  let span = state.view.s1 - state.view.s0;
  span = Math.max(32, Math.min(n, Math.round(span * factor)));
  let s0 = Math.round(anchor - frac * span);
  s0 = Math.max(0, Math.min(n - span, s0));
  state.view.s0 = s0;
  state.view.s1 = Math.min(n, s0 + span);
  redrawPlots();
  updateViewLabel();
}

function updateTooltip() {
  if (!state.hover || !state.source) return hideTooltip();
  const tt = $('tooltip');
  const rect = state.hover.cv.getBoundingClientRect();
  const i = Math.max(state.view.s0, Math.min(state.view.s1 - 1, pxToSample(state.hover.px, rect.width)));
  const r = curResult();
  const t = i / state.source.sampleRate;
  const err = r.recon[i] - curOrig()[i];
  tt.hidden = false;
  tt.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'tt-title';
  title.textContent = `样本 ${i} · ${t.toFixed(4)} s · 整数码 ${r.codes[i]}`;
  tt.appendChild(title);
  const rows = [
    ['原音', curOrig()[i], getCss('--series-orig')],
    ['还原', r.recon[i], getCss('--series-recon')],
    ['误差', err, getCss('--series-err')],
  ];
  for (const [label, val, color] of rows) {
    const row = document.createElement('div');
    row.className = 'tt-row';
    const key = document.createElement('span');
    key.className = 'tt-key';
    key.style.background = color;
    const name = document.createElement('span');
    name.textContent = label;
    const v = document.createElement('span');
    v.className = 'tt-val';
    v.textContent = val.toExponential(3);
    row.append(key, name, v);
    tt.appendChild(row);
  }
  const x = Math.min(state.hover.x + 14, window.innerWidth - 190);
  const y = Math.min(state.hover.y + 14, window.innerHeight - 120);
  tt.style.left = `${x}px`;
  tt.style.top = `${y}px`;
}
function hideTooltip() { $('tooltip').hidden = true; }

/* ================= 失真定位表 ================= */

function refreshBlockTable() {
  if (!state.source) return;
  const orig = curOrig();
  const r = curResult();
  const sr = state.source.sampleRate;
  const tbody = $('block-table').querySelector('tbody');
  tbody.innerHTML = '';

  let rows;
  if (state.source.segments?.length) {
    rows = state.source.segments.map((seg) => {
      const a = Math.round(seg.start * sr);
      const b = Math.round(seg.end * sr);
      return summarize(a, b, seg.name);
    });
  } else {
    const blocks = blockStats(orig, r.recon, sr, state.blockMs);
    rows = blocks.map((blk) =>
      summarize(blk.startSample, blk.endSample,
        `${blk.t0.toFixed(2)}–${blk.t1.toFixed(2)} s`));
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.addEventListener('click', () => jumpTo(row.s0, row.s1));
    const cells = [
      row.label,
      db(row.peak),
      `${(row.changedPct * 100).toFixed(1)}%`,
      fmt(row.rmsLsb, 3),
      fmt(row.maxLsb, 3),
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      td.textContent = c;
      tr.appendChild(td);
    }
    const badge = document.createElement('td');
    const span = document.createElement('span');
    span.className = `badge ${row.badge}`;
    span.textContent = row.badgeText;
    badge.appendChild(span);
    tr.appendChild(badge);
    tbody.appendChild(tr);
  }

  function summarize(a, b, label) {
    let changed = 0, sq = 0, maxAbs = 0, peak = 0;
    for (let i = a; i < b; i++) {
      const e = r.recon[i] - orig[i];
      if (e !== 0) changed++;
      sq += e * e;
      if (Math.abs(e) > maxAbs) maxAbs = Math.abs(e);
      if (Math.abs(orig[i]) > peak) peak = Math.abs(orig[i]);
    }
    const len = b - a;
    const half = r.stats.half;
    const changedPct = changed / len;
    const rmsLsb = Math.sqrt(sq / len) * half;
    const ditherOn = state.settings[state.active].mode !== 'off';
    // 原音峰值不足 1 LSB(数字静音/极弱段):扰动模式下的翻码是有意添加的噪声底,
    // 不是信号失真,单独标注;直接量化则表现为尾音被吃(无翻码)。
    const silenceFloor = peak * half < 0.5;
    let badge = 'ok', badgeText = '无翻码';
    if (changedPct === 0) {
      badge = 'ok'; badgeText = '无翻码';
    } else if (silenceFloor && ditherOn) {
      badge = 'mid'; badgeText = '扰动噪声底';
    } else if (rmsLsb >= 0.3) {
      badge = 'bad'; badgeText = '重度失真';
    } else if (rmsLsb >= 0.05 || (changedPct >= 0.5 && rmsLsb >= 0.1)) {
      badge = 'mid'; badgeText = '可闻失真';
    } else {
      badge = 'ok'; badgeText = '轻微(亚 LSB)';
    }
    return {
      s0: a, s1: b, label, peak, changedPct,
      rmsLsb,
      maxLsb: maxAbs * half,
      badge, badgeText,
    };
  }
}

function jumpTo(s0, s1) {
  const n = curOrig().length;
  state.view.s0 = s0;
  state.view.s1 = Math.min(n, s1);
  state.cursor = s0;
  redrawPlots();
  updateViewLabel();
}

function updateViewLabel() {
  const sr = state.source?.sampleRate;
  if (!sr) return;
  const { s0, s1 } = state.view;
  $('view-range').textContent =
    `视图 ${(s0 / sr).toFixed(3)}–${(s1 / sr).toFixed(3)} s · ${s1 - s0} 采样` +
    (state.cursor != null ? ` · 游标 ${(state.cursor / sr).toFixed(4)} s` : '');
}

/* ================= 试听 ================= */

let audioCtx = null;
let currentSource = null;
let masterGainNode = null;

function ensureCtx() {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function makeBuffer(channels) {
  const ctx = ensureCtx();
  const n = channels[0].length;
  const buf = ctx.createBuffer(channels.length, n, state.source.sampleRate);
  for (let c = 0; c < channels.length; c++) buf.copyToChannel(channels[c], c);
  return buf;
}

function play(channels, startSample) {
  stopPlay();
  const ctx = ensureCtx();
  const buf = makeBuffer(channels);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  masterGainNode = ctx.createGain();
  masterGainNode.gain.value = 10 ** (state.masterGainDb / 20);
  src.connect(masterGainNode).connect(ctx.destination);
  const offset = startSample / state.source.sampleRate;
  if (state.loop) {
    src.loop = true;
    src.loopStart = offset;
    src.loopEnd = state.view.s1 / state.source.sampleRate;
  }
  src.start(0, offset);
  currentSource = src;
}

function stopPlay() {
  if (currentSource) {
    try { currentSource.stop(); } catch { /* 已停止 */ }
    currentSource = null;
  }
}

function startSample() {
  return state.cursor != null ? state.cursor : state.view.s0;
}

/* ================= 导出与回读 ================= */

function exportWav() {
  if (!state.source) return;
  const side = state.active;
  const bitDepth = Number($('export-bits').value);
  const recon = state.results[side].map((r) => r.recon);
  const buf = encodeWav(recon, state.source.sampleRate, bitDepth);
  const blob = new Blob([buf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const base = state.source.name.replace(/[^\w一-龥.-]+/g, '_').replace(/\.wav$/i, '');
  a.href = url;
  a.download = `${base}_${side}_${state.settings[side].bits}bit_${bitDepth}container.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  // 内存回读核对(与下载文件同一字节)
  verifyRoundtrip(buf, recon, bitDepth);
}

function verifyRoundtrip(buf, expectChannels, bitDepth) {
  const dec = decodeWav(buf);
  const r = curResult();
  const half = r.stats.half;
  const sr = state.source.sampleRate;

  // 偏置拆两层:
  // (1) 容器零电平偏置——回读值减预览值的均值,只可能来自格式(如 8 位偏移码),必须为 0;
  // (2) 量化残差偏置——预览(还原)信号自身的均值,低位直接量化非零属正常现象。
  let formatBias = 0, quantBias = 0, maxDiff = 0;
  for (let c = 0; c < dec.channels.length; c++) {
    const got = dec.channels[c];
    const want = expectChannels[c];
    let fb = 0, qb = 0;
    for (let i = 0; i < got.length; i++) {
      fb += got[i] - want[i];
      qb += want[i];
      maxDiff = Math.max(maxDiff, Math.abs(got[i] - want[i]));
    }
    formatBias += (fb / got.length) * half;
    quantBias += (qb / got.length) * half;
  }
  formatBias /= dec.channels.length;
  quantBias /= dec.channels.length;

  setVerify('fmt', `${bitDepth} 位 PCM`, `${dec.bitsPerSample} 位${dec.isFloat ? ' 浮点' : ' PCM'}`,
    dec.bitsPerSample === bitDepth && !dec.isFloat);
  setVerify('ch', `${expectChannels.length} 声道`, `${dec.numChannels} 声道`,
    dec.numChannels === expectChannels.length);
  const expDur = expectChannels[0].length / sr;
  setVerify('dur', `${sr} Hz / ${expDur.toFixed(4)} s`,
    `${dec.sampleRate} Hz / ${dec.duration.toFixed(4)} s`,
    dec.sampleRate === sr && dec.numFrames === expectChannels[0].length);
  // 容器偏置必须为 0;量化残差偏置作为参考值列出
  setVerify('bias',
    '容器 0 / 残差 ' + fmt(quantBias, 3),
    fmt(formatBias, 4) + ' / ' + fmt(quantBias, 3),
    Math.abs(formatBias) < 1e-9);
  setVerify('samp', '0', maxDiff.toExponential(2), maxDiff === 0);
  $('verify-note').textContent =
    `内存回读完成:${state.source.name} 经设置 ${state.active}(${settingLabel(state.active)})量化后写入 ${bitDepth} 位容器。` +
    '“偏置”列左值为容器零电平偏置(8 位偏移码也应为 0),右值为量化残差偏置(低位数直接量化可能非零,扰动量化应接近 0)。';
}

function setVerify(key, exp, act, ok) {
  $(`v-${key}-exp`).textContent = exp;
  $(`v-${key}-act`).textContent = act;
  const cell = $(`v-${key}-ok`);
  cell.textContent = ok ? '✓ 一致' : '✗ 不符';
  cell.className = ok ? 'ok-text' : 'bad-text';
}

async function verifyExternal(file) {
  try {
    const buf = await file.arrayBuffer();
    const dec = decodeWav(buf);
    const n = dec.channels[0].length;
    // 容器位深对应的 LSB 尺度,用于偏置换算
    const half = 2 ** (dec.bitsPerSample - 1);
    let bias = 0;
    for (const ch of dec.channels) {
      let s = 0;
      for (const v of ch) s += v;
      bias += s / ch.length;
    }
    bias = (bias / dec.channels.length) * half;
    $('v-fmt-exp').textContent = state.source ? '与当前导出一致' : '—';
    $('v-fmt-act').textContent = `${dec.bitsPerSample} 位${dec.isFloat ? ' 浮点' : ' PCM'}`;
    $('v-ch-exp').textContent = state.source ? `${state.source.channels.length} 声道` : '—';
    $('v-ch-act').textContent = `${dec.numChannels} 声道`;
    $('v-dur-exp').textContent = state.source ? `${state.source.sampleRate} Hz` : '—';
    $('v-dur-act').textContent = `${dec.sampleRate} Hz / ${dec.duration.toFixed(4)} s / ${n} 帧`;
    $('v-bias-exp').textContent = '文件信号均值';
    $('v-bias-act').textContent = fmt(bias, 4);
    $('v-samp-exp').textContent = state.source ? '与预览比对' : '—';
    if (state.source) {
      const recon = curResult().recon;
      let maxDiff = -1;
      if (recon.length === n) {
        maxDiff = 0;
        for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(dec.channels[0][i] - recon[i]));
      }
      $('v-samp-act').textContent = maxDiff < 0 ? '长度不一致' : maxDiff.toExponential(2);
      const ok = maxDiff === 0;
      $('v-samp-ok').textContent = maxDiff < 0 ? '✗ 不符' : (ok ? '✓ 一致' : '✗ 有差');
      $('v-samp-ok').className = ok ? 'ok-text' : 'bad-text';
    }
    for (const key of ['fmt', 'ch', 'dur', 'bias']) {
      const cell = $(`v-${key}-ok`);
      cell.textContent = '✓ 已读';
      cell.className = 'ok-text';
    }
    flashOk(`已回读磁盘文件 ${file.name}`);
  } catch (err) {
    alert(`回读失败:${err.message}`);
  }
}

/* ================= 总刷新 ================= */

function redrawPlots() {
  if (!state.source) return;
  drawOverview();
  drawWaveform();
  drawError();
  drawHist();
  updateViewLabel();
}

function refreshAll() {
  refreshTiles();
  redrawPlots();
  refreshBlockTable();
}

function flashOk(msg) {
  const el = $('source-info');
  const old = el.textContent;
  el.textContent = msg;
  el.classList.add('ok-text');
  setTimeout(() => { el.textContent = old; el.classList.remove('ok-text'); }, 2600);
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  // 信号来源
  $('file-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) handleWavFile(f);
    e.target.value = '';
  });
  document.querySelectorAll('[data-gen]').forEach((btn) => {
    btn.addEventListener('click', () => loadSource(generateSignal(btn.dataset.gen)));
  });

  // 设置变化
  for (const side of ['A', 'B']) {
    for (const id of [`bits-${side}`, `mode-${side}`, `amp-${side}`, `seed-${side}`, `lock-${side}`]) {
      $(id).addEventListener('change', () => {
        formToSettings(side);
        recomputeSide(side);
        if (state.active === side) refreshAll();
        else { refreshTiles(); drawOverview(); }
      });
    }
    $(`reseed-${side}`).addEventListener('click', () => {
      state.settings[side].seed = (Math.random() * 4294967295) >>> 0;
      settingsToForm(side);
      recomputeSide(side);
      if (state.active === side) refreshAll(); else { refreshTiles(); drawOverview(); }
    });
  }

  $('switch-btn').addEventListener('click', () => {
    state.active = state.active === 'A' ? 'B' : 'A';
    refreshAll(); // 游标/视窗在 state 中不动
  });

  $('channel-sel').addEventListener('change', (e) => {
    state.channel = Number(e.target.value);
    refreshAll();
  });
  $('block-sel').addEventListener('change', (e) => {
    state.blockMs = Number(e.target.value);
    refreshBlockTable();
  });
  $('zoom-y').addEventListener('change', (e) => {
    state.yZoom = Number(e.target.value);
    redrawPlots();
  });
  $('hist-err').addEventListener('change', (e) => {
    state.showHistErr = e.target.checked;
    drawHist();
  });

  // 缩放按钮
  $('zoom-in').addEventListener('click', () => zoomView(1 / 2.2, null, $('waveform')));
  $('zoom-out').addEventListener('click', () => zoomView(2.2, null, $('waveform')));
  $('zoom-reset').addEventListener('click', () => {
    state.view = { s0: 0, s1: curOrig().length };
    redrawPlots();
    updateViewLabel();
  });

  // 试听
  $('master-gain').addEventListener('input', (e) => {
    state.masterGainDb = Number(e.target.value);
    $('gain-val').textContent = `${state.masterGainDb} dB`;
    if (audioCtx && masterGainNode) {
      masterGainNode.gain.setTargetAtTime(
        10 ** (state.masterGainDb / 20), audioCtx.currentTime, 0.01);
    }
  });
  $('err-gain').addEventListener('change', (e) => { state.errGain = Number(e.target.value); });
  $('loop-cb').addEventListener('change', (e) => { state.loop = e.target.checked; });
  $('play-orig').addEventListener('click', () =>
    play(state.source.channels, startSample()));
  $('play-recon').addEventListener('click', () =>
    play(state.results[state.active].map((r) => r.recon), startSample()));
  $('play-err').addEventListener('click', () => {
    const n = curOrig().length;
    const outs = state.source.channels.map((ch, c) => {
      const rec = state.results[state.active][c].recon;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = (rec[i] - ch[i]) * state.errGain;
      return out;
    });
    play(outs, startSample());
  });
  $('stop-btn').addEventListener('click', stopPlay);

  // 导出 / 回读
  $('export-btn').addEventListener('click', exportWav);
  $('verify-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await verifyExternal(f);
    e.target.value = '';
  });

  window.addEventListener('resize', () => redrawPlots());
}

/* ================= 启动 ================= */

function init() {
  fillBitSelects();
  settingsToForm('A');
  settingsToForm('B');
  bindEvents();
  attachCanvasNav();
  loadSource(generateSignal('combo'));
}

init();
