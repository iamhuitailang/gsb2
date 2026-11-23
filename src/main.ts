import './style.css';
import { OrbitCamera, type CameraSnapshot } from './camera';
import { LabelLayer } from './labels';
import { Panel } from './panel';
import { WebGL2Renderer } from './renderer';
import {
  buildDenseScene,
  buildExtraBatch,
  buildSparseScene,
} from './scenes';
import { storage } from './storage';
import { InstanceStore } from './store';
import type { PickResult, SerializedLayout } from './types';
import type { Vec3 } from './math';

class App {
  private canvas: HTMLCanvasElement;
  private renderer: WebGL2Renderer;
  private camera = new OrbitCamera();
  private store = new InstanceStore();
  private panel = new Panel();
  private labels: LabelLayer;
  private crosshair: HTMLElement;

  private selectedId: number | null = null;
  private lastPick: PickResult | null = null;
  private pickLog: PickResult[] = [];
  private extraBatches = 0;

  private frozen = false;
  private frozenCamera: CameraSnapshot | null = null;

  private pointer = {
    down: false,
    moved: false,
    startX: 0,
    startY: 0,
    button: 0,
  };

  constructor() {
    this.canvas = document.getElementById('gl') as HTMLCanvasElement;
    this.renderer = new WebGL2Renderer(this.canvas);
    this.labels = new LabelLayer(
      document.getElementById('label-layer') as HTMLElement,
    );
    this.crosshair = document.getElementById('crosshair') as HTMLElement;

    buildSparseScene(this.store);
    this.bindEvents();
    this.restoreSavedLayoutIfAny();
    this.handleResize();
    this.loop();
  }

  /** 启动时若本地保存过布局则自动恢复（保存动作见“保存到本地”按钮） */
  private restoreSavedLayoutIfAny(): void {
    const data = storage.loadLayout();
    if (data && Array.isArray(data.instances) && data.instances.length > 0) {
      this.applyLayoutData(data);
      this.panel.setSaveStatus(
        `已自动恢复本地布局（${data.instances.length} 个实例）`,
      );
    }
  }

  // ---------------- 场景与尺寸 ----------------

