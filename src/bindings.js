/*
 * bindings.js — 绑定的纯逻辑：归一化、签名、组合键前缀、冲突检测、
 *               按键状态到操作的解析、导入校验。
 * 无 DOM 依赖，可直接在 Node 下做单元测试（见 tests/bindings.test.js）。
 */
(function (global) {
  'use strict';

  var KC = global.KeyCodes || (typeof require === 'function' ? require('./keycodes.js') : null);

  /* ---------- 绑定对象的归一化 ---------- */

  // 兼容多种历史写法："Ctrl+K" / ["ControlLeft","KeyK"] / {type,code,modifiers}
  // 统一输出 { type:'keyboard'|'gamepad', code, modifiers:[物理code...], display, raw }
  function normalizeBinding(input) {
    if (input == null) return null;

    // 结构化对象
    if (typeof input === 'object') {
      if (input.type === 'gamepad' && typeof input.code === 'string') {
        return makeGamepad(input.code);
      }
      if (input.type === 'keyboard') {
        var mods = Array.isArray(input.modifiers) ? input.modifiers.slice() : [];
        var tail = input.code;
        if (!tail && typeof input.key === 'string') tail = input.key;
        if (typeof tail !== 'string') return null;
        return makeKeyboard(tail, mods);
      }
      // 没有 type 但形如 { code: 'gp:...' }
      if (typeof input.code === 'string' && KC.isGamepadCode(input.code)) {
        return makeGamepad(input.code);
      }
      if (typeof input.code === 'string') {
        return makeKeyboard(input.code, Array.isArray(input.modifiers) ? input.modifiers : []);
      }
      return null;
    }

    if (typeof input !== 'string' || input.length === 0) return null;

    // 手柄字符串
    if (KC.isGamepadCode(input)) return makeGamepad(input);

    // "Ctrl+Shift+K" / 纯 "KeyK"
    var parts = input.split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    if (parts.length === 0) return null;

    var tail2 = parts[parts.length - 1];
    var modTokens = parts.slice(0, parts.length - 1);
    var mods2 = [];
    for (var i = 0; i < modTokens.length; i++) {
      var phys = modifierTokenToCode(modTokens[i]);
      if (!phys) return null;
      if (mods2.indexOf(phys) === -1) mods2.push(phys);
    }
    return makeKeyboard(tail2, mods2);
  }

  function modifierTokenToCode(token) {
    switch (token.toLowerCase()) {
      case 'ctrl': case 'control': return 'ControlLeft';
      case 'shift': return 'ShiftLeft';
      case 'alt': return 'AltLeft';
      case 'meta': case 'win': case 'cmd': return 'MetaLeft';
      default: return null;
    }
  }

  function makeKeyboard(code, modifiers) {
    var mods = (modifiers || []).filter(function (m) { return KC.isModifier(m); });
    // 去重（按归一化后的修饰类别）
    var seen = {};
    mods = mods.filter(function (m) {
      var n = KC.normalizeModifier(m);
      if (seen[n]) return false;
      seen[n] = true;
      return true;
    });
    if (KC.isModifier(code)) {
      // 单独绑定修饰键：无附加修饰
      return {
        type: 'keyboard', code: code, modifiers: [],
        display: KC.keyLabel(code), signature: code
      };
    }
    return {
      type: 'keyboard',
      code: code,
      modifiers: mods,
      display: mods.map(function (m) { return KC.normalizeModifier(m); }).join(' + ') +
        (mods.length ? ' + ' : '') + KC.keyLabel(code),
      signature: chordSignature(code, mods)
    };
  }

  function makeGamepad(code) {
    return {
      type: 'gamepad',
      code: code,
      modifiers: [],
      display: KC.gamepadLabel(code),
      signature: code
    };
  }

  // 组合键签名：修饰键按类别排序后拼接，保证 Ctrl+K 与 按下右Ctrl+K 视为同一绑定
  function chordSignature(code, modifiers) {
    var names = (modifiers || []).map(function (m) { return KC.normalizeModifier(m); }).sort();
    return names.concat([code]).join('+');
  }

  /* ---------- 组合键前缀判定 ---------- */

  // 返回一个键盘绑定的“部件”：修饰类别集合 + 主键
  function chordParts(binding) {
    if (!binding || binding.type !== 'keyboard') return null;
    return {
      modSet: binding.modifiers.map(function (m) { return KC.normalizeModifier(m); }),
      code: binding.code
    };
  }

  // a 是否是 b 的严格前缀（a 更短）。
  // 例：Ctrl 是 Ctrl+K 的前缀；Ctrl+K 是 Ctrl+Shift+K 的前缀；
  //     单键 K 不算 Ctrl+K 的前缀（主键不同，且没有组合语义）。
  function isStrictPrefix(a, b) {
    var pa = chordParts(a), pb = chordParts(b);
    if (!pa || !pb) return false;
    if (pa.modSet.length >= pb.modSet.length) return false;
    // 短的那一个必须“全是修饰键”（单独的修饰绑定，或修饰组合本身），
    // 即主键本身也是修饰键且没有非修饰主键
    var aIsModifierOnly = KC.isModifier(pa.code) && pa.modSet.length === 0;
    if (!aIsModifierOnly) return false;
    var aMod = KC.normalizeModifier(pa.code);
    return pb.modSet.indexOf(aMod) !== -1;
  }

  /* ---------- 冲突检测 ----------
   * 只在同一情境内部检测；键盘与手柄互不冲突（不同设备）。
   * 三类：
   *   duplicate —— 完全相同的按键/组合键被多个操作占用
   *   prefix    —— 组合键前缀冲突（按下前缀键会立刻触发另一个操作）
   *   gamepad   —— 同一个手柄按钮/轴方向被多个操作占用
   */
  function detectConflicts(context) {
    var conflicts = [];
    if (!context || !Array.isArray(context.actions)) return conflicts;

    var entries = []; // { actionId, actionName, slot, binding }
    context.actions.forEach(function (action) {
      ['primary', 'secondary'].forEach(function (slot) {
        var raw = action.bindings && action.bindings[slot];
        var b = normalizeBinding(raw);
        if (b) entries.push({ actionId: action.id, actionName: action.name, slot: slot, binding: b });
      });
    });

    // 1) 重复：相同签名
    var bySig = {};
    entries.forEach(function (e) {
      if (e.binding.type !== 'keyboard') return;
      (bySig[e.binding.signature] = bySig[e.binding.signature] || []).push(e);
    });
    Object.keys(bySig).forEach(function (sig) {
      var group = bySig[sig];
      if (group.length < 2) return;
      // 同一操作的主副槽重复也提示（副绑定不会有机会触发）
      conflicts.push({
        kind: 'duplicate',
        signature: sig,
        display: group[0].binding.display,
        entries: group.map(slim)
      });
    });

    // 2) 组合键前缀：修饰键（或其组合）本身被绑定，且存在以它为前缀的组合键
    var kbEntries = entries.filter(function (e) { return e.binding.type === 'keyboard'; });
    var reportedPrefix = {};
    kbEntries.forEach(function (shortEntry) {
      kbEntries.forEach(function (longEntry) {
        if (shortEntry === longEntry) return;
        if (!isStrictPrefix(shortEntry.binding, longEntry.binding)) return;
        var key = shortEntry.binding.signature + '||' + longEntry.binding.signature;
        if (reportedPrefix[key]) return;
        reportedPrefix[key] = true;
        conflicts.push({
          kind: 'prefix',
          signature: key,
          display: shortEntry.binding.display + '  ⟶  ' + longEntry.binding.display,
          entries: [slim(shortEntry), slim(longEntry)]
        });
      });
    });

    // 3) 手柄按钮重复
    var byGp = {};
    entries.forEach(function (e) {
      if (e.binding.type !== 'gamepad') return;
      (byGp[e.binding.code] = byGp[e.binding.code] || []).push(e);
    });
    Object.keys(byGp).forEach(function (code) {
      var group = byGp[code];
      if (group.length < 2) return;
      conflicts.push({
        kind: 'gamepad',
        signature: code,
        display: KC.gamepadLabel(code),
        entries: group.map(slim)
      });
    });

    return conflicts;
  }

  function slim(e) {
    return { actionId: e.actionId, actionName: e.actionName, slot: e.slot, display: e.binding.display };
  }

  // 冲突的稳定标识，用于“已知晓/有意复用”名单
  function conflictAckKey(conflict) {
    return conflict.kind + '|' + conflict.entries
      .map(function (e) { return e.actionId + ':' + e.slot; })
      .sort().join('|');
  }

  function isAcked(conflict, ackList) {
    if (!Array.isArray(ackList)) return false;
    var key = conflictAckKey(conflict);
    return ackList.some(function (a) {
      return typeof a === 'string' ? a === key : a && a.key === key;
    });
  }

  /* ---------- 按下状态 -> 生效操作 ---------- */

  // held: Set<物理 code>（键盘）或 Set<gp code>（手柄），由 InputBus 维护
  // 返回当前应当处于“按下”状态的操作 id 集合
  function resolveActiveActions(context, held) {
    var active = {};
    if (!context || !Array.isArray(context.actions)) return active;
    context.actions.forEach(function (action) {
      ['primary', 'secondary'].forEach(function (slot) {
        var b = normalizeBinding(action.bindings && action.bindings[slot]);
        if (!b) return;
        if (bindingIsHeld(b, held)) active[action.id] = true;
      });
    });
    return active;
  }

  function bindingIsHeld(binding, held) {
    if (binding.type === 'gamepad') return held.has(binding.code);
    if (!held.has(binding.code)) return false;
    for (var i = 0; i < binding.modifiers.length; i++) {
      if (!held.has(binding.modifiers[i])) return false;
    }
    return true;
  }

  /* ---------- 导入校验 ---------- */

  // 校验单条绑定，返回 { ok, binding, reason }
  function validateBinding(input) {
    if (input == null || (typeof input === 'string' && input.trim() === '')) {
      return { ok: false, reason: 'empty' };
    }
    var b = normalizeBinding(input);
    if (!b) return { ok: false, reason: 'malformed' };
    if (b.type === 'keyboard' && !KC.isKnownKeyboardCode(b.code)) {
      return { ok: false, reason: 'unknown-key', binding: b };
    }
    if (b.type === 'gamepad' && !KC.isKnownGamepadCode(b.code)) {
      return { ok: false, reason: 'unknown-gamepad', binding: b };
    }
    // 修饰键列表里出现无法识别的内容
    if (b.type === 'keyboard') {
      for (var i = 0; i < b.modifiers.length; i++) {
        if (!KC.isModifier(b.modifiers[i])) {
          return { ok: false, reason: 'unknown-modifier', binding: b };
        }
      }
    }
    return { ok: true, binding: b };
  }

  var Bindings = {
    normalizeBinding: normalizeBinding,
    chordSignature: chordSignature,
    chordParts: chordParts,
    isStrictPrefix: isStrictPrefix,
    detectConflicts: detectConflicts,
    conflictAckKey: conflictAckKey,
    isAcked: isAcked,
    resolveActiveActions: resolveActiveActions,
    bindingIsHeld: bindingIsHeld,
    validateBinding: validateBinding
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Bindings;
  global.Bindings = Bindings;
})(typeof window !== 'undefined' ? window : globalThis);
