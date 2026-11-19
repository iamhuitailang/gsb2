'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseInput, buildFailureEntry, isFailureEntry } = require('../src/core/importer.js');

test('正常 jsonl：逐行解析，保留原始结构与数据类型', () => {
  const text = [
    '{"a":1,"b":"x","c":null,"d":[1,2],"e":true}',
    '',
    '{"a":2}',
  ].join('\n');
  const r = parseInput(text);
  assert.equal(r.records.length, 2);
  assert.equal(r.failures.length, 0);
  assert.equal(r.blankLines, 1);
  assert.equal(r.totalLines, 3);
  assert.deepEqual(r.records[0].value, { a: 1, b: 'x', c: null, d: [1, 2], e: true });
  assert.equal(r.records[0].line, 1);
  assert.equal(r.records[1].line, 3);
  // 数据类型不被转换
  assert.equal(typeof r.records[0].value.a, 'number');
  assert.equal(r.records[0].value.c, null);
  assert.ok(Array.isArray(r.records[0].value.d));
});

test('格式异常行：进入 failures 且带行号与可理解原因，不影响其他行', () => {
  const text = ['{"ok":1}', '{broken json', '{"ok":2}'].join('\n');
  const r = parseInput(text);
  assert.equal(r.records.length, 2);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].line, 2);
  assert.match(r.failures[0].reason, /JSON 解析失败/);
  assert.ok(r.failures[0].raw.includes('broken'));
  // 错误原因不回显整行原文
  assert.ok(!r.failures[0].reason.includes('{broken json'));
});

test('CRLF 与首尾空行正确处理', () => {
  const r = parseInput('\r\n{"a":1}\r\n\r\n{"b":2}\r\n');
  assert.equal(r.records.length, 2);
  assert.equal(r.blankLines, 3);
});

test('失败包装对象可重新导入并还原为失败项', () => {
  const entry = buildFailureEntry({ line: 7, reason: 'JSON 解析失败：测试', rawLength: 12 });
  assert.ok(isFailureEntry(entry));
  assert.equal(entry.rawLength, 12);
  const r = parseInput(JSON.stringify(entry) + '\n{"ok":1}\n');
  assert.equal(r.records.length, 1);
  assert.equal(r.failures.length, 1);
  assert.equal(r.failures[0].line, 7);
  assert.equal(r.failures[0].reimported, true);
  assert.equal(r.failures[0].raw, null);
});

test('普通对象不会被误判为失败包装', () => {
  assert.equal(isFailureEntry({ __sanlog_unprocessable__: true }), false);
  assert.equal(isFailureEntry({ line: 1, reason: 'x' }), false);
  assert.equal(isFailureEntry(null), false);
  assert.equal(isFailureEntry([1, 2]), false);
});

test('失败原因绝不回显原始行内容（V8 错误可能携带原文片段）', () => {
  const r = parseInput('not json text\n{also bad content}\n{"ok":1}\n');
  assert.equal(r.failures.length, 2);
  for (const f of r.failures) {
    assert.ok(!f.reason.includes('not json'), `原因泄漏原文: ${f.reason}`);
    assert.ok(!f.reason.includes('also bad'), `原因泄漏原文: ${f.reason}`);
    assert.match(f.reason, /JSON 解析失败：/);
  }
  // 导出的失败包装同样不含原文
  const { buildFailureEntry } = require('../src/core/importer.js');
  for (const f of r.failures) {
    const entry = buildFailureEntry(f);
    assert.equal(entry.raw, undefined);
    assert.ok(!JSON.stringify(entry).includes('bad'));
  }
});

test('合法的标量 JSON 行（裸字符串/数字）也被保留为记录', () => {
  const r = parseInput('"a string"\n12345\ntrue\nnull\n');
  assert.equal(r.records.length, 4);
  assert.equal(r.records[0].value, 'a string');
  assert.equal(r.records[1].value, 12345);
  assert.equal(r.records[2].value, true);
  assert.equal(r.records[3].value, null);
});
