/* 应用主控：状态、画布视图（缩放/平移）、遮罩画笔、菜单与快捷键 */
window.App = window.App || {};

(function () {
  const M = () => App.model;

  App.state = {
    doc: { width: 1280, height: 800 },
    root: { children: [] },       // 顶层在前（索引 0 最顶）
    selectedId: null,
    maskEditId: null,             // 正在编辑遮罩的图层 id
    tool: 'pan',                  // 'pan' | 'brush' | 'eraser'
    brush: { size: 80, hardness: 0.6 },
    view: { scale: 1, tx: 0, ty: 0 }
  };

  App.history = new App.History(60);

  let displayCanvas, dctx, container;
  let compCanvas = null;          // 合成结果缓存
  let renderQueued = false;
  let checkerPattern = null;
  let mousePos = null;            // 屏幕坐标（画刷光标）
  let spaceDown = false;

  /* ================= 历史辅助 ================= */

  /* 结构性操作：操作前后各做一次结构快照（遮罩/图像共享引用，同步恢复） */
  App.structural = function (label, fn) {
    const before = M().snapshotTree(App.state);
    fn();
    const after = M().snapshotTree(App.state);
    App.history.push({
      label,
      undo: () => { M().restoreSnapshot(App.state, before); App.refreshUI(); App.requestRender(); },
      redo: () => { M().restoreSnapshot(App.state, after); App.refreshUI(); App.requestRender(); }
    });
    App.refreshUI();
    App.requestRender();
  };

  /* 单参数操作 */
  App.pushParam = function (label, layerId, key, oldV, newV) {
    App.history.push({
      label,
      undo: () => applyParam(layerId, key, oldV),
      redo: () => applyParam(layerId, key, newV)
    });
    applyParam(layerId, key, newV);
  };

  function applyParam(layerId, key, v) {
    const L = M().findLayer(App.state.root.children, layerId);
    if (!L) return;
    App.setProp(L, key, v);
    App.refreshUI();
    App.requestRender();
  }

  /* 遮罩数据操作（一次连续笔触 = 一条历史） */
  function pushMaskHistory(label, layerId, beforeURL, afterURL) {
    App.history.push({
      label,
      undo: () => setMaskData(layerId, beforeURL),
      redo: () => setMaskData(layerId, afterURL)
    });
  }

  function setMaskData(layerId, url) {
    const L = M().findLayer(App.state.root.children, layerId);
    if (!L) return;
    if (!url) {
      L.mask = null;
      if (App.state.maskEditId === layerId) App.state.maskEditId = null;
    } else {
      if (!L.mask) L.mask = App.util.makeCanvas(App.state.doc.width, App.state.doc.height);
      App.util.drawDataURLToCanvas(url, L.mask, () => App.requestRender());
    }
    App.refreshUI();
    App.requestRender();
  }

  /* ================= 图层操作 ================= */

  App.actions = {
    moveLayer(id, targetId, pos) {
      const layer = M().findLayer(App.state.root.children, id);
      if (!layer || layer.locked) return;
      App.structural('移动图层', () => {
        const loc = M().findLocation(App.state.root.children, id);
        loc.parentChildren.splice(loc.index, 1);
        if (pos === 'inside' && targetId) {
          const target = M().findLayer(App.state.root.children, targetId);
          target.children.unshift(layer); // 进入组内顶部
        } else if (targetId) {
          const tloc = M().findLocation(App.state.root.children, targetId);
          tloc.parentChildren.splice(pos === 'before' ? tloc.index : tloc.index + 1, 0, layer);
        } else {
          App.state.root.children.push(layer); // 根级底部
        }
      });
    },

    deleteLayer(id) {
      const L = M().findLayer(App.state.root.children, id);
      if (!L || L.locked) return;
      App.structural('删除图层', () => {
        const loc = M().findLocation(App.state.root.children, id);
        loc.parentChildren.splice(loc.index, 1);
        if (App.state.selectedId === id) App.state.selectedId = null;
        if (App.state.maskEditId === id) App.state.maskEditId = null;
      });
    },

    addLayer(kind) {
      const S = App.state;
      let L;
      if (kind === 'group') L = M().createGroup();
      else if (kind === 'adjustment') L = M().createAdjustment();
      else L = M().createImageLayer(null, kind, S.doc.width, S.doc.height);

      App.structural('添加图层', () => {
        // 选中组时加入组内顶部，否则加入根级顶部
        const sel = S.selectedId && M().findLayer(S.root.children, S.selectedId);
        if (sel && sel.type === 'group') sel.children.unshift(L);
        else S.root.children.unshift(L);
        S.selectedId = L.id;
        S.maskEditId = null;
      });
    }
  };

  App.setSelected = function (id) {
    if (App.state.selectedId !== id) {
      App.state.selectedId = id;
      App.state.maskEditId = null; // 切换选择时退出遮罩编辑
    }
    App.refreshUI();
    App.requestRender();
  };

  App.setTool = function (tool) {
    App.state.tool = tool;
    document.querySelectorAll('.tool-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === tool));
    updateHint();
  };

  /* ================= UI 刷新 ================= */

  App.refreshUI = function () {
    App.ui.rebuildLayers();
    App.ui.rebuildProps();
    document.getElementById('btn-undo').disabled = !App.history.canUndo;
    document.getElementById('btn-redo').disabled = !App.history.canRedo;
    updateHint();
  };

  function updateHint() {
    const S = App.state;
    let text = '滚轮缩放 · 空格/抓手拖动平移 · Ctrl+Z 撤销';
    if (S.tool !== 'pan') {
      const target = S.maskEditId && M().findLayer(S.root.children, S.maskEditId);
      if (target && target.mask) {
        text = (S.tool === 'brush' ? '画笔：涂抹 = 显示' : '橡皮：涂抹 = 隐藏') +
          ' · 目标遮罩：' + target.name + ' · [ ] 调笔刷';
      } else {
        text = '请先在属性面板为图层「添加遮罩」并点「编辑遮罩」';
      }
    }
    document.getElementById('canvas-hint').textContent = text;
  }

  /* ================= 显示渲染 ================= */

  App.requestRender = function () {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      compCanvas = App.render.renderDocument(App.state);
      drawDisplay();
    });
  };

  function drawDisplay() {
    const S = App.state;
    const w = container.clientWidth, h = container.clientHeight;
    if (displayCanvas.width !== w || displayCanvas.height !== h) {
      displayCanvas.width = w;
      displayCanvas.height = h;
    }
    dctx.setTransform(1, 0, 0, 1, 0, 0);
    dctx.clearRect(0, 0, w, h);

    // 透明区域棋盘格背景
    if (!checkerPattern) {
      const p = App.util.makeCanvas(16, 16);
      const pc = p.getContext('2d');
      pc.fillStyle = '#2e2e2e'; pc.fillRect(0, 0, 16, 16);
      pc.fillStyle = '#3c3c3c'; pc.fillRect(0, 0, 8, 8); pc.fillRect(8, 8, 8, 8);
      checkerPattern = dctx.createPattern(p, 'repeat');
    }
    dctx.fillStyle = checkerPattern;
    dctx.fillRect(0, 0, w, h);

    if (compCanvas) {
      const v = S.view;
      dctx.setTransform(v.scale, 0, 0, v.scale, v.tx, v.ty);
      dctx.imageSmoothingEnabled = true;
      dctx.drawImage(compCanvas, 0, 0);

      // 遮罩编辑中：红色叠加显示被遮住的区域（遮罩透明处）
      const editL = S.maskEditId && M().findLayer(S.root.children, S.maskEditId);
      if (editL && editL.mask) {
        const ov = App.util.makeCanvas(S.doc.width, S.doc.height);
        const oc = ov.getContext('2d');
        oc.fillStyle = '#f40';
        oc.fillRect(0, 0, ov.width, ov.height);
        oc.globalCompositeOperation = 'destination-out';
        oc.drawImage(editL.mask, 0, 0);
        dctx.globalAlpha = 0.45;
        dctx.drawImage(ov, 0, 0);
        dctx.globalAlpha = 1;
      }
    }

    // 笔刷光标（屏幕坐标，大小随缩放变化）
    if (mousePos && S.tool !== 'pan' && S.maskEditId) {
      dctx.setTransform(1, 0, 0, 1, 0, 0);
      dctx.strokeStyle = 'rgba(255,255,255,0.85)';
      dctx.lineWidth = 1;
      dctx.beginPath();
      dctx.arc(mousePos.x, mousePos.y, S.brush.size / 2 * S.view.scale, 0, Math.PI * 2);
      dctx.stroke();
    }
  }

  /* 屏幕坐标 → 文档坐标（缩放/平移的逆变换，保证笔刷落点不漂移） */
  function screenToDoc(clientX, clientY) {
    const rect = displayCanvas.getBoundingClientRect();
    const v = App.state.view;
    return {
      x: (clientX - rect.left - v.tx) / v.scale,
      y: (clientY - rect.top - v.ty) / v.scale
    };
  }

  /* ================= 画笔 ================= */

  let painting = false;
  let paintTarget = null;       // 图层引用
  let strokeBeforeURL = null;
  let lastPt = null;

  function maskEditTarget() {
    const S = App.state;
    if (!S.maskEditId) return null;
    const L = M().findLayer(S.root.children, S.maskEditId);
    if (!L || L.locked || !L.visible || L.type === 'adjustment') return null;
    return L;
  }

  /* 遮罩用 alpha 通道表达（不透明=显示，透明=隐藏）：
   * 画笔涂不透明（source-over），橡皮擦除（destination-out） */
  function stamp(ctx, x, y, erase) {
    const r = App.state.brush.size / 2;
    const hard = App.state.brush.hardness;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(Math.max(0.01, hard * 0.98), 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save();
    if (erase) ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function paintLine(ctx, from, to, erase) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.max(1, App.state.brush.size * 0.15);
    const n = Math.max(1, Math.ceil(dist / step));
    for (let i = 1; i <= n; i++) {
      stamp(ctx, from.x + dx * i / n, from.y + dy * i / n, erase);
    }
  }

  function beginStroke(pt) {
    const L = maskEditTarget();
    if (!L) return false;
    if (!L.mask) {
      // 首个笔触自动创建全白遮罩，并纳入本次笔触的撤销记录
      M().createMask(L, App.state.doc.width, App.state.doc.height);
      strokeBeforeURL = null;
    } else {
      strokeBeforeURL = L.mask.toDataURL('image/png');
    }
    paintTarget = L;
    painting = true;
    lastPt = pt;
    stamp(L.mask.getContext('2d'), pt.x, pt.y, App.state.tool === 'eraser');
    App.requestRender();
    return true;
  }

  function moveStroke(pt) {
    if (!painting) return;
    paintLine(paintTarget.mask.getContext('2d'), lastPt, pt, App.state.tool === 'eraser');
    lastPt = pt;
    App.requestRender();
  }

  function endStroke() {
    if (!painting) return;
    painting = false;
    const afterURL = paintTarget.mask.toDataURL('image/png');
    pushMaskHistory('遮罩绘制', paintTarget.id, strokeBeforeURL, afterURL);
    paintTarget = null;
    App.refreshUI();
  }

  /* ================= 画布事件 ================= */

  let panning = false;
  let panStart = null;

  function bindCanvasEvents() {
    displayCanvas.addEventListener('pointerdown', e => {
      displayCanvas.setPointerCapture(e.pointerId);
      const wantPan = App.state.tool === 'pan' || spaceDown || e.button === 1;
      if (wantPan) {
        panning = true;
        panStart = { x: e.clientX, y: e.clientY, tx: App.state.view.tx, ty: App.state.view.ty };
        return;
      }
      if (e.button === 0) beginStroke(screenToDoc(e.clientX, e.clientY));
    });

    displayCanvas.addEventListener('pointermove', e => {
      const rect = displayCanvas.getBoundingClientRect();
      mousePos = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (panning) {
        App.state.view.tx = panStart.tx + (e.clientX - panStart.x);
        App.state.view.ty = panStart.ty + (e.clientY - panStart.y);
        drawDisplay();
        return;
      }
      if (painting) moveStroke(screenToDoc(e.clientX, e.clientY));
      else drawDisplay(); // 更新笔刷光标
    });

    const stop = () => { panning = false; endStroke(); };
    displayCanvas.addEventListener('pointerup', stop);
    displayCanvas.addEventListener('pointercancel', stop);
    displayCanvas.addEventListener('pointerleave', () => { mousePos = null; if (!painting) drawDisplay(); });

    displayCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const v = App.state.view;
      const rect = displayCanvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const ns = App.util.clamp(v.scale * f, 0.05, 16);
      v.tx = mx - (mx - v.tx) * (ns / v.scale);
      v.ty = my - (my - v.ty) * (ns / v.scale);
      v.scale = ns;
      updateZoomLabel();
      drawDisplay();
    }, { passive: false });
  }

  function zoomBy(f) {
    const v = App.state.view;
    const w = container.clientWidth, h = container.clientHeight;
    const ns = App.util.clamp(v.scale * f, 0.05, 16);
    v.tx = w / 2 - (w / 2 - v.tx) * (ns / v.scale);
    v.ty = h / 2 - (h / 2 - v.ty) * (ns / v.scale);
    v.scale = ns;
    updateZoomLabel();
    drawDisplay();
  }

  function zoomFit() {
    const S = App.state;
    const w = container.clientWidth, h = container.clientHeight;
    const s = Math.min(w / S.doc.width, h / S.doc.height) * 0.92;
    S.view.scale = s;
    S.view.tx = (w - S.doc.width * s) / 2;
    S.view.ty = (h - S.doc.height * s) / 2;
    updateZoomLabel();
    drawDisplay();
  }

  function updateZoomLabel() {
    document.getElementById('zoom-label').textContent = Math.round(App.state.view.scale * 100) + '%';
  }

  /* ================= 菜单与快捷键 ================= */

  function bindMenus() {
    document.getElementById('btn-new').addEventListener('click', () => {
      if (!confirm('新建项目？未保存的修改将丢失。')) return;
      App.state.root.children = [];
      App.state.selectedId = null;
      App.state.maskEditId = null;
      App.history.clear();
      App.refreshUI();
      App.requestRender();
    });

    const fileInput = document.getElementById('file-input');
    document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          App.persistence.restore(App.state, reader.result);
          zoomFit();
        } catch (err) {
          alert('项目文件无法解析：' + err.message);
        }
      };
      reader.readAsText(f);
      fileInput.value = '';
    });

    document.getElementById('btn-save').addEventListener('click', () => {
      App.persistence.saveToLocal(App.state);
      flashHint('已保存到浏览器本地存储');
    });
    document.getElementById('btn-export-project').addEventListener('click', () =>
      App.persistence.exportFile(App.state));
    document.getElementById('btn-export-png').addEventListener('click', () =>
      App.persistence.exportPNG(App.state));
    document.getElementById('btn-sample').addEventListener('click', () => {
      App.sample.build(App.state);
      zoomFit();
    });

    document.getElementById('btn-undo').addEventListener('click', () => App.history.undo());
    document.getElementById('btn-redo').addEventListener('click', () => App.history.redo());

    // 添加图层下拉
    const sel = document.getElementById('add-layer-select');
    for (const g of App.generators.list()) {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = '🖼 ' + g.name;
      sel.appendChild(o);
    }
    const og = document.createElement('option');
    og.value = 'group'; og.textContent = '📁 组';
    sel.appendChild(og);
    const oa = document.createElement('option');
    oa.value = 'adjustment'; oa.textContent = '🎛 调整层';
    sel.appendChild(oa);
    sel.addEventListener('change', () => {
      if (sel.value) App.actions.addLayer(sel.value);
      sel.value = '';
    });

    // 工具
    document.querySelectorAll('.tool-btn').forEach(b =>
      b.addEventListener('click', () => App.setTool(b.dataset.tool)));

    // 笔刷参数
    const size = document.getElementById('brush-size');
    const hard = document.getElementById('brush-hardness');
    size.addEventListener('input', () => {
      App.state.brush.size = parseInt(size.value, 10);
      document.getElementById('brush-size-val').textContent = size.value;
    });
    hard.addEventListener('input', () => {
      App.state.brush.hardness = parseInt(hard.value, 10) / 100;
      document.getElementById('brush-hardness-val').textContent = hard.value;
    });

    // 缩放
    document.getElementById('btn-zoom-in').addEventListener('click', () => zoomBy(1.25));
    document.getElementById('btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
    document.getElementById('btn-zoom-fit').addEventListener('click', zoomFit);

    window.addEventListener('resize', () => { drawDisplay(); });

    document.addEventListener('keydown', e => {
      const inInput = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? App.history.redo() : App.history.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        App.history.redo();
        return;
      }
      if (inInput) return;
      if (e.key === ' ') { spaceDown = true; e.preventDefault(); }
      else if (e.key === 'b' || e.key === 'B') App.setTool('brush');
      else if (e.key === 'e' || e.key === 'E') App.setTool('eraser');
      else if (e.key === 'h' || e.key === 'H') App.setTool('pan');
      else if (e.key === '[') adjustBrush(-8);
      else if (e.key === ']') adjustBrush(8);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && App.state.selectedId) {
        App.actions.deleteLayer(App.state.selectedId);
      }
    });
    document.addEventListener('keyup', e => {
      if (e.key === ' ') spaceDown = false;
    });
  }

  function adjustBrush(d) {
    const size = document.getElementById('brush-size');
    size.value = App.util.clamp(parseInt(size.value, 10) + d, 4, 300);
    size.dispatchEvent(new Event('input'));
  }

  let hintTimer = null;
  function flashHint(text) {
    const el = document.getElementById('canvas-hint');
    el.textContent = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(updateHint, 2000);
  }

  /* ================= 启动 ================= */

  function init() {
    container = document.getElementById('canvas-container');
    displayCanvas = document.getElementById('display-canvas');
    dctx = displayCanvas.getContext('2d');

    App.history.onChange = () => {
      document.getElementById('btn-undo').disabled = !App.history.canUndo;
      document.getElementById('btn-redo').disabled = !App.history.canRedo;
    };

    bindCanvasEvents();
    bindMenus();
    App.setTool('pan');

    // 优先恢复上次保存的项目，否则载入示例
    if (!App.persistence.loadFromLocal(App.state)) {
      App.sample.build(App.state);
    }
    App.refreshUI();
    App.requestRender();
    // 等布局完成后适配视图
    requestAnimationFrame(zoomFit);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
