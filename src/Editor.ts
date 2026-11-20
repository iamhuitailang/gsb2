import { TerrainModel } from "./core/TerrainModel";
import { applyBrush } from "./core/brush";
import { generateSeamTest, generateValley } from "./core/generator";
import type { BrushSettings } from "./core/types";
import { OrbitCamera } from "./render/camera";
import { raycastTerrain, type RayHit } from "./render/raycast";
import { Renderer } from "./render/Renderer";
import {
  downloadText,
  parseProject,
  pickTextFile,
  PROJECT_EXT,
  PROJECT_MIME,
  serializeProject,
} from "./io/project";
import {
  exportHeightJSON,
  exportOBJ,
  fullRange,
  type ExportRange,
} from "./io/exporter";
import { Panel, type EditorActions, type NewProjectOptions } from "./ui/Panel";

/**
 * 编辑器总控：把数据模型、渲染器、相机、笔刷和面板接起来，
 * 负责指针交互、射线落点计算、笔画生命周期与渲染循环。
 */
export class Editor {
  private model: TerrainModel;
  private renderer!: Renderer;
  private camera: OrbitCamera;
  private panel: Panel;
  private canvas!: HTMLCanvasElement;

  private brush: BrushSettings = {
    mode: "raise",
    radius: 8,
    strength: 0.25,
    color: [0.72, 0.45, 0.28],
  };

  private painting = false;
  private orbiting = false;
  private panning = false;
  private lastPointer = { x: 0, y: 0 };
  private lastHit: RayHit | null = null;
  private lastFrameTime = performance.now();
  private projectName = "未命名地形";
  private rafId = 0;

  /** 调试用：当前相机（只读语义，外部不应直接修改）。 */
  get debugCamera(): OrbitCamera {
    return this.camera;
  }

  /** 调试用：当前数据模型。 */
  get debugModel(): TerrainModel {
    return this.model;
  }

  constructor(private container: HTMLElement) {
    this.model = new TerrainModel({
      chunkSize: 16,
      chunksPerSide: 4,
      spacing: 1,
      seed: 13890,
    });
    generateValley(this.model, this.model.seed);
    this.camera = new OrbitCamera();
    this.resetCamera();

    const actions: EditorActions = {
      onNewProject: (o) => this.newProject(o),
      onOpen: () => this.openProject(),
      onSave: () => this.saveProject(),
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onLoadValley: () => this.loadValley(),
      onLoadSeam: () => this.loadSeamTest(),
      onExport: (kind, range) => this.exportData(kind, range),
      onBrushChange: (patch) => this.changeBrush(patch),
      onSelectLayer: (id) => this.selectLayer(id),
      onAddLayer: () => this.addLayer(),
      onDuplicateLayer: (id) => this.duplicateLayer(id),
      onDeleteLayer: (id) => this.deleteLayer(id),
      onLayerVisible: (id, v) => this.setLayerVisible(id, v),
      onLayerOpacity: (id, v) => this.setLayerOpacity(id, v),
      onToggleWireframe: (v) => (this.renderer.showWireframe = v),
      onToggleBorders: (v) => (this.renderer.showBorders = v),
      onResetCamera: () => this.resetCamera(),
    };
    this.panel = new Panel(
      container,
      this.brush,
      () => this.model,
      actions
    );
    this.attachCanvas();
    this.attachKeyboard();
    this.panel.syncBrush(this.brush);
    this.panel.refreshLayers();
    this.panel.setStatus(null);
    this.loop();
  }

  // ---------------------------------------------------------------
  // 画布与输入
  // ---------------------------------------------------------------

