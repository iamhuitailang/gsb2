/**
 * Original-file access and re-linking.
 *
 * ChromaDeck never writes to the user's source files. It only keeps a read
 * reference. Where the browser supports the File System Access API we persist
 * that reference in IndexedDB so reopening a project can re-use the same file
 * without copying it. Elsewhere (and whenever permission was not granted) the
 * user gets an explicit "re-link originals" flow that matches files by
 * name + size + lastModified.
 */

const DB_NAME = 'chromadeck-files';
const DB_VERSION = 1;
const STORE = 'handles';

function supportsFileHandles() {
  return typeof globalThis.showOpenFilePicker === 'function';
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开 IndexedDB 失败'));
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let request;
      try {
        request = fn(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => {
        // IDB requests expose their value on `.result`; plain values pass through.
        resolve(request && 'result' in request ? request.result : request);
      };
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务被中止'));
    });
  } finally {
    db.close();
  }
}

export async function putFileHandle(key, handle) {
  try {
    await withStore('readwrite', (store) => store.put(handle, key));
    return true;
  } catch {
    return false;
  }
}

export async function getFileHandle(key) {
  try {
    return await withStore('readonly', (store) => store.get(key)) || null;
  } catch {
    return null;
  }
}

export async function deleteFileHandle(key) {
  try {
    await withStore('readwrite', (store) => store.delete(key));
    return true;
  } catch {
    return false;
  }
}

export async function clearFileHandles() {
  try {
    await withStore('readwrite', (store) => store.clear());
    return true;
  } catch {
    return false;
  }
}

export async function pickImageFiles({ multiple = true } = {}) {
  if (supportsFileHandles()) {
    try {
      const handles = await globalThis.showOpenFilePicker({
        multiple,
        types: [
          {
            description: '图片',
            accept: {
              'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']
            }
          }
        ],
        excludeAcceptAllOption: false
      });
      return Promise.all(
        handles.map(async (handle) => ({
          file: await handle.getFile(),
          handle
        }))
      );
    } catch (error) {
      if (error?.name === 'AbortError') return [];
      // Not a secure context, policy-blocked, or an unsupported option: fall
      // back to a plain file input instead of failing the import outright.
      console.warn('[file-store] showOpenFilePicker 不可用，改用 <input type=file>', error);
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.avif';
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener('change', () => {
      finish(Array.from(input.files || []).map((file) => ({ file, handle: null })));
    });
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

export async function pickImageFile() {
  const picked = await pickImageFiles({ multiple: false });
  return picked[0] || null;
}

/**
 * Verify that a persisted handle still points at an accessible file. If
 * `interactive` is true and permission is not yet granted, ask for it (this
 * must be triggered from a user gesture).
 */
export async function resolveHandle(handle, { interactive = false } = {}) {
  if (!handle) return { file: null, reason: 'missing' };
  try {
    const options = { mode: 'read' };
    if (typeof handle.queryPermission === 'function') {
      const state = await handle.queryPermission(options);
      if (state === 'granted' || (state === 'prompt' && !interactive)) {
        if (state === 'granted') return { file: await handle.getFile(), reason: 'granted' };
        return { file: null, reason: 'prompt' };
      }
      if (state === 'denied') return { file: null, reason: 'denied' };
    }
    if (interactive && typeof handle.requestPermission === 'function') {
      const state = await handle.requestPermission(options);
      if (state === 'granted') return { file: await handle.getFile(), reason: 'granted' };
      return { file: null, reason: state };
    }
    return { file: null, reason: 'prompt' };
  } catch (error) {
    return { file: null, reason: 'error', error };
  }
}

export function fileRefSignature(ref) {
  if (!ref) return '';
  return `${ref.name}|${ref.size}|${ref.lastModified}`;
}

/**
 * Match newly supplied files against images that need re-linking.
 * Returns { matches: Map<imageId, {file, handle}>, unmatchedFiles: File[] }.
 *
 * First tries the exact (name, size, lastModified) triple; falls back to
 * (name, size) because copying a file can change its mtime.
 */
export function matchFilesToImages(images, picked) {
  const matches = new Map();
  const pool = picked.filter((entry) => entry?.file);
  const used = new Set();
  const claim = (image, index) => {
    used.add(index);
    matches.set(image.record.id, pool[index]);
  };
  for (const image of images) {
    if (!image.needsRelink) continue;
    const target = fileRefSignature(image.record.fileRef);
    let index = pool.findIndex((entry, i) => !used.has(i) && fileRefSignature(entry.file) === target);
    if (index < 0) {
      index = pool.findIndex(
        (entry, i) =>
          !used.has(i) &&
          entry.file.name === image.record.fileRef.name &&
          entry.file.size === image.record.fileRef.size
      );
    }
    if (index >= 0) claim(image, index);
  }
  const unmatchedFiles = pool.filter((_, i) => !used.has(i));
  return { matches, unmatchedFiles };
}

export { supportsFileHandles };
