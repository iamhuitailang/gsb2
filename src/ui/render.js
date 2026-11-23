// Canvas 渲染器：所有图层按同一相机（平移/缩放）绘制，
// 仅遍历视口内格子，大地图下保持流畅。
import { CELL } from '../core/geometry.js';

export const COLORS = {
  bg: '#0f1420',
  grid: 'rgba(255,255,255,0.07)',
  block: '#2b3245',
  blockEdge: '#11151f',
  walk: '#1c2536',
  road: '#24403a',
  mud: '#43351f',
  eroded: 'rgba(255, 89, 89, 0.28)',       // 被角色半径侵蚀掉的格子
  unreachable: 'rgba(255, 170, 60, 0.30)',  // 起点所在分量之外的可通行格
  unreachableHatch: 'rgba(255, 170, 60, 0.55)',
  explored: 'rgba(94, 168, 255, 0.14)',     // A* 搜索过的格子
  openSet: 'rgba(94, 168, 255, 0.30)',
  region: 'rgba(255, 226, 122, 0.10)',
  regionEdge: 'rgba(255, 226, 122, 0.65)',
  pathA: '#ff5d8f',
  pathB: '#37d9c0',
  start: '#4cd964',
  goal: '#ffcc00',
  annotation: '#c8d3f5',
  annotationBg: 'rgba(20, 26, 42, 0.88)',
};

export class Camera {
  constructor() {
    this.x = 0; // 世界坐标（格距）下的视口左上角
    this.y = 0;
    this.scale = 24; // 每格像素
  }

  // 屏幕像素 → 世界格坐标
  screenToCell(px, py) {
    return {
      x: Math.floor((px + this.x) / this.scale),
      y: Math.floor((py + this.y) / this.scale),
    };
  }

  worldToScreen(wx, wy) {
    return { x: wx * this.scale - this.x, y: wy * this.scale - this.y };
  }

  pan(dxPx, dyPx) {
    this.x += dxPx;
    this.y += dyPx;
    this.x = Math.max(0, this.x);
    this.y = Math.max(0, this.y);
  }

  zoom(factor, cx, cy, w, h) {
    const before = this.screenToCell(cx, cy);
    this.scale = Math.min(64, Math.max(6, this.scale * factor));
    // 以鼠标位置为锚点缩放
    this.x = before.x * this.scale + this.scale / 2 - cx;
    this.y = before.y * this.scale + this.scale / 2 - cy;
    this.clamp(w, h);
  }

  clamp(mapW, mapH) {
    const viewW = this.viewW;
    const viewH = this.viewH;
    const maxX = Math.max(0, mapW * this.scale - viewW);
    const maxY = Math.max(0, mapH * this.scale - viewH);
    this.x = Math.min(maxX, Math.max(0, this.x));
    this.y = Math.min(maxY, Math.max(0, this.y));
  }

  centerOn(cellX, cellY, viewW, viewH, mapW, mapH) {
    this.scale = Math.max(this.scale, 18);
    this.x = cellX * this.scale - viewW / 2;
    this.y = cellY * this.scale - viewH / 2;
    this.clamp(mapW, mapH);
  }
}

