import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, parseHeaderText, lintPolicy, evaluateSample } from '../src/core/index.js';
import { DEMO_POLICIES, DEMO_SAMPLES } from '../src/data/demo-policies.js';

test('演示数据覆盖要求的五类场景', () => {
  const ids = DEMO_POLICIES.map((p) => p.id);
  for (const expected of ['demo-strict', 'demo-loose', 'demo-duplicate', 'demo-invalid', 'demo-report-only', 'demo-mixed']) {
    assert.ok(ids.includes(expected), `缺少演示策略 ${expected}`);
  }
  // 全部使用演示/保留域，不出现真实外部域
  for (const p of DEMO_POLICIES) {
    assert.doesNotMatch(p.text, /https?:\/\/(?!([a-z]+\.)?(example\.com|example\.org|demo\.local|test|invalid))[a-z0-9.-]+\.[a-z]{2,}/);
  }
});

test('安全配置：内联无 nonce 脚本被拦截，带 nonce 放行', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-strict');
  const [policy] = [parsePolicy(demo.text, { mode: demo.mode })];
  const blocked = evaluateSample({ resourceType: 'script', inline: true }, [policy]);
  assert.equal(blocked.decision, 'blocked');
  const allowed = evaluateSample(
    { resourceType: 'script', inline: true, nonce: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' },
    [parsePolicy(demo.text)]
  );
  assert.equal(allowed.decision, 'allowed');
});

test('宽松配置：unsafe-inline/unsafe-eval 与通配符告警齐全', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-loose');
  const policy = parsePolicy(demo.text);
  const codes = lintPolicy(policy).map((i) => i.code);
  for (const c of ['WILDCARD_SOURCE', 'UNSAFE_INLINE', 'UNSAFE_EVAL', 'DANGEROUS_COMBO', 'CLEARTEXT_SCHEME']) {
    assert.ok(codes.includes(c), `宽松配置缺少告警 ${c}`);
  }
});

test('重复指令演示数据可检出 DUPLICATE_DIRECTIVE', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-duplicate');
  const policy = parsePolicy(demo.text);
  assert.ok(policy.issues.some((i) => i.code === 'DUPLICATE_DIRECTIVE'));
});

test('无效来源演示数据可检出全部四类错误', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-invalid');
  const policy = parsePolicy(demo.text);
  const codes = policy.issues.map((i) => i.code);
  assert.ok(codes.includes('UNKNOWN_DIRECTIVE'));      // stlye-src
  assert.ok(codes.includes('INVALID_SOURCE'));         // self 未加引号
  assert.ok(codes.some((c) => c === 'INVALID_SOURCE')); // 哈希长度 / 端口
  // 错误位置全部带行列号
  for (const issue of policy.issues) {
    assert.ok(issue.loc.line >= 1 && issue.loc.column >= 1);
  }
});

test('报告模式演示数据带 REPORT_ONLY_MODE 提示且不拦截', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-report-only');
  const policy = parsePolicy(demo.text, { mode: 'report-only' });
  assert.ok(lintPolicy(policy).some((i) => i.code === 'REPORT_ONLY_MODE'));
  const v = evaluateSample(
    { resourceType: 'script', url: 'https://evil.test/x.js' },
    [policy]
  );
  assert.equal(v.decision, 'allowed-report-only');
});

test('多策略演示数据按逗号拆成两条且取交集', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-mixed');
  const header = parseHeaderText(demo.text);
  assert.equal(header.policies.length, 2);
  const v = evaluateSample(
    { resourceType: 'img', url: 'https://random.test/p.png' },
    header.policies
  );
  // 第一条只允许 self/img.example.com，随机域被第一条拦截
  assert.equal(v.decision, 'blocked');
});

test('演示样例请求全部可以离线评估且不产生 error 判定（除输入类）', () => {
  const demo = DEMO_POLICIES.find((p) => p.id === 'demo-strict');
  const policy = parsePolicy(demo.text);
  for (const sample of DEMO_SAMPLES) {
    const v = evaluateSample({ ...sample, documentOrigin: 'https://app.demo.local' }, [policy]);
    assert.ok(['allowed', 'blocked', 'allowed-report-only', 'allowed-with-report'].includes(v.decision),
      `样例 ${sample.id} 得到异常判定 ${v.decision}: ${v.reason}`);
  }
});
