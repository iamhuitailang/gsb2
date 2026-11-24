// 沿路径亮度折线图：两条分类曲线 + 补缺占比条带。
// 单一 y 轴（亮度），x 轴为路径距离；鼠标十字准星 + 全系列 tooltip。

import { COLORS } from './config.js';
import { clamp, formatNumber, formatPct } from './util.js';

const M = { top: 18, right: 18, bottom: 44, left: 46 };
const STRIP_H = 26;
const STRIP_GAP = 22;

export class Chart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tooltip = tooltipEl;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.data = [];
    this.events = [];
    this.hoverIndex = null;
    this.currentIndex = 0;
    this.onSeek = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width);
    const h = Math.max(210, rect.height);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    if (this.data.length) this.draw();
  }

  setData(samples, events, currentIndex) {
    this.data = samples;
    this.events = events;
    this.currentIndex = currentIndex;
    this.draw();
  }

  setCurrent(index) {
    this.currentIndex = index;
    this.draw();
  }

  plotRect() {
    return {
      x: M.left,
      y: M.top,
      w: Math.max(10, this.w - M.left - M.right),
      h: Math.max(10, this.h - M.top - M.bottom - STRIP_H - STRIP_GAP),
    };
  }

  xFor(dist) {
    const p = this.plotRect();
    const maxD = this.data.at(-1)?.dist || 1;
    return p.x + (dist / maxD) * p.w;
  }

  yFor(lum) {
    const p = this.plotRect();
    return p.y + (1 - clamp(lum, 0, 1)) * p.h;
  }

  stripRect() {
    const p = this.plotRect();
    return { x: p.x, y: p.y + p.h + STRIP_GAP, w: p.w, h: STRIP_H };
  }

  draw() {
    const ctx = this.ctx;
    if (!this.w || !this.data.length) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    const p = this.plotRect();
    const strip = this.stripRect();
    const maxD = this.data.at(-1).dist || 1;

    // 网格与 y 轴刻度（1px 实线细线）
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i += 1) {
      const v = i / 4;
      const y = this.yFor(v);
      ctx.strokeStyle = i === 0 ? '#383835' : '#2c2c2a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(p.x, Math.round(y) + 0.5);
      ctx.lineTo(p.x + p.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#898781';
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(2), p.x - 8, y);
    }

    // x 轴刻度（放在补缺条带下方，避免与条带重叠）
    const tickCount = Math.max(2, Math.min(7, Math.floor(p.w / 88)));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= tickCount; i += 1) {
      const d = (maxD * i) / tickCount;
      const x = this.xFor(d);
      ctx.fillStyle = '#898781';
      ctx.fillText(`${d.toFixed(1)} m`, x, strip.y + strip.h + 8);
    }

    // 事件标记（格边 / 门槛 / 覆盖变化）
    for (const ev of this.events) {
      const x = this.xFor(ev.dist);
      ctx.strokeStyle = ev.type === 'threshold'
        ? 'rgba(240,239,236,0.34)'
        : ev.type === 'coverage'
          ? 'rgba(250,178,25,0.4)'
          : 'rgba(240,239,236,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, p.y);
      ctx.lineTo(Math.round(x) + 0.5, p.y + p.h);
      ctx.stroke();
    }

    // 补缺条带（下方小图，同一 x 轴）
    ctx.fillStyle = '#242423';
    ctx.fillRect(strip.x, strip.y, strip.w, strip.h);
    ctx.beginPath();
    let started = false;
    for (const s of this.data) {
      const x = this.xFor(s.dist);
      const y = strip.y + strip.h - clamp(s.restricted.fallbackFraction, 0, 1) * strip.h;
      if (!started) { ctx.moveTo(x, strip.y + strip.h); ctx.lineTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    if (started) {
      const lastX = this.xFor(this.data.at(-1).dist);
      ctx.lineTo(lastX, strip.y + strip.h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(250,178,25,0.82)';
      ctx.fill();
    }
    ctx.strokeStyle = '#383835';
    ctx.lineWidth = 1;
    ctx.strokeRect(strip.x + 0.5, strip.y + 0.5, strip.w - 1, strip.h - 1);
    ctx.fillStyle = '#898781';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('补缺占比', strip.x, strip.y - 3);

    // 曲线
    this.drawSeries(this.data.map((s) => ({ d: s.dist, v: s.unrestricted.lum })), COLORS.seriesUnrestricted, 2);
    this.drawSeries(this.data.map((s) => ({ d: s.dist, v: s.restricted.lum })), COLORS.seriesRestricted, 2);

    // 当前帧竖线
    const cur = this.data[clamp(this.currentIndex, 0, this.data.length - 1)];
    if (cur) {
      const x = this.xFor(cur.dist);
      ctx.strokeStyle = 'rgba(240,239,236,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, p.y);
      ctx.lineTo(Math.round(x) + 0.5, strip.y + strip.h);
      ctx.stroke();

      for (const [key, color] of [['restricted', COLORS.seriesRestricted], ['unrestricted', COLORS.seriesUnrestricted]]) {
        const y = this.yFor(cur[key].lum);
        ctx.beginPath();
        ctx.arc(x, y, 4.6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#1a1a19';
        ctx.stroke();
      }

      // 选择性直接标注：只在当前帧给两条曲线标值，避免逐点数字噪声
      ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      const rightSide = x > p.x + p.w * 0.65;
      ctx.textAlign = rightSide ? 'right' : 'left';
      ctx.textBaseline = 'middle';
      const dx = rightSide ? -12 : 12;
      this.drawValueLabel(
        `受区域限制 ${formatNumber(cur.restricted.lum, 3)}`,
        x + dx,
        this.yFor(cur.restricted.lum) - 16,
        '#f0efec',
      );
      this.drawValueLabel(
        `无区域限制 ${formatNumber(cur.unrestricted.lum, 3)}`,
        x + dx,
        this.yFor(cur.unrestricted.lum) + 16,
        '#c3c2b7',
      );
    }

    // 悬停十字准星
    if (this.hoverIndex !== null) {
      const hs = this.data[this.hoverIndex];
      if (hs) {
        const x = this.xFor(hs.dist);
        ctx.strokeStyle = 'rgba(240,239,236,0.28)';
        ctx.setLineDash([3, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, p.y);
        ctx.lineTo(x, strip.y + strip.h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  drawValueLabel(text, x, y, color) {
    const ctx = this.ctx;
    ctx.save();
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(text).width;
    const anchorRight = ctx.textAlign === 'right';
    const left = anchorRight ? x - w - 6 : x - 6;
    ctx.fillStyle = 'rgba(13,13,13,0.78)';
    ctx.beginPath();
    const r = 5;
    const h = 18;
    const top = y - h / 2;
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(left, top, w + 12, h, r);
    } else {
      ctx.rect(left, top, w + 12, h);
    }
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  drawSeries(pts, color, width) {
    const ctx = this.ctx;
    ctx.beginPath();
    pts.forEach((pt, i) => {
      const x = this.xFor(pt.d);
      const y = this.yFor(pt.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  pickIndex(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const p = this.plotRect();
    const t = clamp((x - p.x) / p.w, 0, 1);
    const maxD = this.data.at(-1)?.dist || 1;
    const target = t * maxD;
    let best = 0;
    let bestD = Infinity;
    this.data.forEach((s, i) => {
      const d = Math.abs(s.dist - target);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  handleMove(evt) {
    if (!this.data.length) return;
    const idx = this.pickIndex(evt.clientX);
    if (idx !== this.hoverIndex) {
      this.hoverIndex = idx;
      this.draw();
    }
    this.showTooltip(this.data[idx], evt);
  }

  handleLeave() {
    this.hoverIndex = null;
    this.draw();
    this.tooltip.hidden = true;
  }

  handleClick(evt) {
    if (!this.data.length) return;
    const idx = this.pickIndex(evt.clientX);
    if (this.onSeek) this.onSeek(idx);
  }

  showTooltip(sample, evt) {
    if (!sample) return;
    const rect = this.canvas.getBoundingClientRect();
    const p = this.plotRect();
    const x = clamp(evt.clientX - rect.left, p.x, p.x + p.w);
    const el = this.tooltip;
    el.hidden = false;
    el.replaceChildren();

    const head = document.createElement('div');
    head.className = 'tt-head';
    const zoneText = sample.restricted.zone === 'interior'
      ? '室内'
      : sample.restricted.zone === 'exterior'
        ? '室外'
        : '未分配';
    head.textContent = `${sample.dist.toFixed(2)} m · ${zoneText} · 格 ${sample.restricted.col ?? '—'},${sample.restricted.row ?? '—'}`;
    el.append(head);

    const rows = [
      { color: COLORS.seriesRestricted, name: '受区域限制', value: formatNumber(sample.restricted.lum, 3) },
      { color: COLORS.seriesUnrestricted, name: '无区域限制', value: formatNumber(sample.unrestricted.lum, 3) },
    ];
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('i');
      key.className = 'tt-key';
      key.style.background = r.color;
      const name = document.createElement('span');
      name.className = 'tt-name';
      name.textContent = r.name;
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = r.value;
      row.append(key, name, val);
      el.append(row);
    }

    const extra = document.createElement('div');
    extra.className = 'tt-extra';
    extra.textContent = `支撑 ${formatPct(sample.restricted.support, 0)} · 补缺 ${formatPct(sample.restricted.fallbackFraction, 0)} · 探针 ${sample.restricted.usedProbeCount} 个`;
    el.append(extra);

    const left = Math.min(x + 14, rect.width - 224);
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${M.top + 6}px`;
  }
}
