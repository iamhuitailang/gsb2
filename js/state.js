/* 投影校正工具 —— 状态、示例预设与持久化
 *
 * 所有几何量都用规范坐标保存：角点是相对输出画面 (0..1)² 的归一化位置，
 * 重叠带是源素材 u 轴上的区间。切换输出尺寸只是把规范量乘以新宽高，
 * 角点与遮罩的相对关系保持不变。
 */
(function (global) {
  'use strict';

  var PCAL = global.PCAL;
  var STORE_KEY = 'pcal.config.v1';

  /** 输出尺寸预设。custom 时读取 state.output.customW/H。 */
  var OUTPUT_PRESETS = [
    { id: '720p',  label: '1280 × 720（HD 720p）',   w: 1280, h: 720 },
    { id: '1080p', label: '1920 × 1080（FHD 1080p）', w: 1920, h: 1080 },
    { id: '2k',    label: '2560 × 1440（QHD 2K）',    w: 2560, h: 1440 },
    { id: '4k',    label: '3840 × 2160（UHD 4K）',    w: 3840, h: 2160 },
    { id: 'xga',   label: '1024 × 768（XGA 4:3）',    w: 1024, h: 768 },
    { id: 'custom', label: '自定义尺寸…', w: null, h: null }
  ];

  var UNIT_QUAD = [
    { x: 0.02, y: 0.06 }, { x: 0.98, y: 0.06 },
    { x: 0.98, y: 0.94 }, { x: 0.02, y: 0.94 }
  ];

  /** 两个固定检查标记（源规范坐标），用于验证正反映射来回一致。 */
  function defaultMarkers() {
    return [
      { id: 'M1', label: '标记 A', u: 0.25, v: 0.30 },
      { id: 'M2', label: '标记 B', u: 0.70, v: 0.65 }
    ];
  }

  /** 正投单幕示例：幕面正对镜头，四角基本贴合输出范围，轻微透视。 */
  function frontPreset() {
    return {
      name: 'front',
      screenCount: 1,
      screens: [
        baseScreen(0, [
          { x: 0.06, y: 0.10 }, { x: 0.94, y: 0.10 },
          { x: 0.94, y: 0.90 }, { x: 0.06, y: 0.90 }
        ], null, 1.0, 1.0),
        baseScreen(1, UNIT_QUAD.map(function (p) { return { x: p.x, y: p.y }; }), null, 1.0, 1.0)
      ]
    };
  }

  /**
   * 倾斜双幕示例：两块幕都相对镜头倾斜，中间有重叠带。
   * 故意把 gamma 调低、增益保持 1：带内权重和明显 >1（偏亮），
   * 操作员从这个“重叠偏亮”的起点开始把曲线压平到绿色目标线。
   */
  function tiltedDualPreset() {
    return {
      name: 'tilted-dual',
      screenCount: 2,
      screens: [
        // 左幕：右侧向内倾斜（远端收窄），重叠带在源面右端
        baseScreen(0, [
          { x: 0.04, y: 0.12 }, { x: 0.55, y: 0.20 },
          { x: 0.55, y: 0.82 }, { x: 0.04, y: 0.90 }
        ], { a: 0.70, b: 0.95, side: 'right' }, 1.0, 0.45),
        // 右幕：左侧向内倾斜，与左幕在画面中央重叠
        baseScreen(1, [
          { x: 0.45, y: 0.18 }, { x: 0.96, y: 0.10 },
          { x: 0.96, y: 0.92 }, { x: 0.45, y: 0.84 }
        ], { a: 0.05, b: 0.30, side: 'left' }, 1.0, 0.45)
      ]
    };
  }

  function baseScreen(id, quad, overlap, gain, gamma) {
    return {
      id: id,
      enabled: true,
      quad: quad,
      overlap: overlap,
      gain: gain,
      gamma: gamma
    };
  }

  function defaultState() {
    var p = frontPreset();
    return {
      version: 1,
      output: { presetId: '1080p', customW: 1600, customH: 900 },
      patternType: 'combo',
      screenCount: p.screenCount,
      screens: p.screens,
      activeScreen: 0,
      markers: defaultMarkers(),
      showOverflow: true,
      showOverlapBand: true,
      showGrid: true,
      blendTarget: 1.0
    };
  }

  function outputDimensions(state) {
    var preset = OUTPUT_PRESETS.filter(function (p) { return p.id === state.output.presetId; })[0];
    if (preset && preset.w) return { w: preset.w, h: preset.h };
    return {
      w: PCAL.math.clamp(Math.round(state.output.customW) || 1280, 64, 7680),
      h: PCAL.math.clamp(Math.round(state.output.customH) || 720, 64, 4320)
    };
  }

  /** 深拷贝（状态里全是 JSON 可序列化数据；自定义图片不进状态）。 */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function save(state) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('配置保存失败', e);
      return false;
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      return migrate(s);
    } catch (e) {
      console.warn('配置读取失败', e);
      return null;
    }
  }

  /** 旧版本字段补齐，保证重开后结构可用。 */
  function migrate(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;
    s.version = 1;
    s.output = Object.assign({}, d.output, s.output || {});
    s.screens = Array.isArray(s.screens) ? s.screens : d.screens;
    s.markers = Array.isArray(s.markers) && s.markers.length === 2 ? s.markers : d.markers;
    s.patternType = s.patternType || d.patternType;
    s.screenCount = s.screenCount || (s.screens.length === 2 ? 2 : 1);
    ['showOverflow', 'showOverlapBand', 'showGrid'].forEach(function (k) {
      if (typeof s[k] !== 'boolean') s[k] = d[k];
    });
    return s;
  }

  function clearSaved() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* 忽略 */ }
  }

  /** 应用示例预设（保留当前输出尺寸选择）。 */
  function applyPreset(state, name) {
    var p = name === 'tilted-dual' ? tiltedDualPreset() : frontPreset();
    state.screenCount = p.screenCount;
    state.screens = p.screens;
    state.activeScreen = 0;
    state.showOverflow = true;
    return state;
  }

  PCAL.state = {
    STORE_KEY: STORE_KEY,
    OUTPUT_PRESETS: OUTPUT_PRESETS,
    defaultState: defaultState,
    outputDimensions: outputDimensions,
    clone: clone,
    save: save,
    load: load,
    clearSaved: clearSaved,
    applyPreset: applyPreset,
    frontPreset: frontPreset,
    tiltedDualPreset: tiltedDualPreset
  };
})(window);
