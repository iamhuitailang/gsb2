/* 均衡器调音试验台 —— 纯 Web Audio API，无构建依赖，可直接以 file:// 打开 */
(function () {
'use strict';

// ---------------- 常量 ----------------
var F_MIN = 20, F_MAX = 20000;          // 频率可调范围 (Hz)
var GAIN_MIN = -24, GAIN_MAX = 24;      // 增益可调范围 (dB)
var Q_MIN = 0.1, Q_MAX = 18;            // Q 可调范围
var DB_TOP = 30, DB_BOTTOM = -30;       // 曲线显示范围 (dB)
var STORAGE_KEY = 'eq-bench.v1';

var BAND_TYPES = {
  highpass:  { name: '低切 (High-Pass)',   hasGain: false },
  peaking:   { name: '峰值 (Peaking)',     hasGain: true  },
  lowshelf:  { name: '低频搁架 (Low Shelf)',  hasGain: true },
  highshelf: { name: '高频搁架 (High Shelf)', hasGain: true }
};
var BAND_COLORS = ['#ff6b6b', '#4ecdc4', '#ffd93d', '#a78bfa', '#6bcb77', '#ff9f45', '#54a0ff', '#f368e0'];

// ---------------- 状态 ----------------
function defaultPresets() {
  return {
    A: { bands: [
      { type: 'highpass',  freq: 80,   gain: 0,  q: 0.707, bypass: false },
      { type: 'peaking',   freq: 400,  gain: -4, q: 1.5,   bypass: false },
      { type: 'highshelf', freq: 8000, gain: 3,  q: 0.707, bypass: false }
    ]},
    B: { bands: [
      { type: 'lowshelf',  freq: 200,  gain: 4,  q: 0.707, bypass: false },
      { type: 'peaking',   freq: 3000, gain: 3,  q: 2,     bypass: false },
      { type: 'highpass',  freq: 40,   gain: 0,  q: 0.707, bypass: false }
    ]}
  };
}

var state = {
  presets: defaultPresets(),
  active: 'A',
  matchLoudness: true,
  bypassAll: false,
  showSpectrum: true
};

var selectedBand = -1;          // 当前选中的频段序号（当前激活设置内）
var selRange = null;            // {lo, hi} 分析频段 (Hz)

// ---------------- 音频图 ----------------
var ctx = new (window.AudioContext || window.webkitAudioContext)();
var buffer = null, bufferName = '';
var sourceNode = null;
var inTap, dryGain, analyserIn, analyserOut, masterGain;
var chainEntry = {}, chainGain = {}, chainNodes = { A: [], B: [] };
var trim = { A: 1, B: 1 };
var rmsCache = {};              // preset bands JSON -> rms
var playing = false, startCtxTime = 0, startOffset = 0;

function buildGraph() {
  inTap = ctx.createGain();
  dryGain = ctx.createGain(); dryGain.gain.value = 0;
  masterGain = ctx.createGain(); masterGain.gain.value = 1;
  analyserIn = ctx.createAnalyser();  analyserIn.fftSize = 8192;
  analyserOut = ctx.createAnalyser(); analyserOut.fftSize = 8192;
  analyserIn.smoothingTimeConstant = 0.7;
  analyserOut.smoothingTimeConstant = 0.7;

  inTap.connect(analyserIn);
  inTap.connect(dryGain); dryGain.connect(masterGain);
  ['A', 'B'].forEach(function (w) {
    chainEntry[w] = ctx.createGain();
    chainGain[w] = ctx.createGain(); chainGain[w].gain.value = 0;
    inTap.connect(chainEntry[w]);
    chainGain[w].connect(masterGain);
    rebuildChain(w);
  });
  masterGain.connect(analyserOut);
  analyserOut.connect(ctx.destination);
  applyGains(false);
}

// 用当前参数重建某条链路（旁路的段直接不接入）。
// 结构（段数/类型/旁路）未变时只更新参数，避免滑杆拖动时频繁建节点。
var chainSig = { A: '', B: '' };
function rebuildChain(which) {
  var preset = state.presets[which];
  var sig = preset.bands.map(function (b) { return b.type + (b.bypass ? 'x' : 'o'); }).join(',');
  if (sig === chainSig[which]) {
    var i = 0;
    preset.bands.forEach(function (band) {
      if (band.bypass) return;
      var bq = chainNodes[which][i++];
      bq.frequency.value = band.freq;
      bq.Q.value = band.q;
      bq.gain.value = band.gain;
    });
    return;
  }
  chainSig[which] = sig;
  var entry = chainEntry[which], exit = chainGain[which];
  entry.disconnect();
  chainNodes[which].forEach(function (n) { n.disconnect(); });
  var nodes = [], prev = entry;
  preset.bands.forEach(function (band) {
    if (band.bypass) return;
    var bq = ctx.createBiquadFilter();
    bq.type = band.type;
    bq.frequency.value = band.freq;
    bq.Q.value = band.q;
    bq.gain.value = band.gain;
    prev.connect(bq); prev = bq; nodes.push(bq);
  });
  prev.connect(exit);
  chainNodes[which] = nodes;
}

function applyGains(ramp) {
  var t = ctx.currentTime;
  function set(p, v) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(v, t + (ramp ? 0.04 : 0.001));
  }
  set(dryGain.gain, state.bypassAll ? 1 : 0);
  set(chainGain.A.gain, (!state.bypassAll && state.active === 'A') ? trim.A : 0);
  set(chainGain.B.gain, (!state.bypassAll && state.active === 'B') ? trim.B : 0);
}

// ---------------- 双二阶系数与解析频响（与 Web Audio 规范公式一致） ----------------
function biquadCoeffs(type, freq, q, gainDb, fs) {
  var w0 = 2 * Math.PI * freq / fs;
  var cw = Math.cos(w0), sw = Math.sin(w0);
  var alpha = sw / (2 * q);
  var A = Math.pow(10, gainDb / 40);
  var b0, b1, b2, a0, a1, a2, sq;
  switch (type) {
    case 'highpass':
      b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
      a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha; break;
    case 'peaking':
      b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A; break;
    case 'lowshelf':
      sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cw + sq);
      b1 = 2 * A * ((A - 1) - (A + 1) * cw);
      b2 = A * ((A + 1) - (A - 1) * cw - sq);
      a0 = (A + 1) + (A - 1) * cw + sq;
      a1 = -2 * ((A - 1) + (A + 1) * cw);
      a2 = (A + 1) + (A - 1) * cw - sq; break;
    case 'highshelf':
      sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cw + sq);
      b1 = -2 * A * ((A - 1) + (A + 1) * cw);
      b2 = A * ((A + 1) + (A - 1) * cw - sq);
      a0 = (A + 1) - (A - 1) * cw + sq;
      a1 = 2 * ((A - 1) - (A + 1) * cw);
      a2 = (A + 1) - (A - 1) * cw - sq; break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function magResponse(c, f, fs) {
  var w = 2 * Math.PI * f / fs;
  var c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  var nr = c.b0 + c.b1 * c1 + c.b2 * c2, ni = -(c.b1 * s1 + c.b2 * s2);
  var dr = 1 + c.a1 * c1 + c.a2 * c2,   di = -(c.a1 * s1 + c.a2 * s2);
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

function bandDbAt(band, f) {
  var c = biquadCoeffs(band.type, band.freq, band.q, band.gain, ctx.sampleRate);
  return 20 * Math.log10(magResponse(c, f, ctx.sampleRate) + 1e-9);
}

function compositeDbAt(preset, f) {
  var db = 0;
  preset.bands.forEach(function (b) { if (!b.bypass) db += bandDbAt(b, f); });
  return db;
}

// 数值扫描某段的实际作用频段（响应幅度超过阈值的范围）
function bandEffectiveRange(band) {
  var N = 240, pts = [], peak = 0, peakF = band.freq, i;
  for (i = 0; i < N; i++) {
    var f = F_MIN * Math.pow(F_MAX / F_MIN, i / (N - 1));
    var db = bandDbAt(band, f);
    pts.push([f, db]);
    if (Math.abs(db) > Math.abs(peak)) { peak = db; peakF = f; }
  }
  if (Math.abs(peak) < 0.5) return [band.freq / 2, Math.min(F_MAX, band.freq * 2)];
  var thresh = Math.max(0.5, Math.abs(peak) * 0.1);
  var pi = 0;
  for (i = 0; i < N; i++) if (pts[i][0] >= peakF) { pi = i; break; }
  var i0 = pi, i1 = pi;
  while (i0 > 0 && Math.abs(pts[i0][1]) > thresh) i0--;
  while (i1 < N - 1 && Math.abs(pts[i1][1]) > thresh) i1++;
  return [Math.max(F_MIN, pts[i0][0]), Math.min(F_MAX, pts[i1][0])];
}

// ---------------- 参数校验 ----------------
function validateBand(band) {
  var nyq = ctx.sampleRate / 2;
  var fMax = Math.min(F_MAX, Math.floor(nyq * 0.95));
  if (!(band.freq >= F_MIN && band.freq <= fMax))
    return '频率需在 ' + F_MIN + '–' + fMax + ' Hz 之间（须低于奈奎斯特频率 ' + Math.round(nyq) + ' Hz，留 5% 余量保证滤波器稳定）';
  if (!(band.gain >= GAIN_MIN && band.gain <= GAIN_MAX))
    return '增益需在 ' + GAIN_MIN + ' 至 +' + GAIN_MAX + ' dB 之间（过大易削波失真，也不利于两套设置公平对比）';
  if (!(band.q >= Q_MIN && band.q <= Q_MAX))
    return 'Q 需在 ' + Q_MIN + '–' + Q_MAX + ' 之间（过小曲线过宽近乎搁架，过大近似陷波且易振铃）';
  return null;
}

// ---------------- 播放控制 ----------------
function getPosition() {
  if (!buffer) return 0;
  if (!playing) return startOffset;
  return (ctx.currentTime - startCtxTime + startOffset) % buffer.duration;
}

function startSource(offset) {
  stopSource();
  sourceNode = ctx.createBufferSource();
  sourceNode.buffer = buffer;
  sourceNode.loop = true;
  sourceNode.connect(inTap);
  sourceNode.start(0, offset % buffer.duration);
  startCtxTime = ctx.currentTime;
  startOffset = offset % buffer.duration;
  playing = true;
}

function stopSource() {
  if (sourceNode) { try { sourceNode.stop(); } catch (e) {} sourceNode.disconnect(); sourceNode = null; }
  playing = false;
}

function setBuffer(buf, name) {
  stopSource();
  buffer = buf; bufferName = name;
  startOffset = 0;
  $('fileName').textContent = name + '（' + buf.numberOfChannels + ' 声道, ' +
    buf.sampleRate + ' Hz, ' + buf.duration.toFixed(1) + ' s）';
  $('playBtn').disabled = false;
  $('seekBar').disabled = false;
  $('exportWav').disabled = false;
  rmsCache = {};
  scheduleTrimUpdate();
}

// ---------------- 响度匹配 ----------------
function renderPresetOffline(which) {
  var preset = state.presets[which];
  var off = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  var src = off.createBufferSource(); src.buffer = buffer;
  var node = src;
  preset.bands.forEach(function (band) {
    if (band.bypass) return;
    var bq = off.createBiquadFilter();
    bq.type = band.type; bq.frequency.value = band.freq;
    bq.Q.value = band.q; bq.gain.value = band.gain;
    node.connect(bq); node = bq;
  });
  node.connect(off.destination);
  src.start();
  return off.startRendering();
}

function bufferRms(buf) {
  var sum = 0, n = 0;
  for (var ch = 0; ch < buf.numberOfChannels; ch++) {
    var d = buf.getChannelData(ch);
    for (var i = 0; i < d.length; i++) sum += d[i] * d[i];
    n += d.length;
  }
  return Math.sqrt(sum / Math.max(1, n));
}

function rmsFor(which) {
  var key = which + '|' + JSON.stringify(state.presets[which].bands) + '|' + bufferName + buffer.length;
  if (rmsCache[key]) return Promise.resolve(rmsCache[key]);
  return renderPresetOffline(which).then(function (buf) {
    var r = bufferRms(buf);
    rmsCache[key] = r;
    return r;
  });
}

var trimTimer = null;
function scheduleTrimUpdate() {
  if (!buffer) return;
  clearTimeout(trimTimer);
  trimTimer = setTimeout(updateTrims, 500);
}

function updateTrims() {
  if (!buffer) return;
  if (!state.matchLoudness) {
    trim.A = 1; trim.B = 1;
    $('trimInfo').textContent = '（等响度已关闭，两套按原始输出电平播放）';
    applyGains(true);
    return;
  }
  Promise.all([rmsFor('A'), rmsFor('B')]).then(function (rs) {
    var target = Math.min(rs[0], rs[1]);
    if (target <= 0) return;
    trim.A = Math.min(4, target / rs[0]);
    trim.B = Math.min(4, target / rs[1]);
    $('trimInfo').textContent = '响度补偿 A ' + dbStr(trim.A) + ' / B ' + dbStr(trim.B) +
      '（以较安静的一套为基准，避免响的天然占优）';
    applyGains(true);
  });
}

function dbStr(lin) {
  var db = 20 * Math.log10(lin);
  return (db <= 0 ? '' : '+') + db.toFixed(1) + ' dB';
}

// ---------------- 样音生成 ----------------
function makeBuffer(seconds, channels, fill) {
  var len = Math.floor(seconds * ctx.sampleRate);
  var buf = ctx.createBuffer(channels, len, ctx.sampleRate);
  for (var ch = 0; ch < channels; ch++) fill(buf.getChannelData(ch), ch, ctx.sampleRate);
  return buf;
}

function genSweep() {
  return makeBuffer(6, 2, function (d) {
    var dur = 6, f0 = 20, f1 = 20000, k = Math.log(f1 / f0) / dur;
    for (var i = 0; i < d.length; i++) {
      var t = i / ctx.sampleRate;
      var phase = 2 * Math.PI * f0 * (Math.exp(k * t) - 1) / k;
      var fade = Math.min(1, t / 0.02, (dur - t) / 0.05);
      d[i] = 0.5 * Math.sin(phase) * fade;
    }
  });
}

function genDrums() {
  var bpm = 120, beat = 60 / bpm, dur = beat * 8; // 2 小节
  var buf = makeBuffer(dur, 2, function (d, ch, fs) {
    var noise = [];
    for (var i = 0; i < 4096; i++) noise.push(Math.random() * 2 - 1);
    function kick(t0) {
      var s = Math.floor(t0 * fs);
      for (var i = 0; i < 0.3 * fs && s + i < d.length; i++) {
        var t = i / fs;
        var f = 45 + 105 * Math.exp(-t / 0.03);
        d[s + i] += 0.9 * Math.sin(2 * Math.PI * f * t) * Math.exp(-t / 0.12);
      }
    }
    function snare(t0) {
      var s = Math.floor(t0 * fs);
      for (var i = 0; i < 0.2 * fs && s + i < d.length; i++) {
        var t = i / fs;
        d[s + i] += (0.5 * noise[i % 4096] + 0.3 * Math.sin(2 * Math.PI * 180 * t)) * Math.exp(-t / 0.06);
      }
    }
    function hat(t0, open) {
      var s = Math.floor(t0 * fs), L = (open ? 0.15 : 0.04) * fs;
      var prev = 0;
      for (var i = 0; i < L && s + i < d.length; i++) {
        var t = i / fs;
        var n = noise[(i * 7) % 4096];
        var hp = n - prev; prev = n; // 一阶差分近似高通
        d[s + i] += 0.25 * hp * Math.exp(-t / (open ? 0.06 : 0.015));
      }
    }
    for (var b = 0; b < 8; b++) {
      var t = b * beat;
      if (b % 4 === 0 || b % 4 === 3) kick(t);
      if (b % 4 === 2) kick(t + beat * 0.5);
      if (b % 2 === 1) snare(t);
      hat(t, false); hat(t + beat / 2, b % 4 === 3);
    }
  });
  return buf;
}

function genStereo() {
  // 左右声道内容不同：左耳分解和弦旋律，右耳高五度和声 + 延迟，便于检验声道保留
  var dur = 8;
  return makeBuffer(dur, 2, function (d, ch, fs) {
    var notesL = [261.6, 329.6, 392.0, 329.6, 293.7, 349.2, 440.0, 349.2];
    var notesR = [392.0, 493.9, 587.3, 493.9, 440.0, 523.3, 659.3, 523.3];
    var notes = ch === 0 ? notesL : notesR;
    var step = dur / notes.length;
    var delay = ch === 1 ? 0.03 : 0;
    for (var n = 0; n < notes.length; n++) {
      var t0 = n * step + delay, s = Math.floor(t0 * fs);
      for (var i = 0; i < step * 0.9 * fs && s + i < d.length; i++) {
        var t = i / fs;
        var env = Math.exp(-t / 0.35);
        d[s + i] += 0.3 * env * (Math.sin(2 * Math.PI * notes[n] * t) +
                                 0.3 * Math.sin(4 * Math.PI * notes[n] * t));
      }
    }
  });
}

// ---------------- 曲线绘制 ----------------
var canvas = $('curveCanvas'), g2d = canvas.getContext('2d');

function fMaxDisplay() { return Math.min(F_MAX, ctx.sampleRate / 2); }
function freqToX(f, w) { return Math.log(f / F_MIN) / Math.log(fMaxDisplay() / F_MIN) * w; }
function xToFreq(x, w) { return F_MIN * Math.pow(fMaxDisplay() / F_MIN, x / w); }
function dbToY(db, h) { return (DB_TOP - db) / (DB_TOP - DB_BOTTOM) * h; }
function yToDb(y, h) { return DB_TOP - y / h * (DB_TOP - DB_BOTTOM); }

function drawCurve() {
  var dpr = window.devicePixelRatio || 1;
  var W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; }
  g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2d.clearRect(0, 0, W, H);

  // 网格
  g2d.strokeStyle = '#262b33'; g2d.fillStyle = '#5c636e'; g2d.font = '10px sans-serif';
  g2d.lineWidth = 1;
  [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach(function (f) {
    if (f > fMaxDisplay()) return;
    var x = freqToX(f, W);
    g2d.beginPath(); g2d.moveTo(x, 0); g2d.lineTo(x, H); g2d.stroke();
    g2d.fillText(f >= 1000 ? (f / 1000) + 'k' : String(f), x + 3, H - 5);
  });
  for (var db = DB_BOTTOM; db <= DB_TOP; db += 12) {
    var y = dbToY(db, H);
    g2d.strokeStyle = db === 0 ? '#3a414d' : '#22262d';
    g2d.beginPath(); g2d.moveTo(0, y); g2d.lineTo(W, y); g2d.stroke();
    g2d.fillStyle = '#5c636e';
    g2d.fillText((db > 0 ? '+' : '') + db, 4, y - 3);
  }

  // 选中频段高亮
  if (selRange) {
    var x0 = freqToX(selRange.lo, W), x1 = freqToX(selRange.hi, W);
    g2d.fillStyle = 'rgba(61,126,255,0.12)';
    g2d.fillRect(x0, 0, x1 - x0, H);
    g2d.strokeStyle = 'rgba(61,126,255,0.6)';
    g2d.strokeRect(x0, 0, x1 - x0, H);
  }

  // 实时频谱（输入灰 / 输出绿）
  if (state.showSpectrum && buffer && playing) {
    drawSpectrum(analyserIn, 'rgba(140,148,160,0.5)', W, H);
    drawSpectrum(analyserOut, 'rgba(107,203,119,0.65)', W, H);
  }

  // 各段贡献曲线 + 合成曲线（系数每帧每段只算一次）
  var preset = state.presets[state.active];
  var coeffs = preset.bands.map(function (b) {
    return biquadCoeffs(b.type, b.freq, b.q, b.gain, ctx.sampleRate);
  });
  function dbOf(c, f) { return 20 * Math.log10(magResponse(c, f, ctx.sampleRate) + 1e-9); }
  var N = 256, i, f, x, y;
  preset.bands.forEach(function (band, bi) {
    g2d.strokeStyle = BAND_COLORS[bi % BAND_COLORS.length];
    g2d.globalAlpha = band.bypass ? 0.35 : 0.8;
    g2d.lineWidth = 1;
    g2d.setLineDash(band.bypass ? [4, 4] : []);
    g2d.beginPath();
    for (i = 0; i < N; i++) {
      f = xToFreq(i / (N - 1) * W, W);
      x = freqToX(f, W); y = dbToY(dbOf(coeffs[bi], f), H);
      if (i === 0) g2d.moveTo(x, y); else g2d.lineTo(x, y);
    }
    g2d.stroke();
    g2d.setLineDash([]);
    g2d.globalAlpha = 1;
  });

  g2d.strokeStyle = '#ffffff'; g2d.lineWidth = 2.5;
  g2d.beginPath();
  for (i = 0; i < N; i++) {
    f = xToFreq(i / (N - 1) * W, W);
    var total = 0;
    preset.bands.forEach(function (band, bi) { if (!band.bypass) total += dbOf(coeffs[bi], f); });
    x = freqToX(f, W); y = dbToY(total, H);
    if (i === 0) g2d.moveTo(x, y); else g2d.lineTo(x, y);
  }
  g2d.stroke();
  g2d.lineWidth = 1;

  // 频段手柄
  preset.bands.forEach(function (band, bi) {
    var hx = freqToX(band.freq, W);
    var hy = dbToY(bandDbAt(band, band.freq), H);
    g2d.beginPath();
    g2d.arc(hx, hy, bi === selectedBand ? 7 : 5, 0, Math.PI * 2);
    g2d.fillStyle = BAND_COLORS[bi % BAND_COLORS.length];
    g2d.fill();
    if (bi === selectedBand) { g2d.strokeStyle = '#fff'; g2d.stroke(); }
    g2d.fillStyle = '#0c0e11';
    g2d.font = 'bold 9px sans-serif';
    g2d.fillText(String(bi + 1), hx - 3, hy + 3);
  });
}

var specData = null;
function drawSpectrum(analyser, color, W, H) {
  if (!specData || specData.length !== analyser.frequencyBinCount)
    specData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(specData);
  var binHz = ctx.sampleRate / analyser.fftSize;
  g2d.strokeStyle = color;
  g2d.beginPath();
  var started = false;
  for (var i = 1; i < specData.length; i++) {
    var f = i * binHz;
    if (f < F_MIN) continue;
    if (f > fMaxDisplay()) break;
    // 将电平映射到曲线坐标：-90dBFS -> 底部, 0dBFS -> 顶部
    var db = Math.max(-90, specData[i]);
    var y = dbToY((db + 90) / 90 * (DB_TOP - DB_BOTTOM) + DB_BOTTOM, H);
    var x = freqToX(f, W);
    if (!started) { g2d.moveTo(x, y); started = true; } else g2d.lineTo(x, y);
  }
  g2d.stroke();
}

// ---------------- 能量分析面板 ----------------
function bandEnergy(analyser, lo, hi) {
  if (!specData || specData.length !== analyser.frequencyBinCount)
    specData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(specData);
  var binHz = ctx.sampleRate / analyser.fftSize;
  var sum = 0;
  var i0 = Math.max(1, Math.floor(lo / binHz)), i1 = Math.min(specData.length - 1, Math.ceil(hi / binHz));
  for (var i = i0; i <= i1; i++) sum += Math.pow(10, specData[i] / 10);
  return 10 * Math.log10(sum + 1e-12);
}

function expectedDelta(lo, hi) {
  var preset = state.presets[state.active];
  var sum = 0, N = 32;
  for (var i = 0; i < N; i++) {
    var f = lo * Math.pow(hi / lo, i / (N - 1));
    sum += compositeDbAt(preset, f);
  }
  return sum / N;
}

function fmtHz(f) {
  return f >= 1000 ? (f / 1000).toFixed(f < 10000 ? 2 : 1) + ' kHz' : Math.round(f) + ' Hz';
}

function updateEnergyPanel() {
  var el = $('energyContent');
  if (!selRange) {
    el.className = 'muted';
    el.textContent = '尚未选择频段 —— 在曲线上单击频段手柄或横向拖动选择。';
    return;
  }
  var preset = state.presets[state.active];
  var enabled = preset.bands.filter(function (b) { return !b.bypass; });
  var exp = expectedDelta(selRange.lo, selRange.hi);
  var html = '<div class="grid">' +
    '<div class="item">频段<div class="v">' + fmtHz(selRange.lo) + ' – ' + fmtHz(selRange.hi) + '</div></div>' +
    '<div class="item">理论预期<div class="v">' + (exp >= 0 ? '+' : '') + exp.toFixed(1) + ' dB</div></div>';

  if (buffer && playing) {
    var ein = bandEnergy(analyserIn, selRange.lo, selRange.hi);
    var eout = bandEnergy(analyserOut, selRange.lo, selRange.hi);
    var measured = eout - ein;
    html += '<div class="item">输入能量<div class="v">' + ein.toFixed(1) + ' dB</div></div>' +
            '<div class="item">输出能量<div class="v">' + eout.toFixed(1) + ' dB</div></div>' +
            '<div class="item">实测差<div class="v">' + (measured >= 0 ? '+' : '') + measured.toFixed(1) + ' dB</div></div>';
  } else {
    html += '<div class="item muted">播放音频后显示实测输入/输出能量</div>';
  }
  html += '</div>';
  if (enabled.length === 1) {
    var b = enabled[0];
    html += '<div class="note">当前仅启用 1 段（' + BAND_TYPES[b.type].name + ' @ ' + fmtHz(b.freq) +
      (BAND_TYPES[b.type].hasGain ? ', ' + b.gain + ' dB' : '') +
      '）—— 可将「实测差」与「理论预期」直接核对。注意：实测是音乐信号在该频带的平均能量差，与单点频响存在合理偏差。</div>';
  } else if (enabled.length > 1) {
    html += '<div class="note">当前启用 ' + enabled.length + ' 段，「理论预期」为合成响应在该频段的平均。旁路到只剩 1 段可逐段核对。</div>';
  }
  el.className = '';
  el.innerHTML = html;
}

// ---------------- 频段列表 UI ----------------
function renderBandList() {
  var list = $('bandList');
  list.innerHTML = '';
  $('editingWhich').textContent = state.active;
  var preset = state.presets[state.active];
  preset.bands.forEach(function (band, bi) {
    var row = document.createElement('div');
    row.className = 'band-row' + (bi === selectedBand ? ' selected' : '') + (band.bypass ? ' bypassed' : '');
    row.style.setProperty('--c', BAND_COLORS[bi % BAND_COLORS.length]);

    // 旁路
    var bpLabel = document.createElement('label');
    bpLabel.className = 'chk';
    var bp = document.createElement('input');
    bp.type = 'checkbox'; bp.checked = !band.bypass;
    bp.title = '取消勾选 = 旁路该段';
    bp.onchange = function () {
      band.bypass = !bp.checked;
      onPresetChanged(true);
    };
    bpLabel.appendChild(bp);
    bpLabel.appendChild(document.createTextNode(' 段' + (bi + 1)));
    row.appendChild(bpLabel);

    // 类型
    var sel = document.createElement('select');
    Object.keys(BAND_TYPES).forEach(function (t) {
      var o = document.createElement('option');
      o.value = t; o.textContent = BAND_TYPES[t].name;
      if (band.type === t) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      band.type = sel.value;
      if (!BAND_TYPES[band.type].hasGain) band.gain = 0;
      onPresetChanged(true);
    };
    row.appendChild(sel);

    // 参数控件：频率 / 增益 / Q
    var err = document.createElement('span');
    err.className = 'err';

    function makeField(label, get, set, min, max, step, logScale, fmt, disabled) {
      var wrap = document.createElement('span');
      wrap.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var slider = document.createElement('input');
      slider.type = 'range'; slider.min = 0; slider.max = 1000; slider.step = 1;
      var num = document.createElement('input');
      num.type = 'number'; num.step = step;
      function toSlider(v) { return logScale ? Math.log(v / min) / Math.log(max / min) * 1000 : (v - min) / (max - min) * 1000; }
      function fromSlider(s) { return logScale ? min * Math.pow(max / min, s / 1000) : min + (max - min) * s / 1000; }
      slider.value = toSlider(get());
      num.value = fmt(get());
      if (disabled) { slider.disabled = true; num.disabled = true; }
      slider.oninput = function () {
        var v = fromSlider(+slider.value);
        num.value = fmt(v);
        commit(v);
      };
      num.onchange = function () {
        commit(parseFloat(num.value));
      };
      function commit(v) {
        var msg = set(v);
        if (msg) {
          err.textContent = msg;
          num.classList.add('invalid');
        } else {
          err.textContent = '';
          num.classList.remove('invalid');
          slider.value = toSlider(get());
          num.value = fmt(get());
          onPresetChanged(false);
        }
      }
      wrap.appendChild(lab); wrap.appendChild(slider); wrap.appendChild(num);
      return wrap;
    }

    row.appendChild(makeField('频率 Hz',
      function () { return band.freq; },
      function (v) {
        if (isNaN(v)) return '频率必须是数字';
        var nyq = ctx.sampleRate / 2, fMax = Math.min(F_MAX, Math.floor(nyq * 0.95));
        if (v < F_MIN || v > fMax) return '频率需在 ' + F_MIN + '–' + fMax + ' Hz 之间（奈奎斯特频率 ' + Math.round(nyq) + ' Hz，留 5% 余量）';
        band.freq = v; return null;
      }, F_MIN, F_MAX, 1, true, function (v) { return Math.round(v); }, false));

    row.appendChild(makeField('增益 dB',
      function () { return band.gain; },
      function (v) {
        if (isNaN(v)) return '增益必须是数字';
        if (v < GAIN_MIN || v > GAIN_MAX) return '增益需在 ' + GAIN_MIN + ' 至 +' + GAIN_MAX + ' dB 之间（过大易削波，且不利于两套公平对比）';
        band.gain = v; return null;
      }, GAIN_MIN, GAIN_MAX, 0.1, false, function (v) { return v.toFixed(1); },
      !BAND_TYPES[band.type].hasGain));

    row.appendChild(makeField('Q',
      function () { return band.q; },
      function (v) {
        if (isNaN(v)) return 'Q 必须是数字';
        if (v < Q_MIN || v > Q_MAX) return 'Q 需在 ' + Q_MIN + '–' + Q_MAX + ' 之间（过小近乎搁架，过大易振铃）';
        band.q = v; return null;
      }, Q_MIN, Q_MAX, 0.1, true, function (v) { return v.toFixed(2); }, false));

    // 删除
    var del = document.createElement('button');
    del.className = 'del'; del.textContent = '删除';
    del.onclick = function () {
      preset.bands.splice(bi, 1);
      if (selectedBand >= preset.bands.length) selectedBand = -1;
      onPresetChanged(true);
    };
    row.appendChild(del);

    row.appendChild(err);

    // 点击行选中该段（不触发控件时）
    row.onclick = function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'BUTTON') return;
      selectBand(bi);
    };

    list.appendChild(row);
  });
}

function selectBand(bi) {
  selectedBand = bi;
  var band = state.presets[state.active].bands[bi];
  if (band) {
    var r = bandEffectiveRange(band);
    selRange = { lo: r[0], hi: r[1] };
  }
  renderBandList();
}

// ---------------- 状态变更与持久化 ----------------
function onPresetChanged(structural) {
  rebuildChain(state.active);
  if (structural) renderBandList();
  scheduleTrimUpdate();
  saveState();
}

var saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        presets: state.presets,
        active: state.active,
        matchLoudness: state.matchLoudness
      }));
    } catch (e) {}
  }, 300);
}

