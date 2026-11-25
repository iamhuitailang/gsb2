import type { UiContext } from '../context.ts';
import { h, downloadText } from '../h.ts';
import type { IssueKind, QaIssue } from '../../core/types.ts';
import { ALL_SAMPLES } from '../../data/events.ts';
import { KIND_LABEL, CODE_LABEL, buildChecklistMarkdown } from '../../core/checklist.ts';
import { whenLabel, whenSignature } from '../../core/template.ts';

const FILTERS: Array<{ id: IssueKind | 'all'; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'var-missing', label: KIND_LABEL['var-missing'] },
  { id: 'var-extra', label: KIND_LABEL['var-extra'] },
  { id: 'type-mismatch', label: KIND_LABEL['type-mismatch'] },
  { id: 'unreached-form', label: KIND_LABEL['unreached-form'] },
  { id: 'fallback-used', label: KIND_LABEL['fallback-used'] },
  { id: 'missing-entry', label: KIND_LABEL['missing-entry'] },
];

function buildMarkdown(ctx: UiContext): string {
  const s = ctx.state;
  return buildChecklistMarkdown({
    packs: s.packs,
    characters: Object.fromEntries(s.characters.map((c) => [c.id, c])),
    items: Object.fromEntries(s.items.map((i) => [i.id, i])),
    localeOrder: Object.keys(s.packs),
    samples: ALL_SAMPLES,
    issues: s.issues,
    rawIssueCount: s.rawIssues.length,
  });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function IssueCard(issue: QaIssue) {
  const samples = issue.relatedSampleIds ?? [];
  return h(
    'article',
    { class: `issue issue-${issue.severity} kind-${issue.kind}` },
    h(
      'header',
      { class: 'issue-head' },
      h('span', { class: `kind-tag tag-${issue.kind}` }, KIND_LABEL[issue.kind]),
      h('span', { class: 'issue-code' }, CODE_LABEL[issue.code] ?? issue.code),
      h('span', { class: `locale-pill locale-${issue.locale}` }, issue.locale === '*' ? '全部语言' : issue.locale),
      h('code', { class: 'entry-id' }, issue.entryId),
      issue.sampleCount && issue.sampleCount > 1
        ? h('span', { class: 'count-pill' }, `${issue.sampleCount} 个样例`)
        : null,
    ),
    h('p', { class: 'issue-msg' }, issue.message),
    issue.when && Object.keys(issue.when).length
      ? h(
          'p',
          { class: 'issue-when' },
          '命中句式：',
          h('code', null, whenSignature(issue.when)),
          `（${whenLabel(issue.when)}）`,
        )
      : null,
    issue.expected ? h('p', { class: 'issue-expected' }, '期望：', h('code', null, issue.expected)) : null,
    issue.actual
      ? h(
          'p',
          { class: 'issue-actual' },
          issue.code === 'placeholder-dropped' ? '所在句式原文：' : '实际：',
          h('q', null, issue.actual.length > 220 ? issue.actual.slice(0, 220) + '…' : issue.actual),
        )
      : null,
    issue.suggestedTrigger
      ? h('p', { class: 'issue-suggest' }, '建议触发样例：', h('code', null, issue.suggestedTrigger))
      : null,
    issue.sampleId
      ? h(
          'p',
          { class: 'issue-sample' },
          '触发：',
          h('code', null, issue.sampleId),
          issue.sampleLabel ? ` · ${issue.sampleLabel}` : '',
        )
      : null,
    samples.length > 1
      ? h(
          'details',
          { class: 'sample-list' },
          h('summary', null, `查看 ${samples.length} 个相关样例 ID`),
          h('div', { class: 'sample-ids' }, samples.map((id) => h('code', { class: 'sample-chip' }, id))),
        )
      : null,
    issue.trigger && Object.keys(issue.trigger).length
      ? h(
          'details',
          { class: 'trigger-json' },
          h('summary', null, '复现上下文 JSON'),
          h('pre', null, JSON.stringify(issue.trigger, null, 2)),
        )
      : null,
  );
}

export function renderQaTab(ctx: UiContext): HTMLElement {
  const s = ctx.state;
  const filtered = s.issueFilter === 'all' ? s.issues : s.issues.filter((i) => i.kind === s.issueFilter);

  const countFor = (id: IssueKind | 'all') =>
    id === 'all' ? s.issues.length : s.issues.filter((i) => i.kind === id).length;

  const markdown = s.checklistOpen ? buildMarkdown(ctx) : '';

  return h(
    'div',
    { class: 'tab-qa' },
    h(
      'section',
      { class: 'card qa-toolbar' },
      h(
        'div',
        { class: 'qa-summary' },
        h('div', { class: 'stat stat-error' }, h('strong', null, String(s.rawIssues.filter((i) => i.severity === 'error').length)), h('span', null, '错误触发次数')),
        h('div', { class: 'stat stat-warn' }, h('strong', null, String(s.rawIssues.filter((i) => i.severity === 'warning').length)), h('span', null, '警告触发次数')),
        h('div', { class: 'stat' }, h('strong', null, String(s.issues.length)), h('span', null, '聚合问题组')),
        h('div', { class: 'stat' }, h('strong', null, String(ALL_SAMPLES.length)), h('span', null, '触发样例')),
      ),
      h(
        'div',
        { class: 'qa-actions' },
        h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: () => {
              const md = buildMarkdown(ctx);
              downloadText(`qa-checklist-${new Date().toISOString().slice(0, 10)}.md`, md);
            },
          },
          '⬇ 导出 Markdown 质检清单',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: async (e: MouseEvent) => {
              const btn = e.currentTarget as HTMLButtonElement;
              const ok = await copyText(buildMarkdown(ctx));
              const old = btn.textContent;
              btn.textContent = ok ? '✓ 已复制' : '复制失败，请用预览全选';
              setTimeout(() => (btn.textContent = old), 1600);
            },
          },
          '复制全文',
        ),
        h(
          'button',
          {
            class: 'btn',
            onclick: () => ctx.update({ checklistOpen: !s.checklistOpen }),
          },
          s.checklistOpen ? '收起清单预览' : '预览清单原文',
        ),
      ),
    ),

    s.checklistOpen ? h('pre', { class: 'checklist-preview' }, markdown) : null,

    h(
      'div',
      { class: 'filter-bar' },
      ...FILTERS.map((f) =>
        h(
          'button',
          {
            class: `chip ${s.issueFilter === f.id ? 'chip-active' : ''}`,
            onclick: () => ctx.update({ issueFilter: f.id }),
          },
          f.label,
          h('span', { class: 'chip-count' }, String(countFor(f.id))),
        ),
      ),
    ),

    h('div', { class: 'issue-list' }, ...filtered.map(IssueCard)),
    filtered.length === 0 ? h('div', { class: 'empty' }, '该类别下没有问题 🎉') : null,
  );
}
