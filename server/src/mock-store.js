// 模拟业务系统自己的数据库（与 RPA 执行台的 SQLite 完全独立），
// 用 JSON 文件持久化，重启后仍能识别"已提交过的申请"。
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const STORE_FILE = path.join(config.dataDir, 'mock-applications.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return { applications: [] };
  }
}

let store = load();

function persist() {
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

export function findApplication(applicationNo) {
  return store.applications.find((a) => a.applicationNo === applicationNo) || null;
}

export function listApplications() {
  return [...store.applications].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

export function createApplication(payload) {
  if (findApplication(payload.applicationNo)) {
    const err = new Error(`申请编号 ${payload.applicationNo} 已存在，请勿重复提交`);
    err.status = 409;
    err.code = 'DUPLICATE_APPLICATION';
    throw err;
  }
  const record = {
    ...payload,
    amount: Number(payload.amount),
    refNo: `MOCK-${Date.now()}-${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`,
    status: '已受理',
    submittedAt: new Date().toISOString(),
  };
  store.applications.push(record);
  persist();
  return record;
}

export function resetApplications() {
  store = { applications: [] };
  persist();
}
