import { RenderEngine } from './webgl/RenderEngine';
import { store, resolveResolution, type AppState } from './state/store';
import { downloadTextFile, downloadDataUrl, readProjectFile, safeFileName } from './state/io';
import { CodeEditor } from './ui/CodeEditor';
import { Sidebar } from './ui/Sidebar';
import { Timeline } from './ui/Timeline';
import { PreviewPanel } from './ui/PreviewPanel';
import { EXAMPLES } from './examples';
import { h, debounce } from './ui/dom';
import type { ProjectData, UniformValue } from './types';

export class App {
  private engine: RenderEngine;
  private mainEditor = new CodeEditor();
  private postEditor = new CodeEditor();
  private sidebar: Sidebar;
  private timeline: Timeline;
  private preview: PreviewPanel;
  private root: HTMLElement;
  private nameInput!: HTMLInputElement;
  private dirtyDot!: HTMLElement;

  private lastFrame = performance.now();
  private lastUniformSig = '';
  private rafId = 0;
  private disposed = false;

  constructor(root: HTMLElement) {
    this.preview = new PreviewPanel({
      getPreview: () => store.get().preview,
      setPreview: (patch) => this.updatePreview(patch),
      onExportPng: () => this.exportPng(),
    });
    try {
      this.engine = new RenderEngine(this.preview.canvas);
    } catch (e) {
      root.replaceChildren(
        h('div', { className: 'fatal', textContent: (e as Error).message }),
      );
      throw e;
    }

    this.sidebar = new Sidebar({
      getValue: (name) => store.get().uniformValues[name],
      setValue: (name, value) => this.updateUniform(name, value),
      onTextureFile: (name, dataUrl) => this.handleTextureUpload(name, dataUrl),
    });
    this.timeline = new Timeline({
      getTime: () => store.get().time,
      setPlaying: (playing) => store.update({ time: { ...store.get().time, playing } }),
      setTime: (time) => store.patchSilent({ time: { ...store.get().time, time } }),
    });

    this.root = root;
    this.buildLayout();
    this.wireEditors();

    const state = store.get();
    this.mainEditor.setValue(state.mainSource);
    this.postEditor.setValue(state.postSource);

    this.applyResolution();
    this.compileAll(true);
    this.startLoop();

    document.addEventListener('visibilitychange', () => {
      this.lastFrame = performance.now();
    });
  }

  /* ---------------- 布局 ---------------- */

  private buildLayout() {
    const toolbar = this.buildToolbar();

    const tabBar = h('div', { className: 'tab-bar' });
    const mainTab = h('button', { type: 'button', className: 'tab tab-active', textContent: '主着色器 main.frag' });
    const postTab = h('button', { type: 'button', className: 'tab', textContent: '后处理 post.frag' });
    mainTab.addEventListener('click', () => this.switchTab('main', mainTab, postTab));
    postTab.addEventListener('click', () => this.switchTab('post', mainTab, postTab));
    tabBar.append(mainTab, postTab);

    const editorPane = h('div', { className: 'editor-pane' }, [
      tabBar,
      h('div', { className: 'editor-stack' }, [this.mainEditor.element, this.postEditor.element]),
    ]);
    this.postEditor.element.classList.add('hidden');

    const left = h('div', { className: 'left-pane' }, [editorPane, this.timeline.element]);
    const center = h('div', { className: 'center-pane' }, [this.preview.element]);
    this.root.replaceChildren(
      h('div', { className: 'app-shell' }, [toolbar, left, center, this.sidebar.element]),
    );
  }

