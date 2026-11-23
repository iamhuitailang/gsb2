/* UI 交互：键盘与触控输入、时间轴拖动、编辑器绑定、播放控制、对照、检查点、存储与启动。 */
(function () {
  'use strict';

  const U = window.RTUI;
  const M = U.M;
  const J = U.J;
  const A = U.A;
  const D = U.D;
  const state = U.state;
  const el = U.el;
  const canvas = U.canvas;

  /* ---------- 提示 ---------- */
  U.toast = function (msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(U.toast._t);
    U.toast._t = setTimeout(function () { el.toast.classList.remove('show'); }, 2200);
  };

  /* ---------- 每帧与整体渲染 ---------- */
  U.renderFrame = function () {
    const live = U.computeLive();
    state.liveResult = live;
    U.flashNewJudgments(live);
    U.renderNowLine();
    U.renderHud(live);
    U.renderPads();
    U.drawTimeline(live, state.lastCompare);
  };

  U.flashNewJudgments = function (live) {
    const pb = state.playback;
    if (!pb) return;
    const tl = live.timeline || [];
    if (pb.liveTimelineCount == null) pb.liveTimelineCount = tl.length;
    if (tl.length > pb.liveTimelineCount) {
      const entry = tl[tl.length - 1];
      const label = entry.outcome === 'complete' ? '长按完成'
        : entry.outcome === 'earlyRelease' ? '提前松开'
          : entry.outcome === 'miss' ? '漏拍' : U.labelOf(entry.outcome);
      const tone = entry.outcome === 'miss' ? 'miss'
        : entry.outcome === 'early' ? 'early'
          : entry.outcome === 'late' ? 'late' : 'success';
      if (entry.t > state.playhead - 0.35) U.flash(label, tone);
      pb.liveTimelineCount = tl.length;
    } else if (tl.length < pb.liveTimelineCount) {
      pb.liveTimelineCount = tl.length;
    }
  };

  U.renderAll = function () {
    const live = U.computeLive();
    state.liveResult = live;

    U.renderChartTitle();
    if (state.dirtyTables) {
      U.renderSections();
      U.renderNotes();
      U.renderIssues();
      U.renderWindowsEditor();
      state.dirtyTables = false;
    }
    U.renderNowLine();
    U.renderHud(live);
    U.renderResults(live);
    U.renderTrace(live);
    U.renderCompare();
    U.drawTimeline(live, state.lastCompare);
    U.renderCheckpoints();
    U.renderPads();
    U.updateDataBox();
  };

  /* ---------- 实时输入 ---------- */
  function addEvent(kind, lane, t, noteId) {
    const used = new Set(state.events.map(function (e) { return e.id; }));
    let id;
    do {
      state.eventSeq += 1;
      id = 'ev-live-' + state.eventSeq;
    } while (used.has(id));
    const clamped = Math.max(0, Math.min(U.chartEnd(), t));
    state.events.push({
      id: id,
      kind: kind,
      lane: lane,
      t: clamped,
      rawT: clamped,
      noteId: noteId || null,
      source: 'live',
    });
    state.events.sort(function (a, b) { return a.t - b.t; });
    U.renderAll();
    U.scheduleSave();
    return id;
  }

  const heldKeys = new Set();

  function pressLane(lane) {
    const id = addEvent('press', lane, state.playhead);
    const tr = (state.liveResult.traces || []).filter(function (x) {
      return x.inputId === id;
    }).slice(-1)[0];
    if (tr && tr.outcome !== 'stray' && tr.outcome !== 'no-target'
      && tr.outcome !== 'lane-held') {
      U.flash(U.labelOf(tr.outcome) + ' ' + U.fmtDelta(tr.dtMs) + 'ms', tr.outcome);
      A.click(A.now() + 0.001, tr.outcome === 'success');
    } else {
      U.flash('未命中', 'miss');
      A.click(A.now() + 0.001, false);
    }
  }

  function releaseLane(lane) {
    const id = addEvent('release', lane, state.playhead);
    const tr = (state.liveResult.traces || []).filter(function (x) {
      return x.inputId === id;
    }).slice(-1)[0];
    if (tr && tr.outcome === 'earlyRelease') U.flash('提前松开', 'miss');
    if (tr && tr.outcome === 'complete') U.flash('长按完成', 'success');
  }

  function setPadDown(lane, down) {
    const pad = document.querySelector('.pad[data-lane="' + lane + '"]');
    if (pad) pad.classList.toggle('is-down', down);
  }

  function bindKeyboard() {
    function isTyping(target) {
      const tag = (target && target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
      return !!(target && target.isContentEditable);
    }
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target && e.target.tagName || '').toLowerCase();
      if (tag === 'button' && (e.key === ' ' || e.key === 'Enter')) return;
      if (isTyping(e.target)) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (state.playing) U.stopPlayback();
        else U.play(null);
        return;
      }
      const lane = U.LANE_KEYS[e.key.toLowerCase()];
      if (lane == null || e.repeat || heldKeys.has(lane)) return;
      e.preventDefault();
      heldKeys.add(lane);
      setPadDown(lane, true);
      pressLane(lane);
    });
    document.addEventListener('keyup', function (e) {
      if (isTyping(e.target)) return;
      const lane = U.LANE_KEYS[e.key.toLowerCase()];
      if (lane == null) return;
      e.preventDefault();
      if (!heldKeys.has(lane)) return;
      heldKeys.delete(lane);
      setPadDown(lane, false);
      releaseLane(lane);
    });
    window.addEventListener('blur', function () {
      heldKeys.forEach(function (lane) {
        setPadDown(lane, false);
        releaseLane(lane);
      });
      heldKeys.clear();
    });
  }

  function bindPads() {
    document.querySelectorAll('.pad').forEach(function (pad) {
      const lane = Number(pad.dataset.lane);
      pad.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        pad.setPointerCapture(e.pointerId);
        setPadDown(lane, true);
        pressLane(lane);
      });
      function up(e) {
        e.preventDefault();
        if (!pad.classList.contains('is-down')) return;
        setPadDown(lane, false);
        releaseLane(lane);
      }
      pad.addEventListener('pointerup', up);
      pad.addEventListener('pointercancel', up);
      pad.addEventListener('lostpointercapture', function () {
        if (!pad.classList.contains('is-down')) return;
        setPadDown(lane, false);
        releaseLane(lane);
      });
    });
  }

  function bindTimeline() {
    let dragging = false;
    function localPoint(e) {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    canvas.addEventListener('pointerdown', function (e) {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      const p = localPoint(e);
      if (p.x >= U.PAD.left) {
        U.seek(U.makeScale(U.canvasCssWidth()).xToTime(p.x), true);
        U.hideTooltip();
      }
    });
    canvas.addEventListener('pointermove', function (e) {
      const p = localPoint(e);
      if (dragging && p.x >= U.PAD.left) {
        U.seek(U.makeScale(U.canvasCssWidth()).xToTime(p.x), true);
        U.hideTooltip();
        return;
      }
      U.showHover(p, canvas.getBoundingClientRect());
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      U.renderAll();
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', function () {
      if (!dragging) U.hideTooltip();
    });
  }

  /* ---------- 编辑器 ---------- */
  function addNote(type) {
    const beat = Math.max(0, Math.round(M.beatAtSeconds(state.chart, state.playhead) * 4) / 4);
    const used = new Set(state.chart.notes
      .filter(function (n) { return Math.abs(n.beat - beat) < 1e-6; })
      .map(function (n) { return n.lane; }));
    const lane = U.LANES.find(function (l) { return !used.has(l); });
    if (lane == null) {
      U.toast('这一拍四个轨道都已有音符');
      return;
    }
    state.chart.notes.push({
      id: 'n' + Date.now().toString(36).slice(-4),
      lane: lane,
      type: type,
      beat: beat,
      durBeats: type === 'hold' ? 2 : 0,
    });
    state.chart = M.normalizeChart(state.chart);
    refreshChart();
  }

  function clampCheckpoints() {
    const end = U.chartEnd();
    state.checkpoints = state.checkpoints
      .map(function (c) {
        const copy = Object.assign({}, c);
        copy.time = Math.max(0, Math.min(end, c.time));
        return copy;
      })
      .filter(function (c, i, arr) {
        return arr.findIndex(function (x) {
          return Math.abs(x.time - c.time) < 1e-3;
        }) === i;
      })
      .sort(function (a, b) { return a.time - b.time; });
  }

  function refreshChart() {
    state.verify = null;
    state.dirtyTables = true;
    state.lastCompare = null;
    state.playhead = Math.max(0, Math.min(U.chartEnd(), state.playhead));
    clampCheckpoints();
    U.renderAll();
    U.scheduleSave();
  }

  function bindEditor() {
    el.chartTitle.addEventListener('input', function () {
      state.chart.title = el.chartTitle.value.trim() || '未命名谱面';
      U.scheduleSave();
    });

    el.sectionsTable.addEventListener('change', function (e) {
      const input = e.target.closest('input');
      if (!input) return;
      const i = Number(input.closest('tr').dataset.index);
      const val = Number(input.value);
      if (!Number.isFinite(val) || !state.chart.sections[i]) {
        U.renderSections();
        return;
      }
      state.chart.sections[i][input.dataset.field] = val;
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });
    el.sectionsTable.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      const i = Number(btn.dataset.remove);
      if (i === 0) return;
      state.chart.sections.splice(i, 1);
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });

    el.notesTable.addEventListener('change', function (e) {
      const input = e.target.closest('input, select');
      if (!input) return;
      const note = state.chart.notes.find(function (n) {
        return n.id === input.closest('tr').dataset.id;
      });
      if (!note) return;
      const val = Number(input.value);
      if (!Number.isFinite(val)) {
        U.renderNotes();
        return;
      }
      note[input.dataset.field] = input.dataset.field === 'lane' ? Math.round(val) : val;
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });
    el.notesTable.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      state.chart.notes.splice(Number(btn.dataset.remove), 1);
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });

    el.windowsBody.addEventListener('change', function (e) {
      const input = e.target.closest('input');
      if (!input) return;
      const key = input.closest('tr').dataset.key;
      const val = Number(input.value);
      if (!Number.isFinite(val)) {
        U.renderWindowsEditor();
        return;
      }
      const patch = {};
      patch[input.dataset.field] = Math.max(0, val);
      state.windows[key] = J.normalizeWindows(
        Object.assign({}, state.windows[key], patch));
      U.renderWindowsEditor();
      U.renderAll();
      U.scheduleSave();
    });

    el.btnAddSection.addEventListener('click', function () {
      const secs = state.chart.sections;
      const last = secs[secs.length - 1];
      secs.push({
        beat: last.beat + M.barLength(last),
        bpm: last.bpm,
        sigNum: last.sigNum,
        sigDen: last.sigDen,
      });
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });

    el.btnAddTap.addEventListener('click', function () { addNote('tap'); });
    el.btnAddHold.addEventListener('click', function () { addNote('hold'); });
    el.btnClearNotes.addEventListener('click', function () {
      if (!state.chart.notes.length || !confirm('清空全部音符？')) return;
      state.chart.notes = [];
      state.chart = M.normalizeChart(state.chart);
      refreshChart();
    });
    el.btnDemo.addEventListener('click', loadDemo);
  }

  /* ---------- 播放控制 ---------- */
  function bindTransport() {
    el.btnRecord.addEventListener('click', function () {
      if (state.playing) U.stopPlayback();
      else U.play(null);
    });
    el.btnStop.addEventListener('click', U.stopPlayback);
    el.btnReplay.addEventListener('click', function () {
      if (state.playing) U.stopPlayback();
      state.playhead = 0;
      state.verify = null;
      U.play(null);
    });
    el.btnClearInput.addEventListener('click', function () {
      if (!state.events.length || !confirm('清空所有输入事件？')) return;
      state.events = [];
      state.verify = null;
      U.renderAll();
      U.scheduleSave();
    });
    el.showWindows.addEventListener('change', function () {
      state.showWindows = el.showWindows.checked;
      U.renderFrame();
    });
    document.querySelectorAll('[data-axis]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.axis = btn.dataset.axis;
        document.querySelectorAll('[data-axis]').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        U.renderFrame();
      });
    });
    document.querySelectorAll('[data-window]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.windowKey = btn.dataset.window;
        document.querySelectorAll('[data-window]').forEach(function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        state.verify = null;
        U.renderAll();
      });
    });
    el.btnMute.addEventListener('click', function () {
      state.muted = !state.muted;
      A.setMuted(state.muted);
      el.btnMute.setAttribute('aria-pressed', String(state.muted));
    });
    el.btnTheme.addEventListener('click', function () {
      const root = document.documentElement;
      const cur = root.getAttribute('data-theme');
      if (cur === 'dark') root.setAttribute('data-theme', 'light');
      else if (cur === 'light') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', 'dark');
      U.renderFrame();
    });
  }

  /* ---------- 对照 ---------- */
  function bindCompare() {
    function sync(val) {
      state.biasMs = Math.max(-500, Math.min(500, Math.round(Number(val) || 0)));
      el.biasRange.value = String(Math.max(-150, Math.min(150, state.biasMs)));
      el.biasNumber.value = String(state.biasMs);
      state.verify = null;
      if (state.playback && state.playback.snapshot) {
        state.playback.snapshot = null;
        state.playback.startTime = state.playhead;
        state.playback.liveTimelineCount = 0;
      }
      U.renderAll();
      U.scheduleSave();
    }
    el.biasRange.addEventListener('input', function () { sync(el.biasRange.value); });
    el.biasNumber.addEventListener('change', function () { sync(el.biasNumber.value); });
    el.onlyDivergent.checked = true;
    el.onlyDivergent.addEventListener('change', U.renderCompare);
  }

  /* ---------- 检查点 ---------- */
  function bindCheckpoints() {
    el.btnAddCheckpoint.addEventListener('click', function () {
      const t = state.playhead;
      if (state.checkpoints.some(function (c) { return Math.abs(c.time - t) < 0.01; })) return;
      const pos = M.barBeatLabel(state.chart, M.beatAtSeconds(state.chart, t));
      state.checkpoints.push({
        id: 'cp' + Date.now().toString(36).slice(-5),
        time: t,
        label: pos.label + ' · ' + U.fmtSec(t),
      });
      U.renderAll();
      U.scheduleSave();
    });
    el.btnClearCheckpoints.addEventListener('click', function () {
      if (!state.checkpoints.length) return;
      state.checkpoints = [];
      state.verify = null;
      U.renderAll();
      U.scheduleSave();
    });
    el.cpList.addEventListener('click', function (e) {
      const del = e.target.closest('[data-cp-del]');
      const jump = e.target.closest('[data-cp-jump]');
      const replay = e.target.closest('[data-cp-replay]');
      if (del) {
        state.checkpoints = state.checkpoints.filter(function (c) {
          return c.id !== del.dataset.cpDel;
        });
        state.verify = null;
        U.renderAll();
        U.scheduleSave();
        return;
      }
      if (jump) {
        const cp = state.checkpoints.find(function (c) {
          return c.id === jump.dataset.cpJump;
        });
        if (cp) U.seek(cp.time);
        return;
      }
      if (replay) {
        const cp = state.checkpoints.find(function (c) {
          return c.id === replay.dataset.cpReplay;
        });
        if (!cp) return;
        if (state.playing) U.stopPlayback();
        state.playhead = cp.time;
        state.verify = null;
        U.play(J.snapshotAt(state.chart, U.effectiveEvents(),
          U.activeWindows(), cp.time));
      }
    });
  }

  /* ---------- 存储 ---------- */
  U.scheduleSave = function () {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(U.DRAFT_KEY, JSON.stringify(serialize()));
      } catch (err) { /* 忽略存储上限 */ }
    }, 400);
  };

  function serialize() {
    return {
      version: 1,
      chart: state.chart,
      events: state.events,
      biasMs: state.biasMs,
      windowKey: state.windowKey,
      windows: state.windows,
      axis: state.axis,
      checkpoints: state.checkpoints.map(function (c) {
        return { id: c.id, time: c.time, label: c.label };
      }),
    };
  }

  U.updateDataBox = function () {
    if (!el.dataJson) return;
    if (state.dataDirty && document.activeElement === el.dataJson) return;
    state.dataDirty = false;
    el.dataJson.value = JSON.stringify(serialize(), null, 2);
  };

  function applyPayload(payload, opts) {
    if (!payload || typeof payload !== 'object') throw new Error('JSON 顶层必须是对象');
    if (state.playing) U.stopPlayback();
    if (payload.chart) state.chart = M.normalizeChart(payload.chart);
    if (Array.isArray(payload.events)) {
      state.events = payload.events.map(function (e, i) {
        const copy = Object.assign({}, e);
        copy.id = e.id || 'ev' + i;
        copy.rawT = Number.isFinite(Number(e.rawT)) ? Number(e.rawT) : Number(e.t);
        return copy;
      }).filter(function (e) {
        return Number.isFinite(Number(e.t))
          && (e.kind === 'press' || e.kind === 'release');
      });
    } else {
      state.events = [];
    }
    state.eventSeq = state.events.length + 1000;
    if (payload.windows) {
      if (payload.windows.A) state.windows.A = J.normalizeWindows(payload.windows.A);
      if (payload.windows.B) state.windows.B = J.normalizeWindows(payload.windows.B);
    }
    state.biasMs = Number.isFinite(Number(payload.biasMs)) ? Number(payload.biasMs) : 0;
    el.biasNumber.value = String(state.biasMs);
    el.biasRange.value = String(Math.max(-150, Math.min(150, state.biasMs)));
    if (payload.axis === 'time' || payload.axis === 'beat') {
      state.axis = payload.axis;
      document.querySelectorAll('[data-axis]').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.axis === state.axis);
      });
    }
    if (payload.windowKey && state.windows[payload.windowKey]) {
      state.windowKey = payload.windowKey;
      document.querySelectorAll('[data-window]').forEach(function (b) {
        b.classList.toggle('is-active', b.dataset.window === state.windowKey);
      });
    }
    state.checkpoints = Array.isArray(payload.checkpoints)
      ? payload.checkpoints.filter(function (c) {
        return Number.isFinite(Number(c.time));
      }).map(function (c, i) {
        return {
          id: String(c.id || 'cp' + i).replace(/[^\w-]/g, '_'),
          time: Number(c.time),
          label: String(c.label || ''),
        };
      })
      : [];
    clampCheckpoints();
    // 载入后停在结尾：先看到整段判定结论；「一键回放」会从 0 开始。
    state.playhead = U.chartEnd();
    state.verify = null;
    state.dirtyTables = true;
    el.onlyDivergent.checked = true;
    U.renderAll();
    if (!opts || !opts.silent) {
      try {
        localStorage.setItem(U.DRAFT_KEY, JSON.stringify(serialize()));
      } catch (err) { /* 忽略 */ }
      U.updateDataBox();
    }
  }

  function bindStorage() {
    el.btnSave.addEventListener('click', function () {
      try {
        localStorage.setItem(U.STORE_KEY, JSON.stringify(serialize()));
        U.toast('已保存到浏览器 localStorage（' + new Date().toLocaleTimeString() + '）');
      } catch (err) {
        U.toast('保存失败：' + err.message);
      }
    });
    el.btnLoad.addEventListener('click', function () {
      const raw = localStorage.getItem(U.STORE_KEY) || localStorage.getItem(U.DRAFT_KEY);
      if (!raw) {
        U.toast('浏览器里还没有保存的谱面');
        return;
      }
      try {
        applyPayload(JSON.parse(raw));
        U.toast('已从浏览器载入');
      } catch (err) {
        U.toast('载入失败：' + err.message);
      }
    });
    el.btnExport.addEventListener('click', function () {
      const blob = new Blob([JSON.stringify(serialize(), null, 2)],
        { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.chart.title || 'chart').replace(/[^\w一-龥-]+/g, '_') + '.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        a.remove();
      }, 0);
      U.toast('已导出 JSON');
    });
    el.btnImport.addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function () {
      const file = el.fileInput.files && el.fileInput.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          applyPayload(JSON.parse(String(reader.result)));
          U.toast('已导入 ' + file.name);
        } catch (err) {
          U.toast('导入失败：' + err.message);
        }
      };
      reader.readAsText(file);
      el.fileInput.value = '';
    });
    el.btnCopy.addEventListener('click', async function () {
      try {
        await navigator.clipboard.writeText(el.dataJson.value);
        U.toast('JSON 已复制到剪贴板');
      } catch (err) {
        el.dataJson.select();
        if (document.execCommand) document.execCommand('copy');
        U.toast('已全选，可手动复制');
      }
    });
    el.btnApplyJson.addEventListener('click', function () {
      try {
        applyPayload(JSON.parse(el.dataJson.value));
        state.dataDirty = false;
        U.updateDataBox();
        U.toast('已应用文本框内容');
      } catch (err) {
        U.toast('解析失败：' + err.message);
      }
    });
    el.dataJson.addEventListener('input', function () { state.dataDirty = true; });
    el.dataJson.addEventListener('blur', function () {
      if (state.dataDirty) U.updateDataBox();
    });
  }

  /* ---------- 标签页 ---------- */
  function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.tab').forEach(function (t) {
          const on = t === tab;
          t.classList.toggle('is-active', on);
          t.setAttribute('aria-selected', String(on));
        });
        document.querySelectorAll('.tab-panel').forEach(function (p) {
          p.classList.toggle('is-active', p.id === 'panel-' + tab.dataset.tab);
        });
        if (tab.dataset.tab === 'compare') U.renderCompare();
      });
    });
  }

  /* ---------- 示例 ---------- */
  function loadDemo() {
    applyPayload({
      chart: D.chart,
      events: D.events.map(function (e, i) {
        const copy = Object.assign({}, e);
        copy.id = 'demo-ev' + i;
        return copy;
      }),
      windows: J.DEFAULT_WINDOWS,
      biasMs: 0,
      windowKey: 'A',
      axis: 'beat',
      checkpoints: D.checkpoints.map(function (c, i) {
        return {
          id: 'demo-cp' + i,
          time: c.time,
          label: c.label + ' · ' + U.fmtSec(c.time),
        };
      }),
    }, { silent: true });
    try {
      localStorage.setItem(U.DRAFT_KEY, JSON.stringify(serialize()));
    } catch (err) { /* 忽略 */ }
    U.toast('已载入示例：跨变速长按 + 相邻单点。按「一键回放」走完。');
    U.updateDataBox();
  }

  /* ---------- 启动 ---------- */
  function init() {
    U.cacheEls();
    bindKeyboard();
    bindPads();
    bindTimeline();
    bindEditor();
    bindTransport();
    bindCompare();
    bindCheckpoints();
    bindStorage();
    bindTabs();

    window.addEventListener('resize', U.renderFrame);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) mq.addEventListener('change', U.renderFrame);
    window.addEventListener('beforeunload', function () {
      if (state.rafId) cancelAnimationFrame(state.rafId);
    });

    const draft = (function () {
      try {
        return localStorage.getItem(U.DRAFT_KEY);
      } catch (err) {
        return null;
      }
    })();
    if (draft) {
      try {
        applyPayload(JSON.parse(draft), { silent: true });
        U.toast('已恢复上次草稿，可点「载入示例」回到内置示例。');
        U.updateDataBox();
        return;
      } catch (err) { /* 草稿损坏时回退到示例 */ }
    }
    loadDemo();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
