/* 导入与清洗：
   - 分类完整一圈 / 漏检查点 / 逆向 / 中途退出
   - 区分"可插值位置"（短缺失）与"无证据位置"（长缺失）
   - 标记明显倒退（速度超限或弧长倒退），不把异常点当作证据
   - 检查点通过时间：硬件触发优先；无触发时只有在单条证据链内才允许插值 */
(function (global) {
  "use strict";

  const STATUS = {
    complete: { key: "complete", label: "完整一圈", cls: "ok" },
    missing_checkpoint: { key: "missing_checkpoint", label: "漏检查点", cls: "critical" },
    reverse: { key: "reverse", label: "逆向行驶", cls: "warning" },
    aborted: { key: "aborted", label: "中途退出", cls: "warning" },
    invalid: { key: "invalid", label: "数据不足", cls: "critical" },
  };

  function fmtMs(ms) {
    if (ms === null || ms === undefined) return "—";
    return (ms / 1000).toFixed(2) + " s";
  }

  function importRun(track, raw) {
    const vMax = track.vMax;
    const maxGap = track.maxInterpGap * 1000;

    // 1) 基础采样，按时间排序
    const rawSamples = (raw.samples || []).slice().sort(function (a, b) {
      return a.t - b.t;
    }).map(function (q) {
      return { t: q.t, s: q.s, x: q.x, y: q.y, flags: {} };
    });

    // 2) 逐样本判定：倒退 / 动力学不可能的跳变 / 正常
    for (let i = 0; i < rawSamples.length; i++) {
      const q = rawSamples[i];
      if (i === 0) { q.flags.start = true; continue; }
      const p = rawSamples[i - 1];
      const dt = q.t - p.t;
      const ds = q.s - p.s;
      q.ds = ds;
      q.dt = dt;
      q.v = dt > 0 ? ds / dt * 1000 : null;
      if (ds < -2.0) {
        q.flags.backward = true;          // 明显倒退
      } else if (dt > 0 && Math.abs(ds) / dt * 1000 > vMax) {
        q.flags.implausible = true;       // 跳变：超过可信速度上限
      }
    }

    // 3) 时间缺失分级。短缺失：允许线性插值；长缺失：无证据
    const gaps = [];
    for (let i = 1; i < rawSamples.length; i++) {
      const p = rawSamples[i - 1], q = rawSamples[i];
      const dt = q.t - p.t;
      if (dt > 1500) {
        const g = {
          t0: p.t, t1: q.t,
          s0: p.s, s1: q.s,
          durationMs: dt,
          interpolable: dt <= maxGap && !p.flags.backward && !q.flags.backward
            && !p.flags.implausible && !q.flags.implausible,
        };
        gaps.push(g);
      }
    }

    // 4) 证据链：异常点与长缺失切断证据链；短缺失不切断（可插值）
    const chains = [];
    let cur = [];
    const longGapStarts = new Set();
    gaps.forEach(function (g) {
      if (!g.interpolable) longGapStarts.add(g.t0);
    });
    for (let i = 0; i < rawSamples.length; i++) {
      const q = rawSamples[i];
      const bad = q.flags.backward || q.flags.implausible;
      if (bad) {
        if (cur.length) chains.push(cur);
        cur = [];
        continue;
      }
      if (i > 0 && longGapStarts.has(rawSamples[i - 1].t)) {
        if (cur.length) chains.push(cur);
        cur = [];
      }
      cur.push(q);
    }
    if (cur.length) chains.push(cur);

    // 5) 运行级分类
    const finishCp = track.checkpoints[track.checkpoints.length - 1];
    const triggers = {};
    (raw.checkpoints || []).forEach(function (c) { triggers[c.id] = c.t; });
    const maxS = rawSamples.reduce(function (m, q) { return Math.max(m, q.s); }, 0);
    const minS = rawSamples.reduce(function (m, q) { return Math.min(m, q.s); }, Infinity);
    const backwardSteps = rawSamples.filter(function (q) { return q.flags.backward; }).length;
    const hasImplausible = rawSamples.some(function (q) { return q.flags.implausible; });
    const monotoneDown = rawSamples.length > 5 &&
      rawSamples.filter(function (q) { return q.ds !== undefined && q.ds < 0; }).length
      > rawSamples.length * 0.6 && minS < maxS - 500;

    // 超限跳变只有在"跨过了未触发的检查点"时才构成漏检查点；
    // 孤立异常点（如倒退后的补偿跳变）不改变完整状态，只在统计中留痕。
    const skippedCp = rawSamples.some(function (q, i) {
      if (!q.flags.implausible || i === 0) return false;
      const prev = rawSamples[i - 1];
      return track.checkpoints.some(function (cp) {
        return cp.s > prev.s && cp.s < q.s && triggers[cp.id] === undefined;
      });
    });
    const allTriggered = track.checkpoints.slice(1).every(function (cp) {
      return triggers[cp.id] !== undefined;
    });

    let statusKey;
    if (rawSamples.length < 3) {
      statusKey = "invalid";
    } else if (monotoneDown) {
      statusKey = "reverse";
    } else if (maxS < finishCp.s - 150) {
      statusKey = "aborted";
    } else if (!allTriggered || skippedCp) {
      statusKey = "missing_checkpoint";
    } else {
      statusKey = "complete";
    }

    // 6) 检查点通过时间与证据等级
    const cpResults = track.checkpoints.map(function (cp, idx) {
      const res = {
        id: cp.id, name: cp.name, s: cp.s, index: idx,
        t: null, evidence: null, detail: "",
      };
      if (idx === 0) { res.evidence = "line"; res.t = 0; res.detail = "起点线 t=0"; return res; }
      if (triggers[cp.id] !== undefined) {
        res.t = triggers[cp.id];
        res.evidence = "trigger";
        res.detail = "硬件触发记录";
        return res;
      }
      if (statusKey === "reverse") {
        res.evidence = "none";
        res.detail = "逆向运行，不计算检查点通过时间";
        return res;
      }
      // 无触发：仅当检查点被一条证据链完整跨过才允许插值
      const chain = chains.find(function (ch) {
        return ch[0].s <= cp.s && ch[ch.length - 1].s >= cp.s;
      });
      if (chain) {
        for (let i = 1; i < chain.length; i++) {
          const a = chain[i - 1], b = chain[i];
          if (a.s <= cp.s && b.s >= cp.s) {
            const f = (cp.s - a.s) / Math.max(b.s - a.s, 1e-9);
            res.t = a.t + f * (b.t - a.t);
            res.evidence = "interpolated";
            res.detail = "无触发，证据链内线性插值";
            return res;
          }
        }
      }
      res.evidence = "none";
      res.detail = "无触发且落在无证据区间，不补时间";
      return res;
    });

    // 7) 统计（未知绝不参与最快/最大等极值）
    const isReverse = statusKey === "reverse";
    const goodSamples = rawSamples.filter(function (q) {
      return !q.flags.implausible && (!q.flags.backward || isReverse);
    });
    const maxSpeed = goodSamples.reduce(function (m, q) {
      const v = q.v === null ? null : (isReverse ? Math.abs(q.v) : q.v);
      return v !== null && v > 0 ? Math.max(m, v) : m;
    }, 0);
    const durationMs = rawSamples.length ? rawSamples[rawSamples.length - 1].t : 0;
    const spanMs = Math.max(1, durationMs);
    let unknownMs = 0;
    // 长缺失在任何运行里都是无证据；逆向运行的"倒退"是行驶方向而非定位异常，不计入未知
    gaps.filter(function (g) { return !g.interpolable; }).forEach(function (g) {
      unknownMs += g.durationMs;
    });
    if (!isReverse) {
      // 异常点本身按一个采样间隔折算为未知
      rawSamples.forEach(function (q) {
        if (q.flags.backward || q.flags.implausible) unknownMs += q.dt || 250;
      });
    }

    const segStats = track.segments().map(function (seg) {
      const segGaps = gaps.filter(function (g) {
        return g.s0 < seg.s1 && g.s1 > seg.s0;
      });
      return {
        index: seg.index,
        interpolableGaps: segGaps.filter(function (g) { return g.interpolable; }).length,
        longGaps: segGaps.filter(function (g) { return !g.interpolable; }).length,
        hasUnknown: segGaps.some(function (g) { return !g.interpolable; }),
      };
    });

    return {
      raw: raw,
      runId: raw.runId,
      label: raw.label || raw.runId,
      notes: raw.notes || "",
      sampleRateHz: raw.sampleRateHz,
      status: STATUS[statusKey],
      samples: rawSamples,
      gaps: gaps,
      chains: chains,
      checkpoints: cpResults,
      stats: {
        sampleCount: rawSamples.length,
        durationMs: durationMs,
        maxObservedSpeed: maxSpeed,
        evidenceCoverage: Math.max(0, 1 - unknownMs / spanMs),
        unknownMs: unknownMs,
        backwardSteps: backwardSteps,
        implausibleSteps: rawSamples.filter(function (q) { return q.flags.implausible; }).length,
        segmentStats: segStats,
        maxS: maxS,
      },
    };
  }

  /* 播放/图表用：给定比赛时刻，返回位置与证据状态。
     kind: observed | interpolated | unknown | outside */
  function positionAt(run, tMs) {
    const s = run.samples;
    if (!s.length) return { kind: "outside", s: null, t: tMs };
    if (tMs < s[0].t) return { kind: "outside", s: null, t: tMs };
    const last = s[s.length - 1];
    if (tMs > last.t) return { kind: "outside", s: last.s, t: tMs, ended: true };

    let lo = 0, hi = s.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid].t < tMs) lo = mid + 1; else hi = mid;
    }
    const b = s[lo], a = s[lo - 1];
    if (!a) return { kind: b.flags.backward || b.flags.implausible ? "unknown" : "observed", s: b.s, t: tMs };
    const f = (tMs - a.t) / Math.max(b.t - a.t, 1);

    if (b.flags.backward || b.flags.implausible || a.flags.backward || a.flags.implausible) {
      return { kind: "unknown", s: null, t: tMs,
        detail: b.flags.backward || a.flags.backward ? "明显倒退，位置无证据" : "速度超限跳变，位置无证据" };
    }
    const gap = run.gaps.find(function (g) { return g.t0 === a.t && g.t1 === b.t; });
    if (gap) {
      if (gap.interpolable) {
        return { kind: "interpolated", s: a.s + f * (b.s - a.s), t: tMs,
          detail: "短缺失线性插值（" + (gap.durationMs / 1000).toFixed(1) + " s）" };
      }
      return { kind: "unknown", s: null, t: tMs,
        detail: "长缺失 " + (gap.durationMs / 1000).toFixed(1) + " s，无证据位置" };
    }
    return { kind: "observed", s: a.s + f * (b.s - a.s), t: tMs };
  }

  /* 按路线进度对齐：给定 s，返回该趟通过该 s 的时刻（同样区分证据等级） */
  function timeAtS(run, targetS) {
    const chain = run.chains.find(function (ch) {
      return ch[0].s <= targetS && ch[ch.length - 1].s >= targetS;
    });
    if (!chain) return { kind: "unknown", t: null };
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1], b = chain[i];
      if (a.s <= targetS && b.s >= targetS) {
        const f = (targetS - a.s) / Math.max(b.s - a.s, 1e-9);
        const t = a.t + f * (b.t - a.t);
        const gap = run.gaps.find(function (g) { return g.t0 === a.t && g.t1 === b.t; });
        return {
          kind: gap ? (gap.interpolable ? "interpolated" : "unknown") : "observed",
          t: t,
        };
      }
    }
    return { kind: "unknown", t: null };
  }

  global.GhostImport = {
    STATUS: STATUS,
    importRun: importRun,
    positionAt: positionAt,
    timeAtS: timeAtS,
    fmtMs: fmtMs,
  };
})(window);
