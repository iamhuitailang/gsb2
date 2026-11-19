'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scan } = require('../src/core/scanner.js');
const rules = require('../src/core/rules.js');

const ENABLED = new Set(rules.DEFAULT_ENABLED_IDS);

function scanOne(value, ids = ENABLED) {
  return scan([{ line: 1, value }], ids);
}

test('嵌套对象与数组：路径可定位到叶子', () => {
  const data = {
    user: {
      contacts: [{ phone: '13812345678' }, { email: 'a@b.cn' }],
      profile: { real_name: '王五' },
    },
  };
  const { findings } = scanOne(data);
  const paths = findings.map((f) => f.path).sort();
  assert.deepEqual(paths, ['user.contacts[0].phone', 'user.contacts[1].email', 'user.profile.real_name']);
  assert.ok(findings.every((f) => Array.isArray(f.pathSegments)));
});

test('同一文本多次命中：分别记录且偏移正确、互不重叠', () => {
  const s = '电话 13812345678 与 13911112222，邮箱 x@y.com';
  const { findings } = scanOne({ msg: s });
  const phones = findings.filter((f) => f.type === 'phone');
  const email = findings.filter((f) => f.type === 'email');
  assert.equal(phones.length, 2);
  assert.equal(email.length, 1);
  assert.equal(s.slice(phones[0].start, phones[0].end), '13812345678');
  assert.equal(s.slice(phones[1].start, phones[1].end), '13911112222');
  assert.equal(s.slice(email[0].start, email[0].end), 'x@y.com');
  // 偏移排序后区间不重叠
  const ranges = findings.map((f) => [f.start, f.end]).sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i][0] >= ranges[i - 1][1]);
});

test('普通业务编号、日期、日志级别、时间戳不被误报', () => {
  const data = {
    ts: '2026-11-20T08:12:03Z',
    level: 'INFO',
    order_id: 'ORD20261120001',
    trace_id: 'trc-7f3a91c2',
    latency_ms: 42,
    serial: 1234567890123456,
    version: '12.0.3',
    note: '一切正常，没有敏感内容',
  };
  const { findings } = scanOne(data);
  assert.deepEqual(findings, []);
});

test('规则启停：关闭手机号规则后对应命中消失，重新启用后恢复', () => {
  const data = { msg: 'call 13812345678 now', mail: 'q@w.cn' };
  assert.equal(scanOne(data).findings.filter((f) => f.type === 'phone').length, 1);
  const off = new Set(ENABLED);
  off.delete('PATTERN_PHONE');
  off.delete('FIELD_PHONE');
  const r1 = scanOne(data, off);
  assert.equal(r1.findings.filter((f) => f.type === 'phone').length, 0);
  assert.equal(r1.findings.filter((f) => f.type === 'email').length, 1);
  const r2 = scanOne(data, ENABLED);
  assert.equal(r2.findings.filter((f) => f.type === 'phone').length, 1);
});

test('字段名命中嵌套叶子：路径完整、各自独立命中', () => {
  const data = { auth: { access_token: 'aaa', nested: { refresh_token: 'bbb' } } };
  const { findings } = scanOne(data);
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map((f) => f.path).sort(), ['auth.access_token', 'auth.nested.refresh_token']);
  assert.ok(findings.every((f) => f.mode === 'field'));
});

test('字段名命中对象容器（password 等容器键）：子树整体命中且不下钻', () => {
  const data = { password: { algo: 'sha256', hash: 'x', salt: 'y' }, level: 'INFO' };
  const { findings } = scanOne(data);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, 'password');
  assert.equal(findings[0].mode, 'field');
});

test('已脱敏标记：整值标记与文本内标记都不会产生新命中（幂等）', () => {
  const data = {
    phone: '[REDACTED:PHONE:0001]',
    msg: '客户 [REDACTED:PHONE:0001] 与 [REDACTED:EMAIL:0002] 已处理',
  };
  assert.deepEqual(scanOne(data).findings, []);
});

test('模式规则带边界约束：长数字中的片段不会被截断命中', () => {
  const { findings } = scanOne({ s: 'id=99138123456789 and 138123456780' });
  assert.deepEqual(findings.filter((f) => f.type === 'phone'), []);
});

test('身份证/银行卡依赖校验位，普通 18 位/16 位数字不命中', () => {
  const r1 = scanOne({ id: '123456789012345678' });
  assert.deepEqual(r1.findings.filter((f) => f.type === 'cn_id_card'), []);
  const r2 = scanOne({ card: '1234567890123456' });
  assert.deepEqual(r2.findings.filter((f) => f.type === 'bank_card'), []);
  const r3 = scanOne({ id: '11010519491231002X' });
  assert.equal(r3.findings.filter((f) => f.type === 'cn_id_card').length, 1);
});

test('finding 不携带原始值，仅含预览与长度', () => {
  const { findings } = scanOne({ phone: '13812345678' });
  const json = JSON.stringify(findings);
  assert.ok(!json.includes('13812345678'));
  assert.ok(json.includes('138****5678'));
  assert.equal(findings[0].valueLength, 11);
});

test('同区间多规则竞争时只保留一条（Bearer 令牌与 JWT 区间重叠不重复计数）', () => {
  const token = 'eyJabcde.eyJabcde.sig12345'; // 同时满足 Bearer 捕获组与 JWT 形态
  const { findings } = scanOne({ msg: `Authorization: Bearer ${token}` });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, 'PATTERN_BEARER');
  assert.equal(findings[0].type, 'bearer');
});

test('按类型/规则统计命中数量', () => {
  const { countByType, countByRule } = scanOne({ a: '13812345678', b: '13911112222', c: 'x@y.com' });
  assert.equal(countByType.phone, 2);
  assert.equal(countByType.email, 1);
  assert.equal(countByRule.PATTERN_PHONE, 2);
});
