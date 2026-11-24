/* UI, synchronized transport, waveform overview, charts, and exports. */
(function () {
  'use strict';

  const D = window.DemoDSP;
  const Charts = window.DemoCharts;
  const $ = (id) => document.getElementById(id);

  const SOURCES = [
    { key: 'far', label: '远端声', colorVar: '--far' },
    { key: 'near', label: '近端参考', colorVar: '--near' },
    { key: 'mic', label: '混合录音', colorVar: '--mic' },
    { key: 'adaptive', label: '持续自适应', colorVar: '--adaptive' },
    { key: 'fixed', label: '固定参数', colorVar: '--fixed' }
  ];

  const ui = {};
  let scenario = null;
  let sourceName = 'adaptive';
  let audioCtx = null;
  let buffers = {};
  let activeNode = null;
  let playing = false;
  let startedAt = 0;
  let startOffset = 0;
  let seekOffset = 0;
  let scrubbing = false;
  let rebuildTimer = null;

  function color(varName, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function fmtTime(t) {
    t = Math.max(0, t);
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }
  function dbText(v) { return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`; }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function readParams() {
    return {
      seed: D.FIXED_SEED,
      delay1Ms: Number(ui.delay1.value),
      gain: Number(ui.gain.value),
      reflectionDelayMs: Number(ui.refDelay.value),
      reflectionGain: Number(ui.refGain.value),
      delay2Ms: Number(ui.delay2.value),
      noiseDb: -58
    };
  }

  function updateControlLabels() {
    const p = readParams();
    ui.delay1Val.textContent = `${p.delay1Ms} ms`;
    ui.gainVal.textContent = `${p.gain.toFixed(2)} · ${(20 * Math.log10(p.gain)).toFixed(1)} dB`;
    ui.refDelayVal.textContent = `${p.reflectionDelayMs} ms`;
    ui.refGainVal.textContent = p.reflectionGain === 0
      ? '0 · −∞ dB'
      : `${p.reflectionGain.toFixed(2)} · ${(20 * Math.log10(p.reflectionGain)).toFixed(1)} dB`;
    ui.delay2Val.textContent = `${p.delay2Ms} ms`;
    ui.changeTimeLabel.textContent = `${D.TIMELINE.changeAt.toFixed(2)}s`;
  }

  function setInputsFromFixed() {
    const p = D.FIXED_PARAMS;
    ui.delay1.value = p.delay1Ms;
    ui.gain.value = p.gain;
    ui.refDelay.value = p.reflectionDelayMs;
    ui.refGain.value = p.reflectionGain;
    ui.delay2.value = p.delay2Ms;
    updateControlLabels();
  }

  function setBusy(busy, message) {
    ui.loadingOverlay.hidden = !busy;
    ui.rebuildBtn.disabled = busy;
    ui.buildStatus.classList.toggle('busy', busy);
    if (message) ui.buildStatus.textContent = message;
  }

  function stopNode() {
    if (activeNode) {
      try { activeNode.onended = null; activeNode.stop(); } catch (_) { /* already stopped */ }
      try { activeNode.disconnect(); } catch (_) { /* noop */ }
      activeNode = null;
    }
  }

  function stopPlaybackAndReset() {
    stopNode();
    playing = false;
    seekOffset = 0;
    updatePlayButton();
    updateTransport();
  }

  async function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!scenario) return;
    const token = JSON.stringify(scenario.params);
    if (buffers.__token !== token) {
      buffers = { __token: token };
      for (const key of SOURCES.map((s) => s.key)) {
        const samples = key === 'adaptive'
          ? scenario.adaptive.output
          : key === 'fixed' ? scenario.fixed.output : scenario.signals[key];
        const buf = audioCtx.createBuffer(1, samples.length, scenario.sampleRate);
        buf.getChannelData(0).set(samples);
        buffers[key] = buf;
      }
    }
  }

  function currentPosition() {
    if (scrubbing) return seekOffset;
    if (playing && audioCtx) {
      return clamp(startOffset + audioCtx.currentTime - startedAt, 0, scenario.duration);
    }
    return seekOffset;
  }

  async function startPlayback(offset) {
    if (!scenario) return;
    await ensureAudio();
    stopNode();
    const pos = clamp(offset ?? seekOffset, 0, scenario.duration);
    seekOffset = pos;
    const node = audioCtx.createBufferSource();
    node.buffer = buffers[sourceName];
    node.connect(audioCtx.destination);
    node.onended = () => {
      if (activeNode === node) {
        activeNode = null;
        playing = false;
        seekOffset = scenario.duration;
        updatePlayButton();
        updateTransport();
      }
    };
    node.start(0, pos);
    activeNode = node;
    startedAt = audioCtx.currentTime;
    startOffset = pos;
    playing = true;
    updatePlayButton();
  }

  async function togglePlay() {
    if (!scenario) return;
    if (playing) {
      seekOffset = currentPosition();
      stopNode();
      playing = false;
      updatePlayButton();
      updateTransport();
    } else {
      if (seekOffset >= scenario.duration - 0.03) seekOffset = 0;
      await startPlayback(seekOffset);
    }
  }

  function seekTo(t, beginPlaying = false) {
    if (!scenario) return;
    const pos = clamp(t, 0, scenario.duration);
    seekOffset = pos;
    updateTransport();
    if (playing || beginPlaying) {
      startPlayback(pos);
    }
  }

  function selectSource(key) {
    if (!SOURCES.some((s) => s.key === key)) return;
    const pos = currentPosition();
    const wasPlaying = playing;
    if (wasPlaying) stopNode();
    sourceName = key;
    seekOffset = pos;
    document.querySelectorAll('.source-tab').forEach((btn) => {
      const active = btn.dataset.source === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.wave-row').forEach((row) => {
      row.classList.toggle('selected', row.dataset.source === key);
    });
    if (wasPlaying) startPlayback(pos);
  }

  function updatePlayButton() {
    ui.playLabel.textContent = playing ? '暂停' : '播放';
    ui.playBtn.querySelector('.play-icon').textContent = playing ? '❚❚' : '▶';
    ui.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function updateTransport() {
    if (!scenario) return;
    const pos = currentPosition();
    if (!scrubbing) ui.seek.value = pos.toFixed(3);
    ui.currentTime.textContent = fmtTime(pos);
    ui.durationTime.textContent = fmtTime(scenario.duration);
    const pct = `${(pos / scenario.duration) * 100}%`;
    document.querySelectorAll('.wave-playhead').forEach((p) => { p.style.left = pct; });
  }

  /* ---------------- Waveforms ---------------- */

  function drawRuler(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = color('--grid', '#e1e0d9');
    ctx.fillStyle = color('--muted', '#898781');
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (let t = 0; t <= scenario.duration; t += 2) {
      const x = t / scenario.duration * w;
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, 10); ctx.stroke();
      ctx.fillText(`${t}s`, x + 4, 20);
    }
  }

  function drawWaveform(canvas, key, cssColor, selected) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const x = key === 'adaptive'
      ? scenario.adaptive.output
      : key === 'fixed' ? scenario.fixed.output : scenario.signals[key];
    const mid = h / 2;
    const amp = h * 0.42;
    const samplesPerPixel = x.length / w;

    ctx.strokeStyle = color('--grid', '#e1e0d9');
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    ctx.globalAlpha = selected ? 0.95 : 0.58;
    ctx.strokeStyle = cssColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const a = Math.floor(px * samplesPerPixel);
      const b = Math.min(x.length, Math.max(a + 1, Math.floor((px + 1) * samplesPerPixel)));
      let mn = 0, mx = 0;
      for (let i = a; i < b; i++) {
        const v = x[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const y1 = mid - mx * amp;
      const y2 = mid - mn * amp;
      ctx.moveTo(px + 0.5, y1);
      ctx.lineTo(px + 0.5, y2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  function renderWaveform() {
    if (!scenario) return;
    ui.waveWrap.innerHTML = '';
    const rulerRow = document.createElement('div');
    rulerRow.className = 'wave-ruler';
    rulerRow.innerHTML = '<span></span>';
    const rulerCanvas = document.createElement('canvas');
    rulerCanvas.className = 'ruler-canvas';
    rulerRow.appendChild(rulerCanvas);
    ui.waveWrap.appendChild(rulerRow);
    drawRuler(rulerCanvas);

    for (const source of SOURCES) {
      const row = document.createElement('div');
      row.className = 'wave-row' + (source.key === sourceName ? ' selected' : '');
      row.dataset.source = source.key;
      const label = document.createElement('div');
      label.className = 'wave-label';
      const sw = document.createElement('span');
      sw.className = `swatch ${source.key}`;
      label.appendChild(sw);
      label.appendChild(document.createTextNode(source.label));
      const wrap = document.createElement('div');
      wrap.className = 'wave-canvas-wrap';
      const canvas = document.createElement('canvas');
      canvas.className = 'wave-canvas';
      const head = document.createElement('div');
      head.className = 'wave-playhead';
      wrap.appendChild(canvas);
      wrap.appendChild(head);
      row.appendChild(label);
      row.appendChild(wrap);
      ui.waveWrap.appendChild(row);

      requestAnimationFrame(() => drawWaveform(canvas, source.key, color(source.colorVar, '#2a78d6'), source.key === sourceName));

      const scrubToEvent = (ev) => {
        const rect = wrap.getBoundingClientRect();
        const frac = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        seekTo(frac * scenario.duration);
      };
      row.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        selectSource(source.key);
        row.setPointerCapture(ev.pointerId);
        scrubToEvent(ev);
        const onMove = (e) => scrubToEvent(e);
        const onUp = () => {
          row.removeEventListener('pointermove', onMove);
          row.removeEventListener('pointerup', onUp);
        };
        row.addEventListener('pointermove', onMove);
        row.addEventListener('pointerup', onUp);
      });
    }
    updateTransport();
  }

  /* ---------------- Metrics / charts / table ---------------- */

  function populateMetrics() {
    const s = scenario;
    const init = s.initial;
    ui.lagValue.textContent = `${init.ms.toFixed(1)} ms`;
    ui.lagSub.textContent = `${init.lag} samples · 真值 ${s.params.delay1Ms} ms · 相关 ${init.confidence.toFixed(2)}`;

    if (init.secondLag != null && init.secondConfidence > 0.18) {
      const rel = init.secondMs - init.ms;
      ui.reflectionValue.textContent = `+${rel.toFixed(0)} ms`;
      ui.reflectionSub.textContent = `第二到达 ${init.secondMs.toFixed(0)} ms（绝对）· 相关 ${init.secondConfidence.toFixed(2)} · 真值 +${s.params.reflectionDelayMs}ms`;
    } else {
      ui.reflectionValue.textContent = '无明显峰';
      ui.reflectionSub.textContent = `第二峰相关 ${init.secondConfidence.toFixed(2)}；反射增益较低时会被语音周期峰掩盖`;
    }

    ui.preVolumeValue.textContent = `${init.preDb.toFixed(1)} dBFS`;
    const learn = s.segments[0];
    ui.preVolumeSub.textContent = `学习段 RMS ${init.preRms.toFixed(3)}；自适应处理后 ${learn.adaptiveOutRmsDb.toFixed(1)} dBFS`;

    const ev = s.adaptive.events;
    if (ev.noPathChange) {
      ui.reacquireValue.textContent = '未切换';
      ui.reacquireSub.textContent = '两个延时参数相同，滤波器全程保持锁定';
    } else if (ev.lockedTime != null) {
      ui.reacquireValue.textContent = `${(ev.lockedTime - ev.changeTime).toFixed(2)} s`;
      ui.reacquireSub.textContent = `切换 ${ev.changeTime.toFixed(2)}s → 检测 ${ev.detectedTime.toFixed(2)}s → 锁定 ${ev.lockedTime.toFixed(2)}s`;
    } else {
      ui.reacquireValue.textContent = '未锁定';
      ui.reacquireSub.textContent = `检测时间：${ev.detectedTime ? ev.detectedTime.toFixed(2) + 's' : '—'}`;
    }

    const dt1 = s.segments[1];
    const dt2 = s.segments[3];
    ui.nearKeepValue.textContent = `${dt1.adaptiveNearGain.toFixed(2)}×`;
    ui.nearKeepSub.textContent = `第一次双讲相关 ${dt1.adaptiveNearCorr.toFixed(3)}；第二次增益 ${dt2.adaptiveNearGain.toFixed(2)}×、相关 ${dt2.adaptiveNearCorr.toFixed(3)}`;
  }

  function renderStatusRibbon() {
    const ribbon = ui.statusRibbon;
    ribbon.innerHTML = '';
    const states = scenario.adaptive.stateAtFrame.filter(Boolean);
    const groups = [];
    for (const st of states) {
      const last = groups[groups.length - 1];
      if (last && last.status === st.status && st.frame - last.endFrame <= 1) {
        last.endFrame = st.frame;
      } else {
        groups.push({ status: st.status, startFrame: st.frame, endFrame: st.frame });
      }
    }
    for (const g of groups) {
      const seg = document.createElement('div');
      seg.className = `status-seg ${g.status}`;
      const start = g.startFrame * 0.01;
      const end = (g.endFrame + 1) * 0.01;
      seg.style.width = `${clamp((end - start) / scenario.duration * 100, 0.2, 100)}%`;
      seg.title = `${start.toFixed(2)}–${end.toFixed(2)}s：${g.status}`;
      ribbon.appendChild(seg);
    }
    const marker = document.createElement('div');
    marker.className = 'status-change';
    marker.style.left = `${D.TIMELINE.changeAt / scenario.duration * 100}%`;
    marker.title = `真实延时切换 ${D.TIMELINE.changeAt}s`;
    ribbon.appendChild(marker);
  }

  function renderCharts() {
    if (!scenario) return;
    const w = scenario.windows;
    const xs = w.map((r) => r.time);
    const adaptiveColor = color('--adaptive', '#6250d6');
    const fixedColor = color('--fixed', '#e34948');
    const primaryColor = color('--primary', '#2a78d6');
    const micColor = color('--mic', '#eb6834');
    const textColor = color('--text', '#0b0b0b');
    const goodColor = color('--good', '#0ca30c');
    const changeMarker = { x: D.TIMELINE.changeAt, label: '延时切换', color: color('--critical', '#d03b3b') };
    const lockMarker = scenario.adaptive.events.lockedTime
      ? { x: scenario.adaptive.events.lockedTime, label: '重新锁定', color: goodColor }
      : null;

    Charts.lineChart($('erleChart'), {
      title: '回声抑制量 ERLE（越高越好）',
      description: '用合成器已知的回声分轨计算；双讲时近端仍保留，因此麦克风/输出直接相减会低估消回声量。',
      x: xs,
      yMin: -20,
      yMax: 50,
      yFormat: (v) => `${v}`,
      yTicks: [-20, 0, 10, 20, 30, 40, 50],
      markers: [changeMarker],
      series: [
        { label: '持续自适应', color: adaptiveColor, values: w.map((r) => r.adaptiveErleDb), tooltipFormat: (v) => dbText(v) },
        { label: '固定初始参数', color: fixedColor, values: w.map((r) => r.fixedErleDb), tooltipFormat: (v) => dbText(v) }
      ],
      tableRows: w,
      columns: [
        { key: 'time', label: 't(s)', format: (v) => v.toFixed(2) },
        { key: 'adaptiveErleDb', label: '自适应 ERLE' },
        { key: 'fixedErleDb', label: '固定 ERLE' }
      ]
    });

    const trueLag = w.map((r) => r.time < D.TIMELINE.changeAt ? scenario.params.delay1Ms : scenario.params.delay2Ms);
    const fixedLag = w.map(() => scenario.initial.ms);
    Charts.lineChart($('delayChart'), {
      title: '粗延时跟踪',
      description: '蓝线是连续两次相关确认后、算法实际采用的粗延时；黑线是合成器真实延时阶梯，红虚线是固定参数一直使用的初始估计。',
      x: xs,
      yMin: 50,
      yMax: 370,
      yTicks: [50, 100, 150, 200, 250, 300, 350],
      yFormat: (v) => `${v}`,
      markers: [changeMarker, lockMarker].filter(Boolean),
      series: [
        { label: '算法跟踪延时', color: primaryColor, values: w.map((r) => r.estimatedLagMs), tooltipFormat: (v) => v == null ? '—' : `${v.toFixed(1)} ms` },
        { label: '真实延时', color: textColor, values: trueLag, tooltipFormat: (v) => `${v.toFixed(0)} ms` },
        { label: '固定参数', color: fixedColor, values: fixedLag, dash: '5 4', tooltipFormat: (v) => `${v.toFixed(1)} ms` }
      ],
      tableRows: w,
      columns: [
        { key: 'time', label: 't(s)', format: (v) => v.toFixed(2) },
        { key: 'estimatedLagMs', label: '估计延时(ms)' }
      ]
    });

    Charts.lineChart($('levelChart'), {
      title: '同一时间轴的音量对比（50 ms 窗 RMS）',
      description: '混合录音、持续自适应输出和固定参数输出；双讲段两条输出都应保留近端音节，切换后固定参数会明显变响。',
      x: xs,
      yMin: -70,
      yMax: -10,
      yTicks: [-70, -60, -50, -40, -30, -20, -10],
      yFormat: (v) => `${v}`,
      markers: [changeMarker],
      series: [
        { label: '混合麦克风', color: micColor, values: w.map((r) => r.micDb), tooltipFormat: dbText },
        { label: '持续自适应输出', color: adaptiveColor, values: w.map((r) => r.adaptiveOutDb), tooltipFormat: dbText },
        { label: '固定参数输出', color: fixedColor, values: w.map((r) => r.fixedOutDb), tooltipFormat: dbText }
      ],
      tableRows: w,
      columns: [
        { key: 'time', label: 't(s)', format: (v) => v.toFixed(2) },
        { key: 'micDb', label: '混合 dBFS' },
        { key: 'adaptiveOutDb', label: '自适应 dBFS' },
        { key: 'fixedOutDb', label: '固定 dBFS' },
        { key: 'adaptiveErleDb', label: '自适应 ERLE' },
        { key: 'fixedErleDb', label: '固定 ERLE' },
        { key: 'estimatedLagMs', label: '延时 ms' }
      ]
    });
  }

  function erleClass(v) {
    if (v >= 18) return 'good';
    if (v < 0) return 'bad';
    return '';
  }
  function gainClass(v) {
    return v >= 0.82 && v <= 1.18 ? 'good' : 'bad';
  }

  function renderSegmentTable() {
    const tbody = ui.segmentTable.querySelector('tbody');
    tbody.innerHTML = '';
    for (const s of scenario.segments) {
      const tr = document.createElement('tr');
      const cells = [
        { text: s.segment },
        { text: `${s.startSec.toFixed(2)}–${s.endSec.toFixed(2)}s` },
        { text: `${s.micRmsDb.toFixed(1)}` },
        { text: `${s.adaptiveOutRmsDb.toFixed(1)}` },
        { text: `${s.fixedOutRmsDb.toFixed(1)}` },
        { text: `${s.adaptiveErleDb.toFixed(1)}`, cls: erleClass(s.adaptiveErleDb) },
        { text: `${s.fixedErleDb.toFixed(1)}`, cls: erleClass(s.fixedErleDb) },
        { text: `${s.adaptiveNearGain.toFixed(2)}`, cls: gainClass(s.adaptiveNearGain) },
        { text: `${s.adaptiveNearCorr.toFixed(3)}`, cls: s.adaptiveNearCorr >= 0.85 ? 'good' : '' }
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c.text;
        if (c.cls) td.className = c.cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderRepro() {
    const report = {
      app: 'browser-aec-synthetic-demo',
      seed: scenario.params.seed,
      reproduciblePreset: D.FIXED_PARAMS,
      activeParameters: scenario.params,
      sampleRate: scenario.sampleRate,
      durationSeconds: scenario.duration,
      timeline: scenario.timeline,
      initialEstimate: {
        lagSamples: scenario.initial.lag,
        lagMs: +scenario.initial.ms.toFixed(3),
        confidence: +scenario.initial.confidence.toFixed(4),
        secondLagSamples: scenario.initial.secondLag,
        secondLagMs: scenario.initial.secondMs == null ? null : +scenario.initial.secondMs.toFixed(3),
        preCancellationDbFs: +scenario.initial.preDb.toFixed(3)
      },
      events: scenario.adaptive.events,
      segments: scenario.segments
    };
    ui.reproConfig.textContent = JSON.stringify(report, null, 2);
    return report;
  }

  function renderAll() {
    ui.seek.max = scenario.duration;
    ui.seek.value = 0;
    seekOffset = 0;
    populateMetrics();
    renderStatusRibbon();
    renderSegmentTable();
    renderRepro();
    renderWaveform();
    renderCharts();
    updateTransport();
  }

  async function rebuild(message) {
    if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
    stopPlaybackAndReset();
    setBusy(true, message || '正在合成信号、估计延时并运行两种 AEC…');
    // Let the overlay paint before the synchronous offline DSP block.
    await new Promise((r) => setTimeout(r, 60));
    try {
      const params = readParams();
      scenario = D.buildScenario(params);
      buffers = {};
      renderAll();
      ui.buildStatus.classList.remove('error');
      ui.buildStatus.textContent = `完成：seed ${params.seed}，初始估计 ${scenario.initial.ms.toFixed(1)} ms，重新锁定用时 ${scenario.adaptive.events.reacquireSeconds?.toFixed(2) ?? '—'} s。`;
    } catch (err) {
      console.error(err);
      ui.buildStatus.classList.add('error');
      ui.buildStatus.textContent = `生成失败：${err.message}`;
    } finally {
      setBusy(false);
    }
  }

  function scheduleRebuild() {
    updateControlLabels();
    if (rebuildTimer) clearTimeout(rebuildTimer);
    ui.buildStatus.textContent = '参数已修改，松手后重新生成…';
    rebuildTimer = setTimeout(() => rebuild('正在按新参数重新计算…'), 320);
  }

  function flashButton(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 1200);
  }

  function bindEvents() {
    ui.playBtn.addEventListener('click', togglePlay);
    $('rebuildBtn').addEventListener('click', () => rebuild());
    $('fixedPresetBtn').addEventListener('click', () => {
      setInputsFromFixed();
      rebuild('已恢复固定样例，正在重新计算…');
    });

    for (const id of ['delay1', 'gain', 'refDelay', 'refGain', 'delay2']) {
      ui[id].addEventListener('input', updateControlLabels);
      ui[id].addEventListener('change', scheduleRebuild);
    }

    document.querySelectorAll('.source-tab').forEach((btn) => {
      btn.addEventListener('click', () => selectSource(btn.dataset.source));
    });

    ui.seek.addEventListener('input', () => {
      scrubbing = true;
      seekOffset = Number(ui.seek.value);
      updateTransport();
    });
    ui.seek.addEventListener('change', () => {
      scrubbing = false;
      seekTo(Number(ui.seek.value));
    });

    document.querySelectorAll('[data-seek]').forEach((btn) => {
      btn.addEventListener('click', () => seekTo(Number(btn.dataset.seek), true));
    });
    $('soloNearBtn').addEventListener('click', async () => {
      selectSource('near');
      seekOffset = D.TIMELINE.doubleTalk1Start + 0.12;
      await startPlayback(seekOffset);
    });

    $('exportWavAdaptive').addEventListener('click', (ev) => {
      if (!scenario) return;
      downloadBlob(D.encodeWav(scenario.adaptive.output, scenario.sampleRate), 'aec_adaptive_processed_seed16261.wav');
      flashButton(ev.currentTarget, '已导出 WAV');
    });
    $('exportWavFixed').addEventListener('click', (ev) => {
      if (!scenario) return;
      downloadBlob(D.encodeWav(scenario.fixed.output, scenario.sampleRate), 'aec_fixed_parameters_seed16261.wav');
      flashButton(ev.currentTarget, '已导出 WAV');
    });
    $('exportCsvWindows').addEventListener('click', (ev) => {
      if (!scenario) return;
      downloadBlob(new Blob([String.fromCharCode(0xfeff) + scenario.windowCsv], { type: 'text/csv;charset=utf-8' }), 'aec_comparison_1_windows.csv');
      flashButton(ev.currentTarget, '已导出数据一');
    });
    $('exportCsvSegments').addEventListener('click', (ev) => {
      if (!scenario) return;
      downloadBlob(new Blob([String.fromCharCode(0xfeff) + scenario.segmentCsv], { type: 'text/csv;charset=utf-8' }), 'aec_comparison_2_segments.csv');
      flashButton(ev.currentTarget, '已导出数据二');
    });
    $('exportJson').addEventListener('click', (ev) => {
      if (!scenario) return;
      const report = renderRepro();
      downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'aec_repro_report.json');
      flashButton(ev.currentTarget, '已导出 JSON');
    });

    $('themeToggle').addEventListener('click', () => {
      const root = document.documentElement;
      const darkNow = root.dataset.theme === 'dark' ||
        (!root.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.dataset.theme = darkNow ? 'light' : 'dark';
      try { localStorage.setItem('aec-demo-theme', root.dataset.theme); } catch (_) { /* private mode */ }
      $('themeToggle').setAttribute('aria-pressed', (!darkNow).toString());
      $('themeToggle').textContent = darkNow ? '切换深色' : '切换浅色';
      if (scenario) { renderWaveform(); renderCharts(); }
    });

    window.addEventListener('keydown', (ev) => {
      const tag = document.activeElement?.tagName;
      if (ev.code === 'Space' && !['INPUT', 'BUTTON', 'TEXTAREA', 'SELECT'].includes(tag)) {
        ev.preventDefault();
        togglePlay();
      }
    });

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!scenario) return;
        renderWaveform();
        renderCharts();
      }, 180);
    });

    function frame() {
      updateTransport();
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function cacheElements() {
    [
      'seedBadge', 'themeToggle', 'rebuildBtn', 'fixedPresetBtn', 'buildStatus', 'loadingOverlay',
      'delay1', 'delay1Val', 'gain', 'gainVal', 'refDelay', 'refDelayVal', 'refGain', 'refGainVal',
      'delay2', 'delay2Val', 'changeTimeLabel', 'playBtn', 'playLabel', 'seek', 'currentTime',
      'durationTime', 'waveWrap', 'lagValue', 'lagSub', 'reflectionValue', 'reflectionSub',
      'preVolumeValue', 'preVolumeSub', 'reacquireValue', 'reacquireSub', 'nearKeepValue',
      'nearKeepSub', 'statusRibbon', 'segmentTable', 'reproConfig',
      'exportWavAdaptive', 'exportWavFixed', 'exportCsvWindows', 'exportCsvSegments', 'exportJson'
    ].forEach((id) => { ui[id] = $(id); });
  }

  document.addEventListener('DOMContentLoaded', () => {
    cacheElements();
    bindEvents();
    window.__aecDemo = {
      get audioState() { return audioCtx ? audioCtx.state : 'not-created'; },
      get playing() { return playing; },
      position: currentPosition,
      selectSource,
      seekTo,
      togglePlay
    };
    const initialDark = document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
    $('themeToggle').textContent = initialDark ? '切换浅色' : '切换深色';
    $('themeToggle').setAttribute('aria-pressed', String(initialDark));
    setInputsFromFixed();
    rebuild('正在生成固定样例…');
  });
})();
