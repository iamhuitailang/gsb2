// 散布引擎核心。
//
// 设计要点：
// 1. 全局候选格网：候选点位置由 (seed, 格坐标) 确定性派生，与分块边界、计算顺序无关，
//    因此跨块边界的密度与随机分布天然连续。
// 2. 笔刷只改写每格状态（未触碰/已绘制/已擦除）与替换覆盖，不直接存“刷出来的实例”；
//    实例由纯函数评估得到 —— 同一格点在任何时刻、任何分块里重算结果都相同。
//    重复涂抹同一位置是幂等操作，不会在相邻帧重复堆放。
// 3. 分块惰性重建：规则/遮罩/笔刷变化只把受影响 chunk 标脏，每帧只重建这些块；
//    重建时向外扩 maxSpacing 的 padding 并按全局格序评估，保证跨块间距与全量计算一致。

import { CHUNK_SIZE, MIN_CELL_SIZE, TOOL } from './constants.js';
import { randomFor, lerpRange, hashInts } from './rng.js';
import { ruleAcceptsEnvironment, pickWeightedRule } from './rules.js';

const CELL_STATE = { UNTOUCHED: 0, PAINTED: 1, ERASED: 2 };

// 派生随机量用的盐值，避免不同用途的随机序列撞车
const SALT = { JITTER_X: 11, JITTER_Z: 12, ACCEPT: 21, TIE: 22, ROT: 31, SCALE: 32, TILT: 33 };

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

export class ScatterLayer {
  /**
   * @param {object} opts
   * @param {import('./terrain.js').Terrain} opts.terrain
   * @param {import('./mask.js').PaintMask} opts.mask
   * @param {Array} opts.rules 规则数组（顺序即优先级）
   * @param {number} opts.seed 固定种子
   * @param {number} [opts.cellSize] 候选格边长；不传则按最大密度自动计算
   */
  constructor({ terrain, mask, rules, seed, cellSize }) {
    this.terrain = terrain;
    this.mask = mask;
    this.rules = rules;
    this.seed = seed >>> 0;

    this.cellSize = Math.max(MIN_CELL_SIZE, cellSize ?? this._cellSizeForRules(rules));
    this.cellArea = this.cellSize * this.cellSize;

    this.minX = terrain.minX;
    this.minZ = terrain.minZ;
    this.nx = Math.ceil(terrain.width / this.cellSize);
    this.nz = Math.ceil(terrain.depth / this.cellSize);

    this.cellState = new Uint8Array(this.nx * this.nz);
    /** @type {Map<number, string>} 替换工具写入的强制规则：格序号 -> ruleId */
    this.forcedRules = new Map();

    // chunk 缓存：key -> {instances: Array, signature: string}
    this.chunks = new Map();
    this.dirtyChunks = new Set();
    // 每个 chunk 内 PAINTED 格计数，为 0 的块无需构建/渲染
    this.chunkPaintedCount = new Map();

    // 规则/种子变化时递增；快照版本不匹配的块视为脏块
    this.paramsSignature = this._computeParamsSignature();
    this.maxSpacing = this._computeMaxSpacing();
  }

  // ---------- 基础换算 ----------

  cellIndex(ix, iz) {
    return iz * this.nx + ix;
  }

  cellWorld(ix, iz) {
    return { x: this.minX + ix * this.cellSize, z: this.minZ + iz * this.cellSize };
  }

  worldToCell(x, z) {
    // 加 epsilon 防止边界点因浮点误差落到 -1（floor(-1e-16) === -1）
    return {
      ix: Math.floor((x - this.minX) / this.cellSize + 1e-9),
      iz: Math.floor((z - this.minZ) / this.cellSize + 1e-9),
    };
  }

  worldToChunk(x, z) {
    return {
      cx: Math.floor(x / CHUNK_SIZE + 1e-9),
      cz: Math.floor(z / CHUNK_SIZE + 1e-9),
    };
  }

  _computeMaxSpacing() {
    return Math.max(0.1, ...this.rules.map((r) => r.spacing));
  }

