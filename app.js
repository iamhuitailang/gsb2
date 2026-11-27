/* Browser UI: deterministic replay, canvas geometry, charts, import/export. */
(function () {
  'use strict';

  const V = window.VehicleSim;
  const Charts = window.VehicleCharts;
  const COLORS = Charts.COLORS;
  const $ = (id) => document.getElementById(id);

  const canvas = $('worldCanvas');
  const ctx = canvas.getContext('2d');

  const state = {
    presetIndex: 0,
    test: null,
    viewIndex: 0,
    inspectIndex: null,
    playing: true,
    rate: 1,
    playbackAcc: 0,
    mode: 'review',
    keys: Object.create(null),
    recordFrames: [],
    recordAcc: 0,
    recordSteer: 0,
    live: null,
    liveTrail: [],
    hoverIndex: null,
    lastTs: 0
  };

  let speedChart, gripChart, slipChart, inputChart;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function replayFrameDt() { return state.test?.config?.frameDt || V.FRAME_DT; }

  function toast(message, ms = 2600) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function fmtAngle(rad) {
    let deg = rad * 180 / Math.PI % 360;
    if (deg < 0) deg += 360;
    return deg.toFixed(0) + '°';
  }

  function signedAngleDeg(a, b) {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b)) * 180 / Math.PI;
  }

  function utilColor(u, loss) {
    if (loss || u >= 0.985) return COLORS.red;
    if (u >= 0.82) return COLORS.yellow;
    return COLORS.aqua;
  }

  /* ----------------------------- test loading ----------------------------- */

  function loadPreset(index, autoplay = true) {
    const p = V.presets()[index];
    state.presetIndex = index;
    state.test = {
      kind: 'preset',
      name: p.name,
      description: p.description,
      config: V.clone(p.config),
      frames: V.clone(p.frames),
      importedChecks: null
    };
    recomputeResults(false);
    state.viewIndex = 0;
    state.inspectIndex = null;
    state.playing = autoplay;
    state.playbackAcc = 0;
    state.mode = 'review';
    $('presetSelect').value = String(index);
    $('recordBtn').hidden = false;
    $('stopRecordBtn').hidden = true;
    $('modePill').textContent = '样例回放';
    $('modePill').className = 'pill';
    $('presetDescription').textContent = p.description;
    fillSetupControls();
    updatePlayButton();
    updateCharts();
    updateEventPanels();
    updateVerifyBox();
    toast(p.description, 4200);
  }

  function recomputeResults(refreshPanels = true) {
    const t = state.test;
    if (!t) return;
    t.resultA = V.simulate(t.config, t.frames, t.config.setupA);
    t.resultB = V.simulate(t.config, t.frames, t.config.setupB);
    state.viewIndex = clamp(state.viewIndex, 0, t.frames.length);
    $('timeline').max = String(t.frames.length);
    if (refreshPanels) {
      updateCharts();
      updateEventPanels();
      renderReadouts();
    }
  }

  function fillSetupControls() {
    const a = state.test.config.setupA;
    const b = state.test.config.setupB;
    $('massA').value = a.mass; $('gripA').value = a.tireGrip;
    $('massB').value = b.mass; $('gripB').value = b.tireGrip;
    updateSetupOutputs();
  }

  function updateSetupOutputs() {
    $('massAOut').textContent = `${$('massA').value} kg`;
    $('gripAOut').textContent = Number($('gripA').value).toFixed(2) + '×';
    $('massBOut').textContent = `${$('massB').value} kg`;
    $('gripBOut').textContent = Number($('gripB').value).toFixed(2) + '×';
  }

  let setupTimer = 0;
  function applySetupFromControls() {
    if (!state.test || state.mode === 'recording') return;
    updateSetupOutputs();
    state.test.config.setupA.mass = Number($('massA').value);
    state.test.config.setupA.tireGrip = Number($('gripA').value);
    state.test.config.setupB.mass = Number($('massB').value);
    state.test.config.setupB.tireGrip = Number($('gripB').value);
    clearTimeout(setupTimer);
    setupTimer = setTimeout(() => recomputeResults(true), 60);
  }

  /* ------------------------------ recording ------------------------------- */

  function startRecording() {
    // Use the currently loaded world/setup as the starting configuration.
    if (!state.test) loadPreset(0, false);
    state.mode = 'recording';
    state.playing = false;
    state.recordFrames = [];
    state.recordAcc = 0;
    state.recordSteer = 0;
    state.keys = Object.create(null);
    const setup = state.test.config.setupA;
    state.live = {
      simState: V.makeInitialState(state.test.config, setup),
      telemetry: null,
      sample: null
    };
    state.live.sample = V.sampleFromState(state.live.simState, null, 0, 0);
    state.liveTrail = [{ x: state.live.simState.x, y: state.live.simState.y }];
    state.viewIndex = 0;
    state.hoverIndex = null;
    [speedChart, gripChart, slipChart, inputChart].forEach(c => c?.setHoverIndex(null));
    $('recordBtn').hidden = true;
    $('stopRecordBtn').hidden = false;
    $('modePill').textContent = '● 录制中：W/S/A/D 或方向键';
    $('modePill').className = 'pill recording';
    $('presetDescription').textContent = '正在逐固定帧记录方向、油门和刹车。结束后同一段输入会分别交给 A/B 设置重算，时间轴严格对齐。';
    $('worldCanvas').focus({ preventScroll: true });
    toast('开始录制：W/↑ 油门，S/↓/空格 刹车，A/D/←/→ 转向', 3600);
  }

  function stopRecording() {
    if (state.mode !== 'recording') return;
    if (state.recordFrames.length < 10) {
      toast('录制太短，已保留但建议至少驾驶 1 秒。');
    }
    state.test = {
      kind: 'recording',
      name: '我的键盘输入',
      description: '同一段录制输入，分别用右侧 A/B 设置重跑。',
      config: state.test.config,
      frames: state.recordFrames.slice(),
      importedChecks: null
    };
    state.mode = 'review';
    state.viewIndex = 0;
    state.playing = true;
    state.playbackAcc = 0;
    $('recordBtn').hidden = false;
    $('stopRecordBtn').hidden = true;
    $('modePill').textContent = '同一输入 · A/B 对齐重跑';
    $('modePill').className = 'pill ok';
    $('presetDescription').textContent = state.test.description;
    recomputeResults(true);
    fillSetupControls();
    updateVerifyBox();
    toast('已结束录制，A/B 结果已按完全相同的输入帧重算。');
  }

  function readRawInput() {
    const k = state.keys;
    const left = !!(k.KeyA || k.ArrowLeft);
    const right = !!(k.KeyD || k.ArrowRight);
    return {
      steer: (right ? 1 : 0) - (left ? 1 : 0),
      throttle: (k.KeyW || k.ArrowUp) ? 1 : 0,
      brake: (k.KeyS || k.ArrowDown || k.Space) ? 1 : 0
    };
  }

  function advanceRecordingFrame() {
    const raw = readRawInput();
    // Gentle digital steering filter; the recorded track contains actual angles.
    const maxStep = 4.8 * V.FRAME_DT;
    state.recordSteer += clamp(raw.steer - state.recordSteer, -maxStep, maxStep);
    if (Math.abs(state.recordSteer) < 0.001 && raw.steer === 0) state.recordSteer = 0;
    const input = {
      steer: +state.recordSteer.toFixed(5),
      throttle: raw.throttle,
      brake: raw.brake
    };
    state.recordFrames.push(input);
    const setup = state.test.config.setupA;
    let tel = state.live.telemetry;
    for (let i = 0; i < V.SUBSTEPS; i++) {
      const out = V.axlePhysics(state.live.simState, input, setup, state.test.config.world, V.PHYS_DT);
      state.live.simState = out.state;
      tel = out.telemetry;
    }
    state.live.telemetry = tel;
    state.live.sample = V.sampleFromState(state.live.simState, tel, state.recordFrames.length * V.FRAME_DT, state.recordFrames.length);
    state.liveTrail.push({ x: state.live.simState.x, y: state.live.simState.y });
    if (state.recordFrames.length > 60 * 120) stopRecording();
  }

  /* -------------------------------- charts -------------------------------- */

  function initCharts() {
    const hover = (i) => setHoverIndex(i);
    const seek = (i) => {
      if (state.mode === 'recording') return;
      state.playing = false;
      state.viewIndex = i;
      state.playbackAcc = 0;
      updatePlayButton();
    };
    speedChart = new Charts.LineChart($('speedChart'), { onHover: hover, onSeek: seek, decimals: 0 });
    gripChart = new Charts.LineChart($('gripChart'), { onHover: hover, onSeek: seek, decimals: 1,
      referenceLines: [{ value: 1, label: '摩擦极限', color: COLORS.red }] });
    slipChart = new Charts.LineChart($('slipChart'), { onHover: hover, onSeek: seek, decimals: 1, max: 2,
      referenceLines: [{ value: 1, label: '越过峰值', color: COLORS.yellow }] });
    inputChart = new Charts.LineChart($('inputChart'), { onHover: hover, onSeek: seek, decimals: 1, min: -1.05, max: 1.05,
      referenceLines: [{ value: 0, color: COLORS.baseline }] });
  }

  function setHoverIndex(i) {
    state.hoverIndex = i;
    [speedChart, gripChart, slipChart, inputChart].forEach(c => c.setHoverIndex(i));
  }

  function updateCharts() {
    const t = state.test;
    if (!t?.resultA || !t?.resultB) return;
    const a = t.resultA.samples, b = t.resultB.samples;
    const times = a.map(s => s.t);
    const common = { frameDt: state.test.config.frameDt || V.FRAME_DT };

    speedChart.options = { ...speedChart.options, ...common };
    speedChart.setData(times, [
      { label: 'A km/h', color: COLORS.blue, data: a.map(s => s.speedKmh), format: v => `${v.toFixed(1)} km/h` },
      { label: 'B km/h', color: COLORS.orange, data: b.map(s => s.speedKmh), format: v => `${v.toFixed(1)} km/h` }
    ]);

    gripChart.options = { ...gripChart.options, ...common };
    gripChart.setData(times, [
      { label: 'A 前', color: COLORS.blue, data: a.map(s => s.demandF), format: v => v?.toFixed(2) },
      { label: 'A 后', color: COLORS.blue, dash: [5, 4], data: a.map(s => s.demandR), format: v => v?.toFixed(2) },
      { label: 'B 前', color: COLORS.orange, data: b.map(s => s.demandF), format: v => v?.toFixed(2) },
      { label: 'B 后', color: COLORS.orange, dash: [5, 4], data: b.map(s => s.demandR), format: v => v?.toFixed(2) }
    ]);

    slipChart.options = { ...slipChart.options, ...common };
    slipChart.setData(times, [
      { label: 'A 前', color: COLORS.blue, data: a.map(s => s.slipF), format: v => v?.toFixed(2) },
      { label: 'A 后', color: COLORS.blue, dash: [5, 4], data: a.map(s => s.slipR), format: v => v?.toFixed(2) },
      { label: 'B 前', color: COLORS.orange, data: b.map(s => s.slipF), format: v => v?.toFixed(2) },
      { label: 'B 后', color: COLORS.orange, dash: [5, 4], data: b.map(s => s.slipR), format: v => v?.toFixed(2) }
    ]);

    const inputData = times.map((_, i) => i === 0 ? { steer: 0, throttle: 0, brake: 0 } : t.frames[i - 1]);
    inputChart.options = { ...inputChart.options, ...common };
    inputChart.setData(times, [
      { label: '转向', color: '#6250d6', data: inputData.map(f => f.steer), format: v => v?.toFixed(2) },
      { label: '油门', color: COLORS.aqua, data: inputData.map(f => f.throttle), format: v => v?.toFixed(2) },
      { label: '刹车', color: COLORS.red, data: inputData.map(f => f.brake), format: v => v?.toFixed(2) }
    ]);
    updateChartCursors();
  }

  function updateChartCursors() {
    [speedChart, gripChart, slipChart, inputChart].forEach(c => c.setViewIndex(state.viewIndex));
  }

  /* ------------------------------ world render ---------------------------- */

  function resizeCanvasForDpr() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, rect.width);
    const h = Math.max(360, rect.height);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw; canvas.height = bh;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function makeView(w, h, world) {
    const b = world.bounds;
    const pad = 28;
    const scale = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY));
    const ox = (w - (b.maxX - b.minX) * scale) / 2 - b.minX * scale;
    const oy = (h - (b.maxY - b.minY) * scale) / 2 - b.minY * scale;
    return {
      scale,
      x: (x) => ox + x * scale,
      y: (y) => oy + y * scale,
      m: (v) => v * scale
    };
  }

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function drawGrid(view, world, w, h) {
    const b = world.bounds;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x(b.minX), view.y(b.minY), view.m(b.maxX - b.minX), view.m(b.maxY - b.minY));
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,.34)';
    ctx.lineWidth = 1;
    for (let x = Math.ceil(b.minX / 5) * 5; x <= b.maxX; x += 5) {
      ctx.beginPath(); ctx.moveTo(view.x(x), view.y(b.minY)); ctx.lineTo(view.x(x), view.y(b.maxY)); ctx.stroke();
    }
    for (let y = Math.ceil(b.minY / 5) * 5; y <= b.maxY; y += 5) {
      ctx.beginPath(); ctx.moveTo(view.x(b.minX), view.y(y)); ctx.lineTo(view.x(b.maxX), view.y(y)); ctx.stroke();
    }
    ctx.restore();
  }

  function drawSurfaceAndRoute(view, world) {
    const b = world.bounds;
    ctx.fillStyle = world.defaultSurface.color || '#cfc7b4';
    ctx.fillRect(view.x(b.minX), view.y(b.minY), view.m(b.maxX - b.minX), view.m(b.maxY - b.minY));
    drawGrid(view, world);

    // Road ribbon.
    if (world.route?.length > 1) {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(70,62,45,.18)';
      ctx.lineWidth = view.m(8.4);
      traceRoute(view, world.route); ctx.stroke();
      ctx.strokeStyle = '#b8b09c';
      ctx.lineWidth = view.m(7.2);
      traceRoute(view, world.route); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,.72)';
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 10]);
      traceRoute(view, world.route); ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const z of world.zones || []) {
      const r = z.rect;
      const x = view.x(r.x), y = view.y(r.y), w = view.m(r.w), h = view.m(r.h);
      ctx.save();
      roundRect(ctx, x, y, w, h, 10);
      ctx.fillStyle = z.kind === 'wet' ? 'rgba(74, 144, 204, .42)' : 'rgba(80,160,90,.35)';
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = 2;
      for (let d = -h; d < w + h; d += 14) {
        ctx.beginPath(); ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); ctx.stroke();
      }
      ctx.restore();
      roundRect(ctx, x, y, w, h, 10);
      ctx.strokeStyle = z.kind === 'wet' ? '#236aa8' : '#2e7d43';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#174e7c';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`${z.name}  μ=${z.mu.toFixed(2)}`, x + 10, y + 8);
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('低附着', x + 10, y + 27);
    }

    for (const a of world.arrows || []) {
      drawArrowHead(view.x(a.x), view.y(a.y), a.angle, 13, 'rgba(255,255,255,.85)', '#77705f');
    }
  }

  function traceRoute(view, route) {
    ctx.beginPath();
    ctx.moveTo(view.x(route[0].x), view.y(route[0].y));
    for (let i = 1; i < route.length; i++) ctx.lineTo(view.x(route[i].x), view.y(route[i].y));
  }

  function drawArrowHead(x, y, angle, size, fill, stroke) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size, 0); ctx.lineTo(-size * .7, -size * .58); ctx.lineTo(-size * .35, 0); ctx.lineTo(-size * .7, size * .58);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.restore();
  }

  function drawTrajectory(view, result, index, color, dashed) {
    const s = result.samples;
    if (s.length < 2) return;
    const end = clamp(index, 1, s.length - 1);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = .18;
    ctx.lineWidth = 3;
    if (dashed) ctx.setLineDash([9, 7]);
    ctx.beginPath();
    ctx.moveTo(view.x(s[0].x), view.y(s[0].y));
    for (let i = 1; i < s.length; i++) ctx.lineTo(view.x(s[i].x), view.y(s[i].y));
    ctx.stroke();
    ctx.globalAlpha = .9;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(view.x(s[0].x), view.y(s[0].y));
    for (let i = 1; i <= end; i++) ctx.lineTo(view.x(s[i].x), view.y(s[i].y));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  function drawLiveTrail(view) {
    if (state.liveTrail.length < 2) return;
    ctx.strokeStyle = COLORS.blue;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(view.x(state.liveTrail[0].x), view.y(state.liveTrail[0].y));
    for (const p of state.liveTrail) ctx.lineTo(view.x(p.x), view.y(p.y));
    ctx.stroke();
  }

  function drawCar(view, sample, setup, color, label, yOffset = -30) {
    const x = view.x(sample.x), y = view.y(sample.y);
    // Actual world velocity direction.
    const speed = sample.speed ?? Math.hypot(sample.u || 0, sample.v || 0);
    const vecLen = view.m(clamp(speed * .42, 1.4, 8.5));
    if (vecLen > 4) {
      const mx = x + Math.cos(sample.movementAngle ?? sample.h) * vecLen;
      const my = y + Math.sin(sample.movementAngle ?? sample.h) * vecLen;
      ctx.strokeStyle = COLORS.aqua;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(mx, my); ctx.stroke();
      drawArrowHead(mx, my, sample.movementAngle ?? sample.h, 10, COLORS.aqua, '#0c6b4f');
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sample.h);
    ctx.scale(view.scale, view.scale);

    // Heading arrow in body coordinates.
    ctx.strokeStyle = 'rgba(255,255,255,.95)';
    ctx.lineWidth = .16;
    ctx.beginPath(); ctx.moveTo(.2, 0); ctx.lineTo(3.0, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(3.0, 0); ctx.lineTo(2.45, -.28); ctx.lineTo(2.45, .28); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill();

    // Body: CG is origin; front is +x.
    roundRect(ctx, -setup.cgToRear - .68, -.91, setup.cgToFront + setup.cgToRear + 1.42, 1.82, .28);
    ctx.fillStyle = color;
    ctx.globalAlpha = label === 'B' ? .72 : .9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(11,11,11,.55)';
    ctx.lineWidth = .07;
    ctx.stroke();

    // Windshield / rear window.
    ctx.fillStyle = 'rgba(18,32,48,.72)';
    roundRect(ctx, .18, -.68, .72, 1.36, .12); ctx.fill();
    roundRect(ctx, -1.18, -.62, .55, 1.24, .1); ctx.fill();

    // Axles / wheels.
    const wheel = (axleX, steer) => {
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(axleX, side * .96);
        ctx.rotate(steer || 0);
        roundRect(ctx, -.34, -.13, .68, .26, .07);
        ctx.fillStyle = '#171717';
        ctx.fill();
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(0,0,0,.35)';
      ctx.lineWidth = .08;
      ctx.beginPath(); ctx.moveTo(axleX, -.82); ctx.lineTo(axleX, .82); ctx.stroke();
    };
    wheel(setup.cgToFront, sample.steerAngle || 0);
    wheel(-setup.cgToRear, 0);
    ctx.restore();

    // Label, separated vertically when A/B occupy nearly the same point.
    const nameY = yOffset < 0 ? y - 16 : y + 29;
    ctx.fillStyle = color;
    ctx.font = '800 12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, nameY);

    drawAxleIndicator(view, sample, setup, 'F', setup.cgToFront, x, y, yOffset);
    drawAxleIndicator(view, sample, setup, 'R', -setup.cgToRear, x, y, -yOffset + 8);
  }

  function drawAxleIndicator(view, sample, setup, letter, localX, carX, carY, labelDy) {
    const c = Math.cos(sample.h), s = Math.sin(sample.h);
    const px = carX + view.m(localX * c);
    const py = carY + view.m(localX * s);
    const mu = letter === 'F' ? (sample.muF ?? fallbackMu(sample, setup, 'front')) : (sample.muR ?? fallbackMu(sample, setup, 'rear'));
    const util = letter === 'F' ? (sample.utilizationF ?? clamp(sample.demandF || 0, 0, 1)) : (sample.utilizationR ?? clamp(sample.demandR || 0, 0, 1));
    const loss = letter === 'F' ? sample.lossF : sample.lossR;
    const col = utilColor(util, loss);
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,20,20,.78)'; ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,.25)';
    ctx.beginPath(); ctx.arc(px, py, 6.5, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(px, py, 6.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(util, 0, 1)); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '800 9px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(letter, px, py + .5);

    const text = `μ${mu.toFixed(2)} ${Math.round(util * 100)}%${loss ? ' 打滑!' : ''}`;
    ctx.font = loss ? '800 11px system-ui, sans-serif' : '650 10px ui-monospace, Menlo, monospace';
    const tw = ctx.measureText(text).width + 10;
    let tx = clamp(px - tw / 2, 4, canvas.clientWidth - tw - 4);
    let ty = py + labelDy - 10;
    if (ty < 4) ty = py + 18;
    roundRect(ctx, tx, ty, tw, 17, 6);
    ctx.fillStyle = loss ? 'rgba(208,59,59,.94)' : 'rgba(255,255,255,.9)';
    ctx.fill();
    ctx.fillStyle = loss ? '#fff' : '#222';
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillText(text, tx + 5, ty + 9);
    ctx.restore();
  }

  function fallbackMu(sample, setup, axle) {
    if (!state.test) return 1;
    const pos = V.axlePositions(sample, setup)[axle];
    return V.surfaceAt(state.test.config.world, pos.x, pos.y).mu * setup.tireGrip;
  }

  function drawEventMarkers(view) {
    if (!state.test) return;
    const drawOne = (e, color, setupLabel) => {
      if (e.x === undefined) return;
      const x = view.x(e.x), y = view.y(e.y);
      if (e.type === 'first-loss') {
        ctx.save();
        ctx.translate(x, y);
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? 6 : 11;
          const a = -Math.PI / 2 + i * Math.PI / 5;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fillStyle = COLORS.red; ctx.fill();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = '#fff'; ctx.font = '900 9px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(e.axle, 0, .5);
        ctx.restore();
      } else if (e.type === 'surface-crossing') {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillStyle = e.highToLow ? COLORS.red : color;
        ctx.fillRect(-5, -5, 10, 10);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.strokeRect(-5, -5, 10, 10);
        ctx.restore();
        ctx.fillStyle = '#1d1d1d';
        ctx.font = '800 10px system-ui'; ctx.textAlign = 'center';
        ctx.fillText(e.axle, x, y - 9);
      }
    };
    for (const e of state.test.resultA.events) drawOne(e, COLORS.blue, 'A');
    for (const e of state.test.resultB.events) drawOne(e, COLORS.orange, 'B');
  }

  function renderWorld() {
    const { w, h } = resizeCanvasForDpr();
    ctx.clearRect(0, 0, w, h);
    if (!state.test) return;
    const world = state.test.config.world;
    const view = makeView(w, h, world);
    drawSurfaceAndRoute(view, world);

    if (state.mode === 'recording' && state.live) {
      drawLiveTrail(view);
      const pseudoSample = V.sampleFromState(state.live.simState, state.live.telemetry, state.recordFrames.length * V.FRAME_DT, state.recordFrames.length);
      drawCar(view, pseudoSample, state.test.config.setupA, COLORS.blue, 'A', -30);
    } else if (state.test.resultA && state.test.resultB) {
      drawTrajectory(view, state.test.resultA, state.viewIndex, COLORS.blue, false);
      drawTrajectory(view, state.test.resultB, state.viewIndex, COLORS.orange, true);
      drawEventMarkers(view);
      const idx = clamp(state.hoverIndex ?? state.viewIndex, 0, state.test.frames.length);
      const sa = state.test.resultA.samples[idx];
      const sb = state.test.resultB.samples[idx];
      drawCar(view, sb, state.test.config.setupB, COLORS.orange, 'B', 26);
      drawCar(view, sa, state.test.config.setupA, COLORS.blue, 'A', -34);
    }

    // Canvas focus hint.
    if (document.activeElement !== canvas && state.mode !== 'recording') {
      ctx.fillStyle = 'rgba(11,11,11,.55)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('点击画布后也可直接按驾驶键开始录制', w - 14, h - 12);
    }
  }

  /* ------------------------------- readouts ------------------------------- */

  function readoutCard(result, key, color) {
    const requestedIndex = state.hoverIndex ?? state.viewIndex;
    const idx = clamp(requestedIndex, 0, result.samples.length - 1);
    const s = result.samples[idx];
    const drift = signedAngleDeg(s.movementAngle, s.h);
    const axleLine = (letter, mu, util, slip, loss) => `
      <div class="axle-line">
        <strong>${letter}轴</strong>
        <div class="bar"><i style="width:${Math.round(clamp(util, 0, 1) * 100)}%;background:${utilColor(util, loss)}"></i></div>
        <span class="num">μ${mu.toFixed(2)} · ${Math.round(clamp(util, 0, 1) * 100)}%</span>
      </div>`;
    const muF = s.muF ?? fallbackMu(s, result.setup, 'front');
    const muR = s.muR ?? fallbackMu(s, result.setup, 'rear');
    return `
      <div class="readout-setup ${key.toLowerCase()}">
        <div class="readout-title">
          <span><i class="line-swatch" style="background:${color}"></i> ${result.setup.label}</span>
          <span class="badge ${s.lossF || s.lossR ? 'loss' : (Math.max(s.demandF || 0, s.demandR || 0) > .82 ? 'limit' : 'good')}">
            ${s.lossF ? '前轴打滑' : s.lossR ? '后轴打滑' : Math.max(s.demandF || 0, s.demandR || 0) > .98 ? '临界' : '抓地正常'}
          </span>
        </div>
        <div class="metric-grid">
          <div class="metric"><span class="label">速度</span><span class="value">${s.speedKmh.toFixed(1)} km/h</span></div>
          <div class="metric"><span class="label">车身朝向</span><span class="value">${fmtAngle(s.h)}</span></div>
          <div class="metric"><span class="label">实际运动方向</span><span class="value">${fmtAngle(s.movementAngle)}</span></div>
          <div class="metric"><span class="label">运动 / 朝向差</span><span class="value">${drift.toFixed(1)}°</span></div>
        </div>
        <div class="axle-bars">
          ${axleLine('前', muF, s.utilizationF ?? clamp(s.demandF || 0, 0, 1), s.slipF, s.lossF)}
          ${axleLine('后', muR, s.utilizationR ?? clamp(s.demandR || 0, 0, 1), s.slipR, s.lossR)}
        </div>
      </div>`;
  }

  function renderReadouts() {
    if (!state.test) {
      $('readouts').innerHTML = '<div class="empty">选择样例或开始录制。</div>';
      return;
    }
    if (state.mode === 'recording' && state.live?.sample) {
      const liveResult = { setup: state.test.config.setupA, samples: [state.live.sample] };
      $('readouts').innerHTML = readoutCard(liveResult, 'A', COLORS.blue) +
        '<div class="empty" style="margin-top:10px">B 配置会在点击“结束录制并对比”后，用完全相同的输入帧生成。</div>';
      return;
    }
    if (!state.test.resultA) {
      $('readouts').innerHTML = '<div class="empty">选择样例或开始录制。</div>';
      return;
    }
    $('readouts').innerHTML =
      readoutCard(state.test.resultA, 'A', COLORS.blue) +
      readoutCard(state.test.resultB, 'B', COLORS.orange);
  }

  /* -------------------------------- events -------------------------------- */

  function eventText(e) {
    if (e.type === 'first-loss') return e.axleLabel;
    if (e.type === 'situation') return e.label;
    const dir = e.direction === 'enter' ? '进入' : '离开';
    const hi = e.highToLow ? '；高抓地突入低抓地' : '';
    return `${e.axleLabel}${dir}${e.zoneName}：μ ${e.prevMu.toFixed(2)} → ${e.nextMu.toFixed(2)}${hi}`;
  }

  function eventClass(e) {
    if (e.type === 'first-loss') return 'loss';
    if (e.type === 'situation') return 'situation';
    return 'cross';
  }

  function seekTime(t) {
    state.playing = false;
    state.viewIndex = clamp(Math.round(t / replayFrameDt()), 0, state.test.frames.length);
    state.playbackAcc = 0;
    updatePlayButton();
  }

  function updateEventPanels() {
    if (!state.test) return;
    const rows = [];
    for (const e of state.test.resultA.events) {
      if (e.type === 'situation') rows.push({ ...e, setup: 'S' });
      else rows.push({ ...e, setup: 'A' });
    }
    for (const e of state.test.resultB.events) {
      if (e.type !== 'situation') rows.push({ ...e, setup: 'B' });
    }
    rows.sort((a, b) => a.time - b.time || a.setup.localeCompare(b.setup));

    $('eventLog').innerHTML = rows.length ? rows.map((e, i) => `
      <button class="log-row ${eventClass(e)} setup-${e.setup}" data-i="${i}">
        <span class="t">${e.time.toFixed(2)}s</span>
        <span class="log-dot"></span>
        <span>${e.setup === 'A' || e.setup === 'B' ? `<strong>[${e.setup}]</strong> ` : ''}${eventText(e)}</span>
      </button>`).join('') : '<div class="empty">本段没有检测到边界跨越或失抓。</div>';
    [...$('eventLog').querySelectorAll('.log-row')].forEach((el) => {
      el.addEventListener('click', () => seekTime(rows[Number(el.dataset.i)].time));
    });

    const chips = rows.filter(e => e.type === 'situation' || e.type === 'first-loss' || (e.type === 'surface-crossing' && e.highToLow));
    $('eventChips').innerHTML = chips.length ? chips.map((e, i) => `
      <button class="chip ${eventClass(e)}" data-i="${i}">
        <span class="chip-time">${e.time.toFixed(2)}s</span>${e.setup === 'A' || e.setup === 'B' ? e.setup + ' · ' : ''}${eventText(e)}
      </button>`).join('') : '<span class="empty">移动时间轴查看事件标记</span>';
    [...$('eventChips').querySelectorAll('.chip')].forEach((el) => {
      el.addEventListener('click', () => seekTime(chips[Number(el.dataset.i)].time));
    });
  }

  function updateVerifyBox() {
    const box = $('verifyBox');
    const checks = state.test?.importedChecks;
    if (!checks?.length) { box.innerHTML = ''; return; }
    const bad = checks.some(c => !c.sampleCountMatch || c.endPositionError > 0.02 || c.endSpeedError > 0.03 || !c.eventsMatch);
    box.innerHTML = `<div class="verify ${bad ? 'bad' : ''}">${bad ? '复现校验存在偏差' : '✅ 已从配置和输入逐帧重算：位置、速度与边界时刻和导出文件一致。'}</div>`;
  }

  /* ------------------------------- transport ------------------------------ */

  function updatePlayButton() {
    $('playPauseBtn').textContent = state.playing ? '暂停' : '播放';
    $('timeline').value = String(state.viewIndex);
    const total = state.test?.frames.length || 0;
    const dt = replayFrameDt();
    const t = state.viewIndex * dt;
    $('timeReadout').textContent = `${t.toFixed(2)} / ${(total * dt).toFixed(2)} s`;
  }

  function stepFrames(delta) {
    if (!state.test || state.mode === 'recording') return;
    state.playing = false;
    state.viewIndex = clamp(state.viewIndex + delta, 0, state.test.frames.length);
    state.playbackAcc = 0;
    updatePlayButton();
  }

  /* ------------------------------ import/export --------------------------- */

  function exportJson() {
    if (state.mode === 'recording') stopRecording();
    if (!state.test?.resultA) { toast('暂无可导出的试车。'); return; }
    const payload = V.makeTestCaseExport(
      { config: state.test.config },
      state.test.frames,
      state.test.resultA,
      state.test.resultB
    );
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `grip-rehearsal-${state.test.config.scenarioId || 'run'}-${stamp}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('已导出配置、逐帧输入和 A/B 状态曲线。');
  }

  async function importJson(file) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      if (json.format !== 'top-view-grip-rehearsal' || !json.config || !json.input) {
        throw new Error('文件格式不是本页导出的试车 JSON。');
      }
      const verified = V.verifyImported(json);
      state.test = {
        kind: 'import',
        name: json.config.name || '导入试车',
        description: '从 JSON 恢复；页面已使用固定步长重新计算，而非只回放截图。',
        config: json.config,
        frames: verified.frames,
        resultA: verified.resultA,
        resultB: verified.resultB,
        importedChecks: verified.checks
      };
      state.presetIndex = -1;
      $('presetSelect').value = '';
      state.viewIndex = 0;
      state.playing = false;
      state.mode = 'review';
      $('recordBtn').hidden = false;
      $('stopRecordBtn').hidden = true;
      $('modePill').textContent = '导入复现 · 已重算';
      $('modePill').className = 'pill ok';
      $('presetDescription').textContent = state.test.description;
      fillSetupControls();
      $('timeline').max = String(state.test.frames.length);
      updateCharts(); updateEventPanels(); updateVerifyBox(); updatePlayButton();
      toast('导入成功：可播放、逐帧、对齐查看并再次导出。', 3600);
    } catch (err) {
      console.error(err);
      toast('导入失败：' + err.message, 4200);
    }
  }

  /* --------------------------------- loop --------------------------------- */

  function animationFrame(ts) {
    try {
      tick(ts);
    } catch (err) {
      console.error(err);
      if (!state.renderErrorShown) {
        state.renderErrorShown = true;
        toast('界面刷新出现异常：' + err.message, 5000);
      }
    }
    requestAnimationFrame(animationFrame);
  }

  function tick(ts) {
    if (!state.lastTs) state.lastTs = ts;
    const dt = Math.min(0.08, (ts - state.lastTs) / 1000);
    state.lastTs = ts;

    if (state.mode === 'recording') {
      state.recordAcc += dt;
      let guard = 0;
      while (state.mode === 'recording' && state.recordAcc >= V.FRAME_DT && guard < 6) {
        advanceRecordingFrame();
        state.recordAcc -= V.FRAME_DT;
        guard++;
      }
      if (guard === 6) state.recordAcc = 0;
      $('timeline').max = String(state.recordFrames.length);
      $('timeline').value = String(state.recordFrames.length);
      $('timeReadout').textContent = `${(state.recordFrames.length * V.FRAME_DT).toFixed(2)} s 录制中`;
    } else if (state.playing && state.test) {
      const frameDt = replayFrameDt();
      state.playbackAcc += dt * state.rate;
      let guard = 0;
      while (state.playbackAcc >= frameDt && guard < 8) {
        if (state.viewIndex >= state.test.frames.length) {
          state.playing = false;
          state.playbackAcc = 0;
          updatePlayButton();
          break;
        }
        state.viewIndex++;
        state.playbackAcc -= frameDt;
        guard++;
      }
      if (guard === 8) state.playbackAcc = 0;
      updatePlayButton();
    }

    renderWorld();
    renderReadouts();
    updateChartCursors();
  }

  /* -------------------------------- events -------------------------------- */

  function isFormTarget(e) {
    return !!e.target.closest?.('input, select, textarea');
  }

  function bindUi() {
    const select = $('presetSelect');
    V.presets().forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      select.appendChild(o);
    });
    select.addEventListener('change', () => loadPreset(Number(select.value)));
    $('loadPresetBtn').addEventListener('click', () => loadPreset(Number(select.value)));
    $('recordBtn').addEventListener('click', startRecording);
    $('stopRecordBtn').addEventListener('click', stopRecording);
    $('exportBtn').addEventListener('click', exportJson);
    $('importInput').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) importJson(file);
      e.target.value = '';
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file) importJson(file);
    });

    $('playPauseBtn').addEventListener('click', () => {
      if (!state.test) return;
      if (state.viewIndex >= state.test.frames.length) state.viewIndex = 0;
      state.playing = !state.playing;
      updatePlayButton();
    });
    $('resetBtn').addEventListener('click', () => { state.viewIndex = 0; state.playing = false; updatePlayButton(); });
    $('stepBackBtn').addEventListener('click', () => stepFrames(-1));
    $('stepFwdBtn').addEventListener('click', () => stepFrames(1));
    $('timeline').addEventListener('input', (e) => {
      if (state.mode === 'recording') return;
      state.playing = false;
      state.viewIndex = Number(e.target.value);
      updatePlayButton();
    });
    $('speedSelect').addEventListener('change', (e) => { state.rate = Number(e.target.value); });

    ['massA', 'gripA', 'massB', 'gripB'].forEach(id => $(id).addEventListener('input', applySetupFromControls));
    $('swapSetupBtn').addEventListener('click', () => {
      const a = state.test.config.setupA, b = state.test.config.setupB;
      state.test.config.setupA = b; state.test.config.setupB = a;
      for (const [slot, key] of [['A', 'setupA'], ['B', 'setupB']]) {
        const setup = state.test.config[key];
        const bare = String(setup.label || '').replace(/^[AB]\s*/, '');
        setup.id = slot;
        setup.label = `${slot} ${bare}`;
      }
      fillSetupControls(); recomputeResults(true);
    });
    $('tireCompareBtn').addEventListener('click', () => {
      Object.assign(state.test.config.setupA, {
        mass: 1350, yawInertia: 1900, tireGrip: 1.0,
        label: 'A 运动胎 / 标准车'
      });
      Object.assign(state.test.config.setupB, {
        mass: 1350, yawInertia: 1900, tireGrip: 0.76,
        label: 'B 耐磨低抓胎 / 同车重'
      });
      fillSetupControls(); recomputeResults(true);
      toast('已设为同车重、不同轮胎 μ 的对比。');
    });
    $('weightCompareBtn').addEventListener('click', () => {
      Object.assign(state.test.config.setupA, {
        mass: 1250, yawInertia: 1760, tireGrip: 0.95,
        label: 'A 轻载 1250 kg'
      });
      Object.assign(state.test.config.setupB, {
        mass: 1900, yawInertia: 3250, tireGrip: 0.95,
        label: 'B 重载 1900 kg'
      });
      fillSetupControls(); recomputeResults(true);
      toast('已设为同轮胎 μ、不同车重的对比。');
    });

    canvas.addEventListener('click', () => canvas.focus());
    document.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        if (button.id !== 'playPauseBtn') button.blur();
      });
    });
    $('playPauseBtn').addEventListener('click', () => $('playPauseBtn').blur());

    window.addEventListener('keydown', (e) => {
      if (isFormTarget(e)) return;
      const drivingCodes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (drivingCodes.includes(e.code) || e.code === 'Space') e.preventDefault();

      if (e.code === 'KeyP' && !e.repeat) {
        if (state.mode === 'recording') return;
        $('playPauseBtn').click();
        return;
      }
      if (e.code === 'Home' && !e.repeat) { $('resetBtn').click(); return; }
      if (e.code === 'BracketLeft' && !e.repeat) { stepFrames(-1); return; }
      if (e.code === 'BracketRight' && !e.repeat) { stepFrames(1); return; }

      if ([...drivingCodes, 'Space'].includes(e.code)) {
        if (state.mode !== 'recording' && !e.repeat) startRecording();
        state.keys[e.code] = true;
      }
    });
    window.addEventListener('keyup', (e) => { state.keys[e.code] = false; });
    window.addEventListener('blur', () => { state.keys = Object.create(null); });
  }

  function init() {
    $('simplificationList').innerHTML = V.SIMPLIFICATIONS.map(x => `<li>${x}</li>`).join('');
    initCharts();
    bindUi();

    const params = new URLSearchParams(window.location.search);
    let initialIndex = 0;
    const wanted = params.get('case') || params.get('preset');
    if (wanted !== null) {
      const byId = V.presets().findIndex(p => p.id === wanted);
      const asNumber = Number(wanted);
      if (byId >= 0) initialIndex = byId;
      else if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < V.presets().length) initialIndex = asNumber;
    }
    loadPreset(initialIndex, true);
    const initialTime = Number(params.get('t'));
    if (Number.isFinite(initialTime) && initialTime >= 0) {
      state.playing = false;
      state.viewIndex = Math.min(state.test.frames.length, Math.round(initialTime / replayFrameDt()));
      updatePlayButton();
    }
    requestAnimationFrame(animationFrame);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
