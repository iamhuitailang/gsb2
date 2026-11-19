import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile, basenameOf } from '../src/core/parse-lockfile.js';
import { AppError } from '../src/core/errors.js';
import { RELATIONSHIPS, SOURCE_TYPES } from '../src/core/model.js';

const v2Lockfile = {
  lockfileVersion: 2,
  packages: {
    '': {
      name: 'root-app',
      version: '1.0.0',
      dependencies: { 'left-pad': '^1.3.0', 'my-alias': 'npm:real-pkg@^1.2.0' },
    },
    'node_modules/left-pad': {
      version: '1.3.0',
      resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
      integrity: `sha512-${'A'.repeat(86)}==`,
    },
    'node_modules/my-alias': {
      name: 'real-pkg',
      version: '1.2.3',
      resolved: 'https://registry.npmjs.org/real-pkg/-/real-pkg-1.2.3.tgz',
      integrity: `sha512-${'B'.repeat(86)}==`,
    },
    'node_modules/old-app': {
      version: '2.0.0',
      resolved: 'https://registry.npmjs.org/old-app/-/old-app-2.0.0.tgz',
      integrity: `sha512-${'C'.repeat(86)}==`,
      dependencies: { lodash: '^3.0.0' },
    },
    'node_modules/old-app/node_modules/lodash': {
      version: '3.10.1',
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-3.10.1.tgz',
      integrity: `sha512-${'D'.repeat(86)}==`,
    },
    'node_modules/lodash': {
      version: '4.17.21',
      resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
      integrity: `sha512-${'E'.repeat(86)}==`,
    },
    'node_modules/empty-v3': {},
  },
};

test('v2 解析：根条目、普通包与嵌套同名包分别保留', () => {
  const parsed = parseLockfile(v2Lockfile);
  assert.equal(parsed.lockfileVersion, 2);
  assert.ok(parsed.records.has(''));
  assert.ok(parsed.records.has('node_modules/lodash'));
  assert.ok(parsed.records.has('node_modules/old-app/node_modules/lodash'));
  const lodashNested = parsed.records.get('node_modules/old-app/node_modules/lodash');
  assert.equal(lodashNested.version, '3.10.1');
  assert.equal(parsed.records.get('node_modules/lodash').version, '4.17.21');
});

test('basenameOf 正确处理 scoped 包', () => {
  assert.equal(basenameOf('node_modules/@scope/name'), '@scope/name');
  assert.equal(basenameOf('node_modules/a/node_modules/@s/b'), '@s/b');
  assert.equal(basenameOf('node_modules/left-pad'), 'left-pad');
  assert.equal(basenameOf(''), null);
});

test('别名识别：安装目录名与声明 name 不一致', () => {
  const parsed = parseLockfile(v2Lockfile);
  const alias = parsed.records.get('node_modules/my-alias');
  assert.equal(alias.alias, true);
  assert.equal(alias.basename, 'my-alias');
  assert.equal(alias.declaredName, 'real-pkg');
  assert.equal(alias.name, 'real-pkg');
});

test('v3 空对象条目录入 omittedFields 且 inferred', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/empty-v3': {} },
  });
  const rec = parsed.records.get('node_modules/empty-v3');
  assert.deepEqual(rec.omittedFields.sort(), ['integrity', 'resolved']);
  assert.equal(rec.inferred, true);
  assert.equal(rec.sourceType, SOURCE_TYPES.UNKNOWN);
});

test('link:true 标记为 link 来源', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/ws': { link: true, resolved: 'packages/ws' },
    },
  });
  assert.equal(parsed.records.get('node_modules/ws').sourceType, SOURCE_TYPES.LINK);
});

test('v1 嵌套树合成虚拟位置键并保留 requires', () => {
  const v1 = {
    lockfileVersion: 1,
    dependencies: {
      'top-a': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/top-a/-/top-a-1.0.0.tgz',
        integrity: `sha512-${'F'.repeat(86)}==`,
        requires: { 'inner-b': '^2.0.0' },
        dependencies: {
          'inner-b': {
            version: '2.0.0',
            resolved: 'https://registry.npmjs.org/inner-b/-/inner-b-2.0.0.tgz',
          },
        },
      },
    },
  };
  const parsed = parseLockfile(v1);
  assert.ok(parsed.records.has('node_modules/top-a'));
  assert.ok(parsed.records.has('node_modules/top-a/node_modules/inner-b'));
  assert.equal(parsed.rawDeps.get('node_modules/top-a').get('inner-b'), '^2.0.0');
  assert.equal(parsed.records.get('node_modules/top-a/node_modules/inner-b').from, null);
});

test('v1 从 from 字段的 npm: 描述符识别别名', () => {
  const parsed = parseLockfile({
    lockfileVersion: 1,
    dependencies: {
      'my-alias': {
        version: '1.2.3',
        from: 'my-alias@npm:real-pkg@^1.2.0',
        resolved: 'https://registry.npmjs.org/real-pkg/-/real-pkg-1.2.3.tgz',
      },
    },
  });
  const rec = parsed.records.get('node_modules/my-alias');
  assert.equal(rec.alias, true);
  assert.equal(rec.declaredName, 'real-pkg');
  assert.equal(rec.basename, 'my-alias');
});

test('无 lockfileVersion 报 UNSUPPORTED_STRUCTURE', () => {
  assert.throws(
    () => parseLockfile({ dependencies: {} }),
    (err) => err instanceof AppError && err.code === 'UNSUPPORTED_STRUCTURE',
  );
});

test('未知版本号报 UNKNOWN_LOCKFILE_VERSION', () => {
  assert.throws(
    () => parseLockfile({ lockfileVersion: 99, packages: {} }),
    (err) => err.code === 'UNKNOWN_LOCKFILE_VERSION' && err.lockfileVersion === 99,
  );
});

test('v2 既无 packages 也无 dependencies 报结构错误', () => {
  assert.throws(
    () => parseLockfile({ lockfileVersion: 3 }),
    (err) => err.code === 'UNSUPPORTED_STRUCTURE',
  );
});

test('根节点非对象报结构错误', () => {
  assert.throws(
    () => parseLockfile('not-an-object'),
    (err) => err.code === 'UNSUPPORTED_STRUCTURE',
  );
});

test('__proto__ 特殊键不污染原型且可被 Map 取回', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: { '': {}, 'node_modules/__proto__': { version: '1.0.0' } },
  });
  assert.equal(Object.prototype.version, undefined);
  const rec = parsed.records.get('node_modules/__proto__');
  assert.equal(rec.version, '1.0.0');
  assert.equal(rec.relationship, RELATIONSHIPS.UNREACHABLE);
});
