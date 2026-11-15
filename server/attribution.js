// 三类记录接入 + last-click 归因引擎。所有多语句变更走手动事务。
import { getDb, now } from './db.js';
import {
  parseClicksCsv, parsePaymentsCsv, parseRefundsCsv,
  capErrors, toPayDate, formatLocalTime,
} from './csv.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

function txn(fn) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function hhmm(ms) {
  return formatLocalTime(ms).slice(11, 16);
}

// 给定账号与付款时刻，选 24 小时窗口（含两端）内的最后一次点击；
// 同一点击时刻按 click_id 字典序靠后者为后（页面公开的定序规则）。
export function findWinningClick(accountId, paymentTimeMs) {
  return getDb().prepare(`
    SELECT click_id, campaign_id, campaign_name, click_time_ms
    FROM clicks
    WHERE account_id = ?
      AND click_time_ms BETWEEN ? AND ?
    ORDER BY click_time_ms DESC, click_id DESC
    LIMIT 1
  `).get(accountId, paymentTimeMs - DAY_MS, paymentTimeMs) ?? null;
}

function buildInitialReason(winner) {
  if (!winner) return '付款时未找到付款前 24 小时内的活动点击，判为直接成交';
  return `付款归因：点击 ${winner.click_id}（${winner.campaign_name}，点击时间 ${formatLocalTime(winner.click_time_ms)}）` +
         `是付款前 24 小时内最后一次有效点击，初始归因${winner.campaign_name}`;
}

function buildReattributeReason(order, winner) {
  const at = hhmm(Date.now());
  const clickInfo = `点击 ${winner.click_id}（${winner.campaign_name}，点击时间 ${formatLocalTime(winner.click_time_ms)}）`;
  const oldName = order.current_campaign_name;
  if (oldName === null || oldName === undefined) {
    return `${at} 收到晚到${clickInfo}，原判定为直接成交，改判为${winner.campaign_name}`;
  }
  if (order.current_campaign_id === winner.campaign_id) {
    return `${at} 收到晚到${clickInfo}，晚于原归因点击 ${order.current_click_id}（同为${oldName}），` +
           `归因点击更新：${order.current_click_id} → ${winner.click_id}（活动不变）`;
  }
  return `${at} 收到晚到${clickInfo}，晚于原归因点击 ${order.current_click_id}（${oldName}），` +
         `归因改判：${oldName} → ${winner.campaign_name}`;
}

// 重算单订单：获胜点击变化才更新订单并追加历史（同活动换点击也留痕）
function applyAttribution(orderId) {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
  if (!order) return;
  const winner = findWinningClick(order.account_id, order.payment_time_ms);
  const newClickId = winner ? winner.click_id : null;
  if (newClickId === order.current_click_id) return;

  const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM attribution_history WHERE order_id = ?')
    .get(orderId).s;
  const reason = winner ? buildReattributeReason(order, winner) : '';
  const ts = now();
  db.prepare(`
    UPDATE orders SET current_click_id = ?, current_campaign_id = ?, current_campaign_name = ?, updated_at = ?
    WHERE order_id = ?
  `).run(
    newClickId,
    winner ? winner.campaign_id : null,
    winner ? winner.campaign_name : null,
    ts, orderId,
  );
  db.prepare(`
    INSERT INTO attribution_history (
      order_id, seq, change_type, old_click_id, old_campaign_id, old_campaign_name,
      new_click_id, new_campaign_id, new_campaign_name, reason, created_at
    ) VALUES (?, ?, 'reattribute', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId, seq,
    order.current_click_id, order.current_campaign_id, order.current_campaign_name,
    newClickId, winner ? winner.campaign_id : null, winner ? winner.campaign_name : null,
    reason, ts,
  );
}

function finishBatch(recordType, originalName, totalRows, accepted, duplicate, errors) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO ingest_batches (record_type, original_name, total_rows, accepted, duplicate, error_rows, errors, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(recordType, originalName, totalRows, accepted, duplicate, errors.length,
         JSON.stringify(capErrors(errors)), now());
  return {
    type: recordType,
    total: totalRows,
    accepted,
    duplicate,
    errorRows: errors.length,
    errors: capErrors(errors),
    batchId: Number(info.lastInsertRowid),
  };
}

// ---------- 点击接入 ----------
export function ingestClicks(buffer, originalName) {
  const { records, errors: parseErrors, totalRows } = parseClicksCsv(buffer.toString('utf8'));
  return txn(() => {
    const db = getDb();
    const existsClick = db.prepare('SELECT 1 FROM clicks WHERE click_id = ?');
    const insertClick = db.prepare(`
      INSERT INTO clicks (click_id, account_id, campaign_id, campaign_name, click_time_ms, received_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const upsertCampaign = db.prepare(`
      INSERT INTO campaigns (campaign_id, campaign_name, first_seen_at) VALUES (?, ?, ?)
      ON CONFLICT(campaign_id) DO NOTHING
    `);
    const candidateOrders = db.prepare(`
      SELECT order_id FROM orders
      WHERE account_id = ? AND payment_time_ms BETWEEN ? AND ?
    `);

    let accepted = 0;
    let duplicate = 0;
    const errors = [...parseErrors];
    const affected = new Set();

    for (const rec of records) {
      if (existsClick.get(rec.click_id)) { duplicate++; continue; }
      insertClick.run(rec.click_id, rec.account_id, rec.campaign_id, rec.campaign_name,
                      rec.click_time_ms, now());
      upsertCampaign.run(rec.campaign_id, rec.campaign_name, now());
      accepted++;
      // 新点击只可能影响：同账号、付款时刻落在 [点击时刻, 点击时刻+24h] 的订单
      for (const c of candidateOrders.all(rec.account_id, rec.click_time_ms, rec.click_time_ms + DAY_MS)) {
        affected.add(c.order_id);
      }
    }
    for (const orderId of affected) applyAttribution(orderId);
    return finishBatch('click', originalName, totalRows, accepted, duplicate, errors);
  });
}

