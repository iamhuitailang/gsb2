/*
 * defaults.js — 示例映射：菜单、驾驶、步行三个操作情境
 * 存储中只保留 { type, code, modifiers }，显示名在加载时重新计算。
 */
(function (global) {
  'use strict';

  function kb(code, modifiers) {
    return { type: 'keyboard', code: code, modifiers: Array.isArray(modifiers) ? modifiers : [] };
  }
  function gp(code) {
    return { type: 'gamepad', code: code };
  }

  var SCHEMA_VERSION = 1;

  var DEFAULT_CONTEXTS = [
    {
      id: 'menu',
      name: '菜单',
      icon: '📋',
      description: '界面导航与暂停菜单',
      actions: [
        { id: 'menu.up', name: '向上移动', desc: '菜单光标上移', bindings: { primary: kb('KeyW'), secondary: gp('gp:axis:1:-') } },
        { id: 'menu.down', name: '向下移动', desc: '菜单光标下移', bindings: { primary: kb('KeyS'), secondary: gp('gp:axis:1:+') } },
        { id: 'menu.left', name: '向左移动', desc: '菜单光标左移', bindings: { primary: kb('KeyA'), secondary: gp('gp:axis:0:-') } },
        { id: 'menu.right', name: '向右移动', desc: '菜单光标右移', bindings: { primary: kb('KeyD'), secondary: gp('gp:axis:0:+') } },
        { id: 'menu.confirm', name: '确认', desc: '选中菜单项', bindings: { primary: kb('Enter'), secondary: gp('gp:button:0') } },
        { id: 'menu.back', name: '返回', desc: '返回上一级', bindings: { primary: kb('Escape'), secondary: gp('gp:button:1') } },
        { id: 'menu.pause', name: '暂停', desc: '打开暂停菜单', bindings: { primary: kb('KeyP'), secondary: gp('gp:button:9') } }
      ]
    },
    {
      id: 'driving',
      name: '驾驶',
      icon: '🚗',
      description: '车辆驾驶中的操作',
      actions: [
        { id: 'drive.steerLeft', name: '左转', desc: '方向盘向左', bindings: { primary: kb('KeyA'), secondary: gp('gp:axis:0:-') } },
        { id: 'drive.steerRight', name: '右转', desc: '方向盘向右', bindings: { primary: kb('KeyD'), secondary: gp('gp:axis:0:+') } },
        { id: 'drive.accelerate', name: '油门', desc: '加速前进', bindings: { primary: kb('KeyW'), secondary: gp('gp:button:7') } },
        { id: 'drive.brake', name: '刹车 / 倒车', desc: '减速或倒车', bindings: { primary: kb('KeyS'), secondary: gp('gp:button:6') } },
        { id: 'drive.handbrake', name: '手刹', desc: '手刹漂移', bindings: { primary: kb('Space'), secondary: gp('gp:button:5') } },
        { id: 'drive.horn', name: '喇叭', desc: '鸣笛', bindings: { primary: kb('KeyH'), secondary: gp('gp:button:3') } },
        { id: 'drive.camera', name: '切换视角', desc: '近景 / 远景 / 第一人称', bindings: { primary: kb('KeyC'), secondary: gp('gp:button:2') } },
        { id: 'drive.exit', name: '下车', desc: '离开车辆', bindings: { primary: kb('KeyF'), secondary: gp('gp:button:1') } },
        { id: 'drive.pause', name: '暂停', desc: '打开暂停菜单', bindings: { primary: kb('KeyP'), secondary: gp('gp:button:9') } }
      ]
    },
    {
      id: 'onFoot',
      name: '步行',
      icon: '🚶',
      description: '角色徒步探索与战斗',
      actions: [
        { id: 'foot.forward', name: '前进', desc: '向前移动', bindings: { primary: kb('KeyW'), secondary: gp('gp:axis:1:-') } },
        { id: 'foot.back', name: '后退', desc: '向后移动', bindings: { primary: kb('KeyS'), secondary: gp('gp:axis:1:+') } },
        { id: 'foot.left', name: '左移', desc: '向左侧移动', bindings: { primary: kb('KeyA'), secondary: gp('gp:axis:0:-') } },
        { id: 'foot.right', name: '右移', desc: '向右侧移动', bindings: { primary: kb('KeyD'), secondary: gp('gp:axis:0:+') } },
        { id: 'foot.jump', name: '跳跃', desc: '跳跃 / 翻越', bindings: { primary: kb('Space'), secondary: gp('gp:button:0') } },
        { id: 'foot.sprint', name: '冲刺', desc: '按住加速奔跑', bindings: { primary: kb('ShiftLeft'), secondary: gp('gp:button:10') } },
        { id: 'foot.crouch', name: '蹲下', desc: '下蹲潜行', bindings: { primary: kb('ControlLeft'), secondary: gp('gp:button:11') } },
        { id: 'foot.interact', name: '互动', desc: '拾取 / 开门 / 对话', bindings: { primary: kb('KeyE'), secondary: gp('gp:button:3') } },
        { id: 'foot.reload', name: '装填', desc: '重新装填弹药', bindings: { primary: kb('KeyR'), secondary: gp('gp:button:2') } },
        { id: 'foot.primaryFire', name: '主攻击', desc: '开火 / 使用手持物品', bindings: { primary: kb('KeyJ'), secondary: gp('gp:button:7') } },
        { id: 'foot.secondaryFire', name: '瞄准', desc: '举枪瞄准', bindings: { primary: kb('KeyK'), secondary: gp('gp:button:6') } },
        { id: 'foot.weaponWheel', name: '武器轮盘', desc: '按住打开武器轮盘', bindings: { primary: kb('Tab'), secondary: gp('gp:button:4') } },
        { id: 'foot.pause', name: '暂停', desc: '打开暂停菜单', bindings: { primary: kb('KeyP'), secondary: gp('gp:button:9') } }
      ]
    }
  ];

  // 深拷贝默认情境（避免改到常量）
  function cloneDefaults() {
    return JSON.parse(JSON.stringify(DEFAULT_CONTEXTS));
  }

  function createDefaultProfile(name) {
    return {
      id: 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      name: name || '玩家 1',
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      contexts: cloneDefaults(),
      // 用户确认“有意复用”的冲突 key 列表
      acknowledgedConflicts: []
    };
  }

  var Defaults = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_CONTEXTS: DEFAULT_CONTEXTS,
    cloneDefaults: cloneDefaults,
    createDefaultProfile: createDefaultProfile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Defaults;
  global.Defaults = Defaults;
})(typeof window !== 'undefined' ? window : globalThis);
