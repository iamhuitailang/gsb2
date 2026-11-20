import type { CameraData, GeometryKind, GizmoMode, SceneFile, TransformSpace } from './core/types';
import { SceneDocument } from './core/document';
import {
  AddCommand,
  DeleteCommand,
  DuplicateCommand,
  History,
  LoadCommand,
} from './core/history';
import { parseSceneFile } from './core/loader';
import { SceneRenderer } from './render/renderer';
import { GizmoController } from './render/gizmo';
import { TreePanel } from './ui/tree-panel';
import { InspectorPanel } from './ui/inspector-panel';
import { BUILTIN_SCENES } from './scenes/builtins';

const AUTOSAVE_KEY = 'mini-scene-editor.autosave.v1';
const PICK_DRAG_PX = 5; // 点击与轨道拖动的区分阈值

/**
 * 编辑器主控制器：把文档、历史、渲染器、gizmo、场景树、检查器和 DOM 工具条接起来。
 */
export class EditorController {
  private doc = new SceneDocument();
  private history = new History();
  private renderer: SceneRenderer;
  private gizmo: GizmoController;
  private inspector: InspectorPanel;

  private space: TransformSpace = 'world';

  /** 当前点击位置的重叠命中队列（从前到后） */
  private pickQueue: string[] = [];
  private pickCursor = 0;
  private pointerDown: { x: number; y: number } | null = null;

  constructor() {
    const canvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
    const initialCamera: CameraData = {
      position: [7, 6, 9],
      target: [0, 0.6, 0],
      up: [0, 1, 0],
      fov: 50,
      near: 0.1,
      far: 1000,
    };

    this.renderer = new SceneRenderer(canvas, this.doc, initialCamera);
    this.gizmo = new GizmoController(this.renderer, this.doc, this.history, (m) =>
      this.setStatus(m),
    );
    new TreePanel(
      document.getElementById('tree-root')!,
      this.doc,
      this.history,
      (m, kind) => this.setStatus(m, kind),
    );
    this.inspector = new InspectorPanel(
      document.getElementById('inspector')!,
      this.doc,
      this.history,
      (m, kind) => this.setStatus(m, kind),
    );

    this.bindSelection();
    this.bindToolbar();
    this.bindViewportPicking(canvas);
    this.bindKeyboard();
    this.bindFileIO();
    this.bindSampleLoader();
    this.bindNewObjectButtons();

    this.loadInitialScene();
    this.startRenderLoop();
  }

  // ---------- 选择 ----------

  private bindSelection(): void {
    this.doc.subscribe((change) => {
      if (change.type === 'selection') {
        this.gizmo.attachToSelection();
        this.renderer.setHighlight(this.doc.selection);
        this.updateSelectionStatus();
      }
      if (change.type === 'transform' && this.doc.selection) {
        this.renderer.setHighlight(this.doc.selection);
      }
    });
    this.history.subscribe(() => this.updateUndoRedoButtons());
  }

  // ---------- 工具条 ----------