function loadState() {
  try {
    var s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && s.presets && s.presets.A && s.presets.B) {
      state.presets = s.presets;
      state.active = s.active === 'B' ? 'B' : 'A';
      state.matchLoudness = s.matchLoudness !== false;
    }
  } catch (e) {}
}

// ---------------- A/B 切换 ----------------
function setActive(which) {
  state.active = which;
  selectedBand = -1;
  $('btnA').classList.toggle('active', which === 'A');
  $('btnB').classList.toggle('active', which === 'B');
  applyGains(true);   // 交叉淡入淡出，声源不中断 → 播放位置保留
  renderBandList();
  saveState();
}

// ---------------- 导出 ----------------
function bufferToWav(buf) {
  var nCh = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  var bytes = 44 + len * nCh * 2;
  var ab = new ArrayBuffer(bytes), dv = new DataView(ab);
  function wstr(off, s) { for (var i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); }
  wstr(0, 'RIFF'); dv.setUint32(4, bytes - 8, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nCh, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * nCh * 2, true);
  dv.setUint16(32, nCh * 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, len * nCh * 2, true);
  var off = 44;
  var chans = [];
  for (var c = 0; c < nCh; c++) chans.push(buf.getChannelData(c));
  for (var i = 0; i < len; i++)
    for (var ch = 0; ch < nCh; ch++) {
      var v = Math.max(-1, Math.min(1, chans[ch][i]));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      off += 2;
    }
  return new Blob([ab], { type: 'audio/wav' });
}

