// 单文件 JSON 状态仓库。所有写入串行化并原子落盘；测试可关闭持久化走纯内存。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowSeconds } from './util.js';

const EMPTY_STATE = () => ({
  version: 1,
  users: [],
  tickets: [],
  clients: [],
  grants: [],
  accessTokens: [],
  refreshTokens: [],
  codes: [],
  sessions: [],
  pending: [],
});

export class Store {
  constructor({ file = null, auditFile = null, persist = true } = {}) {
    this.file = file;
    this.auditFile = auditFile;
    this.persist = persist && Boolean(file);
    this.state = EMPTY_STATE();
    this._queue = Promise.resolve();
    this._auditQueue = Promise.resolve();
  }

  static async open(opts) {
    const store = new Store(opts);
    await store.load();
    return store;
  }

  async load() {
    if (!this.persist) return this;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...EMPTY_STATE(), ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = EMPTY_STATE();
    }
    return this;
  }

  // 串行执行读改写，避免并发请求互相覆盖。
  transaction(fn) {
    const run = async () => {
      try {
        const result = await fn(this.state);
        await this._flush();
        return result;
      } catch (err) {
        // 回调抛错前可能已修改状态（例如授权码复用时吊销全部凭据），
        // 必须同样落盘，否则撤销只停留在内存。
        await this._flush().catch(() => {});
        throw err;
      }
    };
    const next = this._queue.then(run, run);
    // 保持队列不因单次失败中断
    this._queue = next.catch(() => {});
    return next;
  }

  async _flush() {
    if (!this.persist) return;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
  }

  audit(event) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
    this._auditQueue = this._auditQueue.then(async () => {
      if (!this.auditFile) {
        if (process.env.GSB_AUDIT_STDOUT === '1') process.stdout.write(line);
        return;
      }
      await fsp.mkdir(path.dirname(this.auditFile), { recursive: true });
      await fsp.appendFile(this.auditFile, line, { mode: 0o600 });
    }).catch(() => {});
    return this._auditQueue;
  }

  // 清理过期的一次性数据（授权码 / 会话 / 待确认请求 / 过期令牌）。
  async sweep() {
    const now = nowSeconds();
    return this.transaction((s) => {
      s.codes = s.codes.filter((c) => c.expiresAt > now - 300);
      s.pending = s.pending.filter((p) => p.expiresAt > now);
      s.sessions = s.sessions.filter((x) => x.expiresAt > now);
      s.accessTokens = s.accessTokens.filter((t) => t.expiresAt > now - 86400);
      s.refreshTokens = s.refreshTokens.filter((t) => t.expiresAt > now);
    });
  }
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}
