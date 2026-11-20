/* 画面标记层：矩形（SVG，归一化坐标）+ 点意见（HTML 图钉）。
 * 所有坐标都是相对画面的 0..1 归一化值，舞台任意缩放都自动贴合。 */
'use strict';

class MarkerLayer {
  constructor({ stage, scroll, overlay, svg, htmlLayer, canvas, video, getComments, onSelect, getCurrentFrame, showAll }) {
    this.stage = stage;
    this.scroll = scroll;
    this.overlay = overlay;
    this.svg = svg;
    this.htmlLayer = htmlLayer;
    this.canvas = canvas;
    this.video = video;
    this.getComments = getComments;
    this.onSelect = onSelect;
    this.getCurrentFrame = getCurrentFrame;
    this.showAll = showAll;                 // () => boolean
    this.zoomMode = 'fit';                  // fit | number
    this.drawMode = false;
    this.selectedId = null;
    this._drag = null;

    this._fit();
    new ResizeObserver(() => { if (this.zoomMode === 'fit') this._fit(); }).observe(this.scroll);
    this.video.addEventListener('loadedmetadata', () => this._fit());
    this._bindDraw();
  }

  /* ---------- 缩放 ---------- */

  _fit() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw) {
      this.stage.style.width = '640px';
      this.stage.style.aspectRatio = '16 / 9';
      return;
    }
    const pad = 36;
    const availW = this.scroll.clientWidth - pad;
    const availH = this.scroll.clientHeight - pad;
    const scale = Math.min(availW / vw, availH / vh, 1);
    this._applyScale(Math.max(0.1, scale));
  }

  _applyScale(scale) {
    const vw = this.video.videoWidth || 960;
    const vh = this.video.videoHeight || 540;
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    this.stage.style.width = `${w}px`;
    this.stage.style.height = `${h}px`;
    this.stage.style.aspectRatio = 'auto';
    this.canvas.width = w;
    this.canvas.height = h;
    this.render();
  }

  setZoom(mode) {
    this.zoomMode = mode;
    if (mode === 'fit') {
      this._fit();
    } else {
      this._applyScale(mode);
    }
  }

  zoomBy(factor) {
    const vw = this.video.videoWidth || 960;
    const cur = this.zoomMode === 'fit'
      ? Math.min(this.scroll.clientWidth - 36, vw) / vw
      : this.zoomMode;
    this.setZoom(clamp(cur * factor, 0.1, 8));
  }

  get zoomLabel() {
    if (this.zoomMode === 'fit') return '适应窗口';
    return `${Math.round(this.zoomMode * 100)}%`;
  }

  /* ---------- 绘制矩形 ---------- */

  setDrawMode(on) {
    this.drawMode = on;
    this.stage.classList.toggle('drawing', on);
  }

  _bindDraw() {
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.drawMode) return;
      e.preventDefault();
      const p0 = this._toNormalized(e);
      this._drag = { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
      this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const p = this._toNormalized(e);
      this._drag.x1 = p.x;
      this._paintDraft();
    });
    this.canvas.addEventListener('pointerup', () => {
      if (!this._drag) return;
      const r = this._normalizedRect(this._drag);
      this._drag = null;
      this._clearDraft();
      if (r.w < 0.012 || r.h < 0.012) {
        window.dispatchEvent(new CustomEvent('marker-draw-cancel'));
        return;
      }
      window.dispatchEvent(new CustomEvent('marker-drawn', { detail: r }));
    });
  }

  _toNormalized(e) {
    const box = this.stage.getBoundingClientRect();
    return {
      x: clamp((e.clientX - box.left) / box.width, 0, 1),
      y: clamp((e.clientY - box.top) / box.height, 0, 1),
    };
  }

  _normalizedRect(d) {
    const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    return { x: round3(x), y: round3(y), w: round3(Math.abs(d.x1 - d.x0)), h: round3(Math.abs(d.y1 - d.y0)) };
  }

  _paintDraft() {
    const ctx = this.canvas.getContext('2d');
    const r = this._normalizedRect(this._drag);
    this._clearDraft();
    ctx.fillStyle = 'rgba(77,163,255,.14)';
    ctx.strokeStyle = '#4da3ff';
    ctx.lineWidth = 2;
    ctx.fillRect(r.x * this.canvas.width, r.y * this.canvas.height, r.w * this.canvas.width, r.h * this.canvas.height);
    ctx.strokeRect(r.x * this.canvas.width, r.y * this.canvas.height, r.w * this.canvas.width, r.h * this.canvas.height);
  }

  _clearDraft() {
    this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /* ---------- 标记渲染 ---------- */

  setSelected(id) {
    this.selectedId = id;
    this.render();
  }

  render() {
    const frame = this.getCurrentFrame();
    const comments = this.getComments();
    const showAll = this.showAll();

    // SVG 矩形
    const rects = comments.filter((c) => c.rect);
    this.svg.innerHTML = rects.map((c) => {
      const active = frame >= c.startFrame && frame <= (c.endFrame ?? c.startFrame);
      const opacity = showAll ? (active ? 1 : 0.28) : (active ? 1 : 0);
      const r = c.rect;
      const cls = [
        'marker-rect',
        c.status === 'done' ? 'done' : '',
        c.status === 'needs-confirm' ? 'needs-confirm' : '',
        c.endFrame != null ? 'range' : '',
        this.selectedId === c.id ? 'selected' : '',
      ].join(' ');
      return `<rect class="${cls}" data-id="${c.id}"
        x="${(r.x * 100).toFixed(2)}%" y="${(r.y * 100).toFixed(2)}%"
        width="${(r.w * 100).toFixed(2)}%" height="${(r.h * 100).toFixed(2)}%"
        opacity="${opacity}"></rect>`;
    }).join('');
    this.svg.querySelectorAll('rect').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onSelect(el.dataset.id);
      });
    });

    // 点意见图钉（含矩形意见在无矩形时的兜底）
    const pins = comments.filter((c) => !c.rect);
    // 同一帧多条：水平错开
    const byFrame = new Map();
    for (const c of pins) {
      const key = c.startFrame;
      if (!byFrame.has(key)) byFrame.set(key, []);
      byFrame.get(key).push(c);
    }
    this.htmlLayer.innerHTML = '';
    for (const [, group] of byFrame) {
      group.forEach((c, idx) => {
        const active = frame >= c.startFrame && frame <= (c.endFrame ?? c.startFrame);
        const opacity = showAll ? (active ? 1 : 0.3) : (active ? 1 : 0);
        const pin = document.createElement('div');
        const seq = comments.filter((x) => x.startFrame === c.startFrame).indexOf(c) + 1;
        pin.className = `marker-pin ${c.status === 'done' ? 'done' : ''} ${c.status === 'needs-confirm' ? 'needs-confirm' : ''} ${this.selectedId === c.id ? 'selected' : ''}`;
        pin.style.opacity = opacity;
        pin.style.left = `${Math.round(50 + (idx - (group.length - 1) / 2) * 9)}%`;
        pin.style.top = '62%';
        pin.innerHTML = `<span class="pin-label">#${seq} ${escapeHtml(Timecode.framesToTc(c.startFrame, this._fps()))}</span><span class="pin-dot"></span>`;
        pin.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onSelect(c.id);
        });
        this.htmlLayer.appendChild(pin);
      });
    }
  }

  _fps() {
    return window.app ? window.app.store.state.fps : 30;
  }
}
