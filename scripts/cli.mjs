#!/usr/bin/env node
// 命令行入口（离线）：
//   node scripts/cli.mjs demo                      列出演示策略
//   node scripts/cli.mjs lint "<策略文本>"          检查一段策略文本
//   node scripts/cli.mjs lint --file policy.txt    检查文件中的策略
//   node scripts/cli.mjs evaluate --policy "<文本>" --url https://x --type script
//   node scripts/cli.mjs compare "<策略A>" "<策略B>"

import { parsePolicy, parseHeaderText, lintPolicy, lintPolicies, evaluateSample, comparePolicies } from '../src/core/index.js';
import { DEMO_POLICIES } from '../src/data/demo-policies.js';

const [command, ...args] = process.argv.slice(2);

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    }
  }
  return flags;
}

function printIssues(title, issues) {
  console.log(`\n${title}`);
  if (!issues.length) {
    console.log('  （无问题）');
    return;
  }
  for (const i of issues) {
    const pos = i.loc ? ` [${i.loc.line}:${i.loc.column}]` : '';
    console.log(`  ${i.severity.toUpperCase().padEnd(7)} ${i.code}${pos}  ${i.message}`);
    if (i.hint) console.log(`           ↳ ${i.hint}`);
  }
}

function buildPolicies(text, mode = 'enforce') {
  if (text.includes(',')) return parseHeaderText(text, { mode }).policies;
  return [parsePolicy(text, { mode })];
}

if (command === 'demo') {
  console.log('演示策略（全部使用演示域，仅供离线判断）：');
  for (const p of DEMO_POLICIES) {
    console.log(`\n- ${p.id}  ${p.name} [${p.mode === 'report-only' ? '报告模式' : '强制模式'}]`);
    console.log(`  ${p.description}`);
    console.log(`  ${p.text}`);
  }
} else if (command === 'lint') {
  const flags = parseFlags(args);
  const text = flags.file ? (await import('node:fs')).readFileSync(flags.file, 'utf8') : args.find((a) => !a.startsWith('--')) || '';
  const policies = buildPolicies(text, flags.mode === 'report-only' ? 'report-only' : 'enforce');
  const all = [...policies.flatMap((p) => [...p.issues, ...lintPolicy(p)]), ...lintPolicies(policies)];
  policies.forEach((p, i) => {
    console.log(`\n策略 ${i + 1} 规范化结果：${p.canonical || '（空）'}`);
  });
  printIssues(`检查结果（共 ${all.length} 项）`, all);
  process.exit(all.some((i) => i.severity === 'error') ? 1 : 0);
} else if (command === 'evaluate') {
  const flags = parseFlags(args);
  if (!flags.policy) {
    console.error('缺少 --policy 参数');
    process.exit(2);
  }
  const policies = buildPolicies(flags.policy);
  const sample = {
    resourceType: flags.type || 'script',
    url: flags.url,
    inline: !!flags.inline,
    redirected: !!flags.redirected,
    nonce: flags.nonce,
  };
  const verdict = evaluateSample(sample, policies);
  console.log(`判定: ${verdict.decision}`);
  console.log(`原因: ${verdict.reason}`);
  for (const r of verdict.perPolicy) {
    console.log(`\n[${r.policyName}] ${r.decision}（指令: ${r.directive || '无'}，命中: ${r.matchedSource || '无'}）`);
    r.trace.forEach((t) => console.log(`  - ${t}`));
  }
} else if (command === 'compare') {
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length < 2) {
    console.error('用法: compare "<策略A文本>" "<策略B文本>"');
    process.exit(2);
  }
  const a = parsePolicy(positional[0], { name: 'A' });
  const b = parsePolicy(positional[1], { name: 'B' });
  const result = comparePolicies(a, b);
  console.log(`新增 ${result.summary.added} / 删除 ${result.summary.removed} / 修改 ${result.summary.modified}；放宽 ${result.summary.loosened} 处，收紧 ${result.summary.tightened} 处`);
  for (const d of result.directiveDiffs) {
    if (d.status === 'unchanged') continue;
    console.log(`\n${d.name}  [${d.statusLabel}]`);
    d.changes.forEach((c) => console.log(`  ${c.effectLabel} (${c.directionLabel}) ${c.token} — ${c.reason}`));
    if (d.status !== 'modified') {
      console.log(`  A: ${d.sourcesA.join(' ') || '（无）'}`);
      console.log(`  B: ${d.sourcesB.join(' ') || '（无）'}`);
    }
  }
} else {
  console.log('用法: node scripts/cli.mjs <demo|lint|evaluate|compare> ...');
  process.exit(2);
}
