import { h, clear, toast } from './dom.js';
import { store } from './store.js';
import { StoryGraph } from './graph.js';
import { nodeInspector, refreshInspectorTags } from './ui/inspector.js';
import { renderSidebar } from './ui/sidebar.js';
import { mountPreview } from './ui/preview.js';
import {
  openExportPanel,
  openNewProjectModal,
  openSettingsPanel,
  openShortcutsModal,
  openTranslationsPanel,
  openValidationPanel,
} from './ui/modals.js';
import {
  deserializeProject,
  createEmptyStory,
  defaultLocale,
  getText,
  LOCALE_PRESETS,
} from './story.js';
import { buildSampleStory } from './sample.js';

const root = document;
const $$ = (selector) => [...root.querySelectorAll(selector)];

let graph = null;
let preview = null;
let inspectorSignature = '';
let highlightMode = 'all';

/* ============================== 顶部栏 ============================== */

function renderTopbar() {
  const { story, report, dirty } = store;
  const titleInput = root.querySelector('#project-title');
  if (document.activeElement !== titleInput) titleInput.value = story.meta.title;

  renderSaveState(dirty);

  const pills = clear(root.querySelector('#status-pills'));
  pills.appendChild(
    h(
      'span',
      { class: `pill ${report.summary.errors ? 'error' : 'ok'}`, title: '结构错误' },
      h('b', {}, String(report.summary.errors)),
      '错误',
    ),
  );
  if (report.summary.warnings) {
    pills.appendChild(h('span', { class: 'pill warn' }, h('b', {}, String(report.summary.warnings)), '警告'));
  }
  if (report.stats.cycles) {
    pills.appendChild(
      h(
        'span',
        {
          class: 'pill cycle',
          title: '检测到循环路径；运行时会限制单节点访问次数',
          style: { cursor: 'pointer' },
          onclick: () => openValidationPanel(store),
        },
        '⟳',
        h('b', {}, String(report.stats.cycles)),
        '循环',
      ),
    );
  }
  if (report.summary.missingTranslations) {
    pills.appendChild(
      h(
        'span',
        {
          class: 'pill warn',
          title: '缺少翻译',
          style: { cursor: 'pointer' },
          onclick: () => openTranslationsPanel(store, { filter: 'missing' }),
        },
        '缺译',
        h('b', {}, String(report.summary.missingTranslations)),
      ),
    );
  }

  const localeSelect = root.querySelector('#text-locale');
  const signature = story.locales.map((locale) => `${locale.code}:${locale.label}`).join('|');
  if (localeSelect.dataset.signature !== signature) {
    localeSelect.dataset.signature = signature;
    clear(localeSelect);
    for (const locale of story.locales) {
      localeSelect.appendChild(h('option', { value: locale.code }, `${locale.label}（${locale.code}）`));
    }
  }
  if (localeSelect.value !== store.editLocale) localeSelect.value = store.editLocale;

  root.querySelector('#btn-undo').disabled = !store.undoStack.length;
  root.querySelector('#btn-redo').disabled = !store.redoStack.length;
}

function renderSaveState(dirty = store.dirty) {
  const saveState = root.querySelector('#save-state');
  if (!saveState) return;
  saveState.textContent = dirty ? '已自动保存到浏览器' : '已保存到浏览器';
  saveState.classList.toggle('dirty', dirty);
}

/* ============================== 侧边栏 ============================== */

function renderSidebarPanel() {
  const tabButtons = $$('.sidebar-tabs .tab');
  for (const button of tabButtons) button.classList.toggle('active', button.dataset.tab === store.sidebarTab);
  renderSidebar(root.querySelector('#sidebar-body'), store);
}

/**
 * 只同步大纲的选中态与标题，不重建 DOM。
 * 文本编辑失焦时会触发同步，重建会移除指针下的元素并吞掉随后的 click。
 */
function syncSidebarSelection() {
  const items = root.querySelectorAll('.outline-item[data-node-id]');
  if (!items.length) return;
  for (const item of items) {
    item.classList.toggle('active', item.dataset.nodeId === store.selection.nodeId);
    const node = store.story.nodes.find((entry) => entry.id === item.dataset.nodeId);
    if (!node) continue;
    const name = item.querySelector('.name');
    if (name && name.textContent !== node.title) name.textContent = node.title;
  }
  const edited = root.querySelector(`.outline-item[data-node-id="${store.selection.nodeId}"]`);
  const node = store.selectedNode;
  if (edited && node) {
    const source = defaultLocale(store.story);
    const preview = getText(node.text, source) || getText(node.text, store.editLocale);
    edited.title = preview || node.title;
    edited.dataset.search = `${node.title} ${preview}`.toLowerCase();
  }
}

/* ============================== 检查器 ============================== */

