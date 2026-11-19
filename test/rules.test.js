import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile } from '../src/core/parse-lockfile.js';
import { buildGraph } from '../src/core/graph.js';
import { evaluate } from '../src/core/rules.js';
import { materializeRules } from '../src/core/config.js';
import { RULE_IDS, RELATIONSHIPS } from '../src/core/model.js';

const goodDigest = `sha512-${'A'.repeat(86)}==`;

function run(lockfile, rulesOverrides) {
  const rules = materializeRules(rulesOverrides);
  const parsed = parseLockfile(lockfile);
  const graph = buildGraph(parsed);
  const result = evaluate(parsed, graph, rules);
  return { parsed, graph, result, rules };
}

function ruleIds(result) {
  return new Set(result.findings.map((f) => f.ruleId));
}

test('正常 registry + sha512 条目无来源/完整性 finding', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { ok: '1.0.0' } },
      'node_modules/ok': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/ok/-/ok-1.0.0.tgz',
        integrity: goodDigest,
      },
    },
  });
  const ids = ruleIds(result);
  assert.equal(ids.has(RULE_IDS.RESOLVED_HOST_UNTRUSTED), false);
  assert.equal(ids.has(RULE_IDS.INTEGRITY_MISSING), false);
  assert.equal(ids.has(RULE_IDS.INTEGRITY_ALG_WEAK), false);
});

test('非可信主机触发 RESOLVED_HOST_UNTRUSTED', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/evil-fetch': {
        version: '1.0.0',
        resolved: 'https://registry.evil-example.com/evil-fetch/-/evil-fetch-1.0.0.tgz',
        integrity: goodDigest,
      },
    },
  });
  assert.ok(ruleIds(result).has(RULE_IDS.RESOLVED_HOST_UNTRUSTED));
  const f = result.findings.find((x) => x.ruleId === RULE_IDS.RESOLVED_HOST_UNTRUSTED);
  assert.equal(f.actual.host, 'registry.evil-example.com');
  assert.deepEqual(f.expected.trustedHosts, ['registry.npmjs.org']);
});

test('http 协议触发 SCHEME_NOT_ALLOWED', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/plain-http': {
        version: '1.0.0',
        resolved: 'http://registry.npmjs.org/plain-http/-/plain-http-1.0.0.tgz',
        integrity: goodDigest,
      },
    },
  });
  assert.ok(ruleIds(result).has(RULE_IDS.RESOLVED_SCHEME_NOT_ALLOWED));
});

test('git 与 file 与 link 各自触发对应规则', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/vcs': {
        version: '1.0.0',
        resolved: 'git+https://github.com/o/r.git#abc',
      },
      'node_modules/local': { version: '1.0.0', resolved: 'file:../vendor/local.tgz' },
      'node_modules/ws': { link: true, resolved: 'packages/ws' },
    },
  });
  const ids = ruleIds(result);
  assert.ok(ids.has(RULE_IDS.RESOLVED_NON_REGISTRY_GIT));
  assert.ok(ids.has(RULE_IDS.RESOLVED_NON_REGISTRY_FILE));
  assert.ok(ids.has(RULE_IDS.RESOLVED_NON_REGISTRY_LINK));
  // git/file/link 不适用 SRI 策略，不应报完整性缺失
  assert.equal(ids.has(RULE_IDS.INTEGRITY_MISSING), false);
});

test('缺少 resolved 与 integrity 分别报缺失', () => {
  const { result } = run({
    lockfileVersion: 2,
    packages: {
      '': {},
      'node_modules/no-resolved': { version: '1.0.0', integrity: goodDigest },
      'node_modules/no-integrity': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/no-integrity/-/no-integrity-1.0.0.tgz',
      },
    },
  });
  const ids = ruleIds(result);
  assert.ok(ids.has(RULE_IDS.RESOLVED_MISSING));
  assert.ok(ids.has(RULE_IDS.INTEGRITY_MISSING));
});