  _computeParamsSignature() {
    // 规则内容 + 种子的指纹；遮罩单独走 region dirty，不进签名
    return hashInts(
      this.seed,
      hashString(JSON.stringify(this.rules)),
      Math.round(this.cellSize * 1000),
    );
  }

  // ---------- 笔刷区域 → 格范围 ----------

  _cellsInCircle(center, radius) {
    const c = this.worldToCell(center.x, center.z);
    const rCells = Math.ceil(radius / this.cellSize);
    const ix0 = Math.max(0, c.ix - rCells);
    const ix1 = Math.min(this.nx - 1, c.ix + rCells);
    const iz0 = Math.max(0, c.iz - rCells);
    const iz1 = Math.min(this.nz - 1, c.iz + rCells);
    const r2 = radius * radius;
    const result = [];
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const w = this.cellWorld(ix, iz);
        const dx = w.x + this.cellSize / 2 - center.x;
        const dz = w.z + this.cellSize / 2 - center.z;
        if (dx * dx + dz * dz <= r2) result.push([ix, iz]);
      }
    }
    return result;
  }

  _chunksInRegion(region) {
    const a = this.worldToChunk(region.minX, region.minZ);
    const b = this.worldToChunk(region.maxX, region.maxZ);
    const keys = [];
    for (let cz = a.cz; cz <= b.cz; cz++) {
      for (let cx = a.cx; cx <= b.cx; cx++) keys.push(chunkKey(cx, cz));
    }
    return keys;
  }

  _setCellState(ix, iz, state) {
    const idx = this.cellIndex(ix, iz);
    const prev = this.cellState[idx];
    if (prev === state) return;
    const w = this.cellWorld(ix, iz);
    const { cx, cz } = this.worldToChunk(w.x + this.cellSize / 2, w.z + this.cellSize / 2);
    const key = chunkKey(cx, cz);
    const count = this.chunkPaintedCount.get(key) ?? 0;
    if (prev === CELL_STATE.PAINTED) this.chunkPaintedCount.set(key, count - 1);
    else if (state === CELL_STATE.PAINTED) this.chunkPaintedCount.set(key, count + 1);
    this.cellState[idx] = state;
    this.dirtyChunks.add(key);
  }

  /**
   * 应用一次笔刷操作。相邻帧重复刷同一区域是幂等的：
   * 格状态只有三个离散值，实例由确定性评估生成，不会叠加第二份。
   * @param {string} tool TOOL.*
   * @param {{x:number,z:number}} center
   * @param {number} radius
   * @param {string} [replaceRuleId] replace 工具的目标规则
   */
  applyBrush(tool, center, radius, replaceRuleId) {
    const cells = this._cellsInCircle(center, radius);
    let region = null;
    const pendingReplace = new Set();
    const grow = (x, z) => {
      if (!region) region = { minX: x, maxX: x, minZ: z, maxZ: z };
      else {
        region.minX = Math.min(region.minX, x);
        region.maxX = Math.max(region.maxX, x);
        region.minZ = Math.min(region.minZ, z);
        region.maxZ = Math.max(region.maxZ, z);
      }
    };

    for (const [ix, iz] of cells) {
      const idx = this.cellIndex(ix, iz);
      const w = this.cellWorld(ix, iz);
      if (tool === TOOL.PAINT) {
        this._setCellState(ix, iz, CELL_STATE.PAINTED);
        this.forcedRules.delete(idx);
        grow(w.x, w.z);
      } else if (tool === TOOL.ERASE) {
        this._setCellState(ix, iz, CELL_STATE.ERASED);
        this.forcedRules.delete(idx);
        grow(w.x, w.z);
      } else if (tool === TOOL.REPLACE) {
        // 只替换当前真正产出实例的格：先记录待替换格，重建后再按实际实例落 forced，
        // 避免给原本被环境/间距过滤掉的空格凭空补上实例
        if (this.cellState[idx] === CELL_STATE.PAINTED && replaceRuleId) {
          pendingReplace.add(idx);
          grow(w.x, w.z);
        }
      }
    }

    if (tool === TOOL.REPLACE && pendingReplace.size > 0) {
      this.flushDirty();
      const liveCells = new Set();
      for (const chunk of this.chunks.values()) {
        for (const inst of chunk.instances) {
          if (pendingReplace.has(inst.cellIndex)) liveCells.add(inst.cellIndex);
        }
      }
      for (const idx of liveCells) this.forcedRules.set(idx, replaceRuleId);
      for (const idx of pendingReplace) {
        if (!liveCells.has(idx)) continue;
        const w = this.cellWorld(idx % this.nx, Math.floor(idx / this.nx));
        const { cx, cz } = this.worldToChunk(w.x + this.cellSize / 2, w.z + this.cellSize / 2);
        this.dirtyChunks.add(chunkKey(cx, cz));
      }
    }
    return region;
  }

  /** 遮罩变化后调用：把与改动区域相交、且含已绘制格的块标脏。 */
  markRegionDirty(region) {
    if (!region) return;
    for (const key of this._chunksInRegion(region)) {
      if ((this.chunkPaintedCount.get(key) ?? 0) > 0 || this.chunks.has(key)) {
        this.dirtyChunks.add(key);
      }
    }
  }

  /** 按当前规则的最大密度计算候选格边长，使最高密度规则的命中概率落在舒适区间。 */
  _cellSizeForRules(rules) {
    const maxDensity = Math.max(0.0001, ...rules.map((r) => r.density));
    return Math.max(MIN_CELL_SIZE, Math.min(2, 1 / Math.sqrt(maxDensity)));
  }

  /**
   * 规则变化后调用：密度变化会改变候选格网尺寸，因此按世界位置迁移笔刷状态，
   * 再把所有已构建块标脏。迁移保证刷过的区域不丢、未刷区域不凭空出现实例。
   */
  invalidateRules(rules) {
    const newCellSize = this._cellSizeForRules(rules);
    this.rules = rules;
    this.maxSpacing = this._computeMaxSpacing();

    if (Math.abs(newCellSize - this.cellSize) > 1e-9) {
      this._rebuildGrid(newCellSize);
    }
    this.paramsSignature = this._computeParamsSignature();
    for (const key of this.chunks.keys()) this.dirtyChunks.add(key);
  }

  /** 按新格边长重建候选格网，旧格网的状态按格中心的世界位置迁移。 */
  _rebuildGrid(newCellSize) {
    const old = {
      cellSize: this.cellSize,
      nx: this.nx,
      nz: this.nz,
      cellState: this.cellState,
      forcedRules: this.forcedRules,
    };
    this.cellSize = newCellSize;
    this.cellArea = newCellSize * newCellSize;
    this.nx = Math.ceil(this.terrain.width / newCellSize);
    this.nz = Math.ceil(this.terrain.depth / newCellSize);
    this.cellState = new Uint8Array(this.nx * this.nz);
    this.forcedRules = new Map();
    this.chunkPaintedCount.clear();
    this.chunks.clear();
    this.dirtyChunks.clear();

    for (let oz = 0; oz < old.nz; oz++) {
      for (let ox = 0; ox < old.nx; ox++) {
        const oldIdx = oz * old.nx + ox;
        const state = old.cellState[oldIdx];
        if (state === CELL_STATE.UNTOUCHED) continue;
        // 旧格中心 → 新格索引
        const wx = this.minX + (ox + 0.5) * old.cellSize;
        const wz = this.minZ + (oz + 0.5) * old.cellSize;
        const { ix, iz } = this.worldToCell(wx, wz);
        if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) continue;
        const newIdx = this.cellIndex(ix, iz);
        // 多个旧格可能落入同一新格：擦除优先，绘制其次，避免凭空复活
        if (this.cellState[newIdx] === CELL_STATE.ERASED) continue;
        this.cellState[newIdx] = state;
        if (old.forcedRules.has(oldIdx)) {
          this.forcedRules.set(newIdx, old.forcedRules.get(oldIdx));
        }
      }
    }

    // 统一重算每块的已绘制格计数与脏块集合，避免多对一映射导致重复计数
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        if (this.cellState[this.cellIndex(ix, iz)] !== CELL_STATE.PAINTED) continue;
        const w = this.cellWorld(ix, iz);
        const { cx, cz } = this.worldToChunk(w.x + this.cellSize / 2, w.z + this.cellSize / 2);
        const key = chunkKey(cx, cz);
        this.chunkPaintedCount.set(key, (this.chunkPaintedCount.get(key) ?? 0) + 1);
        this.dirtyChunks.add(key);
      }
    }
  }

  setSeed(seed) {
    this.seed = seed >>> 0;
    this.paramsSignature = this._computeParamsSignature();
    // 所有含已绘制格的块都要重算（含仅存在于快照、尚未构建的块）
    for (const key of this.chunkPaintedCount.keys()) {
      if ((this.chunkPaintedCount.get(key) ?? 0) > 0) this.dirtyChunks.add(key);
    }
  }

  // ---------- 确定性格点评估 ----------

  _evaluateCell(ix, iz, spatial) {
    const idx = this.cellIndex(ix, iz);
    if (this.cellState[idx] !== CELL_STATE.PAINTED) return null;

    const origin = this.cellWorld(ix, iz);
    // 候选点在格内做确定性抖动，规则抖动范围 [0.15, 0.85]
    const jx = 0.15 + 0.7 * randomFor(this.seed, ix, iz, SALT.JITTER_X);
    const jz = 0.15 + 0.7 * randomFor(this.seed, ix, iz, SALT.JITTER_Z);
    const x = origin.x + jx * this.cellSize;
    const z = origin.z + jz * this.cellSize;

    const y = this.terrain.heightAt(x, z);
    if (Number.isNaN(y)) return null;
    const normal = this.terrain.normalAt(x, z);
    const slope = (Math.acos(Math.min(1, Math.abs(normal.y))) * 180) / Math.PI;
    const maskValue = this.mask.sample(x, z);
    const env = { height: y, slope, mask: maskValue };

    let rule = null;
    let isForced = false;
    const forcedId = this.forcedRules.get(idx);
    if (forcedId) {
      rule = this.rules.find((r) => r.id === forcedId) ?? null;
      if (rule && !ruleAcceptsEnvironment(rule, env)) rule = null;
      isForced = rule !== null;
    }

    if (!rule) {
      // 每条规则独立按目标密度投伯努利票，可多条同时命中时按权重决胜
      const accepted = [];
      for (const r of this.rules) {
        if (!ruleAcceptsEnvironment(r, env)) continue;
        const p = Math.min(0.95, r.density * this.cellArea);
        const roll = randomFor(this.seed, ix, iz, hashString(r.id), SALT.ACCEPT);
        if (roll < p) accepted.push(r);
      }
      if (accepted.length === 1) rule = accepted[0];
      else if (accepted.length > 1) {
        rule = pickWeightedRule(accepted, randomFor(this.seed, ix, iz, SALT.TIE));
      }
      if (!rule) return null;
    }

    const ruleHash = hashString(rule.id);
    const rotDeg = lerpRange(
      randomFor(this.seed, ix, iz, ruleHash, SALT.ROT),
      rule.rotation.min, rule.rotation.max,
    );
    const scale = lerpRange(
      randomFor(this.seed, ix, iz, ruleHash, SALT.SCALE),
      rule.scale.min, rule.scale.max,
    );
    const tilt = lerpRange(
      randomFor(this.seed, ix, iz, ruleHash, SALT.TILT),
      0, rule.tiltMax,
    );

    const instance = {
      cellIndex: idx,
      ruleId: rule.id,
      x, y, z,
      rotationY: (rotDeg * Math.PI) / 180,
      scale,
      tiltDeg: tilt,
      normal,
    };

    // 替换工具保留原候选点位置，不再做间距判定（否则换个大 spacing 的模型会丢点）；
    // 但仍登记到空间哈希，让后续新点与它保持间距。
    if (!isForced && !spatial.canPlace(x, z, rule.spacing)) return null;
    spatial.insert(x, z);
    return instance;
  }

  // ---------- 分块构建 ----------

  _chunkCellRange(cx, cz) {
    // 格归属严格按其原点落在哪个 chunk 世界区间，边界格只属于一个块，
    // 避免相邻 chunk 重复产出同一格的实例。
    const ix0 = Math.max(0, Math.ceil((cx * CHUNK_SIZE - this.minX) / this.cellSize - 1e-9));
    const iz0 = Math.max(0, Math.ceil((cz * CHUNK_SIZE - this.minZ) / this.cellSize - 1e-9));
    const ix1 = Math.min(
      this.nx - 1,
      Math.ceil(((cx + 1) * CHUNK_SIZE - this.minX) / this.cellSize - 1e-9) - 1,
    );
    const iz1 = Math.min(
      this.nz - 1,
      Math.ceil(((cz + 1) * CHUNK_SIZE - this.minZ) / this.cellSize - 1e-9) - 1,
    );
    return { ix0, ix1, iz0, iz1 };
  }

  /**
   * 重建一个 chunk。padding 内的邻居格只参与间距计算，
   * 产出的实例严格限定在本块范围内 —— 与全量按全局格序评估结果完全一致。
   */
  rebuildChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if ((this.chunkPaintedCount.get(key) ?? 0) === 0) {
      if (this.chunks.has(key)) this.chunks.delete(key);
      this.dirtyChunks.delete(key);
      return { key, instances: [], removed: true };
    }

    const range = this._chunkCellRange(cx, cz);
    const padCells = Math.ceil(this.maxSpacing / this.cellSize) + 1;
    const spatial = new SpatialHash(this.maxSpacing);
    const instances = [];

    const izStart = Math.max(0, range.iz0 - padCells);
    const izEnd = Math.min(this.nz - 1, range.iz1 + padCells);
    const ixStart = Math.max(0, range.ix0 - padCells);
    const ixEnd = Math.min(this.nx - 1, range.ix1 + padCells);

    for (let iz = izStart; iz <= izEnd; iz++) {
      for (let ix = ixStart; ix <= ixEnd; ix++) {
        const inst = this._evaluateCell(ix, iz, spatial);
        if (inst && ix >= range.ix0 && ix <= range.ix1 && iz >= range.iz0 && iz <= range.iz1) {
          instances.push(inst);
        }
      }
    }

    this.chunks.set(key, { instances, signature: this.paramsSignature, cx, cz });
    this.dirtyChunks.delete(key);
    return { key, instances, removed: false };
  }

  /** 每帧调用：重建所有脏块，返回变更清单供渲染层增量更新。 */
  flushDirty(maxChunks = Infinity) {
    const changes = [];
    let budget = maxChunks;
    for (const key of Array.from(this.dirtyChunks)) {
      if (budget-- <= 0) break;
      const [cx, cz] = key.split(',').map(Number);
      changes.push(this.rebuildChunk(cx, cz));
    }
    return changes;
  }

  /** 导出/统计前确保所有含绘制格的块都已构建。 */
  ensureAllBuilt() {
    for (const key of this.chunkPaintedCount.keys()) {
      if ((this.chunkPaintedCount.get(key) ?? 0) > 0 && !this.chunks.has(key)) {
        const [cx, cz] = key.split(',').map(Number);
        this.rebuildChunk(cx, cz);
      }
    }
  }

  getAllInstances() {
    this.ensureAllBuilt();
    const all = [];
    for (const chunk of this.chunks.values()) all.push(...chunk.instances);
    return all;
  }

  getStats() {
    const perRule = new Map();
    let total = 0;
    for (const chunk of this.chunks.values()) {
      for (const inst of chunk.instances) {
        perRule.set(inst.ruleId, (perRule.get(inst.ruleId) ?? 0) + 1);
        total++;
      }
    }
    return { total, perRule };
  }

  // ---------- 序列化 ----------

  toJSON() {
    this.ensureAllBuilt();
    const instances = [];
    for (const chunk of this.chunks.values()) {
      for (const inst of chunk.instances) instances.push(inst);
    }
    return {
      seed: this.seed,
      cellSize: this.cellSize,
      nx: this.nx,
      nz: this.nz,
      cellState: Array.from(this.cellState),
      forcedRules: Array.from(this.forcedRules.entries()),
      paramsSignature: this.paramsSignature,
      instances,
    };
  }

  /**
   * 恢复格网状态。实例快照会先原样还原（保证位置逐字节一致），
   * 与当前规则指纹不匹配的块再标脏重算。
   */
  loadState(json, rules) {
    this.rules = rules;
    this.seed = json.seed >>> 0;
    this.cellSize = json.cellSize;
    this.cellArea = this.cellSize * this.cellSize;
    this.nx = json.nx;
    this.nz = json.nz;
    this.cellState = new Uint8Array(json.cellState);
    this.forcedRules = new Map(json.forcedRules.map(([k, v]) => [Number(k), v]));
    this.maxSpacing = this._computeMaxSpacing();
    this.paramsSignature = this._computeParamsSignature();

    this.chunks.clear();
    this.dirtyChunks.clear();
    this.chunkPaintedCount.clear();
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) {
        if (this.cellState[this.cellIndex(ix, iz)] !== CELL_STATE.PAINTED) continue;
        // 用格中心坐标定位 chunk，与笔刷和重建路径的归属判定保持一致
        const w = this.cellWorld(ix, iz);
        const { cx, cz } = this.worldToChunk(
          w.x + this.cellSize / 2,
          w.z + this.cellSize / 2,
        );
        const key = chunkKey(cx, cz);
        this.chunkPaintedCount.set(key, (this.chunkPaintedCount.get(key) ?? 0) + 1);
      }
    }

    // 快照按块分组还原：签名一致则原样保留（实例位置逐字节恢复），
    // 只有规则/种子已变化导致指纹不匹配的块才标脏重算
    const byChunk = new Map();
    for (const inst of json.instances ?? []) {
      const { cx, cz } = this.worldToChunk(inst.x, inst.z);
      const key = chunkKey(cx, cz);
      if (!byChunk.has(key)) byChunk.set(key, []);
      byChunk.get(key).push(inst);
    }
    for (const [key, list] of byChunk) {
      const [cx, cz] = key.split(',').map(Number);
      const stale = json.paramsSignature !== undefined && json.paramsSignature !== this.paramsSignature;
      this.chunks.set(key, { instances: list, signature: this.paramsSignature, cx, cz });
      if (stale) this.dirtyChunks.add(key);
    }
  }
}

/** 均匀空间哈希：spacingGrid 取最大间距，查 3x3 邻桶即可覆盖任意规则间距。 */
class SpatialHash {
  constructor(maxSpacing) {
    this.grid = maxSpacing;
    this.map = new Map();
  }

  _key(cx, cz) {
    return `${cx},${cz}`;
  }

  insert(x, z) {
    const cx = Math.floor(x / this.grid);
    const cz = Math.floor(z / this.grid);
    const key = this._key(cx, cz);
    let bucket = this.map.get(key);
    if (!bucket) {
      bucket = [];
      this.map.set(key, bucket);
    }
    bucket.push(x, z);
  }

  canPlace(x, z, spacing) {
    const cx = Math.floor(x / this.grid);
    const cz = Math.floor(z / this.grid);
    const s2 = spacing * spacing;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = this.map.get(this._key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 2) {
          const ddx = bucket[i] - x;
          const ddz = bucket[i + 1] - z;
          if (ddx * ddx + ddz * ddz < s2) return false;
        }
      }
    }
    return true;
  }
}
