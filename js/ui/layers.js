/* 左侧图层面板 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const h = G.util.h;

  let dragId = null;
  let dropHint = null; // {id, pos}

  function typeBadge(layer) {
    const map = {
      text: ['文', 'type-text'],
      rect: ['矩', 'type-rect'],
      image: ['图', 'type-image'],
      group: ['组', 'type-group'],
    };
    const [ch, cls] = map[layer.type] || ['层', 'type-rect'];
    return h('span', { class: `layer-ico ${cls}` }, ch);
  }

  function flagButton(kind, layer, effectiveState) {
    const isEye = kind === 'eye';
    const off = isEye ? layer.visible === false : layer.locked !== true;
    // eye: active when visible; lock: active when locked
    const cls = `layer-flag ${isEye ? (layer.visible === false ? 'off' : 'active') : (layer.locked ? 'active' : 'off')}`;
    const btn = h('button', {
      class: cls,
      title: isEye ? (layer.visible === false ? '显示图层' : '隐藏图层') : (layer.locked ? '解锁图层' : '锁定图层'),
      'aria-label': isEye ? '切换显示' : '切换锁定',
      innerHTML: isEye
        ? (layer.visible === false ? G.icons.eyeOff : G.icons.eye)
        : (layer.locked ? G.icons.lock : G.icons.unlock),
      onclick: (e) => {
        e.stopPropagation();
        if (isEye) G.App.toggleVisible(layer.id);
        else G.App.toggleLock(layer.id);
      },
    });
    return btn;
  }

  function startRename(layer, nameSpan) {
    const row = nameSpan.closest('.layer-row');
    const input = h('input', {
      class: 'layer-name-input',
      value: layer.name,
      maxlength: '60',
    });
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      G.App.renameLayer(layer.id, v || layer.name);
      G.App.refreshAll();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { done = true; G.App.refreshAll(); }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('dblclick', (e) => e.stopPropagation());
  }

  function rowEl(layer, depth, meta) {
    const app = G.App;
    const selected = app.state.selection.includes(layer.id);
    const cls = [
      'layer-row',
      selected ? 'selected' : '',
      layer.type === 'group' ? 'is-group' : '',
      layer.visible === false || meta.hidden ? 'hidden-layer' : '',
      layer.locked || meta.locked ? 'locked-layer' : '',
    ].join(' ');

    const caret = layer.type === 'group'
      ? h('span', {
          class: 'layer-caret',
          innerHTML: layer.collapsed ? '▶' : '▼',
          title: layer.collapsed ? '展开编组' : '折叠编组',
          onclick: (e) => { e.stopPropagation(); app.toggleCollapse(layer.id); },
        })
      : h('span', { class: 'layer-caret placeholder' }, '');

    const nameSpan = h('span', {
      class: 'layer-name',
      title: '双击重命名',
      ondblclick: (e) => { e.stopPropagation(); startRename(layer, e.currentTarget); },
    }, layer.name);

    const row = h('div', {
      class: cls,
      role: 'listitem',
      draggable: 'true',
      dataset: { id: layer.id },
      style: { paddingLeft: `${6 + depth * 16}px` },
      onclick: (e) => app.selectLayer(layer.id, { additive: e.metaKey || e.ctrlKey, range: e.shiftKey }),
    }, [
      caret,
      typeBadge(layer),
      nameSpan,
      flagButton('eye', layer, meta),
      flagButton('lock', layer, meta),
    ]);

    /* 拖拽排序 / 入组 */
    row.addEventListener('dragstart', (e) => {
      dragId = layer.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', layer.id); } catch (err) { /* ignore */ }
    });
    row.addEventListener('dragover', (e) => {
      if (!dragId || dragId === layer.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      let pos;
      if (layer.type === 'group' && ratio > 0.25 && ratio < 0.75) pos = 'into';
      else pos = ratio < 0.5 ? 'before' : 'after';
      dropHint = { id: layer.id, pos };
      row.parentElement.querySelectorAll('.layer-row').forEach((r) =>
        r.classList.remove('drop-before', 'drop-after', 'drop-into'));
      row.classList.add(pos === 'before' ? 'drop-before' : pos === 'after' ? 'drop-after' : 'drop-into');
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('drop-before', 'drop-after', 'drop-into');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragId && dropHint && dropHint.id === layer.id) {
        app.moveLayer(dragId, layer.id, dropHint.pos);
      }
      clearHints();
    });
    row.addEventListener('dragend', clearHints);

    return row;
  }

  function clearHints() {
    dragId = null;
    dropHint = null;
    document.querySelectorAll('.layer-row').forEach((r) =>
      r.classList.remove('drop-before', 'drop-after', 'drop-into'));
  }

  function renderNodes(nodes, depth, parentMeta) {
    const out = [];
    nodes.forEach((layer) => {
      const meta = {
        hidden: parentMeta.hidden || layer.visible === false,
        locked: parentMeta.locked || layer.locked === true,
      };
      out.push(rowEl(layer, depth, meta));
      if (layer.type === 'group' && !layer.collapsed) {
        out.push(...renderNodes(layer.children || [], depth + 1, meta));
      }
    });
    return out;
  }

  function render() {
    const tree = document.getElementById('layersTree');
    if (!tree) return;
    const p = G.App.state.project;
    tree.innerHTML = '';

    if (!p.children.length) {
      tree.appendChild(h('div', { class: 'layers-empty' }, [
        h('div', { style: { fontSize: '26px', opacity: '.6' } }, '✦'),
        h('div', null, '还没有图层'),
        h('div', null, '点击上方「文字 / 矩形 / 图片」开始创作'),
      ]));
      return;
    }

    const frag = document.createDocumentFragment();
    renderNodes(p.children, 0, { hidden: false, locked: false }).forEach((el) => frag.appendChild(el));

    // 空白区域作为拖到根级末尾的放置区
    const spacer = h('div', { style: { height: '40px' } });
    spacer.addEventListener('dragover', (e) => { e.preventDefault(); });
    spacer.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragId) G.App.moveLayer(dragId, null, 'end');
      clearHints();
    });
    frag.appendChild(spacer);

    tree.appendChild(frag);
  }

  G.UI = G.UI || {};
  G.UI.Layers = { render };
})();
