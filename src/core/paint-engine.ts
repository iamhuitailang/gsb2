/**
 * 表面绘制引擎（纯逻辑，无 DOM 依赖）。
 *
 * 核心思路：
 * 1. 笔触以物体局部三维坐标存储，每次落笔都重新向 UV 投影，
 *    因此旋转 / 缩放视图后位置始终准确。
 * 2. 笔刷是三维空间中的球：所有与球相交的三角面都参与光栅化，
 *    接缝两侧的面各自把同一处三维笔触画到各自的 UV 岛，天然连续。
 * 3. 每个三角面内用 UV 重心坐标反算三维点，按三维距离算衰减，
 *    画布预览与模型预览采样同一张纹理，结果完全一致。
 * 4. 绘画独立成层，橡皮只清绘画层；撤销按笔画保存 tile 快照，
 *    基础纹理（早先纹理）永不被覆盖。
 */
import { PaintMesh, TriangleView } from './mesh.js';
import {
  DirtyRect,
  TILE_SIZE,
  TextureLayer,
} from './texture-layer.js';
import {
  Vec3,
  distance,
  pointSegmentDistance,
  rayTriangle,
} from './math3d.js';

export interface BrushSettings {
  /** 笔刷半径（物体局部空间单位） */
  radius: number;
  /** 硬度 0..1：实心核占比 */
  hardness: number;
  /** 不透明度 0..1 */
  opacity: number;
  /** 颜色 0..255 */
  color: { r: number; g: number; b: number };
  /** 橡皮模式 */
  eraser: boolean;
}

export interface StrokePoint {
  /** 物体局部空间命中点 */
  point: Vec3;
  /** 命中三角面序号 */
  triangle: number;
}

export interface RayHit {
  point: Vec3;
  triangle: number;
  distance: number;
}

interface TileSnapshot {
  tile: number;
  data: Uint8ClampedArray;
}

interface UndoEntry {
  materialName: string;
  before: TileSnapshot[];
  after: TileSnapshot[];
}

export interface MaterialPaintState {
  name: string;
  resolution: number;
  base: TextureLayer;
  paint: TextureLayer;
}

export type DirtyListener = (materialName: string, rect: DirtyRect) => void;

function smoothstep(x: number): number {
  return x * x * (3 - 2 * x);
}

/** 笔刷径向衰减曲线 */
export function brushProfile(t: number, hardness: number): number {
  if (t <= hardness) return 1;
  if (t >= 1) return 0;
  const k = (t - hardness) / Math.max(1e-6, 1 - hardness);
  return 1 - smoothstep(k);
}

export class PaintEngine {
  private materials = new Map<string, MaterialPaintState>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxHistory = 30;

  private activeStroke: {
    materialName: string;
    brush: BrushSettings;
    touched: Map<number, TileSnapshot>;
    rect: DirtyRect;
    lastPoint: Vec3 | null;
  } | null = null;

  onDirty: DirtyListener | null = null;

  constructor(public mesh: PaintMesh) {}

  // ---------- 材质 / 纹理管理 ----------

  ensureMaterial(name: string, resolution: number): MaterialPaintState {
    let state = this.materials.get(name);
    if (!state) {
      state = {
        name,
        resolution,
        base: new TextureLayer(resolution, resolution, [180, 180, 180, 255]),
        paint: new TextureLayer(resolution, resolution),
      };
      this.materials.set(name, state);
    }
    return state;
  }

  getMaterialState(name: string): MaterialPaintState | undefined {
    return this.materials.get(name);
  }

  listMaterials(): MaterialPaintState[] {
    return [...this.materials.values()];
  }

  /** 替换基础纹理（新建 / 棋盘 / 导入贴图），绘画层与历史保持不变 */
  setBaseTexture(name: string, base: TextureLayer): void {
    const state = this.ensureMaterial(name, base.width);
    if (state.resolution !== base.width) {
      state.resolution = base.width;
      state.paint = new TextureLayer(base.width, base.width);
      this.undoStack = [];
      this.redoStack = [];
    }
    state.base = base;
    this.emitDirty(name, { x0: 0, y0: 0, x1: base.width, y1: base.height });
  }

  /** 清空绘画层（不动基础纹理），清空操作本身也进撤销栈 */
  clearPaint(name: string): void {
    const state = this.materials.get(name);
    if (!state) return;
    const resolution = state.resolution;
    this.beginStroke(
      name,
      {
        radius: 1,
        hardness: 1,
        opacity: 1,
        color: { r: 0, g: 0, b: 0 },
        eraser: true,
      },
      resolution,
    );
    const stroke = this.activeStroke!;
    // 该材质 UV 覆盖到的像素全部擦除
    for (let t = 0; t < this.mesh.triangleCount; t++) {
      if (this.mesh.materialOfTriangle(t) !== name) continue;
      const tri = this.mesh.getTriangle(t);
      this.rasterizeTriangle(
        state,
        tri,
        tri.a,
        Number.MAX_SAFE_INTEGER,
        stroke.brush,
        stroke.touched,
        stroke.rect,
      );
    }
    this.endStroke();
  }

