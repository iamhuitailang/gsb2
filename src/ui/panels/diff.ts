import type { UiContext } from '../context.ts';
import { h } from '../h.ts';
import type { DiffRow, LanguagePack } from '../../core/types.ts';
import { ALL_SAMPLES } from '../../data/events.ts';
import { LOCALE_ORDER } from '../../data/packs/index.ts';
import { revisedJaJson } from '../../data/packs/revision.ts';
import { snapshotSamples, diffSnapshots } from '../../core/diff.ts';
import { recomputeIssues } from '../state.ts';

function DiffRowView(row: DiffRow) {
  const statusLabel: Record<DiffRow['status'], string> = {
    'text-changed': '文字变了',
    'source-only': '仅来源变了',
    'status-changed': '成败状态变了',
    unchanged: '未变化',
  };
  return h(
    'article',
    { class: `diff-row diff-${row.status}` },
    h(
      'header',
      { class: 'diff-head' },
      h('span', { class: `diff-status status-${row.status}` }, statusLabel[row.status]),
      h('code', { class: 'entry-id' }, row.entryId),
      h('span', { class: 'sample-id' }, row.sampleId),
      h('span', { class: 'sample-label' }, row.sampleLabel),
    ),
    h(
      'div',
      { class: 'diff-grid' },
      h(
        'div',
        { class: 'diff-col diff-before' },
        h('h5', null, '更新前'),
        h('p', { class: 'diff-text' }, row.before.text),
        h('p', { class: 'diff-source' }, '来源：', row.before.sourceLabel),
      ),
      h(
        'div',
        { class: 'diff-arrow' },
        '→',
      ),
      h(
        'div',
        { class: 'diff-col diff-after' },
        h('h5', null, '更新后'),
        h('p', { class: 'diff-text' }, row.after.text),
        h('p', { class: 'diff-source' }, '来源：', row.after.sourceLabel),
      ),
    ),
  );
}

