/*
 * time-stretch.js —— 本机变速算法（零依赖，浏览器 / Node 通用）
 *
 * 两种模式：
 *   pitch    : WSOLA 波形相似度叠加，放慢/加快时保持音高不变
 *   resample : 线性重采样，改变采样率，音高随速度变化（"原始变速"对照）
 *
 * rate 语义统一：rate = 播放速度倍率（0.5 = 放慢一半、输出时长翻倍，
 * 2.0 = 快一倍），输出长度 = round(源长度 / rate)。
 * 两种模式都把输出长度归一化到该精确值，这样循环回绕时每一圈的
 * 时间误差有界，不会越放越偏。
 *
 * 立体声处理时，用左右声道混合信号做 WSOLA 相关分析，但同一个偏移
 * 施加到两个声道，保证左右声道原有的时间关系（过门/声像）不被破坏。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TimeStretch = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 可用范围与最短输入（引擎与 UI 共用，保证提示口径一致）
  const MIN_RATE = 0.25;
  const MAX_RATE = 4.0;
  const MIN_FRAMES = 1024; // 约 46ms@44.1k，不足一个分析帧无法处理

  const FRAME_LEN = 2048; // N：分析/合成帧长
  const H_SYN = 512;      // 合成跳长 Ha；分析跳长 Hs = Ha·rate
  const TOL = 128;        // 对齐搜索容差 Δmax

  function validate(input, rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) {
      throw new Error('速度参数无效：' + rate);
    }
    if (rate < MIN_RATE || rate > MAX_RATE) {
      throw new Error('速度 ' + rate.toFixed(3) + ' 超出可用范围 ' +
        MIN_RATE + 'x ~ ' + MAX_RATE + 'x');
    }
    const n = input[0].length;
    if (!Number.isInteger(n) || n < MIN_FRAMES) {
      throw new Error('输入过短：仅 ' + n + ' 个采样点（最少需要 ' +
        MIN_FRAMES + ' 个，约 ' + (MIN_FRAMES / 44.1).toFixed(1) + 'k 采样率下 ' +
        (MIN_FRAMES / 44100).toFixed(3) + ' 秒）');
    }
  }

  /* ---------------- 线性重采样（原始变速，音高随速率变化） ---------------- */
  function resample(input, rate) {
    validate(input, rate);
    const n = input[0].length;
    const outLen = Math.round(n / rate);
    const out = input.map((ch) => {
      const y = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        // 输出第 i 点取源 i·rate 位置：放慢(rate<1)时点更密、时长变长，
        // 在同一采样率下播放，频谱按 rate 压缩（音高变低），模拟磁带变速
        const pos = i * rate;
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = ch[i0];
        const b = i0 + 1 < n ? ch[i0 + 1] : a;
        y[i] = a + (b - a) * frac;
      }
      return y;
    });
    return { channels: out, rate, mode: 'resample', sourceFrames: n, outputFrames: outLen };
  }

  /* ---------------- WSOLA（保音高变速） ---------------- */

  function hannWindow(len) {
    const w = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    }
    return w;
  }

  // 在 mono 上取一帧，越界补零
  function frameAt(mono, center) {
    const start = center - FRAME_LEN / 2;
    const f = new Float32Array(FRAME_LEN);
    for (let j = 0; j < FRAME_LEN; j++) {
      const idx = start + j;
      if (idx >= 0 && idx < mono.length) f[j] = mono[idx];
    }
    return f;
  }

  // 在 [center-tol, center+tol] 内找与 ref 归一化互相关最高的位置。
  // 两级搜索：先按 4 倍抽头粗搜，再在最优点附近全分辨率细搜，
  // 运算量约为全量搜索的 1/10，音乐信号下精度等价。
  // tol 由调用方按分析跳长给出：容差不能超过半个分析跳长，
  // 否则放慢时可能跳到相邻周期，破坏时间结构。
  function bestShift(mono, ref, center, tol) {
    const lo = Math.max(0, center - tol);
    const hi = Math.min(mono.length - 1, center + tol);
    let refEnergy = 0;
    for (let j = 0; j < FRAME_LEN; j++) refEnergy += ref[j] * ref[j];
    if (refEnergy < 1e-12) return center; // 静音段无需对齐

    const D = 4;
    let bestK = center;
    let bestScore = -Infinity;

    function scoreAt(k, stride) {
      const start = k - FRAME_LEN / 2;
      let dot = 0;
      let energy = 0;
      let refE = 0;
      for (let j = 0; j < FRAME_LEN; j += stride) {
        const idx = start + j;
        if (idx < 0 || idx >= mono.length) continue;
        const v = mono[idx];
        dot += ref[j] * v;
        energy += v * v;
        refE += ref[j] * ref[j];
      }
      if (energy < 1e-12) return -Infinity;
      return dot / Math.sqrt(refE * energy); // 归一化互相关
    }

    // 粗搜：抽头相关
    for (let k = lo; k <= hi; k += D) {
      const score = scoreAt(k, D);
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    // 细搜：最优点 ±D 内全分辨率（跳过粗搜已算过的整 D 点）
    const fLo = Math.max(lo, bestK - D + 1);
    const fHi = Math.min(hi, bestK + D - 1);
    for (let k = fLo; k <= fHi; k++) {
      if (k % D === 0) continue;
      const score = scoreAt(k, 1);
      if (score > bestScore) { bestScore = score; bestK = k; }
    }
    return bestK;
  }

  function wsola(input, rate) {
    validate(input, rate);
    const n = input[0].length;
    const ch = input.length;
    const outLen = Math.round(n / rate);
    const hSyn = H_SYN;                        // 合成跳长 Ha 固定
    const hAna = Math.max(1, H_SYN * rate);    // 分析跳长 Hs = Ha·rate
    // 容差必须同时满足：
    //  1) 不超过分析跳长的一半，避免跨周期误对齐；
    //  2) 严格小于 |hSyn - hAna|（候选与参考中心的间距），
    //     否则搜索窗口会把参考位置本身纳入，非周期信号会被错误拉回。
    const gap = Math.abs(hSyn - hAna);
    const tol = Math.max(
      8,
      Math.min(TOL, Math.floor(hAna / 2), gap > 0 ? gap - 1 : TOL)
    );
    const window = hannWindow(FRAME_LEN);
    // 两个 Hann 窗 50% 重叠相加时幅度和为 1.5，补偿回 1.0
    const norm = 2 / 3;

    // 分析用的单声道混合（不修改原声道数据）
    const mono = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      for (let i = 0; i < n; i++) mono[i] += input[c][i] / ch;
    }

    // 输出按最长可能预留，最后精确截断到 outLen
    const acc = [];
    for (let c = 0; c < ch; c++) acc.push(new Float32Array(outLen + FRAME_LEN));

    let prevK = 0;       // 上一帧实际分析位置
    let idealAna = 0;    // 理想分析位置（按分析跳长 Hs 推进）
    let outPos = 0;
    let first = true;

    while (outPos < outLen) {
      let k;
      if (first) {
        k = 0;
      } else {
        // 标准 WSOLA：
        //  - 候选中心 idealAna 按分析跳长 Hs = hSyn·rate 推进，
        //    决定源时间轴的消耗速度，即整体拉伸比；
        //  - 参考帧取上一实际帧后移合成跳长 hSyn（在输出侧与当前
        //    合成帧相邻），要求两者波形相似，保证叠加连续。
        // 同一 k 作用于所有声道，故声道间延迟随分析推进按 1/rate 缩放。
        idealAna += hAna;
        const ref = frameAt(mono, prevK + hSyn);
        k = bestShift(mono, ref, Math.round(idealAna), tol);
      }

      // 同一偏移 k 施加到所有声道，分析帧平移复制到输出位置 outPos，
      // 保持声道间时间关系（过门/声像）随时间轴一起缩放
      const start = k - FRAME_LEN / 2;
      for (let c = 0; c < ch; c++) {
        const src = input[c];
        const dst = acc[c];
        for (let j = 0; j < FRAME_LEN; j++) {
          const idx = start + j;
          if (idx < 0 || idx >= n) continue;
          dst[outPos + j] += src[idx] * window[j] * norm;
        }
      }

      prevK = k;
      outPos += hSyn;
      first = false;
      if (idealAna >= n) break;
    }

    const channels = acc.map((a) => a.slice(0, outLen));
    return {
      channels,
      rate,
      mode: 'pitch',
      sourceFrames: n,
      outputFrames: outLen,
    };
  }

  // 统一入口
  function stretch(input, rate, mode) {
    return mode === 'resample' ? resample(input, rate) : wsola(input, rate);
  }

  return {
    stretch,
    wsola,
    resample,
    validate,
    MIN_RATE,
    MAX_RATE,
    MIN_FRAMES,
    FRAME_LEN,
    H_SYN,
  };
});
