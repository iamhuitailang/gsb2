// 时间线：时间段、关键帧、播放头的绘制与交互
import { formatTime } from "./utils.js";

export class Timeline {
  constructor(canvas, { onScrub }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onScrub = onScrub;
    this.project = null;
    this.duration = 0;
    this.time = 0;
    this._drag = false;
    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.parentElement.clientWidth;
    this.canvas.style.width = `${w}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(86 * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.draw();
  }

  setProject(project, duration) {
    this.project = project;
    this.duration = duration;
    this.draw();
  }

  setTime(t) {
    this.time = t;
    this.draw();
  }

  _t2x(t) {
    const pad = 10;
    return pad + (t / Math.max(this.duration, 0.001)) * (this.viewW - pad * 2);
  }
  _x2t(x) {
    const pad = 10;
    const t = ((x - pad) / (this.viewW - pad * 2)) * Math.max(this.duration, 0.001);
    return Math.min(this.duration, Math.max(0, t));
  }

  _bind() {
    const c = this.canvas;
    const down = (e) => {
      this._drag = true;
      this._emit(e);
    };
    const move = (e) => { if (this._drag) this._emit(e); };
    const up = () => { this._drag = false; };
    c.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  _emit(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.onScrub(this._x2t(e.clientX - rect.left));
  }

  draw() {
    const ctx = this.ctx;
    const w = this.viewW, h = 86;
    ctx.clearRect(0, 0, w, h);
    if (!this.project) return;
    const dur = this.duration;

    // 时间刻度
    ctx.strokeStyle = "#2f3844";
    ctx.fillStyle = "#8b97a5";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    const tickEvery = dur > 20 ? 5 : dur > 8 ? 2 : 1;
    for (let t = 0; t <= dur + 0.001; t += tickEvery) {
      const x = this._t2x(t);
      ctx.beginPath();
      ctx.moveTo(x, 8); ctx.lineTo(x, h - 8);
      ctx.stroke();
      ctx.fillText(formatTime(t), x, h - 1);
    }

    // 时间段
    this.project.segments.forEach((seg, i) => {
      const x0 = this._t2x(seg.start);
      const x1 = seg.end === null ? this.viewW - 10 : this._t2x(seg.end);
      const active = this.time >= seg.start && (seg.end === null || this.time < seg.end);
      ctx.fillStyle = active ? "rgba(59,157,255,0.18)" : "rgba(255,255,255,0.04)";
      ctx.strokeStyle = active ? "#3b9dff" : "#3d4856";
      ctx.lineWidth = active ? 1.5 : 1;
      this._roundRect(x0 + 1, 18, Math.max(2, x1 - x0 - 2), 34, 5);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = active ? "#cfe4ff" : "#8b97a5";
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(`段 ${i + 1}`, x0 + 7, 32);
      ctx.font = "9px sans-serif";
      ctx.fillText(`${seg.masks.length} 笔遮罩`, x0 + 7, 45);

      // 关键帧菱形
      seg.keyframes.forEach((kf) => {
        const kx = this._t2x(seg.start + kf.t);
        ctx.fillStyle = active ? "#ffd166" : "#8a7a4d";
        ctx.beginPath();
        ctx.moveTo(kx, 60);
        ctx.lineTo(kx + 5, 66);
        ctx.lineTo(kx, 72);
        ctx.lineTo(kx - 5, 66);
        ctx.closePath();
        ctx.fill();
      });
    });

    // 播放头
    const px = this._t2x(this.time);
    ctx.strokeStyle = "#ff6b6b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 6); ctx.lineTo(px, h - 10);
    ctx.stroke();
    ctx.fillStyle = "#ff6b6b";
    ctx.beginPath();
    ctx.moveTo(px - 6, 6); ctx.lineTo(px + 6, 6); ctx.lineTo(px, 14);
    ctx.closePath(); ctx.fill();
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
