import { test } from 'node:test';
import assert from 'node:assert/strict';
import { materializeRules, DEFAULT_RULES, severityRank, resolveSeverity } from '../src/core/config.js';
import { AppError } from '../src/core/errors.js';

test('无输入时返回完整默认规则', () => {
  const rules = materializeRules();
  assert.deepEqual(rules.trustedHosts, DEFAULT_RULES.trustedHosts);
  assert.equal(rules.forceIntegrity, true);
  assert.ok(rules.maxFileSizeBytes > 0);
});

test('部分输入补全缺省字段且不改默认对象', () => {
  const rules = materializeRules({ trustedHosts: ['mirror.example.com'] });
  assert.deepEqual(rules.trustedHosts, ['mirror.example.com']);
  assert.deepEqual(rules.allowedAlgorithms, DEFAULT_RULES.allowedAlgorithms);
  assert.notEqual(rules, DEFAULT_RULES);
});

test('非对象输入报 INVALID_RULES', () => {
  assert.throws(() => materializeRules('nope'), (e) => e.code === 'INVALID_RULES');
  assert.throws(() => materializeRules([]), (e) => e.code === 'INVALID_RULES');
});

test('字符串数组字段类型校验', () => {
  assert.throws(
    () => materializeRules({ trustedHosts: 'registry.npmjs.org' }),
    (e) => e.code === 'INVALID_RULES' && e.validationErrors.length > 0,
  );
});

test('布尔/正整数/枚举字段校验', () => {
  assert.throws(() => materializeRules({ forceIntegrity: 'yes' }), /forceIntegrity/);
  assert.throws(() => materializeRules({ maxFileSizeBytes: -1 }), /maxFileSizeBytes/);
  assert.throws(() => materializeRules({ reviewGitSources: 'super' }), /reviewGitSources/);
});

test('severityOverrides 校验与应用', () => {
  assert.throws(
    () => materializeRules({ severityOverrides: { X: 'bogus' } }),
    /severityOverrides/,
  );
  const rules = materializeRules({ severityOverrides: { RESOLVED_MISSING: 'low' } });
  assert.equal(resolveSeverity(rules, 'RESOLVED_MISSING', 'medium'), 'low');
  assert.equal(resolveSeverity(rules, 'OTHER_RULE', 'high'), 'high');
});

test('severityRank 级别顺序', () => {
  assert.ok(severityRank('critical') > severityRank('high'));
  assert.ok(severityRank('high') > severityRank('info'));
  assert.equal(severityRank('unknown'), 0);
});

test('物化结果不与入参共享数组引用', () => {
  const input = { trustedHosts: ['a.example'] };
  const rules = materializeRules(input);
  rules.trustedHosts.push('b.example');
  assert.deepEqual(input.trustedHosts, ['a.example']);
});

test('AppError 可携带结构化细节', () => {
  const err = new AppError('X', 'msg', { line: 3 });
  assert.equal(err.line, 3);
  assert.equal(err.message, 'msg');
});
