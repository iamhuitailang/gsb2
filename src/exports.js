import { randomUUID } from 'node:crypto';

// 批量导出是异步的：入队 -> 生成 -> 取文件，三步都按“当下”的权限重新核对。
// 权限被撤销后，已排队的任务在生成时就会失败，取文件时也会再次被拒绝。

export const EXPORT_TTL_MS = 30 * 60 * 1000;

export function createExports({ store, delayMs = 600 }) {
  const timers = new Map();

  // 进程重启后，之前排队的任务继续生成；生成阶段仍然按当前权限重新核对。
  for (const job of store.data.exports) {
    if (job.status === 'queued') {
      const timer = setTimeout(() => finish(job), delayMs);
      timer.unref?.();
      timers.set(job.id, timer);
    }
  }

  function finish(job) {
    timers.delete(job.id);
    // 生成阶段：重新核对，防止排队期间权限被撤销。
    const membership = store.data.memberships.find(
      (m) => m.userId === job.userId && m.orgId === job.orgId && m.active === true && !m.revokedAt,
    );
    if (!membership) {
      job.status = 'denied';
      job.error = '导出生成时重新核对失败：你已没有该机构的操作权限';
      job.finishedAt = Date.now();
      store.save();
      store.audit(job.userId, 'export.denied_at_generate', { exportId: job.id, orgId: job.orgId });
      return;
    }

    const now = Date.now();
    const tickets = store.data.tickets.filter((t) => t.orgId === job.orgId);
    // 按“生成时”的角色过滤：主管导出全机构，员工只导出分给自己的
    const scoped =
      membership.role === 'supervisor' ? tickets : tickets.filter((t) => t.assigneeId === job.userId);

    const lines = ['工单号,标题,状态,负责人,创建时间'];
    for (const t of scoped) {
      const assignee = store.data.users.find((u) => u.id === t.assigneeId);
      lines.push(
        [t.id, t.title, t.status, assignee?.name ?? '未分配', new Date(t.createdAt).toISOString()]
          .map(csvCell)
          .join(','),
      );
    }
    job.status = 'ready';
    job.rows = scoped.length;
    job.content = `${lines.join('\n')}\n`;
    job.finishedAt = now;
    store.save();
    store.audit(job.userId, 'export.generated', { exportId: job.id, orgId: job.orgId, rows: job.rows });
  }

  return {
    enqueue({ userId, orgId, membershipRole }) {
      const job = {
        id: `EXP-${randomUUID().slice(0, 8)}`,
        userId,
        orgId,
        roleAtRequest: membershipRole,
        status: 'queued',
        rows: 0,
        content: null,
        error: null,
        createdAt: Date.now(),
        finishedAt: null,
        expiresAt: Date.now() + EXPORT_TTL_MS,
      };
      store.data.exports.push(job);
      store.save();
      store.audit(userId, 'export.enqueued', { exportId: job.id, orgId });
      const timer = setTimeout(() => finish(job), delayMs);
      timer.unref?.();
      timers.set(job.id, timer);
      return job;
    },
    find(exportId) {
      return store.data.exports.find((j) => j.id === exportId) ?? null;
    },
    cancelAll() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
