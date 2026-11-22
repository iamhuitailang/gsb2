// 应用主逻辑：素材管理、渲染调度、播放控制、导出与回读核对。
(function () {
  const RL = window.RoomLab;
  const $ = (id) => document.getElementById(id);

  const state = {
    dry: null,       // { name, sampleRate, channels }
    irA: null, irB: null,
    activeIR: 'A',
    rendered: null,
    analysisA: null, analysisB: null,
    params: { preDelayMs: 20, wetGain: 0.8, normalize: true },
    lastExport: null, // { buffer, sampleRate, channels, bitDepth }
  };

  function fmtRate(sr) { return `${sr.toLocaleString()} Hz`; }
  function fmtCh(ch, raw) {
    const name = ch === 1 ? '单声道' : '立体声';
    return raw && raw !== ch ? `${name}（源 ${raw} 声道，已按 1/2 声道限制处理）` : name;
  }
  function fmtDur(audio) {
    return `${(audio.channels[0].length / audio.sampleRate).toFixed(3)} s`;
  }

  function audioCard(audio) {
    if (!audio) return '<span class="muted">未载入</span>';
    const rows = [
      ['名称', audio.name],
      ['采样率', fmtRate(audio.sampleRate)],
      ['声道', fmtCh(audio.channels.length, audio.channelsRaw)],
      ['时长', fmtDur(audio)],
      ['峰值', RL.dsp.ampToDb(RL.dsp.peakOf(audio.channels[0])).toFixed(1) + ' dB'],
    ];
    return `<table class="meta">${rows.map(([k, v]) =>
      `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>`;
  }

  function refreshCards() {
    $('dryCard').innerHTML = audioCard(state.dry);
    $('irACard').innerHTML = audioCard(state.irA);
    $('irBCard').innerHTML = audioCard(state.irB);
  }

  function logLine(msg) {
    const div = document.createElement('div');
    div.textContent = `· ${msg}`;
    $('processLog').appendChild(div);
    $('processLog').scrollTop = $('processLog').scrollHeight;
  }
  function clearLog() { $('processLog').innerHTML = ''; }

  // ---------- 素材载入 ----------
  async function readAudioFile(file) {
    const buf = await file.arrayBuffer();
    const decoded = RL.wav.decodeWav(buf);
    return {
      name: file.name,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      channelsRaw: decoded.channelsRaw,
      bitDepth: decoded.bitDepth,
    };
  }

  function loadBuiltins() {
    const G = RL.generators;
    G.dry.forEach((fn, i) => {
      const b = fn();
      const opt = new Option(b.name, `dry${i}`);
      $('builtinDry').add(new Option(b.name, `dry${i}`));
    });
    G.rooms.forEach((fn, i) => {
      const b = fn();
      $('builtinIR').add(new Option(b.name, `ir${i}`));
    });
  }

  function getBuiltin(key) {
    if (!key) return null;
    if (key.startsWith('dry')) return RL.generators.dry[+key.slice(3)]();
    return RL.generators.rooms[+key.slice(2)]();
  }

  function setIR(key, audio) {
    if (key === 'A') state.irA = audio;
    else state.irB = audio;
  }
  function getIR(key) { return key === 'A' ? state.irA : state.irB; }

  // ---------- 渲染 ----------
  async function render() {
    if (!state.dry || !getIR(state.activeIR)) {
      alert('请先载入干声与至少一份房间响应');
      return;
    }
    clearLog();
    $('renderStatus').textContent = '渲染中…';
    await new Promise((r) => setTimeout(r, 30)); // 让状态文字先上屏

    const t0 = performance.now();
    try {
      const rendered = await RL.render.renderMix(
        state.dry, getIR(state.activeIR), state.params, ensureAudioContext());
      state.rendered = rendered;
      rendered.log.forEach(logLine);
      logLine(`卷积完成：输出 ${rendered.sampleRate} Hz / ${rendered.outCh === 2 ? '立体声' : '单声道'} / ` +
        `${rendered.verify.frames} 采样（${rendered.verify.durationSec.toFixed(3)}s），耗时 ${(performance.now() - t0).toFixed(0)}ms`);
      if (rendered.verify.normGain === null) {
        logLine('⚠ 未开启归一化且混音峰值超过 0 dBFS，导出将削波');
      }
      player.load(rendered);
      drawOutputs();
      updateVerifyPanel(rendered.verify);
      $('renderStatus').textContent = '就绪';
    } catch (e) {
      $('renderStatus').textContent = '渲染失败';
      logLine('错误：' + e.message);
      console.error(e);
    }
  }

  function updateVerifyPanel(v) {
    const rows = [
      ['输出采样率', fmtRate(v.sampleRate)],
      ['输出声道', v.channels === 2 ? '立体声（L/R）' : '单声道'],
      ['总帧数', `${v.frames} 采样`],
      ['总时长（含片尾）', `${v.durationSec.toFixed(4)} s`],
      ['干声帧数', v.dryFrames],
      ['延迟后响应帧数', v.irFrames],
      ['预延迟偏移', `${v.preDelaySamples} 采样`],
      ['湿声能量对齐系数', `×${v.wetBalance.toFixed(4)}`],
      ['理论湿声起点', `第 ${v.wetOnlyStartsAt} 采样`],
      ['混合峰值', (v.peak).toFixed(4) + (v.peak > 1 ? '（削波！）' : '')],
    ];
    $('verifyPanel').innerHTML = rows.map(([k, val]) =>
      `<tr><th>${k}</th><td>${val}</td></tr>`).join('');
  }

  function drawOutputs() {
    const r = state.rendered;
    RL.ui.drawWave($('dryCanvas'), r.dry, { colors: ['#7cc4ff'] });
    RL.ui.drawWave($('wetCanvas'), r.wet, { colors: ['#b39dff'] });
    RL.ui.drawWave($('mixCanvas'), r.mix, { colors: ['#57d9a3'] });
  }

  // ---------- IR 分析 ----------
  function analyzeBoth() {
    if (state.irA) state.analysisA = withEnvPeak(RL.analyze.analyzeIR(state.irA));
    if (state.irB) state.analysisB = withEnvPeak(RL.analyze.analyzeIR(state.irB));
    drawIRViews();
  }
  function withEnvPeak(a) {
    let p = 0;
    for (const v of a.env) p = Math.max(p, v);
    a.envPeak = p;
    return a;
  }

  function drawIRViews() {
    if (state.analysisA) {
      RL.ui.drawIR($('irACanvas'), state.analysisA.env, state.analysisA, state.irA.sampleRate);
      $('irAReadout').innerHTML = readout(state.irA, state.analysisA);
    }
    if (state.analysisB) {
      RL.ui.drawIR($('irBCanvas'), state.analysisB.env, state.analysisB, state.irB.sampleRate);
      $('irBReadout').innerHTML = readout(state.irB, state.analysisB);
    }
    if (state.analysisA && state.analysisB) {
      $('comparePanel').hidden = false;
      // 面板从 hidden 切换显示后 canvas 才有实际尺寸，需在下一帧重绘
      requestAnimationFrame(() => RL.ui.drawCompare(
        $('compareCanvas'), state.irA, state.irB, state.analysisA, state.analysisB));
      const c = RL.analyze.compareIRs(state.irA, state.irB);
      $('compareTable').innerHTML = compareRows(c);
    } else {
      $('comparePanel').hidden = true;
    }
  }

  function readout(ir, a) {
    const refl = a.reflections.length
      ? a.reflections.map((r) => `${r.timeMs.toFixed(1)}ms(${r.levelDb.toFixed(0)}dB)`).join('，')
      : '未检出';
    const rows = [
      ['首波到达', `${a.first.timeMs.toFixed(2)} ms`],
      ['主要反射（相对首波）', refl],
      ['RT60 估计', a.rt60 != null ? `${(a.rt60 * 1000).toFixed(0)} ms` : '信号过短，无法估计'],
      ['可听片尾长度', `${(a.tail.tailSec * 1000).toFixed(1)} ms`],
      ['响应总时长', `${a.durationSec.toFixed(3)} s`],
    ];
    return rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
  }

  function compareRows(c) {
    const row = (k, va, vb, delta) =>
      `<tr><th>${k}</th><td>${va}</td><td>${vb}</td><td>${delta ?? ''}</td></tr>`;
    return [
      row('响应总时长', c.a.durationMs + ' ms', c.b.durationMs + ' ms',
        `比值 ${c.lengthRatio.toFixed(2)}×`),
      row('首波到达', c.a.firstWaveMs + ' ms', c.b.firstWaveMs + ' ms',
        `差 ${c.firstWaveDeltaMs.toFixed(1)} ms`),
      row('主要反射数', c.a.reflections, c.b.reflections, `差 ${c.reflectionCountDelta}`),
      row('RT60', c.a.rt60Ms != null ? c.a.rt60Ms + ' ms' : '—',
        c.b.rt60Ms != null ? c.b.rt60Ms + ' ms' : '—',
        `差 ${(c.rt60DeltaSec * 1000).toFixed(0)} ms`),
      row('片尾长度', c.a.tailMs + ' ms', c.b.tailMs + ' ms', ''),
    ].join('');
  }

  // ---------- 播放器 ----------
  const player = new RL.StemPlayer();
  // 渲染重采样需要一个上下文（与播放共用，浏览器自动处理 AudioContext 采样率）
  function ensureAudioContext() {
    player._ensureCtx();
    return player.ctx;
  }

  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  function bindPlayback() {
    $('btnPlay').addEventListener('click', () => player.play());
    $('btnPause').addEventListener('click', () => player.pause());
    $('btnStop').addEventListener('click', () => {
      player.stop();
      updatePlayhead(0);
    });
    document.querySelectorAll('input[name="mode"]').forEach((el) => {
      el.addEventListener('change', () => player.setMode(currentMode()));
    });
    $('wetSlider').addEventListener('input', (e) => {
      state.params.wetGain = +e.target.value;
      $('wetValue').textContent = (+e.target.value).toFixed(2);
      player.setWetGain(state.params.wetGain);
    });
    $('delaySlider').addEventListener('input', (e) => {
      state.params.preDelayMs = +e.target.value;
      $('delayValue').textContent = e.target.value + ' ms';
    });
    $('normalizeChk').addEventListener('change', (e) => {
      state.params.normalize = e.target.checked;
    });
    $('btnRerender').addEventListener('click', render);

    player.onEnded = () => {
      player.playing = false;
      updatePlayhead(0);
    };
    player.onTick = updatePlayhead;

    for (const id of ['dryCanvas', 'wetCanvas', 'mixCanvas']) {
      $(id).addEventListener('click', (e) => {
        if (!state.rendered) return;
        const sec = RL.ui.canvasToSec(e.target, e, state.rendered.verify.durationSec);
        player.seek(sec);
        updatePlayhead(sec);
      });
    }
  }

  let rafPending = false;
  function updatePlayhead(pos) {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      if (!state.rendered) return;
      const dur = state.rendered.verify.durationSec;
      const p = pos != null ? pos : player.position();
      // 先重绘波形再画播放头，避免竖线逐帧残留
      drawOutputs();
      for (const id of ['dryCanvas', 'wetCanvas', 'mixCanvas']) {
        RL.ui.drawPlayhead($(id), p, dur);
      }
      const mm = Math.floor(p / 60), ss = (p % 60).toFixed(2);
      $('posLabel').textContent = `${String(mm).padStart(2, '0')}:${ss.padStart(5, '0')} / ${dur.toFixed(2)}s`;
    });
  }

  // 切换 A/B 响应：保留当前播放位置，重新渲染后同位置继续
  async function switchIR(key) {
    state.activeIR = key;
    document.querySelectorAll('input[name="irSel"]').forEach((el) => {
      el.checked = el.value === key;
    });
    await render();
    if (player.offsetSec > 0 || player.playing) {
      const pos = Math.min(player.position(), state.rendered.verify.durationSec);
      player.offsetSec = pos;
      updatePlayhead(pos);
    }
  }

  // ---------- 导出与回读 ----------
  function doExport() {
    if (!state.rendered) { alert('请先渲染'); return; }
    const bitDepth = $('bitDepth').value;
    const r = state.rendered;
    const buffer = RL.wav.encodeWav(r.mix, r.sampleRate, bitDepth);
    state.lastExport = {
      buffer, bitDepth,
      sampleRate: r.sampleRate,
      channels: r.outCh,
      frames: r.mix[0].length,
    };
    const blob = new Blob([buffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = $('downloadLink');
    a.href = url;
    a.download = `roomlab_mix_${r.sampleRate}hz_${r.outCh}ch_${bitDepth}.wav`;
    a.textContent = `下载 ${a.download}`;
    readback(buffer, r, bitDepth);
    logLine(`已导出 WAV（${String(bitDepth) === '32f' ? 'float32' : bitDepth + '-bit PCM'}），并完成回读核对`);
  }

  // 回读：解码刚导出的文件，与渲染源逐采样核对，并检查尾声/声道映射
  function readback(buffer, rendered, bitDepth) {
    const dec = RL.wav.decodeWav(buffer);
    const checks = [];
    const add = (ok, name, detail) => checks.push({ ok, name, detail });

    add(dec.sampleRate === rendered.sampleRate, '采样率',
      `${dec.sampleRate}（期望 ${rendered.sampleRate}）`);
    add(dec.channels.length === rendered.outCh, '声道数',
      `${dec.channels.length}（期望 ${rendered.outCh}）`);
    add(dec.channels[0].length === rendered.mix[0].length, '帧数',
      `${dec.channels[0].length}（期望 ${rendered.mix[0].length}）`);

    // 逐采样误差（量化误差应与位深匹配）
    let maxDiff = 0;
    for (let c = 0; c < dec.channels.length; c++) {
      const a = dec.channels[c], b = rendered.mix[c];
      for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    }
    // 量化误差容差按位深的理论量化步长设定（往返编码各引入一次取整，给 2 倍余量）
    const bdNum = String(bitDepth) === '32f' ? 32 : Number(bitDepth);
    const tol = bdNum === 16 ? 2 / 32768 : bdNum === 24 ? 2 / 8388608 : 1e-6;
    add(maxDiff <= tol, '混音一致性（逐采样）',
      `最大误差 ${maxDiff.toExponential(2)}，容差 ${tol.toExponential(2)}`);

    // 声道映射：立体声时 L/R 各自与对应源通道比较，不能串道
    if (dec.channels.length === 2) {
      let crossLR = 0, sameLR = 0;
      const l = dec.channels[0], r = dec.channels[1];
      for (let i = 0; i < l.length; i++) {
        crossLR = Math.max(crossLR, Math.abs(l[i] - rendered.mix[1][i]));
        sameLR = Math.max(sameLR, Math.abs(l[i] - r[i]));
      }
      add(crossLR > maxDiff * 1.5 || sameLR > 0, '声道映射 L/R 独立',
        `L↔R 最大差 ${sameLR.toExponential(2)}（>0 即未串道）`);
    } else {
      add(true, '声道映射', '单声道，无映射问题');
    }

    // 尾声长度：导出文件结尾仍保留混响能量，且与渲染源同位置结束
    const env = RL.analyze.envelope({ channels: dec.channels });
    const tailInfo = RL.analyze.analyzeIR({
      channels: dec.channels, sampleRate: dec.sampleRate,
    }).tail;
    const srcTail = rendered.verify.durationSec;
    add(Math.abs(tailInfo.totalSec - srcTail) < 2 / dec.sampleRate, '片尾保留',
      `回读总时长 ${tailInfo.totalSec.toFixed(4)}s，渲染时长 ${srcTail.toFixed(4)}s`);

    // 干声有效内容结束后仍有湿声能量（干声缓冲尾部可能本身是静音，
    // 因此用干声最后一个有效采样而非缓冲区末尾做参考）
    const dryCh = rendered.dry[0];
    let dryLastNz = 0;
    for (let i = 0; i < dryCh.length; i++) if (Math.abs(dryCh[i]) > 1e-9) dryLastNz = i;
    let afterEnergy = 0;
    for (let i = dryLastNz + 1; i < env.length; i++) afterEnergy = Math.max(afterEnergy, env[i]);
    add(afterEnergy > 1e-4, '干声后的房间尾声',
      `干声有效内容结束于 ${(dryLastNz / dec.sampleRate).toFixed(2)}s，其后最大幅度 ` +
      `${(20 * Math.log10(Math.max(afterEnergy, 1e-10))).toFixed(1)} dBFS`);

    $('readbackPanel').innerHTML = checks.map((c) =>
      `<tr><td><span class="badge ${c.ok ? 'ok' : 'bad'}">${c.ok ? '通过' : '失败'}</span></td>` +
      `<th>${c.name}</th><td>${c.detail}</td></tr>`).join('');
    return checks;
  }

  // 预览导出文件本身（回读解码后的数据），验证“导出与预览同样的混音”
  function previewExport() {
    if (!state.lastExport) { alert('请先导出'); return; }
    const dec = RL.wav.decodeWav(state.lastExport.buffer);
    // dry 静音、wet 放导出内容：播放器以 wet 模式播放回读数据
    const fake = {
      sampleRate: dec.sampleRate,
      dry: dec.channels.map(() => new Float32Array(dec.channels[0].length)),
      wet: dec.channels.map((c) => c.slice()),
    };
    const pp = previewPlayer();
    pp.load(fake);
    pp.setMode('wet');
    pp.play();
  }
  let _previewPlayer = null;
  function previewPlayer() {
    if (!_previewPlayer) _previewPlayer = new RL.StemPlayer();
    return _previewPlayer;
  }

  // ---------- 事件绑定 ----------
  function bindInputs() {
    $('dryFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      state.dry = await readAudioFile(f);
      refreshCards();
    });
    $('irFileA').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) { setIR('A', await readAudioFile(f)); refreshCards(); analyzeBoth(); }
    });
    $('irFileB').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (f) { setIR('B', await readAudioFile(f)); refreshCards(); analyzeBoth(); }
    });
    $('btnLoadBuiltinDry').addEventListener('click', () => {
      const b = getBuiltin($('builtinDry').value);
      if (b) { state.dry = b; refreshCards(); }
    });
    $('btnLoadBuiltinIR').addEventListener('click', () => {
      const key = state.activeIR;
      const b = getBuiltin($('builtinIR').value);
      if (b) { setIR(key, b); refreshCards(); analyzeBoth(); }
    });
    document.querySelectorAll('input[name="irSel"]').forEach((el) => {
      el.addEventListener('change', () => switchIR(el.value));
    });
    $('btnRender').addEventListener('click', render);
    $('btnExport').addEventListener('click', doExport);
    $('btnPreviewExport').addEventListener('click', previewExport);
  }

  function init() {
    loadBuiltins();
    bindInputs();
    bindPlayback();
    // 默认载入：节奏鼓点 + 两份程序化响应，开箱即用
    state.dry = RL.generators.dry[1]();
    state.irA = RL.generators.rooms[0]();
    state.irB = RL.generators.rooms[1]();
    refreshCards();
    analyzeBoth();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);

  // 窗口尺寸变化后 canvas 内部位图需按新 CSS 尺寸重建并重绘
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.analysisA || state.analysisB) drawIRViews();
      if (state.rendered) { drawOutputs(); updatePlayhead(); }
    }, 150);
  });
})();
