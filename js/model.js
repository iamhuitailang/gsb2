/*
 * model.js — 组件树数据模型、条件求值、依赖图
 * UMD：浏览器挂 window.ULCModel，Node 下 module.exports（供自动化测试）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    var api = factory();
    module.exports = api;
    root.ULCModel = api;
  } else root.ULCModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCREEN_ID = '__screen__';
  var _seq = 0;
  function uid(prefix) {
    _seq += 1;
    return (prefix || 'n') + '_' + Date.now().toString(36) + '_' + _seq;
  }

  var NODE_TYPES = ['panel', 'text', 'icon', 'bar', 'edge'];
  var LAYOUTS = ['none', 'row', 'column'];

  function createNode(partial) {
    var n = {
      id: uid('n'),
      name: '',
      type: 'panel',
      parentId: null,
      // 布局：none=用锚点自行定位；row/column=父容器流式排列子组件
      layout: 'row',
      gap: 6,
      padding: [3, 8], // [垂直, 水平]
      // 锚点：{ ref, edge, mode:'fixed'|'ratio', value, align:'start'|'center'|'end' }
      leftAnchor: null,
      rightAnchor: null,
      topAnchor: null,
      bottomAnchor: null,
      // 尺寸：{ mode:'fixed'|'content'|'fill', value }
      width: { mode: 'content', value: 0 },
      height: { mode: 'content', value: 0 },
      minWidth: 0,
      maxWidth: 0, // 0 = 不限制
      minHeight: 0,
      // 内容
      text: '',
      textVar: '', // 绑定状态变量，优先于 text
      dataBinding: '',
      icon: '',
      color: '#dfe6f3',
      fill: 0,
      fillVar: '',
      fillMax: 100,
      barHeight: 10,
      // 行为
      hiddenWhen: null, // 条件对象
      overlay: false,   // 模态遮罩层（如暂停菜单）：覆盖在其它内容上属正常，不报遮挡
      priority: 0, // 越大越优先保留，窄屏冲突时低优先级先被隐藏/压缩
      previewOnly: false
    };
    if (partial) for (var k in partial) n[k] = partial[k];
    if (!n.name) n.name = defaultName(n);
    return n;
  }

  function defaultName(n) {
    var map = { panel: '容器', text: '文本', icon: '图标', bar: '条形', edge: '边缘组件' };
    return map[n.type] || '组件';
  }

  function findNode(nodes, id) {
    for (var i = 0; i < nodes.length; i++) if (nodes[i].id === id) return nodes[i];
    return null;
  }

  function childrenOf(nodes, parentId) {
    return nodes.filter(function (n) { return n.parentId === parentId; });
  }

  function descendantIds(nodes, id) {
    var out = [];
    var walk = function (pid) {
      childrenOf(nodes, pid).forEach(function (c) {
        out.push(c.id);
        walk(c.id);
      });
    };
    walk(id);
    return out;
  }

  function ancestorIds(nodes, id) {
    var out = [];
    var n = findNode(nodes, id);
    while (n && n.parentId) {
      out.push(n.parentId);
      n = findNode(nodes, n.parentId);
    }
    return out;
  }

  /* 从树中删除：保留其它节点上的悬空锚点，交由引擎报错并提供“清除悬空参照”修复 */
  function removeNode(nodes, id) {
    var gone = {};
    gone[id] = true;
    descendantIds(nodes, id).forEach(function (d) { gone[d] = true; });
    return nodes.filter(function (n) { return !gone[n.id]; });
  }

  function anchorSlots() {
    return ['leftAnchor', 'rightAnchor', 'topAnchor', 'bottomAnchor'];
  }

  /* 锚点引用依赖：node -> 被参照节点（不含屏幕） */
  function anchorRefsOf(n) {
    var refs = [];
    anchorSlots().forEach(function (s) {
      var a = n[s];
      if (a && a.ref && a.ref !== SCREEN_ID) refs.push(a.ref);
    });
    return refs;
  }

  /* dependents: 被参照节点 -> 依赖它的节点集合（含流式布局的父子关系） */
  function buildDependents(nodes) {
    var map = new Map();
    function add(ref, id) {
      if (!map.has(ref)) map.set(ref, new Set());
      map.get(ref).add(id);
    }
    nodes.forEach(function (n) {
      if (n.parentId) add(n.parentId, n.id);
      anchorRefsOf(n).forEach(function (r) { add(r, n.id); });
    });
    return map;
  }

  function collectDependents(nodes, seedIds) {
    var dep = buildDependents(nodes);
    var seen = {};
    var queue = seedIds.slice();
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true;
      var set = dep.get(id);
      if (set) set.forEach(function (d) { if (!seen[d]) queue.push(d); });
    }
    return Object.keys(seen);
  }

  /* 环检测：锚点参照 + 流式父节点共同构成定位依赖图 */
  function findCycles(nodes) {
    var graph = {};
    nodes.forEach(function (n) {
      var deps = anchorRefsOf(n).slice();
      if (n.parentId && findNode(nodes, n.parentId)) deps.push(n.parentId);
      graph[n.id] = deps.filter(function (d, i) { return deps.indexOf(d) === i; });
    });
    var color = {}; // 0 白 1 灰 2 黑
    var cycles = [];
    function dfs(id, stack) {
      color[id] = 1;
      stack.push(id);
      (graph[id] || []).forEach(function (d) {
        if (!graph[d]) return;
        if (color[d] === 1) {
          var i = stack.indexOf(d);
          cycles.push(stack.slice(i).concat(d));
        } else if (!color[d]) dfs(d, stack);
      });
      stack.pop();
      color[id] = 2;
    }
    Object.keys(graph).forEach(function (id) { if (!color[id]) dfs(id, []); });
    return cycles;
  }

  function findDanglingRefs(nodes) {
    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = true; });
    var bad = [];
    nodes.forEach(function (n) {
      anchorSlots().forEach(function (s) {
        var a = n[s];
        if (a && a.ref !== SCREEN_ID && !ids[a.ref]) {
          bad.push({ nodeId: n.id, slot: s, ref: a.ref });
        }
      });
    });
    return bad;
  }

  /* ---------------- 条件 ---------------- */

  function evalCondition(cond, vars) {
    if (!cond) return false;
    if (cond.all && cond.all.length) return cond.all.every(function (c) { return evalCondition(c, vars); });
    if (cond.any && cond.any.length) return cond.any.some(function (c) { return evalCondition(c, vars); });
    var lv = vars[cond.var];
    var rv = cond.value;
    switch (cond.op) {
      case '==': return lv === rv;
      case '!=': return lv !== rv;
      case '>': return Number(lv) > Number(rv);
      case '<': return Number(lv) < Number(rv);
      case '>=': return Number(lv) >= Number(rv);
      case '<=': return Number(lv) <= Number(rv);
      default: return false;
    }
  }

  function conditionSummary(cond, nodes) {
    if (!cond) return '';
    if (cond.all) return cond.all.map(function (c) { return conditionSummary(c, nodes); }).join(' 且 ');
    if (cond.any) return cond.any.map(function (c) { return conditionSummary(c, nodes); }).join(' 或 ');
    var opText = { '==': '等于', '!=': '不等于', '>': '大于', '<': '小于', '>=': '不小于', '<=': '不大于' }[cond.op] || cond.op;
    var varText = varLabel(cond.var);
    return varText + ' ' + opText + ' ' + displayVal(cond.value);
  }

  function varLabel(v) {
    var map = {
      __screenWidth__: '屏幕宽度',
      __screenHeight__: '屏幕高度',
      __orientation__: '屏幕方向',
      paused: '暂停中',
      rightSidebarVisible: '右侧栏可见',
      nicknameLong: '长昵称',
      hp: '生命值',
      sfxOn: '音效',
      musicOn: '音乐'
    };
    return map[v] || v;
  }

  function displayVal(v) {
    if (v === true) return '是';
    if (v === false) return '否';
    if (v === 'portrait') return '竖屏';
    if (v === 'landscape') return '横屏';
    return String(v);
  }

  /* 条件里直接引用了哪些状态变量（不含引擎注入的 __ 变量） */
  function conditionVars(cond) {
    if (!cond) return [];
    if (cond.all || cond.any) {
      var arr = cond.all || cond.any;
      return arr.reduce(function (acc, c) { return acc.concat(conditionVars(c)); }, []);
    }
    return cond.var && cond.var.indexOf('__') !== 0 ? [cond.var] : [];
  }

  function nodesUsingVar(nodes, varName) {
    return nodes.filter(function (n) {
      return conditionVars(n.hiddenWhen).indexOf(varName) >= 0 ||
        n.textVar === varName || n.fillVar === varName;
    }).map(function (n) { return n.id; });
  }

  /* ---------------- 通用变更操作（引擎修复建议也走这里） ---------------- */

  function applyOp(nodes, op) {
    if (op.kind === 'setNodeProp') {
      var n = findNode(nodes, op.nodeId);
      if (n) n[op.prop] = op.value;
    } else if (op.kind === 'setAnchor') {
      var n2 = findNode(nodes, op.nodeId);
      if (n2) n2[op.slot] = op.anchor;
    } else if (op.kind === 'clearSlot') {
      var n3 = findNode(nodes, op.nodeId);
      if (n3) n3[op.slot] = null;
    }
    return nodes;
  }

  return {
    SCREEN_ID: SCREEN_ID,
    uid: uid,
    NODE_TYPES: NODE_TYPES,
    LAYOUTS: LAYOUTS,
    createNode: createNode,
    defaultName: defaultName,
    findNode: findNode,
    childrenOf: childrenOf,
    descendantIds: descendantIds,
    ancestorIds: ancestorIds,
    removeNode: removeNode,
    anchorSlots: anchorSlots,
    anchorRefsOf: anchorRefsOf,
    buildDependents: buildDependents,
    collectDependents: collectDependents,
    findCycles: findCycles,
    findDanglingRefs: findDanglingRefs,
    evalCondition: evalCondition,
    conditionSummary: conditionSummary,
    conditionVars: conditionVars,
    nodesUsingVar: nodesUsingVar,
    varLabel: varLabel,
    displayVal: displayVal,
    applyOp: applyOp
  };
});
