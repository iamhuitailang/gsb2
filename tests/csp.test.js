/*
 * csp.test.js — 核心匹配逻辑的本地测试。
 * 运行：node tests/csp.test.js
 */
'use strict';

const CSP = require('../js/csp.js');

let passed = 0;
let failed = 0;

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log('  ok  ' + name);
  } else {
    failed++;
    console.log('FAIL  ' + name + '\n      期望: ' + e + '\n      实际: ' + a);
  }
}

// 便捷构造
function policy(text) { return CSP.parsePolicy(text); }
function urlOf(u, page) { return CSP.parseUrl(u, page); }
function ext(type, url, page) {
  return { type, inline: false, url: urlOf(url, page), nonce: null, hash: null };
}
function inlineRes(type, attrs) {
  return Object.assign({ type, inline: true, url: null, nonce: null, hash: null }, attrs);
}

const PAGE = 'https://shop.example.com:8443/app/page.html';
const origin = CSP.parsePageOrigin(PAGE);

/* ---------- 1. 'self' 与来源边界 ---------- */
{
  const p = policy("default-src 'self'");
  const d = p.directives.get('default-src');
  check("'self' 匹配同源（含端口）",
    CSP.evaluateDirective(d, ext('img', 'https://shop.example.com:8443/a.png', PAGE), origin).allowed, true);
  check("'self' 匹配相对路径",
    CSP.evaluateDirective(d, ext('img', '/a.png', PAGE), origin).allowed, true);
  check("'self' 拒绝端口不同",
    CSP.evaluateDirective(d, ext('img', 'https://shop.example.com/a.png', PAGE), origin).allowed, false);
  check("'self' 拒绝协议不同",
    CSP.evaluateDirective(d, ext('img', 'http://shop.example.com:8443/a.png', PAGE), origin).allowed, false);
  check("'self' 拒绝文本前缀相似的域名",
    CSP.evaluateDirective(d, ext('img', 'https://shop.example.com.evil.com/a.png', PAGE), origin).allowed, false);
}

/* ---------- 2. 通配符与主机匹配 ---------- */
{
  check('*.example.com 匹配子域', CSP.hostMatches('*.example.com', 'cdn.example.com'), true);
  check('*.example.com 匹配多级子域', CSP.hostMatches('*.example.com', 'a.b.example.com'), true);
  check('*.example.com 不含主域本身', CSP.hostMatches('*.example.com', 'example.com'), false);
  check('*.example.com 拒绝相似后缀', CSP.hostMatches('*.example.com', 'notexample.com'), false);
  check('*.example.com 拒绝 evil 拼接', CSP.hostMatches('*.example.com', 'example.com.evil.com'), false);
  check('精确主机拒绝前缀相似', CSP.hostMatches('cdn.example.com', 'cdn.example.com.evil.com'), false);
  check('* 匹配任意主机', CSP.hostMatches('*', 'anything.example.net'), true);
}

/* ---------- 3. 协议与端口 ---------- */
{
  const p = policy("img-src https://cdn.example.com:8443; font-src https:; connect-src https://api.example.com");
  const img = p.directives.get('img-src');
  const font = p.directives.get('font-src');
  const conn = p.directives.get('connect-src');
  check('显式端口一致 → 放行',
    CSP.evaluateDirective(img, ext('img', 'https://cdn.example.com:8443/a.png', PAGE), origin).allowed, true);
  check('显式端口不一致（默认443）→ 阻止',
    CSP.evaluateDirective(img, ext('img', 'https://cdn.example.com/a.png', PAGE), origin).allowed, false);
  check('协议源 https: 放行 https',
    CSP.evaluateDirective(font, ext('font', 'https://any.host/a.woff2', PAGE), origin).allowed, true);
  check('协议源 https: 阻止 http',
    CSP.evaluateDirective(font, ext('font', 'http://any.host/a.woff2', PAGE), origin).allowed, false);
  check('无端口来源拒绝非默认端口',
    CSP.evaluateDirective(conn, ext('connect', 'https://api.example.com:9000/x', PAGE), origin).allowed, false);
  check('无端口来源放行默认端口',
    CSP.evaluateDirective(conn, ext('connect', 'https://api.example.com/x', PAGE), origin).allowed, true);
  // 协议升级：策略写 http 可覆盖 https
  const p2 = policy('img-src http://cdn.example.com');
  check('http 来源可覆盖 https（升级）',
    CSP.evaluateDirective(p2.directives.get('img-src'), ext('img', 'https://cdn.example.com/a.png', PAGE), origin).allowed, true);
  // 无协议 host-source 跟随页面协议（页面是 https，http 资源不放行）
  const p3 = policy('img-src cdn.example.com');
  check('无协议来源跟随页面协议：http 资源被阻止',
    CSP.evaluateDirective(p3.directives.get('img-src'), ext('img', 'http://cdn.example.com/a.png', PAGE), origin).allowed, false);
  check('无协议来源跟随页面协议：https 资源放行',
    CSP.evaluateDirective(p3.directives.get('img-src'), ext('img', 'https://cdn.example.com/a.png', PAGE), origin).allowed, true);
}

