import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile } from '../src/core/parse-lockfile.js';
import { diffLockfiles, diffFindings } from '../src/core/diff.js';
import { materializeRules } from '../src/core/config.js';
import { RULE_IDS } from '../src/core/model.js';

const digest = (ch) => `sha512-${ch.repeat(86)}==`;
const pkg = (name, version, host, integCh) => ({
  version,
  resolved: `https://${host}/${name}/-/${name}-${version}.tgz`,
  integrity: digest(integCh),
});

function lockfile(version, packages) {
  return parseLockfile({ lockfileVersion: version, packages: { '': {}, ...packages } });
}

test('added/removed/unchanged 识别与计数', () => {
  const baseline = lockfile(3, {
    'node_modules/keep': pkg('keep', '1.0.0', 'registry.npmjs.org', 'A'),
    'node_modules/gone': pkg('gone', '1.0.0', 'registry.npmjs.org', 'B'),
  });
  const current = lockfile(3, {
    'node_modules/keep': pkg('keep', '1.0.0', 'registry.npmjs.org', 'A'),
    'node_modules/new': pkg('new', '1.0.0', 'registry.npmjs.org', 'C'),
  });
  const diff = diffLockfiles(current, baseline);
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.unchanged, 1);
  assert.equal(diff.summary.changed, 0);
  assert.equal(
    diff.summary.added + diff.summary.removed + diff.summary.changed + diff.summary.unchanged,
    diff.summary.unionLocations,
  );
});

test('主机变化与同主机 URL 变化区分', () => {
  const baseline = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  const currentHost = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.evil-example.com', 'A'),
  });
  const hostDiff = diffLockfiles(currentHost, baseline);
  assert.deepEqual(hostDiff.entries[0].changeTypes, ['resolved-host']);

  const currentUrl = lockfile(3, {
    'node_modules/x': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/x/-/x-1.0.0-rebuild.tgz',
      integrity: digest('A'),
    },
  });
  const urlDiff = diffLockfiles(currentUrl, baseline);
  assert.deepEqual(urlDiff.entries[0].changeTypes, ['resolved-url']);
});

test('版本与 integrity 变化', () => {
  const baseline = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  // 仅替换 version 与 integrity，保持 resolved URL 不变
  const current = lockfile(3, {
    'node_modules/x': {
      version: '1.1.0',
      resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
      integrity: digest('Z'),
    },
  });
  const diff = diffLockfiles(current, baseline);
  assert.deepEqual(diff.entries[0].changeTypes.sort(), ['integrity', 'version']);
});

test('同一位置多变化只计 1 个 changed', () => {
  const baseline = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  const current = lockfile(3, {
    'node_modules/x': pkg('x', '2.0.0', 'registry.evil-example.com', 'Z'),
  });
  const diff = diffLockfiles(current, baseline);
  assert.equal(diff.summary.changed, 1);
  assert.ok(diff.entries[0].changeTypes.length >= 2);
});

test('integrity 多算法顺序不同不算变化', () => {
  const mk = (order) =>
    lockfile(3, {
      'node_modules/x': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz',
        integrity:
          order === 'ab'
            ? `sha256-${'Q'.repeat(43)}= sha512-${'A'.repeat(86)}==`
            : `sha512-${'A'.repeat(86)}== sha256-${'Q'.repeat(43)}=`,
      },
    });
  const diff = diffLockfiles(mk('ba'), mk('ab'));
  assert.equal(diff.entries[0].status, 'unchanged');
});

test('跨 lockfileVersion 对比给警告', () => {
  const baseline = lockfile(2, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  const current = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  const diff = diffLockfiles(current, baseline);
  assert.equal(diff.warnings.length, 1);
});

test('diff 派生 finding 的 ruleId 与级别', () => {
  const rules = materializeRules();
  const baseline = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.npmjs.org', 'A'),
  });
  const current = lockfile(3, {
    'node_modules/x': pkg('x', '1.0.0', 'registry.evil-example.com', 'A'),
  });
  const findings = diffFindings(diffLockfiles(current, baseline), rules);
  const ids = new Set(findings.map((f) => f.ruleId));
  assert.ok(ids.has(RULE_IDS.DIFF_RESOLVED_HOST_CHANGED));
  assert.equal(findings[0].source, 'diff');
});
