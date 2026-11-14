import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function newId(prefix = '') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${prefix}${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 待处理文件：保留上传的原始文件，另存一份规范化 CSV 供预览。
 * 只有确认导入后才移除；未识别表头的文件会一直保留等待处理。
 */
export class PendingStore {
  constructor(dir) {
    this.dir = dir;
    ensureDir(dir);
  }

  metaPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  uploadPath(id) {
    return path.join(this.dir, `${id}.upload`);
  }

  csvPath(id) {
    return path.join(this.dir, `${id}.csv`);
  }

  save({ id, filename, uploadBuffer, csvText, headers }) {
    fs.writeFileSync(this.uploadPath(id), uploadBuffer);
    fs.writeFileSync(this.csvPath(id), csvText, 'utf8');
    const record = {
      id,
      filename,
      createdAt: new Date().toISOString(),
      headers,
      status: 'pending',
    };
    writeJsonAtomic(this.metaPath(id), record);
    return record;
  }

  update(id, patch) {
    const record = this.get(id);
    if (!record) return null;
    const next = { ...record, ...patch };
    writeJsonAtomic(this.metaPath(id), next);
    return next;
  }

  get(id) {
    if (!/^imp-[\w-]+$/.test(String(id ?? ''))) return null;
    return readJson(this.metaPath(id));
  }

  readCsv(id) {
    return fs.readFileSync(this.csvPath(id), 'utf8');
  }

  hasUpload(id) {
    return fs.existsSync(this.uploadPath(id));
  }

  readUpload(id) {
    return fs.readFileSync(this.uploadPath(id));
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(this.dir, name)))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  remove(id) {
    fs.rmSync(this.metaPath(id), { force: true });
    fs.rmSync(this.uploadPath(id), { force: true });
    fs.rmSync(this.csvPath(id), { force: true });
  }
}

/**
 * 已确认批次：保存导入时的映射、规则版本、包装表快照与换算结果，不做回溯重算。
 */
export class BatchStore {
  constructor(dir) {
    this.dir = dir;
    ensureDir(dir);
  }

  filePath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  save(batch) {
    writeJsonAtomic(this.filePath(batch.id), batch);
    return batch;
  }

  get(id) {
    if (!/^batch-[\w-]+$/.test(String(id ?? ''))) return null;
    return readJson(this.filePath(id));
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(this.dir, name)))
      .filter(Boolean)
      .sort((a, b) => (a.confirmedAt < b.confirmedAt ? 1 : -1));
  }
}
