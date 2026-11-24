/* Plain browser SVG charts with a shared hover readout and table fallback. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DemoCharts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, parent) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function svgEl(tag, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    if (parent) parent.appendChild(node);
    return node;
  }

  function cssVar(name, fallback) {
    if (typeof getComputedStyle === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function niceTicks(min, max, count = 5) {
    if (min === max) return [min];
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(6));
    return ticks;
  }

  function lineChart(container, cfg) {
    container.innerHTML = '';
    container.classList.add('chart-shell');

    const header = el('div', { class: 'chart-header' }, container);
    el('h3', { class: 'chart-title', text: cfg.title }, header);
    if (cfg.description) el('p', { class: 'chart-desc', text: cfg.description }, header);

    const legend = el('div', { class: 'chart-legend' }, header);
    for (const s of cfg.series) {
      const item = el('span', { class: 'legend-item' }, legend);
      el('span', { class: 'legend-key', style: `background:${s.color}` }, item);
      el('span', { text: s.label }, item);
    }

    const computedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(container) : null;
    const horizontalPadding = computedStyle
      ? parseFloat(computedStyle.paddingLeft || '0') + parseFloat(computedStyle.paddingRight || '0')
      : 0;
    const width = Math.max(300, (container.clientWidth || 720) - horizontalPadding);
    const height = cfg.height || 260;
    const margin = { top: 18, right: 18, bottom: 34, left: 52 };
    const iw = width - margin.left - margin.right;
    const ih = height - margin.top - margin.bottom;
    const xMin = cfg.xMin ?? cfg.x[0];
    const xMax = cfg.xMax ?? cfg.x[cfg.x.length - 1];
    const yMin = cfg.yMin;
    const yMax = cfg.yMax;
    const xScale = (x) => margin.left + (x - xMin) / (xMax - xMin) * iw;
    const yScale = (y) => margin.top + ih - (y - yMin) / (yMax - yMin) * ih;

    const svg = svgEl('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      role: 'img',
      'aria-label': cfg.title
    }, container);

    const gridColor = cssVar('--grid', '#e1e0d9');
    const axisColor = cssVar('--axis', '#c3c2b7');
    const muted = cssVar('--muted', '#898781');

    const yTicks = cfg.yTicks || niceTicks(yMin, yMax, 5);
    for (const tick of yTicks) {
      const y = yScale(tick);
      svgEl('line', { x1: margin.left, x2: margin.left + iw, y1: y, y2: y, stroke: gridColor, 'stroke-width': 1 }, svg);
      const t = svgEl('text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'axis-text', fill: muted, 'font-size': 11 }, svg);
      t.textContent = cfg.yFormat ? cfg.yFormat(tick) : String(tick);
    }

    const xTickValues = cfg.xTicks || Array.from({ length: 8 }, (_, i) => +(xMin + i * (xMax - xMin) / 7).toFixed(1));
    for (const tick of xTickValues) {
      const x = xScale(tick);
      svgEl('line', { x1: x, x2: x, y1: margin.top, y2: margin.top + ih, stroke: gridColor, 'stroke-width': 1 }, svg);
      const t = svgEl('text', { x, y: margin.top + ih + 20, 'text-anchor': 'middle', fill: muted, 'font-size': 11 }, svg);
      t.textContent = cfg.xFormat ? cfg.xFormat(tick) : `${tick.toFixed(0)}s`;
    }
    svgEl('line', { x1: margin.left, x2: margin.left + iw, y1: margin.top + ih, y2: margin.top + ih, stroke: axisColor, 'stroke-width': 1 }, svg);

    // Event markers sit behind data lines.
    if (cfg.markers) {
      for (const m of cfg.markers) {
        if (m.x < xMin || m.x > xMax) continue;
        const x = xScale(m.x);
        svgEl('line', {
          x1: x, x2: x, y1: margin.top, y2: margin.top + ih,
          stroke: m.color || cssVar('--muted', '#898781'),
          'stroke-width': 1.5,
          'stroke-dasharray': m.dashed === false ? null : '4 4'
        }, svg);
        if (m.label) {
          const label = svgEl('text', {
            x: x + 5, y: margin.top + 12,
            fill: cssVar('--text-secondary', '#52514e'),
            'font-size': 11
          }, svg);
          label.textContent = m.label;
        }
      }
    }

    for (const s of cfg.series) {
      let d = '';
      let started = false;
      for (let i = 0; i < cfg.x.length; i++) {
        const raw = s.values[i];
        if (raw == null || Number.isNaN(raw)) { started = false; continue; }
        const x = xScale(cfg.x[i]);
        const y = yScale(Math.max(yMin, Math.min(yMax, raw)));
        d += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
        started = true;
      }
      svgEl('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        'stroke-dasharray': s.dash || null
      }, svg);
    }

    const crosshair = svgEl('line', {
      x1: 0, x2: 0, y1: margin.top, y2: margin.top + ih,
      stroke: cssVar('--axis', '#c3c2b7'), 'stroke-width': 1, opacity: 0
    }, svg);
    const dots = cfg.series.map((s) => svgEl('circle', {
      r: 4.5, fill: s.color, stroke: cssVar('--surface-1', '#fcfcfb'), 'stroke-width': 2, opacity: 0
    }, svg));

    const tooltip = el('div', { class: 'chart-tooltip', hidden: '' }, container);
    const hoverRect = svgEl('rect', {
      x: margin.left, y: margin.top, width: iw, height: ih,
      fill: 'transparent', 'pointer-events': 'all', tabindex: 0, role: 'slider',
      'aria-label': `${cfg.title}，用左右方向键查看数值`
    }, svg);

    let focusIndex = null;
    function showIndex(i, clientX) {
      i = Math.max(0, Math.min(cfg.x.length - 1, i));
      focusIndex = i;
      const x = xScale(cfg.x[i]);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('opacity', 1);
      cfg.series.forEach((s, j) => {
        const v = s.values[i];
        if (v == null || Number.isNaN(v)) { dots[j].setAttribute('opacity', 0); return; }
        dots[j].setAttribute('cx', x);
        dots[j].setAttribute('cy', yScale(Math.max(yMin, Math.min(yMax, v))));
        dots[j].setAttribute('opacity', 1);
      });
      tooltip.hidden = false;
      tooltip.innerHTML = '';
      const time = el('div', { class: 'tooltip-time' }, tooltip);
      time.textContent = `t = ${cfg.x[i].toFixed(2)} s`;
      for (const s of cfg.series) {
        const row = el('div', { class: 'tooltip-row' }, tooltip);
        el('span', { class: 'tooltip-key', style: `background:${s.color}` }, row);
        el('span', { class: 'tooltip-label', text: s.label }, row);
        const value = el('strong', { class: 'tooltip-value' }, row);
        const v = s.values[i];
        value.textContent = v == null || Number.isNaN(v) ? '—' : (s.tooltipFormat ? s.tooltipFormat(v) : (cfg.yFormat ? cfg.yFormat(v) : v.toFixed(1)));
      }
      const rect = container.getBoundingClientRect();
      const px = clientX != null ? clientX - rect.left : x;
      const tw = tooltip.offsetWidth || 150;
      tooltip.style.left = `${Math.max(8, Math.min((width || rect.width) - tw - 8, px + 14))}px`;
      tooltip.style.top = `${margin.top + 8}px`;
    }

    function hide() {
      crosshair.setAttribute('opacity', 0);
      dots.forEach((d) => d.setAttribute('opacity', 0));
      tooltip.hidden = true;
      focusIndex = null;
    }

    function handleHover(ev) {
      const box = svg.getBoundingClientRect();
      const sx = (ev.clientX - box.left) / box.width * width;
      const t = xMin + (sx - margin.left) / iw * (xMax - xMin);
      let nearest = 0, best = Infinity;
      for (let i = 0; i < cfg.x.length; i++) {
        const dd = Math.abs(cfg.x[i] - t);
        if (dd < best) { best = dd; nearest = i; }
      }
      showIndex(nearest, ev.clientX);
    }
    hoverRect.addEventListener('pointermove', handleHover);
    hoverRect.addEventListener('mousemove', handleHover);
    hoverRect.addEventListener('pointerleave', hide);
    hoverRect.addEventListener('mouseleave', hide);
    hoverRect.addEventListener('focus', () => showIndex(focusIndex ?? 0));
    hoverRect.addEventListener('blur', hide);
    hoverRect.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        const next = (focusIndex ?? 0) + (ev.key === 'ArrowLeft' ? -1 : 1);
        showIndex(next);
      }
    });

    if (cfg.tableRows && cfg.columns) {
      const details = el('details', { class: 'chart-table-details' }, container);
      el('summary', { text: '查看数据表' }, details);
      const wrap = el('div', { class: 'table-scroll compact' }, details);
      const table = el('table', {}, wrap);
      const thead = el('thead', {}, table);
      const hr = el('tr', {}, thead);
      for (const c of cfg.columns) el('th', { text: c.label }, hr);
      const tbody = el('tbody', {}, table);
      for (const row of cfg.tableRows) {
        const tr = el('tr', {}, tbody);
        for (const c of cfg.columns) {
          const td = el('td', {}, tr);
          td.textContent = c.format ? c.format(row[c.key], row) : (row[c.key] ?? '');
        }
      }
    }

    return { refreshTheme() { lineChart(container, cfg); } };
  }

  return { lineChart };
});
