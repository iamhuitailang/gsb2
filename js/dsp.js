/*
 * dsp.js — 纯函数 DSP 内核（不依赖任何 Web API，Node 与浏览器共用同一实现，
 * 保证“试听听到的”和“导出写进文件的”是同一条处理链）。
 * UMD：浏览器挂到 window.DSP，Node 下 module.exports。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------- 基础统计 ----------------

  function rms(buf, start, end) {
    start = start || 0;
    end = end == null ? buf.length : end;
    let sum = 0;
    for (let i = start; i < end; i++) sum += buf[i] * buf[i];
    const n = end - start;
    return n > 0 ? Math.sqrt(sum / n) : 0;
  }

  function peak(buf, start, end) {
    start = start || 0;
    end = end == null ? buf.length : end;
    let p = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(buf[i]);
      if (a > p) p = a;
    }
    return p;
  }

  function toDb(x) {
    return x > 0 ? 20 * Math.log10(x) : -Infinity;
  }

  /** 皮尔逊相关系数；能量过低时返回 null，避免噪声数字 */
  function correlation(a, b, start, end) {
    start = start || 0;
    end = end == null ? a.length : end;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    const n = end - start;
    for (let i = start; i < end; i++) {
      const x = a[i], y = b[i];
      sa += x; sb += y;
      saa += x * x; sbb += y * y; sab += x * y;
    }
    const va = saa - (sa * sa) / n;
    const vb = sbb - (sb * sb) / n;
    if (va <= 1e-12 || vb <= 1e-12) return null;
    const r = (sab - (sa * sb) / n) / Math.sqrt(va * vb);
    return Math.max(-1, Math.min(1, r));
  }

  /** 折叠为单声道：m = (l + r) / 2 */
  function foldMono(left, right) {
    const n = Math.min(left.length, right.length);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) m[i] = (left[i] + right[i]) * 0.5;
    return m;
  }

  // ---------------- 处理链 ----------------

  function defaultSettings() {
    return {
      flipL: false,       // 左声道极性反转
      flipR: false,       // 右声道极性反转
      delayLMs: 0,        // 左声道延时（毫秒）
      delayRMs: 0,        // 右声道延时（毫秒）
      widthPct: 100,      // 立体声宽度百分比，100 = 原始
    };
  }

  function delaySamples(delayMs, sampleRate) {
    return Math.max(0, Math.round(delayMs * sampleRate / 1000));
  }

  /**
   * 应用完整处理链，返回新的 { left, right }（不修改输入）。
   * 顺序：极性 → 各自延时 → M/S 宽度 → 输出长度对齐（延时会在尾部补零）。
   */
  function applyChain(left, right, sampleRate, s) {
    const n = left.length;
    const outL = new Float32Array(n);
    const outR = new Float32Array(n);
    const signL = s.flipL ? -1 : 1;
    const signR = s.flipR ? -1 : 1;
    const dL = delaySamples(s.delayLMs, sampleRate);
    const dR = delaySamples(s.delayRMs, sampleRate);

    for (let i = 0; i < n; i++) {
      if (i >= dL) outL[i] = left[i - dL] * signL;
      if (i >= dR) outR[i] = right[i - dR] * signR;
    }

    if (s.widthPct !== 100) {
      const w = s.widthPct / 100;
      for (let i = 0; i < n; i++) {
        const mid = (outL[i] + outR[i]) * 0.5;
        const side = (outL[i] - outR[i]) * 0.5;
        outL[i] = mid + side * w;
        outR[i] = mid - side * w;
      }
    }
    return { left: outL, right: outR };
  }

  // ---------------- 零相位 FFT 三频带分频 ----------------
  // 为什么不用 IIR biquad：Q=0.707 双二阶级联（LR2）的低通/高通支路在不同
  // 频率上相位关系不一致，三带直接相加无法全域重建（交叉点会翻倍或抵消）。
  // 这里改用一次 FFT + 共轭对称的余弦过渡掩膜：
  //   - 掩膜关于 bin 0 对称，逆变换得到实信号、零相位；
  //   - 低/中/高三张掩膜在每个 bin 上严格求和为 1，三带逐样本相加精确还原；
  //   - 过渡带余弦平滑，避免硬矩形掩膜的频谱泄漏。

  function nextPow2(n) {
    return Math.pow(2, Math.ceil(Math.log(n) / Math.LN2));
  }

  /** 基-2 迭代 FFT（原地），inverse=true 时带 1/N 归一化 */
  function fft(re, im, inverse) {
    var N = re.length;
    for (var i = 1, j = 0; i < N; i++) {
      var bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= N; len <<= 1) {
      var ang = (inverse ? -2 : 2) * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var base = 0; base < N; base += len) {
        var cr = 1, ci = 0;
        for (var k = 0; k < len / 2; k++) {
          var a = base + k, b = base + k + len / 2;
          var ur = re[a], ui = im[a];
          var vr = re[b] * cr - im[b] * ci;
          var vi = re[b] * ci + im[b] * cr;
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    if (inverse) {
      for (var q = 0; q < N; q++) { re[q] /= N; im[q] /= N; }
    }
  }

  // 掩膜按 (FFT 长度, 采样率) 缓存，同一文件的 L/R/M 与多次选区分析可复用
  var maskCache = {};

  function buildMasks(N, sampleRate, lowCut, highCut) {
    var key = N + ':' + sampleRate + ':' + lowCut + ':' + highCut;
    if (maskCache[key]) return maskCache[key];

    var binHz = sampleRate / N;
    var edgeL = lowCut / binHz;
    var edgeH = highCut / binHz;
    // 过渡带宽度 80 Hz（分频点两侧各 40 Hz），至少覆盖一个 bin
    var T = Math.max(1, 80 / binHz);

    // 低带权重：频率越低越接近 1，在 edgeL 附近余弦降到 0
    function lowWeight(f) {
      if (f <= edgeL - T) return 1;
      if (f >= edgeL + T) return 0;
      return 0.5 * (1 + Math.cos(Math.PI * (f - (edgeL - T)) / (2 * T)));
    }
    // 高带权重：频率越高越接近 1
    function highWeight(f) {
      if (f >= edgeH + T) return 1;
      if (f <= edgeH - T) return 0;
      return 0.5 * (1 - Math.cos(Math.PI * (f - (edgeH - T)) / (2 * T)));
    }

    var mLow = new Float64Array(N);
    var mMid = new Float64Array(N);
    var mHigh = new Float64Array(N);
    for (var k = 0; k < N; k++) {
      // 折叠到正频率轴，保证掩膜共轭对称、逆变换为实数
      var f = k <= N / 2 ? k : N - k;
      var lo = lowWeight(f);
      var hi = highWeight(f);
      var mi = 1 - lo - hi;
      if (mi < 0) mi = 0;
      mLow[k] = lo;
      mMid[k] = mi;
      mHigh[k] = hi;
    }
    var masks = { low: mLow, mid: mMid, high: mHigh, N: N };
    maskCache[key] = masks;
    return masks;
  }

  function applyMask(input, mask, N) {
    var re = new Float64Array(N);
    var im = new Float64Array(N);
    for (var i = 0; i < input.length; i++) re[i] = input[i];
    fft(re, im, false);
    for (var k = 0; k < N; k++) {
      re[k] *= mask[k];
      im[k] *= mask[k];
    }
    fft(re, im, true);
    var out = new Float32Array(input.length);
    for (var j = 0; j < input.length; j++) out[j] = re[j];
    return out;
  }

  /**
   * 三频带拆分（低/中/高），默认分频点 250 Hz、4000 Hz。
   * 零相位 FFT 实现，三带逐样本相加精确还原输入（误差仅浮点量级）。
   */
  function splitBands(input, sampleRate, lowCut, highCut) {
    lowCut = lowCut || 250;
    highCut = highCut || 4000;
    var N = nextPow2(input.length);
    var masks = buildMasks(N, sampleRate, lowCut, highCut);
    return {
      low: applyMask(input, masks.low, N),
      mid: applyMask(input, masks.mid, N),
      high: applyMask(input, masks.high, N),
    };
  }

  /**
   * 选区三频带统计。
   * 返回 { low/mid/high: { rmsL, rmsR, rmsM, foldDb, corr, peakM } }
   * 能量过低的频带 foldDb/corr 为 null。
   */
  function bandStats(left, right, sampleRate, start, end) {
    const m = foldMono(left, right);
    const stereoRefRms = (rms(left, start, end) + rms(right, start, end)) * 0.5;
    const bandsL = splitBands(left, sampleRate);
    const bandsR = splitBands(right, sampleRate);
    const bandsM = splitBands(m, sampleRate);
    const result = {};

    ['low', 'mid', 'high'].forEach(function (name) {
      const bl = bandsL[name], br = bandsR[name], bm = bandsM[name];
      const rmsL = rms(bl, start, end);
      const rmsR = rms(br, start, end);
      const rmsM = rms(bm, start, end);
      const ref = (rmsL + rmsR) * 0.5;
      result[name] = {
        rmsL: rmsL,
        rmsR: rmsR,
        rmsM: rmsM,
        foldDb: ref > 1e-7 ? toDb(rmsM) - toDb(ref) : null,
        corr: correlation(bl, br, start, end),
        peakM: peak(bm, start, end),
      };
    });
    result.stereoRefRms = stereoRefRms;
    return result;
  }

  // ---------------- 等响补偿 ----------------

  /**
   * 计算试听等响补偿增益：让当前模式输出的 RMS 对齐立体声参考 RMS，
   * 避免“单声道听着小”被音量差误导。补偿量限制在 ±12 dB 内。
   * mode: stereo | left | right | mono
   */
  function compensationGain(left, right, mode) {
    const rL = rms(left);
    const rR = rms(right);
    const ref = (rL + rR) * 0.5;
    let target;
    if (mode === 'left') target = rL;
    else if (mode === 'right') target = rR;
    else if (mode === 'mono') target = rms(foldMono(left, right));
    else target = ref;

    if (target < 1e-7 || ref < 1e-7) return 1;
    return Math.max(1 / Math.pow(10, 12 / 20),
      Math.min(Math.pow(10, 12 / 20), ref / target));
  }

  // ---------------- 总览降采样曲线 ----------------

  /**
   * 把整条信号降采样成 buckets 个桶，供总览图绘制。
   * 每桶记录 L/R 峰值包络、RMS、相关度、折叠损失 dB。
   */
  function buildOverview(left, right, buckets) {
    const n = left.length;
    buckets = Math.min(buckets || 900, n);
    const m = foldMono(left, right);
    const out = new Array(buckets);
    const per = n / buckets;

    for (let b = 0; b < buckets; b++) {
      const s = Math.floor(b * per);
      const e = Math.max(s + 1, Math.floor((b + 1) * per));
      const rL = rms(left, s, e);
      const rR = rms(right, s, e);
      const rM = rms(m, s, e);
      const ref = (rL + rR) * 0.5;
      out[b] = {
        peakL: peak(left, s, e),
        peakR: peak(right, s, e),
        rmsL: rL,
        rmsR: rR,
        rmsM: rM,
        corr: correlation(left, right, s, e),
        foldDb: ref > 1e-7 ? toDb(rM) - toDb(ref) : null,
      };
    }
    return out;
  }

  return {
    rms: rms,
    peak: peak,
    toDb: toDb,
    correlation: correlation,
    foldMono: foldMono,
    defaultSettings: defaultSettings,
    delaySamples: delaySamples,
    applyChain: applyChain,
    splitBands: splitBands,
    bandStats: bandStats,
    compensationGain: compensationGain,
    buildOverview: buildOverview,
  };
});
