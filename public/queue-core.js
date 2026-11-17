/**
 * 草稿队列的纯逻辑：不碰 DOM、不碰网络，方便直接单测。
 *
 * 状态含义：
 *   pending       还没发出去（断网保存 / 等待同步）
 *   syncing       正在发送
 *   needs_action  服务端没接收，需要用户处理（授权撤销、内容不合格、编号冲突等）
 *   synced        服务端已入库
 */

export const STATE = Object.freeze({
  PENDING: 'pending',
  SYNCING: 'syncing',
  NEEDS_ACTION: 'needs_action',
  SYNCED: 'synced',
});

const STATE_ORDER = [STATE.PENDING, STATE.SYNCING, STATE.NEEDS_ACTION, STATE.SYNCED];

export function normalizeDrafts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((draft) => draft && typeof draft.id === 'string' && typeof draft.checkpointId === 'string')
    .map((draft) => {
      // 页面刷新时若停在「发送中」，说明上次发送结果未知，回到待发送由服务端去重兜底。
      const state = draft.state === STATE.SYNCING ? STATE.PENDING : draft.state;
      return {
        ...draft,
        state: STATE_ORDER.includes(state) ? state : STATE.PENDING,
        attempts: Number.isInteger(draft.attempts) ? draft.attempts : 0,
        payload: draft.payload ?? { answers: {}, note: '' },
      };
    });
}

export function createDraft({ id, checkpointId, checkpointName, payload, now }) {
  const at = now ?? new Date().toISOString();
  return {
    id,
    checkpointId,
    checkpointName: checkpointName ?? '',
    payload,
    createdAt: at,
    updatedAt: at,
    state: STATE.PENDING,
    attempts: 0,
    lastError: null,
    receipt: null,
  };
}

/** 重新编辑一条尚未入库的草稿：内容更新后重新进入待发送，并清掉上次的拦截原因。 */
export function updateDraftPayload(draft, payload, now = new Date().toISOString()) {
  draft.payload = payload;
  draft.updatedAt = now;
  draft.state = STATE.PENDING;
  draft.lastError = null;
  return draft;
}

export function markSyncing(draft) {
  draft.state = STATE.SYNCING;
  return draft;
}

export function markSynced(draft, record, { duplicate = false, now = new Date().toISOString() } = {}) {
  draft.state = STATE.SYNCED;
  draft.attempts += 1;
  draft.lastAttemptAt = now;
  draft.lastError = null;
  draft.receipt = {
    seq: record.seq,
    receivedAt: record.receivedAt,
    duplicate: Boolean(duplicate),
  };
  return draft;
}

export function markNeedsAction(draft, error, now = new Date().toISOString()) {
  draft.state = STATE.NEEDS_ACTION;
  draft.attempts += 1;
  draft.lastAttemptAt = now;
  draft.lastError = {
    code: error.code ?? 'REQUEST_FAILED',
    message: error.message ?? '上报失败',
    status: error.status ?? null,
  };
  return draft;
}

export function markOffline(draft, message = '网络中断，稍后重试') {
  draft.state = STATE.PENDING;
  draft.lastError = { code: 'OFFLINE', message };
  return draft;
}

/**
 * 同步目标：待发送 + 需处理。
 * 已成功的不再重发（服务端也会按草稿编号去重）；
 * 需处理的会再核一次权限，若主管已恢复授权就能自动入库。
 */
export function selectSyncTargets(drafts, onlyId = null) {
  const actionable = drafts.filter(
    (draft) => draft.state === STATE.PENDING || draft.state === STATE.NEEDS_ACTION,
  );
  return onlyId ? actionable.filter((draft) => draft.id === onlyId) : actionable;
}

export function summarize(drafts) {
  const counts = {
    [STATE.PENDING]: 0,
    [STATE.SYNCING]: 0,
    [STATE.NEEDS_ACTION]: 0,
    [STATE.SYNCED]: 0,
  };
  for (const draft of drafts) counts[draft.state] = (counts[draft.state] ?? 0) + 1;
  return {
    total: drafts.length,
    notSent: counts[STATE.PENDING] + counts[STATE.SYNCING],
    needsAction: counts[STATE.NEEDS_ACTION],
    succeeded: counts[STATE.SYNCED],
    counts,
  };
}

/** 同一检查点内按状态分组排序，便于队列展示。 */
export function groupByCheckpoint(drafts) {
  const groups = new Map();
  for (const draft of drafts) {
    if (!groups.has(draft.checkpointId)) groups.set(draft.checkpointId, []);
    groups.get(draft.checkpointId).push(draft);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const byState = STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state);
      return byState !== 0 ? byState : String(a.createdAt).localeCompare(String(b.createdAt));
    });
  }
  return groups;
}

/**
 * 逐条上报：一条没通过不中断其它条，只有断网才中止后续。
 *
 * @param {Array} drafts   队列（会被就地更新）
 * @param {object} options
 * @param {(draft) => Promise<{record: object, duplicate?: boolean}>} options.submit
 * @param {(draft) => boolean} [options.isOffline]
 * @param {string|null} [options.onlyId]
 * @param {() => void} [options.onChange]  每条状态变化后回调，用于刷新界面
 */
export async function runSync(drafts, { submit, isOffline = () => false, onlyId = null, onChange } = {}) {
  const result = { accepted: 0, blocked: 0, interrupted: false, duplicates: [] };
  const targets = selectSyncTargets(drafts, onlyId);
  if (targets.length === 0) return result;

  for (const draft of targets) {
    if (isOffline()) {
      markOffline(draft);
      result.interrupted = true;
      break;
    }
    markSyncing(draft);
    onChange?.();
    try {
      const res = await submit(draft);
      markSynced(draft, res.record, { duplicate: res.duplicate });
      result.accepted += 1;
      if (res.duplicate) result.duplicates.push({ draft, record: res.record });
    } catch (error) {
      if (error?.kind === 'offline') {
        markOffline(draft);
        result.interrupted = true;
        break;
      }
      markNeedsAction(draft, error);
      result.blocked += 1;
    }
    onChange?.();
  }
  return result;
}
