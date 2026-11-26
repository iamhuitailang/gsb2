// 频谱图: 对数频率轴 (20Hz ~ Nyquist), dB 幅度轴, 前后两条曲线
'use strict';

class SpectrumView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.freqs = null;
    this.before = null;
    this.after = null;
    this._resize();
    window.addEventListener('resize', () => {
      this._resize();
      this.draw();
    });
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 800;
    const h = Number(this.canvas.getAttribute('height')) || 220;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.pad = { l: 52, r: 14, t: 14, b: 26 };
  }

  setData(freqs, before, after) {
    this.freqs = freqs;
    this.before = before;
    this.after = after;
    this.draw();
  }

  _css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  _x(freq) {
    const { l, r } = this.pad;
    const f0 = 20;
    const f1 = this.freqs[this.freqs.length - 1];
    const lo = Math.log10(f0);
    const hi = Math.log10(Math.max(f1, f0 * 10));
    return l + ((Math.log10(Math.max(freq, f0)) - lo) / (hi - lo)) * (this.w - l - r);
  }

  _y(db) {
    const { t, b } = this.pad;
    const lo = -90;
    const hi = 0;
    return t + (1 - (Math.max(lo, Math.min(hi, db)) - lo) / (hi - lo)) * (this.h - t - b);
  }

  draw() {
    const { ctx, w, h, pad } = this;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#101218';
    ctx.fillRect(0, 0, w, h);
    if (!this.freqs) {
      ctx.fillStyle = this._css('--muted');
      ctx.font = '13px sans-serif';
      ctx.fillText('分析噪声样本并调整参数后在此显示频谱', pad.l, h / 2);
      return;
    }

    // 网格 + 坐标
    ctx.strokeStyle = this._css('--border');
    ctx.fillStyle = this._css('--muted');
    ctx.font = '11px sans-serif';
    ctx.lineWidth = 1;
    for (let db = -90; db <= 0; db += 15) {
      const y = this._y(db);
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(w - pad.r, y);
      ctx.stroke();
      ctx.fillText(`${db}`, 8, y + 4);
    }
    const fMax = this.freqs[this.freqs.length - 1];
    const ticks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((f) => f <= fMax);
    ctx.textAlign = 'center';
    for (const f of ticks) {
      const x = this._x(f);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
      ctx.fillText(label, x, h - 8);
    }
    ctx.textAlign = 'left';
    ctx.fillText('Hz', w - pad.r - 18, h - 8);

    this._curve(this.before, this._css('--accent'));
    if (this.after) this._curve(this.after, this._css('--accent-2'));
  }

  _curve(data, color) {
    if (!data) return;
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 1; i < this.freqs.length; i++) {
      const x = this._x(this.freqs[i]);
      const y = this._y(data[i]);
      if (i === 1) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

window.SpectrumView = SpectrumView;
