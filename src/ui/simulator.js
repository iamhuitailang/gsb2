/*
 * simulator.js — 页面内的虚拟键盘 / 虚拟手柄
 *
 * 指针按下 -> bus.simPress，指针松开或移出 -> bus.simRelease；
 * 支持多点触控（pointerId 隔离），按住修饰键再点另一个键即可产生组合键。
 * 真实设备按下时，对应虚拟按键也会高亮，便于观察输入总线的统一状态。
 */
(function (global) {
  'use strict';

  var KC = global.KeyCodes;

  // 虚拟键盘布局（取游戏常用键即可，不是全键盘）
  var KB_ROWS = [
    ['Escape', 'F1', 'F2', 'F3', 'F4', 'Tab', 'KeyR', 'KeyE', 'KeyF', 'KeyC', 'KeyH'],
    ['CapsLock', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyJ', 'KeyK', 'KeyP', 'Enter'],
    ['ShiftLeft', 'ControlLeft', 'AltLeft', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']
  ];

  function Simulator(bus) {
    this.bus = bus;
    this.kbRoot = document.getElementById('virtualKeyboard');
    this.gpRoot = document.getElementById('virtualGamepad');
    this.statusEl = document.getElementById('deviceStatus');
    this.pointers = new Map(); // pointerId -> code
    this.keyEls = {};         // code -> element
    this._buildKeyboard();
    this._buildGamepad();
    this._bindHeldHighlight();
    this._refreshDeviceStatus();
    bus.on('device', this._refreshDeviceStatus.bind(this));
  }

  /* ---------- 虚拟键盘 ---------- */

  Simulator.prototype._buildKeyboard = function () {
    var self = this;
    this.kbRoot.innerHTML = '';
    KB_ROWS.forEach(function (row) {
      var rowEl = document.createElement('div');
      rowEl.className = 'vk-row';
      row.forEach(function (code) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'vk-key' + (KC.isModifier(code) ? ' mod' : '');
        btn.dataset.code = code;
        btn.textContent = KC.keyLabel(code);
        self._wirePointer(btn, code, 'keyboard');
        self.keyEls[code] = btn;
        rowEl.appendChild(btn);
      });
      self.kbRoot.appendChild(rowEl);
    });
  };

  /* ---------- 虚拟手柄 ---------- */

  Simulator.prototype._buildGamepad = function () {
    var self = this;
    this.gpRoot.innerHTML = '';

    // 左：十字键 + 左摇杆
    var left = document.createElement('div');
    left.className = 'gp-side';
    var dpad = document.createElement('div');
    dpad.className = 'gp-dpad';
    [
      ['gp:button:12', '↑', 2], ['gp:button:15', '←', 4],
      ['gp:button:13', '↓', 5], ['gp:button:14', '→', 6]
    ].forEach(function (cfg) {
      var b = self._gpButton(cfg[0], cfg[1]);
      b.style.gridColumn = String(cfg[2]);
      dpad.appendChild(b);
    });
    left.appendChild(dpad);
    left.appendChild(this._stick('左摇杆', 0));

    // 右：ABXY + 右摇杆
    var right = document.createElement('div');
    right.className = 'gp-side';
    var abxy = document.createElement('div');
    abxy.className = 'gp-abxy';
    [
      ['gp:button:3', 'Y', 2],
      ['gp:button:2', 'X', 4], ['gp:button:0', 'A', 5], ['gp:button:1', 'B', 6]
    ].forEach(function (cfg) {
      var b = self._gpButton(cfg[0], cfg[1]);
      b.style.gridColumn = String(cfg[2]);
      abxy.appendChild(b);
    });
    right.appendChild(abxy);
    right.appendChild(this._stick('右摇杆', 2));

    // 肩键 / 菜单键
    var misc = document.createElement('div');
    misc.className = 'gp-misc';
    [
      ['gp:button:4', 'LB'], ['gp:button:5', 'RB'],
      ['gp:button:6', 'LT'], ['gp:button:7', 'RT'],
      ['gp:button:8', 'Back'], ['gp:button:9', 'Start'],
      ['gp:button:16', 'Home']
    ].forEach(function (cfg) {
      misc.appendChild(self._gpButton(cfg[0], cfg[1]));
    });

    this.gpRoot.appendChild(left);
    this.gpRoot.appendChild(right);
    this.gpRoot.appendChild(misc);
  };

  Simulator.prototype._gpButton = function (code, label) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'gp-btn';
    b.dataset.code = code;
    b.textContent = label;
    b.title = KC.gamepadLabel(code);
    this._wirePointer(b, code, 'gamepad');
    this.keyEls[code] = b;
    return b;
  };

  // 摇杆：按下后向四个方向滑出即“按下”对应轴方向，松开关闭
  Simulator.prototype._stick = function (label, axisIndex) {
    var self = this;
    var wrap = document.createElement('div');
    wrap.style.textAlign = 'center';
    var pad = document.createElement('div');
    pad.className = 'stick-pad';
    var knob = document.createElement('div');
    knob.className = 'stick-knob';
    pad.appendChild(knob);
    var text = document.createElement('div');
    text.className = 'gp-label';
    text.textContent = label;
    wrap.appendChild(pad);
    wrap.appendChild(text);

    var activeDirs = {};
    function dirFromEvent(e) {
      var rect = pad.getBoundingClientRect();
      var dx = (e.clientX - (rect.left + rect.width / 2)) / (rect.width / 2);
      var dy = (e.clientY - (rect.top + rect.height / 2)) / (rect.height / 2);
      if (Math.abs(dx) < 0.35 && Math.abs(dy) < 0.35) return null;
      if (Math.abs(dx) > Math.abs(dy)) return 'gp:axis:' + axisIndex + ':' + (dx > 0 ? '+' : '-');
      return 'gp:axis:' + (axisIndex + 1) + ':' + (dy > 0 ? '+' : '-');
    }
    function setDir(dir, on) {
      if (!dir) return;
      if (on && !activeDirs[dir]) {
        activeDirs[dir] = true;
        self.bus.simPress(dir, 'gamepad');
        pad.classList.add('active');
        self.keyEls[dir] = pad;
      } else if (!on && activeDirs[dir]) {
        delete activeDirs[dir];
        self.bus.simRelease(dir, 'gamepad');
        if (Object.keys(activeDirs).length === 0) pad.classList.remove('active');
      }
    }

    pad.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { pad.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能无活动指针 */ }
      setDir(dirFromEvent(e), true);
    });
    pad.addEventListener('pointermove', function (e) {
      if (!pad.hasPointerCapture(e.pointerId)) return;
      var dir = dirFromEvent(e);
      // 只保留当前方向：先松开其它
      Object.keys(activeDirs).forEach(function (d) {
        if (d !== dir) setDir(d, false);
      });
      if (dir) setDir(dir, true);
    });
    var releaseAll = function (e) {
      Object.keys(activeDirs).forEach(function (d) { setDir(d, false); });
      try { pad.releasePointerCapture(e.pointerId); } catch (err) {}
    };
    pad.addEventListener('pointerup', releaseAll);
    pad.addEventListener('pointercancel', releaseAll);
    return wrap;
  };

  /* ---------- 通用指针接线 ---------- */

  Simulator.prototype._wirePointer = function (el, code, kind) {
    var self = this;
    el.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件可能无活动指针 */ }
      self.pointers.set(e.pointerId, code);
      self.bus.simPress(code, kind);
    });
    var release = function (e) {
      if (self.pointers.get(e.pointerId) !== code) return;
      self.pointers.delete(e.pointerId);
      self.bus.simRelease(code, kind);
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
  };

  /* ---------- held 状态 -> 虚拟按键高亮（真实/模拟统一） ---------- */

  Simulator.prototype._bindHeldHighlight = function () {
    var self = this;
    setInterval(function () {
      Object.keys(self.keyEls).forEach(function (code) {
        var el = self.keyEls[code];
        if (!el || el.classList.contains('stick-pad')) return;
        el.classList.toggle('pressed', self.bus.held.has(code));
      });
    }, 60);
  };

  /* ---------- 真实设备连接状态 ---------- */

  Simulator.prototype._refreshDeviceStatus = function () {
    var pads = this.bus.listGamepads();
    if (pads.length > 0) {
      var names = pads.map(function (p) { return p.id || '未知手柄'; }).join('；');
      this.statusEl.className = 'device-status online';
      this.statusEl.innerHTML = '<span class="led"></span>已连接 ' + pads.length + ' 个手柄：' +
        Modal.escapeHtml(names);
    } else {
      this.statusEl.className = 'device-status';
      this.statusEl.innerHTML = '<span class="led"></span>未检测到真实手柄（可使用下方模拟手柄）';
    }
  };

  global.Simulator = Simulator;
})(window);
