'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pipeline = require('../src/core/pipeline.js');
const audit = require('../src/core/audit.js');
const { parseInput } = require('../src/core/importer.js');
const rules = require('../src/core/rules.js');

const DEMO = path.join(__dirname, '..', 'demo', 'sample-logs.jsonl');
const SECRETS = [
  '13812345678',
  '13911112222',
  'P@ssw0rd-2026',
  'AKIAIOSFODNN7EXAMPLE',
  'zhangwei@example.cn',
  '11010519491231002X',
  '6222020200111117',
  'sk_live_AbCdEf1234567890XyZ',
  'abcdef1234567890ABCDEF',
  'BEGIN RSA PRIVATE KEY',
];

function runDemo(overrides = {}) {
  const text = fs.readFileSync(DEMO, 'utf8');
  return pipeline.runPipeline(text, { createdAt: '2026-11-20T00:00:00.000Z', ...overrides });
}

test('审计报告：含规则版本、时间、分类型命中数与可定位变更摘要', () => {
  const { report } = runDemo();
  assert.equal(report.reportFormat, 'sanlog-audit/1');
  assert.equal(report.ruleVersion, rules.RULE_VERSION);
  assert.equal(report.createdAt, '2026-11-20T00:00:00.000Z');
  assert.ok(report.reportId.length > 0);
  assert.ok(report.detection.totalFindings > 0);
  assert.ok(report.detection.findingsByType.phone >= 3);
  assert.equal(report.processing.redacted, report.detection.totalFindings);
  assert.ok(Array.isArray(report.rules.enabled));
  assert.ok(report.rules.disabled.some((r) => r.id === 'PATTERN_IPV4'));
  const change = report.changes.find((c) => c.line === 5);
  assert.ok(change.items.some((i) => i.path === 'message' && i.mode === 'text' && typeof i.start === 'number'));
});

test('审计报告与变更摘要不含任何原始敏感值', () => {
  const { reportJson } = runDemo();
  for (const secret of SECRETS) assert.ok(!reportJson.includes(secret), `报告泄漏原值: ${secret}`);
});

test('脱敏 jsonl 导出：失败行以可理解包装保留，不静默丢弃', () => {
  const { maskedJsonl, importResult } = runDemo();
  const lines = maskedJsonl.split('\n').filter(Boolean);
  assert.equal(lines.length, importResult.records.length + importResult.failures.length);
  const wrapped = lines.filter((l) => l.includes('__sanlog_unprocessable__'));
  assert.equal(wrapped.length, 1);
  const entry = JSON.parse(wrapped[0]);
  assert.equal(entry.line, 12);
  assert.match(entry.reason, /JSON 解析失败/);
  assert.equal(entry.raw === undefined, true);
  // 导出内容本身不含原始敏感值
  for (const secret of SECRETS) assert.ok(!maskedJsonl.includes(secret), `导出文件泄漏原值: ${secret}`);
});

test('导出再导入：脱敏 jsonl 可重新解析且零新命中（不会二次误判）', () => {
  const { maskedJsonl } = runDemo();
  const preview = pipeline.preview(maskedJsonl);
  assert.equal(preview.findings.length, 0);
  // 失败包装被还原
  assert.equal(preview.importResult.failures.length, 1);
  assert.equal(preview.importResult.records.length, 12);
  // 再跑一次完整流水线，输出与首次脱敏结果一致
  const second = pipeline.runPipeline(maskedJsonl);
  assert.equal(second.maskedJsonl, maskedJsonl);
});

test('更换规则后再处理脱敏副本：已有标记仍不被误判', () => {
  // 首次开启 IPv4，IP 被脱敏为标记；第二次关闭邮箱规则并保持其他设置，标记不得再被判定
  const idsFirst = new Set(rules.DEFAULT_ENABLED_IDS);
  idsFirst.add('PATTERN_IPV4');
  const first = runDemo({ enabledIds: idsFirst });
  assert.ok(first.maskedJsonl.includes('[REDACTED:IP:'));
  const idsSecond = new Set(idsFirst);
  idsSecond.delete('PATTERN_EMAIL');
  const preview = pipeline.preview(first.maskedJsonl, idsSecond);
  assert.equal(preview.findings.length, 0);
  assert.equal(preview.importResult.failures.length, 1);
});

test('部分保留的导出：被保留项留在副本中，审计记录如实标注 keep', () => {
  const base = runDemo();
  const keep = base.findings.find((f) => f.path === 'user.phone');
  const again = runDemo({ decisions: { [keep.decisionKey]: 'keep' } });
  assert.ok(again.maskedJsonl.includes('13812345678')); // 用户明确保留，允许存在
  assert.equal(again.report.processing.kept, 1);
  assert.equal(again.report.processing.redacted, base.findings.length - 1);
  const d = again.report.decisions.find((x) => x.decisionKey === keep.decisionKey);
  assert.equal(d.action, 'keep');
  // 其余敏感值仍不得泄漏
  for (const secret of SECRETS.filter((s) => s !== '13812345678')) {
    assert.ok(!again.maskedJsonl.includes(secret));
  }
});

test('审计记录文件可被读回，损坏/异格式文件报可理解错误', () => {
  const { reportJson } = runDemo();
  const parsed = audit.parseReport(reportJson);
  assert.equal(parsed.reportId, JSON.parse(reportJson).reportId);
  assert.throws(() => audit.parseReport('not json'), /不是合法 JSON/);
  assert.throws(() => audit.parseReport('{"hello":1}'), /不是本工具生成/);
});

test('端到端：演示数据的完整统计与类型保持', () => {
  const { importResult, findings, redactionResult } = runDemo();
  assert.equal(importResult.records.length, 12);
  assert.equal(importResult.failures.length, 1);
  assert.ok(findings.length >= 18);
  // 数字、布尔、null 类型保持
  const line1 = redactionResult.output.find((o) => o.line === 1).value;
  assert.equal(line1.latency_ms, 42);
  assert.equal(line1.user_id, 10086);
  const line6 = redactionResult.output.find((o) => o.line === 6).value;
  assert.equal(line6.env.region, 'cn-north-1');
  assert.equal(line6.env.retry, 3);
  assert.match(JSON.stringify(line6.env), /\[REDACTED:ACCESSKEY/);
});

test('审计报告中失败原因不含失败行原文', () => {
  const { report } = runDemo();
  const failure = report.failures[0];
  assert.equal(failure.line, 12);
  assert.ok(!('raw' in failure));
  assert.ok(!JSON.stringify(failure).includes('broken'));
});

test('parseInput 与流水线对空输入安全', () => {
  const r = pipeline.runPipeline('');
  assert.equal(r.importResult.records.length, 0);
  assert.equal(r.findings.length, 0);
  assert.equal(r.maskedJsonl, '');
  assert.equal(r.report.processing.redacted, 0);
});
