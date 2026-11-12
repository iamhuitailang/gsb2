// 状态文案与配色集中管理
export const RECORD_STATUS = {
  pending: { label: '待处理', cls: 'st-pending' },
  running: { label: '执行中', cls: 'st-running' },
  success: { label: '已完成', cls: 'st-success' },
  failed: { label: '失败', cls: 'st-failed' },
  skipped: { label: '已跳过', cls: 'st-skipped' },
  interrupted: { label: '已中断', cls: 'st-interrupted' },
};

export const JOB_STATUS = {
  preview: { label: '待确认', cls: 'st-pending' },
  ready: { label: '就绪', cls: 'st-skipped' },
  running: { label: '执行中', cls: 'st-running' },
  paused: { label: '已暂停', cls: 'st-interrupted' },
  interrupted: { label: '已中断', cls: 'st-interrupted' },
  completed: { label: '已完成', cls: 'st-success' },
  failed: { label: '异常', cls: 'st-failed' },
};

export function recordStatus(s) {
  return RECORD_STATUS[s] || { label: s, cls: '' };
}
export function jobStatus(s) {
  return JOB_STATUS[s] || { label: s, cls: '' };
}
