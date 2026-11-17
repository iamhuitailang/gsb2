import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReport, normalizeAssetKey } from '../src/sanitize.js';

const reportId = 'rpt_0123456789abcdef';
const token = 'a'.repeat(64);

function run(html, assets = {}) {
  return sanitizeReport({ html, reportId, token, assets: new Map(Object.entries(assets)) });
}

test('normalizeAssetKey 归一化相对路径', () => {
  assert.equal(normalizeAssetKey('./images/chart.png'), 'images/chart.png');
  assert.equal(normalizeAssetKey('/images//chart.png?v=1'), 'images/chart.png');
  assert.equal(normalizeAssetKey('images/../images/chart.png'), 'images/chart.png');
  assert.equal(normalizeAssetKey('..%2Fetc%2Fpasswd'), 'etc/passwd');
});

test('本地图片改写为报告站点资源地址并记为已载入', () => {
  const { body, check } = run(
    '<p>x</p><img src="images/chart.png" alt="a">',
    { 'images/chart.png': { storedName: 'asset-1.png', contentType: 'image/png' } },
  );
  assert.match(body, /src="\/a\/rpt_0123456789abcdef\/a{64}\/asset-1\.png"/);
  assert.deepEqual(check.resources, [{ kind: 'image', status: 'local', url: 'images/chart.png' }]);
  assert.equal(check.summary.loaded, 1);
});

test('外部图片换成占位说明，并记为未载入', () => {
  const { body, check } = run('<img src="http://tracker.localhost:1/pixel.png">');
  assert.doesNotMatch(body, /tracker\.localhost/);
  assert.match(body, /class="gsb2-blocked"/);
  assert.equal(check.summary.external, 1);
  assert.equal(check.resources[0].status, 'external');
});

test('缺失的本地图片标为缺失', () => {
  const { body, check } = run('<img src="images/none.png">');
  assert.match(body, /本地图片缺失/);
  assert.equal(check.summary.missing, 1);
});

test('协议相对地址与非光栅 data: 不放行', () => {
  const { body, check } = run(
    '<img src="//tracker.localhost/x.png"><img src="data:text/html,<script>alert(1)<\/script>"><img src="data:image/svg+xml,<svg onload=alert(1)>">',
  );
  assert.doesNotMatch(body, /tracker\.localhost/);
  assert.doesNotMatch(body, /data:text\/html/i);
  assert.doesNotMatch(body, /svg\+xml/i);
  assert.equal(check.resources.filter((r) => r.status === 'external').length, 1);
  assert.equal(check.resources.filter((r) => r.status === 'blocked').length, 2);
  assert.equal(check.summary.blocked, 2);
});

test('脚本整段丢弃，内容不会漏出', () => {
  const { body, check } = run(
    '<p>before</p><script>window.__x=1;document.title="RAN"<\/script><p>after</p>',
  );
  assert.doesNotMatch(body, /__x/);
  assert.match(body, /<p>before<\/p><p>after<\/p>/);
  assert.equal(check.removed.scripts, 1);
});

test('未闭合的 script 会吞到文档结尾', () => {
  const { body } = run('<p>ok</p><script src="http://evil.test/x.js">window.__x=1');
  assert.doesNotMatch(body, /__x/);
  assert.doesNotMatch(body, /evil\.test/);
});

test('内联事件处理器与 javascript: 地址被移除', () => {
  const { body, check } = run(
    '<button onclick="alert(1)">b</button><a href="javascript:alert(1)">a</a>',
  );
  assert.doesNotMatch(body, /onclick/);
  assert.doesNotMatch(body, /javascript:/);
  assert.equal(check.removed.inlineHandlers, 1);
  assert.equal(check.removed.jsUrls, 1);
});

