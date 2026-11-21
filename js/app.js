/*
 * app.js — 智能裁切试验台主应用
 *
 * 状态约定：
 *   - 关注区、裁切框全部以「原图归一化坐标 {x,y,w,h} ∈ [0,1]」存储，绑定原图；
 *     画布显示与导出时再换算，原图换分辨率不影响项目语义。
 *   - 每个目标 target 独立持有 outputMode(crop/pad)、locked、manualCrop(归一化)。
 *   - 自动裁切结果不持久化，每次根据当前关注区重新计算；locked 的目标保留手动位置，
 *     不会被「全部重算 / 改关注区」覆盖，并单独标记为「已过期，建议复核」。
 */
(function () {
  'use strict';

  const G = window.SCGeometry;
  const C = window.SCCropper;
  const Posters = window.SCPosters;
  const Storage = window.SCStorage;
  const Exporter = window.SCExporter;

  const REGION_COLORS = {
    required: { stroke: '#ff5d6c', fill: 'rgba(255,93,108,0.14)' },
    preferred: { stroke: '#47c7ff', fill: 'rgba(71,199,255,0.12)' },
  };
  const HANDLE_SIZE = 9;
  const MIN_REGION_NORM = 0.012;
  const AUTOSAVE_DELAY = 500;

  const DEFAULT_TARGETS = [
    { id: 't-banner', name: '横幅 Banner', width: 1920, height: 800 },
    { id: 't-square', name: '方图 1:1', width: 1080, height: 1080 },
    { id: 't-vertical', name: '竖图 9:16', width: 1080, height: 1920 },
  ];

  // ---------- 全局状态 ----------
  const state = {
    sourceCanvas: null, // 原图 canvas（真实分辨率）
    imgW: 0,
    imgH: 0,
    sourceName: 'posterA',
    project: null, // 持久化对象
    currentTargetId: null,
    selectedRegionId: null,
    tool: 'select', // select | required | preferred | crop
    padColor: '#0b1020',
    drag: null, // 当前拖拽会话
    analysisCache: {}, // targetId -> analysis
    view: { scale: 1, ox: 0, oy: 0 }, // 画布显示变换
    autosaveTimer: null,
  };

  let $ = (id) => document.getElementById(id);
  const canvas = $('mainCanvas');
  const ctx = canvas.getContext('2d');

  // ---------- 项目构造 ----------
  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function makeTarget(t) {
    return {
      id: t.id || uid('t'),
      name: t.name,
      width: Math.max(1, Math.round(t.width)),
      height: Math.max(1, Math.round(t.height)),
      outputMode: t.outputMode || 'crop',
      locked: !!t.locked,
      manualCrop: t.manualCrop || null, // 归一化
    };
  }

  function makeRegion(r) {
    return {
      id: r.id || uid('r'),
      label: r.label || (r.priority === 'required' ? '必须保留区' : '尽量保留区'),
      priority: r.priority === 'preferred' ? 'preferred' : 'required',
      x: G.clamp(r.x, 0, 1),
      y: G.clamp(r.y, 0, 1),
      w: G.clamp(r.w, MIN_REGION_NORM, 1),
      h: G.clamp(r.h, MIN_REGION_NORM, 1),
    };
  }

  function buildProject(sourceName, regions, targets) {
    return {
      id: uid('p'),
      sourceName,
      regions: regions.map(makeRegion),
      targets: targets.map(makeTarget),
    };
  }

  // ---------- 海报 / 图片载入 ----------
  function loadPoster(spec) {
    const c = spec.draw();
    state.sourceCanvas = c;
    state.imgW = spec.width;
    state.imgH = spec.height;
    state.sourceName = spec.id;
    state.project = buildProject(spec.id, spec.regions, DEFAULT_TARGETS);
    state.currentTargetId = state.project.targets[0].id;
    state.selectedRegionId = null;
    state.analysisCache = {};
    state.tool = 'select';
    $('stageEmpty').style.display = 'none';
    invalidateAllAnalysis();
    renderAll();
    scheduleAutosave();
    toast('已载入 ' + spec.name, 'success');
  }

  function loadUploadedImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      state.sourceCanvas = c;
      state.imgW = img.naturalWidth;
      state.imgH = img.naturalHeight;
      state.sourceName = file.name.replace(/\.[^.]+$/, '') || 'upload';
      state.project = buildProject(state.sourceName, [], DEFAULT_TARGETS);
      state.currentTargetId = state.project.targets[0].id;
      state.selectedRegionId = null;
      state.analysisCache = {};
      $('stageEmpty').style.display = 'none';
      invalidateAllAnalysis();
      renderAll();
      scheduleAutosave();
      toast(`已导入原图 ${img.naturalWidth}×${img.naturalHeight}，请先框选关注区`, 'success');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('图片读取失败', 'error');
    };
    img.src = url;
  }

  // ---------- 分析计算（核心联动） ----------
  function pixelRegions() {
    return C.toPixelRegions(state.project.regions, state.imgW, state.imgH);
  }

  /**
   * 计算某目标的当前方案。
   * crop 模式：
   *   - locked 且有 manualCrop：使用手动位置，仅分析保留情况（自动结果绝不覆盖）
   *   - 否则：autoCrop 自动选位
   * pad 模式：整张原图等比嵌入 + 补边
   */
  function computeAnalysis(target) {
    if (state.analysisCache[target.id]) return state.analysisCache[target.id];
    let analysis;
    if (target.outputMode === 'pad') {
      const pad = C.padLayout(state.imgW, state.imgH, target.width, target.height);
      // 保留扁平字段（mode/effectiveRatio/conflicts），完整 pad 参数挂在 padLayout 下
      analysis = { ...pad, padLayout: pad, stale: false };
    } else if (target.locked && target.manualCrop) {
      const cropPx = G.denormalizeRect(target.manualCrop, state.imgW, state.imgH);
      analysis = C.analyzeManual(
        cropPx, state.imgW, state.imgH, pixelRegions(), target.width, target.height
      );
      // 关注区被改过之后，锁定的手动框可能已不再满足当前必须区
      analysis.stale = analysis.missingRequired.length > 0;
    } else {
      analysis = C.autoCrop(
        state.imgW, state.imgH, pixelRegions(), target.width, target.height
      );
      analysis.stale = false;
    }
    state.analysisCache[target.id] = analysis;
    return analysis;
  }

  function invalidateAnalysis(targetId) {
    delete state.analysisCache[targetId];
  }

  function invalidateAllAnalysis() {
    state.analysisCache = {};
  }

  /** 关注区变化：未锁定目标全部重算；锁定目标仅刷新分析（保留手动框，标记过期） */
  function onRegionsChanged() {
    state.project.targets.forEach((t) => invalidateAnalysis(t.id));
    renderAll();
    scheduleAutosave();
  }

  // ---------- 画布坐标换算 ----------
  function fitView() {
    const stage = $('stage');
    const pad = 36;
    const availW = stage.clientWidth - pad * 2;
    const availH = stage.clientHeight - pad * 2;
    const scale = Math.min(availW / state.imgW, availH / state.imgH);
    state.view.scale = scale;
    canvas.width = Math.round(state.imgW * scale);
    canvas.height = Math.round(state.imgH * scale);
    state.view.ox = 0;
    state.view.oy = 0;
  }

  function normToCanvas(r) {
    const s = state.view.scale;
    return { x: r.x * state.imgW * s, y: r.y * state.imgH * s, w: r.w * state.imgW * s, h: r.h * state.imgH * s };
  }

  function canvasToNorm(r) {
    const s = state.view.scale;
    return G.normalizeRect(r, state.imgW * s, state.imgH * s);
  }

  function eventToCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ---------- 绘制 ----------
  function draw() {
    if (!state.sourceCanvas) return;
    fitView();
    const s = state.view.scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(state.sourceCanvas, 0, 0, canvas.width, canvas.height);

    // 关注区
    state.project.regions.forEach((r) => drawRegion(r, r.id === state.selectedRegionId));

    // 当前目标裁切框 / pad 取景
    const target = currentTarget();
    if (target) {
      const analysis = computeAnalysis(target);
      if (target.outputMode === 'pad') drawPadOverlay(analysis, target);
      else drawCropOverlay(analysis, target);
    }
  }

  function drawRegion(r, selected) {
    const box = normToCanvas(r);
    const col = REGION_COLORS[r.priority];
    ctx.save();
    ctx.fillStyle = col.fill;
    ctx.strokeStyle = col.stroke;
    ctx.lineWidth = selected ? 2.5 : 1.6;
    ctx.setLineDash(r.priority === 'preferred' ? [7, 5] : []);
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    // 标签
    const label = (r.priority === 'required' ? '必须 · ' : '尽量 · ') + r.label;
    ctx.font = '11px -apple-system,"PingFang SC",sans-serif';
    const tw = ctx.measureText(label).width + 12;
    ctx.fillStyle = col.stroke;
    ctx.fillRect(box.x, Math.max(0, box.y - 18), tw, 18);
    ctx.fillStyle = '#0d1220';
    ctx.fillText(label, box.x + 6, Math.max(12, box.y - 5));
    if (selected) drawHandles(box);
    ctx.restore();
  }

  function drawHandles(box) {
    const pts = handlePoints(box);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1d2640';
    ctx.lineWidth = 1;
    Object.values(pts).forEach((p) => {
      ctx.beginPath();
      ctx.rect(p.x - HANDLE_SIZE / 2, p.y - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE);
      ctx.fill();
      ctx.stroke();
    });
  }

  function handlePoints(box) {
    return {
      nw: { x: box.x, y: box.y },
      ne: { x: box.x + box.w, y: box.y },
      sw: { x: box.x, y: box.y + box.h },
      se: { x: box.x + box.w, y: box.y + box.h },
    };
  }

  function drawCropOverlay(analysis, target) {
    const norm = G.normalizeRect(analysis.crop, state.imgW, state.imgH);
    const box = normToCanvas(norm);
    const locked = target.locked && target.manualCrop;
    ctx.save();
    // 外部遮罩：裁切框之外压暗
    ctx.fillStyle = 'rgba(7,11,22,0.55)';
    ctx.fillRect(0, 0, canvas.width, box.y);
    ctx.fillRect(0, box.y + box.h, canvas.width, canvas.height - box.y - box.h);
    ctx.fillRect(0, box.y, box.x, box.h);
    ctx.fillRect(box.x + box.w, box.y, canvas.width - box.x - box.w, box.h);
    // 框体
    ctx.strokeStyle = locked ? '#ffd23f' : 'rgba(255,210,63,0.9)';
    ctx.lineWidth = locked ? 2.6 : 1.8;
    ctx.setLineDash(locked ? [] : [10, 6]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    // 四角强调
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 3;
    const L = Math.min(18, box.w / 6, box.h / 6);
    [
      [box.x, box.y, 1, 1], [box.x + box.w, box.y, -1, 1],
      [box.x, box.y + box.h, 1, -1], [box.x + box.w, box.y + box.h, -1, -1],
    ].forEach(([x, y, dx, dy]) => {
      ctx.beginPath();
      ctx.moveTo(x + dx * L, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * L);
      ctx.stroke();
    });
    // 标签
    const tag = `${target.name} ${target.width}×${target.height}` + (locked ? ' · 已锁定' : '');
    ctx.font = 'bold 11.5px -apple-system,"PingFang SC",sans-serif';
    const tw = ctx.measureText(tag).width + 14;
    ctx.fillStyle = locked ? '#ffd23f' : 'rgba(255,210,63,0.92)';
    ctx.fillRect(box.x, box.y, tw, 20);
    ctx.fillStyle = '#1a1405';
    ctx.fillText(tag, box.x + 7, box.y + 14);
    ctx.restore();
  }

  function drawPadOverlay(analysis) {
    // pad 模式用整图取景框 + 补边示意框（图像实际占用区域相对全画布）
    ctx.save();
    ctx.strokeStyle = '#43d39e';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.setLineDash([]);
    const pct = (analysis.effectiveRatio * 100).toFixed(1) + '%';
    ctx.font = 'bold 11.5px -apple-system,"PingFang SC",sans-serif';
    const tag = `带留白 · 有效图像 ${pct}（绿框内为整张原图，补边在导出时生成）`;
    const tw = ctx.measureText(tag).width + 14;
    ctx.fillStyle = 'rgba(67,211,158,0.95)';
    ctx.fillRect(0, 0, tw, 20);
    ctx.fillStyle = '#062018';
    ctx.fillText(tag, 7, 14);
    ctx.restore();
  }

  // ---------- 鼠标交互 ----------
  function hitRegion(pos) {
    // 从上往下（后画的在上）逆序命中
    for (let i = state.project.regions.length - 1; i >= 0; i--) {
      const r = state.project.regions[i];
      const box = normToCanvas(r);
      if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) {
        return { region: r, box, handle: hitHandle(box, pos) };
      }
    }
    return null;
  }

  function hitHandle(box, pos) {
    const pts = handlePoints(box);
    let found = null;
    Object.entries(pts).forEach(([name, p]) => {
      if (Math.abs(pos.x - p.x) <= HANDLE_SIZE && Math.abs(pos.y - p.y) <= HANDLE_SIZE) found = name;
    });
    return found;
  }

  function hitCropFrame(pos) {
    const target = currentTarget();
    if (!target || target.outputMode !== 'crop') return null;
    const analysis = computeAnalysis(target);
    const box = normToCanvas(G.normalizeRect(analysis.crop, state.imgW, state.imgH));
    if (pos.x >= box.x && pos.x <= box.x + box.w && pos.y >= box.y && pos.y <= box.y + box.h) {
      return { box, analysis };
    }
    return null;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!state.sourceCanvas) return;
    const pos = eventToCanvasPos(e);

    // 框选新关注区
    if (state.tool === 'required' || state.tool === 'preferred') {
      state.drag = {
        kind: 'create-region',
        priority: state.tool,
        start: pos,
        current: pos,
      };
      return;
    }

    // 拖裁切框（自动模式下拖动即转为手动；锁定模式下也允许微调且保持锁定）
    if (state.tool === 'crop') {
      const hit = hitCropFrame(pos);
      if (hit) {
        const target = currentTarget();
        const analysis = computeAnalysis(target);
        state.drag = {
          kind: 'move-crop',
          targetId: target.id,
          start: pos,
          origCrop: G.normalizeRect(analysis.crop, state.imgW, state.imgH),
        };
      } else {
        toast('请在黄色裁切框内按下拖动', 'error');
      }
      return;
    }

    // 选择工具：优先手柄、再区域、再裁切框
    const hit = hitRegion(pos);
    if (hit) {
      state.selectedRegionId = hit.region.id;
      if (hit.handle) {
        state.drag = { kind: 'resize-region', regionId: hit.region.id, handle: hit.handle, start: pos };
      } else {
        state.drag = { kind: 'move-region', regionId: hit.region.id, start: pos, orig: { ...hit.region } };
      }
      renderSidebar();
      draw();
      return;
    }
    const cropHit = hitCropFrame(pos);
    if (cropHit) {
      const target = currentTarget();
      const analysis = computeAnalysis(target);
      state.drag = {
        kind: 'move-crop',
        targetId: target.id,
        start: pos,
        origCrop: G.normalizeRect(analysis.crop, state.imgW, state.imgH),
      };
      return;
    }
    state.selectedRegionId = null;
    renderSidebar();
    draw();
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.drag) {
      updateCursor(e);
      return;
    }
    const pos = eventToCanvasPos(e);
    const d = state.drag;

    if (d.kind === 'create-region') {
      d.current = pos;
      draw();
      drawCreatingRect(d);
      return;
    }

    if (d.kind === 'move-region') {
      const r = state.project.regions.find((x) => x.id === d.regionId);
      const dx = (pos.x - d.start.x) / (state.imgW * state.view.scale);
      const dy = (pos.y - d.start.y) / (state.imgH * state.view.scale);
      r.x = G.clamp(d.orig.x + dx, 0, 1 - r.w);
      r.y = G.clamp(d.orig.y + dy, 0, 1 - r.h);
      invalidateAllAnalysis();
      draw();
      renderSidebar();
      return;
    }

    if (d.kind === 'resize-region') {
      const r = state.project.regions.find((x) => x.id === d.regionId);
      const p = canvasToNorm({ x: pos.x, y: pos.y, w: 0, h: 0 });
      let { x, y, w, h } = r;
      if (d.handle.includes('w')) { w = x + w - G.clamp(p.x, 0, x + w - MIN_REGION_NORM); x = Math.min(p.x, x + w - MIN_REGION_NORM); }
      if (d.handle.includes('e')) { w = G.clamp(p.x, x + MIN_REGION_NORM, 1) - x; }
      if (d.handle.includes('n')) { h = y + h - G.clamp(p.y, 0, y + h - MIN_REGION_NORM); y = Math.min(p.y, y + h - MIN_REGION_NORM); }
      if (d.handle.includes('s')) { h = G.clamp(p.y, y + MIN_REGION_NORM, 1) - y; }
      Object.assign(r, G.clampRectToBounds({ x, y, w, h }, { x: 0, y: 0, w: 1, h: 1 }));
      r.w = Math.max(MIN_REGION_NORM, r.w);
      r.h = Math.max(MIN_REGION_NORM, r.h);
      invalidateAllAnalysis();
      draw();
      renderSidebar();
      return;
    }

    if (d.kind === 'move-crop') {
      const target = state.project.targets.find((t) => t.id === d.targetId);
      const dx = (pos.x - d.start.x) / (state.imgW * state.view.scale);
      const dy = (pos.y - d.start.y) / (state.imgH * state.view.scale);
      let next = {
        ...d.origCrop,
        x: G.clamp(d.origCrop.x + dx, 0, 1 - d.origCrop.w),
        y: G.clamp(d.origCrop.y + dy, 0, 1 - d.origCrop.h),
      };
      target.manualCrop = G.roundRect(next, 6);
      target.locked = true; // 手动拖动即锁定，防止被自动覆盖
      invalidateAnalysis(target.id);
      draw();
      renderSidebar();
      renderRightPanel();
      return;
    }
  });

  window.addEventListener('mouseup', () => {
    const d = state.drag;
    if (!d) return;
    state.drag = null;
    if (d.kind === 'create-region') {
      const rect = G.rectFromPoints(d.start.x, d.start.y, d.current.x, d.current.y);
      const norm = canvasToNorm(rect);
      if (norm.w >= MIN_REGION_NORM && norm.h >= MIN_REGION_NORM) {
        const r = makeRegion({ ...norm, priority: d.priority, label: d.priority === 'required' ? '必须保留区' : '尽量保留区' });
        state.project.regions.push(r);
        state.selectedRegionId = r.id;
        setTool('select');
        onRegionsChanged();
      } else {
        draw();
        toast('框选区域太小', 'error');
      }
    } else if (d.kind && d.kind.endsWith('region')) {
      onRegionsChanged();
    } else if (d.kind === 'move-crop') {
      scheduleAutosave();
      renderAll();
      toast('已锁定手动裁切位置，自动重算不会覆盖；可点「恢复自动」解锁', 'success');
    }
  });

  function drawCreatingRect(d) {
    const col = REGION_COLORS[d.priority];
    const rect = G.rectFromPoints(d.start.x, d.start.y, d.current.x, d.current.y);
    ctx.save();
    ctx.fillStyle = col.fill;
    ctx.strokeStyle = col.stroke;
    ctx.lineWidth = 2;
    ctx.setLineDash(d.priority === 'preferred' ? [7, 5] : []);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    ctx.restore();
  }

  function updateCursor(e) {
    if (!state.sourceCanvas) return;
    const pos = eventToCanvasPos(e);
    let cursor = 'default';
    if (state.tool === 'required' || state.tool === 'preferred') cursor = 'crosshair';
    else if (state.tool === 'crop') cursor = hitCropFrame(pos) ? 'move' : 'crosshair';
    else {
      const hit = hitRegion(pos);
      if (hit) cursor = hit.handle ? (hit.handle.includes('w') || hit.handle.includes('e') ? 'ew-resize' : 'ns-resize') : 'move';
      else if (hitCropFrame(pos)) cursor = 'move';
    }
    canvas.style.cursor = cursor;
  }

  // ---------- 工具切换 ----------
  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('.tool-btn').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  }
  document.querySelectorAll('.tool-btn').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  $('addRequiredBtn').addEventListener('click', () => setTool('required'));
  $('addPreferredBtn').addEventListener('click', () => setTool('preferred'));

  // ---------- 侧栏：关注区 ----------
  function renderRegionList() {
    const ul = $('regionList');
    ul.innerHTML = '';
    if (!state.project.regions.length) {
      ul.innerHTML = '<li class="hint" style="padding:6px 2px">还没有关注区。用顶部「框选必须保留」在图上拖一个矩形。</li>';
      return;
    }
    state.project.regions.forEach((r) => {
      const li = document.createElement('li');
      li.className = `region-item r-${r.priority}${r.id === state.selectedRegionId ? ' selected' : ''}`;
      li.dataset.regionId = r.id;
      const px = G.denormalizeRect(r, state.imgW, state.imgH);
      li.innerHTML = `
        <div class="ri-head">
          <span class="priority-tag ${r.priority}">${r.priority === 'required' ? '必须' : '尽量'}</span>
          <input class="ri-label" value="${escapeHtml(r.label)}" />
        </div>
        <div class="ri-meta">
          原图坐标 x:${Math.round(px.x)} y:${Math.round(px.y)} w:${Math.round(px.w)} h:${Math.round(px.h)}<br/>
          归一化 x:${r.x.toFixed(3)} y:${r.y.toFixed(3)} w:${r.w.toFixed(3)} h:${r.h.toFixed(3)}
        </div>
        <div class="ri-select">
          <label class="hint">级别</label>
          <select>
            <option value="required" ${r.priority === 'required' ? 'selected' : ''}>必须保留</option>
            <option value="preferred" ${r.priority === 'preferred' ? 'selected' : ''}>尽量保留</option>
          </select>
        </div>`;
      li.addEventListener('click', () => {
        state.selectedRegionId = r.id;
        renderAll();
      });
      li.querySelector('input.ri-label').addEventListener('change', (e) => {
        r.label = e.target.value.trim() || r.label;
        scheduleAutosave();
        draw();
      });
      li.querySelector('select').addEventListener('change', (e) => {
        r.priority = e.target.value;
        onRegionsChanged();
      });
      ul.appendChild(li);
    });
  }

  $('deleteRegionBtn').addEventListener('click', () => {
    if (!state.selectedRegionId) return toast('请先在画布或列表中选中一个关注区', 'error');
    state.project.regions = state.project.regions.filter((r) => r.id !== state.selectedRegionId);
    state.selectedRegionId = null;
    onRegionsChanged();
  });

  // ---------- 侧栏：目标尺寸 ----------
  function currentTarget() {
    return state.project.targets.find((t) => t.id === state.currentTargetId) || state.project.targets[0];
  }

  function renderTargetList() {
    const ul = $('targetList');
    ul.innerHTML = '';
    state.project.targets.forEach((t) => {
      const analysis = computeAnalysis(t);
      const li = document.createElement('li');
      li.className = 'target-item' + (t.id === state.currentTargetId ? ' active' : '');
      li.dataset.targetId = t.id;
      const badges = targetBadges(t, analysis);
      li.innerHTML = `
        <div class="ti-head">
          <div>
            <div class="ti-name">${escapeHtml(t.name)}</div>
            <div class="ti-size">${t.width} × ${t.height}（${(t.width / t.height).toFixed(2)}:1）· ${t.outputMode === 'pad' ? '带留白' : '裁切'}</div>
          </div>
          <div class="ti-actions">
            <button class="icon-btn" data-act="dup" title="复制尺寸">⧉</button>
            <button class="icon-btn" data-act="del" title="删除尺寸">✕</button>
          </div>
        </div>
        <div class="ti-badges">${badges}</div>`;
      li.addEventListener('click', (e) => {
        if (e.target.closest('.ti-actions')) return;
        state.currentTargetId = t.id;
        state.selectedRegionId = null;
        renderAll();
      });
      li.querySelector('[data-act="del"]').addEventListener('click', () => {
        if (state.project.targets.length <= 1) return toast('至少保留一个目标尺寸', 'error');
        state.project.targets = state.project.targets.filter((x) => x.id !== t.id);
        delete state.analysisCache[t.id];
        if (state.currentTargetId === t.id) state.currentTargetId = state.project.targets[0].id;
        renderAll();
        scheduleAutosave();
      });
      li.querySelector('[data-act="dup"]').addEventListener('click', () => {
        const copy = makeTarget({ ...t, name: t.name + ' 副本' });
        state.project.targets.push(copy);
        renderAll();
        scheduleAutosave();
      });
      ul.appendChild(li);
    });
  }

  function targetBadges(t, analysis) {
    const out = [];
    if (t.locked && t.manualCrop) out.push('<span class="badge locked">🔒 已锁定</span>');
    if (t.outputMode === 'pad') {
      out.push(`<span class="badge ok">全保留</span>`);
      out.push(`<span class="badge warn">有效 ${(analysis.effectiveRatio * 100).toFixed(1)}%</span>`);
      return out.join('');
    }
    if (analysis.conflicts && analysis.conflicts.length) {
      out.push(`<span class="badge danger">${analysis.conflicts.length} 项冲突</span>`);
    }
    if (analysis.missingRequired.length) {
      out.push(`<span class="badge danger">缺 ${analysis.missingRequired.length} 个必须区</span>`);
    } else {
      out.push('<span class="badge ok">必须区全保留</span>');
    }
    if (analysis.stale) out.push('<span class="badge warn">关注区已改 · 待复核</span>');
    const prefFull = analysis.preferred.filter((p) => p.contained).length;
    if (analysis.preferred.length) {
      out.push(`<span class="badge">尽量区 ${prefFull}/${analysis.preferred.length} 完整</span>`);
    }
    return out.join('');
  }

  $('addTargetBtn').addEventListener('click', () => {
    const name = $('newTargetName').value.trim() || '自定义尺寸';
    const w = parseInt($('newTargetW').value, 10);
    const h = parseInt($('newTargetH').value, 10);
    if (!w || !h || w <= 0 || h <= 0) return toast('请输入有效的宽高像素', 'error');
    const t = makeTarget({ name, width: w, height: h });
    state.project.targets.push(t);
    state.currentTargetId = t.id;
    $('newTargetName').value = '';
    $('newTargetW').value = '';
    $('newTargetH').value = '';
    renderAll();
    scheduleAutosave();
  });

  // ---------- 右侧方案面板 ----------
  function renderRightPanel() {
    const t = currentTarget();
    if (!t) return;
    const analysis = computeAnalysis(t);
    $('currentTargetTitle').textContent = `裁切方案 · ${t.name}`;

    // 模式单选
    document.querySelectorAll('input[name="outMode"]').forEach((radio) => {
      radio.checked = radio.value === t.outputMode;
      radio.onchange = () => {
        t.outputMode = radio.value;
        invalidateAnalysis(t.id);
        renderAll();
        scheduleAutosave();
      };
    });
    $('padColor').value = state.padColor;
    $('padColor').onchange = (e) => {
      state.padColor = e.target.value;
      scheduleAutosave();
      renderRightPanel();
    };

    // 统计
    const ratio = analysis.effectiveRatio;
    const ratioEl = $('effectiveRatio');
    ratioEl.textContent = (ratio * 100).toFixed(1) + '%';
    const statBox = ratioEl.closest('.stat');
    statBox.classList.toggle('warn', t.outputMode === 'pad' && ratio < 0.75);
    statBox.classList.toggle('good', t.outputMode === 'crop');
    $('effectiveNote').textContent = t.outputMode === 'crop'
      ? '裁切模式：100% 为原图内容，无补边'
      : `补边占 ${((1 - ratio) * 100).toFixed(1)}%，不计入原图内容`;
    $('outputRes').textContent = `${t.width}×${t.height}`;
    $('outputModeNote').textContent = t.outputMode === 'pad'
      ? '带留白（全图 + 补边）'
      : t.locked && t.manualCrop ? '手动裁切（已锁定）' : '自动裁切';

    // 锁定
    const lockCheck = $('lockCheck');
    lockCheck.checked = !!(t.locked && t.manualCrop);
    lockCheck.disabled = t.outputMode === 'pad';
    lockCheck.onchange = () => {
      if (lockCheck.checked) {
        if (!t.manualCrop) t.manualCrop = G.roundRect(G.normalizeRect(analysis.crop, state.imgW, state.imgH), 6);
        t.locked = true;
        toast('已锁定当前裁切位置', 'success');
      } else {
        t.locked = false;
        t.manualCrop = null;
      }
      invalidateAnalysis(t.id);
      renderAll();
      scheduleAutosave();
    };
    $('resetAutoBtn').onclick = () => {
      t.locked = false;
      t.manualCrop = null;
      invalidateAnalysis(t.id);
      renderAll();
      scheduleAutosave();
      toast('已恢复自动裁切', 'success');
    };

    renderStatusBlock(t, analysis);
    renderRetentionList(t, analysis);
    renderCoordBox(t, analysis);
  }

  function renderStatusBlock(t, analysis) {
    const box = $('statusBlock');
    box.innerHTML = '';
    const push = (cls, title, html) => {
      const div = document.createElement('div');
      div.className = 'status-msg ' + cls;
      div.innerHTML = `<div class="sm-title">${title}</div>${html || ''}`;
      box.appendChild(div);
    };

    if (t.outputMode === 'pad') {
      push('ok', '带留白模式：整张原图完整保留，不存在裁切冲突',
        `所有关注区 100% 保留；有效图像占比 <b>${(analysis.effectiveRatio * 100).toFixed(1)}%</b>，其余为补边色。`);
      return;
    }

    // 冲突明细（说清是哪几个区域冲突）
    if (analysis.conflicts.length) {
      const lines = analysis.conflicts.map((cf) => {
        if (cf.type === 'oversize') {
          const r = regionLabel(cf.regionId);
          return `<li><b>「${r}」</b>比裁切框还大，任何位置都无法完整保留，请缩小关注区或换带留白</li>`;
        }
        return `<li><b>「${regionLabel(cf.a)}」</b> 与 <b>「${regionLabel(cf.b)}」</b> 无法同时完整保留（间距超过 ${t.width}×${t.height} 的取景范围）</li>`;
      });
      push('danger', `存在 ${analysis.conflicts.length} 项保留冲突`, `<ul>${lines.join('')}</ul>`);
      const kept = analysis.containedRequired.map(regionLabel).join('、') || '无';
      const missing = analysis.missingRequired.map(regionLabel).join('、') || '无';
      push('warn', '当前自动方案的取舍',
        `<ul><li>完整保留：<b>${kept}</b></li><li>被截掉：<b>${missing}</b></li></ul>
         建议：① 切换「带留白」全保留；② 用裁切框工具手动改位置；③ 修改关注区级别后重算。`);
    } else if (analysis.stale) {
      push('warn', '锁定的手动裁切已过期',
        `关注区调整后，该锁定框已无法完整保留：<b>${analysis.missingRequired.map(regionLabel).join('、')}</b>。锁定保护了你的手动位置未被覆盖，请手动复核或「恢复自动」。`);
    } else {
      push('ok', '所有必须保留区均可完整保留',
        `自动方案已把 ${analysis.containedRequired.length} 个必须区全部纳入裁切框。`);
    }
  }

  function renderRetentionList(t, analysis) {
    const ul = $('retentionList');
    ul.innerHTML = '';
    state.project.regions.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'retention-item';
      let ratio;
      let statusText;
      let cls;
      if (t.outputMode === 'pad') {
        ratio = 1; statusText = '完整保留 100%'; cls = 'full';
      } else {
        const info = r.priority === 'required'
          ? null
          : analysis.preferred.find((p) => p.id === r.id);
        if (r.priority === 'required') {
          const full = analysis.containedRequired.includes(r.id);
          ratio = full ? 1 : retainedRatio(analysis.crop, r);
          statusText = full ? '完整保留 100%' : `已截 ${((1 - ratio) * 100).toFixed(0)}%`;
          cls = full ? 'full' : 'gone';
        } else {
          ratio = info ? info.ratio : 0;
          statusText = info && info.contained ? '完整保留 100%' : `保留 ${(ratio * 100).toFixed(0)}%`;
          cls = info && info.contained ? 'full' : ratio > 0.01 ? 'partial' : 'gone';
        }
      }
      const col = REGION_COLORS[r.priority].stroke;
      li.innerHTML = `
        <div style="flex:1;min-width:0">
          <div class="ri2-name">
            <span class="swatch" style="background:${col}"></span>
            <span class="txt">${escapeHtml(r.label)}</span>
            <span class="priority-tag ${r.priority}">${r.priority === 'required' ? '必须' : '尽量'}</span>
          </div>
          <div class="ratio-bar"><i style="width:${(ratio * 100).toFixed(1)}%;background:${col}"></i></div>
        </div>
        <span class="ri2-status ${cls}">${statusText}</span>`;
      ul.appendChild(li);
    });
  }

  function retainedRatio(cropPx, regionNorm) {
    const px = G.denormalizeRect(regionNorm, state.imgW, state.imgH);
    const overlap = G.intersectionArea(cropPx, px);
    return G.area(px) > 0 ? G.clamp(overlap / G.area(px), 0, 1) : 1;
  }

  function renderCoordBox(t, analysis) {
    if (t.outputMode === 'pad') {
      const ir = analysis.padLayout.imageRect;
      $('coordBox').textContent =
        `模式: 带留白（全图等比居中）\n` +
        `输出画布: ${t.width} × ${t.height} px\n` +
        `原图绘制区: x:${ir.x} y:${ir.y} w:${ir.w} h:${ir.h} px\n` +
        `缩放比: ${analysis.padLayout.scale.toFixed(5)}  有效占比: ${(analysis.effectiveRatio * 100).toFixed(2)}%`;
      return;
    }
    const c = analysis.crop;
    const n = G.normalizeRect(c, state.imgW, state.imgH);
    $('coordBox').textContent =
      `模式: ${t.locked && t.manualCrop ? '手动裁切（锁定）' : '自动裁切'}\n` +
      `原图 px : x:${Math.round(c.x)} y:${Math.round(c.y)} w:${Math.round(c.w)} h:${Math.round(c.h)}\n` +
      `归一化  : x:${n.x.toFixed(4)} y:${n.y.toFixed(4)} w:${n.w.toFixed(4)} h:${n.h.toFixed(4)}\n` +
      `输出尺寸: ${t.width} × ${t.height} px（由裁切框重采样）`;
  }

  function regionLabel(id) {
    const r = state.project.regions.find((x) => x.id === id);
    return r ? r.label : id;
  }

  // ---------- 顶部操作 ----------
  $('recalcAllBtn').addEventListener('click', () => {
    let skipped = 0;
    state.project.targets.forEach((t) => {
      if (t.locked && t.manualCrop) { skipped++; return; }
      invalidateAnalysis(t.id);
    });
    renderAll();
    scheduleAutosave();
    toast(skipped ? `已重算未锁定尺寸，${skipped} 个锁定项被保护` : '全部尺寸已按最新关注区重算',
      skipped ? 'warn' : 'success');
  });

  $('exportOneBtn').addEventListener('click', () => {
    const t = currentTarget();
    const analysis = computeAnalysis(t);
    const out = Exporter.renderOutput(state.sourceCanvas, t, analysis, state.padColor);
    const suffix = t.outputMode === 'pad' ? '_pad' : '_crop';
    Exporter.downloadCanvas(out, `${Exporter.safeName(state.sourceName)}_${Exporter.safeName(t.name)}${suffix}.png`);
    toast(`已导出 ${t.width}×${t.height} 实际分辨率图片`, 'success');
  });

  $('exportAllBtn').addEventListener('click', async () => {
    const items = [];
    state.project.targets.forEach((t) => {
      const analysis = computeAnalysis(t);
      const out = Exporter.renderOutput(state.sourceCanvas, t, analysis, state.padColor);
      const suffix = t.outputMode === 'pad' ? '_pad' : '_crop';
      items.push({ canvas: out, filename: `${Exporter.safeName(state.sourceName)}_${Exporter.safeName(t.name)}${suffix}.png`, type: 'image/png' });
    });
    await Exporter.exportAllImages(items);
    toast(`已顺序导出 ${items.length} 张实际分辨率图片`, 'success');
  });

  $('exportFramesBtn').addEventListener('click', () => {
    const entries = state.project.targets.map((t) =>
      Exporter.buildFrameEntry(t, computeAnalysis(t), state.project.regions, state.imgW, state.imgH, state.padColor));
    Exporter.exportFramesJSON(entries, state.imgW, state.imgH, state.sourceName);
    toast('框位置清单 JSON 已导出（含像素/归一化坐标与保留比例）', 'success');
  });

  $('saveProjectBtn').addEventListener('click', () => {
    // 导出项目保留当前位图（无损 PNG dataURL）
    const dataUrl = state.sourceCanvas.toDataURL('image/png');
    Storage.downloadJSON(`smart-crop-project-${Date.now()}.json`, state.project, dataUrl);
    toast('项目 JSON 已保存（含原图，可迁移后继续编辑）', 'success');
  });

  $('importProjectInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = await Storage.readProjectFile(file);
      await applyImportedProject(parsed);
      toast('项目已载入，可继续编辑', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
    e.target.value = '';
  });

  function applyImportedProject(parsed) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const p = parsed.project;
        state.sourceCanvas = c;
        state.imgW = img.naturalWidth;
        state.imgH = img.naturalHeight;
        state.sourceName = p.sourceName || 'imported';
        state.project = {
          id: p.id || uid('p'),
          sourceName: state.sourceName,
          regions: (p.regions || []).map(makeRegion),
          targets: (p.targets && p.targets.length ? p.targets : DEFAULT_TARGETS).map(makeTarget),
        };
        state.currentTargetId = state.project.targets[0].id;
        state.selectedRegionId = null;
        state.analysisCache = {};
        $('stageEmpty').style.display = 'none';
        invalidateAllAnalysis();
        syncPosterSelect();
        renderAll();
        scheduleAutosave();
        resolve();
      };
      img.onerror = () => reject(new Error('项目内嵌图片解码失败'));
      img.src = parsed.image;
    });
  }

  $('uploadInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadUploadedImage(file);
    e.target.value = '';
  });

  // ---------- 自动保存 ----------
  function scheduleAutosave() {
    clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      // 自动保存走 JPEG 压缩控制 localStorage 体积；项目导出仍用 PNG 无损
      const jpeg = Storage.canvasToJPEG(state.sourceCanvas, 0.82);
      let r = Storage.autosave(state.project, jpeg);
      if (!r.ok && r.reason.includes('配额')) {
        const small = Storage.canvasToJPEG(state.sourceCanvas, 0.6);
        r = Storage.autosave(state.project, small);
      }
      if (!r.ok) toast('自动保存失败：' + r.reason, 'error');
    }, AUTOSAVE_DELAY);
  }

  function restoreAutosave() {
    const parsed = Storage.loadAutosave();
    if (!parsed) return false;
    try {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const p = parsed.project;
        state.sourceCanvas = c;
        state.imgW = img.naturalWidth;
        state.imgH = img.naturalHeight;
        state.sourceName = p.sourceName || 'restored';
        state.project = {
          id: p.id || uid('p'),
          sourceName: state.sourceName,
          regions: (p.regions || []).map(makeRegion),
          targets: (p.targets || DEFAULT_TARGETS).map(makeTarget),
        };
        state.currentTargetId = state.project.targets[0].id;
        state.analysisCache = {};
        $('stageEmpty').style.display = 'none';
        syncPosterSelect();
        renderAll();
        toast('已恢复上次未完成的项目（自动保存）', 'success');
      };
      img.onerror = () => { Storage.clearAutosave(); initDefault(); };
      img.src = parsed.image;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 渲染聚合 ----------
  function renderSidebar() {
    renderRegionList();
    renderTargetList();
  }

  function renderAll() {
    if (!state.project) return;
    renderSidebar();
    renderRightPanel();
    draw();
    const t = currentTarget();
    $('stageInfo').textContent = t
      ? `原图 ${state.imgW}×${state.imgH} · 当前：${t.name} ${t.width}×${t.height} · 工具：${toolLabel(state.tool)}`
      : '';
  }

  function toolLabel(tool) {
    return { select: '选择', required: '框选必须区', preferred: '框选尽量区', crop: '拖裁切框' }[tool] || tool;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast show ' + (kind || '');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = 'toast'; }, 2600);
  }

  window.addEventListener('resize', () => draw());

  // ---------- 初始化 ----------
  function fillPosterSelect() {
    const select = $('posterSelect');
    select.innerHTML = '';
    Posters.specs.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
    });
    select.addEventListener('change', () => {
      const spec = Posters.specs.find((s) => s.id === select.value);
      if (spec) loadPoster(spec);
    });
  }

  /** 让顶栏下拉与当前素材一致（恢复项目 / 载入项目后调用） */
  function syncPosterSelect() {
    const select = $('posterSelect');
    const exists = [...select.options].some((o) => o.value === state.sourceName);
    if (exists) {
      select.value = state.sourceName;
    } else {
      // 上传图 / 项目迁移来的未知素材：加一个占位项
      const opt = document.createElement('option');
      opt.value = state.sourceName;
      opt.textContent = '自定义素材 · ' + state.sourceName;
      select.appendChild(opt);
      select.value = state.sourceName;
    }
  }

  function initDefault() {
    fillPosterSelect();
    loadPoster(Posters.specs[0]);
  }

  function init() {
    fillPosterSelect();
    if (!restoreAutosave()) {
      initDefault();
    }
    // restoreAutosave 内部异步完成后会调用 syncPosterSelect
  }

  init();
})();
