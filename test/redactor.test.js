'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scan } = require('../src/core/scanner.js');
const { applyRedactions } = require('../src/core/redactor.js');
const rules = require('../src/core/rules.js');

const ENABLED = new Set(rules.DEFAULT_ENABLED_IDS);

function redact(records, ids = ENABLED, decisions = {}) {
  const wrapped = records.map((value, i) => ({ line: i + 1, value }));
  const { findings } = scan(wrapped, ids);
  return { findings, result: applyRedactions(wrapped, findings, decisions) };
}

test('整值脱敏：数据类型变为字符串标记，无关字段与类型原样保留', () => {
  const data = { phone: '13812345678', count: 3, ok: true, meta: null, tags: [1, 2], order_id: 'ORD-1' };
  const { result } = redact([data]);
  const out = result.output[0].value;
  assert.match(out.phone, /^\[REDACTED:PHONE:\d+\]$/);
  assert.equal(out.count, 3);
  assert.equal(out.ok, true);
  assert.equal(out.meta, null);
  assert.deepEqual(out.tags, [1, 2]);
  assert.equal(out.order_id, 'ORD-1');
});

test('重复敏感值使用一致替代值；不同值（含仅末位不同）序号不同', () => {
  const data = [
    { a: '13812345678' },
    { b: '13812345678' },
    { c: '13812345679' },
    { msg: 'same 13812345678 again' },
  ];
  const { result } = redact(data);
  const m1 = result.output[0].value.a;
  const m2 = result.output[1].value.b;
  const m3 = result.output[2].value.c;
  assert.equal(m1, m2);
  assert.notEqual(m1, m3);
  assert.ok(result.output[3].value.msg.includes(m1));
  assert.equal(result.distinctValues, 2);
});

test('同一文本多片段命中：从后向前替换，其余文本保留，标记各自正确', () => {
  const s = '电话 13812345678 邮箱 x@y.com 再 13911112222';
  const { result } = redact([{ msg: s }]);
  const out = result.output[0].value.msg;
  assert.ok(out.includes('电话 '));
  assert.ok(out.includes(' 邮箱 '));
  assert.ok(out.includes(' 再 '));
  const markers = out.match(/\[REDACTED:[A-Z]+:\d+\]/g);
  assert.equal(markers.length, 3);
  assert.equal(new Set(markers).size, 3); // 两个手机号值不同，邮箱类型不同
});

test('逐项保留：keep 的命中保留原值，其余正常脱敏，计数准确', () => {
  const data = { phone: '13812345678', email: 'x@y.com' };
  const wrapped = [{ line: 1, value: data }];
  const { findings } = scan(wrapped, ENABLED);
  const phoneFinding = findings.find((f) => f.type === 'phone');
  const result = applyRedactions(wrapped, findings, { [phoneFinding.decisionKey]: 'keep' });
  assert.equal(result.output[0].value.phone, '13812345678');
  assert.match(result.output[0].value.email, /^\[REDACTED:EMAIL:/);
  assert.equal(result.totalKept, 1);
  assert.equal(result.totalRedacted, 1);
});

test('敏感容器整体脱敏：子树被标记替换，兄弟字段保留', () => {
  const data = { password: { algo: 'sha256', hash: 'x' }, level: 'INFO' };
  const { result } = redact([data]);
  const out = result.output[0].value;
  assert.match(out.password, /^\[REDACTED:PASSWORD:/);
  assert.equal(out.level, 'INFO');
});

test('变更摘要可定位且不含原始敏感值', () => {
  const { result } = redact([{ phone: '13812345678', msg: 'x 13911112222' }]);
  const json = JSON.stringify(result.changes);
  assert.ok(!json.includes('13812345678'));
  assert.ok(!json.includes('13911112222'));
  const items = result.changes[0].items;
  assert.ok(items.some((i) => i.path === 'phone' && i.action === 'redact'));
  const textHit = items.find((i) => i.mode === 'text');
  assert.equal(typeof textHit.start, 'number');
  assert.equal(typeof textHit.end, 'number');
  assert.match(textHit.marker, /^\[REDACTED:PHONE:/);
});

test('对已脱敏副本再次处理：幂等，不产生新标记也不改变内容', () => {
  const data = { phone: '13812345678', msg: 'call 13812345678' };
  const first = redact([data]);
  const masked = first.result.output.map((o) => o.value);
  const second = redact(masked);
  assert.equal(second.findings.length, 0);
  assert.equal(second.result.totalRedacted, 0);
  assert.deepEqual(second.result.output[0].value, first.result.output[0].value);
});

test('输入记录不被修改（脱敏在深拷贝上进行）', () => {
  const data = { user: { phone: '13812345678' } };
  const snapshot = JSON.stringify(data);
  redact([data]);
  assert.equal(JSON.stringify(data), snapshot);
});

test('根级标量字符串：文本片段与整值都能正确脱敏', () => {
  const textHit = redact(['call 13812345678 now']);
  assert.equal(textHit.result.output[0].value, 'call [REDACTED:PHONE:0001] now');
  const valueHit = redact(['a@b.cn']);
  assert.match(valueHit.result.output[0].value, /^\[REDACTED:EMAIL:\d+\]$/);
  assert.equal(valueHit.findings[0].mode, 'value');
});

test('根级与嵌套位置的同一敏感值复用同一标记', () => {
  const { result } = redact(['call 13812345678', { phone: '13812345678' }]);
  const first = result.output[0].value.match(/\[REDACTED:PHONE:\d+\]/)[0];
  assert.equal(result.output[1].value.phone, first);
});

test('顶层数组记录：逐元素扫描并保持数组结构', () => {
  const { result } = redact([[{ phone: '13812345678' }, { note: 'x 13911112222 y' }]]);
  assert.ok(Array.isArray(result.output[0].value));
  assert.match(result.output[0].value[0].phone, /^\[REDACTED:PHONE:/);
  assert.ok(result.output[0].value[1].note.includes('[REDACTED:PHONE:'));
});

test('紧邻无分隔的多个命中：偏移与替换均正确', () => {
  const { result } = redact([{ s: '13812345678,13911112222' }]);
  const out = result.output[0].value.s;
  assert.equal(out, '[REDACTED:PHONE:0001],[REDACTED:PHONE:0002]');
});
