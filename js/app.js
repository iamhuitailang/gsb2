/*
 * app.js — 主程序：编辑交互、遮挡计算调度、渲染管线、受光查询
 */
(function () {
  'use strict';

  const { Geometry: G, Lighting: L, Scene: S, Store } = window;

  // ---------- 状态 ----------
  let scene = S.createDefaultScene();
  const state = {
    tool: 'select',            // select | wall | light
    view: 'composite',         // composite | visibility | hits
    blend: 'additive',
    singleLightId: null,       // 单灯视图对象
    showHelpers: true,
    snap: false,
    selected: null,            // { kind: 'light'|'wall', id }
    draftWall: null,           // 正在画的墙链 { points: [] }
    drag: null,                // 拖动会话
    query: null,               // 地面查询 { x, y, results }
    mouse: null,
  };

  // 每帧重算的几何缓存：每盏灯独立计算，互不影响
  let cache = { segments: [], perLight: [] };

  // 多边形首顶点是灯心，外圈顶点不足 3 个视为不可渲染
  function hasVisibleArea(entry) {
    return entry && entry.polygon.filter(v => !v.isOrigin).length >= 3;
  }

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // ---------- 几何调度 ----------
  function recompute() {
    const segments = G.flattenWalls(scene.walls);
    const perLight = scene.lights.map(light => {
      if (!light.on) {
        return { light, polygon: [], hits: new Map(), onWall: null };
      }
      const { polygon, hits } = G.computeVisibility(light, segments, light.radius);
      return { light, polygon, hits, onWall: G.pointOnWall(light, segments) };
    });
    cache = { segments, perLight };
  }

  // ---------- 坐标 ----------
  function eventToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const y = (e.clientY - rect.top) * (H / rect.height);
    const p = { x, y };
    if (state.snap) { p.x = Math.round(p.x / 10) * 10; p.y = Math.round(p.y / 10) * 10; }
    return p;
  }

  // ---------- 命中测试 ----------
  function hitTest(p) {
    // 1. 灯
    for (const light of scene.lights) {
      if (G.dist(p, light) <= 10) return { kind: 'light', id: light.id };
    }
    // 2. 墙端点
    for (const wall of scene.walls) {
      for (let i = 0; i < wall.points.length; i++) {
        if (G.dist(p, wall.points[i]) <= 8) {
          return { kind: 'vertex', wallId: wall.id, index: i };
        }
      }
    }
    // 3. 墙线段
    for (const seg of cache.segments) {
      const pr = G.projectPoint(p, seg);
      if (pr.dist <= 6) return { kind: 'wall', id: seg.wallId, segId: seg.id };
    }
    return null;
  }

  // ---------- 渲染 ----------
  function render() {
    ctx.clearRect(0, 0, W, H);
    drawBackground();

    const single = getSingleLightEntry();

    // 光照层
    if (state.view === 'visibility' || state.view === 'hits') {
      if (single && single.light.on) {
        if (state.view === 'visibility') drawVisibilityDebug(single);
        drawLightGlow(single); // 淡光底，便于辨认范围
      }
    } else {
      for (const entry of cache.perLight) {
        if (!entry.light.on || !hasVisibleArea(entry)) continue;
        const layer = L.renderLightLayer(entry.light, entry.polygon, W, H);
        L.compositeLayer(ctx, layer, state.blend);
      }
    }

    if (state.showHelpers) {
      drawHitsDebug(single);
      drawWalls();
      drawDraftWall();
      drawMarkers();
      drawLights();
      drawSelection();
    }
    drawQuery();
  }

  function drawBackground() {
    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, W, H);
    // 网格
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 50; x < W; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 50; y < H; y += 50) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
  }

  function drawLightGlow(entry) {
    const layer = L.renderLightLayer(entry.light, entry.polygon, W, H);
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.drawImage(layer, 0, 0);
    ctx.restore();
  }

  function drawVisibilityDebug(entry) {
    const { light, polygon } = entry;
    const ring = polygon.filter(v => !v.isOrigin);
    if (ring.length < 3) return;
    ctx.save();
    ctx.beginPath();
    L.buildLightPath(ctx, light, polygon);
    ctx.fillStyle = 'rgba(88, 214, 141, 0.14)';
    ctx.strokeStyle = 'rgba(88, 214, 141, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.fill();
    ctx.stroke();

    // 顶点
    ctx.fillStyle = 'rgba(88, 214, 141, 0.95)';
    for (const v of ring) {
      ctx.beginPath();
      ctx.arc(v.x, v.y, v.onCircle ? 2 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHitsDebug(single) {
    if (state.view !== 'hits' || !single || !single.light.on) return;
    const { light, hits } = single;

    // 半径圈
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.arc(light.x, light.y, light.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // 从灯到每个去重命中点的射线
    const seen = new Set();
    ctx.strokeStyle = 'rgba(255, 183, 107, 0.55)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#ffb76b';
    for (const [segId, points] of hits) {
      for (const pt of points) {
        const key = pt.x.toFixed(1) + ',' + pt.y.toFixed(1);
        if (seen.has(key)) continue;
        seen.add(key);
        ctx.beginPath();
        ctx.moveTo(light.x, light.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // 标注被命中的墙段
      const seg = cache.segments.find(s => s.id === segId);
      if (seg) {
        const mid = { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
        ctx.fillStyle = '#ff6b6b';
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawWalls() {
    for (const wall of scene.walls) {
      const selected = state.selected && state.selected.kind === 'wall' && state.selected.id === wall.id;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 墙体先画一圈深色外廓，盖住灯光在墙两侧的亚像素漏光
      ctx.strokeStyle = '#050608';
      ctx.lineWidth = 9;
      strokeChain(wall.points);
      ctx.strokeStyle = selected ? '#7db4ff' : '#9aa7b8';
      ctx.lineWidth = 4;
      strokeChain(wall.points);
      ctx.restore();
    }
  }

  function strokeChain(points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  function drawDraftWall() {
    if (!state.draftWall || state.draftWall.points.length === 0) return;
    const pts = state.draftWall.points;
    ctx.save();
    ctx.strokeStyle = '#ffd27d';
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (state.mouse) ctx.lineTo(state.mouse.x, state.mouse.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffd27d';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawMarkers() {
    for (const m of scene.markers) {
      ctx.save();
      ctx.strokeStyle = 'rgba(160, 220, 255, 0.85)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#a0dcff';
      ctx.font = '11px sans-serif';
      ctx.fillText(m.name, m.x + 16, m.y + 4);
      ctx.restore();
    }
  }

  function drawLights() {
    for (const light of scene.lights) {
      const selected = state.selected && state.selected.kind === 'light' && state.selected.id === light.id;
      const entry = cache.perLight.find(e => e.light === light);
      ctx.save();

      if (selected || (state.view !== 'composite' && state.singleLightId === light.id)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.arc(light.x, light.y, light.radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 灯体
      ctx.beginPath();
      ctx.arc(light.x, light.y, selected ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = light.on ? light.color : '#555';
      ctx.shadowColor = light.on ? light.color : 'transparent';
      ctx.shadowBlur = light.on ? 16 : 0;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = light.on ? '#10131a' : '#888';
      ctx.stroke();

      // 关闭的灯打叉
      if (!light.on) {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(light.x - 5, light.y - 5); ctx.lineTo(light.x + 5, light.y + 5);
        ctx.moveTo(light.x + 5, light.y - 5); ctx.lineTo(light.x - 5, light.y + 5);
        ctx.stroke();
      }

      // 贴墙标记
      if (entry && entry.onWall) {
        ctx.fillStyle = '#e8a55c';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('贴墙!', light.x + 12, light.y - 10);
      }
      ctx.restore();
    }
  }

  function drawSelection() {
    if (!state.selected || state.selected.kind !== 'wall') return;
    const wall = scene.walls.find(w => w.id === state.selected.id);
    if (!wall) return;
    ctx.save();
    ctx.fillStyle = '#7db4ff';
    ctx.strokeStyle = '#0b0d11';
    ctx.lineWidth = 1.5;
    for (const p of wall.points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawQuery() {
    if (!state.query) return;
    const { x, y, results } = state.query;
    ctx.save();
    ctx.strokeStyle = '#5aa2ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 11, y); ctx.lineTo(x + 11, y);
    ctx.moveTo(x, y - 11); ctx.lineTo(x, y + 11);
    ctx.stroke();
    ctx.restore();

    const tip = document.getElementById('queryTip');
    if (results.length === 0) {
      tip.innerHTML = `<h3>受光查询 (${x.toFixed(0)}, ${y.toFixed(0)})</h3>
        <p class="none">没有任何灯的半径覆盖该点。</p>`;
    } else {
      const rows = results.map(r => {
        const cls = r.blocked ? 'blocked' : 'lit';
        const stateTxt = r.blocked
          ? `被墙 ${wallName(r.blocker.wallId)} 挡住`
          : `照亮（衰减 ${(r.attenuation * 100).toFixed(0)}%）`;
        return `<tr>
          <td><span style="color:${r.light.color}">●</span> ${escapeHtml(r.light.name)}</td>
          <td class="${cls}">${stateTxt}</td>
          <td class="dim">${r.distance.toFixed(0)}px</td>
        </tr>`;
      }).join('');
      tip.innerHTML = `<h3>受光查询 (${x.toFixed(0)}, ${y.toFixed(0)})</h3>
        <table>${rows}</table>`;
    }
    positionTip(x, y, tip);
    tip.hidden = false;
  }

  function wallName(wallId) {
    const w = scene.walls.find(x => x.id === wallId);
    return w ? w.name : wallId;
  }

  function positionTip(x, y, tip) {
    const wrap = canvas.parentElement.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    let left = (rect.left - wrap.left) + x * (rect.width / W) + 14;
    let top = (rect.top - wrap.top) + y * (rect.height / H) + 14;
    if (left + 290 > wrap.width) left -= 310;
    if (top + 160 > wrap.height) top -= 180;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function getSingleLightEntry() {
    const id = state.singleLightId || (scene.lights[0] && scene.lights[0].id);
    return cache.perLight.find(e => e.light.id === id) || null;
  }

  // ---------- 鼠标交互 ----------
  canvas.addEventListener('mousedown', e => {
    const p = eventToWorld(e);
    state.query = null;
    document.getElementById('queryTip').hidden = true;

    if (state.tool === 'light') {
      addLight(p);
      return;
    }
    if (state.tool === 'wall') {
      if (!state.draftWall) state.draftWall = { points: [] };
      state.draftWall.points.push(p);
      scheduleRender();
      return;
    }

    // select 工具
    const hit = hitTest(p);
    if (!hit) {
      state.selected = null;
      state.query = { x: p.x, y: p.y, results: runQuery(p) };
      refreshPanels();
      scheduleRender();
      return;
    }

    if (hit.kind === 'light') {
      state.selected = { kind: 'light', id: hit.id };
      const light = scene.lights.find(l => l.id === hit.id);
      state.drag = { type: 'light', id: hit.id, off: G.sub(light, p) };
    } else if (hit.kind === 'vertex') {
      state.selected = { kind: 'wall', id: hit.wallId };
      state.drag = { type: 'vertex', wallId: hit.wallId, index: hit.index };
    } else if (hit.kind === 'wall') {
      state.selected = { kind: 'wall', id: hit.wallId };
      const wall = scene.walls.find(w => w.id === hit.wallId);
      state.drag = { type: 'wall', wallId: hit.wallId, start: p, original: wall.points.map(q => ({ ...q })) };
    }
    refreshPanels();
    scheduleRender();
  });

  canvas.addEventListener('mousemove', e => {
    const p = eventToWorld(e);
    state.mouse = p;
    document.getElementById('mouseText').textContent = `x:${p.x.toFixed(0)} y:${p.y.toFixed(0)}`;

    if (!state.drag) { scheduleRender(); return; }
    const d = state.drag;

    if (d.type === 'light') {
      const light = scene.lights.find(l => l.id === d.id);
      light.x = clamp(p.x + d.off.x, 4, W - 4);
      light.y = clamp(p.y + d.off.y, 4, H - 4);
    } else if (d.type === 'vertex') {
      const wall = scene.walls.find(w => w.id === d.wallId);
      wall.points[d.index] = { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) };
    } else if (d.type === 'wall') {
      const wall = scene.walls.find(w => w.id === d.wallId);
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      wall.points = d.original.map(q => ({
        x: clamp(q.x + dx, 0, W),
        y: clamp(q.y + dy, 0, H),
      }));
    }
    recompute();
    autosaveSoon();
    refreshPanels();
    scheduleRender();
  });

  window.addEventListener('mouseup', () => { state.drag = null; });
  canvas.addEventListener('mouseleave', () => { state.mouse = null; scheduleRender(); });

  // 双击结束墙链
  canvas.addEventListener('dblclick', e => {
    e.preventDefault();
    finishDraftWall();
  });

  function finishDraftWall() {
    if (state.tool !== 'wall' || !state.draftWall) return;
    const pts = state.draftWall.points;
    if (pts.length >= 2) {
      scene.walls.push({ id: G.uid('w'), name: '墙 ' + (scene.walls.length + 1), points: pts });
      recompute();
      autosaveSoon();
    }
    state.draftWall = null;
    refreshPanels();
    scheduleRender();
  }

  function addLight(p) {
    const light = {
      id: G.uid('l'),
      name: '灯 ' + (scene.lights.length + 1),
      x: clamp(p.x, 4, W - 4), y: clamp(p.y, 4, H - 4),
      color: '#ffe9b0', radius: 260, intensity: 1, on: true,
    };
    scene.lights.push(light);
    state.selected = { kind: 'light', id: light.id };
    state.singleLightId = light.id;
    recompute();
    autosaveSoon();
    refreshPanels();
    scheduleRender();
  }

  function runQuery(p) {
    return G.queryPoint(p, scene.lights, cache.segments);
  }

  // ---------- 键盘 ----------
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      state.draftWall = null;
      state.selected = null;
      state.query = null;
      document.getElementById('queryTip').hidden = true;
      setTool('select');
      refreshPanels();
      scheduleRender();
    } else if ((e.key === 'Enter') && state.tool === 'wall') {
      finishDraftWall();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
      deleteSelected();
    }
  });

  function deleteSelected() {
    const sel = state.selected;
    if (!sel) return;
    if (sel.kind === 'light') {
      scene.lights = scene.lights.filter(l => l.id !== sel.id);
      if (state.singleLightId === sel.id) state.singleLightId = null;
    } else if (sel.kind === 'wall') {
      scene.walls = scene.walls.filter(w => w.id !== sel.id);
    }
    state.selected = null;
    recompute();
    autosaveSoon();
    refreshPanels();
    scheduleRender();
  }

  // ---------- 面板 ----------
  function refreshPanels() {
    refreshLightList();
    refreshMarkerList();
    refreshSingleSelect();
    refreshInspector();
  }

  function refreshLightList() {
    const ul = document.getElementById('lightList');
    ul.innerHTML = '';
    for (const light of scene.lights) {
      const li = document.createElement('li');
      li.className = 'light-item' + (light.on ? '' : ' off') +
        (state.selected && state.selected.id === light.id ? ' selected' : '');
      const entry = cache.perLight.find(e => e.light === light);
      li.innerHTML = `
        <span class="swatch" style="background:${light.color};color:${light.color}"></span>
        <span class="name" title="${escapeHtml(light.name)}">${escapeHtml(light.name)}</span>
        ${entry && entry.onWall ? '<span class="badge">贴墙</span>' : ''}
        <input type="checkbox" class="toggle" ${light.on ? 'checked' : ''} title="开关这盏灯" />`;
      li.querySelector('.name').onclick = () => {
        state.selected = { kind: 'light', id: light.id };
        state.singleLightId = light.id;
        refreshPanels();
        scheduleRender();
      };
      li.querySelector('.swatch').onclick = li.querySelector('.name').onclick;
      li.querySelector('.toggle').onchange = ev => {
        light.on = ev.target.checked;
        recompute();
        autosaveSoon();
        refreshPanels();
        scheduleRender();
      };
      ul.appendChild(li);
    }
  }

  function refreshMarkerList() {
    const ul = document.getElementById('markerList');
    const panel = document.getElementById('markerPanel');
    panel.style.display = scene.markers.length ? '' : 'none';
    ul.innerHTML = '';
    for (const m of scene.markers) {
      const li = document.createElement('li');
      li.className = 'marker-item';
      li.innerHTML = `<span>${escapeHtml(m.name)} <span class="dim">(${m.x}, ${m.y})</span></span>`;
      const btn = document.createElement('button');
      btn.textContent = '把选中的灯移过去';
      btn.onclick = () => {
        const target = selectedLight();
        if (!target) { setStatus('先在灯具列表里选一盏灯'); return; }
        target.x = m.x; target.y = m.y;
        state.singleLightId = target.id;
        recompute();
        autosaveSoon();
        refreshPanels();
        scheduleRender();
      };
      li.appendChild(btn);
      ul.appendChild(li);
    }
  }

  function refreshSingleSelect() {
    const sel = document.getElementById('singleLightSelect');
    if (sel.options.length !== scene.lights.length ||
      !scene.lights.some(l => l.id === state.singleLightId)) {
      const prev = state.singleLightId;
      sel.innerHTML = '';
      for (const light of scene.lights) {
        const opt = document.createElement('option');
        opt.value = light.id;
        opt.textContent = light.name + (light.on ? '' : '（已关）');
        sel.appendChild(opt);
      }
      state.singleLightId = scene.lights.some(l => l.id === prev)
        ? prev
        : (scene.lights[0] && scene.lights[0].id) || null;
      sel.value = state.singleLightId || '';
    }
  }

  function selectedLight() {
    if (!state.selected || state.selected.kind !== 'light') return null;
    return scene.lights.find(l => l.id === state.selected.id) || null;
  }

  function selectedWall() {
    if (!state.selected || state.selected.kind !== 'wall') return null;
    return scene.walls.find(w => w.id === state.selected.id) || null;
  }

  function refreshInspector() {
    const box = document.getElementById('inspector');
    const light = selectedLight();
    const wall = selectedWall();

    if (light) {
      const entry = cache.perLight.find(e => e.light === light);
      box.innerHTML = `
        <div class="insp-grid">
          <label>名称 <input type="text" id="inspName" value="${escapeHtml(light.name)}" /></label>
          <label>颜色 <input type="color" id="inspColor" value="${light.color}" /></label>
          <label>X <input type="number" id="inspX" value="${light.x.toFixed(0)}" min="0" max="${W}" /></label>
          <label>Y <input type="number" id="inspY" value="${light.y.toFixed(0)}" min="0" max="${H}" /></label>
          <label>半径 <div class="insp-row">
            <input type="range" id="inspRadius" min="20" max="700" value="${light.radius}" />
            <span class="insp-value" id="radiusVal">${light.radius}</span></div></label>
          <label>强度 <div class="insp-row">
            <input type="range" id="inspIntensity" min="0" max="2" step="0.05" value="${light.intensity}" />
            <span class="insp-value" id="intensityVal">${light.intensity.toFixed(2)}</span></div></label>
        </div>
        ${entry && entry.onWall ? '<div class="insp-warn">灯贴在墙上：墙两侧仍正常照亮，墙本体由墙体覆盖绘制，不会出现漏光；挪开后提示消失。</div>' : ''}`;

      document.getElementById('inspName').oninput = e => { light.name = e.target.value; autosaveSoon(); refreshLightList(); };
      document.getElementById('inspColor').oninput = e => { light.color = e.target.value; autosaveSoon(); refreshLightList(); scheduleRender(); };
      document.getElementById('inspX').oninput = e => { light.x = clamp(+e.target.value || 0, 0, W); afterLightChange(); };
      document.getElementById('inspY').oninput = e => { light.y = clamp(+e.target.value || 0, 0, H); afterLightChange(); };
      bindRange('inspRadius', 'radiusVal', v => { light.radius = v; }, true);
      bindRange('inspIntensity', 'intensityVal', v => { light.intensity = v; }, false);
    } else if (wall) {
      box.innerHTML = `
        <div class="insp-grid">
          <label>名称 <input type="text" id="inspWallName" value="${escapeHtml(wall.name)}" /></label>
          <p class="hint">${wall.points.length} 个端点，${wall.points.length - 1} 段线段。
          切换到“选择/拖动”工具后可拖动端点或整段墙。</p>
        </div>`;
      document.getElementById('inspWallName').oninput = e => { wall.name = e.target.value; autosaveSoon(); };
    } else {
      box.innerHTML = '<p class="hint">在画布中选择一盏灯或一条墙链。</p>';
    }
  }

  function bindRange(inputId, valId, apply, isRadius) {
    const input = document.getElementById(inputId);
    const val = document.getElementById(valId);
    input.oninput = () => {
      const v = +input.value;
      apply(v);
      val.textContent = isRadius ? v : v.toFixed(2);
      afterLightChange();
    };
  }

  function afterLightChange() {
    recompute();
    autosaveSoon();
    refreshPanels();
    scheduleRender();
  }

  // ---------- 工具栏 ----------
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('.tool-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    canvas.className = 'tool-' + tool;
    if (tool !== 'wall') state.draftWall = null;
    setStatus(tool === 'wall'
      ? '单击依次添加墙端点，双击或回车结束，Esc 取消'
      : tool === 'light' ? '单击地面放置一盏灯' : '拖动灯、墙端点或整段墙；单击空地查询受光');
    scheduleRender();
  }

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.onclick = () => setTool(btn.dataset.tool);
  });

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.onclick = () => {
      state.view = btn.dataset.view;
      document.querySelectorAll('.view-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      scheduleRender();
    };
  });

  document.getElementById('singleLightSelect').onchange = e => {
    state.singleLightId = e.target.value;
    scheduleRender();
  };

  document.getElementById('blendMode').onchange = e => {
    state.blend = e.target.value;
    autosaveSoon();
    scheduleRender();
  };

  document.getElementById('showHelpers').onchange = e => {
    state.showHelpers = e.target.checked;
    scheduleRender();
  };

  document.getElementById('snapToGrid').onchange = e => {
    state.snap = e.target.checked;
  };

  document.getElementById('undoBtn').onclick = () => {
    if (state.draftWall && state.draftWall.points.length) {
      state.draftWall.points.pop();
    } else if (scene.walls.length > 0) {
      scene.walls.pop();
      recompute();
      autosaveSoon();
    }
    refreshPanels();
    scheduleRender();
  };

  document.getElementById('deleteBtn').onclick = deleteSelected;

  document.getElementById('saveBtn').onclick = () => {
    Store.autosave(scene);
    setStatus('场景已保存到浏览器 localStorage');
  };

  document.getElementById('loadBtn').onclick = () => {
    const data = Store.loadAutosave();
    if (!data) { setStatus('没有找到本地存档'); return; }
    loadScene(data, '已读取本地存档');
  };

  document.getElementById('exportSceneBtn').onclick = () => {
    Store.exportScene(scene);
    setStatus('场景 JSON 已导出');
  };

  document.getElementById('importSceneBtn').onclick = () =>
    document.getElementById('importFile').click();

  document.getElementById('importFile').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await Store.importScene(file);
      loadScene(data, '场景导入成功');
    } catch (err) {
      setStatus('导入失败：' + err.message);
    }
    e.target.value = '';
  };

  document.getElementById('exportLightmapBtn').onclick = () => {
    // 纯光照层：不含网格、墙、灯图标等任何辅助线，透明背景
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const octx = out.getContext('2d');
    for (const entry of cache.perLight) {
      if (!entry.light.on || !hasVisibleArea(entry)) continue;
      const layer = L.renderLightLayer(entry.light, entry.polygon, W, H);
      L.compositeLayer(octx, layer, state.blend);
    }
    Store.exportLightmap(out, scene, state.blend);
    setStatus('光照图 PNG 与坐标映射 JSON 已导出（' + L.COMPOSITE_OPS[state.blend].label + '）');
  };

  document.getElementById('exportMappingBtn').onclick = () => {
    Store.exportMapping(W, H, scene, state.blend, null);
    setStatus('坐标映射 JSON 已导出（不含图片）');
  };

  document.getElementById('defaultSceneBtn').onclick = () =>
    loadScene(S.createDefaultScene(), '已载入内置凹角窄缝场景');

  document.getElementById('emptySceneBtn').onclick = () =>
    loadScene(S.createEmptyScene(), '已创建空白场景');

  function loadScene(data, okMsg) {
    try {
      scene = S.validateScene(data);
      state.selected = null;
      state.draftWall = null;
      state.query = null;
      state.singleLightId = scene.lights[0] ? scene.lights[0].id : null;
      document.getElementById('queryTip').hidden = true;
      recompute();
      autosaveSoon();
      refreshPanels();
      scheduleRender();
      setStatus(okMsg);
    } catch (err) {
      setStatus('场景校验失败：' + err.message);
    }
  }

  // ---------- 杂项 ----------
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  let saveTimer = null;
  function autosaveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => Store.autosave(scene), 400);
  }

  function setStatus(text) {
    document.getElementById('statusText').textContent = text;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  // ---------- 初始化 ----------
  function init() {
    const saved = Store.loadAutosave();
    if (saved) {
      try {
        scene = S.validateScene(saved);
        setStatus('已恢复上次自动保存的场景');
      } catch (e) {
        scene = S.createDefaultScene();
      }
    }
    state.singleLightId = scene.lights[0] ? scene.lights[0].id : null;
    document.getElementById('blendMode').value = state.blend;
    recompute();
    refreshPanels();
    Store.autosave(scene); // 首次进入也落盘，保证刷新/重开总能恢复当前场景
    setTool('select');
    render();
  }

  init();
})();
