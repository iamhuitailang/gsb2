/**
 * 模拟供应商的两批商品数据。
 *
 * 规则：
 * - sku 是商品唯一编号；version 是该商品每次变更携带的来源版本号（全局单调递增）
 * - updated_at 是供应商给的变更时间，刻意安排多个商品时间相同但编号不同
 *
 * 第一批（全量，8 个商品）：
 *   SKU1001/1002/1003  updated_at 相同，编号不同
 *   SKU1004/1005       updated_at 相同
 * 第二批（变更，5 条）：
 *   SKU1001 改价、SKU1003 改价、SKU1006 改名（都是老商品新版本）
 *   SKU1009、SKU1010 新上架；SKU1009/1010 的 updated_at 相同但编号不同
 * 未出现在第二批的商品保持原样。
 */
export const BATCH_1 = {
  note: '第一批：供应商初始全量目录（8 个商品）',
  products: [
    { sku: 'SKU1001', name: '东北珍珠米 5kg',      price: 39.9,  version: 1,  updated_at: '2026-11-10T09:00:00Z' },
    { sku: 'SKU1002', name: '压榨花生油 5L',       price: 89.0,  version: 2,  updated_at: '2026-11-10T09:00:00Z' },
    { sku: 'SKU1003', name: '鲜鸡蛋 30 枚',        price: 25.5,  version: 3,  updated_at: '2026-11-10T09:00:00Z' },
    { sku: 'SKU1004', name: '纯牛奶 250ml*24',     price: 59.9,  version: 4,  updated_at: '2026-11-10T14:30:00Z' },
    { sku: 'SKU1005', name: '生抽酱油 1.9L',       price: 18.8,  version: 5,  updated_at: '2026-11-10T14:30:00Z' },
    { sku: 'SKU1006', name: '抽纸 3 层*100 抽*24', price: 42.0,  version: 6,  updated_at: '2026-11-11T10:15:00Z' },
    { sku: 'SKU1007', name: '矿泉水 550ml*24',     price: 22.0,  version: 7,  updated_at: '2026-11-11T16:45:00Z' },
    { sku: 'SKU1008', name: '全麦面包 400g',       price: 12.5,  version: 8,  updated_at: '2026-11-12T08:20:00Z' },
  ],
};

export const BATCH_2 = {
  note: '第二批：3 个改价/改名 + 2 个新上架（5 条变更）',
  products: [
    // 改价：老编号、新版本、新价格
    { sku: 'SKU1001', name: '东北珍珠米 5kg',      price: 35.9,  version: 9,  updated_at: '2026-11-12T09:00:00Z' },
    { sku: 'SKU1003', name: '鲜鸡蛋 30 枚',        price: 23.8,  version: 10, updated_at: '2026-11-12T09:00:00Z' },
    // 改名（价格不变），验证"更新"不只看价格
    { sku: 'SKU1006', name: '柔肤抽纸 3 层*100 抽*24', price: 42.0, version: 11, updated_at: '2026-11-12T09:00:00Z' },
    // 新上架：新编号
    { sku: 'SKU1009', name: '酸奶 100g*16',        price: 33.5,  version: 12, updated_at: '2026-11-13T10:00:00Z' },
    { sku: 'SKU1010', name: '即食鸡胸肉 100g*8',   price: 49.9,  version: 13, updated_at: '2026-11-13T10:00:00Z' },
  ],
};

export const BATCHES = [BATCH_1, BATCH_2];
