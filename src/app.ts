// 应用主控：串联解析、场景构建、渲染、UI 与项目文件存取

import { buildScene, flattenNodes } from './core/build-scene';
import { basename, fetchSampleFiles, readLocalFiles } from './core/files';
import { bbox, mat4, type Mat4 } from './core/math';
import { parseMtl } from './core/mtl-parser';
import { parseObj } from './core/obj-parser';
import { OrbitCamera } from './core/orbit-camera';
import {
  buildProjectFile,
  parseProject,
  projectToSources,
  reconcileMaterialOverrides,
  reconcileNodeOverrides,
  serializeProject,
} from './core/project';
import type {
  CameraState,
  DisplayMode,
  EnvironmentId,
  LoadedSource,
  MaterialOverride,
  NodeOverride,
  ParseWarning,
  ProjectFile,
  SceneModel,
  SceneNode,
} from './core/types';
import { GLRenderer } from './render/renderer';
import { DetailsPanel } from './ui/details-panel';
import { downloadText, h, toast } from './ui/dom';
import { MaterialPanel } from './ui/material-panel';
import { TreeView } from './ui/tree-view';
import { WarningPanel } from './ui/warning-panel';

const SAMPLE_FILES = ['sample-model.obj', 'sample-material.mtl', 'checkerboard.png'];
const ACCEPT = '.obj,.mtl,.png,.jpg,.jpeg,.webp,.gif,.bmp';

export class App {
  private renderer: GLRenderer;
  private camera = new OrbitCamera();
  private canvas: HTMLCanvasElement;

  private sources: LoadedSource[] = [];
  private model: SceneModel | null = null;
  private nodes = new Map<string, SceneNode>();
  private nodeOverrides = new Map<string, NodeOverride>();
  private materialOverrides = new Map<string, MaterialOverride>();
  private selectedNodeId: string | null = null;

  private tree: TreeView;
  private warnings: WarningPanel;
  private details: DetailsPanel;
  private materials: MaterialPanel;

  private fileInput: HTMLInputElement;
  private projectInput: HTMLInputElement;
  private hasFramedOnce = false;
  private disposed = false;

  constructor() {
    this.canvas = document.getElementById('gl-canvas') as HTMLCanvasElement;
    this.renderer = new GLRenderer(this.canvas);

    this.tree = new TreeView(document.getElementById('scene-tree')!, {
      onSelect: (id) => this.selectNode(id),
      onToggleHidden: (id) => this.toggleHidden(id),
      onFocus: (id) => this.focusNode(id),
      onPickColor: (id, color) => this.setNodeColor(id, color),
      onClearColor: (id) => this.setNodeColor(id, null),
    });

    this.warnings = new WarningPanel(
      document.getElementById('warning-list')!,
      document.getElementById('warning-summary')!,
      { onLocate: (w) => this.locateWarning(w) },
    );
    this.details = new DetailsPanel(document.getElementById('details-panel')!);
    this.materials = new MaterialPanel(
      document.getElementById('material-panel')!,
      (name, override) => this.applyMaterialOverride(name, override),
    );

    this.fileInput = h('input', {
      type: 'file',
      accept: ACCEPT,
      multiple: 'true',
      style: 'display:none',
    }) as HTMLInputElement;
    this.fileInput.addEventListener('change', () => {
      if (this.fileInput.files && this.fileInput.files.length > 0) {
        void this.loadFromFiles(this.fileInput.files);
      }
      this.fileInput.value = '';
    });

    this.projectInput = h('input', {
      type: 'file',
      accept: '.json,.mvproj',
      style: 'display:none',
    }) as HTMLInputElement;
    this.projectInput.addEventListener('change', () => {
      if (this.projectInput.files && this.projectInput.files[0]) {
        void this.openProject(this.projectInput.files[0]);
      }
      this.projectInput.value = '';
    });
    document.body.append(this.fileInput, this.projectInput);

    this.buildToolbar();
    this.buildViewToolbar();
    this.bindPointer();
    this.bindResize();
    this.bindDragDrop();
    this.refreshAll();
    this.renderLoop();
  }

  // ---------------- 工具栏 ----------------

