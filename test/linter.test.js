import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../src/core/parser.js';
import { lintPolicy, lintPolicies } from '../src/core/linter.js';

const codes = (policy) => lintPolicy(policy).map((i) => i.code);

test('过宽来源：通配符、明文协议、data 协议', () => {
  const p = parsePolicy("default-src *; img-src http: data:");
  const c = codes(p);
  assert.ok(c.includes('WILDCARD_SOURCE'));
  assert.ok(c.includes('CLEARTEXT_SCHEME'));
  assert.ok(c.includes('DANGEROUS_SCHEME'));
});

test('unsafe-inline + unsafe-eval 同时出现产生组合告警', () => {
  const p = parsePolicy("script-src 'unsafe-inline' 'unsafe-eval'");
  const c = codes(p);
  assert.ok(c.includes('UNSAFE_INLINE'));
  assert.ok(c.includes('UNSAFE_EVAL'));
  assert.ok(c.includes('DANGEROUS_COMBO'));
  // 脚本类指令下 unsafe-inline 是 error 级
  const inline = lintPolicy(p).find((i) => i.code === 'UNSAFE_INLINE');
  assert.equal(inline.severity, 'error');
});

test("'none' 与其他值共存报错", () => {
  const p = parsePolicy("img-src 'none' 'self'");
  assert.ok(codes(p).includes('NONE_WITH_OTHER_SOURCES'));
});

test('strict-dynamic 提示主机白名单被忽略', () => {
  const p = parsePolicy("script-src 'nonce-abc' 'strict-dynamic' https://cdn.example.com 'self'");
  const c = codes(p);
  assert.ok(c.includes('STRICT_DYNAMIC_IGNORES_SOURCES'));
  const issue = lintPolicy(p).find((i) => i.code === 'STRICT_DYNAMIC_IGNORES_SOURCES');
  assert.match(issue.message, /cdn\.example\.com/);
});

test('strict-dynamic 用在非脚本指令上报错', () => {
  const p = parsePolicy("img-src 'strict-dynamic' 'self'");
  assert.ok(codes(p).includes('STRICT_DYNAMIC_WRONG_DIRECTIVE'));
});

test('缺失关键指令的覆盖缺口提示', () => {
  const p = parsePolicy("script-src 'self'");
  const c = codes(p);
  assert.ok(c.includes('MISSING_DEFAULT_SRC'));
  assert.ok(c.includes('MISSING_OBJECT_SRC'));
  assert.ok(c.includes('MISSING_FRAME_ANCESTORS'));
  assert.ok(c.includes('MISSING_BASE_URI'));
});

test('与 default-src 完全相同的指令被标记冗余', () => {
  const p = parsePolicy("default-src 'self' https://a.test; img-src https://a.test 'self'");
  assert.ok(codes(p).includes('REDUNDANT_DIRECTIVE'));
});

test('报告模式策略带模式提示', () => {
  const p = parsePolicy("default-src 'self'", { mode: 'report-only' });
  const issue = lintPolicy(p).find((i) => i.code === 'REPORT_ONLY_MODE');
  assert.ok(issue);
  assert.equal(issue.severity, 'info');
});

test('多策略：混合模式与多强制策略提示', () => {
  const enforce = parsePolicy("default-src 'self'", { mode: 'enforce' });
  const report = parsePolicy("default-src 'self'", { mode: 'report-only' });
  const cross = lintPolicies([enforce, report]);
  assert.ok(cross.some((i) => i.code === 'MIXED_MODE_POLICIES'));

  const two = lintPolicies([
    parsePolicy("default-src 'self'"),
    parsePolicy("default-src 'none'"),
  ]);
  assert.ok(two.some((i) => i.code === 'MULTIPLE_ENFORCE_POLICIES'));
});

test('含解析错误的策略在跨策略检查中产生总提示', () => {
  const broken = parsePolicy('stlye-src self');
  const cross = lintPolicies([broken, parsePolicy("default-src 'self'")]);
  assert.ok(cross.some((i) => i.code === 'POLICY_PARSE_ERRORS'));
});

test('同一条规则可同时命中多个问题', () => {
  const p = parsePolicy("script-src * 'unsafe-inline' 'unsafe-eval' http:");
  const issues = lintPolicy(p);
  const distinct = new Set(issues.map((i) => i.code));
  assert.ok(distinct.size >= 4, `应至少命中 4 类问题，实际 ${distinct.size}`);
});
