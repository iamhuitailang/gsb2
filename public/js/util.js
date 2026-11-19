/*
 * util.js — 通用工具（无依赖，浏览器 / Node 均可加载）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpriteUtil = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[c];
    });
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function uid(prefix) {
    return (
      (prefix || 'id') +
      '_' +
      Date.now().toString(36) +
      '_' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  /**
   * 重名处理：同一批名字里出现重复时，从第二个起追加 -1、-2…
   * 后缀同时避开已存在的名字，保证结果两两不同、且不覆盖已有条目。
   * @param {string[]} names 原始名字列表（保持顺序）
   * @returns {string[]} 与输入等长的唯一名字列表
   */
  function uniqueNames(names) {
    var used = Object.create(null);
    return names.map(function (name) {
      var base = String(name || 'sprite');
      if (!used[base]) {
        used[base] = true;
        return base;
      }
      var i = 1;
      var candidate;
      do {
        candidate = base + '-' + i;
        i++;
      } while (used[candidate]);
      used[candidate] = true;
      return candidate;
    });
  }

  /** 去掉文件扩展名，保留目录名以外的纯文件名。 */
  function baseName(fileName) {
    var name = String(fileName || 'sprite');
    var slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (slash >= 0) name = name.slice(slash + 1);
    var dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function downloadBlob(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败: ' + file.name));
      };
      reader.readAsDataURL(file);
    });
  }

  function readFileAsText(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('读取文件失败: ' + file.name));
      };
      reader.readAsText(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        resolve(img);
      };
      img.onerror = function () {
        reject(new Error('图片解码失败'));
      };
      img.src = dataUrl;
    });
  }

  /** 让数值落在 [0,255] 整数。 */
  function u8(v) {
    return clamp(Math.round(v), 0, 255);
  }

  return {
    clamp: clamp,
    escapeHtml: escapeHtml,
    formatBytes: formatBytes,
    uid: uid,
    uniqueNames: uniqueNames,
    baseName: baseName,
    downloadBlob: downloadBlob,
    readFileAsDataURL: readFileAsDataURL,
    readFileAsText: readFileAsText,
    loadImage: loadImage,
    u8: u8,
  };
});
