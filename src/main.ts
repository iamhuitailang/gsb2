import './styles.css';

import {
  createInitialState,
  type AppState,
} from './state';
import { h, clear } from './ui/dom';
import { renderPackStack, renderBatchPanel } from './ui/renderPacks';
import { renderIssueCenter } from './ui/renderIssues';
import { renderItemGrid, renderTracePanel } from './ui/renderItems';
import { renderProvenanceTable } from './ui/renderProvenance';
import { renderModal } from './ui/renderModal';
import { resolveAll } from './engine/resolve';
import { collectBlockingPacks } from './engine/graph';
import { attemptBatchApply, planBatchApply } from './engine/batch';
import {
  buildExportDoc,
  buildProvenance,
  downloadTextFile,
  parseImportText,
  provenanceToCsv,
  timestampSlug,
} from './engine/transfer';
import { DEFAULT_ENABLED_IDS, DEMO_LIBRARY } from './demoData';
import type { LabConfig } from './types';

const app = document.getElementById('app')!;
const modalRoot = document.getElementById('modal-root')!;
const toastRoot = document.getElementById('toast-root')!;
const importFile = document.getElementById('import-file') as HTMLInputElement;

let state: AppState = createInitialState();
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/* -------------------------------- 渲染 -------------------------------- */

function currentResolution() {
  return resolveAll({
    items: state.items,
    scene: state.config.query.scene,
    language: state.config.query.language,
    library: state.library,
    enabled: state.config.enabled,
    priorities: state.config.priorities,
  });
}

function showToast(text: string, kind: 'ok' | 'error' | 'info' = 'ok'): void {
  state.toast = { text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    renderToast();
  }, 3000);
  renderToast();
}

function renderToast(): void {
  clear(toastRoot);
  if (!state.toast) return;
  toastRoot.appendChild(
    h('div', { class: `toast toast-${state.toast.kind}`, role: 'status', text: state.toast.text }),
  );
}

function renderModalRoot(): void {
  clear(modalRoot);
  const node = renderModal(state);
  if (node) modalRoot.appendChild(node);
}

function renderChrome(enabledCount: number, blockingCount: number): HTMLElement {
  const rightActions = h('div', { class: 'header-actions' }, [
    h('button', { type: 'button', class: 'btn btn-light', text: '导出配置 + 来源 (JSON)', dataset: { action: 'export-json' } }),
    h('button', { type: 'button', class: 'btn btn-light', text: '导出来源清单 (CSV)', dataset: { action: 'export-csv' } }),
    h('button', { type: 'button', class: 'btn btn-light', text: '导入 JSON', dataset: { action: 'import-pick' } }),
    h('button', { type: 'button', class: 'btn btn-ghost-light', text: '重置演示', dataset: { action: 'reset-demo' } }),
  ]);

  const playablePill = h('span', {
    class: `play-pill ${blockingCount > 0 ? 'play-warn' : 'play-ok'}`,
    title: blockingCount > 0 ? '有开启的包不可用，已在解析中跳过' : '所有开启的包均通过依赖校验',
  }, [
    h('span', { class: 'play-dot' }),
    h('span', {
      text:
        blockingCount > 0
          ? `可玩状态运行中：${enabledCount} 个包生效，${blockingCount} 个问题包被跳过`
          : `可玩状态运行中：${enabledCount} 个包全部可用`,
    }),
  ]);

  return h('header', { class: 'topbar' }, [
    h('div', { class: 'topbar-inner' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand-mark', text: '包' }),
        h('div', {}, [
          h('h1', { text: '美术包解析试验场' }),
          h('p', { text: 'Asset Pack Resolver Lab · 同一个道具到底用哪套图' }),
        ]),
      ]),
      rightActions,
    ]),
    h('div', { class: 'querybar' }, [
      h('div', { class: 'query-group' }, [
        h('span', { class: 'query-label', text: '场景' }),
        h('div', { class: 'segmented' }, state.scenes.map((s) =>
          h('button', {
            type: 'button',
            class: `seg-btn ${state.config.query.scene === s.id ? 'is-active' : ''}`,
            text: s.name,
            dataset: { action: 'set-scene', id: s.id },
          }),
        )),
      ]),
      h('div', { class: 'query-group' }, [
        h('label', { class: 'query-label', htmlFor: 'lang-select', text: '语言' }),
        (() => {
          const select = h('select', {
            id: 'lang-select',
            class: 'lang-select',
            dataset: { action: 'set-language' },
          }) as HTMLSelectElement;
          for (const l of state.languages) {
            const opt = document.createElement('option');
            opt.value = l.id;
            opt.textContent = l.name;
            if (l.id === state.config.query.language) opt.selected = true;
            select.appendChild(opt);
          }
          return select;
        })(),
      ]),
      playablePill,
    ]),
  ]);
}

