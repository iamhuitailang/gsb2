/* protection.js — 保护区（原图坐标）
 *
 * 两套输出：
 *   maskCanvas —— 半透明蓝色叠加层，直接给 TiledView 平铺显示
 *   maskData   —— 每像素 0(保护)/255(可修正) 的 Uint8ClampedArray，供修正算法使用
 * 所有图形以矢量形状列表保存，项目文件可完整恢复并按原图尺寸重建。
 */
(function (global) {
  'use strict';

  class ProtectionMask {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.shapes = [];   // { tool:'brush'|'rect'|'eraser', size, points?:[[x,y]..], rect?:[x,y,w,h] }
      this._buildCanvases();
    }

    _buildCanvases() {
      this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = this.width;
      this.maskCanvas.height = this.height;
      this._rawCanvas = document.createElement('canvas');
      this._rawCanvas.width = this.width;
      this._rawCanvas.height = this.height;
      // 255 = 可修正：无保护图形时整张图都允许边缘修正（0 才是受保护）
      this.maskData = new Uint8ClampedArray(this.width * this.height).fill(255);
    }

    beginShape(tool, x, y, size) {
      const shape = { tool, size };
      if (tool === 'rect') shape.rect = [x, y, 0, 0], shape._origin = [x, y];
      else shape.points = [[x, y]];
      this.shapes.push(shape);
      return shape;
    }

    extendShape(shape, x, y) {
      if (shape.tool === 'rect') {
        const [ox, oy] = shape._origin;
        shape.rect = [Math.min(ox, x), Math.min(oy, y), Math.abs(x - ox), Math.abs(y - oy)];
      } else {
        const pts = shape.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(x - last[0], y - last[1]) >= 1) pts.push([x, y]);
      }
    }

    endShape(shape) {
      if (shape.tool === 'rect') delete shape._origin;
      this.rasterize();
    }

    undo() {
      this.shapes.pop();
      this.rasterize();
    }

    clear() {
      this.shapes = [];
      this.rasterize();
    }

    /** 按形状列表重建 8-bit mask 与显示层 */
    rasterize() {
      const raw = this._rawCanvas.getContext('2d');
      raw.setTransform(1, 0, 0, 1, 0, 0);
      raw.clearRect(0, 0, this.width, this.height);
      raw.fillStyle = '#fff';
      raw.strokeStyle = '#fff';
      raw.lineCap = 'round';
      raw.lineJoin = 'round';

      for (const s of this.shapes) {
        raw.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
        if (s.tool === 'rect') {
          const [x, y, w, h] = s.rect;
          if (w > 0 || h > 0) raw.fillRect(x, y, w, h);
        } else {
          raw.lineWidth = s.size;
          const pts = s.points;
          if (pts.length === 1) {
            raw.beginPath();
            raw.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2);
            raw.fill();
          } else {
            raw.beginPath();
            raw.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) raw.lineTo(pts[i][0], pts[i][1]);
            raw.stroke();
          }
        }
      }
      raw.globalCompositeOperation = 'source-over';

      // 读出 alpha：有保护区域 alpha=255
      const alpha = raw.getImageData(0, 0, this.width, this.height).data;
      for (let i = 0, p = 0; i < alpha.length; i += 4, p++) {
        this.maskData[p] = alpha[i + 3] ? 0 : 255; // 0=受保护, 255=可修正
      }

      // 显示层：蓝色半透明 + 描边
      const vis = this.maskCanvas.getContext('2d');
      vis.clearRect(0, 0, this.width, this.height);
      vis.fillStyle = 'rgba(79,156,249,0.30)';
      vis.strokeStyle = 'rgba(120,180,255,0.9)';
      vis.lineCap = 'round';
      vis.lineJoin = 'round';
      for (const s of this.shapes) {
        if (s.tool === 'eraser') continue; // 擦除不画额外标记
        if (s.tool === 'rect') {
          const [x, y, w, h] = s.rect;
          vis.fillRect(x, y, w, h);
          vis.lineWidth = 1;
          vis.strokeRect(x + 0.5, y + 0.5, w, h);
        } else {
          const pts = s.points;
          if (pts.length === 1) {
            vis.beginPath();
            vis.arc(pts[0][0], pts[0][1], s.size / 2, 0, Math.PI * 2);
            vis.fill();
          } else {
            vis.lineWidth = s.size;
            vis.beginPath();
            vis.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) vis.lineTo(pts[i][0], pts[i][1]);
            vis.stroke();
          }
        }
      }
    }

    toJSON() {
      return { width: this.width, height: this.height, shapes: this.shapes };
    }

    static fromJSON(data) {
      const m = new ProtectionMask(data.width, data.height);
      m.shapes = data.shapes.map((s) => {
        const copy = { tool: s.tool, size: s.size };
        if (s.rect) copy.rect = s.rect.slice();
        if (s.points) copy.points = s.points.map((p) => p.slice());
        return copy;
      });
      m.rasterize();
      return m;
    }
  }

  global.ProtectionMask = ProtectionMask;
})(typeof window !== 'undefined' ? window : globalThis);
