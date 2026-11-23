/* 轻量 SVG 图表：折线图与直方图，无外部依赖。 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const PALETTE = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* series: [{ name, color?, points: [y0..yn] }] x 轴为 0..n（局数）
   * opts: { width, height, logY, yLabel, yPercent } */
  function lineChart(container, series, opts) {
    opts = opts || {};
    const W = opts.width || 640, H = opts.height || 320;
    const padL = 52, padR = 12, padT = 14, padB = 30;
    clear(container);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart' }, container);
    if (!series.length) {
      const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, svg);
      t.textContent = '请选择要显示的物品';
      return;
    }
    const n = Math.max(...series.map((s) => s.points.length - 1));
    let ymax = 0;
    series.forEach((s) => s.points.forEach((v) => { if (v > ymax) ymax = v; }));
    if (opts.yPercent) ymax = Math.max(ymax, 0.01);
    ymax = ymax <= 0 ? 1 : ymax * 1.05;

    const logY = !!opts.logY;
    const yminLog = 1e-4;
    const yOf = (v) => {
      if (logY) {
        const lv = Math.log10(Math.max(v, yminLog));
        const l0 = Math.log10(yminLog), l1 = Math.log10(ymax);
        return padT + (H - padT - padB) * (1 - (lv - l0) / (l1 - l0));
      }
      return padT + (H - padT - padB) * (1 - v / ymax);
    };
    const xOf = (i) => padL + (W - padL - padR) * (n === 0 ? 0 : i / n);

    // 网格与 y 轴刻度
    const ticks = logY
      ? [yminLog, 1e-3, 1e-2, 1e-1, 1].filter((v) => v <= ymax)
      : [0, 0.25, 0.5, 0.75, 1].map((f) => f * ymax);
    ticks.forEach((tv) => {
      const y = yOf(tv);
      el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid' }, svg);
      const label = opts.yPercent
        ? (tv >= 0.01 ? (tv * 100).toFixed(0) + '%' : (tv * 100).toExponential(0) + '%')
        : String(Math.round(tv * 100) / 100);
      const t = el('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      t.textContent = label;
    });
    // x 轴刻度
    const xStep = Math.max(1, Math.ceil(n / 10));
    for (let i = 0; i <= n; i += xStep) {
      const x = xOf(i);
      el('line', { x1: x, y1: H - padB, x2: x, y2: H - padB + 4, class: 'axis' }, svg);
      const t = el('text', { x, y: H - padB + 16, 'text-anchor': 'middle', class: 'tick' }, svg);
      t.textContent = String(i);
    }
    el('line', { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: 'axis' }, svg);
    el('line', { x1: padL, y1: padT, x2: padL, y2: H - padB, class: 'axis' }, svg);
    const xl = el('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', class: 'tick' }, svg);
    xl.textContent = '局数';

    // 折线
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      const d = s.points.map((v, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join('');
      el('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.8 }, svg);
    });

    // 图例
    let lx = padL + 8;
    series.forEach((s, si) => {
      const color = s.color || PALETTE[si % PALETTE.length];
      el('rect', { x: lx, y: padT + 2, width: 10, height: 10, fill: color, rx: 2 }, svg);
      const t = el('text', { x: lx + 14, y: padT + 11, class: 'legend' }, svg);
      t.textContent = s.name;
      lx += 14 + s.name.length * 13 + 18;
    });
  }

  /* 直方图：labels[k] 对应 values[k]（玩家数） */
  function barChart(container, labels, values, opts) {
    opts = opts || {};
    const W = opts.width || 640, H = opts.height || 300;
    const padL = 56, padR = 12, padT = 14, padB = 30;
    clear(container);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart' }, container);
    const vmax = Math.max(1, ...values);
    const bw = (W - padL - padR) / values.length;
    const yOf = (v) => padT + (H - padT - padB) * (1 - v / vmax);

    [0, 0.5, 1].forEach((f) => {
      const v = f * vmax, y = yOf(v);
      el('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'grid' }, svg);
      const t = el('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', class: 'tick' }, svg);
      t.textContent = String(Math.round(v));
    });
    values.forEach((v, i) => {
      const x = padL + i * bw;
      el('rect', {
        x: x + 1, y: yOf(v), width: Math.max(1, bw - 2),
        height: H - padB - yOf(v), fill: PALETTE[0], rx: 2,
      }, svg);
      const t = el('text', { x: x + bw / 2, y: H - padB + 16, 'text-anchor': 'middle', class: 'tick' }, svg);
      t.textContent = labels[i];
    });
    el('line', { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, class: 'axis' }, svg);
    const xl = el('text', { x: W - padR, y: H - 6, 'text-anchor': 'end', class: 'tick' }, svg);
    xl.textContent = '获得次数';
  }

  global.Charts = { lineChart, barChart, PALETTE };
})(window);