function download(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
}

// ---------------- 画布交互 ----------------
var dragMode = null, dragStartX = 0, dragBandIdx = -1;

canvas.addEventListener('mousedown', function (e) {
  var rect = canvas.getBoundingClientRect();
  var x = e.clientX - rect.left, y = e.clientY - rect.top;
  var W = canvas.clientWidth, H = canvas.clientHeight;
  var preset = state.presets[state.active];
  dragBandIdx = -1;
  preset.bands.forEach(function (band, bi) {
    var hx = freqToX(band.freq, W), hy = dbToY(bandDbAt(band, band.freq), H);
    if (Math.hypot(x - hx, y - hy) < 12) dragBandIdx = bi;
  });
  if (dragBandIdx >= 0) {
    dragMode = 'band';
    selectBand(dragBandIdx);
  } else {
    dragMode = 'range';
    dragStartX = x;
    var f = xToFreq(Math.max(0, Math.min(W, x)), W);
    selRange = { lo: f, hi: f };
  }
});

canvas.addEventListener('mousemove', function (e) {
  if (!dragMode) return;
  var rect = canvas.getBoundingClientRect();
  var x = Math.max(0, Math.min(canvas.clientWidth, e.clientX - rect.left));
  var y = Math.max(0, Math.min(canvas.clientHeight, e.clientY - rect.top));
  var W = canvas.clientWidth, H = canvas.clientHeight;
  if (dragMode === 'range') {
    var f0 = xToFreq(dragStartX, W), f1 = xToFreq(x, W);
    selRange = { lo: Math.min(f0, f1), hi: Math.max(f0, f1) };
  } else if (dragMode === 'band') {
    var band = state.presets[state.active].bands[dragBandIdx];
    if (!band) return;
    var f = Math.max(F_MIN, Math.min(Math.min(F_MAX, ctx.sampleRate / 2 * 0.95), xToFreq(x, W)));
    band.freq = Math.round(f);
    if (BAND_TYPES[band.type].hasGain) {
      var db = Math.max(GAIN_MIN, Math.min(GAIN_MAX, yToDb(y, H)));
      band.gain = Math.round(db * 10) / 10;
    }
    var r = bandEffectiveRange(band);
    selRange = { lo: r[0], hi: r[1] };
    onPresetChanged(true);
  }
});

