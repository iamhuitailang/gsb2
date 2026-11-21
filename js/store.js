/*
 * store.js — 应用状态：一份共享组件树 + 两个独立预览
 * 预览各自持有分辨率/屏幕/状态变量；组件树改动两个预览同时生效
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    factory(global);
    module.exports = global.ULCStore;
  } else factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';
  var M = root.ULCModel;

  var STORAGE_KEY = 'ulc-checker-v1';

  var DEVICE_PRESETS = [
    { id: 'iphone-se', name: 'iPhone SE (窄屏)', w: 320, h: 568 },
    { id: 'iphone-14', name: 'iPhone 14', w: 390, h: 844 },
    { id: 'iphone-14-max', name: 'iPhone 14 Pro Max', w: 430, h: 932 },
    { id: 'ipad-mini', name: 'iPad mini 竖屏', w: 768, h: 1024 },
    { id: 'desktop-hd', name: '桌面横屏', w: 1280, h: 720 }
  ];

  var SAFE_PRESETS = [
    { id: 'none', name: '无保留区', safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    { id: 'notch', name: '刘海屏', safe: { top: 47, right: 0, bottom: 21, left: 0 } },
    { id: 'gesture', name: '手势条', safe: { top: 0, right: 0, bottom: 34, left: 0 } },
    { id: 'both', name: '刘海+手势条', safe: { top: 47, right: 0, bottom: 34, left: 0 } }
  ];

  /* 可切换的游戏状态变量（预览面板上的开关/输入） */
  var VAR_DEFS = [
    { key: 'paused', kind: 'bool', label: '暂停菜单' },
    { key: 'rightSidebarVisible', kind: 'bool', label: '右侧栏可见' },
    { key: 'nicknameLong', kind: 'bool', label: '长昵称' },
    { key: 'hp', kind: 'number', label: '生命值' },
    { key: 'sfxOn', kind: 'bool', label: '音效' },
    { key: 'musicOn', kind: 'bool', label: '音乐' }
  ];

  var DEFAULT_VARS = {
    paused: false,
    rightSidebarVisible: true,
    nicknameLong: false,
    hp: 72,
    sfxOn: true,
    musicOn: true
  };

  var NICK_SHORT = '勇者';
  var NICK_LONG = '屠龙者·暴风剑圣阿尔法雷德';

  /* 条件组件看到的派生变量（文本绑定也走这里，模拟运行时数据注入） */
  function deriveVars(raw) {
    var v = Object.assign({}, DEFAULT_VARS, raw);
    return Object.assign(v, {
      nickname: v.nicknameLong ? NICK_LONG : NICK_SHORT,
      sfxLabel: '音效：' + (v.sfxOn ? '开' : '关'),
      musicLabel: '音乐：' + (v.musicOn ? '开' : '关')
    });
  }

  function makeScreen(presetId, orientation, safeId) {
    var p = DEVICE_PRESETS.find(function (d) { return d.id === presetId; }) || DEVICE_PRESETS[1];
    var sp = SAFE_PRESETS.find(function (s) { return s.id === safeId; }) || SAFE_PRESETS[0];
    var w = orientation === 'portrait' ? p.w : p.h;
    var h = orientation === 'portrait' ? p.h : p.w;
    var safe = Object.assign({}, sp.safe);
    if (orientation === 'landscape') {
      // 横屏时刘海转到侧边
      safe = { top: 0, bottom: 0, left: safe.top, right: 0 };
    }
    return { id: p.id + '-' + orientation, w: w, h: h, safe: safe };
  }

  function defaultState() {
    return {
      nodes: root.ULCPresets.conflict(),
      presetName: 'conflict',
      screens: {
        a: makeScreen('iphone-se', 'portrait', 'none'),
        b: makeScreen('iphone-14', 'landscape', 'none')
      },
      previewVarOverrides: { a: {}, b: {} },
      previews: [
        { name: '预览 A', screenKey: 'a', vars: {}, showGuides: true },
        { name: '预览 B', screenKey: 'b', vars: {}, showGuides: true }
      ],
      ui: {
        selectedId: null,
        activePreview: 'a',
        issueFilter: 'all',
        showRecomputeLog: true
      },
      recomputeLog: []
    };
  }

  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        nodes: state.nodes,
        presetName: state.presetName,
        screens: state.screens,
        previewVarOverrides: state.previewVarOverrides,
        previews: state.previews
      }));
    } catch (e) { /* 隐私模式等场景静默降级 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      var state = defaultState();
      if (data.nodes && data.nodes.length) state.nodes = data.nodes;
      state.presetName = data.presetName || 'custom';
      if (data.screens) state.screens = data.screens;
      if (data.previewVarOverrides) state.previewVarOverrides = data.previewVarOverrides;
      if (data.previews) state.previews = data.previews;
      return state;
    } catch (e) { return null; }
  }

  /* 条件变化时：找出受影响的节点，供“只重算依赖部分”的日志展示。
     引擎本身是纯函数全量求解（数据量小），这里记录依赖范围用于可解释性 */
  function affectedByVar(nodes, varName) {
    return M.nodesUsingVar(nodes, varName);
  }

  root.ULCStore = {
    STORAGE_KEY: STORAGE_KEY,
    DEVICE_PRESETS: DEVICE_PRESETS,
    SAFE_PRESETS: SAFE_PRESETS,
    VAR_DEFS: VAR_DEFS,
    DEFAULT_VARS: DEFAULT_VARS,
    NICK_SHORT: NICK_SHORT,
    NICK_LONG: NICK_LONG,
    deriveVars: deriveVars,
    makeScreen: makeScreen,
    defaultState: defaultState,
    save: save,
    load: load,
    affectedByVar: affectedByVar
  };
});
