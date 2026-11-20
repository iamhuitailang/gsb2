import { TerrainModel } from "./TerrainModel";
import { fbm2D } from "./random";

/**
 * 程序化地形生成。
 * 所有算法仅依赖保存进工程文件的 seed，同参数同 seed 结果逐位一致。
 */

export interface GenerateOptions {
  seed: number;
  /** 整体起伏幅度（米）。 */
  amplitude?: number;
  /** 基础噪声频率（越大越细碎）。 */
  frequency?: number;
  octaves?: number;
}

/** 通用丘陵：多层 fBm 叠加。 */
export function generateHills(model: TerrainModel, opts: GenerateOptions): void {
  const N = model.vertexCount;
  const layer = model.layers[0];
  const amp = opts.amplitude ?? 12;
  const freq = (opts.frequency ?? 2.5) / N;
  const oct = opts.octaves ?? 5;
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const n = fbm2D(x * freq, z * freq, opts.seed, oct);
      layer.heights[z * N + x] = n * amp;
    }
  }
  model.seed = opts.seed;
  model.recomputeAll();
}

/**
 * 山谷样例：fBm 丘陵基础上沿一条正弦弯曲的河道下切出 V 型山谷，
 * 两侧再叠一层山脊噪声，形成可供刷地形练习的完整地貌。
 */
export function generateValley(model: TerrainModel, seed: number): void {
  const N = model.vertexCount;
  const layer = model.layers[0];
  // 频率以整张地形为基准，N 变化时地貌尺度保持稳定
  const freq = 1.6 / N;
  const center = (N - 1) / 2;
  const valleyWidth = N * 0.2;
  const depth = 11;

  for (let z = 0; z < N; z++) {
    // 河道中心线在 x 方向随 z 正弦摆动
    const pathX = center + Math.sin((z / N) * Math.PI * 2.2 + seed * 0.001) * N * 0.16;
    for (let x = 0; x < N; x++) {
      const i = z * N + x;
      const base = fbm2D(x * freq, z * freq, seed, 4, 2, 0.5) * 7;
      const ridge =
        Math.max(0, fbm2D(x * freq * 1.8 + 11, z * freq * 1.8, seed + 77, 3)) * 4;
      const dist = Math.abs(x - pathX);
      // 谷内下切，谷外保持丘陵
      const valley =
        dist < valleyWidth
          ? -depth * (1 - dist / valleyWidth) ** 1.8
          : 0;
      layer.heights[i] = base + ridge + valley;
    }
  }
  model.seed = seed;
  model.recomputeAll();
}

/**
 * 接缝检查场景：平坦基底 + 若干刻意压在区块边界上的圆锥丘与下沉坑。
 * 若区块边界出现裂缝，圆锥在边界处会明显错位；配合线框/边界显示可直接目检。
 */
export function generateSeamTest(model: TerrainModel, seed: number): void {
  const N = model.vertexCount;
  const layer = model.layers[0];
  layer.heights.fill(0);

  const cs = model.chunkSize;
  const bumps: Array<[number, number, number, number]> = [];
  // 在每条内部区块边界的交点与中点放置特征
  for (let k = 1; k < model.chunksPerSide; k++) {
    const b = k * cs;
    bumps.push([b, N * 0.25, cs * 0.9, 6]); // 竖边界上的丘
    bumps.push([N * 0.75, b, cs * 0.9, -5]); // 横边界上的坑
    bumps.push([b, b, cs * 1.1, 7]); // 四块交界处的丘
  }
  // 确定性撒一些跨边界小丘
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let k = 0; k < 8; k++) {
    const edge = Math.floor(rand() * (model.chunksPerSide - 1)) + 1;
    const along = rand() * N;
    const r = cs * (0.5 + rand() * 0.6);
    const h = (rand() > 0.5 ? 1 : -1) * (3 + rand() * 4);
    if (rand() > 0.5) bumps.push([edge * cs, along, r, h]);
    else bumps.push([along, edge * cs, r, h]);
  }

  for (const [cx, cz, radius, height] of bumps) {
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor(cx - radius));
    const x1 = Math.min(N - 1, Math.ceil(cx + radius));
    const z0 = Math.max(0, Math.floor(cz - radius));
    const z1 = Math.min(N - 1, Math.ceil(cz + radius));
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 > r2) continue;
        const t = 1 - Math.sqrt(d2) / radius;
        layer.heights[z * N + x] += height * t * t;
      }
    }
  }
  model.seed = seed;
  model.recomputeAll();
}