/* ---------- 4. 路径匹配 ---------- */
{
  const p = policy('connect-src https://api.example.com/v1/; img-src https://cdn.example.com/exact');
  const conn = p.directives.get('connect-src');
  const img = p.directives.get('img-src');
  check('路径前缀匹配（以/结尾）',
    CSP.evaluateDirective(conn, ext('connect', 'https://api.example.com/v1/users', PAGE), origin).allowed, true);
  check('路径前缀不匹配其它分支',
    CSP.evaluateDirective(conn, ext('connect', 'https://api.example.com/v2/users', PAGE), origin).allowed, false);
  check('路径精确匹配',
    CSP.evaluateDirective(img, ext('img', 'https://cdn.example.com/exact', PAGE), origin).allowed, true);
  check('路径精确匹配拒绝子路径',
    CSP.evaluateDirective(img, ext('img', 'https://cdn.example.com/exact/more', PAGE), origin).allowed, false);
}

/* ---------- 5. default-src 回退 ---------- */
{
  const p = policy("default-src 'self'; script-src https://cdn.example.com");
  const page2 = 'https://shop.example.com/';
  const o2 = CSP.parsePageOrigin(page2);
  const r1 = CSP.evaluateResource([p], ext('img', 'https://shop.example.com/a.png', page2), o2);
  check('img 未指定 → 回退 default-src 放行', r1.allowed, true);
  check('回退标记为 true', r1.perPolicy[0].usedFallback, true);
  check('回退使用的指令名是 default-src', r1.perPolicy[0].directiveName, 'default-src');
  const r2 = CSP.evaluateResource([p], ext('script', 'https://shop.example.com/a.js', page2), o2);
  check('script-src 已指定时不回退（self 不在其中 → 阻止）', r2.allowed, false);
  check('未回退标记为 false', r2.perPolicy[0].usedFallback, false);
  const p3 = policy("script-src 'self'");
  const r3 = CSP.evaluateResource([p3], ext('img', 'https://any.host/a.png', page2), o2);
  check('既无对应指令也无 default-src → 不限制', r3.allowed, true);
}

/* ---------- 6. 'none' 与异常组合 ---------- */
{
  const p = policy("img-src 'none'");
  check("'none' 阻止一切",
    CSP.evaluateResource([p], ext('img', 'https://shop.example.com/a.png', PAGE), origin).allowed, false);
  const p2 = policy("img-src 'none' 'self'");
  check("'none' 与其他来源并存时被忽略，'self' 生效",
    CSP.evaluateResource([p2], ext('img', 'https://shop.example.com:8443/a.png', PAGE), origin).allowed, true);
  check("'none' 并存产生警告",
    p2.warnings.some(w => w.message.includes("'none'")), true);
  const p3 = policy('script-src');
  check('空来源指令等同 none',
    CSP.evaluateResource([p3], ext('script', 'https://shop.example.com:8443/a.js', PAGE), origin).allowed, false);
}

