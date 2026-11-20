// 手绘遮罩：独立于散布密度的栅格（默认 1 米一格），笔刷加/减涂抹，双线性采样。
// 遮罩变化只重算受影响的散布格点 —— 由 ScatterLayer 通过 dirty 区域感知。

export class PaintMask {
  /**
   * @param {object} opts
   * @param {number} opts.width 覆盖世界宽（与地形一致）
   * @param {number} opts.depth 覆盖世界深
   * @param {number} [opts.cellSize] 遮罩栅格边长（米）
   * @param {Float32Array} [opts.values] 恢复用数据
   */
  constructor({ width, depth, cellSize = 1, values }) {
    this.width = width;
    this.depth = depth;
    this.cellSize = cellSize;
    this.nx = Math.ceil(width / cellSize) + 1;
    this.nz = Math.ceil(depth / cellSize) + 1;
    this.minX = -width / 2;
    this.minZ = -depth / 2;
    this.values = values && values.length === this.nx * this.nz
      ? values
      : new Float32Array(this.nx * this.nz);
  }

  _indexAt(x, z) {
    const ix = Math.round((x - this.minX) / this.cellSize);
    const iz = Math.round((z - this.minZ) / this.cellSize);
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return -1;
    return iz * this.nx + ix;
  }

  /**
   * 笔刷涂抹。
   * @param {{x:number,z:number}} center 世界坐标
   * @param {number} radius 笔刷半径（米）
   * @param {number} strength 正数加遮罩，负数减遮罩，量级 0..1
   * @returns {{minX:number,maxX:number,minZ:number,maxZ:number}|null} 实际改动的世界包围盒
   */
  paint(center, radius, strength) {
    const rCells = Math.ceil(radius / this.cellSize);
    const cx = Math.round((center.x - this.minX) / this.cellSize);
    const cz = Math.round((center.z - this.minZ) / this.cellSize);
    let touched = false;
    let loX = Infinity, hiX = -Infinity, loZ = Infinity, hiZ = -Infinity;
    for (let iz = cz - rCells; iz <= cz + rCells; iz++) {
      if (iz < 0 || iz >= this.nz) continue;
      for (let ix = cx - rCells; ix <= cx + rCells; ix++) {
        if (ix < 0 || ix >= this.nx) continue;
        const wx = this.minX + ix * this.cellSize;
        const wz = this.minZ + iz * this.cellSize;
        const dist = Math.hypot(wx - center.x, wz - center.z);
        if (dist > radius) continue;
        // 平滑圆形 falloff
        const falloff = 0.5 * (1 + Math.cos(Math.PI * (dist / radius)));
        const idx = iz * this.nx + ix;
        const next = Math.max(0, Math.min(1, this.values[idx] + strength * falloff));
        if (next !== this.values[idx]) {
          this.values[idx] = next;
          touched = true;
          loX = Math.min(loX, wx); hiX = Math.max(hiX, wx);
          loZ = Math.min(loZ, wz); hiZ = Math.max(hiZ, wz);
        }
      }
    }
    if (!touched) return null;
    // 向外扩一格，保证相邻散布格点的双线性采样也被纳入重算
    const pad = this.cellSize;
    return { minX: loX - pad, maxX: hiX + pad, minZ: loZ - pad, maxZ: hiZ + pad };
  }

  /** 双线性采样遮罩强度 0..1，范围外返回 0。 */
  sample(x, z) {
    if (x < this.minX || z < this.minZ || x > -this.minX || z > -this.minZ) return 0;
    const fx = (x - this.minX) / this.cellSize;
    const fz = (z - this.minZ) / this.cellSize;
    const ix = Math.min(this.nx - 2, Math.floor(fx));
    const iz = Math.min(this.nz - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iz;
    const v = this.values;
    const i00 = iz * this.nx + ix;
    const a = v[i00] + (v[i00 + 1] - v[i00]) * tx;
    const b = v[i00 + this.nx] + (v[i00 + this.nx + 1] - v[i00 + this.nx]) * tx;
    return a + (b - a) * tz;
  }

  clear(region) {
    if (!region) {
      this.values.fill(0);
      return;
    }
    const x0 = Math.max(0, Math.floor((region.minX - this.minX) / this.cellSize));
    const x1 = Math.min(this.nx - 1, Math.ceil((region.maxX - this.minX) / this.cellSize));
    const z0 = Math.max(0, Math.floor((region.minZ - this.minZ) / this.cellSize));
    const z1 = Math.min(this.nz - 1, Math.ceil((region.maxZ - this.minZ) / this.cellSize));
    for (let iz = z0; iz <= z1; iz++) this.values.fill(0, iz * this.nx + x0, iz * this.nx + x1 + 1);
  }

  toJSON() {
    return {
      width: this.width,
      depth: this.depth,
      cellSize: this.cellSize,
      nx: this.nx,
      nz: this.nz,
      values: Array.from(this.values),
    };
  }

  static fromJSON(json) {
    return new PaintMask({
      width: json.width,
      depth: json.depth,
      cellSize: json.cellSize,
      values: new Float32Array(json.values),
    });
  }
}

export function createMaskFor(terrain, cellSize = 1) {
  return new PaintMask({ width: terrain.width, depth: terrain.depth, cellSize });
}
