'use strict';

const ACTIONS = ['view', 'approve', 'reject'];

function minutesAgo(now, minutes) {
  return new Date(now - minutes * 60 * 1000).toISOString();
}

function minutesFromNow(now, minutes) {
  return new Date(now + minutes * 60 * 1000).toISOString();
}

/**
 * 演示数据：
 * - 两个门店
 * - 三名员工：甲（区域主管）、乙（值班员）、丙（门店店员）
 * - 甲、乙之间已有一条生效中的门店一委托（2 小时）
 */
function createSeed({ now = Date.now() } = {}) {
  const users = [
    { id: 'u_jia', name: '甲', title: '区域主管', role: 'supervisor' },
    { id: 'u_yi', name: '乙', title: '值班员', role: 'duty' },
    { id: 'u_bing', name: '丙', title: '门店店员', role: 'staff' }
  ];

  const stores = [
    { id: 's1', name: '门店一', city: '上海 · 静安' },
    { id: 's2', name: '门店二', city: '上海 · 徐汇' }
  ];

  // 自有权限（可直接委托的部分）。演示中可被“收回”。
  const grants = [
    { id: 'g1', userId: 'u_jia', storeId: 's1', actions: ['view', 'approve', 'reject'], active: true },
    { id: 'g2', userId: 'u_jia', storeId: 's2', actions: ['view', 'approve', 'reject'], active: true }
  ];

  const applications = [
    {
      id: 'a1',
      storeId: 's1',
      requesterId: 'u_bing',
      product: '阳光玫瑰礼盒',
      sku: 'SKU-1001',
      unit: '盒',
      originalPrice: 88,
      proposedPrice: 79,
      reason: '礼盒档期临近，申请下调零售价加快周转。',
      status: 'pending',
      createdAt: minutesAgo(now, 35),
      decision: null
    },
    {
      id: 'a2',
      storeId: 's1',
      requesterId: 'u_bing',
      product: '有机鲜牛奶 950ml',
      sku: 'SKU-1024',
      unit: '瓶',
      originalPrice: 15.9,
      proposedPrice: 13.9,
      reason: '临期库存集中处理，申请两日内特价。',
      status: 'pending',
      createdAt: minutesAgo(now, 22),
      decision: null
    },
    {
      id: 'a3',
      storeId: 's2',
      requesterId: 'u_bing',
      product: '有机蔬菜周箱',
      sku: 'SKU-2036',
      unit: '箱',
      originalPrice: 39,
      proposedPrice: 35,
      reason: '新供应商到货成本下降，希望同步下调售价。',
      status: 'pending',
      createdAt: minutesAgo(now, 48),
      decision: null
    },
    {
      id: 'a4',
      storeId: 's2',
      requesterId: 'u_bing',
      product: '手冲咖啡豆 250g',
      sku: 'SKU-2077',
      unit: '袋',
      originalPrice: 68,
      proposedPrice: 62,
      reason: '竞品促销，申请短期跟价。',
      status: 'pending',
      createdAt: minutesAgo(now, 12),
      decision: null
    },
    {
      id: 'a5',
      storeId: 's1',
      requesterId: 'u_bing',
      product: '冷冻手工水饺',
      sku: 'SKU-1042',
      unit: '袋',
      originalPrice: 32,
      proposedPrice: 29,
      reason: '周末陈列促销。',
      status: 'approved',
      createdAt: minutesAgo(now, 240),
      decision: {
        action: 'approve',
        by: 'u_jia',
        byName: '甲',
        at: minutesAgo(now, 180),
        via: { type: 'direct' },
        comment: '同意，仅限本周。'
      }
    },
    {
      id: 'a6',
      storeId: 's2',
      requesterId: 'u_bing',
      product: '进口气泡水 6 瓶装',
      sku: 'SKU-2099',
      unit: '提',
      originalPrice: 45,
      proposedPrice: 42,
      reason: '清仓处理。',
      status: 'rejected',
      createdAt: minutesAgo(now, 1600),
      decision: {
        action: 'reject',
        by: 'u_jia',
        byName: '甲',
        at: minutesAgo(now, 1560),
        via: { type: 'direct' },
        comment: '毛利过低，暂不调整。'
      }
    }
  ];

  const delegations = [
    {
      id: 'd1',
      delegatorId: 'u_jia',
      delegateeId: 'u_yi',
      storeIds: ['s1'],
      actions: ['view', 'approve', 'reject'],
      startsAt: minutesAgo(now, 2),
      endsAt: minutesFromNow(now, 120),
      createdAt: minutesAgo(now, 10),
      acceptedAt: minutesAgo(now, 8),
      endedAt: null,
      note: '休假期间代审门店一'
    }
  ];

  return {
    users,
    stores,
    grants,
    applications,
    delegations,
    clockOffsetMs: 0
  };
}

module.exports = { ACTIONS, createSeed };
