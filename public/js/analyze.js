/*
 * analyze.js —— 对照分析工具（零依赖，浏览器 / Node 通用）
 *
 * estimatePitch      : 自相关基频估计，核对保音高变速后音高是否漂移
 * findAccents        : 短时能量峰值，核对重音大致位置
 * estimateChannelLag : 左右声道互相关，核立体声时间关系
 * regionStats        : 汇总当前区间的时长/能量等信息
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AudioAnalyze = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 去均值
  function centered(x) {
    let mean = 0;
    for (let i = 0; i < x.length; i++) mean += x[i];
    mean /= x.length;
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] - mean;
    return y;
  }

  // 三点抛物线插值，把离散 lag/location 细化到亚采样精度
  function refinePeak(vals, idx) {
    if (idx <= 0 || idx >= vals.length - 1) return idx;
    const y0 = vals[idx - 1];
    const y1 = vals[idx];
    const y2 = vals[idx + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom === 0) return idx;
    const shift = 0.5 * (y0 - y2) / denom;
    return idx + Math.max(-1, Math.min(1, shift));
  }

  // 自相关基频估计；fMin/fMax 限定搜索范围（默认 60~1200Hz）
  function estimatePitch(mono, sampleRate, fMin = 60, fMax = 1200) {
    const x = centered(mono);
    const minLag = Math.floor(sampleRate / fMax);
    const maxLag = Math.min(Math.floor(sampleRate / fMin), x.length - 1);
    if (maxLag <= minLag) return null;

    let energy = 0;
    for (let i = 0; i < x.length; i++) energy += x[i] * x[i];
    if (energy / x.length < 1e-6) return null; // 静音

    const scores = new Array(maxLag + 1).fill(-Infinity);
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      let e0 = 0;
      let e1 = 0;
      for (let i = 0; i + lag < x.length; i++) {
        sum += x[i] * x[i + lag];
        e0 += x[i] * x[i];
        e1 += x[i + lag] * x[i + lag];
      }
      const norm = Math.sqrt(e0 * e1);
      scores[lag] = norm > 0 ? sum / norm : 0;
    }
    let bestLag = minLag;
    for (let lag = minLag + 1; lag <= maxLag; lag++) {
      if (scores[lag] > scores[bestLag]) bestLag = lag;
    }
    if (scores[bestLag] < 0.4) return null; // 周期性太弱，不可信

    // 八度下行纠错：纯正弦等信号在 2x/3x... 周期处相关度同样接近 1。
    // 从最佳 lag 的每个整数分频位置独立判断（不依赖上一轮结果），
    // 取其中相关度近似等高（≥0.97 峰值）的最短 lag；
    // 分频位置低于搜索下限时，下限本身即候选。
    let lag = bestLag;
    for (let div = 2; Math.round(bestLag / div) >= minLag || div === 2; div++) {
      const sub = Math.max(minLag, Math.round(bestLag / div));
      if (sub >= lag) break;
      if (scores[sub] >= 0.97 * scores[bestLag]) lag = sub;
      if (sub === minLag) break;
    }

    const refinedLag = refinePeak(scores, lag);
    return { frequency: sampleRate / refinedLag, clarity: scores[lag], lag: refinedLag };
  }

  // 短时能量峰值 -> 重音位置（返回秒）
  function findAccents(mono, sampleRate, windowSec = 0.02, thresholdRatio = 0.5) {
    const win = Math.max(64, Math.floor(windowSec * sampleRate));
    const n = mono.length;
    const energies = [];
    for (let i = 0; i < n; i += win) {
      let e = 0;
      const end = Math.min(i + win, n);
      for (let j = i; j < end; j++) e += mono[j] * mono[j];
      energies.push({ frame: i, energy: e / (end - i) });
    }
    const maxE = Math.max(...energies.map((d) => d.energy));
    if (maxE <= 0) return [];
    const accents = [];
    for (let k = 1; k < energies.length - 1; k++) {
      const e = energies[k].energy;
      if (e > thresholdRatio * maxE &&
          e >= energies[k - 1].energy && e >= energies[k + 1].energy) {
        accents.push(energies[k].frame / sampleRate);
      }
    }
    return accents;
  }

  // 左右声道互相关估计右声道相对左声道的延迟（采样点/秒）
  // 按有效重叠长度做归一化，避免边缘零填充让短滞后虚高；
  // 直接取全区间归一化相关的全局最强峰，再做抛物线亚采样细化。
  // maxLagSec 需覆盖处理后最大的时间伸缩量。
  function estimateChannelLag(left, right, sampleRate, maxLagSec = 0.2) {
    const maxLag = Math.min(Math.floor(maxLagSec * sampleRate), left.length - 1);
    const a = centered(left);
    const b = centered(right);
    const vals = new Array(maxLag + 1).fill(-Infinity);
    let bestLag = 0;
    for (let lag = 0; lag <= maxLag; lag++) {
      let sum = 0;
      let ea = 0;
      let eb = 0;
      const overlap = a.length - lag;
      for (let i = 0; i < overlap; i++) {
        sum += a[i] * b[i + lag];
        ea += a[i] * a[i];
        eb += b[i + lag] * b[i + lag];
      }
      vals[lag] = ea > 0 && eb > 0 ? sum / Math.sqrt(ea * eb) : 0;
      if (vals[lag] > vals[bestLag]) bestLag = lag;
    }
    const refined = refinePeak(vals, bestLag);
    return { lagSamples: refined, lagSec: refined / sampleRate };
  }

  // 汇总一段（多声道）音频的分析结果
  function regionStats(channels, sampleRate) {
    const mono = new Float32Array(channels[0].length);
    for (const ch of channels) for (let i = 0; i < ch.length; i++) mono[i] += ch[i] / channels.length;

    const pitch = estimatePitch(mono, sampleRate);
    const accents = findAccents(mono, sampleRate);
    const stats = {
      frames: mono.length,
      durationSec: mono.length / sampleRate,
      pitch: pitch ? pitch.frequency : null,
      pitchClarity: pitch ? pitch.clarity : null,
      accentsSec: accents,
    };
    if (channels.length === 2) {
      stats.channelLag = estimateChannelLag(channels[0], channels[1], sampleRate);
    }
    return stats;
  }

  return { estimatePitch, findAccents, estimateChannelLag, regionStats };
});
