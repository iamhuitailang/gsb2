// 纯函数 DSP：FFT、卷积（全量 FFT 与 overlap-save 两条路径）、基础工具。
// 不依赖 DOM，可直接在 Node 中自测。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});

  function nextPow2(n) {
    if (n <= 1) return 1;
    return 1 << (32 - Math.clz32(n - 1));
  }

  // 迭代基-2 FFT，in-place；inverse=true 做逆变换（含 1/N）
  function fft(re, im, inverse) {
    const n = re.length;
    if (n <= 1) return;
    // 位逆序置换
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const ur = re[i + k], ui = im[i + k];
          const idx2 = i + k + half;
          const vr = re[idx2] * cr - im[idx2] * ci;
          const vi = re[idx2] * ci + im[idx2] * cr;
          re[i + k] = ur + vr;
          im[i + k] = ui + vi;
          re[idx2] = ur - vr;
          im[idx2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }

  // 单次 FFT 卷积，返回完整长度 x.len + h.len - 1
  function convolveFull(x, h) {
    const L = x.length + h.length - 1;
    const n = nextPow2(L);
    const xr = new Float64Array(n), xi = new Float64Array(n);
    const hr = new Float64Array(n), hi = new Float64Array(n);
    xr.set(x);
    hr.set(h);
    fft(xr, xi, false);
    fft(hr, hi, false);
    for (let i = 0; i < n; i++) {
      const rr = xr[i] * hr[i] - xi[i] * hi[i];
      xi[i] = xr[i] * hi[i] + xi[i] * hr[i];
      xr[i] = rr;
    }
    fft(xr, xi, true);
    const out = new Float32Array(L);
    for (let i = 0; i < L; i++) out[i] = xr[i];
    return out;
  }

  // overlap-save 流式卷积，长信号用；与 convolveFull 数学等价
  function convolveOverlapSave(x, h) {
    const M = h.length;
    let N = nextPow2(Math.max(2 * M, Math.min(4 * M, 65536)));
    if (N < 2 * M) N = nextPow2(2 * M);
    const step = N - M + 1;

    const hr = new Float64Array(N), hi = new Float64Array(N);
    hr.set(h);
    fft(hr, hi, false);

    const out = new Float32Array(x.length + M - 1);
    const bre = new Float64Array(N), bim = new Float64Array(N);

    for (let start = -(M - 1), j = 0; start < x.length; start += step, j++) {
      bre.fill(0); bim.fill(0);
      for (let n = 0; n < N; n++) {
        const idx = start + n;
        if (idx >= 0 && idx < x.length) bre[n] = x[idx];
      }
      fft(bre, bim, false);
      for (let i = 0; i < N; i++) {
        const rr = bre[i] * hr[i] - bim[i] * hi[i];
        bim[i] = bre[i] * hi[i] + bim[i] * hr[i];
        bre[i] = rr;
      }
      fft(bre, bim, true);
      const outStart = j * step;
      for (let n = M - 1; n < N; n++) {
        const o = outStart + n - (M - 1);
        if (o < out.length) out[o] = bre[n];
      }
    }
    return out;
  }

  // 通用入口：短信号走单次 FFT，长信号走 overlap-save
  function convolve(x, h) {
    if (!x.length || !h.length) {
      return new Float32Array(Math.max(0, x.length + h.length - 1));
    }
    if (h.length === 1) {
      const out = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) out[i] = x[i] * h[0];
      return out;
    }
    const L = x.length + h.length - 1;
    return L <= 65536 ? convolveFull(x, h) : convolveOverlapSave(x, h);
  }

  // 确定性伪随机数（让内置素材可复现）
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function peakOf(ch) {
    let p = 0;
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]);
      if (a > p) p = a;
    }
    return p;
  }

  function ampToDb(a) {
    return 20 * Math.log10(Math.max(a, 1e-10));
  }

  // 一阶低通（用于 IR 尾声的高频阻尼）
  function onePoleLowPass(buf, cutoffHz, sampleRate) {
    const dt = 1 / sampleRate;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const a = dt / (rc + dt);
    let y = 0;
    for (let i = 0; i < buf.length; i++) {
      y += a * (buf[i] - y);
      buf[i] = y;
    }
    return buf;
  }

  // 线性重采样（浏览器主路径使用 OfflineAudioContext，此函数用于回退与自测）
  function resampleLinear(channels, srcRate, dstRate) {
    if (srcRate === dstRate) return channels.map((c) => c.slice());
    const ratio = srcRate / dstRate;
    return channels.map((src) => {
      const outLen = Math.floor(src.length * dstRate / srcRate);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = src[i0] || 0;
        const b = src[i0 + 1] !== undefined ? src[i0 + 1] : a;
        out[i] = a + (b - a) * frac;
      }
      return out;
    });
  }

  RL.dsp = {
    nextPow2, fft, convolve, convolveFull, convolveOverlapSave,
    makeRng, gaussian, peakOf, ampToDb, onePoleLowPass, resampleLinear,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
