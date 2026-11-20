import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../src/core/parser.js';
import { comparePolicies } from '../src/core/compare.js';

test('识别指令的新增与删除', () => {
  const a = parsePolicy("default-src 'self'");
  const b = parsePolicy("default-src 'self'; img-src https://img.test");
  const r = comparePolicies(a, b);
  assert.equal(r.summary.added, 1);
  assert.ok(r.directiveDiffs.find((d) => d.name === 'img-src' && d.status === 'added'));

  const r2 = comparePolicies(b, a);
  assert.equal(r2.summary.removed, 1);
  assert.ok(r2.directiveDiffs.find((d) => d.name === 'img-src' && d.status === 'removed'));
});

test('来源新增判定为放宽，删除判定为收紧', () => {
  const a = parsePolicy("img-src 'self'");
  const b = parsePolicy("img-src 'self' https://img.test");
  const r = comparePolicies(a, b);
  const diff = r.directiveDiffs.find((d) => d.name === 'img-src');
  assert.equal(diff.status, 'modified');
  const change = diff.changes[0];
  assert.equal(change.effect, 'loosened');

  const back = comparePolicies(b, a);
  const backChange = back.directiveDiffs.find((d) => d.name === 'img-src').changes[0];
  assert.equal(backChange.effect, 'tightened');
});

test("新增 unsafe-inline 标记为放宽，移除标记为收紧", () => {
  const a = parsePolicy("script-src 'self'");
  const b = parsePolicy("script-src 'self' 'unsafe-inline'");
  const change = comparePolicies(a, b)
    .directiveDiffs.find((d) => d.name === 'script-src')
    .changes.find((c) => c.token === "'unsafe-inline'");
  assert.equal(change.effect, 'loosened');
  assert.match(change.reason, /危险关键字/);
});

test("新增 'none' 判定为收紧", () => {
  const a = parsePolicy("object-src 'self'");
  const b = parsePolicy("object-src 'none'");
  const change = comparePolicies(a, b)
    .directiveDiffs.find((d) => d.name === 'object-src')
    .changes.find((c) => c.token === "'none'");
  assert.equal(change.effect, 'tightened');
});

test('顺序稳定性：调换指令与来源顺序不产生差异', () => {
  const a = parsePolicy("default-src 'self'; img-src 'self' https://a.test; script-src https://s.test");
  const b = parsePolicy("script-src https://s.test; img-src https://a.test 'self'; default-src 'self'");
  const r = comparePolicies(a, b);
  assert.equal(r.summary.modified, 0);
  assert.equal(r.summary.added, 0);
  assert.equal(r.summary.removed, 0);
  // stableKey 与输入顺序无关
  assert.equal(r.stableKey, comparePolicies(b, a).stableKey.split('||').reverse().join('||'));
});

test('模式变化被识别', () => {
  const a = parsePolicy("default-src 'self'", { mode: 'enforce' });
  const b = parsePolicy("default-src 'self'", { mode: 'report-only' });
  const r = comparePolicies(a, b);
  assert.ok(r.modeChange);
  assert.match(r.modeChange.label, /强制模式.*报告模式/);
});

test('无法解析的来源在比较中保留标记而不是静默丢弃', () => {
  const a = parsePolicy("img-src 'self'");
  const b = parsePolicy("img-src 'self' 'unsafe-inline");
  const r = comparePolicies(a, b);
  const diff = r.directiveDiffs.find((d) => d.name === 'img-src');
  const change = diff.changes[0];
  assert.ok(change.token.startsWith('⚠'));
  assert.equal(change.effect, 'neutral');
  assert.match(change.reason, /无法解析/);
});

test('更宽泛的同维度来源覆盖时给出提示', () => {
  const a = parsePolicy('img-src https:');
  const b = parsePolicy('img-src https: https://cdn.example.com');
  const change = comparePolicies(a, b)
    .directiveDiffs.find((d) => d.name === 'img-src')
    .changes.find((c) => c.token === 'https://cdn.example.com');
  assert.match(change.reason, /覆盖/);
});

test('危险关键字与主机源维度不同，不给出覆盖提示', () => {
  const a = parsePolicy("img-src 'self'");
  const b = parsePolicy("img-src 'self' 'unsafe-inline'");
  const change = comparePolicies(a, b)
    .directiveDiffs.find((d) => d.name === 'img-src')
    .changes.find((c) => c.token === "'unsafe-inline'");
  assert.doesNotMatch(change.reason, /覆盖/);
});
