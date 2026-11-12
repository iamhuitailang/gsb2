// 任务编排：把 Playwright 引擎与 SQLite 状态机、SSE 接起来
import {
  claimRecord,
  countByStatus,
  getJob,
  getRecords,
  insertLog,
  markRecordFailed,
  markRecordSkipped,
  markRecordSuccess,
  updateJobStatus,
} from './db.js';
import { runJob } from './automation/playwright-runner.js';
import { sseBus } from './sse.js';
import { maskText } from './masking.js';

// 每个正在执行的任务一把停止旗标；同一任务禁止并发执行
const activeRuns = new Map();

export function isRunning(jobId) {
  return activeRuns.has(jobId);
}

function publish(jobId, event, data) {
  sseBus.emitJob(jobId, event, { ...data, at: new Date().toISOString() });
}

function snapshot(jobId) {
  const job = getJob(jobId);
  const counts = countByStatus(jobId);
  return { job, counts };
}

export async function startJob(jobId) {
  const job = getJob(jobId);
  if (!job) throw Object.assign(new Error('任务不存在'), { status: 404 });
  if (isRunning(jobId)) throw Object.assign(new Error('任务正在执行中'), { status: 409 });
  // preview 需先确认；其余状态（含 completed）都允许尝试，没有可执行记录时幂等返回
  if (!['ready', 'interrupted', 'failed', 'completed'].includes(job.status)) {
    throw Object.assign(new Error(`当前状态 ${job.status} 不允许启动`), { status: 409 });
  }

  // 只取未完成记录；success / skipped 永远不会再次进入浏览器流程
  const candidates = getRecords(jobId).filter((r) =>
    ['pending', 'interrupted', 'failed'].includes(r.status)
  );
  if (candidates.length === 0) {
    updateJobStatus(jobId, 'completed');
    return { nothingToDo: true };
  }

  const control = { stopRequested: false };
  activeRuns.set(jobId, control);
  updateJobStatus(jobId, 'running');
  insertLog({ jobId, level: 'info', event: 'job_start', message: `任务开始执行，待处理 ${candidates.length} 条` });
  publish(jobId, 'job', snapshot(jobId));

  // 异步执行，HTTP 请求立即返回；进度走 SSE
  void execute(jobId, candidates, control);
  return { started: true, remaining: candidates.length };
}

export function stopJob(jobId) {
  const control = activeRuns.get(jobId);
  if (!control) throw Object.assign(new Error('任务未在执行'), { status: 409 });
  control.stopRequested = true;
  insertLog({ jobId, level: 'warn', event: 'stop_requested', message: '用户请求停止，当前记录执行完后中断' });
  return { stopping: true };
}

async function execute(jobId, candidates, control) {
  try {
    await runJob(jobId, candidates, {
      shouldStop: () => control.stopRequested,

      onStart() {},

      onLog({ level, event, message }) {
        insertLog({ jobId, level, event, message });
        publish(jobId, 'log', { level, event, message });
      },

      onRecordUpdate(record, patch) {
        if (patch.status === 'running') {
          // 按 ID 原子认领；认领不到说明该记录已被处理，引擎会跳过
          const claimed = claimRecord(record.id);
          if (!claimed) return false;
        } else if (patch.status === 'success') {
          markRecordSuccess(record.id, patch.mockRef, patch.screenshot ?? null);
        } else if (patch.status === 'failed') {
          markRecordFailed(record.id, patch.error);
        } else if (patch.status === 'skipped') {
          markRecordSkipped(record.id, patch.error || '跳过重复提交');
        }
        publish(jobId, 'record', {
          recordId: record.id,
          patch,
          counts: snapshot(jobId).counts,
        });
        return true;
      },

      onFinish(fatal) {
        let finalStatus;
        if (control.stopRequested) finalStatus = 'interrupted';
        else if (fatal) finalStatus = 'failed';
        else finalStatus = 'completed';
        updateJobStatus(jobId, finalStatus);
        const counts = countByStatus(jobId);
        const msg = fatal
          ? `任务异常结束：${maskText(fatal)}`
          : control.stopRequested
            ? '任务已中断，未完成记录可在重启/恢复后继续'
            : `任务结束：成功 ${counts.success}，跳过 ${counts.skipped}，失败 ${counts.failed}`;
        insertLog({
          jobId,
          level: fatal ? 'error' : 'info',
          event: 'job_end',
          message: msg,
        });
        publish(jobId, 'end', { ...snapshot(jobId), finalStatus, message: msg });
      },
    });
  } finally {
    activeRuns.delete(jobId);
  }
}
