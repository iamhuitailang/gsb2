/**
 * 可绘制网格：位置 / UV / 索引、按材质分组的三角面、空间哈希加速结构、
 * 以及 UV 接缝检测。全部为纯数据 + 纯逻辑，不依赖 DOM。
 */
import {
  BBox,
  Vec2,
  Vec3,
  barycentric,
  bboxFromPositions,
  clamp,
  v3,
} from './math3d.js';

export interface MaterialSlot {
  /** 材质名（对应 .mtl / glTF material） */
  name: string;
  /** 在索引缓冲中的起始三角面序号 */
  startTriangle: number;
  /** 三角面数量 */
  triangleCount: number;
}

export interface TriangleView {
  index: number;
  materialName: string;
  a: Vec3;
  b: Vec3;
  c: Vec3;
  uvA: Vec2;
  uvB: Vec2;
  uvC: Vec2;
  normal: Vec3;
}

export interface SeamSegment {
  from: Vec2;
  to: Vec2;
}

const QUANT = 1e5;

function quantize(x: number): number {
  return Math.round(x * QUANT);
}

export class PaintMesh {
  name: string;
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  materials: MaterialSlot[];
  bbox: BBox;

  /** 空间哈希：cellKey -> 三角面序号列表 */
  private grid = new Map<string, number[]>();
  readonly cellSize: number;