function renderFooter(): HTMLElement {
  return h('footer', { class: 'rule-footer panel' }, [
    h('h3', { text: '解析规则速查' }),
    h('ol', { class: 'rule-list' }, [
      h('li', { text: '包顺序优先：按有效优先级从高到低检查每个包；高优先级包一旦给出变体或移除意见，低优先级包整体被覆盖。' }),
      h('li', { text: '包内逐级回退：场景链 [当前场景 → *] 在外、语言链 [语言精确 → 主标签 → *] 在内，最多 6 级，命中即停。' }),
      h('li', { text: '同级冲突：多个相同优先级的可用包对同一道具表态时记为 conflict；先比匹配精度（阶梯序号），同精度再按包 ID 固定排序，结果始终确定。' }),
      h('li', { text: '依赖校验：缺依赖 / 依赖未开启 / 依赖成环的包标记为不可用并跳过，其他包与道具继续解析预览。' }),
      h('li', { text: '显式移除 ≠ 缺图：removals 命中显示 REMOVED；所有包都无意见才是 MISSING。关闭移除包后原资源立即恢复。' }),
      h('li', { text: '批量应用先出前后对比，确认后才提交；候选配置存在不可用包时提交被拒绝，当前可玩状态保持不变。' }),
    ]),
  ]);
}

function render(): void {
  // 清掉批量面板里已经失效的勾选项
  state.batchSelection = state.batchSelection.filter((id) => {
    const p = state.library.find((x) => x.id === id);
    return !!p?.batchCandidate && !(state.config.enabled[id] ?? false);
  });

  const { analysis, results } = currentResolution();
  const enabledCount = analysis.statuses.filter((s) => s.enabled).length;
  const blockingCount = collectBlockingPacks(analysis).length;

  clear(app);
  app.appendChild(renderChrome(enabledCount, blockingCount));

  const main = h('main', { class: 'layout' }, [
    h('div', { class: 'issue-section' }, [renderIssueCenter(state, analysis, results)]),
    h('div', { class: 'lab-grid' }, [
      h('aside', { class: 'left-rail' }, [
        renderPackStack(state, analysis),
        renderBatchPanel(state, analysis),
      ]),
      h('div', { class: 'content-col' }, [
        renderItemGrid(state, results, new Map(state.library.map((p) => [p.id, p.name]))),
        renderTracePanel(state, results.get(state.config.selectedItemId)),
        renderProvenanceTable(state, results),
      ]),
    ]),
    renderFooter(),
  ]);
  app.appendChild(main);

  renderModalRoot();
}

/* -------------------------------- 动作 -------------------------------- */

function effectivePriorityOf(id: string): number {
  const pack = state.library.find((p) => p.id === id);
  const fallback = pack?.priority ?? 0;
  return state.config.priorities[id] ?? fallback;
}

