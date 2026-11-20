import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSourceToken, sourceMatches, parseUrl, breadthRank } from '../src/core/sources.js';

const ctx = { documentOrigin: 'https://app.demo.local' };
const match = (token, url, context = ctx) => {
  const r = parseSourceToken(token);
  assert.ok(r.ok, `源解析失败: ${r.ok ? '' : r.error.message}`);
  const info = parseUrl(url);
  assert.ok(info, `URL 解析失败: ${url}`);
  return sourceMatches(r.source, info, context);
};

test('主机源：精确域名、子域通配与裸域边界', () => {
  assert.equal(match('https://cdn.example.com/app.js', 'https://cdn.example.com/app.js'), true);
  assert.equal(match('cdn.example.com', 'https://cdn.example.com/x'), true);
  assert.equal(match('cdn.example.com', 'http://cdn.example.com/x'), true); // 无协议默认匹配 http/https/ws/wss
  assert.equal(match('cdn.example.com', 'https://other.example.com/x'), false);
  // *.example.com 不匹配裸 example.com
  assert.equal(match('*.example.com', 'https://example.com/x'), false);
  assert.equal(match('*.example.com', 'https://a.example.com/x'), true);
  assert.equal(match('*.example.com', 'https://a.b.example.com/x'), true);
  // 单独 *
  assert.equal(match('*', 'https://anything.test/x'), true);
  assert.equal(match('*', 'data:text/plain,hi'), false); // * 不匹配 data:
});

test('协议源匹配', () => {
  assert.equal(match('https:', 'https://x.test/a'), true);
  assert.equal(match('https:', 'http://x.test/a'), false);
  assert.equal(match('data:', 'data:text/plain,hi'), true);
  assert.equal(match('https:', 'data:text/plain,hi'), false);
});

test("'self' 同源判定与 data:/blob: 处理", () => {
  assert.equal(match("'self'", 'https://app.demo.local/x'), true);
  assert.equal(match("'self'", 'https://other.demo.local/x'), false);
  assert.equal(match("'self'", 'data:text/plain,hi'), false);
  assert.equal(match("'self'", 'blob:https://app.demo.local/uuid'), true);
  assert.equal(match("'self'", 'blob:https://other.local/uuid'), false);
});

test('端口规则：显式端口、通配端口与默认端口', () => {
  assert.equal(match('https://api.example.com:8443', 'https://api.example.com:8443/x'), true);
  assert.equal(match('https://api.example.com:8443', 'https://api.example.com/x'), false);
  assert.equal(match('https://api.example.com', 'https://api.example.com:8443/x'), false);
  assert.equal(match('https://api.example.com', 'https://api.example.com/x'), true);
  assert.equal(match('https://api.example.com:*', 'https://api.example.com:9999/x'), true);
});

test('路径前缀匹配', () => {
  assert.equal(match('https://cdn.example.com/app/', 'https://cdn.example.com/app/main.js'), true);
  assert.equal(match('https://cdn.example.com/app/', 'https://cdn.example.com/other/main.js'), false);
  // 前缀不做目录语义，按字符串比较
  assert.equal(match('https://cdn.example.com/app', 'https://cdn.example.com/app-ish/x'), true);
});

test("'none' 与 nonce/hash 不匹配外部 URL", () => {
  assert.equal(match("'none'", 'https://x.test/a'), false);
  assert.equal(match("'nonce-abc'", 'https://x.test/a'), false);
  assert.equal(match(`'sha256-${'A'.repeat(43)}='`, 'https://x.test/a'), false);
});

test('非法源给出错误而非抛异常', () => {
  for (const bad of ["'unsafe-inline", 'self', 'https://h:99999', '*..bad', 'ht!tp://x']) {
    const r = parseSourceToken(bad);
    assert.equal(r.ok, false, `${bad} 应当解析失败`);
    assert.ok(r.error.message);
  }
});

test('宽泛度排序：通配符 < 协议源 < 主机源 < self < nonce', () => {
  const ranks = ['*', 'https:', '*.example.com', 'https://cdn.example.com', "'self'", "'nonce-abc'"].map((t) => {
    const r = parseSourceToken(t);
    return breadthRank(r.source);
  });
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i - 1] < ranks[i], '宽泛度应递增');
  }
});

test('非法 URL 解析返回 null 而不是抛异常', () => {
  assert.equal(parseUrl('not a url at all'), null);
  assert.equal(parseUrl('http://'), null);
});
