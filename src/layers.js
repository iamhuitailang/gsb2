// 图层面板：树形列表 + 显隐/锁定/排序/分组/合并/拆分入口
import {
  findNode, reorder, groupNodes, ungroup, removeNode, cloneNode,
  mergePaths, splitPath, toggleClose, locate,
} from './model.js';

export class LayersPanel {
  constructor(store, mountEl) {
    this.store = store;
    this.mount = mountEl;
    store.subscribe((kind) => { if (['change', 'doc', 'history', 'selection', 'gesture'].includes(kind)) this.render(); });
    this.mount.addEventListener('click', (e) => this._onClick(e));
    this.render();
  }

  render() {
    this.mount.replaceChildren();
    const tree = document.createElement('div');
    tree.className = 'layer-tree';
    if (!this.store.doc.layers.length) {
      const empty = document.createElement('div');
      empty.className = 'layer-empty';
      empty.textContent = '暂无图层，选择左侧工具开始绘制';
      tree.append(empty);
    }
    // 栈顶显示在最上方
    this._renderList(this.store.doc.layers, tree, 0, true);
    this.mount.append(tree);
    this._renderToolbar();
  }

  _renderList(list, parent, depth, reverse) {
    const ordered = reverse ? [...list].reverse() : list;
    for (const node of ordered) {
      const row = document.createElement('div');
      row.className = 'layer-row';
      row.style.setProperty('--depth', depth);
      row.dataset.id = node.id;
      const selected = this.store.selection.paths.includes(node.id);
      if (selected) row.classList.add('selected');
      if (node.type === 'group') row.classList.add('is-group');
      if (node.locked) row.classList.add('is-locked');
      if (!node.visible) row.classList.add('is-hidden');

      const typeIcon = document.createElement('span');
      typeIcon.className = `layer-icon icon-${node.type}`;
      typeIcon.textContent = node.type === 'group' ? '📁' : '◆';

      const name = document.createElement('span');
      name.className = 'layer-name';
      name.textContent = node.name;
      name.title = '双击重命名';

      const actions = document.createElement('span');
      actions.className = 'layer-actions';
      actions.append(
        this._iconBtn(node.visible ? '👁' : '🚫', 'toggle-visible', node.visible ? '隐藏' : '显示'),
        this._iconBtn(node.locked ? '🔒' : '🔓', 'toggle-lock', node.locked ? '解锁' : '锁定'),
      );

      row.append(typeIcon, name, actions);
      parent.append(row);

      if (node.type === 'group') {
        const childWrap = document.createElement('div');
        childWrap.className = 'layer-children';
        this._renderList(node.children, childWrap, depth + 1, false);
        parent.append(childWrap);
      }
    }
  }

  _iconBtn(text, action, title) {
    const b = document.createElement('button');
    b.className = 'icon-btn';
    b.textContent = text;
    b.dataset.action = action;
    b.title = title;
    return b;
  }

  _renderToolbar() {
    const bar = document.createElement('div');
    bar.className = 'layer-toolbar';
    const defs = [
      ['up', '↑', '上移一层'], ['down', '↓', '下移一层'],
      ['top', '⤒', '置顶'], ['bottom', '⤓', '置底'],
      ['group', '⊟', '编组（仅同父级多选）'], ['ungroup', '⊞', '解组'],
      ['merge', '⊕', '合并路径'], ['split', '⊘', '拆分路径'],
      ['close', '◔', '闭合/打开'], ['dup', '⧉', '复制'], ['del', '🗑', '删除'],
    ];
    for (const [action, text, title] of defs) {
      const b = document.createElement('button');
      b.className = 'tool-btn';
      b.textContent = text; b.title = title; b.dataset.action = action;
      bar.append(b);
    }
    this.mount.append(bar);
  }

  _onClick(e) {
    const actionBtn = e.target.closest('[data-action]');
    const row = e.target.closest('.layer-row');
    if (!actionBtn && !row) return;
    const action = actionBtn?.dataset.action;
    const id = (actionBtn?.closest('.layer-row') || row)?.dataset.id;
    const store = this.store;

    if (action && id) {
      const node = findNode(store.doc.layers, id);
      if (!node) return;
      switch (action) {
        case 'toggle-visible':
          store.run('显示/隐藏图层', () => { node.visible = !node.visible; });
          return;
        case 'toggle-lock':
          store.run('锁定/解锁图层', () => { node.locked = !node.locked; });
          return;
      }
    }

    if (action) {
      const ids = store.selection.paths;
      const singleId = ids.length === 1 ? ids[0] : null;
      const single = singleId ? findNode(store.doc.layers, singleId) : null;
      switch (action) {
        case 'up': case 'down': case 'top': case 'bottom':
          if (singleId) store.run('调整图层顺序', () => reorder(store.doc, singleId, action));
          break;
        case 'group':
          if (ids.length >= 2) {
            store.run('编组', () => {
              const g = groupNodes(store.doc, ids);
              if (!g) return false;
              store.select([g.id]);
            });
          }
          break;
        case 'ungroup':
          if (single?.type === 'group') {
            store.run('解组', () => {
              const children = ungroup(store.doc, single.id);
              store.select(children.map((c) => c.id));
            });
          }
          break;
        case 'merge':
          if (ids.length >= 2) {
            store.run('合并路径', () => {
              const merged = mergePaths(store.doc, ids);
              if (!merged) return false;
              store.select([merged.id]);
            });
          }
          break;
        case 'split': {
          if (!single || single.type !== 'path') break;
          store.run('拆分路径', () => {
            const made = splitPath(store.doc, single.id, []);
            if (!made.length) return false;
            store.select(made.map((n) => n.id));
          });
          break;
        }
        case 'close':
          if (single?.type === 'path') store.run('闭合/打开路径', () => toggleClose(single));
          break;
        case 'dup': {
          if (!singleId) break;
          store.run('复制图层', () => {
            const loc = locate(store.doc, singleId);
            const copy = cloneNode(loc.node);
            loc.list.splice(loc.index + 1, 0, copy);
            store.select([copy.id]);
          });
          break;
        }
        case 'del':
          if (ids.length) {
            store.run('删除图层', () => {
              for (const delId of [...ids]) removeNode(store.doc, delId);
              store.clearSelection();
            });
          }
          break;
      }
      return;
    }

    // 行点击：切换选择（支持在列表中切换重叠路径）
    if (row && id) {
      if (e.shiftKey) store.toggleSelection(id);
      else store.select([id]);
    }
  }

  // 双击重命名
  bindRename() {
    this.mount.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('.layer-name');
      if (!nameEl) return;
      const row = nameEl.closest('.layer-row');
      const node = findNode(this.store.doc.layers, row.dataset.id);
      if (!node) return;
      const input = document.createElement('input');
      input.value = node.name;
      nameEl.replaceWith(input);
      input.focus(); input.select();
      const finish = () => {
        this.store.run('重命名图层', () => { node.name = input.value.trim() || node.name; });
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') this.render();
      });
    });
  }
}
