import { createHash, randomUUID } from 'node:crypto';
import {
  FIELD_BY_KEY,
  ORDERS,
  PERMISSIONS,
  SITE_BY_ID,
  SITES,
  USERS,
} from './data.js';
import {
  canViewField,
  checkColumns,
  checkSites,
  normalizeQuery,
  visibleFields,
} from './permissions.js';

const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  FAILED: 'failed',
  INVALIDATED: 'invalidated',
});

const STATUS_LABEL = Object.freeze({
  queued: '排队中',
  running: '生成中',
  ready: '可下载',
  failed: '生成失败',
  invalidated: '已失效',
});

function cloneUser(user) {
  return {
    ...user,
    sites: [...user.sites],
    permissions: [...user.permissions],
  };
}

function nowStamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 防 CSV 公式注入，并统一加引号转义。
 */
function csvCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

const UTF8_BOM = '﻿';

export function buildCsv(columns, rows) {
  const lines = [columns.map((column) => csvCell(column.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return {
    content: `${UTF8_BOM}${lines.join('\r\n')}\r\n`,
    rowCount: rows.length,
  };
}

function projectWithColumns(order, columns) {
  const row = {};
  for (const key of columns) {
    row[key] = key === 'site' ? SITE_BY_ID[order.siteId]?.name ?? order.siteId : order[key] ?? '';
  }
  return row;
}

export function filterOrders(query, user) {
  const searchable = new Set(visibleFields(user).map((field) => field.key));
  const needle = query.q ? query.q.toLowerCase() : '';

  return ORDERS.filter((order) => {
    if (!query.siteIds.includes(order.siteId)) return false;
    if (query.statuses.length > 0 && !query.statuses.includes(order.status)) return false;
    if (!needle) return true;

    return [...searchable].some((key) => {
      const value = key === 'site' ? SITE_BY_ID[order.siteId]?.name : order[key];
      return String(value ?? '').toLowerCase().includes(needle);
    });
  });
}

export function createStore(options = {}) {
  const autoRun = options.autoRun !== false;
  const executionDelayMs = options.executionDelayMs ?? 350;
  const now = options.now ?? (() => Date.now());

  let users = Object.fromEntries(Object.entries(USERS).map(([id, user]) => [id, cloneUser(user)]));
  const jobs = new Map();
  const timers = new Map();

  function getUser(userId) {
    return users[userId] ?? null;
  }

  function listUsers() {
    return Object.values(users).map((user) => ({ ...user, sites: [...user.sites], permissions: [...user.permissions] }));
  }

  function isJobDownloadable(job, user) {
    if (!job || !user || job.applicantId !== user.id) return false;
    if (job.status !== JOB_STATUS.READY || !job.file) return false;
    if (job.file.permissionVersion !== user.permissionVersion) return false;
    if (!job.snapshot.siteIds.every((siteId) => user.sites.includes(siteId))) return false;
    return job.snapshot.columns.every((key) => canViewField(user, FIELD_BY_KEY[key]));
  }

  function jobView(job, viewer) {
    const isOwner = viewer && viewer.id === job.applicantId;
    const downloadable = isOwner && isJobDownloadable(job, viewer);
    const accessChanged = isOwner && job.status === JOB_STATUS.READY && !downloadable;

    return {
      id: job.id,
      status: job.status,
      statusLabel: STATUS_LABEL[job.status],
      applicant: { id: job.applicantId, name: job.applicantName },
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      snapshot: {
        ...job.snapshot,
        sites: job.snapshot.siteIds.map((siteId) => ({ id: siteId, name: SITE_BY_ID[siteId]?.name ?? siteId })),
        columns: job.snapshot.columns.map((key) => ({ key, label: FIELD_BY_KEY[key]?.label ?? key })),
        statuses: [...job.snapshot.statuses],
      },
      queuedPermissionVersion: job.queuedPermissionVersion,
      error: job.error,
      needsReapply: job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.INVALIDATED || accessChanged,
      file: job.file
        ? {
            filename: job.file.filename,
            rowCount: job.file.rowCount,
            byteSize: job.file.byteSize,
            createdAt: job.file.createdAt,
            permissionVersion: job.file.permissionVersion,
            downloadUrl: `/api/exports/${job.id}/download`,
            downloadable,
            invalidReason: job.file.invalidReason ?? null,
          }
        : null,
    };
  }

  function snapshotFor(query) {
    return {
      siteIds: [...query.siteIds],
      statuses: [...query.statuses],
      q: query.q,
      columns: [...query.columns],
    };
  }

  function markInvalid(job, reason, message) {
    job.status = JOB_STATUS.INVALIDATED;
    job.finishedAt = job.finishedAt ?? now();
    job.invalidatedAt = now();
    job.invalidatedReason = reason;
    if (job.file) {
      job.file.invalidReason = reason;
      job.file.content = null;
    }
    job.error = { code: reason, message };
  }

  function validateForOwner(job, user) {
    if (!user) {
      return {
        code: 'applicant_missing',
        message: '申请人账号已不存在，请重新登录后再申请导出。',
      };
    }

    const siteCheck = checkSites(user, job.snapshot.siteIds);
    if (!siteCheck.ok) {
      return {
        code: 'sites_forbidden',
        message: '站点范围已发生变化，当前账号已不能查看其中的站点，请按当前范围重新申请导出。',
      };
    }

    const columnCheck = checkColumns(user, job.snapshot.columns);
    if (!columnCheck.ok) {
      return {
        code: 'columns_forbidden',
        message: '字段权限已发生变化，当前账号已不能查看其中的列，请按当前范围重新申请导出。',
      };
    }

    return null;
  }

  /**
   * 执行排队中的导出。执行前必须按当前权限重新核对站点和列。
   */
  function executeJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return null;
    if (job.status !== JOB_STATUS.QUEUED) return jobView(job, getUser(job.applicantId));

    const timer = timers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(jobId);
    }

    job.status = JOB_STATUS.RUNNING;
    job.startedAt = now();

    const user = getUser(job.applicantId);
    const invalid = validateForOwner(job, user);
    if (invalid) {
      job.status = JOB_STATUS.FAILED;
      job.finishedAt = now();
      job.error = invalid;
      return jobView(job, user);
    }

    try {
      const orders = filterOrders(job.snapshot, user);
      const rows = orders.map((order) => projectWithColumns(order, job.snapshot.columns));
      const columns = job.snapshot.columns.map((key) => ({ key, label: FIELD_BY_KEY[key].label }));
      const csv = buildCsv(columns, rows);
      const timestamp = now();

      job.status = JOB_STATUS.READY;
      job.finishedAt = timestamp;
      job.error = null;
      job.file = {
        filename: `orders-${nowStamp(timestamp)}-${job.id.slice(0, 8)}.csv`,
        content: csv.content,
        rowCount: csv.rowCount,
        byteSize: Buffer.byteLength(csv.content, 'utf8'),
        createdAt: timestamp,
        permissionVersion: user.permissionVersion,
        sha256: createHash('sha256').update(csv.content, 'utf8').digest('hex'),
        invalidReason: null,
      };
      return jobView(job, user);
    } catch (error) {
      job.status = JOB_STATUS.FAILED;
      job.finishedAt = now();
      job.error = {
        code: 'generation_failed',
        message: '导出文件生成失败，请稍后重试。',
        detail: { reason: error.message },
      };
      return jobView(job, user);
    }
  }

  function schedule(jobId) {
    if (!autoRun) return;
    const timer = setTimeout(() => executeJob(jobId), executionDelayMs);
    timer.unref?.();
    timers.set(jobId, timer);
  }

  function enqueueExport(user, rawInput) {
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const normalized = normalizeQuery(user, input);
    if (!normalized.ok) return normalized;

    const columnCheck = checkColumns(user, input.columns);
    if (!columnCheck.ok) return columnCheck;

    const job = {
      id: randomUUID(),
      applicantId: user.id,
      applicantName: user.name,
      status: JOB_STATUS.QUEUED,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      queuedPermissionVersion: user.permissionVersion,
      snapshot: snapshotFor({ ...normalized.query, columns: columnCheck.columns }),
      error: null,
      file: null,
    };

    jobs.set(job.id, job);
    schedule(job.id);
    return { ok: true, job: jobView(job, user) };
  }

  function previewExport(user, rawInput) {
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const normalized = normalizeQuery(user, input);
    if (!normalized.ok) return normalized;

    const columnCheck = checkColumns(user, input.columns);
    if (!columnCheck.ok) return columnCheck;

    const orders = filterOrders(normalized.query, user);
    const rows = orders.slice(0, 10).map((order) => projectWithColumns(order, columnCheck.columns));

    return {
      ok: true,
      preview: {
        total: orders.length,
        truncated: orders.length > rows.length,
        columns: columnCheck.columns.map((key) => ({ key, label: FIELD_BY_KEY[key].label })),
        rows,
      },
    };
  }

  function listJobs(user) {
    return [...jobs.values()]
      .filter((job) => job.applicantId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((job) => jobView(job, user));
  }

  function getJob(user, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.applicantId !== user.id) return null;
    return jobView(job, user);
  }

  /**
   * 下载前再次按当前权限核对。任何一项不满足都返回失效，不返回旧内容。
   */
  function getDownload(user, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.applicantId !== user.id) {
      return { status: 404, error: { code: 'export_not_found', message: '导出任务不存在。' } };
    }
    if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.RUNNING) {
      return {
        status: 409,
        error: { code: 'export_not_ready', message: '文件尚未生成完成，请稍后再试。' },
      };
    }
    if (job.status === JOB_STATUS.FAILED) {
      return {
        status: 409,
        error: {
          code: 'export_failed',
          message: job.error?.message ?? '导出任务失败，请按当前范围重新申请。',
        },
      };
    }
    if (job.status === JOB_STATUS.INVALIDATED) {
      return {
        status: 410,
        error: {
          code: job.invalidatedReason ?? 'export_invalidated',
          message: '该文件已失效，无法从原地址取回。请按当前权限范围重新申请导出。',
        },
      };
    }

    const stillAllowed = isJobDownloadable(job, user);
    if (!stillAllowed || !job.file?.content) {
      // 兜底：权限在下载瞬间发生变化，立即作废并删除内容。
      markInvalid(
        job,
        'permission_changed',
        '权限已发生变化，该文件已失效，请按当前范围重新申请导出。',
      );
      return {
        status: 410,
        error: {
          code: 'permission_changed',
          message: '权限已发生变化，该文件已失效，无法从原地址取回。请按当前范围重新申请导出。',
        },
      };
    }

    return {
      status: 200,
      file: job.file,
      download: { filename: job.file.filename, content: job.file.content },
    };
  }

  function updateUserAccess(actor, userId, rawInput) {
    if (!actor.permissions.includes('admin:users')) {
      return {
        ok: false,
        status: 403,
        code: 'admin_required',
        message: '只有权限管理员可以调整账号权限。',
      };
    }

    const target = users[userId];
    if (!target) {
      return { ok: false, status: 404, code: 'user_not_found', message: '账号不存在。' };
    }

    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    if (!Array.isArray(input.sites) || !Array.isArray(input.permissions)) {
      return {
        ok: false,
        status: 400,
        code: 'access_invalid',
        message: 'sites 和 permissions 必须是数组。',
      };
    }

    const sites = [...new Set(input.sites)];
    const permissions = [...new Set(input.permissions)];
    const unknownSites = sites.filter((siteId) => !SITE_BY_ID[siteId]);
    const unknownPermissions = permissions.filter((permission) => !PERMISSIONS[permission]);
    if (unknownSites.length > 0 || unknownPermissions.length > 0) {
      return {
        ok: false,
        status: 400,
        code: 'access_unknown',
        message: '包含未知的站点或权限。',
        detail: { sites: unknownSites, permissions: unknownPermissions },
      };
    }

    const unchanged =
      sites.length === target.sites.length &&
      permissions.length === target.permissions.length &&
      sites.every((siteId) => target.sites.includes(siteId)) &&
      permissions.every((permission) => target.permissions.includes(permission));

    if (unchanged) {
      return {
        ok: true,
        changed: false,
        invalidatedJobs: 0,
        user: { ...target, sites: [...target.sites], permissions: [...target.permissions] },
      };
    }

    target.sites = sites;
    target.permissions = permissions;
    target.permissionVersion += 1;

    // 权限版本一旦变化，旧文件立即作废并清空内容，原地址永远无法再取回。
    let invalidatedJobs = 0;
    for (const job of jobs.values()) {
      if (job.applicantId !== userId || job.status !== JOB_STATUS.READY) continue;
      markInvalid(
        job,
        'permission_changed',
        '账号权限已变更，旧文件不能从原地址取回，请按当前权限范围重新申请导出。',
      );
      invalidatedJobs += 1;
    }

    return {
      ok: true,
      changed: true,
      invalidatedJobs,
      user: { ...target, sites: [...target.sites], permissions: [...target.permissions] },
    };
  }

  function reset() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    jobs.clear();
    users = Object.fromEntries(Object.entries(USERS).map(([id, user]) => [id, cloneUser(user)]));
  }

  return {
    getUser,
    listUsers,
    isJobDownloadable,
    enqueueExport,
    previewExport,
    listJobs,
    getJob,
    getDownload,
    executeJob,
    updateUserAccess,
    reset,
    filterOrders,
    _sites: SITES,
  };
}