window.addEventListener('mouseup', function () {
  if (dragMode === 'range' && selRange && selRange.hi / selRange.lo < 1.05) {
    // 几乎没拖动：以该频率为中心给 ±1 个半音的窄带
    var c = Math.sqrt(selRange.lo * selRange.hi);
    selRange = { lo: c / 1.06, hi: c * 1.06 };
  }
  dragMode = null;
});

// ---------------- 主循环 ----------------
var lastEnergyUpdate = 0;
function tick() {
  drawCurve();
  var now = performance.now();
  if (now - lastEnergyUpdate > 200) {   // 能量面板降频刷新，避免每帧重建 DOM
    lastEnergyUpdate = now;
    updateEnergyPanel();
  }
  if (buffer) {
    var pos = getPosition();
    $('timeLabel').textContent = fmtTime(pos) + ' / ' + fmtTime(buffer.duration);
    if (!seekDragging) $('seekBar').value = Math.round(pos / buffer.duration * 1000);
  }
  requestAnimationFrame(tick);
}

function fmtTime(s) {
  var m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
}

// ---------------- 事件绑定 ----------------
function $(id) { return document.getElementById(id); }
var seekDragging = false;

function bindEvents() {
  $('fileInput').onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    file.arrayBuffer().then(function (ab) {
      return ctx.decodeAudioData(ab);
    }).then(function (buf) {
      setBuffer(buf, file.name);
    }).catch(function () {
      alert('无法解码该音频文件，请换用常见的 WAV / MP3 / AAC 等格式。');
    });
  };

  $('demoSweep').onclick = function () { setBuffer(genSweep(), '样音：扫频 20Hz–20kHz'); };
  $('demoDrums').onclick = function () { setBuffer(genDrums(), '样音：鼓点循环'); };
  $('demoStereo').onclick = function () { setBuffer(genStereo(), '样音：双声道（左右不同内容）'); };

  $('playBtn').onclick = function () {
    if (!buffer) return;
    ctx.resume();
    if (playing) {
      startOffset = getPosition();
      stopSource();
      $('playBtn').textContent = '▶ 播放';
    } else {
      startSource(startOffset);
      $('playBtn').textContent = '⏸ 暂停';
    }
  };

  $('seekBar').addEventListener('pointerdown', function () { seekDragging = true; });
  $('seekBar').addEventListener('pointerup', function () { seekDragging = false; });
  $('seekBar').oninput = function () {
    if (!buffer) return;
    var pos = $('seekBar').value / 1000 * buffer.duration;
    if (playing) startSource(pos); else startOffset = pos;
  };

  $('btnA').onclick = function () { setActive('A'); };
  $('btnB').onclick = function () { setActive('B'); };

  $('matchLoudness').onchange = function () {
    state.matchLoudness = $('matchLoudness').checked;
    updateTrims();
    saveState();
  };

  $('bypassAll').onchange = function () {
    state.bypassAll = $('bypassAll').checked;
    applyGains(true);
  };

  $('showSpectrum').onchange = function () {
    state.showSpectrum = $('showSpectrum').checked;
  };

  $('addBand').onclick = function () {
    state.presets[state.active].bands.push({ type: 'peaking', freq: 1000, gain: 0, q: 1, bypass: false });
    onPresetChanged(true);
  };

  $('exportWav').onclick = function () {
    if (!buffer) return;
    var which = state.active;
    $('exportWav').disabled = true;
    renderPresetOffline(which).then(function (rendered) {
      download(bufferToWav(rendered), 'eq-' + which + '-' + (bufferName || 'export').replace(/[^\w一-龥-]+/g, '_') + '.wav');
      $('exportWav').disabled = false;
    });
  };

  $('saveSettings').onclick = function () {
    var data = JSON.stringify({ version: 1, presets: state.presets, active: state.active, matchLoudness: state.matchLoudness }, null, 2);
    download(new Blob([data], { type: 'application/json' }), 'eq-settings.json');
  };

  $('loadSettings').onchange = function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var s = JSON.parse(reader.result);
        var errors = [];
        ['A', 'B'].forEach(function (w) {
          if (!s.presets || !Array.isArray(s.presets[w] && s.presets[w].bands)) throw new Error('缺少设置 ' + w);
          s.presets[w].bands.forEach(function (b, i) {
            if (!BAND_TYPES[b.type]) { errors.push(w + ' 段' + (i + 1) + '：未知类型 ' + b.type); return; }
            var msg = validateBand(b);
            if (msg) errors.push(w + ' 段' + (i + 1) + '：' + msg);
          });
        });
        if (errors.length) { alert('设置文件存在问题：\n' + errors.join('\n')); return; }
        state.presets = s.presets;
        state.active = s.active === 'B' ? 'B' : 'A';
        state.matchLoudness = s.matchLoudness !== false;
        $('matchLoudness').checked = state.matchLoudness;
        rebuildChain('A'); rebuildChain('B');
        setActive(state.active);
        scheduleTrimUpdate();
        saveState();
      } catch (err) {
        alert('无法载入设置文件：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && !/INPUT|SELECT|BUTTON|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $('playBtn').click();
    }
  });
}

// ---------------- 启动 ----------------
loadState();
buildGraph();
$('matchLoudness').checked = state.matchLoudness;
$('btnA').classList.toggle('active', state.active === 'A');
$('btnB').classList.toggle('active', state.active === 'B');
bindEvents();
renderBandList();
tick();

})();