  private bindToolbar(): void {
    document.getElementById('mode-group')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-mode]') as HTMLButtonElement | null;
      if (!btn) return;
      this.setMode(btn.dataset.mode as GizmoMode);
    });
    document.getElementById('space-group')!.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button[data-space]') as HTMLButtonElement | null;
      if (!btn) return;
      this.setSpace(btn.dataset.space as TransformSpace);
    });
    document.getElementById('btn-duplicate')!.addEventListener('click', () => this.duplicate());
    document.getElementById('btn-delete')!.addEventListener('click', () => this.deleteSelected());
    document.getElementById('btn-undo')!.addEventListener('click', () => this.history.undo());
    document.getElementById('btn-redo')!.addEventListener('click', () => this.history.redo());
  }

  private setMode(mode: GizmoMode): void {
    this.gizmo.setMode(mode);
    document.querySelectorAll('#mode-group button').forEach((b) =>
      b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode),
    );
  }

  private setSpace(space: TransformSpace): void {
    this.space = space;
    this.gizmo.setSpace(space);
    this.inspector.setSpace(space);
    document.querySelectorAll('#space-group button').forEach((b) =>
      b.classList.toggle('active', (b as HTMLElement).dataset.space === space),
    );
  }

  // ---------- 拾取与重叠循环 ----------

  private bindViewportPicking(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved > PICK_DRAG_PX) return; // 是轨道相机拖动，不是点选
      if (this.gizmo.isDragging) return;
      this.handlePick(e.clientX, e.clientY);
    });

    document.getElementById('cycle-next')!.addEventListener('click', () => this.cyclePick());
  }

  private handlePick(x: number, y: number): void {
    const hits = this.renderer.pick(x, y);
    if (hits.length === 0) {
      this.pickQueue = [];
      this.doc.select(null);
      this.hideCycleBadge();
      this.setStatus('未命中任何可见对象');
      return;
    }
    this.pickQueue = hits.map((h) => h.nodeId);
    this.pickCursor = 0;
    this.doc.select(this.pickQueue[0]);
    if (hits.length > 1) {
      this.showCycleBadge();
      this.setStatus(`命中 ${hits.length} 个重叠对象，按 Tab 或点击「下一个」前后切换`);
    } else {
      this.hideCycleBadge();
      const node = this.doc.getNode(this.pickQueue[0]);
      this.setStatus(`已选中「${node?.name}」`);
    }
  }

  private cyclePick(): void {
    if (this.pickQueue.length <= 1) return;
    this.pickCursor = (this.pickCursor + 1) % this.pickQueue.length;
    this.doc.select(this.pickQueue[this.pickCursor]);
    this.showCycleBadge();
  }

  private showCycleBadge(): void {
    const badge = document.getElementById('cycle-badge')!;
    badge.hidden = false;
    document.getElementById('cycle-index')!.textContent = String(this.pickCursor + 1);
    document.getElementById('cycle-total')!.textContent = String(this.pickQueue.length);
  }

  private hideCycleBadge(): void {
    document.getElementById('cycle-badge')!.hidden = true;
  }

  // ---------- 复制 / 删除 ----------

  private duplicate(): void {
    const id = this.doc.selection;
    if (!id) {
      this.setStatus('请先选中要复制的对象', 'info');
      return;
    }
    this.history.execute(new DuplicateCommand(this.doc, '复制', id));
    this.setStatus('已深复制选中对象（含全部子节点）');
  }

  private async deleteSelected(): Promise<void> {
    const id = this.doc.selection;
    if (!id) {
      this.setStatus('请先选中要删除的对象', 'info');
      return;
    }
    const node = this.doc.getNode(id)!;
    const childCount = this.doc.getChildren(id).length;
    let keepChildren = false;

    if (childCount > 0) {
      const choice = await this.askDeletePolicy(node.name, childCount);
      if (choice === 'cancel') {
        this.setStatus('已取消删除');
        return;
      }
      keepChildren = choice === 'keep';
    }

    this.history.execute(
      new DeleteCommand(
        this.doc,
        keepChildren ? '删除（保留子对象）' : '删除（含子树）',
        id,
        keepChildren,
      ),
    );
    this.hideCycleBadge();
    this.setStatus(
      keepChildren
        ? '已删除父对象，子对象提升到原父级并保持世界变换'
        : '已删除对象及其整棵子树（可撤销）',
    );
  }

  private askDeletePolicy(
    name: string,
    childCount: number,
  ): Promise<'cancel' | 'keep' | 'remove'> {
    return new Promise((resolve) => {
      const backdrop = document.getElementById('modal-backdrop')!;
      document.getElementById('modal-message')!.textContent =
        `「${name}」下还有 ${childCount} 个直接子对象。删除父对象时如何处理这些子对象？`;
      backdrop.hidden = false;

      const finish = (choice: 'cancel' | 'keep' | 'remove'): void => {
        backdrop.hidden = true;
        resolve(choice);
      };
      document.getElementById('modal-cancel')!.onclick = () => finish('cancel');
      document.getElementById('modal-keep')!.onclick = () => finish('keep');
      document.getElementById('modal-remove')!.onclick = () => finish('remove');
    });
  }

  // ---------- 快捷键 ----------

  private bindKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.history.redo();
        else this.history.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        this.duplicate();
        return;
      }
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        this.saveToFile();
        return;
      }
      if (e.key === 'Delete') {
        e.preventDefault();
        void this.deleteSelected();
        return;
      }
      if (e.key === 'Tab' && this.pickQueue.length > 1) {
        e.preventDefault();
        this.cyclePick();
        return;
      }
      switch (e.key.toLowerCase()) {
        case 'w':
          this.setMode('translate');
          break;
        case 'e':
          this.setMode('rotate');
          break;
        case 'r':
          this.setMode('scale');
          break;
        case 'q':
          this.setSpace(this.space === 'local' ? 'world' : 'local');
          break;
        case 'escape':
          this.doc.select(null);
          this.hideCycleBadge();
          break;
      }
    });
  }

  // ---------- 文件存取 ----------

  private bindFileIO(): void {
    document.getElementById('btn-save')!.addEventListener('click', () => this.saveToFile());
    document.getElementById('btn-open')!.addEventListener('click', () => {
      document.getElementById('file-input')!.click();
    });
    document.getElementById('file-input')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (file) void this.openFile(file);
      input.value = '';
    });
  }

  private currentSnapshot(): SceneFile {
    return this.doc.toSceneFile(this.renderer.getCameraData());
  }

  /** 自动化/调试用只读快照 */
  snapshot(): SceneFile {
    return this.currentSnapshot();
  }

  /** 节点世界原点投影到 canvas 的归一化设备坐标（-1~1），自动化测试用 */
  projectNode(id: string): { x: number; y: number } | null {
    if (!this.doc.has(id)) return null;
    const world = this.doc.getWorldTRS(id).position;
    const projected = world.clone().project(this.renderer.camera);
    const rect = this.renderer.canvas.getBoundingClientRect();
    return {
      x: ((projected.x + 1) / 2) * rect.width,
      y: ((-projected.y + 1) / 2) * rect.height,
    };
  }

  saveToFile(): void {
    const snapshot = this.currentSnapshot();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scene-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    } catch {
      /* 存储不可用时静默，下载已成功 */
    }
    this.setStatus('场景文件已保存（变换、层级、相机均包含在内）');
  }

  async openFile(file: File): Promise<void> {
    let parsed: SceneFile;
    try {
      const text = await file.text();
      // 关键：先完整校验，失败直接抛错，当前文档一行都不会被改动
      parsed = parseSceneFile(text);
    } catch (err) {
      this.setStatus((err as Error).message, 'error');
      return;
    }
    this.applyLoadedScene(parsed, `已打开 ${file.name}`);
  }

  private applyLoadedScene(file: SceneFile, message: string): void {
    const previous = this.currentSnapshot();
    const cmd = new LoadCommand(this.doc, '打开场景', file, (cam) =>
      this.renderer.applyCameraData(cam),
    );
    cmd.setPrevious(previous);
    this.history.execute(cmd);
    this.pickQueue = [];
    this.hideCycleBadge();
    this.setStatus(message);
  }

  // ---------- 内置场景 ----------

  private bindSampleLoader(): void {
    const select = document.getElementById('sample-select') as HTMLSelectElement;
    select.addEventListener('change', () => {
      const key = select.value;
      const label = select.options[select.selectedIndex]?.text ?? key;
      select.value = '';
      if (!key) return;
      const factory = BUILTIN_SCENES[key];
      if (!factory) return;
      // 内置场景同样先过校验，保证路径一致
      const parsed = parseSceneFile(factory());
      this.applyLoadedScene(parsed, `已载入内置场景：${label}`);
    });
  }

  private bindNewObjectButtons(): void {
    // 在工具条注入「新建」下拉（保持 index.html 简洁，这里动态构建）
    const group = document.createElement('div');
    group.className = 'tb-group';
    const label = document.createElement('label');
    label.className = 'tb-label';
    label.textContent = '新建 ';
    const select = document.createElement('select');
    select.innerHTML = `
      <option value="">— 添加对象 —</option>
      <option value="group">分组</option>
      <option value="box">立方体</option>
      <option value="sphere">球体</option>
      <option value="cylinder">圆柱</option>
      <option value="cone">圆锥</option>
      <option value="torus">圆环</option>
      <option value="plane">平面</option>`;
    select.addEventListener('change', () => {
      const kind = select.value;
      select.value = '';
      if (kind) this.createNode(kind);
    });
    label.appendChild(select);
    group.appendChild(label);
    const saveGroup = document.getElementById('btn-save')!.parentElement!;
    saveGroup.parentElement!.insertBefore(group, saveGroup.nextSibling);
  }

  private createNode(kind: string): void {
    const base = {
      position: [0, 0.8, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      visible: true,
    };
    const palette = [0x66a3ff, 0xff9966, 0x6bffb0, 0xffcc66, 0xcc99ff, 0xff6b9d];
    const color = palette[this.doc.getAllNodes().length % palette.length];
    const data =
      kind === 'group'
        ? { ...base, name: this.uniqueName('新分组') }
        : {
            ...base,
            name: this.uniqueName(`新${kind}`),
            geometry: { kind: kind as GeometryKind },
            material: { color },
          };
    this.history.execute(new AddCommand(this.doc, '新建对象', data, this.doc.selection, null));
    this.setStatus('已在选中对象下新建（未选中则挂到场景根）');
  }

  private uniqueName(prefix: string): string {
    const names = new Set(this.doc.getAllNodes().map((n) => n.name));
    let i = 1;
    let name = prefix;
    while (names.has(name)) name = `${prefix} ${++i}`;
    return name;
  }

  // ---------- 初始场景与自动保存 ----------

  private loadInitialScene(): void {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (raw) {
        const parsed = parseSceneFile(raw); // 自动保存坏了也不能阻塞启动
        this.doc.loadValidated(parsed);
        this.renderer.applyCameraData(parsed.camera);
        this.history.clear();
        this.setStatus('已恢复上次自动保存的场景');
        return;
      }
    } catch (err) {
      console.warn('自动保存恢复失败，改用内置示例：', err);
    }
    const parsed = parseSceneFile(BUILTIN_SCENES['sample:diorama']());
    this.doc.loadValidated(parsed);
    this.renderer.applyCameraData(parsed.camera);
    this.history.clear();
    this.setStatus('已载入内置几何体示例场景');
  }

  // ---------- 渲染循环 / 状态栏 ----------

  private startRenderLoop(): void {
    const tick = (): void => {
      this.renderer.renderFrame();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    // 相机静止时也定期自动保存（节流到每 5 秒一次）
    let lastSave = 0;
    setInterval(() => {
      const now = Date.now();
      if (now - lastSave < 5000) return;
      lastSave = now;
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.currentSnapshot()));
      } catch {
        /* 忽略配额/隐私模式错误 */
      }
    }, 5000);
  }

  private setStatus(message: string, kind: 'info' | 'error' = 'info'): void {
    const el = document.getElementById('status-message')!;
    el.textContent = message;
    el.classList.toggle('status-error', kind === 'error');
  }

  private updateSelectionStatus(): void {
    const id = this.doc.selection;
    const node = id ? this.doc.getNode(id) : undefined;
    document.getElementById('status-selection')!.textContent = node
      ? `当前选择：${node.name}${node.visible ? '' : '（已隐藏）'}`
      : '';
  }

  private updateUndoRedoButtons(): void {
    const undo = document.getElementById('btn-undo') as HTMLButtonElement;
    const redo = document.getElementById('btn-redo') as HTMLButtonElement;
    undo.disabled = !this.history.canUndo;
    redo.disabled = !this.history.canRedo;
    undo.title = this.history.canUndo ? `撤销：${this.history.nextUndoLabel} (Ctrl+Z)` : '无可撤销';
    redo.title = this.history.canRedo ? `重做：${this.history.nextRedoLabel} (Ctrl+Shift+Z)` : '无可重做';
  }
}

// 供 main.ts 启动
export function bootstrap(): void {
  const controller = new EditorController();
  // 只读调试/自动化钩子：只暴露查询能力，不提供任何写入
  (window as unknown as { __editor__: unknown }).__editor__ = {
    snapshot: () => controller.snapshot(),
    project: (id: string) => controller.projectNode(id),
  };
}
