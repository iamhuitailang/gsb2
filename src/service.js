/**
 * 礼品卡流水接收核心逻辑。
 *
 * 并发模型：node:sqlite 为同步驱动，每次提交都在一个
 * BEGIN IMMEDIATE 事务内完成"读额度 → 核算 → 写流水/余额"，
 * 因此多个收银点同时上报退款时，剩余可退额度的核算是串行且原子的。
 */

export const TX_TYPES = ['recharge', 'purchase', 'refund'];
export const TX_STATUS = ['posted', 'pending', 'rejected'];

export const REASONS = {
  PENDING_REFUND_ORIGIN_MISSING: '原消费尚未收到，退款暂存',
  REJECTED_REFUND_EXCEEDS: '退款金额超过该笔消费剩余可退额度',
  REJECTED_PENDING_EXCEEDS: '原消费到达后，暂存退款超过剩余可退额度',
  REJECTED_PURCHASE_INSUFFICIENT_BALANCE: '卡内余额不足，消费被拒绝',
  REJECTED_REFUND_CARD_MISMATCH: '退款指向的原消费属于另一张卡',
  REJECTED_REFUND_ORIGIN_REJECTED: '原消费已被拒绝，无法退款',
};

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const now = () => new Date().toISOString();

function requireStr(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'VALIDATION_ERROR', `字段 ${field} 不能为空`);
  }
  return value.trim();
}

function requirePositiveCents(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', `字段 ${field} 必须是正整数（分）`);
  }
  return value;
}

function formatTx(row) {
  const isPurchase = row.type === 'purchase';
  return {
    id: row.id,
    cardId: row.card_id,
    registerId: row.register_id,
    seq: row.seq,
    type: row.type,
    amountCents: row.amount_cents,
    status: row.status,
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    ref: row.linked_ref_register
      ? { registerId: row.linked_ref_register, seq: row.linked_ref_seq }
      : null,
    linkedTxId: row.linked_tx_id,
    balanceAfterCents: row.balance_after_cents,
    refundedCents: isPurchase ? row.refunded_cents : null,
    refundableCents: isPurchase ? row.amount_cents - row.refunded_cents : null,
    createdAt: row.created_at,
    postedAt: row.posted_at,
  };
}

/* ---------------------------------- 卡 ---------------------------------- */

export function createCard(db, cardId, initialBalanceCents = 0) {
  const id = requireStr(cardId, 'cardId');
  if (!Number.isInteger(initialBalanceCents) || initialBalanceCents < 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', '初始余额必须是非负整数（分）');
  }
  try {
    db.prepare('INSERT INTO cards (id, balance_cents) VALUES (?, ?)').run(id, initialBalanceCents);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      throw new HttpError(409, 'CARD_EXISTS', `卡 ${id} 已存在`);
    }
    throw err;
  }
  return getCard(db, id);
}

export function getCard(db, cardId) {
  const row = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!row) throw new HttpError(404, 'CARD_NOT_FOUND', `卡 ${cardId} 不存在`);
  return { cardId: row.id, balanceCents: row.balance_cents, createdAt: row.created_at };
}

/* --------------------------------- 流水 --------------------------------- */

const selectTxSql = `SELECT * FROM transactions WHERE register_id = ? AND seq = ?`;
const selectPendingByRef = `
  SELECT * FROM transactions
  WHERE status = 'pending'
    AND linked_ref_register = ? AND linked_ref_seq = ?
  ORDER BY id ASC
`;

/**
 * 接收一笔流水。
 * 同 (registerId, seq) 重复上报时不重复入账，返回首条记录并标记 duplicate。
 */
