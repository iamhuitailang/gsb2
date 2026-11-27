import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEntities, encodeText, encodeAttribute } from '../src/sanitizer/entities.js';
import { sanitizeHtml } from '../src/sanitizer/sanitizer.js';

// ---- 实体编解码 -----------------------------------------------------------
test('十进制与十六进制数字实体解码', () => {
  assert.equal(decodeEntities('&#106;'), 'j');
  assert.equal(decodeEntities('&#x6a;'), 'j');
  assert.equal(decodeEntities('&#X6A;'), 'j');
  // 缺分号时按最长合法数字消费(HTML5 遗留规则),剩余字符保留
  assert.equal(decodeEntities('&#65;bc'), 'Abc');
  assert.equal(decodeEntities('&#x41;bc'), 'Abc');
});

test('命名实体解码(含大小写)', () => {
  assert.equal(decodeEntities('&amp;'), '&');
  assert.equal(decodeEntities('&AMP;'), '&');
  assert.equal(decodeEntities('&lt;'), '<');
  // 缺分号且不在遗留命名表中的形式不是实体,原样保留(安全:不会被误解码)
  assert.equal(decodeEntities('&ampx'), '&ampx');
  assert.equal(decodeEntities('&amp;x'), '&x');
});

test('非法码位与控制字符替换为 U+FFFD', () => {
  assert.equal(decodeEntities('&#0;'), '�');
  assert.equal(decodeEntities('&#55296;'), '�'); // 代理区
  assert.equal(decodeEntities('&#1114112;'), '�'); // 超最大码位
});

test('非实体 & 原样保留', () => {
  assert.equal(decodeEntities('a & b'), 'a & b');
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});

test('编码后不可注入标记', () => {
  assert.equal(encodeText('<b>'), '&lt;b&gt;');
  assert.equal(encodeAttribute('"x"'), '&quot;x&quot;');
  assert.equal(encodeText('a & b'), 'a &amp; b');
});

// ---- 端到端绕过:编码/空白/控制字符/NUL -----------------------------------
test('NUL 字节不截断解析、不造成绕过', () => {
  const { html } = sanitizeHtml('<img src="x" on\x00error="alert(1)">');
  assert.ok(!/\son[a-z]*\x00?error/i.test(html));
  assert.ok(!/alert/.test(html));
});

test('制表/换行拆分的脚本协议仍被拦', () => {
  const payloads = [
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\rscript:alert(1)',
    'java\fscript:alert(1)',
    'java script:alert(1)'
  ];
  for (const p of payloads) {
    const { html } = sanitizeHtml(`<a href="${p}">x</a>`);
    assert.ok(!html.includes('href='), `未拦截: ${JSON.stringify(p)}`);
  }
});

test('双层 &amp;# 编码无法在第二轮复活脚本', () => {
  // &amp;#106; 单遍解码得到 &#106;(文本),不会继续变成 j
  const { html } = sanitizeHtml('<a href="&amp;#106;avascript:alert(1)">x</a>');
  // 浏览器也只解码一遍,因此该值不是有效 javascript: URL,相对地址被拒
  assert.ok(!html.includes('href='));
  // 再次清理保持安全且幂等
  const second = sanitizeHtml(html).html;
  assert.equal(second, html);
});

test('畸形标签序列不泄漏事件处理器', () => {
  const cases = [
    '<img src=x onerror=alert(1)',
    '<img """><script>alert(1)</script>',
    '<x onclick=alert(1)>a</x>',
    '<a href="javascript:alert(1)"',
    '<<script>>alert(1)<</script>>'
  ];
  for (const input of cases) {
    const { html } = sanitizeHtml(input);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `事件泄漏: ${input} -> ${html}`);
    assert.ok(!/<script/i.test(html), `脚本泄漏: ${input} -> ${html}`);
  }
});

test('深度嵌套危险元素全部清除且安全文本保留', () => {
  const input = '<div><section><p>a' +
    '<script>alert(1)</script>' +
    '<span>b<iframe src="x"></iframe>c</span>' +
    '</p></section></div>';
  const { html } = sanitizeHtml(input);
  assert.ok(!/script|iframe|alert/i.test(html));
  assert.match(html, /a/);
  assert.match(html, /b/);
  assert.match(html, /c/);
});

test('大量空白与异常属性排列稳定处理', () => {
  const input = '<div\n\t class = "x"\n\r  id = "y" >z</div>';
  const { html } = sanitizeHtml(input);
  assert.match(html, /class="x"/);
  assert.match(html, /id="y"/);
  assert.match(html, />z</);
});

test('自闭合与非闭合混合不导致后续内容被吞', () => {
  const { html } = sanitizeHtml('<p>one<p>two<br><p>three');
  assert.match(html, /one/);
  assert.match(html, /two/);
  assert.match(html, /three/);
  assert.match(html, /<br>/);
});

test('幂等性:含实体与编码 URL 的复杂输入多次清理稳定', () => {
  const input = '<p title="a&amp;b&quot;c">x</p>' +
    '<a href="#sec" rel="x">y</a>' +
    '<img alt="t" src="data:image/png;base64,AA==">';
  const once = sanitizeHtml(input).html;
  const twice = sanitizeHtml(once).html;
  const thrice = sanitizeHtml(twice).html;
  assert.equal(twice, once);
  assert.equal(thrice, once);
});

test('rel 固化逻辑不会重复叠加', () => {
  const once = sanitizeHtml('<a href="#x">y</a>').html;
  const twice = sanitizeHtml(once).html;
  const relCount = (twice.match(/rel=/g) || []).length;
  assert.equal(relCount, 1);
  assert.equal(twice, once);
});
