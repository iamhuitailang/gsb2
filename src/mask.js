// 局部遮罩：在预览画面上涂抹保留/移除区域，笔画按时间段存储
import { clamp, uid } from "./utils.js";

// 遮罩纹理通道：R=保留，G=移除
export class MaskEditor {
  constructor(canvas, getState) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.getState = getState; // () => ({ project, time, seg, brushSize, feather, mode })
    this.mode = "remove";
    this.painting = false;
    this.points = null;
    this._lastPt = null;
    // 视频画面在容器内的 contain 矩形（CSS 像素，相对容器）
    this.frame = { x: 0, y: 0, w: 1, h: 1 };
    this._bind();
  }

  // 由主循环调用：把遮罩画布精确对齐到视频显示区域
  syncFrame(containerRect, videoW, videoH) {
    if (!videoW || !videoH) return;
    const scale = Math.min(containerRect.width / videoW, containerRect.height / videoH);
    const w = videoW * scale, h = videoH * scale;
    this.frame = {
      x: (containerRect.width - w) / 2,
      y: (containerRect.height - h) / 2,
      w, h,
    };
    const c = this.canvas;
    c.style.left = `${this.frame.x}px`;
    c.style.top = `${this.frame.y}px`;
    c.style.width = `${this.frame.w}px`;
    c.style.height = `${this.frame.h}px`;
    this.drawOverlay();
  }

  _toNorm(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width),
      y: clamp((e.clientY - rect.top) / rect.height),
    };
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => {
      const st = this.getState();
      if (!st.seg) return;
      this.painting = true;
      c.setPointerCapture(e.pointerId);
      const pt = this._toNorm(e);
      const rect = c.getBoundingClientRect();
      const r = st.brushSize / rect.width;
      this.points = [{ ...pt, r }];
      this._lastPt = pt;
      this._strokeRadius = r;
      this.drawOverlay();
    });
    c.addEventListener("pointermove", (e) => {
      const st = this.getState();
      const pt = this._toNorm(e);
      if (this.painting && this.points) {
        // 插值补点，避免快速拖动出现断线
        const last = this.points[this.points.length - 1];
        const dist = Math.hypot(pt.x - last.x, pt.y - last.y);
        const step = this._strokeRadius * 0.35;
        if (dist > step) {
          const n = Math.ceil(dist / step);
          for (let i = 1; i <= n; i++) {
            const f = i / n;
            this.points.push({
              x: last.x + (pt.x - last.x) * f,
              y: last.y + (pt.y - last.y) * f,
              r: this._strokeRadius,
            });
          }
        }
        this._lastPt = pt;
        this.drawOverlay();
      } else if (st.seg) {
        this._hover = pt;
        this.drawOverlay();
      }
    });
    const finish = () => {
      if (!this.painting) return;
      this.painting = false;
      const st = this.getState();
      if (this.points && this.points.length && st.seg) {
        st.seg.masks.push({
          id: uid("mask"),
          mode: this.mode,
          feather: st.feather,
          points: this.points,
        });
        st.onChange?.();
      }
      this.points = null;
      this._lastPt = null;
      this.drawOverlay();
    };
    c.addEventListener("pointerup", finish);
    c.addEventListener("pointercancel", finish);
    c.addEventListener("pointerleave", () => { this._hover = null; this.drawOverlay(); });
  }

  undo(seg) {
    if (!seg || !seg.masks.length) return false;
    seg.masks.pop();
    this.drawOverlay();
    return true;
  }

  clear(seg) {
    if (!seg) return false;
    seg.masks = [];
    this.drawOverlay();
    return true;
  }

  // 把某时间段的所有笔画栅格化到遮罩 canvas（视频原始分辨率）
  rasterize(seg, width, height) {
    const c = this.maskCanvas || (this.maskCanvas = document.createElement("canvas"));
    if (c.width !== width || c.height !== height) {
      c.width = width; c.height = height;
    }
    const ctx = c.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.filter = "none";
    if (!seg) return c;

    for (const stroke of seg.masks) {
      const color = stroke.mode === "keep" ? "255,0,0" : "0,255,0";
      ctx.globalCompositeOperation = "source-over";
      this._paintStroke(ctx, stroke, width, height, color, 1);
    }
    // 羽化：对整层做一次高斯模糊（浏览器原生 canvas filter）
    const maxFeather = Math.max(0, ...seg.masks.map((m) => m.feather));
    if (maxFeather > 0) {
      const tmp = document.createElement("canvas");
      tmp.width = width; tmp.height = height;
      const tctx = tmp.getContext("2d");
      tctx.drawImage(c, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.filter = `blur(${maxFeather}px)`;
      ctx.drawImage(tmp, 0, 0);
      ctx.filter = "none";
    }
    return c;
  }

  _paintStroke(ctx, stroke, w, h, rgb, alpha) {
    ctx.fillStyle = `rgba(${rgb},${alpha})`;
    for (const p of stroke.points) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, p.r * w, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 屏幕上的编辑覆盖层（半透明绿/红 + 画笔光标）
  drawOverlay() {
    const st = this.getState();
    const c = this.canvas;
    const ctx = this.ctx;
    const rect = c.getBoundingClientRect();
    const w = Math.max(1, rect.width | 0), h = Math.max(1, rect.height | 0);
    if (c.width !== w || c.height !== h) {
      c.width = w; c.height = h;
    }
    ctx.clearRect(0, 0, c.width, c.height);
    if (!st.seg) return;

    for (const stroke of st.seg.masks) {
      const col = stroke.mode === "keep" ? [53, 196, 109] : [224, 85, 85];
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.35)`;
      for (const p of stroke.points) {
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, p.r * c.width, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 当前正在画的笔画
    if (this.points) {
      const col = this.mode === "keep" ? [53, 196, 109] : [224, 85, 85];
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.5)`;
      for (const p of this.points) {
        ctx.beginPath();
        ctx.arc(p.x * c.width, p.y * c.height, p.r * c.width, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // 画笔悬停圈
    if (this._hover && !this.painting) {
      ctx.strokeStyle = this.mode === "keep" ? "rgba(53,196,109,0.9)" : "rgba(224,85,85,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(this._hover.x * c.width, this._hover.y * c.height, st.brushSize, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}
