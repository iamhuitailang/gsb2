// 本机持久化（IndexedDB）：项目、示例素材缓存
const DB_NAME = "gss-studio";
const DB_VER = 1;
const STORE = "kv";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

export async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readonly").get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDel(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readwrite").delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function idbAllKeys() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = tx(db, "readonly").getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- 项目存档 ----
const INDEX_KEY = "project-index";

export async function saveProjectRecord(record) {
  const index = (await idbGet(INDEX_KEY)) || {};
  index[record.id] = {
    id: record.id,
    name: record.name,
    updatedAt: record.updatedAt,
  };
  await idbSet(`project:${record.id}`, record);
  await idbSet(INDEX_KEY, index);
}

export async function listProjectRecords() {
  const index = (await idbGet(INDEX_KEY)) || {};
  return Object.values(index).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadProjectRecord(id) {
  return idbGet(`project:${id}`);
}

export async function deleteProjectRecord(id) {
  await idbDel(`project:${id}`);
  const index = (await idbGet(INDEX_KEY)) || {};
  delete index[id];
  await idbSet(INDEX_KEY, index);
}

export async function autosaveProject(record) {
  await idbSet("autosave", record);
}

export async function loadAutosave() {
  return idbGet("autosave");
}
