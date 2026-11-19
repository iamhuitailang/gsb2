/* 图层面板（树形列表、拖拽排序/分组）与属性面板 */
window.App = window.App || {};

App.ui = (function () {
  const M = () => App.model;

  const BLEND_MODES = [
    ['source-over', '正常'], ['multiply', '正片叠底'], ['screen', '滤色'],
    ['overlay', '叠加'], ['darken', '变暗'], ['lighten', '变亮'],
    ['color-dodge', '颜色减淡'], ['color-burn', '颜色加深'],
    ['hard-light', '强光'], ['soft-light', '柔光'],
    ['difference', '差值'], ['exclusion', '排除'],
    ['hue', '色相'], ['saturation', '饱和度'], ['color', '颜色'], ['luminosity', '明度']
  ];

  const TYPE_ICONS = { image: '🖼', group: '📁', adjustment: '🎛' };

  const collapsed = new Set(); // 折叠的组 id（仅 UI 状态）
  let dragId = null;

  /* ---------- 属性读写（支持 'adjust.hue' 这类路径） ---------- */
  function getProp(layer, key) {
    return key.includes('.') ? key.split('.').reduce((o, k) => o[k], layer) : layer[key];
  }
  function setProp(layer, key, v) {
    if (key.includes('.')) {
      const parts = key.split('.');
      const last = parts.pop();
      parts.reduce((o, k) => o[k], layer)[last] = v;
    } else {
      layer[key] = v;
    }
  }
  App.getProp = getProp;
  App.setProp = setProp;

  /* ---------- 图层面板 ---------- */

  function rebuildLayers() {
    const panel = document.getElementById('layers-panel');
    panel.innerHTML = '';
    buildLevel(panel, App.state.root.children);
    const zone = document.createElement('div');
    zone.className = 'drop-zone-root';
    zone.textContent = '拖到此处移至根级';
    bindDropZone(zone, null);
    panel.appendChild(zone);
  }

  function buildLevel(container, children) {
    for (const L of children) {
      const row = document.createElement('div');
      row.className = 'layer-row' + (L.id === App.state.selectedId ? ' selected' : '');
      row.draggable = !L.locked;
      row.dataset.id = L.id;

      // 组折叠箭头
      if (L.type === 'group') {
        const arrow = document.createElement('span');
        arrow.className = 'icon-btn';
        arrow.textContent = collapsed.has(L.id) ? '▸' : '▾';
        arrow.title = '折叠/展开';
        arrow.addEventListener('click', e => {
          e.stopPropagation();
          collapsed.has(L.id) ? collapsed.delete(L.id) : collapsed.add(L.id);
          rebuildLayers();
        });
        row.appendChild(arrow);
      }

      const vis = document.createElement('span');
      vis.className = 'icon-btn' + (L.visible ? '' : ' off');
      vis.textContent = '👁';
      vis.title = '显示/隐藏';
      vis.addEventListener('click', e => {
        e.stopPropagation();
        App.pushParam((L.visible ? '隐藏' : '显示') + '图层', L.id, 'visible', L.visible, !L.visible);
      });
      row.appendChild(vis);

      const lock = document.createElement('span');
      lock.className = 'icon-btn' + (L.locked ? '' : ' off');
      lock.textContent = L.locked ? '🔒' : '🔓';
      lock.title = '锁定/解锁';
      lock.addEventListener('click', e => {
        e.stopPropagation();
        App.pushParam((L.locked ? '解锁' : '锁定') + '图层', L.id, 'locked', L.locked, !L.locked);
      });
      row.appendChild(lock);

      const icon = document.createElement('span');
      icon.className = 'type-icon';
      icon.textContent = TYPE_ICONS[L.type];
      row.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = L.name;
      name.title = L.name;
      row.appendChild(name);

      if (L.mask) {
        const dot = document.createElement('span');
        dot.className = 'mask-dot' + (App.state.maskEditId === L.id ? ' editing' : '');
        dot.title = App.state.maskEditId === L.id ? '正在编辑遮罩' : '含遮罩';
        row.appendChild(dot);
      }

      const meta = document.createElement('span');
      meta.className = 'layer-meta';
      const bm = BLEND_MODES.find(b => b[0] === L.blendMode);
      meta.textContent = L.type === 'adjustment'
        ? '调整'
        : (bm ? bm[1] : '') + ' ' + Math.round(L.opacity * 100) + '%';
      row.appendChild(meta);

      row.addEventListener('click', () => App.setSelected(L.id));

      // 拖拽排序
      row.addEventListener('dragstart', e => {
        dragId = L.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', L.id);
      });
      row.addEventListener('dragend', () => { dragId = null; clearDropHints(); });
      bindDropZone(row, L);

      container.appendChild(row);

      if (L.type === 'group' && !collapsed.has(L.id)) {
        const sub = document.createElement('div');
        sub.className = 'group-children';
        buildLevel(sub, L.children);
        container.appendChild(sub);
      }
    }
  }

  function bindDropZone(el, targetLayer) {
    el.addEventListener('dragover', e => {
      if (!dragId) return;
      const layer = M().findLayer(App.state.root.children, dragId);
      if (!layer) return;
      if (targetLayer) {
        if (targetLayer.id === dragId) return;
        if (M().isDescendant(layer, targetLayer.id)) return; // 不能拖进自己的子级
      }
      e.preventDefault();
      e.stopPropagation();
      clearDropHints();
      let pos = 'inside';
      if (targetLayer) {
        const rect = el.getBoundingClientRect();
        const ratio = (e.clientY - rect.top) / rect.height;
        if (targetLayer.type === 'group') {
          pos = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'inside';
        } else {
          pos = ratio < 0.5 ? 'before' : 'after';
        }
      }
      el.classList.add(pos === 'inside' ? 'drop-inside' : pos === 'before' ? 'drop-before' : 'drop-after');
      el._dropPos = pos;
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    el.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      const pos = el._dropPos || 'inside';
      const targetId = targetLayer ? targetLayer.id : null;
      clearDropHints();
      if (dragId) App.actions.moveLayer(dragId, targetId, pos);
      dragId = null;
    });
  }

  function clearDropHints() {
    document.querySelectorAll('.drop-before,.drop-after,.drop-inside')
      .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-inside'));
  }

  /* ---------- 属性面板 ---------- */

  function rebuildProps() {
    const panel = document.getElementById('props-panel');
    panel.innerHTML = '';
    const L = App.state.selectedId && M().findLayer(App.state.root.children, App.state.selectedId);
    if (!L) {
      panel.innerHTML = '<p class="empty-tip">未选中图层</p>';
      return;
    }

    // 名称
    const nameRow = el('div', 'prop-row');
    nameRow.appendChild(label('名称'));
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = L.name;
    nameInput.disabled = L.locked;
    nameInput.addEventListener('change', () => {
      if (nameInput.value !== L.name) App.pushParam('重命名', L.id, 'name', L.name, nameInput.value);
    });
    nameRow.appendChild(nameInput);
    panel.appendChild(nameRow);

    // 不透明度（调整层的不透明度不参与渲染，不显示）
    if (L.type !== 'adjustment') {
      panel.appendChild(rangeRow(L, '不透明度', 'opacity', 0, 1, 0.01,
        v => Math.round(v * 100) + '%'));
    }

    // 混合方式（调整层无混合模式）
    if (L.type !== 'adjustment') {
      const row = el('div', 'prop-row');
      row.appendChild(label('混合方式'));
      const sel = document.createElement('select');
      for (const [val, text] of BLEND_MODES) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = text;
        sel.appendChild(opt);
      }
      sel.value = L.blendMode;
      sel.disabled = L.locked;
      sel.addEventListener('change', () => {
        App.pushParam('混合方式', L.id, 'blendMode', L.blendMode, sel.value);
      });
      row.appendChild(sel);
      panel.appendChild(row);
    }

    // 调整层参数
    if (L.type === 'adjustment') {
      panel.appendChild(rangeRow(L, '亮度', 'adjust.brightness', 0, 2, 0.01));
      panel.appendChild(rangeRow(L, '对比度', 'adjust.contrast', 0, 2, 0.01));
      panel.appendChild(rangeRow(L, '饱和度', 'adjust.saturate', 0, 2, 0.01));
      panel.appendChild(rangeRow(L, '色相', 'adjust.hue', -180, 180, 1, v => v + '°'));
      panel.appendChild(rangeRow(L, '灰度', 'adjust.grayscale', 0, 1, 0.01));
      panel.appendChild(rangeRow(L, '反相', 'adjust.invert', 0, 1, 0.01));
      const tip = el('p', 'empty-tip');
      tip.textContent = '调整层作用于其下方所有已合成内容，可拖动重排。';
      panel.appendChild(tip);
    }

    // 遮罩
    if (L.type !== 'adjustment') {
      const row = el('div', 'prop-row');
      row.appendChild(label('遮罩'));
      const status = el('span', 'mask-status' + (L.mask ? '' : ' none'));
      status.textContent = L.mask ? (App.state.maskEditId === L.id ? '编辑中（画笔/橡皮涂抹）' : '已添加') : '无';
      row.appendChild(status);
      panel.appendChild(row);

      const actions = el('div', 'prop-actions');
      if (!L.mask) {
        actions.appendChild(actionBtn('添加遮罩', L.locked, () =>
          App.structural('添加遮罩', () => M().createMask(L, App.state.doc.width, App.state.doc.height))));
      } else {
        const editing = App.state.maskEditId === L.id;
        actions.appendChild(actionBtn(editing ? '停止编辑遮罩' : '编辑遮罩', L.locked, () => {
          App.state.maskEditId = editing ? null : L.id;
          if (!editing) App.setTool('brush');
          App.refreshUI();
          App.requestRender();
        }, editing));
        actions.appendChild(actionBtn('反相遮罩', L.locked, () =>
          App.structural('反相遮罩', () => {
            // 替换为新画布而非原地修改，保证结构快照的撤销能还原。
            // 遮罩以 alpha 表达可见性，反相 = 全不透明减去当前遮罩
            const inv = App.util.makeCanvas(L.mask.width, L.mask.height);
            const ctx = inv.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, inv.width, inv.height);
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(L.mask, 0, 0);
            L.mask = inv;
          })));
        actions.appendChild(actionBtn('删除遮罩', L.locked, () =>
          App.structural('删除遮罩', () => {
            L.mask = null;
            if (App.state.maskEditId === L.id) App.state.maskEditId = null;
          })));
      }
      panel.appendChild(actions);
    }

    // 删除图层
    const del = el('div', 'prop-actions');
    del.appendChild(actionBtn('删除图层', L.locked, () => App.actions.deleteLayer(L.id)));
    panel.appendChild(del);
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function label(text) {
    const l = el('label');
    l.textContent = text;
    return l;
  }
  function actionBtn(text, disabled, onClick, active) {
    const b = el('button');
    b.textContent = text;
    b.disabled = !!disabled;
    if (active) b.classList.add('active');
    b.addEventListener('click', onClick);
    return b;
  }

  /* 数值滑杆：拖动实时预览，松开后作为一次撤销操作 */
  function rangeRow(layer, labelText, key, min, max, step, fmt) {
    const row = el('div', 'prop-row');
    row.appendChild(label(labelText));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = getProp(layer, key);
    input.disabled = layer.locked;
    const val = el('span', 'val');
    const show = v => { val.textContent = fmt ? fmt(v) : (Math.round(v * 100) / 100); };
    show(getProp(layer, key));

    let startVal;
    const capture = () => { startVal = getProp(layer, key); };
    input.addEventListener('pointerdown', capture);
    input.addEventListener('focusin', capture);
    input.addEventListener('input', () => {
      setProp(layer, key, parseFloat(input.value));
      show(parseFloat(input.value));
      App.requestRender();
    });
    input.addEventListener('change', () => {
      const end = getProp(layer, key);
      if (startVal !== undefined && startVal !== end) {
        App.pushParam(labelText, layer.id, key, startVal, end);
      }
      startVal = undefined;
    });

    row.appendChild(input);
    row.appendChild(val);
    return row;
  }

  return { rebuildLayers, rebuildProps, BLEND_MODES };
})();
