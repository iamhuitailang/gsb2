/*
 * 渲染器：把 layout 结果渲染成绝对定位的 DOM。
 * 逐字播放通过控制每个字形 span 的显隐实现，布局永不重排。
 */
(function (global) {
  'use strict';

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pageTops(lay) {
    const tops = [];
    let acc = 0;
    const gap = lay.lineHeightPx;
    lay.pages.forEach((p, i) => {
      tops.push(acc);
      acc += p.height + (i < lay.pages.length - 1 ? gap : 0);
    });
    return tops;
  }

  function applySpanStyle(span, p, config) {
    const s = p.style || {};
    span.style.left = p.x + 'px';
    span.style.top = '0px';
    span.style.width = p.width + 'px';
    span.style.height = lay_lineHeight(config) + 'px';
    span.style.lineHeight = lay_lineHeight(config) + 'px';
    span.style.fontSize = (s.size || config.fontSize) + 'px';
    span.style.fontWeight = s.bold ? '700' : '400';
    span.style.fontStyle = s.italic ? 'italic' : 'normal';
    span.style.textDecoration = s.underline ? 'underline' : 'none';
    if (s.color) span.style.color = s.color;
    // 不在此设置 CSS letter-spacing：间距已包含在 placement 的 x 步进中，避免双重计算
  }

  function lay_lineHeight(config) {
    return config.fontSize * config.lineHeight;
  }

  /**
   * @returns {object} { stage, spanByChar:Map, markerEls, pageTops:number[], scrollToChar(), flashChar() }
   */
  function render(lay, parsed, opts) {
    const options = Object.assign({ showMarkers: true, scale: 1 }, opts || {});
    const stage = el('div', 'tt-stage');
    const width = lay.config.lineWidth;
    const tops = pageTops(lay);
    const totalH = lay.totalHeight;

    stage.style.width = width + 'px';
    stage.style.height = totalH + 'px';
    stage.style.fontFamily = lay.config.fontFamily;
    stage.style.fontSize = lay.config.fontSize + 'px';

    // 右边界参考线
    const edge = el('div', 'tt-edge');
    edge.style.left = width + 'px';
    edge.style.height = totalH + 'px';
    stage.appendChild(edge);

    // 分页分隔
    if (lay.pages.length > 1) {
      lay.pages.forEach((p, i) => {
        if (i === 0) return;
        const sep = el('div', 'tt-page-sep');
        sep.style.top = (tops[i] - lay.lineHeightPx / 2) + 'px';
        sep.style.width = width + 'px';
        sep.textContent = '— 第 ' + (i + 1) + ' 页 —';
        stage.appendChild(sep);
      });
    }

    const spanByChar = new Map();

    for (const p of lay.placements) {
      const span = el('span', 'tt-glyph', p.text);
      span.dataset.charIndex = String(p.charIndex);
      span.dataset.srcStart = String(p.srcStart);
      applySpanStyle(span, p, lay.config);
      span.style.transform = 'translateY(' + (tops[p.page] + p.y) + 'px)';
      span.style.whiteSpace = 'pre';
      const of = lay.overflows.find((o) => o.charIndex === p.charIndex && o.srcStart === p.srcStart);
      if (of) span.classList.add('tt-overflow');
      stage.appendChild(span);
      spanByChar.set(p.charIndex, span);
    }

    // 停顿 / 分页标记
    const markerEls = [];
    if (options.showMarkers) {
      for (const m of parsed.markers) {
        const anchor = lay.markerAt.get(m.unitIndex);
        if (!anchor) continue;
        const node = el('span', 'tt-marker tt-marker-' + m.type, m.type === 'wait'
          ? '⏸' + (m.duration || '')
          : '📄');
        node.title = m.type === 'wait'
          ? '停顿 ' + (m.duration || '默认') + 'ms（原文位置 ' + m.srcStart + '）'
          : '分页标记（原文位置 ' + m.srcStart + '）';
        node.style.left = Math.min(anchor.x + 8, width - 46) + 'px';
        node.style.top = (tops[anchor.page] + anchor.y) + 'px';
        node.dataset.srcStart = String(m.srcStart);
        stage.appendChild(node);
        markerEls.push(node);
      }
    }

    if (options.scale !== 1) {
      stage.style.transformOrigin = 'top left';
      stage.style.transform = 'scale(' + options.scale + ')';
    }

    function charElement(charIndex) {
      return spanByChar.get(charIndex);
    }

    function reveal(count) {
      for (const [idx, node] of spanByChar) {
        node.classList.toggle('tt-hidden', idx >= count);
      }
    }

    function flashChar(charIndex) {
      const node = spanByChar.get(charIndex);
      if (!node) return null;
      node.classList.remove('tt-flash');
      // 强制重启动画
      void node.offsetWidth;
      node.classList.add('tt-flash');
      return node;
    }

    function charPageTop(charIndex) {
      const p = lay.placements.find((z) => z.charIndex === charIndex);
      return p ? tops[p.page] + p.y : 0;
    }

    return {
      stage,
      spanByChar,
      markerEls,
      pageTops: tops,
      reveal,
      flashChar,
      charElement,
      charPageTop,
      totalWidth: width,
      totalHeight: totalH
    };
  }

  global.TT = global.TT || {};
  global.TT.renderer = { render, pageTops };
})(typeof window !== 'undefined' ? window : globalThis);
