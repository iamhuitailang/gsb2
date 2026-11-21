import { h, clear, toast, download, download_name } from '../dom.js';
import { issueIcon } from './inspector.js';
import {
  LOCALE_PRESETS,
  defaultLocale,
  getText,
  hasText,
  localeLabel,
  localeList,
  serializeProject,
} from '../story.js';
import { buildTranslationReport } from '../validation.js';
import { buildRuntimeData, exportRuntimeJSON } from '../exporter.js';

/* ------------------------------ 模态框外壳 ------------------------------ */

let activeModal = null;

export function openModal({ title, subtitle, body, footer, size = '' }) {
  closeModal();
  const modalRoot = document.getElementById('modal-root');
  const modal = h(
    'div',
    { class: `modal ${size}` },
    h(
      'div',
      { class: 'modal-head' },
      h('h3', { text: title }),
      subtitle ? h('span', { class: 'sub', text: subtitle }) : h('span', { class: 'sub' }),
      h('button', { class: 'icon-btn', 'aria-label': '关闭', text: '✕', onclick: closeModal }),
    ),
    h('div', { class: 'modal-body' }, body),
    footer ? h('div', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', {
    class: 'modal-backdrop',
    onpointerdown: (event) => {
      if (event.target === backdrop) closeModal();
    },
  }, modal);
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
  modalRoot.appendChild(backdrop);
  activeModal = { backdrop, modal, returnFocus: document.activeElement };
  setTimeout(() => modal.querySelector('input, textarea, button')?.focus(), 30);
  document.addEventListener('keydown', escClose, true);
  return modal;
}

function escClose(event) {
  if (event.key === 'Escape' && activeModal) {
    event.stopPropagation();
    closeModal();
  }
}

export function closeModal() {
  if (!activeModal) return;
  document.removeEventListener('keydown', escClose, true);
  activeModal.backdrop.remove();
  activeModal.returnFocus?.focus?.();
  activeModal = null;
}

/* ------------------------------ 检查面板 ------------------------------ */

