/*
 * presets.js — 内置组件树预设
 * 1) 一套在窄屏（320px 竖屏 + 长昵称）必然冲突的状态栏
 * 2) 一套健康的宽屏布局，用于对照
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    factory(global);
    module.exports = global.ULCPresets;
  } else factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var M = root.ULCModel;
  var SCREEN = M.SCREEN_ID;

  function screen(edge, value, align) {
    return { ref: SCREEN, edge: edge, mode: 'fixed', value: value, align: align || 'start' };
  }

  function text(v) { return { mode: 'content', value: 0 }; }
  function fixed(v) { return { mode: 'fixed', value: v }; }
  function fill() { return { mode: 'fill', value: 0 }; }

  function buildConflictPreset() {
    var nodes = [];
    function add(o) {
      var n = M.createNode(o);
      n.id = o.id; // 预设保留稳定 id，方便讲解和测试
      nodes.push(n);
      return n;
    }

    /* 根：铺满屏幕，仅作为容器，不渲染外观 */
    add({
      id: 'root', name: '界面根容器', type: 'panel', layout: 'none',
      width: fill(), height: fill(), padding: [0, 0], gap: 0,
      leftAnchor: screen('left', 0), topAnchor: screen('top', 0),
      rightAnchor: screen('right', 0), bottomAnchor: screen('bottom', 0),
      color: 'transparent'
    });

    /* 边缘组件：作为定位参照（其它组件可锚到它） */
    add({
      id: 'edge-top', name: '顶部安全边缘', type: 'edge', layout: 'none',
      width: fill(), height: fixed(2),
      leftAnchor: screen('left', 0), rightAnchor: screen('right', 0),
      topAnchor: screen('top', 12),
      color: '#7dd3fc', previewOnly: true
    });

    /* ---------- 顶部状态栏：none 容器，左右两组分别锚定屏幕左右边（典型 HUD 做法） ---------- */
    add({
      id: 'topbar', name: '顶部状态栏', type: 'panel', layout: 'none',
      width: fill(), height: fixed(34), minHeight: 34,
      leftAnchor: screen('left', 8), rightAnchor: screen('right', 8),
      topAnchor: { ref: 'edge-top', edge: 'bottom', mode: 'fixed', value: 8 },
      color: 'rgba(15,23,42,0.55)'
    });

    add({
      id: 'cluster-left', name: '左侧玩家信息组', type: 'panel', layout: 'row',
      parentId: 'topbar', gap: 6, padding: [4, 6],
      width: text(), height: text(), minHeight: 26, minWidth: 175,
      leftAnchor: screen('left', 0), topAnchor: screen('top', 4),
      color: 'rgba(30,41,59,0.9)'
    });
    add({
      id: 'avatar', name: '头像图标', type: 'icon', parentId: 'cluster-left',
      icon: 'avatar', width: fixed(20), height: fixed(20), color: '#fbbf24'
    });
    add({
      id: 'nickname', name: '玩家昵称（文本）', type: 'text', parentId: 'cluster-left',
      text: '勇者', textVar: 'nickname',
      width: text(), height: text(), minWidth: 24, minHeight: 14,
      color: '#e2e8f0'
    });
    add({
      id: 'level', name: '等级徽章（文本）', type: 'text', parentId: 'cluster-left',
      text: 'Lv.12', width: text(), height: text(), minWidth: 28,
      color: '#93c5fd'
    });

    add({
      id: 'cluster-right', name: '右侧状态图标组', type: 'panel', layout: 'row',
      parentId: 'topbar', gap: 5, padding: [4, 6],
      width: text(), height: text(), minHeight: 26, minWidth: 160,
      rightAnchor: screen('right', 0), topAnchor: screen('top', 4),
      color: 'rgba(30,41,59,0.9)'
    });
    ['wifi', 'battery', 'bell', 'clock'].forEach(function (ic, idx) {
      add({
        id: 'icon-' + ic, name: '状态图标·' + ic, type: 'icon', parentId: 'cluster-right',
        icon: ic, width: fixed(18), height: fixed(18),
        color: idx === 3 ? '#f87171' : '#a7f3d0'
      });
    });
    add({
      id: 'timer', name: '倒计时（文本）', type: 'text', parentId: 'cluster-right',
      text: '03:00', width: text(), height: text(), minWidth: 34, color: '#fde68a'
    });

    /* ---------- 任务追踪：比例位置 + 最小可读宽度，窄屏会触发最小宽度冲突 ---------- */
    add({
      id: 'quest', name: '任务追踪条', type: 'panel', layout: 'row',
      parentId: 'root', gap: 6, padding: [5, 8],
      width: text(), height: text(), minWidth: 150,
      leftAnchor: { ref: SCREEN, edge: 'left', mode: 'ratio', value: 0.12, align: 'start' },
      topAnchor: { ref: 'topbar', edge: 'bottom', mode: 'fixed', value: 24 },
      color: 'rgba(30,41,59,0.85)'
    });
    add({
      id: 'quest-icon', name: '任务图标', type: 'icon', parentId: 'quest',
      icon: 'quest', width: fixed(16), height: fixed(16), color: '#c4b5fd'
    });
    add({
      id: 'quest-text', name: '任务文本', type: 'text', parentId: 'quest',
      text: '护送商队穿过峡谷', width: text(), height: text(),
      minWidth: 96, color: '#e9d5ff'
    });
    /* ---------- 右侧栏：可临时隐藏；暂停菜单不依赖它 ---------- */
    add({
      id: 'rightbar', name: '右侧功能栏', type: 'panel', layout: 'column',
      parentId: 'root', gap: 8, padding: [8, 8],
      width: fixed(64), height: text(),
      rightAnchor: screen('right', 10), topAnchor: screen('top', 96),
      hiddenWhen: { any: [{ var: 'rightSidebarVisible', op: '==', value: false }] },
      color: 'rgba(30,41,59,0.92)'
    });
    ['bag', 'gear', 'map'].forEach(function (ic) {
      add({
        id: 'rightbar-' + ic, name: '侧栏按钮·' + ic, type: 'icon', parentId: 'rightbar',
        icon: ic, width: fixed(30), height: fixed(30), color: '#7dd3fc'
      });
    });

    /* ---------- 底部血条/蓝条：条形组件 ---------- */
    add({
      id: 'bottombar', name: '底部状态条容器', type: 'panel', layout: 'row',
      parentId: 'root', gap: 10, padding: [6, 10],
      width: fixed(300), height: text(), minWidth: 220,
      leftAnchor: screen('left', 12), bottomAnchor: screen('bottom', 10),
      color: 'rgba(15,23,42,0.6)'
    });
    add({
      id: 'hp-bar', name: '生命条（条形）', type: 'bar', parentId: 'bottombar',
      width: fixed(130), height: fixed(12), barHeight: 12,
      fill: 72, fillVar: 'hp', fillMax: 100, color: '#ef4444'
    });
    add({
      id: 'mp-bar', name: '法力条（条形）', type: 'bar', parentId: 'bottombar',
      width: fixed(130), height: fixed(12), barHeight: 12,
      fill: 46, fillMax: 100, color: '#3b82f6'
    });

    /* ---------- 暂停菜单：屏幕比例居中，不参照右侧栏，侧栏隐藏时位置/设置不变 ---------- */
    add({
      id: 'pause', name: '暂停菜单', type: 'panel', layout: 'column',
      parentId: 'root', gap: 10, padding: [16, 18],
      width: fixed(220), height: text(),
      leftAnchor: { ref: SCREEN, edge: 'left', mode: 'ratio', value: 0.5, align: 'center' },
      topAnchor: { ref: SCREEN, edge: 'top', mode: 'ratio', value: 0.42, align: 'center' },
      hiddenWhen: { any: [{ var: 'paused', op: '==', value: false }] },
      overlay: true,
      color: 'rgba(15,23,42,0.95)'
    });
    add({
      id: 'pause-title', name: '暂停标题', type: 'text', parentId: 'pause',
      text: '游戏暂停', width: text(), height: text(), color: '#f8fafc'
    });
    add({
      id: 'pause-sfx', name: '音效开关文本', type: 'text', parentId: 'pause',
      text: '音效：开', textVar: 'sfxLabel', width: text(), height: text(), color: '#cbd5e1'
    });
    add({
      id: 'pause-music', name: '音乐开关文本', type: 'text', parentId: 'pause',
      text: '音乐：开', textVar: 'musicLabel', width: text(), height: text(), color: '#cbd5e1'
    });

    return nodes;
  }

  /* 健康预设：同样的界面，但给昵称加了宽度上限、把 quest 改成可压缩，窄屏不冲突 */
  function buildHealthyPreset() {
    var nodes = buildConflictPreset();
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });

    byId['nickname'].maxWidth = 92;
    byId['quest'].minWidth = 0;
    byId['quest-text'].minWidth = 0;
    byId['quest-text'].maxWidth = 110;
    byId['cluster-right'].minWidth = 0;
    byId['cluster-left'].minWidth = 0;
    // 倒计时在极窄屏幕主动隐藏，而不是硬挤
    byId['timer'].hiddenWhen = { any: [{ var: '__screenWidth__', op: '<', value: 360 }] };
    return nodes;
  }

  root.ULCPresets = {
    conflict: buildConflictPreset,
    healthy: buildHealthyPreset,
    SCREEN: SCREEN
  };
});
