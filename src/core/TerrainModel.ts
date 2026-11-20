import type {
  BrushSettings,
  Rect,
  StrokePatch,
  TerrainLayer,
  TerrainProjectData,
} from "./types";
import { clamp } from "./math";
import { clampRect } from "./types";
import { encodeBase64, decodeBase64 } from "./encoding";

let layerSeq = 0;
export function makeLayerId(): string {
  layerSeq += 1;
  return `layer-${Date.now().toString(36)}-${layerSeq}`;
}

/**
 * 地形数据模型。
 *
 * 关键约定：
 * - 整张地形是一张 vertexCount × vertexCount 的全局顶点网格，按 chunksPerSide
 *   个区块切分显示；所有图层共享同一套网格坐标。
 * - 每个区块包含边界上的全部顶点，相邻区块读到的是同一份高度数组元素，
 *   因此区块边界在数据层面不可能出现裂缝。
 * - 合成高度 compositeHeights 与合成颜色 compositeColors 是渲染缓存，
 *   任何编辑都通过 markDirty 按顶点包围盒重算，并上报受影响的区块集合。
 */
export class TerrainModel {
  readonly chunkSize: number;
  readonly chunksPerSide: number;
  readonly spacing: number;
  readonly vertexCount: number;
  seed: number;

  layers: TerrainLayer[] = [];
  selectedLayerId: string;
  activeLayerIndex = 0;

  /** 合成高度缓存（所有可见图层按 opacity 加权）。 */
  compositeHeights: Float32Array;
  /** 合成颜色缓存 RGBA（未涂抹区域 alpha=0，由着色器按高度着色）。 */
  compositeColors: Float32Array;

  /** 进行中的笔画：每层一份 before/after 快照。 */
  private strokeBefore = new Map<string, StrokePatch>();
  private strokeAfter = new Map<string, StrokePatch>();
  private strokeLabel = "";
  private inStroke = false;

  constructor(opts: {
    chunkSize: number;
    chunksPerSide: number;
    spacing: number;
    seed: number;
  }) {
    this.chunkSize = opts.chunkSize;
    this.chunksPerSide = opts.chunksPerSide;
    this.spacing = opts.spacing;
    this.seed = opts.seed;
    this.vertexCount = opts.chunkSize * opts.chunksPerSide + 1;
    const n = this.vertexCount * this.vertexCount;
    this.compositeHeights = new Float32Array(n);
    this.compositeColors = new Float32Array(n * 4);
    const base = this.createLayer("基础地层");
    this.selectedLayerId = base.id;
    this.recomputeAll();
  }

  get vertexTotal(): number {
    return this.vertexCount * this.vertexCount;
  }

  /** 地形世界尺寸（米）。 */
  get worldSize(): number {
    return (this.vertexCount - 1) * this.spacing;
  }

  idx(x: number, z: number): number {
    return z * this.vertexCount + x;
  }

  inBounds(x: number, z: number): boolean {
    return x >= 0 && z >= 0 && x < this.vertexCount && z < this.vertexCount;
  }

  createLayer(name: string): TerrainLayer {
    const layer: TerrainLayer = {
      id: makeLayerId(),
      name,
      visible: true,
      opacity: 1,
      heights: new Float32Array(this.vertexTotal),
      colors: null,
      undoStack: [],
      redoStack: [],
    };
    this.layers.push(layer);
    return layer;
  }

  get selectedLayer(): TerrainLayer {
    const l = this.layers.find((x) => x.id === this.selectedLayerId);
    if (!l) throw new Error("选中图层不存在");
    return l;
  }

  selectLayer(id: string): void {
    if (!this.layers.some((l) => l.id === id)) return;
    this.selectedLayerId = id;
    this.activeLayerIndex = this.layers.findIndex((l) => l.id === id);
  }

  addLayer(name?: string): TerrainLayer {
    const layer = this.createLayer(name ?? `图层 ${this.layers.length + 1}`);
    this.selectedLayerId = layer.id;
    this.activeLayerIndex = this.layers.length - 1;
    this.recomputeAll();
    return layer;
  }

