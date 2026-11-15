'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.GSB_DATA_DIR
  ? path.resolve(process.env.GSB_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

const SEED_PRODUCTS = [
  { code: 'P-1001', name: '示例商品 A', priceCents: 2000 },
  { code: 'P-1002', name: '示例商品 B', priceCents: 3000 },
  { code: 'P-1003', name: '示例商品 C', priceCents: 4000 },
];

function now() {
  return new Date().toISOString();
}

function buildSeed() {
  const ts = now();
  return {
    schema: 1,
    products: SEED_PRODUCTS.map((p) => ({
      code: p.code,
      name: p.name,
      priceCents: p.priceCents,
      version: 1,
      updatedAt: ts,
    })),
    history: [],
    nextSeq: 1,
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    writeStore(buildSeed());
  }
}

function readStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

function writeStore(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`);
  fs.renameSync(tmp, STORE_PATH);
}

function resetStore() {
  const db = buildSeed();
  writeStore(db);
  return db;
}

function findProduct(db, code) {
  return db.products.find((p) => p.code === code) || null;
}

function findHistoryByOpId(db, opId) {
  if (!opId) return null;
  return db.history.find((h) => h.opId === opId) || null;
}

/**
 * 改价的核心写入逻辑（手动入口与自动化共用）。
 *
 * 校验顺序：
 *  1. 操作编号幂等：同一 opId 已成功保存过，直接返回既有记录，绝不重复写入；
 *  2. 商品存在；
 *  3. 预计旧价 == 当前价，否则视为「核对后被人改过」，拒绝覆盖；
 *  4. 页面渲染时的版本号 == 当前版本号（防止改走又改回，价格相同但内容已被改过）。
 */
function applyChange(db, opts) {
  const {
    code,
    newPriceCents,
    expectedOldPriceCents = null,
    expectedVersion = null,
    opId = null,
    source = 'manual',
    actor = 'manual',
  } = opts;

  const product = findProduct(db, code);
  const existing = findHistoryByOpId(db, opId);
  if (existing) {
    // 同一操作编号只能对应同一商品的同一次改动，否则视为编号冲突
    if (existing.code !== code) {
      return {
        ok: false,
        error: 'OP_ID_CONFLICT',
        message: `操作编号 ${opId} 已被商品 ${existing.code} 使用，不能用于商品 ${code}`,
        product,
      };
    }
    return { ok: true, duplicate: true, entry: existing, product };
  }
  if (!product) {
    return { ok: false, error: 'NOT_FOUND', message: `商品 ${code} 不存在` };
  }
  // 先按预计旧价比对：这是「保存时再校验一次」的核心防线
  if (expectedOldPriceCents !== null && expectedOldPriceCents !== product.priceCents) {
    return {
      ok: false,
      error: 'PRICE_MISMATCH',
      message: `商品 ${code} 当前价 ${product.priceCents / 100} 元，与预计旧价 ${
        expectedOldPriceCents / 100
      } 元不一致，已拒绝覆盖`,
      product,
    };
  }
  if (expectedVersion !== null && expectedVersion !== product.version) {
    return {
      ok: false,
      error: 'VERSION_MISMATCH',
      message: `商品 ${code} 在核对后被修改过（版本 ${expectedVersion} → ${product.version}），已拒绝覆盖`,
      product,
    };
  }
  if (newPriceCents === product.priceCents) {
    return { ok: false, error: 'SAME_PRICE', message: `新价格与当前价格相同，无需保存`, product };
  }

  const seq = db.nextSeq++;
  const entry = {
    seq,
    opId: opId || `MANUAL-${Date.now()}-${seq}`,
    code,
    productName: product.name,
    oldPriceCents: product.priceCents,
    newPriceCents,
    source,
    actor,
    at: now(),
  };
  db.history.push(entry);
  product.priceCents = newPriceCents;
  product.version += 1;
  product.updatedAt = entry.at;
  writeStore(db);
  return { ok: true, duplicate: false, entry, product };
}

module.exports = {
  STORE_PATH,
  buildSeed,
  readStore,
  writeStore,
  resetStore,
  findProduct,
  findHistoryByOpId,
  applyChange,
};
