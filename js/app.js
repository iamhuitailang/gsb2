/*
 * app.js — 界面编排：加载、总览、试听表桥、选区频带分析、
 * 风险段落、调整链、导出回读。
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  // ---------------- 全局状态 ----------------
  var state = {
    sourceName: '',
    sampleRate: 0,
    origL: null,            // 原始左右声道（永不修改）
    origR: null,
    procL: null,            // 当前处理链结果（试听/导出/分析都用它）
    procR: null,
    mono: null,             // 处理结果的折叠单声道
    settings: DSP.defaultSettings(),
    mode: 'stereo',
    selection: null,        // { startFrame, endFrame }
    segments: [],
    overviewOrig: null,
    overviewProc: null,
    abTimer: null,
    abStereoNext: true,
    rafId: null,
    rebuildTimer: null,
  };

  var engine = new AudioEngine();
  engine.onEnded = function () {
    $('playBtn').textContent = '播放';
  };

  // ---------------- 小工具 ----------------
  function fmtTime(sec) {
    if (!isFinite(sec)) return '--:--.-';
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    return ('0' + m).slice(-2) + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function fmtDb(db) {
    if (db === null) return '—';
    if (!isFinite(db)) return db < 0 ? '全抵消' : '∞ dB';
    return db.toFixed(2) + ' dB';
  }

  function classOfDb(db, warnAt, dangerAt) {
    if (db === null || !isFinite(db)) return db === null ? '' : 'danger';
    if (db <= dangerAt) return 'danger';
    if (db <= warnAt) return 'warn';
    return 'ok';
  }

  function dbEl(db, warnAt, dangerAt) {
    var cls = classOfDb(db, warnAt, dangerAt);
    return '<td class="' + cls + '">' + fmtDb(db) + '</td>';
  }

  function showBanner(el, level, text) {
    el.className = 'hint-banner ' + level;
    el.textContent = text;
  }

  function hideBanner(el) {
    el.className = 'hint-banner hidden';
    el.textContent = '';
  }

  // ---------------- 加载 ----------------
  function loadTrack(name, left, right, sampleRate) {
    stopAB();
    engine.stop();
    $('playBtn').textContent = '播放';

    state.sourceName = name;
    state.sampleRate = sampleRate;
    state.origL = left;
    state.origR = right;
    state.settings = DSP.defaultSettings();
    state.selection = null;
    state.segments = [];
    hold.L = hold.R = hold.M = 0; // 重置表桥峰值保持，避免残留上一个文件的峰值

    rebuildProcessed(true);
    syncChainControls();
    enableControls(true);

    var secs = left.length / sampleRate;
    $('fileInfo').textContent =
      name + ' · ' + sampleRate + ' Hz · 双声道 · ' +
      secs.toFixed(2) + ' 秒 · ' + left.length + ' 帧';
    $('timeDisplay').textContent = '00:00.0 / ' + fmtTime(secs);
    $('selectionInfo').textContent = '在波形上拖拽选择一段，单击则移动播放头';
    hideBanner($('hintBanner'));
    $('bandTable').querySelector('tbody').innerHTML = '';
    hideBanner($('bandVerdict'));
    $('exportTable').querySelector('tbody').innerHTML = '';
    drawOverview();
    renderSegments();
    updatePreviewTable();
    updateCompensation();
    startRaf();
  }

  function enableControls(on) {
    ['playBtn', 'stopBtn', 'playSelectionBtn', 'loopSelectionBtn',
     'clearSelectionBtn', 'analyzeBtn', 'resetChainBtn',
     'exportStereoBtn', 'exportMonoBtn', 'abToggleBtn',
     'delayL', 'delayR', 'width'].forEach(function (id) { $(id).disabled = !on; });
  }

  $('fileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var decoded = WAV.decodeWav(reader.result);
        if (decoded.channels !== 2) {
          alert('需要双声道（立体声）WAV，当前文件声道数为 ' + decoded.channels + '。');
          return;
        }
        loadTrack(file.name, decoded.data[0], decoded.data[1], decoded.sampleRate);
      } catch (err) {
        alert('WAV 解析失败：' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = ''; // 允许再次选择同名文件
  });

  document.querySelectorAll('.sample-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      try {
        var s = Samples.generate(btn.dataset.sample);
        loadTrack('内置样例：' + s.name, s.left, s.right, s.sampleRate);
        showBanner($('hintBanner'), 'info', s.name + '：' + s.description);
      } catch (err) {
        alert('样例加载失败：' + err.message);
      }
    });
  });

  // ---------------- 处理链重建 ----------------
  function rebuildProcessed(immediate) {
    if (!state.origL) return;
    if (state.rebuildTimer) clearTimeout(state.rebuildTimer);
    var run = function () {
      var pos = engine.getPosition();
      var wasPlaying = engine.isPlaying();
      var out = DSP.applyChain(state.origL, state.origR, state.sampleRate, state.settings);
      state.procL = out.left;
      state.procR = out.right;
      state.mono = DSP.foldMono(out.left, out.right);
      state.overviewProc = DSP.buildOverview(state.procL, state.procR, 900);
      state.segments = Analysis.scanSegments(state.procL, state.procR, state.sampleRate);

      engine.setTrack(state.procL, state.procR, state.sampleRate);
      if (wasPlaying) engine.play(pos);
      updateCompensation();
      drawOverview();
      renderSegments();
      updatePreviewTable();
      refreshGlobalHint();
      if (state.selection) analyzeSelection(false);
    };
    if (immediate) {
      // 首次加载时还需要原始总览
      state.overviewOrig = DSP.buildOverview(state.origL, state.origR, 900);
      run();
    } else {
      state.rebuildTimer = setTimeout(run, 120); // 拖动滑块时合并刷新
    }
  }

  function refreshGlobalHint() {
    var g = Analysis.globalState(state.procL, state.procR);
    if (g.state === 'silence') {
      showBanner($('hintBanner'), 'warn', '提示：整段信号为静音（左右声道 RMS 均低于阈值）。');
    } else if (g.state === 'one-sided') {
      showBanner($('hintBanner'), 'warn',
        '提示：仅' + (g.side === 'L' ? '左' : '右') +
        '声道有声音，另一声道为静音；折叠单声道电平会比立体声低约 6 dB。');
    } else if (state.segments.some(function (s) { return s.kind === 'cancel'; })) {
      showBanner($('hintBanner'), 'danger',
        '检测到折叠抵消段落（红色），可在第 ④ 节定位并做 A/B 试听。');
    } else {
      hideBanner($('hintBanner'));
    }
  }

  // ---------------- 调整链控件 ----------------
  function syncChainControls() {
    var s = state.settings;
    $('polLBtn').classList.toggle('flip', s.flipL);
    $('polRBtn').classList.toggle('flip', s.flipR);
    $('polLBtn').textContent = s.flipL ? '反转 (−)' : '正常 (+)';
    $('polRBtn').textContent = s.flipR ? '反转 (−)' : '正常 (+)';
    $('delayL').value = s.delayLMs;
    $('delayR').value = s.delayRMs;
    $('width').value = s.widthPct;
    $('delayLVal').textContent = s.delayLMs.toFixed(1) + ' ms';
    $('delayRVal').textContent = s.delayRMs.toFixed(1) + ' ms';
    $('widthVal').textContent = s.widthPct + '%';
  }

  $('polLBtn').addEventListener('click', function () {
    state.settings.flipL = !state.settings.flipL;
    syncChainControls();
    rebuildProcessed(false);
  });
  $('polRBtn').addEventListener('click', function () {
    state.settings.flipR = !state.settings.flipR;
    syncChainControls();
    rebuildProcessed(false);
  });

  [['delayL', 'delayLMs', 'delayLVal', function (v) { return v.toFixed(1) + ' ms'; }],
   ['delayR', 'delayRMs', 'delayRVal', function (v) { return v.toFixed(1) + ' ms'; }],
   ['width', 'widthPct', 'widthVal', function (v) { return v + '%'; }]
  ].forEach(function (cfg) {
    $(cfg[0]).addEventListener('input', function () {
      state.settings[cfg[1]] = parseFloat(this.value);
      $(cfg[2]).textContent = cfg[3](state.settings[cfg[1]]);
      rebuildProcessed(false);
    });
  });

  $('resetChainBtn').addEventListener('click', function () {
    state.settings = DSP.defaultSettings();
    syncChainControls();
    rebuildProcessed(false);
  });

  function updatePreviewTable() {
    if (!state.origL) return;
    var s = state.settings;
    var origMono = DSP.foldMono(state.origL, state.origR);
    var rows = [];

    function row(label, orig, proc, isDb) {
      var delta = proc - orig;
      var dTxt = isDb
        ? (Math.abs(delta) < 0.005 ? '±0.00 dB' : (delta > 0 ? '+' : '') + delta.toFixed(2) + ' dB')
        : (Math.abs(delta) < 1e-6 ? '0' : (delta > 0 ? '+' : '') + delta.toFixed(6));
      var cls = isDb ? classOfDb(delta, -0.01, -6) : '';
      rows.push('<tr><td>' + label + '</td><td>' + orig + '</td><td>' +
        proc + '</td><td class="' + cls + '">' + dTxt + '</td></tr>');
    }

    row('左声道峰值（线性）',
      DSP.peak(state.origL).toFixed(6), DSP.peak(state.procL).toFixed(6), false);
    row('右声道峰值（线性）',
      DSP.peak(state.origR).toFixed(6), DSP.peak(state.procR).toFixed(6), false);
    row('左声道峰值 dBFS',
      DSP.toDb(DSP.peak(state.origL)).toFixed(2),
      DSP.toDb(DSP.peak(state.procL)).toFixed(2), true);
    row('右声道峰值 dBFS',
      DSP.toDb(DSP.peak(state.origR)).toFixed(2),
      DSP.toDb(DSP.peak(state.procR)).toFixed(2), true);
    row('折叠单声道峰值 dBFS',
      DSP.toDb(DSP.peak(origMono)).toFixed(2),
      DSP.toDb(DSP.peak(state.mono)).toFixed(2), true);
    row('折叠单声道 RMS dBFS',
      DSP.toDb(DSP.rms(origMono)).toFixed(2),
      DSP.toDb(DSP.rms(state.mono)).toFixed(2), true);
    row('整体相关度',
      String((DSP.correlation(state.origL, state.origR) || 0).toFixed(3)),
      String((DSP.correlation(state.procL, state.procR) || 0).toFixed(3)), false);

    rows.push('<tr class="muted"><td colspan="4">当前设置：L 极性 ' +
      (s.flipL ? '反转' : '正常') + '，R 极性 ' + (s.flipR ? '反转' : '正常') +
      '，L 延时 ' + s.delayLMs.toFixed(1) + ' ms，R 延时 ' + s.delayRMs.toFixed(1) +
      ' ms，宽度 ' + s.widthPct + '%</td></tr>');
    $('previewTable').querySelector('tbody').innerHTML = rows.join('');
  }

  // ---------------- 试听模式 / 播放 ----------------
  document.querySelectorAll('.mode-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.mode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      engine.setMode(state.mode);
      updateCompensation();
    });
  });

  function updateCompensation() {
    if (!state.procL) return;
    var g = DSP.compensationGain(state.procL, state.procR, state.mode);
    var enabled = $('compCheck').checked;
    engine.setCompensation(enabled, g);
    engine.applyCompNow();
    $('compValue').textContent = enabled
      ? '当前补偿 ' + (DSP.toDb(g)).toFixed(2) + ' dB'
      : '（已关闭）';
  }

  $('compCheck').addEventListener('change', updateCompensation);

  $('playBtn').addEventListener('click', function () {
    if (engine.isPlaying()) {
      engine.pause();
      $('playBtn').textContent = '播放';
    } else {
      engine.play();
      $('playBtn').textContent = '暂停';
    }
  });

  $('stopBtn').addEventListener('click', function () {
    engine.stop();
    $('playBtn').textContent = '播放';
  });

  $('playSelectionBtn').addEventListener('click', function () {
    if (!state.selection) return;
    engine.setLoop(null, null);
    $('loopSelectionBtn').textContent = '循环选区：关';
    engine.play(state.selection.startFrame / state.sampleRate);
    $('playBtn').textContent = '暂停';
  });

  $('loopSelectionBtn').addEventListener('click', function () {
    if (!state.selection) return;
    var looping = this.textContent.indexOf('开') >= 0;
    if (looping) {
      engine.setLoop(null, null);
      this.textContent = '循环选区：关';
    } else {
      engine.setLoop(
        state.selection.startFrame / state.sampleRate,
        state.selection.endFrame / state.sampleRate);
      this.textContent = '循环选区：开';
      if (!engine.isPlaying()) {
        engine.play(state.selection.startFrame / state.sampleRate);
        $('playBtn').textContent = '暂停';
      }
    }
  });

  $('clearSelectionBtn').addEventListener('click', function () {
    state.selection = null;
    engine.setLoop(null, null);
    $('loopSelectionBtn').textContent = '循环选区：关';
    $('selectionInfo').textContent = '在波形上拖拽选择一段，单击则移动播放头';
    drawOverview();
  });

  // ---------------- A/B 对比 ----------------
  function playSegment(seg, mode) {
    state.mode = mode;
    document.querySelectorAll('.mode-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    engine.setMode(mode);
    updateCompensation();
    engine.setLoop(seg.startSec, seg.endSec);
    engine.play(seg.startSec);
    $('playBtn').textContent = '暂停';
  }

  function stopAB() {
    if (state.abTimer) {
      clearInterval(state.abTimer);
      state.abTimer = null;
    }
    $('abToggleBtn').textContent = 'A/B 自动轮流（每 2 秒）';
  }

  $('abToggleBtn').addEventListener('click', function () {
    if (state.abTimer) {
      stopAB();
      return;
    }
    var seg = state.segments.filter(function (s) { return s.kind === 'cancel'; })[0];
    if (!seg) { alert('当前没有折叠抵消段落可供对比。'); return; }
    state.abStereoNext = true;
    this.textContent = '停止 A/B 轮流';
    var step = function () {
      // 注意：playSegment 不能碰 abTimer，否则定时器会被自己清掉
      playSegment(seg, state.abStereoNext ? 'stereo' : 'mono');
      state.abStereoNext = !state.abStereoNext;
    };
    step();
    state.abTimer = setInterval(step, 2000);
  });

  // ---------------- 总览画布 ----------------
  var overviewCanvas = $('overviewCanvas');
  var drag = null;

  function fitCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth;
    canvas.width = Math.max(320, w * dpr);
    return dpr;
  }

  function frameFromX(x, canvas) {
    var rect = canvas.getBoundingClientRect();
    var ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    return Math.round(ratio * state.procL.length);
  }

  overviewCanvas.addEventListener('mousedown', function (e) {
    if (!state.procL) return;
    drag = { x0: e.clientX, moved: false };
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 4) drag.moved = true;
  });
  window.addEventListener('mouseup', function (e) {
    if (!drag || !state.procL) { drag = null; return; }
    // 只在画布范围内松开才处理；画布外松开视为取消
    var rect = overviewCanvas.getBoundingClientRect();
    var inside = e.clientX >= rect.left && e.clientX <= rect.right &&
      e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (inside) {
      var f = frameFromX(e.clientX, overviewCanvas);
      if (drag.moved) {
        var f0 = frameFromX(drag.x0, overviewCanvas);
        var lo = Math.max(0, Math.min(f0, f));
        var hi = Math.min(state.procL.length, Math.max(f0, f));
        if (hi - lo > 1) {
          state.selection = { startFrame: lo, endFrame: hi };
          var sr = state.sampleRate;
          $('selectionInfo').textContent = '选区：' +
            fmtTime(lo / sr) + ' → ' + fmtTime(hi / sr) +
            '（' + ((hi - lo) / sr).toFixed(3) + ' 秒）';
        }
      } else {
        engine.play(f / state.sampleRate);
        $('playBtn').textContent = '暂停';
      }
    }
    drag = null;
    drawOverview();
  });

  var SEG_COLORS = {
    cancel: 'rgba(239,107,107,.28)',
    'one-sided': 'rgba(180,135,240,.28)',
    silence: 'rgba(91,102,117,.35)',
  };

  function drawOverview() {
    if (!state.procL) return;
    var canvas = overviewCanvas;
    var dpr = fitCanvas(canvas);
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = W / dpr, h = H / dpr;
    ctx.clearRect(0, 0, w, h);

    var ov = state.overviewProc;
    var n = state.procL.length;
    var pad = 6;
    var rowH = (h - pad * 2) / 4;
    var xOf = function (frame) { return frame / n * w; };

    // 风险段落底色（覆盖全部四行）
    state.segments.forEach(function (seg) {
      ctx.fillStyle = SEG_COLORS[seg.kind];
      ctx.fillRect(xOf(seg.startFrame), 0,
        Math.max(2, xOf(seg.endFrame) - xOf(seg.startFrame)), h);
    });

    // 选区
    if (state.selection) {
      ctx.fillStyle = 'rgba(78,161,255,.18)';
      ctx.fillRect(xOf(state.selection.startFrame), 0,
        xOf(state.selection.endFrame) - xOf(state.selection.startFrame), h);
    }

    function waveformRow(rowIdx, getPeak, color) {
      var cy = pad + rowIdx * rowH + rowH / 2;
      var amp = rowH / 2 - 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ov.forEach(function (b, i) {
        var x = i / (ov.length - 1) * w;
        var y = cy - getPeak(b) * amp;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.beginPath();
      ov.forEach(function (b, i) {
        var x = i / (ov.length - 1) * w;
        var y = cy + getPeak(b) * amp;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    waveformRow(0, function (b) { return b.peakL; }, '#6fb2ff');
    waveformRow(1, function (b) { return b.peakR; }, '#36c08a');

    // 行标签
    ctx.fillStyle = '#8b97a6';
    ctx.font = '10px sans-serif';
    ctx.fillText('L', 4, pad + 10);
    ctx.fillText('R', 4, pad + rowH + 10);
    ctx.fillText('相关', 4, pad + 2 * rowH + 10);
    ctx.fillText('折叠 dB', 4, pad + 3 * rowH + 10);

    // 相关度行：中线 0，向上为正
    var corrTop = pad + 2 * rowH;
    ctx.strokeStyle = 'rgba(139,151,166,.4)';
    ctx.beginPath();
    ctx.moveTo(0, corrTop + rowH / 2);
    ctx.lineTo(w, corrTop + rowH / 2);
    ctx.stroke();
    ctx.strokeStyle = '#e8b34b';
    ctx.beginPath();
    ov.forEach(function (b, i) {
      var x = i / (ov.length - 1) * w;
      var v = b.corr === null ? 0 : b.corr;
      var y = corrTop + rowH / 2 - v * (rowH / 2 - 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 原始信号相关度参考（灰色虚线），调整后为上方实线
    if (state.overviewOrig) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(180,190,205,.55)';
      ctx.beginPath();
      state.overviewOrig.forEach(function (b, i) {
        var x = i / (ov.length - 1) * w;
        var v = b.corr === null ? 0 : b.corr;
        var y = corrTop + rowH / 2 - v * (rowH / 2 - 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 折叠损失行：0 dB 在顶部，-24 dB 及以下到底
    var foldTop = pad + 3 * rowH;
    ctx.strokeStyle = 'rgba(139,151,166,.4)';
    [0, -6, -12].forEach(function (db) {
      var y = foldTop + Math.min(1, -db / 24) * (rowH - 4) + 2;
      ctx.strokeStyle = db === -6 ? 'rgba(239,107,107,.5)' : 'rgba(139,151,166,.25)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    });
    ctx.strokeStyle = '#ef6b6b';
    ctx.beginPath();
    ov.forEach(function (b, i) {
      var x = i / (ov.length - 1) * w;
      var loss = b.foldDb === null ? 0 : Math.max(-24, b.foldDb);
      var y = foldTop + Math.min(1, -loss / 24) * (rowH - 4) + 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 原始信号折叠损失参考（灰色虚线），调整后为上方红色实线
    if (state.overviewOrig) {
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(180,190,205,.55)';
      ctx.beginPath();
      state.overviewOrig.forEach(function (b, i) {
        var x = i / (ov.length - 1) * w;
        var loss = b.foldDb === null ? 0 : Math.max(-24, b.foldDb);
        var y = foldTop + Math.min(1, -loss / 24) * (rowH - 4) + 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 播放头
    var pos = engine.getPosition();
    var px = pos / (n / state.sampleRate) * w;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();
  }

  // ---------------- 实时表桥 ----------------
  var meterCanvases = {
    L: $('meterL'), R: $('meterR'), M: $('meterM'),
    corr: $('meterCorr'), fold: $('meterFold'),
  };

  function drawLevelMeter(canvas, level, hold, maxDb) {
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    }
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var db = level < 1e-7 ? maxDb : Math.max(maxDb, DSP.toDb(level));
    var ratio = 1 - db / maxDb;
    var hue = ratio > 0.9 ? '#ef6b6b' : ratio > 0.7 ? '#e8b34b' : '#36c08a';
    ctx.fillStyle = hue;
    ctx.fillRect(0, 0, w * ratio, h);
    if (hold > 0) {
      var hx = w * (1 - Math.max(maxDb, DSP.toDb(hold)) / maxDb);
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.fillRect(hx - 1, 0, 2, h);
    }
  }

  function drawBipolarMeter(canvas, value, minV, maxV, colorFn) {
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) {
      canvas.width = Math.round(canvas.clientWidth * dpr);
      canvas.height = Math.round(canvas.clientHeight * dpr);
    }
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var mid = w * (0 - minV) / (maxV - minV);
    ctx.strokeStyle = 'rgba(139,151,166,.6)';
    ctx.beginPath(); ctx.moveTo(mid, 0); ctx.lineTo(mid, h); ctx.stroke();
    var x = w * (value - minV) / (maxV - minV);
    ctx.fillStyle = colorFn(value);
    if (value >= 0) ctx.fillRect(mid, 4, x - mid, h - 8);
    else ctx.fillRect(x, 4, mid - x, h - 8);
  }

  var hold = { L: 0, R: 0, M: 0 };
  function startRaf() {
    if (state.rafId) return;
    var loop = function () {
      state.rafId = requestAnimationFrame(loop);
      if (!state.procL) return;
      engine.tick();
      var pos = engine.getPosition();
      $('timeDisplay').textContent =
        fmtTime(pos) + ' / ' + fmtTime(state.procL.length / state.sampleRate);
      drawOverview();

      var td = engine.getTimeDomain();
      if (!td) return;
      var lvlL = DSP.rms(td.l), lvlR = DSP.rms(td.r);
      var m = new Float32Array(td.l.length);
      var sum = 0;
      for (var i = 0; i < td.l.length; i++) {
        m[i] = (td.l[i] + td.r[i]) * 0.5;
        sum += m[i] * m[i];
      }
      var lvlM = Math.sqrt(sum / m.length);
      ['L', 'R', 'M'].forEach(function (k) {
        var v = k === 'L' ? lvlL : k === 'R' ? lvlR : lvlM;
        hold[k] = Math.max(v, hold[k] * 0.995);
      });
      drawLevelMeter(meterCanvases.L, lvlL, hold.L, -60);
      drawLevelMeter(meterCanvases.R, lvlR, hold.R, -60);
      drawLevelMeter(meterCanvases.M, lvlM, hold.M, -60);

      var corr = DSP.correlation(td.l, td.r);
      if (corr === null) corr = 0;
      $('corrText').textContent = corr.toFixed(2);
      drawBipolarMeter(meterCanvases.corr, corr, -1, 1, function (v) {
        return v < -0.55 ? '#ef6b6b' : v < 0 ? '#e8b34b' : '#36c08a';
      });

      var ref = (lvlL + lvlR) * 0.5;
      var foldDb = ref > 1e-7 ? DSP.toDb(lvlM) - DSP.toDb(ref) : 0;
      $('foldText').textContent = foldDb.toFixed(1) + ' dB';
      drawBipolarMeter(meterCanvases.fold, foldDb, -24, 0, function (v) {
        return v <= -12 ? '#ef6b6b' : v <= -6 ? '#e8b34b' : '#36c08a';
      });
    };
    state.rafId = requestAnimationFrame(loop);
  }

  // ---------------- 选区频带分析 ----------------
  $('analyzeBtn').addEventListener('click', function () { analyzeSelection(true); });

  function analyzeSelection(manual) {
    if (!state.selection) {
      if (manual) alert('请先在总览波形上拖拽选择一段。');
      return;
    }
    var sel = state.selection;
    var stats = DSP.bandStats(state.procL, state.procR, state.sampleRate,
      sel.startFrame, sel.endFrame);
    var labels = [['low', '低频 (≤250 Hz)'], ['mid', '中频 (250–4000 Hz)'],
                  ['high', '高频 (≥4000 Hz)']];
    var html = labels.map(function (pair) {
      var b = stats[pair[0]];
      return '<tr><td>' + pair[1] + '</td>' +
        '<td>' + fmtDb(DSP.toDb(b.rmsL)) + '</td>' +
        '<td>' + fmtDb(DSP.toDb(b.rmsR)) + '</td>' +
        '<td>' + fmtDb(DSP.toDb(b.rmsM)) + '</td>' +
        dbEl(b.foldDb, -6, -12) +
        '<td>' + (b.corr === null ? '—' : b.corr.toFixed(3)) + '</td>' +
        '<td>' + (b.peakM < 1e-7 ? '—' : DSP.toDb(b.peakM).toFixed(2) + ' dBFS') +
        '</td></tr>';
    }).join('');
    $('bandTable').querySelector('tbody').innerHTML = html;

    var verdict = Analysis.foldVerdict(stats);
    showBanner($('bandVerdict'), verdict.level, verdict.text);
  }

  // ---------------- 风险段落表 ----------------
  var KIND_META = {
    cancel: { badge: 'cancel', label: '折叠抵消' },
    'one-sided': { badge: 'one', label: '单边有声' },
    silence: { badge: 'silence', label: '静音' },
  };

  function renderSegments() {
    var tbody = $('segmentTable').querySelector('tbody');
    if (!state.procL) { tbody.innerHTML = ''; return; }
    if (state.segments.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">未检测到静音、单边或折叠抵消段落。</td></tr>';
      $('scanNote').textContent = '';
      return;
    }
    $('scanNote').textContent = '基于当前处理链结果扫描，窗长 93 ms';
    tbody.innerHTML = state.segments.map(function (seg, i) {
      var meta = KIND_META[seg.kind];
      var corrTxt = seg.minCorr === null ? '—' : seg.minCorr.toFixed(2);
      var lossTxt = seg.kind === 'cancel'
        ? (!isFinite(seg.maxFoldLossDb) ? '全抵消' : fmtDb(seg.maxFoldLossDb))
        : '—';
      var actions = seg.kind === 'cancel'
        ? '<button class="btn seg-play" data-i="' + i + '" data-mode="stereo">听立体声 A</button> ' +
          '<button class="btn seg-play" data-i="' + i + '" data-mode="mono">听单声道 B</button>'
        : '<button class="btn seg-play" data-i="' + i + '" data-mode="stereo">定位播放</button>';
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td>' + fmtTime(seg.startSec) + ' → ' + fmtTime(seg.endSec) + '</td>' +
        '<td><span class="badge ' + meta.badge + '">' + meta.label + '</span></td>' +
        '<td>' + corrTxt + '</td>' +
        '<td class="' + (seg.kind === 'cancel' ? 'danger' : '') + '">' + lossTxt + '</td>' +
        '<td>' + actions + '</td></tr>';
    }).join('');

    tbody.querySelectorAll('.seg-play').forEach(function (btn) {
      btn.addEventListener('click', function () {
        stopAB(); // 手动 A/B 时停止自动轮流，避免两个控制互相打架
        var seg = state.segments[parseInt(btn.dataset.i, 10)];
        playSegment(seg, btn.dataset.mode);
      });
    });
  }

  // ---------------- 导出与回读 ----------------
  function settingsSnapshot(s) {
    return 'L极性' + (s.flipL ? '反' : '正') +
      ' / R极性' + (s.flipR ? '反' : '正') +
      ' / L延时' + s.delayLMs.toFixed(1) + 'ms' +
      ' / R延时' + s.delayRMs.toFixed(1) + 'ms' +
      ' / 宽度' + s.widthPct + '%';
  }

  function blobToArrayBuffer(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() {
    var d = new Date();
    function p(x) { return ('0' + x).slice(-2); }
    return p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  async function doExport(kind) {
    if (!state.procL) return;
    // 关键：每次导出都现场读取当前设置、现场跑处理链，不使用任何缓存结果，
    // 因此处理链重设后再次导出不会继承上一次的设置。
    var liveSettings = readSettingsFromControls();
    var out = DSP.applyChain(state.origL, state.origR, state.sampleRate, liveSettings);
    var channelsData = kind === 'stereo'
      ? [out.left, out.right]
      : [DSP.foldMono(out.left, out.right)];
    var expectChannels = kind === 'stereo' ? 2 : 1;
    var isFloat = $('bitDepth').value === '32f';
    var blob = isFloat
      ? WAV.encodeWavFloat32(channelsData, state.sampleRate)
      : WAV.encodeWavPcm16(channelsData, state.sampleRate);

    // 期望峰值必须按“实际编码进文件的值”计算：
    // 16-bit PCM 会先夹到 [-1,1] 再量化，处理链可能产生 >1 的采样（宽度加阔、
    // 延时叠加等），若按编码前的原始峰值核对必然误报。
    var expectPeak = 0;
    var rawPeak = 0;
    var isPcm16 = !isFloat;
    channelsData.forEach(function (ch) {
      var p = 0;
      for (var i = 0; i < ch.length; i++) {
        var aRaw = Math.abs(ch[i]);
        if (aRaw > rawPeak) rawPeak = aRaw;
        var v = isPcm16 ? Math.max(-1, Math.min(1, ch[i])) : ch[i];
        var a = Math.abs(v);
        if (a > p) p = a;
      }
      if (p > expectPeak) expectPeak = p;
    });
    if (isPcm16) expectPeak = Math.round(expectPeak * 32767) / 32767;
    var clipping = rawPeak > 1;

    var base = state.sourceName.replace(/\.wav$/i, '').replace(/[\\/:*?"<>|\s]+/g, '_');
    var suffix = kind === 'stereo' ? 'stereo' : 'mono';
    var filename = base + '_' + suffix + '_' + $('bitDepth').value + '_' + stamp() + '.wav';

    // 回读核对：把刚生成的 Blob 重新解码，核对长度/峰值/声道数
    var ab = await blobToArrayBuffer(blob);
    var result = WAV.verifyExport(ab, {
      channels: expectChannels,
      sampleRate: state.sampleRate,
      length: out.left.length,
      peak: expectPeak,
      bitsPerSample: isFloat ? 32 : 16,
    });

    var checkTxt = result.ok
      ? '<span class="ok">✓ 核对通过</span>：' + result.actual.channels + ' 声道 / ' +
        result.actual.sampleRate + ' Hz / ' + result.actual.length + ' 帧 / 峰值 ' +
        result.actual.peak.toFixed(6) +
        (isFloat ? ' / 32-bit float' : ' / 16-bit PCM') +
        (clipping && isPcm16
          ? ' <span class="warn">（原始峰值 ' + rawPeak.toFixed(3) +
            ' 超 1，PCM 已削波；建议改用 32-bit 浮点导出）</span>'
          : '')
      : '<span class="danger">✗ 核对失败</span>：' + result.errors.join('；');

    var row = '<tr><td>' + new Date().toLocaleTimeString() + '</td>' +
      '<td>' + filename + '</td>' +
      '<td>' + settingsSnapshot(liveSettings) + '</td>' +
      '<td>' + checkTxt + '</td></tr>';
    $('exportTable').querySelector('tbody').insertAdjacentHTML('afterbegin', row);

    triggerDownload(blob, filename);
  }

  /** 从控件 DOM 实时读取设置快照（导出专用，杜绝继承旧状态） */
  function readSettingsFromControls() {
    return {
      flipL: $('polLBtn').classList.contains('flip'),
      flipR: $('polRBtn').classList.contains('flip'),
      delayLMs: parseFloat($('delayL').value),
      delayRMs: parseFloat($('delayR').value),
      widthPct: parseFloat($('width').value),
    };
  }

  $('exportStereoBtn').addEventListener('click', function () {
    doExport('stereo').catch(function (err) { alert('导出失败：' + err.message); });
  });
  $('exportMonoBtn').addEventListener('click', function () {
    doExport('mono').catch(function (err) { alert('导出失败：' + err.message); });
  });

  window.addEventListener('resize', function () {
    if (state.procL) drawOverview();
  });
})();
