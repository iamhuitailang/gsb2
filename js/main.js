/* Main UI, camera, picking, tours and HUD wiring. */
(function () {
  'use strict';

  const T = window.Terrain;
  const TerrainViewer = window.TerrainViewer;
  const $ = (id) => document.getElementById(id);

  const canvas = $('glCanvas');
  let viewer = null;
  let viewerError = null;

  const settings = {
    crack: false,
    wireframe: false,
    freeze: false,
    snap: true,
    resolution: T.DEFAULT_RESOLUTION,
    renderScale: 1,
  };

  const lodStates = new Map();
  const overrides = {};
  const meshData = new Map();

  let camera = makeInitialCamera();
  let selectedEdge = null;
  let tour = null;
  let liveTour = null;
  let auditResults = {};
  const baseline = T.diagnosticBaseline();
  let toastTimer = null;

  const LOD_COLORS = [
    [0.18, 0.92, 0.42],
    [0.20, 0.66, 1.0],
    [1.0, 0.60, 0.12],
    [0.72, 0.34, 0.96],
  ];

  function makeInitialCamera() {
    const x = -18;
    const z = 82;
    return {
      eye: { x, y: T.heightAt(x, z) + 49, z },
      target: { x: 4, y: T.heightAt(4, -55) + 7, z: -55 },
    };
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function currentLod(id) {
    if (overrides[id] != null) return overrides[id];
    const st = lodStates.get(id);
    return st ? st.lod : T.rawLodForDistance(
      T.distanceToChunkXZ(camera.eye.x, camera.eye.z, ...id.split(',').map(Number))
    );
  }

  function lodColorMap() {
    const map = new Map();
    for (const c of T.allChunkCoords()) map.set(c.id, LOD_COLORS[currentLod(c.id)]);
    return map;
  }

  function rebuildChunk(id) {
    const parsed = T.parseChunkId(id);
    const lod = currentLod(id);
    const neighbors = T.neighborLods(parsed.cx, parsed.cz, lodStates, overrides);
    const mesh = T.buildChunkMesh(parsed.cx, parsed.cz, {
      lod,
      resolution: settings.resolution,
      snap: settings.snap,
      neighbors,
    });
    meshData.set(id, mesh);
    if (viewer) viewer.upsertMesh(mesh);
  }

  function rebuildAll() {
    meshData.clear();
    if (viewer) viewer.clearMeshes();
    for (const c of T.allChunkCoords()) rebuildChunk(c.id);
    updateOverlay();
    updateStats();
  }

  function rebuildAffected(ids) {
    const set = new Set();
    for (const id of ids) {
      if (!id) continue;
      set.add(id);
      const p = T.parseChunkId(id);
      const adjacent = [
        [p.cx - 1, p.cz],
        [p.cx + 1, p.cz],
        [p.cx, p.cz - 1],
        [p.cx, p.cz + 1],
      ];
      for (const [cx, cz] of adjacent) {
        if (T.inChunkRange(cx, cz)) set.add(T.chunkId(cx, cz));
      }
    }
    for (const id of set) rebuildChunk(id);
  }

  function triangleCount() {
    let sum = 0;
    for (const m of meshData.values()) sum += m.triangleCount;
    return sum;
  }

  function lodCounts() {
    const counts = [0, 0, 0, 0];
    for (const c of T.allChunkCoords()) counts[currentLod(c.id)]++;
    return counts;
  }

  function updateStats() {
    const counts = lodCounts();
    const cam = camera.eye;
    const tourText = tour ? ` · 固定镜头播放中` : '';
    $('liveStats').innerHTML =
      `种子 <code>${T.SEED}</code> · ${T.CHUNKS_X}×${T.CHUNKS_Z}=${T.CHUNKS_X * T.CHUNKS_Z} 块 · ` +
      `当前三角面 <b>${Math.round(triangleCount()).toLocaleString('zh-CN')}</b><br>` +
      `LOD 块数 0:${counts[0]} / 1:${counts[1]} / 2:${counts[2]} / 3:${counts[3]} · ` +
      `镜头 (${cam.x.toFixed(1)}, ${cam.y.toFixed(1)}, ${cam.z.toFixed(1)})${tourText}`;
    renderChunkMatrix();
  }

  let chunkMatrixSignature = '';
  function formatShortFaces(faces) {
    if (faces >= 1024) return (faces / 1024).toFixed(faces >= 10240 ? 0 : 1) + 'k';
    return String(faces);
  }

  function renderChunkMatrix() {
    const signatureParts = [];
    const cells = [];
    for (let cz = 0; cz < T.CHUNKS_Z; cz++) {
      for (let cx = 0; cx < T.CHUNKS_X; cx++) {
        const id = T.chunkId(cx, cz);
        const lod = currentLod(id);
        const n = T.segmentsForLod(lod, settings.resolution);
        const faces = n * n * 2;
        signatureParts.push(lod);
        cells.push(
          `<div class="chunk-cell lod${lod}" title="块 ${id} · LOD${lod} · ${n}×${n} 段 · 精确 ${faces.toLocaleString('zh-CN')} 三角面">` +
          `<span>${lod}</span><small>${formatShortFaces(faces)}</small></div>`
        );
      }
    }
    const signature = signatureParts.join('') + ':' + settings.resolution;
    if (signature === chunkMatrixSignature) return;
    chunkMatrixSignature = signature;
    $('chunkMatrix').innerHTML = cells.join('');
  }

  function pushLine(out, a, b, color) {
    out.push(a.x, a.y, a.z, color[0], color[1], color[2], color[3] == null ? 1 : color[3]);
    out.push(b.x, b.y, b.z, color[0], color[1], color[2], color[3] == null ? 1 : color[3]);
  }

  function pushPolyline(out, points, color) {
    for (let i = 1; i < points.length; i++) pushLine(out, points[i - 1], points[i], color);
  }

  function errorColor(e, alpha) {
    const a = alpha == null ? 0.95 : alpha;
    if (e < 0.12) return [0.25, 1.0, 0.48, a];
    if (e < 0.45) return [1.0, 0.86, 0.20, a];
    if (e < 1.1) return [1.0, 0.48, 0.12, a];
    return [1.0, 0.16, 0.24, a];
  }

  function edgePolyline(info, count, yMode, yOffset) {
    const d = info.desc;
    const pts = [];
    for (let k = 0; k <= count; k++) {
      const t = k / count;
      const p = T.edgeWorldPoint(d, t);
      let y;
      if (yMode === 'A') y = T.nativeEdgeHeight(d.orientation, d.fixed, d.from, d.length, info.nA, t);
      else if (yMode === 'B') y = T.nativeEdgeHeight(d.orientation, d.fixed, d.from, d.length, info.nB, t);
      else if (yMode === 'common') y = T.nativeEdgeHeight(d.orientation, d.fixed, d.from, d.length, info.commonN, t);
      else y = T.heightAt(p.x, p.z);
      pts.push({ x: p.x, y: y + (yOffset || 0), z: p.z });
    }
    return pts;
  }

  function addMarker(out, p, size, color) {
    pushLine(out, { x: p.x - size, y: p.y, z: p.z }, { x: p.x + size, y: p.y, z: p.z }, color);
    pushLine(out, { x: p.x, y: p.y - size, z: p.z }, { x: p.x, y: p.y + size, z: p.z }, color);
    pushLine(out, { x: p.x, y: p.y, z: p.z - size }, { x: p.x, y: p.y, z: p.z + size }, color);
    pushLine(out, { x: p.x, y: p.y, z: p.z + size }, { x: p.x, y: p.y, z: p.z - size }, color);
  }

  function updateOverlay() {
    if (!viewer) return;
    const lines = [];

    if (settings.crack) {
      for (const edgeId of T.allInternalEdges()) {
        const info = T.diagnoseEdge(edgeId, lodStates, settings.resolution, overrides);
        const pts = edgePolyline(info, info.commonN, 'common', 0.16);
        pushPolyline(lines, pts, errorColor(info.nativeMismatch, 0.82));
      }
    }

    if (selectedEdge) {
      const info = T.diagnoseEdge(selectedEdge, lodStates, settings.resolution, overrides);
      const cyan = [0.35, 0.95, 1.0, 1];
      const red = [1.0, 0.28, 0.32, 0.95];
      const blue = [0.30, 0.55, 1.0, 0.95];
      const white = [1, 1, 1, 0.9];
      const yellow = [1.0, 0.92, 0.25, 1];

      pushPolyline(lines, edgePolyline(info, 96, 'A', 0.28), red);
      pushPolyline(lines, edgePolyline(info, 96, 'B', 0.34), blue);
      pushPolyline(lines, edgePolyline(info, 96, 'common', 0.42), cyan);
      pushPolyline(lines, edgePolyline(info, T.EDGE_SAMPLES, 'true', 0.20), white);

      const np = info.nativeMismatchPoint;
      if (np) {
        pushLine(
          lines,
          { x: np.x, y: np.yA + 0.3, z: np.z },
          { x: np.x, y: np.yB + 0.3, z: np.z },
          [1, 0.1, 0.18, 1]
        );
        addMarker(lines, { x: np.x, y: (np.yA + np.yB) * 0.5 + 0.3, z: np.z }, 0.8, yellow);
      }

      const lp = info.seamErrorPoint;
      if (lp) {
        pushLine(
          lines,
          { x: lp.x, y: lp.yTrue + 0.48, z: lp.z },
          { x: lp.x, y: lp.yCommon + 0.48, z: lp.z },
          [1, 0.85, 0.1, 1]
        );
        addMarker(lines, { x: lp.x, y: lp.yTrue + 0.48, z: lp.z }, 0.55, white);
      }
    }

    viewer.setDebugBatch(lines);
  }

  function formatMeters(v) {
    return `${v.toFixed(3)} m / ${(v * 100).toFixed(1)} cm`;
  }

  function renderInspector() {
    const el = $('edgeInspector');
    if (!selectedEdge) {
      el.classList.add('empty');
      el.textContent = '尚未选中块边。';
      return;
    }

    const info = T.diagnoseEdge(selectedEdge, lodStates, settings.resolution, overrides);
    el.classList.remove('empty');
    const snapStatus = settings.snap
      ? `<span class="good">锁高后两侧接边差 = 0.000 m</span>`
      : `<span class="bad">锁高已关：此处会出现最多 ${formatMeters(info.nativeMismatch)} 的裂缝</span>`;

    el.innerHTML = `
      <div><b>${info.edgeId}</b></div>
      <dl class="kv">
        <dt>A 块</dt><dd>${info.idA} · <span class="badge lod${info.lodA}">LOD${info.lodA}</span> · ${info.nA} 段 · ${(info.nA * info.nA * 2).toLocaleString('zh-CN')} 三角面</dd>
        <dt>B 块</dt><dd>${info.idB} · <span class="badge lod${info.lodB}">LOD${info.lodB}</span> · ${info.nB} 段 · ${(info.nB * info.nB * 2).toLocaleString('zh-CN')} 三角面</dd>
        <dt>公共边精度</dt><dd>${info.commonN} 段（取较粗一侧，细边顶点吸附到同一折线）</dd>
        <dt>接边状态</dt><dd>${snapStatus}</dd>
        <dt>原始档差</dt><dd class="${info.nativeMismatch > 0.5 ? 'bad' : info.nativeMismatch > 0.12 ? 'warn' : 'good'}">${formatMeters(info.nativeMismatch)}</dd>
        <dt>锁边逼近误差</dt><dd class="${info.seamError > 0.8 ? 'bad' : info.seamError > 0.25 ? 'warn' : 'good'}">${formatMeters(info.seamError)}</dd>
        <dt>最大档差点</dt><dd>x=${info.nativeMismatchPoint.x.toFixed(2)}, z=${info.nativeMismatchPoint.z.toFixed(2)}</dd>
        <dt>最大误差点</dt><dd>x=${info.seamErrorPoint.x.toFixed(2)}, z=${info.seamErrorPoint.z.toFixed(2)}</dd>
      </dl>
      <div class="side-controls">
        <label>A 侧档位
          <select id="sideASelect">
            <option value="auto">自动</option><option>0</option><option>1</option><option>2</option><option>3</option>
          </select>
        </label>
        <label>B 侧档位
          <select id="sideBSelect">
            <option value="auto">自动</option><option>0</option><option>1</option><option>2</option><option>3</option>
          </select>
        </label>
      </div>
      <button id="btnClearSideOverrides" class="wide">清除此边两侧强制档位</button>
    `;

    $('sideASelect').value = overrides[info.idA] == null ? 'auto' : String(overrides[info.idA]);
    $('sideBSelect').value = overrides[info.idB] == null ? 'auto' : String(overrides[info.idB]);

    $('sideASelect').addEventListener('change', (e) => setSideOverride(info.idA, e.target.value));
    $('sideBSelect').addEventListener('change', (e) => setSideOverride(info.idB, e.target.value));
    $('btnClearSideOverrides').addEventListener('click', () => {
      delete overrides[info.idA];
      delete overrides[info.idB];
      lodStates.delete(info.idA);
      lodStates.delete(info.idB);
      T.updateLodStates(lodStates, camera.eye, performance.now(), { frozen: settings.freeze, overrides });
      rebuildAffected([info.idA, info.idB]);
      renderInspector();
      updateOverlay();
    });
  }

  function setSideOverride(chunkId, value) {
    if (value === 'auto') {
      delete overrides[chunkId];
      lodStates.delete(chunkId);
    } else {
      overrides[chunkId] = Number(value);
    }
    T.updateLodStates(lodStates, camera.eye, performance.now(), {
      frozen: settings.freeze,
      overrides,
    });
    rebuildAffected([chunkId]);
    renderInspector();
    updateOverlay();
  }

  function pointSegmentDistance(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const wx = px - ax;
    const wy = py - ay;
    const len2 = vx * vx + vy * vy;
    let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const x = ax + vx * t;
    const y = ay + vy * t;
    return Math.hypot(px - x, py - y);
  }

  function pickEdge(clientX, clientY) {
    if (!viewer) {
      toast('WebGL 不可用，无法在画面中拾取；可查看页面审计数据。');
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const threshold = 20;
    let best = null;

    for (const edgeId of T.allInternalEdges()) {
      const d = T.edgeDescriptor(edgeId);
      let previous = null;
      for (let i = 0; i <= 28; i++) {
        const t = i / 28;
        const wp = T.edgeWorldPoint(d, t);
        wp.y = T.heightAt(wp.x, wp.z) + 0.2;
        const sp = viewer.project(wp);
        if (!sp) {
          previous = null;
          continue;
        }
        if (previous) {
          const dist = pointSegmentDistance(mx, my, previous.x, previous.y, sp.x, sp.y);
          if (dist < threshold && (!best || dist < best.distance)) best = { edgeId, distance: dist };
        }
        previous = sp;
      }
    }

    selectedEdge = best ? best.edgeId : null;
    if (!selectedEdge) toast('没有点中块边，请靠近线条后再点。');
    renderInspector();
    updateOverlay();
    if (selectedEdge) {
      $('edgeInspector').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function orbitCamera(dx, dy) {
    const target = camera.target;
    const o = { x: camera.eye.x - target.x, y: camera.eye.y - target.y, z: camera.eye.z - target.z };
    const radius = Math.max(1, Math.hypot(o.x, o.y, o.z));
    let theta = Math.atan2(o.x, o.z);
    let phi = Math.acos(T.clamp(o.y / radius, -1, 1));
    theta -= dx * 0.0052;
    phi = T.clamp(phi + dy * 0.0048, 0.16, 1.53);
    const sp = Math.sin(phi);
    camera.eye.x = target.x + radius * sp * Math.sin(theta);
    camera.eye.y = target.y + radius * Math.cos(phi);
    camera.eye.z = target.z + radius * sp * Math.cos(theta);
  }

  function zoomCamera(deltaY) {
    const target = camera.target;
    const o = { x: camera.eye.x - target.x, y: camera.eye.y - target.y, z: camera.eye.z - target.z };
    const radius = T.clamp(Math.hypot(o.x, o.y, o.z) * Math.exp(deltaY * 0.0011), 9, 235);
    const old = Math.hypot(o.x, o.y, o.z) || 1;
    camera.eye.x = target.x + (o.x / old) * radius;
    camera.eye.y = target.y + (o.y / old) * radius;
    camera.eye.z = target.z + (o.z / old) * radius;
  }

  function installPointerControls() {
    let down = false;
    let lastX = 0;
    let lastY = 0;
    let startX = 0;
    let startY = 0;
    let moved = false;

    canvas.addEventListener('pointerdown', (e) => {
      if (tour) stopTour();
      down = true;
      moved = false;
      lastX = startX = e.clientX;
      lastY = startY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (Math.hypot(e.clientX - startX, e.clientY - startY) > 6) moved = true;
      if (moved) orbitCamera(dx, dy);
    });

    function end(e) {
      if (!down) return;
      down = false;
      canvas.classList.remove('dragging');
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
      if (!moved) pickEdge(e.clientX, e.clientY);
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => {
      down = false;
      canvas.classList.remove('dragging');
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (tour) stopTour();
      zoomCamera(e.deltaY);
    }, { passive: false });
  }

  function startTour(key) {
    clearOverrides(false);
    settings.freeze = false;
    $('chkFreeze').checked = false;

    const def = T.TOURS[key];
    const first = def.sampleAt(0);
    camera = { eye: first.eye, target: first.target };
    lodStates.clear();
    T.updateLodStates(lodStates, camera.eye, performance.now(), { frozen: false, overrides });
    rebuildAll();
    renderInspector();

    tour = { key, def, start: performance.now() };
    liveTour = { key, peakTriangles: triangleCount(), start: performance.now() };
    toast(`开始播放：${def.name}`);
  }

  function stopTour() {
    if (tour) toast('已停止巡游，镜头保持在当前位置。');
    tour = null;
  }

  function clearOverrides(rebuild = true) {
    for (const k of Object.keys(overrides)) delete overrides[k];
    if (rebuild) {
      lodStates.clear();
      T.updateLodStates(lodStates, camera.eye, performance.now(), { frozen: settings.freeze, overrides });
      rebuildAll();
      renderInspector();
    }
  }

  function locateCorner() {
    // x=-10,z=-50 is the shared corner of chunks 4,4 / 5,4 / 4,5 / 5,5.
    const cornerOverrides = {
      '4,4': 0,
      '5,4': 1,
      '4,5': 2,
      '5,5': 3,
    };
    Object.assign(overrides, cornerOverrides);
    settings.freeze = true;
    $('chkFreeze').checked = true;

    const x = 13;
    const z = -25;
    camera = {
      eye: { x, y: T.heightAt(x, z) + 17, z },
      target: { x: -10, y: T.heightAt(-10, -50) + 1.5, z: -50 },
    };
    T.updateLodStates(lodStates, camera.eye, performance.now(), { frozen: true, overrides });
    rebuildAll();
    selectedEdge = 'v:4:5'; // One of the four edges meeting at that corner.
    renderInspector();
    updateOverlay();
    $('edgeInspector').scrollIntoView({ block: 'nearest' });
    toast('已强制拐角四块为 LOD0/1/2/3；所有共边仍吸附到同一高度。');
  }

  function renderBaseline() {
    $('seedValue').textContent = String(T.SEED);
    $('baselineHashes').innerHTML =
      `诊断点 hash <code>${baseline.pointHash}</code><br>外轮廓采样 hash <code>${baseline.contourHash}</code>`;
    const tbody = $('diagnosticTable').querySelector('tbody');
    tbody.innerHTML = baseline.points.map((p) => `
      <tr>
        <td>${p.id} ${p.name}</td>
        <td>${p.x}, ${p.z}</td>
        <td>${p.y.toFixed(4)}</td>
      </tr>
    `).join('');
  }

  function auditCard(result) {
    if (!result) return '';
    const w = result.worst;
    return `
      <div class="audit-card" data-tour="${result.tourKey}">
        <h3>${result.name}</h3>
        <div class="audit-grid">
          <span class="muted">峰值三角面</span><b data-testid="audit-peak" data-peak-triangles="${result.peakTriangles}">${result.peakTriangles.toLocaleString('zh-CN')}</b>
          <span class="muted">峰值出现位置</span><span>${(result.peakAt * 100).toFixed(0)}%</span>
          <span class="muted">最明显原始接边档差</span>
          <b data-testid="audit-native-error" data-native-mismatch="${w.nativeMismatch.toFixed(6)}" class="${w.nativeMismatch > 0.5 ? 'bad' : 'warn'}">${formatMeters(w.nativeMismatch)}</b>
          <span class="muted">最差边 / 档位</span>
          <span data-testid="audit-worst-edge" data-edge-id="${w.edgeId}" data-lod-a="${w.lodA}" data-lod-b="${w.lodB}">${w.edgeId} · LOD${w.lodA}/LOD${w.lodB}</span>
          <span class="muted">锁边后逼近误差</span><span data-seam-error="${w.seamError.toFixed(6)}">${formatMeters(w.seamError)}</span>
          <span class="muted">审计采样位置</span><span>${(w.tourT * 100).toFixed(0)}%</span>
        </div>
      </div>
    `;
  }

  function updateAuditSummary() {
    const el = $('auditSummary');
    if (!el) return;
    if (!auditResults.cross || !auditResults.edge) {
      el.textContent = '固定镜头审计计算中…';
      return;
    }
    const peak = Math.max(auditResults.cross.peakTriangles, auditResults.edge.peakTriangles);
    const worst = [auditResults.cross.worst, auditResults.edge.worst]
      .sort((a, b) => b.nativeMismatch - a.nativeMismatch)[0];
    el.innerHTML =
      `两镜头峰值 <b>${peak.toLocaleString('zh-CN')}</b> 三角面 · ` +
      `最明显接边档差 <b>${worst.nativeMismatch.toFixed(3)} m</b> ` +
      `(${worst.edgeId}, LOD${worst.lodA}/${worst.lodB})`;
  }

  let auditRunId = 0;
  function runAudits() {
    const runId = ++auditRunId;
    const resolution = settings.resolution;
    const box = $('auditReport');
    box.innerHTML = '<div class="note">正在用同一种子逐采样复核两段固定镜头…</div>';
    auditResults = {};
    updateAuditSummary();

    setTimeout(() => {
      if (runId !== auditRunId) return;
      auditResults.cross = T.auditTour('cross', { resolution, samples: 181 });
      if (runId !== auditRunId) return;
      box.innerHTML = auditCard(auditResults.cross);
      updateAuditSummary();
      setTimeout(() => {
        if (runId !== auditRunId) return;
        auditResults.edge = T.auditTour('edge', { resolution, samples: 181 });
        if (runId !== auditRunId) return;
        box.innerHTML = auditCard(auditResults.cross) + auditCard(auditResults.edge);
        updateAuditSummary();
      }, 40);
    }, 60);
  }

  function installUi() {
    $('btnTourCross').addEventListener('click', () => startTour('cross'));
    $('btnTourEdge').addEventListener('click', () => startTour('edge'));
    $('btnStopTour').addEventListener('click', stopTour);
    $('btnCorner').addEventListener('click', locateCorner);
    $('btnResetCamera').addEventListener('click', () => {
      stopTour();
      camera = makeInitialCamera();
      lodStates.clear();
      T.updateLodStates(lodStates, camera.eye, performance.now(), { frozen: settings.freeze, overrides });
      rebuildAll();
      renderInspector();
    });

    $('chkCrack').addEventListener('change', (e) => {
      settings.crack = e.target.checked;
      updateOverlay();
    });
    $('chkWireframe').addEventListener('change', (e) => {
      settings.wireframe = e.target.checked;
    });
    $('chkFreeze').addEventListener('change', (e) => {
      settings.freeze = e.target.checked;
      toast(settings.freeze ? '自动换档已冻结；移动镜头时各块保持当前档位。' : '已恢复基于镜头距离和迟滞带的自动换档。');
    });
    $('chkSnap').addEventListener('change', (e) => {
      settings.snap = e.target.checked;
      rebuildAll();
      renderInspector();
      if (!settings.snap) toast('边缘锁高已关闭：不同 LOD 的折线会暴露原始裂缝和翘边。');
      else toast('边缘锁高已恢复：细边公共顶点吸附到较粗折线。');
    });

    $('selResolution').addEventListener('change', (e) => {
      settings.resolution = Number(e.target.value);
      rebuildAll();
      renderInspector();
      runAudits();
      toast(`网格分辨率改为 ${settings.resolution}；种子和固定诊断点高度不变。`);
    });

    $('selRenderScale').addEventListener('change', (e) => {
      settings.renderScale = Number(e.target.value);
      if (viewer) viewer.setRenderScale(settings.renderScale);
    });

    $('btnCopyBaseline').addEventListener('click', async () => {
      const text = JSON.stringify(baseline, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        toast('诊断基线 JSON 已复制。');
      } catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        toast('诊断基线 JSON 已复制（兼容模式）。');
      }
    });

    window.addEventListener('resize', () => viewer && viewer.resize());
  }

  let lastStatsUpdate = 0;

  function frame(now) {
    if (tour) {
      const elapsed = now - tour.start;
      const t = Math.min(1, elapsed / tour.def.durationMs);
      const f = tour.def.sampleAt(t);
      camera.eye = f.eye;
      camera.target = f.target;

      const changed = T.updateLodStates(lodStates, camera.eye, now, {
        frozen: settings.freeze,
        overrides,
      });
      if (changed.length) {
        rebuildAffected(changed.map((c) => c.id));
        updateOverlay();
        renderInspector();
      }

      const faces = triangleCount();
      liveTour.peakTriangles = Math.max(liveTour.peakTriangles, faces);
      $('tourLive').innerHTML =
        `正在播放 <b>${(t * 100).toFixed(0)}%</b><br>` +
        `当前三角面 ${Math.round(faces).toLocaleString('zh-CN')} · ` +
        `实测峰值 <b>${Math.round(liveTour.peakTriangles).toLocaleString('zh-CN')}</b>`;

      if (t >= 1) {
        tour = null;
        $('tourLive').innerHTML =
          `播放结束。本次实测峰值 <b>${Math.round(liveTour.peakTriangles).toLocaleString('zh-CN')}</b> 三角面；` +
          `右侧审计卡片给出逐采样峰值与最明显接边误差。`;
      }
    } else {
      const changed = T.updateLodStates(lodStates, camera.eye, now, {
        frozen: settings.freeze,
        overrides,
      });
      if (changed.length) {
        rebuildAffected(changed.map((c) => c.id));
        updateOverlay();
        renderInspector();
      }
    }

    if (viewer) {
      viewer.render(camera, {
        crack: settings.crack,
        wireframe: settings.wireframe,
        lodColorById: lodColorMap(),
      });
    }

    if (now - lastStatsUpdate > 250) {
      updateStats();
      lastStatsUpdate = now;
    }
    requestAnimationFrame(frame);
  }

  function applyInitialQuery() {
    const q = new URLSearchParams(window.location.search);
    if (q.get('crack') === '1') {
      settings.crack = true;
      $('chkCrack').checked = true;
    }
    if (q.get('wireframe') === '1') {
      settings.wireframe = true;
      $('chkWireframe').checked = true;
    }
    if (q.get('freeze') === '1') {
      settings.freeze = true;
      $('chkFreeze').checked = true;
    }
    if (q.get('snap') === '0') {
      settings.snap = false;
      $('chkSnap').checked = false;
    }
    const resolution = Number(q.get('resolution'));
    if (T.RESOLUTIONS.includes(resolution)) {
      settings.resolution = resolution;
      $('selResolution').value = String(resolution);
    }
    const renderScale = Number(q.get('renderScale'));
    if ([0.75, 1, 1.5, 2].includes(renderScale)) {
      settings.renderScale = renderScale;
      $('selRenderScale').value = String(renderScale);
    }
    return q;
  }

  function init() {
    renderBaseline();
    installUi();
    installPointerControls();
    const query = applyInitialQuery();

    T.updateLodStates(lodStates, camera.eye, 0, { frozen: false, overrides });

    try {
      viewer = new TerrainViewer(canvas);
      viewer.setRenderScale(settings.renderScale);
    } catch (err) {
      viewerError = err;
      console.error(err);
      $('liveStats').textContent = 'WebGL 初始化失败：' + err.message + '。纯逻辑审计和诊断仍可用。';
    }

    rebuildAll();
    renderInspector();
    runAudits();

    if (query.get('corner') === '1') {
      locateCorner();
    } else {
      const edge = query.get('edge');
      if (edge && T.allInternalEdges().includes(edge)) {
        selectedEdge = edge;
        renderInspector();
        updateOverlay();
      }
    }
    if (query.get('tour') === 'cross' || query.get('tour') === 'edge') {
      startTour(query.get('tour'));
    }
    const pick = query.get('pick');
    if (pick) {
      const [x, y] = pick.split(',').map(Number);
      setTimeout(() => pickEdge(x, y), 300);
    }
    const pickWorld = query.get('pickworld');
    if (pickWorld && T.allInternalEdges().includes(pickWorld.split('@')[0])) {
      const [edgeId, tText] = pickWorld.split('@');
      const t = tText == null ? 0.5 : Number(tText);
      setTimeout(() => {
        const d = T.edgeDescriptor(edgeId);
        const p = T.edgeWorldPoint(d, Number.isFinite(t) ? t : 0.5);
        p.y = T.heightAt(p.x, p.z) + 0.2;
        const s = viewer.project(p);
        const rect = canvas.getBoundingClientRect();
        if (s) pickEdge(rect.left + s.x, rect.top + s.y);
      }, 300);
    }

    window.__TERRAIN_APP__ = {
      T,
      get camera() { return camera; },
      get settings() { return settings; },
      get overrides() { return overrides; },
      get lodStates() { return lodStates; },
      get selectedEdge() { return selectedEdge; },
      triangleCount,
      pickEdge: (x, y) => pickEdge(x, y),
      selectEdge: (id) => { selectedEdge = id; renderInspector(); updateOverlay(); },
      startTour,
      locateCorner,
      auditResults: () => auditResults,
    };
    window.app = window.__TERRAIN_APP__;

    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
