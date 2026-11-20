/** 全局共享的类型定义与工程文件格式。 */

export type BrushMode = "raise" | "lower" | "smooth" | "paint";

export interface BrushSettings {
  mode: BrushMode;
  /** 笔刷半径，单位为世界单位（米）。 */
  radius: number;
  /** 每次作用的强度 0~1。 */
  strength: number;
  /** 涂抹模式使用的颜色（0~1 线性分量）。 */
  color: [number, number, number];
}

/** 一次笔画对单个图层产生的稀疏改动（包围盒 + 改动前/后快照）。 */
export interface StrokePatch {
  layerId: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** 改动前的高度（按行主序，长度 = (x1-x0+1)*(y1-y0+1)）。 */
  heightBefore: Float32Array;
  heightAfter: Float32Array;
  /** 颜色改动前；未改颜色时为 null。 */
  colorBefore: Float32Array | null;
  colorAfter: Float32Array | null;
}

export interface HistoryEntry {
  label: string;
  before: StrokePatch;
  after: StrokePatch;
}

export interface TerrainLayer {
  id: string;
  name: string;
  visible: boolean;
  /** 图层强度 0~1，作用于该层高度贡献与颜色 alpha。 */
  opacity: number;
  /** 每层独立高度场，长度 = vertexCount^2，行主序 (z*N+x)。 */
  heights: Float32Array;
  /** 每层独立颜色场，长度 = vertexCount^2*4，未涂抹像素 alpha=0；懒分配。 */
  colors: Float32Array | null;
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
}

export interface TerrainProjectData {
  /** 工程文件格式版本。 */
  version: 1;
  /** 每个区块一条边包含的格数（顶点数 = chunkSize+1）。 */
  chunkSize: number;
  /** 每边区块数。 */
  chunksPerSide: number;
  /** 相邻顶点世界间距（米）。 */
  spacing: number;
  /** 随机生成用的种子；保存后重新打开据此保持一致。 */
  seed: number;
  layers: Array<{
    id: string;
    name: string;
    visible: boolean;
    opacity: number;
    /** base64 编码的 Float32 高度数据。 */
    heightsB64: string;
    colorsB64: string | null;
  }>;
  selectedLayerId: string;
  activeLayerIndex: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

export function clampRect(r: Rect, max: number): Rect {
  return {
    x0: Math.max(0, r.x0),
    y0: Math.max(0, r.y0),
    x1: Math.min(max, r.x1),
    y1: Math.min(max, r.y1),
  };
}
