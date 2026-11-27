import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateUrl, normalizeUrl } from '../src/sanitizer/url-policy.js';

// ---- 脚本协议必须在任何混淆形式下都被拒绝 -------------------------------
test('javascript: 协议各种混淆全部拒绝', () => {
  const payloads = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java script:alert(1)',
    'javascript:alert(1)',
    '  javascript:alert(1)  ',
    '&#106;avascript:alert(1)',          // 十进制实体
    '&#x6a;avascript:alert(1)',          // 十六进制实体
    '&#x6A;AVASCRIPT:alert(1)',
    'jav&#x09;ascript:alert(1)',         // 实体插在中间
    'jav\u0000ascript:alert(1)',         // NUL 字节
    'vbscript:msgbox(1)',
    'VBScript:msgbox(1)',
    'livescript:foo()',
    'jscript:foo()'
  ];
  for (const p of payloads) {
    const r = evaluateUrl(p, 'href');
    assert.equal(r.ok, false, `应拒绝: ${JSON.stringify(p)}`);
    assert.match(r.reason, /script-scheme/);
  }
});

test('剥离混淆字符后协议仍可识别', () => {
  assert.equal(normalizeUrl('java\tscript:x'), 'javascript:x');
  assert.equal(normalizeUrl('&#106;avascript:x'), 'javascript:x');
  assert.equal(normalizeUrl('  https://a/ '), 'https://a/');
  assert.equal(normalizeUrl('java\u0000script:x'), 'javascript:x');
  assert.equal(normalizeUrl('java­script:x'), 'javascript:x'); // 软连字符
});

// ---- 协议白名单 -----------------------------------------------------------
test('http/https 外联一律拒绝(预览不发起外部请求)', () => {
  for (const u of [
    'http://example.com/',
    'https://example.com/a?b=1',
    'https://127.0.0.1:9999/x',
    'https://localhost/x'
  ]) {
    const r = evaluateUrl(u, 'resource');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'network-request-blocked-by-policy');
  }
});

test('协议相对地址拒绝', () => {
  const r = evaluateUrl('//evil.example/x', 'href');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'protocol-relative-url');
});

test('反斜杠混淆拒绝', () => {
  for (const u of ['\\\\evil.example\\x', 'https:\\\\evil.example', '\\x']) {
    const r = evaluateUrl(u, 'href');
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, 'backslash-obfuscation');
  }
});

test('非白名单 scheme 拒绝(file/blob/mailto/data 非图片等)', () => {
  const cases = [
    ['file:///etc/passwd', 'scheme-not-allowed'],
    ['blob:https://x/uuid', 'blob-uri-not-allowed'],
    ['filesystem:https://x/t/f', 'filesystem-uri-not-allowed'],
    ['mailto:a@b.test', 'scheme-not-allowed'],
    ['tel:10086', 'scheme-not-allowed'],
    ['about:blank', 'scheme-not-allowed'],
    ['custom-app://launch', 'scheme-not-allowed']
  ];
  for (const [u, reason] of cases) {
    const r = evaluateUrl(u, 'href');
    assert.equal(r.ok, false, u);
    assert.equal(r.reason, reason, u);
  }
});

// ---- data: URI 策略 -------------------------------------------------------
test('图片类 base64 data URI 在资源上下文放行', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = evaluateUrl(png, 'resource');
  assert.equal(r.ok, true);
  assert.equal(r.scheme, 'data');
});

test('SVG/HTML/文本 data URI 拒绝(SVG 可携带脚本)', () => {
  const bad = [
    'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:text/html;base64,PGI+MTwvYj4=',
    'data:text/plain;base64,aGVsbG8=',
    'data:image/png,abc',                 // 非 base64
    'data:image/png;base64,!!!notb64',    // 非法载荷
    'data:',                               // 不完整
    'data:image/png;base64'               // 缺逗号
  ];
  for (const u of bad) {
    const r = evaluateUrl(u, 'resource');
    assert.equal(r.ok, false, u);
  }
});

test('data: URI 即使在 href 也只放行图片', () => {
  const ok = evaluateUrl(
    'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'href'
  );
  assert.equal(ok.ok, true);
  const bad = evaluateUrl('data:text/html,<b>1</b>', 'href');
  assert.equal(bad.ok, false);
});

// ---- 相对地址与锚点 -------------------------------------------------------
test('相对路径在两种上下文都拒绝', () => {
  for (const u of ['a/b.html', './a.html', '../x', '/root/path']) {
    assert.equal(evaluateUrl(u, 'resource').ok, false, u);
    assert.equal(evaluateUrl(u, 'href').ok, false, u);
  }
});

test('页内锚点仅 href 上下文放行', () => {
  assert.equal(evaluateUrl('#section', 'href').ok, true);
  const r = evaluateUrl('#x', 'resource');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'fragment-not-allowed-as-resource');
});

test('空地址拒绝', () => {
  assert.equal(evaluateUrl('', 'href').ok, false);
  assert.equal(evaluateUrl('   ', 'href').reason, 'empty-url');
  assert.equal(evaluateUrl(null, 'href').reason, 'empty-url');
});

test('大小写不影响判定结果', () => {
  const r = evaluateUrl('HTTPS://EXAMPLE.COM/', 'resource');
  assert.equal(r.ok, false);
  assert.equal(r.scheme, 'https');
});