export function openValidationPanel(store) {
  const report = store.report;
  const grouped = {
    error: report.issues.filter((issue) => issue.severity === 'error'),
    warning: report.issues.filter((issue) => issue.severity === 'warning'),
    hint: report.issues.filter((issue) => issue.severity === 'hint'),
  };

  const section = (severity, list, title) =>
    list.length
      ? h(
          'div',
          { class: 'issue-group' },
          h('h4', {}, issueIcon(severity), `${title} · ${list.length}`),
          h(
            'div',
            { class: 'issue-list' },
            list.map((issue) => {
              const node = issue.nodeId ? store.story.nodes.find((item) => item.id === issue.nodeId) : null;
              return h(
                'div',
                {
                  class: `issue ${issue.severity}`,
                  style: node ? { cursor: 'pointer' } : null,
                  onclick: () => {
                    if (!node) return;
                    closeModal();
                    store.selectNode(node.id, issue.choiceId || null);
                    store.emit('graph:center', { nodeId: node.id });
                  },
                },
                issueIcon(issue.severity),
                h(
                  'div',
                  { class: 'body' },
                  issue.message,
                  node ? h('div', { class: 'cond-help', style: { marginTop: '2px' } }, `节点：${node.title}`) : null,
                ),
                node ? h('span', { class: 'jump', text: '定位' }) : null,
              );
            }),
          ),
        )
      : null;

  const structure = h(
    'div',
    { class: 'settings-grid' },
    statCard('节点 / 选项 / 连线', `${report.stats.nodes} / ${report.stats.choices} / ${report.stats.edges}`),
    statCard('入口 / 汇合点', `${report.stats.entries} / ${report.stats.merges}`),
    statCard('循环路径', `${report.stats.cycles}`, report.stats.cycles > 0 ? 'loop' : null),
    statCard('语言 / 变量 / 角色', `${report.stats.locales} / ${report.stats.variables} / ${report.stats.characters}`),
  );

  const cycles = report.cycles.length
    ? h(
        'div',
        { class: 'issue-group' },
        h('h4', {}, '⟳ 循环路径'),
        h(
          'div',
          { class: 'issue-list' },
          report.cycles.map((cycle) => {
            const titles = cycle.nodeIds.map((id) => store.story.nodes.find((node) => node.id === id)?.title || id);
            const label = cycle.selfLoop ? `${titles[0]}（自循环）` : `${titles.join(' → ')} → ${titles[0]}`;
            return h(
              'div',
              {
                class: 'issue hint',
                style: { cursor: 'pointer' },
                onclick: () => {
                  closeModal();
                  store.selectNode(cycle.nodeIds[0]);
                  store.emit('graph:center', { nodeId: cycle.nodeIds[0] });
                },
              },
              issueIcon('hint'),
              h(
                'div',
                { class: 'body' },
                label,
                h(
                  'div',
                  { class: 'cond-help', style: { marginTop: '2px' } },
                  `运行时单节点最多访问 ${store.story.settings.maxVisitsPerNode} 次，超过即停止，避免无限播放`,
                ),
              ),
              h('span', { class: 'jump', text: '定位' }),
            );
          }),
        ),
      )
    : null;

  const merges = report.merges.length
    ? h(
        'div',
        { class: 'issue-group' },
        h('h4', {}, `⇥ 汇合点 · ${report.merges.length}`),
        h(
          'div',
          { class: 'issue-list' },
          report.merges.map((merge) => {
            const node = store.story.nodes.find((item) => item.id === merge.nodeId);
            const sources = merge.sources.map((id) => store.story.nodes.find((item) => item.id === id)?.title || id);
            return h(
              'div',
              {
                class: 'issue hint',
                style: { cursor: 'pointer' },
                onclick: () => {
                  closeModal();
                  store.selectNode(merge.nodeId);
                  store.emit('graph:center', { nodeId: merge.nodeId });
                },
              },
              h('span', { class: 'ico' }, '⇥'),
              h(
                'div',
                { class: 'body' },
                `「${node?.title || merge.nodeId}」汇合 ${merge.sources.length} 条路径`,
                h('div', { class: 'cond-help', style: { marginTop: '2px' } }, `来源：${sources.join('、')}`),
              ),
              h('span', { class: 'jump', text: '定位' }),
            );
          }),
        ),
      )
    : null;

  const body = h(
    'div',
    null,
    h(
      'div',
      { class: 'tabs-row' },
      h('span', { class: 'tab active' }, '问题'),
    ),
    structure,
    h('div', { style: { height: '14px' } }),
    section('error', grouped.error, '错误'),
    section('warning', grouped.warning, '警告'),
    section('hint', grouped.hint, '提示'),
    cycles,
    merges,
    !report.issues.length
      ? h('div', { class: 'empty-state' }, h('div', { style: { fontSize: '30px', marginBottom: '8px' } }, '✓'), '没有发现问题。剧情结构完整，条件与变量均可解析。')
      : null,
  );

  openModal({
    title: '剧情检查',
    subtitle: `错误 ${report.summary.errors} · 警告 ${report.summary.warnings} · 提示 ${report.summary.hints}`,
    body,
    footer: h(
      'button',
      { class: 'btn', text: '关闭', onclick: closeModal },
    ),
    size: 'wide',
  });
}

function statCard(label, value, kind) {
  return h(
    'div',
    { class: 'settings-section' },
    h('h4', { text: label }),
    h('div', { style: { fontSize: '20px', fontWeight: 650, fontFamily: 'var(--mono)', color: kind === 'loop' ? 'var(--violet)' : 'var(--text)' } }, value),
  );
}

/* ------------------------------ 翻译工作台 ------------------------------ */

