// 体素世界: 按区块(chunk)分块存储
// 每个区块是 CHUNK^3 的 Uint8Array, 0 表示空气, >0 表示材质 id (对应 palette 下标)

export const CHUNK = 8;

export function chunkKey(cx, cy, cz) {
  return `${cx},${cy},${cz}`;
}

export function parseChunkKey(key) {
  return key.split(',').map(Number);
}

// 负数也能正确取模
export function mod(n, m) {
  return ((n % m) + m) % m;
}

export function floorDiv(n, m) {
  return Math.floor(n / m);
}

// 世界坐标 -> 区块坐标 / 区块内坐标
export function worldToChunk(x, y, z) {
  return {
    cx: floorDiv(x, CHUNK),
    cy: floorDiv(y, CHUNK),
    cz: floorDiv(z, CHUNK),
    lx: mod(x, CHUNK),
    ly: mod(y, CHUNK),
    lz: mod(z, CHUNK),
  };
}

export function localIndex(lx, ly, lz) {
  return lx + CHUNK * (ly + CHUNK * lz);
}

export class World {
  constructor(palette = []) {
    // key -> { cx, cy, cz, data: Uint8Array }
    this.chunks = new Map();
    // 材质调色板: [{ id, name, color }], data 里存的是数组下标 + 1
    this.palette = palette;
  }

  // 调色板下标 -> 存储用 id (0 留给空气)
  materialId(index) {
    return index + 1;
  }

  // 存储 id -> 调色板下标
  paletteIndex(id) {
    return id - 1;
  }

  getChunk(cx, cy, cz) {
    return this.chunks.get(chunkKey(cx, cy, cz));
  }

  ensureChunk(cx, cy, cz) {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = { cx, cy, cz, data: new Uint8Array(CHUNK * CHUNK * CHUNK) };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  getVoxel(x, y, z) {
    const { cx, cy, cz, lx, ly, lz } = worldToChunk(x, y, z);
    const chunk = this.getChunk(cx, cy, cz);
    if (!chunk) return 0;
    return chunk.data[localIndex(lx, ly, lz)];
  }

  /**
   * 设置一个体素, 返回需要重建网格的区块 key 集合。
   * 位于区块边缘的修改会把相邻区块也带进来(相邻区块贴着该面的表面要刷新)。
   * 整个区块被删空时, 数据被移除, 同时保证邻居被重建, 不会留下悬空旧表面。
   */
  setVoxel(x, y, z, id) {
    const { cx, cy, cz, lx, ly, lz } = worldToChunk(x, y, z);
    const affected = new Set();

    if (id === 0) {
      const chunk = this.getChunk(cx, cy, cz);
      if (!chunk || chunk.data[localIndex(lx, ly, lz)] === 0) return affected;
      chunk.data[localIndex(lx, ly, lz)] = 0;
      affected.add(chunkKey(cx, cy, cz));
      if (!this.chunkHasVoxel(chunk)) {
        this.chunks.delete(chunkKey(cx, cy, cz));
      }
    } else {
      const chunk = this.ensureChunk(cx, cy, cz);
      if (chunk.data[localIndex(lx, ly, lz)] === id) return affected;
      chunk.data[localIndex(lx, ly, lz)] = id;
      affected.add(chunkKey(cx, cy, cz));
    }

    // 边缘修改: 相邻区块的可见表面可能出现/消失
    if (lx === 0) affected.add(chunkKey(cx - 1, cy, cz));
    if (lx === CHUNK - 1) affected.add(chunkKey(cx + 1, cy, cz));
    if (ly === 0) affected.add(chunkKey(cx, cy - 1, cz));
    if (ly === CHUNK - 1) affected.add(chunkKey(cx, cy + 1, cz));
    if (lz === 0) affected.add(chunkKey(cx, cy, cz - 1));
    if (lz === CHUNK - 1) affected.add(chunkKey(cx, cy, cz + 1));

    return affected;
  }

  chunkHasVoxel(chunk) {
    return chunk.data.some((v) => v !== 0);
  }

  voxelCount() {
    let n = 0;
    for (const chunk of this.chunks.values()) {
      for (const v of chunk.data) if (v !== 0) n++;
    }
    return n;
  }

  clear() {
    this.chunks.clear();
  }

  serialize() {
    const voxels = [];
    for (const chunk of this.chunks.values()) {
      const { cx, cy, cz, data } = chunk;
      for (let lz = 0; lz < CHUNK; lz++) {
        for (let ly = 0; ly < CHUNK; ly++) {
          for (let lx = 0; lx < CHUNK; lx++) {
            const id = data[localIndex(lx, ly, lz)];
            if (id !== 0) {
              voxels.push({
                x: cx * CHUNK + lx,
                y: cy * CHUNK + ly,
                z: cz * CHUNK + lz,
                m: this.paletteIndex(id),
              });
            }
          }
        }
      }
    }
    return {
      format: 'voxel-project',
      version: 1,
      chunkSize: CHUNK,
      palette: this.palette,
      voxels,
    };
  }

  static deserialize(obj) {
    if (obj.format !== 'voxel-project') throw new Error('不是有效的体素工程文件');
    if (obj.chunkSize !== CHUNK) throw new Error(`区块尺寸不匹配: 需要 ${CHUNK}`);
    const world = new World(obj.palette || []);
    for (const v of obj.voxels || []) {
      world.setVoxel(v.x, v.y, v.z, world.materialId(v.m));
    }
    return world;
  }
}