  // ---------- 射线拾取 ----------

  /**
   * 局部空间射线求交，返回最近命中。沿网格 cell 步进收集候选面。
   */
  raycast(origin: Vec3, dir: Vec3, materialName?: string): RayHit | null {
    const cellSize = this.mesh.cellSize;
    const box = this.mesh.bbox;
    // 与 bbox 求交确定步进区间
    let tEnter = 0;
    let tExit = Infinity;
    for (const ax of ['x', 'y', 'z'] as const) {
      const o = origin[ax];
      const d = dir[ax];
      if (Math.abs(d) < 1e-12) {
        if (o < box.min[ax] || o > box.max[ax]) return null;
        continue;
      }
      let t1 = (box.min[ax] - o) / d;
      let t2 = (box.max[ax] - o) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tEnter = Math.max(tEnter, t1);
      tExit = Math.min(tExit, t2);
    }
    if (tExit < Math.max(0, tEnter)) return null;
    tEnter = Math.max(0, tEnter);

    let best: RayHit | null = null;
    const step = cellSize;
    const steps = Math.ceil((tExit - tEnter) / step) + 1;
    const visited = new Set<number>();
    for (let i = 0; i <= steps; i++) {
      const t = tEnter + i * step;
      if (t > tExit) break;
      const p = {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      };
      const candidates = this.mesh.queryTrianglesInSphere(p, step, materialName);
      for (const tri of candidates) {
        if (visited.has(tri)) continue;
        visited.add(tri);
        const view = this.mesh.getTriangle(tri);
        const hitT = rayTriangle(origin, dir, view.a, view.b, view.c);
        if (hitT !== null && (!best || hitT < best.distance)) {
          best = {
            triangle: tri,
            distance: hitT,
            point: {
              x: origin.x + dir.x * hitT,
              y: origin.y + dir.y * hitT,
              z: origin.z + dir.z * hitT,
            },
          };
        }
      }
    }
    return best;
  }

  // ---------- 笔画 ----------

  beginStroke(materialName: string, brush: BrushSettings, resolution = 1024): void {
    if (this.activeStroke) this.endStroke();
    const state = this.ensureMaterial(materialName, resolution);
    this.activeStroke = {
      materialName,
      brush: { ...brush, color: { ...brush.color } },
      touched: new Map(),
      rect: { x0: state.resolution, y0: state.resolution, x1: 0, y1: 0 },
      lastPoint: null,
    };
  }

