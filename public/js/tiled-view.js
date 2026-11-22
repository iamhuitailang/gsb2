/* tiled-view.js — 平铺预览视图
 *
 * 坐标约定：
 *   图像空间 (ix, iy) = 原图坐标（整数像素即原图同一位置），
 *   视图状态 { panX, panY, zoom } 只负责“图像空间 → 屏幕像素”的映射。
 *   平移、切换缩放、切换平铺模式都不改图像内容，因此原图定位始终一致。
 *
 * 防插值误缝：
 *   先把单张纹理 drawImage 到一个 N×N 的离屏图集（关闭 imageSmoothing），
 *   再一次性把图集缩放到屏幕。每个瓦片只在自己的整数边界内被采样，
 *   缩放产生的柔化只发生在屏幕端，永远不参与像素级诊断。
 */
(function (global) {
  'use strict';

  const COLORS = {
    v: '#ff6b6b',
    h: '#f7b32b',
    corner: '#c678dd',
    boundary: 'rgba(255,255,255,0.55)',
    protect: 'rgba(79,156,249,0.30)',
    protectLine: 'rgba(120,180,255,0.9)',
  };

  class TiledView {
    constructor(canvas, wrapEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.wrap = wrapEl;
      this.panX = 0;
      this.panY = 0;
      this.zoom = 1;
      this.mode = 'both';               // both | horizontal | vertical | single
      this.showBoundaries = true;
      this.showMarkers = true;
      this.showProtect = true;
      this.source = null;               // 当前显示用 canvas（原版或修正版）
      this.originalSource = null;       // 分屏另一半
      this.compareMode = 'split';       // current | original | split
      this.splitAt = 0.5;
      this.analysis = null;
      this.maskCanvas = null;
      this.atlas = null;
      this.atlasOrig = null;
      this._atlasKey = '';
      this.dpr = Math.max(1, global.devicePixelRatio || 1);
      this.onCursor = null;             // (imageX, imageY) => void
    }

    setSource(sourceCanvas) {
      this.source = sourceCanvas;
      this._atlasKey = '';
      this.invalidateAtlas();
    }

    setOriginalSource(sourceCanvas) {
      this.originalSource = sourceCanvas;
      this.invalidateAtlas();
    }

    setAnalysis(a) { this.analysis = a; }
    setMaskCanvas(c) { this.maskCanvas = c; }
    setMode(mode) { this.mode = mode; }
    setCompare(mode) { this.compareMode = mode; }
    setSplitAt(v) { this.splitAt = v; }

    invalidateAtlas() {
      this.atlas = null;
      this.atlasOrig = null;
      this._atlasKey = '';
    }

    resize() {
      const rect = this.wrap.getBoundingClientRect();
      this.dpr = Math.max(1, global.devicePixelRatio || 1);
      this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
      this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
      this.render();
    }

    get viewW() { return this.canvas.width / this.dpr; }
    get viewH() { return this.canvas.height / this.dpr; }

    /** 屏幕像素 → 图像空间（含环绕，返回原图坐标） */
    screenToImage(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      if (!this.source) return null;
      const W = this.source.width, H = this.source.height;
      const ix = (sx - this.panX) / this.zoom;
      const iy = (sy - this.panY) / this.zoom;
      return {
        x: ((ix % W) + W) % W,
        y: ((iy % H) + H) % H,
        ix, iy, sx, sy,
      };
    }

    /** 图像空间 → 屏幕像素 */
    imageToScreen(ix, iy) {
      return { x: this.panX + ix * this.zoom, y: this.panY + iy * this.zoom };
    }

    fitZoom() {
      if (!this.source) return;
      const z = Math.min(this.viewW / this.source.width, this.viewH / this.source.height);
      this.setZoom(z, this.viewW / 2, this.viewH / 2);
      this.panX = (this.viewW - this.source.width * this.zoom) / 2;
      this.panY = (this.viewH - this.source.height * this.zoom) / 2;
    }

    /** 以屏幕点 (ax, ay) 为不动点缩放，保证该点对应的原图位置不变 */
    setZoom(newZoom, anchorX, anchorY) {
      if (!this.source) { this.zoom = newZoom; return; }
      newZoom = Math.max(0.05, Math.min(16, newZoom));
      if (anchorX === undefined) { anchorX = this.viewW / 2; anchorY = this.viewH / 2; }
      const imgX = (anchorX - this.panX) / this.zoom;
      const imgY = (anchorY - this.panY) / this.zoom;
      this.zoom = newZoom;
      this.panX = anchorX - imgX * newZoom;
      this.panY = anchorY - imgY * newZoom;
    }

    zoomBy(factor, anchorX, anchorY) {
      this.setZoom(this.zoom * factor, anchorX, anchorY);
    }

    /** 把某条接缝平移到视图中央（接缝在图像空间中的位置 k*W，k=0 那条即图像边缘） */
    centerSeam(axis) {
      if (!this.source) return;
      // 仅横向平铺时没有竖向接缝、仅纵向平铺时没有横向接缝，按当前模式裁剪
      const canV = this.mode === 'both' || this.mode === 'horizontal';
      const canH = this.mode === 'both' || this.mode === 'vertical';
      if ((axis === 'v' || axis === 'both') && canV) this.panX = this.viewW / 2;
      if ((axis === 'h' || axis === 'both') && canH) this.panY = this.viewH / 2;
    }

    resetPan() {
      if (!this.source) return;
      this.panX = (this.viewW - this.source.width * this.zoom) / 2;
      this.panY = (this.viewH - this.source.height * this.zoom) / 2;
    }

    /** 让某个原图坐标（例如角点）出现在视图中央 */
    centerOnImagePoint(x, y) {
      if (!this.source) return;
      this.panX = this.viewW / 2 - x * this.zoom;
      this.panY = this.viewH / 2 - y * this.zoom;
    }

    /* ---------------- 离屏图集 ---------------- */

    _buildAtlas(src) {
      if (!src) return null;
      const W = src.width, H = src.height;
      let nx = 1, ny = 1;
      if (this.mode === 'both' || this.mode === 'horizontal') {
        nx = Math.max(2, Math.ceil(this.viewW / (W * this.zoom)) + 2);
      }
      if (this.mode === 'both' || this.mode === 'vertical') {
        ny = Math.max(2, Math.ceil(this.viewH / (H * this.zoom)) + 2);
      }
      const atlas = document.createElement('canvas');
      atlas.width = W * nx;
      atlas.height = H * ny;
      const actx = atlas.getContext('2d');
      actx.imageSmoothingEnabled = false;
      for (let ty = 0; ty < ny; ty++) {
        for (let tx = 0; tx < nx; tx++) {
          actx.drawImage(src, tx * W, ty * H);
        }
      }
      return atlas;
    }

    /** 图集左上角的屏幕位置：对齐到覆盖可视区的第一个瓦片，
     *  pan 为负（向左/上平移）时左、上方仍有瓦片覆盖 */
    _atlasOrigin() {
      // 单图模式不平铺，图集就是一张图，固定从 pan 开始
      if (this.mode === 'single') return { x: this.panX, y: this.panY };
      const tileW = this.source.width * this.zoom;
      const tileH = this.source.height * this.zoom;
      return {
        x: Math.floor(this.panX / tileW) * tileW,
        y: Math.floor(this.panY / tileH) * tileH,
      };
    }

    _ensureAtlases() {
      const key = [this.mode, this.zoom.toFixed(4), this.viewW, this.viewH,
        this.source && this.source.width, this.source && this.source.height].join('|');
      if (key === this._atlasKey && this.atlas) return;
      this.atlas = this._buildAtlas(this.source);
      this.atlasOrig = this._buildAtlas(this.originalSource);
      this._atlasKey = key;
    }

    /* ---------------- 渲染 ---------------- */

    render() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.viewW, this.viewH);
      if (!this.source) return;
      this._ensureAtlases();

      const W = this.source.width, H = this.source.height;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      const drawAtlas = (atlas, clipX, clipW) => {
        if (!atlas) return;
        const origin = this._atlasOrigin();
        ctx.save();
        if (clipW !== undefined) ctx.beginPath(), ctx.rect(clipX, 0, clipW, this.viewH), ctx.clip();
        // 图集整体按 pan/zoom 缩放，起点对齐到覆盖可视区的首个瓦片
        ctx.drawImage(atlas, origin.x, origin.y,
          atlas.width * this.zoom, atlas.height * this.zoom);
        ctx.restore();
      };

      if (this.compareMode === 'original' && this.atlasOrig) {
        drawAtlas(this.atlasOrig);
      } else if (this.compareMode === 'split' && this.atlasOrig) {
        const splitX = this.viewW * this.splitAt;
        drawAtlas(this.atlasOrig, 0, splitX);
        drawAtlas(this.atlas, splitX, this.viewW - splitX);
        ctx.save();
        ctx.strokeStyle = '#4f9cf9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(splitX, 0);
        ctx.lineTo(splitX, this.viewH);
        ctx.stroke();
        ctx.fillStyle = 'rgba(79,156,249,0.9)';
        ctx.font = '11px sans-serif';
        ctx.fillText('原版', 8, 16);
        ctx.fillText('修正版', splitX + 8, 16);
        ctx.restore();
      } else {
        drawAtlas(this.atlas);
      }

      if (this.showProtect && this.maskCanvas) this._renderMask();
      if (this.showBoundaries) this._renderBoundaries();
      if (this.showMarkers && this.analysis) this._renderMarkers();
    }

    /** 每 k 个图像空间周期出现一次的线条，覆盖可视区 */
    _eachPeriod(period, pan, viewSize, cb) {
      const startK = Math.floor(-pan / period) - 1;
      const endK = Math.ceil((viewSize - pan) / period) + 1;
      for (let k = startK; k <= endK; k++) cb(k, pan + k * period);
    }

    _renderBoundaries() {
      const ctx = this.ctx;
      const W = this.source.width, H = this.source.height;
      ctx.save();
      ctx.strokeStyle = COLORS.boundary;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 5]);
      if (this.mode !== 'vertical') {
        this._eachPeriod(W, this.panX, this.viewW, (k, sx) => {
          ctx.beginPath(); ctx.moveTo(sx + 0.5, 0); ctx.lineTo(sx + 0.5, this.viewH); ctx.stroke();
        });
      }
      if (this.mode !== 'horizontal') {
        this._eachPeriod(H, this.panY, this.viewH, (k, sy) => {
          ctx.beginPath(); ctx.moveTo(0, sy + 0.5); ctx.lineTo(this.viewW, sy + 0.5); ctx.stroke();
        });
      }
      ctx.restore();
    }

    _renderMask() {
      const ctx = this.ctx;
      const W = this.source.width, H = this.source.height;
      const tileW = W * this.zoom, tileH = H * this.zoom;
      const kx0 = Math.floor(-this.panX / tileW) - 1;
      const kx1 = Math.ceil((this.viewW - this.panX) / tileW) + 1;
      const ky0 = Math.floor(-this.panY / tileH) - 1;
      const ky1 = Math.ceil((this.viewH - this.panY) / tileH) + 1;
      ctx.save();
      for (let ty = ky0; ty <= ky1; ty++) {
        for (let tx = kx0; tx <= kx1; tx++) {
          ctx.drawImage(
            this.maskCanvas,
            this.panX + tx * tileW,
            this.panY + ty * tileH,
            tileW, tileH
          );
        }
      }
      ctx.restore();
    }

    _renderMarkers() {
      const ctx = this.ctx;
      const W = this.source.width, H = this.source.height;
      const a = this.analysis;
      const lineW = Math.max(2, Math.min(10, this.zoom * 0.9));

      ctx.save();
      // 竖向异常边段：画在图像空间 x=0（即接缝线）上，沿 y 展布
      if (this.mode !== 'vertical') {
        for (const seg of a.vertical.segments) {
          ctx.strokeStyle = COLORS.v;
          ctx.lineWidth = lineW;
          this._eachPeriod(W, this.panX, this.viewW, (k, sx) => {
            const y0 = this.panY + seg.start * this.zoom;
            const y1 = this.panY + (seg.end + 1) * this.zoom;
            ctx.beginPath(); ctx.moveTo(sx, y0); ctx.lineTo(sx, y1); ctx.stroke();
          });
        }
      }
      // 横向异常边段：画在图像空间 y=0 上，沿 x 展布
      if (this.mode !== 'horizontal') {
        for (const seg of a.horizontal.segments) {
          ctx.strokeStyle = COLORS.h;
          ctx.lineWidth = lineW;
          this._eachPeriod(H, this.panY, this.viewH, (k, sy) => {
            const x0 = this.panX + seg.start * this.zoom;
            const x1 = this.panX + (seg.end + 1) * this.zoom;
            ctx.beginPath(); ctx.moveTo(x0, sy); ctx.lineTo(x1, sy); ctx.stroke();
          });
        }
      }

      // 角点：接缝交点（图像空间整数倍 W,H 处），异常角单独高亮
      const badCorners = a.corners.filter((c) => c.bad);
      if (badCorners.length && this.mode === 'both') {
        const r = Math.max(4, Math.min(12, this.zoom * 0.6));
        this._eachPeriod(W, this.panX, this.viewW, (k, sx) => {
          this._eachPeriod(H, this.panY, this.viewH, (kk, sy) => {
            ctx.fillStyle = COLORS.corner;
            ctx.strokeStyle = 'rgba(255,255,255,.85)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
          });
        });
      }
      ctx.restore();
    }
  }

  const api = { TiledView, COLORS };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    global.TiledView = api.TiledView;
    global.TiledViewColors = api.COLORS;
  }
})(typeof window !== 'undefined' ? window : globalThis);
