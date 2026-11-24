namespace SamplerLab {
  // ---------- 主画布：低分辨率帧缓冲放大显示 + 矢量覆盖层 ----------

  export interface ViewCallbacks {
    onPickPixel: (px: number, py: number) => void;
    onDragTri: (triId: string, dxPx: number, dyPx: number, commit: boolean) => void;
  }

  export class CanvasView {
    readonly canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private scale = 44;
    private scene: SceneConfig | null = null;
    private out: RasterOutput | null = null;
    private selected: { px: number; py: number } | null = null;
    private hover: { px: number; py: number } | null = null;
    private drag: { triId: string; startX: number; startY: number; lastX: number; lastY: number; moved: boolean } | null =
      null;
    private frame: HTMLCanvasElement;

    constructor(private cb: ViewCallbacks) {
      this.canvas = h('canvas', { className: 'view-canvas' });
      this.ctx = this.canvas.getContext('2d')!;
      this.frame = document.createElement('canvas');
      this.ctx.imageSmoothingEnabled = false;
      this.bind();
    }

    private bind(): void {
      this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
      this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
      window.addEventListener('pointerup', (e) => this.onUp(e));
      this.canvas.addEventListener('pointerleave', () => {
        this.hover = null;
        this.paint();
      });
    }

    private toScene(e: PointerEvent): Vec2 {
      const r = this.canvas.getBoundingClientRect();
      return v2((e.clientX - r.left) / this.scale, (e.clientY - r.top) / this.scale);
    }

    private pickTriAt(s: Vec2): string | null {
      if (!this.scene || !this.out) return null;
      // 后画在上层的优先，逆序拾取
      for (let i = this.scene.triangles.length - 1; i >= 0; i--) {
        const t = this.scene.triangles[i];
        const d = this.out.diagnoses.get(t.id);
        if (!t.enabled || !d || !d.normalized) continue;
        if (pointInTriangle(d.normalized, s).inside) return t.id;
      }
      return null;
    }

    private onDown(e: PointerEvent): void {
      if (!this.scene) return;
      const s = this.toScene(e);
      const px = Math.floor(s.x);
      const py = Math.floor(s.y);
      const triId = this.pickTriAt(s);
      this.canvas.setPointerCapture(e.pointerId);
      this.drag = { triId: triId ?? '', startX: s.x, startY: s.y, lastX: s.x, lastY: s.y, moved: false };
      if (px >= 0 && py >= 0 && px < this.scene.width && py < this.scene.height) {
        this.selected = { px, py };
        this.cb.onPickPixel(px, py);
      }
      this.paint();
    }

    private onMove(e: PointerEvent): void {
      if (!this.scene) return;
      const s = this.toScene(e);
      const px = Math.floor(s.x);
      const py = Math.floor(s.y);
      if (px >= 0 && py >= 0 && px < this.scene.width && py < this.scene.height) {
        this.hover = { px, py };
      }
      if (this.drag && this.drag.triId) {
        const dx = s.x - this.drag.lastX;
        const dy = s.y - this.drag.lastY;
        if (Math.abs(s.x - this.drag.startX) + Math.abs(s.y - this.drag.startY) > 0.15) this.drag.moved = true;
        this.drag.lastX = s.x;
        this.drag.lastY = s.y;
        this.cb.onDragTri(this.drag.triId, dx, dy, false);
      }
      this.paint();
    }

    private onUp(e: PointerEvent): void {
      if (this.drag && this.drag.triId && this.drag.moved) {
        this.cb.onDragTri(this.drag.triId, 0, 0, true);
      }
      this.drag = null;
      void e;
    }

    setScale(scale: number): void {
      this.scale = scale;
      this.paint();
    }

    update(scene: SceneConfig, out: RasterOutput, selected: { px: number; py: number } | null): void {
      this.scene = scene;
      this.out = out;
      this.selected = selected;
      this.frame.width = scene.width;
      this.frame.height = scene.height;
      this.frame.getContext('2d')!.putImageData(toFramebuffer(out), 0, 0);
      this.paint();
    }

    paint(): void {
      if (!this.scene || !this.out) return;
      const { width, height } = this.scene;
      const cssW = width * this.scale;
      const cssH = height * this.scale;
      if (this.canvas.width !== cssW || this.canvas.height !== cssH) {
        this.canvas.width = cssW;
        this.canvas.height = cssH;
        this.ctx.imageSmoothingEnabled = false;
      }
      const ctx = this.ctx;
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.frame, 0, 0, cssW, cssH);

      // 像素网格
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x++) {
        ctx.moveTo(x * this.scale + 0.5, 0);
        ctx.lineTo(x * this.scale + 0.5, cssH);
      }
      for (let y = 0; y <= height; y++) {
        ctx.moveTo(0, y * this.scale + 0.5);
        ctx.lineTo(cssW, y * this.scale + 0.5);
      }
      ctx.stroke();

      // 三角形线框与顶点
      for (const t of this.scene.triangles) {
        if (!t.enabled) continue;
        const d = this.out.diagnoses.get(t.id);
        if (!d || !d.normalized) continue;
        const v = d.normalized;
        ctx.beginPath();
        ctx.moveTo(v[0].x * this.scale, v[0].y * this.scale);
        ctx.lineTo(v[1].x * this.scale, v[1].y * this.scale);
        ctx.lineTo(v[2].x * this.scale, v[2].y * this.scale);
        ctx.closePath();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        for (const p of v) {
          ctx.beginPath();
          ctx.arc(p.x * this.scale, p.y * this.scale, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = '#ffd34d';
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      // 悬停 / 选中像素高亮
      if (this.hover) {
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 2;
        ctx.strokeRect(
          this.hover.px * this.scale + 1,
          this.hover.py * this.scale + 1,
          this.scale - 2,
          this.scale - 2,
        );
      }
      if (this.selected) {
        ctx.strokeStyle = '#ffd34d';
        ctx.lineWidth = 3;
        ctx.strokeRect(
          this.selected.px * this.scale + 1.5,
          this.selected.py * this.scale + 1.5,
          this.scale - 3,
          this.scale - 3,
        );
        this.drawSamples(this.selected.px, this.selected.py);
      }
    }

    /** 在选中像素内画采样点：绿色=被面覆盖，灰白=背景 */
    private drawSamples(px: number, py: number): void {
      const ctx = this.ctx;
      const pixel = this.out!.pixels[py][px];
      const r = Math.max(3, this.scale * 0.09);
      for (const s of pixel.samples) {
        const cx = (px + s.point.ox) * this.scale;
        const cy = (py + s.point.oy) * this.scale;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fillStyle = s.winnerId ? '#57e389' : 'rgba(230,230,230,0.85)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }
}
