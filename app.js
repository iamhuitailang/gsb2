'use strict';

/* ============================================================
 * 本地音频频谱分析
 * 全部处理在浏览器内完成（Web Audio API），不发送任何网络请求。
 * ============================================================ */

// ---------- 全局状态 ----------
const state = {
  view: 'spectrum',      // waveform | spectrum | diff
  scale: 'log',          // linear | log
  fftSize: 2048,
  peakHold: 2,           // 秒；0 = 关闭；Infinity = 无限
  markers: [],           // {id, freqLow, freqHigh, tStart, tEnd, note}
  audioFileName: null,
  selection: null,       // 拖选中的频段 {f1, f2}（f1 < f2）
};

const FMIN = 20;         // 对数刻度下限 (Hz)
const MIN_DB = -90;
const MAX_DB = -10;
const DIFF_RANGE = 40;   // 声道差异视图纵轴 ±dB

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const audio = $('audio');
const canvas = $('canvas');
const ctx2d = canvas.getContext('2d');

// ---------- 音频图 ----------
let audioCtx = null;
let analyserL = null;
let analyserR = null;
let freqL = null, freqR = null;   // Float32Array，dB 频谱
let timeL = null, timeR = null;   // Float32Array，时域波形
let peakL = null, peakR = null;   // 峰值保持（dB）
let peakStampL = null, peakStampR = null; // 每个 bin 最近一次刷新峰值的时间戳

function ensureAudioGraph() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  const source = audioCtx.createMediaElementSource(audio);
  const splitter = audioCtx.createChannelSplitter(2);
  const merger = audioCtx.createChannelMerger(2);

  analyserL = audioCtx.createAnalyser();
  analyserR = audioCtx.createAnalyser();

  source.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);
  // 输出到扬声器（不经过 analyser，避免任何处理影响声音）
  source.connect(merger);
  merger.connect(audioCtx.destination);

  applyFftSize();
}

// 分析窗口变化：重建所有依赖 fftSize 的缓冲，旧峰值数据一律作废，
// 否则新旧 bin 数量不一致会导致图形错位 / 残留旧数据。
function applyFftSize() {
  for (const a of [analyserL, analyserR]) {
    a.fftSize = state.fftSize;
    a.smoothingTimeConstant = 0.6;
    a.minDecibels = MIN_DB;
    a.maxDecibels = MAX_DB;
  }
  const bins = analyserL.frequencyBinCount;
  freqL = new Float32Array(bins);
  freqR = new Float32Array(bins);
  timeL = new Float32Array(state.fftSize);
  timeR = new Float32Array(state.fftSize);
  resetPeakHold();
  updateFftInfo();
}

function resetPeakHold() {
  const bins = analyserL.frequencyBinCount;
  peakL = new Float32Array(bins).fill(-Infinity);
  peakR = new Float32Array(bins).fill(-Infinity);
  peakStampL = new Float64Array(bins);
  peakStampR = new Float64Array(bins);
}

function updateFftInfo() {
  if (!audioCtx) return;
  const res = audioCtx.sampleRate / state.fftSize;
  const winMs = (state.fftSize / audioCtx.sampleRate) * 1000;
  $('fftInfo').textContent =
    `采样率 ${audioCtx.sampleRate} Hz · 频率分辨率 ${res.toFixed(1)} Hz · 窗长 ${winMs.toFixed(0)} ms`;
}

// ---------- 频率 <-> 像素 映射 ----------
function nyquist() { return audioCtx ? audioCtx.sampleRate / 2 : 24000; }

function freqToX(freq, w) {
  const fmax = nyquist();
  if (state.scale === 'log') {
    const f = Math.max(freq, FMIN);
    return w * Math.log(f / FMIN) / Math.log(fmax / FMIN);
  }
  return w * freq / fmax;
}

function xToFreq(x, w) {
  const fmax = nyquist();
  if (state.scale === 'log') {
    return FMIN * Math.pow(fmax / FMIN, x / w);
  }
  return fmax * x / w;
}

// ---------- 渲染 ----------
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

const COLOR_L = '#4fc3f7';
const COLOR_R = '#ff8a65';
const COLOR_PEAK = '#ffd54f';

