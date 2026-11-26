/* 工程持久化：下载 .mgs.json、读取打开、localStorage 自动暂存 */
(function () {
  'use strict';
  const G = (window.Gfx = window.Gfx || {});
  const KEY = 'motion-title-studio:autosave:v1';

  const Storage = {
    /** 序列化为自包含 JSON（图片已是 dataURL） */
    serialize(project) {
      return JSON.stringify({
        app: G.Model.APP_ID,
        version: 1,
        savedAt: new Date().toISOString(),
        project,
      }, null, 2);
    },

    saveToFile(project) {
      const text = Storage.serialize(project);
      const name = (project.name || '未命名工程').replace(/[\\/:*?"<>|]+/g, '_');
      G.util.downloadText(text, `${name}${G.Model.FILE_EXT}`, 'application/json');
    },

    async openFromFile(file) {
      const text = await G.util.readFileAsText(file);
      const raw = JSON.parse(text);
      return G.Model.normalizeProject(raw);
    },

    autosave(project) {
      try {
        localStorage.setItem(KEY, Storage.serialize(project));
        return true;
      } catch (e) {
        // 图片过大可能超配额，自动暂存失败不应影响主流程
        console.warn('自动暂存失败：', e);
        return false;
      }
    },

    loadAutosave() {
      try {
        const text = localStorage.getItem(KEY);
        if (!text) return null;
        return G.Model.normalizeProject(JSON.parse(text));
      } catch (e) {
        console.warn('自动暂存已损坏，忽略：', e);
        return null;
      }
    },

    clearAutosave() {
      try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    },
  };

  G.Storage = Storage;
})();
