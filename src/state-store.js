import fs from 'node:fs';
import path from 'node:path';

/**
 * 限流状态持久化。
 *
 * 只保存“失败时间戳”和演示时钟偏移量，判定永远基于绝对时间戳。
 * 服务重启后读取的是同一批时间戳，所以截止时间不会因为重启而重置。
 */
export class StateStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return emptyState();
    }
    const raw = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`无法解析状态文件 ${this.filePath}: ${error.message}`);
    }
    return normalizeState(parsed);
  }

  save(state) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }
}

export function emptyState() {
  // 账号名 / 来源标识来自用户输入，使用无原型对象避免 __proto__ 之类的键。
  return { version: 1, clockOffsetMs: 0, accounts: Object.create(null), sources: Object.create(null) };
}

function normalizeState(value) {
  const state = emptyState();
  if (!value || typeof value !== 'object') return state;
  if (Number.isFinite(value.clockOffsetMs)) state.clockOffsetMs = value.clockOffsetMs;

  for (const bucket of ['accounts', 'sources']) {
    const source = value[bucket];
    if (!source || typeof source !== 'object') continue;
    for (const [key, entry] of Object.entries(source)) {
      const failures = Array.isArray(entry?.failures)
        ? entry.failures.filter((ts) => Number.isFinite(ts)).sort((a, b) => a - b)
        : [];
      if (failures.length > 0) state[bucket][key] = { failures };
    }
  }
  return state;
}
