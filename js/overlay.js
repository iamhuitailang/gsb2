// WebGL 画布上方的 2D 覆盖层:探针标记、追踪轨迹、分屏线、帧信息水印。
// 标记坐标使用归一化 UV,与画布尺寸无关;seek 后轨迹清空。

const PALETTE = {
  ghost: '#d95926',
  jitter: '#3987e5',
  track: '#199e70',
  text: '#f0efec',
  split: '#f0efec',
};

export class Overlay {
  constructor(canvas2d, glCanvas) {
    this.cv = canvas2d;
    this.glc = glCanvas;
    this.ctx = canvas2d.getContext('2d');
    this.probes = null;
    this.mode = 1;
    this.splitX = 0.5;
    this.frameInfo = null;
  }

  syncSize() {
    this.cv.width = this.glc.width;
    this.cv.height = this.glc.height;
  }

  draw() {
    const { ctx, cv } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!this.probes) return;

    const px = (u, v) => [u * cv.width, (1 - v) * cv.height];

    // 追踪轨迹(青色连线,老点渐隐)
    for (const t of this.probes.tracks) {
      const trail = this.probes.get(t.id);
      if (trail.length < 2) continue;
      ctx.lineWidth = 1.5 * dpr;
      trail.forEach((p, i) => {
        if (i === 0) return;
        const alpha = 1 - i / trail.length;
        ctx.strokeStyle = withAlpha(PALETTE.track, alpha * 0.8);
        const a = trail[i - 1], b = p;
        ctx.beginPath();
        ctx.moveTo(a.x, cv.height - a.y);
        ctx.lineTo(b.x, cv.height - b.y);
        ctx.stroke();
      });
      marker(ctx, ...px(t.u, t.v), PALETTE.track, 'T', dpr, t.label);
    }

    // 拖影探针(橙,方块)
    for (const p of this.probes.ghost) {
      marker(ctx, ...px(p.u, p.v), PALETTE.ghost, 'G', dpr, p.label);
    }
    // 抖动探针(蓝,圆)
    for (const p of this.probes.jitter) {
      marker(ctx, ...px(p.u, p.v), PALETTE.jitter, 'J', dpr, p.label);
    }

    // 分屏线
    if (this.mode === 2) {
      const x = this.splitX * cv.width;
      ctx.strokeStyle = PALETTE.split;
      ctx.setLineDash([6 * dpr, 6 * dpr]);
      ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      ctx.fillStyle = PALETTE.text;
      label(ctx, 8 * dpr, 16 * dpr, '单帧', dpr);
      label(ctx, x + 8 * dpr, 16 * dpr, 'TAA', dpr);
    }

    // 帧水印
    if (this.frameInfo) {
      const lines = [
        `帧 ${this.frameInfo.frame} / ${this.frameInfo.maxFrame}   t=${this.frameInfo.t.toFixed(3)}s`,
        `jitter[${this.frameInfo.jitterIndex}] = (${this.frameInfo.jx.toFixed(3)}, ${this.frameInfo.jy.toFixed(3)}) px级`,
        this.frameInfo.reset ? `⟲ 重开: ${this.frameInfo.reset}` : '历史有效',
      ];
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      lines.forEach((ln, i) => label(ctx, 8 * dpr, cv.height - (lines.length - i) * 15 * dpr - 6 * dpr, ln, dpr));
    }
  }
}

function marker(ctx, x, y, color, glyph, dpr, labelText) {
  const r = 7 * dpr;
  ctx.fillStyle = 'rgba(10,10,10,0.6)';
  ctx.beginPath(); ctx.arc(x, y, r + dpr, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = `bold ${9 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x, y + 0.5 * dpr);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  if (labelText) label(ctx, x + r + 3 * dpr, y - 3 * dpr, labelText, dpr);
}

function label(ctx, x, y, text, dpr) {
  ctx.font = `${11 * dpr}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(10,10,10,0.65)';
  ctx.fillRect(x - 3 * dpr, y - 11 * dpr, w + 6 * dpr, 14 * dpr);
  ctx.fillStyle = '#f0efec';
  ctx.fillText(text, x, y);
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
