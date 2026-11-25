import type { QaIssue, TriggerSample } from './types.ts';
import type { RenderDeps } from './render.ts';
import { renderSample } from './render.ts';
import { whenLabel, whenSignature } from './template.ts';

export const KIND_LABEL: Record<QaIssue['kind'], string> = {
  'var-missing': '变量缺失',
  'var-extra': '变量多出',
  'type-mismatch': '类型不合',
  'unreached-form': '未走到的句式',
  'fallback-used': '回退使用',
  'missing-entry': '条目缺失',
};

export const CODE_LABEL: Record<string, string> = {
  'placeholder-dropped': '译文漏用了基准变量',
  'required-value-missing': '事件漏传必需变量',
  'value-missing-at-render': '渲染时变量无值',
  'placeholder-undeclared': '模板出现契约外变量（疑似拼写错误）',
  'value-unused': '样例传入的变量未被句式使用',
  'param-type-mismatch': '样例值类型与变量契约不符',
  'value-type-mismatch-at-render': '渲染时值类型不符',
  'form-never-selected': '句式从未被触发',
  'locale-fallback': '跨语言回退',
  'entry-unresolved': '回退链上无文案',
};

export interface ChecklistArgs extends RenderDeps {
  localeOrder: string[];
  samples: TriggerSample[];
  /** 聚合后的问题（aggregateIssues 的结果） */
  issues: QaIssue[];
  /** 聚合前的原始触发次数 */
  rawIssueCount: number;
  generatedAt?: string;
  title?: string;
}

function codeLabel(code: string): string {
  return CODE_LABEL[code] ?? code;
}

function formatIssue(issue: QaIssue): string {
  const lines: string[] = [];
  const where =
    issue.locale === '*'
      ? '全部语言（样例数据）'
      : `语言 \`${issue.locale}\``;
  lines.push(`- [ ] **[${KIND_LABEL[issue.kind]}] ${codeLabel(issue.code)}**`);
  lines.push(`  - 位置：${where}，条目 \`${issue.entryId}\``);
  if (issue.when && Object.keys(issue.when).length) {
    lines.push(`  - 句式：\`${whenSignature(issue.when)}\`（${whenLabel(issue.when)}）`);
  }
  lines.push(`  - 问题：${issue.message}`);
  if (issue.expected) lines.push(`  - 期望：${issue.expected}`);
  if (issue.actual && issue.code !== 'placeholder-dropped') {
    const actual = issue.actual.length > 160 ? issue.actual.slice(0, 160) + '…' : issue.actual;
    lines.push(`  - 实际/原文：${actual}`);
  }
  if (issue.suggestedTrigger) {
    lines.push(`  - 建议补的触发样例：\`${issue.suggestedTrigger}\``);
  }
  if (issue.sampleCount && issue.sampleCount > 1) {
    const ids = issue.relatedSampleIds ?? [];
    const shown = ids.slice(0, 8).map((id) => `\`${id}\``).join('、');
    lines.push(
      `  - 触发样例：共 **${issue.sampleCount}** 个，首个 \`${issue.sampleId}\`（${issue.sampleLabel ?? ''}）`,
    );
    if (shown) lines.push(`    - 样例 ID：${shown}${ids.length > 8 ? ` 等 ${ids.length} 个` : ''}`);
  } else if (issue.sampleId) {
    lines.push(`  - 触发样例：\`${issue.sampleId}\`（${issue.sampleLabel ?? ''}）`);
  }
  if (issue.trigger && Object.keys(issue.trigger).length) {
    lines.push('  - 复现上下文：');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(issue.trigger, null, 2));
    lines.push('```');
  }
  return lines.join('\n');
}

/** 生成可直接发给翻译/策划的 Markdown 质检清单 */
export function buildChecklistMarkdown(args: ChecklistArgs): string {
  const { issues, localeOrder, samples, rawIssueCount } = args;
  const generatedAt = args.generatedAt ?? new Date().toISOString();
  const title = args.title ?? '《星港杂货铺》文案上下文质检清单';

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');

  const kindCounts = new Map<QaIssue['kind'], number>();
  for (const i of issues) kindCounts.set(i.kind, (kindCounts.get(i.kind) ?? 0) + 1);

  const out: string[] = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`- 生成时间：${generatedAt}`);
  out.push('- 运行方式：本地离线运行（`npm run qa`），不依赖任何网络服务');
  out.push(`- 扫描语言：${localeOrder.map((l) => `\`${l}\``).join(' / ')}`);
  out.push(`- 触发样例：${samples.length} 个（对话事件 + 数量/物品矩阵）`);
  out.push(`- 聚合后问题：**${issues.length}** 组；按样例计的原始触发：${rawIssueCount} 次`);
  out.push(`- 错误 ${errors.length} 组，警告 ${warnings.length} 组`);
  out.push('');
  out.push('## 总览（按类别分开统计）');
  out.push('');
  out.push('| 类别 | 问题组数 |');
  out.push('| --- | ---: |');
  (Object.keys(KIND_LABEL) as QaIssue['kind'][]).forEach((kind) => {
    out.push(`| ${KIND_LABEL[kind]} | ${kindCounts.get(kind) ?? 0} |`);
  });
  out.push('');
  out.push('> 来源标记约定：`exact` 精确专用句式；`generic-form` / `count-fallback` 为本语言约定回退；');
  out.push('> `locale-fallback` 为跨语言回退（**不算已翻译**）；`missing` 为资源缺失。');
  out.push('');

  out.push('## 一、必须修复的错误');
  out.push('');
  if (!errors.length) out.push('- 无 🎉');
  else out.push(errors.map(formatIssue).join('\n\n'));
  out.push('');

  out.push('## 二、警告与回退');
  out.push('');
  if (!warnings.length) out.push('- 无');
  else out.push(warnings.map(formatIssue).join('\n\n'));
  out.push('');

  // 附录：对话事件样例的三语真实渲染结果与来源
  const eventSamples = samples.filter((s) => s.eventId !== 'ev_matrix');
  out.push('## 三、对话事件三语试玩结果（含真实来源）');
  out.push('');
  for (const sample of eventSamples) {
    out.push(`### ${sample.eventId} / \`${sample.id}\` ${sample.label}`);
    out.push('');
    for (const locale of localeOrder) {
      const r = renderSample(args, sample, locale);
      const badge =
        r.source.via === 'exact'
          ? `✅ 精确 · ${r.source.label}`
          : r.source.via === 'locale-fallback'
            ? `⚠️ 跨语言回退（不算已翻译）· ${r.source.label}`
            : r.source.via === 'missing'
              ? `❌ 缺失 · ${r.source.label}`
              : `↳ 本语言约定回退 · ${r.source.label}`;
      out.push(`- **${locale}**：${r.text}`);
      out.push(`  - 来源：${badge}`);
      if (r.source.hops.length) out.push(`  - 回退轨迹：${r.source.hops.join(' → ')}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('## 四、使用说明');
  out.push('');
  out.push('1. 页面顶部可切换角色、物品与数量（0 / 1 / 2 / 5），所有对话与矩阵批量重渲染。');
  out.push('2. 一句台词报错不会影响同事件其他台词。');
  out.push('3. 在「更新对比」页编辑或一键填入 ja-JP 修订包，可查看文字变化与“仅来源变了”。');
  out.push('4. 本清单由默认虚构样例生成，接入真实语言包时替换 `src/data/packs` 与 `src/data/events.ts` 即可。');
  out.push('');

  return out.join('\n');
}
