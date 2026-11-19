/* 合成渲染引擎（Canvas 2D）。
 * - 图层自底向上合成，支持混合模式与不透明度
 * - 灰度遮罩：以画布的 alpha 通道表达灰度（不透明=显示，透明=隐藏），destination-in 应用
 * - 组：子图层先合成到离屏画布，再作为整体参与混合
 * - 调整层：对它下方已合成的结果整体应用 CSS filter（非破坏性） */
window.App = window.App || {};

App.render = (function () {

  function adjustmentFilter(adj) {
    const parts = [];
    if (adj.brightness !== 1) parts.push('brightness(' + adj.brightness + ')');
    if (adj.contrast !== 1) parts.push('contrast(' + adj.contrast + ')');
    if (adj.saturate !== 1) parts.push('saturate(' + adj.saturate + ')');
    if (adj.hue !== 0) parts.push('hue-rotate(' + adj.hue + 'deg)');
    if (adj.grayscale !== 0) parts.push('grayscale(' + adj.grayscale + ')');
    if (adj.invert !== 0) parts.push('invert(' + adj.invert + ')');
    return parts.join(' ');
  }

  /* children 为顶层在前（索引 0 最顶），遍历时从末尾（最底）开始 */
  function renderChildren(children, w, h) {
    let acc = App.util.makeCanvas(w, h);
    for (let i = children.length - 1; i >= 0; i--) {
      const L = children[i];
      if (!L.visible) continue;

      if (L.type === 'adjustment') {
        const f = adjustmentFilter(L.adjust);
        if (f) {
          const tmp = App.util.makeCanvas(w, h);
          const tc = tmp.getContext('2d');
          tc.filter = f;
          tc.drawImage(acc, 0, 0);
          acc = tmp;
        }
        continue;
      }

      let src;
      if (L.type === 'group') {
        src = renderChildren(L.children, w, h);
      } else {
        src = L.imageCanvas;
      }
      if (!src) continue;

      let stamped = src;
      if (L.mask) {
        stamped = App.util.makeCanvas(w, h);
        const sc = stamped.getContext('2d');
        sc.drawImage(src, 0, 0);
        sc.globalCompositeOperation = 'destination-in';
        sc.drawImage(L.mask, 0, 0);
      }

      const ac = acc.getContext('2d');
      ac.globalAlpha = L.opacity;
      ac.globalCompositeOperation = L.blendMode || 'source-over';
      ac.drawImage(stamped, 0, 0);
      ac.globalAlpha = 1;
      ac.globalCompositeOperation = 'source-over';
    }
    return acc;
  }

  function renderDocument(state) {
    return renderChildren(state.root.children, state.doc.width, state.doc.height);
  }

  return { renderDocument, adjustmentFilter };
})();
