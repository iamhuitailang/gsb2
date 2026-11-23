/*
 * analysis.js — 折叠风险段落扫描与状态判定
 * UMD；依赖 DSP（Node require 或浏览器 window.DSP）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./dsp.js'));
  } else root.Analysis = factory(root.DSP);
})(typeof self !== 'undefined' ? self : this, function (DSP) {
  'use strict';

  // 判定阈值（经内置样例与测试校准）
  var SILENCE_RMS = 2e-4;          // 低于该 RMS 视为静音（约 -74 dBFS）
  var ONE_SIDED_RATIO = 0.12;      // 一侧 RMS 不足另一侧的 12% → 单边有声
  var CANCEL_FOLD_DB = -6;         // 折叠损失超过 6 dB → 抵消
  var CANCEL_CORR = -0.55;         // 或相关度低于 -0.55 → 抵消
  var WINDOW_MS = 93;              // 分析窗长（约 1/11 秒，48k 下约 4464 帧）

  /**
   * 窗级扫描并合并相邻同类窗为段落。
   * 返回段落数组：
   *  { kind: 'silence'|'one-sided'|'cancel',
   *    startFrame,endFrame,startSec,endSec,minCorr,maxFoldLossDb }
   */
  function scanSegments(left, right, sampleRate, opts) {
    opts = opts || {};
    var winMs = opts.windowMs || WINDOW_MS;
    var win = Math.max(64, Math.round(sampleRate * winMs / 1000));
    var n = Math.min(left.length, right.length);
    var mono = DSP.foldMono(left, right);
    var labels = new Array(Math.ceil(n / win));

    for (var w = 0, off = 0; off < n; w++, off += win) {
      var end = Math.min(off + win, n);
      var rL = DSP.rms(left, off, end);
      var rR = DSP.rms(right, off, end);
      var rM = DSP.rms(mono, off, end);
      var ref = (rL + rR) * 0.5;
      var corr = DSP.correlation(left, right, off, end);
      var foldDb = ref > SILENCE_RMS ? DSP.toDb(rM) - DSP.toDb(ref) : 0;

      var kind;
      if (rL < SILENCE_RMS && rR < SILENCE_RMS) {
        kind = 'silence';
      } else if (rL < SILENCE_RMS || rR < SILENCE_RMS ||
                 (rL > SILENCE_RMS && rR > SILENCE_RMS &&
                  (rL / rR < ONE_SIDED_RATIO || rR / rL < ONE_SIDED_RATIO))) {
        kind = 'one-sided';
      } else if (foldDb <= CANCEL_FOLD_DB || (corr !== null && corr <= CANCEL_CORR)) {
        kind = 'cancel';
      } else {
        kind = 'ok';
      }
      labels[w] = {
        kind: kind,
        off: off,
        end: end,
        corr: corr,
        foldDb: foldDb,
      };
    }

    // 合并相邻同类窗（ok 不产出段落）
    var segments = [];
    var cur = null;
    labels.forEach(function (lab) {
      if (lab.kind === 'ok') {
        if (cur) { segments.push(cur); cur = null; }
        return;
      }
      if (cur && cur.kind === lab.kind) {
        cur.endFrame = lab.end;
        if (lab.corr !== null && (cur.minCorr === null || lab.corr < cur.minCorr)) {
          cur.minCorr = lab.corr;
        }
        if (lab.foldDb < cur.maxFoldLossDb) cur.maxFoldLossDb = lab.foldDb;
      } else {
        if (cur) segments.push(cur);
        cur = {
          kind: lab.kind,
          startFrame: lab.off,
          endFrame: lab.end,
          minCorr: lab.corr,
          maxFoldLossDb: lab.foldDb,
        };
      }
    });
    if (cur) segments.push(cur);

    segments.forEach(function (seg) {
      seg.startSec = seg.startFrame / sampleRate;
      seg.endSec = seg.endFrame / sampleRate;
    });
    // 折叠损失最大的排前面，静音/单边按时间排
    segments.sort(function (a, b) {
      var rank = { cancel: 0, 'one-sided': 1, silence: 2 };
      if (rank[a.kind] !== rank[b.kind]) return rank[a.kind] - rank[b.kind];
      if (a.kind === 'cancel') return a.maxFoldLossDb - b.maxFoldLossDb;
      return a.startFrame - b.startFrame;
    });
    return segments;
  }

  /** 全局状态：整段是否静音、是否单边有声，供横幅与实时表桥提示使用 */
  function globalState(left, right) {
    var rL = DSP.rms(left);
    var rR = DSP.rms(right);
    if (rL < SILENCE_RMS && rR < SILENCE_RMS) {
      return { state: 'silence', rmsL: rL, rmsR: rR };
    }
    if (rL < SILENCE_RMS || rR < SILENCE_RMS ||
        (rL > SILENCE_RMS && rR > SILENCE_RMS &&
         (rL / rR < ONE_SIDED_RATIO || rR / rL < ONE_SIDED_RATIO))) {
      return {
        state: 'one-sided',
        rmsL: rL,
        rmsR: rR,
        side: rL >= rR ? 'L' : 'R',
      };
    }
    return { state: 'ok', rmsL: rL, rmsR: rR };
  }

  /** 区分“整体变小”与“某频带消失”的判定文案 */
  function foldVerdict(bandResult) {
    var names = [
      { key: 'low', label: '低频' },
      { key: 'mid', label: '中频' },
      { key: 'high', label: '高频' },
    ];
    var bandLosses = names.map(function (b) {
      return { label: b.label, foldDb: bandResult[b.key].foldDb, corr: bandResult[b.key].corr };
    });
    var vanished = bandLosses.filter(function (b) { return b.foldDb !== null && b.foldDb <= -12; });
    var allLost = bandLosses.filter(function (b) { return b.foldDb !== null && b.foldDb <= -6; });
    if (vanished.length > 0 && vanished.length < 3) {
      return {
        level: 'danger',
        text: '局部频带消失：' + vanished.map(function (b) {
          return b.label + '（折叠损失 ' + b.foldDb.toFixed(1) + ' dB）';
        }).join('、') + '。这是频带级抵消，不是整体音量变小。',
      };
    }
    if (allLost.length === 3) {
      return {
        level: 'warn',
        text: '三个频带同时明显变小（均超过 6 dB），属于折叠后整体变小，而非某个频带单独消失。',
      };
    }
    return { level: 'info', text: '未发现频带级消失；各频带折叠损失均在正常范围。' };
  }

  return {
    scanSegments: scanSegments,
    globalState: globalState,
    foldVerdict: foldVerdict,
    thresholds: {
      SILENCE_RMS: SILENCE_RMS,
      ONE_SIDED_RATIO: ONE_SIDED_RATIO,
      CANCEL_FOLD_DB: CANCEL_FOLD_DB,
      CANCEL_CORR: CANCEL_CORR,
    },
  };
});
