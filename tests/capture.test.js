/*
 * capture.test.js — CaptureSession 单元测试，用最小 InputBus 桩模拟事件序列。
 * 运行：node tests/capture.test.js
 */
'use strict';

const assert = require('assert');
const KC = require('../src/keycodes.js');
const Bindings = require('../src/bindings.js');
global.KeyCodes = KC;
global.Bindings = Bindings;
const CaptureSession = require('../src/capture.js');

// 最小 bus 桩：持有 held 集合与事件监听
function fakeBus(held) {
  return {
    held: new Set(held || []),
    swallowKeys: false,
    _fns: { down: [], up: [] },
    on(ev, fn) { this._fns[ev].push(fn); },
    off(ev, fn) {
      const i = this._fns[ev].indexOf(fn);
      if (i !== -1) this._fns[ev].splice(i, 1);
    },
    emit(ev, data) { this._fns[ev].forEach((fn) => fn(data)); },
    down(code, kind, repeat) {
      this.emit('down', { kind: kind || 'keyboard', code, action: 'down', repeat: !!repeat });
    },
    up(code, kind) {
      this.emit('up', { kind: kind || 'keyboard', code, action: 'up', repeat: false });
    }
  };
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e.stack || e).split('\n').slice(0, 3).join('\n    '));
    process.exitCode = 1;
  }
}

console.log('捕获会话：');

test('普通按键完成绑定', () => {
  const bus = fakeBus();
  let done = null;
  const cap = new CaptureSession(bus, { onDone: (b) => (done = b) });
  cap.start();
  bus.down('KeyT');
  assert.ok(cap.active === false);
  assert.strictEqual(done.type, 'keyboard');
  assert.strictEqual(done.code, 'KeyT');
});

test('长按 repeat 事件被忽略，不会提前/重复完成', () => {
  const bus = fakeBus();
  let count = 0;
  const cap = new CaptureSession(bus, { onDone: () => count++ });
  cap.start();
  bus.down('KeyR', 'keyboard', true);
  bus.down('KeyR', 'keyboard', true);
  assert.strictEqual(cap.active, true);
  assert.strictEqual(count, 0);
  bus.up('KeyR');
  // 只有 repeat 没有边沿 down -> 不会完成
  assert.strictEqual(count, 0);
});

test('修饰键 + 主键形成组合键', () => {
  const bus = fakeBus();
  let done = null;
  const cap = new CaptureSession(bus, { onDone: (b) => (done = b) });
  cap.start();
  bus.down('ControlLeft');
  bus.down('KeyG');
  assert.strictEqual(done.code, 'KeyG');
  assert.deepStrictEqual(done.modifiers, ['ControlLeft']);
  assert.strictEqual(done.signature, 'Ctrl+KeyG');
});

test('进入捕获前已按住的修饰键计入组合键', () => {
  const bus = fakeBus(['ShiftLeft']);
  let done = null;
  const cap = new CaptureSession(bus, { onDone: (b) => (done = b) });
  cap.start();
  bus.down('KeyQ');
  assert.deepStrictEqual(done.modifiers, ['ShiftLeft']);
  assert.strictEqual(done.signature, 'Shift+KeyQ');
});

test('只按修饰键并松开 -> 修饰键本身成为绑定', () => {
  const bus = fakeBus();
  let done = null;
  const cap = new CaptureSession(bus, { onDone: (b) => (done = b) });
  cap.start();
  bus.down('ShiftLeft');
  bus.up('ShiftLeft');
  assert.strictEqual(done.code, 'ShiftLeft');
  assert.deepStrictEqual(done.modifiers, []);
});

test('Esc 取消且不产生绑定', () => {
  const bus = fakeBus();
  let canceled = null;
  const cap = new CaptureSession(bus, { onDone: () => { throw new Error('不应完成'); }, onCancel: (r) => (canceled = r) });
  cap.start();
  bus.down('Escape');
  assert.strictEqual(cap.active, false);
  assert.strictEqual(canceled, 'esc');
});

test('手柄 Back/Select 取消', () => {
  const bus = fakeBus();
  let canceled = null;
  const cap = new CaptureSession(bus, { onDone: () => { throw new Error('不应完成'); }, onCancel: (r) => (canceled = r) });
  cap.start();
  bus.down('gp:button:8', 'gamepad');
  assert.strictEqual(canceled, 'gamepad-back');
});

test('手柄按钮立即完成且不组合', () => {
  const bus = fakeBus(['ControlLeft']);
  let done = null;
  const cap = new CaptureSession(bus, { onDone: (b) => (done = b) });
  cap.start();
  bus.down('gp:button:3', 'gamepad');
  assert.strictEqual(done.type, 'gamepad');
  assert.strictEqual(done.code, 'gp:button:3');
});

test('stop 后不再响应事件', () => {
  const bus = fakeBus();
  const cap = new CaptureSession(bus, { onDone: () => { throw new Error('不应完成'); } });
  cap.start();
  cap.cancel('external');
  assert.strictEqual(bus.swallowKeys, false);
  bus.down('KeyW'); // 不应抛错
});

console.log('\n通过 ' + passed + ' 项测试。');
