/*
 * app.js — 主控制器：共享组件树 + 双预览，接线全部面板
 */
(function () {
  'use strict';
  var M = window.ULCModel, E = window.ULCEngine, Store = window.ULCStore;

  var state = Store.load() || Store.defaultState();
  var views = {};
  var results = { a: null, b: null };

  function init() {
    views.tree = new window.ULCTreeView({
      el: document.getElementById('tree'),
      onSelect: selectNode,
      onAdd: addNode,
      onDelete: deleteNode,
      onReparent: reparentNode
    });
    views.inspector = new window.ULCInspector({
      el: document.getElementById('inspector'),
      onEdit: applyOps
    });
    views.issues = new window.ULCIssuesView({
      el: document.getElementById('issues'),
      onSelect: selectNode,
      onLocate: locateInPreview,
      onApplyFix: function (fx) { applyOps(fx.ops); pushLog('应用修复：' + fx.label); }
    });
    views.previews = {
      a: new window.ULCPreviewView({
        container: document.getElementById('preview-a'),
        onSelect: selectNode,
        onChange: function (op) { applyOps([op]); },
        onHitTest: function (p, id) { updateHitReadout('a', p, id); }
      }),
      b: new window.ULCPreviewView({
        container: document.getElementById('preview-b'),
        onSelect: selectNode,
        onChange: function (op) { applyOps([op]); },
        onHitTest: function (p, id) { updateHitReadout('b', p, id); }
      })
    };

    bindToolbar();
    bindPreviewControls('a');
    bindPreviewControls('b');
    document.getElementById('issue-filter').addEventListener('change', function (ev) {
      state.ui.issueFilter = ev.target.value;
      renderAll();
    });
    renderAll();
    window.addEventListener('resize', renderAll);
  }

  /* ---------------- 求解 ---------------- */

  function previewVars(key) {
    return Store.deriveVars(state.previewVarOverrides[key] || {});
  }

  function solve(key) {
    var p = state.previews[key === 'a' ? 0 : 1];
    var screen = state.screens[p.screenKey];
    var vars = previewVars(key);
    return E.solveLayout(state.nodes, screen, vars, window.ULCMeasure.measureNode);
  }

  function renderAll(reason) {
    results.a = solve('a');
    results.b = solve('b');
    views.tree.render(state.nodes, results.a, state.ui.selectedId);
    views.inspector.render(state.nodes, M.findNode(state.nodes, state.ui.selectedId));
    renderPreview('a');
    renderPreview('b');
    renderIssues();
    renderStats();
    Store.save(state);
    if (reason) pushLog(reason);
  }

  function renderPreview(key) {
    var idx = key === 'a' ? 0 : 1;
    var p = state.previews[idx];
    views.previews[key].render({
      nodes: state.nodes,
      screen: state.screens[p.screenKey],
      result: results[key],
      vars: previewVars(key),
      selectedId: state.ui.selectedId,
      showGuides: p.showGuides
    });
  }

  function renderIssues() {
    var active = state.ui.activePreview === 'b' ? results.b : results.a;
    views.issues.render(active, state.nodes, state.ui.issueFilter);
  }

  function renderStats() {
    ['a', 'b'].forEach(function (key) {
      var r = results[key];
      var el = document.getElementById('stats-' + key);
      el.innerHTML = '组件 ' + r.stats.total + ' · 可见 ' + r.stats.visible +
        ' · 隐藏 ' + r.stats.hidden +
        (r.stats.errors ? ' · <b class="st-err">错误 ' + r.stats.errors + '</b>' : '') +
        (r.stats.conflicts ? ' · <b class="st-conf">冲突 ' + r.stats.conflicts + '</b>' : '') +
        (r.stats.warnings ? ' · <b class="st-warn">警告 ' + r.stats.warnings + '</b>' : '');
    });
  }

  /* ---------------- 编辑操作 ---------------- */

  function applyOps(ops) {
    var before = snapshotNodes();
    ops.forEach(function (op) { M.applyOp(state.nodes, op); });
    var changed = diffNodeIds(before, state.nodes);
    var affected = M.collectDependents(state.nodes, changed);
    state.presetName = 'custom';
    renderAll('条件/属性变化 → 重算 ' + affected.length + ' 个依赖组件：' +
      affected.slice(0, 5).map(function (id) {
        var n = M.findNode(state.nodes, id);
        return n ? n.name : id;
      }).join('、') + (affected.length > 5 ? ' 等' : ''));
  }

  function selectNode(id) {
    state.ui.selectedId = id;
    renderAll();
  }

  function addNode(parentId) {
    var type = prompt('新组件类型：panel / text / icon / bar / edge', 'text');
    if (!type || M.NODE_TYPES.indexOf(type) < 0) return;
    var n = M.createNode({
      type: type,
      parentId: parentId || null,
      name: M.defaultName({ type: type }) + Date.now() % 100
    });
    if (type === 'icon') { n.icon = 'gear'; n.width = { mode: 'fixed', value: 20 }; n.height = { mode: 'fixed', value: 20 }; }
    if (type === 'bar') n.width = { mode: 'fixed', value: 100 };
    state.nodes.push(n);
    state.ui.selectedId = n.id;
    renderAll('新增「' + n.name + '」');
  }

  function deleteNode(id) {
    var n = M.findNode(state.nodes, id);
    if (!n) return;
    if (!confirm('删除「' + n.name + '」？参照它的锚点会变成悬空并报错。')) return;
    state.nodes = M.removeNode(state.nodes, id);
    if (state.ui.selectedId === id) state.ui.selectedId = null;
    renderAll('删除「' + n.name + '」→ 悬空参照已标出');
  }

  function reparentNode(id, parentId) {
    var n = M.findNode(state.nodes, id);
    if (!n) return;
    n.parentId = parentId;
    renderAll('移动「' + n.name + '」的父容器');
  }

  function locateInPreview(id) {
    state.ui.activePreview = 'a';
    // 触发该预览里节点闪烁
    renderAll();
    var el = document.querySelector('#preview-a .pv-node[data-id="' + id + '"]');
    if (el) {
      el.classList.add('pv-flash');
      setTimeout(function () { el.classList.remove('pv-flash'); }, 1200);
    }
  }

  /* ---------------- 工具栏 ---------------- */

  function bindToolbar() {
    document.getElementById('btn-preset-conflict').onclick = function () {
      state.nodes = window.ULCPresets.conflict();
      state.presetName = 'conflict';
      state.ui.selectedId = null;
      renderAll('载入窄屏冲突预设');
    };
    document.getElementById('btn-preset-healthy').onclick = function () {
      state.nodes = window.ULCPresets.healthy();
      state.presetName = 'healthy';
      renderAll('载入健康预设');
    };
    document.getElementById('btn-demo-cycle').onclick = demoCycle;
    document.getElementById('btn-demo-dangling').onclick = demoDangling;
    document.getElementById('btn-export').onclick = openExport;
    document.getElementById('btn-reset').onclick = function () {
      if (!confirm('清空本地保存并恢复初始预设？')) return;
      localStorage.removeItem(Store.STORAGE_KEY);
      state = Store.defaultState();
      renderAll('已重置');
    };
    document.getElementById('btn-clear-log').onclick = function () {
      state.recomputeLog = [];
      renderLog();
    };
  }

  /* 演示循环：让 quest 锚 topbar，topbar 再锚 quest（基于当前树，不依赖预设状态） */
  function demoCycle() {
    var quest = M.findNode(state.nodes, 'quest');
    var topbar = M.findNode(state.nodes, 'topbar');
    if (!quest || !topbar) { alert('请先载入内置预设'); return; }
    quest.topAnchor = { ref: 'topbar', edge: 'bottom', mode: 'fixed', value: 10 };
    topbar.topAnchor = { ref: 'quest', edge: 'top', mode: 'fixed', value: 0 };
    renderAll('演示：topbar ↔ quest 互相参照，形成定位循环');
  }

  /* 演示悬空：删除被参照的边缘组件 */
  function demoDangling() {
    var edge = M.findNode(state.nodes, 'edge-top');
    if (!edge) { alert('请先载入内置预设'); return; }
    state.nodes = M.removeNode(state.nodes, 'edge-top');
    renderAll('演示：删除顶部安全边缘 → topbar 锚点悬空');
  }

  /* ---------------- 预览控制条 ---------------- */

  function bindPreviewControls(key) {
    var idx = key === 'a' ? 0 : 1;
    var rootEl = document.getElementById('preview-' + key);
    rootEl.querySelector('[data-ctl="device"]').addEventListener('change', function (ev) {
      var p = state.previews[idx];
      var orientation = getOrientation(key);
      var safeId = rootEl.querySelector('[data-ctl="safe"]').value;
      state.screens[p.screenKey] = Store.makeScreen(ev.target.value, orientation, safeId);
      renderAll(key.toUpperCase() + ' 切换设备 → 全树重算');
    });
    rootEl.querySelector('[data-ctl="orientation"]').addEventListener('click', function () {
      var p = state.previews[idx];
      var s = state.screens[p.screenKey];
      var t = s.w; s.w = s.h; s.h = t;
      var safeId = rootEl.querySelector('[data-ctl="safe"]').value;
      state.screens[p.screenKey] = Store.makeScreen(
        rootEl.querySelector('[data-ctl="device"]').value,
        s.w >= s.h ? 'landscape' : 'portrait', safeId);
      renderAll(key.toUpperCase() + ' 切换横竖屏');
    });
    rootEl.querySelector('[data-ctl="safe"]').addEventListener('change', function (ev) {
      var p = state.previews[idx];
      var s = state.screens[p.screenKey];
      var orientation = s.w >= s.h ? 'landscape' : 'portrait';
      state.screens[p.screenKey] = Store.makeScreen(
        rootEl.querySelector('[data-ctl="device"]').value, orientation, ev.target.value);
      renderAll(key.toUpperCase() + ' 切换屏幕保留区');
    });
    rootEl.querySelector('[data-ctl="guides"]').addEventListener('change', function (ev) {
      state.previews[idx].showGuides = ev.target.checked;
      renderPreview(key);
    });
    rootEl.querySelector('[data-ctl="active"]').addEventListener('click', function () {
      state.ui.activePreview = key;
      rootEl.classList.add('pv-active');
      document.getElementById('preview-' + (key === 'a' ? 'b' : 'a')).classList.remove('pv-active');
      renderIssues();
    });

    Store.VAR_DEFS.forEach(function (def) {
      var input = rootEl.querySelector('[data-var="' + def.key + '"]');
      if (!input) return;
      input.addEventListener('change', function () {
        var overrides = state.previewVarOverrides[key] || (state.previewVarOverrides[key] = {});
        overrides[def.key] = def.kind === 'bool' ? input.checked : Number(input.value);
        var affected = Store.affectedByVar(state.nodes, def.key);
        renderAll(key.toUpperCase() + ' 状态「' + def.label + '」变化 → 条件重算，影响 ' +
          affected.length + ' 个组件');
      });
    });
  }

  function getOrientation(key) {
    var idx = key === 'a' ? 0 : 1;
    var s = state.screens[state.previews[idx].screenKey];
    return s.w >= s.h ? 'landscape' : 'portrait';
  }

  function updateHitReadout(key, p, id) {
    var el = document.getElementById('hit-' + key);
    var n = id && M.findNode(state.nodes, id);
    el.textContent = '坐标(' + Math.round(p.x) + ',' + Math.round(p.y) + ') → ' +
      (n ? n.name + ' [' + n.type + ']' : '空白');
  }

  /* ---------------- 导出 ---------------- */

  function openExport() {
    var screens = [state.screens.a, state.screens.b];
    var runtime = window.ULCExport.buildRuntimeConfig(state.nodes, screens, state.ui.activePreview);
    var project = window.ULCExport.buildEditorProject(state.nodes, screens, state.previews);
    var modal = document.getElementById('export-modal');
    var rt = document.getElementById('export-runtime');
    rt.value = JSON.stringify(runtime, null, 2);
    document.getElementById('export-project').value = JSON.stringify(project, null, 2);
    document.getElementById('export-summary').textContent =
      '运行配置已剔除：previewOnly 组件 ' + runtime.dropped.previewOnly +
      ' 个、预览字段 ' + runtime.dropped.fields +
      ' 处、假数据绑定 ' + runtime.dropped.fakeBindings + ' 处；不含辅助线开关';
    modal.classList.add('modal-open');

    document.getElementById('btn-download-runtime').onclick = function () {
      download('ui-runtime.json', rt.value);
    };
    document.getElementById('btn-download-project').onclick = function () {
      download('ui-editor-project.json', document.getElementById('export-project').value);
    };
    document.getElementById('export-close').onclick = function () {
      modal.classList.remove('modal-open');
    };
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------------- 日志与差异 ---------------- */

  function pushLog(msg) {
    var time = new Date().toLocaleTimeString();
    state.recomputeLog.unshift(time + '  ' + msg);
    if (state.recomputeLog.length > 40) state.recomputeLog.pop();
    renderLog();
  }

  function renderLog() {
    document.getElementById('recompute-log').innerHTML =
      state.recomputeLog.map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('') ||
      '<li class="log-empty">操作记录会显示在这里</li>';
  }

  function snapshotNodes() {
    return JSON.parse(JSON.stringify(state.nodes));
  }
  function diffNodeIds(before, after) {
    var b = {};
    before.forEach(function (n) { b[n.id] = JSON.stringify(n); });
    var changed = [];
    after.forEach(function (n) {
      if (b[n.id] !== JSON.stringify(n)) changed.push(n.id);
    });
    return changed;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
