/* 数据模型：工程/图层工厂、属性描述、图层树、尺寸比例换算、存档归一化 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const { uid, deepClone, clamp } = G.util;

  const APP_ID = 'motion-title-studio';
  const FILE_EXT = '.mgs.json';

  const SIZE_PRESETS = [
    { label: '1920 × 1080 · 横屏 16:9', w: 1920, h: 1080 },
    { label: '1080 × 1920 · 竖屏 9:16', w: 1080, h: 1920 },
    { label: '1080 × 1080 · 方形 1:1', w: 1080, h: 1080 },
    { label: '1080 × 1350 · 竖版 4:5', w: 1080, h: 1350 },
    { label: '1280 × 720 · 高清 720p', w: 1280, h: 720 },
    { label: '3840 × 2160 · 4K 横屏', w: 3840, h: 2160 },
  ];

  /** 可关键帧化的变换属性（时间线/检查器共用同一份描述） */
  const PROP_DEFS = [
    { key: 'position', label: '位置', kfLabel: '位置关键帧' },
    { key: 'scale', label: '大小', kfLabel: '大小关键帧（缩放）' },
    { key: 'size', label: '宽高', kfLabel: '宽高关键帧' },
    { key: 'rotation', label: '旋转', kfLabel: '旋转关键帧' },
    { key: 'opacity', label: '透明度', kfLabel: '透明度关键帧' },
  ];

  function emptyKeys() {
    return { position: [], scale: [], size: [], rotation: [], opacity: [] };
  }

  let nameCounters = { text: 0, rect: 0, image: 0, group: 0 };
  function nextName(type) {
    nameCounters[type] = (nameCounters[type] || 0) + 1;
    const map = { text: '文字', rect: '矩形', image: '图片', group: '编组' };
    return `${map[type] || '图层'} ${nameCounters[type]}`;
  }
  function resetNameCounters() {
    nameCounters = { text: 0, rect: 0, image: 0, group: 0 };
  }

  function commonTransform(project, x, y, w, h) {
    return {
      x, y, w, h,
      scaleX: 100, scaleY: 100, uniformScale: true,
      rotation: 0,
      opacity: 100,
      in: 0,
      out: project ? project.duration : 6,
      keys: emptyKeys(),
    };
  }

  function createTextLayer(project, opts) {
    opts = opts || {};
    const w = opts.w || 900;
    const h = opts.h || 200;
    return Object.assign(commonTransform(project, project.width / 2, project.height / 2, w, h), {
      id: uid('ly'),
      type: 'text',
      name: opts.name || nextName('text'),
      visible: true,
      locked: false,
      text: opts.text != null ? opts.text : '双击编辑文字',
      fontFamily: opts.fontFamily ||
        '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      fontSize: opts.fontSize || 96,
      fontWeight: opts.fontWeight || 800,
      color: opts.color || '#ffffff',
      align: opts.align || 'center',
      lineHeight: opts.lineHeight || 1.25,
      letterSpacing: opts.letterSpacing || 0,
      shadow: opts.shadow === undefined
        ? { enabled: true, color: 'rgba(0,0,0,0.45)', blur: 24, offsetY: 8 }
        : opts.shadow,
    }, opts.extra || {});
  }

  function createRectLayer(project, opts) {
    opts = opts || {};
    return Object.assign(commonTransform(
      project,
      project.width / 2,
      project.height / 2,
      opts.w || 360,
      opts.h || 180
    ), {
      id: uid('ly'),
      type: 'rect',
      name: opts.name || nextName('rect'),
      visible: true,
      locked: false,
      fill: opts.fill || '#6e8bff',
      radius: opts.radius != null ? opts.radius : 16,
      strokeColor: opts.strokeColor || '#ffffff',
      strokeWidth: opts.strokeWidth || 0,
    }, opts.extra || {});
  }

  function createImageLayer(project, opts) {
    opts = opts || {};
    const w = opts.w || 420;
    const h = opts.h || 420;
    return Object.assign(commonTransform(project, project.width / 2, project.height / 2, w, h), {
      id: uid('ly'),
      type: 'image',
      name: opts.name || nextName('image'),
      visible: true,
      locked: false,
      src: opts.src || '',
      imgW: opts.imgW || w,
      imgH: opts.imgH || h,
      fit: opts.fit || 'contain', // contain | cover | fill
    }, opts.extra || {});
  }

  function createGroup(name) {
    return {
      id: uid('grp'),
      type: 'group',
      name: name || nextName('group'),
      visible: true,
      locked: false,
      collapsed: false,
      children: [],
    };
  }

  function createDefaultProject() {
    resetNameCounters();
    return {
      app: APP_ID,
      version: 1,
      name: '未命名工程',
      width: 1920,
      height: 1080,
      fps: 30,
      duration: 6,
      safeArea: true,
      thirds: false,
      checker: true,
      scaleWithCanvas: true,
      children: [],
    };
  }

  /* ---------------- 树操作 ---------------- */

  /** DFS 扁平化：返回 [{layer, parent, siblings, index, depth, hidden, locked}]，顺序即面板顺序（顶→底） */
  function flatten(children) {
    const out = [];
    (function walk(list, depth, parent, ancHidden, ancLocked) {
      for (let i = 0; i < list.length; i++) {
        const layer = list[i];
        const hidden = ancHidden || layer.visible === false;
        const locked = ancLocked || layer.locked === true;
        out.push({
          layer, depth, parent, siblings: list, index: i,
          hidden, locked,
        });
        if (layer.type === 'group' && Array.isArray(layer.children)) {
          walk(layer.children, depth + 1, layer, hidden, locked);
        }
      }
    })(children, 0, null, false, false);
    return out;
  }

  function findById(children, id) {
    for (let i = 0; i < children.length; i++) {
      const layer = children[i];
      if (layer.id === id) {
        return { layer, siblings: children, index: i, parent: null };
      }
      if (layer.children) {
        const hit = findById(layer.children, id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /** 画布绘制顺序：面板顶→底，绘制时需要倒序；这里返回正序叶子，renderer 倒序遍历 */
  function paintList(children) {
    return flatten(children).filter((e) => e.layer.type !== 'group' && !e.hidden);
  }

  function isDescendant(maybeParent, id) {
    if (!maybeParent.children) return false;
    return flatten(maybeParent.children).some((e) => e.layer.id === id);
  }

  /* ---------------- 关键帧小工具 ---------------- */

  function kfAt(keys, t, fps) {
    if (!keys || !keys.length) return -1;
    const eps = fps ? 0.5 / fps + 1e-4 : 0.01;
    for (let i = 0; i < keys.length; i++) {
      if (Math.abs(keys[i].t - t) <= eps) return i;
    }
    return -1;
  }

  function sortedKf(keys) {
    return (keys || []).slice().sort((a, b) => a.t - b.t);
  }

  function makeKf(prop, t, values, ease) {
    const base = { id: uid('kf'), t: +t.toFixed(4), ease: ease || 'easeOutCubic' };
    if (prop === 'position') return Object.assign(base, { x: values.x, y: values.y });
    if (prop === 'scale') return Object.assign(base, { sx: values.sx, sy: values.sy });
    if (prop === 'size') return Object.assign(base, { w: values.w, h: values.h });
    return Object.assign(base, { v: values.v });
  }

  /* ---------------- 尺寸比例调整 ---------------- */

  /**
   * 改输出尺寸时，按画布比例换算所有元素：
   * x/宽 随宽度比，y/高 随高度比；字号/圆角/描边等水平度量随宽度比。
   * 位置因此严格满足 x' = x * newW/oldW, y' = y * newH/oldH。
   */
  function rescaleProject(project, newW, newH) {
    const rw = newW / project.width;
    const rh = newH / project.height;
    const scaleNum = (v, r) => (typeof v === 'number' ? v * r : v);

    flatten(project.children).forEach(({ layer }) => {
      if (layer.type === 'group') return;
      layer.x *= rw;
      layer.y *= rh;
      layer.w *= rw;
      layer.h *= rh;
      if (layer.fontSize != null) layer.fontSize = Math.round(layer.fontSize * rw * 10) / 10;
      if (layer.letterSpacing != null) layer.letterSpacing *= rw;
      if (layer.radius != null) layer.radius *= rw;
      if (layer.strokeWidth != null) layer.strokeWidth *= rw;

      const k = layer.keys || {};
      (k.position || []).forEach((p) => { p.x *= rw; p.y *= rh; });
      (k.size || []).forEach((p) => { p.w *= rw; p.h *= rh; });
      // scale / rotation / opacity 是比例量，不随画布尺寸变化
    });

    project.width = newW;
    project.height = newH;
  }

  /* ---------------- 存档归一化（打开外部/旧工程不崩） ---------------- */

  function normalizeProject(raw) {
    if (!raw || typeof raw !== 'object') throw new Error('文件内容不是有效的工程 JSON');
    const p = raw.project && raw.project.app ? raw.project : raw;
    if (!Array.isArray(p.children)) {
      if (Array.isArray(p.layers)) p.children = p.layers;
      else throw new Error('工程缺少图层数据');
    }
    p.app = APP_ID;
    p.version = 1;
    p.name = typeof p.name === 'string' ? p.name : '未命名工程';
    p.width = clamp(parseInt(p.width, 10) || 1920, 64, 7680);
    p.height = clamp(parseInt(p.height, 10) || 1080, 64, 7680);
    p.fps = clamp(parseInt(p.fps, 10) || 30, 1, 120);
    p.duration = clamp(+p.duration || 6, 0.1, 600);
    ['safeArea', 'thirds', 'checker'].forEach((k) => {
      if (typeof p[k] !== 'boolean') p[k] = k === 'safeArea' || k === 'checker';
    });

    let seq = 0;
    const normalizeLayer = (l, depth) => {
      if (!l || typeof l !== 'object') return null;
      seq++;
      l.id = l.id || uid('ly');
      l.type = ['text', 'rect', 'image', 'group'].includes(l.type) ? l.type : 'rect';
      l.name = l.name || `图层 ${seq}`;
      l.visible = l.visible !== false;
      l.locked = !!l.locked;
      if (l.type === 'group') {
        l.collapsed = !!l.collapsed;
        l.children = (Array.isArray(l.children) ? l.children : [])
          .map((c) => normalizeLayer(c, depth + 1))
          .filter(Boolean);
        return l;
      }
      const base = commonTransform(p, p.width / 2, p.height / 2, 300, 160);
      Object.keys(base).forEach((key) => {
        if (l[key] === undefined) l[key] = base[key];
      });
      // keys 归一化
      const keys = l.keys || {};
      l.keys = emptyKeys();
      PROP_DEFS.forEach((d) => {
        if (Array.isArray(keys[d.key])) {
          l.keys[d.key] = keys[d.key]
            .filter((k) => k && typeof k.t === 'number')
            .map((k) => Object.assign({ id: uid('kf'), ease: 'easeOutCubic' }, k))
            .sort((a, b) => a.t - b.t);
        }
      });
      const op = +l.opacity;
      l.opacity = typeof op === 'number' && !isNaN(op) ? clamp(op, 0, 100) : 100;
      const sx = +l.scaleX;
      l.scaleX = !isNaN(sx) ? clamp(sx, 0, 4000) : 100;
      l.scaleY = l.uniformScale === false ? clamp(+l.scaleY || 100, 0, 4000) : l.scaleX;
      l.rotation = +l.rotation || 0;
      l.in = clamp(+l.in || 0, 0, p.duration);
      l.out = clamp(+l.out || p.duration, 0.01, p.duration);
      if (l.out <= l.in) l.out = Math.min(p.duration, l.in + 0.1);
      if (l.type === 'text') {
        l.text = l.text == null ? '文字' : String(l.text);
        l.fontSize = +l.fontSize || 96;
        l.fontWeight = l.fontWeight || 700;
        l.color = l.color || '#ffffff';
        l.align = ['left', 'center', 'right'].includes(l.align) ? l.align : 'center';
        l.lineHeight = +l.lineHeight || 1.25;
        l.letterSpacing = +l.letterSpacing || 0;
      }
      if (l.type === 'rect') {
        l.fill = l.fill || '#6e8bff';
        l.radius = +l.radius || 0;
        l.strokeWidth = +l.strokeWidth || 0;
        l.strokeColor = l.strokeColor || '#ffffff';
      }
      if (l.type === 'image') {
        l.src = l.src || '';
        l.fit = ['contain', 'cover', 'fill'].includes(l.fit) ? l.fit : 'contain';
        l.imgW = +l.imgW || l.w;
        l.imgH = +l.imgH || l.h;
      }
      return l;
    };
    p.children = p.children.map((l) => normalizeLayer(l, 0)).filter(Boolean);
    resetNameCounters();
    return p;
  }

  G.Model = {
    APP_ID,
    FILE_EXT,
    SIZE_PRESETS,
    PROP_DEFS,
    createDefaultProject,
    createTextLayer,
    createRectLayer,
    createImageLayer,
    createGroup,
    flatten,
    findById,
    paintList,
    isDescendant,
    kfAt,
    sortedKf,
    makeKf,
    rescaleProject,
    normalizeProject,
    resetNameCounters,
  };
})();
