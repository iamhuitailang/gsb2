/* 差距分析：以基准趟为参照计算累计/分段差距与领先路段。
   任何无证据的检查点都输出 unknown，绝不参与最快段等极值统计。 */
(function (global) {
  "use strict";

  const IMP = global.GhostImport;

  function cpTime(run, cpId) {
    const cp = run.checkpoints.find(function (c) { return c.id === cpId; });
    if (!cp || cp.t === null) return { t: null, evidence: cp ? cp.evidence : "none" };
    return { t: cp.t, evidence: cp.evidence };
  }

  /* 逐检查点累计差距 + 分段差距。delta > 0 表示 comparison 比 baseline 慢。 */
  function buildDeltas(track, baseline, comparison) {
    const rows = [];
    let prev = { baseT: 0, compT: 0, cumKnown: true };
    track.checkpoints.forEach(function (cp, idx) {
      const b = cpTime(baseline, cp.id);
      const c = cpTime(comparison, cp.id);
      let cum = null, seg = null, segKnown = false, cumKnown = false;
      if (b.t !== null && c.t !== null) {
        cum = c.t - b.t;
        cumKnown = true;
      }
      if (cumKnown && prev.cumKnown) {
        seg = cum - (prev.compT - prev.baseT);
        segKnown = true;
      }
      rows.push({
        index: idx,
        cp: cp,
        baseline: b,
        comparison: c,
        cumDelta: cum,
        segDelta: seg,
        segKnown: segKnown,
        cumKnown: cumKnown,
      });
      if (cumKnown) prev = { baseT: b.t, compT: c.t, cumKnown: true };
    });
    return rows;
  }

  /* 领先路段（按弧长采样，证据链之外标 unknown）。
     返回 [{s0,s1,leader:'baseline'|'comparison'|'unknown'}] */
  function leaderProfile(track, baseline, comparison, stepM) {
    stepM = stepM || 25;
    const out = [];
    let cur = null;
    for (let s = 0; s <= track.length + 0.01; s += stepM) {
      const sb = Math.min(s, track.length);
      const tb = IMP.timeAtS(baseline, sb);
      const tc = IMP.timeAtS(comparison, sb);
      let leader = "unknown";
      if (tb.kind !== "unknown" && tc.kind !== "unknown" && tb.t !== null && tc.t !== null) {
        leader = tc.t < tb.t ? "comparison" : (tc.t > tb.t ? "baseline" : "tie");
      }
      if (!cur || cur.leader !== leader) {
        if (cur) cur.s1 = sb;
        cur = { s0: sb, s1: track.length, leader: leader };
        out.push(cur);
      }
    }
    if (cur) cur.s1 = track.length;
    return out;
  }

  /* 沿弧长的差距曲线（用于差距图），每 10m 一个点，带证据标记 */
  function deltaCurve(track, baseline, comparison) {
    const pts = [];
    for (let s = 0; s <= track.length + 0.01; s += 10) {
      const tb = IMP.timeAtS(baseline, Math.min(s, track.length));
      const tc = IMP.timeAtS(comparison, Math.min(s, track.length));
      pts.push({
        s: Math.min(s, track.length),
        delta: (tb.t !== null && tc.t !== null) ? tc.t - tb.t : null,
        kind: (tb.kind === "unknown" || tc.kind === "unknown") ? "unknown"
          : (tb.kind === "interpolated" || tc.kind === "interpolated") ? "interpolated"
          : "observed",
      });
    }
    return pts;
  }

  /* 分段汇总表（供 UI 表格与导出共用） */
  function segmentTable(track, baseline, comparison, deltas) {
    return track.segments().map(function (seg) {
      const rowB = deltas[seg.index + 1];
      const rowA = deltas[seg.index];
      let segDelta = null;
      if (rowA && rowB && rowA.cumKnown && rowB.cumKnown) {
        segDelta = rowB.cumDelta - rowA.cumDelta;
      }
      const bSeg = baseline.stats.segmentStats[seg.index];
      const cSeg = comparison.stats.segmentStats[seg.index];
      return {
        index: seg.index,
        name: seg.name,
        length: seg.length,
        segDelta: segDelta,
        baselineUnknown: bSeg ? bSeg.hasUnknown : false,
        comparisonUnknown: cSeg ? cSeg.hasUnknown : false,
        baselineEvidence: rowA && rowB ? rowB.baseline.evidence : "none",
        comparisonEvidence: rowA && rowB ? rowB.comparison.evidence : "none",
      };
    });
  }

  /* 最快分段排名：含未知的分段直接排除，不把未知补成最快 */
  function fastestSegments(run, deltas) {
    const cps = run.checkpoints;
    const out = [];
    for (let i = 1; i < cps.length; i++) {
      const a = cps[i - 1], b = cps[i];
      const segStat = run.stats.segmentStats[i - 1];
      if (a.t === null || b.t === null || segStat.hasUnknown) continue;
      out.push({ index: i - 1, duration: b.t - a.t, name:
        run.raw.runId + " 段" + (i) });
    }
    return out.sort(function (a, b) { return a.duration - b.duration; });
  }

  function exportCsv(track, baseline, comparison, deltas) {
    const header = [
      "检查点", "弧长m",
      "基准时间ms(" + baseline.runId + ")", "基准证据",
      "对照时间ms(" + comparison.runId + ")", "对照证据",
      "累计差距ms(对照-基准)", "分段差距ms",
    ];
    const lines = [header.join(",")];
    let prevCum = 0;
    deltas.forEach(function (r) {
      const cum = r.cumKnown ? r.cumDelta : "";
      const seg = r.segKnown ? r.segDelta : "";
      lines.push([
        r.cp.name, r.cp.s,
        r.baseline.t === null ? "" : r.baseline.t, r.baseline.evidence,
        r.comparison.t === null ? "" : r.comparison.t, r.comparison.evidence,
        cum, seg,
      ].join(","));
      if (r.cumKnown) prevCum = r.cumDelta;
    });
    // UTF-8 BOM，Excel 直接打开不乱码
    return "﻿" + lines.join("\n");
  }

  /* 审计说明：基准切换后复查某段是怎么算出来的 */
  function auditSegment(track, baseline, comparison, segIndex, deltas) {
    const cpA = track.checkpoints[segIndex];
    const cpB = track.checkpoints[segIndex + 1];
    const rA = deltas[segIndex];
    const rB = deltas[segIndex + 1];
    const steps = [];
    steps.push("基准趟：" + baseline.label + "；对照趟：" + comparison.label);
    steps.push("分段：" + cpA.name + " → " + cpB.name +
      "（" + cpA.s + "m → " + cpB.s + "m，长 " + (cpB.s - cpA.s) + "m）");
    steps.push("基准端：" + evidenceText(rA.baseline) + " → " + evidenceText(rB.baseline));
    steps.push("对照端：" + evidenceText(rA.comparison) + " → " + evidenceText(rB.comparison));
    if (rA.cumKnown && rB.cumKnown) {
      steps.push("累计差距 " + fmt(rA.cumDelta) + " → " + fmt(rB.cumDelta));
      steps.push("分段差距 = " + fmt(rB.cumDelta) + " − (" + fmt(rA.cumDelta) + ") = " +
        fmt(rB.cumDelta - rA.cumDelta) +
        (rB.cumDelta - rA.cumDelta > 0 ? "（对照慢）" : "（对照快）"));
    } else {
      steps.push("存在无证据检查点，该段差距标记为未知，不参与任何极值统计。");
    }
    const bSeg = baseline.stats.segmentStats[segIndex];
    const cSeg = comparison.stats.segmentStats[segIndex];
    if (bSeg && (bSeg.longGaps || bSeg.interpolableGaps)) {
      steps.push("基准该段：长缺失 " + bSeg.longGaps + " 处、可插值短缺失 " +
        bSeg.interpolableGaps + " 处");
    }
    if (cSeg && (cSeg.longGaps || cSeg.interpolableGaps)) {
      steps.push("对照该段：长缺失 " + cSeg.longGaps + " 处、可插值短缺失 " +
        cSeg.interpolableGaps + " 处");
    }
    return steps;
  }

  function evidenceText(ev) {
    const map = {
      trigger: "硬件触发 " + IMP.fmtMs(ev.t),
      interpolated: "链内插值 " + IMP.fmtMs(ev.t),
      line: "起点线 0.00 s",
      none: "无证据（时间未知）",
    };
    return map[ev.evidence] || ev.evidence;
  }

  function fmt(ms) { return (ms / 1000).toFixed(3) + " s"; }

  global.GhostAnalysis = {
    buildDeltas: buildDeltas,
    leaderProfile: leaderProfile,
    deltaCurve: deltaCurve,
    segmentTable: segmentTable,
    fastestSegments: fastestSegments,
    exportCsv: exportCsv,
    auditSegment: auditSegment,
  };
})(window);
