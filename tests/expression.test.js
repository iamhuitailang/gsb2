import test from 'node:test';
import assert from 'node:assert/strict';
import { compileCondition, checkCondition, ExpressionError, evaluateConditionSource } from '../src/expression.js';

const vars = { 信任: 2, 持有钥匙: true, gold: 10, name: '旅人', flag: false };

test('空条件视为成立', () => {
  assert.equal(evaluateConditionSource('', vars), true);
  assert.equal(evaluateConditionSource('   ', vars), true);
});

test('比较与逻辑运算', () => {
  assert.equal(evaluateConditionSource('信任 >= 2', vars), true);
  assert.equal(evaluateConditionSource('信任 > 2', vars), false);
  assert.equal(evaluateConditionSource('持有钥匙', vars), true);
  assert.equal(evaluateConditionSource('持有钥匙 == true', vars), true);
  assert.equal(evaluateConditionSource('flag', vars), false);
  assert.equal(evaluateConditionSource('!flag', vars), true);
  assert.equal(evaluateConditionSource('gold >= 5 && 信任 <= 2', vars), true);
  assert.equal(evaluateConditionSource('gold > 100 || 持有钥匙', vars), true);
  assert.equal(evaluateConditionSource('(gold + 5) * 2 == 30', vars), true);
});

test('运算符优先级：&& 高于 ||', () => {
  assert.equal(evaluateConditionSource('false && true || true', {}), true);
  assert.equal(evaluateConditionSource('true || false && false', {}), true);
  assert.equal(evaluateConditionSource('true || true && false', {}), true);
});

test('字符串比较与拼接', () => {
  assert.equal(evaluateConditionSource('name == "旅人"', vars), true);
  assert.equal(evaluateConditionSource("name != '旅人'", vars), false);
  assert.equal(evaluateConditionSource('name + "!" == "旅人!"', vars), true);
});

test('未定义变量会抛出可识别的错误', () => {
  const result = checkCondition('不存在的变量 > 1', vars);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UNKNOWN_VARIABLE');
  assert.match(result.error, /未设置/);
});

test('语法错误会被报告', () => {
  for (const source of ['信任 >=', '(信任 > 1', '信任 > 1 &&', '"未闭合', '1 + + 2', '信任 @ 1']) {
    const result = checkCondition(source, vars);
    assert.equal(result.ok, false, `应当判定 ${source} 非法`);
  }
});

test('标识符收集用于静态检查', () => {
  assert.deepEqual(
    [...compileCondition('信任 >= 2 && 持有钥匙').identifiers].sort(),
    ['信任', '持有钥匙'].sort(),
  );
});

test('除零与类型错误', () => {
  assert.throws(() => evaluateConditionSource('1 / 0', {}), ExpressionError);
  const result = checkCondition('name - 1', vars);
  assert.equal(result.ok, false);
});

test('中文变量名和英文关键字都能解析', () => {
  assert.equal(evaluateConditionSource('信任 >= 1 and 持有钥匙 or flag', vars), true);
  assert.equal(evaluateConditionSource('not flag', vars), true);
});

test('布尔值以数字比较时保持严格比较语义', () => {
  // 3 == "3" 为 false，避免隐式转换带来的意外
  assert.equal(evaluateConditionSource('3 == "3"', {}), false);
  assert.equal(evaluateConditionSource('1 != 2', {}), true);
});

test('负数与一元运算', () => {
  assert.equal(evaluateConditionSource('-gold == -10', vars), true);
  assert.equal(evaluateConditionSource('!(gold < 5)', vars), true);
});
