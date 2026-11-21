/*
 * tree.js — 左侧组件树
 */
(function (root) {
  'use strict';
  var M = root.ULCModel;

  function TreeView(opts) {
    this.el = opts.el;
    this.onSelect = opts.onSelect;
    this.onAdd = opts.onAdd;
    this.onDelete = opts.onDelete;
    this.onReparent = opts.onReparent;
    this.nodes = [];
    this.result = null;
    this.selectedId = null;
    this._bind();
  }

  TreeView.prototype._bind = function () {
    var self = this;
    this.el.addEventListener('click', function (ev) {
      var row = ev.target.closest('.tv-row');
      if (!row) return;
      var id = row.dataset.id;
      if (ev.target.matches('.tv-del')) { self.onDelete(id); return; }
      if (ev.target.matches('.tv-add')) { self.onAdd(id); return; }
      self.onSelect(id);
    });
    this.el.addEventListener('change', function (ev) {
      if (!ev.target.matches('.tv-parent-select')) return;
      self.onReparent(ev.target.closest('.tv-row').dataset.id, ev.target.value || null);
    });
  };

  TreeView.prototype.render = function (nodes, result, selectedId) {
    this.nodes = nodes;
    this.result = result;
    this.selectedId = selectedId;
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var dangling = {};
    M.findDanglingRefs(nodes).forEach(function (d) { dangling[d.nodeId + d.slot] = true; });
    var cycles = M.findCycles(nodes);
    var inCycle = {};
    cycles.forEach(function (path) { path.forEach(function (id) { inCycle[id] = true; }); });

    var html = '';
    var roots = nodes.filter(function (n) { return !n.parentId || !byId[n.parentId]; });
    function walk(id, depth) {
      var n = byId[id];
      var hidden = result.hiddenReason[id];
      var cls = 'tv-row' + (id === selectedId ? ' tv-sel' : '');
      var badges = '';
      if (hidden) badges += '<em class="tv-badge tv-b-hidden" title="主动隐藏：' + hidden.text + '">隐</em>';
      if (inCycle[id]) badges += '<em class="tv-badge tv-b-err" title="参照循环">环</em>';
      M.anchorSlots().forEach(function (s) {
        if (dangling[id + s]) badges += '<em class="tv-badge tv-b-err" title="' + E_slot(s) + '参照已删除">断</em>';
      });
      if (n.previewOnly) badges += '<em class="tv-badge tv-b-prev" title="仅预览，不进运行配置">预览</em>';

      var parentOptions = '<option value="">（根级）</option>' +
        nodes.filter(function (x) {
          return x.id !== id && M.ancestorIds(nodes, id).indexOf(x.id) < 0 && x.type === 'panel';
        }).map(function (x) {
          return '<option value="' + x.id + '"' + (x.id === n.parentId ? ' selected' : '') + '>' +
            escapeHtml(x.name) + '</option>';
        }).join('');

      html += '<div class="' + cls + '" data-id="' + id + '" style="padding-left:' + (8 + depth * 16) + 'px">' +
        '<span class="tv-type tv-type-' + n.type + '">' + typeIcon(n.type) + '</span>' +
        '<span class="tv-name">' + escapeHtml(n.name) + '</span>' + badges +
        '<span class="tv-actions">' +
        '<button class="tv-add" title="在该容器下新建组件">＋</button>' +
        '<button class="tv-del" title="删除（悬空参照会被标红报错）">✕</button>' +
        '</span>' +
        '<select class="tv-parent-select" title="父容器（定位参照）">' + parentOptions + '</select>' +
        '</div>';
      M.childrenOf(nodes, id).forEach(function (c) { walk(c.id, depth + 1); });
    }
    roots.forEach(function (r) { walk(r.id, 0); });
    this.el.innerHTML = html;
  };

  function E_slot(s) {
    return root.ULCEngine.slotLabel(s);
  }
  function typeIcon(t) {
    return { panel: '▣', text: 'T', icon: '◈', bar: '▮', edge: '⌐' }[t] || '?';
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  root.ULCTreeView = TreeView;
})(typeof self !== 'undefined' ? self : this);