export function renderDiffTab(ctx: UiContext): HTMLElement {
  const s = ctx.state;

  const applyJson = () => {
    const ta = document.getElementById('pack-json-editor') as HTMLTextAreaElement | null;
    if (!ta) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ta.value);
    } catch (e) {
      ctx.update({ jsonError: `JSON 解析失败：${(e as Error).message}` });
      return;
    }
    const candidate = parsed as LanguagePack;
    if (!candidate || typeof candidate !== 'object' || !candidate.entries || typeof candidate.entries !== 'object') {
      ctx.update({ jsonError: '语言包必须包含 entries 对象' });
      return;
    }
    candidate.locale = s.diffLocale;
    if (!candidate.terms?.address) {
      ctx.update({ jsonError: '语言包缺少 terms.address 称呼表' });
      return;
    }

    const characters = Object.fromEntries(s.characters.map((c) => [c.id, c]));
    const items = Object.fromEntries(s.items.map((i) => [i.id, i]));

    const nextPacks: Record<string, LanguagePack> = {
      ...s.packs,
      [s.diffLocale]: candidate,
    };
    const before = snapshotSamples(
      { packs: s.baselinePacks, characters, items },
      ALL_SAMPLES,
      s.diffLocale,
    );
    const after = snapshotSamples({ packs: nextPacks, characters, items }, ALL_SAMPLES, s.diffLocale);
    const report = diffSnapshots(before, after, s.diffLocale);
    const { rawIssues, issues } = recomputeIssues(nextPacks);

    ctx.update({
      packs: nextPacks,
      diff: report,
      rawIssues,
      issues,
      jsonError: null,
      packJson: ta.value,
    });
  };

  const loadBaselineJson = (locale: string) => {
    ctx.update({
      diffLocale: locale,
      packJson: JSON.stringify(s.baselinePacks[locale], null, 2),
      jsonError: null,
      diff: null,
    });
  };

  const fillRevision = () => {
    ctx.update({ diffLocale: 'ja-JP', packJson: revisedJaJson(), jsonError: null });
  };

  const resetPack = () => {
    const packs = JSON.parse(JSON.stringify(s.baselinePacks)) as typeof s.packs;
    const { rawIssues, issues } = recomputeIssues(packs);
    ctx.update({
      packs,
      rawIssues,
      issues,
      diff: null,
      jsonError: null,
      packJson: JSON.stringify(s.baselinePacks[s.diffLocale], null, 2),
    });
  };

  const report = s.diff;
  const filter = s.diffFilter;
  const visibleRows = report
    ? report.rows.filter((r) => (filter === 'all' ? true : r.status === filter))
    : [];

  const filterChips: Array<{ id: typeof filter; label: string; count?: number }> = report
    ? [
        { id: 'all', label: '全部', count: report.total },
        { id: 'text-changed', label: '文字变了', count: report.textChanged.length },
        { id: 'source-only', label: '仅来源变了', count: report.sourceOnly.length },
        { id: 'status-changed', label: '成败变化', count: report.statusChanged.length },
        { id: 'unchanged', label: '未变化', count: report.unchangedCount },
      ]
    : [];

  return h(
    'div',
    { class: 'tab-diff' },
    h(
      'section',
      { class: 'card editor-card' },
      h(
        'header',
        { class: 'card-head' },
        h('h3', null, '更新一份语言包'),
        h('p', { class: 'card-blurb' }, '直接编辑 JSON，或一键填入预置的 ja-JP 修订包，然后对比同一组事件/矩阵样例的渲染结果。所有计算都在本地浏览器完成。'),
      ),
      h(
        'div',
        { class: 'editor-controls' },
        h(
          'label',
          null,
          '语言：',
          h(
            'select',
            {
              onchange: (e: Event) => loadBaselineJson((e.target as HTMLSelectElement).value),
            },
            ...LOCALE_ORDER.map((l) => h('option', { value: l, selected: l === s.diffLocale }, l)),
          ),
        ),
        h('button', { class: 'btn', onclick: fillRevision }, '填入 ja-JP 示例修订 v2'),
        h('button', { class: 'btn btn-primary', onclick: applyJson }, '应用更新并对比'),
        h('button', { class: 'btn btn-ghost', onclick: resetPack }, '重置全部语言包'),
        h('span', { class: 'editor-hint' }, '应用后「质检清单」也会按新语言包重新统计'),
      ),
      s.jsonError ? h('div', { class: 'json-error' }, s.jsonError) : null,
      h('textarea', {
        id: 'pack-json-editor',
        class: 'json-editor',
        spellcheck: false,
        value: s.packJson,
        rows: 18,
      }),
    ),

    report
      ? h(
          'section',
          { class: 'diff-report' },
          h(
            'div',
            { class: 'diff-summary card' },
            h('div', { class: 'stat stat-text' }, h('strong', null, String(report.textChanged.length)), h('span', null, '文字变化')),
            h('div', { class: 'stat stat-source' }, h('strong', null, String(report.sourceOnly.length)), h('span', null, '仅来源变化')),
            h('div', { class: 'stat' }, h('strong', null, String(report.statusChanged.length)), h('span', null, '成败状态变化')),
            h('div', { class: 'stat' }, h('strong', null, String(report.unchangedCount)), h('span', null, '未变化')),
          ),
          h(
            'div',
            { class: 'filter-bar' },
            ...filterChips.map((c) =>
              h(
                'button',
                {
                  class: `chip ${filter === c.id ? 'chip-active' : ''}`,
                  onclick: () => ctx.update({ diffFilter: c.id }),
                },
                c.label,
                h('span', { class: 'chip-count' }, String(c.count ?? 0)),
              ),
            ),
          ),
          h('div', { class: 'diff-list' }, ...visibleRows.map(DiffRowView)),
        )
      : h(
          'div',
          { class: 'card empty diff-empty' },
          '编辑语言包后点击「应用更新并对比」，这里会逐样例列出：哪些渲染文字变了，哪些文字相同但真实来源变了（例如补上本地句式后不再回退）。',
        ),
  );
}
