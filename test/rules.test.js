'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/core/rules.js');

test('身份证校验位：合法号码通过、篡改末位被拒', () => {
  assert.equal(rules.idCardCheck('11010519491231002X'), true);
  assert.equal(rules.idCardCheck('110105194912310021'), false);
  assert.equal(rules.idCardCheck('123456789012345678'), false);
});

test('Luhn：合法银行卡/IMEI 通过，普通业务数字被拒', () => {
  assert.equal(rules.luhnCheck('6222020200111117'), true);
  assert.equal(rules.luhnCheck('490154203237518'), true);
  assert.equal(rules.luhnCheck('1234567890123456'), false); // demo 中的 serial
  assert.equal(rules.luhnCheck('12'), false);
});

test('字段名规则：敏感字段命中，普通业务编号/日期字段不命中', () => {
  assert.equal(rules.matchFieldName('password').id, 'FIELD_PASSWORD');
  assert.equal(rules.normalizeKey('API-Key'), 'api_key');
  assert.equal(rules.matchFieldName('API-Key').id, 'FIELD_SECRET_KEY');
  for (const key of ['order_id', 'trace_id', 'ts', 'event', 'level', 'latency_ms', 'app_version', 'serial', 'username']) {
    assert.equal(rules.matchFieldName(key), null, `${key} 不应命中字段名规则`);
  }
});

test('字段名规则：后缀匹配覆盖嵌套命名，login_name 不被误判为 name', () => {
  assert.equal(rules.matchFieldName('user_phone').id, 'FIELD_PHONE');
  assert.equal(rules.matchFieldName('contactEmail').id, 'FIELD_EMAIL');
  assert.equal(rules.matchFieldName('login_name'), null);
  assert.equal(rules.matchFieldName('user_name'), null);
  assert.equal(rules.matchFieldName('real_name').id, 'FIELD_NAME');
});

test('脱敏标记识别', () => {
  assert.equal(rules.isRedactionMarker('[REDACTED:PHONE:0001]'), true);
  assert.equal(rules.isRedactionMarker('[REDACTED:PHONE:1]'), true);
  assert.equal(rules.isRedactionMarker('前缀[REDACTED:PHONE:0001]后缀'), false);
  assert.equal(rules.isRedactionMarker('13812345678'), false);
  assert.equal(rules.isRedactionMarker(42), false);
});

test('maskPreview 不返回完整原值', () => {
  assert.equal(rules.maskPreview('phone', '13812345678'), '138****5678');
  assert.equal(rules.maskPreview('email', 'zhangwei@example.cn'), 'z***@example.cn');
  const p = rules.maskPreview('password', 'P@ssw0rd-2026');
  assert.ok(!p.includes('P@ssw0rd-2026'));
});

test('IPv4 规则默认关闭，其余模式规则默认启用', () => {
  assert.ok(!rules.DEFAULT_ENABLED_IDS.includes('PATTERN_IPV4'));
  assert.ok(rules.DEFAULT_ENABLED_IDS.includes('PATTERN_PHONE'));
  assert.equal(rules.RULES_BY_ID.PATTERN_IPV4.defaultEnabled, false);
});
