import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, parseHeaderText } from '../src/core/parser.js';
import { evaluateSample } from '../src/core/evaluator.js';

const parse = (text, mode = 'enforce') => [parsePolicy(text, { mode })];
const ORIGIN = 'https://app.demo.local';

test('外部 URL 命中白名单则允许，并记录命中来源', () => {
  const v = evaluateSample(
    { resourceType: 'script', url: 'https://cdn.example.com/a.js', documentOrigin: ORIGIN },
    parse("script-src 'self' https://cdn.example.com")
  );
  assert.equal(v.decision, 'allowed');
  assert.equal(v.perPolicy[0].matchedSource, 'https://cdn.example.com');
  assert.equal(v.perPolicy[0].directive, 'script-src');
});

test('外部 URL 不匹配任何来源则拦截', () => {
  const v = evaluateSample(
    { resourceType: 'script', url: 'https://evil.test/a.js', documentOrigin: ORIGIN },
    parse("script-src 'self' https://cdn.example.com")
  );
  assert.equal(v.decision, 'blocked');
  assert.match(v.reason, /拦截/);
});

test('回退到 default-src 的判定', () => {
  const allowed = evaluateSample(
    { resourceType: 'img', url: 'https://app.demo.local/a.png', documentOrigin: ORIGIN },
    parse("default-src 'self'")
  );
  assert.equal(allowed.decision, 'allowed');
  assert.equal(allowed.perPolicy[0].directive, 'default-src');

  const blocked = evaluateSample(
    { resourceType: 'img', url: 'https://other.test/a.png', documentOrigin: ORIGIN },
    parse("default-src 'self'")
  );
  assert.equal(blocked.decision, 'blocked');
});

test("'none' 拦截全部外部资源", () => {
  const v = evaluateSample(
    { resourceType: 'frame', url: 'https://widget.test/x.html' },
    parse("frame-src 'none'")
  );
  assert.equal(v.decision, 'blocked');
  assert.match(v.perPolicy[0].reason, /none/);
});

test('内联脚本：nonce 命中允许，nonce 缺失拦截', () => {
  const policies = parse("script-src 'nonce-secret123'");
  const ok = evaluateSample({ resourceType: 'script', inline: true, nonce: 'secret123' }, policies);
  assert.equal(ok.decision, 'allowed');
  const bad = evaluateSample({ resourceType: 'script', inline: true, nonce: 'wrong' }, policies);
  assert.equal(bad.decision, 'blocked');
  const none = evaluateSample({ resourceType: 'script', inline: true }, policies);
  assert.equal(none.decision, 'blocked');
});

test("内联脚本：'unsafe-inline' 在有 nonce 时被忽略（CSP3 语义）", () => {
  const policies = parse("script-src 'unsafe-inline' 'nonce-secret123'");
  const withNonce = evaluateSample({ resourceType: 'script', inline: true, nonce: 'secret123' }, policies);
  assert.equal(withNonce.decision, 'allowed');
  const withoutNonce = evaluateSample({ resourceType: 'script', inline: true }, policies);
  assert.equal(withoutNonce.decision, 'blocked');
  assert.ok(withoutNonce.perPolicy[0].trace.some((t) => t.includes('忽略')));
});

test("内联脚本：'unsafe-inline' 单独存在时放行", () => {
  const v = evaluateSample(
    { resourceType: 'script', inline: true },
    parse("script-src 'unsafe-inline'")
  );
  assert.equal(v.decision, 'allowed');
  assert.equal(v.perPolicy[0].matchedSource, "'unsafe-inline'");
});

test('哈希匹配放行内联内容', () => {
  const hash = 'A'.repeat(43) + '=';
  const v = evaluateSample(
    { resourceType: 'style', inline: true, hashAlgo: 'sha256', hashValue: hash },
    parse(`style-src 'sha256-${hash}'`)
  );
  assert.equal(v.decision, 'allowed');
});

test('strict-dynamic：受信传播允许，普通外部脚本拦截', () => {
  const policies = parse("script-src 'nonce-secret' 'strict-dynamic' https://cdn.example.com");
  const trusted = evaluateSample(
    { resourceType: 'script', url: 'https://anything.test/x.js', trusted: true },
    policies
  );
  assert.equal(trusted.decision, 'allowed');
  const plain = evaluateSample(
    { resourceType: 'script', url: 'https://cdn.example.com/x.js', trusted: false },
    policies
  );
  assert.equal(plain.decision, 'blocked');
  assert.match(plain.perPolicy[0].reason, /strict-dynamic/);
});

