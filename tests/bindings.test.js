/*
 * bindings.test.js — 纯逻辑单元测试（node tests/bindings.test.js）
 * 覆盖：归一化、组合键签名与前缀、三类冲突检测、确认名单、
 *       held 状态解析、导入校验。
 */
'use strict';

var assert = require('assert');
var KC = require('../src/keycodes.js');
var Bindings = require('../src/bindings.js');
var Defaults = require('../src/defaults.js');

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e));
    process.exitCode = 1;
  }
}

function kb(code, mods) { return { type: 'keyboard', code: code, modifiers: mods || [] }; }
function gp(code) { return { type: 'gamepad', code: code }; }
function ctx(actions) { return { id: 't', name: '测试', actions: actions }; }
function act(id, primary, secondary) {
  return { id: id, name: id, bindings: { primary: primary || null, secondary: secondary || null } };
}

console.log('归一化与签名：');

test('字符串 "Ctrl+K" 归一为修饰+主键', function () {
  var b = Bindings.normalizeBinding('Ctrl+KeyK');
  assert.strictEqual(b.type, 'keyboard');
  assert.strictEqual(b.code, 'KeyK');
  assert.deepStrictEqual(b.modifiers, ['ControlLeft']);
  assert.strictEqual(b.signature, 'Ctrl+KeyK');
});

test('左右 Ctrl 归一为同一签名', function () {
  var a = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft']));
  var b = Bindings.normalizeBinding(kb('KeyK', ['ControlRight']));
  assert.strictEqual(a.signature, b.signature);
});

test('修饰键顺序不影响签名', function () {
  var a = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft', 'ShiftLeft']));
  var b = Bindings.normalizeBinding(kb('KeyK', ['ShiftRight', 'ControlRight']));
  assert.strictEqual(a.signature, b.signature);
});

test('单独修饰键绑定', function () {
  var b = Bindings.normalizeBinding(kb('ShiftLeft'));
  assert.strictEqual(b.signature, 'ShiftLeft');
  assert.strictEqual(b.display, 'L Shift');
});

test('手柄字符串与结构化对象等价', function () {
  var a = Bindings.normalizeBinding('gp:button:0');
  var b = Bindings.normalizeBinding(gp('gp:button:0'));
  assert.strictEqual(a.code, b.code);
  assert.strictEqual(a.type, 'gamepad');
});

test('非法输入返回 null', function () {
  assert.strictEqual(Bindings.normalizeBinding(null), null);
  assert.strictEqual(Bindings.normalizeBinding(''), null);
  assert.strictEqual(Bindings.normalizeBinding({ foo: 1 }), null);
});

console.log('\n组合键前缀：');

test('Ctrl 是 Ctrl+K 的严格前缀', function () {
  var shortB = Bindings.normalizeBinding(kb('ControlLeft'));
  var longB = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft']));
  assert.strictEqual(Bindings.isStrictPrefix(shortB, longB), true);
});

test('普通单键 K 不是 Ctrl+K 的前缀', function () {
  var shortB = Bindings.normalizeBinding(kb('KeyK'));
  var longB = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft']));
  assert.strictEqual(Bindings.isStrictPrefix(shortB, longB), false);
});

test('反向（长 -> 短）不算前缀', function () {
  var shortB = Bindings.normalizeBinding(kb('ControlLeft'));
  var longB = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft']));
  assert.strictEqual(Bindings.isStrictPrefix(longB, shortB), false);
});

test('Shift 不是 Ctrl+K 的前缀', function () {
  var shortB = Bindings.normalizeBinding(kb('ShiftLeft'));
  var longB = Bindings.normalizeBinding(kb('KeyK', ['ControlLeft']));
  assert.strictEqual(Bindings.isStrictPrefix(shortB, longB), false);
});

console.log('\n冲突检测：');

test('完全相同的按键 -> duplicate', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.jump', kb('Space')),
    act('a.dodge', kb('Space'))
  ]));
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'duplicate');
});

test('修饰键与组合键共存 -> prefix', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.sprint', kb('ShiftLeft')),
    act('a.skill', kb('KeyQ', ['ShiftLeft']))
  ]));
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'prefix');
});

