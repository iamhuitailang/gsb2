// 迷你逐帧折线图(canvas 2D)。配色取自经验证的暗色调色板前三槽:
// 蓝 #3987e5 / 橙 #d95926 / 青 #199e70;重置事件用红 #e66767 竖线标记。
// 支持悬停十字线 + 数值气泡,以及与图同源的表格视图(无障碍兜底)。

const COLORS = {
  blue: '#3987e5',
  orange: '#d95926',
  aqua: '#199e70',
  red: '#e66767',
  text: '#c3c2b7',
  muted: '#7a7972',
  grid: '#2c2c2a',
  surface: '#1a1a19',
};

export class Sparkline {
  // series: [{key, label, color}], getPoint(frame) -> { [key]: number }
  constructor(canvas, opts) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.title = opts.title;
    this.series = opts.series;
    this.getPoint = opts.getPoint;
    this.window = opts.window || 120;
    this.currentFrame = 0;
    this.events = []; // [{frame, label}]
    this.hover = null;
    this._installHover();
  }

  setEvents(events) { this.events = events; }

  _installHover() {
    const cv = this.cv;
    cv.addEventListener('mousemove', (e) => {
      const rect = cv.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const dpr = window.devicePixelRatio || 1;
      const pad = 22 * dpr;
      const plotW = cv.width - pad - 8 * dpr;
      const frac = Math.min(1, Math.max(0, (x * dpr - pad) / plotW));
      const start = Math.max(0, this.currentFrame - this.window);
      this.hover = start + Math.round(frac * Math.min(this.window, this.currentFrame - start + 1));
      this.draw();
    });
    cv.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
  }

  draw(frame) {
    if (Number.isInteger(frame)) this.currentFrame = frame;
    const { ctx, cv } = this;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    const padL = 22 * dpr, padB = 14 * dpr, padT = 30 * dpr, padR = 8 * dpr;
    ctx.fillStyle = COLORS.surface;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = COLORS.text;
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.fillText(this.title, padL, 12 * dpr);

    const start = Math.max(0, this.currentFrame - this.window);
    const points = [];
    for (let f = start; f <= this.currentFrame; f++) {
      const p = this.getPoint(f);
      if (p) points.push({ frame: f, ...p });
    }
    if (points.length < 2) {
      ctx.fillStyle = COLORS.muted;
      ctx.fillText('等待数据…', padL, H / 2);
      return;
    }

    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const xOf = (f) => padL + ((f - start) / Math.max(1, this.currentFrame - start)) * plotW;
    const maxV = Math.max(0.02, ...points.flatMap((p) => this.series.map((s) => p[s.key] || 0)));
    const yOf = (v) => padT + plotH - (v / maxV) * plotH;

    // 网格 + 顶值
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = dpr;
    ctx.beginPath();
    ctx.moveTo(padL, padT); ctx.lineTo(W - padR, padT);
    ctx.moveTo(padL, padT + plotH); ctx.lineTo(W - padR, padT + plotH);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.font = `${9 * dpr}px system-ui, sans-serif`;
    ctx.fillText(maxV.toFixed(3), 2 * dpr, padT + 4 * dpr);
    ctx.fillText('0', 2 * dpr, padT + plotH);
    ctx.fillText(`f${start}`, padL, H - 3 * dpr);
    ctx.fillText(`f${this.currentFrame}`, W - padR - 24 * dpr, H - 3 * dpr);

    // 重置事件竖线
    for (const ev of this.events) {
      if (ev.frame < start || ev.frame > this.currentFrame) continue;
      ctx.strokeStyle = COLORS.red;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath();
      ctx.moveTo(xOf(ev.frame), padT);
      ctx.lineTo(xOf(ev.frame), padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 数据线(2px,与设计规范一致)
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = xOf(p.frame), y = yOf(p[s.key] || 0);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 图例(直接标注,不依赖颜色识别),放在标题右侧一行
    let lx = padL + 150 * dpr;
    ctx.font = `${10 * dpr}px system-ui, sans-serif`;
    for (const s of this.series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, 3 * dpr, 10 * dpr, 3 * dpr);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(s.label, lx + 13 * dpr, 7 * dpr);
      lx += (13 + s.label.length * 7 + 10) * dpr;
    }

    // 悬停十字线 + 气泡
    if (this.hover != null) {
      const hp = points.find((p) => p.frame === this.hover);
      if (hp) {
        const hx = xOf(hp.frame);
        ctx.strokeStyle = COLORS.muted;
        ctx.beginPath();
        ctx.moveTo(hx, padT); ctx.lineTo(hx, padT + plotH);
        ctx.stroke();
        const lines = [`帧 ${hp.frame}`, ...this.series.map((s) => `${s.label}: ${(hp[s.key] || 0).toFixed(4)}`)];
        const bw = 92 * dpr, bh = (lines.length * 12 + 6) * dpr;
        let bx = hx + 6 * dpr;
        if (bx + bw > W - padR) bx = hx - bw - 6 * dpr;
        ctx.fillStyle = 'rgba(20,20,19,0.94)';
        ctx.fillRect(bx, padT + 2 * dpr, bw, bh);
        ctx.strokeStyle = COLORS.grid;
        ctx.strokeRect(bx, padT + 2 * dpr, bw, bh);
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        lines.forEach((ln, i) => {
          ctx.fillStyle = i === 0 ? COLORS.text : this.series[i - 1].color;
          ctx.fillText(ln, bx + 5 * dpr, padT + (14 + i * 12) * dpr);
        });
      }
    }
  }
}

// 探针面板用的单序列小图(带红色的显露/重置点)
export class ProbeSparkline extends Sparkline {
  draw(frame) {
    super.draw(frame);
    if (!this._marks) return;
    const { ctx, cv } = this;
    const dpr = window.devicePixelRatio || 1;
    const start = Math.max(0, this.currentFrame - this.window);
    const padL = 22 * dpr, padR = 8 * dpr, padT = 16 * dpr, padB = 14 * dpr;
    const plotW = cv.width - padL - padR;
    const plotH = cv.height - padT - padB;
    const xOf = (f) => padL + ((f - start) / Math.max(1, this.currentFrame - start)) * plotW;
    ctx.fillStyle = COLORS.red;
    for (const m of this._marks) {
      if (m.frame < start || m.frame > this.currentFrame) continue;
      ctx.beginPath();
      ctx.arc(xOf(m.frame), padT + plotH - 2 * dpr, 2.5 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  setMarks(frames) { this._marks = frames; }
}

export const PROBE_COLORS = COLORS;