test('表单与自动跳转被移除并记录', () => {
  const { body, check } = run(
    '<form action="http://business.localhost:1/api/x"><input name="a"></form>'
    + '<meta http-equiv="refresh" content="0;url=http://tracker.localhost/">',
  );
  assert.doesNotMatch(body, /<form/);
  assert.doesNotMatch(body, /http-equiv/);
  assert.equal(check.removed.forms, 1);
  assert.equal(check.removed.metaRefreshes, 1);
});

test('style 内的外部 url 与 @import 被拦截', () => {
  const { body, check } = run(
    '<style>@import "http://tracker.localhost/a.css"; .a{background:url(http://tracker.localhost/p.png)}</style>',
  );
  assert.doesNotMatch(body, /tracker\.localhost/);
  assert.equal(check.resources.filter((r) => r.status === 'external').length, 2);
});

test('本地样式表内联进样式区', () => {
  const { body } = run('<link rel="stylesheet" href="styles/a.css">', {
    'styles/a.css': { storedName: 'asset-2.css', contentType: 'text/css', content: '.lead{color:#333}' },
  });
  assert.match(body, /<style>\.lead\{color:#333\}<\/style>/);
});

test('iframe / object 被替换成占位说明', () => {
  const { body, check } = run('<iframe src="http://business.localhost:1/"></iframe>');
  assert.doesNotMatch(body, /<iframe/);
  assert.match(body, /外部框架未载入/);
  assert.equal(check.removed.frames, 1);
});

test('srcset 里的外部候选被丢弃，只保留本地候选', () => {
  const { body } = run(
    '<img srcset="images/a.png 1x, http://tracker.localhost/b.png 2x" src="images/a.png">',
    { 'images/a.png': { storedName: 'asset-1.png', contentType: 'image/png' } },
  );
  assert.doesNotMatch(body, /tracker\.localhost/);
  assert.match(body, /srcset="\/a\/rpt_0123456789abcdef\/a{64}\/asset-1\.png 1x"/);
});

test('文本里残缺的尖括号被转义', () => {
  const { body } = run('<p>对比 &lt;script 与 <scr');
  assert.match(body, /&lt;scr/);
});

test('外部链接被去掉 href 并记录', () => {
  const { body, check } = run('<a href="http://tracker.localhost/click">点</a>');
  assert.doesNotMatch(body, /href="http/);
  assert.equal(check.resources[0].status, 'external');
});

test('实体编码与控制字符伪装的 javascript: 也会被识别', () => {
  const { body, check } = run(
    '<a href="java&#115;cript:alert(1)">a</a><a href="jav&#x09;ascript:alert(1)">b</a>',
  );
  assert.doesNotMatch(body, /javascript:/i);
  assert.equal(check.removed.jsUrls, 2);
});

test('超范围字符实体不会让净化抛异常', () => {
  const { body } = run('<a href="&#x110000;http://x/&#99999999999;">a</a><img src="&#x110000;.png">');
  assert.ok(typeof body === 'string');
});

test('data: 的媒体类型被实体编码时不会当成图片放行', () => {
  const { body, check } = run(
    '<img src="data&#58;image/svg+xml,<svg onload=alert(1)>"><img src="data&#58;image/png;base64,AAAA">',
  );
  assert.doesNotMatch(body, /svg\+xml/i);
  assert.equal(check.summary.blocked, 2);
  assert.equal(check.summary.loaded, 0);

  // 干净写法的光栅 data: 图片仍可内嵌。
  const ok = run('<img src="data:image/png;base64,AAAA">');
  assert.equal(ok.check.summary.loaded, 1);
  assert.match(ok.body, /src="data:image\/png;base64,AAAA"/);
});

test('表格结构原样保留', () => {
  const { body } = run('<table><thead><tr><th>批次号</th></tr></thead><tbody><tr><td>B-1</td></tr></tbody></table>');
  assert.match(body, /<table><thead><tr><th>批次号<\/th><\/tr><\/thead><tbody><tr><td>B-1<\/td><\/tr><\/tbody><\/table>/);
});
