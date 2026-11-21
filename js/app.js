/* 主应用：画布渲染、交互编辑、时间轴回放、面板绑定、保存与导出 */
'use strict';

(function () {
  const canvas = document.getElementById('stage');
  const ctx2d = canvas.getContext('2d');
  const engine = new AudioEngine();

  const state = {
    scene: new Scene(),
    tool: 'select',
    selection: null,        // {kind:'source'|'listener'|'wall'|'zone', obj}
    cam: { x: 0, y: 0, zoom: 1 }, // 世界原点偏移（米）与缩放
    playing: false,
    time: 0,
    recording: false,
    recTarget: null,        // 正在录制路线的实体
    recLastSample: 0,
    drag: null,             // 拖动状态
    showGrid: true,
    exporting: false,
  };

  const PPM = 20; // 基础像素/米

  /* ---------- 坐标变换 ---------- */
  function ppm() { return PPM * state.cam.zoom; }
  function w2s(wx, wy) {
    return {
      x: (wx - state.cam.x) * ppm() + canvas.width / (2 * devicePixelRatio),
      y: (wy - state.cam.y) * ppm() + canvas.height / (2 * devicePixelRatio),
    };
  }
  function s2w(sx, sy) {
    return {
      x: (sx - canvas.width / (2 * devicePixelRatio)) / ppm() + state.cam.x,
      y: (sy - canvas.height / (2 * devicePixelRatio)) / ppm() + state.cam.y,
    };
  }

  /* ---------- 画布尺寸 ---------- */
  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio;
    canvas.height = r.height * devicePixelRatio;
  }
  window.addEventListener('resize', resize);

  /* ---------- 渲染 ---------- */
  function draw() {
    const w = canvas.width / devicePixelRatio, h = canvas.height / devicePixelRatio;
    ctx2d.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx2d.clearRect(0, 0, w, h);
    const sc = state.scene;

    if (state.showGrid) drawGrid(w, h);

    // 混响区
    for (const z of sc.zones) {
      const c = w2s(z.x, z.y), r = z.r * ppm();
      ctx2d.beginPath(); ctx2d.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(120,90,220,0.13)'; ctx2d.fill();
      ctx2d.strokeStyle = isSel(z) ? '#c9a6ff' : 'rgba(150,120,230,0.6)';
      ctx2d.setLineDash([6, 4]); ctx2d.lineWidth = isSel(z) ? 2.5 : 1.5;
      ctx2d.stroke(); ctx2d.setLineDash([]);
      ctx2d.fillStyle = '#b9a3ee'; ctx2d.font = '11px sans-serif';
      ctx2d.fillText(`${z.name} (衰减${z.decay}s 湿声${Math.round(z.wet * 100)}%)`, c.x - r + 6, c.y - r + 16);
    }

    // 移动路线
    const drawPath = (ent, color) => {
      if (!ent.path || ent.path.length < 2) return;
      ctx2d.beginPath();
      ent.path.forEach((k, i) => {
        const p = w2s(k.x, k.y);
        i === 0 ? ctx2d.moveTo(p.x, p.y) : ctx2d.lineTo(p.x, p.y);
      });
      ctx2d.strokeStyle = color; ctx2d.lineWidth = 1.2;
      ctx2d.setLineDash([4, 4]); ctx2d.stroke(); ctx2d.setLineDash([]);
      for (const k of ent.path) {
        const p = w2s(k.x, k.y);
        ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
        ctx2d.fillStyle = color; ctx2d.fill();
      }
    };
    sc.sources.forEach(s => drawPath(s, 'rgba(255,212,121,0.55)'));
    if (sc.listener) drawPath(sc.listener, 'rgba(111,211,167,0.55)');

    // 墙体
    for (const wl of sc.walls) {
      const a = w2s(wl.x1, wl.y1), b = w2s(wl.x2, wl.y2);
      ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y);
      ctx2d.strokeStyle = isSel(wl) ? '#ff9d6b' : '#8a94a6';
      ctx2d.lineWidth = isSel(wl) ? 6 : 4;
      ctx2d.lineCap = 'round'; ctx2d.stroke();
    }

    // 声源
    for (const s of sc.sources) drawSource(s);
    // 听者
    if (sc.listener) drawListener(sc.listener);

    // 拖动绘制预览
    if (state.drag && state.drag.preview) state.drag.preview();
  }

  function drawGrid(w, h) {
    const step = ppm(); // 1 米网格
    if (step < 8) return;
    const tl = s2w(0, 0);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.05)'; ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = Math.floor(tl.x); ; x++) {
      const sx = w2s(x, 0).x; if (sx > w) break;
      ctx2d.moveTo(sx, 0); ctx2d.lineTo(sx, h);
    }
    for (let y = Math.floor(tl.y); ; y++) {
      const sy = w2s(0, y).y; if (sy > h) break;
      ctx2d.moveTo(0, sy); ctx2d.lineTo(w, sy);
    }
    ctx2d.stroke();
    // 原点十字
    const o = w2s(0, 0);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx2d.beginPath();
    ctx2d.moveTo(o.x - 8, o.y); ctx2d.lineTo(o.x + 8, o.y);
    ctx2d.moveTo(o.x, o.y - 8); ctx2d.lineTo(o.x, o.y + 8);
    ctx2d.stroke();
  }

  function drawSource(s) {
    const p = w2s(s.x, s.y);
    const sel = isSel(s);
    // 方向性锥体
    if (s.coneInner < 360) {
      const rOut = s.maxDistance * 0.5 * ppm();
      const draw1 = (angDeg, alpha) => {
        const half = (angDeg / 2) * Math.PI / 180;
        ctx2d.beginPath();
        ctx2d.moveTo(p.x, p.y);
        ctx2d.arc(p.x, p.y, Math.min(rOut, 300), s.angle - half, s.angle + half);
        ctx2d.closePath();
        ctx2d.fillStyle = `rgba(255,212,121,${alpha})`; ctx2d.fill();
      };
      draw1(s.coneOuter, 0.05);
      draw1(s.coneInner, 0.10);
    }
    // 参考距离圈
    ctx2d.beginPath(); ctx2d.arc(p.x, p.y, s.refDistance * ppm(), 0, Math.PI * 2);
    ctx2d.strokeStyle = 'rgba(255,212,121,0.35)'; ctx2d.setLineDash([3, 3]);
    ctx2d.lineWidth = 1; ctx2d.stroke(); ctx2d.setLineDash([]);

    ctx2d.beginPath(); ctx2d.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx2d.fillStyle = s.muted ? '#6b5a35' : '#ffd479'; ctx2d.fill();
    ctx2d.strokeStyle = sel ? '#fff' : '#a8842e'; ctx2d.lineWidth = sel ? 2.5 : 1.5; ctx2d.stroke();
    // 朝向线
    const d = w2s(s.x + Math.cos(s.angle) * 0.9, s.y + Math.sin(s.angle) * 0.9);
    ctx2d.beginPath(); ctx2d.moveTo(p.x, p.y); ctx2d.lineTo(d.x, d.y);
    ctx2d.strokeStyle = '#ffd479'; ctx2d.lineWidth = 2; ctx2d.stroke();
    ctx2d.fillStyle = '#ffe9b8'; ctx2d.font = '11px sans-serif';
    ctx2d.fillText(s.name, p.x + 12, p.y - 10);
    if (sel) drawRotateHandle(s);
  }

  function drawListener(L) {
    const p = w2s(L.x, L.y);
    const sel = isSel(L);
    ctx2d.save();
    ctx2d.translate(p.x, p.y); ctx2d.rotate(L.angle);
    ctx2d.beginPath();
    ctx2d.moveTo(12, 0); ctx2d.lineTo(-8, -8); ctx2d.lineTo(-4, 0); ctx2d.lineTo(-8, 8);
    ctx2d.closePath();
    ctx2d.fillStyle = '#6fd3a7'; ctx2d.fill();
    ctx2d.strokeStyle = sel ? '#fff' : '#3a8a66'; ctx2d.lineWidth = sel ? 2.5 : 1.5; ctx2d.stroke();
    ctx2d.restore();
    ctx2d.fillStyle = '#a9e8cb'; ctx2d.font = '11px sans-serif';
    ctx2d.fillText('听者', p.x + 14, p.y - 10);
    if (sel) drawRotateHandle(L);
  }

  function drawRotateHandle(ent) {
    const hx = ent.x + Math.cos(ent.angle) * 1.4;
    const hy = ent.y + Math.sin(ent.angle) * 1.4;
    const hp = w2s(hx, hy), ep = w2s(ent.x, ent.y);
    ctx2d.beginPath(); ctx2d.moveTo(ep.x, ep.y); ctx2d.lineTo(hp.x, hp.y);
    ctx2d.strokeStyle = 'rgba(255,255,255,0.4)'; ctx2d.lineWidth = 1; ctx2d.stroke();
    ctx2d.beginPath(); ctx2d.arc(hp.x, hp.y, 5, 0, Math.PI * 2);
    ctx2d.fillStyle = '#fff'; ctx2d.fill();
  }

  function isSel(obj) { return state.selection && state.selection.obj === obj; }

  /* ---------- 拾取 ---------- */
  function hitTest(wx, wy) {
    const sc = state.scene;
    // 旋转手柄优先
    if (state.selection && (state.selection.kind === 'source' || state.selection.kind === 'listener')) {
      const e = state.selection.obj;
      const hx = e.x + Math.cos(e.angle) * 1.4, hy = e.y + Math.sin(e.angle) * 1.4;
      if (Util.dist(wx, wy, hx, hy) < 0.45) return { kind: 'rotate', obj: e };
    }
    if (sc.listener && Util.dist(wx, wy, sc.listener.x, sc.listener.y) < 0.7)
      return { kind: 'listener', obj: sc.listener };
    for (let i = sc.sources.length - 1; i >= 0; i--) {
      const s = sc.sources[i];
      if (Util.dist(wx, wy, s.x, s.y) < 0.7) return { kind: 'source', obj: s };
    }
    for (const wl of sc.walls) {
      if (Util.distToSegment(wx, wy, wl.x1, wl.y1, wl.x2, wl.y2) < 0.3)
        return { kind: 'wall', obj: wl };
    }
    for (let i = sc.zones.length - 1; i >= 0; i--) {
      const z = sc.zones[i];
      if (Util.pointInCircle(wx, wy, z.x, z.y, z.r)) return { kind: 'zone', obj: z };
    }
    return null;
  }

  /* ---------- 鼠标交互 ---------- */
  function canvasPos(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener('mousedown', e => {
    engine.ensureContext(); // 用户手势内激活音频
    const cp = canvasPos(e), wp = s2w(cp.x, cp.y);
    const tool = state.tool;

    if (tool === 'source') {
      const s = Scene.makeSource({ x: wp.x, y: wp.y, name: '声源' + (state.scene.sources.length + 1) });
      state.scene.sources.push(s);
      select('source', s); setTool('select');
      return;
    }
    if (tool === 'listener') {
      state.scene.listener = Scene.makeListener({ x: wp.x, y: wp.y });
      select('listener', state.scene.listener); setTool('select');
      return;
    }
    if (tool === 'wall') {
      state.drag = { kind: 'drawWall', x1: wp.x, y1: wp.y, x2: wp.x, y2: wp.y };
      return;
    }
    if (tool === 'zone') {
      state.drag = { kind: 'drawZone', cx: wp.x, cy: wp.y, r: 0 };
      return;
    }

    // select 工具
    const hit = hitTest(wp.x, wp.y);
    if (hit) {
      if (hit.kind === 'rotate') {
        state.drag = { kind: 'rotate', obj: hit.obj };
      } else {
        select(hit.kind, hit.obj);
        state.drag = { kind: 'move', obj: hit.obj, kindOf: hit.kind,
          dx: hit.obj.x - wp.x, dy: hit.obj.y - wp.y, moved: false };
        if (state.recording && state.playing &&
            (hit.kind === 'source' || hit.kind === 'listener')) {
          state.recTarget = hit.obj;
          if (!state.recTarget.path) state.recTarget.path = [];
          // 截断当前时刻之后的旧关键帧，从此时刻起覆盖录制
          state.recTarget.path = state.recTarget.path.filter(k => k.t <= state.time);
          state.recLastSample = state.time;
        }
      }
    } else {
      select(null);
      state.drag = { kind: 'pan', sx: cp.x, sy: cp.y, camX: state.cam.x, camY: state.cam.y };
    }
  });

  canvas.addEventListener('mousemove', e => {
    if (!state.drag) return;
    const cp = canvasPos(e), wp = s2w(cp.x, cp.y);
    const d = state.drag;
    if (d.kind === 'move') {
      d.obj.x = wp.x + d.dx; d.obj.y = wp.y + d.dy;
      d.moved = true;
      // 录制路线：每 80ms 采一个关键帧
      if (state.recording && state.playing && state.recTarget === d.obj) {
        if (state.time - state.recLastSample > 0.08) {
          d.obj.path.push({ t: state.time, x: d.obj.x, y: d.obj.y, angle: d.obj.angle || 0 });
          state.recLastSample = state.time;
        }
      }
    } else if (d.kind === 'rotate') {
      d.obj.angle = Math.atan2(wp.y - d.obj.y, wp.x - d.obj.x);
    } else if (d.kind === 'pan') {
      state.cam.x = d.camX - (cp.x - d.sx) / ppm();
      state.cam.y = d.camY - (cp.y - d.sy) / ppm();
    } else if (d.kind === 'drawWall') {
      d.x2 = wp.x; d.y2 = wp.y;
      d.preview = () => {
        const a = w2s(d.x1, d.y1), b = w2s(d.x2, d.y2);
        ctx2d.beginPath(); ctx2d.moveTo(a.x, a.y); ctx2d.lineTo(b.x, b.y);
        ctx2d.strokeStyle = '#ff9d6b'; ctx2d.lineWidth = 4; ctx2d.stroke();
      };
    } else if (d.kind === 'drawZone') {
      d.r = Util.dist(d.cx, d.cy, wp.x, wp.y);
      d.preview = () => {
        const c = w2s(d.cx, d.cy);
        ctx2d.beginPath(); ctx2d.arc(c.x, c.y, d.r * ppm(), 0, Math.PI * 2);
        ctx2d.strokeStyle = '#c9a6ff'; ctx2d.setLineDash([6, 4]);
        ctx2d.lineWidth = 2; ctx2d.stroke(); ctx2d.setLineDash([]);
      };
    }
  });

  window.addEventListener('mouseup', () => {
    const d = state.drag;
    if (!d) return;
    if (d.kind === 'drawWall' && Util.dist(d.x1, d.y1, d.x2, d.y2) > 0.3) {
      const wl = Scene.makeWall(d.x1, d.y1, d.x2, d.y2);
      state.scene.walls.push(wl);
      select('wall', wl);
    } else if (d.kind === 'drawZone' && d.r > 0.5) {
      const z = Scene.makeZone(d.cx, d.cy, d.r);
      state.scene.zones.push(z);
      select('zone', z);
    }
    if (state.recording && state.recTarget && d.kind === 'move') {
      // 收尾补一个关键帧
      state.recTarget.path.push({ t: state.time, x: state.recTarget.x, y: state.recTarget.y, angle: state.recTarget.angle || 0 });
    }
    state.drag = null;
    refreshSelPanel();
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const cp = canvasPos(e);
    const before = s2w(cp.x, cp.y);
    state.cam.zoom = Util.clamp(state.cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.3, 6);
    const after = s2w(cp.x, cp.y);
    state.cam.x += before.x - after.x;
    state.cam.y += before.y - after.y;
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) deleteSelected();
  });

  /* ---------- 选择 / 删除 ---------- */
  function select(kind, obj) {
    state.selection = kind ? { kind, obj } : null;
    refreshSelPanel();
  }

  function deleteSelected() {
    const sel = state.selection;
    if (!sel) return;
    const sc = state.scene;
    if (sel.kind === 'source') sc.sources = sc.sources.filter(s => s !== sel.obj);
    else if (sel.kind === 'listener') sc.listener = null;
    else if (sel.kind === 'wall') sc.walls = sc.walls.filter(w => w !== sel.obj);
    else if (sel.kind === 'zone') sc.zones = sc.zones.filter(z => z !== sel.obj);
    select(null);
  }

  /* ---------- 工具栏 ---------- */
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('#toolbar .tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === t));
  }
  document.querySelectorAll('#toolbar .tool').forEach(b =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  document.getElementById('btnDelete').addEventListener('click', deleteSelected);
  document.getElementById('chkGrid').addEventListener('change', e => { state.showGrid = e.target.checked; });
  document.getElementById('chkAudio').addEventListener('change', e => {
    engine.enabled = e.target.checked;
    if (engine.enabled) engine.ensureContext();
  });

  const btnRecord = document.getElementById('btnRecord');
  btnRecord.addEventListener('click', () => {
    state.recording = !state.recording;
    btnRecord.classList.toggle('recording', state.recording);
    btnRecord.textContent = state.recording ? '■ 停止录制' : '● 录制路线';
    if (state.recording) {
      // 录制时自动开始回放，拖动对象即记录路线
      if (!state.playing) togglePlay();
      state.recLastSample = state.time;
    } else {
      state.recTarget = null;
      state.scene.duration = Math.max(state.scene.duration, Math.ceil(state.scene.maxPathTime()));
      ui.durationInput.value = state.scene.duration;
      ui.timeSlider.max = state.scene.duration;
    }
  });

  /* ---------- 时间轴 ---------- */
  const ui = {
    btnPlay: document.getElementById('btnPlay'),
    btnStop: document.getElementById('btnStop'),
    timeLabel: document.getElementById('timeLabel'),
    timeSlider: document.getElementById('timeSlider'),
    durationInput: document.getElementById('durationInput'),
    playState: document.getElementById('playState'),
  };

  function togglePlay() {
    state.playing = !state.playing;
    if (state.playing) engine.ensureContext();
    updatePlayUI();
  }
  ui.btnPlay.addEventListener('click', togglePlay);
  ui.btnStop.addEventListener('click', () => {
    state.playing = false; state.time = 0;
    state.scene.applyTimeline(0);
    updatePlayUI();
  });
  ui.timeSlider.addEventListener('input', () => {
    state.time = parseFloat(ui.timeSlider.value);
    state.scene.applyTimeline(state.time); // 暂停中拖动时间轴即可检查任意时刻
    updatePlayUI();
  });
  ui.durationInput.addEventListener('change', () => {
    state.scene.duration = Util.clamp(parseFloat(ui.durationInput.value) || 10, 1, 600);
    ui.durationInput.value = state.scene.duration;
    ui.timeSlider.max = state.scene.duration;
  });

  function updatePlayUI() {
    ui.btnPlay.textContent = state.playing ? '⏸' : '▶';
    ui.playState.textContent = state.exporting ? '导出录音中…'
      : state.recording ? '录制路线中（拖动对象）'
      : state.playing ? '回放中' : (state.time > 0 ? '已暂停（可拖动听者检查）' : '已停止');
  }

  /* 应用时间轴，可跳过正在录制拖动中的实体 */
  function applyTimelineExcept(skip) {
    const sc = state.scene, t = state.time;
    for (const s of sc.sources) {
      if (s === skip) continue;
      const p = Scene.samplePath(s.path, t);
      if (p) { s.x = p.x; s.y = p.y; if (p.angle !== undefined) s.angle = p.angle; }
    }
    if (sc.listener && sc.listener !== skip) {
      const p = Scene.samplePath(sc.listener.path, t);
      if (p) { sc.listener.x = p.x; sc.listener.y = p.y; sc.listener.angle = p.angle; }
    }
  }

  /* ---------- 主循环 ---------- */
  let lastTs = 0, liveTimer = 0;
  function loop(ts) {
    const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
    lastTs = ts;

    if (state.playing) {
      state.time += dt;
      if (state.time >= state.scene.duration) {
        if (state.exporting) {
          state.playing = false;
        } else {
          state.time = 0; // 循环回放
        }
      }
      applyTimelineExcept(state.recording ? state.recTarget : null);
      ui.timeSlider.value = state.time;
    }
    ui.timeLabel.textContent = `${state.time.toFixed(2)} / ${state.scene.duration.toFixed(2)} s`;

    engine.sync(state.scene);
    draw();

    liveTimer += dt;
    if (liveTimer > 0.15) { liveTimer = 0; refreshLivePanel(); }
    requestAnimationFrame(loop);
  }

  /* ---------- 选中对象属性面板 ---------- */
  const selBody = document.getElementById('selBody');

  function row(label, inputHtml, valId) {
    return `<div class="prop-row"><label>${label}</label>${inputHtml}${valId ? `<span class="val" id="${valId}"></span>` : ''}</div>`;
  }
  function slider(id, min, max, step, val) {
    return `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${val}">`;
  }

  function refreshSelPanel() {
    const sel = state.selection;
    if (!sel) { selBody.innerHTML = '<p class="muted">未选中任何对象</p>'; return; }
    const o = sel.obj;
    let html = '';
    if (sel.kind === 'source') {
      html += row('名称', `<input type="text" id="p_name" value="${o.name}">`);
      html += row('音量', slider('p_vol', 0, 1.5, 0.01, o.volume), 'v_vol');
      html += row('静音', `<input type="checkbox" id="p_mute" ${o.muted ? 'checked' : ''}>`);
      html += row('衰减模型', `<select id="p_distModel">
        <option value="linear">线性 linear</option>
        <option value="inverse">反比 inverse</option>
        <option value="exponential">指数 exponential</option></select>`);
      html += row('参考距离(m)', slider('p_ref', 0.2, 10, 0.1, o.refDistance), 'v_ref');
      html += row('最大距离(m)', slider('p_max', 5, 100, 1, o.maxDistance), 'v_max');
      html += row('滚降系数', slider('p_roll', 0, 3, 0.05, o.rolloff), 'v_roll');
      html += row('锥体内角°', slider('p_cin', 0, 360, 5, o.coneInner), 'v_cin');
      html += row('锥体外角°', slider('p_cout', 0, 360, 5, o.coneOuter), 'v_cout');
      html += row('锥体外增益', slider('p_cgain', 0, 1, 0.01, o.coneOuterGain), 'v_cgain');
      html += row('声音类型', `<select id="p_stype">
        <option value="tone">纯音</option><option value="beep">蜂鸣</option>
        <option value="noise">噪声</option><option value="engine">引擎</option>
        <option value="melody">旋律</option></select>`);
      html += `<div id="soundExtra"></div>`;
      html += row('路线关键帧', `<span>${o.path.length} 个</span>
        <button id="p_clearPath" ${o.path.length ? '' : 'disabled'}>清除路线</button>`);
    } else if (sel.kind === 'listener') {
      html += `<p class="muted">听者：拖动移动，拖动白色手柄旋转。暂停回放后可自由拖动检查各位置听感。</p>`;
      html += row('朝向(°)', slider('p_lang', -180, 180, 1, Math.round(o.angle * 180 / Math.PI)), 'v_lang');
      html += row('路线关键帧', `<span>${o.path.length} 个</span>
        <button id="p_clearPath" ${o.path.length ? '' : 'disabled'}>清除路线</button>`);
    } else if (sel.kind === 'wall') {
      html += row('遮挡阻尼', slider('p_damp', 0, 1, 0.01, o.damping), 'v_damp');
      html += `<p class="muted">阻尼越大，穿墙衰减与低通越明显。</p>`;
    } else if (sel.kind === 'zone') {
      html += row('名称', `<input type="text" id="p_zname" value="${o.name}">`);
      html += row('混响衰减(s)', slider('p_decay', 0.1, 8, 0.1, o.decay), 'v_decay');
      html += row('湿声比例', slider('p_wet', 0, 1, 0.01, o.wet), 'v_wet');
      html += row('半径(m)', slider('p_zr', 1, 30, 0.5, o.r), 'v_zr');
    }
    selBody.innerHTML = html;
    bindSelPanel(sel);
  }

  function bindSelPanel(sel) {
    const o = sel.obj;
    const $ = id => document.getElementById(id);
    const bindSlider = (id, vid, fn, fmt) => {
      const el = $(id); if (!el) return;
      const show = () => { if ($(vid)) $(vid).textContent = fmt ? fmt(el.value) : el.value; };
      el.addEventListener('input', () => { fn(parseFloat(el.value)); show(); });
      show();
    };
    if (sel.kind === 'source') {
      $('p_name').addEventListener('input', e => { o.name = e.target.value; });
      bindSlider('p_vol', 'v_vol', v => o.volume = v);
      $('p_mute').addEventListener('change', e => { o.muted = e.target.checked; });
      $('p_distModel').value = o.distModel;
      $('p_distModel').addEventListener('change', e => { o.distModel = e.target.value; });
      bindSlider('p_ref', 'v_ref', v => o.refDistance = v);
      bindSlider('p_max', 'v_max', v => o.maxDistance = v);
      bindSlider('p_roll', 'v_roll', v => o.rolloff = v);
      bindSlider('p_cin', 'v_cin', v => { o.coneInner = Math.min(v, o.coneOuter); });
      bindSlider('p_cout', 'v_cout', v => { o.coneOuter = Math.max(v, o.coneInner); });
      bindSlider('p_cgain', 'v_cgain', v => o.coneOuterGain = v);
      $('p_stype').value = o.sound.type;
      $('p_stype').addEventListener('change', e => {
        o.sound = defaultSound(e.target.value, o.sound);
        refreshSelPanel();
      });
      renderSoundExtra(o);
      const cp = $('p_clearPath');
      if (cp) cp.addEventListener('click', () => { o.path = []; refreshSelPanel(); });
    } else if (sel.kind === 'listener') {
      bindSlider('p_lang', 'v_lang', v => { o.angle = v * Math.PI / 180; });
      const cp = $('p_clearPath');
      if (cp) cp.addEventListener('click', () => { o.path = []; refreshSelPanel(); });
    } else if (sel.kind === 'wall') {
      bindSlider('p_damp', 'v_damp', v => o.damping = v);
    } else if (sel.kind === 'zone') {
      $('p_zname').addEventListener('input', e => { o.name = e.target.value; });
      bindSlider('p_decay', 'v_decay', v => o.decay = v);
      bindSlider('p_wet', 'v_wet', v => o.wet = v);
      bindSlider('p_zr', 'v_zr', v => o.r = v);
    }
  }

  function defaultSound(type, old) {
    const keep = old || {};
    switch (type) {
      case 'tone': return { type, wave: keep.wave || 'sine', freq: keep.freq || 440 };
      case 'beep': return { type, freq: keep.freq || 880, rate: keep.rate || 2 };
      case 'noise': return { type, bandFreq: keep.bandFreq || 1200, bandQ: keep.bandQ || 0.8 };
      case 'engine': return { type, freq: keep.freq || 70 };
      case 'melody': return { type, tempo: keep.tempo || 120, notes: keep.notes || [523, 587, 659, 784, 659, 587] };
    }
    return { type };
  }

  function renderSoundExtra(o) {
    const box = document.getElementById('soundExtra');
    const s = o.sound;
    let html = '';
    if (s.type === 'tone') {
      html += row('波形', `<select id="s_wave">
        <option>sine</option><option>square</option><option>sawtooth</option><option>triangle</option></select>`);
      html += row('频率(Hz)', slider('s_freq', 50, 2000, 1, s.freq), 'v_sfreq');
    } else if (s.type === 'beep') {
      html += row('频率(Hz)', slider('s_freq', 200, 4000, 10, s.freq), 'v_sfreq');
      html += row('蜂鸣率(Hz)', slider('s_rate', 0.2, 10, 0.1, s.rate), 'v_srate');
    } else if (s.type === 'noise') {
      html += row('带通频率', slider('s_band', 100, 8000, 10, s.bandFreq), 'v_sband');
      html += row('Q 值', slider('s_q', 0.1, 10, 0.1, s.bandQ), 'v_sq');
    } else if (s.type === 'engine') {
      html += row('基频(Hz)', slider('s_freq', 30, 300, 1, s.freq), 'v_sfreq');
    } else if (s.type === 'melody') {
      html += row('速度(BPM)', slider('s_tempo', 60, 240, 1, s.tempo), 'v_stempo');
    }
    box.innerHTML = html;
    const $ = id => document.getElementById(id);
    const bs = (id, vid, fn) => {
      const el = $(id); if (!el) return;
      const show = () => { if ($(vid)) $(vid).textContent = el.value; };
      el.addEventListener('input', () => { fn(parseFloat(el.value)); show(); });
      show();
    };
    if ($('s_wave')) { $('s_wave').value = s.wave; $('s_wave').addEventListener('change', e => s.wave = e.target.value); }
    bs('s_freq', 'v_sfreq', v => s.freq = v);
    bs('s_rate', 'v_srate', v => s.rate = v);
    bs('s_band', 'v_sband', v => s.bandFreq = v);
    bs('s_q', 'v_sq', v => s.bandQ = v);
    bs('s_tempo', 'v_stempo', v => s.tempo = v);
  }

  /* ---------- 声源实时参数面板 ---------- */
  const liveBody = document.getElementById('liveBody');
  function refreshLivePanel() {
    const sc = state.scene;
    if (!sc.sources.length) { liveBody.innerHTML = '<p class="muted">场景中没有声源</p>'; return; }
    const L = sc.listener;
    let html = '';
    for (const s of sc.sources) {
      const lv = AudioEngine.computeLive(s, L, sc.walls, sc.zones);
      const panTxt = !L ? '—' : Math.abs(lv.panDeg) < 5 ? '正中'
        : lv.panDeg > 0 ? `左 ${Math.abs(lv.panDeg).toFixed(0)}°` : `右 ${Math.abs(lv.panDeg).toFixed(0)}°`;
      const total = Util.clamp((s.muted ? 0 : s.volume) * lv.distGain * lv.coneGain * lv.occFactor, 0, 1.5);
      html += `<div class="live-src"><h3>${s.name}${s.muted ? '（已静音）' : ''}</h3><table>
        <tr><td>距离</td><td class="v">${lv.dist.toFixed(2)} m</td>
            <td>距离增益</td><td class="v">${lv.distGain.toFixed(3)}</td></tr>
        <tr><td>声像</td><td class="v">${panTxt}</td>
            <td>锥体增益</td><td class="v">${lv.coneGain.toFixed(3)}</td></tr>
        <tr><td>遮挡衰减</td><td class="v">${lv.occDb.toFixed(1)} dB</td>
            <td>低通截止</td><td class="v">${lv.lpf >= 20000 ? '—' : Math.round(lv.lpf) + ' Hz'}</td></tr>
        <tr><td>混响湿声</td><td class="v">${Math.round(lv.wet * 100)} %</td>
            <td>所在混响区</td><td class="v">${lv.zoneName || '—'}</td></tr>
      </table><div class="bar"><div style="width:${Math.min(100, total / 1.5 * 100)}%"></div></div></div>`;
    }
    liveBody.innerHTML = html;
  }

  /* ---------- 场景保存 / 加载 / 导入导出 ---------- */
  const LS_KEY = 'spatialAudioPreviewer.scenes';
  const sampleSelect = document.getElementById('sampleSelect');
  const savedSelect = document.getElementById('savedSelect');

  Samples.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.key; opt.textContent = s.label;
    sampleSelect.appendChild(opt);
  });
  sampleSelect.addEventListener('change', () => {
    const sm = Samples.find(x => x.key === sampleSelect.value);
    if (sm) loadScene(sm.build());
    sampleSelect.value = '';
  });

  function loadScene(sc) {
    state.scene = sc;
    state.time = 0; state.playing = false;
    state.recording = false;
    btnRecord.classList.remove('recording'); btnRecord.textContent = '● 录制路线';
    select(null);
    ui.durationInput.value = sc.duration;
    ui.timeSlider.max = sc.duration;
    ui.timeSlider.value = 0;
    sc.applyTimeline(0);
    updatePlayUI();
    // 视野居中到场景内容
    const pts = [];
    sc.sources.forEach(s => pts.push([s.x, s.y]));
    if (sc.listener) pts.push([sc.listener.x, sc.listener.y]);
    sc.zones.forEach(z => pts.push([z.x, z.y]));
    if (pts.length) {
      state.cam.x = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      state.cam.y = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    }
  }

  function refreshSavedList() {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    savedSelect.innerHTML = '<option value="">已保存场景…</option>';
    Object.keys(all).forEach(n => {
      const opt = document.createElement('option');
      opt.value = n; opt.textContent = n;
      savedSelect.appendChild(opt);
    });
  }
  savedSelect.addEventListener('change', () => {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    const data = all[savedSelect.value];
    if (data) loadScene(Scene.fromJSON(data));
    savedSelect.value = '';
  });

  document.getElementById('btnNewScene').addEventListener('click', () => {
    if (!confirm('清空当前场景？')) return;
    loadScene(new Scene());
    state.cam = { x: 0, y: 0, zoom: 1 };
  });

  document.getElementById('btnSaveScene').addEventListener('click', () => {
    const name = prompt('场景名称：', state.scene.name);
    if (!name) return;
    state.scene.name = name;
    const all = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    all[name] = state.scene.toJSON();
    localStorage.setItem(LS_KEY, JSON.stringify(all));
    refreshSavedList();
    alert('已保存到浏览器本地存储');
  });

  document.getElementById('btnExportScene').addEventListener('click', () => {
    Util.download(`${state.scene.name}.scene.json`, JSON.stringify(state.scene.toJSON(), null, 2));
  });

  const fileImport = document.getElementById('fileImport');
  document.getElementById('btnImportScene').addEventListener('click', () => fileImport.click());
  fileImport.addEventListener('change', () => {
    const f = fileImport.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try { loadScene(Scene.fromJSON(JSON.parse(rd.result))); }
      catch (err) { alert('导入失败：' + err.message); }
    };
    rd.readAsText(f);
    fileImport.value = '';
  });

  /* 导出当前生效的声源配置（供游戏运行时参考） */
  document.getElementById('btnExportConfig').addEventListener('click', () => {
    const sc = state.scene, L = sc.listener;
    const cfg = {
      scene: sc.name,
      exportedAt: new Date().toISOString(),
      coordinateNote: '2D 世界坐标（米），角度为弧度（屏幕坐标系，y 向下）',
      listener: L ? { x: L.x, y: L.y, angle: L.angle } : null,
      sources: sc.sources.map(s => {
        const lv = AudioEngine.computeLive(s, L, sc.walls, sc.zones);
        return {
          name: s.name,
          position: { x: s.x, y: s.y, angle: s.angle },
          volume: s.volume, muted: s.muted,
          distanceModel: s.distModel,
          refDistance: s.refDistance, maxDistance: s.maxDistance, rolloff: s.rolloff,
          cone: { inner: s.coneInner, outer: s.coneOuter, outerGain: s.coneOuterGain },
          sound: s.sound,
          path: s.path,
          effective: {
            distance: +lv.dist.toFixed(3),
            distanceGain: +lv.distGain.toFixed(4),
            panDeg: +lv.panDeg.toFixed(1),
            coneGain: +lv.coneGain.toFixed(4),
            occlusionDb: +lv.occDb.toFixed(2),
            lowpassHz: Math.round(lv.lpf),
            reverbWet: +lv.wet.toFixed(3),
          },
        };
      }),
      walls: sc.walls, reverbZones: sc.zones,
    };
    Util.download(`${sc.name}.sources.json`, JSON.stringify(cfg, null, 2));
  });

  /* 导出试听结果：从头回放整条时间轴并录音 */
  document.getElementById('btnExportAudio').addEventListener('click', async () => {
    if (state.exporting) return;
    if (!state.scene.sources.length) { alert('场景中没有声源'); return; }
    engine.enabled = true;
    document.getElementById('chkAudio').checked = true;
    engine.ensureContext();
    state.exporting = true;
    state.time = 0; state.playing = true;
    updatePlayUI();
    try {
      const blob = await engine.recordFor(state.scene.duration);
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      Util.download(`${state.scene.name}.试听.${ext}`, blob);
    } catch (err) {
      alert('录音导出失败：' + err.message);
    }
    state.exporting = false;
    state.playing = false;
    updatePlayUI();
  });

  /* ---------- 启动 ---------- */
  refreshSavedList();
  loadScene(Samples[0].build());
  resize();
  requestAnimationFrame(loop);
})();
