import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/core/analyze.js';
import { materializeRules } from '../src/core/config.js';

const digest = `sha512-${'A'.repeat(86)}==`;

const lockfile = {
  lockfileVersion: 3,
  packages: {
    '': { name: 'root', version: '1.0.0', dependencies: { good: '1.0.0', bad: '1.0.0' } },
    'node_modules/good': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/good/-/good-1.0.0.tgz',
      integrity: digest,
    },
    'node_modules/bad': {
      version: '2.0.0',
      resolved: 'https://registry.evil-example.com/bad/-/bad-2.0.0.tgz',
      integrity: `sha1-${'D'.repeat(27)}=`,
    },
    'node_modules/__proto__': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/proto/-/proto-1.0.0.tgz',
      integrity: digest,
    },
  },
};

const baseline = {
  lockfileVersion: 3,
  packages: {
    '': {},
    'node_modules/good': {
      version: '0.9.0',
      resolved: 'https://registry.npmjs.org/good/-/good-0.9.0.tgz',
      integrity: `sha512-${'Z'.repeat(86)}==`,
    },
  },
};

test('analyze 产出完整报告字段与边界声明', async () => {
  const report = await analyze({
    lockfile: { fileName: 'package-lock.json', content: JSON.stringify(lockfile) },
  });
  assert.equal(report.schemaVersion, '1.0');
  assert.match(report.generatedAtUtc, /Z$/);
  assert.match(report.generatedAtLocal, /[+-]\d{2}:\d{2}$/);
  assert.ok(report.timeZone);
  assert.ok(report.boundaries.offline.includes('离线'));
  assert.ok(report.boundaries.integrity.includes('verified 均为 false'));
  assert.equal(report.lockfile.lockfileVersion, 3);
  assert.equal(report.lockfile.packageCount, 3); // 根条目不计数
  assert.equal(report.lockfile.directCount, 2);
  assert.ok(report.summary.totalFindings > 0);
  assert.ok(report.summary.bySeverity.high >= 1);
});

test('所有记录与完整性 finding 的 verified 恒为 false', async () => {
  const report = await analyze({
    lockfile: { fileName: 'x.json', content: JSON.stringify(lockfile) },
  });
  for (const rec of report.records) assert.equal(rec.integrityVerified, false);
  for (const f of report.findings.filter((x) => x.ruleId.startsWith('INTEGRITY'))) {
    assert.equal(f.verified, false);
  }
});

test('依赖路径可从根到达直接依赖', async () => {
  const report = await analyze({
    lockfile: { fileName: 'x.json', content: JSON.stringify(lockfile) },
  });
  const bad = report.records.find((r) => r.name === 'bad');
  const pathInfo = report.dependencyPaths[bad.recordId];
  assert.equal(pathInfo.reachable, true);
  assert.deepEqual(pathInfo.shortest, ['', 'node_modules/bad']);
});

test('__proto__ 键不污染 Object 原型', async () => {
  await analyze({
    lockfile: { fileName: 'x.json', content: JSON.stringify(lockfile) },
  });
  assert.equal(Object.prototype.version, undefined);
  assert.equal({}.version, undefined);
});

test('基线对比写入 diff 与计数', async () => {
  const report = await analyze({
    lockfile: { fileName: 'current.json', content: JSON.stringify(lockfile) },
    rules: { content: JSON.stringify(materializeRules()) },
    baseline: { fileName: 'baseline.json', content: JSON.stringify(baseline) },
  });
  assert.ok(report.diff);
  assert.equal(report.diff.baseline.fileName, 'baseline.json');
  assert.match(report.diff.baseline.sha256, /^[0-9a-f]{64}$/);
  // 当前清单含 bad 与 __proto__，基线只有 good → 至少两个新增
  assert.ok(report.diff.summary.added >= 2);
  // good 在两边都存在但版本/来源/摘要变化 → changed 至少 1
  assert.ok(report.diff.summary.changed >= 1);
  // 汇总计数按唯一位置，added+removed+changed+unchanged = 并集
  const s = report.diff.summary;
  assert.equal(s.added + s.removed + s.changed + s.unchanged, s.unionLocations);
});

test('非法规则配置抛 INVALID_RULES', async () => {
  await assert.rejects(
    analyze({
      lockfile: { fileName: 'x.json', content: JSON.stringify(lockfile) },
      rules: { content: JSON.stringify({ trustedHosts: 'not-an-array' }) },
    }),
    (err) => err.code === 'INVALID_RULES',
  );
});

test('坏 JSON 输入抛带行列的 JSON_PARSE_ERROR', async () => {
  await assert.rejects(
    analyze({ lockfile: { fileName: 'bad.json', content: '{ broken' } }),
    (err) => err.code === 'JSON_PARSE_ERROR' && err.line >= 1 && err.column >= 1,
  );
});
