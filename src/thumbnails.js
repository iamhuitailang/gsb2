/* 帧截图与画面指纹。
 * 指纹：缩放到 16×9 的灰度均值序列（共 144 维），匹配时用零均值归一化互相关（NCC），
 * 对整体亮度变化、H.264 压缩噪声和版本角标差异不敏感。 */
'use strict';

const Thumbnails = {
  _canvas: null,
  _ctx: null,

  _getCanvas(w, h) {
    if (!this._canvas) {
      this._canvas = document.createElement('canvas');
      this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
    }
    this._canvas.width = w;
    this._canvas.height = h;
    return [this._canvas, this._ctx];
  },

  /** 截当前帧，返回压缩后的 JPEG dataURL */
  captureDataUrl(video, maxW = 320, quality = 0.72) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const scale = Math.min(1, maxW / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    const [canvas, ctx] = this._getCanvas(w, h);
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', quality);
  },

  /** 当前帧的 16×9 灰度指纹 */
  signature(video) {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    const W = 16, H = 9;
    const [canvas, ctx] = this._getCanvas(W, H);
    ctx.drawImage(video, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H);
    const sig = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      sig[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return sig;
  },

  /** 零均值归一化互相关，范围约 -1..1 */
  ncc(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
    ma /= a.length; mb /= b.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y;
      da += x * x;
      db += y * y;
    }
    if (da < 1e-6 || db < 1e-6) return 0;
    return num / Math.sqrt(da * db);
  },
};
