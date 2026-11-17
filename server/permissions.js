'use strict';

const { ACTIONS } = require('./store');

const DECISION_ACTIONS = ['approve', 'reject'];
const ACTION_LABELS = {
  view: '查看',
  approve: '审核通过',
  reject: '审核驳回'
};

function isValidAction(action) {
  return ACTIONS.includes(action);
}

/**
 * 去重；审核动作隐含“查看”（否则值班员无法打开审核页）。
 */
function normalizeActions(actions) {
  const out = [];
  for (const action of actions) {
    if (isValidAction(action) && !out.includes(action)) out.push(action);
  }
  if (out.some((action) => DECISION_ACTIONS.includes(action)) && !out.includes('view')) {
    out.unshift('view');
  }
  return out;
}

function timeOf(value) {
  return new Date(value).getTime();
}

/** 直接授予（自有权限），不含任何代来的权限。 */
function directActions(db, userId, storeId) {
  const result = new Set();
  for (const grant of db.grants) {
    if (grant.userId !== userId || grant.storeId !== storeId) continue;
    if (grant.active === false) continue;
    for (const action of grant.actions) result.add(action);
  }
  // 审核动作必然包含查看；即使权限记录只写了 approve，也应能打开审核页。
  if (result.has('approve') || result.has('reject')) result.add('view');
  return result;
}

function directPermissions(db, userId) {
  const map = new Map();
  for (const grant of db.grants) {
    if (grant.userId !== userId || grant.active === false) continue;
    let entry = map.get(grant.storeId);
    if (!entry) {
      entry = { actions: new Set(), sources: [] };
      map.set(grant.storeId, entry);
    }
    // 与 directActions 保持一致：审核动作隐含查看。
    const actions = [...grant.actions];
    if (actions.some((action) => DECISION_ACTIONS.includes(action)) && !actions.includes('view')) {
      actions.unshift('view');
    }
    for (const action of actions) entry.actions.add(action);
    entry.sources.push({ type: 'direct', grantId: grant.id, actions });
  }
  return map;
}

function delegationStatus(delegation, now) {
  if (delegation.declinedAt) return 'declined';
  if (delegation.endedAt) return 'ended';
  if (!delegation.acceptedAt) {
    return now > timeOf(delegation.endsAt) ? 'expired' : 'pending_acceptance';
  }
  if (now < timeOf(delegation.startsAt)) return 'scheduled';
  if (now > timeOf(delegation.endsAt)) return 'expired';
  return 'active';
}

/**
 * 一条委托此刻真正能给出的权限。
 * 逐项与发起人“当前的自有权限”取交集——发起人被收回权限时，
 * 代来的权限会同步消失，无需额外清理动作。
 */
function delegationGrant(db, delegation, now) {
  if (delegationStatus(delegation, now) !== 'active') return null;
  const byStore = {};
  let any = false;
  for (const storeId of delegation.storeIds) {
    const own = directActions(db, delegation.delegatorId, storeId);
    const allowed = delegation.actions.filter((action) => own.has(action));
    if (allowed.length > 0) {
      byStore[storeId] = allowed;
      any = true;
    }
  }
  return any ? byStore : null;
}

function effectivePermissions(db, userId, now) {
  const map = directPermissions(db, userId);
  for (const delegation of db.delegations) {
    if (delegation.delegateeId !== userId) continue;
    const granted = delegationGrant(db, delegation, now);
    if (!granted) continue;
    for (const [storeId, actions] of Object.entries(granted)) {
      let entry = map.get(storeId);
      if (!entry) {
        entry = { actions: new Set(), sources: [] };
        map.set(storeId, entry);
      }
      for (const action of actions) entry.actions.add(action);
      entry.sources.push({
        type: 'delegation',
        delegationId: delegation.id,
        delegatorId: delegation.delegatorId,
        actions,
        startsAt: delegation.startsAt,
        endsAt: delegation.endsAt
      });
    }
  }
  return map;
}

function pickSource(entry, action) {
  if (!entry) return { type: 'none' };
  for (const source of entry.sources) {
    if (source.type === 'direct' && source.actions.includes(action)) {
      return { type: 'direct' };
    }
  }
  for (const source of entry.sources) {
    if (source.type === 'delegation' && source.actions.includes(action)) {
      return {
        type: 'delegation',
        delegationId: source.delegationId,
        delegatorId: source.delegatorId,
        startsAt: source.startsAt,
        endsAt: source.endsAt
      };
    }
  }
  return { type: 'none' };
}

/**
 * 无权时给前端一个可解释的原因（用于被拦截的审核页）。
 */
function explainDenied(db, userId, storeId, action, now) {
  const inactiveDirect = db.grants.find(
    (grant) =>
      grant.userId === userId &&
      grant.storeId === storeId &&
      grant.active === false &&
      grant.actions.includes(action)
  );
  if (inactiveDirect) {
    return {
      code: 'DIRECT_PERMISSION_REVOKED',
      message: '你在该门店的直接权限已被收回，无法继续处理。'
    };
  }

  const allRelated = db.delegations.filter(
    (delegation) =>
      delegation.delegateeId === userId && delegation.storeIds.includes(storeId)
  );
  // 优先解释“本来覆盖这个动作”的委托，避免多个委托并存时给出不相干的到期原因。
  const covering = allRelated.filter((delegation) => delegation.actions.includes(action));
  const related = covering.length > 0 ? covering : allRelated;

  for (const delegation of related) {
    const status = delegationStatus(delegation, now);
    if (status === 'declined') continue;
    if (status === 'ended') {
      return {
        code: 'DELEGATION_ENDED',
        message: '该代审委托已被发起人提前结束，当前无法提交审核。'
      };
    }
    if (status === 'expired') {
      return {
        code: 'DELEGATION_EXPIRED',
        message: '该代审委托已到期，当前无法提交审核。'
      };
    }
    if (status === 'pending_acceptance') {
      return {
        code: 'DELEGATION_NOT_ACCEPTED',
        message: '该代审委托尚未接受，当前无法处理申请。'
      };
    }
    if (status === 'scheduled') {
      return {
        code: 'DELEGATION_NOT_STARTED',
        message: '该代审委托尚未生效，当前无法处理申请。'
      };
    }

    const own = directActions(db, delegation.delegatorId, storeId);
    if (delegation.actions.includes(action) && !own.has(action)) {
      return {
        code: 'DELEGATOR_PERMISSION_REVOKED',
        message: '委托人的权限已被收回，代审权限同步失效。'
      };
    }
    const allowed = delegation.actions.filter((item) => own.has(item));
    if (allowed.length === 0) {
      return {
        code: 'DELEGATOR_PERMISSION_REVOKED',
        message: '委托人的权限已被收回，代审权限同步失效。'
      };
    }
    if (!allowed.includes(action)) {
      return {
        code: 'ACTION_NOT_DELEGATED',
        message: `该委托未包含「${ACTION_LABELS[action] || action}」动作。`
      };
    }
  }

  return {
    code: 'NO_PERMISSION',
    message: '你没有该门店的审核权限。'
  };
}

module.exports = {
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
};