function renderInspector() {
  const body = root.querySelector('#inspector-body');
  const empty = root.querySelector('#inspector-empty');
  const node = store.selectedNode;
  if (!node) {
    body.hidden = true;
    empty.hidden = false;
    clear(body);
    inspectorSignature = '';
    return;
  }
  empty.hidden = true;
  body.hidden = false;
  const signature = [
    node.id,
    store.editLocale,
    store.report.issues.length,
    store.story.variables.length,
    store.story.characters.length,
    node.choices.map((choice) => choice.id).join(','),
  ].join('|');
  if (signature === inspectorSignature && body.childElementCount) return;
  inspectorSignature = signature;
  clear(body);
  body.appendChild(nodeInspector({ store }));
}

/* ============================== 画布 ============================== */

function graphState() {
  const missingNodeIds = new Set();
  const source = defaultLocale(store.story);
  for (const item of store.report.translations) {
    if (item.locale === source) continue;
    for (const entry of item.missing) {
      if (entry.nodeId) missingNodeIds.add(entry.nodeId);
    }
  }
  const cycleNodeIds = new Set(store.report.cycles.flatMap((cycle) => cycle.nodeIds));
  return {
    nodes: store.story.nodes,
    report: store.report,
    selectedId: store.selection.nodeId,
    editLocale: store.editLocale,
    sourceLocale: defaultLocale(store.story),
    highlight: highlightMode,
    missingNodeIds,
    cycleNodeIds,
  };
}

function refreshGraph() {
  if (!graph) return;
  graph.setData(graphState());
  root.querySelector('#graph-empty').hidden = store.story.nodes.length > 0;
  root.querySelector('#zoom-level').textContent = `${Math.round(graph.camera.scale * 100)}%`;
}

function centerOnNode(nodeId) {
  if (!graph) return;
  graph.centerOn(nodeId);
}

/* ============================== 整体渲染 ============================== */

function renderAll() {
  renderTopbar();
  renderSidebarPanel();
  renderInspector();
  refreshGraph();
}

/* ============================== 事件绑定 ============================== */

function bindTopbar() {
  const titleInput = root.querySelector('#project-title');
  titleInput.addEventListener('change', () => store.renameProject(titleInput.value));
  titleInput.addEventListener('blur', () => {
    titleInput.value = store.story.meta.title;
  });
  titleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') titleInput.blur();
  });

  root.querySelector('#text-locale').addEventListener('change', (event) => {
    store.setEditLocale(event.target.value);
  });

  root.querySelector('#btn-undo').addEventListener('click', () => store.undo());
  root.querySelector('#btn-redo').addEventListener('click', () => store.redo());
  root.querySelector('#btn-new').addEventListener('click', () => {
    openNewProjectModal(store, {
      onCreate: ({ title, locale, template }) => {
        const story = template === 'branch'
          ? buildSampleStory({ title, locale })
          : createEmptyStory({ title, locales: [{ code: locale, label: labelFor(locale) }] });
        store.loadFromObject(story);
        toast('已创建新项目', 'success');
      },
    });
  });
  root.querySelector('#btn-open').addEventListener('click', () => {
    root.querySelector('#file-input').click();
  });
  root.querySelector('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const imported = deserializeProject(text);
      if (store.dirty && !confirm('当前项目有未保存的修改，打开新文件会替换它们。继续？')) return;
      store.loadFromObject(imported);
      refreshGraph();
      graph?.fit();
      toast(`已打开「${imported.meta.title}」`, 'success');
    } catch (error) {
      toast(`打开失败：${error.message}`, 'error');
    }
  });

  root.querySelector('#btn-save').addEventListener('click', () => {
    if (store.editBaseline) store.finishEdit('text:edit');
    store.saveNow();
    renderTopbar();
    toast('已保存到浏览器，下次打开可继续编辑', 'success');
  });

  root.querySelector('#btn-export').addEventListener('click', () => openExportPanel(store));
  root.querySelector('#btn-validation').addEventListener('click', () => openValidationPanel(store));
  root.querySelector('#btn-translations').addEventListener('click', () => openTranslationsPanel(store));
  root.querySelector('#btn-settings').addEventListener('click', () => openSettingsPanel(store));
  root.querySelector('#btn-preview').addEventListener('click', () => preview.togglePreview());

  for (const tab of $$('.sidebar-tabs .tab')) {
    tab.addEventListener('click', () => store.setSidebarTab(tab.dataset.tab));
  }
}

function labelFor(code) {
  return LOCALE_PRESETS.find((item) => item.code === code)?.label || code;
}

