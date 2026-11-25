/**
 * 应用主控制器：连接 UI、场景视图、UV 预览、工程存取。
 */
import { SceneView, PaintableObject, PointerHit } from './three/scene-view.js';
import { UvPreview } from './three/uv-preview.js';
import { loadModelFiles } from './three/model-loader.js';
import { createPaintableObject } from './three/object-factory.js';
import { BrushSettings } from './core/paint-engine.js';
import { TextureLayer, compositeLayers } from './core/texture-layer.js';
import {
  buildBinding,
  buildProjectFile,
  bytesToFile,
  downloadBlob,
  downloadText,
  exportLayerPng,
  pngDataUrlToLayer,
  ProjectFile,
  projectModelFiles,
} from './state/project-store.js';

interface UiRefs {
  viewport: HTMLCanvasElement;
  uvPreview: HTMLCanvasElement;
  hint: HTMLDivElement;
  objectSelect: HTMLSelectElement;
  materialSelect: HTMLSelectElement;
  chkPaintOnly: HTMLInputElement;
  chkUv: HTMLInputElement;
  chkSeams: HTMLInputElement;
  btnPaintMode: HTMLButtonElement;
  btnNavMode: HTMLButtonElement;
  color: HTMLInputElement;
  size: HTMLInputElement;
  hardness: HTMLInputElement;
  opacity: HTMLInputElement;
  valSize: HTMLSpanElement;
  valHardness: HTMLSpanElement;
  valOpacity: HTMLSpanElement;
  btnEraser: HTMLButtonElement;
  btnUndo: HTMLButtonElement;
  btnRedo: HTMLButtonElement;
  resolution: HTMLSelectElement;
  btnNewLayer: HTMLButtonElement;
  btnChecker: HTMLButtonElement;
  btnOpen: HTMLButtonElement;
  fileOpen: HTMLInputElement;
  btnSave: HTMLButtonElement;
  btnLoad: HTMLButtonElement;
  fileProject: HTMLInputElement;
  btnExport: HTMLButtonElement;
}

export class App {
  private view: SceneView;
  private preview: UvPreview;
  private selected: PaintableObject | null = null;
  private selectedMaterial: string | null = null;
  private navMode = false;
  private painting = false;

  private brush: BrushSettings = {
    radius: 0.06, // 相对模型包围球半径的比例
    hardness: 0.8,
    opacity: 0.9,
    color: { r: 226, g: 59, b: 59 },
    eraser: false,
  };
  private resolution = 1024;

  constructor(private ui: UiRefs) {
    this.view = new SceneView(ui.viewport);
    this.preview = new UvPreview(
      ui.uvPreview,
      () => this.selected,
      () => this.selectedMaterial,
      () => ui.chkUv.checked,
      () => ui.chkSeams.checked,
      () => ui.chkPaintOnly.checked,
    );
    this.view.onStrokeEnd = () => {
      this.syncHistoryButtons();
      this.preview.update();
    };
    this.bindEvents();
    this.syncBrushLabels();
    this.syncHistoryButtons();
    this.preview.update();
  }

  // ---------- 选择 ----------

  /** 场景视图（公开只读访问，供调试 / E2E） */
  get sceneView(): SceneView {
    return this.view;
  }

  /** 当前选中对象（公开只读访问，供调试 / E2E） */
  get selectedObject(): PaintableObject | null {
    return this.selected;
  }

  /** 当前选中材质名 */
  get selectedMaterialName(): string | null {
    return this.selectedMaterial;
  }

  private get current(): PaintableObject | null {
    return this.selected;
  }

  private selectObject(id: string) {
    this.selected = this.view.getObject(id) ?? null;
    this.view.setHighlight(id);
    if (this.selected) {
      this.selectedMaterial = this.selected.materialNames[0] ?? null;
      this.view.setSeamVisible(this.selected, this.ui.chkSeams.checked);
      this.preview.refreshSeams(this.selected);
      this.ensureEngineMaterials();
    } else {
      this.selectedMaterial = null;
    }
    this.rebuildMaterialSelect();
    this.preview.update();
  }

  private ensureEngineMaterials() {
    if (!this.selected) return;
    for (const name of this.selected.materialNames) {
      this.selected.engine.ensureMaterial(name, this.resolution);
    }
  }

