/* 页面主控：选趟、基准切换、播放（比赛时间 / 路线进度对齐）、
   分段回放、检查点差距表、审计、CSV 导出、本地记录导入。 */
(function () {
  "use strict";

  const IMP = window.GhostImport;
  const ANA = window.GhostAnalysis;
  const $ = function (sel) { return document.querySelector(sel); };
  const el = function (tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const state = {
    track: null,
    runs: [],            // 已导入并清洗的运行
    selected: [null, null],
    baselineIdx: 0,      // 两趟中的哪一个是基准
    mode: "race",        // race | progress
    playing: false,
    speed: 1,
    cursor: 0,           // race 模式：比赛毫秒；progress 模式：弧长 s
    replaySeg: null,     // 分段回放状态
    raf: null,
    lastWall: 0,
    chartSyncS: null,
  };

  function init(bundle) {
    state.track = new window.GhostTrack(bundle.track);
    state.runs = bundle.runs.map(function (r) {
      return IMP.importRun(state.track, r);
    });
    buildRunPicker();
    buildMapAndCharts();
    bindControls();
    // 默认选 A、B 两趟，A 为基准
    pickRun(0, 0);
    pickRun(1, 1);
    refreshAll();
  }

  /* ---------- 选趟 ---------- */
  function buildRunPicker() {
    const host = $("#run-picker");
    host.innerHTML = "";
    state.runs.forEach(function (run, idx) {
      const card = el("div", "run-card");
      card.dataset.idx = idx;
      const head = el("div", "run-card-head");
      const name = el("span", "run-name", run.label);
      const badge = el("span", "badge badge-" + run.status.cls, run.status.label);
      head.appendChild(name); head.appendChild(badge);
      card.appendChild(head);

      const meta = el("div", "run-meta");
      meta.textContent = run.samples.length + " 个采样 · " +
        (run.sampleRateHz || "?") + "Hz · 证据覆盖 " +
        (run.stats.evidenceCoverage * 100).toFixed(1) + "%";
      card.appendChild(meta);
      if (run.notes) card.appendChild(el("div", "run-notes", run.notes));

      const btns = el("div", "run-card-btns");
      [0, 1].forEach(function (slot) {
        const b = el("button", "btn btn-small", slot === 0 ? "设为趟 1" : "设为趟 2");
        b.addEventListener("click", function () { pickRun(slot, idx); refreshAll(); });
        b.dataset.slot = slot;
        btns.appendChild(b);
      });
      card.appendChild(btns);
      host.appendChild(card);
    });
  }

  function pickRun(slot, idx) {
    state.selected[slot] = idx;
    document.querySelectorAll(".run-card").forEach(function (card) {
      const i = Number(card.dataset.idx);
      card.classList.toggle("selected-0", state.selected[0] === i);
      card.classList.toggle("selected-1", state.selected[1] === i);
      card.querySelectorAll("button").forEach(function (b) {
        b.classList.toggle("btn-active",
          state.selected[Number(b.dataset.slot)] === i);
      });
    });
  }

  function activeRuns() {
    return state.selected.map(function (idx) {
      return idx === null ? null : state.runs[idx];
    });
  }
  function roles() {
    const [r0, r1] = activeRuns();
    if (state.baselineIdx === 0) return { baseline: r0, comparison: r1 };
    return { baseline: r1, comparison: r0 };
  }

  /* ---------- 地图与图表 ---------- */
  function buildMapAndCharts() {
    state.map = new window.GhostMap($("#map"), state.track);
    state.map.onSegmentClick = function (segIdx) { startSegmentReplay(segIdx); };
    state.deltaChart = new window.GhostChart($("#delta-chart"), {
      xLabel: "路线进度（弧长 m）",
      yLabel: "累计差距（s，正=对照慢）",
      zeroLine: true,
      tipHtml: function (s, rows) {
        const r = rows[0];
        if (!r) return "s=" + s.toFixed(0) + "m";
        const v = r.p.y === null ? "未知（无证据）" : (r.p.y / 1000).toFixed(2) + " s";
        return "s=" + s.toFixed(0) + "m<br>" + r.name + "：" + v +
          "<br><span class='tip-kind'>证据：" + kindText(r.p.kind) + "</span>";
      },
    });
    state.deltaChart.onHover = function (s) {
      state.chartSyncS = s;
      if (state.mode === "progress" && s !== null) {
        state.cursor = s;
        renderFrame();
      }
    };
    state.timeChart = new window.GhostChart($("#time-chart"), {
      xLabel: "路线进度（弧长 m）",
      yLabel: "圈内时间（s）",
      zeroLine: false,
      tipHtml: function (s, rows) {
        return "s=" + s.toFixed(0) + "m" + rows.map(function (r) {
          const v = r.p.y === null ? "未知" : (r.p.y / 1000).toFixed(2) + " s";
          return "<br><span class='dot dot-" + r.role + "'></span>" +
            r.name + "：" + v + "（" + kindText(r.p.kind) + "）";
        }).join("");
      },
    });
    state.timeChart.onHover = state.deltaChart.onHover;
  }

  function kindText(k) {
    return { observed: "实测", interpolated: "插值", unknown: "无证据" }[k] || k;
  }

  /* ---------- 控件 ---------- */
  function bindControls() {
    $("#play").addEventListener("click", togglePlay);
    $("#reset").addEventListener("click", function () { stopPlay(); resetCursor(); renderFrame(); });
    document.querySelectorAll("[data-speed]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.speed = Number(b.dataset.speed);
        document.querySelectorAll("[data-speed]").forEach(function (x) {
          x.classList.toggle("btn-active", x === b);
        });
      });
    });
    document.querySelectorAll("[data-mode]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.mode = b.dataset.mode;
        document.querySelectorAll("[data-mode]").forEach(function (x) {
          x.classList.toggle("btn-active", x === b);
        });
        stopPlay(); resetCursor();
        $("#cursor-label").textContent = state.mode === "race" ? "比赛时间" : "路线进度";
        renderFrame();
      });
    });
    $("#baseline-toggle").addEventListener("click", function () {
      state.baselineIdx = 1 - state.baselineIdx;
      refreshAll();
    });
    $("#export-csv").addEventListener("click", exportCsv);
    $("#import-file").addEventListener("change", importFiles);
    $("#replay-exit").addEventListener("click", cancelReplay);
    $("#scrub").addEventListener("input", function (e) {
      stopPlay();
      state.cursor = Number(e.target.value);
      renderFrame();
    });
  }

  function resetCursor() {
    state.cursor = state.mode === "race" ? 0 : 0;
    state.replaySeg = null;
    $("#replay-bar").classList.add("hidden");
    state.map.highlightSegment(-1);
    updateScrub();
  }

  function togglePlay() {
    if (state.playing) { stopPlay(); return; }
    const [a, b] = activeRuns();
    if (!a || !b) return;
    state.playing = true;
    $("#play").textContent = "暂停";
    state.lastWall = performance.now();
    tick();
  }
  function stopPlay() {
    state.playing = false;
    $("#play").textContent = "播放";
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
  }

  function tick() {
    if (!state.playing) return;
    const now = performance.now();
    const wall = now - state.lastWall;
    state.lastWall = now;
    const [a, b] = activeRuns();
    if (state.mode === "race") {
      state.cursor += wall * state.speed;
      const end = Math.max(durationOf(a), durationOf(b));
      if (state.cursor >= end) { state.cursor = end; stopPlay(); }
    } else {
      state.cursor += (wall / 1000) * state.speed * (state.track.length / 60);
      if (state.cursor >= state.track.length) {
        state.cursor = state.track.length; stopPlay();
      }
    }
    if (state.replaySeg) {
      if (state.cursor > state.replaySeg.s1) { stopPlay(); }
    }
    updateScrub();
    renderFrame();
    state.raf = requestAnimationFrame(tick);
  }

  function durationOf(run) {
    return run && run.samples.length ? run.samples[run.samples.length - 1].t : 0;
  }

  function updateScrub() {
    const scrub = $("#scrub");
    if (state.mode === "race") {
      const [a, b] = activeRuns();
      const end = Math.max(durationOf(a), durationOf(b), 1);
      scrub.max = end;
    } else {
      scrub.max = state.track.length;
    }
    scrub.value = state.cursor;
    $("#cursor-value").textContent = state.mode === "race"
      ? (state.cursor / 1000).toFixed(2) + " s"
      : state.cursor.toFixed(0) + " m";
  }

  /* ---------- 分段回放 ---------- */
  function startSegmentReplay(segIdx) {
    cancelReplay();
    const seg = state.track.segments()[segIdx];
    state.map.highlightSegment(segIdx);
    $("#replay-bar").classList.remove("hidden");
    $("#replay-title").textContent = "回放段 " + (segIdx + 1) + "：" + seg.name;
    state.replaySeg = { index: segIdx, s0: seg.s0, s1: seg.s1 };
    state.mode = "progress";
    document.querySelectorAll("[data-mode]").forEach(function (x) {
      x.classList.toggle("btn-active", x.dataset.mode === "progress");
    });
    state.cursor = seg.s0;
    stopPlay();
    updateScrub();
    renderFrame();
    togglePlay();
  }
  function cancelReplay() {
    state.replaySeg = null;
    $("#replay-bar").classList.add("hidden");
    state.map.highlightSegment(-1);
  }

  /* ---------- 渲染 ---------- */
  function refreshAll() {
    const [a, b] = activeRuns();
    if (!a || !b) { $("#hint-empty").classList.remove("hidden"); return; }
    $("#hint-empty").classList.add("hidden");
    const { baseline, comparison } = roles();
    $("#baseline-label").textContent =
      "当前基准：" + baseline.label + "（点击右侧按钮切换）";

    const deltas = ANA.buildDeltas(state.track, baseline, comparison);
    state.deltas = deltas;
    renderStatusCards();
    renderCheckpointTable(deltas, baseline, comparison);
    renderCharts(baseline, comparison);
    renderLeaders(baseline, comparison);
    renderStats(baseline, comparison, deltas);
    resetCursor();
    renderFrame();
  }

  function renderStatusCards() {
    document.querySelectorAll(".run-card").forEach(function (card) {
      const i = Number(card.dataset.idx);
      const run = state.runs[i];
      card.classList.toggle("is-baseline",
        state.selected[state.baselineIdx] === i);
    });
  }

  function renderFrame() {
    const [a, b] = activeRuns();
    if (!a || !b) return;
    const roles0 = roles();
    const map = state.map;
    map.resetTrails();

    [["baseline", roles0.baseline], ["comparison", roles0.comparison]]
      .forEach(function (pair) {
        const role = pair[0], run = pair[1];
        let pos;
        if (state.mode === "race") {
          pos = IMP.positionAt(run, state.cursor);
          map.updateTrail(role, run, state.cursor);
        } else {
          const tt = IMP.timeAtS(run, state.cursor);
          pos = { kind: tt.kind, s: state.cursor, t: tt.t };
        }
        map.updateMarker(role, pos, role === "baseline" ? "基准" : "对照");
        renderReadout(role, run, pos);
      });
    updateScrub();
  }

  function renderReadout(role, run, pos) {
    const host = $("#readout-" + role);
    const segIdx = pos.s !== null && pos.s !== undefined
      ? state.track.segmentIndexAt(pos.s) : null;
    const segName = segIdx === null || segIdx < 0 ? "—"
      : "段" + (segIdx + 1);
    host.innerHTML = "";
    host.appendChild(el("div", "readout-title",
      (role === "baseline" ? "基准 · " : "对照 · ") + run.label));
    const line1 = el("div", "readout-line");
    line1.appendChild(el("span", null, "位置："));
    const posSpan = el("span", "pos-" + pos.kind,
      pos.s === null || pos.s === undefined ? "无证据" : pos.s.toFixed(1) + "m");
    line1.appendChild(posSpan);
    line1.appendChild(el("span", "readout-seg", segName));
    host.appendChild(line1);
    host.appendChild(el("div", "readout-kind kind-" + pos.kind,
      kindText(pos.kind) + (pos.detail ? "：" + pos.detail : "")));
  }

  function renderCharts(baseline, comparison) {
    const track = state.track;
    const dc = ANA.deltaCurve(track, baseline, comparison);
    const xTicks = track.checkpoints.map(function (cp) { return cp.s; });
    const dVals = dc.map(function (p) { return p.delta; }).filter(function (v) { return v !== null; });
    const dMax = Math.max(1, Math.max.apply(null, dVals.map(Math.abs).concat([1])));
    const yTicksD = [-dMax, 0, dMax].map(function (v) { return Math.round(v); });
    state.deltaChart.setData(
      [{ name: "对照−基准", role: "delta", points: dc.map(function (p) {
        return { x: p.s, y: p.delta, kind: p.kind };
      }) }],
      xTicks, yTicksD,
      function (v) { return v.toFixed(0); },
      function (v) { return (v / 1000).toFixed(1); });

    const mk = function (run, role) {
      const pts = [];
      for (let s = 0; s <= track.length + 0.01; s += 10) {
        const tt = IMP.timeAtS(run, Math.min(s, track.length));
        pts.push({ x: Math.min(s, track.length),
          y: tt.t === null ? null : tt.t, kind: tt.kind });
      }
      return { name: run.runId, role: role, points: pts };
    };
    const tMax = Math.max(durationOf(baseline), durationOf(comparison));
    const yTicksT = [0, Math.round(tMax / 2 / 1000) * 1000, tMax];
    state.timeChart.setData(
      [mk(baseline, "baseline"), mk(comparison, "comparison")],
      xTicks, yTicksT,
      function (v) { return v.toFixed(0); },
      function (v) { return (v / 1000).toFixed(0); });
  }

  function renderLeaders(baseline, comparison) {
    const profile = ANA.leaderProfile(state.track, baseline, comparison, 25);
    state.map.renderLeaders(profile);
    const host = $("#leader-summary");
    host.innerHTML = "";
    const sum = { baseline: 0, comparison: 0, unknown: 0, tie: 0 };
    profile.forEach(function (span) { sum[span.leader] += span.s1 - span.s0; });
    const total = state.track.length;
    [["baseline", "基准领先", sum.baseline],
     ["comparison", "对照领先", sum.comparison],
     ["unknown", "无证据", sum.unknown]].forEach(function (k) {
      const item = el("div", "leader-item");
      item.appendChild(el("span", "leader-swatch swatch-" + k[0]));
      item.appendChild(el("span", null, k[1] + " "));
      item.appendChild(el("b", null, (k[2] / total * 100).toFixed(1) + "%"));
      host.appendChild(item);
    });
  }

  function renderCheckpointTable(deltas, baseline, comparison) {
    const host = $("#cp-table");
    host.innerHTML = "";
    const table = el("table");
    const thead = el("thead");
    const hr = el("tr");
    ["检查点", "基准 (" + baseline.runId + ")", "证据",
     "对照 (" + comparison.runId + ")", "证据",
     "累计差距", "分段差距", "审计"].forEach(function (h) {
      hr.appendChild(el("th", null, h));
    });
    thead.appendChild(hr); table.appendChild(thead);
    const tbody = el("tbody");

    deltas.forEach(function (r, idx) {
      const tr = el("tr");
      tr.appendChild(el("td", null, r.cp.name + " " + r.cp.s.toFixed(0) + "m"));
      tr.appendChild(cellTime(r.baseline));
      tr.appendChild(el("td", "ev ev-" + r.baseline.evidence, evText(r.baseline.evidence)));
      tr.appendChild(cellTime(r.comparison));
      tr.appendChild(el("td", "ev ev-" + r.comparison.evidence, evText(r.comparison.evidence)));
      tr.appendChild(cellDelta(r.cumDelta, r.cumKnown));
      tr.appendChild(cellDelta(r.segDelta, r.segKnown));
      const tdAudit = el("td");
      if (idx > 0) {
        const btn = el("button", "btn btn-small", "复查");
        btn.addEventListener("click", function () {
          showAudit(idx - 1);
        });
        tdAudit.appendChild(btn);
      }
      tr.appendChild(tdAudit);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);

    // 分段表（点击行回放该段）
    const segHost = $("#seg-table");
    segHost.innerHTML = "";
    const st = el("table");
    const sh = el("tr");
    ["分段", "长度m", "分段差距（对照−基准）", "证据情况", "操作"].forEach(function (h) {
      sh.appendChild(el("th", null, h));
    });
    st.appendChild(sh);
    const rows = ANA.segmentTable(state.track, baseline, comparison, deltas);
    rows.forEach(function (sr) {
      const tr = el("tr", "seg-row");
      tr.appendChild(el("td", null, "段" + (sr.index + 1)));
      tr.appendChild(el("td", null, sr.length.toFixed(0)));
      tr.appendChild(cellDelta(sr.segDelta, sr.segDelta !== null));
      const evDesc = [];
      if (sr.baselineUnknown) evDesc.push("基准段内含无证据区间");
      if (sr.comparisonUnknown) evDesc.push("对照段内含无证据区间");
      if (sr.baselineEvidence === "none") evDesc.push("基准端检查点无证据");
      if (sr.comparisonEvidence === "none") evDesc.push("对照端检查点无证据");
      tr.appendChild(el("td", null, evDesc.join("；") || "两端均有检查点证据"));
      const td = el("td");
      const btn = el("button", "btn btn-small", "回放该段");
      btn.addEventListener("click", function () { startSegmentReplay(sr.index); });
      td.appendChild(btn);
      tr.appendChild(td);
      st.appendChild(tr);
    });
    segHost.appendChild(st);
  }

  function cellTime(ev) {
    if (ev.t === null) return el("td", "cell-unknown", "未知");
    return el("td", "tabular", (ev.t / 1000).toFixed(2));
  }
  function cellDelta(v, known) {
    if (!known || v === null) return el("td", "cell-unknown tabular", "未知");
    const cls = v > 0 ? "delta-slow" : (v < 0 ? "delta-fast" : "delta-zero");
    return el("td", cls + " tabular", (v / 1000).toFixed(2) + " s");
  }
  function evText(e) {
    return { trigger: "触发", interpolated: "插值", line: "起点", none: "无证据" }[e] || e;
  }

  function showAudit(segIndex) {
    const { baseline, comparison } = roles();
    const steps = ANA.auditSegment(state.track, baseline, comparison, segIndex, state.deltas);
    const host = $("#audit-body");
    host.innerHTML = "";
    host.appendChild(el("div", "audit-title",
      "段 " + (segIndex + 1) + " 计算复查（基准：" + baseline.label + "）"));
    steps.forEach(function (s) {
      host.appendChild(el("div", "audit-step", s));
    });
    $("#audit-panel").classList.remove("hidden");
  }

  function renderStats(baseline, comparison) {
    const host = $("#stats-body");
    host.innerHTML = "";
    [baseline, comparison].forEach(function (run) {
      const card = el("div", "stat-card");
      card.appendChild(el("div", "stat-title", run.label));
      const items = [
        ["状态", run.status.label],
        ["总时长", run.checkpoints[run.checkpoints.length - 1].t !== null
          ? IMP.fmtMs(run.checkpoints[run.checkpoints.length - 1].t) : "未完成/未知"],
        ["证据覆盖", (run.stats.evidenceCoverage * 100).toFixed(1) + "%"],
        ["实测最大速度", run.stats.maxObservedSpeed.toFixed(1) + " m/s（不含异常/未知点）"],
        ["倒退采样", String(run.stats.backwardSteps) + " 个"],
        ["超限跳变", String(run.stats.implausibleSteps) + " 个"],
        ["长缺失", run.gaps.filter(function (g) { return !g.interpolable; }).length + " 处（无证据）"],
        ["可插值短缺失", run.gaps.filter(function (g) { return g.interpolable; }).length + " 处"],
      ];
      items.forEach(function (kv) {
        const row = el("div", "stat-row");
        row.appendChild(el("span", "stat-k", kv[0]));
        row.appendChild(el("span", "stat-v tabular", kv[1]));
        card.appendChild(row);
      });
      // 最快分段：排除含未知的段
      const fast = ANA.fastestSegments(run, state.deltas);
      if (fast.length) {
        card.appendChild(el("div", "stat-k", "最快分段（未知段不参评）"));
        card.appendChild(el("div", "stat-v tabular",
          "段" + (fast[0].index + 1) + " · " + (fast[0].duration / 1000).toFixed(2) + " s"));
      }
      host.appendChild(card);
    });
  }

  /* ---------- 导出 ---------- */
  function exportCsv() {
    const { baseline, comparison } = roles();
    const csv = ANA.exportCsv(state.track, baseline, comparison, state.deltas);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gap_" + baseline.runId + "_vs_" + comparison.runId + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- 本地导入 ---------- */
  function importFiles(ev) {
    const files = Array.from(ev.target.files || []);
    if (!files.length) return;
    Promise.all(files.map(function (f) {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () {
          try { resolve(JSON.parse(fr.result)); }
          catch (e) { reject(new Error(f.name + " 不是合法 JSON：" + e.message)); }
        };
        fr.onerror = function () { reject(new Error(f.name + " 读取失败")); };
        fr.readAsText(f);
      });
    })).then(function (objs) {
      const added = [];
      objs.forEach(function (obj) {
        if (obj.track && obj.runs) {
          obj.runs.forEach(function (r) { added.push(r); });
        } else if (obj.samples || obj.runId) {
          added.push(obj);
        }
      });
      const errors = [];
      added.forEach(function (raw) {
        if (raw.trackId && raw.trackId !== state.track.def.trackId) {
          errors.push(raw.runId + " 的 trackId 与当前跑道不一致，已拒绝");
          return;
        }
        if (state.runs.some(function (r) { return r.runId === raw.runId; })) {
          errors.push((raw.runId || "未命名记录") + " 的 runId 已存在，已跳过");
          return;
        }
        state.runs.push(IMP.importRun(state.track, raw));
      });
      buildRunPicker();
      const msg = $("#import-message");
      msg.textContent = "导入 " + added.length + " 条记录" +
        (errors.length ? "；提示：" + errors.join("；") : "");
      msg.className = errors.length ? "import-message warn" : "import-message ok";
    }).catch(function (err) {
      const msg = $("#import-message");
      msg.textContent = err.message;
      msg.className = "import-message warn";
    });
    ev.target.value = "";
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (window.GHOST_DATA) init(window.GHOST_DATA);
    else $("#app-root").innerHTML = "<p class='fatal'>未找到 data/data.js，请先运行 python3 tools/generate_data.py</p>";
  });
})();
