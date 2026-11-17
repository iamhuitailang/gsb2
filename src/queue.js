/**
 * 盘点写入队列。
 *
 * 盘点提交不会立刻落库，而是生成一个排队任务，到执行时刻才真正写入库存。
 * 关键规则：入队时核对一次范围，任务真正执行写入前必须"再次确认"
 * 同一把钥匙与所属服务账号此刻仍然有效——重叠期到期、账号被停用都会拒写。
 */
import { randomUUID } from 'node:crypto';
import { authorize } from './auth.js';
import { ACTIONS } from './store.js';
import { keyStatus } from './credentials.js';
import { ApiError } from './errors.js';

/** 演示用排队延迟，默认 5 秒（演示时钟时间），测试可调 0 */
export const DEFAULT_QUEUE_DELAY_MS = 5_000;

export function enqueueStocktake(store, clock, req, body, delayMs = DEFAULT_QUEUE_DELAY_MS) {
  const warehouse = body.warehouse;
  const sku = body.sku;
  const countedQty = Number(body.countedQty);
  if (!warehouse || !sku || !Number.isFinite(countedQty) || countedQty < 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'warehouse、sku 和非负 countedQty 必填');
  }

  // 入队时核对范围
  const { key, account } = authorize(store, clock, req, ACTIONS.SUBMIT_STOCKTAKE, warehouse);

  const now = clock.now();
  const job = {
    id: `job_${randomUUID()}`,
    warehouse,
    sku,
    countedQty,
    keyId: key.id,
    keyPrefix: key.prefix,
    serviceAccountId: account.id,
    status: 'queued',
    enqueuedAt: new Date(now).toISOString(),
    runAt: new Date(now + delayMs).toISOString(),
    finishedAt: null,
    result: null,
  };
  store.stocktakeJobs.push(job);
  store.persist();
  return serializeJob(job);
}

/**
 * 处理所有到执行时刻的排队任务。由服务器定时驱动。
 * 写入前重新走完整授权链，模拟"排队中的写入再次确认"。
 */
export function tickQueue(store, clock) {
  const now = clock.now();
  const processed = [];
  for (const job of store.stocktakeJobs) {
    if (job.status !== 'queued' || now < Date.parse(job.runAt)) continue;

    const item = store.inventory.find(
      (i) => i.sku === job.sku && i.warehouse === job.warehouse
    );
    const key = store.findKey(job.keyId);
    const account = store.findAccount(job.serviceAccountId);

    // —— 执行前再次确认 ——
    let reason = null;
    if (!key) reason = '钥匙已被删除';
    else if (keyStatus(key, clock) !== 'active' && keyStatus(key, clock) !== 'overlapping') {
      reason = `钥匙状态为 ${keyStatus(key, clock)}，拒写`;
    } else if (!account || !account.enabled) {
      reason = '服务账号已停用，排队写入被拒绝';
    } else if (!key.actions.includes(ACTIONS.SUBMIT_STOCKTAKE)) {
      reason = '钥匙不再包含盘点提交动作';
    } else if (!key.warehouses.includes(job.warehouse)) {
      reason = '钥匙范围不再包含该仓库';
    } else if (!account.allowedActions.includes(ACTIONS.SUBMIT_STOCKTAKE)) {
      reason = '服务账号权限已收回盘点提交';
    } else if (!account.allowedWarehouses.includes(job.warehouse)) {
      reason = '服务账号权限已收回该仓库';
    } else if (!item) {
      reason = `库存中不存在 ${job.warehouse}/${job.sku}`;
    }

    if (reason) {
      job.status = 'rejected';
      job.result = reason;
    } else {
      const before = item.qty;
      item.qty = job.countedQty;
      job.status = 'applied';
      job.result = `盘点写入成功：${before} → ${job.countedQty}`;
    }
    job.finishedAt = new Date(now).toISOString();
    processed.push(job);
  }
  if (processed.length) store.persist();
  return processed.map(serializeJob);
}

export const JOB_STATUS_LABELS = Object.freeze({
  queued: '排队中',
  applied: '已写入',
  rejected: '已拒写',
});

export function serializeJob(job) {
  return {
    id: job.id,
    warehouse: job.warehouse,
    sku: job.sku,
    countedQty: job.countedQty,
    keyId: job.keyId,
    keyPrefix: job.keyPrefix,
    serviceAccountId: job.serviceAccountId,
    status: job.status,
    statusLabel: JOB_STATUS_LABELS[job.status] || job.status,
    enqueuedAt: job.enqueuedAt,
    runAt: job.runAt,
    finishedAt: job.finishedAt,
    result: job.result,
  };
}
