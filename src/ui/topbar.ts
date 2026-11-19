import type { AppState, Store } from '../app/state.ts';
import type { Project } from '../core/types.ts';
import { PRESETS } from '../core/presets.ts';
import { createProject } from '../core/project.ts';
import { button } from './controls.ts';
import { downloadBlob, fmt, h, safeFilename, toast } from './dom.ts';

export interface TopBarView {
  root: HTMLElement;
  update(state: AppState): void;
}

export interface TopBarDeps {
  store: Store;
  loadProject(project: Project): void;
  saveProject(): void;
  openProject(): void;
  exportConfig(): void;
  exportSheet(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

export function createTopBar(deps: TopBarDeps): TopBarView {
  const projectName = h('div', { class: 'project-name' });
  const dirtyBadge = h('span', { class: 'dirty-badge' });

  const presetSelect = h('select', { class: 'select', attrs: { 'aria-label': '载入示例' } });
  presetSelect.append(h('option', { text: '载入示例…', attrs: { value: '' } }));
  for (const preset of PRESETS) {
    presetSelect.append(h('option', { text: preset.name, attrs: { value: preset.id } }));
  }
  presetSelect.addEventListener('change', () => {
    const id = presetSelect.value;
    presetSelect.value = '';
    const preset = PRESETS.find((item) => item.id === id);
    if (!preset) return;
    deps.loadProject(preset.build());
    toast(`已载入示例：${preset.name}`);
  });

  const undoButton = button('撤销', () => deps.undo(), { title: '撤销（Ctrl/⌘+Z）' });
  const redoButton = button('重做', () => deps.redo(), { title: '重做（Ctrl/⌘+Shift+Z）' });
  const newButton = button(
    '新建',
    () => {
      deps.loadProject(createProject({ name: '新建粒子工程' }));
    },
    { variant: 'ghost' },
  );

  const root = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark', text: '✦' }),
      h('div', {}, h('strong', { text: '粒子工坊' }), h('small', { text: 'Particle Studio' })),
    ),
    h('div', { class: 'topbar-project' }, projectName, dirtyBadge),
    h(
      'div',
      { class: 'topbar-actions' },
      presetSelect,
      newButton,
      undoButton,
      redoButton,
      button('打开', () => deps.openProject()),
      button('导出配置', () => deps.exportConfig()),
      button('导出序列图', () => deps.exportSheet()),
      button('保存工程', () => deps.saveProject(), { variant: 'primary' }),
    ),
  );

  return {
    root,
    update(state) {
      projectName.textContent = state.project.name;
      projectName.title = state.project.name;
      dirtyBadge.textContent = state.dirty ? '未保存' : '已保存';
      dirtyBadge.className = `dirty-badge${state.dirty ? ' is-dirty' : ''}`;
      undoButton.disabled = !deps.canUndo();
      redoButton.disabled = !deps.canRedo();
    },
  };
}

export function createHelpOverlay(): { root: HTMLElement; show(): void; hide(): void; toggle(): void } {
  const rows: [string, string][] = [
    ['空格', '播放 / 暂停'],
    ['← / →', '上一帧 / 下一帧'],
    ['Home', '回到时间轴开头'],
    ['Ctrl/⌘ + Z', '撤销工程修改'],
    ['Ctrl/⌘ + Shift + Z', '重做'],
    ['Ctrl/⌘ + S', '保存工程文件'],
    ['Ctrl/⌘ + O', '打开工程文件'],
    ['拖动舞台圆点', '移动选中的发射器'],
  ];

  const overlay = h('div', { class: 'help-overlay' });
  const dialog = h(
    'div',
    { class: 'help-panel' },
    h('h2', { text: '快捷键与说明' }),
    h(
      'div',
      { class: 'help-grid' },
      rows.map(([key, desc]) =>
        h('div', { class: 'help-row' }, h('kbd', { text: key }), h('span', { text: desc })),
      ),
    ),
    h(
      'div',
      { class: 'help-notes' },
      h('p', { text: '预览是无状态重算的：拖动时间轴、逐帧前进或跳到任意帧，结果只取决于参数与随机种子。' }),
      h('p', { text: '修改参数时预览立即刷新；为避免播放推进与编辑互相干扰，编辑会自动暂停播放。' }),
      h('p', { text: '粒子上限用于防止页面卡死：超出后按比例抽稀显示，并在统计区与画面左上角明确提示。' }),
      h('p', { text: '保存工程会下载 JSON 文件，重新打开可完整还原发射器与曲线；导出配置给出引擎友好的扁平结构。' }),
    ),
    h('div', { class: 'dialog-footer' }, button('知道了', () => hide(), { variant: 'primary' })),
  );
  overlay.append(dialog);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) hide();
  });

  function show() {
    overlay.classList.add('is-open');
  }
  function hide() {
    overlay.classList.remove('is-open');
  }

  return { root: overlay, show, hide, toggle: () => (overlay.classList.contains('is-open') ? hide() : show()) };
}

export function downloadProject(project: Project, text: string) {
  downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), safeFilename(project.name, 'particle.json'));
  toast(`已保存工程（${fmt(new Blob([text]).size)} 字节）`);
}

export function downloadConfig(project: Project, text: string) {
  downloadBlob(new Blob([text], { type: 'application/json;charset=utf-8' }), safeFilename(project.name, 'config.json'));
  toast('已导出运行时配置 JSON');
}
