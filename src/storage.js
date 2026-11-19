/**
 * 本地持久化：
 * - 草稿 JSON（标签、图片元数据、标注、当前图片）存入 localStorage；
 * - 导入图片的原始 Blob 存入 IndexedDB（同名图片刷新后可直接恢复）；
 * - 示例图片不入库，按其 sceneId 在运行时重新绘制。
 * 全部数据只在本机浏览器中，不会上传。
 */

const DB_NAME = 'local-image-annotator';
const DB_VERSION = 1;
const IMAGE_STORE = 'images';
const PROJECT_KEY = 'local-image-annotator:project';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('打开 IndexedDB 失败'));
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, mode);
    const store = tx.objectStore(IMAGE_STORE);
    let result;
    try {
      result = fn(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

export async function putImageBlob(id, blob) {
  await withStore('readwrite', (store) => store.put(blob, id));
}

export async function getImageBlob(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IMAGE_STORE, 'readonly');
    const request = tx.objectStore(IMAGE_STORE).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteImageBlob(id) {
  await withStore('readwrite', (store) => store.delete(id));
}

export async function clearImageBlobs() {
  await withStore('readwrite', (store) => store.clear());
}

export function saveProjectLocal(serialized) {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(serialized));
    return true;
  } catch (error) {
    console.warn('保存草稿到 localStorage 失败', error);
    return false;
  }
}

export function loadProjectLocal() {
  try {
    const text = localStorage.getItem(PROJECT_KEY);
    return text ? JSON.parse(text) : null;
  } catch (error) {
    console.warn('读取本地草稿失败', error);
    return null;
  }
}

export function clearProjectLocal() {
  try {
    localStorage.removeItem(PROJECT_KEY);
  } catch {
    // 忽略
  }
}
