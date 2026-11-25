/*
 * keycodes.js — 物理按键 / 手柄按钮的码表、名称与合法性校验
 *
 * 键盘统一使用 KeyboardEvent.code（物理位置，不随键盘布局变化）。
 * 手柄使用标准 Gamepad API 的索引编码：
 *   gp:button:<index>          按钮（0..16）
 *   gp:axis:<index>:+ | :-     摇杆/扳机越过死区的方向
 */
(function (global) {
  'use strict';

  // 修饰键（参与组合键）
  var MODIFIERS = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];

  // KeyboardEvent.code -> 中文/通用短名
  var KEY_LABELS = {
    // 功能键
    Escape: 'Esc', Backquote: '`', Tab: 'Tab', CapsLock: 'Caps',
    Backspace: 'Backspace', Enter: 'Enter', Space: 'Space',
    ContextMenu: 'Menu',
    // 数字/字母
    Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
    Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
    KeyA: 'A', KeyB: 'B', KeyC: 'C', KeyD: 'D', KeyE: 'E', KeyF: 'F',
    KeyG: 'G', KeyH: 'H', KeyI: 'I', KeyJ: 'J', KeyK: 'K', KeyL: 'L',
    KeyM: 'M', KeyN: 'N', KeyO: 'O', KeyP: 'P', KeyQ: 'Q', KeyR: 'R',
    KeyS: 'S', KeyT: 'T', KeyU: 'U', KeyV: 'V', KeyW: 'W', KeyX: 'X',
    KeyY: 'Y', KeyZ: 'Z',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/',
    // 编辑区
    Insert: 'Insert', Delete: 'Del', Home: 'Home', End: 'End',
    PageUp: 'PgUp', PageDown: 'PgDn',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    NumpadEnter: '小键盘 Enter',
    // 修饰
    ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
    AltLeft: 'L Alt', AltRight: 'R Alt',
    MetaLeft: 'L Win', MetaRight: 'R Win',
    // F 区
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12'
  };

  // 标准手柄按钮索引（W3C Standard Gamepad）
  var GAMEPAD_BUTTONS = [
    'A（确认）', 'B（取消）', 'X', 'Y',
    'LB 肩键', 'RB 肩键', 'LT 扳机', 'RT 扳机',
    'Back/Select', 'Start', '左摇杆按下', '右摇杆按下',
    '十字键 ↑', '十字键 ↓', '十字键 ←', '十字键 →',
    'Home/Guide'
  ];

  var GAMEPAD_AXES = [
    '左摇杆 水平', '左摇杆 垂直', '右摇杆 水平', '右摇杆 垂直'
  ];

  var MODIFIER_LABEL = {
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
    ShiftLeft: 'Shift', ShiftRight: 'Shift',
    AltLeft: 'Alt', AltRight: 'Alt',
    MetaLeft: 'Win', MetaRight: 'Win'
  };

  function isModifier(code) {
    return MODIFIERS.indexOf(code) !== -1;
  }

  // 左右修饰键归一：Ctrl 左右都算作 Ctrl 参与组合判定
  function normalizeModifier(code) {
    if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
    if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
    if (code === 'MetaLeft' || code === 'MetaRight') return 'Win';
    return null;
  }

  function keyLabel(code) {
    return KEY_LABELS[code] || code;
  }

  function isKnownKeyboardCode(code) {
    return Object.prototype.hasOwnProperty.call(KEY_LABELS, code);
  }

  // 手柄按钮/轴的显示名
  function gamepadLabel(gpCode) {
    var m = /^gp:button:(\d+)$/.exec(gpCode);
    if (m) {
      var i = Number(m[1]);
      return GAMEPAD_BUTTONS[i] || ('按钮 ' + i);
    }
    m = /^gp:axis:(\d+):([+-])$/.exec(gpCode);
    if (m) {
      var ax = Number(m[1]);
      var base = GAMEPAD_AXES[ax] || ('轴 ' + ax);
      return base + (m[2] === '+' ? ' +' : ' −');
    }
    return gpCode;
  }

  function isKnownGamepadCode(gpCode) {
    var m = /^gp:button:(\d+)$/.exec(gpCode);
    if (m) {
      var i = Number(m[1]);
      return i >= 0 && i < GAMEPAD_BUTTONS.length;
    }
    m = /^gp:axis:(\d+):([+-])$/.exec(gpCode);
    if (m) {
      var a = Number(m[1]);
      return a >= 0 && a < GAMEPAD_AXES.length;
    }
    return false;
  }

  function isGamepadCode(code) {
    return code.indexOf('gp:') === 0;
  }

  // 绑定编码的整体合法性校验（导入时使用）
  function isValidBindingCode(code) {
    if (typeof code !== 'string' || code.length === 0) return false;
    if (isGamepadCode(code)) return isKnownGamepadCode(code);
    return isKnownKeyboardCode(code);
  }

  var KeyCodes = {
    MODIFIERS: MODIFIERS,
    KEY_LABELS: KEY_LABELS,
    GAMEPAD_BUTTONS: GAMEPAD_BUTTONS,
    GAMEPAD_AXES: GAMEPAD_AXES,
    isModifier: isModifier,
    normalizeModifier: normalizeModifier,
    keyLabel: keyLabel,
    gamepadLabel: gamepadLabel,
    isKnownKeyboardCode: isKnownKeyboardCode,
    isKnownGamepadCode: isKnownGamepadCode,
    isGamepadCode: isGamepadCode,
    isValidBindingCode: isValidBindingCode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = KeyCodes;
  global.KeyCodes = KeyCodes;
})(typeof window !== 'undefined' ? window : globalThis);
