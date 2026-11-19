import './style.css';
import {
  GraphEvaluator,
  connect,
  createNode,
  findNode,
  findOutputNodes,
  nextEdgeId,
  nextNodeId,
  nodeName,
  type EvaluateResult,
} from './core/graph.ts';
import { NODE_DEFS } from './core/nodes.ts';
import { parseProject, serializeProject, ProjectValidationError } from './core/project.ts';
import type {
  ConnectionResult,
  Edge,
  NodeInstance,
  ParamValue,
  PortRef,
  Project,
  RasterImage,
} from './core/types.ts';
import { SAMPLES } from './samples.ts';
import { GraphCanvas } from './ui/graphCanvas.ts';
import { createPreviewPanel } from './ui/previewPanel.ts';
import { createInspector } from './ui/inspector.ts';
import { rasterToCanvas } from './ui/rasterCanvas.ts';
import { el, clear } from './ui/dom.ts';

const STORAGE_KEY = 'material-node-editor:project:v1';

const CATEGORY_ORDER: Array<'生成器' | '处理' | '合成' | '输出'> = ['生成器', '处理', '合成', '输出'];
const CATEGORY_CLASS: Record<string, string> = {
  生成器: 'generator',
  处理: 'process',
  合成: 'composite',
  输出: 'output',
};

const EMPTY_RESULT: EvaluateResult = {
  images: new Map(),
  errors: new Map(),
  blocked: new Set(),
  computed: [],
  reused: [],
};

class App {
  private project: Project;
  private readonly evaluator = new GraphEvaluator();
  private evaluation: EvaluateResult = EMPTY_RESULT;
  private selectedNodeId: string | null = null;
  private selectedEdgeId: string | null = null;
  /** Last image each node produced successfully, keyed by node id. */
  private readonly lastGoodOutputs = new Map<string, RasterImage>();
  private graph!: GraphCanvas;
  private preview!: ReturnType<typeof createPreviewPanel>;
  private inspector!: ReturnType<typeof createInspector>;
  private statusEl!: HTMLElement;
  private toastLayer!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private zoomReadout!: HTMLElement;
  private persistTimer: number | null = null;
  private evalFrame: number | null = null;

  constructor(project: Project) {
    this.project = project;
    this.build();
    this.evaluateNow();
    this.refreshAll();
  }

  // ---------------------------------------------------------------- setup

