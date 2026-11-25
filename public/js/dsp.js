// 纯本地信号处理：迭代 radix-2 FFT、归一化互相关 (NCC)、时钟漂移估计、锚点映射。
// 不依赖任何第三方库，可同时在浏览器与 Node 中运行（ESM）。

export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// 原地迭代 radix-2 FFT；inverse=true 时执行逆变换（含 1/N 缩放）。
export function fft(re, im, inverse = false) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = i + k + half;
        const ur = re[a];
        const ui = im[a];
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[a] = ur + vr;
        im[a] = ui + vi;
        re[b] = ur - vr;
        im[b] = ui - vi;
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

// 块均值抽取，用于粗搜，降低长录音的运算量。
export function decimate(x, factor) {
  if (factor <= 1) return x;
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const base = i * factor;
    for (let j = 0; j < factor; j++) s += x[base + j];
    out[i] = s / factor;
  }
  return out;
}

// 计算 minLag..maxLag 范围内的归一化互相关系数。
// lag 约定：target[q] 对齐 ref[p] 时 q = p + lag（lag>0 表示 target 更晚）。
// 用线性卷积实现以避免 FFT 环形下标歧义：令 xr=reverse(x)，
// 则 C(lag)=Σ_p x[p]·y[p+lag] = conv(xr, y)[lag + m - 1]。
export function nccRange(x, y, minLag, maxLag) {
  const m = x.length;
  const n = y.length;
  const size = nextPow2(m + n - 1);
  // ar[k] = x[m-1-k]（反转 ref），零填充到 size。
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const yr = new Float64Array(size);
  const yi = new Float64Array(size);
  for (let k = 0; k < m; k++) ar[k] = x[m - 1 - k];
  yr.set(y);
  fft(ar, ai);
  fft(yr, yi);
  // 卷积 = IFFT(A · Y)
  const cr = new Float64Array(size);
  const ci = new Float64Array(size);
  for (let k = 0; k < size; k++) {
    cr[k] = ar[k] * yr[k] - ai[k] * yi[k];
    ci[k] = ar[k] * yi[k] + ai[k] * yr[k];
  }
  fft(cr, ci, true);

  const ex = new Float64Array(m + 1);
  const ey = new Float64Array(n + 1);
  for (let i = 0; i < m; i++) ex[i + 1] = ex[i] + x[i] * x[i];
  for (let i = 0; i < n; i++) ey[i + 1] = ey[i] + y[i] * y[i];

  const lo = Math.max(minLag, -(m - 1));
  const hi = Math.min(maxLag, n - 1);
  const out = [];
  for (let lag = lo; lag <= hi; lag++) {
    // 有效重叠：p∈[max(0,-lag), min(m-1, n-1-lag)]，对应 q=p+lag。
    const p0 = Math.max(0, -lag);
    const p1 = Math.min(m - 1, n - 1 - lag);
    if (p1 - p0 + 1 < 8) continue; // 重叠样本太少，统计意义不足
    const raw = cr[lag + m - 1];
    const sx = ex[p1 + 1] - ex[p0];
    const sy = ey[p1 + lag + 1] - ey[p0 + lag];
    const den = Math.sqrt(sx * sy);
    out.push({ lag, coeff: den > 0 ? raw / den : 0 });
  }
  return out;
}

// 抛物线插值，得到亚采样级 lag。
function refinePeak(list) {
  let best = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].coeff > list[best].coeff) best = i;
  }
  const c = list[best];
  const prev = list[best - 1];
  const next = list[best + 1];
  let delta = 0;
  if (prev && next) {
    const den = prev.coeff - 2 * c.coeff + next.coeff;
    if (Math.abs(den) > 1e-12) {
      delta = 0.5 * (prev.coeff - next.coeff) / den;
      delta = Math.max(-1, Math.min(1, delta));
    }
  }
  return { lag: c.lag + delta, coeff: c.coeff };
}