function scrollToSelector(selector: string): void {
  requestAnimationFrame(() => {
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

async function handleAction(el: HTMLElement): Promise<void> {
  const action = el.dataset.action;
  const id = el.dataset.id ?? '';
  if (!action) return;

  switch (action) {
    case 'set-scene':
      state.config.query.scene = id;
      render();
      break;

    case 'select-item':
      state.config.selectedItemId = id;
      render();
      scrollToSelector('.trace-panel');
      break;

    case 'locate-pack': {
      render();
      const row = document.querySelector(`.pack-row[data-pack-id="${CSS.escape(id)}"]`);
      row?.classList.add('flash');
      scrollToSelector(`.pack-row[data-pack-id="${CSS.escape(id)}"]`);
      setTimeout(() => row?.classList.remove('flash'), 1600);
      break;
    }

    case 'prio-inc':
      state.config.priorities[id] = effectivePriorityOf(id) + 5;
      render();
      break;

    case 'prio-dec':
      state.config.priorities[id] = effectivePriorityOf(id) - 5;
      render();
      break;

    case 'reset-priorities':
      state.config.priorities = {};
      showToast('已恢复各包清单默认优先级');
      render();
      break;

    case 'batch-select-healthy': {
      const { analysis } = currentResolution();
      state.batchSelection = state.library
        .filter((p) => {
          if (!p.batchCandidate || state.config.enabled[p.id]) return false;
          const st = analysis.byId.get(p.id);
          return st && st.manifestIssues.length === 0;
        })
        .map((p) => p.id);
      render();
      break;
    }

    case 'batch-clear':
      state.batchSelection = [];
      render();
      break;

    case 'open-diff': {
      if (state.batchSelection.length === 0) return;
      const selectedIds = [...state.batchSelection];
      const plan = planBatchApply({
        library: state.library,
        items: state.items,
        query: state.config.query,
        currentEnabled: state.config.enabled,
        priorities: state.config.priorities,
        selectedIds,
      });
      state.modal = { type: 'diff', plan, selectedIds };
      renderModalRoot();
      break;
    }

    case 'close-modal':
      state.modal = null;
      renderModalRoot();
      break;

    case 'confirm-apply': {
      const modal = state.modal;
      if (!modal || modal.type !== 'diff') return;
      const result = attemptBatchApply({
        library: state.library,
        currentEnabled: state.config.enabled,
        priorities: state.config.priorities,
        selectedIds: modal.selectedIds,
      });
      if (!result.ok) {
        // 原子拒绝：原 state.config.enabled 从未被修改
        const plan = planBatchApply({
          library: state.library,
          items: state.items,
          query: state.config.query,
          currentEnabled: state.config.enabled,
          priorities: state.config.priorities,
          selectedIds: modal.selectedIds,
        });
        state.modal = { type: 'diff', plan, selectedIds: modal.selectedIds };
        renderModalRoot();
        showToast('存在不可用包，应用被拒绝，原可玩状态未改动', 'error');
        return;
      }
      state.config.enabled = result.enabled;
      state.batchSelection = [];
      state.modal = null;
      render();
      showToast(`已应用 ${modal.selectedIds.length} 个包，新的可玩状态生效`);
      break;
    }

    case 'toggle-expand-all':
      state.expandAllTraces = !state.expandAllTraces;
      render();
      break;

    case 'export-json': {
      const provenance = buildProvenance({
        items: state.items,
        scenes: state.scenes,
        languages: state.languages,
        library: state.library,
        enabled: state.config.enabled,
        priorities: state.config.priorities,
      });
      // 导出完整有效优先级，保证配置自描述
      const fullPriorities: Record<string, number> = {};
      for (const p of state.library) {
        fullPriorities[p.id] = state.config.priorities[p.id] ?? p.priority;
      }
      const config: LabConfig = {
        ...state.config,
        priorities: fullPriorities,
      };
      const doc = buildExportDoc({
        config,
        items: state.items,
        scenes: state.scenes,
        languages: state.languages,
        library: state.library,
        provenance,
      });
      downloadTextFile(
        `asset-pack-config-${timestampSlug()}.json`,
        JSON.stringify(doc, null, 2),
        'application/json;charset=utf-8',
      );
      showToast(`已导出配置与 ${provenance.length} 条全量来源记录`);
      break;
    }

    case 'export-csv': {
      const provenance = buildProvenance({
        items: state.items,
        scenes: state.scenes,
        languages: state.languages,
        library: state.library,
        enabled: state.config.enabled,
        priorities: state.config.priorities,
      });
      downloadTextFile(
        `asset-pack-provenance-${timestampSlug()}.csv`,
        provenanceToCsv(provenance),
        'text/csv;charset=utf-8',
      );
      showToast(`已导出 ${provenance.length} 条来源清单（CSV）`);
      break;
    }

    case 'import-pick':
      importFile.value = '';
      importFile.click();
      break;

    case 'reset-demo':
      state = createInitialState();
      render();
      showToast('已恢复内置演示包库与初始配置', 'info');
      break;

    default:
      break;
  }
}

/* ------------------------------ 事件委托 ------------------------------ */

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement | null;
  const actionEl = target?.closest<HTMLElement>('[data-action]');
  if (!actionEl) return;
  // 复选框 / select 交给 change 处理，避免 click 与 change 双触发
  const action = actionEl.dataset.action;
  if (action === 'toggle-pack' || action === 'toggle-batch' || action === 'set-language') return;
  void handleAction(actionEl);
});

document.addEventListener('change', (e) => {
  const target = e.target as HTMLElement | null;
  const actionEl = target?.closest<HTMLElement>('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'set-language') {
    state.config.query.language = (target as HTMLSelectElement).value;
    render();
    return;
  }

  if (action === 'toggle-pack') {
    const id = actionEl.dataset.id!;
    const input = target as HTMLInputElement;
    state.config.enabled[id] = input.checked;
    render();
    return;
  }

  if (action === 'toggle-batch') {
    const id = actionEl.dataset.id!;
    const checked = (target as HTMLInputElement).checked;
    if (checked) {
      if (!state.batchSelection.includes(id)) state.batchSelection.push(id);
    } else {
      state.batchSelection = state.batchSelection.filter((x) => x !== id);
    }
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-action="select-item"]');
  if (el) {
    e.preventDefault();
    el.click();
  }
});

document.addEventListener('lab-close-modal', () => {
  state.modal = null;
  renderModalRoot();
});

importFile.addEventListener('change', async () => {
  const file = importFile.files?.[0];
  if (!file) return;
  let text: string;
  try {
    text = await file.text();
  } catch {
    state.modal = {
      type: 'import-report',
      ok: false,
      title: '导入失败：无法读取文件',
      lines: ['请确认选择的是本页导出的 .json 文件。'],
    };
    renderModalRoot();
    return;
  }

  const result = parseImportText(text);
  if (!result.ok) {
    state.modal = {
      type: 'import-report',
      ok: false,
      title: '导入失败：文件校验未通过',
      lines: result.errors,
    };
    renderModalRoot();
    return;
  }

  const data = result.data;
  const usingEmbeddedLibrary = data.library.length > 0;
  // 完整导出一定带 library；不含 library 的纯配置文件统一回退到内置演示库
  const library = usingEmbeddedLibrary ? data.library : DEMO_LIBRARY;

  // 以「全关」为底，配置文件中的 enabled 显式覆盖；
  // 纯配置文件套用内置演示库时，先恢复内置默认开关作为兜底。
  const enabled: Record<string, boolean> = {};
  if (!usingEmbeddedLibrary) {
    for (const id of DEFAULT_ENABLED_IDS) enabled[id] = true;
  }
  for (const p of library) enabled[p.id] = false;
  Object.assign(enabled, data.config.enabled);
  for (const id of Object.keys(enabled)) {
    if (!library.some((p) => p.id === id)) delete enabled[id];
  }

  const selectedItemId = data.items.some((i) => i.id === data.config.selectedItemId)
    ? data.config.selectedItemId
    : (data.items[0]?.id ?? '');

  state.library = library;
  state.items = data.items;
  state.scenes = data.scenes;
  state.languages = data.languages;
  state.config = {
    query: data.config.query,
    selectedItemId,
    enabled,
    priorities: data.config.priorities,
  };
  state.batchSelection = [];
  state.revision += 1;

  const mismatchCount = data.verification?.mismatches.length ?? 0;
  const lines = [
    `资源包 ${library.length} 套 · 道具 ${data.items.length} 个 · 场景 ${data.scenes.length} 个 · 语言 ${data.languages.length} 种`,
    data.exportedAt ? `导出于 ${new Date(data.exportedAt).toLocaleString()}` : '文件未记录导出时间',
    ...data.warnings,
  ];
  if (data.verification) {
    lines.push(
      mismatchCount === 0
        ? `来源复算：${data.verification.consistent}/${data.verification.checked} 条与导出时完全一致，覆盖结果已重现。`
        : `来源复算发现 ${mismatchCount} 条不一致（最多展示前 20 条）：`,
    );
    for (const m of data.verification.mismatches) lines.push(`· ${m}`);
  } else {
    lines.push('该文件未内嵌全量来源清单，已按导入的配置 / 清单重新解析。');
  }

  state.modal = {
    type: 'import-report',
    ok: mismatchCount === 0,
    title: mismatchCount === 0 ? '导入成功，覆盖结果已重现' : '配置已导入，但复算存在差异',
    lines,
    verification: data.verification
      ? {
          checked: data.verification.checked,
          consistent: data.verification.consistent,
          mismatchCount,
        }
      : null,
  };

  render();
});

/* -------------------------------- 启动 -------------------------------- */

render();
