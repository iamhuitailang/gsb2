/*
 * input-bus.js — 统一输入总线
 *
 * 真实键盘（window keydown/keyup）、真实手柄（Gamepad API 轮询，含摇杆
 * 死区与迟滞）、模拟面板（sim* 方法）都汇入同一个 held 集合与事件流，
 * 保证“游戏预览”和“捕获录入”面对的是完全一致的输入语义。
 *
 * 事件对象：
 *   { source:'real'|'sim', kind:'keyboard'|'gamepad',
 *     code:'KeyW' | 'gp:button:0' | 'gp:axis:0:+',
 *     action:'down'|'up', repeat:boolean, raw?:Event }
 */
(function (global) {
  'use strict';

  var AXIS_PRESS = 0.5;   // 越过该阈值视为“按下”
  var AXIS_RELEASE = 0.35; // 回落到该阈值以下才“抬起”（迟滞防抖）

  function InputBus() {
    this.held = new Set();
    this._listeners = { down: [], up: [], device: [] };
    this._keyboardAttached = false;
    this._rafId = null;
    this._prevButtons = new Map(); // gamepadIndex -> boolean[]
    this._axisArmed = new Map();   // "index:axis:dir" -> bool（迟滞状态）
    this.swallowKeys = false;      // 捕获模式下拦截浏览器默认行为
    this._onKeyDown = this._handleKeyDown.bind(this);
    this._onKeyUp = this._handleKeyUp.bind(this);
    this._pollGamepads = this._pollGamepads.bind(this);
    this._onGpConnect = this._handleGpConnect.bind(this);
  }

  InputBus.prototype.on = function (event, fn) {
    if (this._listeners[event]) this._listeners[event].push(fn);
    return this;
  };

  InputBus.prototype.off = function (event, fn) {
    var arr = this._listeners[event];
    if (!arr) return this;
    var i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
    return this;
  };

  InputBus.prototype._emit = function (event, ev) {
    this._listeners[event].forEach(function (fn) {
      try { fn(ev); } catch (e) { console.error('输入事件处理异常：', e); }
    });
  };

  InputBus.prototype.isHeld = function (code) {
    return this.held.has(code);
  };

  /* ---------- 真实键盘 ---------- */

  InputBus.prototype.attachKeyboard = function () {
    if (this._keyboardAttached || typeof window === 'undefined') return;
    window.addEventListener('keydown', this._onKeyDown, true);
    window.addEventListener('keyup', this._onKeyUp, true);
    this._keyboardAttached = true;
  };

  InputBus.prototype.detachKeyboard = function () {
    if (!this._keyboardAttached || typeof window === 'undefined') return;
    window.removeEventListener('keydown', this._onKeyDown, true);
    window.removeEventListener('keyup', this._onKeyUp, true);
    this._keyboardAttached = false;
  };

  InputBus.prototype._handleKeyDown = function (e) {
    if (this.swallowKeys && e.code !== 'F11') e.preventDefault();
    // 长按自动 repeat：仍然更新 held（本来就在），但带上 repeat 标记，
    // 捕获逻辑据此忽略，保证“按住不放不会连续生成多条绑定”。
    var ev = {
      source: 'real', kind: 'keyboard', code: e.code,
      action: 'down', repeat: e.repeat === true, raw: e
    };
    if (!e.repeat) this.held.add(e.code);
    this._emit('down', ev);
  };

  InputBus.prototype._handleKeyUp = function (e) {
    this.held.delete(e.code);
    this._emit('up', {
      source: 'real', kind: 'keyboard', code: e.code,
      action: 'up', repeat: false, raw: e
    });
  };

  /* ---------- 模拟键盘 / 手柄（页面上的虚拟设备） ---------- */

  InputBus.prototype.simPress = function (code, kind) {
    if (this.held.has(code)) return false; // 按住期间只产生一次 down
    this.held.add(code);
    this._emit('down', {
      source: 'sim', kind: kind || 'keyboard', code: code,
      action: 'down', repeat: false
    });
    return true;
  };

  InputBus.prototype.simRelease = function (code, kind) {
    if (!this.held.delete(code)) return false;
    this._emit('up', {
      source: 'sim', kind: kind || 'keyboard', code: code,
      action: 'up', repeat: false
    });
    return true;
  };

  /* ---------- 真实手柄轮询 ---------- */

  InputBus.prototype.startGamepadPolling = function () {
    if (this._rafId || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    window.addEventListener('gamepadconnected', this._onGpConnect);
    window.addEventListener('gamepaddisconnected', this._onGpConnect);
    var loop = function () {
      this._pollGamepads();
      this._rafId = requestAnimationFrame(loop);
    }.bind(this);
    this._rafId = requestAnimationFrame(loop);
  };

  InputBus.prototype.stopGamepadPolling = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', this._onGpConnect);
      window.removeEventListener('gamepaddisconnected', this._onGpConnect);
    }
  };

  InputBus.prototype._handleGpConnect = function () {
    this._emit('device', { type: 'gamepad-list-changed' });
  };

  InputBus.prototype.listGamepads = function () {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    var pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.prototype.filter.call(pads, Boolean);
  };

  InputBus.prototype._pollGamepads = function () {
    var pads = this.listGamepads();
    pads.forEach(function (pad) {
      var idx = pad.index;

      // 按钮
      var prev = this._prevButtons.get(idx) || [];
      pad.buttons.forEach(function (btn, i) {
        var pressed = btn.pressed || btn.value > 0.5;
        var code = 'gp:button:' + i;
        if (pressed && !prev[i]) {
          if (!this.held.has(code)) {
            this.held.add(code);
            this._emit('down', { source: 'real', kind: 'gamepad', code: code, action: 'down', repeat: false });
          }
        } else if (!pressed && prev[i]) {
          this.held.delete(code);
          this._emit('up', { source: 'real', kind: 'gamepad', code: code, action: 'up', repeat: false });
        }
      }.bind(this));
      this._prevButtons.set(idx, pad.buttons.map(function (b) { return b.pressed || b.value > 0.5; }));

      // 摇杆轴：带迟滞的方向按下/抬起
      (pad.axes || []).forEach(function (value, axisIdx) {
        ['+', '-'].forEach(function (dir) {
          var key = idx + ':' + axisIdx + ':' + dir;
          var armed = !!this._axisArmed.get(key);
          var over = dir === '+' ? value > AXIS_PRESS : value < -AXIS_PRESS;
          var under = dir === '+' ? value < AXIS_RELEASE : value > -AXIS_RELEASE;
          var code = 'gp:axis:' + axisIdx + ':' + dir;
          if (!armed && over) {
            this._axisArmed.set(key, true);
            if (!this.held.has(code)) {
              this.held.add(code);
              this._emit('down', { source: 'real', kind: 'gamepad', code: code, action: 'down', repeat: false });
            }
          } else if (armed && under) {
            this._axisArmed.set(key, false);
            this.held.delete(code);
            this._emit('up', { source: 'real', kind: 'gamepad', code: code, action: 'up', repeat: false });
          }
        }.bind(this));
      }.bind(this));
    }.bind(this));
  };

  /* ---------- 失焦兜底：窗口失焦时清空所有按住状态，避免“卡键” ---------- */

  InputBus.prototype.attachBlurReset = function () {
    if (typeof window === 'undefined') return;
    window.addEventListener('blur', this.releaseAll.bind(this));
  };

  InputBus.prototype.releaseAll = function () {
    var codes = Array.from(this.held);
    codes.forEach(function (code) {
      var kind = code.indexOf('gp:') === 0 ? 'gamepad' : 'keyboard';
      this.held.delete(code);
      this._emit('up', { source: 'sim', kind: kind, code: code, action: 'up', repeat: false });
    }.bind(this));
    this._axisArmed.clear();
  };

  global.InputBus = InputBus;
})(typeof window !== 'undefined' ? window : globalThis);