/* ---------- 7. 内联：nonce / 哈希 / unsafe-inline ---------- */
{
  const p = policy("script-src 'self' 'nonce-abc123' 'sha256-Hhh+AAA='; style-src 'unsafe-inline'");
  const s = p.directives.get('script-src');
  const st = p.directives.get('style-src');
  check('nonce 相符 → 放行',
    CSP.evaluateDirective(s, inlineRes('script', { nonce: 'abc123' }), origin).allowed, true);
  check('nonce 不符 → 阻止',
    CSP.evaluateDirective(s, inlineRes('script', { nonce: 'nope' }), origin).allowed, false);
  check('无标记内联 → 阻止',
    CSP.evaluateDirective(s, inlineRes('script', {}), origin).allowed, false);
  check('哈希相符 → 放行',
    CSP.evaluateDirective(s, inlineRes('script', { hash: 'sha256-Hhh+AAA=' }), origin).allowed, true);
  check('unsafe-inline 放行内联样式',
    CSP.evaluateDirective(st, inlineRes('style', {}), origin).allowed, true);
  // unsafe-inline 与 nonce 并存 → CSP3 忽略 unsafe-inline
  const p2 = policy("script-src 'unsafe-inline' 'nonce-x1'");
  check('nonce 并存时 unsafe-inline 被忽略（无标记 → 阻止）',
    CSP.evaluateDirective(p2.directives.get('script-src'), inlineRes('script', {}), origin).allowed, false);
  check('nonce 并存时 unsafe-inline 被忽略（标记相符 → 放行）',
    CSP.evaluateDirective(p2.directives.get('script-src'), inlineRes('script', { nonce: 'x1' }), origin).allowed, true);
}

/* ---------- 8. 多策略共同生效 ---------- */
{
  const p1 = policy("default-src 'self'; script-src 'self' https://cdn.example.com");
  const p2 = policy("script-src 'self'; img-src 'self' https://img.example.com");
  const page2 = 'https://shop.example.com/';
  const o2 = CSP.parsePageOrigin(page2);
  const r1 = CSP.evaluateResource([p1, p2], ext('script', 'https://cdn.example.com/a.js', page2), o2);
  check('策略1放行但策略2阻止 → 整体阻止', r1.allowed, false);
  check('能指出是策略2阻止', r1.perPolicy[1].allowed, false);
  check('策略1该项放行', r1.perPolicy[0].allowed, true);
  const r2 = CSP.evaluateResource([p1, p2], ext('script', 'https://shop.example.com/a.js', page2), o2);
  check('两条都放行 → 整体放行', r2.allowed, true);
  const r3 = CSP.evaluateResource([p1, p2], ext('img', 'https://img.example.com/a.png', page2), o2);
  check('img：策略1回退default-src阻止，策略2放行 → 阻止', r3.allowed, false);
}

/* ---------- 9. 解析告警 ---------- */
{
  const p = policy("default-src 'self'; script-src 'self'; script-src https://x.com; bad-dir 'self'; img-src 'self' 'self' bad_token!!; report-uri /r");
  check('重复指令告警', p.warnings.some(w => w.message.includes('重复')), true);
  check('未知指令告警', p.warnings.some(w => w.message.includes('未知指令 "bad-dir"')), true);
  check('重复来源提示', p.warnings.some(w => w.message.includes('重复出现')), true);
  check('无效来源告警', p.warnings.some(w => w.message.includes('bad_token!!')), true);
  check('已知但不评估的指令给提示', p.warnings.some(w => w.message.includes('report-uri')), true);
  check('重复指令时第一条生效',
    CSP.evaluateResource([p], ext('script', 'https://shop.example.com:8443/a.js', PAGE), origin).allowed, true);
  check('被忽略的第二条不放行',
    CSP.evaluateResource([p], ext('script', 'https://x.com/a.js', PAGE), origin).allowed, false);
  // 有问题的策略不影响其他策略的评估
  const good = policy("font-src 'self'");
  const r = CSP.evaluateResource([p, good], ext('font', 'https://shop.example.com:8443/a.woff2', PAGE), origin);
  check('问题策略 + 正常策略：正常策略结果仍在', r.perPolicy[1].allowed, true);
}

/* ---------- 10. 资源清单行解析 ---------- */
{
  const r1 = CSP.parseResourceLine('script https://a.com/x.js');
  check('解析外部资源行', r1.type === 'script' && !r1.inline, true);
  const r2 = CSP.parseResourceLine('script inline nonce=abc');
  check('解析内联 nonce 行', r2.inline && r2.nonce === 'abc', true);
  let threw = false;
  try { CSP.parseResourceLine('video https://a.com/x.mp4'); } catch (e) { threw = true; }
  check('未知类型报错', threw, true);
  threw = false;
  try { CSP.parseResourceLine('script https://a.com/x.js nonce=abc'); } catch (e) { threw = true; }
  check('外部资源带 nonce 报错', threw, true);
  threw = false;
  try { CSP.parseResourceLine('script inline hash=md5-abc'); } catch (e) { threw = true; }
  check('非法哈希算法报错', threw, true);
}

/* ---------- 汇总 ---------- */
console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
process.exit(failed === 0 ? 0 : 1);
