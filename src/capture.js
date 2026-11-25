/*
 * capture.js — 录入新绑定的捕获会话
 *
 * 规则：
 *  - 捕获期间真实键盘/手柄与模拟设备均可录入；
 *  - 只认“边沿事件”（repeat=true 的长按事件直接忽略），按住不放只会产生一条绑定；
 *  - 先按住修饰键（Ctrl/Shift/Alt/Win，可多个）再按主键 -> 组合键；
 *  - 只按修饰键并松开 -> 该修饰键本身成为绑定；
 *  - 手柄输入不支持组合键，任意按钮/摇杆方向立即完成；
 *  - 点“取消”、按 Esc（作为取消指令而非绑定）、或手柄 Back/Select -> 取消；
 *  - 捕获期间拦截浏览器默认快捷键，避免页面被刷新/关闭。
 */
(function (global) {
  'use strict';

  var KC = global.KeyCodes;

  function CaptureSession(bus, options) {
    this.bus = bus;
    this.options = options || {};
    this.onUpdate = this.options.onUpdate || function () {};
    this.onDone = this.options.onDone || function () {};
    this.onCancel = this.options.onCancel || function () {};

    this.active = false;
    this.pendingModifiers = []; // 物理 code
    this._downHandler = this._handleDown.bind(this);
    this._upHandler = this._handleUp.bind(this);
  }

  CaptureSession.prototype.start = function () {
    if (this.active) return;
    this.active = true;
    // 快照进入捕获前已经按住的修饰键，支持“先按住 Ctrl 再点录入”的操作习惯
    this.pendingModifiers = [];
    this.bus.held.forEach(function (code) {
      if (KC.isModifier(code) && this.pendingModifiers.indexOf(code) === -1) {
        this.pendingModifiers.push(code);
      }
    }.bind(this));
    this.bus.swallowKeys = true;
    this.bus.on('down', this._downHandler);
    this.bus.on('up', this._upHandler);
    this._renderProgress();
  };

  CaptureSession.prototype.stop = function () {
    if (!this.active) return;
    this.active = false;
    this.bus.swallowKeys = false;
    this.bus.off('down', this._downHandler);
    this.bus.off('up', this._upHandler);
  };

  CaptureSession.prototype.cancel = function (reason) {
    if (!this.active) return;
    this.stop();
    this.onCancel(reason || 'user-cancel');
  };

  CaptureSession.prototype._handleDown = function (ev) {
    if (!this.active || ev.repeat) return; // 关键：长按重复事件一律忽略

    // Esc 始终是“取消”，不参与绑定
    if (ev.kind === 'keyboard' && ev.code === 'Escape') {
      this.cancel('esc');
      return;
    }
    // 手柄 Back/Select（标准索引 8）也用于取消
    if (ev.kind === 'gamepad' && ev.code === 'gp:button:8') {
      this.cancel('gamepad-back');
      return;
    }

    if (ev.kind === 'gamepad') {
      // 手柄不组合，直接完成
      this._finish({ type: 'gamepad', code: ev.code, modifiers: [] });
      return;
    }

    if (KC.isModifier(ev.code)) {
      if (this.pendingModifiers.indexOf(ev.code) === -1) {
        this.pendingModifiers.push(ev.code);
      }
      this._renderProgress();
      return;
    }

    // 普通主键 + 当前修饰 -> 组合键，完成
    this._finish({ type: 'keyboard', code: ev.code, modifiers: this.pendingModifiers.slice() });
  };

  CaptureSession.prototype._handleUp = function (ev) {
    if (!this.active) return;
    if (ev.kind !== 'keyboard' || !KC.isModifier(ev.code)) return;

    var idx = this.pendingModifiers.indexOf(ev.code);
    if (idx !== -1) {
      this.pendingModifiers.splice(idx, 1);
      this._renderProgress();
    }

    // 没有任何主键按下过，且修饰键全部松开 -> 以刚松开的修饰键本身作为绑定
    if (this.pendingModifiers.length === 0) {
      this._finish({ type: 'keyboard', code: ev.code, modifiers: [] });
    }
  };

  CaptureSession.prototype._finish = function (rawBinding) {
    if (!this.active) return;
    var binding = global.Bindings.normalizeBinding(rawBinding);
    this.stop();
    if (binding) this.onDone(binding);
    else this.onCancel('invalid-input');
  };

  CaptureSession.prototype._renderProgress = function () {
    if (this.pendingModifiers.length === 0) {
      this.onUpdate('');
      return;
    }
    var text = this.pendingModifiers
      .map(function (m) { return KC.normalizeModifier(m); })
      .join(' + ') + ' + …';
    this.onUpdate(text);
  };

  global.CaptureSession = CaptureSession;
  if (typeof module !== 'undefined' && module.exports) module.exports = CaptureSession;
})(typeof window !== 'undefined' ? window : globalThis);