export function openTranslationsPanel(store, options = {}) {
  const story = store.story;
  const source = defaultLocale(story);
  let localeFilter = options.locale || localeList(story).find((code) => code !== source) || source;
  let filterMode = options.filter || 'all';
  let query = '';

  const content = h('div');

  const render = () => {
    clear(content);
    const report = buildTranslationReport(story);
    const locales = localeList(story).filter((code) => code !== source);

    if (!locales.length) {
      content.appendChild(
        h(
          'div',
          { class: 'empty-state' },
          '当前只有原文一种语言。',
          h('div', { style: { marginTop: '10px' } }, h('button', {
            class: 'btn primary',
            text: '打开语言设置',
            onclick: () => {
              closeModal();
              openSettingsPanel(store);
            },
          })),
        ),
      );
      return;
    }

    const current = report.find((item) => item.locale === localeFilter) || report[0];
    localeFilter = current.locale;

    /* --- 语言摘要 --- */
    const summary = h(
      'div',
      { class: 'locale-list' },
      report.map((item) => {
        const percent = item.total ? Math.round((item.translatedCount / item.total) * 100) : 100;
        const cls = percent >= 100 ? '' : percent > 60 ? 'warn' : 'bad';
        return h(
          'div',
          {
            class: 'locale-row',
            style: { cursor: 'pointer', outline: item.locale === current.locale ? '1px solid var(--accent-line)' : 'none' },
            onclick: () => {
              localeFilter = item.locale;
              render();
            },
          },
          h('span', { class: 'code', text: item.locale }),
          h('span', { class: 'label', text: localeLabel(story, item.locale) }),
          h('div', { class: `progress-bar ${cls}` }, h('i', { style: { width: `${percent}%` } })),
          h('span', { class: 'num', style: { color: 'var(--text-faint)', fontSize: '11px', minWidth: '76px', textAlign: 'right' } }, `${item.translatedCount}/${item.total} · ${percent}%`),
          item.staleCount ? h('span', { class: 'badge warn' }, `待复核 ${item.staleCount}`) : null,
          item.missingCount ? h('span', { class: 'badge err' }, `缺 ${item.missingCount}`) : h('span', { class: 'badge' }, '完整'),
        );
      }),
    );

    /* --- 筛选栏 --- */
    const searchInput = h('input', {
      class: 'input',
      placeholder: '搜索原文或译文…',
      value: query,
      oninput: (event) => {
        query = event.target.value;
        render();
        const input = content.querySelector('.filter-row .input');
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
      },
    });

    const filterSelect = h(
      'select',
      {
        class: 'select',
        style: { width: 'auto' },
        onchange: (event) => {
          filterMode = event.target.value;
          render();
        },
      },
      h('option', { value: 'all', selected: filterMode === 'all' }, '全部条目'),
      h('option', { value: 'missing', selected: filterMode === 'missing' }, `仅缺少翻译（${current.missingCount}）`),
      h('option', { value: 'stale', selected: filterMode === 'stale' }, `仅待复核（${current.staleCount}）`),
    );

    let items = current.items;
    if (filterMode === 'missing') items = items.filter((item) => !hasText(item.map, current.locale));
    if (filterMode === 'stale') items = items.filter((item) => current.stale.includes(item));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      items = items.filter(
        (item) =>
          item.sourceText.toLowerCase().includes(q) ||
          getText(item.map, current.locale).toLowerCase().includes(q) ||
          item.label.toLowerCase().includes(q),
      );
    }

    const rows = items.map((item) => translatorRow(store, item, current.locale, source));

    content.appendChild(summary);
    content.appendChild(
      h(
        'div',
        { class: 'filter-row', style: { marginTop: '14px' } },
        searchInput,
        filterSelect,
        h('button', {
          class: 'btn small',
          text: '导出缺译清单',
          onclick: () => exportMissingJSON(store, current),
        }),
      ),
    );
    content.appendChild(
      h(
        'div',
        { class: 'side-head', style: { margin: '4px 0 2px' } },
        h('span', {}, `${items.length} 条条目 · 原文 ${source} → ${current.locale}`),
      ),
    );
    content.appendChild(
      rows.length
        ? h('div', {}, rows)
        : h('div', { class: 'empty-state' }, filterMode === 'missing' ? '这个语言没有缺失的翻译。' : '没有匹配的条目。'),
    );
  };

  const body = h(
    'div',
    null,
    h(
      'div',
      { class: 'hint-box', style: { marginBottom: '12px' } },
      '每个语言都是独立字段：修改原文只会把对应译文标记为「待复核」，绝不会清空或覆盖已有译文。',
    ),
    content,
  );

  render();

  openModal({
    title: '翻译工作台',
    subtitle: `${story.locales.length} 种语言`,
    body,
    footer: h(
      'button',
      { class: 'btn', text: '关闭', onclick: closeModal },
    ),
    size: 'wide',
  });
}

