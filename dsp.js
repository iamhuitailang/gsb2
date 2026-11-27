// dsp.js — 纯函数核心:WAV 编解码、量化/扰动、统计、信号生成。
// 不依赖 DOM,可同时被浏览器(app.js)与 Node 测试引用。

/* ---------------- 确定性随机数 ---------------- */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- 量化 ---------------- */

// 把 [-1,1] 浮点样本量化到 bits 位有符号整数码,再还原为浮点。
// opt: { mode: 'off'|'rpdf'|'tpdf', amp: 扰动幅度(LSB), rng: () => [0,1) }
// 返回 { codes: Int32Array, recon: Float32Array, stats: {...} }
export function quantizeChannel(x, bits, opt = {}) {
  const n = x.length;
  const half = 2 ** (bits - 1);
  const maxPos = half - 1;
  const minNeg = -half;
  const mode = opt.mode || 'off';
  const amp = opt.amp != null ? opt.amp : 1;
  const rng = opt.rng || Math.random;

  const codes = new Int32Array(n);
  const recon = new Float32Array(n);

  let changed = 0;
  let clipHi = 0;     // 量化前(含扰动)越过正满幅,被夹断的采样
  let clipLo = 0;     // 量化前越过负满幅,被夹断的采样
  let railPos = 0;    // 最终码落在正满幅码(含本来就等于边界)
  let railNeg = 0;    // 最终码落在负满幅码
  let sumErr = 0;
  let sumSqErr = 0;
  let sumSqSig = 0;
  let maxAbsErr = 0;

  for (let i = 0; i < n; i++) {
    let d = 0;
    if (mode === 'rpdf') {
      d = (rng() * 2 - 1) * amp;
    } else if (mode === 'tpdf') {
      d = (rng() + rng() - 1) * amp;
    }
    const raw = x[i] * half + d;
    let c = Math.round(raw);
    if (c > maxPos) {
      c = maxPos;
      if (raw > maxPos) clipHi++;
    } else if (c < minNeg) {
      c = minNeg;
      if (raw < minNeg) clipLo++;
    }
    if (c === maxPos) railPos++;
    if (c === minNeg) railNeg++;

    codes[i] = c;
    const y = c === 0 ? 0 : c / half; // 归一化 -0,保证与 dequantize 深度相等
    recon[i] = y;

    const e = y - x[i];
    if (c !== Math.round(x[i] * half)) changed++;
    const ae = Math.abs(e);
    if (ae > maxAbsErr) maxAbsErr = ae;
    sumErr += e;
    sumSqErr += e * e;
    sumSqSig += x[i] * x[i];
  }

  return {
    codes,
    recon,
    stats: {
      bits,
      mode,
      amp,
      n,
      half,
      changed,
      changedPct: n ? changed / n : 0,
      clipHi,
      clipLo,
      railPos,
      railNeg,
      meanErr: n ? sumErr / n : 0,           // 偏置(浮点)
      meanErrLsb: n ? (sumErr / n) * half : 0,
      rmsErr: n ? Math.sqrt(sumSqErr / n) : 0,
      rmsErrLsb: n ? Math.sqrt(sumSqErr / n) * half : 0,
      maxAbsErr,
      maxAbsErrLsb: maxAbsErr * half,
      snrDb: sumSqErr > 0 ? 10 * Math.log10(sumSqSig / sumSqErr) : Infinity,
      hash: hashCodes(codes),
    },
  };
}

export function dequantize(codes, bits) {
  const half = 2 ** (bits - 1);
  const out = new Float32Array(codes.length);
  for (let i = 0; i < codes.length; i++) out[i] = codes[i] === 0 ? 0 : codes[i] / half;
  return out;
}

