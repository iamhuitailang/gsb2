/**
 * app.js — 界面控制：素材导入、放置、视图切换、分析触发、扫描、快照与导出
 */
(function () {
  'use strict';
  const { C, Geo, Assets, Analysis, Render, Report } = window;
  const W = 640, H = 400;

  const stage = document.getElementById('stage');
  const scene = new Render.Scene(stage, W, H);
  const $ = (id) => document.getElementById(id);

  const state = {
    mode: 'normal',
    metric: '2000',          // 常规分析默认精确指标
    resultCache: new Map(),  // mode -> {iconResults, pairResults, frame}
    scanSignal: null,
    snapshots: [],
    bgName: '演示渐变底',
  };

  // ---------------- 初始化 ----------------
  function init() {
    scene.setBackground(Assets.createBackground('demo', W, H));
    buildBuiltinIcons();
    buildModeBar();
    bindEvents();
    loadDemo(true);
  }

  function buildBuiltinIcons() {
    const wrap = $('builtin-icons');
    wrap.innerHTML = '';
    Assets.defaultIconSet().forEach((spec, i) => {
      const cv = Assets.drawIcon({ ...spec, size: 72 });
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.title = '点击添加：' + spec.name;
      chip.appendChild(cv);
      const label = document.createElement('span');
      label.textContent = spec.name;
      chip.appendChild(label);
      chip.onclick = () => {
        const full = Assets.drawIcon({ ...spec, size: 96 });
        addIcon(full, spec.name);
      };
      wrap.appendChild(chip);
    });
  }

  function buildModeBar() {
    const bar = $('mode-bar');
    bar.innerHTML = '';
    Render.VIEW_MODES.forEach(m => {
      const b = document.createElement('button');
      b.className = 'btn btn-small' + (m.id === state.mode ? ' active' : '');
      b.textContent = m.label;
      b.dataset.mode = m.id;
      b.onclick = () => setMode(m.id);
      bar.appendChild(b);
    });
  }

  // ---------------- 图标管理 ----------------
  function addIcon(sourceCanvas, name) {
    const icon = scene.addIcon(sourceCanvas, name);
    scene.selectedId = icon.id;
    invalidate();
    refreshIconList();
    syncControls();
    runAnalysis();
    return icon;
  }

  function refreshIconList() {
    const ul = $('icon-list');
    ul.innerHTML = '';
    scene.icons.forEach(ic => {
      const li = document.createElement('li');
      li.className = ic.id === scene.selectedId ? 'selected' : '';
      const thumb = Assets.makeCanvas(30, 30);
      thumb.getContext('2d').drawImage(scene.effectiveCanvas(ic), 0, 0, 30, 30);
      li.appendChild(thumb);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<b>${escapeHtml(ic.name)}</b><small>${ic.w}×${ic.h} @ (${ic.x},${ic.y})</small>`;
      li.appendChild(meta);
      const del = document.createElement('button');
      del.className = 'del';
      del.textContent = '✕';
      del.title = '删除';
      del.onclick = (e) => {
        e.stopPropagation();
        scene.removeIcon(ic.id);
        if (scene.selectedId === ic.id) scene.selectedId = scene.icons[0]?.id;
        invalidate(); refreshIconList(); syncControls(); runAnalysis();
      };
      li.onclick = () => { scene.selectedId = ic.id; refreshIconList(); syncControls(); scene.render(); };
      li.appendChild(del);
      ul.appendChild(li);
    });
    const sel = $('scan-icon');
    sel.innerHTML = '';
    scene.icons.forEach(ic => {
      const o = document.createElement('option');
      o.value = ic.id; o.textContent = ic.name;
      sel.appendChild(o);
    });
    if (scene.selectedId) sel.value = scene.selectedId;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // ---------------- 视图模式 ----------------
  function setMode(mode) {
    state.mode = mode;
    scene.mode = mode;
    scene.overlay = null;
    $('btn-overlay-none').classList.add('active');
    ['btn-overlay-heat', 'btn-overlay-alpha'].forEach(id => $(id).classList.remove('active'));
    buildModeBar();
    $('cur-mode').textContent = Render.VIEW_MODES.find(m => m.id === mode).label;
    scene.render();
    runAnalysis();
  }

  function invalidate() {
    state.resultCache.clear();
    scene.bump();
  }

  // ---------------- 分析 ----------------
  function runAnalysis() {
    if (!scene.icons.length) { $('results').innerHTML = '<p class="note">请先添加提示图。</p>'; return; }
    const mode = state.mode;

    // 每个图标的画面级 alpha 缓冲只绘制一次，后续掩膜/分析复用
    const iconBufs = new Map();
    for (const ic of scene.icons) iconBufs.set(ic.id, iconBuffer(ic));

    // 背景覆盖掩膜（所有提示）
    const coveredAll = Analysis.buildCoveredMask(W, H, Array.from(iconBufs.values()));

    // 当前模式帧（整帧只做一次色觉转换）
    const baseComposite = scene.composite();
    const frameData = mode === 'normal'
      ? baseComposite.frame.data
      : C.transformFrame(baseComposite.frame.data, mode);
    const frame = putFrame(frameData);

    let cached = state.resultCache.get(mode);
    if (!cached) {
      const lut = Analysis.makeLabLut(frameData);
      const iconResults = scene.icons.map(ic => {
        const r = Analysis.analyzeIcon(frameData, lut, W, H, iconBufs.get(ic.id), coveredAll, state.metric);
        r.name = ic.name;
        return r;
      });

      // 两两提示：各自单独合成后比较重叠区
      const pairResults = [];
      for (let i = 0; i < scene.icons.length; i++) {
        for (let j = i + 1; j < scene.icons.length; j++) {
          const a = scene.icons[i], b = scene.icons[j];
          const soloA = scene.composite(scene.icons.filter(k => k.id !== a.id).map(k => k.id));
          const soloB = scene.composite(scene.icons.filter(k => k.id !== b.id).map(k => k.id));
          const dataA = mode === 'normal' ? soloA.frame.data : C.transformFrame(soloA.frame.data, mode);
          const dataB = mode === 'normal' ? soloB.frame.data : C.transformFrame(soloB.frame.data, mode);
          pairResults.push(Analysis.analyzePair(
            frameData, dataA, dataB,
            Analysis.makeLabLut(dataA), Analysis.makeLabLut(dataB),
            W, H, a, b,
            soloA.coveredOf.get(a.id), soloB.coveredOf.get(b.id),
            state.metric,
          ));
        }
      }
      cached = { iconResults, pairResults, alphaOf: baseComposite.alphaOf };
      state.resultCache.set(mode, cached);
    }
    renderResults(cached);
    scene.render();
  }

  /** 构造分析模块需要的图标描述：图标本地尺寸的 alpha 缓冲 + 画面左上角偏移 */
  function iconBuffer(ic) {
    const buf = scene._drawIconBuffer(ic);
    const alpha = new Uint8ClampedArray(ic.w * ic.h);
    for (let y = 0; y < ic.h; y++) {
      for (let x = 0; x < ic.w; x++) {
        const fx = ic.x + x, fy = ic.y + y;
        alpha[y * ic.w + x] =
          (fx < 0 || fy < 0 || fx >= W || fy >= H) ? 0 : buf.data[(fy * W + fx) * 4 + 3];
      }
    }
    return { id: ic.id, name: ic.name, x0: ic.x, y0: ic.y, W: ic.w, H: ic.h, alpha };
  }

  function putFrame(data) {
    const img = stage.getContext('2d').createImageData(W, H);
    img.data.set(data);
    return img;
  }

  // ---------------- 结果渲染 ----------------
  function renderResults(cached) {
    const root = $('results');
    root.innerHTML = '';
    for (const r of cached.iconResults) {
      root.appendChild(renderIconCard(r));
    }
    for (const p of cached.pairResults) {
      root.appendChild(renderPairCard(p));
    }
    root.appendChild(worstLegendNote());
  }

  function rating(mean) {
    if (!isFinite(mean)) return { cls: 'warn', text: '无样本' };
    if (mean < 5) return { cls: 'bad', text: '难分辨' };
    if (mean < 10) return { cls: 'warn', text: '勉强可辨' };
    return { cls: 'ok', text: '清晰可辨' };
  }

  function renderIconCard(r) {
    const card = document.createElement('div');
    card.className = 'metric-card';
    const full = r.summary.full, edge = r.summary.edge;
    const rt = rating(full.mean || edge.mean);
    card.innerHTML = `
      <h4>${escapeHtml(r.name)} <span class="tag">图标 vs 局部背景 · ${r.metric === '2000' ? 'ΔE2000' : 'ΔE76'}</span>
        <span class="badge ${rt.cls}">${rt.text}</span></h4>
      <table class="metrics">
        <tr><th>像素类别</th><th>样本</th><th>均值</th><th>P5</th><th>最小</th></tr>
        <tr><td>全不透明</td><td>${full.count}</td>
          <td class="${full.mean < 5 ? 'bad-text' : ''}">${fmt(full.mean)}</td>
          <td>${fmt(full.p5)}</td><td>${fmt(full.min)}</td></tr>
        <tr><td>半透明边缘</td><td>${edge.count}</td>
          <td>${fmt(edge.mean)}</td><td>${fmt(edge.p5)}</td><td>${fmt(edge.min)}</td></tr>
        <tr><td>全透明区（不参与色差）</td><td>${r.summary.transparentCount}</td><td colspan="3" style="text-align:left;color:var(--muted)">单独统计，排除在色差之外</td></tr>
      </table>
      <div class="bar-row"><span style="width:74px">WCAG 对比</span>
        <span class="bar"><i style="width:${Math.min(100, (r.summary.contrastFull.min || 0) / 7 * 100)}%"></i></span>
        <b>${fmt(r.summary.contrastFull.min)}:1</b></div>
      <div class="bar-row"><span style="width:74px">ΔE&lt;5 占比</span>
        <span class="bar"><i style="width:${(r.thresholds.lt5 * 100).toFixed(0)}%;background:${r.thresholds.lt5 > .1 ? '#c0392b' : '#2f80ed'}"></i></span>
        <b>${(r.thresholds.lt5 * 100).toFixed(1)}%</b></div>
      <ol class="worst-list">最难分像素（点击定位）:
        ${r.worst.slice(0, 5).map(w =>
          `<li data-x="${w.x}" data-y="${w.y}" data-icon="${r.iconId}">
            (${w.x},${w.y}) ΔE=${fmt(w.dE)} · 前景 rgb(${w.fgRgb.join(',')}) vs 邻近背景 rgb(${w.bgRgb.join(',')})
          </li>`).join('')}
      </ol>`;
    card.querySelectorAll('.worst-list li').forEach(li => {
      li.onclick = () => showTooltipAt(+li.dataset.x, +li.dataset.y, cached, li.dataset.icon);
    });
    return card;
  }

  function renderPairCard(p) {
    const card = document.createElement('div');
    card.className = 'metric-card pair-card';
    const nameA = scene.icons.find(i => i.id === p.iconA)?.name || p.iconA;
    const nameB = scene.icons.find(i => i.id === p.iconB)?.name || p.iconB;
    const s = p.full.count ? p.full : p.edge;
    const rt = rating(s.mean);
    card.innerHTML = `
      <h4>${escapeHtml(nameA)} × ${escapeHtml(nameB)}
        <span class="tag">两提示之间 · ${p.metric === '2000' ? 'ΔE2000' : 'ΔE76'}</span>
        <span class="badge ${rt.cls}">${rt.text}</span></h4>
      ${p.overlapCount === 0
        ? `<p class="note">两图不重叠，最近边缘间距 ${fmt(p.minGap, 1)} px；无可逐像素比较的重叠区。</p>`
        : `<table class="metrics">
            <tr><th>类别</th><th>样本</th><th>均值</th><th>P5</th><th>最小</th></tr>
            <tr><td>不透明重叠</td><td>${p.full.count}</td><td>${fmt(p.full.mean)}</td><td>${fmt(p.full.p5)}</td><td>${fmt(p.full.min)}</td></tr>
            <tr><td>半透明重叠</td><td>${p.edge.count}</td><td>${fmt(p.edge.mean)}</td><td>${fmt(p.edge.p5)}</td><td>${fmt(p.edge.min)}</td></tr>
          </table>
          <div class="bar-row"><span style="width:74px">ΔE&lt;5 占比</span>
            <span class="bar"><i style="width:${(p.thresholds.lt5 * 100).toFixed(0)}%;background:${p.thresholds.lt5 > .1 ? '#c0392b' : '#2f80ed'}"></i></span>
            <b>${(p.thresholds.lt5 * 100).toFixed(1)}%</b></div>
          <ol class="worst-list">最难分重叠像素:
            ${p.worst.slice(0, 5).map(w =>
              `<li data-x="${w.x}" data-y="${w.y}">(${w.x},${w.y}) ΔE=${fmt(w.dE)} · rgb(${w.rgbA.join(',')}) vs rgb(${w.rgbB.join(',')})</li>`
            ).join('')}
          </ol>`}`;
    card.querySelectorAll('.worst-list li').forEach(li => {
      li.onclick = () => showTooltipAt(+li.dataset.x, +li.dataset.y, cached);
    });
    return card;
  }

  function worstLegendNote() {
    const div = document.createElement('div');
    div.className = 'note';
    div.innerHTML = '判定参考：ΔE&lt;5 多数人难分辨，5–10 勉强可辨，&gt;10 一般清晰。<br>' +
      '所有数值均来自<b>当前视图模式下真实合成像素</b>；局部背景取每个图标像素最近的未覆盖背景像素，非平均色。';
    return div;
  }

  function fmt(v, n) {
    if (v == null || Number.isNaN(v)) return '—';
    return Report.round(v, n == null ? 2 : n);
  }

  // ---------------- 画布交互：拖动 / 缩放 / 悬停数值 ----------------
  let drag = null;
  function canvasPos(e) {
    const rect = stage.getBoundingClientRect();
    return {
      x: Math.round((e.clientX - rect.left) * W / rect.width),
      y: Math.round((e.clientY - rect.top) * H / rect.height),
    };
  }
  stage.addEventListener('mousedown', (e) => {
    const pos = canvasPos(e);
    const hit = scene.hitTest(pos.x, pos.y);
    if (!hit) return;
    scene.selectedId = hit.icon.id;
    refreshIconList(); syncControls();
    drag = {
      icon: hit.icon, handle: hit.handle,
      start: pos, ox: hit.icon.x, oy: hit.icon.y, ow: hit.icon.w,
      ratio: hit.icon.h / hit.icon.w,
    };
    stage.style.cursor = hit.handle ? 'nwse-resize' : 'move';
  });
  window.addEventListener('mousemove', (e) => {
    const pos = canvasPos(e);
    if (drag) {
      const ic = drag.icon;
      if (drag.handle) {
        ic.w = Math.max(24, Math.min(240, drag.ow + (pos.x - drag.start.x)));
        ic.h = Math.round(ic.w * drag.ratio);
      } else {
        ic.x = Math.max(0, Math.min(W - ic.w, drag.ox + pos.x - drag.start.x));
        ic.y = Math.max(0, Math.min(H - ic.h, drag.oy + pos.y - drag.start.y));
      }
      invalidate(); syncControls(); scene.render();
      return;
    }
    const hit = scene.hitTest(pos.x, pos.y);
    stage.style.cursor = hit ? (hit.handle ? 'nwse-resize' : 'move') : 'default';
    maybeHoverTip(pos);
  });
  window.addEventListener('mouseup', () => {
    if (drag) {
      drag = null;
      refreshIconList(); runAnalysis();
    }
  });

  function maybeHoverTip(pos) {
    const cached = state.resultCache.get(state.mode);
    if (!cached) { $('tooltip').hidden = true; return; }
    const p = pos.y * W + pos.x;
    const found = cached.iconResults.find(r => r.valid[p]);
    const tip = $('tooltip');
    if (!found) { tip.hidden = true; return; }
    const w = found.worst.find(q => q.x === pos.x && q.y === pos.y)
      || nearestWorst(found, pos);
    if (!w) { tip.hidden = true; return; }
    tip.innerHTML = `位置 (${w.x},${w.y}) · <b>ΔE=${fmt(w.dE)}</b> (${w.cls === 'full' ? '不透明' : '半透明边缘'})<br>
      前景 <span class="sw" style="background:rgb(${w.fgRgb.join(',')})"></span>rgb(${w.fgRgb.join(',')})<br>
      最近背景 <span class="sw" style="background:rgb(${w.bgRgb.join(',')})"></span>rgb(${w.bgRgb.join(',')}) @(${w.bgX},${w.bgY}) 距离${fmt(w.bgDist, 1)}px`;
    const rect = stage.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = Math.min(rect.width - 270, (pos.x / W) * rect.width + 14) + 'px';
    tip.style.top = ((pos.y / H) * rect.height + 14) + 'px';
  }
  function nearestWorst(result, pos) {
    let best = null, bd = Infinity;
    for (const w of result.worst) {
      const d = (w.x - pos.x) ** 2 + (w.y - pos.y) ** 2;
      if (d < bd) { bd = d; best = w; }
    }
    return bd <= 144 ? best : null;
  }
  function showTooltipAt(x, y, cached, iconId) {
    const r = cached.iconResults.find(r => r.iconId === (iconId || r.iconId) && r.valid[y * W + x])
      || cached.iconResults.find(r => r.valid[y * W + x]);
    if (!r) return;
    const w = r.worst.find(q => q.x === x && q.y === y) || r.worst[0];
    const tip = $('tooltip');
    tip.innerHTML = `位置 (${w.x},${w.y}) · <b>ΔE=${fmt(w.dE)}</b><br>
      前景 <span class="sw" style="background:rgb(${w.fgRgb.join(',')})"></span>rgb(${w.fgRgb.join(',')})<br>
      最近背景 <span class="sw" style="background:rgb(${w.bgRgb.join(',')})"></span>rgb(${w.bgRgb.join(',')})`;
    const rect = stage.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = Math.min(rect.width - 270, (w.x / W) * rect.width + 14) + 'px';
    tip.style.top = ((w.y / H) * rect.height + 14) + 'px';
  }

  // ---------------- 控件同步 ----------------
  function syncControls() {
    const ic = scene.icons.find(i => i.id === scene.selectedId);
    const disabled = !ic;
    ['pos-x', 'pos-y', 'pos-w', 'tint-hue', 'tint-sat', 'symbol-select'].forEach(id => $(id).disabled = disabled);
    if (!ic) return;
    $('pos-x').value = ic.x; $('pos-x').max = W - ic.w;
    $('pos-y').value = ic.y; $('pos-y').max = H - ic.h;
    $('pos-w').value = ic.w;
    $('tint-hue').value = ic.tintHue; $('tint-hue-val').textContent = ic.tintHue + '°';
    $('tint-sat').value = Math.round(ic.tintSat * 100); $('tint-sat-val').textContent = Math.round(ic.tintSat * 100) + '%';
    $('symbol-select').value = ic.symbol;
    $('border-check').checked = !!ic.border;
  }

  function bindEvents() {
    $('bg-select').onchange = (e) => {
      scene.setBackground(Assets.createBackground(e.target.value, W, H));
      state.bgName = e.target.selectedOptions[0].textContent.replace('自带：', '');
      invalidate(); runAnalysis();
    };
    $('bg-file').onchange = (e) => loadImageFile(e.target.files[0], (img) => {
      const cv = Assets.makeCanvas(W, H);
      cv.getContext('2d').drawImage(img, 0, 0, W, H);
      scene.setBackground(cv);
      state.bgName = '导入图片：' + e.target.files[0].name;
      invalidate(); runAnalysis();
    });
    $('icon-files').onchange = (e) => {
      Array.from(e.target.files).forEach(f => loadImageFile(f, (img) => {
        const cv = Assets.makeCanvas(img.width, img.height);
        cv.getContext('2d').drawImage(img, 0, 0);
        addIcon(cv, f.name.replace(/\.[^.]+$/, ''));
      }));
      e.target.value = '';
    };

    $('pos-x').oninput = (e) => { const ic = selected(); if (ic) { ic.x = +e.target.value; invalidate(); syncControls(); scene.render(); } };
    $('pos-y').oninput = (e) => { const ic = selected(); if (ic) { ic.y = +e.target.value; invalidate(); syncControls(); scene.render(); } };
    $('pos-w').oninput = (e) => {
      const ic = selected(); if (!ic) return;
      ic.w = +e.target.value;
      ic.h = Math.round(ic.w * ic.src.height / ic.src.width);
      invalidate(); syncControls(); scene.render();
    };
    ['pos-x', 'pos-y', 'pos-w'].forEach(id => $(id).onchange = () => { refreshIconList(); runAnalysis(); });

    $('tint-hue').oninput = (e) => {
      const ic = selected(); if (!ic) return;
      ic.tintHue = +e.target.value; $('tint-hue-val').textContent = ic.tintHue + '°';
      invalidate(); refreshIconList(); scene.render();
    };
    $('tint-hue').onchange = () => runAnalysis();
    $('tint-sat').oninput = (e) => {
      const ic = selected(); if (!ic) return;
      ic.tintSat = +e.target.value / 100; $('tint-sat-val').textContent = e.target.value + '%';
      invalidate(); refreshIconList(); scene.render();
    };
    $('tint-sat').onchange = () => runAnalysis();
    $('symbol-select').onchange = (e) => { const ic = selected(); if (ic) { ic.symbol = e.target.value; invalidate(); scene.render(); runAnalysis(); } };
    $('border-check').onchange = (e) => { const ic = selected(); if (ic) { ic.border = e.target.checked; invalidate(); scene.render(); runAnalysis(); } };
    $('btn-reset-style').onclick = () => {
      const ic = selected(); if (!ic) return;
      ic.tintHue = 0; ic.tintSat = 1; ic.symbol = 'none'; ic.border = false;
      invalidate(); syncControls(); refreshIconList(); scene.render(); runAnalysis();
    };

    $('btn-overlay-none').onclick = () => { scene.overlay = null; setOverlayActive('btn-overlay-none'); scene.render(); };
    $('btn-overlay-heat').onclick = () => showHeatOverlay();
    $('btn-overlay-alpha').onclick = () => showAlphaOverlay();

    $('btn-scan').onclick = () => runScan();
    $('btn-scan-cancel').onclick = () => { if (state.scanSignal) state.scanSignal.cancelled = true; };
    $('btn-snap').onclick = () => saveSnapshot();
    $('btn-snap-clear').onclick = () => { state.snapshots = []; renderSnapshots(); };
    $('btn-export-json').onclick = () => exportReport('json');
    $('btn-export-html').onclick = () => exportReport('html');
    $('btn-export-png').onclick = () => Report.downloadCanvas(stage, 'legibility-view.png');
    $('btn-demo').onclick = () => loadDemo(false);
    $('btn-demo-export').onclick = () => exportDemoFigure();
  }

  function selected() { return scene.icons.find(i => i.id === scene.selectedId); }
  function setOverlayActive(id) {
    ['btn-overlay-none', 'btn-overlay-heat', 'btn-overlay-alpha'].forEach(x => $(x).classList.toggle('active', x === id));
  }

  function showHeatOverlay() {
    const cached = state.resultCache.get(state.mode);
    if (!cached) return;
    // 多图标时叠加第一张（选择框指定图标优先）
    const r = cached.iconResults.find(x => x.iconId === scene.selectedId) || cached.iconResults[0];
    scene.overlay = { type: 'heat', heat: r.heat, valid: r.valid, alpha: 0.5 };
    setOverlayActive('btn-overlay-heat');
    scene.render();
  }
  function showAlphaOverlay() {
    const comp = scene.composite();
    scene.overlay = { type: 'alpha', alphaOf: comp.alphaOf };
    setOverlayActive('btn-overlay-alpha');
    scene.render();
  }

  // ---------------- 最难位置扫描 ----------------
  async function runScan() {
    const iconId = $('scan-icon').value || scene.selectedId;
    const ic = scene.icons.find(i => i.id === iconId);
    if (!ic) return;
    const step = Math.max(4, +$('scan-step').value || 16);
    const metric = $('scan-metric').value;
    const progress = document.querySelector('.progress');
    const fill = $('progress-fill');
    progress.hidden = false; fill.style.width = '0%';
    $('btn-scan').disabled = true;
    $('btn-scan-cancel').hidden = false;
    state.scanSignal = { cancelled: false };

    const probe = (x, y) => {
      const r = scene.renderProbe(ic.id, x, y, state.mode);
      return Promise.resolve(r);
    };
    const result = await Analysis.scanWorstPositions(probe, {
      W, H, iconW: ic.w, iconH: ic.h, step, metric,
      signal: state.scanSignal,
      onProgress: (t) => { fill.style.width = (t * 100).toFixed(0) + '%'; },
    });
    state.scanSignal = null;
    $('btn-scan-cancel').hidden = true;
    $('btn-scan').disabled = false;

    if (result.cancelled) {
      $('scan-result').innerHTML = '<p class="note">已取消。</p>';
      return;
    }
    state.lastScan = { ...result, iconId, iconW: ic.w, iconH: ic.h };
    scene.overlay = {
      type: 'scan',
      grid: result.grid, cols: result.cols, rows: result.rows, step,
      hardest: result.hardest, iconW: ic.w, iconH: ic.h,
    };
    scene.render();
    renderScanResult(result, ic);
  }

  function renderScanResult(result, ic) {
    const root = $('scan-result');
    const unit = result.metric === '2000' ? 'ΔE2000' : 'ΔE76';
    root.innerHTML = `
      <div class="spot hard">
        <div><div class="big">${fmt(result.hardest.score)}</div><small>${unit} 均值（越低越难分）</small></div>
        <div>最难分辨位置：<b>(${result.hardest.x}, ${result.hardest.y})</b></div>
        <button class="btn btn-small" id="goto-hard">把图标移到这里并分析</button>
      </div>
      <div class="spot easy">
        <div><div class="big">${fmt(result.easiest.score)}</div><small>${unit} 均值</small></div>
        <div>最易分辨位置：<b>(${result.easiest.x}, ${result.easiest.y})</b></div>
        <button class="btn btn-small" id="goto-easy">把图标移到这里并分析</button>
      </div>`;
    $('goto-hard').onclick = () => jumpTo(result.hardest, ic);
    $('goto-easy').onclick = () => jumpTo(result.easiest, ic);
  }
  function jumpTo(pos, ic) {
    ic.x = pos.x; ic.y = pos.y;
    scene.overlay = null;
    invalidate(); syncControls(); refreshIconList(); runAnalysis();
  }

  // ---------------- 快照与并排比较 ----------------
  function saveSnapshot() {
    if (!scene.icons.length) return;
    scene.overlay = null; scene.render();
    const cached = state.resultCache.get(state.mode);
    const headline = cached
      ? cached.iconResults.map(r => `${r.name}:均值ΔE ${fmt(r.summary.full.mean || r.summary.edge.mean)}`).join('；')
      : '';
    state.snapshots.push({
      label: '快照 ' + (state.snapshots.length + 1),
      createdAt: new Date().toLocaleTimeString(),
      dataUrl: stage.toDataURL('png'),
      headline,
      icons: scene.icons.map(ic => ({
        name: ic.name, x: ic.x, y: ic.y, w: ic.w, h: ic.h,
        tintHue: ic.tintHue, tintSat: ic.tintSat, symbol: ic.symbol, border: ic.border,
      })),
    });
    renderSnapshots();
  }
  function renderSnapshots() {
    const wrap = $('snapshots');
    wrap.innerHTML = '';
    state.snapshots.forEach((sp, i) => {
      const fig = document.createElement('div');
      fig.className = 'snap';
      fig.innerHTML = `<figcaption><b>${escapeHtml(sp.label)}</b><button class="rm" title="删除">✕</button></figcaption>
        <img src="${sp.dataUrl}" alt="${escapeHtml(sp.label)}">
        <div class="snap-headline">${escapeHtml(sp.headline)}</div>
        <small>${sp.createdAt} · ${Render.VIEW_MODES.find(m => m.id === state.mode).label}</small>`;
      fig.querySelector('.rm').onclick = () => { state.snapshots.splice(i, 1); renderSnapshots(); };
      wrap.appendChild(fig);
    });
  }

  // ---------------- 导出 ----------------
  function collectPayload() {
    const modes = [];
    for (const mode of Render.VIEW_MODES.map(m => m.id)) {
      const comp = scene.composite();
      const data = mode === 'normal' ? comp.frame.data : C.transformFrame(comp.frame.data, mode);
      const img = putFrame(data);
      const lut = Analysis.makeLabLut(img.data);
      const coveredAll = Analysis.buildCoveredMask(W, H, scene.icons.map(ic => iconBuffer(ic)));
      const iconResults = scene.icons.map(ic =>
        Analysis.analyzeIcon(img.data, lut, W, H, iconBuffer(ic), coveredAll, '2000'));
      const pairResults = [];
      for (let i = 0; i < scene.icons.length; i++) {
        for (let j = i + 1; j < scene.icons.length; j++) {
          const a = scene.icons[i], b = scene.icons[j];
          const sA = scene.composite(scene.icons.filter(k => k.id !== a.id).map(k => k.id));
          const sB = scene.composite(scene.icons.filter(k => k.id !== b.id).map(k => k.id));
          const dA = mode === 'normal' ? sA.frame.data : C.transformFrame(sA.frame.data, mode);
          const dB = mode === 'normal' ? sB.frame.data : C.transformFrame(sB.frame.data, mode);
          pairResults.push(Analysis.analyzePair(
            img.data, dA, dB, Analysis.makeLabLut(dA), Analysis.makeLabLut(dB),
            W, H, a, b, sA.coveredOf.get(a.id), sB.coveredOf.get(b.id), '2000'));
        }
      }
      modes.push({ mode, label: Render.VIEW_MODES.find(m => m.id === mode).label, iconResults, pairResults });
    }
    return {
      meta: { note: '基于真实合成像素的局部色差分析；全透明像素不参与色差。' },
      scene: { W, H, backgroundName: state.bgName, icons: scene.icons },
      modes,
      scans: state.lastScan ? [{ ...state.lastScan, mode: state.mode }] : [],
      snapshots: state.snapshots,
    };
  }

  function exportReport(kind) {
    const payload = collectPayload();
    if (kind === 'json') {
      Report.exportJSON(payload);
    } else {
      scene.overlay = null; scene.render();
      const images = [
        { dataUrl: stage.toDataURL('png'), caption: '当前视图（' + Render.VIEW_MODES.find(m => m.id === state.mode).label + '）' },
      ];
      if (state.lastScan) {
        const ov = scene.overlay = {
          type: 'scan', grid: state.lastScan.grid, cols: state.lastScan.cols,
          rows: state.lastScan.rows, step: state.lastScan.step,
          hardest: state.lastScan.hardest, iconW: state.lastScan.iconW, iconH: state.lastScan.iconH,
        };
        scene.render();
        images.push({ dataUrl: stage.toDataURL('png'), caption: '最难位置扫描热力' });
        scene.overlay = null; scene.render();
      }
      for (const sp of state.snapshots) images.push({ dataUrl: sp.dataUrl, caption: sp.label });
      Report.exportHTML(payload, images);
    }
  }

  // ---------------- 演示 ----------------
  function loadDemo(initial) {
    // 重置
    scene.icons = [];
    scene.seq = 1;
    scene.overlay = null;
    state.snapshots = []; renderSnapshots();
    $('bg-select').value = 'demo';
    scene.setBackground(Assets.createBackground('demo', W, H));
    state.bgName = '演示渐变底（左半纯白 / 右半亮暗渐变）';

    const redSpec = Assets.defaultIconSet()[0];
    const greenSpec = Assets.defaultIconSet()[1];
    // 两个图标部分重叠，便于演示“两提示之间”的逐像素可区分度
    const red = addIconAt(Assets.drawIcon({ ...redSpec, size: 96 }), '红圆（红绿色盲易混）', 110, 130);
    const green = addIconAt(Assets.drawIcon({ ...greenSpec, size: 96 }), '绿菱（红绿色盲易混）', 185, 150);
    setMode('normal');
    invalidate(); refreshIconList(); syncControls(); runAnalysis();

    if (!initial) {
      // 演示流程：先在白底快照 -> 挪到砖红带（仍保持重叠）-> 快照 -> 切绿色盲
      setTimeout(() => {
        saveSnapshot();
        red.x = 425; red.y = 105;
        green.x = 470; green.y = 165;
        invalidate(); syncControls(); refreshIconList(); runAnalysis();
        setTimeout(() => {
          saveSnapshot();
          setMode('deutan');
          $('btn-overlay-heat').click();
          flashDemoNote();
        }, 120);
      }, 120);
    } else {
      syncControls();
    }
  }

  function addIconAt(cv, name, x, y) {
    const ic = scene.addIcon(cv, name);
    ic.x = x; ic.y = y;
    scene.selectedId = ic.id;
    return ic;
  }

  function flashDemoNote() {
    const note = document.createElement('div');
    note.className = 'note';
    note.style.cssText = 'border:1px solid #f5c6c0;background:#fdecea;color:#7b241c;margin-top:8px';
    note.innerHTML = '演示：两个提示在<b>左侧纯白底</b>上 ΔE 合格；挪到右侧渐变底后，' +
      '红色圆在橄榄绿背景上、绿色盲模拟下局部 ΔE 明显下降。可点「开始扫描」查看最难位置红框。';
    $('scan-result').prepend(note);
    setTimeout(() => note.remove(), 12000);
  }

  /** 自绘演示示意图：同色提示在纯色底 vs 渐变底的对比（不含任何个人信息），返回 canvas */
  function buildDemoFigure() {
    const cv = Assets.makeCanvas(960, 420);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 480, 420);
    const g = ctx.createLinearGradient(480, 0, 960, 420);
    g.addColorStop(0, '#e8f2c0'); g.addColorStop(0.32, '#7f9a4a');
    g.addColorStop(0.52, '#d14f47'); g.addColorStop(0.72, '#b58a3e');
    g.addColorStop(1, '#2e3550');
    ctx.fillStyle = g; ctx.fillRect(480, 0, 480, 420);

    const red = Assets.drawIcon({ ...Assets.defaultIconSet()[0], size: 110 });
    const green = Assets.drawIcon({ ...Assets.defaultIconSet()[1], size: 110 });
    ctx.drawImage(red, 150, 150); ctx.drawImage(green, 300, 150);
    ctx.drawImage(red, 610, 140); ctx.drawImage(green, 660, 230);

    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('① 纯白底：红/绿提示 ΔE 合格（清晰可辨）', 30, 40);
    ctx.fillText('② 渐变底：压在橄榄绿/土黄区，局部 ΔE 骤降', 510, 40);
    ctx.font = '14px sans-serif';
    ctx.fillStyle = '#c0392b';
    ctx.fillText('绿色盲模拟下红圆与背景几乎同色 → 难分辨区域', 510, 400);
    ctx.fillStyle = '#1e8449';
    ctx.fillText('同一张图、同一组颜色，差别只来自背景局部像素', 30, 400);
    return cv;
  }
  function exportDemoFigure() {
    Report.downloadCanvas(buildDemoFigure(), 'demo-solid-vs-gradient.png');
  }

  function loadImageFile(file, cb) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { cb(img); URL.revokeObjectURL(url); };
    img.onerror = () => { URL.revokeObjectURL(url); alert('图片读取失败：' + file.name); };
    img.src = url;
  }

  init();

  // 暴露给自动化测试 / 无头截图脚本
  window.__app = {
    scene, state, runAnalysis, runScan, saveSnapshot, loadDemo,
    invalidate, buildDemoFigure, W, H,
  };
})();