function translatorRow(store, item, locale, source) {
  const story = store.story;
  const currentValue = getText(item.map, locale);
  const missing = !hasText(item.map, locale);
  const stale = item.stale.includes(locale);

  const jump = () => {
    closeModal();
    if (item.nodeId) {
      store.selectNode(item.nodeId, item.choiceId || null);
      store.emit('graph:center', { nodeId: item.nodeId });
    } else if (item.characterId) {
      store.setSidebarTab('characters');
    }
  };

  const kindLabel = item.kind === 'node-text' ? '台词' : item.kind === 'choice' ? '选项' : '角色名';

  const statusEl = h(
    'span',
    { class: `status ${missing ? 'missing' : stale ? 'stale' : 'ok'}` },
    missing ? '缺少翻译' : stale ? '待复核' : '已翻译',
  );

  const textarea = h('textarea', {
    class: 'textarea',
    rows: 1,
    placeholder: '输入翻译…',
    onchange: (event) => {
      const value = event.target.value;
      // 只写入当前语言；其他语言与原文保持不变
      if (item.kind === 'node-text') store.setNodeText(item.nodeId, locale, value);
      else if (item.kind === 'choice') store.setChoiceText(item.nodeId, item.choiceId, locale, value);
      else if (item.kind === 'character') store.setCharacterName(item.characterId, locale, value);
      // 就地更新状态，不重建列表（保持滚动与焦点，便于连续录入）
      const nowMissing = !value.trim();
      statusEl.className = `status ${nowMissing ? 'missing' : 'ok'}`;
      statusEl.textContent = nowMissing ? '缺少翻译' : '已翻译';
    },
  });
  textarea.value = currentValue;

  return h(
    'div',
    { class: 'translator-row' },
    h(
      'div',
      { class: 'translator-src' },
      h('span', { class: 'label' }, `${kindLabel} · ${item.label}`),
      item.sourceText,
      h(
        'div',
        { style: { marginTop: '5px' } },
        h('button', { class: 'btn small ghost', style: { padding: '0 6px', fontSize: '10.5px' }, text: '定位 →', onclick: jump }),
      ),
    ),
    h(
      'div',
      { class: 'translator-fields' },
      h(
        'div',
        { class: 'translator-field' },
        h(
          'div',
          { class: 'head' },
          h('span', { text: `${localeLabel(story, locale)}（${locale}）` }),
          statusEl,
        ),
        textarea,
      ),
    ),
  );
}

function exportMissingJSON(store, report) {
  const data = {
    format: 'storyloom.translation-todo',
    locale: report.locale,
    label: localeLabel(store.story, report.locale),
    sourceLocale: defaultLocale(store.story),
    entries: report.missing.map((item) => ({
      key: item.key,
      kind: item.kind,
      label: item.label,
      nodeId: item.nodeId || null,
      choiceId: item.choiceId || null,
      characterId: item.characterId || null,
      source: item.sourceText,
      translation: '',
    })),
    stale: report.stale.map((item) => ({
      key: item.key,
      label: item.label,
      source: item.sourceText,
      translation: getText(item.map, report.locale),
    })),
  };
  download(download_name(`${store.story.meta.title}-${report.locale}-todo`, 'json'), JSON.stringify(data, null, 2));
  toast(`已导出 ${report.missing.length} 条缺译条目`, 'success');
}

/* ------------------------------ 项目设置 ------------------------------ */

