/*
 * dsp.js — 纯 JS 动态压缩（峰值检测 + 平滑增益）、电平统计与 WAV 编码。
 * 不依赖浏览器 API，可直接在 Node 下跑单元测试（见 tests/dsp.test.mjs）。
 */
(function (global) {
  'use strict';

  // ---------- 基础换算 ----------

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function gainToDb(g) {
    return 20 * Math.log10(g < 1e-7 ? 1e-7 : g);
  }

  // 时间常数（毫秒）→ 每采样一阶平滑系数。
  // alpha = exp(-1 / (fs * t/1000))，t 越小系数越小、动作越快。
  function smoothingCoeff(timeMs, sampleRate) {
    if (timeMs <= 0) return 0;
    return Math.exp(-1 / (sampleRate * timeMs / 1000));
  }

  /**
   * 对 AudioBuffer 样式的输入做动态压缩（逐采样）。
   *
   * params: { thresholdDb, ratio, attackMs, releaseMs, linked }
   * channelData: 数组，每个元素是一个 Float32Array 声道
   *
   * 返回: {
   *   out: 与输入同结构的 Float32Array[]（应用了压缩、未加补偿增益）,
   *   gainDb: Float32Array[]，逐采样增益量（dB，<=0），
   *   gainCurve: { t: Float32Array, channels: Float32Array[] }，降采样后的增益曲线，
   *   maxGrDb: 最大增益衰减量（正数，dB）
   * }
   *
   * 增益衰减初值为 0（对应完全放开），因此开头的静音不会被任何增益动作改动，
   * 输出长度与输入逐采样相同。
   */
  function compress(channelData, sampleRate, params, curvePoints) {
    const numCh = channelData.length;
    const n = channelData[0].length;
    const linked = !!params.linked && numCh > 1;
    const kAttack = smoothingCoeff(params.attackMs, sampleRate);
    const kRelease = smoothingCoeff(params.releaseMs, sampleRate);

    const out = channelData.map((d) => new Float32Array(d.length));

    // 每声道当前增益衰减（dB，>=0）；包络初值为“无衰减”，
    // 因此开头静音不产生任何增益动作，输出长度与输入逐采样相同。
    const gr = new Array(numCh).fill(0);

    const gainDb = channelData.map(() => new Float32Array(n));

    // 联动模式共享一条增益
    let linkedGr = 0;

    const threshold = params.thresholdDb;
    const invRatio = 1 / params.ratio;

    // feed-forward 结构：峰值检测取瞬时电平 → 静态曲线算目标衰减 →
    // 对衰减量做 attack/release 一阶平滑（上行 attack、下行 release）。
    function smoothGr(cur, target) {
      const k = target > cur ? kAttack : kRelease;
      return cur + (1 - k) * (target - cur);
    }

    function targetGrForPeak(peak) {
      if (peak < 1e-7) return 0;
      const level = gainToDb(peak);
      return level > threshold ? (level - threshold) * (1 - invRatio) : 0;
    }

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < numCh; c++) {
        let curGr;
        if (linked) {
          if (c === 0) {
            let peak = 0;
            for (let cc = 0; cc < numCh; cc++) {
              const a = Math.abs(channelData[cc][i]);
              if (a > peak) peak = a;
            }
            linkedGr = smoothGr(linkedGr, targetGrForPeak(peak));
          }
          curGr = linkedGr;
        } else {
          gr[c] = smoothGr(gr[c], targetGrForPeak(Math.abs(channelData[c][i])));
          curGr = gr[c];
        }

        const g = dbToGain(-curGr);
        gainDb[c][i] = -curGr;
        out[c][i] = channelData[c][i] * g;
      }
    }

    // 2. 降采样增益曲线（用于画布），取每桶内最大衰减（最能代表压缩动作）
    const points = Math.max(200, Math.min(curvePoints || 2000, n));
    const bucket = Math.max(1, Math.floor(n / points));
    const tArr = new Float32Array(points);
    const curveCh = channelData.map(() => new Float32Array(points));
    let maxGr = 0;
    for (let p = 0; p < points; p++) {
      const start = p * bucket;
      const end = Math.min(n, start + bucket);
      tArr[p] = (start + (end - start) / 2) / sampleRate;
      for (let c = 0; c < numCh; c++) {
        let worst = 0;
        for (let i = start; i < end; i++) {
          const v = -gainDb[c][i];
          if (v > worst) worst = v;
        }
        curveCh[c][p] = worst;
        if (worst > maxGr) maxGr = worst;
      }
    }

    return {
      out,
      gainDb,
      gainCurve: { t: tArr, channels: curveCh },
      maxGrDb: maxGr,
    };
  }

  // ---------- 电平 / 响度统计 ----------

  function rmsDb(channelData) {
    let sum = 0;
    let cnt = 0;
    for (let c = 0; c < channelData.length; c++) {
      const d = channelData[c];
      for (let i = 0; i < d.length; i++) sum += d[i] * d[i];
      cnt += d.length;
    }
    const rms = Math.sqrt(sum / Math.max(1, cnt));
    return gainToDb(rms);
  }

  function peakAbs(channelData) {
    let p = 0;
    for (let c = 0; c < channelData.length; c++) {
      const d = channelData[c];
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > p) p = a;
      }
    }
    return p;
  }

  /**
   * 统计首尾静音长度（秒）。门限默认 -60 dBFS。
   * 多声道时所有声道都低于门限才算静音。
   */
  function silenceEdges(channelData, sampleRate, thresholdDb) {
    const th = dbToGain(thresholdDb == null ? -60 : thresholdDb);
    const n = channelData[0].length;
    const numCh = channelData.length;

    function silentAt(i) {
      for (let c = 0; c < numCh; c++) {
        if (Math.abs(channelData[c][i]) > th) return false;
      }
      return true;
    }

    let head = 0;
    while (head < n && silentAt(head)) head++;
    let tail = 0;
    while (tail < n && silentAt(n - 1 - tail)) tail++;
    return { headSec: head / sampleRate, tailSec: tail / sampleRate };
  }

  /**
   * 把“压缩后、未补偿”的数据加上补偿增益后做削波统计。
   * 返回削波样本数、首次削波时间（秒，null 表示无）、以及 > -1 dBFS 的近削波数。
   */
  function clipStats(channelData, sampleRate, makeupDb) {
    const m = dbToGain(makeupDb);
    const near = dbToGain(-1);
    let clips = 0;
    let nearClips = 0;
    let firstIdx = -1;
    for (let c = 0; c < channelData.length; c++) {
      const d = channelData[c];
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i] * m);
        if (v >= 1) {
          clips++;
          if (firstIdx < 0) firstIdx = i;
        } else if (v >= near) {
          nearClips++;
        }
      }
    }
    return {
      clips,
      nearClips,
      firstSec: firstIdx < 0 ? null : firstIdx / sampleRate,
    };
  }

  // ---------- WAV 编码（16-bit PCM，交叉排列，保留完整长度） ----------

  function encodeWav16(channelData, sampleRate, makeupDb) {
    const numCh = channelData.length;
    const n = channelData[0].length;
    const m = dbToGain(makeupDb || 0);
    const dataBytes = n * numCh * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const dv = new DataView(buf);

    function writeStr(offset, s) {
      for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i));
    }

    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, numCh, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * numCh * 2, true);
    dv.setUint16(32, numCh * 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, dataBytes, true);

    let off = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < numCh; c++) {
        let v = channelData[c][i] * m;
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  const api = {
    dbToGain,
    gainToDb,
    smoothingCoeff,
    compress,
    rmsDb,
    peakAbs,
    silenceEdges,
    clipStats,
    encodeWav16,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.DSP = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
