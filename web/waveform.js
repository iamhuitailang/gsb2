// Canvas 波形渲染: 峰值波形、区间拖选、播放头
'use strict';

class WaveformView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { selectable, onSelect(start,end) }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.selectable = !!opts.selectable;
    this.onSelect = opts.onSelect || (() => {});
    this.duration = 1;
    this.channels = 1;
    this.tracks = []; // { min:[[]], max:[[]], color, label }
    this.selection = null; // { start, end }
    this.playhead = 0;
    this._drag = null;
    this._bind();
    this._resize();
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 800;
    const h = Number(this.canvas.getAttribute('height')) || 150;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  setPeaks(peaks, color = 'var(--wave)', label = '') {
    this.channels = peaks.channels || 1;
    this.tracks = [{ min: peaks.min, max: peaks.max, color, label }];
    this.draw();
  }

  setMultiTracks(tracks) {
    this.channels = 1;
    this.tracks = tracks;
    this.draw();
  }

  setDuration(d) {
    this.duration = Math.max(d, 1e-6);
  }

  setSelection(start, end) {
    this.selection = { start: Math.max(0, start), end: Math.min(this.duration, end) };
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  _xToTime(x) {
    return Math.max(0, Math.min(this.duration, (x / this.w) * this.duration));
  }

  _bind() {
    if (!this.selectable) return;
    const pos = (ev) => {
      const rect = this.canvas.getBoundingClientRect();
      return ev.clientX - rect.left;
    };
    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.setPointerCapture(ev.pointerId);
      const t = this._xToTime(pos(ev));
      this._drag = { start: t };
      this.selection = { start: t, end: t };
      this.draw();
    });
    this.canvas.addEventListener('pointermove', (ev) => {
      if (!this._drag) return;
      const t = this._xToTime(pos(ev));
      this.selection = {
        start: Math.min(this._drag.start, t),
        end: Math.max(this._drag.start, t),
      };
      this.draw();
    });
    const finish = () => {
      if (!this._drag) return;
      this._drag = null;
      if (this.selection && this.selection.end - this.selection.start >= 0.02) {
        this.onSelect(this.selection.start, this.selection.end);
      } else {
        this.selection = null;
        this.draw();
      }
    };
    this.canvas.addEventListener('pointerup', finish);
    this.canvas.addEventListener('pointercancel', finish);
  }

  _css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  draw() {
    if (!this.w) this._resize();
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#101218';
    ctx.fillRect(0, 0, w, h);

    // 中线网格
    ctx.strokeStyle = this._css('--border');
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, h * frac);
      ctx.lineTo(w, h * frac);
      ctx.stroke();
    }

    const n = this.tracks.length || 1;
    const trackH = h / n;
    this.tracks.forEach((tr, idx) => this._drawTrack(tr, idx, trackH));

    // 选择区
    if (this.selection) {
      const x0 = (this.selection.start / this.duration) * w;
      const x1 = (this.selection.end / this.duration) * w;
      ctx.fillStyle = this._css('--selection');
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.strokeStyle = this._css('--accent');
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, 0, Math.max(1, x1 - x0), h);
    }

    // 播放头
    if (this.playhead > 0) {
      const x = (this.playhead / this.duration) * w;
      ctx.strokeStyle = this._css('--good');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // 轨道标签
    if (n > 1) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = this._css('--muted');
      this.tracks.forEach((tr, idx) => ctx.fillText(tr.label, 6, 14 + idx * trackH));
    }
  }

  _drawTrack(tr, idx, trackH) {
    const { ctx, w } = this;
    const top = idx * trackH;
    const buckets = tr.min[0] ? tr.min[0].length : 0;
    if (!buckets) return;
    const step = w / buckets;
    ctx.fillStyle = this._css(tr.color) || '#6f9bff';
    const chCount = tr.min.length;    const chH = (trackH - 4) / chCount;
    for (let c = 0; c < chCount; c++) {
      const cc = top + 2 + chH * (c + 0.5);
      for (let i = 0; i < buckets; i++) {
        const x = i * step;
        const yMin = cc - Math.max(-1, Math.min(1, tr.max[c][i])) * (chH / 2);
        const yMax = cc - Math.max(-1, Math.min(1, tr.min[c][i])) * (chH / 2);
        ctx.fillRect(x, yMin, Math.max(1, step - 0.3), Math.max(1, yMax - yMin));
      }
    }
  }
}

window.WaveformView = WaveformView;