export function submitTransaction(db, input) {
  const cardId = requireStr(input.cardId, 'cardId');
  const registerId = requireStr(input.registerId, 'registerId');
  const seq = requireStr(input.seq, 'seq');
  const type = requireStr(input.type, 'type');
  if (!TX_TYPES.includes(type)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `type 必须是 ${TX_TYPES.join('/')}`);
  }
  const amountCents = requirePositiveCents(input.amountCents, 'amountCents');

  const hasRef = input.refRegisterId != null || input.refSeq != null;
  if (type === 'refund' && !hasRef) {
    throw new HttpError(400, 'VALIDATION_ERROR', '退款必须指向原消费（refRegisterId + refSeq）');
  }
  if (type !== 'refund' && hasRef) {
    throw new HttpError(400, 'VALIDATION_ERROR', '只有退款才能指向原消费');
  }
  const refRegisterId = hasRef ? requireStr(input.refRegisterId, 'refRegisterId') : null;
  const refSeq = hasRef ? requireStr(input.refSeq, 'refSeq') : null;

  return withTx(db, () => {
    const existing = db.prepare(selectTxSql).get(registerId, seq);
    if (existing) return { duplicate: true, tx: formatTx(existing) };

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    if (!card) throw new HttpError(404, 'CARD_NOT_FOUND', `卡 ${cardId} 不存在`);

    let row;
    if (type === 'recharge') {
      row = postRecharge(db, card, { registerId, seq, amountCents });
    } else if (type === 'purchase') {
      row = postPurchase(db, card, { registerId, seq, amountCents });
    } else {
      row = postRefund(db, card, { registerId, seq, amountCents, refRegisterId, refSeq });
    }
    return { duplicate: false, tx: formatTx(row) };
  });
}

function postRecharge(db, card, { registerId, seq, amountCents }) {
  const balance = card.balance_cents + amountCents;
  db.prepare('UPDATE cards SET balance_cents = ? WHERE id = ?').run(balance, card.id);
  return insertTx(db, {
    cardId: card.id, registerId, seq, type: 'recharge', amountCents,
    status: 'posted', balanceAfter: balance,
  });
}

function postPurchase(db, card, { registerId, seq, amountCents }) {
  if (card.balance_cents < amountCents) {
    // 拒绝的流水同样保留，供对账页追溯原因
    return insertTx(db, {
      cardId: card.id, registerId, seq, type: 'purchase', amountCents,
      status: 'rejected',
      reasonCode: 'REJECTED_PURCHASE_INSUFFICIENT_BALANCE',
      reasonDetail: `余额 ${card.balance_cents} 分，不足消费 ${amountCents} 分`,
    });
  }

  const balance = card.balance_cents - amountCents;
  db.prepare('UPDATE cards SET balance_cents = ? WHERE id = ?').run(balance, card.id);
  card.balance_cents = balance;
  const purchase = insertTx(db, {
    cardId: card.id, registerId, seq, type: 'purchase', amountCents,
    status: 'posted', balanceAfter: balance,
  });

  // 原消费到达：按 FIFO 处理此前暂存、指向它的退款
  settlePendingRefunds(db, card, purchase);
  return db.prepare('SELECT * FROM transactions WHERE id = ?').get(purchase.id);
}

function postRefund(db, card, { registerId, seq, amountCents, refRegisterId, refSeq }) {
  const origin = db
    .prepare('SELECT * FROM transactions WHERE register_id = ? AND seq = ? AND type = \'purchase\'')
    .get(refRegisterId, refSeq);

  // 原消费未到：暂存，不动余额
  if (!origin) {
    return insertTx(db, {
      cardId: card.id, registerId, seq, type: 'refund', amountCents,
      status: 'pending',
      reasonCode: 'PENDING_REFUND_ORIGIN_MISSING',
      reasonDetail: `原消费（收银点 ${refRegisterId} / 流水号 ${refSeq}）尚未收到`,
      refRegisterId, refSeq,
    });
  }

  const decision = decideRefund(card, amountCents, origin);
  if (decision.status === 'posted') {
    const balance = applyRefundEffect(db, card, origin, amountCents);
    return insertTx(db, {
      cardId: card.id, registerId, seq, type: 'refund', amountCents,
      status: 'posted', refRegisterId, refSeq,
      linkedTxId: origin.id, balanceAfter: balance,
    });
  }
  return insertTx(db, {
    cardId: card.id, registerId, seq, type: 'refund', amountCents,
    status: 'rejected', refRegisterId, refSeq,
    reasonCode: decision.reasonCode, reasonDetail: decision.reasonDetail,
  });
}

/**
 * 核算一笔退款能否入账（实时退款与暂存退款释放共用）。
 * 只做判断、不写库；调用方已持有写事务。
 */
