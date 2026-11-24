// 俯视编辑画布：格子、区域、探针、路径、当前物体位置。

import { GRID, DIVIDER } from './config.js';
import { probeWorldPos } from './model.js';
import { clamp, rgbToCss } from './util.js';

const PAD = 26;

export class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.hit = [];
    this.pointer = null;
    this.drag = null;
    this.hoverCell = null;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(240, rect.width);
    const h = Math.max(200, rect.height);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w;
    this.h = h;
    this.computeScale();
  }

  computeScale() {
    const worldW = GRID.cols * GRID.cell;
    const worldH = GRID.rows * GRID.cell;
    this.sx = (this.w - PAD * 2) / worldW;
    this.sz = (this.h - PAD * 2) / worldH;
    this.s = Math.min(this.sx, this.sz);
    this.ox = (this.w - worldW * this.s) / 2;
    this.oz = (this.h - worldH * this.s) / 2;
  }

  toScreen(x, z) {
    return {
      x: this.ox + (x - GRID.originX) * this.s,
      y: this.oz + (z - GRID.originZ) * this.s,
    };
  }

  toWorld(sx, sy) {
    return {
      x: GRID.originX + (sx - this.ox) / this.s,
      z: GRID.originZ + (sy - this.oz) / this.s,
    };
  }

  cellAtWorld(x, z) {
    const col = Math.floor((x - GRID.originX) / GRID.cell);
    const row = Math.floor((z - GRID.originZ) / GRID.cell);
    if (col < 0 || col >= GRID.cols || row < 0 || row >= GRID.rows) return null;
    return { col, row };
  }

  draw(state, sample, mode, options = {}) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.fillStyle = '#141416';
    ctx.fillRect(0, 0, this.w, this.h);
    this.hit = [];

    const cellPx = GRID.cell * this.s;

    // 格子
    for (const cell of state.cells) {
      const p = this.toScreen(
        GRID.originX + cell.col * GRID.cell,
        GRID.originZ + cell.row * GRID.cell,
      );
      const isHover = this.hoverCell && this.hoverCell.col === cell.col && this.hoverCell.row === cell.row;
      const isSelected = options.selectedCell && options.selectedCell.col === cell.col && options.selectedCell.row === cell.row;
      ctx.fillStyle = cell.zone === 'exterior'
        ? 'rgba(217,89,38,0.075)'
        : cell.zone === 'interior'
          ? 'rgba(57,135,229,0.09)'
          : 'rgba(137,135,129,0.06)';
      ctx.fillRect(p.x, p.y, cellPx, cellPx);

      // 采样网格的亮度提示（每格再分 2×2）
      if (!cell.blocked) {
        for (let dz = 0; dz < 2; dz += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const wx = GRID.originX + cell.col * GRID.cell + (dx + 0.5) * GRID.cell / 2;
            const wz = GRID.originZ + cell.row * GRID.cell + (dz + 0.5) * GRID.cell / 2;
            const s = sample(wx, wz, mode);
            ctx.fillStyle = rgbToCss(s.colors.up, 0.5);
            ctx.fillRect(
              p.x + (dx * cellPx) / 2 + 1,
              p.y + (dz * cellPx) / 2 + 1,
              cellPx / 2 - 2,
              cellPx / 2 - 2,
            );
          }
        }
      }

      if (cell.blocked) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(p.x, p.y, cellPx, cellPx);
        ctx.clip();
        ctx.strokeStyle = 'rgba(240,239,236,0.12)';
        ctx.lineWidth = 1;
        for (let d = -cellPx; d < cellPx * 2; d += 8) {
          ctx.beginPath();
          ctx.moveTo(p.x + d, p.y);
          ctx.lineTo(p.x + d + cellPx, p.y + cellPx);
          ctx.stroke();
        }
        ctx.restore();
      }

      ctx.strokeStyle = isSelected
        ? 'rgba(240,239,236,0.85)'
        : isHover
          ? 'rgba(240,239,236,0.45)'
          : 'rgba(240,239,236,0.11)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(p.x + 0.5, p.y + 0.5, cellPx - 1, cellPx - 1);

      this.hit.push({ kind: 'cell', col: cell.col, row: cell.row, area: [p.x, p.y, cellPx, cellPx] });
    }

    // 门与隔墙
    const wallX = this.toScreen(DIVIDER.x, GRID.originZ);
    const open = clamp(state.door.open, 0, 1);
    const half = state.door.hasOpening ? DIVIDER.doorHalf : 0;
    const z0 = this.toScreen(DIVIDER.x, -half).y;
    const z1 = this.toScreen(DIVIDER.x, half).y;
    const top = this.toScreen(DIVIDER.x, GRID.originZ).y;
    const bottom = this.toScreen(DIVIDER.x, GRID.originZ + GRID.rows * GRID.cell).y;

    ctx.strokeStyle = 'rgba(240,239,236,0.5)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(wallX.x, top);
    ctx.lineTo(wallX.x, z0);
    ctx.moveTo(wallX.x, z1);
    ctx.lineTo(wallX.x, bottom);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(240,239,236,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wallX.x, z0);
    ctx.lineTo(wallX.x, z1);
    ctx.stroke();

    if (state.door.hasOpening) {
      // 门扇俯视：从 z = -half 起向室内（-x）转开
      const hinge = this.toScreen(DIVIDER.x, -half);
      const angle = open * (Math.PI / 2);
      const len = half * 2 * this.s;
      ctx.strokeStyle = 'rgba(200,158,116,0.95)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(hinge.x, hinge.y);
      ctx.lineTo(hinge.x - Math.sin(angle) * len, hinge.y + Math.cos(angle) * len);
      ctx.stroke();

      // 门洞的开启范围
      if (open > 0.02) {
        ctx.fillStyle = 'rgba(240,239,236,0.05)';
        ctx.beginPath();
        ctx.moveTo(hinge.x, hinge.y);
        ctx.arc(hinge.x, hinge.y, half * 2 * this.s, Math.PI / 2, Math.PI / 2 + angle);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 路径
    if (state.path.length >= 2) {
      ctx.strokeStyle = 'rgba(240,239,236,0.42)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      state.path.forEach((p, i) => {
        const s = this.toScreen(p.x, p.z);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.stroke();

      for (const p of state.path) {
        const s = this.toScreen(p.x, p.z);
        ctx.fillStyle = '#141416';
        ctx.strokeStyle = 'rgba(240,239,236,0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 3.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        this.hit.push({ kind: 'pathpoint', point: p, area: [s.x - 8, s.y - 8, 16, 16] });
      }
    }

    // 探针
    const usedMap = new Map();
    for (const c of options.usedList ?? []) usedMap.set(c.probeId, c.fraction);
    for (const probe of state.probes) {
      const pos = probeWorldPos(probe);
      const s = this.toScreen(pos.x, pos.z);
      const on = probe.enabled !== false;
      const frac = usedMap.get(probe.id) ?? 0;
      const selected = options.selectedProbeId === probe.id;
      const r = selected ? 7 : frac > 0.02 ? 6 : 4.6;

      if (frac > 0.02) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 4 + frac * 10, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(240,239,236,${0.12 + frac * 0.5})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = rgbToCss(probe.up, on ? 1 : 0.4);
      ctx.fill();
      ctx.lineWidth = selected ? 2.2 : 1.4;
      ctx.strokeStyle = selected ? '#f0efec' : 'rgba(13,13,13,0.9)';
      ctx.stroke();

      // 朝侧颜色的小弧
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 2.4, 0.35, Math.PI * 0.95);
      ctx.strokeStyle = rgbToCss(probe.sides.s, on ? 0.95 : 0.35);
      ctx.lineWidth = 2;
      ctx.stroke();

      this.hit.push({ kind: 'probe', probeId: probe.id, area: [s.x - 12, s.y - 12, 24, 24] });
    }

    // 物体
    const m = this.toScreen(state.mover.x, state.mover.z);
    const moverLight = sample(state.mover.x, state.mover.z, mode);
    ctx.beginPath();
    ctx.arc(m.x, m.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = rgbToCss(moverLight.colors.up, 1);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#0d0d0d';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(m.x, m.y, 12.5, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(240,239,236,0.75)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    this.hit.push({ kind: 'mover', area: [m.x - 12, m.y - 12, 24, 24] });

    // 坐标标注
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(137,135,129,0.9)';
    ctx.textAlign = 'center';
    const mid = this.toScreen(DIVIDER.x, GRID.originZ - 0.6);
    ctx.fillText('墙 / 门', mid.x, mid.y - 4);
  }

  hitTest(x, y) {
    for (let i = this.hit.length - 1; i >= 0; i -= 1) {
      const h = this.hit[i];
      if (h.kind === 'cell') continue;
      const [ax, ay, aw, ah] = h.area;
      if (x >= ax - 4 && x <= ax + aw + 4 && y >= ay - 4 && y <= ay + ah + 4) return h;
    }
    for (const h of this.hit) {
      if (h.kind !== 'cell') continue;
      const [ax, ay, aw, ah] = h.area;
      if (x >= ax && x <= ax + aw && y >= ay && y <= ay + ah) return h;
    }
    return null;
  }
}
