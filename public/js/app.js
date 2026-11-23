/*
 * app.js —— 页面交互接线
 * 负责：素材载入、波形选区/跳转、播放控制、时间显示、
 * 对照分析、导出下载与读回校验、键盘快捷键、浏览器自测钩子。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const engine = new PlayerEngine();
  const fmt = PlayMath.formatTime;

  const els = {
    fileInput: $('fileInput'), sourceInfo: $('sourceInfo'),
    wave: $('wave'),
    setStart: $('setStart'), setEnd: $('setEnd'), selectAll: $('selectAll'),
    regionStart: $('regionStart'), regionEnd: $('regionEnd'),
    regionSrcDur: $('regionSrcDur'), regionOutDur: $('regionOutDur'),
    play: $('play'), stop: $('stop'), loop: $('loop'),
    volume: $('volume'), volumeVal: $('volumeVal'),
    rate: $('rate'), rateVal: $('rateVal'),
    srcNow: $('srcNow'), outNow: $('outNow'),
    loopCount: $('loopCount'), drift: $('drift'),
    status: $('status'), sampleMarkers: $('sampleMarkers'),
    analyzeBtn: $('analyzeBtn'), analyzeOut: $('analyzeOut'),
    exportBtn: $('exportBtn'), exportOut: $('exportOut'),
  };

  const state = {
    sampleMeta: null,   // 当前样例的标注（导入的 WAV 为 null）
    drag: null,         // 波形拖动选区状态
  };

  function setStatus(msg, kind) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------------- 素材载入 ---------------- */

  function loadChannels(name, sampleRate, channels, markers) {
    try {
      engine.loadDecoded({ sampleRate, channels, numberOfChannels: channels.length });
      state.sampleMeta = markers || null;
      els.sourceInfo.textContent = name + ' · ' + sampleRate + ' Hz · ' +
        channels.length + ' 声道 · ' + fmt(channels[0].length / sampleRate);
      els.sampleMarkers.textContent = markers ? describeMarkers(markers) : '';
      refreshRegionUI();
      drawWave();
      setStatus('已载入：' + name, 'ok');
    } catch (e) {
      setStatus('载入失败：' + e.message, 'err');
    }
  }

  function describeMarkers(m) {
    const parts = [];
    if (m.bpm) parts.push('BPM=' + m.bpm + '（每拍 ' + m.beatSec + 's）');
    if (m.accents) parts.push('重音时刻(s)=' + m.accents.map((a) => a.toFixed(2)).join(', '));
    if (m.runBar) parts.push('过门小节 ' + m.runBar.start.toFixed(2) + 's~' + m.runBar.end.toFixed(2) + 's');
    if (m.frequency) parts.push('标称基频 ' + m.frequency.toFixed(1) + ' Hz');
    if (m.channelDelaySec) parts.push('右声道标称延迟 ' + (m.channelDelaySec * 1000).toFixed(0) + 'ms');
    return parts.join('；');
  }

  els.fileInput.addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const decoded = engine.loadWav(buf);
      state.sampleMeta = null;
      els.sourceInfo.textContent = file.name + ' · ' + decoded.sampleRate + ' Hz · ' +
        decoded.numberOfChannels + ' 声道 · ' + fmt(decoded.channels[0].length / decoded.sampleRate);
      els.sampleMarkers.textContent = '';
      refreshRegionUI();
      drawWave();
      setStatus('WAV 导入成功：' + file.name, 'ok');
    } catch (e) {
      setStatus('WAV 导入失败：' + e.message, 'err');
    } finally {
      els.fileInput.value = '';
    }
  });

  const sampleCache = new Map();
  function getSample(id) {
    if (!sampleCache.size) {
      for (const s of Samples.buildAll()) sampleCache.set(s.id, s);
    }
    return sampleCache.get(id);
  }

  document.querySelectorAll('button[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = getSample(btn.dataset.sample);
      // 复制一份，避免引擎内部淡变等操作污染缓存
      const channels = s.channels.map((ch) => ch.slice());
      loadChannels(s.name, s.sampleRate, channels, s.markers);
    });
  });

  /* ---------------- 波形绘制与选区 ---------------- */

  const canvas = els.wave;
  const ctx2d = canvas.getContext('2d');

  function canvasXToSample(x) {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
    return Math.round(ratio * engine.source.frames);
  }

  function drawWave() {
    const w = canvas.width;
    const h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    if (!engine.source) return;

    const { frames, channels } = engine.source;
    const bucket = Math.max(1, Math.floor(frames / w));
    const peaks = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      let peak = 0;
      const start = x * bucket;
      const end = Math.min(frames, start + bucket);
      for (let i = start; i < end; i++) {
        let v = 0;
        for (const ch of channels) v += Math.abs(ch[i]);
        v /= channels.length;
        if (v > peak) peak = v;
      }
      peaks[x] = peak;
    }

    // 选中区间底色
    const rs = engine.region.start / frames * w;
    const re = engine.region.end / frames * w;
    ctx2d.fillStyle = 'rgba(55, 211, 155, 0.14)';
    ctx2d.fillRect(rs, 0, re - rs, h);

    // 波形
    ctx2d.strokeStyle = '#7fb8ff';
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < w; x++) {
      const y = (1 - peaks[x]) * h / 2;
      const y2 = (1 + peaks[x]) * h / 2;
      ctx2d.moveTo(x + 0.5, y);
      ctx2d.lineTo(x + 0.5, y2);
    }
    ctx2d.stroke();

    // 区间边界
    ctx2d.strokeStyle = '#37d39b';
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    ctx2d.moveTo(rs, 0); ctx2d.lineTo(rs, h);
    ctx2d.moveTo(re, 0); ctx2d.lineTo(re, h);
    ctx2d.stroke();

    // 拖动预览
    if (state.drag) {
      const x0 = state.drag.startX / frames * w;
      const x1 = state.drag.curX / frames * w;
      ctx2d.fillStyle = 'rgba(77, 163, 255, 0.18)';
      ctx2d.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h);
    }

    // 播放头
    const pos = engine.getSourcePosition();
    const px = pos / frames * w;
    ctx2d.strokeStyle = '#ffb84d';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath();
    ctx2d.moveTo(px, 0); ctx2d.lineTo(px, h);
    ctx2d.stroke();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    if (!engine.source) return;
    canvas.setPointerCapture(ev.pointerId);
    const s = canvasXToSample(ev.clientX);
    state.drag = { startX: s, curX: s, pointerId: ev.pointerId, moved: false };
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!state.drag || ev.pointerId !== state.drag.pointerId) return;
    state.drag.curX = canvasXToSample(ev.clientX);
    state.drag.moved = true;
    drawWave();
  });

  canvas.addEventListener('pointerup', (ev) => {
    if (!state.drag || ev.pointerId !== state.drag.pointerId) return;
    const { startX, curX, moved } = state.drag;
    state.drag = null;
    if (!moved || Math.abs(curX - startX) < 4) {
      engine.seek(curX); // 单击 = 跳转
    } else {
      try {
        engine.setRegion(Math.min(startX, curX), Math.max(startX, curX));
      } catch (e) {
        setStatus(e.message, 'err');
      }
    }
    refreshRegionUI();
    drawWave();
  });

  /* ---------------- 区间按钮 ---------------- */

  els.setStart.addEventListener('click', () => {
    if (!engine.source) return;
    try {
      engine.setRegion(Math.floor(engine.getSourcePosition()), engine.region.end);
      refreshRegionUI(); drawWave();
    } catch (e) { setStatus(e.message, 'err'); }
  });

  els.setEnd.addEventListener('click', () => {
    if (!engine.source) return;
    try {
      engine.setRegion(engine.region.start, Math.ceil(engine.getSourcePosition()));
      refreshRegionUI(); drawWave();
    } catch (e) { setStatus(e.message, 'err'); }
  });

  els.selectAll.addEventListener('click', () => {
    if (!engine.source) return;
    engine.setRegion(0, engine.source.frames);
    refreshRegionUI(); drawWave();
  });

  function refreshRegionUI() {
    if (!engine.source || !engine.region) return;
    const { start, end } = engine.region;
    const sr = engine.source.sampleRate;
    els.regionStart.value = fmt(start / sr) + ' (' + start + ')';
    els.regionEnd.value = fmt(end / sr) + ' (' + end + ')';
    els.regionSrcDur.value = fmt((end - start) / sr);
    const outFrames = Math.round((end - start) / parseFloat(els.rate.value));
    els.regionOutDur.value = fmt(outFrames / sr);
  }

  /* ---------------- 播放控制 ---------------- */

  els.play.addEventListener('click', () => {
    try { engine.play(); } catch (e) { setStatus(e.message, 'err'); }
  });
  els.stop.addEventListener('click', () => engine.stop());
  els.loop.addEventListener('change', () => engine.setLoop(els.loop.checked));

  els.volume.addEventListener('input', () => {
    els.volumeVal.textContent = parseFloat(els.volume.value).toFixed(2);
    engine.setVolume(parseFloat(els.volume.value));
  });

  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  function applyPlaybackChange() {
    const rate = parseFloat(els.rate.value);
    els.rateVal.textContent = rate.toFixed(2) + 'x';
    try {
      engine.setPlayback(currentMode(), rate);
      setStatus('已切换：' + (currentMode() === 'pitch' ? '保音高' : '原始变速') +
        ' ' + rate.toFixed(2) + 'x，按当前源时间继续', 'ok');
    } catch (e) {
      setStatus(e.message, 'err');
    }
    refreshRegionUI();
  }

  els.rate.addEventListener('input', applyPlaybackChange);
  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', applyPlaybackChange));

  /* ---------------- 时间显示刷新 ---------------- */

  function tick() {
    if (engine.source) {
      drawWave();
      const sr = engine.source.sampleRate;
      const srcPos = engine.getSourcePosition();
      els.srcNow.value = fmt(srcPos / sr);
      if (engine.rendered) {
        const raw = engine._rawOutFrame();
        const shown = engine.loop ? raw % engine.rendered.outputFrames : Math.min(raw, engine.rendered.outputFrames);
        els.outNow.value = fmt(shown / sr);
      } else {
        els.outNow.value = fmt(0);
      }
      els.loopCount.value = String(engine.getLoopCount());
      const d = engine.getDriftInfo();
      els.drift.value = d ? (d.accumulatedSec * 1000).toFixed(3) + ' ms（每圈 ' +
        (d.perLoopSec * 1000).toFixed(4) + ' ms）' : '0.000 ms';
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---------------- 对照分析 ---------------- */

  els.analyzeBtn.addEventListener('click', () => {
    if (!engine.source) { setStatus('请先载入素材', 'warn'); return; }
    try {
      const sr = engine.source.sampleRate;
      const srcChans = engine._regionChannels().map((ch) => ch.slice());
      const srcStats = AudioAnalyze.regionStats(srcChans, sr);
      const rendered = engine.renderCurrent();
      const outStats = AudioAnalyze.regionStats(
        rendered.channels.map((ch) => ch.slice()), sr);

      const lines = [];
      lines.push('== 源区间 ==');
      lines.push('时长 ' + srcStats.durationSec.toFixed(3) + 's / ' + srcStats.frames + ' 帧');
      lines.push('基频 ' + (srcStats.pitch ? srcStats.pitch.toFixed(1) + ' Hz（清晰度 ' +
        srcStats.pitchClarity.toFixed(2) + '）' : '未检出（非周期信号）'));
      lines.push('重音位置(s) ' + srcStats.accentsSec.map((a) => a.toFixed(3)).join(', '));
      if (srcStats.channelLag) {
        lines.push('右声道延迟 ' + (srcStats.channelLag.lagSec * 1000).toFixed(1) + 'ms');
      }
      lines.push('');
      lines.push('== 处理后（' + rendered.mode + ' @ ' + rendered.rate.toFixed(2) + 'x）==');
      lines.push('时长 ' + outStats.durationSec.toFixed(3) + 's / ' + outStats.frames + ' 帧' +
        '（时长比 ' + (outStats.durationSec / srcStats.durationSec).toFixed(3) + '，期望 ' +
        (1 / rendered.rate).toFixed(3) + '）');
      if (outStats.pitch) {
        const pitchChange = srcStats.pitch
          ? '，音高变化 ' + ((outStats.pitch / srcStats.pitch - 1) * 100).toFixed(1) + '%'
          : '，音高变化无法比较';
        lines.push('基频 ' + outStats.pitch.toFixed(1) + ' Hz（清晰度 ' +
          outStats.pitchClarity.toFixed(2) + '）' + pitchChange);
      } else {
        lines.push('基频 未检出');
      }
      lines.push('重音位置(s) ' + outStats.accentsSec.map((a) => a.toFixed(3)).join(', '));
      if (outStats.channelLag) {
        lines.push('右声道延迟 ' + (outStats.channelLag.lagSec * 1000).toFixed(1) + 'ms');
      }
      els.analyzeOut.textContent = lines.join('\n');
      setStatus('分析完成', 'ok');
    } catch (e) {
      setStatus('分析失败：' + e.message, 'err');
    }
  });

  /* ---------------- 导出与读回 ---------------- */

  els.exportBtn.addEventListener('click', () => {
    if (!engine.source) { setStatus('请先载入素材', 'warn'); return; }
    try {
      const { buffer, expected } = engine.exportRegionWav();
      const report = engine.verifyExport(buffer, expected);

      const lines = [];
      lines.push('导出区间：源 ' + fmt(expected.regionStart / expected.sampleRate) +
        ' ~ ' + fmt(expected.regionEnd / expected.sampleRate) +
        '（' + (expected.regionEnd - expected.regionStart) + ' 帧）');
      lines.push('方式：' + expected.mode + ' @ ' + expected.rate.toFixed(2) + 'x');
      for (const c of report.checks) {
        lines.push((c.pass ? '✓ ' : '✗ ') + c.name + ' — ' + c.detail);
      }
      lines.push('读回时长 ' + report.durationSec.toFixed(3) + 's');
      els.exportOut.textContent = lines.join('\n');
      setStatus(report.ok ? '导出并读回校验通过' : '导出校验存在失败项', report.ok ? 'ok' : 'err');

      // 触发浏览器下载
      const blob = new Blob([buffer], { type: 'audio/wav' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'region-' + expected.mode + '-' + expected.rate.toFixed(2) + 'x.wav';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      setStatus('导出失败：' + e.message, 'err');
    }
  });

  /* ---------------- 键盘快捷键 ---------------- */

  document.addEventListener('keydown', (ev) => {
    if (ev.target.tagName === 'INPUT' && ev.target.type !== 'range') return;
    if (ev.code === 'Space') {
      ev.preventDefault();
      engine.playing ? engine.stop() : engine.play();
    } else if (ev.code === 'ArrowLeft' || ev.code === 'ArrowRight') {
      const delta = engine.source.sampleRate * (ev.shiftKey ? 5 : 1);
      engine.seek(engine.getSourcePosition() + (ev.code === 'ArrowLeft' ? -delta : delta));
    } else if (ev.key === '[') {
      els.setStart.click();
    } else if (ev.key === ']') {
      els.setEnd.click();
    } else if (ev.key.toLowerCase() === 'l') {
      els.loop.checked = !els.loop.checked;
      engine.setLoop(els.loop.checked);
    }
  });

  /* ---------------- 浏览器自测钩子（供 smoke 脚本与控制台调用） ---------------- */

  window.__smoke = {
    engine,
    loadSample(id) {
      const s = getSample(id);
      engine.loadDecoded({
        sampleRate: s.sampleRate,
        channels: s.channels.map((ch) => ch.slice()),
        numberOfChannels: s.channels.length,
      });
      return engine.source.frames;
    },
    // 全链路自检：两种模式 × 多个速度，渲染/导出读回/漂移/异常分支
    async runSelfCheck() {
      const results = [];
      const add = (name, pass, detail) => results.push({ name, pass, detail });
      const ok = (cond, name, detail) => add(name, !!cond, detail || '');

      this.loadSample('accent');
      for (const mode of ['pitch', 'resample']) {
        for (const rate of [0.25, 0.5, 1.0, 2.0, 4.0]) {
          engine.setPlayback(mode, rate);
          const r = engine.rendered;
          const expectFrames = Math.round(engine.region.end / rate);
          ok(r.outputFrames === expectFrames,
            mode + '@' + rate + ' 输出长度精确',
            r.outputFrames + ' vs ' + expectFrames);
          const { buffer, expected } = engine.exportRegionWav();
          const report = engine.verifyExport(buffer, expected);
          ok(report.ok, mode + '@' + rate + ' 导出读回一致',
            report.checks.filter((c) => !c.pass).map((c) => c.name).join(','));
        }
      }

      // 漂移有界性：200 圈
      engine.setPlayback('pitch', 0.5);
      const drift = PlayMath.accumulatedDrift(
        engine.region.end - engine.region.start, 0.5, engine.source.sampleRate, 200);
      ok(Math.abs(drift) < 0.005, '200 圈累计漂移 < 5ms', drift.toFixed(6) + 's');

      // 异常分支
      let threw = false;
      try { TimeStretch.stretch(engine._regionChannels(), 0.1, 'pitch'); }
      catch (e) { threw = /超出可用范围/.test(e.message); }
      ok(threw, '超范围速度被拒绝并说明');

      threw = false;
      try { TimeStretch.stretch([new Float32Array(100)], 1, 'pitch'); }
      catch (e) { threw = /输入过短/.test(e.message); }
      ok(threw, '过短输入被拒绝并说明');

      // 源时间连续性：切模式后位置映射一致
      this.loadSample('practice');
      engine.setPlayback('pitch', 0.5);
      engine.startOutFrame = 12345;
      const srcBefore = engine.getSourcePosition();
      engine.setPlayback('resample', 0.75);
      const srcAfter = engine.getSourcePosition();
      ok(Math.abs(srcAfter - srcBefore) < 2, '切模式后源时间连续（误差<2采样）',
        'before=' + srcBefore.toFixed(1) + ' after=' + srcAfter.toFixed(1));

      const passed = results.filter((r) => r.pass).length;
      return { passed, total: results.length, results };
    },
  };
})();
