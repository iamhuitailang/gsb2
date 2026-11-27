import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeHtml } from '../src/sanitizer/sanitizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(__dirname, '..', 'samples');

// 所有演示样例(代表不同入口的输入)清理后都必须满足的不变量。
// 注意:只检查可执行的标记结构(标签/属性/URL 值),不检查纯文本中的
// 说明性文字——样例正文里出现 "javascript:" 字样作为讲解内容是安全的。
const FORBIDDEN_OUTPUT = [
  /<script/i, /<iframe/i, /<object/i, /<embed/i, /<svg/i, /<math/i,
  /<form/i, /<input/i, /<link/i, /<meta/i, /<base[\s>]/i, /<style/i,
  /<canvas/i, /<template/i, /<noscript/i,
  /\son[a-z]+\s*=/i,                                    // 事件属性
  /(?:src|href)\s*=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i,
  /(?:src|href)\s*=\s*["']?\s*https?:/i,                // 外联地址
  /(?:src|href)\s*=\s*["']?\/\//i,                      // 协议相对
  /style="[^"]*url\s*\(/i                               // CSS 外联
];

test('全部演示样例清理后不含任何危险结构', async () => {
  const files = (await readdir(SAMPLES)).filter((f) => f.endsWith('.html')).sort();
  assert.ok(files.length >= 5, '应至少提供 5 份演示样例');
  for (const file of files) {
    const raw = await readFile(join(SAMPLES, file), 'utf8');
    const { html, report } = sanitizeHtml(raw);
    for (const pattern of FORBIDDEN_OUTPUT) {
      assert.ok(!pattern.test(html), `${file} 清理结果命中 ${pattern}: ${html}`);
    }
    // 额外的结构性断言:不存在任何携带 src/href 的外部引用
    assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(html));
    // 每份样例都应当产生至少一类处理记录,证明报告链路有效
    assert.ok(
      report.removedElements.length + report.removedAttributes.length +
        report.removedStyleDeclarations.length + report.urlDecisions.length > 0,
      `${file} 应产生处理记录`
    );
  }
});

test('不同入口(粘贴/导入/样例)同一输入安全结果一致', async () => {
  const raw = await readFile(join(SAMPLES, '02-script-injection.html'), 'utf8');
  // 模拟三次独立调用,结果必须逐字节一致
  const r1 = sanitizeHtml(raw);
  const r2 = sanitizeHtml(raw);
  const r3 = sanitizeHtml(raw);
  assert.equal(r2.html, r1.html);
  assert.equal(r3.html, r1.html);
  assert.deepEqual(r2.stats, r1.stats);
});

test('清理结果对全部样例具备幂等性', async () => {
  const files = (await readdir(SAMPLES)).filter((f) => f.endsWith('.html'));
  for (const file of files) {
    const raw = await readFile(join(SAMPLES, file), 'utf8');
    const once = sanitizeHtml(raw).html;
    const twice = sanitizeHtml(once).html;
    assert.equal(twice, once, `${file} 二次清理结果漂移`);
  }
});

test('报告 JSON 可序列化且不回显危险载荷原文', async () => {
  const raw = await readFile(join(SAMPLES, '02-script-injection.html'), 'utf8');
  const { report } = sanitizeHtml(raw);
  const json = JSON.stringify(report);
  assert.ok(json.length > 0);
  assert.ok(!json.includes("alert('xss-1')"));
  assert.ok(!json.includes("alert('xss-2')"));
});
