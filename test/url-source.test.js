import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyResolved, hostMatches, extractTarballName } from '../src/core/url-source.js';
import { SOURCE_TYPES } from '../src/core/model.js';

test('https registry tarball 分类为 http-tarball 并提取主机', () => {
  const r = classifyResolved('https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz');
  assert.equal(r.sourceType, SOURCE_TYPES.HTTP_TARBALL);
  assert.equal(r.scheme, 'https:');
  assert.equal(r.host, 'registry.npmjs.org');
});

test('http 协议保留并交给规则引擎判定', () => {
  const r = classifyResolved('http://registry.example.com/a/-/a-1.0.0.tgz');
  assert.equal(r.scheme, 'http:');
  assert.equal(r.host, 'registry.example.com');
});

test('git+https 剥离前缀后识别为 git', () => {
  const r = classifyResolved('git+https://github.com/org/repo.git#abc123');
  assert.equal(r.sourceType, SOURCE_TYPES.GIT);
  assert.equal(r.scheme, 'https:');
  assert.equal(r.host, 'github.com');
});

test('git+ssh 识别为 git 并取主机', () => {
  const r = classifyResolved('git+ssh://git@gitlab.com/org/repo.git#deadbeef');
  assert.equal(r.sourceType, SOURCE_TYPES.GIT);
  assert.equal(r.host, 'gitlab.com');
});

test('scp-like git 地址不依赖 URL 解析', () => {
  const r = classifyResolved('git@github.com:org/repo.git#cafe');
  assert.equal(r.sourceType, SOURCE_TYPES.GIT);
  assert.equal(r.scheme, 'ssh:');
  assert.equal(r.host, 'github.com');
});

test('github 缩写识别并标注 shorthand', () => {
  const r = classifyResolved('github:org/repo');
  assert.equal(r.sourceType, SOURCE_TYPES.GIT);
  assert.equal(r.host, 'github.com');
  assert.equal(r.shorthand, true);
});

test('file: 与裸路径识别为 file', () => {
  assert.equal(classifyResolved('file:../../vendor/x-1.0.0.tgz').sourceType, SOURCE_TYPES.FILE);
  assert.equal(classifyResolved('/opt/storage/x.tgz').sourceType, SOURCE_TYPES.FILE);
  assert.equal(classifyResolved('./local.tgz').sourceType, SOURCE_TYPES.FILE);
});

test('link: 识别为 link', () => {
  assert.equal(classifyResolved('link:../packages/w').sourceType, SOURCE_TYPES.LINK);
});

test('空值与无法解析的字符串归 unknown', () => {
  assert.equal(classifyResolved(null).sourceType, SOURCE_TYPES.UNKNOWN);
  assert.equal(classifyResolved('  ').sourceType, SOURCE_TYPES.UNKNOWN);
  const bad = classifyResolved('not a url !!!');
  assert.equal(bad.sourceType, SOURCE_TYPES.UNKNOWN);
  assert.ok(bad.parseError);
});

test('主机名与端口、大写 scheme 归一化', () => {
  const r = classifyResolved('HTTPS://REGISTRY.Example.COM:8443/a/-/a-1.0.0.tgz');
  assert.equal(r.host, 'registry.example.com');
  assert.equal(r.port, '8443');
  assert.equal(r.scheme, 'https:');
});

test('hostMatches 精确与子域匹配', () => {
  assert.equal(hostMatches('registry.npmjs.org', ['registry.npmjs.org'], true), true);
  assert.equal(hostMatches('mirror.registry.npmjs.org', ['registry.npmjs.org'], true), true);
  assert.equal(hostMatches('evil-registry.npmjs.org.attacker.com', ['registry.npmjs.org'], true), false);
  assert.equal(hostMatches('sub.registry.npmjs.org', ['registry.npmjs.org'], false), false);
  assert.equal(hostMatches(null, ['registry.npmjs.org'], true), false);
});

test('extractTarballName 普通包与 scoped 包', () => {
  assert.equal(
    extractTarballName('https://h/left-pad/-/left-pad-1.3.0.tgz'),
    'left-pad',
  );
  assert.equal(
    extractTarballName('https://h/@scope/name/-/name-2.0.0.tgz'),
    '@scope/name',
  );
  assert.equal(extractTarballName('https://h/not/a/registry/path'), null);
  assert.equal(extractTarballName('git+https://github.com/o/r.git'), null);
});