// FNV-1a(32),对整数码序列取校验和,便于两次试验逐位比对。
export function hashCodes(codes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < codes.length; i++) {
    const v = codes[i] | 0;
    for (let k = 0; k < 4; k++) {
      h ^= (v >>> (8 * k)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}

// 对整段多声道信号做量化;每声道用 seed+ch 派生独立但确定的随机流。
export function quantizeSignal(channels, bits, setting) {
  return channels.map((ch, ci) =>
    quantizeChannel(ch, bits, {
      mode: setting.mode,
      amp: setting.amp,
      rng: mulberry32((setting.seed >>> 0) + ci * 0x9e3779b9),
    })
  );
}

/* ---------------- 分块统计(标出失真段落) ---------------- */

export function blockStats(orig, recon, sr, blockMs = 50) {
  const n = orig.length;
  const size = Math.max(1, Math.round((blockMs / 1000) * sr));
  const out = [];
  const half = 1; // LSB 换算由调用方结合位数完成,这里同时返回浮点误差
  for (let s = 0; s < n; s += size) {
    const e0 = s;
    const e1 = Math.min(n, s + size);
    let changed = 0;
    let maxAbs = 0;
    let sq = 0;
    let peakOrig = 0;
    for (let i = e0; i < e1; i++) {
      const e = recon[i] - orig[i];
      if (e !== 0) changed++;
      const ae = Math.abs(e);
      if (ae > maxAbs) maxAbs = ae;
      sq += e * e;
      const ax = Math.abs(orig[i]);
      if (ax > peakOrig) peakOrig = ax;
    }
    const len = e1 - e0;
    out.push({
      startSample: e0,
      endSample: e1,
      t0: e0 / sr,
      t1: e1 / sr,
      changed,
      changedPct: changed / len,
      maxAbsErr: maxAbs,
      rmsErr: Math.sqrt(sq / len),
      peakOrig,
    });
  }
  return out;
}

/* ---------------- WAV 解码 ---------------- */

function readChunk(view, offset) {
  const id = String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1),
    view.getUint8(offset + 2), view.getUint8(offset + 3)
  );
  return { id, size: view.getUint32(offset + 4, true), dataStart: offset + 8 };
}

// 解析 PCM(8/16/24/32 位整型,及 32 位浮点)WAV,返回归一化到 [-1,1] 的 Float32 声道。
export function decodeWav(buffer) {
  const view = new DataView(buffer);
  if (String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== 'RIFF' ||
      String.fromCharCode(...new Uint8Array(buffer, 8, 4)) !== 'WAVE') {
    throw new Error('不是 RIFF/WAVE 文件');
  }
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;
  let p = 12;
  while (p + 8 <= buffer.byteLength) {
    const chunk = readChunk(view, p);
    if (chunk.id === 'fmt ') {
      fmt = {
        formatTag: view.getUint16(chunk.dataStart, true),
        channels: view.getUint16(chunk.dataStart + 2, true),
        sampleRate: view.getUint32(chunk.dataStart + 4, true),
        bitsPerSample: view.getUint16(chunk.dataStart + 14, true),
      };
    } else if (chunk.id === 'data') {
      dataOffset = chunk.dataStart;
      dataSize = chunk.size;
    }
    p = chunk.dataStart + chunk.size + (chunk.size & 1); // 字对齐填充
  }
  if (!fmt) throw new Error('缺少 fmt 块');
  if (dataOffset < 0) throw new Error('缺少 data 块');

  const tag = fmt.formatTag;
  const isPcm = tag === 1 || tag === 0xfffe; // 含 WAVE_FORMAT_EXTENSIBLE(子类型按 PCM 处理)
  const isFloat = tag === 3;
  if (!isPcm && !isFloat) throw new Error(`暂不支持的格式标签 ${tag}`);
  const bps = fmt.bitsPerSample;
  if (!isFloat && ![8, 16, 24, 32].includes(bps)) {
    throw new Error(`暂不支持的位深 ${bps}`);
  }
  if (isFloat && bps !== 32) throw new Error('浮点 WAV 仅支持 32 位');

  const ch = fmt.channels;
  const sr = fmt.sampleRate;
  const bytesPerSample = bps / 8;
  const frames = Math.floor(dataSize / (bytesPerSample * ch));
  const channels = Array.from({ length: ch }, () => new Float32Array(frames));

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const o = dataOffset + (f * ch + c) * bytesPerSample;
      let v;
      if (bps === 8) {
        v = (view.getUint8(o) - 128) / 128;           // 8 位 WAV 为无符号偏移码
      } else if (bps === 16) {
        v = view.getInt16(o, true) / 32768;
      } else if (bps === 24) {
        const u = view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
        const s = u & 0x800000 ? u - 0x1000000 : u;
        v = s / 8388608;
      } else if (isFloat) {
        v = view.getFloat32(o, true);
      } else {
        v = view.getInt32(o, true) / 2147483648;
      }
      channels[c][f] = v;
    }
  }
  return {
    channels,
    sampleRate: sr,
    numChannels: ch,
    bitsPerSample: bps,
    isFloat,
    numFrames: frames,
    duration: frames / sr,
  };
}

/* ---------------- WAV 编码(标准 8/16 位 PCM) ---------------- */