export function openSettingsPanel(store) {
  const story = store.story;
  const source = defaultLocale(story);

  const titleInput = h('input', {
    class: 'input',
    value: story.meta.title,
    onchange: (event) => store.renameProject(event.target.value),
  });
  const descInput = h('textarea', {
    class: 'textarea',
    rows: 2,
    onchange: (event) => store.updateDescription(event.target.value),
  });
  descInput.value = story.meta.description || '';

  const maxSteps = h('input', {
    class: 'input',
    type: 'number',
    min: 10,
    max: 2000,
    value: story.settings.maxSteps,
    onchange: (event) => store.updateSettings({ maxSteps: Math.max(10, Math.min(2000, Number(event.target.value) || 200)) }),
  });
  const maxVisits = h('input', {
    class: 'input',
    type: 'number',
    min: 2,
    max: 50,
    value: story.settings.maxVisitsPerNode,
    onchange: (event) => store.updateSettings({ maxVisitsPerNode: Math.max(2, Math.min(50, Number(event.target.value) || 3)) }),
  });

  const localeRows = story.locales.map((locale) => {
    const isSource = locale.code === source;
    return h(
      'div',
      { class: 'locale-row' },
      h('span', { class: 'code', text: locale.code }),
      h('span', { class: 'label', text: locale.label }),
      isSource ? h('span', { class: 'src-tag' }, '原文') : null,
      !isSource
        ? h('button', {
            class: 'icon-btn danger',
            title: '移除语言（该语言的所有译文将被删除）',
            text: '✕',
            onclick: () => {
              if (confirm(`移除语言 ${locale.code}？该语言下的所有译文会被删除。`)) {
                store.removeLocale(locale.code);
                closeModal();
                openSettingsPanel(store);
              }
            },
          })
        : null,
      !isSource
        ? h('button', {
            class: 'btn small ghost',
            text: '设为原文',
            onclick: () => {
              store.setDefaultLocale(locale.code);
              closeModal();
              openSettingsPanel(store);
            },
          })
        : null,
    );
  });

  const newCode = h('input', {
    class: 'input',
    placeholder: '语言代码，如 en / ja',
    list: 'locale-presets',
  });
  const newLabel = h('input', { class: 'input', placeholder: '显示名称' });
  const datalist = h(
    'datalist',
    { id: 'locale-presets' },
    LOCALE_PRESETS.map((preset) => h('option', { value: preset.code }, preset.label)),
  );

  newCode.addEventListener('input', () => {
    const preset = LOCALE_PRESETS.find((item) => item.code === newCode.value.trim());
    if (preset && !newLabel.value.trim()) newLabel.placeholder = preset.label;
  });

  const addLocale = () => {
    const code = newCode.value.trim();
    if (!code) return;
    const preset = LOCALE_PRESETS.find((item) => item.code === code);
    if (!store.addLocale(code, newLabel.value.trim() || preset?.label || code)) {
      toast('语言已存在或代码无效', 'error');
      return;
    }
    closeModal();
    openSettingsPanel(store);
  };

  const body = h(
    'div',
    null,
    h(
      'div',
      { class: 'settings-grid' },
      h(
        'div',
        { class: 'settings-section' },
        h('h4', {}, '项目'),
        h('div', { class: 'form-grid' }, fieldRow('标题', titleInput), fieldRow('简介', descInput)),
      ),
      h(
        'div',
        { class: 'settings-section' },
        h('h4', {}, '运行限制'),
        h(
          'div',
          { class: 'form-row' },
          fieldRow('最大步数', maxSteps),
          fieldRow('单节点访问上限', maxVisits),
        ),
        h(
          'div',
          { class: 'cond-help', style: { marginTop: '8px', lineHeight: '1.6' } },
          '循环路径会在达到单节点访问上限时自动停止，避免无限播放；最大步数是整局的兜底上限。',
        ),
      ),
    ),
    h(
      'div',
      { class: 'settings-section', style: { marginTop: '14px' } },
      h('h4', {}, `语言 · ${story.locales.length}`),
      h('div', { class: 'locale-list' }, localeRows),
      h(
        'div',
        { class: 'locale-add' },
        newCode,
        newLabel,
        h('button', { class: 'btn', text: '＋ 添加', onclick: addLocale }),
      ),
      datalist,
      h(
        'div',
        { class: 'cond-help', style: { marginTop: '8px', lineHeight: '1.6' } },
        `原文语言是 ${source}。修改原文时，其他语言的已有译文会保留并被标记为「待复核」。`,
      ),
    ),
    h(
      'div',
      { class: 'settings-section', style: { marginTop: '14px' } },
      h('h4', {}, '项目文件'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
        h('button', {
          class: 'btn',
          text: '下载项目文件（含编辑状态）',
          onclick: () => {
            download(download_name(story.meta.title, 'json').replace('.json', '.story.json'), serializeProject(story));
            toast('已下载项目文件', 'success');
          },
        }),
        h('button', {
          class: 'btn ghost',
          text: '从文件打开…',
          onclick: () => {
            closeModal();
            document.getElementById('file-input')?.click();
          },
        }),
      ),
      h(
        'div',
        { class: 'cond-help', style: { lineHeight: '1.6' } },
        '编辑器会自动保存到浏览器（重新打开可继续）。项目文件用于备份、跨设备继续编辑或提交到版本库。',
      ),
    ),
    h(
      'div',
      { class: 'settings-section', style: { marginTop: '14px' } },
      h('h4', {}, '示例剧情'),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', {
          class: 'btn',
          text: '载入「雾中的灯塔」示例',
          onclick: async () => {
            try {
              const { mistyLighthouseStory } = await import('../sample.js');
              store.loadFromObject(mistyLighthouseStory());
              closeModal();
              toast('已载入示例剧情', 'success');
            } catch (error) {
              toast(`载入失败：${error.message}`, 'error');
            }
          },
        }),
        h('button', {
          class: 'btn ghost',
          text: '下载示例 JSON',
          onclick: async () => {
            const { mistyLighthouseStory } = await import('../sample.js');
            download(download_name('misty-lighthouse', 'json').replace('.json', '.story.json'), serializeProject(mistyLighthouseStory()));
          },
        }),
      ),
      h('div', { class: 'cond-help', style: { marginTop: '8px' } }, '示例包含条件分支、汇合点、多入口、循环路径与三种语言（含少量缺译）。'),
    ),
  );

  openModal({
    title: '项目设置',
    subtitle: story.meta.title,
    body,
    footer: h('button', { class: 'btn', text: '完成', onclick: closeModal }),
  });
}