  private rebuildObjectSelect() {
    const sel = this.ui.objectSelect;
    sel.innerHTML = '';
    for (const obj of this.view.listObjects()) {
      const opt = document.createElement('option');
      opt.value = obj.id;
      opt.textContent = obj.name;
      sel.appendChild(opt);
    }
    if (this.selected) sel.value = this.selected.id;
  }

  private rebuildMaterialSelect() {
    const sel = this.ui.materialSelect;
    sel.innerHTML = '';
    if (!this.selected) {
      const opt = document.createElement('option');
      opt.textContent = '（无对象）';
      sel.appendChild(opt);
      return;
    }
    for (const name of this.selected.materialNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    if (this.selectedMaterial) sel.value = this.selectedMaterial;
  }

  // ---------- 模型导入 ----------

  private async importFiles(files: File[]) {
    if (!files.length) return;
    this.setHint('正在解析模型…');
    try {
      const loaded = await loadModelFiles(files);
      const obj = await createPaintableObject(loaded, this.resolution);
      this.view.addObject(obj);
      this.rebuildObjectSelect();
      this.selectObject(obj.id);
      this.setHint(`已导入 ${obj.name}：${obj.paintMesh.triangleCount} 个三角面，${obj.materialNames.length} 个材质`);
    } catch (err) {
      console.error(err);
      this.setHint(`导入失败：${(err as Error).message}`);
    }
  }

  // ---------- 笔刷 ----------

  private currentBrush(): BrushSettings {
    return {
      ...this.brush,
      color: { ...this.brush.color },
      radius: this.view.localRadius(this.current!, this.brush.radius),
    };
  }

  private syncBrushLabels() {
    this.ui.valSize.textContent = String(Math.round(this.brush.radius * 400));
    this.ui.valHardness.textContent = `${Math.round(this.brush.hardness * 100)}%`;
    this.ui.valOpacity.textContent = `${Math.round(this.brush.opacity * 100)}%`;
    this.ui.btnEraser.classList.toggle('active', this.brush.eraser);
  }

  private syncHistoryButtons() {
    const engine = this.current?.engine;
    this.ui.btnUndo.disabled = !engine?.canUndo;
    this.ui.btnRedo.disabled = !engine?.canRedo;
  }

  // ---------- 指针交互 ----------

  private canPaint(): boolean {
    return (
      !!this.current &&
      !!this.selectedMaterial &&
      !this.navMode &&
      !this.view.orbit.spaceNavigation
    );
  }

  private pickAt(e: PointerEvent): PointerHit | null {
    if (!this.current || !this.selectedMaterial) return null;
    return this.view.pick(
      e.clientX,
      e.clientY,
      this.current,
      this.selectedMaterial,
    );
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.canPaint()) return;
    const hit = this.pickAt(e);
    if (!hit || !this.current) return;
    e.preventDefault();
    this.painting = true;
    this.ui.viewport.setPointerCapture(e.pointerId);
    this.view.beginPaint(
      this.current,
      this.selectedMaterial!,
      this.currentBrush(),
      hit,
      this.resolution,
    );
    this.preview.update();
  };

  private onPointerMove = (e: PointerEvent) => {
    // 光标反馈（非绘制时也要显示）
    if (this.canPaint() && this.current && this.selectedMaterial) {
      const hit = this.pickAt(e);
      if (hit) {
        this.view.updateCursor(
          this.current,
          hit.point,
          this.currentBrush().radius,
          this.brush.eraser,
        );
      } else {
        this.view.hideCursor();
      }
    } else {
      this.view.hideCursor();
    }

    if (!this.painting || !this.current) return;
    const hit = this.pickAt(e);
    if (!hit) return;
    this.view.applyStrokePoint(hit);
    this.preview.update();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.painting) return;
    this.painting = false;
    try {
      this.ui.viewport.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    this.view.endPaint();
  };

  // ---------- 纹理操作 ----------

  private newBaseTexture(checker: boolean) {
    if (!this.current || !this.selectedMaterial) return;
    const layer = new TextureLayer(this.resolution, this.resolution, [
      180, 180, 180, 255,
    ]);
    if (checker) layer.fillChecker(8);
    this.current.engine.setBaseTexture(this.selectedMaterial, layer);
    this.afterTextureChange();
  }

