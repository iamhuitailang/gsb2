/*
 * views.js — 画布视图：波形视图（输入/输出复用）与增益曲线视图。
 * 三个视图共享同一时间映射，播放头与点击/拖动跳转由 app.js 统一驱动。
 *
 * 配色（暗色主题，色板已通过 CVD 校验）：
 *   左声道 蓝 #3987e5 / 右声道 橙 #d95926
 *   削波提示 红 #e66767（状态色，不用于数据系列）
 */
(function (global) {
  'use strict';

  const COLORS = {
    left: '#3987e5',
    right: '#d95926',
    clip: '#e66767',
    grid: '#2c2c2a',
    baseline: '#383835',
    text: '#c3c2b7',
    textMuted: '#898781',
    playhead: '#f0efec',
    segmentBg: 'rgba(255,255,255,0.045)',
    segmentEdge: 'rgba(255,255,255,0.14)',
  };

  const DPR_CAP = 2;

  class ViewBase {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.duration = 1;
      this.playheadSec = 0;
      this.hoverX = null;
      this.segments = null;
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(canvas);
      this.resize();
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
      this.w = Math.max(50, rect.width);
      this.h = Math.max(40, rect.height);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.onResized();
      this.draw();
    }

    onResized() {}

    setDuration(d) {
      this.duration = Math.max(1e-6, d);
      this.draw();
    }

    setPlayhead(sec) {
      this.playheadSec = sec;
      this.draw();
    }

    setHover(x) {
      this.hoverX = x;
      this.draw();
    }

    setSegments(segments) {
      this.segments = segments;
      this.draw();
    }

    xToTime(x) {
      return Math.max(0, Math.min(this.duration, (x / this.w) * this.duration));
    }

    timeToX(t) {
      return (t / this.duration) * this.w;
    }

    _drawGridLines(yTicks, fmt) {
      const ctx = this.ctx;
      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = COLORS.textMuted;
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const y of yTicks) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(this.w, y + 0.5);
      }
      ctx.stroke();
      if (fmt) {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        for (const y of yTicks) ctx.fillText(fmt(y), 4, y + 2);
      }
    }

    _drawSegments() {
      if (!this.segments) return;
      const ctx = this.ctx;
      ctx.save();
      for (const seg of this.segments) {
        const x0 = this.timeToX(seg.start);
        const x1 = this.timeToX(seg.end);
        if (x1 - x0 < 2) continue;
        ctx.fillStyle = COLORS.segmentBg;
        ctx.fillRect(x0, 0, x1 - x0, this.h);
        ctx.strokeStyle = COLORS.segmentEdge;
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, 0);
        ctx.lineTo(x0 + 0.5, this.h);
        ctx.stroke();
      }
      ctx.restore();
    }

    _drawSegmentLabels() {
      if (!this.segments) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = COLORS.textMuted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      // 避开左上角声道标签（约占前 60px）
      const labelAvoidPx = 64;
      for (const seg of this.segments) {
        const x0 = this.timeToX(seg.start);
        const x1 = this.timeToX(seg.end);
        if (x1 - x0 < 46 || !seg.label) continue;
        const center = (x0 + x1) / 2;
        if (center < labelAvoidPx) continue;
        ctx.fillText(seg.label, center, 4);
      }
      ctx.restore();
    }

    _drawPlayhead() {
      const ctx = this.ctx;
      const x = this.timeToX(this.playheadSec);
      ctx.save();
      ctx.strokeStyle = COLORS.playhead;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, this.h);
      ctx.stroke();
      ctx.fillStyle = COLORS.playhead;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x - 5, -7);
      ctx.lineTo(x + 5, -7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    _drawHover() {
      if (this.hoverX == null) return;
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = COLORS.baseline;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.hoverX + 0.5, 0);
      ctx.lineTo(this.hoverX + 0.5, this.h);
      ctx.stroke();
      ctx.restore();
    }

    draw() {}
  }

  function formatTime(sec) {
    if (sec == null || !isFinite(sec)) return '--';
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return m > 0
      ? `${m}:${s.toFixed(2).padStart(5, '0')}`
      : `${s.toFixed(2)}s`;
  }

  // ---------------- 波形视图 ----------------

  class WaveView extends ViewBase {
    constructor(canvas, opts) {
      super(canvas, opts);
      this.peaks = null;
      this.numChannels = 1;
      this.clipBuckets = null; // [{Uint8Array}] 每像素列是否有削波
    }

    setData(peaks, numChannels) {
      this.peaks = peaks;
      this.numChannels = numChannels || 1;
      this.draw();
    }

    setClipBuckets(clipBuckets) {
      this.clipBuckets = clipBuckets;
      this.draw();
    }

    onResized() {
      // 峰值桶由 app 在 resize 后重建并重新 setData
      if (this.opts.onResized) this.opts.onResized(this);
    }

    _channelGeometry() {
      const labelPad = 14;
      const gap = this.numChannels > 1 ? 6 : 0;
      const laneH = (this.h - labelPad - gap) / this.numChannels;
      return Array.from({ length: this.numChannels }, (_, c) => ({
        top: labelPad + c * (laneH + gap),
        h: laneH,
        mid: labelPad + c * (laneH + gap) + laneH / 2,
      }));
    }

    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      this._drawSegments();

      const geo = this._channelGeometry();
      const colors = [COLORS.left, COLORS.right];

      // 每声道中线
      ctx.strokeStyle = COLORS.baseline;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const g of geo) {
        ctx.moveTo(0, g.mid + 0.5);
        ctx.lineTo(this.w, g.mid + 0.5);
      }
      ctx.stroke();

      // 声道标签（文字不用数据色，色点承担身份标识）
      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const names = this.numChannels > 1 ? ['L', 'R'] : ['单声道'];
      for (let c = 0; c < this.numChannels; c++) {
        ctx.fillStyle = colors[c];
        ctx.fillRect(4, 2 + c * (geo[0].h + 6), 8, 8);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(names[c], 16, 1 + c * (geo[0].h + 6));
      }
      if (this.opts.showSegmentLabels !== false) this._drawSegmentLabels();

      if (!this.peaks) {
        this._drawPlayhead();
        return;
      }

      for (let c = 0; c < this.numChannels; c++) {
        const lane = this.peaks.perChannel[c];
        const g = geo[c];
        const half = g.h / 2;
        const col = colors[c];

        // 峰值填充（10% 透明度的色洗 + 2px 描边折线）
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, g.top, this.w, g.h);
        ctx.clip();

        ctx.fillStyle = col;
        ctx.globalAlpha = 0.18;
        const nB = lane.min.length;
        for (let b = 0; b < nB; b++) {
          const x = (b / nB) * this.w;
          const y1 = g.mid - lane.max[b] * half;
          const y2 = g.mid - lane.min[b] * half;
          ctx.fillRect(x, y1, Math.max(1, this.w / nB), Math.max(1, y2 - y1));
        }
        ctx.globalAlpha = 1;

        // 削波列用状态红覆盖
        if (this.clipBuckets && this.clipBuckets[c]) {
          ctx.fillStyle = COLORS.clip;
          const cb = this.clipBuckets[c];
          for (let b = 0; b < cb.length; b++) {
            if (cb[b]) {
              const x = (b / cb.length) * this.w;
              ctx.fillRect(x, g.top, Math.max(1, this.w / cb.length), g.h);
            }
          }
        }
        ctx.restore();
      }

      this._drawHover();
      this._drawPlayhead();
    }

    tooltipAt(x) {
      if (!this.peaks) return null;
      const t = this.xToTime(x);
      const geo = this._channelGeometry();
      const lines = [`时间 ${formatTime(t)}`];
      const idx = Math.floor((t / this.duration) * (this.peaks.perChannel[0].min.length - 1));
      for (let c = 0; c < this.numChannels; c++) {
        const pk = this.peaks.perChannel[c];
        const peak = Math.max(Math.abs(pk.min[idx]), Math.abs(pk.max[idx]));
        lines.push(`${c === 0 ? 'L' : 'R'} 峰值 ${(20 * Math.log10(Math.max(peak, 1e-7))).toFixed(1)} dBFS`);
      }
      return { x, title: this.opts.title || '波形', lines };
    }
  }

  // ---------------- 增益曲线视图 ----------------

  class GainView extends ViewBase {
    constructor(canvas, opts) {
      super(canvas, opts);
      this.curve = null; // { t, channels: [Float32Array] }
      this.maxGr = 0;
      this.numChannels = 1;
      this.linked = false;
    }

    setData(curve, numChannels, maxGr, linked) {
      this.curve = curve;
      this.numChannels = numChannels || 1;
      this.maxGr = maxGr || 0;
      this.linked = !!linked;
      this.draw();
    }

    _scaleMax() {
      // 纵轴最大衰减量，向上取整到 3 dB 的格子
      return Math.max(6, Math.ceil((this.maxGr * 1.15) / 3) * 3);
    }

    draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      this._drawSegments();

      const topPad = 16;
      const bottomPad = 18;
      const plotH = this.h - topPad - bottomPad;
      const scaleMax = this._scaleMax();

      // 水平网格：0 / 每 3 dB
      const ticks = [];
      for (let db = 0; db <= scaleMax; db += 3) {
        ticks.push({ y: topPad + (db / scaleMax) * plotH, db });
      }
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const tk of ticks) {
        ctx.moveTo(0, tk.y + 0.5);
        ctx.lineTo(this.w, tk.y + 0.5);
      }
      ctx.stroke();
      // 0 dB 基线加重
      ctx.strokeStyle = COLORS.baseline;
      ctx.beginPath();
      ctx.moveTo(0, topPad + 0.5);
      ctx.lineTo(this.w, topPad + 0.5);
      ctx.stroke();

      ctx.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = COLORS.textMuted;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (const tk of ticks) ctx.fillText(`-${tk.db}`, 4, tk.y + 2);
      ctx.fillText('增益衰减 dB（0 = 完全放开）', 40, 2);

      // 图例：联动立体声只有一条共享曲线（组合色样 + 说明），
      // 非联动画两条，单声道不设图例（标题已说明）。
      const colors = [COLORS.left, COLORS.right];
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      let lx = this.w - 8;
      if (this.linked && this.numChannels > 1) {
        const label = 'L/R 联动（共享一条增益）';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = COLORS.text;
        ctx.fillText(label, lx, 9);
        // 左半蓝、右半橙的组合色样
        const sx = lx - tw - 10;
        ctx.fillStyle = COLORS.left;
        ctx.fillRect(sx, 5, 4, 8);
        ctx.fillStyle = COLORS.right;
        ctx.fillRect(sx + 4, 5, 4, 8);
      } else if (this.numChannels > 1) {
        const names = ['L', 'R'];
        for (let c = this.numChannels - 1; c >= 0; c--) {
          const label = names[c];
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = COLORS.text;
          ctx.fillText(label, lx, 9);
          ctx.fillStyle = colors[c];
          ctx.fillRect(lx - tw - 10, 5, 8, 8);
          lx -= tw + 22;
        }
      }

      if (this.curve) {
        const pts = this.curve.t.length;
        // 联动时两声道曲线逐点相同，只画一条（避免后画的完全盖住先画的）
        const drawCount = this.linked && this.numChannels > 1 ? 1 : this.numChannels;
        for (let c = 0; c < drawCount; c++) {
          const data = this.curve.channels[c];
          ctx.strokeStyle = colors[c];
          ctx.lineWidth = 2;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.beginPath();
          for (let p = 0; p < pts; p++) {
            const x = this.timeToX(this.curve.t[p]);
            const y = topPad + (Math.min(data[p], scaleMax) / scaleMax) * plotH;
            if (p === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
        }
      }

      this._drawHover();
      this._drawPlayhead();
    }

    tooltipAt(x) {
      const t = this.xToTime(x);
      const lines = [`时间 ${formatTime(t)}`];
      if (this.curve) {
        const pts = this.curve.t;
        let lo = 0;
        let hi = pts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pts[mid] < t) lo = mid + 1;
          else hi = mid;
        }
        const showCount = this.linked ? 1 : this.numChannels;
        for (let c = 0; c < showCount; c++) {
          const v = this.curve.channels[c][lo];
          const name = this.linked ? 'L/R 共享' : (c === 0 ? 'L' : 'R');
          lines.push(`${name} 衰减 ${v.toFixed(2)} dB（增益 ${(-v).toFixed(2)} dB）`);
        }
      }
      return { x, title: '增益曲线', lines };
    }
  }

  global.Views = { WaveView, GainView, formatTime, COLORS };
})(typeof window !== 'undefined' ? window : globalThis);
