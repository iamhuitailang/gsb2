/**
 * 2D 纹理画布预览：直接绘制引擎中的像素，与模型采样同一份数据，
 * 保证画布与模型显示同一结果。叠加 UV 线框与接缝高亮。
 */
import { PaintableObject } from './scene-view.js';
import { compositeLayers, TextureLayer } from '../core/texture-layer.js';
import { SeamSegment } from '../core/mesh.js';

export class UvPreview {
  private ctx: CanvasRenderingContext2D;
  private seams: SeamSegment[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private getObject: () => PaintableObject | null,
    private getMaterial: () => string | null,
    private getShowUv: () => boolean,
    private getShowSeams: () => boolean,
    private getPaintOnly: () => boolean,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  update(): void {
    const obj = this.getObject();
    const material = this.getMaterial();
    const ctx = this.ctx;
    const size = this.canvas.width;
    ctx.clearRect(0, 0, size, size);
    if (!obj || !material) {
      ctx.fillStyle = '#262a30';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#7a8089';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('导入模型后在此预览纹理', size / 2, size / 2);
      return;
    }
    const state = obj.engine.getMaterialState(material);
    if (!state) return;

    const layer = this.getPaintOnly()
      ? state.paint
      : (() => {
          const composite = new TextureLayer(state.resolution, state.resolution);
          composite.data.set(compositeLayers(state.base, state.paint));
          return composite;
        })();

    // 放大/缩放到预览尺寸（图像像素 0 行在顶部，UV v=0 在底部）
    const imgData = ctx.createImageData(state.resolution, state.resolution);
    imgData.data.set(layer.data);
    const tmp = document.createElement('canvas');
    tmp.width = state.resolution;
    tmp.height = state.resolution;
    tmp.getContext('2d')!.putImageData(imgData, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, 0, 0, size, size);

    if (this.getShowUv()) this.drawUvWireframe(obj, material, size);
    if (this.getShowSeams()) this.drawSeams(size);
  }

  private drawUvWireframe(obj: PaintableObject, material: string, size: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(80, 200, 255, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mesh = obj.paintMesh;
    for (let t = 0; t < mesh.triangleCount; t++) {
      if (mesh.materialOfTriangle(t) !== material) continue;
      const tri = mesh.getTriangle(t);
      const pts = [tri.uvA, tri.uvB, tri.uvC];
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % 3];
        ctx.moveTo(p.x * size, (1 - p.y) * size);
        ctx.lineTo(q.x * size, (1 - q.y) * size);
      }
    }
    ctx.stroke();
  }

  private drawSeams(size: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = 'rgba(255, 160, 0, 0.95)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (const seg of this.seams) {
      ctx.moveTo(seg.from.x * size, (1 - seg.from.y) * size);
      ctx.lineTo(seg.to.x * size, (1 - seg.to.y) * size);
    }
    ctx.stroke();
  }

  refreshSeams(obj: PaintableObject): void {
    this.seams = obj.paintMesh.detectSeamUvSegments();
  }
}
