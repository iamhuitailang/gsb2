// 导航引擎：持有关卡状态，区域边界修改后重算距离场、侵蚀可行走区与连通分量。
// 寻路本身按需调用（computePath），编辑后由 UI 层触发重算并重新寻路。

import { CELL, clearanceField, erode, labelComponents, inBounds } from './geometry.js';
import { findPath } from './pathfinding.js';

export class NavEngine {
  constructor({ width, height, cells, agentRadius = 1, start, goal, annotations = [] } = {}) {
    this.w = width;
    this.h = height;
    this.cells = cells ?? new Uint8Array(width * height);
    this.agentRadius = agentRadius;
    // 起点/终点存储格子下标；缺省放在地图对角的可通行位置
    this.start = start ?? (this.w > 1 ? this.w + 1 : 0);
    this.goal = goal ?? ((this.h - 2) * this.w + (this.w - 2) >= 0
      ? (this.h - 2) * this.w + (this.w - 2) : this.w * this.h - 1);
    this.annotations = annotations;
    this.version = 0; // 每次结构性编辑自增，UI 据此判断脏状态
    this._recompute();
    // 缺省位置若被侵蚀掉，回退到第一个可通行格
    if (!this.passable[this.start]) this.start = this._firstPassable() ?? this.start;
    if (!this.passable[this.goal]) this.goal = this._firstPassable() ?? this.goal;
  }

  get size() {
    return this.w * this.h;
  }

  cellAt(x, y) {
    return inBounds(this.w, this.h, x, y) ? this.cells[y * this.w + x] : CELL.BLOCK;
  }

  /** 涂格子，返回受影响的脏区域（含边界扩展，供距离场/分区高亮） */
  paint(x, y, value, brushRadius = 0) {
    let dirty = null;
    for (let dy = -brushRadius; dy <= brushRadius; dy++) {
      for (let dx = -brushRadius; dx <= brushRadius; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(this.w, this.h, nx, ny)) continue;
        const i = ny * this.w + nx;
        if (this.cells[i] === value) continue;
        this.cells[i] = value;
        if (!dirty) dirty = { x0: nx, y0: ny, x1: nx, y1: ny };
        dirty.x0 = Math.min(dirty.x0, nx);
        dirty.y0 = Math.min(dirty.y0, ny);
        dirty.x1 = Math.max(dirty.x1, nx);
        dirty.y1 = Math.max(dirty.y1, ny);
      }
    }
    if (dirty) {
      // 距离场传播与分区高亮用：扩展 2 格覆盖修改边界
      const pad = 2;
      dirty.x0 = Math.max(0, dirty.x0 - pad);
      dirty.y0 = Math.max(0, dirty.y0 - pad);
      dirty.x1 = Math.min(this.w - 1, dirty.x1 + pad);
      dirty.y1 = Math.min(this.h - 1, dirty.y1 + pad);
      this._recompute(dirty);
    }
    return dirty;
  }

  /** 填矩形（按住拖动时按笔刷连续调用 paint，也可直接用此方法） */
  paintRect(x0, y0, x1, y1, value) {
    let dirty = null;
    const xa = Math.max(0, Math.min(x0, x1));
    const xb = Math.min(this.w - 1, Math.max(x0, x1));
    const ya = Math.max(0, Math.min(y0, y1));
    const yb = Math.min(this.h - 1, Math.max(y0, y1));
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const i = y * this.w + x;
        if (this.cells[i] !== value) {
          this.cells[i] = value;
          dirty = { x0: xa, y0: ya, x1: xb, y1: yb };
        }
      }
    }
    if (dirty) {
      dirty.x0 = Math.max(0, dirty.x0 - 2);
      dirty.y0 = Math.max(0, dirty.y0 - 2);
      dirty.x1 = Math.min(this.w - 1, dirty.x1 + 2);
      dirty.y1 = Math.min(this.h - 1, dirty.y1 + 2);
      this._recompute(dirty);
    }
    return dirty;
  }

  setAgentRadius(radius) {
    this.agentRadius = Math.max(0, radius);
    this._recompute();
  }

  setEndpoint(which, x, y) {
    if (!inBounds(this.w, this.h, x, y)) return false;
    const i = y * this.w + x;
    if (!this.passable[i]) return false;
    this[which] = i;
    return true;
  }

  addAnnotation(x, y, text) {
    const id = this.annotations.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    this.annotations.push({ id, x, y, text });
    return id;
  }

  removeAnnotation(id) {
    const before = this.annotations.length;
    this.annotations = this.annotations.filter((a) => a.id !== id);
    return this.annotations.length !== before;
  }

  _firstPassable() {
    for (let i = 0; i < this.passable.length; i++) {
      if (this.passable[i]) return i;
    }
    return null;
  }

  /**
   * 重算距离场 / 侵蚀 / 连通分量。
   * 注：当前实现整体重算（精确 EDT 两遍扫描是 O(n)，200x200 地图数毫秒），
   * 但保留 dirtyRect 入参并向上抛出，UI 用它做「修改分区」高亮，
   * 保证标注等与区域无关的数据不被清空。
   */
  _recompute(dirtyRect = null) {
    this.clearance = clearanceField(this.cells, this.w, this.h);
    this.passable = erode(this.cells, this.clearance, this.agentRadius, this.w, this.h);
    const comp = labelComponents(this.passable, this.w, this.h);
    this.labels = comp.labels;
    this.componentCount = comp.count;
    this.componentSizes = comp.sizes;
    this.lastDirtyRect = dirtyRect;
    this.version++;
    return dirtyRect;
  }

  componentLabelAt(index) {
    return this.labels[index] || 0;
  }

  /** 从某个可通行格出发的 8 连通可达集合（用于「无法到达的区域」） */
  reachabilityFrom(index) {
    const reach = new Uint8Array(this.w * this.h);
    if (!this.passable[index]) return reach;
    const label = this.labels[index];
    for (let i = 0; i < reach.length; i++) {
      if (this.labels[i] === label) reach[i] = 1;
    }
    return reach;
  }

  computePath(weights, start = this.start, goal = this.goal) {
    return findPath(
      { cells: this.cells, passable: this.passable, clearance: this.clearance, w: this.w, h: this.h },
      start, goal, weights,
    );
  }
}
