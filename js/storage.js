/*
 * 排版/播放预设的本地持久化（localStorage）。
 * 同时负责草稿文本的自动保存。
 */
(function (global) {
  'use strict';

  const PRESET_KEY = 'tt.presets.v1';
  const DRAFT_KEY = 'tt.draft.v1';

  function safeParse(raw, fallback) {
    try {
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function listPresets() {
    const all = safeParse(localStorage.getItem(PRESET_KEY), {});
    return Object.keys(all).map((name) => ({ name, data: all[name] }));
  }

  function savePreset(name, data) {
    if (!name || !/^[\w一-龥 .\-]{1,32}$/.test(name)) {
      throw new Error('预设名称需为 1–32 个字符（中英文、数字、空格、-_.）');
    }
    const all = safeParse(localStorage.getItem(PRESET_KEY), {});
    all[name] = {
      layout: data.layout,
      playback: data.playback,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  }

  function loadPreset(name) {
    const all = safeParse(localStorage.getItem(PRESET_KEY), {});
    return all[name] || null;
  }

  function deletePreset(name) {
    const all = safeParse(localStorage.getItem(PRESET_KEY), {});
    delete all[name];
    localStorage.setItem(PRESET_KEY, JSON.stringify(all));
  }

  function saveDraft(text, layoutCfg, playbackCfg) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        text, layout: layoutCfg, playback: playbackCfg, savedAt: new Date().toISOString()
      }));
    } catch (e) { /* 配额满时静默失败 */ }
  }

  function loadDraft() {
    return safeParse(localStorage.getItem(DRAFT_KEY), null);
  }

  global.TT = global.TT || {};
  global.TT.storage = { listPresets, savePreset, loadPreset, deletePreset, saveDraft, loadDraft };
})(typeof window !== 'undefined' ? window : globalThis);