  constructor(
    name: string,
    positions: Float32Array,
    uvs: Float32Array,
    indices: Uint32Array,
    materials: MaterialSlot[],
  ) {
    if (indices.length % 3 !== 0) throw new Error('索引数必须是 3 的倍数');
    if (uvs.length !== positions.length / 3 * 2) {
      throw new Error('UV 顶点数与位置顶点数不一致');
    }
    this.name = name;
    this.positions = positions;
    this.uvs = uvs;
    this.indices = indices;
    this.materials = materials.length
      ? materials
      : [{ name: 'default', startTriangle: 0, triangleCount: indices.length / 3 }];
    this.bbox = bboxFromPositions(positions);

    // 网格尺寸：以模型平均边长量级为参考，保证每个 cell 内三角面数量适中
    const size = this.bbox.max;
    const min = this.bbox.min;
    const extent = Math.max(
      size.x - min.x,
      size.y - min.y,
      size.z - min.z,
      1e-6,
    );
    this.cellSize = Math.max(extent / 32, 1e-6);
    this.buildGrid();
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  materialOfTriangle(t: number): string {
    for (const m of this.materials) {
      if (t >= m.startTriangle && t < m.startTriangle + m.triangleCount) {
        return m.name;
      }
    }
    return this.materials[0]?.name ?? 'default';
  }

  private vertexPos(i: number): Vec3 {
    return v3(
      this.positions[i * 3],
      this.positions[i * 3 + 1],
      this.positions[i * 3 + 2],
    );
  }

  private vertexUv(i: number): Vec2 {
    return { x: this.uvs[i * 2], y: this.uvs[i * 2 + 1] };
  }

  getTriangle(t: number): TriangleView {
    const o = t * 3;
    const ia = this.indices[o];
    const ib = this.indices[o + 1];
    const ic = this.indices[o + 2];
    const a = this.vertexPos(ia);
    const b = this.vertexPos(ib);
    const c = this.vertexPos(ic);
    const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    const n = {
      x: e1.y * e2.z - e1.z * e2.y,
      y: e1.z * e2.x - e1.x * e2.z,
      z: e1.x * e2.y - e1.y * e2.x,
    };
    const nl = Math.hypot(n.x, n.y, n.z) || 1;
    return {
      index: t,
      materialName: this.materialOfTriangle(t),
      a,
      b,
      c,
      uvA: this.vertexUv(ia),
      uvB: this.vertexUv(ib),
      uvC: this.vertexUv(ic),
      normal: { x: n.x / nl, y: n.y / nl, z: n.z / nl },
    };
  }

  /** 三角面三个顶点的位置索引（接缝检测用） */
  triangleVertexIndices(t: number): [number, number, number] {
    const o = t * 3;
    return [this.indices[o], this.indices[o + 1], this.indices[o + 2]];
  }

  private buildGrid(): void {
    for (let t = 0; t < this.triangleCount; t++) {
      const tri = this.getTriangle(t);
      const mn = [
        Math.min(tri.a.x, tri.b.x, tri.c.x),
        Math.min(tri.a.y, tri.b.y, tri.c.y),
        Math.min(tri.a.z, tri.b.z, tri.c.z),
      ];
      const mx = [
        Math.max(tri.a.x, tri.b.x, tri.c.x),
        Math.max(tri.a.y, tri.b.y, tri.c.y),
        Math.max(tri.a.z, tri.b.z, tri.c.z),
      ];
      const c0 = this.cellOf(mn[0], mn[1], mn[2]);
      const c1 = this.cellOf(mx[0], mx[1], mx[2]);
      for (let ix = c0[0]; ix <= c1[0]; ix++) {
        for (let iy = c0[1]; iy <= c1[1]; iy++) {
          for (let iz = c0[2]; iz <= c1[2]; iz++) {
            const key = `${ix}|${iy}|${iz}`;
            let list = this.grid.get(key);
            if (!list) {
              list = [];
              this.grid.set(key, list);
            }
            list.push(t);
          }
        }
      }
    }
  }

  private cellOf(x: number, y: number, z: number): [number, number, number] {
    return [
      Math.floor(x / this.cellSize),
      Math.floor(y / this.cellSize),
      Math.floor(z / this.cellSize),
    ];
  }

  /**
   * 返回包围球与给定球（局部空间中心 + 半径）相交的候选三角面。
   * 只遍历球覆盖的 cell，避免全网格逐三角面检测。
   */
  queryTrianglesInSphere(
    center: Vec3,
    radius: number,
    materialName?: string,
  ): number[] {
    const c0 = this.cellOf(
      center.x - radius,
      center.y - radius,
      center.z - radius,
    );
    const c1 = this.cellOf(
      center.x + radius,
      center.y + radius,
      center.z + radius,
    );
    const seen = new Set<number>();
    const out: number[] = [];
    for (let ix = c0[0]; ix <= c1[0]; ix++) {
      for (let iy = c0[1]; iy <= c1[1]; iy++) {
        for (let iz = c0[2]; iz <= c1[2]; iz++) {
          const list = this.grid.get(`${ix}|${iy}|${iz}`);
          if (!list) continue;
          for (const t of list) {
            if (seen.has(t)) continue;
            if (materialName && this.materialOfTriangle(t) !== materialName) {
              continue;
            }
            seen.add(t);
            out.push(t);
          }
        }
      }
    }
    return out;
  }

  /**
   * 三角面上的三维点 -> UV（重心插值）。
   */
  interpolateUv(triangle: TriangleView, p: Vec3): Vec2 {
    const bary = barycentric(p, triangle.a, triangle.b, triangle.c);
    return {
      x:
        bary.x * triangle.uvA.x +
        bary.y * triangle.uvB.x +
        bary.z * triangle.uvC.x,
      y:
        bary.x * triangle.uvA.y +
        bary.y * triangle.uvB.y +
        bary.z * triangle.uvC.y,
    };
  }

  /**
   * 三维空间中的接缝边（位置重合的共享边、两侧 UV 不一致），
   * 用于在模型上高亮显示接缝位置。返回端点对数组。
   */
  detectSeam3DEdges(): Array<[Vec3, Vec3]> {
    const edgeMap = new Map<string, Array<{ u0: Vec2; u1: Vec2; p0: Vec3; p1: Vec3 }>>();
    for (let t = 0; t < this.triangleCount; t++) {
      const [i0, i1, i2] = this.triangleVertexIndices(t);
      const pairs: Array<[number, number]> = [
        [i0, i1],
        [i1, i2],
        [i2, i0],
      ];
      for (const [pa, pb] of pairs) {
        const pa3 = this.vertexPos(pa);
        const pb3 = this.vertexPos(pb);
        const qa = [quantize(pa3.x), quantize(pa3.y), quantize(pa3.z)];
        const qb = [quantize(pb3.x), quantize(pb3.y), quantize(pb3.z)];
        const flip =
          qa[0] !== qb[0]
            ? qa[0] > qb[0]
            : qa[1] !== qb[1]
              ? qa[1] > qb[1]
              : qa[2] > qb[2];
        const key = flip
          ? `${qb.join(',')}|${qa.join(',')}`
          : `${qa.join(',')}|${qb.join(',')}`;
        const u0 = this.vertexUv(pa);
        const u1 = this.vertexUv(pb);
        const entry = flip
          ? { u0: u1, u1: u0, p0: pb3, p1: pa3 }
          : { u0, u1, p0: pa3, p1: pb3 };
        const existing = edgeMap.get(key);
        if (existing) existing.push(entry);
        else edgeMap.set(key, [entry]);
      }
    }
    const edges: Array<[Vec3, Vec3]> = [];
    for (const occurrences of edgeMap.values()) {
      if (occurrences.length < 2) continue;
      let isSeam = false;
      for (let i = 0; i < occurrences.length && !isSeam; i++) {
        for (let j = i + 1; j < occurrences.length; j++) {
          const a = occurrences[i];
          const b = occurrences[j];
          if (
            Math.hypot(a.u0.x - b.u0.x, a.u0.y - b.u0.y) > 1e-4 ||
            Math.hypot(a.u1.x - b.u1.x, a.u1.y - b.u1.y) > 1e-4
          ) {
            isSeam = true;
            break;
          }
        }
      }
      if (isSeam) edges.push([occurrences[0].p0, occurrences[0].p1]);
    }
    return edges;
  }

  /**
   * 检测 UV 接缝：同一条三维边（位置相同的两个端点）被两个面共享，
   * 但两侧的 UV 端点不重合，则该边为接缝。返回接缝在 UV 空间的线段（每侧各一条）。
   */
  detectSeamUvSegments(uvEpsilon = 1e-4): SeamSegment[] {
    // key: 量化后的三维无向边 -> 出现过的 UV 端点对
    const edgeMap = new Map<string, Array<{ u0: Vec2; u1: Vec2 }>>();
    for (let t = 0; t < this.triangleCount; t++) {
      const [i0, i1, i2] = this.triangleVertexIndices(t);
      const pairs: Array<[number, number]> = [
        [i0, i1],
        [i1, i2],
        [i2, i0],
      ];
      for (const [pa, pb] of pairs) {
        const pa3 = this.vertexPos(pa);
        const pb3 = this.vertexPos(pb);
        const qa = [quantize(pa3.x), quantize(pa3.y), quantize(pa3.z)];
        const qb = [quantize(pb3.x), quantize(pb3.y), quantize(pb3.z)];
        // 无向边：字典序较小的端点在前
        const flip =
          qa[0] !== qb[0]
            ? qa[0] > qb[0]
            : qa[1] !== qb[1]
              ? qa[1] > qb[1]
              : qa[2] > qb[2];
        const key = flip
          ? `${qb.join(',')}|${qa.join(',')}`
          : `${qa.join(',')}|${qb.join(',')}`;
        const u0 = this.vertexUv(pa);
        const u1 = this.vertexUv(pb);
        const entry = flip ? { u0: u1, u1: u0 } : { u0, u1 };
        const existing = edgeMap.get(key);
        if (existing) existing.push(entry);
        else edgeMap.set(key, [entry]);
      }
    }

    const segments: SeamSegment[] = [];
    for (const occurrences of edgeMap.values()) {
      if (occurrences.length < 2) continue;
      // 任两侧 UV 端点差距超阈值 => 接缝，收集全部 UV 线段
      let isSeam = false;
      for (let i = 0; i < occurrences.length && !isSeam; i++) {
        for (let j = i + 1; j < occurrences.length; j++) {
          const a = occurrences[i];
          const b = occurrences[j];
          if (
            Math.hypot(a.u0.x - b.u0.x, a.u0.y - b.u0.y) > uvEpsilon ||
            Math.hypot(a.u1.x - b.u1.x, a.u1.y - b.u1.y) > uvEpsilon
          ) {
            isSeam = true;
            break;
          }
        }
      }
      if (isSeam) {
        for (const o of occurrences) {
          segments.push({ from: o.u0, to: o.u1 });
        }
      }
    }
    return segments;
  }
}

/**
 * 将 UV 坐标（约定 0..1，原点左下）夹紧到合法范围。
 */
export function clampUv(uv: Vec2): Vec2 {
  return {
    x: clamp(uv.x, 0, 1 - 1e-7),
    y: clamp(uv.y, 0, 1 - 1e-7),
  };
}