function fieldRow(label, control) {
  return h('label', { class: 'field' }, h('span', { text: label }), control);
}

/* ------------------------------ 导出 ------------------------------ */

export function openExportPanel(store) {
  const story = store.story;
  const report = store.report;
  const data = buildRuntimeData(story);
  const json = JSON.stringify(data, null, 2);
  const fileBase = download_name(story.meta.title, 'json').replace(/\.json$/, '');

  const preview = h('pre', { class: 'code-block', html: highlightJSON(json.slice(0, 12000)) });
  const warningBox =
    report.summary.errors > 0
      ? h(
          'div',
          { class: 'hint-box warn', style: { marginBottom: '10px' } },
          `仍有 ${report.summary.errors} 个错误。导出的数据可能无法正常运行，建议先在「检查」中修复。`,
        )
      : null;

  const stats = h(
    'div',
    { class: 'cond-help', style: { marginBottom: '10px', display: 'flex', gap: '14px', flexWrap: 'wrap' } },
    h('span', {}, `节点 ${data.story.nodes.length}`),
    h('span', {}, `选项 ${story.nodes.reduce((total, node) => total + node.choices.length, 0)}`),
    h('span', {}, `语言 ${data.story.locales.length}`),
    h('span', {}, `大小 ${formatBytes(new Blob([json]).size)}`),
  );

  const body = h(
    'div',
    null,
    warningBox,
    stats,
    h(
      'div',
      { class: 'hint-box', style: { marginBottom: '12px' } },
      '导出的是游戏运行时读取的数据：只包含播放所需字段（台词、条件、赋值、分支目标），不含编辑器坐标与备注。',
    ),
    h(
      'div',
      { style: { display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' } },
      h('button', {
        class: 'btn primary',
        text: '下载剧情数据 (.json)',
        onclick: () => {
          download(`${fileBase}.runtime.json`, exportRuntimeJSON(story));
          toast('已导出运行时剧情数据', 'success');
        },
      }),
      h('button', {
        class: 'btn',
        text: '复制到剪贴板',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(json);
            toast('已复制 JSON', 'success');
          } catch {
            toast('浏览器拒绝了剪贴板访问', 'error');
          }
        },
      }),
      h('button', {
        class: 'btn ghost',
        text: '复制下载链接',
        onclick: () => {
          download(`${fileBase}.runtime.json`, json);
          toast('已下载；可直接在游戏工程中引用此文件', 'info');
        },
      }),
    ),
    preview,
  );

  openModal({
    title: '导出剧情数据',
    subtitle: `${data.story.nodes.length} 个节点 · ${data.story.locales.length} 种语言`,
    body,
    footer: h(
      'div',
      { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'btn ghost', text: '关闭', onclick: closeModal }),
    ),
    size: 'wide',
  });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightJSON(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = 'n';
      if (/^"/.test(match)) cls = /:$/.test(match) ? 'k' : 's';
      else if (/true|false|null/.test(match)) cls = 'b';
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

/* ------------------------------ 新建项目 ------------------------------ */

export function openNewProjectModal(store, callbacks = {}) {
  const titleInput = h('input', { class: 'input', value: '未命名剧情', placeholder: '剧情标题' });
  const localesInput = h('input', {
    class: 'input',
    value: 'zh-CN',
    placeholder: '原文语言代码，如 zh-CN',
  });
  const templateSelect = h(
    'select',
    { class: 'select' },
    h('option', { value: 'empty' }, '空白（开始 → 结局）'),
    h('option', { value: 'branch' }, '三分支 + 汇合点示例'),
  );

  const body = h(
    'div',
    { class: 'form-grid' },
    fieldRow('标题', titleInput),
    fieldRow('原文语言', localesInput),
    fieldRow('起始结构', templateSelect),
    h('div', { class: 'hint-box' }, '新建会替换当前项目。如有未导出的修改，请先保存或导出。'),
  );

  openModal({
    title: '新建剧情项目',
    body,
    size: 'narrow',
    footer: h(
      'div',
      { style: { display: 'flex', gap: '8px' } },
      h('button', { class: 'btn ghost', text: '取消', onclick: closeModal }),
      h('button', {
        class: 'btn primary',
        text: '创建',
        onclick: () => {
          closeModal();
          callbacks.onCreate?.({
            title: titleInput.value.trim() || '未命名剧情',
            locale: localesInput.value.trim() || 'zh-CN',
            template: templateSelect.value,
          });
        },
      }),
    ),
  });
}

/* ------------------------------ 快捷键帮助 ------------------------------ */

export function openShortcutsModal() {
  const rows = [
    ['Ctrl / Cmd + Z', '撤销'],
    ['Ctrl / Cmd + Shift + Z', '重做'],
    ['Ctrl / Cmd + S', '保存到浏览器'],
    ['Ctrl / Cmd + O', '打开项目文件'],
    ['P', '切换试玩面板'],
    ['Delete / Backspace', '删除选中节点'],
    ['空格 + 拖动', '平移画布'],
    ['滚轮', '缩放画布'],
    ['双击空白', '新建节点'],
    ['拖动右侧圆点', '连接到目标节点 / 拖到空白处新建'],
  ];
  openModal({
    title: '快捷键',
    size: 'narrow',
    body: h(
      'table',
      { class: 'locale-table' },
      h('tbody', {}, rows.map(([keys, desc]) => h('tr', {}, h('td', { style: { fontFamily: 'var(--mono)', fontSize: '11.5px', width: '190px' } }, keys), h('td', {}, desc)))),
    ),
    footer: h('button', { class: 'btn', text: '关闭', onclick: closeModal }),
  });
}
