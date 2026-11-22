/* app.js — 主应用：状态管理与全部 UI 接线 */
(function () {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------- 状态 ---------------- */
  const state = {
    fileName: '',
    width: 0,
    height: 0,
    originalCanvas: null,     // 原图（不可变）
    currentCanvas: null,      // 当前版本（实时修正结果）
    originalBuffer: null,     // 原图 ImageData
    currentBuffer: null,      // 当前 ImageData
    protection: null,         // ProtectionMask
    analysisOriginal: null,
    analysisCurrent: null,
    sensitivity: 2.5,
    params: {
      vStrength: 0.8, vWidth: 16,
      hStrength: 0.8, hWidth: 16,
    },
    live: true,
    view: { mode: 'both', compare: 'split', splitAt: 0.5, panX: 0, panY: 0, zoom: 1 },
    protectTool: null,        // null=平移, brush/rect/eraser
    brushSize: 24,
  };

  const view = new TiledView($('#stage-canvas'), $('#canvas-wrap'));
  let recomputeTimer = null;

  /* ---------------- 工具 ---------------- */
  function setStatus(msg) { $('#status-msg').textContent = msg; }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function bufferToCanvas(buf) {
    const c = document.createElement('canvas');
    c.width = buf.width;
    c.height = buf.height;
    c.getContext('2d').putImageData(toImageData(buf), 0, 0);
    return c;
  }

  /** 统一构造真正的 ImageData（Node/测试环境可能只给普通缓冲） */
  function toImageData(buf) {
    if (typeof ImageData !== 'undefined' && buf instanceof ImageData) return buf;
    return new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height);
  }

  function canvasToBuffer(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function baseName(fileName) {
    return (fileName || 'texture').replace(/\.[^.]+$/, '');
  }

  /* ---------------- 载入图片 ---------------- */
  function loadImageFile(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      ingestImage(img, file.name);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatus('图片解码失败');
    };
    img.src = url;
  }

  function ingestImage(imgOrCanvas, fileName) {
    // 兼容 HTMLImageElement / HTMLCanvasElement / ImageData（程序化示例）
    const W = imgOrCanvas.width || imgOrCanvas.naturalWidth;
    const H = imgOrCanvas.height || imgOrCanvas.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (imgOrCanvas.data && imgOrCanvas.data instanceof Uint8ClampedArray) {
      ctx.putImageData(toImageData(imgOrCanvas), 0, 0);
    } else {
      ctx.drawImage(imgOrCanvas, 0, 0);
    }

    state.fileName = fileName || 'sample.png';
    state.width = W;
    state.height = H;
    state.originalCanvas = canvas;
    state.originalBuffer = ctx.getImageData(0, 0, W, H);
    state.currentBuffer = toImageData({
      data: new Uint8ClampedArray(state.originalBuffer.data), width: W, height: H,
    });
    state.currentCanvas = bufferToCanvas(state.currentBuffer);
    state.protection = new ProtectionMask(W, H);

    state.analysisOriginal = SeamAnalysis.analyzeSeams(state.originalBuffer, state.sensitivity);
    state.analysisCurrent = SeamAnalysis.analyzeSeams(state.currentBuffer, state.sensitivity);

    // 修正宽度上限不超过图像短边的一半
    const maxW = Math.max(2, Math.floor(Math.min(W, H) / 2));
    ['#v-width', '#h-width'].forEach((sel) => {
      const el = $(sel);
      el.max = maxW;
      el.value = Math.min(+el.value || 16, maxW);
      state.params[el.id === '#v-width' ? 'vWidth' : 'hWidth'] = +el.value;
      $(el.id === '#v-width' ? '#v-width-val' : '#h-width-val').textContent = `${el.value}px`;
    });

    $('#empty-hint').classList.add('hidden');
    ['#export-image-btn', '#export-diag-btn', '#save-project-btn',
     '#save-project-btn-2', '#export-image-btn-2', '#export-diag-btn-2']
      .forEach((sel) => { $(sel).disabled = false; });

    view.setSource(state.currentCanvas);
    view.setOriginalSource(state.originalCanvas);
    view.setMaskCanvas(state.protection.maskCanvas);
    view.setAnalysis(getDisplayedAnalysis());
    view.resize();
    view.fitZoom();
    renderAll();
    setStatus(`已载入 ${state.fileName}（${W}×${H}），分析基于原始分辨率 ${W}×${H} 像素`);
  }

  function getDisplayedAnalysis() {
    return $('#analysis-source').value === 'original'
      ? state.analysisOriginal
      : state.analysisCurrent;
  }

  /* ---------------- 修正管线 ---------------- */
  /** 项目恢复/外部数据进入前，把参数钳制到合法范围，避免 NaN/越界 */
  function sanitizeParams(p) {
    const num = (v, lo, hi, dft) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dft;
    };
    return {
      vStrength: num(p.vStrength, 0, 1, 0.8),
      vWidth: Math.round(num(p.vWidth, 1, 512, 16)),
      hStrength: num(p.hStrength, 0, 1, 0.8),
      hWidth: Math.round(num(p.hWidth, 1, 512, 16)),
    };
  }

  function recomputeCorrection() {
    if (!state.originalBuffer) return;
    state.params = sanitizeParams(state.params);
    const p = state.params;
    const mask = state.protection ? state.protection.maskData : null;
    state.currentBuffer = SeamCorrection.applyCorrection(state.originalBuffer, p, mask);
    state.currentCanvas = bufferToCanvas(state.currentBuffer);
    state.analysisCurrent = SeamAnalysis.analyzeSeams(state.currentBuffer, state.sensitivity);
    view.setSource(state.currentCanvas);
    view.setOriginalSource(state.originalCanvas);
    view.setAnalysis(getDisplayedAnalysis());
    view.render();
    renderDiagnosis();
    renderMetrics();
    renderParamDump();
  }
  const scheduleRecompute = debounce(recomputeCorrection, 120);

  /* ---------------- 诊断面板 ---------------- */
  function edgeStatsHtml(r, label) {
    return `
      <div>${label}颜色差 均值/最大</div><div><b>${r.meanColor}</b> / <b>${r.maxColor}</b></div>
      <div>亮度走势差 均值/最大</div><div><b>${r.meanTrend}</b> / <b>${r.maxTrend}</b></div>
      <div>判定阈值 颜色/走势</div><div>${r.thresholdColor} / ${r.thresholdTrend}</div>
      <div>内部噪声地板</div><div>${r.baselineColor} / ${r.baselineTrend}</div>`;
  }

  function segListHtml(segments, axis) {
    if (!segments.length) return '<div class="seg-empty">✓ 未发现超过阈值的异常边段</div>';
    return segments.map((s, i) => `
      <div class="seg-item ${axis}" data-axis="${axis}" data-i="${i}">
        <div class="seg-head">
          <span class="seg-name">#${i + 1} 行/列 ${s.start}–${s.end}（${s.length}px）</span>
          <span class="seg-score">评分 ${s.score.toFixed(2)}</span>
        </div>
        <div class="seg-detail">
          颜色差 max ${s.maxColor}${s.colorFlag ? ' ⚠' : ''} ·
          走势差 max ${s.maxTrend}${s.trendFlag ? ' ⚠' : ''}
        </div>
      </div>`).join('');
  }

  function renderDiagnosis() {
    const a = getDisplayedAnalysis();
    if (!a) return;
    $('#v-stats').innerHTML = edgeStatsHtml(a.vertical, '竖向');
    $('#h-stats').innerHTML = edgeStatsHtml(a.horizontal, '横向');
    $('#v-segments').innerHTML = segListHtml(a.vertical.segments, 'v');
    $('#h-segments').innerHTML = segListHtml(a.horizontal.segments, 'h');

    $('#corner-grid').innerHTML = a.corners.map((c, i) => `
      <div class="corner-cell ${c.bad ? 'bad' : ''}" data-corner="${i}">
        <div class="c-name">${c.name}${c.bad ? ' ⚠' : ''}</div>
        <div class="c-val">角点评分 ${c.score.toFixed(2)}<br>
          竖: 色${c.vColor} 势${c.vTrend}<br>横: 色${c.hColor} 势${c.hTrend}</div>
      </div>`).join('');

    const totalSegs = a.vertical.segments.length + a.horizontal.segments.length;
    const badCorners = a.corners.filter((c) => c.bad).length;
    const badge = $('#analysis-badge');
    if (totalSegs === 0 && badCorners === 0) {
      badge.className = 'badge ok';
      badge.textContent = '✓ 可平铺（未检出接缝）';
    } else {
      badge.className = 'badge bad';
      badge.textContent = `⚠ ${totalSegs} 个异常边段 · ${badCorners} 个异常角点`;
    }

    // 点击边段/角点 → 平移到对应原图位置
    $$('.seg-item').forEach((el) => el.addEventListener('click', () => {
      const axis = el.dataset.axis;
      const seg = a[axis === 'v' ? 'vertical' : 'horizontal'].segments[+el.dataset.i];
      const mid = (seg.start + seg.end) / 2;
      if (axis === 'v') view.centerOnImagePoint(0, mid);
      else view.centerOnImagePoint(mid, 0);
      view.render();
    }));
    $$('.corner-cell').forEach((el) => el.addEventListener('click', () => {
      const c = a.corners[+el.dataset.corner];
      const x = c.cornerX < 0 ? state.width : 0;
      const y = c.cornerY < 0 ? state.height : 0;
      view.centerOnImagePoint(x, y);
      view.render();
    }));
  }

  /* ---------------- 对比指标 ---------------- */
  function deltaHtml(before, after, lowerBetter) {
    const d = after - before;
    const pct = before === 0 ? (after === 0 ? 0 : 100) : (d / before * 100);
    let cls = 'delta-flat';
    if (Math.abs(d) >= 0.01) cls = (d < 0) === lowerBetter ? 'delta-down' : 'delta-up';
    const arrow = Math.abs(d) < 0.01 ? '＝' : (d < 0 ? '↓' : '↑');
    return `<td class="${cls}">${arrow} ${Math.abs(d).toFixed(2)}（${Math.abs(pct).toFixed(1)}%）</td>`;
  }

  function renderMetrics() {
    if (!state.analysisOriginal) return;
    const o = state.analysisOriginal, n = state.analysisCurrent;
    const rows = [
      ['竖向 · 颜色差均值', o.vertical.meanColor, n.vertical.meanColor, true],
      ['竖向 · 颜色差最大', o.vertical.maxColor, n.vertical.maxColor, true],
      ['竖向 · 走势差均值', o.vertical.meanTrend, n.vertical.meanTrend, true],
      ['横向 · 颜色差均值', o.horizontal.meanColor, n.horizontal.meanColor, true],
      ['横向 · 颜色差最大', o.horizontal.maxColor, n.horizontal.maxColor, true],
      ['横向 · 走势差均值', o.horizontal.meanTrend, n.horizontal.meanTrend, true],
    ];
    $('#metric-table tbody').innerHTML = rows.map(([name, b, a2, lb]) => `
      <tr><td>${name}</td><td>${b.toFixed(2)}</td><td>${a2.toFixed(2)}</td>${deltaHtml(b, a2, lb)}</tr>
    `).join('');
  }

  function renderParamDump() {
    $('#param-dump').textContent = JSON.stringify({
      sensitivity: state.sensitivity,
      correction: state.params,
      protectShapes: state.protection ? state.protection.shapes.length : 0,
      view: {
        mode: view.mode, zoom: Math.round(view.zoom * 1000) / 1000,
        panX: Math.round(view.panX), panY: Math.round(view.panY),
      },
    }, null, 2);
  }

  function renderReadout() {
    if (!state.originalCanvas) { $('#view-readout').textContent = '未载入图片'; return; }
    $('#view-readout').textContent =
      `原图 ${state.width}×${state.height} · 缩放 ${(view.zoom * 100).toFixed(0)}% · ` +
      `平移 (${view.panX.toFixed(0)}, ${view.panY.toFixed(0)}) · 模式 ${view.mode}`;
  }

  function renderAll() {
    view.render();
    renderDiagnosis();
    renderMetrics();
    renderParamDump();
    renderReadout();
  }

  /* ---------------- 视图交互 ---------------- */
  function bindViewControls() {
    $$('#repeat-mode-group .tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('#repeat-mode-group .tool-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        view.setMode(btn.dataset.mode);
        view.invalidateAtlas();
        view.render();
        renderReadout();
      });
    });

    $('#zoom-in-btn').addEventListener('click', () => { view.zoomBy(1.25); view.render(); renderReadout(); });
    $('#zoom-out-btn').addEventListener('click', () => { view.zoomBy(1 / 1.25); view.render(); renderReadout(); });
    $('#zoom-fit-btn').addEventListener('click', () => { view.fitZoom(); view.render(); renderReadout(); });
    $('#zoom-100-btn').addEventListener('click', () => {
      view.setZoom(1); view.render(); renderReadout();
    });
    $('#center-v-btn').addEventListener('click', () => { view.centerSeam('v'); view.render(); });
    $('#center-h-btn').addEventListener('click', () => { view.centerSeam('h'); view.render(); });
    $('#center-both-btn').addEventListener('click', () => { view.centerSeam('both'); view.render(); });
    $('#center-reset-btn').addEventListener('click', () => { view.resetPan(); view.render(); renderReadout(); });

    $('#toggle-boundaries').addEventListener('change', (e) => {
      view.showBoundaries = e.target.checked; view.render();
    });
    $('#toggle-markers').addEventListener('change', (e) => {
      view.showMarkers = e.target.checked; view.render();
    });
    $('#toggle-protect-overlay').addEventListener('change', (e) => {
      view.showProtect = e.target.checked; view.render();
    });

    $$('[data-compare]').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('[data-compare]').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        view.setCompare(btn.dataset.compare);
        view.render();
      });
    });
    $('#split-pos').addEventListener('input', (e) => {
      const v = +e.target.value / 100;
      $('#split-pos-val').textContent = `${e.target.value}%`;
      view.setSplitAt(v);
      view.render();
    });

    // 滚轮缩放（光标位置为不动点）
    const wrap = $('#canvas-wrap');
    wrap.addEventListener('wheel', (e) => {
      if (!state.originalCanvas) return;
      e.preventDefault();
      const rect = view.canvas.getBoundingClientRect();
      const ax = e.clientX - rect.left, ay = e.clientY - rect.top;
      view.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, ax, ay);
      view.render();
      renderReadout();
    }, { passive: false });

    // 平移 / 保护区绘制
    let drag = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (!state.originalCanvas) return;
      wrap.setPointerCapture(e.pointerId);
      const p = view.screenToImage(e.clientX, e.clientY);
      if (state.protectTool) {
        wrap.classList.add('protecting');
        drag = { kind: 'protect', shape: state.protection.beginShape(
          state.protectTool, p.x, p.y, state.brushSize) };
      } else {
        wrap.classList.add('dragging');
        drag = { kind: 'pan', startX: e.clientX, startY: e.clientY, panX: view.panX, panY: view.panY };
      }
    });
    wrap.addEventListener('pointermove', (e) => {
      const p = view.screenToImage(e.clientX, e.clientY);
      if (p) {
        $('#cursor-readout').textContent =
          `原图坐标 (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) / ${state.width}×${state.height}`;
      }
      if (!drag) return;
      if (drag.kind === 'pan') {
        view.panX = drag.panX + (e.clientX - drag.startX);
        view.panY = drag.panY + (e.clientY - drag.startY);
        view.render();
        renderReadout();
      } else if (drag.shape.tool !== 'rect') {
        state.protection.extendShape(drag.shape, p.x, p.y);
        state.protection.rasterize();
        view.render();
      }
    });
    const endPointer = (e) => {
      if (!drag) return;
      if (drag.kind === 'protect') {
        const p = view.screenToImage(e.clientX, e.clientY);
        if (drag.shape.tool === 'rect') state.protection.extendShape(drag.shape, p.x, p.y);
        state.protection.endShape(drag.shape);
        view.setMaskCanvas(state.protection.maskCanvas);
        view.render();
        scheduleRecompute();
        renderParamDump();
      }
      wrap.classList.remove('dragging', 'protecting');
      drag = null;
    };
    wrap.addEventListener('pointerup', endPointer);
    wrap.addEventListener('pointercancel', endPointer);

    // 快捷键
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === '+' || e.key === '=') { view.zoomBy(1.25); view.render(); renderReadout(); }
      if (e.key === '-') { view.zoomBy(1 / 1.25); view.render(); renderReadout(); }
      if (e.key === '0') { view.fitZoom(); view.render(); renderReadout(); }
      if (e.key === 'Escape') selectProtectTool(null);
    });

    new ResizeObserver(() => { view.resize(); renderReadout(); }).observe(wrap);
  }

  /* ---------------- 保护区工具 ---------------- */
  function selectProtectTool(tool) {
    state.protectTool = tool;
    $$('[data-protect-tool]').forEach((b) =>
      b.classList.toggle('active', b.dataset.protectTool === tool));
    $('#canvas-wrap').classList.toggle('protecting', !!tool);
  }

  function bindProtectionControls() {
    $$('[data-protect-tool]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selectProtectTool(state.protectTool === btn.dataset.protectTool
          ? null : btn.dataset.protectTool);
      });
    });
    $('#brush-size').addEventListener('input', (e) => {
      state.brushSize = +e.target.value;
      $('#brush-size-val').textContent = `${e.target.value}px`;
    });
    $('#protect-clear-btn').addEventListener('click', () => {
      if (!state.protection) return;
      state.protection.clear();
      view.setMaskCanvas(state.protection.maskCanvas);
      view.render();
      scheduleRecompute();
    });
  }

  /* ---------------- 修正控件 ---------------- */
  function bindCorrectionControls() {
    const bindSlider = (sliderId, valId, key, suffix, isPercent) => {
      $(sliderId).addEventListener('input', (e) => {
        const v = +e.target.value;
        state.params[key] = isPercent ? v / 100 : v;
        $(valId).textContent = isPercent ? `${v}%` : `${v}px`;
        if (state.live) scheduleRecompute();
        renderParamDump();
      });
    };
    bindSlider('#v-strength', '#v-strength-val', 'vStrength', '%', true);
    bindSlider('#v-width', '#v-width-val', 'vWidth', 'px', false);
    bindSlider('#h-strength', '#h-strength-val', 'hStrength', '%', true);
    bindSlider('#h-width', '#h-width-val', 'hWidth', 'px', false);

    $('#live-correction').addEventListener('change', (e) => {
      state.live = e.target.checked;
      if (state.live) scheduleRecompute();
    });
    $('#apply-correction-btn').addEventListener('click', () => {
      recomputeCorrection();
      setStatus('已应用修正并重新诊断');
    });
    $('#reset-correction-btn').addEventListener('click', () => {
      if (!state.originalBuffer) return;
      state.currentBuffer = toImageData({
        data: new Uint8ClampedArray(state.originalBuffer.data),
        width: state.width, height: state.height,
      });
      state.currentCanvas = bufferToCanvas(state.currentBuffer);
      state.analysisCurrent = SeamAnalysis.analyzeSeams(state.currentBuffer, state.sensitivity);
      view.setSource(state.currentCanvas);
      view.setOriginalSource(state.originalCanvas);
      view.setAnalysis(getDisplayedAnalysis());
      renderAll();
      setStatus('已回到原始版本（参数与保护区保留）');
    });

    $('#sensitivity').addEventListener('input', (e) => {
      state.sensitivity = +e.target.value;
      $('#sensitivity-val').textContent = `${(+e.target.value).toFixed(1)}×`;
      if (!state.originalBuffer) return;
      state.analysisOriginal = SeamAnalysis.analyzeSeams(state.originalBuffer, state.sensitivity);
      state.analysisCurrent = SeamAnalysis.analyzeSeams(state.currentBuffer, state.sensitivity);
      view.setAnalysis(getDisplayedAnalysis());
      renderDiagnosis();
      renderParamDump();
    });
    $('#analysis-source').addEventListener('change', () => {
      view.setAnalysis(getDisplayedAnalysis());
      renderDiagnosis();
      view.render();
    });
  }

  /* ---------------- 导出 / 项目 ---------------- */
  function stripTypedArrays(r) {
    const pick = (o) => ({
      thresholdColor: o.thresholdColor, thresholdTrend: o.thresholdTrend,
      baselineColor: o.baselineColor, baselineTrend: o.baselineTrend,
      meanColor: o.meanColor, meanLuma: o.meanLuma, meanTrend: o.meanTrend,
      maxColor: o.maxColor, maxTrend: o.maxTrend,
      segments: o.segments,
    });
    return {
      width: r.width, height: r.height, sensitivity: r.sensitivity,
      baselines: r.baselines,
      vertical: pick(r.vertical), horizontal: pick(r.horizontal), corners: r.corners,
    };
  }

  function bindExport() {
    const exportImage = () => state.currentCanvas.toBlob((blob) => {
      downloadBlob(blob, `${baseName(state.fileName)}_corrected.png`);
    }, 'image/png');
    const exportDiag = () => {
      const report = {
        tool: 'Seam Inspector',
        exportedAt: new Date().toISOString(),
        source: state.fileName,
        imageSize: { width: state.width, height: state.height },
        note: '全部指标基于原始分辨率像素计算，与预览缩放/插值无关',
        original: stripTypedArrays(state.analysisOriginal),
        corrected: stripTypedArrays(state.analysisCurrent),
        correctionParams: state.params,
      };
      downloadBlob(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
        `${baseName(state.fileName)}_diagnosis.json`);
    };
    $('#export-image-btn').addEventListener('click', exportImage);
    $('#export-image-btn-2').addEventListener('click', exportImage);
    $('#export-diag-btn').addEventListener('click', exportDiag);
    $('#export-diag-btn-2').addEventListener('click', exportDiag);
  }

  function canvasToDataURL(canvas) {
    return canvas.toDataURL('image/png');
  }

  function saveProject() {
    const project = {
      format: 'seam-inspector-project',
      version: 1,
      fileName: state.fileName,
      sensitivity: state.sensitivity,
      params: state.params,
      live: state.live,
      view: {
        mode: view.mode, compare: view.compareMode, splitAt: view.splitAt,
        panX: view.panX, panY: view.panY, zoom: view.zoom,
        showBoundaries: view.showBoundaries, showMarkers: view.showMarkers,
        showProtect: view.showProtect,
      },
      protection: state.protection.toJSON(),
      sourceImage: canvasToDataURL(state.originalCanvas),
    };
    downloadBlob(new Blob([JSON.stringify(project)], { type: 'application/json' }),
      `${baseName(state.fileName)}.seam.json`);
    setStatus('项目已保存（含原图、保护区与全部参数）');
  }

  function loadProject(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = JSON.parse(reader.result);
        if (p.format !== 'seam-inspector-project') throw new Error('不是本工具的项目文件');
        const img = new Image();
        img.onload = () => {
          ingestImage(img, p.fileName || 'restored.png');
          // 恢复参数
          Object.assign(state.params, p.params);
          state.sensitivity = p.sensitivity;
          state.live = p.live !== false;
          $('#v-strength').value = Math.round(state.params.vStrength * 100);
          $('#v-strength-val').textContent = `${Math.round(state.params.vStrength * 100)}%`;
          $('#v-width').value = state.params.vWidth;
          $('#v-width-val').textContent = `${state.params.vWidth}px`;
          $('#h-strength').value = Math.round(state.params.hStrength * 100);
          $('#h-strength-val').textContent = `${Math.round(state.params.hStrength * 100)}%`;
          $('#h-width').value = state.params.hWidth;
          $('#h-width-val').textContent = `${state.params.hWidth}px`;
          $('#sensitivity').value = state.sensitivity;
          $('#sensitivity-val').textContent = `${state.sensitivity.toFixed(1)}×`;
          $('#live-correction').checked = state.live;

          // 恢复保护区
          state.protection = ProtectionMask.fromJSON(p.protection);
          view.setMaskCanvas(state.protection.maskCanvas);

          // 恢复视图
          const v = p.view || {};
          if (v.mode) {
            view.setMode(v.mode);
            $$('#repeat-mode-group .tool-btn').forEach((b) =>
              b.classList.toggle('active', b.dataset.mode === v.mode));
          }
          view.setCompare(v.compare || 'split');
          $$('[data-compare]').forEach((b) =>
            b.classList.toggle('active', b.dataset.compare === (v.compare || 'split')));
          view.setSplitAt(v.splitAt ?? 0.5);
          view.showBoundaries = v.showBoundaries !== false;
          view.showMarkers = v.showMarkers !== false;
          view.showProtect = v.showProtect !== false;
          $('#toggle-boundaries').checked = view.showBoundaries;
          $('#toggle-markers').checked = view.showMarkers;
          $('#toggle-protect-overlay').checked = view.showProtect;

          recomputeCorrection();
          if (typeof v.zoom === 'number') view.zoom = v.zoom;
          if (typeof v.panX === 'number') view.panX = v.panX;
          if (typeof v.panY === 'number') view.panY = v.panY;
          view.setAnalysis(getDisplayedAnalysis());
          renderAll();
          setStatus(`项目已恢复：${state.fileName}`);
        };
        img.src = p.sourceImage;
      } catch (err) {
        setStatus(`项目打开失败：${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  function bindProjectIO() {
    $('#save-project-btn').addEventListener('click', saveProject);
    $('#save-project-btn-2').addEventListener('click', saveProject);
    $('#project-input').addEventListener('change', (e) => {
      if (e.target.files[0]) loadProject(e.target.files[0]);
      e.target.value = '';
    });
  }

  /* ---------------- 文件与示例 ---------------- */
  function bindFileAndSamples() {
    $('#file-input').addEventListener('change', (e) => {
      if (e.target.files[0]) loadImageFile(e.target.files[0]);
      e.target.value = '';
    });

    const menu = $('#sample-menu');
    $('#sample-btn').addEventListener('click', () => {
      menu.hidden = !menu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.dropdown-wrap')) menu.hidden = true;
    });
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sample]');
      if (!btn) return;
      menu.hidden = true;
      const size = 256;
      const img = btn.dataset.sample === 'cloth'
        ? SeamSamples.generateCloth(size)
        : SeamSamples.generateFloor(size);
      ingestImage(img, btn.dataset.sample === 'cloth'
        ? 'sample_cloth_tileable.png'
        : 'sample_floor_vertical_seam.png');
    });
  }

  /* ---------------- Tabs ---------------- */
  function bindTabs() {
    $$('#tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        $$('#tabs .tab').forEach((t) => t.classList.remove('active'));
        $$('.tab-panel').forEach((p) => p.classList.remove('active'));
        tab.classList.add('active');
        $(`.tab-panel[data-panel="${tab.dataset.tab}"]`).classList.add('active');
      });
    });
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    bindTabs();
    bindViewControls();
    bindProtectionControls();
    bindCorrectionControls();
    bindExport();
    bindProjectIO();
    bindFileAndSamples();
    view.showBoundaries = $('#toggle-boundaries').checked;
    view.showMarkers = $('#toggle-markers').checked;
    view.showProtect = $('#toggle-protect-overlay').checked;
    setStatus('就绪：载入图片或选择示例纹理');
  }

  init();
})();