  private build(): void {
    const app = document.getElementById('app');
    if (!app) throw new Error('缺少 #app 挂载点');
    clear(app);

    const topbar = el('header', { className: 'topbar' });
    const brand = el('div', { className: 'brand' }, [
      el('div', { className: 'brand-mark' }),
      el('div', {}, [
        el('div', { className: 'brand-title', text: '材质节点编辑器' }),
        el('div', { className: 'brand-sub', text: '程序化纹理 · 实时预览' }),
      ]),
    ]);
    this.nameInput = el('input', {
      className: 'project-name',
      value: this.project.name,
      title: '项目名称',
    }) as HTMLInputElement;
    this.nameInput.addEventListener('change', () => {
      this.project.name = this.nameInput.value.trim() || '未命名项目';
      this.nameInput.value = this.project.name;
      this.persistSoon();
    });

    const fileInput = el('input', { type: 'file', accept: '.json,application/json' }) as HTMLInputElement;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) void this.loadFile(file);
      fileInput.value = '';
    });

    const saveButton = el('button', {
      className: 'btn',
      text: '保存项目',
      title: '下载为 JSON 文件 (Ctrl/Cmd+S)',
      on: { click: () => this.saveProjectFile() },
    });
    const openButton = el('button', {
      className: 'btn',
      text: '打开项目',
      title: '从 JSON 文件加载 (Ctrl/Cmd+O)',
      on: { click: () => fileInput.click() },
    });
    const newButton = el('button', { className: 'btn', text: '新建', on: { click: () => this.newProject() } });
    const exportButton = el('button', {
      className: 'btn primary',
      text: '导出 PNG',
      on: { click: () => this.exportPng() },
    });
    const sampleSelect = el('select', { className: 'select', title: '加载示例项目' }) as HTMLSelectElement;
    sampleSelect.append(el('option', { value: '', text: '示例项目…' }));
    for (const sample of SAMPLES) {
      sampleSelect.append(el('option', { value: sample.id, text: sample.name }));
    }
    sampleSelect.addEventListener('change', () => {
      const sample = SAMPLES.find((candidate) => candidate.id === sampleSelect.value);
      sampleSelect.value = '';
      if (sample) this.loadSample(sample.id);
    });

    topbar.append(
      brand,
      this.nameInput,
      el('div', { className: 'topbar-spacer' }),
      el('div', { className: 'toolbar-group' }, [
        newButton,
        openButton,
        saveButton,
        sampleSelect,
        exportButton,
        fileInput,
      ]),
    );

    const workspace = el('div', { className: 'workspace' });
    const sidebar = this.buildSidebar();
    const graphWrap = el('div', { className: 'graph-wrap' });
    const canvas = el('canvas', { id: 'graph-canvas' });
    graphWrap.append(canvas);

    const hud = el('div', { className: 'canvas-hud' });
    const zoomOut = el('button', {
      className: 'btn small',
      text: '−',
      title: '缩小',
      on: { click: () => this.graph.zoomBy(0.85) },
    });
    const zoomIn = el('button', {
      className: 'btn small',
      text: '+',
      title: '放大',
      on: { click: () => this.graph.zoomBy(1.18) },
    });
    const fit = el('button', {
      className: 'btn small',
      text: '适配',
      title: '显示全部节点',
      on: { click: () => this.graph.fitView() },
    });
    this.zoomReadout = el('span', { className: 'zoom-readout' });
    hud.append(zoomOut, this.zoomReadout, zoomIn, fit);

    const note = el('div', {
      className: 'canvas-note',
      text: '拖动端口连线 · 滚轮缩放 · 空白处拖动平移 · Delete 删除选中',
    });
    graphWrap.append(hud, note);

    const inspectorColumn = el('div', { className: 'inspector-column' });
    workspace.append(sidebar, graphWrap, inspectorColumn);

    this.toastLayer = el('div', { className: 'toast-layer' });
    const statusbar = el('footer', { className: 'statusbar' });
    this.statusEl = el('span');
    statusbar.append(this.statusEl);
    app.append(topbar, workspace, statusbar, this.toastLayer);

    // Graph canvas
    this.graph = new GraphCanvas(canvas as HTMLCanvasElement, {
      getProject: () => this.project,
      getEvaluation: () => this.evaluation,
      getSelectedNodeId: () => this.selectedNodeId,
      getSelectedEdgeId: () => this.selectedEdgeId,
      selectNode: (id) => {
        this.selectedNodeId = id;
        this.selectedEdgeId = null;
        this.inspector.refresh();
        this.graph.requestRender();
        this.updateStatus();
      },
      selectEdge: (id) => {
        this.selectedEdgeId = id;
        this.selectedNodeId = null;
        this.inspector.refresh();
        this.graph.requestRender();
        this.updateStatus();
      },
      moveNode: (id, x, y) => {
        const node = findNode(this.project, id);
        if (!node) return;
        node.x = x;
        node.y = y;
      },
      commitMove: () => {
        this.graph.requestRender();
        this.persistSoon();
      },
      viewChanged: () => {
        this.zoomReadout.textContent = `${Math.round(this.project.view.zoom * 100)}%`;
        this.persistSoon();
      },
      connect: (from, to) => this.connectPorts(from, to),
      toast: (message, kind) => this.toast(message, kind),
    });

    // Preview
    this.preview = createPreviewPanel({
      getProject: () => this.project,
      getImage: () => this.activeOutputImage(),
      getStatus: () => this.previewStatus(),
      resolutionChanged: (resolution) => {
        this.project.preview.resolution = resolution;
        this.evaluateNow();
        this.refreshAll();
        this.persistSoon();
      },
      zoomChanged: (zoom) => {
        this.project.preview.zoom = zoom;
        this.preview.refresh();
        this.persistSoon();
      },
      exportPng: () => this.exportPng(),
    });

    // Inspector
    this.inspector = createInspector({
      getProject: () => this.project,
      getSelectedNodeId: () => this.selectedNodeId,
      getSelectedEdgeId: () => this.selectedEdgeId,
      setNodeLabel: (id, label) => {
        const node = findNode(this.project, id);
        if (!node) return;
        node.label = label;
        this.graph.requestRender();
        this.persistSoon();
      },
      setParam: (id, key, value) => this.setParam(id, key, value),
      setActiveOutput: (id) => {
        this.project.activeOutputId = id;
        this.evaluateNow();
        this.refreshAll();
        this.persistSoon();
      },
      deleteNode: (id) => this.deleteNode(id),
      duplicateNode: (id) => this.duplicateNode(id),
      deleteEdge: (id) => this.deleteEdge(id),
      getNodeImage: (id) => this.evaluation.images.get(id),
      exportNodePng: (id) => {
        const image = this.evaluation.images.get(id);
        if (image) {
          const name = sanitizeFileName(`${this.project.name}-${this.nodeNameOf(id)}`);
          this.downloadImage(image, `${name}.png`);
        }
      },
    });

    inspectorColumn.append(this.preview.root, this.inspector.root);
    this.zoomReadout.textContent = `${Math.round(this.project.view.zoom * 100)}%`;

    this.bindKeyboard();
    this.persistSoon();
  }

  private buildSidebar(): HTMLElement {
    const sidebar = el('aside', { className: 'sidebar' });
    sidebar.append(el('h2', { className: 'side-title', text: '添加节点' }));
    const list = el('div', { className: 'palette-list' });
    for (const category of CATEGORY_ORDER) {
      const defs = NODE_DEFS.filter((def) => def.category === category);
      if (defs.length === 0) continue;
      list.append(el('div', { className: 'palette-category', text: category }));
      for (const def of defs) {
        const item = el('button', { className: 'palette-item', title: def.description }, [
          el('span', { className: `palette-dot ${CATEGORY_CLASS[category]}` }),
          el('span', {}, [
            el('span', { text: def.title }),
            el('span', { className: 'palette-desc', text: def.description }),
          ]),
        ]);
        item.addEventListener('click', () => this.addNodeAtCenter(def.type));
        list.append(item);
      }
    }
    sidebar.append(list);

    const samples = el('div', {}, [
      el('h2', { className: 'side-title', text: '示例项目' }),
      el(
        'div',
        { className: 'sample-list' },
        SAMPLES.map((sample) => {
          const button = el('button', { className: 'sample-item' }, [
            el('span', { className: 'sample-name', text: sample.name }),
            el('span', { className: 'sample-desc', text: sample.description }),
          ]);
          button.addEventListener('click', () => this.loadSample(sample.id));
          return button;
        }),
      ),
    ]);
    sidebar.append(samples);

    sidebar.append(
      el('div', {}, [
        el('h2', { className: 'side-title', text: '操作提示' }),
        el('ul', { className: 'hint-list' }, [
          el('li', { text: '从输出端口拖到输入端口即可连线' }),
          el('li', { text: '蓝色端口传颜色，黄色端口传遮罩，不能混接' }),
          el('li', { text: '点击连线后按 Delete 删除' }),
          el('li', { text: '滚轮缩放画布，空白处拖动平移' }),
          el('li', { text: '编辑自动保存在浏览器本地' }),
        ]),
      ]),
    );
    return sidebar;
  }

  // ---------------------------------------------------------------- graph edits

  private addNodeAtCenter(type: string): void {
    const view = this.project.view;
    const canvas = document.getElementById('graph-canvas') as HTMLCanvasElement | null;
    const width = canvas?.clientWidth ?? 800;
    const height = canvas?.clientHeight ?? 600;
    const jitter = () => Math.round(Math.random() * 40 - 20);
    const x = Math.round((width / 2 - view.x) / view.zoom - 105) + jitter();
    const y = Math.round((height / 2 - view.y) / view.zoom - 60) + jitter();
    const node = createNode(type, x, y);
    this.project.nodes.push(node);
    this.selectedNodeId = node.id;
    this.selectedEdgeId = null;
    if (type === 'output' && !this.project.activeOutputId) {
      this.project.activeOutputId = node.id;
    }
    this.evaluateNow();
    this.refreshAll();
    this.persistSoon();
  }

  private setParam(id: string, key: string, value: ParamValue): void {
    const node = findNode(this.project, id);
    if (!node) return;
    node.params = { ...node.params, [key]: value };
    this.scheduleEvaluate();
    this.graph.requestRender();
    this.updateStatus();
    this.persistSoon();
  }

  private connectPorts(from: PortRef, to: PortRef): ConnectionResult {
    const result = connect(this.project, from, to);
    if (!result.ok || !result.edge) return result;
    if (result.replaced) {
      this.project.edges = this.project.edges.filter((edge) => edge.id !== result.replaced!.id);
      this.toast('已替换该输入上的原有连线', 'info');
    }
    this.project.edges.push(result.edge);
    this.evaluateNow();
    this.refreshAll();
    this.persistSoon();
    return result;
  }

  private deleteEdge(id: string): void {
    const before = this.project.edges.length;
    this.project.edges = this.project.edges.filter((edge) => edge.id !== id);
    if (this.project.edges.length === before) return;
    if (this.selectedEdgeId === id) this.selectedEdgeId = null;
    this.evaluateNow();
    this.refreshAll();
    this.persistSoon();
  }

  private deleteNode(id: string): void {
    const node = findNode(this.project, id);
    if (!node) return;
    const name = nodeName(node);
    this.project.nodes = this.project.nodes.filter((candidate) => candidate.id !== id);
    this.project.edges = this.project.edges.filter(
      (edge) => edge.from.node !== id && edge.to.node !== id,
    );
    if (this.selectedNodeId === id) this.selectedNodeId = null;
    if (this.project.activeOutputId === id) {
      this.project.activeOutputId = findOutputNodes(this.project)[0]?.id ?? null;
    }
    this.evaluateNow();
    this.refreshAll();
    this.persistSoon();
    this.toast(`已删除节点「${name}」`, 'info');
  }

  private duplicateNode(id: string): void {
    const node = findNode(this.project, id);
    if (!node) return;
    const clone: NodeInstance = {
      ...node,
      id: nextNodeId(node.type),
      label: `${node.label} 副本`,
      x: node.x + 36,
      y: node.y + 36,
      params: { ...node.params },
    };
    this.project.nodes.push(clone);
    this.selectedNodeId = clone.id;
    this.evaluateNow();
    this.refreshAll();
    this.persistSoon();
  }

  private bindKeyboard(): void {
    window.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;
      if (typing) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (this.selectedEdgeId) {
          this.deleteEdge(this.selectedEdgeId);
          event.preventDefault();
        } else if (this.selectedNodeId) {
          this.deleteNode(this.selectedNodeId);
          event.preventDefault();
        }
        return;
      }
      if (event.key === 'Escape') {
        this.selectedNodeId = null;
        this.selectedEdgeId = null;
        this.inspector.refresh();
        this.graph.requestRender();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.saveProjectFile();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[type="file"]')?.click();
      }
    });
  }

  // ---------------------------------------------------------------- evaluation

  /** Coalesce rapid parameter edits into one evaluation per animation frame. */
  private scheduleEvaluate(): void {
    if (this.evalFrame !== null) return;
    this.evalFrame = requestAnimationFrame(() => {
      this.evalFrame = null;
      this.evaluateNow();
      this.refreshAll();
    });
  }

  private evaluateNow(): void {
    const { resolution } = this.project.preview;
    this.evaluation = this.evaluator.evaluate(this.project, {
      width: resolution,
      height: resolution,
    });

    if (!this.project.activeOutputId || !findNode(this.project, this.project.activeOutputId)) {
      this.project.activeOutputId = findOutputNodes(this.project)[0]?.id ?? null;
    }

    for (const [nodeId, image] of this.evaluation.images) {
      this.lastGoodOutputs.set(nodeId, image);
    }
    // Drop retained images for nodes that no longer exist.
    const live = new Set(this.project.nodes.map((node) => node.id));
    for (const id of [...this.lastGoodOutputs.keys()]) {
      if (!live.has(id)) this.lastGoodOutputs.delete(id);
    }
  }

  private activeOutputImage(): RasterImage | undefined {
    const active = this.project.activeOutputId;
    if (!active) return undefined;
    return this.evaluation.images.get(active) ?? this.lastGoodOutputs.get(active);
  }

  private previewStatus(): { stale: boolean; errors: { nodeName: string; message: string }[] } {
    const errors = [...this.evaluation.errors.entries()].map(([nodeId, message]) => ({
      nodeName: this.nodeNameOf(nodeId),
      message,
    }));
    const active = this.project.activeOutputId;
    // The active output is showing an older image when it could not be
    // recomputed this pass (upstream failure) or failed on its own.
    const stale =
      active !== null &&
      (this.evaluation.blocked.has(active) ||
        this.evaluation.errors.has(active) ||
        !this.evaluation.images.has(active)) &&
      this.lastGoodOutputs.has(active);
    return { stale, errors };
  }

  private nodeNameOf(id: string): string {
    const node = findNode(this.project, id);
    return node ? nodeName(node) : id;
  }

  // ---------------------------------------------------------------- refresh

  private refreshAll(): void {
    this.graph?.requestRender();
    this.preview?.refresh();
    this.inspector?.refresh();
    this.updateStatus();
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const nodeCount = this.project.nodes.length;
    const edgeCount = this.project.edges.length;
    const errorCount = this.evaluation.errors.size;
    const computed = this.evaluation.computed.length;
    const reused = this.evaluation.reused.length;
    const selected = this.selectedNodeId
      ? this.nodeNameOf(this.selectedNodeId)
      : this.selectedEdgeId
        ? '连线'
        : '无';
    this.statusEl.replaceChildren();
    this.statusEl.append(
      el('span', { className: `dot${errorCount > 0 ? ' error' : ''}` }),
      el('span', { text: `${nodeCount} 节点 · ${edgeCount} 连线` }),
      el('span', { text: `本次计算 ${computed} · 缓存复用 ${reused}` }),
      el('span', { text: `选中：${selected}` }),
      el('span', { text: errorCount > 0 ? `${errorCount} 个节点报错` : '运行正常' }),
    );
  }

  // ---------------------------------------------------------------- persistence

  private persistSoon(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 400);
  }

  private persistNow(): void {
    try {
      localStorage.setItem(STORAGE_KEY, serializeProject(this.project));
    } catch {
      // Private mode / quota. Explicit file saving still works.
    }
  }

  private saveProjectFile(): void {
    const json = serializeProject(this.project);
    this.persistNow();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${sanitizeFileName(this.project.name)}.material.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    this.toast('项目已保存为 JSON 文件', 'success');
  }

  private async loadFile(file: File): Promise<void> {
    let text: string;
    try {
      text = await file.text();
    } catch {
      this.toast('无法读取文件', 'error');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.toast(`「${file.name}」不是合法的 JSON，当前项目未改变`, 'error');
      return;
    }
    try {
      const next = parseProject(raw);
      this.replaceProject(next);
      this.toast(`已打开「${next.name}」`, 'success');
    } catch (error) {
      const message = error instanceof ProjectValidationError ? error.message : String(error);
      this.toast(`项目文件无效，当前项目未改变：${message}`, 'error');
    }
  }

  private replaceProject(project: Project): void {
    this.project = project;
    this.evaluator.clear();
    this.lastGoodOutputs.clear();
    this.selectedNodeId = null;
    this.selectedEdgeId = null;
    this.nameInput.value = project.name;
    this.evaluateNow();
    this.refreshAll();
    // Keep the saved view so pan/zoom survive reopening, as the project stores it.
    this.persistNow();
  }

  private newProject(): void {
    const output = createNode('output', 560, 240);
    const solid = createNode('solid', 160, 220);
    const edge: Edge = {
      id: nextEdgeId(),
      from: { node: solid.id, port: 'color' },
      to: { node: output.id, port: 'input' },
    };
    this.replaceProject({
      version: 1,
      name: '未命名项目',
      nodes: [solid, output],
      edges: [edge],
      view: { x: 40, y: 40, zoom: 1 },
      preview: { resolution: 512, zoom: 0 },
      activeOutputId: output.id,
    });
    this.toast('已新建项目', 'info');
  }

  private loadSample(id: string): void {
    const sample = SAMPLES.find((candidate) => candidate.id === id);
    if (!sample) return;
    this.replaceProject(sample.build());
    this.toast(`已加载示例「${sample.name}」`, 'success');
  }

  // ---------------------------------------------------------------- export

  private exportPng(): void {
    const image = this.activeOutputImage();
    if (!image) {
      this.toast('当前没有可导出的输出', 'error');
      return;
    }
    this.downloadImage(image, `${sanitizeFileName(this.project.name)}.png`);
  }

  private downloadImage(image: RasterImage, filename: string): void {
    const canvas = rasterToCanvas(image);
    canvas.toBlob((blob) => {
      if (!blob) {
        this.toast('PNG 编码失败', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
      this.toast(`已导出 ${filename}`, 'success');
    }, 'image/png');
  }

  // ---------------------------------------------------------------- toast

  toast(message: string, kind: 'info' | 'error' | 'success' = 'info'): void {
    const item = el('div', { className: `toast ${kind === 'info' ? '' : kind}`, text: message });
    this.toastLayer.append(item);
    window.setTimeout(() => {
      item.style.opacity = '0';
      item.style.transition = 'opacity 180ms ease';
      window.setTimeout(() => item.remove(), 200);
    }, kind === 'error' ? 4200 : 2600);
  }
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'material';
}

function loadInitialProject(): Project {
  const stored = readStored();
  if (stored) {
    try {
      return parseProject(stored);
    } catch {
      // A corrupt autosave must not prevent the app from starting.
    }
  }
  const sample = SAMPLES[0];
  if (sample) return sample.build();
  const output = createNode('output', 520, 220);
  return {
    version: 1,
    name: '未命名项目',
    nodes: [output],
    edges: [],
    view: { x: 40, y: 40, zoom: 1 },
    preview: { resolution: 512, zoom: 0 },
    activeOutputId: output.id,
  };
}

function readStored(): unknown {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const initial = loadInitialProject();
new App(initial);
