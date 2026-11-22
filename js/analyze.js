// 响应分析：首波、主要反射、RT60 估计、片尾长度；以及两份响应的对比。
(function (root) {
  const RL = root.RoomLab || (root.RoomLab = {});
  const dsp = RL.dsp;

  // 多声道包络（每采样取各声道最大绝对值）
  function envelope(ir) {
    const n = ir.channels[0].length;
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let m = 0;
      for (const ch of ir.channels) m = Math.max(m, Math.abs(ch[i]));
      env[i] = m;
    }
    return env;
  }

  function findFirstPeak(env) {
    let peak = 0, peakIdx = 0;
    for (let i = 0; i < env.length; i++) {
      if (env[i] > peak) { peak = env[i]; peakIdx = i; }
    }
    // 首波：首个越过全局峰值 20% 的采样（-14dB 门限）
    const threshold = peak * 0.2;
    for (let i = 0; i < env.length; i++) {
      if (env[i] >= threshold) return { index: i, level: env[i], peak, peakIdx };
    }
    return { index: peakIdx, level: peak, peak, peakIdx };
  }

  // 主要反射：首波之后窗口内的局部极大，按最小间隔去重，按幅度取前 N
  function findReflections(env, firstIdx, sampleRate, maxCount) {
    const winStart = firstIdx + Math.round(0.004 * sampleRate);
    const winEnd = Math.min(env.length, firstIdx + Math.round(0.3 * sampleRate));
    const minGap = Math.round(0.008 * sampleRate);
    const cands = [];
    for (let i = winStart; i < winEnd; i++) {
      const v = env[i];
      if (v >= env[i - 1] && v >= env[i + 1] && v > 0.05) cands.push({ index: i, level: v });
    }
    cands.sort((a, b) => b.level - a.level);
    const picked = [];
    for (const c of cands) {
      if (picked.every((p) => Math.abs(p.index - c.index) >= minGap)) picked.push(c);
      if (picked.length >= maxCount) break;
    }
    picked.sort((a, b) => a.index - b.index);
    return picked;
  }

  // RT60：对首波后的窗口 RMS 包络做 -5..-35dB 段线性回归，再外推到 60dB。
  // 用 10ms 窗口平滑，避免高斯尾声的逐采样抖动污染回归。
  function estimateRt60(env, firstIdx, sampleRate) {
    const peak = env[firstIdx];
    const win = Math.max(1, Math.round(0.01 * sampleRate));
    const n = env.length;
    const times = [], dbs = [];
    for (let i = firstIdx; i < n; i += win) {
      let sum = 0, cnt = 0;
      for (let j = i; j < Math.min(i + win, n); j++) { sum += env[j] * env[j]; cnt++; }
      const rms = Math.sqrt(sum / cnt);
      if (rms < peak * 1e-5) continue; // 低于 -100dB 视为噪声基底，不参与回归
      times.push((i - firstIdx) / sampleRate);
      dbs.push(dsp.ampToDb(rms / peak));
    }
    let i5 = -1, i35 = -1;
    for (let k = 0; k < dbs.length; k++) {
      if (i5 < 0 && dbs[k] <= -5) i5 = k;
      if (dbs[k] <= -35) { i35 = k; break; }
    }
    if (i5 < 0 || i35 < 0 || i35 <= i5) {
      // 尾声较短时退化为 -5..-25dB 段
      for (let k = 0; k < dbs.length; k++) {
        if (dbs[k] <= -25) { i35 = k; break; }
      }
      if (i5 < 0 || i35 < 0 || i35 <= i5) return { rt60: null, slopeDbPerSec: null, usable: false };
    }
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let k = i5; k <= i35; k++) {
      const t = times[k];
      sx += t; sy += dbs[k]; sxx += t * t; sxy += t * dbs[k]; cnt++;
    }
    const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx);
    if (slope >= 0) return { rt60: null, slopeDbPerSec: slope, usable: false };
    return { rt60: 60 / -slope, slopeDbPerSec: slope, usable: true };
  }

  // 片尾长度：从末端向前找到持续高于 -55dB 门限的最后一个采样
  function findTail(env, firstIdx, sampleRate) {
    const peak = env[firstIdx];
    const threshold = peak * Math.pow(10, -55 / 20);
    const hold = Math.round(0.02 * sampleRate);
    let end = env.length - 1;
    let below = 0;
    for (let i = env.length - 1; i > firstIdx; i--) {
      if (env[i] < threshold) {
        below++;
        if (below >= hold) { end = i + hold; break; }
      } else {
        below = 0;
        end = i;
      }
    }
    return {
      endIndex: end,
      tailSec: (end - firstIdx) / sampleRate,
      totalSec: env.length / sampleRate,
    };
  }

  function analyzeIR(ir) {
    const env = envelope(ir);
    const sr = ir.sampleRate;
    const first = findFirstPeak(env);
    const reflections = findReflections(env, first.index, sr, 6).map((r) => ({
      timeMs: (r.index - first.index) / sr * 1000,
      timeAbsMs: r.index / sr * 1000,
      levelDb: dsp.ampToDb(r.level / first.peak),
      index: r.index,
    }));
    const rt = estimateRt60(env, first.index, sr);
    const tail = findTail(env, first.index, sr);
    return {
      env,
      first: {
        timeMs: first.index / sr * 1000,
        index: first.index,
        levelDb: dsp.ampToDb(first.level),
      },
      reflections,
      rt60: rt.rt60,
      tail,
      durationSec: env.length / sr,
      channels: ir.channels.length,
    };
  }

  // 两份（长度可不同）响应的归一化对比：统一时间轴，给出关键指标差
  function compareIRs(irA, irB) {
    const a = analyzeIR(irA);
    const b = analyzeIR(irB);
    return {
      a: summary(a, irA.name),
      b: summary(b, irB.name),
      lengthRatio: b.durationSec / a.durationSec,
      firstWaveDeltaMs: b.first.timeMs - a.first.timeMs,
      rt60DeltaSec: (b.rt60 || 0) - (a.rt60 || 0),
      reflectionCountDelta: b.reflections.length - a.reflections.length,
    };
  }

  function summary(a, name) {
    return {
      name,
      durationMs: Math.round(a.durationSec * 1000),
      firstWaveMs: +a.first.timeMs.toFixed(2),
      reflections: a.reflections.length,
      rt60Ms: a.rt60 != null ? Math.round(a.rt60 * 1000) : null,
      tailMs: Math.round(a.tail.tailSec * 1000),
    };
  }

  RL.analyze = { analyzeIR, compareIRs, envelope };
})(typeof globalThis !== 'undefined' ? globalThis : this);
