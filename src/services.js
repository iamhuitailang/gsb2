// 业务服务层：所有写操作都在数据库事务内完成，
// 通过「行锁 + 版本号校验 + 唯一约束」三重机制保证并发正确性。
import {
  INSTRUCTION_STATUS,
  REQUIRED_APPROVALS,
  nowIso,
  resetDatabase,
} from './db.js';

export class ServiceError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.httpStatus = status;
    Object.assign(this, extra);
  }
}

// 金额由「元」转「分」，杜绝浮点误差；非法或非正数返回校验错误
function yuanToCents(yuan, fieldLabel = '金额') {
  if (typeof yuan !== 'number' || !Number.isFinite(yuan)) {
    throw new ServiceError('VALIDATION_ERROR', `${fieldLabel}必须是数字`);
  }
  if (yuan <= 0) {
    throw new ServiceError('VALIDATION_ERROR', `${fieldLabel}必须大于 0`);
  }
  const cents = Math.round(yuan * 100);
  if (Math.abs(cents / 100 - yuan) > 1e-9) {
    throw new ServiceError('VALIDATION_ERROR', `${fieldLabel}最小单位为 0.01 元`);
  }
  return cents;
}

export function createService(db) {
  // ---------- 内部工具 ----------

  function getUser(userId) {
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId);
    if (!user) throw new ServiceError('USER_NOT_FOUND', '用户不存在', 404);
    return user;
  }

  function getInstruction(id) {
    const row = db.prepare('SELECT * FROM instructions WHERE id = ?').get(id);
    if (!row) throw new ServiceError('INSTRUCTION_NOT_FOUND', '付款指令不存在', 404);
    return row;
  }

  function assertEditable(instr) {
    if (instr.status === INSTRUCTION_STATUS.PENDING_EXECUTION) {
      throw new ServiceError(
        'INSTRUCTION_FINALIZED',
        '指令已进入待执行，不能再修改',
        409,
      );
    }
  }

  function addAuditEvent(instrId, version, actorId, action, detail) {
    db.prepare(`
      INSERT INTO audit_events (instruction_id, version, actor_id, action, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(instrId, version ?? null, actorId, action, detail ?? null, nowIso());
  }

  // 被拒绝的尝试也要留痕（在回滚之后、自动提交状态下写入）
  function logRejection(instrId, version, actorId, detail) {
    addAuditEvent(instrId, version, actorId, 'APPROVAL_REJECTED', detail);
  }

  // ---------- 查询 ----------

  function listUsers() {
    return db.prepare('SELECT id, name, role FROM users ORDER BY id').all();
  }

  function listInstructions() {
    return db.prepare(`
      SELECT
        i.id, i.instruction_no, i.current_version, i.status, i.created_at,
        u.name AS submitter_name,
        v.payee, v.amount_cents,
        (SELECT COUNT(*) FROM approvals a
          WHERE a.instruction_id = i.id AND a.version = i.current_version
        ) AS approval_count
      FROM instructions i
      JOIN users u ON u.id = i.submitter_id
      JOIN instruction_versions v
        ON v.instruction_id = i.id AND v.version = i.current_version
      ORDER BY i.created_at DESC
    `).all();
  }

  function getInstructionDetail(id) {
    const instr = getInstruction(id);
    const submitter = db.prepare('SELECT id, name, role FROM users WHERE id = ?')
      .get(instr.submitter_id);

    const versions = db.prepare(`
      SELECT * FROM instruction_versions
      WHERE instruction_id = ? ORDER BY version ASC
    `).all(id);

    const approvals = db.prepare(`
      SELECT a.*, u.name AS reviewer_name
      FROM approvals a JOIN users u ON u.id = a.reviewer_id
      WHERE a.instruction_id = ?
      ORDER BY a.version ASC, a.created_at ASC
    `).all(id);

    const events = db.prepare(`
      SELECT e.*, u.name AS actor_name
      FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.instruction_id = ?
      ORDER BY e.id ASC
    `).all(id);

    const approvalsByVersion = new Map();
    for (const a of approvals) {
      if (!approvalsByVersion.has(a.version)) approvalsByVersion.set(a.version, []);
      approvalsByVersion.get(a.version).push(a);
    }

    return {
      ...instr,
      submitter,
      required_approvals: REQUIRED_APPROVALS,
      versions: versions.map((v) => ({
        ...v,
        approvals: approvalsByVersion.get(v.version) ?? [],
      })),
      audit_events: events,
    };
  }

  // ---------- 写入 ----------

  function createInstruction({ userId, payee, amountYuan }) {
    const user = getUser(userId);
    if (user.role !== 'SUBMITTER') {
      throw new ServiceError('FORBIDDEN_NOT_SUBMITTER', '只有提交人可以创建付款指令', 403);
    }
    const trimmedPayee = String(payee ?? '').trim();
    if (!trimmedPayee) {
      throw new ServiceError('VALIDATION_ERROR', '收款方不能为空');
    }
    const amountCents = yuanToCents(amountYuan);

    db.exec('BEGIN IMMEDIATE');
    try {
      const id = `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const seq = db.prepare('SELECT COUNT(*) AS n FROM instructions').get().n + 1;
      const instructionNo = `PI-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${String(seq).padStart(4, '0')}`;
      const ts = nowIso();

      db.prepare(`
        INSERT INTO instructions (id, instruction_no, submitter_id, current_version, status, created_at)
        VALUES (?, ?, ?, 1, 'PENDING_APPROVAL', ?)
      `).run(id, instructionNo, user.id, ts);

      db.prepare(`
        INSERT INTO instruction_versions
          (instruction_id, version, payee, amount_cents, change_summary, created_by, created_at)
        VALUES (?, 1, ?, ?, '初始提交', ?, ?)
      `).run(id, trimmedPayee, amountCents, user.id, ts);

      addAuditEvent(
        id, 1, user.id, 'CREATED',
        `${user.name} 创建付款指令，金额 ${formatYuan(amountCents)} 元，收款方：${trimmedPayee}`,
      );
      db.exec('COMMIT');
      return getInstructionDetail(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function assertExpectedVersion(expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new ServiceError('VALIDATION_ERROR', 'expected_version 必须是正整数');
    }
  }

  // 提交人修改收款方/金额 → 生成新版本；旧版本上的复核记录保留但不再有效
  function editInstruction({ id, userId, payee, amountYuan, expectedVersion }) {
    const user = getUser(userId);
    if (user.role !== 'SUBMITTER') {
      throw new ServiceError('FORBIDDEN_NOT_SUBMITTER', '只有提交人可以修改付款指令', 403);
    }
    assertExpectedVersion(expectedVersion);
    const trimmedPayee = String(payee ?? '').trim();
    if (!trimmedPayee) {
      throw new ServiceError('VALIDATION_ERROR', '收款方不能为空');
    }
    const amountCents = yuanToCents(amountYuan);

    db.exec('BEGIN IMMEDIATE');
    try {
      const instr = getInstruction(id);
      assertEditable(instr);

      if (expectedVersion !== instr.current_version) {
        throw new ServiceError(
          'VERSION_CHANGED',
          `页面已过期：当前版本为 v${instr.current_version}，你编辑的是 v${expectedVersion}`,
          409,
          { current_version: instr.current_version },
        );
      }

      const current = db.prepare(`
        SELECT * FROM instruction_versions
        WHERE instruction_id = ? AND version = ?
      `).get(id, instr.current_version);

      if (current.payee === trimmedPayee && current.amount_cents === amountCents) {
        throw new ServiceError('VALIDATION_ERROR', '收款方和金额均未变化，无需生成新版本');
      }

      const changes = [];
      if (current.payee !== trimmedPayee) {
        changes.push(`收款方：${current.payee} → ${trimmedPayee}`);
      }
      if (current.amount_cents !== amountCents) {
        changes.push(`金额：${formatYuan(current.amount_cents)} 元 → ${formatYuan(amountCents)} 元`);
      }
      const summary = changes.join('；');
      const nextVersion = instr.current_version + 1;
      const ts = nowIso();

      db.prepare(`
        INSERT INTO instruction_versions
          (instruction_id, version, payee, amount_cents, change_summary, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextVersion, trimmedPayee, amountCents, summary, user.id, ts);

      db.prepare('UPDATE instructions SET current_version = ? WHERE id = ?')
        .run(nextVersion, id);

      addAuditEvent(
        id, nextVersion, user.id, 'UPDATED',
        `${user.name} 修改指令（v${current.version} → v${nextVersion}）：${summary}。旧版本复核记录不再计入新版本`,
      );
      db.exec('COMMIT');
      return getInstructionDetail(id);
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 复核同意。整个流程在一个 IMMEDIATE 事务内：
   * 1. 锁定指令行，串行化并发复核
   * 2. 校验复核人权限（复核人角色 + 不能是提交人本人）
   * 3. 校验 expectedVersion 必须等于当前版本（乐观并发控制）
   * 4. 同一复核人对同一版本重复点击 → 幂等返回，只算一次
   * 5. 达到 REQUIRED_APPROVALS 条有效复核 → 状态翻转为待执行（只发生一次）
   */
  function approve({ id, userId, expectedVersion }) {
    const user = getUser(userId);
    const instr = getInstruction(id); // 事务外先确认指令存在，便于 404
    assertExpectedVersion(expectedVersion);

    db.exec('BEGIN IMMEDIATE');
    try {
      const locked = getInstruction(id);
      assertEditable(locked);

      // 自我复核优先于角色校验：提交人点自己指令的复核按钮时给出最贴切的原因
      if (locked.submitter_id === user.id) {
        throw new ServiceError(
          'FORBIDDEN_SELF_REVIEW',
          '提交人不能给自己的付款指令复核',
          403,
        );
      }
      if (user.role !== 'REVIEWER') {
        throw new ServiceError('FORBIDDEN_NOT_REVIEWER', '只有复核人可以执行复核操作', 403);
      }

      if (expectedVersion !== locked.current_version) {
        throw new ServiceError(
          'VERSION_CHANGED',
          `版本已变化：指令已更新到 v${locked.current_version}，你复核的是 v${expectedVersion}，旧版本复核无效，请刷新后核对新版本`,
          409,
          { current_version: locked.current_version },
        );
      }

      // 幂等：同一复核人对同一版本重复点击，直接返回既有记录
      const existing = db.prepare(`
        SELECT * FROM approvals
        WHERE instruction_id = ? AND version = ? AND reviewer_id = ?
      `).get(id, locked.current_version, user.id);
      if (existing) {
        db.exec('COMMIT');
        return {
          duplicate: true,
          detail: getInstructionDetail(id),
          message: `你已对 v${locked.current_version} 复核同意，重复点击不重复计数`,
        };
      }

      const ts = nowIso();
      db.prepare(`
        INSERT INTO approvals (instruction_id, version, reviewer_id, decision, created_at)
        VALUES (?, ?, ?, 'APPROVED', ?)
      `).run(id, locked.current_version, user.id, ts);

      addAuditEvent(
        id, locked.current_version, user.id, 'APPROVED',
        `${user.name} 同意复核（v${locked.current_version}）`,
      );

      const countRow = db.prepare(`
        SELECT COUNT(*) AS n FROM approvals
        WHERE instruction_id = ? AND version = ?
      `).get(id, locked.current_version);

      let enteredPendingExecution = false;
      if (countRow.n >= REQUIRED_APPROVALS &&
          locked.status === INSTRUCTION_STATUS.PENDING_APPROVAL) {
        db.prepare(`
          UPDATE instructions SET status = ? WHERE id = ? AND status = ?
        `).run(INSTRUCTION_STATUS.PENDING_EXECUTION, id, INSTRUCTION_STATUS.PENDING_APPROVAL);
        addAuditEvent(
          id, locked.current_version, user.id, 'ENTERED_PENDING_EXECUTION',
          `v${locked.current_version} 集齐 ${REQUIRED_APPROVALS} 名不同复核人同意，指令进入待执行`,
        );
        enteredPendingExecution = true;
      }

      db.exec('COMMIT');
      return {
        duplicate: false,
        entered_pending_execution: enteredPendingExecution,
        detail: getInstructionDetail(id),
      };
    } catch (err) {
      db.exec('ROLLBACK');
      // 被拒绝的复核尝试同样留痕（回滚后在自动提交状态写入，不影响主流程数据）
      if (err instanceof ServiceError &&
          ['FORBIDDEN_NOT_REVIEWER', 'FORBIDDEN_SELF_REVIEW', 'VERSION_CHANGED'].includes(err.code)) {
        try {
          logRejection(id, expectedVersion ?? null, user.id, `${user.name} 的复核被拒绝：${err.message}`);
        } catch {
          // 留痕失败不掩盖原始业务错误
        }
      }
      throw err;
    }
  }

  function reset() {
    resetDatabase(db);
    return listInstructions().map((row) => getInstructionDetail(row.id));
  }

  return {
    listUsers,
    listInstructions,
    getInstructionDetail,
    createInstruction,
    editInstruction,
    approve,
    reset,
  };
}

export function formatYuan(cents) {
  return (cents / 100).toFixed(2);
}