// ---------- 付款接入 ----------
export function ingestPayments(buffer, originalName) {
  const { records, errors: parseErrors, totalRows } = parsePaymentsCsv(buffer.toString('utf8'));
  return txn(() => {
    const db = getDb();
    const existsOrder = db.prepare('SELECT 1 FROM orders WHERE order_id = ?');
    const insertOrder = db.prepare(`
      INSERT INTO orders (
        order_id, account_id, payment_time_ms, pay_date,
        current_click_id, current_campaign_id, current_campaign_name,
        refund_id, refund_time_ms, refunded_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);
    const insertHistory = db.prepare(`
      INSERT INTO attribution_history (
        order_id, seq, change_type, old_click_id, old_campaign_id, old_campaign_name,
        new_click_id, new_campaign_id, new_campaign_name, reason, created_at
      ) VALUES (?, 1, 'initial', NULL, NULL, NULL, ?, ?, ?, ?, ?)
    `);

    let accepted = 0;
    let duplicate = 0;
    const errors = [...parseErrors];

    for (const rec of records) {
      if (existsOrder.get(rec.order_id)) { duplicate++; continue; }
      const winner = findWinningClick(rec.account_id, rec.payment_time_ms);
      const ts = now();
      insertOrder.run(
        rec.order_id, rec.account_id, rec.payment_time_ms, toPayDate(rec.payment_time_ms),
        winner ? winner.click_id : null,
        winner ? winner.campaign_id : null,
        winner ? winner.campaign_name : null,
        ts, ts,
      );
      insertHistory.run(
        rec.order_id,
        winner ? winner.click_id : null,
        winner ? winner.campaign_id : null,
        winner ? winner.campaign_name : null,
        buildInitialReason(winner), ts,
      );
      accepted++;
    }
    return finishBatch('payment', originalName, totalRows, accepted, duplicate, errors);
  });
}

// ---------- 整单退款接入（不改归因，只挂订单当前态） ----------
export function ingestRefunds(buffer, originalName) {
  const { records, errors: parseErrors, totalRows } = parseRefundsCsv(buffer.toString('utf8'));
  return txn(() => {
    const db = getDb();
    const existsRefund = db.prepare('SELECT 1 FROM refunds WHERE refund_id = ?');
    const getOrder = db.prepare('SELECT * FROM orders WHERE order_id = ?');
    const markOrder = db.prepare(`
      UPDATE orders SET refund_id = ?, refund_time_ms = ?, refunded_at = ?, updated_at = ?
      WHERE order_id = ?
    `);
    const insertRefund = db.prepare(`
      INSERT INTO refunds (refund_id, order_id, refund_time_ms, received_at) VALUES (?, ?, ?, ?)
    `);

    let accepted = 0;
    let duplicate = 0;
    const errors = [...parseErrors];

    for (const rec of records) {
      if (existsRefund.get(rec.refund_id)) { duplicate++; continue; }
      const order = getOrder.get(rec.order_id);
      if (!order) {
        errors.push(`第 ${rec.lineNo} 行：订单 ${rec.order_id} 不存在，无法退款`);
        continue;
      }
      if (order.refund_id) {
        errors.push(`第 ${rec.lineNo} 行：订单 ${rec.order_id} 已存在整单退款 ${order.refund_id}，每单仅可退款一次`);
        continue;
      }
      const ts = now();
      markOrder.run(rec.refund_id, rec.refund_time_ms, ts, ts, rec.order_id);
      insertRefund.run(rec.refund_id, rec.order_id, rec.refund_time_ms, ts);
      accepted++;
    }
    return finishBatch('refund', originalName, totalRows, accepted, duplicate, errors);
  });
}

export function listIngestBatches() {
  return getDb().prepare(`
    SELECT id, record_type AS recordType, original_name AS originalName,
           total_rows AS totalRows, accepted, duplicate,
           error_rows AS errorRows, errors, created_at AS createdAt
    FROM ingest_batches ORDER BY id DESC LIMIT 100
  `).all().map((b) => ({ ...b, errors: JSON.parse(b.errors) }));
}