  private buildToolbar(): void {
    const bar = document.getElementById('toolbar')!;
    const openBtn = h('button', { className: 'btn btn-primary', textContent: '📂 打开文件' });
    openBtn.addEventListener('click', () => this.fileInput.click());

    const sampleBtn = h('button', { className: 'btn', textContent: '🧪 载入示例' });
    sampleBtn.addEventListener('click', () => void this.loadSample());

    const saveBtn = h('button', { className: 'btn', textContent: '💾 保存项目' });
    saveBtn.addEventListener('click', () => this.saveProject());

    const openProjectBtn = h('button', { className: 'btn', textContent: '📁 打开项目' });
    openProjectBtn.addEventListener('click', () => this.projectInput.click());

    bar.append(openBtn, sampleBtn, saveBtn, openProjectBtn);
  }

  private buildViewToolbar(): void {
    const bar = document.getElementById('view-toolbar')!;

    const modeGroup = h('div', { className: 'control-group' },
      h('span', { className: 'control-label', textContent: '显示模式' }),
    );
    const modes: { id: DisplayMode; label: string }[] = [
      { id: 'material', label: '材质' },
      { id: 'wireframe', label: '线框' },
      { id: 'normal', label: '法线' },
    ];
    for (const mode of modes) {
      const btn = h('button', {
        className: `btn btn-toggle ${this.renderer.displayMode === mode.id ? 'active' : ''}`,
        'data-mode': mode.id,
        textContent: mode.label,
      });
      btn.addEventListener('click', () => {
        this.renderer.setDisplayMode(mode.id);
        bar.querySelectorAll('[data-mode]').forEach((el) =>
          el.classList.toggle('active', el.getAttribute('data-mode') === mode.id),
        );
      });
      modeGroup.append(btn);
    }

    const envGroup = h('div', { className: 'control-group' },
      h('span', { className: 'control-label', textContent: '光照环境' }),
    );
    const envSelect = h('select', { className: 'select' }) as HTMLSelectElement;
    for (const env of [
      { id: 'studio', label: '摄影棚' },
      { id: 'daylight', label: '日光' },
      { id: 'night', label: '夜晚' },
    ] as const) {
      envSelect.append(h('option', { value: env.id, textContent: env.label }));
    }
    envSelect.addEventListener('change', () => {
      this.renderer.setEnvironment(envSelect.value as EnvironmentId);
    });
    envGroup.append(envSelect);

    const resetCamBtn = h('button', { className: 'btn', textContent: '复位镜头' });
    resetCamBtn.addEventListener('click', () => {
      if (this.model) this.frameBox(this.model.root.bbox);
    });

    bar.append(modeGroup, envGroup, resetCamBtn);
  }

  // ---------------- 加载管线 ----------------

  async loadFromFiles(fileList: FileList | File[]): Promise<void> {
    try {
      const sources = await readLocalFiles(fileList);
      if (sources.length === 0) {
        toast('未发现可识别的模型文件（支持 OBJ / MTL / 常见图片格式）', 'error');
        return;
      }
      await this.loadSources(sources, { frame: true });
    } catch (err) {
      toast(`文件读取失败：${(err as Error).message}`, 'error');
    }
  }

