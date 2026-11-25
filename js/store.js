/*
 * store.js — 场景存取与光照图导出
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'lightlab.scene.v1';

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }

  function triggerDownload(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const Store = {
    STORAGE_KEY,

    autosave(scene) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(scene));
      } catch (e) {
        console.warn('自动保存失败', e);
      }
    },

    loadAutosave() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        console.warn('读取存档失败', e);
        return null;
      }
    },

    clearAutosave() {
      localStorage.removeItem(STORAGE_KEY);
    },

    exportScene(scene) {
      download('lightlab-scene.json', JSON.stringify(scene, null, 2));
    },

    importScene(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          try {
            resolve(JSON.parse(reader.result));
          } catch (e) {
            reject(new Error('JSON 解析失败：' + e.message));
          }
        };
        reader.onerror = () => reject(new Error('文件读取失败'));
        reader.readAsText(file);
      });
    },

    exportLightmap(lightCanvas, scene, mode) {
      downloadCanvas(lightCanvas, 'lightlab-lightmap.png');
      this.exportMapping(lightCanvas.width, lightCanvas.height, scene, mode, 'lightlab-lightmap.png');
    },

    // 只导出坐标映射 JSON（不附带图片）
    exportMapping(width, height, scene, mode, imageName) {
      const mapping = {
        description: '光照图与世界坐标的映射关系：1 世界单位 = 1 像素，原点在左上角',
        image: imageName || null,
        coordinateSystem: {
          origin: { x: 0, y: 0 },
          unitsPerPixel: 1,
          orientation: 'y-down',
        },
        imageSize: { width, height },
        worldBounds: {
          left: 0, top: 0,
          width: scene.world.width, height: scene.world.height,
        },
        transform: {
          // worldX = imageX * scaleX + translateX（本实现中就是恒等映射）
          scaleX: 1, scaleY: 1, translateX: 0, translateY: 0,
        },
        blendMode: mode,
        lights: scene.lights.map(l => ({
          id: l.id, name: l.name, x: l.x, y: l.y,
          color: l.color, radius: l.radius, intensity: l.intensity, on: l.on,
        })),
        exportedAt: new Date().toISOString(),
      };
      download('lightlab-lightmap-mapping.json', JSON.stringify(mapping, null, 2));
    },
  };

  root.Store = Store;
  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
})(typeof window !== 'undefined' ? window : globalThis);