  private buildToolbar(): HTMLElement {
    this.nameInput = h('input', {
      className: 'project-name',
      value: store.get().projectName,
    }) as HTMLInputElement;
    this.nameInput.addEventListener('change', () =>
      store.update({ projectName: this.nameInput.value }),
    );

    const exampleSelect = h('select', { className: 'example-select' }) as HTMLSelectElement;
    exampleSelect.append(h('option', { value: '', textContent: '载入示例…' }));
    for (const ex of EXAMPLES) {
      exampleSelect.append(h('option', { value: ex.id, textContent: ex.label, title: ex.description }));
    }
    exampleSelect.addEventListener('change', () => {
      const ex = EXAMPLES.find((x) => x.id === exampleSelect.value);
      exampleSelect.value = '';
      if (ex) this.loadProject(ex.project);
    });

    const saveBtn = h('button', { type: 'button', textContent: '保存工程' });
    saveBtn.addEventListener('click', () => this.saveProject());
    const openBtn = h('button', { type: 'button', textContent: '打开工程' });
    const fileInput = h('input', {
      type: 'file', accept: '.json,application/json',
    }) as HTMLInputElement;
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const project = await readProjectFile(file);
        this.loadProject(project);
      } catch (e) {
        alert(`打开失败：${(e as Error).message}`);
      }
      fileInput.value = '';
    });
    openBtn.addEventListener('click', () => fileInput.click());

    const dirtyDot = h('span', { className: 'dirty-dot', title: '有未保存修改' });
    this.dirtyDot = dirtyDot;
    this.updateDirty();

    return h('div', { className: 'toolbar' }, [
      h('span', { className: 'brand', textContent: 'Shader Lab' }),
      this.nameInput,
      dirtyDot,
      h('div', { className: 'toolbar-spacer' }),
      exampleSelect,
      openBtn,
      saveBtn,
      fileInput,
    ]);
  }

  /* ---------------- 编辑器 ---------------- */

  private wireEditors() {
    const debounced = debounce(() => this.compileAll(false), 350);
    this.mainEditor.onChange((value) => {
      store.update({ mainSource: value });
      debounced();
    });
    this.postEditor.onChange((value) => {
      store.update({ postSource: value });
      debounced();
    });
    const save = () => {
      this.compileAll(false);
      this.saveProject();
    };
    this.mainEditor.onSave(save);
    this.postEditor.onSave(save);
  }

  private switchTab(tab: 'main' | 'post', mainTab: HTMLElement, postTab: HTMLElement) {
    store.patchSilent({ activeTab: tab });
    const mainActive = tab === 'main';
    this.mainEditor.element.classList.toggle('hidden', !mainActive);
    this.postEditor.element.classList.toggle('hidden', mainActive);
    mainTab.classList.toggle('tab-active', mainActive);
    postTab.classList.toggle('tab-active', !mainActive);
  }

  /* ---------------- 编译 ---------------- */

  private compileAll(initial: boolean) {
    const s = store.get();
    const result = this.engine.compile(s.mainSource, s.postSource, s.uniformValues);

    if (this.engine.isInErrorState) {
      // 主着色器失败：状态完全不动（uniformValues 保留上一次成功编译的表）
      store.patchSilent({ mainFailed: true, diagnostics: result.diagnostics });
      this.mainEditor.setErrorLines(result.diagnostics.map((d) => d.line));
    } else {
      // 主着色器成功：回引擎合并后的 uniform 值（同名同类型保留，新增取默认）
      // 并按最终签名（主程序 ∪ 后处理）剔除已删除的旧参数
      const valid = new Set([
        ...this.engine.activeUniforms.map((u) => u.name),
        ...this.engine.postUniforms.map((u) => u.name),
      ]);
      const pruned: Record<string, UniformValue> = {};
      for (const [name, value] of Object.entries(result.values ?? s.uniformValues)) {
        if (valid.has(name)) pruned[name] = value;
      }
      store.patchSilent({
        uniformValues: pruned,
        mainFailed: false,
        diagnostics: result.diagnostics,
      });
      this.mainEditor.setErrorLines([]);
      // 诊断非空 => 后处理编译失败，错误定位到 post 编辑器
      this.postEditor.setErrorLines(result.diagnostics.map((d) => d.line));
    }

    this.preview.showErrors(result.diagnostics, (line) => {
      // 后处理错误跳到 post 编辑器，其余跳到主编辑器
      if (!this.engine.isInErrorState && result.diagnostics.length > 0) {
        this.postEditor.element.classList.remove('hidden');
        this.mainEditor.element.classList.add('hidden');
        this.postEditor.goToLine(line);
      } else {
        this.mainEditor.goToLine(line);
      }
    });
    this.refreshSidebar();

    if (initial) this.applyResolution();
    this.scheduleAutosave();
  }

  private refreshSidebar() {
    const sig = JSON.stringify(this.engine.activeUniforms.map((u) => `${u.name}:${u.kind}`))
      + '|' + JSON.stringify(this.engine.postUniforms.map((u) => `${u.name}:${u.kind}`))
      + '|' + store.get().preview.postEnabled;
    if (sig === this.lastUniformSig) return;
    this.lastUniformSig = sig;
    this.sidebar.render(
      this.engine.activeUniforms,
      this.engine.postUniforms,
      store.get().preview.postEnabled,
    );
  }

  /* ---------------- 参数 / 纹理 ---------------- */

  private updateUniform(name: string, value: UniformValue) {
    const uniforms = { ...store.get().uniformValues, [name]: value };
    store.patchSilent({ uniformValues: uniforms });
    this.scheduleAutosave();
  }

  private handleTextureUpload(name: string, dataUrl: string) {
    const old = store.get().uniformValues[name];
    if (typeof old === 'string' && old) this.engine.invalidateTexture(old);
    this.updateUniform(name, dataUrl);
  }

  /* ---------------- 预览设置 ---------------- */

  private updatePreview(patch: Partial<AppState['preview']>) {
    store.update({ preview: { ...store.get().preview, ...patch } });
    this.applyResolution();
    this.preview.syncControls();
    this.refreshSidebar();
    this.scheduleAutosave();
  }

  private applyResolution() {
    const { width, height } = resolveResolution(store.get().preview);
    this.engine.resize(width, height);
    this.preview.setSizeLabel(width, height);
  }

  /* ---------------- 工程文件 ---------------- */

  private saveProject() {
    const project = store.toProject();
    store.markClean();
    this.updateDirty();
    downloadTextFile(
      safeFileName(project.name, 'shaderlab.json'),
      JSON.stringify(project, null, 2),
      'application/json',
    );
  }

  private syncProjectName(name: string) {
    if (this.nameInput) this.nameInput.value = name;
    this.updateDirty();
  }

  private updateDirty() {
    if (this.dirtyDot) this.dirtyDot.style.display = store.get().dirty ? 'block' : 'none';
  }

  private loadProject(project: ProjectData) {
    store.loadProject(project);
    this.mainEditor.setValue(project.source.main);
    this.postEditor.setValue(project.source.post);
    this.mainEditor.setErrorLines([]);
    this.postEditor.setErrorLines([]);
    this.lastUniformSig = '';
    this.preview.syncControls();
    this.syncProjectName(project.name);
    this.applyResolution();
    this.compileAll(true);
  }

  private exportPng() {
    const dataUrl = this.engine.exportPng();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadDataUrl(safeFileName(`${store.get().projectName}-${stamp}`, 'png'), dataUrl);
  }

  /* ---------------- 主循环 ---------------- */

  private startLoop() {
    const loop = (now: number) => {
      if (this.disposed) return;
      const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
      this.lastFrame = now;

      const s = store.get();
      if (s.time.playing && !s.mainFailed) {
        store.patchSilent({ time: { playing: true, time: s.time.time + dt } });
      }
      this.engine.render(
        store.get().time.time,
        s.preview.mode,
        s.preview.postEnabled,
        store.get().uniformValues,
      );
      this.timeline.sync();
      this.updateDirty();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private autosave = debounce(() => store.saveAutosave(), 500);
  private scheduleAutosave() {
    this.autosave();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.engine.dispose();
  }
}