  /** 笔画上的一个采样点（含与上一点之间的插值） */
  addStrokePoint(hit: StrokePoint): void {
    const stroke = this.activeStroke;
    if (!stroke) return;
    const state = this.materials.get(stroke.materialName);
    if (!state) return;

    const from = stroke.lastPoint;
    const spacing = Math.max(stroke.brush.radius * 0.2, 1e-6);
    if (!from) {
      this.stamp(state, hit.point, stroke);
    } else {
      const segLen = distance(from, hit.point);
      const n = Math.max(1, Math.ceil(segLen / spacing));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const p = {
          x: from.x + (hit.point.x - from.x) * t,
          y: from.y + (hit.point.y - from.y) * t,
          z: from.z + (hit.point.z - from.z) * t,
        };
        this.stamp(state, p, stroke);
      }
    }
    stroke.lastPoint = { ...hit.point };
  }

  endStroke(): UndoEntry | null {
    const stroke = this.activeStroke;
    if (!stroke) return null;
    this.activeStroke = null;
    if (stroke.touched.size === 0) return null;

    const state = this.materials.get(stroke.materialName)!;
    const after: TileSnapshot[] = [];
    for (const snap of stroke.touched.values()) {
      after.push(state.paint.snapshotTile(snap.tile));
    }
    const entry: UndoEntry = {
      materialName: stroke.materialName,
      before: [...stroke.touched.values()],
      after,
    };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emitDirty(stroke.materialName, stroke.rect);
    return entry;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    const state = this.materials.get(entry.materialName);
    if (!state) return false;
    for (const snap of entry.before) state.paint.restoreTile(snap);
    this.redoStack.push(entry);
    this.emitDirty(entry.materialName, this.tileListRect(state, entry.before));
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    const state = this.materials.get(entry.materialName);
    if (!state) return false;
    for (const snap of entry.after) state.paint.restoreTile(snap);
    this.undoStack.push(entry);
    this.emitDirty(entry.materialName, this.tileListRect(state, entry.after));
    return true;
  }

  private tileListRect(state: MaterialPaintState, snaps: TileSnapshot[]): DirtyRect {
    const rect: DirtyRect = {
      x0: state.resolution,
      y0: state.resolution,
      x1: 0,
      y1: 0,
    };
    for (const s of snaps) {
      const b = state.paint.tileBounds(s.tile);
      rect.x0 = Math.min(rect.x0, b.x0);
      rect.y0 = Math.min(rect.y0, b.y0);
      rect.x1 = Math.max(rect.x1, b.x1);
      rect.y1 = Math.max(rect.y1, b.y1);
    }
    return rect;
  }

  // ---------- 单点笔刷 ----------

  private stamp(
    state: MaterialPaintState,
    center: Vec3,
    stroke: NonNullable<PaintEngine['activeStroke']>,
  ): void {
    const candidates = this.mesh.queryTrianglesInSphere(
      center,
      stroke.brush.radius,
      stroke.materialName,
    );
    for (const t of candidates) {
      const tri = this.mesh.getTriangle(t);
      this.rasterizeTriangle(
        state,
        tri,
        center,
        stroke.brush.radius,
        stroke.brush,
        stroke.touched,
        stroke.rect,
      );
    }
  }

  /**
   * 把一个三维笔刷球光栅化到单个三角面的 UV 区域：
   * 在 UV 像素包围盒内逐像素求重心 -> 反算三维点 -> 三维距离衰减，
   * 并按像素到 UV 边的距离做边缘抗锯齿。
   */
  rasterizeTriangle(
    state: MaterialPaintState,
    tri: TriangleView,
    center: Vec3,
    radius: number,
    brush: BrushSettings,
    touched: Map<number, TileSnapshot>,
    rect: DirtyRect,
  ): void {
    const res = state.resolution;
    const layer = state.paint;
    // UV(0,0) 在图像左下，像素行 0 在顶部
    const ax = tri.uvA.x * res;
    const ay = (1 - tri.uvA.y) * res;
    const bx = tri.uvB.x * res;
    const by = (1 - tri.uvB.y) * res;
    const cx = tri.uvC.x * res;
    const cy = (1 - tri.uvC.y) * res;

    const denom = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(denom) < 1e-10) return; // UV 退化三角形

    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const x1 = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y1 = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy)));

    const edgeLenAB = Math.hypot(bx - ax, by - ay) || 1;
    const edgeLenBC = Math.hypot(cx - bx, cy - by) || 1;
    const edgeLenCA = Math.hypot(ax - cx, ay - cy) || 1;

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const pxC = px + 0.5;
        const pyC = py + 0.5;
        // UV 空间重心坐标
        const wB =
          ((pxC - ax) * (cy - ay) - (cx - ax) * (pyC - ay)) / denom;
        const wC =
          ((bx - ax) * (pyC - ay) - (pxC - ax) * (by - ay)) / denom;
        const wA = 1 - wB - wC;

        // 三边有向距离（像素），取最小值做边缘覆盖
        const dAB = ((bx - ax) * (pyC - ay) - (by - ay) * (pxC - ax)) / edgeLenAB;
        const dBC = ((cx - bx) * (pyC - by) - (cy - by) * (pxC - bx)) / edgeLenBC;
        const dCA = ((ax - cx) * (pyC - ay) - (ay - cy) * (pxC - cx)) / edgeLenCA;
        const minEdge = Math.min(dAB, dBC, dCA);
        if (minEdge < -0.5) continue;
        const coverage = Math.min(1, minEdge + 0.5);

        // 重心反算三维点（UV 三角与三维三角仿射对应，重心权重一致）
        const p3 = {
          x: wA * tri.a.x + wB * tri.b.x + wC * tri.c.x,
          y: wA * tri.a.y + wB * tri.b.y + wC * tri.c.y,
          z: wA * tri.a.z + wB * tri.b.z + wC * tri.c.z,
        };
        const d = distance(p3, center);
        if (d > radius) continue;

        const profile = brushProfile(d / radius, brush.hardness);
        const alpha = brush.opacity * profile * coverage;
        if (alpha <= 1 / 255) continue;

        const tile = this.tileAt(layer, px, py);
        if (!touched.has(tile)) touched.set(tile, layer.snapshotTile(tile));

        if (brush.eraser) {
          layer.erasePixel(px, py, alpha);
        } else {
          layer.blendPixel(
            px,
            py,
            brush.color.r,
            brush.color.g,
            brush.color.b,
            alpha,
          );
        }
        rect.x0 = Math.min(rect.x0, px);
        rect.y0 = Math.min(rect.y0, py);
        rect.x1 = Math.max(rect.x1, px + 1);
        rect.y1 = Math.max(rect.y1, py + 1);
      }
    }
  }

  private tileAt(layer: TextureLayer, x: number, y: number): number {
    const cols = Math.ceil(layer.width / TILE_SIZE);
    return (
      Math.floor(y / TILE_SIZE) * cols +
      Math.floor(x / TILE_SIZE)
    );
  }

  /**
   * 供插值笔画查询：点到线段距离（外部用于判定拾取漂移等，保留为工具）。
   */
  static pointSegmentDistance = pointSegmentDistance;

  private emitDirty(materialName: string, rect: DirtyRect): void {
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return;
    this.onDirty?.(materialName, rect);
  }
}
