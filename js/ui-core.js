/* UI 核心：状态、DOM 缓存、通用工具、播放循环与求值。 */
(function () {
  'use strict';

  const U = window.RTUI = {};

  U.M = window.RTModel;
  U.J = window.RTJudge;
  U.A = window.RTAudio;
  U.D = window.RTDemo;

  U.LANES = [0, 1, 2, 3];
  U.LANE_KEYS = { d: 0, f: 1, j: 2, k: 3 };
  U.STORE_KEY = 'rt-debug-desk-v1';
  U.DRAFT_KEY = 'rt-debug-desk-draft-v1';

  U.OUTCOME_LABEL = {
    success: '成功',
    early: '早',
    late: '晚',
    miss: '漏拍',
    earlyRelease: '提前松开',
    holding: '按住中',
    complete: '尾完成',
    pending: '待判',
  };

  U.state = {
    chart: U.M.normalizeChart(U.D.chart),
    events: U.D.events.map(function (e, i) {
      const copy = Object.assign({}, e);
      copy.id = 'ev' + i;
      return copy;
    }),
    windows: {
      A: U.J.normalizeWindows(U.J.DEFAULT_WINDOWS.A),
      B: U.J.normalizeWindows(U.J.DEFAULT_WINDOWS.B),
    },
    windowKey: 'A',
    biasMs: 0,
    playhead: 0,
    axis: 'beat',
    showWindows: true,
    muted: false,
    playing: false,
    playback: null,
    checkpoints: [],
    lastCompare: null,
    liveResult: null,
    notesDraw: [],
    verify: null,
    dirtyTables: true,
    eventSeq: 0,
    rafId: 0,
    saveTimer: 0,
    dataDirty: false,
  };

  U.el = {};
  U.canvas = document.getElementById('timeline');
  U.ctx = U.canvas.getContext('2d');
  U.tooltip = document.getElementById('tooltip');

  U.cacheEls = function () {
    const ids = [
      'chart-title', 'sections-table', 'notes-table', 'issues-list', 'issues-pill',
      'windows-body', 'btn-add-section', 'btn-add-tap', 'btn-add-hold', 'btn-clear-notes',
      'btn-demo', 'btn-record', 'btn-replay', 'btn-stop', 'btn-clear-input', 'speed-select',
      'show-windows', 'clock', 'now-bar', 'now-sub', 'hud-score', 'hud-max', 'hud-combo',
      'hud-maxcombo', 'hud-flash', 'result-summary', 'result-sub', 'results-table',
      'stray-list', 'trace-table', 'bias-range', 'bias-number', 'only-divergent',
      'compare-stats', 'window-cards', 'compare-table', 'btn-add-checkpoint',
      'btn-clear-checkpoints', 'verify-badge', 'cp-list', 'replay-detail', 'btn-save',
      'btn-load', 'btn-export', 'btn-import', 'file-input', 'data-json', 'storage-note',
      'btn-copy', 'btn-apply-json', 'btn-theme', 'btn-mute', 'timeline-wrap', 'legend',
      'toast',
    ];
    ids.forEach(function (id) {
      U.el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] =
        document.getElementById(id);
    });
  };

  U.cssVar = function (name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  };

  U.fmtSec = function (t, digits) {
    const d = digits == null ? 3 : digits;
    return (t < 0 ? '-' : '') + Math.abs(t).toFixed(d) + 's';
  };

  U.fmtMs = function (v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const r = Math.round(v);
    return (r > 0 ? '+' : '') + r + ' ms';
  };

  U.fmtDelta = function (v) {
    if (v == null || !Number.isFinite(v)) return '—';
    const r = Math.round(v);
    return (r > 0 ? '+' : '') + r;
  };

  U.esc = function (s) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, function (c) { return map[c]; });
  };

  U.activeWindows = function () {
    return U.state.windows[U.state.windowKey];
  };

  U.chartEnd = function () {
    return U.M.chartEndSeconds(U.state.chart) + 0.6;
  };

  U.effectiveEvents = function () {
    return U.J.shiftEvents(U.state.events, U.state.biasMs);
  };

  U.labelOf = function (v) {
    return U.OUTCOME_LABEL[v] || v || '—';
  };

  /* ---------- 播放 ---------- */
  U.play = function (snapshot) {
    if (U.state.playhead >= U.chartEnd() - 0.001) U.state.playhead = 0;
    const resumeSnap = snapshot
      || (U.state.playhead > 0.001
        ? U.J.snapshotAt(U.state.chart, U.effectiveEvents(), U.activeWindows(), U.state.playhead)
        : null);
    U.state.playing = true;
    U.state.playback = {
      wall: performance.now(),
      song: U.state.playhead,
      snapshot: resumeSnap,
      startTime: U.state.playhead,
      liveTimelineCount: U.state.liveResult && U.state.liveResult.timeline
        ? U.state.liveResult.timeline.length : 0,
    };
    U.state.verify = null;
    U.el.btnStop.disabled = false;
    U.el.btnRecord.classList.add('is-active');
    U.el.btnRecord.innerHTML = '<span aria-hidden="true">◉</span> 播放中';
    U.A.ensure();
    if (resumeSnap) {
      U.toast('从 ' + U.fmtSec(U.state.playhead) + ' 检查点重放：只处理此后的输入');
    }
    U.renderAll();
    U.loop();
  };

  U.stopPlayback = function () {
    U.state.playing = false;
    U.state.playback = null;
    U.el.btnStop.disabled = true;
    U.el.btnRecord.classList.remove('is-active');
    U.el.btnRecord.innerHTML = '<span aria-hidden="true">◉</span> 录制 / 播放';
    U.renderAll();
  };

  U.loop = function () {
    if (!U.state.playing) return;
    const pb = U.state.playback;
    const speed = Number(U.el.speedSelect.value) || 1;
    const songTime = pb.song + ((performance.now() - pb.wall) / 1000) * speed;
    const end = U.chartEnd();
    const t = Math.min(songTime, end);
    const prev = U.state.playhead;
    U.state.playhead = t;
    U.scheduleAudio(prev, t, speed);
    if (t >= end - 1e-6) {
      U.finishPlayback();
      return;
    }
    U.renderFrame();
    U.state.rafId = requestAnimationFrame(U.loop);
  };

  U.finishPlayback = function () {
    const pb = U.state.playback;
    U.state.playhead = U.chartEnd();
    U.state.playing = false;
    U.state.playback = null;
    U.el.btnStop.disabled = true;
    U.el.btnRecord.classList.remove('is-active');
    U.el.btnRecord.innerHTML = '<span aria-hidden="true">◉</span> 录制 / 播放';
    if (pb && pb.snapshot) U.verifyReplay(pb.snapshot, pb.startTime);
    else if (U.state.checkpoints.length) U.verifyAllCheckpoints();
    U.renderAll();
  };

  U.scheduleAudio = function (from, to, speed) {
    if (U.state.muted) return;
    const now = U.A.now();
    const rate = speed > 0 ? speed : 1;
    function at(songT) {
      return now + Math.max(0, (songT - to) / rate) + 0.001;
    }
    U.M.beatTicks(U.state.chart, U.M.chartEndBeat(U.state.chart)).forEach(function (tk) {
      if (tk.time > from + 1e-6 && tk.time <= to + 1e-6) U.A.blip(at(tk.time), tk.accent);
    });
    U.effectiveEvents().forEach(function (e) {
      if (e.kind === 'press' && e.t > from + 1e-6 && e.t <= to + 1e-6) {
        U.A.click(at(e.t), false);
      }
    });
  };

  U.seek = function (t, light) {
    U.state.playhead = Math.max(0, Math.min(U.chartEnd(), t));
    if (U.state.playback) {
      U.state.playback.wall = performance.now();
      U.state.playback.song = U.state.playhead;
      if (U.state.playback.snapshot
        && U.state.playhead < U.state.playback.snapshot.time - 1e-6) {
        U.state.playback.snapshot = null;
        U.state.playback.startTime = U.state.playhead;
        U.state.playback.liveTimelineCount = 0;
      }
    }
    if (light) U.renderFrame();
    else U.renderAll();
  };

  U.computeLive = function () {
    const opts = { endTime: U.state.playhead };
    if (U.state.playback && U.state.playback.snapshot) {
      opts.from = U.state.playback.snapshot;
      opts.endTime = Math.max(U.state.playhead, U.state.playback.snapshot.time);
    }
    return U.J.evaluate(U.state.chart, U.effectiveEvents(), U.activeWindows(), opts);
  };

  U.computeFull = function () {
    return U.J.evaluate(U.state.chart, U.effectiveEvents(), U.activeWindows(),
      { endTime: U.chartEnd() });
  };
})();