  private loadScene(kind: 'sparse' | 'dense'): void {
    this.store = new InstanceStore();
    this.extraBatches = 0;
    this.selectedId = null;
    this.lastPick = null;
    this.panel.clearPickResult();
    if (kind === 'sparse') buildSparseScene(this.store);
    else buildDenseScene(this.store);
    this.camera.reset();
    this.frozen = false;
    this.frozenCamera = null;
  }

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.renderer.resize(rect.width, rect.height, dpr);
    this.camera.setAspect(rect.width / Math.max(1, rect.height));
  }

  private currentDrawList() {
    return this.store.buildDrawList(
      this.panel.chkFrustum.checked,
      this.camera.viewProj(),
    );
  }

  // ---------------- 主循环 ----------------

  private loop = (): void => {
    const drawList = this.currentDrawList();
    const stats = this.renderer.render(
      this.store,
      drawList,
      this.camera,
      this.selectedId,
    );

    this.labels.update(
      drawList,
      new Map(this.store.getAll().map((i) => [i.id, i])),
      this.renderer,
      this.camera,
      this.selectedId,
      this.panel.chkLabels.checked,
    );

    this.panel.updateStats({
      total: this.store.getAll().length,
      visibleCount: this.store.getAll().filter((i) => i.visible).length,
      render: stats,
      frozen: this.frozen,
    });
    const selected =
      this.selectedId != null ? this.store.get(this.selectedId) ?? null : null;
    this.panel.updateSelection(selected, drawList);

    requestAnimationFrame(this.loop);
  };

  // ---------------- 点选 ----------------

  private doPick(cssX: number, cssY: number): PickResult {
    const drawList = this.currentDrawList();
    const result = this.renderer.pick(
      this.store,
      drawList,
      this.camera,
      cssX,
      cssY,
      this.panel.chkNeighbor.checked,
      this.frozen,
    );
    this.lastPick = result;
    this.panel.showPickResult(result);
    this.panel.appendPickLog(result);
    this.pickLog.push(result);
    storage.savePicks(this.pickLog);

    if (result.hitId !== 0 && this.store.get(result.hitId)) {
      this.selectedId = result.hitId;
    } else {
      this.selectedId = null;
    }
    this.placeCrosshair(cssX, cssY);
    return result;
  }

  private placeCrosshair(cssX: number, cssY: number): void {
    this.crosshair.hidden = false;
    this.crosshair.style.left = `${cssX}px`;
    this.crosshair.style.top = `${cssY}px`;
  }

  // ---------------- 事件绑定 ----------------

  private bindEvents(): void {
    const p = this.panel;

    p.btnSparse.addEventListener('click', () => this.loadScene('sparse'));
    p.btnDense.addEventListener('click', () => this.loadScene('dense'));
    p.btnAddBatch.addEventListener('click', () => {
      buildExtraBatch(this.store, ++this.extraBatches);
    });
    p.btnResetCam.addEventListener('click', () => this.camera.reset());

    p.btnHideSelected.addEventListener('click', () =>
      this.withSelected((id) => this.store.hideSelected([id])),
    );
    p.btnShowAll.addEventListener('click', () => this.store.showAll());
    p.btnDeleteSelected.addEventListener('click', () =>
      this.withSelected((id) => {
        this.store.deleteIds([id]);
        if (this.selectedId === id) this.selectedId = null;
      }),
    );
    p.btnShuffle.addEventListener('click', () =>
      this.store.shuffleDrawOrder(),
    );
    p.btnMirrorBatch.addEventListener('click', () =>
      this.transformSelectedBatch((inst) => {
        inst.scale = [-inst.scale[0], inst.scale[1], inst.scale[2]];
      }),
    );
    p.btnRandomBatch.addEventListener('click', () =>
      this.transformSelectedBatch((inst) => {
        inst.rotationDeg = [
          (Math.random() * 90 - 45),
          (Math.random() * 360),
          (Math.random() * 90 - 45),
        ];
        const k = 0.7 + Math.random() * 0.9;
        inst.scale = [
          k * (Math.random() < 0.2 ? -1 : 1),
          0.6 + Math.random() * 1.1,
          0.6 + Math.random() * 1.1,
        ];
      }),
    );

    p.btnSelHide.addEventListener('click', () =>
      this.withSelected((id) => this.store.hideSelected([id])),
    );
    p.btnSelDelete.addEventListener('click', () =>
      this.withSelected((id) => {
        this.store.deleteIds([id]);
        if (this.selectedId === id) this.selectedId = null;
      }),
    );

    for (const el of [
      p.inTx, p.inTy, p.inTz,
      p.inRx, p.inRy, p.inRz,
      p.inSx, p.inSy, p.inSz,
    ]) {
      el.addEventListener('change', () => this.applyTransformInputs());
    }

    p.btnRepick.addEventListener('click', () => {
      if (this.lastPick) {
        this.doPick(this.lastPick.cssX, this.lastPick.cssY);
      }
    });
    p.btnClearPick.addEventListener('click', () => {
      this.lastPick = null;
      this.selectedId = null;
      this.crosshair.hidden = true;
      this.panel.clearPickResult();
    });
    p.btnClearLog.addEventListener('click', () => {
      this.pickLog = [];
      this.panel.clearPickLog();
      storage.savePicks([]);
    });

    // 冻结：固定视角快照，之后的点选在同一相机参数下重测
    p.btnFreeze.addEventListener('click', () => {
      if (!this.frozen) {
        this.frozenCamera = this.camera.snapshot();
        this.frozen = true;
      } else {
        this.frozen = false;
        if (this.frozenCamera) this.camera.restore(this.frozenCamera);
        this.frozenCamera = null;
      }
    });
    p.btnRestore.addEventListener('click', () => {
      // 恢复到冻结时的视角（布局本身未被冻结改变）
      if (this.frozenCamera) this.camera.restore(this.frozenCamera);
    });

    p.btnSave.addEventListener('click', () => this.saveLayout());
    p.btnLoad.addEventListener('click', () => this.loadLayout());
    p.btnExportLayout.addEventListener('click', () => {
      storage.download(
        `layout-${Date.now()}.json`,
        this.buildSerializedLayout(),
      );
    });
    p.btnImportLayout.addEventListener('click', () =>
      p.fileImport.click(),
    );
    p.fileImport.addEventListener('change', () =>
      this.importLayoutFile(),
    );
    p.btnExportPicks.addEventListener('click', () => {
      storage.download(`pick-results-${Date.now()}.json`, this.pickLog);
      this.panel.setSaveStatus(`已导出 ${this.pickLog.length} 条点选记录`);
    });

    // 指针：按下记录起点，移动超过阈值视为相机操作，抬起时未移动才算点击
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointer = {
        down: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        button: e.button,
      };
    });
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.panel.updateHud(this.renderer.dpr, {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      if (!this.pointer.down) return;
      const dx = e.clientX - this.pointer.startX;
      const dy = e.clientY - this.pointer.startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) this.pointer.moved = true;
      if (!this.pointer.moved) return;

      const rectNow = this.canvas.getBoundingClientRect();
      if (this.pointer.button === 2 || e.shiftKey) {
        this.camera.pan(dx, dy, rectNow.width, rectNow.height);
      } else {
        this.camera.rotate(dx, dy);
      }
      // 以当前位置为新起点，形成连续拖动
      this.pointer.startX = e.clientX;
      this.pointer.startY = e.clientY;
    });
    this.canvas.addEventListener('pointerup', (e) => {
      const wasDown = this.pointer.down;
      const wasMoved = this.pointer.moved;
      this.pointer.down = false;
      if (wasDown && !wasMoved && e.button === 0) {
        const rect = this.canvas.getBoundingClientRect();
        this.doPick(e.clientX - rect.left, e.clientY - rect.top);
      }
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.camera.zoom(e.deltaY);
      },
      { passive: false },
    );

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        this.withSelected((id) => {
          this.store.deleteIds([id]);
          if (this.selectedId === id) this.selectedId = null;
        });
      } else if (e.key === 'h' || e.key === 'H') {
        this.withSelected((id) => this.store.hideSelected([id]));
      }
    });

    const ro = new ResizeObserver(() => this.handleResize());
    ro.observe(this.canvas);
    window.addEventListener('resize', () => this.handleResize());

    // 启动时尝试恢复上次点选记录
    this.pickLog = storage.loadPicks();
    for (const item of this.pickLog.slice(-10).reverse()) {
      this.panel.appendPickLog(item);
    }
  }

  private withSelected(fn: (id: number) => void): void {
    if (this.selectedId != null) fn(this.selectedId);
  }

  private transformSelectedBatch(fn: (inst: import('./types').InstanceData) => void): void {
    if (this.selectedId == null) return;
    const target = this.store.get(this.selectedId);
    if (!target) return;
    for (const inst of this.store.getAll()) {
      if (inst.batchId === target.batchId) fn(inst);
    }
  }

  private applyTransformInputs(): void {
    if (this.panel.isSyncingInputs || this.selectedId == null) return;
    const inst = this.store.get(this.selectedId);
    if (!inst) return;
    const t = this.panel.readTransformInputs();
    // 缩放为 0 会让矩阵不可逆（无法反算局部命中点），钳掉
    inst.position = t.position;
    inst.rotationDeg = t.rotationDeg;
    inst.scale = t.scale.map((s) => (Math.abs(s) < 1e-4 ? 1e-4 : s)) as Vec3;
  }

  // ---------------- 持久化 ----------------

  private buildSerializedLayout(): SerializedLayout {
    const data = this.store.serialize();
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      instances: data.instances,
      nextId: data.nextId,
      nextBatchId: data.nextBatchId,
      cameraSnapshot: this.camera.snapshot(),
    };
  }

  private saveLayout(): void {
    const data = this.store.serialize();
    storage.saveLayout({
      ...data,
      cameraSnapshot: this.camera.snapshot(),
      savedAt: new Date().toISOString(),
    });
    this.panel.setSaveStatus(
      `已保存 ${data.instances.length} 个实例到 localStorage`,
    );
  }

  private loadLayout(): void {
    const data = storage.loadLayout();
    if (!data) {
      this.panel.setSaveStatus('本地没有可读取的布局');
      return;
    }
    this.applyLayoutData(data);
    this.panel.setSaveStatus(
      `已读取 ${data.instances.length} 个实例`,
    );
  }

  private applyLayoutData(data: {
    instances: SerializedLayout['instances'];
    nextId: number;
    nextBatchId: number;
    drawOrder?: number[];
    cameraSnapshot?: CameraSnapshot;
  }): void {
    this.store = InstanceStore.deserialize(data);
    this.selectedId = null;
    this.lastPick = null;
    this.panel.clearPickResult();
    if (data.cameraSnapshot) this.camera.restore(data.cameraSnapshot);
  }

  private importLayoutFile(): void {
    const file = this.panel.fileImport.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as SerializedLayout;
        if (parsed.version !== 1 || !Array.isArray(parsed.instances)) {
          throw new Error('布局文件格式不符');
        }
        this.applyLayoutData({
          instances: parsed.instances,
          nextId: parsed.nextId,
          nextBatchId: parsed.nextBatchId,
          cameraSnapshot:
            parsed.cameraSnapshot as CameraSnapshot | undefined,
        });
        this.panel.setSaveStatus(`已导入布局文件（${parsed.instances.length} 个实例）`);
      } catch (err) {
        this.panel.setSaveStatus(`导入失败：${(err as Error).message}`);
      }
      this.panel.fileImport.value = '';
    };
    reader.readAsText(file);
  }
}

new App();
