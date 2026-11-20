// 地形：高度场 + 双线性采样 + 法线/坡度。
// 地形既可由程序噪声生成，也可从项目文件恢复，散布算法只依赖 heightAt/normalAt 两个查询。

import { mulberry32, hashInts } from './rng.js';

export class Terrain {
  /**
   * @param {object} opts
   * @param {number} opts.width 世界尺寸 X（米）
   * @param {number} opts.depth 世界尺寸 Z（米）
   * @param {number} opts.resolution 每边顶点数（含边界，通常为 2^n+1）
   * @param {Float32Array} opts.heights 长度 resolution*resolution 的高度数组，行优先（z 行 x 列）
   */
  constructor({ width, depth, resolution, heights }) {
    if (heights.length !== resolution * resolution) {
      throw new Error('高度数组长度与分辨率不匹配');
    }
    this.width = width;
    this.depth = depth;
    this.resolution = resolution;
    this.heights = heights;
    this.minX = -width / 2;
    this.minZ = -depth / 2;
    this._cell = width / (resolution - 1);
  }

  /** 双线性插值采样高度，地形范围外返回 NaN（散布层据此丢弃越界点）。 */
  heightAt(x, z) {
    if (x < this.minX || z < this.minZ || x > -this.minX || z > -this.minZ) return NaN;
    const fx = (x - this.minX) / this._cell;
    const fz = (z - this.minZ) / this._cell;
    const ix = Math.min(this.resolution - 2, Math.floor(fx));
    const iz = Math.min(this.resolution - 2, Math.floor(fz));
    const tx = fx - ix;
    const tz = fz - iz;
    const N = this.resolution;
    const h00 = this.heights[iz * N + ix];
    const h10 = this.heights[iz * N + ix + 1];
    const h01 = this.heights[(iz + 1) * N + ix];
    const h11 = this.heights[(iz + 1) * N + ix + 1];
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return a + (b - a) * tz;
  }

  /** 用中心差分求世界空间法线（单位向量）。 */
  normalAt(x, z) {
    const e = this._cell;
    const hL = this.heightAt(x - e, z);
    const hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e);
    const hU = this.heightAt(x, z + e);
    // 越界点用对侧补，保证边界仍有法线
    const dx = (Number.isNaN(hR) ? hL : hR) - (Number.isNaN(hL) ? hR : hL);
    const dz = (Number.isNaN(hU) ? hD : hU) - (Number.isNaN(hD) ? hU : hD);
    let nx = -dx / (2 * e);
    let nz = -dz / (2 * e);
    const invLen = 1 / Math.hypot(nx, 1, nz);
    return { x: nx * invLen, y: invLen, z: nz * invLen };
  }

  /** 坡度角（度），0 = 平地，90 = 垂直面。 */
  slopeAt(x, z) {
    const n = this.normalAt(x, z);
    return (Math.acos(Math.min(1, Math.abs(n.y))) * 180) / Math.PI;
  }

  toJSON() {
    return {
      width: this.width,
      depth: this.depth,
      resolution: this.resolution,
      // 转普通数组，保证 JSON.stringify 后仍是数组
      heights: Array.from(this.heights),
    };
  }

  static fromJSON(json) {
    return new Terrain({
      width: json.width,
      depth: json.depth,
      resolution: json.resolution,
      heights: new Float32Array(json.heights),
    });
  }
}

// ---- 程序生成：带种子的 value noise + 分形布朗运动 ----

function smooth(t) {
  return t * t * (3 - 2 * t);
}

function makeValueNoise(seed) {
  const rand = mulberry32(seed);
  const gridSize = 256;
  const values = new Float32Array(gridSize * gridSize);
  for (let i = 0; i < values.length; i++) values[i] = rand();
  return (x, z) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const tx = smooth(x - ix);
    const tz = smooth(z - iz);
    const at = (i, j) => values[((j & 255) * 256 + (i & 255)) >>> 0];
    const a = at(ix, iz);
    const b = at(ix + 1, iz);
    const c = at(ix, iz + 1);
    const d = at(ix + 1, iz + 1);
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  };
}

/**
 * 程序生成小地形。
 * @param {object} opts
 * @param {number} opts.size 正方形边长（米），默认 128
 * @param {number} opts.resolution 默认 129
 * @param {number} opts.seed 噪声种子
 * @param {number} opts.amplitude 总高度幅度（米）
 * @returns {Terrain}
 */
export function generateTerrain({
  size = 128,
  resolution = 129,
  seed = hashInts(13896, 7),
  amplitude = 14,
} = {}) {
  const noise = makeValueNoise(seed);
  const heights = new Float32Array(resolution * resolution);
  const scale = 4 / size; // 基础频率：整个地形约 4 个噪声周期
  let k = 0;
  for (let iz = 0; iz < resolution; iz++) {
    for (let ix = 0; ix < resolution; ix++) {
      const x = (ix / (resolution - 1) - 0.5) * size;
      const z = (iz / (resolution - 1) - 0.5) * size;
      let h = 0;
      let amp = 1;
      let freq = scale;
      let norm = 0;
      for (let oct = 0; oct < 4; oct++) {
        h += noise(x * freq + 100, z * freq + 100) * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      h /= norm; // 0..1
      // 边缘压平，避免实例在地形边界被裁掉时观感突兀
      const edge = Math.min(size / 2 - Math.abs(x), size / 2 - Math.abs(z));
      const edgeFade = Math.max(0, Math.min(1, edge / (size * 0.08)));
      heights[k++] = (h - 0.35) * amplitude * edgeFade;
    }
  }
  return new Terrain({ width: size, depth: size, resolution, heights });
}