test('重定向：重定向前后都必须通过', () => {
  const policies = parse("script-src https://cdn.example.com");
  const ok = evaluateSample(
    {
      resourceType: 'script',
      url: 'https://cdn.example.com/r.js',
      redirected: true,
      redirectUrl: 'https://cdn.example.com/target.js',
    },
    policies
  );
  assert.equal(ok.decision, 'allowed');

  const bad = evaluateSample(
    {
      resourceType: 'script',
      url: 'https://cdn.example.com/r.js',
      redirected: true,
      redirectUrl: 'https://evil.test/x.js',
    },
    policies
  );
  assert.equal(bad.decision, 'blocked');
  assert.match(bad.perPolicy[0].reason, /重定向后/);
});

test('多强制策略取交集：任一策略拒绝即拦截', () => {
  const header = parseHeaderText(
    "script-src https://cdn.example.com, script-src https://other.example.com"
  );
  const v = evaluateSample(
    { resourceType: 'script', url: 'https://cdn.example.com/a.js' },
    header.policies
  );
  assert.equal(v.decision, 'blocked');
  assert.ok(v.perPolicy[0].decision === 'allowed' && v.perPolicy[1].decision === 'blocked');
});

test('报告模式：违规只产生报告结论，资源仍加载', () => {
  const v = evaluateSample(
    { resourceType: 'script', url: 'https://evil.test/a.js' },
    parse("script-src 'self'", 'report-only')
  );
  assert.equal(v.decision, 'allowed-report-only');
  assert.equal(v.perPolicy[0].decision, 'blocked'); // 策略本身判定违规
});

test('强制 + 报告混合：被强制拦截时整体拦截，并附带报告信息', () => {
  const policies = [
    parsePolicy("script-src 'self'", { mode: 'enforce', name: '强制' }),
    parsePolicy("script-src https://cdn.example.com", { mode: 'report-only', name: '报告' }),
  ];
  const blocked = evaluateSample({ resourceType: 'script', url: 'https://evil.test/x.js' }, policies);
  assert.equal(blocked.decision, 'blocked');

  const reported = evaluateSample({ resourceType: 'script', url: 'https://cdn.example.com/x.js' }, policies);
  assert.equal(reported.decision, 'blocked'); // 强制策略仍不允许 cdn
});

test('解析失败的地址按拒绝处理，绝不放行', () => {
  const v = evaluateSample(
    { resourceType: 'script', url: 'not-a-real-url' },
    parse("script-src *")
  );
  assert.equal(v.decision, 'blocked');
  assert.match(v.reason, /无法解析/);
});

test("指令含语法错误时无法证明允许即拒绝（'none' 互斥场景）", () => {
  const v = evaluateSample(
    { resourceType: 'img', url: 'https://x.test/a.png' },
    parse("img-src 'none' 'self'")
  );
  assert.equal(v.decision, 'blocked');
  assert.match(v.perPolicy[0].reason, /忽略/);
});

test('策略完全没有适用指令时该策略不限制（但其他策略仍可拦截）', () => {
  const v = evaluateSample(
    { resourceType: 'img', url: 'https://x.test/a.png' },
    parse("object-src 'none'")
  );
  assert.equal(v.decision, 'allowed');
  assert.equal(v.perPolicy[0].directive, null);
});

test('data: 图片需要显式 data: 协议源', () => {
  const url = 'data:image/png;base64,iVBORw0KGgo=';
  const blocked = evaluateSample({ resourceType: 'img', url }, parse("img-src 'self'"));
  assert.equal(blocked.decision, 'blocked');
  const allowed = evaluateSample({ resourceType: 'img', url }, parse('img-src data:'));
  assert.equal(allowed.decision, 'allowed');
});

test('缺少地址的外部请求返回 error 而不是放行', () => {
  const v = evaluateSample({ resourceType: 'script', url: '' }, parse("script-src 'self'"));
  assert.equal(v.decision, 'error');
});