function draw() {
  requestAnimationFrame(draw);
  const { w, h } = resizeCanvas();
  ctx2d.clearRect(0, 0, w, h);
  if (!audioCtx) return;

  if (state.view === 'waveform') {
    analyserL.getFloatTimeDomainData(timeL);
    analyserR.getFloatTimeDomainData(timeR);
    drawWaveform(w, h);
  } else {
    analyserL.getFloatFrequencyData(freqL);
    analyserR.getFloatFrequencyData(freqR);
    updatePeaks();
    if (state.view === 'spectrum') drawSpectrum(w, h);
    else drawDiff(w, h);
  }
}

function drawGrid(w, h, isDb) {
  ctx2d.strokeStyle = '#232a35';
  ctx2d.fillStyle = '#6b7686';
  ctx2d.font = '10px monospace';
  ctx2d.lineWidth = 1;

  // 频率竖线
  const fmax = nyquist();
  const ticks = state.scale === 'log'
    ? [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(f => f < fmax)
    : linearTicks(fmax, 10);
  for (const f of ticks) {
    const x = freqToX(f, w);
    ctx2d.beginPath();
    ctx2d.moveTo(x, 0);
    ctx2d.lineTo(x, h);
    ctx2d.stroke();
    const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
    ctx2d.fillText(label, x + 3, h - 5);
  }

  // 电平横线
  if (isDb) {
    for (let db = MIN_DB; db <= MAX_DB; db += 10) {
      const y = dbToY(db, h);
      ctx2d.beginPath();
      ctx2d.moveTo(0, y);
      ctx2d.lineTo(w, y);
      ctx2d.stroke();
      ctx2d.fillText(`${db}`, 4, y - 2);
    }
  }
}

function linearTicks(max, n) {
  const out = [];
  const step = max / n;
  for (let i = 1; i < n; i++) out.push(Math.round(i * step));
  return out;
}

function dbToY(db, h) {
  const t = (db - MIN_DB) / (MAX_DB - MIN_DB);
  return h - Math.max(0, Math.min(1, t)) * h;
}

// 每个 x 像素聚合对应频率区间内的最大 dB（对数刻度下低频区一个像素覆盖多个 bin，
// 高频区一个 bin 覆盖多个像素，逐像素聚合保证两种刻度下都不错位）
function drawSpectrumTrace(data, w, h, color) {
  ctx2d.strokeStyle = color;
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  const fmax = nyquist();
  const binHz = fmax / data.length;
  let started = false;
  for (let x = 0; x < w; x++) {
    const f1 = xToFreq(x, w);
    const f2 = xToFreq(x + 1, w);
    let b1 = Math.floor(f1 / binHz);
    let b2 = Math.max(b1 + 1, Math.ceil(f2 / binHz));
    b1 = Math.max(0, Math.min(b1, data.length - 1));
    b2 = Math.max(1, Math.min(b2, data.length));
    let maxDb = -Infinity;
    for (let b = b1; b < b2; b++) if (data[b] > maxDb) maxDb = data[b];
    if (!isFinite(maxDb)) continue;
    const y = dbToY(maxDb, h);
    if (!started) { ctx2d.moveTo(x, y); started = true; }
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

function drawSpectrum(w, h) {
  drawMarkersOnSpectrum(w, h);
  drawGrid(w, h, true);
  drawSpectrumTrace(freqR, w, h, COLOR_R);
  drawSpectrumTrace(freqL, w, h, COLOR_L);
  if (state.peakHold !== 0) {
    drawSpectrumTrace(peakR, w, h, fade(COLOR_PEAK, 0.55));
    drawSpectrumTrace(peakL, w, h, COLOR_PEAK);
  }
  drawLegend(w, [['L', COLOR_L], ['R', COLOR_R], ['峰值', COLOR_PEAK]]);
  drawSelection(w, h);
}

function drawDiff(w, h) {
  drawGrid(w, h, false);
  // 0 dB 中线与 ±dB 横线
  ctx2d.strokeStyle = '#232a35';
  ctx2d.fillStyle = '#6b7686';
  ctx2d.font = '10px monospace';
  for (let d = -DIFF_RANGE; d <= DIFF_RANGE; d += 10) {
    const y = h / 2 - (d / DIFF_RANGE) * (h / 2);
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(w, y);
    ctx2d.strokeStyle = d === 0 ? '#3a4450' : '#232a35';
    ctx2d.stroke();
    ctx2d.fillText(`${d > 0 ? '+' : ''}${d}`, 4, y - 2);
  }

  // L-R 差值（dB）：>0 左声道强，<0 右声道强
  ctx2d.strokeStyle = '#ba68c8';
  ctx2d.lineWidth = 1.5;
  ctx2d.beginPath();
  const fmax = nyquist();
  const binHz = fmax / freqL.length;
  let started = false;
  for (let x = 0; x < w; x++) {
    const f1 = xToFreq(x, w);
    const f2 = xToFreq(x + 1, w);
    let b1 = Math.max(0, Math.floor(f1 / binHz));
    let b2 = Math.min(freqL.length, Math.max(b1 + 1, Math.ceil(f2 / binHz)));
    // 取区间内绝对值最大的差值，避免正负抵消漏掉差异
    let best = 0, bestAbs = -1;
    for (let b = b1; b < b2; b++) {
      const d = freqL[b] - freqR[b];
      if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); best = d; }
    }
    if (!isFinite(best)) continue;
    const clamped = Math.max(-DIFF_RANGE, Math.min(DIFF_RANGE, best));
    const y = h / 2 - (clamped / DIFF_RANGE) * (h / 2);
    if (!started) { ctx2d.moveTo(x, y); started = true; }
    else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
  drawLegend(w, [['L−R (dB)，上偏=左强，下偏=右强', '#ba68c8']]);
}

function drawWaveform(w, h) {
  const midL = h * 0.25, midR = h * 0.75, amp = h * 0.22;
  ctx2d.strokeStyle = '#232a35';
  ctx2d.beginPath();
  ctx2d.moveTo(0, h / 2); ctx2d.lineTo(w, h / 2);
  ctx2d.moveTo(0, midL); ctx2d.lineTo(w, midL);
  ctx2d.moveTo(0, midR); ctx2d.lineTo(w, midR);
  ctx2d.stroke();
  ctx2d.fillStyle = '#6b7686';
  ctx2d.font = '10px monospace';
  ctx2d.fillText('L', 4, midL - amp - 4);
  ctx2d.fillText('R', 4, midR - amp - 4);

  for (const [data, mid, color] of [[timeL, midL, COLOR_L], [timeR, midR, COLOR_R]]) {
    ctx2d.strokeStyle = color;
    ctx2d.lineWidth = 1.2;
    ctx2d.beginPath();
    const step = data.length / w;
    for (let x = 0; x < w; x++) {
      const i = Math.min(data.length - 1, Math.floor(x * step));
      const y = mid - data[i] * amp;
      if (x === 0) ctx2d.moveTo(x, y);
      else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
}

function updatePeaks() {
  if (state.peakHold === 0) return;
  const now = performance.now() / 1000;
  const hold = state.peakHold;
  for (let i = 0; i < freqL.length; i++) {
    for (const [freq, peak, stamp] of [[freqL, peakL, peakStampL], [freqR, peakR, peakStampR]]) {
      const v = freq[i];
      if (v >= peak[i]) {
        peak[i] = v;
        stamp[i] = now;
      } else if (isFinite(hold) && now - stamp[i] > hold) {
        // 保持时间到：直接回落到当前值，避免残留旧峰值
        peak[i] = v;
        stamp[i] = now;
      }
    }
  }
}

function fade(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawLegend(w, items) {
  ctx2d.font = '11px sans-serif';
  let x = w - 8;
  for (let i = items.length - 1; i >= 0; i--) {
    const [label, color] = items[i];
    const tw = ctx2d.measureText(label).width;
    x -= tw;
    ctx2d.fillStyle = color;
    ctx2d.fillText(label, x, 14);
    x -= 14;
  }
}

// ---------- 标记绘制 ----------
function markerColor(m, alpha) {
  // 按 id 散列取色，保证同一标记在频谱、进度条、表格中颜色一致
  const hues = [45, 150, 200, 280, 0, 110, 330];
  return `hsla(${hues[m.id % hues.length]}, 80%, 60%, ${alpha})`;
}

function drawMarkersOnSpectrum(w, h) {
  ctx2d.font = '10px sans-serif';
  for (const m of state.markers) {
    const x1 = freqToX(m.freqLow, w);
    const x2 = freqToX(m.freqHigh, w);
    ctx2d.fillStyle = markerColor(m, 0.12);
    ctx2d.fillRect(x1, 0, x2 - x1, h);
    ctx2d.strokeStyle = markerColor(m, 0.7);
    ctx2d.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, h - 1);
    ctx2d.fillStyle = markerColor(m, 1);
    ctx2d.fillText(`#${m.id}`, x1 + 3, 12);
  }
}

function drawSelection(w, h) {
  if (!state.selection) return;
  const { f1, f2 } = state.selection;
  const x1 = freqToX(f1, w);
  const x2 = freqToX(f2, w);
  ctx2d.fillStyle = 'rgba(79,195,247,0.15)';
  ctx2d.fillRect(x1, 0, x2 - x1, h);
  ctx2d.strokeStyle = 'rgba(79,195,247,0.8)';
  ctx2d.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, h - 1);
}

// ---------- 标记管理 ----------
let nextMarkerId = 1;

function addMarker() {
  if (!state.selection || !audio.duration) return;
  const { f1, f2 } = state.selection;
  const t = audio.currentTime;
  state.markers.push({
    id: nextMarkerId++,
    freqLow: Math.round(f1),
    freqHigh: Math.round(f2),
    tStart: round2(t),
    tEnd: round2(Math.min(t + 2, audio.duration)),
    note: '',
  });
  state.selection = null;
  updateSelInfo();
  renderMarkers();
}

function round2(v) { return Math.round(v * 100) / 100; }

function renderMarkers() {
  const tbody = $('markerBody');
  tbody.innerHTML = '';
  for (const m of state.markers) {
    const tr = document.createElement('tr');
    tr.dataset.id = m.id;
    tr.innerHTML = `
      <td><span style="color:${markerColor(m, 1)}">#${m.id}</span></td>
      <td>${m.freqLow} – ${m.freqHigh}</td>
      <td><input type="number" step="0.1" min="0" value="${m.tStart}" data-field="tStart"></td>
      <td><input type="number" step="0.1" min="0" value="${m.tEnd}" data-field="tEnd"></td>
      <td><input type="text" value="${escapeHtml(m.note)}" data-field="note" placeholder="备注"></td>
      <td><button class="btn-del" data-del="${m.id}">删除</button></td>`;
    // 点击行（非输入框）跳转到标记起点试听
    tr.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      seekTo(m.tStart, true);
    });
    tbody.appendChild(tr);
  }
  $('btnClearMarkers').disabled = state.markers.length === 0;
  renderSeekMarkers();
}

function renderSeekMarkers() {
  const box = $('seekMarkers');
  box.innerHTML = '';
  const dur = audio.duration;
  if (!isFinite(dur) || dur <= 0) return;
  for (const m of state.markers) {
    const div = document.createElement('div');
    div.className = 'seek-marker';
    div.style.left = `${(m.tStart / dur) * 100}%`;
    div.style.width = `${Math.max(0.5, ((m.tEnd - m.tStart) / dur) * 100)}%`;
    div.style.background = markerColor(m, 0.35);
    div.title = `#${m.id} ${m.freqLow}–${m.freqHigh} Hz @ ${m.tStart}s`;
    div.addEventListener('click', (e) => {
      e.stopPropagation();
      seekTo(m.tStart, true);
    });
    box.appendChild(div);
  }
}

function seekTo(t, autoplay) {
  if (!isFinite(audio.duration)) return;
  audio.currentTime = Math.max(0, Math.min(t, audio.duration));
  if (autoplay) {
    ensureAudioGraph();
    audioCtx.resume();
    audio.play();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 工程保存 / 加载 ----------
function saveProject() {
  const project = {
    app: 'local-audio-spectrum-analyzer',
    version: 1,
    audioFileName: state.audioFileName,
    settings: {
      view: state.view,
      scale: state.scale,
      fftSize: state.fftSize,
      peakHold: String(state.peakHold),
    },
    markers: state.markers,
  };
  download(
    JSON.stringify(project, null, 2),
    (state.audioFileName || 'project').replace(/\.[^.]+$/, '') + '.spectrum.json',
    'application/json'
  );
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(reader.result);
      if (p.app !== 'local-audio-spectrum-analyzer') throw new Error('不是本工具导出的工程文件');
      if (p.settings) {
        setView(p.settings.view);
        setScale(p.settings.scale);
        if (p.settings.fftSize) {
          state.fftSize = Number(p.settings.fftSize);
          $('fftSize').value = String(state.fftSize);
          if (audioCtx) applyFftSize();
        }
        if (p.settings.peakHold !== undefined) {
          state.peakHold = p.settings.peakHold === 'Infinity' ? Infinity : Number(p.settings.peakHold);
          $('peakHold').value = p.settings.peakHold;
          if (audioCtx) resetPeakHold();
        }
      }
      state.markers = Array.isArray(p.markers) ? p.markers : [];
      nextMarkerId = state.markers.reduce((mx, m) => Math.max(mx, m.id + 1), 1);
      renderMarkers();
      if (p.audioFileName && p.audioFileName !== state.audioFileName) {
        alert(`工程对应的音频文件是「${p.audioFileName}」，请手动选择该文件。`);
      }
    } catch (err) {
      alert('工程文件加载失败：' + err.message);
    }
  };
  reader.readAsText(file);
}

// ---------- 报告导出 ----------
function exportReport() {
  const dur = isFinite(audio.duration) ? audio.duration : 0;
  const lines = [
    '# 音频频谱分析报告',
    '',
    `- 音频文件：${state.audioFileName || '(未命名)'}`,
    `- 时长：${dur.toFixed(2)} s`,
    `- 采样率：${audioCtx ? audioCtx.sampleRate + ' Hz' : '未知'}`,
    `- 分析窗口：${state.fftSize}（频率分辨率 ${audioCtx ? (audioCtx.sampleRate / state.fftSize).toFixed(1) : '?'} Hz）`,
    `- 峰值保持：${state.peakHold === Infinity ? '无限' : state.peakHold + ' s'}`,
    `- 频率刻度：${state.scale === 'log' ? '对数' : '线性'}`,
    `- 导出时间：${new Date().toLocaleString()}`,
    '',
    '## 频段标记',
    '',
  ];
  if (state.markers.length === 0) {
    lines.push('（无标记）');
  } else {
    lines.push('| # | 频段 (Hz) | 时间范围 (s) | 备注 |');
    lines.push('|---|-----------|--------------|------|');
    for (const m of state.markers) {
      lines.push(`| ${m.id} | ${m.freqLow} – ${m.freqHigh} | ${m.tStart.toFixed(2)} – ${m.tEnd.toFixed(2)} | ${m.note || ''} |`);
    }
  }
  lines.push('');
  download(lines.join('\n'),
    (state.audioFileName || 'report').replace(/\.[^.]+$/, '') + '.report.md',
    'text/markdown');
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 播放进度 ----------
function fmtTime(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${String(m).padStart(2, '0')}:${sec.toFixed(1).padStart(4, '0')}`;
}

function tickProgress() {
  requestAnimationFrame(tickProgress);
  const dur = audio.duration;
  $('timeLabel').textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(dur)}`;
  if (isFinite(dur) && dur > 0) {
    const pct = (audio.currentTime / dur) * 100;
    $('seekProgress').style.width = pct + '%';
    $('seekCursor').style.left = pct + '%';
  }
}

// ---------- 事件绑定 ----------
function setView(view) {
  if (!['waveform', 'spectrum', 'diff'].includes(view)) return;
  state.view = view;
  for (const b of $('viewSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
}

function setScale(scale) {
  if (!['linear', 'log'].includes(scale)) return;
  state.scale = scale;
  state.selection = null; // 刻度变化后旧选区像素位置失效，清除避免错位
  updateSelInfo();
  for (const b of $('scaleSeg').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.scale === scale);
  }
}

function updateSelInfo() {
  const el = $('selInfo');
  if (state.selection) {
    const { f1, f2 } = state.selection;
    el.textContent = `已选频段：${Math.round(f1)} – ${Math.round(f2)} Hz`;
    $('btnAddMarker').disabled = !audio.duration;
  } else {
    el.textContent = '未选择频段（在频谱图上拖动选择）';
    $('btnAddMarker').disabled = true;
  }
}

function loadAudioSource(src, name) {
  ensureAudioGraph();
  audioCtx.resume();
  audio.src = src;
  state.audioFileName = name;
  $('fileName').textContent = name;
  $('fileName').title = name;
  $('btnPlay').disabled = false;
  $('canvasHint').classList.add('hidden');
  updateFftInfo();
}

function bindEvents() {
  $('fileInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    loadAudioSource(URL.createObjectURL(f), f.name);
  });

  for (const btn of document.querySelectorAll('.sample')) {
    btn.addEventListener('click', () => loadAudioSource(btn.dataset.sample, btn.dataset.sample.split('/').pop()));
  }

  $('btnPlay').addEventListener('click', () => {
    ensureAudioGraph();
    audioCtx.resume();
    if (audio.paused) audio.play();
    else audio.pause();
  });
  audio.addEventListener('play', () => { $('btnPlay').textContent = '暂停'; });
  audio.addEventListener('pause', () => { $('btnPlay').textContent = '播放'; });
  audio.addEventListener('loadedmetadata', renderSeekMarkers);

  // 进度条点击 / 拖动跳转
  const seekWrap = $('seekWrap');
  let seeking = false;
  const seekFromEvent = (e) => {
    const rect = $('seekTrack').getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (isFinite(audio.duration)) audio.currentTime = ratio * audio.duration;
  };
  seekWrap.addEventListener('pointerdown', (e) => { seeking = true; seekFromEvent(e); });
  window.addEventListener('pointermove', (e) => { if (seeking) seekFromEvent(e); });
  window.addEventListener('pointerup', () => { seeking = false; });

  // 视图 / 刻度切换
  $('viewSeg').addEventListener('click', (e) => {
    if (e.target.dataset.view) setView(e.target.dataset.view);
  });
  $('scaleSeg').addEventListener('click', (e) => {
    if (e.target.dataset.scale) setScale(e.target.dataset.scale);
  });

  // 参数
  $('fftSize').addEventListener('change', (e) => {
    state.fftSize = Number(e.target.value);
    if (audioCtx) applyFftSize(); // 重建缓冲 + 清空峰值，杜绝旧数据残留
  });
  $('peakHold').addEventListener('change', (e) => {
    state.peakHold = e.target.value === 'Infinity' ? Infinity : Number(e.target.value);
    if (audioCtx) resetPeakHold(); // 保持时间变化同样清空旧峰值
  });

  // 频谱图拖选频段
  let dragStartX = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (state.view !== 'spectrum' || !audioCtx) return;
    dragStartX = e.offsetX;
    state.selection = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragStartX === null) return;
    const w = canvas.clientWidth;
    const fa = xToFreq(Math.max(0, Math.min(dragStartX, w)), w);
    const fb = xToFreq(Math.max(0, Math.min(e.offsetX, w)), w);
    state.selection = { f1: Math.min(fa, fb), f2: Math.max(fa, fb) };
    updateSelInfo();
  });
  window.addEventListener('pointerup', () => {
    if (dragStartX !== null && state.selection && state.selection.f2 - state.selection.f1 < 1) {
      state.selection = null; // 视为单击，清除选区
      updateSelInfo();
    }
    dragStartX = null;
  });

  $('btnAddMarker').addEventListener('click', addMarker);
  $('btnClearMarkers').addEventListener('click', () => {
    state.markers = [];
    renderMarkers();
  });
  $('markerBody').addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.del;
    if (id) {
      state.markers = state.markers.filter(m => m.id !== Number(id));
      renderMarkers();
    }
  });
  $('markerBody').addEventListener('change', (e) => {
    const field = e.target.dataset.field;
    if (!field) return;
    const id = Number(e.target.closest('tr').dataset.id);
    const m = state.markers.find(m => m.id === id);
    if (!m) return;
    if (field === 'note') m.note = e.target.value;
    else {
      const v = Number(e.target.value);
      if (isFinite(v) && v >= 0) m[field] = round2(v);
      else e.target.value = m[field];
    }
    renderSeekMarkers();
  });

  $('btnSaveProject').addEventListener('click', saveProject);
  $('btnLoadProject').addEventListener('click', () => $('projectInput').click());
  $('projectInput').addEventListener('change', (e) => {
    if (e.target.files[0]) loadProject(e.target.files[0]);
    e.target.value = '';
  });
  $('btnExportReport').addEventListener('click', exportReport);
}

bindEvents();
requestAnimationFrame(draw);
requestAnimationFrame(tickProgress);
