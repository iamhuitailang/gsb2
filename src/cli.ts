import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASELINE_PACKS, LOCALE_ORDER, REFERENCE_LOCALE } from './data/packs/index.ts';
import { CHARACTERS_BY_ID, ITEMS_BY_ID } from './data/game-data.ts';
import { ALL_SAMPLES, EVENT_SAMPLES } from './data/events.ts';
import { runChecks, aggregateIssues, summarizeIssues } from './core/checks.ts';
import { buildChecklistMarkdown, KIND_LABEL } from './core/checklist.ts';
import { renderSample } from './core/render.ts';

const deps = {
  packs: BASELINE_PACKS,
  characters: CHARACTERS_BY_ID,
  items: ITEMS_BY_ID,
};

const rawIssues = runChecks({
  ...deps,
  referenceLocale: REFERENCE_LOCALE,
  samples: ALL_SAMPLES,
});
const grouped = aggregateIssues(rawIssues);
const summary = summarizeIssues(rawIssues);

const markdown = buildChecklistMarkdown({
  ...deps,
  localeOrder: LOCALE_ORDER,
  samples: ALL_SAMPLES,
  issues: grouped,
  rawIssueCount: rawIssues.length,
});

const outPath = resolve(process.cwd(), 'qa-checklist.md');
writeFileSync(outPath, markdown, 'utf8');

console.log('=== 游戏文案上下文检查 · 离线 QA ===');
console.log(`触发样例 ${ALL_SAMPLES.length} 个（其中对话事件 ${EVENT_SAMPLES.length} 条）`);
console.log(
  `原始问题 ${summary.total} 次，聚合为 ${grouped.length} 组；错误 ${summary.errors}，警告 ${summary.warnings}`,
);
console.log('');
for (const kind of Object.keys(KIND_LABEL) as Array<keyof typeof KIND_LABEL>) {
  console.log(`  ${KIND_LABEL[kind].padEnd(8)} ${summary[kind]}`);
}
console.log('');
console.log('--- 问题组预览（前 12 组） ---');
for (const issue of grouped.slice(0, 12)) {
  const times = issue.sampleCount && issue.sampleCount > 1 ? ` ×${issue.sampleCount}样例` : '';
  console.log(
    `[${issue.severity}] ${issue.locale} ${issue.entryId} ${issue.code}${times}\n    ${issue.message}`,
  );
}

console.log('');
console.log('--- 试玩样例：ev_harbor.inspect @ ja-JP（应暴露漏 count） ---');
const demo = EVENT_SAMPLES.find((s) => s.id === 'ev_harbor.inspect')!;
const r = renderSample(deps, demo, 'ja-JP');
console.log('文本:', r.text);
console.log('来源:', r.source.label, '| via =', r.source.via);

console.log('');
console.log(`质检清单已写入: ${outPath}`);
