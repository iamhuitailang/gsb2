/* 主控制器：状态管理、编辑、细度对比、工程保存/载入、网格导出、诊断面板 */
(function (root) {
  'use strict';

  const FINENESS = {
    coarse: { label: '粗', arcLengthStep: 8, minStep: 1.0, maxTurnAngleDeg: 8 },
    fine: { label: '细', arcLengthStep: 1.5, minStep: 0.25, maxTurnAngleDeg: 2.5 },
  };

  const state = {
    controlPoints: [],
    closed: true,
    spans: [],
    selected: 0,
    fineness: 'fine',
    flags: { showGrid: true, showCenter: true, showShL: true, showShR: true },
    analysis: null,
    folded: false,
  };

  const $ = (id) => document.getElementById(id);

  function deepCopyPts(pts) { return pts.map((p) => p.slice()); }

  function init() {
    // 载入演示路线
    state.controlPoints = deepCopyPts(root.RoadDemo.controlPoints);
    state.closed = true;
    state.spans = root.RoadDemo.makeSpans();
    state.selected = 0;

    root.view3d = new root.RoadView3D($('view3d'));
    root.topView = new root.RoadTopView($('topCanvas'), {
      onSelect: (i) => selectPoint(i),
      onDrag: (i, p) => dragPoint(i, p),
      onAddAt: (w) => addPointAt(w),
    });

    bindUI();
    selectPoint(0);
    rebuild(true);
  }

  function bindUI() {
    $('closed').addEventListener('change', (e) => {
      state.closed = e.target.checked;
      syncSpanCount();
      rebuild(true);
    });

    $('addPoint').addEventListener('click', () => appendPoint());
    $('delPoint').addEventListener('click', () => deleteSelected());

    ['showGrid', 'showCenter', 'showShL', 'showShR'].forEach((k) => {
      $(k).addEventListener('change', (e) => { state.flags[k] = e.target.checked; refreshViews(); });
    });

    document.querySelectorAll('input[name=fineness]').forEach((r) => {
      r.addEventListener('change', () => { state.fineness = r.value; rebuild(false); });
    });

    ['pWidth', 'pHeight', 'pCross'].forEach((id) => {
      $(id).addEventListener('input', () => applyParamEdits());
    });

    $('foldBtn').addEventListener('click', applyFold);
    $('resetBtn').addEventListener('click', resetNormal);

    $('saveBtn').addEventListener('click', saveProject);
    $('loadBtn').addEventListener('click', () => $('loadFile').click());
    $('loadFile').addEventListener('change', loadProject);
    $('exportObj').addEventListener('click', exportOBJ);
    $('exportMeta').addEventListener('click', exportMeta);
  }

  /* ---------------- 控制点编辑 ---------------- */

  function selectPoint(i) {
    state.selected = i;
    root.topView && root.topView.setSelected(i);
    syncParamPanel();
  }

  function dragPoint(i, p) {
    state.controlPoints[i] = p;
    rebuild(false);
  }

  function appendPoint() {
    const n = state.controlPoints.length;
    const a = state.controlPoints[n - 1];
    const b = state.controlPoints[n - 2] || [a[0] - 10, a[1], a[2]];
    const np = [a[0] + (a[0] - b[0]) * 0.4, a[1] + (a[1] - b[1]) * 0.4, a[2]];
    state.controlPoints.push(np);
    state.spans.push(root.RoadMesh.defaultSpanParams());
    selectPoint(n);
    rebuild(true);
  }

  function addPointAt(w) {
    // 在选中点之后插入，高程取相邻均值
    const i = state.selected >= 0 ? state.selected + 1 : state.controlPoints.length;
    const prev = state.controlPoints[Math.max(0, i - 1)];
    const next = state.controlPoints[Math.min(state.controlPoints.length - 1, i)] || prev;
    const np = [w[0], w[1], (prev[2] + next[2]) / 2];
    state.controlPoints.splice(i, 0, np);
    state.spans.splice(i, 0, root.RoadMesh.defaultSpanParams());
    selectPoint(i);
    rebuild(true);
  }

  function deleteSelected() {
    if (state.controlPoints.length <= 3) return;
    const i = state.selected;
    state.controlPoints.splice(i, 1);
    state.spans.splice(i, 1);
    selectPoint(Math.max(0, i - 1));
    rebuild(true);
  }

  /** 开口/闭合切换后保证段数 = 闭合? n : n-1 */
  function syncSpanCount() {
    const target = state.closed ? state.controlPoints.length : state.controlPoints.length - 1;
    while (state.spans.length < target) state.spans.push(root.RoadMesh.defaultSpanParams());
    if (state.spans.length > target) state.spans.length = target;
    if (state.selected >= target) state.selected = target - 1;
  }

  /* ---------------- 段参数 ---------------- */

  function syncParamPanel() {
    const i = state.selected;
    if (i < 0 || !state.spans[i]) return;
    const sp = state.spans[i];
    $('selLabel').textContent = `P${i} → P${(i + 1) % state.controlPoints.length}（段 ${i}）`;
    $('pWidth').value = sp.width; $('pWidthV').textContent = sp.width.toFixed(1);
    $('pHeight').value = sp.height; $('pHeightV').textContent = sp.height.toFixed(1);
    $('pCross').value = sp.crossfall; $('pCrossV').textContent = sp.crossfall.toFixed(1);
  }

  function applyParamEdits() {
    const i = state.selected;
    if (i < 0 || !state.spans[i]) return;
    const sp = state.spans[i];
    sp.width = parseFloat($('pWidth').value);
    sp.height = parseFloat($('pHeight').value);
    sp.crossfall = parseFloat($('pCross').value);
    $('pWidthV').textContent = sp.width.toFixed(1);
    $('pHeightV').textContent = sp.height.toFixed(1);
    $('pCrossV').textContent = sp.crossfall.toFixed(1);
    rebuild(false);
  }

  function applyFold() {
    root.RoadDemo.foldSpans.forEach((i) => {
      if (state.spans[i]) state.spans[i].width = 30;
    });
    state.folded = true;
    syncParamPanel();
    rebuild(true);
  }

  function resetNormal() {
    state.spans = root.RoadDemo.makeSpans();
    state.controlPoints = deepCopyPts(root.RoadDemo.controlPoints);
    state.closed = true;
    $('closed').checked = true;
    state.folded = false;
    selectPoint(0);
    rebuild(true);
  }

  /* ---------------- 重建与渲染 ---------------- */

  function meshOptions() {
    const f = FINENESS[state.fineness];
    return {
      arcLengthStep: f.arcLengthStep,
      minStep: f.minStep,
      maxTurnAngleDeg: f.maxTurnAngleDeg,
      crossDivs: 4,
      shoulderWidth: 1.2,
      includeShoulders: true,
    };
  }

  function rebuild(reframe) {
    if (state.controlPoints.length < 3) return;
    const opts = meshOptions();
    state.analysis = root.RoadMesh.analyze(state.controlPoints, state.closed, state.spans, opts);
    refreshViews();
    updateDiagnostics();
    updateFineStats();
    if (reframe) root.view3d.frameAll(state.analysis.road);
  }

  function refreshViews() {
    if (!state.analysis) return;
    root.view3d.update(state.analysis.road, state.flags, state.analysis.issues);
    root.topView.setData(
      state.controlPoints, state.closed, state.analysis.road,
      state.analysis.issues, state.selected
    );
    $('stats3d').textContent =
      `里程 ${state.analysis.road.spline.totalLength.toFixed(1)} m · ` +
      `${state.analysis.road.rings.length} 环 · ${state.analysis.road.indices.length / 3 | 0} 三角面`;
  }

  function updateFineStats() {
    // 同时计算两种细度用于对比
    const opts = meshOptions();
    const lines = [];
    Object.entries(FINENESS).forEach(([key, f]) => {
      const o = Object.assign({}, opts, {
        arcLengthStep: f.arcLengthStep, minStep: f.minStep, maxTurnAngleDeg: f.maxTurnAngleDeg,
      });
      const road = root.RoadMesh.buildRoad(state.controlPoints, state.closed, state.spans, o);
      const active = key === state.fineness ? '◉' : '○';
      lines.push(
        `${active} ${f.label}：步长 ${f.arcLengthStep}m｜环 ${road.rings.length}｜` +
        `三角面 ${road.indices.length / 3 | 0}｜顶点 ${road.vertices.length}`
      );
    });
    $('fineStats').innerHTML = lines.join('<br>');
  }

  function updateDiagnostics() {
    const { issues, seam } = state.analysis;
    const seamBox = $('seamBox');
    if (!seam) {
      seamBox.className = 'seam none';
      seamBox.textContent = '开口路线：无闭合接缝';
    } else {
      seamBox.className = 'seam ' + (seam.ok ? 'ok' : 'bad');
      seamBox.textContent = seam.message;
    }

    const list = $('issueList');
    list.innerHTML = '';
    if (!issues.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '✓ 未检测到自交或折叠';
      list.appendChild(li);
      $('topHint').textContent = '';
      return;
    }
    const rank = { 'inner-edge-fold': 'error', 'surface-self-intersection': 'error',
      'centerline-crossing': 'error', 'overslope': 'error', 'radius-warning': 'warning' };
    issues.forEach((iss) => {
      const li = document.createElement('li');
      li.className = rank[iss.type] || 'info';
      const where = iss.station !== undefined
        ? `里程 ${iss.station} m`
        : `里程 ${iss.stationA} / ${iss.stationB} m`;
      li.innerHTML = `${iss.message}<span class="meta">${iss.type} · ${where}</span>`;
      list.appendChild(li);
    });
    const errs = issues.filter((i) => (rank[i.type] === 'error')).length;
    $('topHint').textContent = errs ? `⚠ ${errs} 处需处理（红色标记）` : '';
  }

  /* ---------------- 工程保存 / 载入 ---------------- */

  function projectJSON() {
    return JSON.stringify({
      format: 'road-tool-project/1',
      closed: state.closed,
      fineness: state.fineness,
      controlPoints: state.controlPoints,
      spans: state.spans,
    }, null, 2);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function saveProject() { download('road-project.json', projectJSON(), 'application/json'); }

  function loadProject(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.controlPoints) || !Array.isArray(data.spans)) throw new Error('格式不符');
        state.controlPoints = deepCopyPts(data.controlPoints);
        state.spans = data.spans.map((s) => ({
          width: s.width, height: s.height, crossfall: s.crossfall,
        }));
        state.closed = !!data.closed;
        $('closed').checked = state.closed;
        if (data.fineness && FINENESS[data.fineness]) {
          state.fineness = data.fineness;
          document.querySelector(`input[name=fineness][value=${data.fineness}]`).checked = true;
        }
        syncSpanCount();
        selectPoint(0);
        rebuild(true);
      } catch (err) {
        alert('工程载入失败：' + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  /* ---------------- 网格导出 ---------------- */

  function exportOBJ() {
    const road = state.analysis.road;
    download('road-mesh.obj', root.RoadMesh.toOBJ(road), 'text/plain');
  }

  function exportMeta() {
    const road = state.analysis.road;
    const meta = root.RoadMesh.exportMeta(road, state.controlPoints, state.closed);
    download('road-meta.json', JSON.stringify(meta, null, 2), 'application/json');
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
