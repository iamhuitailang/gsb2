/**
 * 最小 Canvas/2D shim：仅实现本项目图像管线用到的 API（像素级，双线性采样）。
 * 浏览器里由原生 Canvas 完成同样的工作，这里让 Node 测试可以跑通合成链路。
 */
if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };
}

function parseRgba(style) {
  const m = style.match(/rgba?\(([^)]+)\)/);
  const parts = m[1].split(",").map((s) => s.trim());
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts[3] == null ? 255 : Math.round(Number(parts[3]) * 255),
  };
}

class FakeCanvas {
  constructor() {
    this._width = 0;
    this._height = 0;
    this.imageData = null;
    this._ctx = null;
  }
  get width() {
    return this._width;
  }
  set width(v) {
    if (v === this._width) return; // 与浏览器一致：同值赋值不清空
    this._width = v;
    if (v && this._height) this.imageData = new ImageData(v, this._height);
  }
  get height() {
    return this._height;
  }
  set height(v) {
    if (v === this._height) return;
    this._height = v;
    if (this._width && v) this.imageData = new ImageData(this._width, v);
  }
  getContext() {
    if (!this._ctx) {
      this._ctx = new FakeContext(this);
      this.ctx = this._ctx;
    }
    return this._ctx;
  }
}

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = "#000000";
    this.imageSmoothingEnabled = true;
    this.imageSmoothingQuality = "high";
  }

  putImageData(img) {
    if (!this.canvas.imageData || this.canvas.width !== img.width) {
      this.canvas.width = img.width;
      this.canvas.height = img.height;
    }
    this.canvas.imageData.data.set(img.data);
  }

  getImageData(x, y, w, h) {
    const out = new ImageData(w, h);
    const src = this.canvas.imageData.data;
    for (let row = 0; row < h; row++) {
      const sOff = ((y + row) * this.canvas.width + x) * 4;
      out.data.set(src.subarray(sOff, sOff + w * 4), row * w * 4);
    }
    return out;
  }

  fillRect(x, y, w, h) {
    const c = parseRgba(this.fillStyle);
    const d = this.canvas.imageData.data;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const o = (yy * this.canvas.width + xx) * 4;
        d[o] = c.r;
        d[o + 1] = c.g;
        d[o + 2] = c.b;
        d[o + 3] = c.a;
      }
    }
  }

  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    const srcW = src.naturalWidth || src.width;
    const srcH = src.naturalHeight || src.height;
    if (arguments.length === 3) {
      dx = sx; dy = sy; dw = srcW; dh = srcH;
      sx = sy = 0; sw = srcW; sh = srcH;
    } else if (arguments.length === 5) {
      dx = sx; dy = sy; dw = sw; dh = sh;
      sx = sy = 0; sw = srcW; sh = srcH;
    } else if (sw == null) {
      sw = srcW;
    }
    if (sh == null) sh = srcH;
    if (!this.canvas.imageData) {
      this.canvas.width = Math.max(dx + dw, dw);
      this.canvas.height = Math.max(dy + dh, dh);
    }
    const srcData = src.imageData || (src.ctx && src.ctx.canvas.imageData);
    const sd = srcData.data;
    const dd = this.canvas.imageData.data;
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
    const lerp = (a, b, t) => a + (b - a) * t;
    // 仅写目标矩形 [dx,dy,dw,dh]；矩形外保持画布原样（浏览器语义，留边区因此保留填充色）。
    // 双线性采样在目标边缘的半个像素会外推到源外，浏览器此时不保证写入，
    // 因此对映射后落在源范围外的目标像素直接跳过（与留边预期一致）。
    for (let yy = 0; yy < dh; yy++) {
      const outY = dy + yy;
      const ffy = (yy + 0.5) * sh / dh - 0.5;
      if (ffy < 0 || ffy > sh - 1) continue;
      const y0 = Math.floor(ffy);
      const y1 = Math.min(srcH - 1, y0 + 1);
      const ty = ffy - y0;
      for (let xx = 0; xx < dw; xx++) {
        const outX = dx + xx;
        const ffx = (xx + 0.5) * sw / dw - 0.5;
        if (ffx < 0 || ffx > sw - 1) continue;
        const x0 = Math.floor(ffx);
        const x1 = Math.min(srcW - 1, x0 + 1);
        const tx = ffx - x0;
        const doff = (outY * this.canvas.width + outX) * 4;
        for (let c = 0; c < 4; c++) {
          const p00 = sd[(y0 * srcW + x0) * 4 + c];
          const p10 = sd[(y0 * srcW + x1) * 4 + c];
          const p01 = sd[(y1 * srcW + x0) * 4 + c];
          const p11 = sd[(y1 * srcW + x1) * 4 + c];
          dd[doff + c] = lerp(lerp(p00, p10, tx), lerp(p01, p11, tx), ty);
        }
      }
    }
  }
}

function installDomShim() {
  globalThis.document = { createElement: () => new FakeCanvas() };
}

module.exports = { installDomShim, FakeCanvas, FakeContext };
