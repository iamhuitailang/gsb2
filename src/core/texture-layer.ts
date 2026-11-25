/**
 * 纹理像素层（RGBA8）。
 * 纯数据结构，不依赖 DOM / Canvas，Node 下也可运行单测。
 * 基础纹理层与绘画层各一个 TextureLayer，显示时再合成。
 */

export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface DirtyRect {
  x0: number;
  y0: number;
  x1: number; // 不含
  y1: number; // 不含
}

export const TILE_SIZE = 64;

export class TextureLayer implements PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(width: number, height: number, fill: [number, number, number, number] = [0, 0, 0, 0]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data[i * 4] = fill[0];
      this.data[i * 4 + 1] = fill[1];
      this.data[i * 4 + 2] = fill[2];
      this.data[i * 4 + 3] = fill[3];
    }
  }

  static fromRGBA(width: number, height: number, data: Uint8ClampedArray | Uint8Array): TextureLayer {
    if (data.length !== width * height * 4) throw new Error('像素数据尺寸不匹配');
    const layer = new TextureLayer(width, height);
    layer.data.set(data);
    return layer;
  }

  clear(): void {
    this.data.fill(0);
  }

  /** 程序生成棋盘格（含浅色坐标格线，便于观察 UV 方向与接缝） */
  fillChecker(cells = 8, c1: [number, number, number] = [235, 235, 235], c2: [number, number, number] = [120, 120, 120]): void {
    const { width: w, height: h, data } = this;
    const cellW = w / cells;
    const cellH = h / cells;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const cx = Math.min(cells - 1, Math.floor(x / cellW));
        const cy = Math.min(cells - 1, Math.floor(y / cellH));
        const odd = (cx + cy) % 2 === 0;
        const base = odd ? c1 : c2;
        // 格线：每格边界 1 像素加深
        const onLineX = x % Math.max(1, Math.round(cellW)) === 0;
        const onLineY = y % Math.max(1, Math.round(cellH)) === 0;
        const shade = onLineX || onLineY ? 0.72 : 1;
        const i = (y * w + x) * 4;
        data[i] = base[0] * shade;
        data[i + 1] = base[1] * shade;
        data[i + 2] = base[2] * shade;
        data[i + 3] = 255;
      }
    }
  }

  /** 覆盖矩形涉及的 tile 集合 */
  tilesInRect(rect: DirtyRect): Set<number> {
    const tiles = new Set<number>();
    const tx0 = Math.floor(rect.x0 / TILE_SIZE);
    const ty0 = Math.floor(rect.y0 / TILE_SIZE);
    const tx1 = Math.floor((rect.x1 - 1) / TILE_SIZE);
    const ty1 = Math.floor((rect.y1 - 1) / TILE_SIZE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        tiles.add(ty * Math.ceil(this.width / TILE_SIZE) + tx);
      }
    }
    return tiles;
  }

  tileBounds(tile: number): DirtyRect {
    const cols = Math.ceil(this.width / TILE_SIZE);
    const tx = tile % cols;
    const ty = Math.floor(tile / cols);
    return {
      x0: tx * TILE_SIZE,
      y0: ty * TILE_SIZE,
      x1: Math.min(this.width, (tx + 1) * TILE_SIZE),
      y1: Math.min(this.height, (ty + 1) * TILE_SIZE),
    };
  }

  /** 复制一个 tile 的当前像素（撤销快照用） */
  snapshotTile(tile: number): { tile: number; data: Uint8ClampedArray } {
    const b = this.tileBounds(tile);
    const copy = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
    for (let y = b.y0; y < b.y1; y++) {
      const srcOff = (y * this.width + b.x0) * 4;
      const dstOff = ((y - b.y0) * TILE_SIZE) * 4;
      copy.set(this.data.subarray(srcOff, srcOff + (b.x1 - b.x0) * 4), dstOff);
    }
    return { tile, data: copy };
  }

  restoreTile(snapshot: { tile: number; data: Uint8ClampedArray }): void {
    const b = this.tileBounds(snapshot.tile);
    for (let y = b.y0; y < b.y1; y++) {
      const dstOff = (y * this.width + b.x0) * 4;
      const srcOff = ((y - b.y0) * TILE_SIZE) * 4;
      this.data.set(
        snapshot.data.subarray(srcOff, srcOff + (b.x1 - b.x0) * 4),
        dstOff,
      );
    }
  }

  /** 单像素 source-over（paint 层内部混合） */
  blendPixel(x: number, y: number, r: number, g: number, b: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const sa = alpha;
    const da = this.data[i + 3] / 255;
    const outA = sa + da * (1 - sa);
    if (outA < 1e-6) {
      this.data[i + 3] = 0;
      return;
    }
    this.data[i] = (r * sa + this.data[i] * da * (1 - sa)) / outA;
    this.data[i + 1] = (g * sa + this.data[i + 1] * da * (1 - sa)) / outA;
    this.data[i + 2] = (b * sa + this.data[i + 2] * da * (1 - sa)) / outA;
    this.data[i + 3] = outA * 255;
  }

  /** 橡皮：destination-out，按 alpha 扣减绘画层不透明度 */
  erasePixel(x: number, y: number, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const keep = 1 - alpha;
    this.data[i + 3] = (this.data[i + 3] / 255) * keep * 255;
  }
}

/**
 * 合成基础层 + 绘画层（source-over），输出用于显示 / 导出的 RGBA。
 */
export function compositeLayers(base: TextureLayer, paint: TextureLayer): Uint8ClampedArray {
  if (base.width !== paint.width || base.height !== paint.height) {
    throw new Error('基础层与绘画层尺寸不一致');
  }
  const w = base.width;
  const h = base.height;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const ba = base.data[o + 3] / 255;
    const pa = paint.data[o + 3] / 255;
    // 先放基础层（预乘自身 alpha），再把绘画层 source-over 上去
    const outA = pa + ba * (1 - pa);
    if (outA < 1e-6) continue;
    out[o] = (pa * paint.data[o] + ba * (1 - pa) * base.data[o]) / outA;
    out[o + 1] = (pa * paint.data[o + 1] + ba * (1 - pa) * base.data[o + 1]) / outA;
    out[o + 2] = (pa * paint.data[o + 2] + ba * (1 - pa) * base.data[o + 2]) / outA;
    out[o + 3] = outA * 255;
  }
  return out;
}
