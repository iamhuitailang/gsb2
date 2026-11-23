// 右下角小地图：整张关卡缩略图、当前视口框、修改分区高亮、点击/拖拽跳转。
import { CELL } from '../core/geometry.js';

export class Minimap {
  constructor(canvas, app) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.app = app;
    this.dragging = false;
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this._jump(e);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.dragging) this._jump(e);
    });
    canvas.addEventListener('pointerup', () => { this.dragging = false; });
  }

  _jump(e) {
    const rect = this.canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const { engine, camera } = this.app.state;
    const targetX = fx * engine.w * camera.scale - this.app.renderer.viewW / 2;
    const targetY = fy * engine.h * camera.scale - this.app.renderer.viewH / 2;
    camera.x = targetX;
    camera.y = targetY;
    camera.clamp(engine.w, engine.h);
    this.app.scheduleDraw();
  }

  draw() {
    const { ctx, canvas } = this;
    const { engine, camera, dirtyRect } = this.app.state;
    const rect = canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    const sx = W / engine.w;
    const sy = H / engine.h;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(15,20,32,0.92)';
    ctx.fillRect(0, 0, W, H);

    for (let y = 0; y < engine.h; y++) {
      for (let x = 0; x < engine.w; x++) {
        const i = y * engine.w + x;
        const v = engine.cells[i];
        ctx.fillStyle = v === CELL.BLOCK ? '#3a4358'
          : v === CELL.ROAD ? '#2f6b5b'
            : v === CELL.MUD ? '#7a5a28'
              : engine.passable[i] ? '#22304a' : '#5a2a33';
        ctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }

    // 最近修改的分区
    if (dirtyRect && this.app.state.showRegions) {
      ctx.strokeStyle = 'rgba(255,226,122,0.95)';
      ctx.lineWidth = 1;
      ctx.strokeRect(dirtyRect.x0 * sx, dirtyRect.y0 * sy,
        (dirtyRect.x1 - dirtyRect.x0 + 1) * sx,
        (dirtyRect.y1 - dirtyRect.y0 + 1) * sy);
    }

    // 起终点
    const dot = (index, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc((index % engine.w + 0.5) * sx, (((index / engine.w) | 0) + 0.5) * sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    };
    dot(engine.start, '#4cd964');
    dot(engine.goal, '#ffcc00');

    // 当前视口框
    const vx = camera.x / camera.scale;
    const vy = camera.y / camera.scale;
    const vw = this.app.renderer.viewW / camera.scale;
    const vh = this.app.renderer.viewH / camera.scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(vx * sx, vy * sy, vw * sx, vh * sy);
  }
}