function bindStage() {
  root.querySelector('#btn-add-node').addEventListener('click', () => {
    const node = store.addNode();
    if (node) centerOnNode(node.id);
  });
  root.querySelector('#btn-auto-layout').addEventListener('click', () => {
    store.autoLayout();
    refreshGraph();
    graph?.fit();
    toast('已自动排版', 'info');
  });
  root.querySelector('#btn-fit').addEventListener('click', () => graph?.fit());
  root.querySelector('#btn-zoom-in').addEventListener('click', () => {
    graph?.zoomBy(1.2);
    updateZoomLabel();
  });
  root.querySelector('#btn-zoom-out').addEventListener('click', () => {
    graph?.zoomBy(1 / 1.2);
    updateZoomLabel();
  });
  root.querySelector('#graph-highlight').addEventListener('change', (event) => {
    highlightMode = event.target.value;
    refreshGraph();
  });

  graph = new StoryGraph(root.querySelector('#graph'), {
    onSelect: (nodeId, choiceId) => {
      if (nodeId) store.selectNode(nodeId, choiceId);
      else store.selectNode(null);
    },
    onMove: (nodeId, position) => {
      store.moveNode(nodeId, position);
      refreshGraph();
    },
    onConnect: ({ fromNodeId, choiceId, toNodeId }) => {
      if (choiceId) store.updateChoice(fromNodeId, choiceId, { target: toNodeId });
      else store.setNodeNext(fromNodeId, toNodeId);
      refreshGraph();
    },
    onAddNode: (position, link) => {
      const node = store.addNode(position);
      if (!node || !link) return;
      if (link.choiceId) store.updateChoice(link.fromNodeId, link.choiceId, { target: node.id });
      else store.setNodeNext(link.fromNodeId, node.id);
      store.selectNode(node.id);
    },
    onContext: ({ x, y, nodeId, choiceId }) => {
      showContextMenu(x, y, nodeId, choiceId);
    },
    onZoom: () => updateZoomLabel(),
  });
  graph.setData(graphState());
  root.querySelector('#graph-empty').hidden = store.story.nodes.length > 0;
  requestAnimationFrame(() => graph.fit());
}

function updateZoomLabel() {
  if (!graph) return;
  root.querySelector('#zoom-level').textContent = `${Math.round(graph.camera.scale * 100)}%`;
}

/* ============================== 右键菜单 ============================== */

let contextMenuEl = null;

function showContextMenu(x, y, nodeId, choiceId) {
  hideContextMenu();
  const items = [];
  if (nodeId) {
    const node = store.story.nodes.find((item) => item.id === nodeId);
    items.push(
      { label: '编辑节点', action: () => store.selectNode(nodeId) },
      { label: '复制节点', action: () => store.duplicateNode(nodeId) },
      { label: '设为开始节点', action: () => store.setStartNode(nodeId) },
      {
        label: node?.entry ? '取消入口标记' : '标记为入口',
        action: () => store.toggleEntry(nodeId, !node?.entry),
      },
      { label: '从此节点开始试玩', action: () => preview.openAt(nodeId) },
      { separator: true },
      {
        label: '删除节点',
        danger: true,
        action: () => {
          if (confirm(`删除节点「${node?.title}」？`)) store.deleteNode(nodeId);
        },
      },
    );
  } else {
    items.push(
      { label: '在此新建节点', action: () => {
        const rect = root.querySelector('#graph-wrap').getBoundingClientRect();
        const world = graph.toWorld(x - rect.left, y - rect.top);
        const node = store.addNode({ x: Math.round(world.x), y: Math.round(world.y) });
        store.selectNode(node.id);
      } },
      { label: '自动排版', action: () => { store.autoLayout(); refreshGraph(); graph?.fit(); } },
      { label: '适应视图', action: () => graph?.fit() },
    );
  }

  const menu = h(
    'div',
    {
      style: {
        position: 'fixed',
        left: `${x}px`,
        top: `${y}px`,
        zIndex: 90,
        background: 'var(--bg-panel)',
        border: '1px solid var(--line)',
        borderRadius: '9px',
        boxShadow: 'var(--shadow)',
        padding: '4px',
        minWidth: '170px',
      },
    },
    items.map((item) =>
      item.separator
        ? h('div', { style: { height: '1px', background: 'var(--line-soft)', margin: '4px 2px' } })
        : h(
            'button',
            {
              class: 'btn ghost',
              style: {
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                color: item.danger ? '#e8a0a0' : 'var(--text)',
              },
              text: item.label,
              onclick: () => {
                hideContextMenu();
                item.action();
              },
            },
          ),
    ),
  );
  document.body.appendChild(menu);
  contextMenuEl = menu;

  const close = (event) => {
    if (contextMenuEl && contextMenuEl.contains(event.target)) return;
    hideContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close);
    document.addEventListener('contextmenu', close);
  });
  menu.addEventListener('contextmenu', (event) => event.preventDefault());
}

function hideContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

/* ============================== 快捷键与全局事件 ============================== */