  removeLayer(id: string): boolean {
    if (this.layers.length <= 1) return false;
    const i = this.layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    this.layers.splice(i, 1);
    if (this.selectedLayerId === id) {
      this.selectedLayerId = this.layers[Math.max(0, i - 1)].id;
    }
    this.activeLayerIndex = this.layers.findIndex(
      (l) => l.id === this.selectedLayerId
    );
    this.recomputeAll();
    return true;
  }

  duplicateLayer(id: string): TerrainLayer | null {
    const src = this.layers.find((l) => l.id === id);
    if (!src) return null;
    const copy = this.createLayer(`${src.name} 副本`);
    copy.opacity = src.opacity;
    copy.visible = src.visible;
    copy.heights.set(src.heights);
    if (src.colors) {
      copy.colors = new Float32Array(src.colors);
    }
    this.selectedLayerId = copy.id;
    this.activeLayerIndex = this.layers.length - 1;
    this.recomputeAll();
    return copy;
  }

  setLayerVisible(id: string, visible: boolean): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) l.visible = visible;
    this.recomputeAll();
  }

  setLayerOpacity(id: string, opacity: number): void {
    const l = this.layers.find((x) => x.id === id);
    if (l) l.opacity = clamp(opacity, 0, 1);
    this.recomputeAll();
  }

  renameLayer(id: string, name: string): void {
    const l = this.layers.find((x) => x.id === id);
    if (l && name.trim()) l.name = name.trim();
  }

  // ---------------------------------------------------------------
  // 合成
  // ---------------------------------------------------------------

  /** 全量重算合成高度/颜色（图层显隐、强度变化时使用）。 */
  recomputeAll(): void {
    const n = this.vertexTotal;
    const h = this.compositeHeights;
    const c = this.compositeColors;
    h.fill(0);
    c.fill(0);
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      const op = layer.opacity;
      for (let i = 0; i < n; i++) {
        h[i] += layer.heights[i] * op;
      }
      if (layer.colors) {
        const lc = layer.colors;
        for (let i = 0; i < n; i++) {
          const a = lc[i * 4 + 3] * op;
          if (a <= 0) continue;
          // 自下而上的 alpha 混合
          const ia = 1 - a;
          c[i * 4] = c[i * 4] * ia + lc[i * 4] * a;
          c[i * 4 + 1] = c[i * 4 + 1] * ia + lc[i * 4 + 1] * a;
          c[i * 4 + 2] = c[i * 4 + 2] * ia + lc[i * 4 + 2] * a;
          c[i * 4 + 3] = c[i * 4 + 3] * ia + a;
        }
      }
    }
  }

  /** 局部重算给定顶点包围盒内的合成数据。 */
  recomputeRect(rect: Rect): void {
    const r = clampRect(rect, this.vertexCount - 1);
    const N = this.vertexCount;
    for (let z = r.y0; z <= r.y1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * N + x;
        let hSum = 0;
        let cr = 0, cg = 0, cb = 0, ca = 0;
        for (const layer of this.layers) {
          if (!layer.visible) continue;
          const op = layer.opacity;
          hSum += layer.heights[i] * op;
          if (layer.colors) {
            const a = layer.colors[i * 4 + 3] * op;
            if (a > 0) {
              const ia = 1 - a;
              cr = cr * ia + layer.colors[i * 4] * a;
              cg = cg * ia + layer.colors[i * 4 + 1] * a;
              cb = cb * ia + layer.colors[i * 4 + 2] * a;
              ca = ca * ia + a;
            }
          }
        }
        this.compositeHeights[i] = hSum;
        this.compositeColors[i * 4] = cr;
        this.compositeColors[i * 4 + 1] = cg;
        this.compositeColors[i * 4 + 2] = cb;
        this.compositeColors[i * 4 + 3] = ca;
      }
    }
  }

  /** 顶点包围盒 -> 受影响区块坐标集合（跨边界时两侧区块同时返回）。 */
  chunksTouchingRect(rect: Rect): Array<[number, number]> {
    const r = clampRect(rect, this.vertexCount - 1);
    const cx0 = Math.max(0, Math.floor(r.x0 / this.chunkSize));
    const cy0 = Math.max(0, Math.floor(r.y0 / this.chunkSize));
    const cx1 = Math.min(
      this.chunksPerSide - 1,
      Math.floor(r.x1 / this.chunkSize)
    );
    const cy1 = Math.min(
      this.chunksPerSide - 1,
      Math.floor(r.y1 / this.chunkSize)
    );
    const out: Array<[number, number]> = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        out.push([cx, cy]);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------
  // 笔画与撤销
  // ---------------------------------------------------------------

  beginStroke(label: string): void {
    this.inStroke = true;
    this.strokeLabel = label;
    this.strokeBefore.clear();
    this.strokeAfter.clear();
  }

  private ensureColorArray(layer: TerrainLayer): Float32Array {
    if (!layer.colors) {
      layer.colors = new Float32Array(this.vertexTotal * 4);
    }
    return layer.colors;
  }

  /** 在笔画中记录某图层某包围盒的“改动前”快照（同笔画同层自动扩张）。 */
  private captureBefore(layer: TerrainLayer, rect: Rect, withColor: boolean): void {
    const r = clampRect(rect, this.vertexCount - 1);
    const existing = this.strokeBefore.get(layer.id);
    if (existing) {
      const grows =
        r.x0 < existing.x0 || r.y0 < existing.y0 || r.x1 > existing.x1 || r.y1 > existing.y1;
      if (!grows) return;
      // 扩张包围盒：旧区域保留笔画开始时的原始值，只有新纳入的顶点
      // 才从当前数组读取（这些顶点此前不在编辑包围盒内，尚未被改动）。
      const merged = clampRect(
        {
          x0: Math.min(existing.x0, r.x0),
          y0: Math.min(existing.y0, r.y0),
          x1: Math.max(existing.x1, r.x1),
          y1: Math.max(existing.y1, r.y1),
        },
        this.vertexCount - 1
      );
      const useColor = withColor || existing.colorBefore !== null;
      const fresh = this.snapshot(layer, merged, useColor);
      this.strokeBefore.set(layer.id, this.mergeSnapshots(existing, fresh));
      return;
    }
    this.strokeBefore.set(layer.id, this.snapshot(layer, r, withColor));
  }

  /** 把旧快照的原始值覆盖到新（更大）快照的重叠区域上。 */
  private mergeSnapshots(oldPatch: StrokePatch, newPatch: StrokePatch): StrokePatch {
    const copyOverlap = (
      oldArr: Float32Array | null,
      newArr: Float32Array | null,
      components: number
    ): void => {
      if (!oldArr || !newArr) return;
      const oldW = oldPatch.x1 - oldPatch.x0 + 1;
      const newW = newPatch.x1 - newPatch.x0 + 1;
      for (let z = oldPatch.y0; z <= oldPatch.y1; z++) {
        for (let x = oldPatch.x0; x <= oldPatch.x1; x++) {
          const oi = ((z - oldPatch.y0) * oldW + (x - oldPatch.x0)) * components;
          const ni = ((z - newPatch.y0) * newW + (x - newPatch.x0)) * components;
          for (let k = 0; k < components; k++) newArr[ni + k] = oldArr[oi + k];
        }
      }
    };
    copyOverlap(oldPatch.heightBefore, newPatch.heightBefore, 1);
    copyOverlap(oldPatch.colorBefore, newPatch.colorBefore, 4);
    return newPatch;
  }

  private snapshot(layer: TerrainLayer, r: Rect, withColor: boolean): StrokePatch {
    const N = this.vertexCount;
    const w = r.x1 - r.x0 + 1;
    const h = r.y1 - r.y0 + 1;
    const heights = new Float32Array(w * h);
    let colors: Float32Array | null = withColor
      ? new Float32Array(w * h * 4)
      : null;
    let p = 0;
    for (let z = r.y0; z <= r.y1; z++) {
      for (let x = r.x0; x <= r.x1; x++) {
        const i = z * N + x;
        heights[p] = layer.heights[i];
        if (colors && layer.colors) {
          colors.set(layer.colors.subarray(i * 4, i * 4 + 4), p * 4);
        }
        p++;
      }
    }
    return {
      layerId: layer.id,
      x0: r.x0,
      y0: r.y0,
      x1: r.x1,
      y1: r.y1,
      heightBefore: heights,
      heightAfter: heights.slice(),
      colorBefore: colors,
      colorAfter: colors ? colors.slice() : null,
    };
  }

  /** 一次笔刷作用。rect 为影响到的顶点包围盒，mutate 直接改写图层数组。 */
  applyEdit(
    layer: TerrainLayer,
    rect: Rect,
    withColor: boolean,
    mutate: () => void
  ): void {
    if (!this.inStroke) this.beginStroke("编辑");
    this.captureBefore(layer, rect, withColor);
    mutate();
    // after 快照延后到 endStroke 统一截取
  }

  endStroke(): { rect: Rect; chunks: Array<[number, number]> } | null {
    if (!this.inStroke) return null;
    this.inStroke = false;
    if (this.strokeBefore.size === 0) {
      this.strokeBefore.clear();
      this.strokeAfter.clear();
      return null;
    }

    let union: Rect | null = null;
    for (const before of this.strokeBefore.values()) {
      const layer = this.layers.find((l) => l.id === before.layerId)!;
      const withColor = before.colorBefore !== null;
      const after = this.snapshot(layer, before, withColor);
      this.strokeAfter.set(layer.id, after);
      // 仅当确实发生变化才入栈
      const hChanged = !before.heightBefore.every((v, i) => v === after.heightBefore[i]);
      const cChanged =
        before.colorBefore &&
        !before.colorBefore.every((v, i) => v === after.colorBefore![i]);
      if (hChanged || cChanged) {
        layer.undoStack.push({ label: this.strokeLabel, before, after });
        if (layer.undoStack.length > 50) layer.undoStack.shift();
        layer.redoStack.length = 0;
      }
      union = union
        ? {
            x0: Math.min(union.x0, before.x0),
            y0: Math.min(union.y0, before.y0),
            x1: Math.max(union.x1, before.x1),
            y1: Math.max(union.y1, before.y1),
          }
        : { x0: before.x0, y0: before.y0, x1: before.x1, y1: before.y1 };
    }
    this.strokeBefore.clear();
    this.strokeAfter.clear();
    if (!union) return null;
    this.recomputeRect(union);
    return { rect: union, chunks: this.chunksTouchingRect(union) };
  }

  private writePatch(layer: TerrainLayer, patch: StrokePatch, useAfter: boolean): Rect {
    const N = this.vertexCount;
    const h = useAfter ? patch.heightAfter : patch.heightBefore;
    const c = useAfter ? patch.colorAfter : patch.colorBefore;
    let p = 0;
    for (let z = patch.y0; z <= patch.y1; z++) {
      for (let x = patch.x0; x <= patch.x1; x++) {
        const i = z * N + x;
        layer.heights[i] = h[p];
        if (c) {
          this.ensureColorArray(layer);
          layer.colors!.set(c.subarray(p * 4, p * 4 + 4), i * 4);
        }
        p++;
      }
    }
    return { x0: patch.x0, y0: patch.y0, x1: patch.x1, y1: patch.y1 };
  }

  /** 撤销：只回退指定图层（即当前选中图层）自己的栈。 */
  undo(layerId: string): { rect: Rect; chunks: Array<[number, number]> } | null {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer || layer.undoStack.length === 0) return null;
    const entry = layer.undoStack.pop()!;
    layer.redoStack.push(entry);
    const rect = this.writePatch(layer, entry.before, false);
    this.recomputeRect(rect);
    return { rect, chunks: this.chunksTouchingRect(rect) };
  }

  redo(layerId: string): { rect: Rect; chunks: Array<[number, number]> } | null {
    const layer = this.layers.find((l) => l.id === layerId);
    if (!layer || layer.redoStack.length === 0) return null;
    const entry = layer.redoStack.pop()!;
    layer.undoStack.push(entry);
    const rect = this.writePatch(layer, entry.after, true);
    this.recomputeRect(rect);
    return { rect, chunks: this.chunksTouchingRect(rect) };
  }

  canUndo(layerId: string): boolean {
    return (this.layers.find((l) => l.id === layerId)?.undoStack.length ?? 0) > 0;
  }

  canRedo(layerId: string): boolean {
    return (this.layers.find((l) => l.id === layerId)?.redoStack.length ?? 0) > 0;
  }

  // ---------------------------------------------------------------
  // 查询
  // ---------------------------------------------------------------

  /** 世界坐标 -> 网格坐标（浮点）。 */
  worldToGrid(wx: number, wz: number): [number, number] {
    return [wx / this.spacing + (this.vertexCount - 1) / 2, wz / this.spacing + (this.vertexCount - 1) / 2];
  }

  gridToWorld(gx: number, gz: number): [number, number] {
    return [
      (gx - (this.vertexCount - 1) / 2) * this.spacing,
      (gz - (this.vertexCount - 1) / 2) * this.spacing,
    ];
  }

  /** 合成高度场双线性采样（世界坐标），越界返回 0。 */
  sampleHeightWorld(wx: number, wz: number): number {
    const [gx, gz] = this.worldToGrid(wx, wz);
    const N = this.vertexCount - 1;
    if (gx < 0 || gz < 0 || gx > N || gz > N) return 0;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const x1 = Math.min(N, x0 + 1);
    const z1 = Math.min(N, z0 + 1);
    const tx = gx - x0;
    const tz = gz - z0;
    const h00 = this.compositeHeights[z0 * this.vertexCount + x0];
    const h10 = this.compositeHeights[z0 * this.vertexCount + x1];
    const h01 = this.compositeHeights[z1 * this.vertexCount + x0];
    const h11 = this.compositeHeights[z1 * this.vertexCount + x1];
    const top = h00 + (h10 - h00) * tx;
    const bot = h01 + (h11 - h01) * tx;
    return top + (bot - top) * tz;
  }

  // ---------------------------------------------------------------
  // 序列化
  // ---------------------------------------------------------------

  toProjectData(): TerrainProjectData {
    return {
      version: 1,
      chunkSize: this.chunkSize,
      chunksPerSide: this.chunksPerSide,
      spacing: this.spacing,
      seed: this.seed,
      selectedLayerId: this.selectedLayerId,
      activeLayerIndex: this.activeLayerIndex,
      layers: this.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        opacity: l.opacity,
        heightsB64: encodeBase64(l.heights),
        colorsB64: l.colors ? encodeBase64(l.colors) : null,
      })),
    };
  }

  static fromProjectData(data: TerrainProjectData): TerrainModel {
    const model = new TerrainModel({
      chunkSize: data.chunkSize,
      chunksPerSide: data.chunksPerSide,
      spacing: data.spacing,
      seed: data.seed,
    });
    // 用工程数据替换构造时产生的默认层
    model.layers = data.layers.map((ld) => {
      const heights = decodeBase64(ld.heightsB64);
      const colors = ld.colorsB64 ? decodeBase64(ld.colorsB64) : null;
      return {
        id: ld.id,
        name: ld.name,
        visible: ld.visible,
        opacity: ld.opacity,
        heights,
        colors,
        undoStack: [],
        redoStack: [],
      } as TerrainLayer;
    });
    model.selectedLayerId =
      model.layers.find((l) => l.id === data.selectedLayerId)?.id ??
      model.layers[0].id;
    model.activeLayerIndex = Math.max(
      0,
      model.layers.findIndex((l) => l.id === model.selectedLayerId)
    );
    model.recomputeAll();
    return model;
  }
}
