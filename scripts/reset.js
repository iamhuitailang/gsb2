'use strict';

/**
 * 一键重置演示环境：清空商品价格、改价历史与执行记录，恢复
 * P-1001=20 元、P-1002=30 元、P-1003=40 元。
 */

const fs = require('fs');
const store = require('../server/store');
const journal = require('../executor/journal');

store.resetStore();
fs.rmSync(journal.RUNS_DIR, { recursive: true, force: true });
console.log('已重置模拟后台数据与执行记录。');
console.log(`商品初始价：${store.readStore().products.map((p) => `${p.code}=${(p.priceCents / 100).toFixed(2)}`).join('，')}`);