  private afterTextureChange() {
    if (!this.current || !this.selectedMaterial) return;
    this.view.refreshTexture(this.current, this.selectedMaterial);
    this.view.setPaintOnly(this.current, this.ui.chkPaintOnly.checked);
    this.preview.update();
  }

  private undo() {
    const obj = this.current;
    if (!obj) return;
    if (obj.engine.undo()) {
      this.view.refreshAllTextures(obj);
      this.syncHistoryButtons();
      this.preview.update();
    }
  }

  private redo() {
    const obj = this.current;
    if (!obj) return;
    if (obj.engine.redo()) {
      this.view.refreshAllTextures(obj);
      this.syncHistoryButtons();
      this.preview.update();
    }
  }

  // ---------- 工程保存 / 恢复 ----------

  private saveProject() {
    const objects = this.view.listObjects();
    if (!objects.length) {
      this.setHint('没有可保存的对象');
      return;
    }
    const payload = buildProjectFile(
      objects.map((o) => ({
        name: o.name,
        format: o.format,
        files: o.files,
        materials: o.materialNames.map((name) => {
          const state = o.engine.getMaterialState(name)!;
          return {
            name,
            resolution: state.resolution,
            base: state.base,
            paint: state.paint,
          };
        }),
      })),
      { ...this.brush, resolution: this.resolution },
    );
    downloadText(
      JSON.stringify(payload),
      `meshpaint-${new Date().toISOString().slice(0, 10)}.tpp.json`,
    );
    this.setHint('工程已保存（模型与纹理均内嵌在单个 JSON 中）');
  }

  private async loadProject(file: File) {
    try {
      const text = await file.text();
      const project = JSON.parse(text) as ProjectFile;
      if (project.app !== 'meshpaint3d') throw new Error('不是 MeshPaint 工程文件');

      this.resolution = project.brush.resolution;
      this.ui.resolution.value = String(this.resolution);
      this.brush = {
        radius: project.brush.radius,
        hardness: project.brush.hardness,
        opacity: project.brush.opacity,
        color: { ...project.brush.color },
        eraser: project.brush.eraser,
      };
      this.ui.color.value = rgbToHex(this.brush.color);
      this.ui.size.value = String(Math.round(this.brush.radius * 400));
      this.ui.hardness.value = String(this.brush.hardness * 100);
      this.ui.opacity.value = String(this.brush.opacity * 100);
      this.syncBrushLabels();

      let first: PaintableObject | null = null;
      // 恢复工程前清空现有对象，避免同名叠加
      for (const existing of this.view.listObjects()) {
        this.view.removeObject(existing.id);
      }
      this.selected = null;
      this.selectedMaterial = null;
      for (const record of project.objects) {
        const files = [...projectModelFiles(record).entries()].map(([name, bytes]) => {
          const ref = record.modelFiles.find((f) => f.name === name)!;
          return bytesToFile(bytes, name, ref.mime);
        });
        const loaded = await loadModelFiles(files);
        const obj = await createPaintableObject(loaded, this.resolution);
        for (const mat of record.materials) {
          const [base, paint] = await Promise.all([
            pngDataUrlToLayer(mat.basePng),
            pngDataUrlToLayer(mat.paintPng),
          ]);
          obj.engine.setBaseTexture(mat.name, base);
          const state = obj.engine.getMaterialState(mat.name)!;
          state.paint = paint;
        }
        this.view.addObject(obj);
        first ??= obj;
      }
      this.rebuildObjectSelect();
      if (first) this.selectObject(first.id);
      this.setHint(`工程已恢复：${project.objects.length} 个对象`);
    } catch (err) {
      console.error(err);
      this.setHint(`工程恢复失败：${(err as Error).message}`);
    }
  }

