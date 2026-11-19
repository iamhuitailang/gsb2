import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntegrity, evaluateAlgorithms, integrityMap } from '../src/core/sri.js';
import { materializeRules } from '../src/core/config.js';

const rules = materializeRules();

test('合法 sha512 token', () => {
  const digest = 'A'.repeat(86) + '=='; // 88 字符，%4===0
  const parsed = parseIntegrity(`sha512-${digest}`);
  assert.equal(parsed.present, true);
  assert.equal(parsed.overallValid, true);
  assert.equal(parsed.tokens[0].alg, 'sha512');
});

test('多算法空格分隔且保留全部 token', () => {
  const parsed = parseIntegrity(`sha256-${'B'.repeat(43)}= sha512-${'C'.repeat(86)}==`);
  assert.equal(parsed.tokens.length, 2);
  assert.equal(parsed.overallValid, true);
});

test('空串与纯空白视为未声明', () => {
  assert.equal(parseIntegrity('').present, false);
  assert.equal(parseIntegrity('   ').present, false);
  assert.equal(parseIntegrity(null).present, false);
});

test('非法 base64 字符', () => {
  const parsed = parseIntegrity('sha512-!!!notbase64');
  assert.equal(parsed.overallValid, false);
  assert.ok(parsed.tokens[0].errors.join(' ').includes('base64'));
});

test('padding 长度不合法', () => {
  const parsed = parseIntegrity('sha512-abc'); // 长度 3，%4!==0
  assert.equal(parsed.overallValid, false);
  assert.ok(parsed.tokens[0].errors.some((e) => e.includes('padding') || e.includes('4 的倍数')));
});

test('padding 后仍有字符', () => {
  const parsed = parseIntegrity('sha512-abc=def');
  assert.equal(parsed.overallValid, false);
});

test('缺少 alg-digest 分隔符', () => {
  const parsed = parseIntegrity('sha512nodash');
  assert.equal(parsed.overallValid, false);
});

test('sha1 语法合法但策略为 weak', () => {
  const digest = 'D'.repeat(27) + '='; // 28 chars
  const parsed = parseIntegrity(`sha1-${digest}`);
  assert.equal(parsed.overallValid, true);
  const evaluated = evaluateAlgorithms(parsed, rules);
  assert.equal(evaluated[0].policy, 'weak');
  assert.equal(evaluated[0].ruleId, 'INTEGRITY_ALG_WEAK');
});

test('未知算法策略为 not-allowed', () => {
  const digest = 'E'.repeat(43) + '=';
  const evaluated = evaluateAlgorithms(parseIntegrity(`md5-${digest}`), rules);
  assert.equal(evaluated[0].policy, 'not-allowed');
  assert.equal(evaluated[0].ruleId, 'INTEGRITY_ALG_NOT_ALLOWED');
});

test('允许算法策略为 allowed 且无 ruleId', () => {
  const digest = 'F'.repeat(43) + '=';
  const evaluated = evaluateAlgorithms(parseIntegrity(`sha256-${digest}`), rules);
  assert.equal(evaluated[0].policy, 'allowed');
  assert.equal(evaluated[0].ruleId, null);
});

test('integrityMap 顺序无关的集合比较', () => {
  const a = integrityMap(`sha256-${'A'.repeat(43)}= sha512-${'B'.repeat(86)}==`);
  const b = integrityMap(`sha512-${'B'.repeat(86)}== sha256-${'A'.repeat(43)}=`);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
});