function cellColor(v) {
  switch (v) {
    case CELL.BLOCK: return COLORS.block;
    case CELL.ROAD: return COLORS.road;
    case CELL.MUD: return COLORS.mud;
    default: return COLORS.walk;
  }
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = rect.width;
    this.viewH = rect.height;
  }

  draw(state) {
    const { ctx } = this;
    const cam = state.camera;
    cam.viewW = this.viewW;
    cam.viewH = this.viewH;
    cam.clamp(state.engine.w, state.engine.h);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const s = cam.scale;
    const x0 = Math.max(0, Math.floor(cam.x / s));
    const y0 = Math.max(0, Math.floor(cam.y / s));
    const x1 = Math.min(state.engine.w - 1, Math.ceil((cam.x + this.viewW) / s));
    const y1 = Math.min(state.engine.h - 1, Math.ceil((cam.y + this.viewH) / s));

    this._drawCells(state, x0, y0, x1, y1);
    this._drawOverlays(state, x0, y0, x1, y1);
    this._drawDirtyRegion(state);
    this._drawGrid(x0, y0, x1, y1, cam);
    this._drawExplored(state, x0, y0, x1, y1);
    this._drawClearance(state, x0, y0, x1, y1);
    this._drawPaths(state);
    this._drawEndpoints(state);
    this._drawAnnotations(state);
    this._drawHover(state);
  }

  _drawCells(state, x0, y0, x1, y1) {
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const { cells, passable } = state.engine;
    const w = state.engine.w;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const sx = x * s - cam.x;
        const sy = y * s - cam.y;
        ctx.fillStyle = cellColor(cells[i]);
        ctx.fillRect(sx, sy, s + 0.5, s + 0.5);
        if (cells[i] !== CELL.BLOCK && !passable[i]) {
          ctx.fillStyle = COLORS.eroded;
          ctx.fillRect(sx, sy, s + 0.5, s + 0.5);
        }
      }
    }
  }

  _drawOverlays(state, x0, y0, x1, y1) {
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const w = state.engine.w;
    if (state.showUnreachable && state.reach) {
      ctx.fillStyle = COLORS.unreachable;
      const hatchCells = [];
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (state.engine.passable[i] && !state.reach[i]) {
            ctx.fillRect(x * s - cam.x, y * s - cam.y, s + 0.5, s + 0.5);
            hatchCells.push([x, y]);
          }
        }
      }
      // 对角线斜纹，让「不可达」在任意底色上都能被辨认
      if (s >= 8) {
        ctx.strokeStyle = COLORS.unreachableHatch;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const [x, y] of hatchCells) {
          const sx = x * s - cam.x;
          const sy = y * s - cam.y;
          ctx.moveTo(sx + 2, sy + s - 2);
          ctx.lineTo(sx + s - 2, sy + 2);
        }
        ctx.stroke();
      }
    }
  }

  _drawExplored(state, x0, y0, x1, y1) {
    if (!state.showExplored || !state.primaryResult) return;
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const w = state.engine.w;
    const closed = state.primaryResult.closed;
    ctx.fillStyle = COLORS.explored;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (closed[i]) ctx.fillRect(x * s - cam.x, y * s - cam.y, s + 0.5, s + 0.5);
      }
    }
  }

  _drawGrid(x0, y0, x1, y1, cam) {
    const { ctx } = this;
    const s = cam.scale;
    ctx.strokeStyle = s >= 14 ? COLORS.grid : COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x <= x1 + 1; x++) {
      const sx = x * s - cam.x;
      ctx.moveTo(sx, Math.max(0, y0 * s - cam.y));
      ctx.lineTo(sx, Math.min(this.viewH, (y1 + 1) * s - cam.y));
    }
    for (let y = y0; y <= y1 + 1; y++) {
      const sy = y * s - cam.y;
      ctx.moveTo(Math.max(0, x0 * s - cam.x), sy);
      ctx.lineTo(Math.min(this.viewW, (x1 + 1) * s - cam.x), sy);
    }
    ctx.stroke();
  }

  _drawClearance(state, x0, y0, x1, y1) {
    if (!state.showClearance || state.camera.scale < 18) return;
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const w = state.engine.w;
    ctx.font = `${Math.round(s * 0.3)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (state.engine.cells[i] === CELL.BLOCK) continue;
        ctx.fillStyle = state.engine.passable[i] ? 'rgba(255,255,255,0.75)' : 'rgba(255,120,120,0.9)';
        ctx.fillText(state.engine.clearance[i].toFixed(1),
          (x + 0.5) * s - cam.x, (y + 0.82) * s - cam.y);
      }
    }
  }

  _drawDirtyRegion(state) {
    const rect = state.dirtyRect;
    if (!rect || !state.showRegions) return;
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    ctx.fillStyle = COLORS.region;
    ctx.fillRect(rect.x0 * s - cam.x, rect.y0 * s - cam.y,
      (rect.x1 - rect.x0 + 1) * s, (rect.y1 - rect.y0 + 1) * s);
    ctx.strokeStyle = COLORS.regionEdge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rect.x0 * s - cam.x, rect.y0 * s - cam.y,
      (rect.x1 - rect.x0 + 1) * s, (rect.y1 - rect.y0 + 1) * s);
  }

  _drawPathLine(result, cam, color, width) {
    if (!result || !result.found || result.path.length < 2) return;
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    result.path.forEach((i, k) => {
      const x = i % cam._w;
      const y = (i / cam._w) | 0;
      const sx = (x + 0.5) * cam.scale - cam.x;
      const sy = (y + 0.5) * cam.scale - cam.y;
      if (k === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    });
    ctx.stroke();
  }

  _drawPaths(state) {
    const cam = state.camera;
    cam._w = state.engine.w;
    // 对比路径 B 先画（细线），主路径 A 在上
    if (state.compareResult) {
      this._drawPathLine(state.compareResult, cam, COLORS.pathB, 3);
    }
    this._drawPathLine(state.primaryResult, cam, COLORS.pathA, 4);
  }

  _drawEndpoints(state) {
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const dot = (index, color, label) => {
      const x = index % state.engine.w;
      const y = (index / state.engine.w) | 0;
      const cx = (x + 0.5) * s - cam.x;
      const cy = (y + 0.5) * s - cam.y;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(5, s * 0.28), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke();
      if (s >= 16) {
        ctx.fillStyle = '#0b0f1a';
        ctx.font = `bold ${Math.round(s * 0.36)}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy + 0.5);
      }
    };
    dot(state.engine.start, COLORS.start, 'S');
    dot(state.engine.goal, COLORS.goal, 'G');
  }

  _drawAnnotations(state) {
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    if (s < 10) return;
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const a of state.engine.annotations) {
      const sx = (a.x + 0.5) * s - cam.x;
      const sy = (a.y + 0.5) * s - cam.y;
      if (sx < -120 || sy < -30 || sx > this.viewW + 120 || sy > this.viewH + 30) continue;
      // 定位小三角
      ctx.fillStyle = COLORS.annotation;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx - 6, sy - 10);
      ctx.lineTo(sx + 6, sy - 10);
      ctx.closePath();
      ctx.fill();
      const text = `#${a.id} ${a.text}`;
      const tw = ctx.measureText(text).width;
      const bx = sx + 8;
      const by = sy - 22;
      ctx.fillStyle = COLORS.annotationBg;
      ctx.strokeStyle = 'rgba(200,211,245,0.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by - 9, tw + 12, 18, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = COLORS.annotation;
      ctx.fillText(text, bx + 6, by);
    }
  }

  _drawHover(state) {
    if (!state.hover) return;
    const { ctx } = this;
    const cam = state.camera;
    const s = cam.scale;
    const { x, y } = state.hover;
    if (x < 0 || y < 0 || x >= state.engine.w || y >= state.engine.h) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x * s - cam.x + 0.5, y * s - cam.y + 0.5, s - 1, s - 1);
  }
}
