// 属性面板：填充与描边分别设置、自相交填充规则、锚点平滑切换
import { findNode, setSmooth, deleteAnchor } from './model.js';

export class PropertiesPanel {
  constructor(store, mountEl) {
    this.store = store;
    this.mount = mountEl;
    store.subscribe((kind) => { if (['change', 'doc', 'history', 'selection', 'gesture'].includes(kind)) this.render(); });
    this.mount.addEventListener('input', (e) => this._onInput(e));
    this.mount.addEventListener('click', (e) => this._onClick(e));
    this.render();
  }

  _singlePath() {
    const { paths } = this.store.selection;
    if (paths.length !== 1) return null;
    const n = findNode(this.store.doc.layers, paths[0]);
    return n?.type === 'path' ? n : null;
  }

  render() {
    this.mount.replaceChildren();
    const node = this._singlePath();
    const multi = this.store.selection.paths.length > 1;

    const head = document.createElement('div');
    head.className = 'prop-head';
    head.textContent = node ? `样式 · ${node.name}` : multi ? `样式 · ${this.store.selection.paths.length} 个路径（批量）` : '样式 · 未选择路径';
    this.mount.append(head);
    if (!node && !multi) {
      const tip = document.createElement('p');
      tip.className = 'prop-tip';
      tip.textContent = '选中一个或多个路径后可统一修改填充与描边。';
      this.mount.append(tip);
      this._renderAnchorSection(null);
      return;
    }

    const target = node || { style: findNode(this.store.doc.layers, this.store.selection.paths[0]).style };
    const s = target.style;

    // ---- 填充 ----
    this.mount.append(this._section('填充', [
      this._colorRow('fill', '填充色', s.fill),
      this._sliderRow('fillOpacity', '不透明度', s.fillOpacity, 0, 1, 0.01),
      this._selectRow('fillRule', '自相交规则', s.fillRule, [
        ['nonzero', 'nonzero（环绕填充）'],
        ['evenodd', 'evenodd（镂空交叉）'],
      ]),
    ]));

    // ---- 描边 ----
    this.mount.append(this._section('描边', [
      this._colorRow('stroke', '描边色', s.stroke),
      this._numRow('strokeWidth', '粗细', s.strokeWidth, 0, 100, 0.5),
      this._sliderRow('strokeOpacity', '不透明度', s.strokeOpacity, 0, 1, 0.01),
      this._selectRow('strokeLinecap', '端点', s.strokeLinecap, [
        ['butt', 'butt 平端'], ['round', 'round 圆端'], ['square', 'square 方端'],
      ]),
      this._selectRow('strokeLinejoin', '拐角', s.strokeLinejoin, [
        ['miter', 'miter 尖角'], ['round', 'round 圆角'], ['bevel', 'bevel 斜切'],
      ]),
      this._selectRow('strokeDash', '虚线', s.strokeDash, [
        ['none', '实线'], ['6 4', '短虚线'], ['12 6', '长虚线'], ['2 4', '点线'],
      ]),
    ]));

    // ---- 整体 ----
    this.mount.append(this._section('整体', [
      this._sliderRow('opacity', '图层不透明度', s.opacity, 0, 1, 0.01),
    ]));

    this._renderAnchorSection(node);
  }

  _renderAnchorSection(node) {
    const sel = this.store.selection.anchor;
    const wrap = this._section('锚点', []);
    if (!node || !sel) {
      const p = document.createElement('p');
      p.className = 'prop-tip';
      p.textContent = node
        ? '用选择工具点击路径上的锚点后，可切换平滑/尖角或删除锚点；双击线段可插入锚点。'
        : '选中路径并点击锚点后可编辑控制柄。';
      wrap.append(p);
      this.mount.append(wrap);
      return;
    }
    const a = node.subpaths[sel.si]?.anchors[sel.ai];
    if (!a) { this.mount.append(wrap); return; }

    const pos = document.createElement('div');
    pos.className = 'prop-row';
    pos.innerHTML = `<span class="prop-label">坐标</span><span class="prop-value">X ${a.x.toFixed(1)}　Y ${a.y.toFixed(1)}</span>`;
    wrap.append(pos);

    const btnRow = document.createElement('div');
    btnRow.className = 'prop-row';
    const smoothBtn = document.createElement('button');
    smoothBtn.className = 'mini-btn';
    smoothBtn.dataset.action = 'toggle-smooth';
    smoothBtn.textContent = a.smooth ? '转为尖角锚点' : '转为平滑锚点';
    const delBtn = document.createElement('button');
    delBtn.className = 'mini-btn danger';
    delBtn.dataset.action = 'delete-anchor';
    delBtn.textContent = '删除锚点';
    btnRow.append(smoothBtn, delBtn);
    wrap.append(btnRow);
    this.mount.append(wrap);
  }