  async loadSample(): Promise<void> {
    try {
      const sources = await fetchSampleFiles(SAMPLE_FILES);
      await this.loadSources(sources, { frame: true });
      toast('示例模型已载入，警告面板列出了内置的各类读取问题');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  /** 从任意 LoadedSource 集合构建场景；frame=false 时保持当前相机（切换/重开模型不跳镜头） */
  async loadSources(sources: LoadedSource[], opts: { frame: boolean; camera?: CameraState }): Promise<void> {
    const objs = sources.filter((s) => s.kind === 'obj');
    if (objs.length === 0) {
      toast('没有找到 OBJ 文件，请连同 OBJ 一起选择', 'error');
      return;
    }
    if (objs.length > 1) {
      toast('检测到多个 OBJ，仅载入第一个，其余已忽略', 'error');
    }
    const objSource = objs[0];
    const parsed = parseObj(objSource.text ?? '', objSource.name);

    // 按 mtllib 声明顺序匹配已载入的 mtl；声明了但没提供文件也要告警
    const mtlSources = sources.filter((s) => s.kind === 'mtl');
    const mtls = [];
    for (const lib of parsed.mtllibs) {
      const match = mtlSources.find((s) => basename(s.name) === basename(lib));
      if (match) {
        mtls.push(parseMtl(match.text ?? '', match.name));
      } else {
        parsed.warnings.push({
          level: 'warn',
          code: 'MTL_FILE_MISSING',
          message: `mtllib 声明的材质库 "${lib}" 未在已载入文件中找到，相关材质将按缺失处理`,
          file: objSource.name,
          line: null,
        });
      }
    }

    // 声明了 mtllib 但用户多给了未被引用的 mtl，也提示一下
    const referenced = new Set(parsed.mtllibs.map((l) => basename(l)));
    for (const m of mtlSources) {
      if (parsed.mtllibs.length > 0 && !referenced.has(basename(m.name))) {
        parsed.warnings.push({
          level: 'warn',
          code: 'MTL_NOT_REFERENCED',
          message: `材质库 "${m.name}" 没有被 OBJ 的 mtllib 引用，已忽略`,
          file: m.name,
          line: null,
        });
      }
    }

    const textureSources = sources.filter((s) => s.kind === 'texture' && s.dataUrl);
    const availableTextures = new Set(textureSources.map((s) => basename(s.name)));

    const model = buildScene({
      parsed,
      mtls,
      availableTextures,
      objFileName: objSource.name,
    });

    this.sources = sources;
    this.model = model;
    this.nodes = flattenNodes(model.root);
    this.nodeOverrides = new Map();
    this.materialOverrides = new Map();
    this.selectedNodeId = null;

    this.renderer.registerTextureFiles(
      textureSources
        .filter((s): s is LoadedSource & { dataUrl: string } => Boolean(s.dataUrl))
        .map((s) => ({ name: basename(s.name), dataUrl: s.dataUrl! })),
    );
    await this.renderer.setModel(model);
    this.renderer.setMaterialOverrides(this.materialOverrides);
    this.renderer.setSelectedNode(null);

    if (opts.camera) {
      this.camera.setState(opts.camera);
    } else if (opts.frame || !this.hasFramedOnce) {
      this.frameBox(model.root.bbox);
      this.hasFramedOnce = true;
    }
    // frame=false 且已有相机姿态时：保持不动，避免镜头跳到不可见位置

    this.refreshAll();
    this.updateStatusBar();

    if (model.warnings.length > 0) {
      toast(`模型已载入，存在 ${model.warnings.length} 条读取警告，可用部分正常显示`);
    } else {
      toast('模型已载入，未发现读取问题');
    }
  }

  // ---------------- 节点交互 ----------------

  private selectNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return; // 稳定 ID 找不到时直接忽略，杜绝重名选错
    this.selectedNodeId = id;
    this.renderer.setSelectedNode(id);
    this.tree.setSelected(id);
    this.details.update(this.model, node);
    this.updateStatusBar();
  }

  private toggleHidden(id: string): void {
    const node = this.nodes.get(id);
    if (!node || !this.model) return;
    node.hidden = !node.hidden;
    this.nodeOverrides.set(id, {
      hidden: node.hidden,
      colorOverride: node.colorOverride,
    });
    this.renderer.refreshSelectionBBox();
    this.tree.update(this.model.root);
    this.tree.setSelected(this.selectedNodeId);
    this.details.update(this.model, this.selectedNodeId ? this.nodes.get(this.selectedNodeId) ?? null : null);
    this.updateStatusBar();
  }

  private setNodeColor(id: string, color: string | null): void {
    const node = this.nodes.get(id);
    if (!node || !this.model) return;
    node.colorOverride = color;
    this.nodeOverrides.set(id, {
      hidden: node.hidden,
      colorOverride: color,
    });
    this.tree.update(this.model.root);
    this.tree.setSelected(this.selectedNodeId);
    this.details.update(this.model, this.nodes.get(id) ?? null);
  }

  private focusNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node || !this.model) return;
    if (node.hidden) {
      // 聚焦隐藏节点没有意义，先恢复显示
      node.hidden = false;
      this.nodeOverrides.set(id, { hidden: false, colorOverride: node.colorOverride });
      this.tree.update(this.model.root);
      this.tree.setSelected(this.selectedNodeId);
    }
    this.selectNode(id);
    this.frameBox(node.bbox);
  }

  private frameBox(box: SceneNode['bbox']): void {
    if (bbox.isEmpty(box)) {
      toast('该节点没有有效几何数据，无法聚焦', 'error');
      return;
    }
    this.camera.frame(box);
  }

  private applyMaterialOverride(name: string, override: MaterialOverride | null): void {
    if (!this.model) return;
    if (override === null) {
      this.materialOverrides.delete(name);
    } else {
      const cleaned: MaterialOverride = {};
      if (override.diffuse) cleaned.diffuse = override.diffuse;
      if (override.opacity !== undefined) cleaned.opacity = override.opacity;
      if (Object.keys(cleaned).length === 0) this.materialOverrides.delete(name);
      else this.materialOverrides.set(name, cleaned);
    }
    this.renderer.setMaterialOverrides(this.materialOverrides);
    this.materials.update(this.model, this.materialOverrides);
  }

  private locateWarning(warning: ParseWarning): void {
    toast(`${warning.file}${warning.line !== null ? ` 第 ${warning.line} 行` : ''}：${warning.message}`);
  }

  // ---------------- 项目文件 ----------------

  private saveProject(): void {
    if (!this.model) {
      toast('请先载入模型再保存项目', 'error');
      return;
    }
    const project = buildProjectFile({
      sources: this.sources,
      model: this.model,
      camera: this.camera.getState(),
      displayMode: this.renderer.displayMode,
      environment: this.renderer.environment.id,
      nodeOverrides: this.nodeOverrides,
      materialOverrides: this.materialOverrides,
      selectedNodeId: this.selectedNodeId,
    });
    const base = this.model.objFileName.replace(/\.obj$/i, '') || 'model';
    downloadText(`${base}.mvproj.json`, serializeProject(project), 'application/json');
    toast('项目文件已保存（含源模型、贴图与全部覆盖项）');
  }

  async openProject(file: File): Promise<void> {
    try {
      const project: ProjectFile = parseProject(await file.text());
      const sources = projectToSources(project);
      await this.loadSources(sources, { frame: false, camera: project.camera });

      // 恢复覆盖项（按稳定 ID 与材质名校验，丢弃已不存在的条目）
      this.nodeOverrides = reconcileNodeOverrides(project.nodeOverrides, this.model!.root);
      for (const [id, override] of this.nodeOverrides) {
        const node = this.nodes.get(id);
        if (!node) continue;
        if (override.hidden !== undefined) node.hidden = override.hidden;
        if (override.colorOverride !== undefined) node.colorOverride = override.colorOverride;
      }
      this.materialOverrides = reconcileMaterialOverrides(project.materialOverrides, this.model!);
      this.renderer.setMaterialOverrides(this.materialOverrides);

      this.renderer.setDisplayMode(project.displayMode);
      this.renderer.setEnvironment(project.environment);
      this.syncToolbarState(project.displayMode, project.environment);

      const selected = project.selectedNodeId && this.nodes.has(project.selectedNodeId)
        ? project.selectedNodeId
        : null;
      if (selected) this.selectNode(selected);
      this.renderer.refreshSelectionBBox();
      this.refreshAll();
      toast('项目已恢复：结构、相机姿态与材质覆盖项均已还原');
    } catch (err) {
      toast(`项目打开失败：${(err as Error).message}`, 'error');
    }
  }

  private syncToolbarState(mode: DisplayMode, env: EnvironmentId): void {
    document.querySelectorAll('[data-mode]').forEach((el) =>
      el.classList.toggle('active', el.getAttribute('data-mode') === mode),
    );
    const select = document.querySelector('#view-toolbar select') as HTMLSelectElement | null;
    if (select) select.value = env;
  }

  // ---------------- 指针交互 ----------------

  private bindPointer(): void {
    const canvas = this.canvas;
    let dragging: 'rotate' | 'pan' | null = null;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 0 || e.button === 2) {
        dragging = e.button === 0 ? 'rotate' : 'pan';
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (dragging === 'rotate') this.camera.rotate(dx, dy);
      else this.camera.pan(dx, dy, canvas.clientHeight);
    });
    const end = (e: PointerEvent): void => {
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      dragging = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camera.zoom(e.deltaY);
    }, { passive: false });
  }

  private bindResize(): void {
    const resize = (): void => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, this.canvas.clientWidth);
      const height = Math.max(1, this.canvas.clientHeight);
      this.canvas.width = Math.round(width * dpr);
      this.canvas.height = Math.round(height * dpr);
      this.camera.aspect = width / height;
    };
    resize();
    new ResizeObserver(resize).observe(this.canvas);
  }

  private bindDragDrop(): void {
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
        void this.loadFromFiles(e.dataTransfer.files);
      }
    });
  }

  // ---------------- 渲染循环与刷新 ----------------

  private renderLoop = (): void => {
    if (this.disposed) return;
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    this.camera.aspect = aspect;
    const view = this.camera.viewMatrix();
    const proj = this.camera.projectionMatrix();
    const viewProj = multiply4(proj, view);
    this.renderer.render(viewProj, this.camera.eye());
    requestAnimationFrame(this.renderLoop);
  };

  private refreshAll(): void {
    if (this.model) {
      document.getElementById('empty-state')!.classList.add('hidden');
      this.tree.update(this.model.root);
      this.tree.setSelected(this.selectedNodeId);
      this.warnings.update(this.model.warnings);
      this.details.update(this.model, this.selectedNodeId ? this.nodes.get(this.selectedNodeId) ?? null : null);
      this.materials.update(this.model, this.materialOverrides);
      document.getElementById('tree-summary')!.textContent =
        `${this.model.objects.length} 对象 · ${this.model.root.faceCount.toLocaleString()} 面`;
    } else {
      document.getElementById('empty-state')!.classList.remove('hidden');
      this.warnings.update([]);
      this.details.update(null, null);
      this.materials.update(null, new Map());
      document.getElementById('tree-summary')!.textContent = '';
    }
  }

  private updateStatusBar(): void {
    const bar = document.getElementById('status-bar')!;
    if (!this.model) {
      bar.textContent = '就绪';
      return;
    }
    const placeholders = this.renderer.placeholderMaterials();
    const parts = [
      `OBJ: ${this.model.objFileName}`,
      `顶点 ${this.model.root.vertexCount.toLocaleString()}`,
      `面 ${this.model.root.faceCount.toLocaleString()}`,
      `警告 ${this.model.warnings.length}`,
    ];
    if (placeholders.length > 0) {
      parts.push(`占位贴图 ${placeholders.length} 个材质`);
    }
    if (this.selectedNodeId) {
      const node = this.nodes.get(this.selectedNodeId);
      if (node) parts.push(`选中：${node.label}`);
    }
    bar.textContent = parts.join(' ｜ ');
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }

  // ---------------- 自动化自检（仅 ?selftest=1 时由 main.ts 调用） ----------------

  /** 启动参数设置显示模式（早于样例载入） */
  setDisplayModeForBoot(mode: DisplayMode): void {
    this.renderer.setDisplayMode(mode);
    this.syncToolbarState(mode, this.renderer.environment.id);
  }

  /** 启动参数设置光照环境（早于样例载入） */
  setEnvironmentForBoot(env: EnvironmentId): void {
    this.renderer.setEnvironment(env);
    this.syncToolbarState(this.renderer.displayMode, env);
  }

  async runSelfCheck(): Promise<void> {
    const results: { name: string; ok: boolean; detail?: string }[] = [];
    const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
      try {
        await fn();
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, detail: (err as Error).message });
      }
    };

    await this.loadSample();

    await check('样例载入后存在 3 个对象', () => {
      if (!this.model || this.model.objects.length !== 3) throw new Error('对象数不为 3');
    });

    await check('警告面板渲染了带行号的问题条目', () => {
      const rows = document.querySelectorAll('#warning-list .warning-row');
      if (rows.length < 6) throw new Error(`警告条目只有 ${rows.length} 条`);
      const locs = [...rows].map((r) => r.querySelector('.warning-loc')?.textContent ?? '');
      if (locs.some((l) => l === '')) throw new Error('存在无位置信息的警告');
    });

    await check('结构树渲染对象与组节点', () => {
      const rows = document.querySelectorAll('#scene-tree .tree-row');
      if (rows.length < 4) throw new Error(`树节点只有 ${rows.length} 个`);
    });

    const firstGroupId = this.model!.objects[0].children[0].id;

    await check('按稳定 ID 选中节点并显示包围信息', () => {
      this.selectNode(firstGroupId);
      if (this.selectedNodeId !== firstGroupId) throw new Error('选中态未更新');
      const text = document.getElementById('details-panel')!.textContent ?? '';
      if (!text.includes('包围范围') || !text.includes('顶点数')) throw new Error('详情面板缺少包围范围/统计');
    });

    await check('隐藏节点后渲染可见性更新', () => {
      this.toggleHidden(firstGroupId);
      const node = this.nodes.get(firstGroupId)!;
      if (!node.hidden) throw new Error('节点未被标记隐藏');
      this.toggleHidden(firstGroupId);
    });

    await check('颜色覆盖写入节点并可清除', () => {
      this.setNodeColor(firstGroupId, '#123456');
      if (this.nodes.get(firstGroupId)!.colorOverride !== '#123456') throw new Error('颜色覆盖失败');
      this.setNodeColor(firstGroupId, null);
      if (this.nodes.get(firstGroupId)!.colorOverride !== null) throw new Error('颜色清除失败');
    });

    await check('材质覆盖同步到渲染器', () => {
      this.applyMaterialOverride('RedPlastic', { diffuse: '#abcdef' });
      if (this.materialOverrides.get('RedPlastic')?.diffuse !== '#abcdef') throw new Error('材质覆盖未保存');
      this.applyMaterialOverride('RedPlastic', null);
      if (this.materialOverrides.has('RedPlastic')) throw new Error('材质重置失败');
    });

    await check('三种显示模式可切换', () => {
      for (const mode of ['material', 'wireframe', 'normal'] as const) {
        this.renderer.setDisplayMode(mode);
        if (this.renderer.displayMode !== mode) throw new Error(`模式 ${mode} 切换失败`);
      }
      this.renderer.setDisplayMode('material');
    });

    await check('光照环境切换且背景像素随之变化', () => {
      const gl = this.renderer.glContext;
      const sample = (): number[] => {
        const px = new Uint8Array(4);
        gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return [...px];
      };
      this.renderer.setEnvironment('studio');
      this.renderer.render(
        mat4.multiply(this.camera.projectionMatrix(), this.camera.viewMatrix()),
        this.camera.eye(),
      );
      const a = sample();
      this.renderer.setEnvironment('night');
      this.renderer.render(
        mat4.multiply(this.camera.projectionMatrix(), this.camera.viewMatrix()),
        this.camera.eye(),
      );
      const b = sample();
      this.renderer.setEnvironment('studio');
      if (a.join() === b.join()) throw new Error('环境切换后背景像素没有变化');
    });

    await check('贴图缺失被识别为占位材质', () => {
      const placeholders = this.renderer.placeholderMaterials();
      if (!placeholders.some((p) => p.material === 'MissingTextureMat')) {
        throw new Error('MissingTextureMat 未出现在占位列表');
      }
    });

    await check('项目文件保存-打开往返保持相机与覆盖项', async () => {
      this.selectNode(firstGroupId);
      this.setNodeColor(firstGroupId, '#ff8800');
      const cameraBefore = this.camera.getState();
      const project = buildProjectFile({
        sources: this.sources,
        model: this.model!,
        camera: cameraBefore,
        displayMode: 'wireframe',
        environment: 'night',
        nodeOverrides: this.nodeOverrides,
        materialOverrides: this.materialOverrides,
        selectedNodeId: this.selectedNodeId,
      });
      const restored = parseProject(serializeProject(project));
      await this.loadSources(projectToSources(restored), { frame: false, camera: restored.camera });
      const cameraAfter = this.camera.getState();
      if (Math.abs(cameraAfter.distance - cameraBefore.distance) > 1e-9) {
        throw new Error('切换模型后相机距离发生跳变');
      }
      this.nodeOverrides = reconcileNodeOverrides(restored.nodeOverrides, this.model!.root);
      this.materialOverrides = reconcileMaterialOverrides(restored.materialOverrides, this.model!);
      const override = this.nodeOverrides.get(firstGroupId);
      if (override?.colorOverride !== '#ff8800') throw new Error('节点颜色覆盖未恢复');
      if (restored.displayMode !== 'wireframe' || restored.environment !== 'night') {
        throw new Error('显示模式/环境未持久化');
      }
    });

    const failed = results.filter((r) => !r.ok);
    const status = failed.length === 0 ? 'pass' : 'fail';
    const marker = document.createElement('div');
    marker.id = 'selftest-result';
    marker.dataset.status = status;
    marker.textContent = JSON.stringify({ status, results });
    marker.style.position = 'fixed';
    marker.style.top = '0';
    marker.style.zIndex = '9999';
    document.body.append(marker);
    document.title = `SELFTEST_${status.toUpperCase()}`;
    // eslint-disable-next-line no-console
    console.log('[selftest]', JSON.stringify({ status, results }, null, 2));
  }
}

function multiply4(a: Mat4, b: Mat4): Mat4 {
  return mat4.multiply(a, b);
}
