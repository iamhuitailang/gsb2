// waveform-view.js — Canvas 波形视图。
// 负责：时间标尺、按声道分轨波形（L/R 可单独查看）、拖选区域与精确起止时间、
// 标记渲染与点选、播放头、横向缩放/滚动。本身不处理音频，只通过回调与外部通信。

import { formatTime } from './audio-engine.js';

const RULER_H = 30;
const LANE_GAP = 6;
const LANE_LABEL_W = 34;
const TICK_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300];

export class WaveformView {
  /**
   * @param {HTMLElement} container 滚动容器（内部自动创建 canvas 与播放头）
   * @param {object} cb 回调集合
   */
  constructor(container, cb) {
    this.container = container;
    this.cb = cb;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wave-canvas';
    this.playhead = document.createElement('div');
    this.playhead.className = 'playhead';
    this.playhead.style.display = 'none';
    this.container.classList.add('wave-scroll');
    this.container.appendChild(this.canvas);
    this.container.appendChild(this.playhead);
    this.ctx = this.canvas.getContext('2d');

    this.channels = [];
    this.sampleRate = 44100;
    this.duration = 0;
    this.selection = null; // { start, end } 秒
    this.markers = [];
    this.viewMode = 'all'; // all | left | right
    this.pps = 100; // 每秒像素数
    this.markerMode = false;
    this.drag = null;

    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this.render());
    this._resizeObserver.observe(this.container);
  }

  setData(channels, sampleRate) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.duration = channels.length ? channels[0].length / sampleRate : 0;
    this._ensureCanvasSize();
    this.render();
  }

  setSelection(sel) {
    this.selection = sel;
    this.render();
  }

  setMarkers(markers) {
    this.markers = markers;
    this.render();
  }

  setViewMode(mode) {
    this.viewMode = mode;
    this._ensureCanvasSize();
    this.render();
  }

  setMarkerMode(on) {
    this.markerMode = on;
    this.canvas.style.cursor = on ? 'crosshair' : 'text';
  }

  setPps(pps) {
    this.pps = Math.max(4, Math.min(2000, pps));
    this._ensureCanvasSize();
    this.render();
    this.cb.onPpsChange?.(this.pps);
  }

  getPps() {
    return this.pps;
  }

  /** 自适应缩放：整段波形刚好铺满可视宽度 */
  fitToWidth() {
    const w = this.container.clientWidth - 8;
    if (this.duration > 0) this.setPps(Math.max(4, w / this.duration));
  }

  setPlayhead(time) {
    if (time == null) {
      this.playhead.style.display = 'none';
      return;
    }
    this.playhead.style.display = 'block';
    this.playhead.style.left = `${time * this.pps}px`;
  }

  scrollToTime(time) {
    const x = time * this.pps;
    const viewW = this.container.clientWidth;
    if (x < this.container.scrollLeft || x > this.container.scrollLeft + viewW) {
      this.container.scrollLeft = Math.max(0, x - viewW / 3);
    }
  }

  visibleLanes() {
    if (!this.channels.length) return [];
    if (this.channels.length === 1) return [{ index: 0, label: 'Mono', data: this.channels[0] }];
    if (this.viewMode === 'left') return [{ index: 0, label: 'L', data: this.channels[0] }];
    if (this.viewMode === 'right') return [{ index: 1, label: 'R', data: this.channels[1] }];
    return [
      { index: 0, label: 'L', data: this.channels[0] },
      { index: 1, label: 'R', data: this.channels[1] },
    ];
  }

  _ensureCanvasSize() {
    const dpr = window.devicePixelRatio || 1;
    const lanes = Math.max(1, this.visibleLanes().length);
    const cssW = Math.max(this.container.clientWidth, Math.ceil(this.duration * this.pps) + 24);
    const laneH = this._laneHeight();
    const cssH = RULER_H + lanes * laneH + (lanes - 1) * LANE_GAP + 12;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cssW = cssW;
    this.cssH = cssH;
  }

  _laneHeight() {
    const available = Math.max(120, this.container.clientHeight - RULER_H - 24);
    const lanes = Math.max(1, this.visibleLanes().length);
    return Math.max(70, Math.floor((available - (lanes - 1) * LANE_GAP) / lanes));
  }

  _laneRect(li) {
    const laneH = this._laneHeight();
    return {
      x: 0,
      y: RULER_H + li * (laneH + LANE_GAP),
      w: this.cssW,
      h: laneH,
    };
  }

  _timeAtEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(this.duration, x / this.pps));
  }

  _bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const t = this._timeAtEvent(e);
      const marker = this._markerAt(t);
      if (marker) {
        this.cb.onMarkerSelect?.(marker);
        return;
      }
      if (this.markerMode) {
        this.cb.onMarkerAdd?.(t);
        return;
      }
      const inRuler = e.offsetY < RULER_H;
      this.drag = { start: t, moved: false, inRuler };
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.drag) return;
      const t = this._timeAtEvent(e);
      if (Math.abs(t - this.drag.start) * this.pps > 3) this.drag.moved = true;
      this.selection = {
        start: Math.min(this.drag.start, t),
        end: Math.max(this.drag.start, t),
      };
      this.render();
      this.cb.onSelectionChanging?.(this.selection);
    });

    window.addEventListener('mouseup', () => {
      if (!this.drag) return;
      const d = this.drag;
      this.drag = null;
      if (!d.moved) {
        // 单击：移动播放头/定位，不保留选区
        this.selection = null;
        this.cb.onSeek?.(d.start);
      } else {
        this.cb.onSelectionChange?.(this.selection);
      }
      this.render();
    });

    this.canvas.addEventListener('dblclick', () => {
      this.selection = null;
      this.cb.onSelectionChange?.(null);
      this.render();
    });

    // Ctrl/⌘ + 滚轮：以光标为锚点缩放；普通滚轮横向滚动由容器原生处理
    this.canvas.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const anchorTime = (cursorX + this.container.scrollLeft) / this.pps;
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.setPps(this.pps * factor);
      this.container.scrollLeft = anchorTime * this.pps - cursorX;
    }, { passive: false });

    this.container.addEventListener('scroll', () => this.render());
  }

  _markerAt(time) {
    const tol = 7 / this.pps;
    // 标记画在标尺底部，命中判定按时间距离即可
    for (const m of this.markers) {
      if (Math.abs(m.time - time) <= tol) return m;
    }
    return null;
  }

  // ---------------- 渲染 ----------------

  render() {
    if (!this.cssW) this._ensureCanvasSize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this._drawRuler(ctx);
    const lanes = this.visibleLanes();
    lanes.forEach((lane, li) => this._drawLane(ctx, lane, li));
    this._drawMarkers(ctx);
    this._drawSelection(ctx);
  }

  _drawRuler(ctx) {
    const step = TICK_STEPS.find((s) => s * this.pps >= 70) || TICK_STEPS.at(-1);
    ctx.fillStyle = '#161b22';
    ctx.fillRect(0, 0, this.cssW, RULER_H - 4);
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 4.5);
    ctx.lineTo(this.cssW, RULER_H - 4.5);
    ctx.stroke();

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = '#8b949e';
    ctx.textBaseline = 'top';
    const startT = this.container.scrollLeft / this.pps;
    const endT = (this.container.scrollLeft + this.container.clientWidth) / this.pps;
    const first = Math.floor(startT / step);
    for (let k = first; k * step <= Math.min(this.duration, endT) + step; k++) {
      const t = k * step;
      const x = t * this.pps;
      ctx.strokeStyle = '#30363d';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 8);
      ctx.lineTo(x + 0.5, RULER_H - 5);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 4, 1);
    }
  }

  _drawLane(ctx, lane, li) {
    const rect = this._laneRect(li);
    const mid = rect.y + rect.h / 2;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
    ctx.strokeStyle = '#21262d';
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);

    // 中线
    ctx.strokeStyle = '#1c2128';
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(rect.w, mid + 0.5);
    ctx.stroke();

    // 声道标签
    ctx.fillStyle = '#58a6ff';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(lane.label, 6, rect.y + 12);

    const sr = this.sampleRate;
    const data = lane.data;
    const x0 = Math.max(0, Math.floor(this.container.scrollLeft) - 1);
    const x1 = Math.min(this.cssW, Math.ceil(this.container.scrollLeft + this.container.clientWidth) + 1);
    const amp = rect.h / 2 - 4;

    ctx.fillStyle = li === 0 ? '#3fb950' : '#d29922';
    for (let x = x0; x < x1; x++) {
      const f0 = Math.floor((x / this.pps) * sr);
      const f1 = Math.max(f0 + 1, Math.floor(((x + 1) / this.pps) * sr));
      let min = 1;
      let max = -1;
      for (let f = f0; f < f1 && f < data.length; f++) {
        const v = data[f];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max < min) { min = 0; max = 0; }
      const yTop = mid - max * amp;
      const yBot = mid - min * amp;
      ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
    }
  }

  _drawMarkers(ctx) {
    ctx.font = '10px ui-monospace, monospace';
    for (const m of this.markers) {
      const x = m.time * this.pps;
      ctx.strokeStyle = '#f0883e';
      ctx.fillStyle = '#f0883e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 4);
      ctx.lineTo(x + 0.5, this.cssH - 8);
      ctx.stroke();
      // 标尺上的小三角
      ctx.beginPath();
      ctx.moveTo(x - 5, 0);
      ctx.lineTo(x + 5, 0);
      ctx.lineTo(x, 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillText(m.name || 'M', x + 4, RULER_H - 2);
    }
    ctx.lineWidth = 1;
  }

  _drawSelection(ctx) {
    if (!this.selection) return;
    const { start, end } = this.selection;
    const x0 = start * this.pps;
    const x1 = end * this.pps;
    ctx.fillStyle = 'rgba(88, 166, 255, 0.18)';
    ctx.fillRect(x0, RULER_H - 4, x1 - x0, this.cssH - RULER_H - 4);
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, RULER_H - 4, Math.max(1, x1 - x0), this.cssH - RULER_H - 4);

    // 起止时间徽标
    ctx.font = '10px ui-monospace, monospace';
    const label = `${formatTime(start)} → ${formatTime(end)}（${formatTime(end - start)}）`;
    const tw = ctx.measureText(label).width + 10;
    const bx = Math.min(x0, this.cssW - tw - 4);
    ctx.fillStyle = '#1f6feb';
    ctx.fillRect(bx, RULER_H + 2, tw, 16);
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 5, RULER_H + 10);
  }
}
