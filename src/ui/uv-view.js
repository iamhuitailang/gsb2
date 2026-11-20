// UV 平面视图：2D Canvas。
// 绘制 [0,1] 纹理方框、棋盘底、UV 三角形（按材质淡色）、切缝红线、选中高亮；
// 支持点击面定位（反向选择模型）、拖拽岛移动、滚轮缩放平移。

import { findIslands, isSeam } from '../core/topology.js';

const ISLAND_PALETTE = [
  '#5b8def', '#58c98f', '#f0a35e', '#d36ba0', '#8a7de1',
  '#4fb6c9', '#c9c45f', '#c97b5f', '#7dc95f', '#9a6bd3',
];

export class UVView {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.faceSet = new Set();
    this.zoom = 1;
    this.pan = [0, 0];
    this.dragIsland = null;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this._loop();
  }

  setMesh(mesh, setIndex) {
    this.mesh = mesh;
    this.setIndex = setIndex;
    this.zoom = 1;
    this.pan = [0, 0];
    this.updateIslands();
    this.draw();
  }

  refresh() {
    this.updateIslands();
    this.draw();
  }

  updateIslands() {
    if (!this.mesh) return;
    const { islands, faceIsland } = findIslands(this.mesh, this.setIndex);
    this.islands = islands;
    this.faceIsland = faceIsland;
  }

  setSelection(faceSet) {
    this.faceSet = faceSet;
    this.draw();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewW = w;
    this.viewH = h;
    this.draw();
  }

  /** UV 坐标 -> 画布坐标（V 向上，画布 y 向下，故翻转）。 */
  toCanvas(u, v) {
    const side = Math.min(this.viewW, this.viewH) - 40;
    const ox = (this.viewW - side) / 2 + this.pan[0];
    const oy = (this.viewH - side) / 2 + this.pan[1];
    return [ox + u * side * this.zoom, oy + (1 - v) * side * this.zoom];
  }

  toUV(x, y) {
    const side = Math.min(this.viewW, this.viewH) - 40;
    const ox = (this.viewW - side) / 2 + this.pan[0];
    const oy = (this.viewH - side) / 2 + this.pan[1];
    const u = (x - ox) / (side * this.zoom);
    const v = 1 - (y - oy) / (side * this.zoom);
    return [u, v];
  }

  draw() {
    if (!this.mesh) return;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewW, this.viewH);
    ctx.fillStyle = '#17191e';
    ctx.fillRect(0, 0, this.viewW, this.viewH);

    const [x0, y0] = this.toCanvas(0, 1);
    const [x1, y1] = this.toCanvas(1, 0);
    const side = x1 - x0;

    // 棋盘格底
    const cells = 8;
    for (let i = 0; i < cells; i++) for (let j = 0; j < cells; j++) {
      ctx.fillStyle = (i + j) % 2 ? '#20242c' : '#242932';
      ctx.fillRect(x0 + (i * side) / cells, y0 + (j * side) / cells,
        side / cells + 1, side / cells + 1);
    }
    ctx.strokeStyle = '#4a5160';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, side, side);

    const uvs = this.mesh.uvSets[this.setIndex];

    // 岛填充（每个岛一个色调，选中岛提亮）
    this.islands.forEach((faces, id) => {
      const selected = faces.some((f) => this.faceSet.has(f));
      ctx.beginPath();
      for (const f of faces) {
        const tri = uvs[f];
        const [ax, ay] = this.toCanvas(tri[0][0], tri[0][1]);
        ctx.moveTo(ax, ay);
        for (let k = 1; k < 3; k++) {
          const [px, py] = this.toCanvas(tri[k][0], tri[k][1]);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      const base = ISLAND_PALETTE[id % ISLAND_PALETTE.length];
      ctx.fillStyle = selected ? 'rgba(78,161,255,0.42)' : base + '55';
      ctx.fill();
    });

    // 三角形边线
    ctx.strokeStyle = 'rgba(220,226,235,0.55)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let f = 0; f < this.mesh.faces.length; f++) {
      const tri = uvs[f];
      const [ax, ay] = this.toCanvas(tri[0][0], tri[0][1]);
      ctx.moveTo(ax, ay);
      for (let k = 1; k < 3; k++) {
        const [px, py] = this.toCanvas(tri[k][0], tri[k][1]);
        ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    ctx.stroke();

    // 切缝（共享边但被标记为缝，或边界）：加粗红线
    ctx.strokeStyle = '#ff6b6b';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const drawn = new Set();
    const { faces, topology, seams } = this.mesh;
    for (const [key, c] of topology.halfedges) {
      const [a, b] = key.split('_').map(Number);
      if (!isSeam(seams, topology, a, b)) continue;
      const uk = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (drawn.has(uk)) continue;
      drawn.add(uk);
      // 取该边上任意一个 corner 的 UV
      const f = Math.floor(c / 3);
      const k = c % 3;
      const p = uvs[f][k];
      const q = uvs[f][(k + 1) % 3];
      const [px, py] = this.toCanvas(p[0], p[1]);
      const [qx, qy] = this.toCanvas(q[0], q[1]);
      ctx.moveTo(px, py);
      ctx.lineTo(qx, qy);
    }
    ctx.stroke();

    // 选中面描边
    if (this.faceSet.size) {
      ctx.strokeStyle = '#4ea1ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const f of this.faceSet) {
        const tri = uvs[f];
        const [ax, ay] = this.toCanvas(tri[0][0], tri[0][1]);
        ctx.moveTo(ax, ay);
        for (let k = 1; k < 3; k++) {
          const [px, py] = this.toCanvas(tri[k][0], tri[k][1]);
          ctx.lineTo(px, py);
        }
        ctx.closePath();
      }
      ctx.stroke();
    }

    // 岛编号
    ctx.font = '11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    this.islands.forEach((faces, id) => {
      let cx = 0, cy = 0, n = 0;
      for (const f of faces) for (const [u, v] of uvs[f]) {
        cx += u; cy += v; n++;
      }
      const [px, py] = this.toCanvas(cx / n, cy / n);
      ctx.fillText(`#${id}`, px - 6, py + 4);
    });
  }

  // ---------- 交互 ----------
  _bind() {
    const el = this.canvas;
    let down = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      down = { x: e.clientX - rect.left, y: e.clientY - rect.top, moved: false, button: e.button };
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (Math.abs(x - down.x) + Math.abs(y - down.y) > 4) down.moved = true;
      if (down.moved && down.button === 0 && this.dragIsland !== null) {
        const side = Math.min(this.viewW, this.viewH) - 40;
        const du = (x - down.x) / (side * this.zoom);
        const dv = -(y - down.y) / (side * this.zoom);
        this.cb.onDragIsland?.(this.dragIsland, du - (down.lastDu ?? 0), dv - (down.lastDv ?? 0));
        down.lastDu = du; down.lastDv = dv;
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      if (!down.moved && down.button === 0) {
        const [u, v] = this.toUV(x, y);
        const face = this._pickFace(u, v);
        this.cb.onPickUV?.(face, e.shiftKey);
      }
      this.dragIsland = null;
      down = null;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(8, Math.max(0.3, this.zoom * (1 - Math.sign(e.deltaY) * 0.1)));
      this.draw();
    }, { passive: false });

    // 按下时记录命中的岛，供拖拽使用
    el.addEventListener('pointerdown', (e) => {
      const rect = el.getBoundingClientRect();
      const [u, v] = this.toUV(e.clientX - rect.left, e.clientY - rect.top);
      const face = this._pickFace(u, v);
      this.dragIsland = face === null ? null : this.faceIsland[face];
    });
  }

  /** 在 UV 空间找包含 (u,v) 的三角形（优先选中面，便于选中小岛）。 */
  _pickFace(u, v) {
    if (!this.mesh) return null;
    const uvs = this.mesh.uvSets[this.setIndex];
    let fallback = null;
    for (let f = 0; f < this.mesh.faces.length; f++) {
      if (this.pointInTri(u, v, uvs[f])) {
        if (this.faceSet.has(f)) return f;
        if (fallback === null) fallback = f;
      }
    }
    return fallback;
  }

  pointInTri(px, py, tri) {
    const [[ax, ay], [bx, by], [cx, cy]] = tri;
    const d1 = this._sign(px, py, ax, ay, bx, by);
    const d2 = this._sign(px, py, bx, by, cx, cy);
    const d3 = this._sign(px, py, cx, cy, ax, ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }
  _sign(px, py, ax, ay, bx, by) {
    return (px - bx) * (ay - by) - (ax - bx) * (py - by);
  }

  _loop() {
    requestAnimationFrame(() => this._loop());
    this.draw();
  }
}
