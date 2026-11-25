/*
 * storage.js — 多玩家方案的本地持久化（localStorage）
 * 数据结构：
 * {
 *   version: 1,
 *   activeProfileId: 'p_xxx',
 *   profiles: [ profile, ... ]
 * }
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'gimc.profileStore.v1';
  var Defaults = global.Defaults || (typeof require === 'function' ? require('./defaults.js') : null);

  function hasStorage() {
    try {
      return typeof localStorage !== 'undefined' && !!localStorage;
    } catch (e) {
      return false;
    }
  }

  function load() {
    if (!hasStorage()) return emptyStore();
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return initStore();
      var parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
        return initStore();
      }
      // 基本修复：保证每个 profile 都有必要字段
      parsed.profiles.forEach(repairProfile);
      if (!parsed.profiles.some(function (p) { return p.id === parsed.activeProfileId; })) {
        parsed.activeProfileId = parsed.profiles[0].id;
      }
      return parsed;
    } catch (e) {
      console.warn('配置存储解析失败，回退到默认方案：', e);
      return initStore();
    }
  }

  function save(store) {
    if (!hasStorage()) return false;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
      return true;
    } catch (e) {
      console.error('保存配置失败：', e);
      return false;
    }
  }

  function repairProfile(profile) {
    if (!profile.id) profile.id = 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    if (!Array.isArray(profile.contexts)) profile.contexts = Defaults.cloneDefaults();
    if (!Array.isArray(profile.acknowledgedConflicts)) profile.acknowledgedConflicts = [];
    return profile;
  }

  function emptyStore() {
    return { version: 1, activeProfileId: null, profiles: [] };
  }

  function initStore() {
    var store = emptyStore();
    var p = Defaults.createDefaultProfile('玩家 1');
    store.profiles.push(p);
    store.activeProfileId = p.id;
    save(store);
    return store;
  }

  function getActiveProfile(store) {
    return store.profiles.find(function (p) { return p.id === store.activeProfileId; }) || store.profiles[0];
  }

  function createProfile(store, name, cloneFrom) {
    var base = cloneFrom ? JSON.parse(JSON.stringify(cloneFrom)) : Defaults.createDefaultProfile(name);
    base.id = 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    base.name = (name || '新方案').trim() || '新方案';
    base.createdAt = new Date().toISOString();
    if (!cloneFrom) {
      base.contexts = Defaults.cloneDefaults();
      base.acknowledgedConflicts = [];
    } else {
      // 克隆出来的方案保留冲突确认名单也无妨；重置为空让新主人重新决策
      base.acknowledgedConflicts = [];
    }
    store.profiles.push(base);
    return base;
  }

  function renameProfile(profile, name) {
    var n = (name || '').trim();
    if (n) profile.name = n;
  }

  function deleteProfile(store, profileId) {
    var idx = store.profiles.findIndex(function (p) { return p.id === profileId; });
    if (idx === -1) return false;
    if (store.profiles.length === 1) return false; // 至少保留一个
    store.profiles.splice(idx, 1);
    if (store.activeProfileId === profileId) {
      store.activeProfileId = store.profiles[Math.max(0, idx - 1)].id;
    }
    return true;
  }

  function resetProfile(profile) {
    profile.contexts = Defaults.cloneDefaults();
    profile.acknowledgedConflicts = [];
    return profile;
  }

  function findContext(profile, contextId) {
    return profile.contexts.find(function (c) { return c.id === contextId; }) || null;
  }

  function findAction(profile, contextId, actionId) {
    var ctx = findContext(profile, contextId);
    if (!ctx) return null;
    return ctx.actions.find(function (a) { return a.id === actionId; }) || null;
  }

  var StorageLayer = {
    STORE_KEY: STORE_KEY,
    hasStorage: hasStorage,
    load: load,
    save: save,
    initStore: initStore,
    getActiveProfile: getActiveProfile,
    createProfile: createProfile,
    renameProfile: renameProfile,
    deleteProfile: deleteProfile,
    resetProfile: resetProfile,
    findContext: findContext,
    findAction: findAction,
    repairProfile: repairProfile
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = StorageLayer;
  global.StorageLayer = StorageLayer;
})(typeof window !== 'undefined' ? window : globalThis);