// 粗搜（抽取后 NCC）+ 精搜（全采样率窗口 NCC）估计整轨起始偏移。
// maxOffsetSec 限定物理合理的偏移范围（默认 ±10s），排除周期性内容的远距离自相关假峰。
// 返回 { lagSamples, coeff }，lag 为 target 相对 ref 的滞后采样数（亚采样精度）。
export function estimateOffset(ref, tgt, sampleRate, maxOffsetSec = 10) {
  const factor = Math.max(1, Math.floor(sampleRate / 4000));
  const xr = decimate(ref, factor);
  const yr = decimate(tgt, factor);
  // 在物理合理的有限偏移范围内粗搜。
  const maxLag = Math.round(maxOffsetSec * (sampleRate / factor));
  const lo = Math.max(-(xr.length - 1), -maxLag);
  const hi = Math.min(yr.length - 1, maxLag);
  const coarse = nccRange(xr, yr, lo, hi);
  if (coarse.length === 0) return { lagSamples: 0, coeff: 0 };
  const k0 = refinePeak(coarse).lag;

  const winLen = Math.min(ref.length, Math.floor(30 * sampleRate));
  const center = Math.floor(ref.length / 2);
  const start = Math.max(0, center - Math.floor(winLen / 2));
  const xw = ref.subarray(start, start + winLen);
  // 粗搜 lag 是全数组坐标系；窗口 lag = 全数组 lag - start，
  // 精搜在粗估值附近 ±(3 个抽取块 + 少量采样) 范围内进行。
  const margin = 3 * factor + 8;
  const centerLagWin = k0 * factor - start;
  const fine = nccRange(xw, tgt, Math.round(centerLagWin) - margin, Math.round(centerLagWin) + margin);
  if (fine.length === 0) {
    return { lagSamples: k0 * factor, coeff: refinePeak(coarse).coeff };
  }
  const r = refinePeak(fine);
  // 负偏移（target 更短/更早）时窗口可能几乎无重叠，此时信任粗搜。
  if (r.coeff < 0.3) {
    const c = refinePeak(coarse);
    return { lagSamples: c.lag * factor, coeff: c.coeff };
  }
  // 还原到全数组坐标系。
  return { lagSamples: r.lag + start, coeff: r.coeff };
}

// 最小二乘拟合 y = a*t + b。
function fitLine(points) {
  let st = 0;
  let sy = 0;
  let stt = 0;
  let sty = 0;
  const n = points.length;
  for (const p of points) {
    st += p.t;
    sy += p.lagSec;
    stt += p.t * p.t;
    sty += p.t * p.lagSec;
  }
  const det = n * stt - st * st;
  if (Math.abs(det) < 1e-12) return { slope: 0, intercept: sy / n || 0 };
  return {
    slope: (n * sty - st * sy) / det,
    intercept: (sy * stt - st * sty) / det,
  };
}

// 稳健线性拟合：先全量拟合，再剔除残差超过 3 倍稳健标准差（MAD）的离群窗口，
// 反复迭代，避免个别“跟丢”的假峰污染漂移斜率。返回模型与保留的点索引。
function robustFitLine(points) {
  if (points.length < 2) {
    const b = points.length ? points[0].lagSec : 0;
    return { slope: 0, intercept: b, inliers: points.map((_, i) => i) };
  }
  let inliers = points.map((_, i) => i);
  let model = fitLine(inliers.map((i) => points[i]));
  for (let iter = 0; iter < 5; iter++) {
    const resid = inliers.map((i) => Math.abs(points[i].lagSec -
      (model.slope * points[i].t + model.intercept)));
    const med = [...resid].sort((a, b) => a - b)[Math.floor(resid.length / 2)] || 1e-9;
    // MAD → 标准差估计：σ ≈ 1.4826·MAD；阈值再放宽到 3σ。
    const thr = Math.max(1e-4, 3 * 1.4826 * med);
    const next = inliers.filter((i) => Math.abs(points[i].lagSec -
      (model.slope * points[i].t + model.intercept)) <= thr);
    if (next.length === inliers.length || next.length < 2) break;
    inliers = next;
    model = fitLine(inliers.map((i) => points[i]));
  }
  return { ...model, inliers };
}

