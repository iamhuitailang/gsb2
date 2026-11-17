'use strict';

const {
  ACTIONS,
  ACTION_LABELS,
  DECISION_ACTIONS,
  normalizeActions,
  directActions,
  directPermissions,
  delegationStatus,
  delegationGrant,
  effectivePermissions,
  pickSource,
  explainDenied
} = require('./permissions');

function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

function createService(db) {
  function now() {
    return Date.now() + (db.clockOffsetMs || 0);
  }

  function id(prefix) {
    db.seq = (db.seq || 0) + 1;
    return `${prefix}_${Date.now().toString(36)}${db.seq.toString(36)}`;
  }

  function getUser(userId) {
    const user = db.users.find((item) => item.id === userId);
    if (!user) throw new ServiceError(404, 'USER_NOT_FOUND', '员工不存在。');
    return user;
  }

  function getStore(storeId) {
    const store = db.stores.find((item) => item.id === storeId);
    if (!store) throw new ServiceError(404, 'STORE_NOT_FOUND', '门店不存在。');
    return store;
  }

  function getApplication(applicationId) {
    const application = db.applications.find((item) => item.id === applicationId);
    if (!application) throw new ServiceError(404, 'APPLICATION_NOT_FOUND', '调价申请不存在。');
    return application;
  }

  function getDelegation(delegationId) {
    const delegation = db.delegations.find((item) => item.id === delegationId);
    if (!delegation) throw new ServiceError(404, 'DELEGATION_NOT_FOUND', '委托不存在。');
    return delegation;
  }

  function canDecide(entry) {
    return !!entry && DECISION_ACTIONS.some((action) => entry.actions.has(action));
  }

  /* ---------------------------------------------------------------- 视图 -- */

  function userView(user) {
    return { id: user.id, name: user.name, title: user.title, role: user.role };
  }

  function effectiveView(userId, at) {
    const direct = directPermissions(db, userId);
    const effective = effectivePermissions(db, userId, at);
    return [...effective.entries()].map(([storeId, entry]) => {
      const directEntry = direct.get(storeId);
      return {
        storeId,
        storeName: getStore(storeId).name,
        actions: ACTIONS.filter((action) => entry.actions.has(action)),
        directActions: ACTIONS.filter(
          (action) => !!directEntry && directEntry.actions.has(action)
        ),
        viaDelegation: entry.sources
          .filter((source) => source.type === 'delegation')
          .map((source) => ({
            delegationId: source.delegationId,
            delegatorId: source.delegatorId,
            delegatorName: getUser(source.delegatorId).name,
            actions: source.actions,
            startsAt: source.startsAt,
            endsAt: source.endsAt
          }))
      };
    });
  }

  function delegationView(delegation, at) {
    const status = delegationStatus(delegation, at);
    const effectiveScope = Object.entries(delegationGrant(db, delegation, at) || {}).map(
      ([storeId, actions]) => ({ storeId, storeName: getStore(storeId).name, actions })
    );
    const stillCovered = delegation.storeIds.every((storeId) =>
      delegation.actions.every((action) => directActions(db, delegation.delegatorId, storeId).has(action))
    );
    // 委托还“在有效期”，但委托人已丢权：对使用者来说等价于失效，
    // 单独标出来，避免界面显示“生效中”却什么都做不了。
    const revoked = status === 'active' && effectiveScope.length === 0;
    return {
      id: delegation.id,
      delegatorId: delegation.delegatorId,
      delegatorName: getUser(delegation.delegatorId).name,
      delegateeId: delegation.delegateeId,
      delegateeName: getUser(delegation.delegateeId).name,
      storeIds: delegation.storeIds,
      storeNames: delegation.storeIds.map((storeId) => getStore(storeId).name),
      actions: delegation.actions,
      startsAt: delegation.startsAt,
      endsAt: delegation.endsAt,
      note: delegation.note || '',
      status,
      statusLabel: revoked ? '已失效（委托人权限被收回）' : STATUS_LABELS[status] || status,
      revoked,
      createdAt: delegation.createdAt,
      acceptedAt: delegation.acceptedAt,
      endedAt: delegation.endedAt,
      endedReason: delegation.endedReason || null,
      delegatorScopeIntact: stillCovered,
      // 便于前端展示“当前实际生效范围”
      effectiveScope
    };
  }

  const STATUS_LABELS = {
    pending_acceptance: '待接受',
    scheduled: '未生效',
    active: '生效中',
    expired: '已到期',
    ended: '已结束',
    declined: '已拒绝'
  };

  function applicationView(application, userId, at) {
    const entry = effectivePermissions(db, userId, at).get(application.storeId);
    const store = getStore(application.storeId);
    return {
      id: application.id,
      storeId: application.storeId,
      storeName: store.name,
      requesterId: application.requesterId,
      requesterName: getUser(application.requesterId).name,
      product: application.product,
      sku: application.sku,
      unit: application.unit,
      originalPrice: application.originalPrice,
      proposedPrice: application.proposedPrice,
      delta: Number((application.proposedPrice - application.originalPrice).toFixed(2)),
      deltaPercent: Number(
        (((application.proposedPrice - application.originalPrice) / application.originalPrice) * 100).toFixed(1)
      ),
      reason: application.reason,
      status: application.status,
      createdAt: application.createdAt,
      decision: application.decision,
      permission: {
        canView: !!entry && entry.actions.has('view'),
        canApprove: !!entry && entry.actions.has('approve'),
        canReject: !!entry && entry.actions.has('reject'),
        sources: entry ? entry.sources : []
      }
    };
  }

  function getState(userId) {
    const at = now();
    const user = userId ? getUser(userId) : null;
    return {
      clock: {
        now: at,
        offsetMs: db.clockOffsetMs || 0,
        simulated: (db.clockOffsetMs || 0) !== 0
      },
      users: db.users.map(userView),
      stores: db.stores,
      currentUser: user ? userView(user) : null,
      permissions: user ? effectiveView(user.id, at) : [],
      delegations: db.delegations.map((delegation) => delegationView(delegation, at)),
      todos: user ? listTodos(user.id) : [],
      grants: db.grants.map((grant) => ({
        userId: grant.userId,
        userName: getUser(grant.userId).name,
        storeId: grant.storeId,
        storeName: getStore(grant.storeId).name,
        actions: grant.actions,
        active: grant.active !== false
      }))
    };
  }

  /* ----------------------------------------------------------- 待办列表 -- */

  function listTodos(userId) {
    const at = now();
    getUser(userId);
    const permissions = effectivePermissions(db, userId, at);

    return db.applications
      .filter((application) => application.status === 'pending')
      // 待办只列“能处理”的申请：仅可查看的委托不产生待办。
      .filter((application) => canDecide(permissions.get(application.storeId)))
      .map((application) => {
        const entry = permissions.get(application.storeId);
        // 取一个真正存在的审核动作，判断这条待办是自有权限还是代来的。
        const viaAction = DECISION_ACTIONS.find((action) => entry.actions.has(action)) || 'view';
        const source = pickSource(entry, viaAction);
        return {
          ...applicationView(application, userId, at),
          storeName: getStore(application.storeId).name,
          source: source.type === 'delegation'
            ? {
                type: 'delegation',
                label: `代 ${getUser(source.delegatorId).name} 审核`,
                delegationId: source.delegationId,
                endsAt: source.endsAt
              }
            : { type: 'direct', label: '自有权限' }
        };
      })
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function getApplicationForUser(userId, applicationId) {
    const at = now();
    getUser(userId);
    const application = getApplication(applicationId);
    const entry = effectivePermissions(db, userId, at).get(application.storeId);
    if (!entry || !entry.actions.has('view')) {
      const denied = explainDenied(db, userId, application.storeId, 'view', at);
      throw new ServiceError(403, denied.code, denied.message);
    }
    return {
      application: applicationView(application, userId, at),
      clockNow: at
    };
  }

  /* --------------------------------------------------------------- 审核 -- */

  function decide(userId, applicationId, action, comment) {
    const at = now();
    getUser(userId);
    if (!DECISION_ACTIONS.includes(action)) {
      throw new ServiceError(400, 'INVALID_ACTION', '只支持 approve 或 reject。');
    }
    const application = getApplication(applicationId);
    const entry = effectivePermissions(db, userId, at).get(application.storeId);
    if (!entry || !entry.actions.has(action)) {
      const denied = explainDenied(db, userId, application.storeId, action, at);
      throw new ServiceError(403, denied.code, denied.message);
    }
    if (application.status !== 'pending') {
      throw new ServiceError(409, 'APPLICATION_CLOSED', '该申请已被处理，请刷新待办。');
    }

    const source = pickSource(entry, action);
    application.status = action === 'approve' ? 'approved' : 'rejected';
    application.decision = {
      action,
      by: userId,
      byName: getUser(userId).name,
      at: new Date(at).toISOString(),
      via: source,
      comment: text(comment, 200) || null
    };

    if (source.type === 'delegation') {
      const delegation = getDelegation(source.delegationId);
      delegation.usage = delegation.usage || [];
      delegation.usage.push({ applicationId, action, at: application.decision.at });
    }

    return { application: applicationView(application, userId, at) };
  }

  /* --------------------------------------------------------------- 委托 -- */

  function validateDelegationInput(payload) {
    const { delegatorId, delegateeId, storeIds, actions, startsAt, endsAt } = payload || {};
    const delegator = getUser(delegatorId);
    const delegatee = getUser(delegateeId);

    if (delegator.id === delegatee.id) {
      throw new ServiceError(400, 'SELF_DELEGATION', '不能把权限委托给自己。');
    }
    if (!Array.isArray(storeIds) || storeIds.length === 0) {
      throw new ServiceError(400, 'STORE_REQUIRED', '请选择至少一个门店。');
    }
    const stores = [...new Set(storeIds)];
    stores.forEach(getStore);

    const normalizedActions = normalizeActions(Array.isArray(actions) ? actions : []);
    if (!normalizedActions.some((action) => DECISION_ACTIONS.includes(action))) {
      throw new ServiceError(400, 'ACTION_REQUIRED', '请至少勾选一个审核动作。');
    }

    const startMs = new Date(startsAt || '').getTime();
    const endMs = new Date(endsAt || '').getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new ServiceError(400, 'INVALID_TIME', '开始/结束时间格式不正确。');
    }
    if (endMs <= startMs) {
      throw new ServiceError(400, 'INVALID_TIME_RANGE', '结束时间必须晚于开始时间。');
    }
    const at = now();
    if (endMs <= at) {
      throw new ServiceError(400, 'END_IN_PAST', '结束时间必须晚于当前时间。');
    }

    // 委托范围不得超出发起人“当前自有权限”；只经委托得来的权限不可再委托。
    for (const storeId of stores) {
      const own = directActions(db, delegator.id, storeId);
      const missing = normalizedActions.filter((action) => !own.has(action));
      if (missing.length === 0) continue;

      // 发起人自己也是“受托人”时，任何来自委托的权限都不能再转出去。
      const fromDelegation = db.delegations.some(
        (delegation) =>
          delegation.delegateeId === delegator.id &&
          delegation.storeIds.includes(storeId) &&
          delegation.actions.some((action) => missing.includes(action)) &&
          ['active', 'scheduled', 'pending_acceptance'].includes(delegationStatus(delegation, at))
      );
      const storeName = getStore(storeId).name;
      const missingLabels = missing.map((action) => ACTION_LABELS[action] || action).join('、');
      if (fromDelegation) {
        throw new ServiceError(
          403,
          'DELEGATION_CANNOT_BE_REDELEGATED',
          `「${storeName}」的${missingLabels}权限来自他人的委托，不能再转委托给第三人。`
        );
      }
      throw new ServiceError(
        403,
        'SCOPE_EXCEEDS_OWN_PERMISSION',
        `你对「${storeName}」没有 ${missingLabels} 权限，委托范围不能超过自己的权限。`
      );
    }

    return { delegator, delegatee, stores, actions: normalizedActions, startMs, endMs };
  }

  function createDelegation(payload) {
    const { delegator, delegatee, stores, actions, startMs, endMs } = validateDelegationInput(payload);
    const at = now();

    // 同一委托人给同一人的多条委托允许并存：有效权限取并集，
    // 每条委托各自有自己的时间窗与动作范围，更容易表达“换班接力”。
    const delegation = {
      id: id('d'),
      delegatorId: delegator.id,
      delegateeId: delegatee.id,
      storeIds: stores,
      actions,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      createdAt: new Date(at).toISOString(),
      acceptedAt: null,
      endedAt: null,
      endedReason: null,
      note: text(payload.note, 200),
      usage: []
    };
    db.delegations.push(delegation);
    return { delegation: delegationView(delegation, at) };
  }

  function acceptDelegation(userId, delegationId) {
    const at = now();
    const delegation = getDelegation(delegationId);
    if (delegation.delegateeId !== userId) {
      throw new ServiceError(403, 'NOT_DELEGATEE', '只有被委托人本人可以接受该委托。');
    }
    const status = delegationStatus(delegation, at);
    if (status === 'expired') {
      throw new ServiceError(409, 'DELEGATION_EXPIRED', '委托已到期，无法接受。');
    }
    if (status === 'ended') {
      throw new ServiceError(409, 'DELEGATION_ENDED', '委托已被结束，无法接受。');
    }
    if (status === 'declined') {
      throw new ServiceError(409, 'DELEGATION_DECLINED', '该委托已被拒绝。');
    }
    if (delegation.acceptedAt) {
      return { delegation: delegationView(delegation, at) };
    }
    delegation.acceptedAt = new Date(at).toISOString();
    return { delegation: delegationView(delegation, at) };
  }

  function declineDelegation(userId, delegationId) {
    const at = now();
    const delegation = getDelegation(delegationId);
    if (delegation.delegateeId !== userId) {
      throw new ServiceError(403, 'NOT_DELEGATEE', '只有被委托人本人可以处理该委托。');
    }
    const status = delegationStatus(delegation, at);
    if (status === 'ended') {
      throw new ServiceError(409, 'DELEGATION_ENDED', '委托已被结束。');
    }
    if (status === 'expired') {
      throw new ServiceError(409, 'DELEGATION_EXPIRED', '委托已到期。');
    }
    if (delegation.acceptedAt) {
      throw new ServiceError(409, 'ALREADY_ACCEPTED', '已接受的委托不能拒绝，请由发起人结束。');
    }
    delegation.declinedAt = new Date(at).toISOString();
    return { delegation: delegationView(delegation, at) };
  }

  function endDelegation(userId, delegationId, reason) {
    const at = now();
    const delegation = getDelegation(delegationId);
    if (delegation.delegatorId !== userId) {
      throw new ServiceError(403, 'NOT_DELEGATOR', '只有发起人可以结束该委托。');
    }
    if (delegation.endedAt) {
      return { delegation: delegationView(delegation, at) };
    }
    if (delegationStatus(delegation, at) === 'expired') {
      throw new ServiceError(409, 'DELEGATION_EXPIRED', '委托已到期。');
    }
    delegation.endedAt = new Date(at).toISOString();
    delegation.endedReason = text(reason, 200) || '发起人提前结束';
    return { delegation: delegationView(delegation, at) };
  }

  /* ----------------------------------------------------------- 权限收回 -- */

  function setGrantActive(userId, storeId, active) {
    getUser(userId);
    getStore(storeId);
    if (typeof active !== 'boolean') {
      throw new ServiceError(400, 'INVALID_ACTIVE', 'active 必须是布尔值。');
    }
    const grant = db.grants.find((item) => item.userId === userId && item.storeId === storeId);
    if (!grant) throw new ServiceError(404, 'GRANT_NOT_FOUND', '没有找到该门店的权限记录。');
    grant.active = active;
    return { grant: { ...grant } };
  }

  /* --------------------------------------------------------------- 时钟 -- */

  function setClock({ offsetMs, iso } = {}) {
    // 允许负偏移：演示时可以把时钟往前拨，观察“委托尚未开始”等状态。
    if (Number.isFinite(offsetMs)) {
      db.clockOffsetMs = Math.round(offsetMs);
    } else if (iso) {
      const target = new Date(iso).getTime();
      if (!Number.isFinite(target)) {
        throw new ServiceError(400, 'INVALID_TIME', '演示时钟时间格式不正确。');
      }
      db.clockOffsetMs = target - Date.now();
    } else {
      throw new ServiceError(400, 'INVALID_CLOCK', '请提供 offsetMs 或 iso。');
    }
    return { clock: { now: now(), offsetMs: db.clockOffsetMs, simulated: db.clockOffsetMs !== 0 } };
  }

  return {
    now,
    getState,
    listTodos,
    getApplicationForUser,
    decide,
    createDelegation,
    acceptDelegation,
    declineDelegation,
    endDelegation,
    setGrantActive,
    setClock
  };
}

module.exports = { createService, ServiceError };