  private attachCanvas(): void {
    const viewport = this.panel.viewport;
    const canvas = document.createElement("canvas");
    viewport.appendChild(canvas);
    this.canvas = canvas;
    this.renderer = new Renderer(canvas, this.model);

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    window.addEventListener("pointermove", (e) => this.onPointerMove(e));
    window.addEventListener("pointerup", (e) => this.onPointerUp(e));
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        this.camera.zoom(e.deltaY);
      },
      { passive: false }
    );
    new ResizeObserver(() => this.renderer.resize()).observe(viewport);
    this.renderer.resize();
  }

  private attachKeyboard(): void {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z" && !e.shiftKey) {
        e.preventDefault();
        this.undo();
      } else if ((e.metaKey || e.ctrlKey) && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        this.redo();
      } else if (key === "1" || key === "2" || key === "3" || key === "4") {
        const modes = ["raise", "lower", "smooth", "paint"] as const;
        this.changeBrush({ mode: modes[Number(key) - 1] });
      } else if (key === "[") {
        this.changeBrush({ radius: Math.max(1, this.brush.radius - 1) });
      } else if (key === "]") {
        this.changeBrush({ radius: Math.min(40, this.brush.radius + 1) });
      }
    });
  }

  private canvasCoords(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / rect.width;
    return [(e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr];
  }

  private pick(e: PointerEvent): RayHit | null {
    const [px, py] = this.canvasCoords(e);
    const ray = this.camera.screenRay(px, py);
    return raycastTerrain(this.model, ray.origin, ray.dir);
  }

  private onPointerDown(e: PointerEvent): void {
    this.canvas.setPointerCapture?.(e.pointerId);
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (e.button === 2 || e.button === 1) {
      this.orbiting = true;
      return;
    }
    if (e.button === 0 && e.shiftKey) {
      this.panning = true;
      return;
    }
    if (e.button === 0) {
      const hit = this.pick(e);
      if (!hit) return;
      // 一次按下-拖动-抬起构成一条笔画，撤销粒度为整个手势
      this.painting = true;
      this.lastHit = hit;
      this.lastFrameTime = performance.now();
      this.model.beginStroke(this.brush.mode);
      this.strokeAt(hit);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const dx = e.clientX - this.lastPointer.x;
    const dy = e.clientY - this.lastPointer.y;
    this.lastPointer = { x: e.clientX, y: e.clientY };

    if (this.orbiting) {
      this.camera.rotate(dx, dy);
      return;
    }
    if (this.panning) {
      this.camera.pan(dx, dy);
      return;
    }

    const hit = this.pick(e);
    this.lastHit = hit;
    if (this.painting && hit) {
      this.strokeAt(hit);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 2 || e.button === 1) this.orbiting = false;
    if (e.button === 0) {
      if (this.painting) this.finishStroke();
      this.painting = false;
      this.panning = false;
    }
  }

  /** 笔画中的一次笔刷作用；包围盒扩张由模型层处理，抬起时统一入栈。 */
  private strokeAt(hit: RayHit): void {
    const now = performance.now();
    const dt = Math.min(64, now - this.lastFrameTime);
    this.lastFrameTime = now;
    const frameScale = Math.min(2.5, dt / 16.7);
    applyBrush(this.model, this.brush, hit.point[0], hit.point[2], frameScale);
  }

  private finishStroke(): void {
    const result = this.model.endStroke();
    if (result) this.renderer.rebuildChunks(result.chunks);
    this.panel.refreshLayers();
  }

  // ---------------------------------------------------------------
  // 渲染循环
  // ---------------------------------------------------------------

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    this.renderer.resize();
    if (this.lastHit) {
      this.renderer.updateBrushRing(this.lastHit.point, this.brush.radius);
      const [gx, gz] = [this.lastHit.gridX, this.lastHit.gridZ];
      const h = this.model.sampleHeightWorld(
        this.lastHit.point[0],
        this.lastHit.point[2]
      );
      this.panel.setStatus(
        `X ${this.lastHit.point[0].toFixed(2)}，Y ${h.toFixed(2)}，Z ${this.lastHit.point[2].toFixed(2)}` +
          `｜格 (${gx.toFixed(1)}, ${gz.toFixed(1)})`
      );
    } else {
      this.renderer.hideBrushRing();
      this.panel.setStatus(null);
    }
    this.renderer.render(this.camera);
  };

  // ---------------------------------------------------------------
  // 动作
  // ---------------------------------------------------------------

  private changeBrush(patch: Partial<BrushSettings>): void {
    Object.assign(this.brush, patch);
    this.panel.syncBrush(this.brush);
  }

  private selectLayer(id: string): void {
    this.model.selectLayer(id);
    this.panel.refreshLayers();
  }

  private addLayer(): void {
    this.model.addLayer();
    this.renderer.rebuildAll();
    this.panel.refreshLayers();
  }

  private duplicateLayer(id: string): void {
    if (this.model.duplicateLayer(id)) {
      this.renderer.rebuildAll();
      this.panel.refreshLayers();
    }
  }

  private deleteLayer(id: string): void {
    if (!this.model.removeLayer(id)) {
      this.panel.alert("至少需要保留一个图层。");
      return;
    }
    this.renderer.rebuildAll();
    this.panel.refreshLayers();
  }

  private setLayerVisible(id: string, visible: boolean): void {
    this.model.setLayerVisible(id, visible);
    this.renderer.rebuildAll();
    this.panel.refreshLayers();
  }

  private setLayerOpacity(id: string, opacity: number): void {
    this.model.setLayerOpacity(id, opacity);
    this.renderer.rebuildAll();
    this.panel.refreshLayers();
  }

  private undo(): void {
    const r = this.model.undo(this.model.selectedLayerId);
    if (r) {
      this.renderer.rebuildChunks(r.chunks);
      this.panel.refreshLayers();
    }
  }

  private redo(): void {
    const r = this.model.redo(this.model.selectedLayerId);
    if (r) {
      this.renderer.rebuildChunks(r.chunks);
      this.panel.refreshLayers();
    }
  }

  private resetCamera(): void {
    const size = this.model.worldSize;
    this.camera.target = [0, 0, 0];
    this.camera.distance = size * 1.15;
    this.camera.azimuth = Math.PI * 0.25;
    this.camera.elevation = Math.PI * 0.36;
  }

  // ---------------------------------------------------------------
  // 工程 / 样例 / 导出
  // ---------------------------------------------------------------

  private replaceModel(model: TerrainModel, name: string): void {
    this.model = model;
    this.projectName = name;
    this.renderer.dispose();
    this.renderer = new Renderer(this.canvas, this.model);
    this.renderer.resize();
    this.resetCamera();
    this.panel.refreshLayers();
  }

  private newProject(opts: NewProjectOptions): void {
    const model = new TerrainModel({
      chunkSize: opts.chunkSize,
      chunksPerSide: opts.chunksPerSide,
      spacing: opts.spacing,
      seed: opts.seed,
    });
    this.replaceModel(model, "未命名地形");
  }

  private async openProject(): Promise<void> {
    try {
      const text = await pickTextFile(".json,application/json");
      const model = parseProject(text);
      this.replaceModel(model, this.projectName);
    } catch (err) {
      this.panel.alert("打开工程失败：" + (err instanceof Error ? err.message : String(err)));
    }
  }

  private saveProject(): void {
    downloadText(
      `${this.projectName}${PROJECT_EXT}`,
      serializeProject(this.model),
      PROJECT_MIME
    );
  }

  private loadValley(): void {
    const model = new TerrainModel({
      chunkSize: 16,
      chunksPerSide: 4,
      spacing: 1,
      seed: 20260715,
    });
    generateValley(model, model.seed);
    this.replaceModel(model, "山谷样例");
  }

  private loadSeamTest(): void {
    const model = new TerrainModel({
      chunkSize: 16,
      chunksPerSide: 4,
      spacing: 1,
      seed: 9090,
    });
    generateSeamTest(model, model.seed);
    this.replaceModel(model, "接缝检查场景");
  }

  private exportData(kind: "obj" | "height", range: ExportRange): void {
    const r =
      range.cx0 === 0 &&
      range.cy0 === 0 &&
      range.cx1 === this.model.chunksPerSide - 1 &&
      range.cy1 === this.model.chunksPerSide - 1
        ? fullRange(this.model)
        : range;
    if (kind === "obj") {
      downloadText(`${this.projectName}.obj`, exportOBJ(this.model, r), "text/plain");
    } else {
      downloadText(
        `${this.projectName}.height.json`,
        exportHeightJSON(this.model, r),
        "application/json"
      );
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId);
    this.renderer.dispose();
  }
}
