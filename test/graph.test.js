import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLockfile } from '../src/core/parse-lockfile.js';
import { buildGraph, allPathsTo } from '../src/core/graph.js';
import { RELATIONSHIPS } from '../src/core/model.js';

const digest = `sha512-${'A'.repeat(86)}==`;
const tarball = (n, v) => `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`;

test('根出边判定 direct，深层依赖判定 transitive', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1.0.0' } },
      'node_modules/a': {
        version: '1.0.0',
        resolved: tarball('a', '1.0.0'),
        integrity: digest,
        dependencies: { b: '2.0.0' },
      },
      'node_modules/a/node_modules/b': {
        version: '2.0.0',
        resolved: tarball('b', '2.0.0'),
        integrity: digest,
      },
    },
  });
  const graph = buildGraph(parsed);
  assert.equal(graph.relationship.get('node_modules/a'), RELATIONSHIPS.DIRECT);
  assert.equal(graph.relationship.get('node_modules/a/node_modules/b'), RELATIONSHIPS.TRANSITIVE);
  assert.deepEqual(graph.shortestPaths.get('node_modules/a/node_modules/b'), [
    '',
    'node_modules/a',
    'node_modules/a/node_modules/b',
  ]);
});

test('提升依赖解析到祖先 node_modules', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1.0.0', lodash: '4.0.0' } },
      'node_modules/a': {
        version: '1.0.0',
        resolved: tarball('a', '1.0.0'),
        integrity: digest,
        dependencies: { lodash: '4.0.0', deep: '1.0.0' },
        // a 依赖 deep，deep 又依赖 lodash
      },
      'node_modules/a/node_modules/deep': {
        version: '1.0.0',
        resolved: tarball('deep', '1.0.0'),
        integrity: digest,
        dependencies: { lodash: '4.0.0' },
      },
      'node_modules/lodash': {
        version: '4.0.0',
        resolved: tarball('lodash', '4.0.0'),
        integrity: digest,
      },
    },
  });
  const graph = buildGraph(parsed);
  // deep 的 lodash 依赖应解析到根级 node_modules/lodash
  assert.ok(graph.edgesIn.get('node_modules/lodash').has('node_modules/a/node_modules/deep'));
  assert.equal(graph.relationship.get('node_modules/lodash'), RELATIONSHIPS.DIRECT);
  assert.equal(graph.dangling.length, 0);
});

test('嵌套同名包分别建边，路径保留位置信息', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { app: '1.0.0', lodash: '4.0.0' } },
      'node_modules/app': {
        version: '1.0.0',
        resolved: tarball('app', '1.0.0'),
        integrity: digest,
        dependencies: { lodash: '3.0.0' },
      },
      'node_modules/app/node_modules/lodash': {
        version: '3.0.0',
        resolved: tarball('lodash', '3.0.0'),
        integrity: digest,
      },
      'node_modules/lodash': {
        version: '4.0.0',
        resolved: tarball('lodash', '4.0.0'),
        integrity: digest,
      },
    },
  });
  const graph = buildGraph(parsed);
  assert.ok(graph.edgesOut.get('node_modules/app').has('node_modules/app/node_modules/lodash'));
  assert.ok(graph.edgesOut.get('').has('node_modules/lodash'));
  const nestedPath = graph.shortestPaths.get('node_modules/app/node_modules/lodash');
  assert.deepEqual(nestedPath, ['', 'node_modules/app', 'node_modules/app/node_modules/lodash']);
});

test('悬空依赖记入 dangling 而不是建边', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1.0.0' } },
      'node_modules/a': {
        version: '1.0.0',
        resolved: tarball('a', '1.0.0'),
        integrity: digest,
        optionalDependencies: { 'missing-opt': '1.0.0' },
      },
    },
  });
  const graph = buildGraph(parsed);
  assert.equal(graph.dangling.length, 1);
  assert.equal(graph.dangling[0].depName, 'missing-opt');
});

test('环依赖不会让路径枚举死循环', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { a: '1.0.0' } },
      'node_modules/a': {
        version: '1.0.0',
        resolved: tarball('a', '1.0.0'),
        integrity: digest,
        dependencies: { b: '1.0.0' },
      },
      'node_modules/b': {
        version: '1.0.0',
        resolved: tarball('b', '1.0.0'),
        integrity: digest,
        dependencies: { a: '1.0.0' },
      },
    },
  });
  const graph = buildGraph(parsed);
  assert.equal(graph.relationship.get('node_modules/b'), RELATIONSHIPS.TRANSITIVE);
  const { paths, truncated } = allPathsTo('node_modules/b', graph);
  assert.ok(paths.length >= 1);
  // 环被 visited 拦截，不应无限增长
  assert.ok(paths.length <= 20);
  assert.equal(truncated, false);
});

test('菱形依赖枚举多条简单路径', () => {
  const parsed = parseLockfile({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { left: '1.0.0', right: '1.0.0' } },
      'node_modules/left': {
        version: '1.0.0',
        resolved: tarball('left', '1.0.0'),
        integrity: digest,
        dependencies: { bottom: '1.0.0' },
      },
      'node_modules/right': {
        version: '1.0.0',
        resolved: tarball('right', '1.0.0'),
        integrity: digest,
        dependencies: { bottom: '1.0.0' },
      },
      'node_modules/bottom': {
        version: '1.0.0',
        resolved: tarball('bottom', '1.0.0'),
        integrity: digest,
      },
    },
  });
  const graph = buildGraph(parsed);
  const { paths } = allPathsTo('node_modules/bottom', graph);
  assert.equal(paths.length, 2);
});
