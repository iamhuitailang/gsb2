/* 用 Node 直接运行的逻辑测试：node tests/run-tests.js */
'use strict';

const assert = require('assert');
const Checks = require('../js/checks.js');
const Examples = require('../js/examples.js');

let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

const expectedVerdicts = {
  'normal-rotation': 'pass',
  'early-removal': 'attention',
  'kid-reuse': 'reject',
  'duplicate-kid': 'reject',
  'issuer-mismatch': 'reject',
  'incomplete-keys': 'unknown',
};

test('内置示例覆盖全部六种场景', () => {
  const ids = Examples.scenarios.map((s) => s.id).sort();
  assert.deepStrictEqual(ids, Object.keys(expectedVerdicts).sort());
});

for (const scenario of Examples.scenarios) {
  test(`示例 ${scenario.id} 的结论为 ${expectedVerdicts[scenario.id]}`, () => {
    const report = Checks.evaluateEnvironment(scenario.env);
    assert.strictEqual(report.verdict, expectedVerdicts[scenario.id]);
  });
}

test('同一组输入重复检查结论完全一致（确定性）', () => {
  const envs = Examples.scenarios.map((s) => s.env);
  const first = JSON.stringify(Checks.buildReport(envs));
  const second = JSON.stringify(Checks.buildReport(envs));
  assert.strictEqual(first, second);
});

test('签发者必须完全一致，差一个字符也是拒绝', () => {
  const discovery = {
    issuer: 'https://idp.example.com/',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/jwks.json',
  };
  const findings = Checks.checkDiscovery(discovery, 'https://idp.example.com');
  assert.ok(findings.some((f) => f.code === 'ISSUER_MISMATCH' && f.severity === 'reject'));
});

test('重复 kid 被拒绝且指出位置', () => {
  const jwks = {
    keys: [
      { kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', n: 'a', e: 'AQAB' },
      { kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', n: 'b', e: 'AQAB' },
    ],
  };
  const findings = Checks.checkJwks(jwks, 't1');
  const dup = findings.find((f) => f.code === 'KEY_KID_DUPLICATED');
  assert.ok(dup && dup.severity === 'reject');
  assert.strictEqual(dup.evidence.firstIndex, 0);
  assert.strictEqual(dup.evidence.againIndex, 1);
});

test('不支持的密钥类型标为无法确认而非可信', () => {
  const jwks = { keys: [{ kty: 'OKP', kid: 'k1', use: 'sig', alg: 'EdDSA', crv: 'Ed25519', x: 'abc' }] };
  const findings = Checks.checkJwks(jwks, 't1');
  assert.ok(findings.some((f) => f.code === 'KEY_KTY_UNSUPPORTED' && f.severity === 'unknown'));
  assert.ok(!findings.some((f) => f.code === 'KEY_OK'));
});

test('同标识换内容被识别为替换（拒绝），新增/保留/移除分类正确', () => {
  const prev = {
    keys: [
      { kty: 'RSA', kid: 'keep', use: 'sig', alg: 'RS256', n: 'same', e: 'AQAB' },
      { kty: 'RSA', kid: 'swap', use: 'sig', alg: 'RS256', n: 'old', e: 'AQAB' },
      { kty: 'RSA', kid: 'gone', use: 'sig', alg: 'RS256', n: 'gone', e: 'AQAB' },
    ],
  };
  const next = {
    keys: [
      { kty: 'RSA', kid: 'keep', use: 'sig', alg: 'RS256', n: 'same', e: 'AQAB' },
      { kty: 'RSA', kid: 'swap', use: 'sig', alg: 'RS256', n: 'new', e: 'AQAB' },
      { kty: 'RSA', kid: 'fresh', use: 'sig', alg: 'RS256', n: 'fresh', e: 'AQAB' },
    ],
  };
  const cmp = Checks.compareSnapshots(prev, 't1', next, 't2');
  assert.deepStrictEqual(cmp.retained, ['keep']);
  assert.deepStrictEqual(cmp.replaced, ['swap']);
  assert.deepStrictEqual(cmp.removed, ['gone']);
  assert.deepStrictEqual(cmp.added, ['fresh']);
  assert.strictEqual(cmp.verdict, 'reject');
});

test('两份快照毫无共同密钥时报验签断档', () => {
  const prev = { keys: [{ kty: 'RSA', kid: 'a', use: 'sig', alg: 'RS256', n: 'x', e: 'AQAB' }] };
  const next = { keys: [{ kty: 'RSA', kid: 'b', use: 'sig', alg: 'RS256', n: 'y', e: 'AQAB' }] };
  const cmp = Checks.compareSnapshots(prev, 't1', next, 't2');
  assert.ok(cmp.findings.some((f) => f.code === 'KEY_SET_NO_OVERLAP' && f.severity === 'reject'));
});

test('端点源与签发者不一致时需要关注，且不自动改写', () => {
  const discovery = {
    issuer: 'https://idp.example.com',
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://other.example.net/jwks.json',
  };
  const findings = Checks.checkDiscovery(discovery, 'https://idp.example.com');
  const m = findings.find((f) => f.code === 'ENDPOINT_ORIGIN_MISMATCH');
  assert.ok(m && m.severity === 'attention');
  assert.strictEqual(discovery.jwks_uri, 'https://other.example.net/jwks.json'); // 未被改写
});

test('use 与 key_ops 矛盾被拒绝', () => {
  const jwks = {
    keys: [{ kty: 'RSA', kid: 'k1', use: 'sig', alg: 'RS256', key_ops: ['encrypt'], n: 'a', e: 'AQAB' }],
  };
  const findings = Checks.checkJwks(jwks, 't1');
  assert.ok(findings.some((f) => f.code === 'KEY_USE_OPS_CONTRADICTION' && f.severity === 'reject'));
});

console.log(`\n${passed} 个测试通过${process.exitCode ? '（存在失败）' : ''}`);
