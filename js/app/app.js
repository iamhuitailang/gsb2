/*
 * app.js — UI 总装: 文件导入、变换面板、框选裁剪、筛选、双扫描对比、保存导出
 * 所有重活都在 js/pc/* 的纯逻辑模块中,本文件只负责 DOM 与 THREE 渲染衔接。
 */
(function () {
  'use strict';

  const store = new PCState.ScanStore();
  const viewportEl = document.getElementById('viewport');
  const viewer = new PCViewer(viewportEl);
  const COLOR_CYCLE = [0x7fb3e8, 0xe8a87f, 0x8fe0a8, 0xd98fe0, 0xe0d98f];

  const $ = function (id) { return document.getElementById(id); };
  const statusEl = $('statusText');
  let layout = 'overlay';
  let selecting = false;
  let dragStart = null;       // {x,y}
  let currentSelection = null; // Set<原始索引>
  let currentBox = null;      // {min,max} 世界坐标 AABB
  let previewState = null;    // {kind, scanId, indices} 预览态(尚未应用)
  let lastRegistration = null;
  let pendingProject = null;  // 工程恢复流程: 等待源文件载入
  const projectLoaders = {};
  let busy = false;           // 重计算进行中,防止重复触发

  function setStatus(msg) { statusEl.textContent = msg; }

  function fmt(v) {
    if (v === null || v === undefined) return '—';
    if (Math.abs(v) >= 1e6 || (Math.abs(v) > 0 && Math.abs(v) < 1e-4)) return v.toExponential(4);
    return (Math.round(v * 1e5) / 1e5).toString();
  }

  // ---------- 导入 ----------
  $('fileInput').addEventListener('change', function (e) {
    const files = Array.from(e.target.files || []);
    if (pendingProject) {
      files.forEach(loadProjectSource);
    } else {
      // 顺序读取,保证多文件按选择顺序进入扫描列表(FileReader 回调不保证顺序)
      loadFilesInOrder(files);
    }
    e.target.value = '';
  });

  async function loadFilesInOrder(files) {
    for (const file of files) {
      // eslint-disable-next-line no-await-in-loop
      await loadFile(file);
    }
  }

  function loadFile(file) {
    if (file.name.toLowerCase().endsWith('.json')) {
      loadProjectFile(file);
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      const reader = new FileReader();
      reader.onload = function () {
        const parsed = PCParser.parse(reader.result, file.name);
        if (!parsed.points.length) {
          setStatus('导入失败: ' + file.name + ' 无有效点');
          alert('文件 ' + file.name + ' 没有解析出任何有效点,请查看格式说明(README)。');
          resolve();
          return;
        }
        parsed.fileName = file.name;
        const baseName = file.name.replace(/\.[^.]+$/, '');
        const scan = store.add(parsed, baseName);
        viewer.addScan(scan);
        tintScan(scan);
        viewer.frameScan(scan);
        renderScanList();
        refreshPanels();
        showParseReport();
        setStatus('已导入 ' + file.name + ':' + parsed.points.length +
          ' 点' + (parsed.errors.length ? (', ' + parsed.errors.length + ' 个坏行') : ''));
        hideEmptyHint();
        resolve();
      };
      reader.onerror = function () {
        alert('读取文件失败: ' + file.name);
        resolve();
      };
      reader.readAsText(file);
    });
  }

  // ---------- 工程保存文件的重新打开 ----------
  function loadProjectFile(file) {
    const reader = new FileReader();
    reader.onload = function () {
      let project;
      try { project = JSON.parse(reader.result); }
      catch (err) { alert('工程文件不是有效的 JSON'); return; }
      if (project.type !== 'pointcloud-inspector-project') {
        alert('该 JSON 不是本工具的工程文件');
        return;
      }
      pendingProject = project;
      Object.keys(projectLoaders).forEach(function (k) { delete projectLoaders[k]; });
      const need = project.scans.map(function (s) { return s.fileName; });
      setStatus('工程需要源文件: ' + need.join('、') + ' —— 请再次选择这些文件');
      alert('工程文件已读取。\n请再次选择以下源点云文件(可多选,文件名需一致):\n\n' + need.join('\n'));
    };
    reader.readAsText(file);
  }

  function loadProjectSource(file) {
    const text = new FileReader();
    text.onload = function () {
      const parsed = PCParser.parse(text.result, file.name);
      parsed.fileName = file.name;
      projectLoaders[file.name] = parsed;
      tryCompleteProjectResolve();
    };
    text.readAsText(file);
  }

  function tryCompleteProjectResolve(attemptedFiles) {
    if (!pendingProject) return;
    const missing = pendingProject.scans
      .map(function (s) { return s.fileName; })
      .filter(function (n) { return !projectLoaders[n]; });
    if (missing.length) {
      setStatus('工程恢复: 仍缺少 ' + missing.join('、'));
      return;
    }
    finishProjectRestore();
  }

  function finishProjectRestore() {
    const project = pendingProject;
    // 清空现有场景
    store.scans.slice().forEach(function (s) { viewer.removeScan(s.id); });
    store.scans = [];
    store.activeId = null;
    try {
      PCProjectIO.restoreProject(project, store, PCState.Scan, projectLoaders);
    } catch (err) {
      if (err.code === 'MISSING_SOURCE') {
        setStatus('缺少源文件: ' + err.fileName);
        return;
      }
      throw err;
    }
    store.scans.forEach(function (s) {
      viewer.addScan(s);
      tintScan(s);
    });
    if (project.note) $('projectNote').value = project.note;
    if (project.registration) {
      lastRegistration = project.registration;
      const r = project.registration;
      $('errorReadout').textContent = 'RMSE: ' + fmt(r.rmse) +
        ' 平均: ' + fmt(r.mean) + ' 最大: ' + fmt(r.max);
    }
    setLayout(project.layout === 'split' ? 'split' : 'overlay');
    viewer.frameAll();
    renderScanList();
    refreshPanels();
    showParseReport();
    hideEmptyHint();
    pendingProject = null;
    setStatus('工程已恢复: ' + store.scans.length + ' 份扫描(变换与裁剪范围已还原)');
  }

  // 无颜色点云时按导入顺序分配区分色
  function tintScan(scan) {
    const obj = viewer.scanObjects.get(scan.id);
    if (!obj || scan.colors) return;
    const ci = (store.scans.indexOf(scan)) % COLOR_CYCLE.length;
    const hex = COLOR_CYCLE[ci];
    const r = ((hex >> 16) & 255) / 255;
    const g = ((hex >> 8) & 255) / 255;
    const b = (hex & 255) / 255;
    scan.colors = scan.points.map(function () { return [r * 255, g * 255, b * 255]; });
    viewer.updateScan(scan);
  }

  function showParseReport() {
    const el = $('parseReport');
    const blocks = [];
    store.scans.forEach(function (s) {
      if (!s.parseErrors.length) return;
      const rows = s.parseErrors.slice(0, 20).map(function (err) {
        return '<div class="err-line">第 ' + err.line + ' 行: ' + escapeHtml(err.reason) + '</div>';
      }).join('');
      const more = s.parseErrors.length > 20
        ? '<div class="err-line">…另有 ' + (s.parseErrors.length - 20) + ' 行未展开</div>' : '';
      blocks.push('<div class="title">⚠ ' + escapeHtml(s.name) + ' 有 ' +
        s.parseErrors.length + ' 个坏行(已跳过,' +
        s.originalCount().toLocaleString() + ' 个有效点正常加载)</div>' + rows + more);
    });
    if (!blocks.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.innerHTML = blocks.join('');
    el.classList.remove('hidden');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- 扫描列表 ----------
  function renderScanList() {
    const el = $('scanList');
    el.innerHTML = '';
    store.scans.forEach(function (s, i) {
      const item = document.createElement('div');
      item.className = 'scan-item' + (s.id === store.activeId ? ' active' : '');
      const hex = s.colors ? rgbToHex(s.colors[0]) : 0x888888;
      item.innerHTML = '<span class="dot" style="background:#' + hex.toString(16).padStart(6, '0') + '"></span>' +
        '<span class="meta"><span class="name">' + escapeHtml(s.name) + '</span>' +
        '<span class="sub">' + s.count().toLocaleString() + '/' + s.originalCount().toLocaleString() +
        ' 点 · ' + s.format.toUpperCase() + (s.parseErrors.length ? ' · ' + s.parseErrors.length + ' 坏行' : '') +
        '</span></span><button title="移除">×</button>';
      item.addEventListener('click', function (ev) {
        if (ev.target.tagName === 'BUTTON') return;
        if (store.activeId === s.id) return;
        // 切走前清掉旧扫描上的预览高亮与框选状态
        const old = store.active();
        if (old) viewer.updateScan(old);
        invalidatePreview();
        viewer.clearSelectionBox();
        currentSelection = null;
        currentBox = null;
        $('selectionInfo').textContent = '未选择';
        $('boxReadout').textContent = '—';
        endSelectionMode();
        store.activeId = s.id;
        renderScanList();
        refreshPanels();
      });
      item.querySelector('button').addEventListener('click', function () {
        if (previewState && previewState.scanId === s.id) previewState = null;
        viewer.removeScan(s.id);
        store.remove(s.id);
        currentSelection = null;
        currentBox = null;
        renderScanList();
        refreshPanels();
        if (!store.scans.length) showEmptyHint();
      });
      el.appendChild(item);
    });
  }

  function rgbToHex(c) {
    return ((Math.round(c[0]) & 255) << 16) | ((Math.round(c[1]) & 255) << 8) | (Math.round(c[2]) & 255);
  }

  // ---------- 面板刷新 ----------
  function refreshPanels() {
    const s = store.active();
    $('activeScanName').textContent = s ? s.name : '—';
    if (s) {
      $('tx').value = fmt(s.translation[0]); $('ty').value = fmt(s.translation[1]); $('tz').value = fmt(s.translation[2]);
      $('rx').value = fmt(s.rotationDeg[0]); $('ry').value = fmt(s.rotationDeg[1]); $('rz').value = fmt(s.rotationDeg[2]);
      $('transformReadout').textContent =
        '平移: [' + s.translation.map(fmt).join(', ') + ']\n' +
        '旋转(度): [' + s.rotationDeg.map(fmt).join(', ') + ']\n' +
        '可见点: ' + s.count().toLocaleString() + ' / 原始 ' + s.originalCount().toLocaleString() +
        '\n可撤销步数: ' + s.history.length;
      $('undoBtn').disabled = s.history.length === 0;
      $('restoreBtn').disabled = s.activeIndices === null &&
        s.translation.every(function (v) { return v === 0; }) &&
        s.rotationDeg.every(function (v) { return v === 0; });
    } else {
      ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'].forEach(function (id) { $(id).value = ''; });
      $('transformReadout').textContent = '未导入';
      $('undoBtn').disabled = true;
      $('restoreBtn').disabled = true;
    }
    updateLodText();
    updateSplitLabels();
  }

  function updateLodText() {
    const parts = [];
    viewer.scanObjects.forEach(function (obj) {
      if (obj.renderedCount < obj.scan.count()) {
        parts.push(obj.scan.name + ' LOD ' + obj.renderedCount.toLocaleString() +
          '/' + obj.scan.count().toLocaleString());
      }
    });
    $('lodText').textContent = parts.join('  |  ');
  }

  // ---------- 变换 ----------
  function readTransformInputs() {
    return {
      t: [parseFloat($('tx').value) || 0, parseFloat($('ty').value) || 0, parseFloat($('tz').value) || 0],
      r: [parseFloat($('rx').value) || 0, parseFloat($('ry').value) || 0, parseFloat($('rz').value) || 0]
    };
  }

  $('applyTransform').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    const v = readTransformInputs();
    s.setTransform(v.t, v.r, '手动变换');
    invalidatePreview(s.id);
    viewer.updateScan(s);
    viewer.setHelperVisible(s.id, bboxOn);
    refreshPanels();
    setStatus('已应用变换到 ' + s.name);
  });

  document.querySelectorAll('[data-nudge]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      const s = store.active();
      if (!s) return;
      const parts = btn.getAttribute('data-nudge').split(',');
      const field = parts[0], delta = parseFloat(parts[1]);
      const v = readTransformInputs();
      const map = { tx: 0, ty: 1, tz: 2, rx: 0, ry: 1, rz: 2 };
      if (field[0] === 't') v.t[map[field]] += delta;
      else v.r[map[field]] += delta;
      s.setTransform(v.t, v.r, '微调 ' + field);
      invalidatePreview(s.id);
      $('tx').value = fmt(v.t[0]); $('ty').value = fmt(v.t[1]); $('tz').value = fmt(v.t[2]);
      $('rx').value = fmt(v.r[0]); $('ry').value = fmt(v.r[1]); $('rz').value = fmt(v.r[2]);
      viewer.updateScan(s);
      viewer.setHelperVisible(s.id, bboxOn);
      refreshPanels();
    });
  });

  // ---------- 框选 ----------
  $('startSelect').addEventListener('click', function () {
    if (!store.active()) return;
    selecting = true;
    document.body.classList.add('selecting');
    viewer.setInteractionEnabled(false);
    setStatus('框选模式: 在视图上拖拽画框,完成后点裁剪按钮或取消框选');
  });

  $('cancelSelect').addEventListener('click', endSelectionMode);

  function endSelectionMode() {
    selecting = false;
    document.body.classList.remove('selecting');
    viewer.setInteractionEnabled(true);
    hideRect();
  }

  const canvas = () => viewer.renderer.domElement;

  viewportEl.addEventListener('mousedown', function (e) {
    if (!selecting || e.button !== 0) return;
    const rect = canvas().getBoundingClientRect();
    dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top, cx: e.clientX, cy: e.clientY };
    e.preventDefault();
  });

  viewportEl.addEventListener('mousemove', function (e) {
    if (!selecting || !dragStart) return;
    const rect = canvas().getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    showRect(dragStart.x, dragStart.y, x, y);
  });

  viewportEl.addEventListener('mouseup', function (e) {
    if (!selecting || !dragStart) return;
    const rect = canvas().getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    hideRect();
    if (Math.abs(x - dragStart.x) < 6 || Math.abs(y - dragStart.y) < 6) {
      dragStart = null;
      return; // 视为点击,不做选择
    }
    const viewIndex = pickViewIndex(e.clientX, rect);
    // split 并排时, 左视口对应第 0 片、右视口对应第 1 片,自动切换编辑对象
    let s = store.active();
    if (layout === 'split' && store.scans[viewIndex]) {
      if (store.activeId !== store.scans[viewIndex].id) {
        store.activeId = store.scans[viewIndex].id;
        s = store.active();
        renderScanList();
        refreshPanels();
      }
    }
    const ndc = rectToNdc(dragStart.x, dragStart.y, x, y, rect, viewIndex);
    currentSelection = viewer.pickInRect(s, ndc, viewIndex);
    currentBox = viewer.selectionToBox(s, currentSelection);
    viewer.showSelectionBox(currentBox ? toThreeBox(currentBox) : null, viewIndex);
    $('selectionInfo').textContent = '已选中 ' + currentSelection.size.toLocaleString() + ' 点(扫描: ' + s.name + ')';
    $('boxReadout').textContent = currentBox
      ? 'min [' + currentBox.min.map(fmt).join(', ') + ']\nmax [' + currentBox.max.map(fmt).join(', ') + ']'
      : '框内无点';
    viewer.updateScan(s, currentSelection);
    dragStart = null;
    setStatus('框选完成: ' + currentSelection.size + ' 点,可保留框内或剔除框内');
  });

  function pickViewIndex(clientX, rect) {
    if (layout !== 'split') return 0;
    const local = clientX - rect.left;
    return local > rect.width / 2 ? 1 : 0;
  }

  function rectToNdc(x0, y0, x1, y1, rect, viewIndex) {
    const halfW = layout === 'split' ? rect.width / 2 : rect.width;
    const ox = layout === 'split' && viewIndex === 1 ? halfW : 0;
    const nx0 = ((Math.min(x0, x1) - ox) / halfW) * 2 - 1;
    const nx1 = ((Math.max(x0, x1) - ox) / halfW) * 2 - 1;
    const ny0 = -(Math.min(y0, y1) / rect.height) * 2 + 1;
    const ny1 = -(Math.max(y0, y1) / rect.height) * 2 + 1;
    return { x0: nx0, y0: Math.max(ny0, ny1), x1: nx1, y1: Math.min(ny0, ny1) };
  }

  function toThreeBox(box) {
    return new THREE.Box3(
      new THREE.Vector3(box.min[0], box.min[1], box.min[2]),
      new THREE.Vector3(box.max[0], box.max[1], box.max[2])
    );
  }

  function showRect(x0, y0, x1, y1) {
    const el = $('selectRect');
    el.classList.remove('hidden');
    el.style.left = Math.min(x0, x1) + 'px';
    el.style.top = Math.min(y0, y1) + 'px';
    el.style.width = Math.abs(x1 - x0) + 'px';
    el.style.height = Math.abs(y1 - y0) + 'px';
  }
  function hideRect() { $('selectRect').classList.add('hidden'); }

  // 裁剪: 注意先取消高亮预览,再对「当前 activeIndices」做 AABB 过滤
  function applyCrop(mode) {
    const s = store.active();
    if (!s || !currentBox || !currentSelection || !currentSelection.size) {
      setStatus('请先框选一片区域');
      return;
    }
    viewer.updateScan(s); // 清除黄色高亮
    // currentBox 是世界坐标 AABB; cropByBox 在局部坐标判定,需用逆变换换算
    const localBox = worldBoxToLocal(s, currentBox);
    const result = PCFilters.cropByBox(s.points,
      s.activeIndices || allIndices(s), localBox, mode);
    s.applyIndices(result.keep,
      mode === 'remove-inside' ? '剔除框内' : '保留框内(裁剪)',
      { min: currentBox.min.slice(), max: currentBox.max.slice() });
    invalidatePreview(s.id);
    viewer.updateScan(s);
    viewer.clearSelectionBox();
    currentSelection = null;
    currentBox = null;
    $('selectionInfo').textContent = '未选择';
    $('boxReadout').textContent = '—';
    endSelectionMode();
    renderScanList();
    refreshPanels();
    setStatus((mode === 'remove-inside' ? '剔除' : '保留') + ' 完成,剩余 ' +
      s.count().toLocaleString() + ' 点(可撤销恢复)');
  }

  // 世界坐标 AABB → 该扫描局部坐标 AABB(对 8 个角点做逆变换后重新取包围盒)
  function worldBoxToLocal(scan, worldBox) {
    const m = scan.matrix();
    const inv = invertMatrix4(m);
    const corners = [
      [worldBox.min[0], worldBox.min[1], worldBox.min[2]],
      [worldBox.max[0], worldBox.min[1], worldBox.min[2]],
      [worldBox.min[0], worldBox.max[1], worldBox.min[2]],
      [worldBox.max[0], worldBox.max[1], worldBox.min[2]],
      [worldBox.min[0], worldBox.min[1], worldBox.max[2]],
      [worldBox.max[0], worldBox.min[1], worldBox.max[2]],
      [worldBox.min[0], worldBox.max[1], worldBox.max[2]],
      [worldBox.max[0], worldBox.max[1], worldBox.max[2]]
    ];
    const local = corners.map(function (c) { return PCMath.applyPoint(inv, c); });
    return PCMath.bbox(local);
  }

  // 刚体变换(旋转+平移)求逆: R^T 与 -R^T*t,列主序
  function invertMatrix4(m) {
    const out = PCMath.identity();
    // 3x3 旋转部分转置
    for (let col = 0; col < 3; col++) {
      for (let row = 0; row < 3; row++) {
        out[col * 4 + row] = m[row * 4 + col];
      }
    }
    const t = [m[12], m[13], m[14]];
    out[12] = -(out[0] * t[0] + out[4] * t[1] + out[8] * t[2]);
    out[13] = -(out[1] * t[0] + out[5] * t[1] + out[9] * t[2]);
    out[14] = -(out[2] * t[0] + out[6] * t[1] + out[10] * t[2]);
    return out;
  }
  $('cropInside').addEventListener('click', function () { applyCrop('keep-inside'); });
  $('cropOutside').addEventListener('click', function () { applyCrop('remove-inside'); });

  function allIndices(s) {
    const a = new Uint32Array(s.originalCount());
    for (let i = 0; i < a.length; i++) a[i] = i;
    return a;
  }

  // ---------- 离群点筛除 ----------
  function sorParams() {
    return { k: Math.max(2, parseInt($('sorK').value, 10) || 8),
      std: parseFloat($('sorStd').value) || 1.0 };
  }

  $('previewSor').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    if (busy) return;
    const n = s.count();
    setStatus('正在计算离群点(' + n.toLocaleString() + ' 点,大点数可能需要数秒)…');
    busy = true; $('previewSor').disabled = true;
    setTimeout(function () {
      const t0 = performance.now();
      try {
        const p = sorParams();
        const active = s.activeIndices || allIndices(s);
        const sub = pointsFromIndices(s, active);
        const r = PCFilters.statisticalOutlierRemoval(sub, p.k, p.std);
        // 子数组索引映射回原始索引
        const removedSet = new Set();
        for (let i = 0; i < r.remove.length; i++) removedSet.add(active[r.remove[i]]);
        previewState = { kind: 'sor', scanId: s.id, removeSet: removedSet };
        viewer.updateScan(s, removedSet);
        $('sorInfo').innerHTML = '预计剔除 <b>' + r.removedCount.toLocaleString() + '</b> 点' +
          '(平均邻距 ' + fmt(r.meanDist) + ',阈值 ' + fmt(r.threshold) +
          ',计算耗时 ' + (performance.now() - t0).toFixed(0) + ' ms)。' +
          '黄色为待剔除点,「应用筛除」生效,其他操作自动取消预览。';
        setStatus('预览: 将剔除 ' + r.removedCount.toLocaleString() + ' 个离群点');
      } finally {
        busy = false; $('previewSor').disabled = false;
      }
    }, 30);
  });

  $('applySor').addEventListener('click', function () {
    const s = store.active();
    if (!s || !previewState || previewState.kind !== 'sor' || previewState.scanId !== s.id) {
      setStatus('请先点击「预览筛除」');
      return;
    }
    const removedSet = previewState.removeSet;
    const active = s.activeIndices || allIndices(s);
    const keep = [];
    for (let i = 0; i < active.length; i++) {
      if (!removedSet.has(active[i])) keep.push(active[i]);
    }
    s.applyIndices(Uint32Array.from(keep), '离群点筛除 k=' + sorParams().k);
    previewState = null;
    viewer.updateScan(s);
    renderScanList();
    refreshPanels();
    setStatus('已剔除 ' + removedSet.size + ' 个离群点,剩余 ' + s.count().toLocaleString() + ' 点');
  });

  // ---------- 稀疏采样 ----------
  function pointsFromIndices(s, indices) {
    const out = new Array(indices.length);
    for (let i = 0; i < indices.length; i++) out[i] = s.points[indices[i]];
    return out;
  }

  $('previewSample').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    const target = Math.max(100, parseInt($('sampleTarget').value, 10) || 50000);
    const active = s.activeIndices || allIndices(s);
    const r = PCFilters.strideSample({ length: active.length }, target);
    const keptSet = new Set();
    for (let i = 0; i < r.indices.length; i++) keptSet.add(active[r.indices[i]]);
    previewState = { kind: 'sample', scanId: s.id, keepSet: keptSet };
    // 高亮将被保留的点(黄色),其余灰显由 material 保持原色 —— 这里用反向集合做"待移除"提示
    const removeSet = new Set();
    for (let i = 0; i < active.length; i++) {
      if (!keptSet.has(active[i])) removeSet.add(active[i]);
    }
    viewer.updateScan(s, removeSet);
    $('sampleInfo').innerHTML = '等步长采样将保留 <b>' + keptSet.size.toLocaleString() +
      '</b> 点,黄色为待移除点。';
    setStatus('采样预览: 保留 ' + keptSet.size + ' / ' + active.length + ' 点');
  });

  $('applySample').addEventListener('click', function () {
    const s = store.active();
    if (!s || !previewState || previewState.kind !== 'sample' || previewState.scanId !== s.id) {
      setStatus('请先点击「预览采样」');
      return;
    }
    const keepSet = previewState.keepSet;
    const active = s.activeIndices || allIndices(s);
    const keep = [];
    for (let i = 0; i < active.length; i++) {
      if (keepSet.has(active[i])) keep.push(active[i]);
    }
    s.applyIndices(Uint32Array.from(keep), '等步长稀疏采样→' + keep.length);
    previewState = null;
    viewer.updateScan(s);
    renderScanList();
    refreshPanels();
    setStatus('采样完成: ' + s.count().toLocaleString() + ' 点');
  });

  $('applyVoxel').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    const size = parseFloat($('voxelSize').value);
    if (!Number.isFinite(size) || size <= 0) { setStatus('请输入有效的体素边长'); return; }
    const active = s.activeIndices || allIndices(s);
    const r = PCFilters.voxelDownsample(pointsFromIndices(s, active), size);
    const keep = Array.from(r.indices, function (i) { return active[i]; });
    s.applyIndices(Uint32Array.from(keep), '体素降采样 size=' + size);
    previewState = null;
    viewer.updateScan(s);
    renderScanList();
    refreshPanels();
    setStatus('体素降采样: ' + r.voxelCount.toLocaleString() + ' 个体素,保留 ' +
      s.count().toLocaleString() + ' 点');
  });

  // 任何切换都应作废预览态
  function invalidatePreview(scanId) {
    if (previewState && (!scanId || previewState.scanId === scanId)) previewState = null;
  }

  // ---------- 撤销 / 恢复 ----------
  $('undoBtn').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    const prev = s.undo();
    if (!prev) return;
    invalidatePreview(s.id);
    viewer.clearSelectionBox();
    viewer.updateScan(s);
    viewer.setHelperVisible(s.id, bboxOn);
    renderScanList();
    refreshPanels();
    setStatus('已撤销: ' + prev.label + '(剩余 ' + s.count().toLocaleString() + ' 点)');
  });

  $('restoreBtn').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    if (!confirm('恢复该扫描的完整原始点集并重置变换?历史操作将清空。')) return;
    const cleared = s.restoreAll();
    invalidatePreview(s.id);
    viewer.clearSelectionBox();
    viewer.updateScan(s);
    viewer.setHelperVisible(s.id, false);
    renderScanList();
    refreshPanels();
    setStatus('已恢复原始点集(' + s.originalCount().toLocaleString() + ' 点),清空 ' + cleared + ' 步历史');
  });

  // ---------- 双扫描布局与配准 ----------
  $('layoutOverlay').addEventListener('click', function () { setLayout('overlay'); });
  $('layoutSplit').addEventListener('click', function () {
    if (store.scans.length < 2) { setStatus('并排视图需要至少两份扫描'); return; }
    setLayout('split');
  });

  function setLayout(mode) {
    layout = mode;
    viewer.setLayout(mode);
    updateSplitLabels();
    setStatus(mode === 'split' ? '并排视图: 左右各一个独立相机,点击上方扫描名切换编辑对象' : '叠加视图');
  }

  function updateSplitLabels() {
    const l = $('splitLabelL'), r = $('splitLabelR');
    if (layout !== 'split' || store.scans.length < 2) {
      l.classList.add('hidden'); r.classList.add('hidden');
      return;
    }
    l.textContent = 'A: ' + store.scans[0].name;
    r.textContent = 'B: ' + store.scans[1].name;
    l.classList.remove('hidden'); r.classList.remove('hidden');
  }

  $('calcError').addEventListener('click', function () {
    if (store.scans.length < 2) { setStatus('需要两份扫描才能计算配准误差'); return; }
    if (busy) return;
    setStatus('正在计算最近邻配准误差…');
    busy = true; $('calcError').disabled = true;
    setTimeout(function () {
      try {
        const a = store.scans[0], b = store.scans[1];
        const r = PCRegistration.nearestNeighborError(a.worldPoints(), b.worldPoints(), 5000);
        lastRegistration = r;
        if (r.rmse === null) { $('errorReadout').textContent = r.message; return; }
        $('errorReadout').textContent =
          '源: ' + a.name + ' → 目标: ' + b.name + '\n' +
          '抽样 ' + r.samples.toLocaleString() + ' 点(目标共 ' + r.targetCount.toLocaleString() + ')\n' +
          'RMSE:   ' + fmt(r.rmse) + '\n' +
          '平均:   ' + fmt(r.mean) + '\n' +
          '中位数: ' + fmt(r.median) + '\n' +
          '最大:   ' + fmt(r.max);
        setStatus('配准误差 RMSE=' + fmt(r.rmse));
      } finally {
        busy = false; $('calcError').disabled = false;
      }
    }, 30);
  });

  // ---------- 显示设置 ----------
  $('pointSize').addEventListener('input', function (e) {
    viewer.setPointSize(parseFloat(e.target.value));
  });
  $('renderCap').addEventListener('change', function (e) {
    const cap = Math.max(1000, parseInt(e.target.value, 10) || 250000);
    viewer.setRenderCap(cap);
    refreshPanels();
  });
  $('frameAll').addEventListener('click', function () { viewer.frameAll(); });

  let bboxOn = false;
  $('toggleBBox').addEventListener('click', function () {
    bboxOn = !bboxOn;
    store.scans.forEach(function (s) { viewer.setHelperVisible(s.id, bboxOn); });
    setStatus(bboxOn ? '已显示包围盒' : '已隐藏包围盒');
  });

  // ---------- 保存 / 导出 ----------
  function buildProject() {
    return PCProjectIO.saveProject(store, {
      note: $('projectNote').value.trim(),
      layout: layout,
      registration: lastRegistration
    });
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 200);
  }

  $('saveProject').addEventListener('click', function () {
    if (!store.scans.length) return;
    downloadText('pointcloud-project-' + timestamp() + '.pcproj.json',
      JSON.stringify(buildProject(), null, 2), 'application/json');
    setStatus('工程已保存(重新打开时需选择同样的源文件)');
  });

  $('saveNote').addEventListener('click', function () {
    if (!store.scans.length) return;
    downloadText('pointcloud-note-' + timestamp() + '.md',
      PCProjectIO.exportProjectNote(store, buildProject()));
    setStatus('工程说明已导出');
  });

  $('exportActive').addEventListener('click', function () {
    const s = store.active();
    if (!s) return;
    const text = PCProjectIO.exportXYZ(s, { withColor: $('exportColor').checked });
    downloadText(s.name + '-processed-' + timestamp() + '.xyz', text);
    setStatus('已导出 ' + s.name + ':' + s.count().toLocaleString() + ' 点');
  });

  $('exportAll').addEventListener('click', function () {
    if (!store.scans.length) return;
    store.scans.forEach(function (s, i) {
      setTimeout(function () {
        const text = PCProjectIO.exportXYZ(s, { withColor: $('exportColor').checked });
        downloadText(s.name + '-processed-' + timestamp() + '.xyz', text);
      }, i * 300);
    });
    setStatus('正在导出全部 ' + store.scans.length + ' 份点云…');
  });

  function timestamp() {
    const d = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ---------- 工程文件重新打开 ----------
  // 工程 json 也通过同一个文件选择器导入: 识别 type 字段后要求再选源文件

  function hideEmptyHint() { $('emptyHint').classList.add('hidden'); }
  function showEmptyHint() { $('emptyHint').classList.remove('hidden'); }

  refreshPanels();
})();
