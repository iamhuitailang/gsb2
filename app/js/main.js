/* main.js — 场景、交互与界面逻辑。 */
"use strict";

(function () {
  const $ = id => document.getElementById(id);

  /* ---------- 全局状态 ---------- */
  const state = {
    clouds: { A: null, B: null },   // PointCloud
    active: "A",
    viewMode: "overlay",            // overlay | side
    pointBudget: 500000,
    selection: null,                // { cloud: 'A'|'B', indices: Uint32Array }
    pendingFilter: null,            // { cloud: 'A'|'B', keep: Uint8Array, label: string }
  };

  /* ---------- Three.js 场景 ---------- */
  const canvas = $("canvas");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10000);
  camera.position.set(3, 3, 5);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;

  scene.add(new THREE.AxesHelper(0.5));
  const gridHelper = new THREE.GridHelper(10, 20, 0x333944, 0x22262c);
  scene.add(gridHelper);

  // 每个云两层 Group：viewGroup 负责并排显示的视觉偏移，cloudGroup 承载用户变换
  const viewGroups = {}, cloudGroups = {}, pointsObjs = {};
  for (const key of ["A", "B"]) {
    viewGroups[key] = new THREE.Group();
    cloudGroups[key] = new THREE.Group();
    viewGroups[key].add(cloudGroups[key]);
    scene.add(viewGroups[key]);
    pointsObjs[key] = null;
  }
  // 选择高亮（世界坐标）
  let highlightObj = null;

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
  }
  window.addEventListener("resize", resize);

  function animate() {
    requestAnimationFrame(animate);
    resize();
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  /* ---------- 渲染（大点云按预算抽稀预览） ---------- */
  function renderCloud(key) {
    const cloud = state.clouds[key];
    if (pointsObjs[key]) {
      cloudGroups[key].remove(pointsObjs[key]);
      pointsObjs[key].geometry.dispose();
      pointsObjs[key].material.dispose();
      pointsObjs[key] = null;
    }
    if (!cloud) { updateRenderInfo(); return; }

    const n = cloud.count;
    const stride = Math.max(1, Math.ceil(n / state.pointBudget));
    const m = Math.ceil(n / stride);
    const pos = new Float32Array(m * 3);
    const col = new Float32Array(m * 3);
    const hasColor = !!cloud.colors;
    let j = 0;
    for (let i = 0; i < n; i += stride) {
      pos[j * 3] = cloud.positions[i * 3];
      pos[j * 3 + 1] = cloud.positions[i * 3 + 1];
      pos[j * 3 + 2] = cloud.positions[i * 3 + 2];
      if (hasColor) {
        col[j * 3] = cloud.colors[i * 3] / 255;
        col[j * 3 + 1] = cloud.colors[i * 3 + 1] / 255;
        col[j * 3 + 2] = cloud.colors[i * 3 + 2] / 255;
      } else {
        const c = key === "A" ? [0.45, 0.75, 1.0] : [1.0, 0.65, 0.4];
        col[j * 3] = c[0]; col[j * 3 + 1] = c[1]; col[j * 3 + 2] = c[2];
      }
      j++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: parseFloat($("pointSize").value) * 0.01,
      vertexColors: true, sizeAttenuation: true
    });
    pointsObjs[key] = new THREE.Points(geo, mat);
    pointsObjs[key].userData.rendered = m;
    cloudGroups[key].add(pointsObjs[key]);
    updateRenderInfo();
  }

  function updateRenderInfo() {
    const parts = [];
    for (const key of ["A", "B"]) {
      const c = state.clouds[key];
      if (!c) continue;
      const r = pointsObjs[key] ? pointsObjs[key].userData.rendered : 0;
      parts.push(`${key}: 渲染 ${r.toLocaleString()} / ${c.count.toLocaleString()} 点`);
    }
    $("renderInfo").textContent = parts.join("　");
  }

  function applyTransforms() {
    for (const key of ["A", "B"]) {
      const c = state.clouds[key];
      if (!c) continue;
      const m = PCAlign.transformToMatrix(c.transform);
      m.decompose(cloudGroups[key].position, cloudGroups[key].quaternion, cloudGroups[key].scale);
    }
    updateMatrixView();
    scheduleRmsUpdate();
  }

  function applyViewMode() {
    const side = state.viewMode === "side";
    let off = 2;
    const bbA = state.clouds.A && state.clouds.A.bbox();
    const bbB = state.clouds.B && state.clouds.B.bbox();
    const diag = b => b ? Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) : 0;
    off = Math.max(diag(bbA), diag(bbB), 1) * 0.75;
    viewGroups.A.position.set(side ? -off : 0, 0, 0);
    viewGroups.B.position.set(side ? off : 0, 0, 0);
  }

  /* ---------- 信息面板 ---------- */
  function setStatus(msg) { $("statusbar").textContent = msg; }

  function updateCloudInfo() {
    for (const key of ["A", "B"]) {
      const c = state.clouds[key];
      $("cloudInfo" + key).textContent = c
        ? `${key}: ${c.name} — ${c.count.toLocaleString()} 点${c.colors ? "（含颜色）" : ""}`
        : `${key}: 未载入`;
    }
    const c = state.clouds[state.active];
    $("undoInfo").textContent = c && c.undoStack.length
      ? `可撤销 ${c.undoStack.length} 步` : "";
  }

  function updateMatrixView() {
    const c = state.clouds[state.active];
    if (!c) { $("matrixView").textContent = "—"; return; }
    const m = PCAlign.transformToMatrix(c.transform).elements;
    // 列主序 → 按行显示
    let s = "";
    for (let r = 0; r < 4; r++) {
      const row = [];
      for (let col = 0; col < 4; col++) row.push(m[col * 4 + r].toFixed(4).padStart(9));
      s += row.join(" ") + "\n";
    }
    $("matrixView").textContent = s;
  }

  function syncTransformInputs() {
    const c = state.clouds[state.active];
    const t = c ? c.transform : { position: [0, 0, 0], rotationDeg: [0, 0, 0] };
    $("tx").value = t.position[0]; $("ty").value = t.position[1]; $("tz").value = t.position[2];
    $("rx").value = t.rotationDeg[0]; $("ry").value = t.rotationDeg[1]; $("rz").value = t.rotationDeg[2];
  }

  /* ---------- 配准误差 ---------- */
  let rmsTimer = null;
  function scheduleRmsUpdate() {
    clearTimeout(rmsTimer);
    rmsTimer = setTimeout(updateRms, 250);
  }

  function overlapMaxDist() {
    const c = state.clouds.A || state.clouds.B;
    if (!c) return 1;
    const bb = c.bbox();
    if (!bb) return 1;
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
    return Math.max(diag / 5, 1e-6);
  }

  function updateRms() {
    const A = state.clouds.A, B = state.clouds.B;
    if (!A || !B) { $("rmsView").textContent = "配准误差: —（需载入两份扫描）"; return; }
    const srcW = PCAlign.transformPoints(A.positions, PCAlign.transformToMatrix(A.transform));
    const dstW = PCAlign.transformPoints(B.positions, PCAlign.transformToMatrix(B.transform));
    const err = PCAlign.registrationError(srcW, dstW, overlapMaxDist(), 3000, 0.7);
    $("rmsView").textContent = err && err.rms !== null
      ? `配准误差 (A→B 最近邻，最近 70% 配对): RMS = ${err.rms.toFixed(5)}，配对 ${err.pairs} 点`
      : "配准误差: 重叠区域内无配对点";
  }

  /* ---------- 文件载入 ---------- */
  function loadFile(input, key) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const res = PCIO.parsePointText(reader.result);
      if (res.positions.length === 0) {
        setStatus(`${file.name}: 没有解析到有效点`);
        return;
      }
      state.clouds[key] = new PointCloud(file.name, res.positions, res.colors);
      clearSelection();
      renderCloud(key);
      applyTransforms();
      applyViewMode();
      updateCloudInfo();
      syncTransformInputs();
      frameCloud(key);
      if (res.badLines.length) {
        const shown = res.badLines.slice(0, 20).join(", ");
        const more = res.badLines.length > 20 ? ` …共 ${res.badLines.length} 行` : "";
        $("badLines").textContent =
          `${file.name}: 跳过 ${res.badLines.length} 个坏行，行号: ${shown}${more}`;
      } else {
        $("badLines").textContent = "";
      }
      setStatus(`已载入 ${file.name}（${(res.positions.length / 3).toLocaleString()} 点）`);
    };
    reader.readAsText(file);
  }

  $("loadA").onclick = () => $("fileA").click();
  $("loadB").onclick = () => $("fileB").click();
  $("fileA").onchange = e => loadFile(e.target, "A");
  $("fileB").onchange = e => loadFile(e.target, "B");

  function frameCloud(key) {
    const c = state.clouds[key];
    if (!c) return;
    const bb = c.bbox();
    if (!bb) return;
    const center = [
      (bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) || 1;
    const world = new THREE.Vector3(...center);
    scene.updateMatrixWorld(true);
    cloudGroups[key].localToWorld(world);
    controls.target.copy(world);
    camera.position.copy(world).add(new THREE.Vector3(diag, diag * 0.7, diag));
    camera.near = diag / 1000; camera.far = diag * 100;
    camera.updateProjectionMatrix();
  }

  /* ---------- 视图控件 ---------- */
  $("activeCloud").onchange = e => { state.active = e.target.value; syncTransformInputs(); updateMatrixView(); updateCloudInfo(); };
  $("viewMode").onchange = e => { state.viewMode = e.target.value; clearSelection(); applyViewMode(); };
  $("pointBudget").onchange = e => {
    state.pointBudget = parseInt(e.target.value, 10);
    renderCloud("A"); renderCloud("B");
  };
  $("pointSize").oninput = () => {
    for (const key of ["A", "B"])
      if (pointsObjs[key])
        pointsObjs[key].material.size = parseFloat($("pointSize").value) * 0.01;
  };

  /* ---------- 变换控件 ---------- */
  for (const id of ["tx", "ty", "tz", "rx", "ry", "rz"]) {
    $(id).onchange = () => {
      const c = state.clouds[state.active];
      if (!c) return;
      c.transform.position = [+$("tx").value, +$("ty").value, +$("tz").value];
      c.transform.rotationDeg = [+$("rx").value, +$("ry").value, +$("rz").value];
      applyTransforms();
    };
  }
  $("resetTransform").onclick = () => {
    const c = state.clouds[state.active];
    if (!c) return;
    c.transform = { position: [0, 0, 0], rotationDeg: [0, 0, 0] };
    syncTransformInputs();
    applyTransforms();
  };

  $("runIcp").onclick = () => {
    const srcKey = state.active, dstKey = srcKey === "A" ? "B" : "A";
    const src = state.clouds[srcKey], dst = state.clouds[dstKey];
    if (!src || !dst) { $("icpStatus").textContent = "需先载入两份扫描"; return; }
    $("icpStatus").textContent = "计算中（PCA 粗对齐 + ICP 精化）…";
    setTimeout(() => {
      const t0 = performance.now();
      const res = PCAlign.autoAlign(src.positions, dst.positions,
        { maxIter: 40, maxDist: overlapMaxDist() });
      if (!res) { $("icpStatus").textContent = "失败：重叠区对应点太少"; return; }
      src.transform = PCAlign.matrixToTransform(res.matrix);
      src.ops.push(`自动配准 ${srcKey}→${dstKey}（${res.iterations} 次迭代，RMS=${
        res.rms === null ? "—" : res.rms.toFixed(6)}）`);
      syncTransformInputs();
      applyTransforms();
      $("icpStatus").textContent =
        `完成：${srcKey}→${dstKey}，RMS=${res.rms === null ? "—" : res.rms.toFixed(5)}，耗时 ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    }, 30);
  };

  /* ---------- 框选 ---------- */
  const selectBox = $("selectBox");
  let selStart = null;

  window.addEventListener("keydown", e => { if (e.key === "Shift") controls.enabled = false; });
  window.addEventListener("keyup", e => { if (e.key === "Shift") controls.enabled = true; });

  canvas.addEventListener("pointerdown", e => {
    if (!e.shiftKey) return;
    const r = canvas.getBoundingClientRect();
    selStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    selectBox.hidden = false;
    positionSelectBox(selStart, selStart);
  });
  window.addEventListener("pointermove", e => {
    if (!selStart) return;
    const r = canvas.getBoundingClientRect();
    positionSelectBox(selStart, { x: e.clientX - r.left, y: e.clientY - r.top });
  });
  window.addEventListener("pointerup", e => {
    if (!selStart) return;
    const r = canvas.getBoundingClientRect();
    const end = { x: e.clientX - r.left, y: e.clientY - r.top };
    selectBox.hidden = true;
    const rect = normalizeRect(selStart, end);
    selStart = null;
    controls.enabled = true;
    if (rect.w > 4 && rect.h > 4) performSelection(rect, r);
  });

  function positionSelectBox(a, b) {
    const rc = normalizeRect(a, b);
    Object.assign(selectBox.style, { left: rc.x + "px", top: rc.y + "px", width: rc.w + "px", height: rc.h + "px" });
  }
  function normalizeRect(a, b) {
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  }

  function performSelection(rect, canvasRect) {
    const key = state.active;
    const c = state.clouds[key];
    if (!c) return;
    const world = PCAlign.transformPoints(c.positions, PCAlign.transformToMatrix(c.transform));
    // 并排模式需叠加视觉偏移
    const vg = viewGroups[key].position;
    const n = c.count;
    const idx = [];
    const v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      v.set(world[i * 3] + vg.x, world[i * 3 + 1] + vg.y, world[i * 3 + 2] + vg.z).project(camera);
      if (v.z < -1 || v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * canvasRect.width;
      const sy = (1 - (v.y * 0.5 + 0.5)) * canvasRect.height;
      if (sx >= rect.x && sx <= rect.x + rect.w && sy >= rect.y && sy <= rect.y + rect.h) idx.push(i);
    }
    state.selection = { cloud: key, indices: Uint32Array.from(idx) };
    showHighlight(key, world);
    $("selectInfo").textContent = `已选择 ${idx.length.toLocaleString()} 点（${key}）`;
  }

  function showHighlight(key, worldPositions) {
    clearHighlight();
    const sel = state.selection;
    if (!sel || sel.indices.length === 0) return;
    const m = sel.indices.length;
    const pos = new Float32Array(m * 3);
    const vg = viewGroups[key].position;
    for (let j = 0; j < m; j++) {
      const i = sel.indices[j];
      pos[j * 3] = worldPositions[i * 3] + vg.x;
      pos[j * 3 + 1] = worldPositions[i * 3 + 1] + vg.y;
      pos[j * 3 + 2] = worldPositions[i * 3 + 2] + vg.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    highlightObj = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffd54f, size: parseFloat($("pointSize").value) * 0.014, sizeAttenuation: true }));
    scene.add(highlightObj);
  }

  function clearHighlight() {
    if (highlightObj) {
      scene.remove(highlightObj);
      highlightObj.geometry.dispose();
      highlightObj.material.dispose();
      highlightObj = null;
    }
  }

  function clearSelection() {
    state.selection = null;
    clearHighlight();
    $("selectInfo").textContent = "未选择";
  }
  $("clearSel").onclick = clearSelection;

  /** 把框选结果转为局部坐标掩码并裁剪。 */
  function cropBySelection(keepInside) {
    const sel = state.selection;
    if (!sel || sel.indices.length === 0) { setStatus("请先用 Shift+拖动 框选"); return; }
    const c = state.clouds[sel.cloud];
    const keep = new Uint8Array(c.count);
    if (!keepInside) keep.fill(1);
    for (const i of sel.indices) keep[i] = keepInside ? 1 : 0;
    const label = keepInside ? "框选保留" : "框选删除";
    c.applyMask(keep, label);
    clearSelection();
    renderCloud(sel.cloud);
    updateCloudInfo();
    scheduleRmsUpdate();
    setStatus(`${label}完成，${c.name} 现有 ${c.count.toLocaleString()} 点（可撤销）`);
  }
  $("cropKeep").onclick = () => cropBySelection(true);
  $("cropRemove").onclick = () => cropBySelection(false);

  /* ---------- 滤波 / 采样（先预览数量，再应用） ---------- */
  function setPendingFilter(cloudKey, keep, label) {
    const n = keep.length;
    let m = 0;
    for (let i = 0; i < n; i++) m += keep[i];
    state.pendingFilter = { cloud: cloudKey, keep, label };
    $("filterInfo").textContent =
      `${label}：将保留 ${m.toLocaleString()} / ${n.toLocaleString()} 点（删除 ${(n - m).toLocaleString()}）`;
    $("applyFilter").disabled = false;
    $("cancelFilter").disabled = false;
  }

  $("previewOutlier").onclick = () => {
    const key = state.active, c = state.clouds[key];
    if (!c) { setStatus("请先载入点云"); return; }
    const k = Math.max(2, +$("outK").value || 8);
    const std = Math.max(0.1, +$("outStd").value || 2);
    setStatus("正在计算离群点…");
    setTimeout(() => {
      const keep = c.outlierMask(k, std);
      setPendingFilter(key, keep, `离群点筛除 (k=${k}, σ×${std})`);
      setStatus("离群点预览完成，确认后应用");
    }, 30);
  };

  $("previewDownsample").onclick = () => {
    const key = state.active, c = state.clouds[key];
    if (!c) { setStatus("请先载入点云"); return; }
    const voxel = +$("voxelSize").value || 0;
    const ratio = Math.min(1, Math.max(0.01, +$("sampleRatio").value || 1));
    if (voxel <= 0 && ratio >= 1) { setStatus("请设置体素边长或保留比"); return; }
    let keep = null, label = "";
    if (voxel > 0) { keep = c.voxelMask(voxel); label = `体素采样 (边长=${voxel})`; }
    if (ratio < 1) {
      const rmask = c.randomMask(ratio);
      if (keep) {
        for (let i = 0; i < keep.length; i++) keep[i] = keep[i] && rmask[i] ? 1 : 0;
        label += ` + 随机保留 ${ratio}`;
      } else {
        keep = rmask; label = `随机采样 (保留比=${ratio})`;
      }
    }
    setPendingFilter(key, keep, label);
    setStatus("采样预览完成，确认后应用");
  };

  $("applyFilter").onclick = () => {
    const pf = state.pendingFilter;
    if (!pf) return;
    const c = state.clouds[pf.cloud];
    c.applyMask(pf.keep, pf.label);
    state.pendingFilter = null;
    $("filterInfo").textContent = "";
    $("applyFilter").disabled = true;
    $("cancelFilter").disabled = true;
    clearSelection();
    renderCloud(pf.cloud);
    updateCloudInfo();
    scheduleRmsUpdate();
    setStatus(`已应用：${pf.label}，现有 ${c.count.toLocaleString()} 点（可撤销）`);
  };

  $("cancelFilter").onclick = () => {
    state.pendingFilter = null;
    $("filterInfo").textContent = "已取消预览";
    $("applyFilter").disabled = true;
    $("cancelFilter").disabled = true;
  };

  $("undo").onclick = () => {
    const key = state.active, c = state.clouds[key];
    if (!c) return;
    const label = c.undo();
    if (label === null) { setStatus("没有可撤销的操作"); return; }
    clearSelection();
    renderCloud(key);
    updateCloudInfo();
    scheduleRmsUpdate();
    setStatus(`已撤销「${label}」，恢复到 ${c.count.toLocaleString()} 点`);
  };

  /* ---------- 项目保存 / 载入 / 导出 ---------- */
  $("saveProject").onclick = () => {
    const proj = {
      app: "point-cloud-inspector",
      version: 1,
      savedAt: new Date().toISOString(),
      viewMode: state.viewMode,
      clouds: {}
    };
    for (const key of ["A", "B"]) {
      const c = state.clouds[key];
      if (!c) continue;
      proj.clouds[key] = {
        file: c.name,
        pointCount: c.count,
        transform: c.transform,
        operations: c.ops
      };
    }
    PCIO.download("project.pcproj.json", JSON.stringify(proj, null, 2), "application/json");
    setStatus("项目已保存（仅含变换与操作记录，不含点数据本身）");
  };

  $("loadProject").onclick = () => $("projectFile").click();
  $("projectFile").onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let proj;
      try { proj = JSON.parse(reader.result); }
      catch { setStatus("项目文件解析失败"); return; }
      if (proj.viewMode) { state.viewMode = proj.viewMode; $("viewMode").value = proj.viewMode; applyViewMode(); }
      const notes = [];
      for (const key of ["A", "B"]) {
        const pc = proj.clouds && proj.clouds[key];
        const c = state.clouds[key];
        if (pc && c) {
          c.transform = {
            position: pc.transform.position.slice(),
            rotationDeg: pc.transform.rotationDeg.slice()
          };
          notes.push(`${key}: 已恢复变换（文件 ${pc.file}，保存时 ${pc.pointCount} 点）`);
        } else if (pc) {
          notes.push(`${key}: 项目记录的文件 ${pc.file} 尚未载入，请先载入同名数据`);
        }
      }
      syncTransformInputs();
      applyTransforms();
      setStatus("项目已载入。" + notes.join("；"));
    };
    reader.readAsText(file);
  };

  function exportCloud(key) {
    const c = state.clouds[key];
    if (!c) { setStatus(`扫描 ${key} 未载入`); return; }
    const m = PCAlign.transformToMatrix(c.transform);
    const text = PCIO.exportPointText(c.positions, c.colors, m);
    const base = c.name.replace(/\.[^.]+$/, "");
    PCIO.download(`${base}.processed.xyz`, text);
    setStatus(`已导出 ${key}（含当前变换，共 ${c.count.toLocaleString()} 点）`);
  }
  $("exportA").onclick = () => exportCloud("A");
  $("exportB").onclick = () => exportCloud("B");

  $("exportNotes").onclick = () => {
    const lines = ["# 点云处理项目说明", "", `生成时间: ${new Date().toLocaleString()}`, ""];
    lines.push(`视图模式: ${state.viewMode === "side" ? "并排" : "叠加"}`, "");
    for (const key of ["A", "B"]) {
      const c = state.clouds[key];
      if (!c) continue;
      const t = c.transform;
      lines.push(`## 扫描 ${key}: ${c.name}`, "");
      lines.push(`- 当前点数: ${c.count.toLocaleString()}`);
      lines.push(`- 含颜色: ${c.colors ? "是" : "否"}`);
      lines.push(`- 平移: [${t.position.map(v => v.toFixed(4)).join(", ")}]`);
      lines.push(`- 旋转(度, XYZ): [${t.rotationDeg.map(v => v.toFixed(2)).join(", ")}]`);
      const bb = c.bbox();
      if (bb) lines.push(`- 包围盒: [${bb.min.map(v => v.toFixed(3))}] ~ [${bb.max.map(v => v.toFixed(3))}]`);
      if (c.ops.length) {
        lines.push("- 操作记录:");
        for (const op of c.ops) lines.push(`  - ${op}`);
      }
      lines.push("");
    }
    lines.push("## 配准误差", "", $("rmsView").textContent, "");
    PCIO.download("project-notes.md", lines.join("\n"), "text/markdown;charset=utf-8");
    setStatus("项目说明已导出");
  };

  /* ---------- 初始化 ---------- */
  updateCloudInfo();
  syncTransformInputs();
  applyViewMode();
})();
