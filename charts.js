/* Tiny dependency-free HiDPI line charts with shared crosshair/seek. */
(function (root) {
  'use strict';

  const COLORS = {
    blue: '#2a78d6',
    orange: '#eb6834',
    aqua: '#1baf7a',
    yellow: '#eda100',
    red: '#d03b3b',
    violet: '#6250d6',
    ink: '#0b0b0b',
    secondary: '#52514e',
    muted: '#898781',
    grid: '#e1e0d9',
    baseline: '#c3c2b7',
    surface: '#fcfcfb'
  };

  class LineChart {
    constructor(canvas, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.options = options;
      this.series = [];
      this.times = [];
      this.viewIndex = 0;
      this.hoverIndex = null;
      this.w = 300;
      this.h = 140;
      this.margin = { l: 44, r: 14, t: 12, b: 24 };
      this.tooltip = document.createElement('div');
      this.tooltip.className = 'chart-tooltip';
      this.tooltip.hidden = true;
      if (canvas.parentElement) {
        canvas.parentElement.classList.add('chart-wrap');
        canvas.parentElement.appendChild(this.tooltip);
      }
      this.bindEvents();
    }

    setData(times, series) {
      this.times = times || [];
      this.series = series || [];
      this.draw();
    }

    setViewIndex(i) {
      this.viewIndex = i;
      this.draw();
    }

    setHoverIndex(i) {
      this.hoverIndex = i;
      if (i === null || i === undefined) {
        this.tooltip.hidden = true;
      }
      this.draw();
    }

    indexFromEvent(evt) {
      const rect = this.canvas.getBoundingClientRect();
      const x = evt.clientX - rect.left;
      const plot = this.plotRect();
      if (x < plot.x || x > plot.x + plot.w) return null;
      const k = (x - plot.x) / plot.w;
      return Math.max(0, Math.min(this.times.length - 1, Math.round(k * (this.times.length - 1))));
    }

    bindEvents() {
      this.canvas.addEventListener('mousemove', (evt) => {
        const i = this.indexFromEvent(evt);
        if (i === null) return;
        this.hoverIndex = i;
        this.showTooltip(evt, i);
        this.draw();
        this.options.onHover?.(i, evt);
      });
      this.canvas.addEventListener('mouseleave', () => {
        this.hoverIndex = null;
        this.tooltip.hidden = true;
        this.draw();
        this.options.onHover?.(null);
      });
      this.canvas.addEventListener('click', (evt) => {
        const i = this.indexFromEvent(evt);
        if (i !== null) this.options.onSeek?.(i);
      });
    }

    showTooltip(evt, i) {
      if (this.times[i] === null || this.times[i] === undefined) return;
      const rows = this.series.filter(s => !s.hidden).map(s => {
        const raw = s.data?.[i];
        const txt = raw === null || raw === undefined ? '—' :
          (s.format ? s.format(raw) : Number(raw).toFixed(2));
        return `<div class="tip-row"><span class="tip-swatch" style="background:${s.color}"></span><span>${s.label}</span><strong>${txt}</strong></div>`;
      }).join('');
      this.tooltip.innerHTML = `<div class="tip-time">t=${this.times[i].toFixed(2)} s</div>${rows}`;
      this.tooltip.hidden = false;
      const parentRect = this.canvas.parentElement.getBoundingClientRect();
      let left = evt.clientX - parentRect.left + 12;
      let top = evt.clientY - parentRect.top + 12;
      const tw = this.tooltip.offsetWidth || 150;
      const th = this.tooltip.offsetHeight || 80;
      if (left + tw > parentRect.width - 4) left = evt.clientX - parentRect.left - tw - 12;
      if (top + th > parentRect.height - 4) top = parentRect.height - th - 4;
      this.tooltip.style.left = `${Math.max(4, left)}px`;
      this.tooltip.style.top = `${Math.max(4, top)}px`;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(2, root.devicePixelRatio || 1);
      const w = Math.max(120, rect.width);
      const h = Math.max(90, rect.height);
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
      }
      this.w = w;
      this.h = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    plotRect() {
      return {
        x: this.margin.l,
        y: this.margin.t,
        w: Math.max(10, this.w - this.margin.l - this.margin.r),
        h: Math.max(10, this.h - this.margin.t - this.margin.b)
      };
    }

    draw() {
      this.resize();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      const p = this.plotRect();
      const n = this.times.length;
      if (n < 2) {
        ctx.fillStyle = COLORS.muted;
        ctx.font = '12px system-ui, sans-serif';
        ctx.fillText('暂无曲线', p.x + 8, p.y + 24);
        return;
      }

      let yMin = this.options.min;
      let yMax = this.options.max;
      if (yMin === undefined || yMax === undefined) {
        let lo = Infinity, hi = -Infinity;
        for (const s of this.series) {
          if (s.hidden) continue;
          for (const v of s.data || []) {
            if (v === null || v === undefined || Number.isNaN(v)) continue;
            lo = Math.min(lo, v); hi = Math.max(hi, v);
          }
        }
        if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
        if (yMin === undefined) yMin = Math.min(0, lo);
        if (yMax === undefined) yMax = Math.max(1, hi);
        if (yMax - yMin < 1e-6) yMax = yMin + 1;
        if (this.options.pad !== false) {
          const pad = (yMax - yMin) * 0.08;
          yMin = this.options.min ?? (yMin - pad);
          yMax = this.options.max ?? (yMax + pad);
        }
      }

      const xAt = (i) => p.x + (i / (n - 1)) * p.w;
      const yAt = (v) => p.y + p.h - ((v - yMin) / (yMax - yMin)) * p.h;

      // Grid and y ticks.
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.lineWidth = 1;
      const ticks = 4;
      for (let k = 0; k <= ticks; k++) {
        const v = yMin + (yMax - yMin) * k / ticks;
        const y = yAt(v);
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
        ctx.fillStyle = COLORS.muted;
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(this.options.tickFormat ? this.options.tickFormat(v) : v.toFixed(this.options.decimals ?? 1), p.x - 6, y);
      }

      // Time ticks.
      const duration = this.times[n - 1];
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const xTickCount = Math.min(6, Math.max(3, Math.floor(p.w / 90)));
      for (let k = 0; k <= xTickCount; k++) {
        const t = duration * k / xTickCount;
        const i = Math.round(t / (this.options.frameDt || 1 / 60));
        const x = xAt(clampIndex(i, n));
        ctx.strokeStyle = COLORS.grid;
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
        ctx.fillStyle = COLORS.muted;
        ctx.fillText(`${t.toFixed(1)}s`, x, p.y + p.h + 6);
      }

      if (this.options.referenceLines) {
        for (const ref of this.options.referenceLines) {
          const y = yAt(ref.value);
          ctx.strokeStyle = ref.color || COLORS.baseline;
          ctx.setLineDash(ref.dash || [4, 4]);
          ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
          ctx.setLineDash([]);
          if (ref.label) {
            ctx.fillStyle = ref.color || COLORS.secondary;
            ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
            ctx.font = '10px system-ui, sans-serif';
            ctx.fillText(ref.label, p.x + 4, y - 2);
          }
        }
      }

      // Series.
      for (const s of this.series) {
        if (s.hidden || !s.data) continue;
        ctx.strokeStyle = s.color;
        ctx.lineWidth = s.width || 2;
        ctx.setLineDash(s.dash || []);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const v = s.data[i];
          if (v === null || v === undefined || Number.isNaN(v)) { started = false; continue; }
          const x = xAt(i), y = yAt(v);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Current playback cursor.
      if (this.viewIndex !== null && this.viewIndex >= 0) {
        const x = xAt(clampIndex(this.viewIndex, n));
        ctx.strokeStyle = COLORS.ink;
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
        ctx.fillStyle = COLORS.ink;
        ctx.beginPath(); ctx.moveTo(x - 4, p.y - 1); ctx.lineTo(x + 4, p.y - 1); ctx.lineTo(x, p.y + 5); ctx.fill();
      }

      // Hover crosshair.
      if (this.hoverIndex !== null) {
        const x = xAt(clampIndex(this.hoverIndex, n));
        ctx.strokeStyle = 'rgba(11,11,11,.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, p.y); ctx.lineTo(x, p.y + p.h); ctx.stroke();
        ctx.setLineDash([]);
      }

      // Border.
      ctx.strokeStyle = COLORS.baseline;
      ctx.strokeRect(p.x, p.y, p.w, p.h);
    }
  }

  function clampIndex(i, n) {
    return Math.max(0, Math.min(n - 1, i));
  }

  root.VehicleCharts = { LineChart, COLORS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
