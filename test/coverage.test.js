import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy } from '../src/core/parser.js';
import { analyzeCoverage } from '../src/core/coverage.js';

test('回退链：未定义 script-src 时由 default-src 接管', () => {
  const p = parsePolicy("default-src 'self'");
  const cov = analyzeCoverage(p);
  assert.equal(cov.script.effectiveDirective, 'default-src');
  assert.equal(cov.script.covered, true);
  assert.ok(cov.script.notes.some((n) => n.text.includes('回退链')));
  assert.deepEqual(
    cov.script.chain.map((c) => c.name),
    ['script-src-elem', 'script-src', 'default-src']
  );
});

test('显式指令优先于 default-src', () => {
  const p = parsePolicy("default-src 'self'; img-src https://img.example.com");
  const cov = analyzeCoverage(p);
  assert.equal(cov.img.effectiveDirective, 'img-src');
  assert.equal(cov.img.effectiveSources[0].raw, 'https://img.example.com');
});

test('frame 的回退链经过 child-src', () => {
  const p = parsePolicy("default-src 'self'; child-src https://frames.test");
  const cov = analyzeCoverage(p);
  assert.equal(cov.frame.effectiveDirective, 'child-src');
  assert.deepEqual(
    cov.frame.chain.map((c) => c.name),
    ['frame-src', 'child-src', 'default-src']
  );
});

test('完全无覆盖时给出不受限警告', () => {
  const p = parsePolicy("object-src 'none'");
  const cov = analyzeCoverage(p);
  assert.equal(cov.img.covered, false);
  assert.equal(cov.img.effectiveDirective, null);
  assert.ok(cov.img.notes.some((n) => n.level === 'warning' && n.text.includes('不做限制')));
});

test("'none' 模式与 strict-dynamic 模式识别", () => {
  const p = parsePolicy(
    "object-src 'none'; script-src 'nonce-abc' 'strict-dynamic'"
  );
  const cov = analyzeCoverage(p);
  assert.equal(cov.object.effectiveMode, 'deny-all');
  assert.equal(cov.script.effectiveMode, 'strict-dynamic');
  assert.ok(cov.script.notes.some((n) => n.text.includes('strict-dynamic')));
});

test('空值指令被标记为忽略并继续回退', () => {
  const p = parsePolicy("default-src 'self'; img-src");
  const cov = analyzeCoverage(p);
  assert.equal(cov.img.effectiveDirective, 'default-src');
  assert.ok(cov.img.chain[0].present, true);
  assert.ok(cov.img.notes.some((n) => n.text.includes('被浏览器忽略')));
});

test('规范化来源与原文同时保留', () => {
  const p = parsePolicy('img-src HTTPS://IMG.Example.COM/x');
  const cov = analyzeCoverage(p);
  const s = cov.img.effectiveSources[0];
  assert.equal(s.raw, 'HTTPS://IMG.Example.COM/x'); // 原文
  assert.equal(s.canonical, 'https://img.example.com/x'); // 规范化
});