function decideRefund(card, amountCents, origin) {
  if (origin.card_id !== card.id) {
    return {
      status: 'rejected',
      reasonCode: 'REJECTED_REFUND_CARD_MISMATCH',
      reasonDetail: `原消费属于卡 ${origin.card_id}，退款上报给卡 ${card.id}`,
    };
  }
  if (origin.status === 'rejected') {
    return {
      status: 'rejected',
      reasonCode: 'REJECTED_REFUND_ORIGIN_REJECTED',
      reasonDetail: '原消费处于被拒绝状态',
    };
  }
  const refundable = origin.amount_cents - origin.refunded_cents;
  if (amountCents > refundable) {
    return {
      status: 'rejected',
      reasonCode: 'REJECTED_REFUND_EXCEEDS',
      reasonDetail: `申请退 ${amountCents} 分，该消费剩余可退仅 ${refundable} 分`,
    };
  }
  return { status: 'posted' };
}

/** 退款通过后的账务动作：回补余额、累计原消费已退金额，返回新余额。 */
function applyRefundEffect(db, card, origin, amountCents) {
  const balance = card.balance_cents + amountCents;
  db.prepare('UPDATE cards SET balance_cents = ? WHERE id = ?').run(balance, card.id);
  db.prepare('UPDATE transactions SET refunded_cents = ? WHERE id = ?')
    .run(origin.refunded_cents + amountCents, origin.id);
  card.balance_cents = balance;
  return balance;
}

/**
 * 原消费入账后，按到达顺序（FIFO）释放暂存退款。
 * 暂存行原地转状态（保留首次到达时间与唯一键）；
 * 某笔超额被拒不影响后续暂存退款继续核算。
 */
function settlePendingRefunds(db, card, purchase) {
  const pending = db.prepare(selectPendingByRef).all(purchase.register_id, purchase.seq);
  let origin = purchase;
  for (const p of pending) {
    const decision = decideRefund(card, p.amount_cents, origin);
    if (decision.status === 'posted') {
      const balance = applyRefundEffect(db, card, origin, p.amount_cents);
      db.prepare(`
        UPDATE transactions
        SET status = 'posted', reason_code = NULL, reason_detail = NULL,
            linked_tx_id = ?, balance_after_cents = ?, posted_at = ?
        WHERE id = ?
      `).run(origin.id, balance, now(), p.id);
      origin = db.prepare('SELECT * FROM transactions WHERE id = ?').get(origin.id);
    } else {
      // 暂存转拒绝：超额原因使用暂存专属码，便于对账页区分
      const reasonCode = decision.reasonCode === 'REJECTED_REFUND_EXCEEDS'
        ? 'REJECTED_PENDING_EXCEEDS'
        : decision.reasonCode;
      db.prepare(`
        UPDATE transactions
        SET status = 'rejected', reason_code = ?, reason_detail = ?
        WHERE id = ?
      `).run(reasonCode, decision.reasonDetail, p.id);
    }
  }
}

function insertTx(db, t) {
  const sql = `
    INSERT INTO transactions (
      card_id, register_id, seq, type, amount_cents, status,
      reason_code, reason_detail, linked_ref_register, linked_ref_seq,
      linked_tx_id, balance_after_cents, posted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `;
  return db.prepare(sql).get(
    t.cardId, t.registerId, t.seq, t.type, t.amountCents, t.status,
    t.reasonCode ?? null, t.reasonDetail ?? null,
    t.refRegisterId ?? null, t.refSeq ?? null,
    t.linkedTxId ?? null, t.balanceAfter ?? null,
    t.status === 'posted' ? now() : null,
  );
}

/* --------------------------------- 查询 --------------------------------- */

export function getTransaction(db, id) {
  const row = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'TX_NOT_FOUND', `流水 #${id} 不存在`);
  return formatTx(row);
}

export function listTransactions(db, { cardId, status, type } = {}) {
  const where = [];
  const params = [];
  if (cardId) { where.push('card_id = ?'); params.push(cardId); }
  if (status) {
    if (!TX_STATUS.includes(status)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `status 必须是 ${TX_STATUS.join('/')}`);
    }
    where.push('status = ?');
    params.push(status);
  }
  if (type) {
    if (!TX_TYPES.includes(type)) {
      throw new HttpError(400, 'VALIDATION_ERROR', `type 必须是 ${TX_TYPES.join('/')}`);
    }
    where.push('type = ?');
    params.push(type);
  }
  const sql = `SELECT * FROM transactions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id ASC`;
  return db.prepare(sql).all(...params).map(formatTx);
}
