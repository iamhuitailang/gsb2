// 报表查询、订单列表/详情时间线、汇总与明细 CSV 导出。
import { getDb } from './db.js';
import { rowsToCsv, formatLocalTime } from './csv.js';

export const DIRECT = { campaignId: null, campaignName: '直接成交' };

// 枚举闭区间内的全部日历日
export function enumerateDates(startDate, endDate) {
  const out = [];
  const cur = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (cur.getTime() <= end.getTime()) {
    const p = (n) => String(n).padStart(2, '0');
    out.push(`${cur.getFullYear()}-${p(cur.getMonth() + 1)}-${p(cur.getDate())}`);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// 统一解析查询参数：单日或闭区间
function resolveRange(query) {
  let { date, startDate, endDate } = query;
  if (date) { startDate = endDate = date; }
  if (!startDate || !endDate) {
    const today = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const d = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    startDate = endDate = d;
  }
  if (startDate > endDate) [startDate, endDate] = [endDate, startDate];
  return { startDate, endDate };
}

export function listCampaigns() {
  return getDb().prepare('SELECT campaign_id AS campaignId, campaign_name AS campaignName FROM campaigns ORDER BY rowid').all();
}

// 活动 × 付款日 报表，含直接成交与零单补零；另附区间合计
export function getReport(query) {
  const { startDate, endDate } = resolveRange(query);
  const db = getDb();
  const dates = enumerateDates(startDate, endDate);

  const aggRows = db.prepare(`
    SELECT pay_date AS payDate,
           current_campaign_id AS campaignId,
           current_campaign_name AS campaignName,
           COUNT(*) AS gross,
           SUM(CASE WHEN refund_id IS NOT NULL THEN 1 ELSE 0 END) AS refunded
    FROM orders
    WHERE pay_date BETWEEN ? AND ?
    GROUP BY pay_date, current_campaign_id
  `).all(startDate, endDate);
  const agg = new Map();
  for (const r of aggRows) {
    agg.set(`${r.payDate}|${r.campaignId ?? ''}`, { gross: r.gross, refunded: r.refunded });
  }

  const campaigns = listCampaigns();
  const columns = [...campaigns, DIRECT];
  const rows = dates.map((payDate) => ({
    payDate,
    campaigns: columns.map((c) => {
      const cell = agg.get(`${payDate}|${c.campaignId ?? ''}`);
      const gross = cell?.gross ?? 0;
      const refunded = cell?.refunded ?? 0;
      return { ...c, gross, refunded, net: gross - refunded };
    }),
  }));

  const totals = columns.map((c) => {
    const gross = rows.reduce((s, r) => s + (r.campaigns.find((x) => x.campaignId === c.campaignId)?.gross ?? 0), 0);
    const refunded = rows.reduce((s, r) => s + (r.campaigns.find((x) => x.campaignId === c.campaignId)?.refunded ?? 0), 0);
    return { ...c, gross, refunded, net: gross - refunded };
  });

  return { startDate, endDate, dates, campaigns: columns, rows, totals };
}

export function listOrders({ q = '', campaignId, payDate } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (q) {
    where.push('(order_id LIKE ? OR account_id LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  if (campaignId === '__direct__') where.push('current_campaign_id IS NULL');
  else if (campaignId) { where.push('current_campaign_id = ?'); params.push(campaignId); }
  if (payDate) { where.push('pay_date = ?'); params.push(payDate); }
  const sql = `
    SELECT order_id AS orderId, account_id AS accountId,
           payment_time_ms AS paymentTimeMs, pay_date AS payDate,
           current_click_id AS clickId,
           current_campaign_id AS campaignId, current_campaign_name AS campaignName,
           refund_id AS refundId, refund_time_ms AS refundTimeMs, updated_at AS updatedAt
    FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY payment_time_ms DESC, order_id DESC LIMIT 500
  `;
  return db.prepare(sql).all(...params);
}

function historySummary(history) {
  return history.map((row) => {
    // 兼容 getOrderDetail 的 camelCase 别名查询与 buildDetailCsv 的 SELECT * 原始列名
    const h = {
      changeType: row.changeType ?? row.change_type,
      oldName: row.oldCampaignName ?? row.old_campaign_name,
      newName: row.newCampaignName ?? row.new_campaign_name,
      reason: row.reason,
    };
    const from = h.oldName ?? '直接成交';
    const to = h.newName ?? '直接成交';
    return h.changeType === 'initial'
      ? `初始归因→${to}（${h.reason}）`
      : `${from}→${to}（${h.reason}）`;
  }).join('｜');
}

export function getOrderDetail(orderId) {
  const db = getDb();
  const order = db.prepare(`
    SELECT order_id AS orderId, account_id AS accountId,
           payment_time_ms AS paymentTimeMs, pay_date AS payDate,
           current_click_id AS clickId,
           current_campaign_id AS campaignId, current_campaign_name AS campaignName,
           refund_id AS refundId, refund_time_ms AS refundTimeMs,
           created_at AS createdAt, updated_at AS updatedAt
    FROM orders WHERE order_id = ?
  `).get(orderId);
  if (!order) return null;

  const history = db.prepare(`
    SELECT seq, change_type AS changeType,
           old_click_id AS oldClickId, old_campaign_id AS oldCampaignId, old_campaign_name AS oldCampaignName,
           new_click_id AS newClickId, new_campaign_id AS newCampaignId, new_campaign_name AS newCampaignName,
           reason, created_at AS createdAt
    FROM attribution_history WHERE order_id = ? ORDER BY seq
  `).all(orderId);

  const refund = db.prepare(`
    SELECT refund_id AS refundId, refund_time_ms AS refundTimeMs, received_at AS receivedAt
    FROM refunds WHERE order_id = ?
  `).get(orderId);

  const timeline = [
    ...history.map((h) => ({
      kind: h.changeType === 'initial' ? '初始归因' : '归因改判',
      at: h.createdAt,
      title: h.changeType === 'initial'
        ? `初始归因：${h.newCampaignName ?? '直接成交'}`
        : `归因改判：${h.oldCampaignName ?? '直接成交'} → ${h.newCampaignName ?? '直接成交'}`,
      detail: h.reason,
    })),
  ];
  if (refund) {
    timeline.push({
      kind: '整单退款',
      at: refund.receivedAt,
      title: `整单退款 ${refund.refundId}`,
      detail: `退款时间 ${formatLocalTime(refund.refundTimeMs)}，从订单当前归属活动（${order.campaignName ?? '直接成交'}）扣减，归因不变`,
    });
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return { order, history, refund, timeline, summary: historySummary(history) };
}

// ---------- 导出 ----------
export function buildSummaryCsv(query) {
  const report = getReport(query);
  const rows = [['付款日期', '活动编号', '活动名称', '成交单数', '退款单数', '净单数']];
  for (const day of report.rows) {
    for (const c of day.campaigns) {
      rows.push([day.payDate, c.campaignId ?? '', c.campaignName, c.gross, c.refunded, c.net]);
    }
  }
  rows.push([]);
  rows.push(['区间合计', '', '', '', '', '']);
  for (const c of report.totals) {
    rows.push([`${report.startDate}~${report.endDate}`, c.campaignId ?? '', c.campaignName, c.gross, c.refunded, c.net]);
  }
  return '﻿' + rowsToCsv(rows);
}

export function buildDetailCsv(query) {
  const { startDate, endDate } = resolveRange(query);
  const db = getDb();
  const orders = db.prepare(`
    SELECT * FROM orders WHERE pay_date BETWEEN ? AND ?
    ORDER BY pay_date, order_id
  `).all(startDate, endDate);
  const histStmt = db.prepare('SELECT * FROM attribution_history WHERE order_id = ? ORDER BY seq');
  const rows = [[
    '订单编号', '账号', '付款时间', '付款日期', '归因活动编号', '归因活动名称', '归因点击编号',
    '是否已退款', '退款单号', '退款时间', '归因历史摘要',
  ]];
  for (const o of orders) {
    const summary = historySummary(histStmt.all(o.order_id));
    rows.push([
      o.order_id, o.account_id, formatLocalTime(o.payment_time_ms), o.pay_date,
      o.current_campaign_id ?? '', o.current_campaign_name ?? '直接成交', o.current_click_id ?? '',
      o.refund_id ? '是' : '否', o.refund_id ?? '', formatLocalTime(o.refund_time_ms), summary,
    ]);
  }
  return '﻿' + rowsToCsv(rows);
}