  private exportTextures() {
    const obj = this.current;
    if (!obj || !this.selectedMaterial) {
      this.setHint('没有可导出的纹理');
      return;
    }
    const records = obj.materialNames.map((name) => {
      const state = obj.engine.getMaterialState(name)!;
      const composite = new TextureLayer(state.resolution, state.resolution);
      composite.data.set(compositeLayers(state.base, state.paint));
      const { blob, filename } = exportLayerPng(composite, obj.name, name);
      downloadBlob(blob, filename);
      return {
        name,
        resolution: state.resolution,
      };
    });
    const binding = buildBinding(
      obj.name,
      records.map((r) => ({
        name: r.name,
        resolution: r.resolution,
        basePng: '',
        paintPng: '',
      })),
    );
    downloadText(
      JSON.stringify(binding, null, 2),
      `${obj.name.replace(/[^\w.-]+/g, '_')}__binding.json`,
    );
    this.setHint(`已导出 ${records.length} 张纹理 PNG 与 binding.json`);
  }

  // ---------- 事件绑定 ----------

  private bindEvents() {
    const ui = this.ui;
    ui.viewport.addEventListener('pointerdown', this.onPointerDown);
    ui.viewport.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    ui.viewport.addEventListener('pointerleave', () => this.view.hideCursor());

    ui.objectSelect.addEventListener('change', () => this.selectObject(ui.objectSelect.value));
    ui.materialSelect.addEventListener('change', () => {
      this.selectedMaterial = ui.materialSelect.value;
      this.preview.refreshSeams(this.selected!);
      this.preview.update();
      this.syncHistoryButtons();
    });

    ui.btnPaintMode.addEventListener('click', () => this.setMode(false));
    ui.btnNavMode.addEventListener('click', () => this.setMode(true));

    ui.color.addEventListener('input', () => {
      const { r, g, b } = hexToRgb(ui.color.value);
      this.brush.color = { r, g, b };
    });
    ui.size.addEventListener('input', () => {
      this.brush.radius = Number(ui.size.value) / 400;
      this.syncBrushLabels();
    });
    ui.hardness.addEventListener('input', () => {
      this.brush.hardness = Number(ui.hardness.value) / 100;
      this.syncBrushLabels();
    });
    ui.opacity.addEventListener('input', () => {
      this.brush.opacity = Number(ui.opacity.value) / 100;
      this.syncBrushLabels();
    });
    ui.btnEraser.addEventListener('click', () => {
      this.brush.eraser = !this.brush.eraser;
      this.syncBrushLabels();
    });
    ui.btnUndo.addEventListener('click', () => this.undo());
    ui.btnRedo.addEventListener('click', () => this.redo());

    ui.resolution.addEventListener('change', () => {
      this.resolution = Number(ui.resolution.value);
      this.ensureEngineMaterials();
    });
    ui.btnNewLayer.addEventListener('click', () => this.newBaseTexture(false));
    ui.btnChecker.addEventListener('click', () => this.newBaseTexture(true));

    ui.chkPaintOnly.addEventListener('change', () => {
      if (this.selected) {
        this.view.setPaintOnly(this.selected, ui.chkPaintOnly.checked);
        this.preview.update();
      }
    });
    ui.chkSeams.addEventListener('change', () => {
      if (this.selected) {
        this.view.setSeamVisible(this.selected, ui.chkSeams.checked);
        this.preview.update();
      }
    });
    ui.chkUv.addEventListener('change', () => this.preview.update());

    ui.btnOpen.addEventListener('click', () => ui.fileOpen.click());
    ui.fileOpen.addEventListener('change', () => {
      this.importFiles([...(ui.fileOpen.files ?? [])]);
      ui.fileOpen.value = '';
    });
    ui.btnSave.addEventListener('click', () => this.saveProject());
    ui.btnLoad.addEventListener('click', () => ui.fileProject.click());
    ui.fileProject.addEventListener('change', () => {
      const f = ui.fileProject.files?.[0];
      if (f) this.loadProject(f);
      ui.fileProject.value = '';
    });
    ui.btnExport.addEventListener('click', () => this.exportTextures());

    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        this.undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveProject();
      }
    });
  }

  private setMode(nav: boolean) {
    this.navMode = nav;
    this.ui.btnPaintMode.classList.toggle('active', !nav);
    this.ui.btnNavMode.classList.toggle('active', nav);
    this.ui.viewport.style.cursor = nav ? 'grab' : 'crosshair';
  }

  private setHint(text: string) {
    this.ui.hint.textContent = text;
  }
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
