/*
 * storage.js — 项目持久化
 *  - localStorage 自动保存：重开页面继续编辑（含关注区、各尺寸裁切框、锁定状态）
 *  - 项目 JSON 导入/导出：图片以 dataURL 内嵌，单文件即可迁移
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.SCStorage = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const AUTOSAVE_KEY = 'smart-cropper:autosave:v1';
  const FORMAT_VERSION = 1;

  function safeStorage() {
    try {
      const t = '__sc_test__';
      localStorage.setItem(t, t);
      localStorage.removeItem(t);
      return localStorage;
    } catch (e) {
      return null;
    }
  }

  /**
   * 序列化项目。imageDataUrl 可能很大，自动保存前由调用方压缩为 JPEG；
   * 导出项目时保留原始 dataURL（PNG 上传图也不二次压缩）。
   */
  function serialize(project, imageDataUrl) {
    return JSON.stringify({
      formatVersion: FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      project,
      image: imageDataUrl || null,
    });
  }

  function autosave(project, imageDataUrl) {
    const ls = safeStorage();
    if (!ls) return { ok: false, reason: 'localStorage 不可用（可能是隐私模式）' };
    try {
      ls.setItem(AUTOSAVE_KEY, serialize(project, imageDataUrl));
      return { ok: true };
    } catch (e) {
      // 配额超限：尝试更低 JPEG 质量后由 app 重试一次
      return { ok: false, reason: e && e.name === 'QuotaExceededError' ? '存储配额不足' : String(e) };
    }
  }

  function loadAutosave() {
    const ls = safeStorage();
    if (!ls) return null;
    const raw = ls.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.project) return null;
      return parsed;
    } catch (e) {
      return null;
    }
  }

  function clearAutosave() {
    const ls = safeStorage();
    if (ls) ls.removeItem(AUTOSAVE_KEY);
  }

  /** 导出为 .json 文件下载 */
  function downloadJSON(filename, project, imageDataUrl) {
    const blob = new Blob([serialize(project, imageDataUrl)], { type: 'application/json' });
    triggerDownload(URL.createObjectURL(blob), filename);
  }

  /** 读取用户选择的项目 JSON */
  function readProjectFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || !parsed.project || !parsed.image) {
            reject(new Error('项目文件缺少 project 或 image 字段'));
            return;
          }
          resolve(parsed);
        } catch (e) {
          reject(new Error('JSON 解析失败：' + e.message));
        }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsText(file);
    });
  }

  function triggerDownload(href, filename) {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      if (href.startsWith('blob:')) URL.revokeObjectURL(href);
    }, 200);
  }

  /** 把任意 canvas 压成 JPEG dataURL，用于自动保存控体积 */
  function canvasToJPEG(canvas, quality) {
    return canvas.toDataURL('image/jpeg', quality == null ? 0.82 : quality);
  }

  return {
    AUTOSAVE_KEY,
    FORMAT_VERSION,
    autosave,
    loadAutosave,
    clearAutosave,
    downloadJSON,
    readProjectFile,
    triggerDownload,
    canvasToJPEG,
    serialize,
  };
});