// 分窗口 NCC 估计局部偏差，再稳健线性拟合得到时钟漂移（ppm）。
// 关键约束：存在时钟漂移时，长窗口内部会逐渐失步使真实峰塌缩、假峰胜出，
// 因此一律使用短窗口（窗内漂移失步可忽略，真实 NCC 保持高系数）。
// 首窗在物理合理的 ±maxOffsetSec 范围内定位（排除周期性纹理的远距离自相关假峰）；
// 若调用方提供 baseLagSec（通常来自整轨 estimateOffset，全程信号更稳健）则优先采用；
// 后续窗口只在首窗 lag 的有界邻域内搜索。
// 返回各窗口的局部 lag、相关系数、相对拟合直线的残差及离群标记。
export function estimateDrift(ref, tgt, sampleRate, winSec = 4, hopSec = 2, maxOffsetSec = 10, baseLagSec = null) {
  const factor = Math.max(1, Math.floor(sampleRate / 6000));
  const srLow = sampleRate / factor;
  const xr = decimate(ref, factor);
  const yr = decimate(tgt, factor);
  const W = Math.round(winSec * srLow);
  const H = Math.round(hopSec * srLow);
  const MIN_COEFF = 0.4;   // 邻域搜索已排除远距离假峰，阈值可放宽
  const points = [];

  // 首窗定位：优先采用调用方给出的整轨基准 lag（全程信号、更稳健）；
  // 否则在有限偏移范围内用首窗 NCC 定位，排除周期性纹理的远距离假峰。
  const maxLag = Math.round(maxOffsetSec * srLow);
  let anchorLag;
  if (baseLagSec !== null && Number.isFinite(baseLagSec)) {
    anchorLag = Math.round(baseLagSec * srLow);
  } else {
    const firstWin = xr.subarray(0, W);
    const firstAll = nccRange(firstWin, yr, -maxLag, maxLag);
    if (firstAll.length === 0) {
      return { points: [], driftPpm: 0, interceptMs: 0 };
    }
    const first = refinePeak(firstAll);
    if (first.coeff < MIN_COEFF) {
      return { points: [], driftPpm: 0, interceptMs: 0 };
    }
    anchorLag = Math.round(first.lag);
  }
  // 锚点为整数 lag（亚采样精化只用于输出），避免污染后续整数 lag 搜索范围。
  // 跟踪邻域半宽：覆盖整段录音的累计漂移（按 2000ppm 极端时钟误差取上界），再加 100ms。
  const totalSec = xr.length / srLow;
  const band = Math.round((totalSec * 2000e-6 + 0.1) * srLow);

  for (let p0 = 0; p0 + W <= xr.length; p0 += H) {
    const xw = xr.subarray(p0, p0 + W);
    // 窗口 NCC 的 lag 是相对窗口起点的局部坐标：targetIdx = windowIdx + localLag，
    // 故 全局 lag = localLag - p0。搜索前把全局 anchor 换算为局部，结果再换回全局。
    const localAnchor = anchorLag + p0;
    const res = nccRange(xw, yr, localAnchor - band, localAnchor + band);
    if (res.length === 0) continue;
    const r = refinePeak(res);
    if (r.coeff < MIN_COEFF) continue;
    points.push({
      t: (p0 + W / 2) / srLow, // 参考轨（工程时间）秒
      lagSec: (r.lag - p0) / srLow, // 转回全局 lag
      coeff: r.coeff,
    });
  }
  if (points.length < 2) {
    return { points: points.map((p) => ({ ...p, localMs: 0, outlier: false })), driftPpm: 0, interceptMs: 0 };
  }
  const { slope, intercept, inliers } = robustFitLine(points);
  const inSet = new Set(inliers);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    p.localMs = (p.lagSec - (slope * p.t + intercept)) * 1000;
    p.outlier = !inSet.has(i);
  }
  return {
    points,
    driftPpm: slope * 1e6,
    interceptMs: intercept * 1000,
  };
}

// ---- 工程时间 -> 源文件时间 的映射 ----
// 简单模式：全局偏移（秒）+ 线性漂移（ppm）。
export function sourceTimeSimple(projectSec, offsetSec, driftPpm) {
  return projectSec + offsetSec + driftPpm * 1e-6 * projectSec;
}

