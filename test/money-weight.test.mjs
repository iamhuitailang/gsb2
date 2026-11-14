import { test } from 'node:test';
import assert from 'node:assert/strict';

import { yuanToFen, fenToYuan } from '../lib/money.js';
import { ceilWeightKg } from '../lib/weight.js';
import { isValidIsoDate } from '../lib/dates.js';

test('yuanToFen: 合法金额精确转分', () => {
  assert.equal(yuanToFen('8.00'), 800);
  assert.equal(yuanToFen('3'), 300);
  assert.equal(yuanToFen('3.5'), 350);
  assert.equal(yuanToFen('0'), 0);
  assert.equal(yuanToFen('1234567.89'), 123456789);
});

test('yuanToFen: 三位小数、负数、科学计数法、空串一律拒绝', () => {
  for (const bad of ['3.555', '-1.00', '1e3', '', '  ', 'abc', '1.2.3']) {
    assert.throws(() => yuanToFen(bad), /金额格式非法/);
  }
});

test('fenToYuan: 字符串拼接两位小数且与 yuanToFen 互逆', () => {
  assert.equal(fenToYuan(0), '0.00');
  assert.equal(fenToYuan(1350), '13.50');
  assert.equal(fenToYuan(5), '0.05');
  for (const s of ['8.00', '3.50', '10.00', '0.01', '999.99']) {
    assert.equal(fenToYuan(yuanToFen(s)), s);
  }
});

test('ceilWeightKg: 边界取整', () => {
  assert.equal(ceilWeightKg('1'), 1);
  assert.equal(ceilWeightKg('1.0'), 1);
  assert.equal(ceilWeightKg('1.2'), 2);
  assert.equal(ceilWeightKg('1.005'), 2); // 浮点 parse 会出错的边界
  assert.equal(ceilWeightKg('0.001'), 1);
  assert.equal(ceilWeightKg('3'), 3);
  assert.equal(ceilWeightKg('100.0001'), 101);
});

test('ceilWeightKg: 非法输入拒绝', () => {
  for (const bad of ['', '-1', '1e3', 'abc', '1,000']) {
    assert.throws(() => ceilWeightKg(bad), /重量格式非法/);
  }
  assert.equal(ceilWeightKg('0'), 0); // 0 可被精确计算，业务层再判 >0
});

test('isValidIsoDate: 含闰年与非法日历日', () => {
  assert.equal(isValidIsoDate('2026-11-10'), true);
  assert.equal(isValidIsoDate('2024-02-29'), true); // 闰年
  assert.equal(isValidIsoDate('2026-02-29'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-11-40'), false);
  assert.equal(isValidIsoDate('20261110'), false);
});
