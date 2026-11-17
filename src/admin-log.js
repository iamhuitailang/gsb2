import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 1000;

/**
 * 管理员审计日志。
 *
 * 写入本地 JSONL 文件，同时在内存里保留最近若干条供本地页面展示。
 * 日志会记录受限生效的层（account / source），但对外响应始终保持一致。
 */
export class AdminLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  write(entry) {
    const record = { at: new Date().toISOString(), ...entry };
    this.entries.push(record);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }

  recent(limit = 50) {
    const requested = Number(limit);
    const count = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), MAX_ENTRIES)
      : 50;
    return this.entries.slice(-count).reverse();
  }
}
