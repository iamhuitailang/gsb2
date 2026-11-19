/* 图层数据模型：图像层 / 组 / 调整层。
 * children 数组约定：索引 0 为最顶层（与图层面板显示顺序一致），渲染时自底向上遍历。 */
window.App = window.App || {};

App.model = (function () {

  const ADJUST_DEFAULTS = {
    brightness: 1,   // 亮度 0~2
    contrast: 1,     // 对比度 0~2
    saturate: 1,     // 饱和度 0~2
    hue: 0,          // 色相 -180~180
    grayscale: 0,    // 灰度 0~1
    invert: 0        // 反相 0~1
  };

  function baseLayer(type, name) {
    return {
      id: App.util.uid(),
      type,                 // 'image' | 'group' | 'adjustment'
      name,
      visible: true,
      locked: false,
      opacity: 1,           // 0~1
      blendMode: 'source-over',
      mask: null            // 灰度遮罩 canvas（文档尺寸），白=显示 黑=隐藏
    };
  }

  function createImageLayer(name, genId, docW, docH) {
    const L = baseLayer('image', name || App.generators.nameOf(genId));
    L.source = { gen: genId };
    L.imageCanvas = App.generators.generate(genId, docW, docH);
    return L;
  }

  function createGroup(name) {
    const L = baseLayer('group', name || '新建组');
    L.children = [];
    return L;
  }

  function createAdjustment(name) {
    const L = baseLayer('adjustment', name || '调整层');
    L.adjust = Object.assign({}, ADJUST_DEFAULTS);
    return L;
  }

  /* 为图层创建全白遮罩（完全显示） */
  function createMask(layer, docW, docH) {
    const c = App.util.makeCanvas(docW, docH);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, docW, docH);
    layer.mask = c;
    return c;
  }

  /* ---------- 树操作 ---------- */

  function findLayer(layers, id) {
    for (const L of layers) {
      if (L.id === id) return L;
      if (L.children) {
        const r = findLayer(L.children, id);
        if (r) return r;
      }
    }
    return null;
  }

  /* 返回 { parentChildren, index }，根级时 parentChildren 为根数组 */
  function findLocation(rootChildren, id) {
    function rec(children) {
      for (let i = 0; i < children.length; i++) {
        if (children[i].id === id) return { parentChildren: children, index: i };
        if (children[i].children) {
          const r = rec(children[i].children);
          if (r) return r;
        }
      }
      return null;
    }
    return rec(rootChildren);
  }

  function isDescendant(ancestor, id) {
    if (!ancestor.children) return false;
    for (const c of ancestor.children) {
      if (c.id === id || isDescendant(c, id)) return true;
    }
    return false;
  }

  /* ---------- 序列化 ---------- */

  function serializeLayer(L) {
    const o = {
      id: L.id,
      type: L.type,
      name: L.name,
      visible: L.visible,
      locked: L.locked,
      opacity: L.opacity,
      blendMode: L.blendMode
    };
    if (L.mask) o.mask = L.mask.toDataURL('image/png');
    if (L.type === 'image') o.source = { gen: L.source.gen };
    if (L.type === 'adjustment') o.adjust = Object.assign({}, L.adjust);
    if (L.type === 'group') o.children = L.children.map(serializeLayer);
    return o;
  }

  function deserializeLayer(o, docW, docH, onMaskLoaded) {
    const L = baseLayer(o.type, o.name);
    L.id = o.id || L.id;
    L.visible = o.visible !== false;
    L.locked = !!o.locked;
    L.opacity = (o.opacity == null) ? 1 : o.opacity;
    L.blendMode = o.blendMode || 'source-over';
    if (o.mask) {
      L.mask = App.util.makeCanvas(docW, docH);
      App.util.drawDataURLToCanvas(o.mask, L.mask, onMaskLoaded);
    }
    if (L.type === 'image') {
      L.source = { gen: o.source && o.source.gen };
      L.imageCanvas = App.generators.generate(L.source.gen, docW, docH);
    }
    if (L.type === 'adjustment') {
      L.adjust = Object.assign({}, ADJUST_DEFAULTS, o.adjust || {});
    }
    if (L.type === 'group') {
      L.children = (o.children || []).map(c => deserializeLayer(c, docW, docH, onMaskLoaded));
    }
    return L;
  }

  /* ---------- 结构快照（供撤销/重做使用） ----------
   * 深拷贝图层树结构，但 mask / imageCanvas 共享引用：
   * 遮罩内容只能被画笔笔触修改，而笔触有独立的历史记录（存 dataURL），
   * 撤销按 LIFO 顺序执行，因此共享引用在任何时刻都与正确状态一致。 */
  function cloneLayerShallow(L) {
    const c = Object.assign({}, L);
    if (L.adjust) c.adjust = Object.assign({}, L.adjust);
    if (L.source) c.source = Object.assign({}, L.source);
    if (L.children) c.children = L.children.map(cloneLayerShallow);
    return c;
  }

  function snapshotTree(state) {
    return state.root.children.map(cloneLayerShallow);
  }

  function restoreSnapshot(state, snap) {
    state.root.children = snap.map(cloneLayerShallow);
    if (state.selectedId && !findLayer(state.root.children, state.selectedId)) {
      state.selectedId = null;
    }
    if (state.maskEditId && !findLayer(state.root.children, state.maskEditId)) {
      state.maskEditId = null;
    }
  }

  return {
    ADJUST_DEFAULTS,
    createImageLayer,
    createGroup,
    createAdjustment,
    createMask,
    findLayer,
    findLocation,
    isDescendant,
    serializeLayer,
    deserializeLayer,
    snapshotTree,
    restoreSnapshot
  };
})();
