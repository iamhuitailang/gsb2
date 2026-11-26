/*
 * app.js — 立体短片左右眼校对工具 · 主应用
 *
 * 状态模型见 state 对象；core.js 负责所有时间/帧/标记数学，
 * view.js 负责画面，export.js 负责导出，本文件负责 DOM 与编排。
 */
(function () {
  'use strict';

  var C = window.StereoCore;
  var STORAGE_KEY = 'stereo-calib-autosave-v1';

  /* ---------------- 状态 ---------------- */

  function freshEye() {
    return {
      source: null,
      fps: 25,
      timeOffset: 0,       // 秒，正值 = 该眼内容在时间线上偏“晚”
      verticalOffset: 0    // 像素，正值 = 画面向下移
    };
  }

  var state = {
    eyes: { left: freshEye(), right: freshEye() },
    baseFps: 25,
    masterFrame: 0,
    mode: 'sbs',            // sbs | overlay | blink
    overlayMode: 'alpha',   // alpha | anaglyph | diff
    showGrid: true,
    showCross: true,
    showSafe: false,
    markers: []
  };

  var grid = { frameCount: 1, lastFrame: 0 };
  var ranges = null;
  var frames = { left: null, right: null };
  var playing = false;
  var playLast = 0;
  var playAccum = 0;
  var markerSeq = 0;
  var view, exporter;
  var toastTimer = null;

  function $() { return document.querySelector(arguments[0]); }

  function toast(msg, kind) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show ' + (kind || 'info');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = 'toast'; }, 3200);
  }

  function eyeReady(k) {
    return state.eyes[k].source && state.eyes[k].source.ready;
  }

  function bothReady() { return eyeReady('left') && eyeReady('right'); }

  function getViewState() {
    return {
      eyes: state.eyes,
      frames: frames,
      markers: state.markers,
      mode: state.mode,
      overlayMode: state.overlayMode,
      showGrid: state.showGrid,
      showCross: state.showCross,
      showSafe: state.showSafe,
      baseFps: state.baseFps
    };
  }

  /* ---------------- 主网格 / 帧计算 ---------------- */

  function rebuildGrid() {
    var infos = ['left', 'right'].map(function (k) {
      var e = state.eyes[k];
      if (!e.source || !e.source.ready) return null;
      return {
        fps: e.fps,
        frameCount: e.source.frameCount,
        timeOffset: e.timeOffset
      };
    });
    var present = infos.filter(Boolean);
    if (!present.length) {
      grid = { frameCount: 1, lastFrame: 0 };
      ranges = null;
    } else {
      grid = C.buildMasterGrid(present, state.baseFps);
      if (present.length === 2) {
        ranges = C.commonRanges(grid, infos[0], infos[1], state.baseFps);
      } else {
        var idx = infos[0] ? 0 : 1;
        var vr = C.eyeValidRange(infos[idx], state.baseFps);
        ranges = {
          left: idx === 0 ? vr : { lo: 0, hi: 0 },
          right: idx === 1 ? vr : { lo: 0, hi: 0 },
          common: { lo: vr.lo, hi: vr.hi }
        };
      }
    }
    state.masterFrame = C.clamp(state.masterFrame, 0, grid.lastFrame);
    updateFrames();
  }

  function updateFrames() {
    ['left', 'right'].forEach(function (k) {
      if (!eyeReady(k)) { frames[k] = null; return; }
      frames[k] = C.eyeFrameAt(state.masterFrame, state.baseFps, {
        fps: state.eyes[k].fps,
        frameCount: state.eyes[k].source.frameCount,
        timeOffset: state.eyes[k].timeOffset
      });
    });
  }

  function requestRender() {
    updateFrames();
    view.scheduleRender();
    syncReadouts();
  }

  /* ---------------- 素材装载 ---------------- */

  function setSource(eyeKey, source) {
    var old = state.eyes[eyeKey].source;
    if (old && old.destroy) old.destroy();
    state.eyes[eyeKey].source = source;
    if (source) {
      state.eyes[eyeKey].fps = source.fps;
    }
  }

  function loadSample(eyeKey) {
    var source = window.StereoSamples.create(eyeKey);
    setSource(eyeKey, source);
    state.eyes[eyeKey].timeOffset = 0;
    state.eyes[eyeKey].verticalOffset = 0;
    afterSourcesChanged('已载入' + source.name);
  }

  function loadVideoFile(eyeKey, file) {
    var video;
    try {
      video = new window.VideoSource(file, state.eyes[eyeKey].fps || 25);
    } catch (e) {
      toast(e.message, 'error');
      return;
    }
    $('#eye-' + eyeKey + ' .source-state').textContent = '加载中…';
    video.whenReady().then(function () {
      setSource(eyeKey, video);
      afterSourcesChanged('已载入视频：' + file.name);
      maybeRestoreAutosave();
    }).catch(function (err) {
      $('#eye-' + eyeKey + ' .source-state').textContent = '加载失败';
      toast(err.message || String(err), 'error');
      video.destroy();
    });
  }

  function afterSourcesChanged(msg) {
    // 素材变化后所有旧标记一律失效
    state.markers.forEach(function (m) { m._forced = true; });
    rebuildGrid();
    renderEyePanels();
    renderTimeline();
    renderMarkers();
    requestRender();
    if (msg) toast(msg);
    saveAutosave();
  }

  /* ---------------- 眼面板 ---------------- */

  function renderEyePanels() {
    ['left', 'right'].forEach(function (k) {
      var eye = state.eyes[k];
      var root = $('#eye-' + k);
      var src = eye.source;

      root.querySelector('.source-state').textContent = src
        ? (src.ready ? '已就绪' : '加载中…')
        : '未选择素材';
      root.querySelector('.source-name').textContent = src ? src.name : '—';

      var meta = root.querySelector('.source-meta');
      if (src && src.ready) {
        if (src.kind === 'video') {
          meta.textContent = src.metaText();
        } else {
          meta.textContent = src.width + '×' + src.height + ' · ' +
            src.fps + 'fps · ' + src.duration.toFixed(2) + 's · ' +
            src.frameCount + ' 帧 · 内置几何样片';
        }
      } else {
        meta.textContent = '';
      }

      root.querySelector('.fps-input').value = eye.fps;
      root.querySelector('.offset-time').value = eye.timeOffset.toFixed(3);
      root.querySelector('.offset-y').value = eye.verticalOffset;
      root.querySelector('.offset-time-frames').textContent =
        (eye.timeOffset * eye.fps).toFixed(2) + ' 帧';
      root.querySelector('.offset-y-pct').textContent = src && src.ready
        ? (eye.verticalOffset / src.height * 100).toFixed(2) + '% 高'
        : '';

      var corr = root.querySelector('.sample-correct');
      corr.disabled = !(src && src.kind === 'sample');
    });
    renderCommonRange();
  }

  function renderCommonRange() {
    var el = $('#common-range');
    if (!ranges || !bothReady()) {
      el.innerHTML = '共同可预览范围：<b>—</b>（需要两路素材都就绪）';
      return;
    }
    var c = ranges.common;
    var t0 = c.lo / state.baseFps, t1 = c.hi / state.baseFps;
    var lF = frames.left, rF = frames.right;
    el.innerHTML =
      '共同可预览范围：<b>' + C.formatTimecode(t0, state.baseFps) + ' → ' +
      C.formatTimecode(t1, state.baseFps) + '</b>' +
      '（主帧 ' + c.lo + '–' + (c.hi - 1) + '，共 ' + (c.hi - c.lo) + ' 帧，' +
      (t1 - t0).toFixed(2) + 's）';
  }

  /* ---------------- 时间线 ---------------- */

  function renderTimeline() {
    var track = $('#timeline-track');
    track.innerHTML = '';
    if (!grid.frameCount) return;

    function pct(f) { return (f / grid.frameCount) * 100; }

    if (ranges) {
      addSeg(track, ranges.left, 'seg-left', pct);
      addSeg(track, ranges.right, 'seg-right', pct);
      addSeg(track, ranges.common, 'seg-common', pct);
    }
    var cursor = document.createElement('div');
    cursor.className = 'timeline-cursor';
    cursor.id = 'timeline-cursor';
    track.appendChild(cursor);
    updateCursor();
  }

  function addSeg(track, r, cls, pctFn) {
    if (r.hi <= r.lo) return;
    var d = document.createElement('div');
    d.className = 'timeline-seg ' + cls;
    d.style.left = pctFn(r.lo) + '%';
    d.style.width = (pctFn(r.hi) - pctFn(r.lo)) + '%';
    track.appendChild(d);
  }

  function updateCursor() {
    var cursor = $('#timeline-cursor');
    if (cursor) {
      cursor.style.left = (state.masterFrame / grid.frameCount * 100) + '%';
    }
    var input = $('#timeline-input');
    input.max = grid.lastFrame;
    input.value = state.masterFrame;
  }

  function gotoFrame(f) {
    state.masterFrame = C.clamp(Math.round(f), 0, grid.lastFrame);
    updateCursor();
    requestRender();
    saveAutosave();
  }

  function nudgeFrame(d) { gotoFrame(state.masterFrame + d); }

  function syncReadouts() {
    $('#master-readout').textContent =
      '主时间线：帧 ' + state.masterFrame + ' / ' + grid.lastFrame +
      '　' + C.formatTimecode(state.masterFrame / state.baseFps, state.baseFps);

    ['left', 'right'].forEach(function (k) {
      var el = $('#eye-' + k + ' .frame-readout');
      var fr = frames[k];
      if (!eyeReady(k)) {
        el.textContent = '本地帧 —';
        return;
      }
      if (!fr.available) {
        el.innerHTML = '<span class="missing-tag">缺帧</span> 本地时刻 ' +
          fr.eyeTime.toFixed(3) + 's（帧 ' + fr.frame + ' 越界）';
      } else {
        el.textContent = '本地帧 ' + fr.frame + ' / ' +
          (state.eyes[k].source.frameCount - 1) +
          '（' + C.formatTimecode(fr.eyeTime, state.eyes[k].fps) + '）';
      }
    });
    renderCommonRange();
    renderMarkerStatusOnly();
  }

  /* ---------------- 播放 ---------------- */

  function setPlaying(v) {
    playing = v;
    playAccum = 0;
    playLast = performance.now();
    $('#btn-play').textContent = playing ? '暂停' : '播放';
    if (playing) requestAnimationFrame(playTick);
  }

  function playTick(now) {
    if (!playing) return;
    var dt = (now - playLast) / 1000;
    playLast = now;
    playAccum += dt;
    var step = 1 / state.baseFps;
    var advanced = false;
    while (playAccum >= step) {
      playAccum -= step;
      if (state.masterFrame >= grid.lastFrame) {
        state.masterFrame = 0;
      } else {
        state.masterFrame++;
      }
      advanced = true;
    }
    if (advanced) {
      updateCursor();
      requestRender();
    }
    requestAnimationFrame(playTick);
  }

  /* ---------------- 标记 ---------------- */

  function startPick() {
    if (!bothReady()) { toast('需要两路素材都就绪才能选参考点', 'error'); return; }
    if (!frames.left.available || !frames.right.available) {
      toast('当前主帧有缺帧，请先把时间线移到两路都有效的区间', 'error');
      return;
    }
    view.pickMode = true;
    view.pickFirst = null;
    view.scheduleRender();
    toast('先在左眼点参考点，再在右眼对应位置点一下');
  }

  function handlePick(eyeKey, srcPoint) {
    if (!view.pickFirst) {
      if (eyeKey !== 'left') {
        // 叠加模式下第一次强制算左眼
        eyeKey = 'left';
      }
      view.pickFirst = { x: srcPoint.x, y: srcPoint.y };
      toast('已记左眼点，请在右眼对应位置点击');
      return;
    }
    var picks = {
      left: view.pickFirst,
      right: { x: srcPoint.x, y: srcPoint.y }
    };
    var m = C.createMarker(++markerSeq, state.masterFrame, state.baseFps, state.eyes, picks);
    state.markers.push(m);
    view.cancelPick();
    renderMarkers();
    saveAutosave();
    toast('已记录参考点 #' + state.markers.length);
  }

  function renderMarkers() {
    var list = $('#marker-list');
    list.innerHTML = '';
    if (!state.markers.length) {
      list.innerHTML = '<div class="marker-empty">尚无参考点。把时间线停在对应帧，点“选一对参考点”。</div>';
      $('#marker-summary').textContent = '';
      return;
    }
    state.markers.forEach(function (m, idx) {
      var st = m._forced ? 'stale' : C.markerState(m, state.baseFps, state.eyes);
      var dev = C.markerDeviation(m, state.eyes);
      var row = document.createElement('div');
      row.className = 'marker-row ' + st;
      row.innerHTML =
        '<div class="marker-head">' +
        '  <span class="marker-id">#' + (idx + 1) + '</span>' +
        '  <span class="marker-frame">主帧 ' + m.masterFrame + '</span>' +
        '  <span class="marker-badge ' + st + '">' + (st === 'valid' ? '有效' : '失效·需复核') + '</span>' +
        '</div>' +
        '<div class="marker-dev">dx <b>' + dev.dx + '</b>px (' + dev.dxPct + '%)' +
        '　dy <b>' + dev.dy + '</b>px (' + dev.dyPct + '%)</div>' +
        '<div class="marker-norm">归一化 dx ' + dev.dxNorm + '% · dy ' + dev.dyNorm + '%</div>' +
        '<div class="marker-actions">' +
        '  <button data-act="goto">定位到该帧</button>' +
        '  <button data-act="recheck">复核重选</button>' +
        '  <button data-act="del">删除</button>' +
        '</div>';
      row.querySelector('[data-act=goto]').onclick = function () {
        gotoFrame(m.masterFrame);
      };
      row.querySelector('[data-act=recheck]').onclick = function () {
        gotoFrame(m.masterFrame);
        state.markers.splice(idx, 1);
        startPick();
      };
      row.querySelector('[data-act=del]').onclick = function () {
        state.markers.splice(idx, 1);
        renderMarkers();
        view.scheduleRender();
        saveAutosave();
      };
      list.appendChild(row);
    });
    renderMarkerSummary();
  }

  function renderMarkerStatusOnly() {
    // 帧位置变化不改有效性，但 dy 显示依赖垂直偏移，需要刷新
    var rows = document.querySelectorAll('.marker-row');
    state.markers.forEach(function (m, idx) {
      var row = rows[idx];
      if (!row) return;
      var st = m._forced ? 'stale' : C.markerState(m, state.baseFps, state.eyes);
      var dev = C.markerDeviation(m, state.eyes);
      row.className = 'marker-row ' + st;
      row.querySelector('.marker-badge').className = 'marker-badge ' + st;
      row.querySelector('.marker-badge').textContent = st === 'valid' ? '有效' : '失效·需复核';
      row.querySelector('.marker-dev').innerHTML =
        'dx <b>' + dev.dx + '</b>px (' + dev.dxPct + '%)' +
        '　dy <b>' + dev.dy + '</b>px (' + dev.dyPct + '%)';
      row.querySelector('.marker-norm').textContent =
        '归一化 dx ' + dev.dxNorm + '% · dy ' + dev.dyNorm + '%';
    });
  }

  function renderMarkerSummary() {
    var valid = state.markers.filter(function (m) {
      return !m._forced && C.markerState(m, state.baseFps, state.eyes) === 'valid';
    });
    var el = $('#marker-summary');
    if (!valid.length) { el.textContent = ''; return; }
    var adx = valid.reduce(function (a, m) { return a + C.markerDeviation(m, state.eyes).dx; }, 0) / valid.length;
    var ady = valid.reduce(function (a, m) { return a + C.markerDeviation(m, state.eyes).dy; }, 0) / valid.length;
    el.textContent = '有效点 ' + valid.length + ' 个 · 平均偏差 dx ' +
      C.round2(adx) + 'px / dy ' + C.round2(ady) + 'px（dy 调到 0 即纵向对齐）';
  }

  /* ---------------- 设置存取 ---------------- */

  function buildSettings() {
    return {
      app: 'stereo-calib',
      version: 1,
      savedAt: new Date().toISOString(),
      baseFps: state.baseFps,
      mode: state.mode,
      overlayMode: state.overlayMode,
      showGrid: state.showGrid,
      showCross: state.showCross,
      showSafe: state.showSafe,
      eyes: {
        left: {
          sourceSig: state.eyes.left.source && state.eyes.left.source.sig,
          sourceName: state.eyes.left.source && state.eyes.left.source.name,
          fps: state.eyes.left.fps,
          timeOffset: state.eyes.left.timeOffset,
          verticalOffset: state.eyes.left.verticalOffset
        },
        right: {
          sourceSig: state.eyes.right.source && state.eyes.right.source.sig,
          sourceName: state.eyes.right.source && state.eyes.right.source.name,
          fps: state.eyes.right.fps,
          timeOffset: state.eyes.right.timeOffset,
          verticalOffset: state.eyes.right.verticalOffset
        }
      },
      markers: state.markers
    };
  }

  function saveAutosave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(buildSettings()));
    } catch (e) { /* 隐私模式等场景忽略 */ }
  }

  function maybeRestoreAutosave() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { return; }
    if (!raw) return;
    var data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    var matchL = state.eyes.left.source && data.eyes.left.sourceSig === state.eyes.left.source.sig;
    var matchR = state.eyes.right.source && data.eyes.right.sourceSig === state.eyes.right.source.sig;
    if (!matchL || !matchR) return;
    applySettings(data, true);
    toast('已按素材签名恢复上次的对齐设置（可在“对齐设置”里清除）');
  }

  function applySettings(data, silent) {
    if (data.baseFps) state.baseFps = Number(data.baseFps) || state.baseFps;
    ['left', 'right'].forEach(function (k) {
      var ed = data.eyes && data.eyes[k];
      if (!ed) return;
      state.eyes[k].timeOffset = Number(ed.timeOffset) || 0;
      state.eyes[k].verticalOffset = Number(ed.verticalOffset) || 0;
      if (ed.fps) {
        state.eyes[k].fps = Number(ed.fps);
        if (state.eyes[k].source && state.eyes[k].source.kind === 'video') {
          state.eyes[k].source.setFps(state.eyes[k].fps);
        } else if (state.eyes[k].source) {
          state.eyes[k].fps = state.eyes[k].source.fps;
        }
      }
    });
    if (data.mode) state.mode = data.mode;
    if (data.overlayMode) state.overlayMode = data.overlayMode;
    if (typeof data.showGrid === 'boolean') state.showGrid = data.showGrid;
    if (typeof data.showCross === 'boolean') state.showCross = data.showCross;
    if (typeof data.showSafe === 'boolean') state.showSafe = data.showSafe;
    if (Array.isArray(data.markers)) {
      // 恢复的标记清掉运行期临时标志，有效性交给 markerState 按素材签名重新判定
      state.markers = data.markers.map(function (m) {
        var copy = Object.assign({}, m);
        delete copy._forced;
        return copy;
      });
      markerSeq = state.markers.reduce(function (a, m) { return Math.max(a, m.id || 0); }, 0);
    }
    syncControlWidgets();
    rebuildGrid();
    renderEyePanels();
    renderTimeline();
    renderMarkers();
    requestRender();
    if (!silent) toast('设置已载入');
  }

  function syncControlWidgets() {
    $('#base-fps').value = state.baseFps;
    document.querySelectorAll('input[name=mode]').forEach(function (r) {
      r.checked = r.value === state.mode;
    });
    document.querySelectorAll('input[name=overlay-mode]').forEach(function (r) {
      r.checked = r.value === state.overlayMode;
      r.disabled = state.mode !== 'overlay';
    });
    $('#chk-grid').checked = state.showGrid;
    $('#chk-cross').checked = state.showCross;
    $('#chk-safe').checked = state.showSafe;
  }

  /* ---------------- 导出对话框 ---------------- */

  async function openExportDialog() {
    if (!bothReady()) { toast('需要两路素材都就绪才能导出', 'error'); return; }
    var dlg = $('#export-dialog');
    var c = ranges.common;
    if (c.hi <= c.lo) { toast('两路没有共同区间，无法导出', 'error'); return; }
    $('#export-start').value = c.lo;
    $('#export-end').value = c.hi - 1;
    $('#export-start').max = c.hi - 1;
    $('#export-end').min = c.lo;
    $('#export-end').max = grid.lastFrame;
    $('#export-start').min = c.lo;
    $('#export-progress-wrap').hidden = true;
    $('#export-msg').textContent = '';
    dlg.classList.add('show');
    await refreshExportThumbs();
  }

  async function refreshExportThumbs() {
    var s = getViewState();
    var sf = parseInt($('#export-start').value, 10);
    var ef = parseInt($('#export-end').value, 10);
    $('#thumb-start').alt = '生成中…';
    $('#thumb-end').alt = '生成中…';
    var a = await exporter.thumbnail(s, sf, 320);
    var b = await exporter.thumbnail(s, ef, 320);
    $('#thumb-start').src = a;
    $('#thumb-end').src = b;
    var len = (ef - sf + 1) / state.baseFps;
    $('#export-msg').textContent =
      '输出 ' + (ef - sf + 1) + ' 帧，时长 ' + len.toFixed(2) + 's，' +
      '起始主帧 ' + sf + '、结束主帧 ' + ef;
  }

  async function runExport() {
    var sf = parseInt($('#export-start').value, 10);
    var ef = parseInt($('#export-end').value, 10);
    if (ef < sf) { toast('结束帧不能早于起始帧', 'error'); return; }
    var signal = { cancel: false };
    var wrap = $('#export-progress-wrap');
    wrap.hidden = false;
    var bar = $('#export-bar');
    bar.style.width = '0%';
    $('#btn-export-go').disabled = true;
    try {
      var res = await exporter.export(getViewState(), {
        startFrame: sf,
        endFrame: ef + 1,
        signal: signal,
        onProgress: function (pct) { bar.style.width = pct + '%'; }
      });
      var ext = res.mimeType.indexOf('vp9') >= 0 ? 'webm' : 'webm';
      var name = 'stereo_sbs_f' + sf + '-' + ef + '.' + ext;
      var url = URL.createObjectURL(res.blob);
      var a = document.createElement('a');
      a.href = url; a.download = name;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('已导出 ' + name + '（' + res.width + '×' + res.height + '，' +
        res.frames + ' 帧）。起止画面可对照上方缩略图核对。');
      $('#export-dialog').classList.remove('show');
    } catch (e) {
      toast('导出失败：' + e.message, 'error');
    } finally {
      $('#btn-export-go').disabled = false;
    }
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    view = new window.StereoView($('#main-canvas'), getViewState);
    exporter = new window.StereoExporter(view);
    view.onPick = handlePick;

    ['left', 'right'].forEach(function (k) {
      $('#eye-' + k + ' .btn-sample').onclick = function () { loadSample(k); };
      $('#eye-' + k + ' .file-input').onchange = function (e) {
        var f = e.target.files[0];
        if (f) loadVideoFile(k, f);
        e.target.value = '';
      };
      $('#eye-' + k + ' .btn-clear').onclick = function () {
        setSource(k, null);
        afterSourcesChanged('已清除' + (k === 'left' ? '左' : '右') + '眼素材');
      };
      $('#eye-' + k + ' .sample-correct').onclick = function () {
        var corr = window.StereoSamples.correction[k];
        state.eyes[k].timeOffset = corr.timeOffset;
        state.eyes[k].verticalOffset = corr.verticalOffset;
        rebuildGrid();
        renderEyePanels();
        renderTimeline();
        renderMarkers();
        requestRender();
        saveAutosave();
        toast('已套用样片校回值：timeOffset ' +
          corr.timeOffset.toFixed(3) + 's，垂直 ' + corr.verticalOffset + 'px');
      };

      var root = $('#eye-' + k);
      root.querySelector('.btn-nudge-time-l').onclick = function () { changeOffset(k, 'time', -1 / state.eyes[k].fps); };
      root.querySelector('.btn-nudge-time-r').onclick = function () { changeOffset(k, 'time', 1 / state.eyes[k].fps); };
      root.querySelector('.btn-nudge-y-u').onclick = function () { changeOffset(k, 'y', -1); };
      root.querySelector('.btn-nudge-y-d').onclick = function () { changeOffset(k, 'y', 1); };

      root.querySelector('.offset-time').onchange = function (e) {
        state.eyes[k].timeOffset = parseFloat(e.target.value) || 0;
        onOffsetChanged(k);
      };
      root.querySelector('.offset-y').onchange = function (e) {
        state.eyes[k].verticalOffset = parseInt(e.target.value, 10) || 0;
        onVerticalChanged(k);
      };
      root.querySelector('.fps-input').onchange = function (e) {
        var v = parseFloat(e.target.value);
        if (!(v > 0)) { e.target.value = state.eyes[k].fps; return; }
        state.eyes[k].fps = v;
        if (state.eyes[k].source && state.eyes[k].source.kind === 'video') {
          state.eyes[k].source.setFps(v);
        }
        onOffsetChanged(k); // 帧率变化同样使标记失效
      };
    });

    function changeOffset(k, which, delta) {
      if (which === 'time') {
        state.eyes[k].timeOffset = C.round2(state.eyes[k].timeOffset + delta);
      } else {
        state.eyes[k].verticalOffset += delta;
      }
      if (which === 'time') onOffsetChanged(k); else onVerticalChanged(k);
    }

    function onOffsetChanged(k) {
      // 时间偏移/帧率变化 -> 标记失效
      rebuildGrid();
      renderEyePanels();
      renderTimeline();
      renderMarkers();
      requestRender();
      saveAutosave();
    }

    function onVerticalChanged(k) {
      // 垂直偏移不使标记失效：dy 实时变化正是对齐操作的反馈
      renderEyePanels();
      renderMarkers();
      requestRender();
      saveAutosave();
    }

    // 时间线
    var track = $('#timeline-track');
    track.addEventListener('mousedown', function (e) {
      if (e.target.classList.contains('timeline-seg')) return;
      seekFromEvent(e);
      var move = function (ev) { seekFromEvent(ev); };
      var up = function () {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    function seekFromEvent(e) {
      var rect = track.getBoundingClientRect();
      var ratio = C.clamp((e.clientX - rect.left) / rect.width, 0, 1);
      gotoFrame(Math.round(ratio * grid.frameCount));
    }

    $('#timeline-input').oninput = function (e) { gotoFrame(e.target.value); };
    $('#btn-prev').onclick = function () { nudgeFrame(-1); };
    $('#btn-next').onclick = function () { nudgeFrame(1); };
    $('#btn-play').onclick = function () { setPlaying(!playing); };
    $('#btn-goto-start').onclick = function () {
      if (ranges) gotoFrame(ranges.common.lo);
    };
    $('#btn-goto-end').onclick = function () {
      if (ranges) gotoFrame(ranges.common.hi - 1);
    };

    $('#base-fps').onchange = function (e) {
      var v = parseFloat(e.target.value);
      if (!(v > 0)) { e.target.value = state.baseFps; return; }
      state.baseFps = v;
      rebuildGrid();
      renderTimeline();
      renderMarkers();
      requestRender();
      saveAutosave();
    };

    // 显示模式
    document.querySelectorAll('input[name=mode]').forEach(function (r) {
      r.onchange = function () {
        state.mode = r.value;
        syncControlWidgets();
        view.cancelPick();
        requestRender();
        saveAutosave();
      };
    });
    document.querySelectorAll('input[name=overlay-mode]').forEach(function (r) {
      r.onchange = function () {
        state.overlayMode = r.value;
        requestRender();
        saveAutosave();
      };
    });
    $('#chk-grid').onchange = function (e) { state.showGrid = e.target.checked; requestRender(); saveAutosave(); };
    $('#chk-cross').onchange = function (e) { state.showCross = e.target.checked; requestRender(); saveAutosave(); };
    $('#chk-safe').onchange = function (e) { state.showSafe = e.target.checked; requestRender(); saveAutosave(); };

    // 缩放
    $('#btn-zoom-in').onclick = function () { view.setZoom(view.zoom * 1.25); };
    $('#btn-zoom-out').onclick = function () { view.setZoom(view.zoom / 1.25); };
    $('#btn-zoom-fit').onclick = function () { view.resetView(); };

    // 标记
    $('#btn-pick').onclick = startPick;
    $('#btn-cancel-pick').onclick = function () { view.cancelPick(); };
    $('#btn-clear-markers').onclick = function () {
      state.markers = [];
      renderMarkers();
      view.scheduleRender();
      saveAutosave();
    };

    // 设置
    $('#btn-save-settings').onclick = function () {
      var blob = new Blob([JSON.stringify(buildSettings(), null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'stereo_alignment_settings.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast('对齐设置已保存为 JSON');
    };
    $('#settings-file').onchange = function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          applySettings(JSON.parse(reader.result), false);
        } catch (err) {
          toast('设置文件解析失败：' + err.message, 'error');
        }
      };
      reader.readAsText(f);
      e.target.value = '';
    };
    $('#btn-clear-autosave').onclick = function () {
      localStorage.removeItem(STORAGE_KEY);
      toast('已清除本机自动保存的设置');
    };

    // 导出
    $('#btn-export').onclick = openExportDialog;
    $('#export-close').onclick = function () { $('#export-dialog').classList.remove('show'); };
    $('#btn-export-go').onclick = runExport;
    $('#export-start').onchange = refreshExportThumbs;
    $('#export-end').onchange = refreshExportThumbs;

    // 键盘
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'radio' && e.target.type !== 'checkbox') return;
      if (e.key === 'Escape') { view.cancelPick(); return; }
      if (e.key === 'ArrowLeft') { nudgeFrame(e.shiftKey ? -10 : -1); }
      else if (e.key === 'ArrowRight') { nudgeFrame(e.shiftKey ? 10 : 1); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    });

    window.addEventListener('resize', function () { view.resize(); });
  }

  /* ---------------- 自动演示（?demo=...，供截图与快速体验） ---------------- */

  function runDemo(mode) {
    loadSample('left');
    loadSample('right');
    rebuildGrid();
    renderEyePanels();
    renderTimeline();

    function step(fn) {
      return new Promise(function (resolve) {
        requestAnimationFrame(function () {
          fn();
          requestRender();
          setTimeout(resolve, 120);
        });
      });
    }

    return (async function () {
      await step(function () { gotoFrame(24); });

      if (mode === 'samples') {
        // 默认并排，展示右眼错拍与偏高
      } else if (mode === 'overlay') {
        state.mode = 'overlay';
        state.overlayMode = 'alpha';
        syncControlWidgets();
      } else if (mode === 'corrected') {
        state.eyes.left.timeOffset = window.StereoSamples.correction.left.timeOffset;
        state.eyes.left.verticalOffset = window.StereoSamples.correction.left.verticalOffset;
        state.eyes.right.timeOffset = window.StereoSamples.correction.right.timeOffset;
        state.eyes.right.verticalOffset = window.StereoSamples.correction.right.verticalOffset;
        rebuildGrid();
        renderEyePanels();
        renderTimeline();
        // 校回后在同一主帧加一对参考点验证 dy=0
        var m = C.createMarker(++markerSeq, 24, state.baseFps, state.eyes, {
          left: { x: 320, y: 180 }, right: { x: 320, y: 180 }
        });
        state.markers.push(m);
        renderMarkers();
      } else if (mode === 'missing') {
        // 把右眼强行后移，制造时间线两端的缺帧区
        state.eyes.right.timeOffset = 0.4;
        rebuildGrid();
        renderEyePanels();
        renderTimeline();
        gotoFrame(2);
      }
      await step(function () {});
      await step(function () {});
      view.resize();
      requestRender();
    })();
  }

  /* ---------------- 启动 / 自检 ---------------- */

  function init() {
    bindEvents();
    syncControlWidgets();
    renderEyePanels();
    renderTimeline();
    renderMarkers();
    view.resize();
    requestRender();

    var params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      runDemo(params.get('demo') || 'samples');
    }

    // headless 自检钩子：#selftest 存在时由 tests/browser-selftest.js 驱动
    if (window.STEREO_SELFTEST) {
      window.STEREO_SELFTEST.run({
        state: state,
        getState: getViewState,
        view: function () { return view; },
        loadSample: loadSample,
        gotoFrame: gotoFrame,
        rebuildGrid: rebuildGrid,
        requestRender: requestRender,
        renderMarkers: renderMarkers,
        applySettings: applySettings,
        toast: toast
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
