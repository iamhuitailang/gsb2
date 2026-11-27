import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeHtml, ALLOWED_TAGS } from '../src/sanitizer/sanitizer.js';

// 危险载荷在清理结果中完全消失的辅助断言
function assertFullyStripped(input, payloadSnippets = []) {
  const { html } = sanitizeHtml(input);
  for (const snippet of payloadSnippets) {
    assert.ok(!html.includes(snippet), `输出中不应包含 ${JSON.stringify(snippet)}: ${html}`);
  }
}

test('安全排版内容保留', () => {
  const input = '<h2>标题</h2><p>文本 <strong>加粗</strong> <em>斜体</em></p>' +
    '<ul><li>项</li></ul><table><tr><td>格</td></tr></table>';
  const { html } = sanitizeHtml(input);
  assert.match(html, /<h2>标题<\/h2>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<table>/);
  assert.match(html, /<td>格<\/td>/);
});

test('script 标签整子树移除,内部文本不外泄', () => {
  const { html, report } = sanitizeHtml(
    '<p>前</p><script>alert(1)</script><p>后</p>'
  );
  assert.ok(!html.includes('script'));
  assert.ok(!html.includes('alert'));
  assert.ok(report.removedElements.some(
    (e) => e.tag === 'script' && e.reason === 'dangerous-subtree'
  ));
  assert.match(html, /<p>前<\/p>/);
  assert.match(html, /<p>后<\/p>/);
});

test('大小写混淆的 SCRIPT 同样移除', () => {
  assertFullyStripped('<ScRiPt>alert(1)</ScRiPt>', ['script', 'ScRiPt', 'alert']);
  assertFullyStripped('<IFRAME src="x"></IFRAME>', ['iframe', 'IFRAME']);
});

test('所有事件处理属性移除(含冷门事件与大小写)', () => {
  const cases = [
    '<img src="data:image/png;base64,AA==" onerror="alert(1)">',
    '<div onclick="x()">y</div>',
    '<DIV ONCLICK="x()">y</DIV>',
    '<body onload="x()">',
    '<p onmouseover="x()" onfocus="x()" onmozpointerlockchange="x()">y</p>',
    '<details ontoggle="x()"></details>'
  ];
  for (const input of cases) {
    const { html, report } = sanitizeHtml(input);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `事件属性残留: ${html}`);
    assert.ok(report.removedAttributes.some((a) => a.reason === 'event-handler'),
      `应报告事件属性: ${input}`);
  }
  // svg 属于整树移除类,事件属性随子树一起消失
  const svg = sanitizeHtml('<svg onload="x()"></svg>');
  assert.ok(!/svg|onload/i.test(svg.html));
  assert.ok(svg.report.removedElements.some((e) => e.tag === 'svg'));
});

test('javascript: 链接的 href 被移除但标签保留', () => {
  const { html, report } = sanitizeHtml(
    '<a href="javascript:alert(1)" title="t">x</a>'
  );
  assert.ok(!html.includes('javascript'));
  assert.ok(!html.includes('href='));
  assert.match(html, /<a[^>]*title="t"/);
  assert.match(html, />x<\/a>/);
  assert.ok(report.urlDecisions.some((u) => u.reason === 'script-scheme'));
});

test('实体编码的 javascript: 仍被识别', () => {
  const cases = [
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<a href="&#x6a;avascript:alert(1)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<a href="jav&#x0A;ascript:alert(1)">x</a>'
  ];
  for (const input of cases) {
    const { html } = sanitizeHtml(input);
    assert.ok(!html.includes('href='), `实体绕过失败: ${input} -> ${html}`);
  }
});

test('外站 URL 被拒,输出不含任何外部主机名', () => {
  const input = '<a href="https://evil.example/x">y</a>' +
    '<img src="http://tracker.test/1.gif" alt="">' +
    '<img src="//cdn.test/x.png" alt="">';
  const { html } = sanitizeHtml(input);
  assert.ok(!html.includes('evil.example'));
  assert.ok(!html.includes('tracker.test'));
  assert.ok(!html.includes('cdn.test'));
  assert.ok(!html.includes('src=')); // 两张图的 src 都被移除
});