// 锚点模式：分段线性插值，区间外按首尾斜率外推后钳制到源素材范围。
// anchors: [{ projectSec, sourceSec }]，按 projectSec 升序。
export function sourceTimeFromAnchors(projectSec, anchors) {
  if (anchors.length === 0) return projectSec;
  if (anchors.length === 1) return projectSec + (anchors[0].sourceSec - anchors[0].projectSec);
  const a = anchors;
  if (projectSec <= a[0].projectSec) {
    const slope = (a[1].sourceSec - a[0].sourceSec) / (a[1].projectSec - a[0].projectSec);
    return a[0].sourceSec + (projectSec - a[0].projectSec) * slope;
  }
  const last = a.length - 1;
  if (projectSec >= a[last].projectSec) {
    const slope = (a[last].sourceSec - a[last - 1].sourceSec) /
      (a[last].projectSec - a[last - 1].projectSec);
    return a[last].sourceSec + (projectSec - a[last].projectSec) * slope;
  }
  for (let i = 0; i < last; i++) {
    if (projectSec >= a[i].projectSec && projectSec <= a[i + 1].projectSec) {
      const span = a[i + 1].projectSec - a[i].projectSec;
      const f = span > 0 ? (projectSec - a[i].projectSec) / span : 0;
      return a[i].sourceSec + f * (a[i + 1].sourceSec - a[i].sourceSec);
    }
  }
  return projectSec;
}

// 逆映射：源时间 -> 工程时间（用于波形绘制）。
export function projectTimeFromAnchors(sourceSec, anchors) {
  if (anchors.length === 0) return sourceSec;
  if (anchors.length === 1) return sourceSec - (anchors[0].sourceSec - anchors[0].projectSec);
  const a = [...anchors].sort((x, y) => x.sourceSec - y.sourceSec);
  if (sourceSec <= a[0].sourceSec) {
    const slope = (a[1].projectSec - a[0].projectSec) / (a[1].sourceSec - a[0].sourceSec);
    return a[0].projectSec + (sourceSec - a[0].sourceSec) * slope;
  }
  const last = a.length - 1;
  if (sourceSec >= a[last].sourceSec) {
    const slope = (a[last].projectSec - a[last - 1].projectSec) /
      (a[last].sourceSec - a[last - 1].sourceSec);
    return a[last].projectSec + (sourceSec - a[last].sourceSec) * slope;
  }
  for (let i = 0; i < last; i++) {
    if (sourceSec >= a[i].sourceSec && sourceSec <= a[i + 1].sourceSec) {
      const span = a[i + 1].sourceSec - a[i].sourceSec;
      const f = span > 0 ? (sourceSec - a[i].sourceSec) / span : 0;
      return a[i].projectSec + f * (a[i + 1].projectSec - a[i].projectSec);
    }
  }
  return sourceSec;
}

export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

export function peakAmplitude(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
}

// 静音段检测：RMS 低于阈值且持续不少于 minMs。
export function detectSilence(x, sampleRate, thresholdDb = -45, minMs = 300) {
  const frame = Math.max(64, Math.floor(sampleRate * 0.02));
  const thr = 10 ** (thresholdDb / 20);
  const minFrames = Math.ceil((minMs / 1000) / (frame / sampleRate));
  const ranges = [];
  let runStart = -1;
  for (let i = 0; i + frame <= x.length; i += frame) {
    const seg = x.subarray(i, i + frame);
    const silent = rms(seg) < thr;
    if (silent && runStart < 0) runStart = i;
    if (!silent && runStart >= 0) {
      if ((i - runStart) / frame >= minFrames) {
        ranges.push([runStart / sampleRate, i / sampleRate]);
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && (x.length - runStart) / frame >= minFrames) {
    ranges.push([runStart / sampleRate, x.length / sampleRate]);
  }
  return ranges;
}

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--:--.---';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (v, w = 2) => String(v).padStart(w, '0');
  return `${neg ? '-' : ''}${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}