test('同一手柄按钮被两个操作占用 -> gamepad', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.jump', kb('Space'), gp('gp:button:0')),
    act('a.confirm', kb('Enter'), gp('gp:button:0'))
  ]));
  assert.strictEqual(c.some(function (x) { return x.kind === 'gamepad'; }), true);
});

test('键盘与手柄互不冲突', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.one', kb('Space')),
    act('a.two', gp('gp:button:0'))
  ]));
  assert.strictEqual(c.length, 0);
});

test('同一操作主副槽重复也会报告 duplicate', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.one', kb('Space'), kb('Space'))
  ]));
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'duplicate');
});

test('干净的默认映射在每个情境都无冲突', function () {
  var p = Defaults.createDefaultProfile();
  p.contexts.forEach(function (c) {
    assert.deepStrictEqual(Bindings.detectConflicts(c), [], '情境 ' + c.id + ' 存在冲突');
  });
});

test('冲突确认 key 稳定且可匹配', function () {
  var c = Bindings.detectConflicts(ctx([
    act('a.jump', kb('Space')),
    act('a.dodge', kb('Space'))
  ]))[0];
  var key = Bindings.conflictAckKey(c);
  assert.strictEqual(Bindings.isAcked(c, [key]), true);
  assert.strictEqual(Bindings.isAcked(c, ['other']), false);
  assert.strictEqual(Bindings.isAcked(c, [{ key: key }]), true);
});

console.log('\nheld 状态解析：');

test('单键按下激活对应操作', function () {
  var c = ctx([act('a.jump', kb('Space'))]);
  var active = Bindings.resolveActiveActions(c, new Set(['Space']));
  assert.strictEqual(active['a.jump'], true);
});

test('组合键需要修饰键同时按住', function () {
  var c = ctx([act('a.skill', kb('KeyQ', ['ControlLeft']))]);
  assert.deepStrictEqual(Bindings.resolveActiveActions(c, new Set(['KeyQ'])), {});
  var active = Bindings.resolveActiveActions(c, new Set(['KeyQ', 'ControlLeft']));
  assert.strictEqual(active['a.skill'], true);
});

test('手柄方向轴按下激活', function () {
  var c = ctx([act('a.up', gp('gp:axis:1:-'))]);
  var active = Bindings.resolveActiveActions(c, new Set(['gp:axis:1:-']));
  assert.strictEqual(active['a.up'], true);
});

test('主副绑定任一按住即激活', function () {
  var c = ctx([act('a.jump', kb('Space'), gp('gp:button:0'))]);
  assert.strictEqual(Bindings.resolveActiveActions(c, new Set(['gp:button:0']))['a.jump'], true);
  assert.strictEqual(Bindings.resolveActiveActions(c, new Set(['Space']))['a.jump'], true);
  assert.deepStrictEqual(Bindings.resolveActiveActions(c, new Set()), {});
});

console.log('\n导入校验：');

test('合法键盘/手柄绑定通过校验', function () {
  assert.strictEqual(Bindings.validateBinding(kb('KeyW')).ok, true);
  assert.strictEqual(Bindings.validateBinding('Ctrl+KeyK').ok, true);
  assert.strictEqual(Bindings.validateBinding('gp:axis:0:+').ok, true);
});

test('未知键盘码被拒绝', function () {
  var r = Bindings.validateBinding(kb('KeyNotExist'));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown-key');
});

test('越界手柄按钮被拒绝', function () {
  var r = Bindings.validateBinding('gp:button:99');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unknown-gamepad');
});

test('格式错误的字符串被拒绝', function () {
  var r = Bindings.validateBinding('Foo+');
  assert.strictEqual(r.ok, false);
});

test('空绑定被拒绝', function () {
  assert.strictEqual(Bindings.validateBinding(null).ok, false);
  assert.strictEqual(Bindings.validateBinding('').ok, false);
});

console.log('\n码表：');

test('手柄按钮与轴名称可解析', function () {
  assert.ok(KC.gamepadLabel('gp:button:0').indexOf('A') !== -1);
  assert.ok(KC.gamepadLabel('gp:axis:0:-').indexOf('左摇杆') !== -1);
  assert.strictEqual(KC.isKnownGamepadCode('gp:button:16'), true);
  assert.strictEqual(KC.isKnownGamepadCode('gp:button:17'), false);
});

console.log('\n通过 ' + passed + ' 项测试。');