  _section(title, rows) {
    const sec = document.createElement('div');
    sec.className = 'prop-section';
    const h = document.createElement('h3');
    h.textContent = title;
    sec.append(h, ...rows);
    return sec;
  }
  _row(label, control) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const lab = document.createElement('span');
    lab.className = 'prop-label'; lab.textContent = label;
    row.append(lab, control);
    return row;
  }
  _colorRow(key, label, value) {
    const wrap = document.createElement('span');
    wrap.className = 'color-control';
    const picker = document.createElement('input');
    picker.type = 'color'; picker.dataset.key = key;
    picker.value = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
    const text = document.createElement('input');
    text.type = 'text'; text.className = 'color-text'; text.dataset.key = key;
    text.value = value;
    wrap.append(picker, text);
    return this._row(label, wrap);
  }
  _sliderRow(key, label, value, min, max, step) {
    const input = document.createElement('input');
    input.type = 'range'; input.dataset.key = key;
    input.min = min; input.max = max; input.step = step; input.value = value;
    const num = document.createElement('span');
    num.className = 'prop-value'; num.textContent = Number(value).toFixed(2);
    input.addEventListener('input', () => { num.textContent = Number(input.value).toFixed(2); });
    const wrap = document.createElement('span');
    wrap.className = 'slider-control';
    wrap.append(input, num);
    return this._row(label, wrap);
  }
  _numRow(key, label, value, min, max, step) {
    const input = document.createElement('input');
    input.type = 'number'; input.dataset.key = key;
    input.min = min; input.max = max; input.step = step; input.value = value;
    return this._row(label, input);
  }
  _selectRow(key, label, value, options) {
    const input = document.createElement('select');
    input.dataset.key = key;
    for (const [v, t] of options) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === String(value)) o.selected = true;
      input.append(o);
    }
    return this._row(label, input);
  }

  _targets() {
    const ids = this.store.selection.paths;
    return ids.map((id) => findNode(this.store.doc.layers, id)).filter((n) => n && n.type === 'path');
  }

  _onInput(e) {
    const input = e.target.closest('[data-key]');
    if (!input) return;
    const key = input.dataset.key;
    let value = input.type === 'range' || input.type === 'number' ? parseFloat(input.value) : input.value;
    const targets = this._targets();
    if (!targets.length) return;
    this.store.run(`修改${key}`, () => {
      for (const n of targets) {
        n.style[key] = value;
        if (key === 'strokeWidth' && value < 0) n.style[key] = 0;
      }
      // 颜色选择器与文本框双向同步
      if (input.classList.contains('color-text') || input.type === 'color') {
        const row = input.closest('.color-control');
        const [picker, text] = row.children;
        if (input.type === 'color') text.value = value;
        else if (/^#[0-9a-fA-F]{6}$/.test(value)) picker.value = value;
      }
    });
  }

  _onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const sel = this.store.selection.anchor;
    const node = this._singlePath();
    if (!node || !sel) return;
    if (btn.dataset.action === 'toggle-smooth') {
      const a = node.subpaths[sel.si].anchors[sel.ai];
      this.store.run('切换锚点平滑', () => setSmooth(node, sel.si, sel.ai, !a.smooth));
    }
    if (btn.dataset.action === 'delete-anchor') {
      this.store.run('删除锚点', () => {
        deleteAnchor(node, sel.si, sel.ai);
        if (!node.subpaths.length) return false;
        this.store.select([node.id]);
      });
    }
  }
}