test('安全的图片 data URI 保留,SVG data URI 拒绝', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const ok = sanitizeHtml(`<img src="${png}" alt="ok">`);
  assert.match(ok.html, /<img[^>]*src="data:image\/png;base64,/);

  const bad = sanitizeHtml(
    '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="svg">'
  );
  assert.ok(!bad.html.includes('data:'));
  assert.ok(!bad.html.includes('src='));
});

test('危险嵌入标签整子树移除', () => {
  const cases = [
    '<object data="x"><param name="a"></object>',
    '<embed src="x">',
    '<iframe src="x"><p>inner</p></iframe>',
    '<svg><script>alert(1)</script></svg>',
    '<math><mi>x</mi></math>',
    '<canvas></canvas>',
    '<template><p>x</p></template>',
    '<noscript><img src=x onerror=alert(1)></noscript>',
    '<applet code="x.class"></applet>',
    '<portal src="x"></portal>'
  ];
  for (const input of cases) {
    const { html, report } = sanitizeHtml(input);
    assert.ok(report.removedElements.some((e) => e.reason === 'dangerous-subtree'),
      `应整树移除: ${input}`);
    assert.ok(!/object|embed|iframe|svg|math|canvas|template|noscript|applet|portal/i.test(html),
      `危险标签残留: ${input} -> ${html}`);
  }
});

test('未知标签脱壳保留安全子节点', () => {
  const { html } = sanitizeHtml('<custom-element><p>safe</p></custom-element>');
  assert.ok(!html.includes('custom-element'));
  assert.match(html, /<p>safe<\/p>/);
});

test('表单相关标签不进入输出', () => {
  const input = '<form action="https://x"><input name="a"><button>go</button></form><p>ok</p>';
  const { html } = sanitizeHtml(input);
  assert.ok(!/form|input|button|action/i.test(html));
  assert.match(html, /<p>ok<\/p>/);
});

test('target 与 ping 属性移除', () => {
  const { html } = sanitizeHtml('<a href="#x" target="_blank" ping="https://x/p">y</a>');
  assert.ok(!html.includes('target'));
  assert.ok(!html.includes('ping'));
  assert.match(html, /rel="noopener noreferrer"/);
});

test('link/meta/base/style 等头部元素被移除', () => {
  const input = '<link rel="stylesheet" href="https://x/x.css">' +
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' +
    '<base href="https://x/">' +
    '<style>body{color:red}</style>';
  const { html } = sanitizeHtml(input);
  assert.ok(!/link|meta|base|style/i.test(html));
});

test('内联样式白名单生效,危险声明剥离', () => {
  const { html, report } = sanitizeHtml(
    '<p style="color: red; background: url(x.png); width: expression(alert(1)); z-index: 2">x</p>'
  );
  assert.match(html, /color: red/);
  assert.match(html, /z-index: 2/);
  assert.ok(!html.includes('url('));
  assert.ok(!html.includes('expression'));
  assert.ok(report.removedStyleDeclarations.some((r) => r.reason === 'css-url-reference'));
  assert.ok(report.removedStyleDeclarations.some((r) => r.reason === 'css-expression'));
});

test('CSS 自定义属性与 @import 拒绝', () => {
  const { html } = sanitizeHtml(
    '<p style="--x: 1; @import \'x.css\'; color: red">x</p>'
  );
  assert.ok(!html.includes('--x'));
  assert.ok(!html.includes('@import'));
  assert.match(html, /color: red/);
});