test('v3 省略 resolved/integrity 进 inconclusive 而非放行', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { omitted: '1.0.0' } },
      'node_modules/omitted': {},
    },
  });
  // resolved 与 integrity 各一项不可判定（该条目可从根到达，不再有不可达项）
  assert.equal(result.inconclusive.length, 2);
  const reasons = result.inconclusive.map((i) => i.missingFields.join()).join(' ');
  assert.match(reasons, /resolved/);
  assert.match(reasons, /integrity/);
  assert.ok(ruleIds(result).has(RULE_IDS.RESOLVED_OMITTED_V3));
  assert.ok(ruleIds(result).has(RULE_IDS.INTEGRITY_OMITTED_V3));
});

test('sha1 触发弱算法，坏 SRI 触发格式非法', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/legacy': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/legacy/-/legacy-1.0.0.tgz',
        integrity: `sha1-${'D'.repeat(27)}=`,
      },
      'node_modules/bad-sri': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/bad-sri/-/bad-sri-1.0.0.tgz',
        integrity: 'sha512-!!!notbase64',
      },
    },
  });
  const ids = ruleIds(result);
  assert.ok(ids.has(RULE_IDS.INTEGRITY_ALG_WEAK));
  assert.ok(ids.has(RULE_IDS.INTEGRITY_SRI_MALFORMED));
});

test('tarball 包名与声明包名不符触发 RESOLVED_NAME_MISMATCH', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/imposter': {
        name: 'imposter',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/genuine/-/genuine-1.0.0.tgz',
        integrity: goodDigest,
      },
    },
  });
  const f = result.findings.find((x) => x.ruleId === RULE_IDS.RESOLVED_NAME_MISMATCH);
  assert.ok(f);
  assert.equal(f.actual.tarballPackageName, 'genuine');
  assert.equal(f.expected.tarballPackageName, 'imposter');
});

test('别名触发 ALIAS_NAME_MISMATCH 且措辞中性', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/my-alias': {
        name: 'real-pkg',
        version: '1.2.3',
        resolved: 'https://registry.npmjs.org/real-pkg/-/real-pkg-1.2.3.tgz',
        integrity: goodDigest,
      },
    },
  });
  const f = result.findings.find((x) => x.ruleId === RULE_IDS.ALIAS_NAME_MISMATCH);
  assert.ok(f);
  assert.doesNotMatch(f.message, /恶意/);
});

test('所有 finding 措辞不含"恶意"，完整性类 verified 恒 false', () => {
  const { result } = run({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/x': {
        version: '1.0.0',
        resolved: 'https://evil.example.com/x/-/x-1.0.0.tgz',
        integrity: 'sha1-abc',
      },
    },
  });
  for (const f of result.findings) {
    assert.doesNotMatch(f.message + f.title, /恶意/);
  }
  for (const f of result.findings.filter((x) => x.ruleId.startsWith('INTEGRITY'))) {
    assert.equal(f.verified, false);
  }
});

test('severityOverrides 可降级规则', () => {
  const { result } = run(
    {
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://evil.example.com/x/-/x-1.0.0.tgz',
          integrity: goodDigest,
        },
      },
    },
    { severityOverrides: { RESOLVED_HOST_UNTRUSTED: 'low' } },
  );
  const f = result.findings.find((x) => x.ruleId === RULE_IDS.RESOLVED_HOST_UNTRUSTED);
  assert.equal(f.severity, 'low');
});

test('forceIntegrity=false 时缺失降级为 medium', () => {
  const { result } = run(
    {
      lockfileVersion: 2,
      packages: {
        '': { dependencies: { x: '1.0.0' } },
        'node_modules/x': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        },
      },
    },
    { forceIntegrity: false },
  );
  const f = result.findings.find((x) => x.ruleId === RULE_IDS.INTEGRITY_MISSING);
  assert.equal(f.severity, 'medium');
});

test('不可达条目进 inconclusive 并报 PACKAGE_UNREACHABLE', () => {
  const { graph, result } = run({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1.0.0' } },
      'node_modules/a': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
        integrity: goodDigest,
      },
      'node_modules/orphan': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/orphan/-/orphan-1.0.0.tgz',
        integrity: goodDigest,
      },
    },
  });
  assert.equal(graph.relationship.get('node_modules/a'), RELATIONSHIPS.DIRECT);
  assert.equal(graph.relationship.get('node_modules/orphan'), RELATIONSHIPS.UNREACHABLE);
  assert.ok(ruleIds(result).has(RULE_IDS.PACKAGE_UNREACHABLE));
});
