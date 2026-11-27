import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeStyle } from '../src/sanitizer/css-sanitizer.js';

test('安全排版声明保留', () => {
  const { css, removed } = sanitizeStyle('color: red; font-size: 14px; margin: 0 auto');
  assert.match(css, /color: red/);
  assert.match(css, /font-size: 14px/);
  assert.match(css, /margin: 0 auto/);
  assert.equal(removed.length, 0);
});

test('url() 引用在任何属性中都被拦截', () => {
  const { css, removed } = sanitizeStyle(
    'background: url(https://x/x.png); color: red; background-image: url("javascript:x")'
  );
  assert.ok(!css.includes('url'));
  assert.match(css, /color: red/);
  assert.equal(removed.filter((r) => r.reason === 'css-url-reference').length, 2);
});

test('expression 与脚本协议拦截', () => {
  const { css, removed } = sanitizeStyle(
    'width: expression(alert(1)); behavior: url(x.htc); ' +
    'background: url(javascript:alert(1)); color: rgb(1,2,3)'
  );
  assert.ok(!/expression|javascript/.test(css));
  assert.ok(removed.some((r) => r.reason === 'css-expression'));
  assert.ok(removed.some((r) => r.reason === 'css-url-reference'));
  assert.match(css, /color: rgb\(1,2,3\)/);
});

test('@import 与 data: 拦截', () => {
  const { removed } = sanitizeStyle("@import 'x.css'; background: url(data:image/png;base64,AA)");
  assert.ok(removed.some((r) => r.reason === 'css-at-import'));
  assert.ok(removed.some((r) => r.reason === 'css-url-reference'));
});

test('非白名单属性拦截(position 相关除外)', () => {
  const { removed } = sanitizeStyle(
    'position: fixed; --my-var: 1; -moz-binding: url(x); unknown-prop: 1'
  );
  const reasons = removed.map((r) => r.reason);
  assert.ok(reasons.includes('custom-property-not-allowed'));
  assert.ok(reasons.includes('property-not-allowed'));
});

test('反斜杠十六进制转义拦截', () => {
  const { removed } = sanitizeStyle('color: \\65 xpression(x)');
  assert.ok(removed.some((r) => r.reason === 'css-backslash-escape'));
});

test('引号不配对的声明拦截', () => {
  const { removed } = sanitizeStyle("font-family: 'unclosed; color: red");
  assert.ok(removed.some((r) => r.reason === 'unbalanced-quotes'));
});

test('畸形与空声明容错', () => {
  const { css, removed } = sanitizeStyle('garbage;; color: red;');
  assert.match(css, /color: red/);
  assert.ok(removed.some((r) => r.reason === 'malformed-declaration'));
});

test('大小写不影响判定', () => {
  const { css, removed } = sanitizeStyle('COLOR: RED; WIDTH: EXPRESSION(1)');
  assert.match(css, /color: RED/);
  assert.ok(removed.some((r) => r.reason === 'css-expression'));
});

test('全部声明被拒时返回空字符串', () => {
  const { css } = sanitizeStyle('background: url(x); --y: 1');
  assert.equal(css, '');
});
