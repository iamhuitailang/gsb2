/**
 * JSON 文件存储。
 *
 * 数据落在 data/db.json，写入采用"临时文件 + rename"原子替换，
 * 避免演示过程中写到一半的文件损坏状态。首次启动自动播种演示数据。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = join(HERE, '..', 'data', 'db.json');

export const ACTIONS = Object.freeze({
  READ_INVENTORY: 'inventory:read',
  SUBMIT_STOCKTAKE: 'stocktake:submit',
});

export const ALL_ACTIONS = Object.freeze(Object.values(ACTIONS));

/** 演示初始数据：两个仓库、两个本地集成程序对应的服务账号（初始不带钥匙） */
export function seedData() {
  return {
    warehouses: [
      { code: 'WH1', name: '仓库一' },
      { code: 'WH2', name: '仓库二' },
    ],
    serviceAccounts: [
      {
        id: 'sa_ro_wh1',
        name: '本地集成程序 A（只读盘点查询）',
        enabled: true,
        allowedWarehouses: ['WH1'],
        allowedActions: [ACTIONS.READ_INVENTORY],
        createdAt: '2026-11-16T00:00:00.000Z',
      },
      {
        id: 'sa_rw',
        name: '本地集成程序 B（库存查询 + 盘点提交）',
        enabled: true,
        allowedWarehouses: ['WH1', 'WH2'],
        allowedActions: [ACTIONS.READ_INVENTORY, ACTIONS.SUBMIT_STOCKTAKE],
        createdAt: '2026-11-16T00:00:00.000Z',
      },
    ],
    keys: [],
    inventory: [
      { sku: 'SKU-1001', warehouse: 'WH1', name: '六角螺栓 M8×30', qty: 1200 },
      { sku: 'SKU-1002', warehouse: 'WH1', name: '平垫 Φ8', qty: 3400 },
      { sku: 'SKU-2001', warehouse: 'WH2', name: '伺服电机 750W', qty: 18 },
      { sku: 'SKU-2002', warehouse: 'WH2', name: '同步带 HTD-5M', qty: 76 },
    ],
    stocktakeJobs: [],
  };
}

export class Store {
  constructor(dbPath = DEFAULT_DB_PATH) {
    this.dbPath = dbPath;
    mkdirSync(dirname(dbPath), { recursive: true });
    if (!existsSync(dbPath)) {
      this.data = seedData();
      this.persist();
    } else {
      this.data = JSON.parse(readFileSync(dbPath, 'utf8'));
    }
  }

  persist() {
    const tmp = `${this.dbPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.dbPath);
  }

  /** 恢复演示初始数据（时钟偏移由调用方另行重置） */
  reset() {
    this.data = seedData();
    this.persist();
    return this.data;
  }

  get warehouses() {
    return this.data.warehouses;
  }

  get serviceAccounts() {
    return this.data.serviceAccounts;
  }

  get keys() {
    return this.data.keys;
  }

  get inventory() {
    return this.data.inventory;
  }

  get stocktakeJobs() {
    return this.data.stocktakeJobs;
  }

  findAccount(id) {
    return this.serviceAccounts.find((a) => a.id === id) || null;
  }

  findKey(id) {
    return this.keys.find((k) => k.id === id) || null;
  }

  /** 按哈希取钥匙（API 请求鉴权入口） */
  findKeyByHash(hash) {
    return this.keys.find((k) => k.hash === hash) || null;
  }

  /** 该服务账号当前处于有效状态的钥匙（active 或轮换重叠期） */
  effectiveKeysOf(accountId) {
    return this.keys.filter(
      (k) => k.serviceAccountId === accountId &&
        (k.status === 'active' || k.status === 'overlapping')
    );
  }
}
