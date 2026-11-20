/**
 * 浏览器端持久化：
 * - IndexedDB 保存音频 Blob（按 SHA-256 内容寻址），使工程文件重新打开后仍可继续编辑；
 * - IndexedDB 保存自动恢复草稿；
 * - 不支持 IndexedDB 时静默降级，工程仍可导出/导入。
 */

const DB_NAME = 'gsb2-annotator';
const DB_VERSION = 1;
const AUDIO_STORE = 'audio';
const DRAFT_STORE = 'drafts';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE);
      if (!db.objectStoreNames.contains(DRAFT_STORE)) db.createObjectStore(DRAFT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn('[storage] IndexedDB 不可用', request.error);
      resolve(null);
    };
  });
  return dbPromise;
}

async function withStore(storeName, mode, action) {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    let request;
    try {
      const transaction = db.transaction(storeName, mode);
      request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request?.result ?? null);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    } catch (error) {
      reject(error);
    }
  });
}

export async function hashBlob(blob) {
  if (!blob) return null;
  const data = await blob.arrayBuffer();
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', data);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* 非安全上下文时降级 */
    }
  }
  // 非 HTTPS / 旧浏览器没有 crypto.subtle：用长度 + 采样字节做稳定键，
  // 只用于本机缓存去重，不需要密码学强度。
  const view = new Uint8Array(data);
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(view.length / 65536));
  for (let i = 0; i < view.length; i += step) {
    hash ^= view[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `fallback-${view.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

export async function saveAudioBlob(key, blob) {
  return withStore(AUDIO_STORE, 'readwrite', (store) => store.put(blob, key));
}

export async function loadAudioBlob(key) {
  if (!key) return null;
  try {
    return await withStore(AUDIO_STORE, 'readonly', (store) => store.get(key));
  } catch (error) {
    console.warn('[storage] 读取音频失败', error);
    return null;
  }
}

export async function deleteAudioBlob(key) {
  if (!key) return;
  try {
    await withStore(AUDIO_STORE, 'readwrite', (store) => store.delete(key));
  } catch {
    /* noop */
  }
}

export async function saveDraft(projectDoc) {
  try {
    await withStore(DRAFT_STORE, 'readwrite', (store) =>
      store.put({ savedAt: Date.now(), project: projectDoc }, 'latest'),
    );
  } catch (error) {
    console.warn('[storage] 草稿保存失败', error);
  }
}

export async function loadDraft() {
  try {
    return await withStore(DRAFT_STORE, 'readonly', (store) => store.get('latest'));
  } catch {
    return null;
  }
}

export async function clearDraft() {
  try {
    await withStore(DRAFT_STORE, 'readwrite', (store) => store.delete('latest'));
  } catch {
    /* noop */
  }
}