export function encodeWav(channels, sampleRate, bitDepth) {
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new Error('仅支持导出 8 或 16 位 WAV');
  }
  const ch = channels.length;
  const frames = channels[0].length;
  const bps = bitDepth / 8;
  const dataSize = frames * ch * bps;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);                    // PCM
  view.setUint16(22, ch, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * ch * bps, true);
  view.setUint16(32, ch * bps, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let o = 44;
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < ch; c++) {
      const x = channels[c][f];
      if (bitDepth === 8) {
        const u = Math.max(0, Math.min(255, Math.round(x * 128 + 128)));
        view.setUint8(o++, u);
      } else {
        const s = Math.max(-32768, Math.min(32767, Math.round(x * 32768)));
        view.setInt16(o, s, true);
        o += 2;
      }
    }
  }
  return buf;
}

/* ---------------- 测试信号生成 ---------------- */

const DEMO_SR = 44100;

function tone(sr, freq, t) {
  return Math.sin(2 * Math.PI * freq * t);
}

// 渐弱音:440Hz,指数包络 -6 dBFS 衰减到约 -75 dBFS
function genFade(sr = DEMO_SR, dur = 3) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const startAmp = 10 ** (-6 / 20);
  const endAmp = 10 ** (-75 / 20);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const k = i / (n - 1);
    const env = startAmp * (endAmp / startAmp) ** k;
    const fadeIn = Math.min(1, t / 0.005);
    out[i] = tone(sr, 440, t) * env * fadeIn;
  }
  return out;
}

// 接近静音的持续音:300Hz,-55 dBFS 恒定
function genQuiet(sr = DEMO_SR, dur = 3) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const amp = 10 ** (-55 / 20);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fadeIn = Math.min(1, t / 0.01);
    out[i] = tone(sr, 300, t) * amp * fadeIn;
  }
  return out;
}

// 接近满幅:220Hz,-0.5 dBFS
function genFullScale(sr = DEMO_SR, dur = 2) {
  const n = Math.round(sr * dur);
  const out = new Float32Array(n);
  const amp = 10 ** (-0.5 / 20);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const fadeIn = Math.min(1, t / 0.01);
    const fadeOut = Math.min(1, (dur - t) / 0.01);
    out[i] = tone(sr, 220, t) * amp * Math.min(fadeIn, fadeOut);
  }
  return out;
}

// 组合样例:满幅 → 渐弱 → 近静音持续 → 数字静音,段边界用于失真定位
function genCombo(sr = DEMO_SR) {
  const bounds = [0, 1.0, 2.5, 3.5, 4.0];
  const n = Math.round(sr * bounds[bounds.length - 1]);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if (t < 1.0) {
      const g = Math.min(1, t / 0.01);
      v = tone(sr, 220, t) * (10 ** (-0.5 / 20)) * g;
    } else if (t < 2.5) {
      const k = (t - 1.0) / 1.5;
      const env = 0.5 * (0.0003 / 0.5) ** k; // -6 dBFS → -70 dBFS
      v = tone(sr, 440, t) * env;
    } else if (t < 3.5) {
      const g = Math.min(1, (t - 2.5) / 0.01);
      v = tone(sr, 300, t) * (10 ** (-50 / 20)) * g; // -50 dBFS 持续
    } else {
      v = 0; // 数字静音
    }
    out[i] = v;
  }
  return out;
}

const SEG_NAMES = ['近满幅 220Hz', '渐弱 440Hz', '近静音 300Hz', '数字静音'];

export function generateSignal(kind, sr = DEMO_SR) {
  let data;
  let segments = [];
  let name;
  if (kind === 'fade') {
    data = genFade(sr);
    name = '渐弱音(440Hz,-6→-75 dBFS)';
  } else if (kind === 'quiet') {
    data = genQuiet(sr);
    name = '近静音持续音(300Hz,-55 dBFS)';
  } else if (kind === 'fullscale') {
    data = genFullScale(sr);
    name = '近满幅音(220Hz,-0.5 dBFS)';
  } else if (kind === 'combo') {
    data = genCombo(sr);
    const bounds = [0, 1.0, 2.5, 3.5, 4.0];
    segments = bounds.slice(0, -1).map((b, i) => ({
      name: SEG_NAMES[i],
      start: b,
      end: bounds[i + 1],
    }));
    name = '组合样例(满幅/渐弱/近静音/静音)';
  } else {
    throw new Error(`未知样例 ${kind}`);
  }
  return {
    name,
    sampleRate: sr,
    channels: [data],
    segments,
    generated: kind,
  };
}

/* ---------------- 幅度直方图 ---------------- */

export function histogram(sig, bins = 120, range = 1) {
  const counts = new Uint32Array(bins);
  for (let i = 0; i < sig.length; i++) {
    let b = Math.floor(((sig[i] + range) / (2 * range)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  return counts;
}
