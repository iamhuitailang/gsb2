import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreviewDocument, PREVIEW_CSP } from '../src/sanitizer/preview.js';
import { sanitizeHtml } from '../src/sanitizer/sanitizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, '..', 'public');

test('预览文档包含严格 CSP,default-src 为 none', () => {
  const doc = buildPreviewDocument('<p>x</p>');
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /form-action 'none'/);
  assert.match(doc, /base-uri 'none'/);
  assert.match(doc, /frame-ancestors 'none'/);
  // 不允许任何脚本来源
  assert.ok(!/script-src [^;]*'unsafe-inline'/.test(doc));
  assert.ok(!/script-src [^;]*\*/.test(doc));
});

test('CSP 常量本身锁定关键指令', () => {
  assert.match(PREVIEW_CSP, /default-src 'none'/);
  assert.match(PREVIEW_CSP, /sandbox/);
});

test('预览文档不放大权限:不含 allow-scripts/allow-same-origin 等令牌字样', () => {
  const doc = buildPreviewDocument('<p>x</p>');
  assert.ok(!/allow-scripts|allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(doc));
});

test('宿主页面 iframe 使用空 sandbox 令牌', async () => {
  const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
  const frameMatch = /<iframe[^>]*id="preview-frame"[^>]*>/.exec(html);
  assert.ok(frameMatch, '页面中应存在预览 iframe');
  assert.match(frameMatch[0], /sandbox=""/);
  assert.ok(!/allow-scripts|allow-same-origin|allow-forms|allow-popups|allow-top-navigation/.test(frameMatch[0]));
});

test('原始输入视图只通过 textContent 渲染,无 innerHTML 写入', async () => {
  const appJs = await readFile(join(dirname(__dirname), 'src', 'ui', 'app.js'), 'utf8');
  assert.match(appJs, /rawInputView\.textContent\s*=/);
  // 应用代码不得把输入直接赋给 innerHTML/outerHTML/document.write
  assert.ok(!/\.innerHTML\s*=/.test(appJs), '不得使用 innerHTML 赋值');
  assert.ok(!/document\.write/.test(appJs), '不得使用 document.write');
  assert.ok(!/insertAdjacentHTML/.test(appJs), '不得使用 insertAdjacentHTML');
});

test('srcdoc 由属性赋值构建且内容来自清理结果', async () => {
  const appJs = await readFile(join(dirname(__dirname), 'src', 'ui', 'app.js'), 'utf8');
  assert.match(appJs, /frame\.srcdoc\s*=\s*buildPreviewDocument\(/);
});

test('端到端:危险输入经清理后进入预览文档仍无脚本/外联/表单', () => {
  const input = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(2)">',
    '<a href="javascript:alert(3)" target="_blank">x</a>',
    '<form action="https://evil.example"><input name="q"></form>',
    '<iframe src="https://evil.example"></iframe>',
    '<p style="background:url(https://tracker.test/x.gif)">y</p>'
  ].join('');
  const { html, report } = sanitizeHtml(input);
  const doc = buildPreviewDocument(html);

  assert.ok(!/<script/i.test(doc));
  assert.ok(!/onerror|onload|onclick/i.test(doc));
  assert.ok(!/javascript:/i.test(doc));
  assert.ok(!/<form|<input|<iframe/i.test(doc));
  assert.ok(!/evil\.example|tracker\.test/.test(doc));
  assert.ok(!/url\(/i.test(doc));
  assert.ok(report.removedElements.length > 0);
  assert.ok(report.removedAttributes.length > 0);
});

test('清理结果在预览文档中保留安全排版', () => {
  const { html } = sanitizeHtml('<h1>t</h1><p>hello <strong>world</strong></p>');
  const doc = buildPreviewDocument(html);
  assert.match(doc, /<h1>t<\/h1>/);
  assert.match(doc, /<strong>world<\/strong>/);
});

test('应用外壳自带 CSP 且不允许内联脚本', async () => {
  const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'self'/);
  assert.ok(!/script-src 'unsafe-inline'/.test(html));
});
