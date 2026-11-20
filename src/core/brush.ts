import type { BrushSettings, Rect } from "./types";
import type { TerrainModel } from "./TerrainModel";
import { clamp } from "./math";

/**
 * 笔刷作用逻辑。
 *
 * 笔刷以世界单位定义半径；每次作用先把圆心与半径换算到网格坐标，
 * 遍历包围盒内顶点，按到圆心的网格距离计算平滑衰减权重：
 *   weight = (cos(d/r * PI) + 1) / 2   （d <= r）
 *
 * 抬高/压低直接改高度；平滑把顶点高度向 3x3 邻域均值靠拢；
 * 涂抹在图层颜色场上叠加 RGBA。所有改动通过 model.applyEdit 进入
 * 当前笔画的撤销快照，跨区块边界的顶点天然属于同一份数组，
 * 两侧区块随后一起重建。
 */

export function brushFalloff(normDist: number): number {
  if (normDist >= 1) return 0;
  return 0.5 * (Math.cos(normDist * Math.PI) + 1);
}

export interface BrushHit {
  /** 圆心网格坐标（浮点）。 */
  gx: number;
  gz: number;
  /** 半径对应的网格跨度。 */
  gridRadius: number;
  rect: Rect;
}

export function resolveBrushHit(
  model: TerrainModel,
  worldX: number,
  worldZ: number,
  radius: number
): BrushHit {
  const [gx, gz] = model.worldToGrid(worldX, worldZ);
  const gridRadius = radius / model.spacing;
  const ri = Math.ceil(gridRadius);
  const rect: Rect = {
    x0: Math.max(0, Math.floor(gx - ri)),
    y0: Math.max(0, Math.floor(gz - ri)),
    x1: Math.min(model.vertexCount - 1, Math.ceil(gx + ri)),
    y1: Math.min(model.vertexCount - 1, Math.ceil(gz + ri)),
  };
  return { gx, gz, gridRadius, rect };
}

/** 应用一次笔刷；返回实际影响的顶点包围盒。 */
export function applyBrush(
  model: TerrainModel,
  brush: BrushSettings,
  worldX: number,
  worldZ: number,
  /** 帧率归一化系数：每帧调用时用 dt/dtRef，避免刷新率不同笔速不同。 */
  frameScale = 1
): Rect | null {
  const layer = model.selectedLayer;
  const hit = resolveBrushHit(model, worldX, worldZ, brush.radius);
  if (hit.rect.x0 > hit.rect.x1 || hit.rect.y0 > hit.rect.y1) return null;
  const N = model.vertexCount;
  const strength = clamp(brush.strength, 0, 1) * frameScale;
  const mode = brush.mode;
  const withColor = mode === "paint";

  model.applyEdit(layer, hit.rect, withColor, () => {
    if (mode === "raise" || mode === "lower") {
      const dir = mode === "raise" ? 1 : -1;
      // 每帧固定的高度步进（米），按住持续累积
      const step = dir * strength * model.spacing * 0.5;
      for (let z = hit.rect.y0; z <= hit.rect.y1; z++) {
        for (let x = hit.rect.x0; x <= hit.rect.x1; x++) {
          const d = Math.hypot(x - hit.gx, z - hit.gz);
          const w = brushFalloff(d / hit.gridRadius);
          if (w <= 0) continue;
          const i = z * N + x;
          layer.heights[i] += step * w;
        }
      }
    } else if (mode === "smooth") {
      // 先读出当前高度再写回，防止同一次作用内邻域被污染
      const snapshot = new Float32Array(
        (hit.rect.y1 - hit.rect.y0 + 1) * (hit.rect.x1 - hit.rect.x0 + 1)
      );
      let p = 0;
      for (let z = hit.rect.y0; z <= hit.rect.y1; z++) {
        for (let x = hit.rect.x0; x <= hit.rect.x1; x++) {
          snapshot[p++] = layer.heights[z * N + x];
        }
      }
      const w0 = hit.rect.x1 - hit.rect.x0 + 1;
      const at = (x: number, z: number): number => {
        const cx = clamp(x, 0, N - 1);
        const cz = clamp(z, 0, N - 1);
        return layer.heights[cz * N + cx];
      };
      p = 0;
      for (let z = hit.rect.y0; z <= hit.rect.y1; z++) {
        for (let x = hit.rect.x0; x <= hit.rect.x1; x++) {
          const d = Math.hypot(x - hit.gx, z - hit.gz);
          const w = brushFalloff(d / hit.gridRadius);
          if (w <= 0) {
            p++;
            continue;
          }
          let sum = 0;
          let count = 0;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              sum += at(x + dx, z + dz);
              count++;
            }
          }
          const avg = sum / count;
          const i = z * N + x;
          const cur = snapshot[p++];
          layer.heights[i] = cur + (avg - cur) * strength * w;
        }
      }
    } else {
      // paint：向图层颜色场叠加颜色，alpha 随强度与衰减累积
      if (!layer.colors) {
        layer.colors = new Float32Array(model.vertexTotal * 4);
      }
      const [r, g, b] = brush.color;
      for (let z = hit.rect.y0; z <= hit.rect.y1; z++) {
        for (let x = hit.rect.x0; x <= hit.rect.x1; x++) {
          const d = Math.hypot(x - hit.gx, z - hit.gz);
          const w = brushFalloff(d / hit.gridRadius);
          if (w <= 0) continue;
          const i = z * N + x;
          const alpha = Math.min(1, strength * w);
          const ia = 1 - alpha;
          layer.colors[i * 4] = layer.colors[i * 4] * ia + r * alpha;
          layer.colors[i * 4 + 1] = layer.colors[i * 4 + 1] * ia + g * alpha;
          layer.colors[i * 4 + 2] = layer.colors[i * 4 + 2] * ia + b * alpha;
          layer.colors[i * 4 + 3] = Math.min(
            1,
            layer.colors[i * 4 + 3] * ia + alpha
          );
        }
      }
    }
  });

  return hit.rect;
}
