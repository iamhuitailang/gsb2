import type { TerrainModel } from "../core/TerrainModel";
import { encodeBase64 } from "../core/encoding";

export interface ExportRange {
  /** 区块坐标区间（含端点）。 */
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

export interface ExportInfo {
  vertexX: number;
  vertexZ: number;
  triangleCount: number;
  worldWidth: number;
  worldDepth: number;
  chunkLabel: string;
  heightMin: number;
  heightMax: number;
}

/** 在导出前计算尺寸与区块范围，供确认弹窗展示。 */
export function computeExportInfo(model: TerrainModel, range: ExportRange): ExportInfo {
  const cs = model.chunkSize;
  const gx0 = range.cx0 * cs;
  const gz0 = range.cy0 * cs;
  const gx1 = (range.cx1 + 1) * cs;
  const gz1 = (range.cy1 + 1) * cs;
  const vertexX = gx1 - gx0 + 1;
  const vertexZ = gz1 - gz0 + 1;
  const cellsX = gx1 - gx0;
  const cellsZ = gz1 - gz0;
  let hMin = Infinity;
  let hMax = -Infinity;
  const N = model.vertexCount;
  for (let z = gz0; z <= gz1; z++) {
    for (let x = gx0; x <= gx1; x++) {
      const h = model.compositeHeights[z * N + x];
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }
  return {
    vertexX,
    vertexZ,
    triangleCount: cellsX * cellsZ * 2,
    worldWidth: cellsX * model.spacing,
    worldDepth: cellsZ * model.spacing,
    chunkLabel: `X [${range.cx0}..${range.cx1}]，Z [${range.cy0}..${range.cy1}]（共 ${
      (range.cx1 - range.cx0 + 1) * (range.cy1 - range.cy0 + 1)
    } 块）`,
    heightMin: hMin,
    heightMax: hMax,
  };
}

export function fullRange(model: TerrainModel): ExportRange {
  const last = model.chunksPerSide - 1;
  return { cx0: 0, cy0: 0, cx1: last, cy1: last };
}

/**
 * 导出 Wavefront OBJ。
 * 输出合并后的单一网格（共享边界顶点，天然无缝），包含 v / vn / f，
 * 坐标系与编辑器一致：X 横向、Y 高度、Z 纵向。
 */
export function exportOBJ(model: TerrainModel, range: ExportRange): string {
  const cs = model.chunkSize;
  const spacing = model.spacing;
  const N = model.vertexCount;
  const gx0 = range.cx0 * cs;
  const gz0 = range.cy0 * cs;
  const gx1 = (range.cx1 + 1) * cs;
  const gz1 = (range.cy1 + 1) * cs;
  const vx = gx1 - gx0 + 1;
  const half = model.worldSize / 2;

  const lines: string[] = ["# 三维地形编辑器导出 OBJ", `# 区块范围: ${JSON.stringify(range)}`];

  // 顶点
  for (let z = gz0; z <= gz1; z++) {
    for (let x = gx0; x <= gx1; x++) {
      const wx = x * spacing - half;
      const wz = z * spacing - half;
      const h = model.compositeHeights[z * N + x];
      lines.push(`v ${wx.toFixed(4)} ${h.toFixed(4)} ${wz.toFixed(4)}`);
    }
  }

  // 法线（与 mesher 相同的中央差分）
  const normalAt = (x: number, z: number): [number, number, number] => {
    const xl = Math.max(0, x - 1);
    const xr = Math.min(N - 1, x + 1);
    const zl = Math.max(0, z - 1);
    const zr = Math.min(N - 1, z + 1);
    const nx =
      (model.compositeHeights[z * N + xl] - model.compositeHeights[z * N + xr]) /
      ((xr - xl) * spacing);
    const nz =
      (model.compositeHeights[zl * N + x] - model.compositeHeights[zr * N + x]) /
      ((zr - zl) * spacing);
    const len = Math.hypot(nx, 1, nz) || 1;
    return [nx / len, 1 / len, nz / len];
  };
  for (let z = gz0; z <= gz1; z++) {
    for (let x = gx0; x <= gx1; x++) {
      const [nx, ny, nz] = normalAt(x, z);
      lines.push(`vn ${nx.toFixed(4)} ${ny.toFixed(4)} ${nz.toFixed(4)}`);
    }
  }

  // 面（OBJ 索引从 1 开始，位置/法线同序）
  const localIndex = (x: number, z: number) => (z - gz0) * vx + (x - gx0) + 1;
  for (let z = gz0; z < gz1; z++) {
    for (let x = gx0; x < gx1; x++) {
      const a = localIndex(x, z);
      const b = localIndex(x + 1, z);
      const c = localIndex(x, z + 1);
      const d = localIndex(x + 1, z + 1);
      lines.push(`f ${a}//${a} ${c}//${c} ${b}//${b}`);
      lines.push(`f ${b}//${b} ${c}//${c} ${d}//${d}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** 导出高度数据 JSON：元信息 + base64 Float32 高度场。 */
export function exportHeightJSON(model: TerrainModel, range: ExportRange): string {
  const cs = model.chunkSize;
  const N = model.vertexCount;
  const gx0 = range.cx0 * cs;
  const gz0 = range.cy0 * cs;
  const gx1 = (range.cx1 + 1) * cs;
  const gz1 = (range.cy1 + 1) * cs;
  const vx = gx1 - gx0 + 1;
  const vz = gz1 - gz0 + 1;
  const heights = new Float32Array(vx * vz);
  let p = 0;
  for (let z = gz0; z <= gz1; z++) {
    for (let x = gx0; x <= gx1; x++) {
      heights[p++] = model.compositeHeights[z * N + x];
    }
  }
  const payload = {
    format: "terrain-height-1",
    chunkRange: range,
    vertexX: vx,
    vertexZ: vz,
    spacing: model.spacing,
    heightUnit: "meter",
    layout: "row-major-z",
    heightsB64: encodeBase64(heights),
  };
  return JSON.stringify(payload, null, 2);
}