function bindGlobal() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.tagName === 'SELECT');
    const meta = event.metaKey || event.ctrlKey;

    if (meta && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (store.editBaseline) store.finishEdit('text:edit');
      store.saveNow();
      renderTopbar();
      toast('已保存', 'success', 1600);
      return;
    }
    if (meta && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      if (typing) return;
      event.preventDefault();
      if (store.editBaseline) store.finishEdit('text:edit');
      store.undo();
      return;
    }
    if (meta && (event.key.toLowerCase() === 'y' || (event.key.toLowerCase() === 'z' && event.shiftKey))) {
      if (typing) return;
      event.preventDefault();
      if (store.editBaseline) store.finishEdit('text:edit');
      store.redo();
      return;
    }
    if (meta && event.key.toLowerCase() === 'o') {
      event.preventDefault();
      root.querySelector('#file-input').click();
      return;
    }
    if (!typing && event.key === '?') {
      event.preventDefault();
      openShortcutsModal();
      return;
    }
    if (!typing && (event.key === 'Delete' || event.key === 'Backspace')) {
      if (!store.selection.nodeId) return;
      event.preventDefault();
      const node = store.selectedNode;
      if (node && confirm(`删除节点「${node.title}」？`)) store.deleteNode(node.id);
      return;
    }
    if (!typing && event.key.toLowerCase() === 'p' && !meta) {
      event.preventDefault();
      preview.togglePreview();
      return;
    }
    if (!typing && event.key === 'Escape') {
      hideContextMenu();
    }
  });
}

/* ============================== Store 事件 ============================== */

let structuralTimer = null;
let pointerDown = false;
let renderPending = false;

/**
 * 结构性变更后重绘。
 * 若鼠标仍按着（典型场景：输入框 onchange 在 mousedown 期间触发），
 * 推迟到 pointerup 之后，否则重建 DOM 会移除指针下的按钮，吞掉这次 click。
 */
function scheduleStructuralRender() {
  renderPending = true;
  if (pointerDown) return;
  if (structuralTimer) return;
  structuralTimer = setTimeout(() => {
    structuralTimer = null;
    if (pointerDown) return;
    if (!renderPending) return;
    renderPending = false;
    inspectorSignature = '';
    renderAll();
  }, 0);
}

function flushPendingRender() {
  if (!renderPending) return;
  scheduleStructuralRender();
}

function bindStore() {
  store.subscribe(({ type, detail }) => {
    switch (type) {
      case 'selection:change':
        renderInspector();
        refreshGraph();
        syncSidebarSelection();
        store.persistSession();
        break;
      case 'locale:change':
        inspectorSignature = '';
        renderAll();
        break;
      case 'sidebar:tab':
        renderSidebarPanel();
        store.persistSession();
        break;
      case 'graph:center':
        if (detail?.nodeId) centerOnNode(detail.nodeId);
        break;
      case 'story:undo':
      case 'story:redo':
      case 'story:load':
      case 'story:new':
        inspectorSignature = '';
        renderAll();
        preview?.onStoryChanged();
        requestAnimationFrame(() => graph?.fit());
        break;
      case 'report:change':
        renderTopbar();
        renderSidebarPanel();
        renderInspector();
        refreshGraph();
        break;
      case 'save:state':
        renderSaveState();
        break;
      case 'story:text':
        // 文本编辑落定：只做原地更新，绝不重建侧边栏/检查器（会吞掉正在进行的手势与点击）
        renderTopbar();
        syncSidebarSelection();
        refreshGraph();
        refreshInspectorTags(root.querySelector('#inspector-body'), store, store.selectedNode);
        preview?.onStoryChanged();
        break;
      default:
        // 结构性修改：若焦点仍在某个输入框里（例如侧边栏改名后按 Tab），延后重建，
        // 避免在 blur 事件派发过程中移除节点导致后续 click 丢失
        scheduleStructuralRender();
        preview?.onStoryChanged();
        break;
    }
  });
}

/* ============================== 启动 ============================== */

function boot() {
  bindTopbar();
  bindStage();
  bindGlobal();
  preview = mountPreview(root, store);
  bindStore();
  renderAll();

  document.addEventListener('pointerdown', () => {
    pointerDown = true;
  }, true);
  document.addEventListener('pointerup', () => {
    pointerDown = false;
    flushPendingRender();
  }, true);
  document.addEventListener('pointercancel', () => {
    pointerDown = false;
    flushPendingRender();
  }, true);

  // 首次打开无项目时的提示
  if (store.story.nodes.length <= 2 && store.story.meta.title === '未命名剧情') {
    setTimeout(() => {
      toast('欢迎使用剧情织机。可以在「设置」中载入示例剧情。', 'info', 5000);
    }, 500);
  }

  requestAnimationFrame(() => {
    graph?.fit();
    refreshGraph();
  });

  window.addEventListener('beforeunload', () => {
    if (store.dirty) store.persist();
  });
}

boot();

export { store, graph, preview };