test('文本中的标记被编码,不会形成新标签', () => {
  const { html } = sanitizeHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('属性值中的引号被编码,无法逃逸属性', () => {
  const { html } = sanitizeHtml('<p title="a&quot; onclick=&quot;alert(1)">x</p>');
  assert.match(html, /title="/);
  assert.match(html, /&quot;/);

  // 按引号状态机解析输出标签上的真实属性,引号内部的内容不计为属性
  function realAttributeNames(serializedTag) {
    const inner = serializedTag.slice(serializedTag.indexOf(' ') + 1, -1);
    const names = [];
    let inQuote = false;
    let i = 0;
    while (i < inner.length) {
      const ch = inner[i];
      if (ch === '"') { inQuote = !inQuote; i++; continue; }
      if (!inQuote) {
        // 属性起始:字符串开头,或紧跟在空白之后
        const atBoundary = i === 0 || /\s/.test(inner[i - 1]);
        if (atBoundary) {
          const m = /^([a-z-]+)\s*=/.exec(inner.slice(i));
          if (m) { names.push(m[1].toLowerCase()); i += m[0].length; continue; }
        }
      }
      i++;
    }
    return names;
  }
  const tag = /^<[a-z]+[^>]*>/.exec(html)[0];
  assert.deepEqual(realAttributeNames(tag), ['title']);

  // title 的值完整闭合在一对引号中,原文作为数据保留
  const titleAttr = /title="([^"]*)"/.exec(html);
  assert.ok(titleAttr);
  assert.match(titleAttr[1], /onclick/);
});

test('嵌套危险结构全部清理', () => {
  const input = '<div>safe <script>alert(1)</script> ' +
    '<iframe><script>alert(2)</script></iframe> <p>end</p></div>';
  const { html } = sanitizeHtml(input);
  assert.ok(!/script|iframe|alert/i.test(html));
  assert.match(html, /safe/);
  assert.match(html, /<p>end<\/p>/);
});

test('畸形/交叉嵌套不导致危险内容泄漏', () => {
  const cases = [
    '<div><span>x</div></span>',
    '<b>bold <p>para',
    '<a href="javascript:alert(1)">未闭合 <img src=x onerror=alert(2)>',
    '<div/>fake self closing</div>',
    '<<script>alert(1)//<</script>'
  ];
  for (const input of cases) {
    const { html } = sanitizeHtml(input);
    assert.ok(!/onerror|onclick|javascript|<script/i.test(html),
      `畸形输入泄漏: ${input} -> ${html}`);
  }
});

test('注释与 DOCTYPE 不进入输出', () => {
  const { html } = sanitizeHtml('<!-- c --><!DOCTYPE html><p>x</p><?xml version="1.0"?>');
  assert.ok(!html.includes('<!--'));
  assert.ok(!html.includes('DOCTYPE'));
  assert.ok(!html.includes('xml'));
  assert.match(html, /<p>x<\/p>/);
});

test('完整文档输入:外壳脱壳,头部危险物丢弃,正文保留', () => {
  const input = '<!DOCTYPE html><html><head><script>alert(1)</script>' +
    '<base href="https://x/"></head><body onload="alert(2)"><h1>t</h1></body></html>';
  const { html } = sanitizeHtml(input);
  assert.ok(!/script|base|onload|html|head|body/i.test(html));
  assert.match(html, /<h1>t<\/h1>/);
});

test('幂等性:清理结果再次清理保持不变', () => {
  const inputs = [
    '<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:f()">b</a>',
    '<div style="color:red; background:url(x)">t</div>',
    '<p title="a&quot;b">x</p>'
  ];
  for (const input of inputs) {
    const first = sanitizeHtml(input).html;
    const second = sanitizeHtml(first).html;
    assert.equal(second, first, `二次清理结果不一致:\n${first}\n${second}`);
  }
});

test('所有白名单标签确实可通过(抽查)', () => {
  for (const tag of ['p', 'div', 'span', 'a', 'img', 'table', 'details', 'ruby']) {
    assert.ok(ALLOWED_TAGS.has(tag));
  }
});

test('空输入与非字符串输入不抛异常', () => {
  assert.equal(sanitizeHtml('').html, '');
  assert.equal(sanitizeHtml(null).html, '');
  assert.equal(sanitizeHtml(undefined).html, '');
});

test('报告不含可执行原始标记,只含类别信息', () => {
  const { report } = sanitizeHtml(
    '<script>alert("secret-token")</script><img src=x onerror="alert(1)">'
  );
  const json = JSON.stringify(report);
  assert.ok(!json.includes('secret-token'));
  assert.ok(!json.includes('alert(1)'));
});

test('URL 报告中的地址被截断,不回显超长载荷', () => {
  const long = 'javascript:' + 'A'.repeat(300);
  const { report } = sanitizeHtml(`<a href="${long}">x</a>`);
  const decision = report.urlDecisions[0];
  assert.ok(decision.sample.length <= 120);
});

test('清理结果中不出现任何 on* 事件属性(模糊测试式枚举)', () => {
  const events = ['onload', 'onerror', 'onclick', 'onmouseenter', 'onanimationend',
    'onbeforeprint', 'onpageshow', 'onhashchange', 'onmessage', 'onstorage'];
  for (const ev of events) {
    const { html } = sanitizeHtml(`<p ${ev}="alert(1)">x</p>`);
    assert.ok(!html.toLowerCase().includes(ev));
  }
});
