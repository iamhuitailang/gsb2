export function formatDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m} 分 ${s} 秒`
}

export function formatPercent(rate) {
  if (rate === null || rate === undefined) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

export const ANOMALY_LABELS = {
  missing_sequence: '缺失序号',
  duplicate_sequence: '重复序号',
  time_regression: '时间倒退',
  unknown_event_type: '未知事件类型',
  late_arrival: '迟到事件',
  out_of_order_arrival: '乱序到达',
}

export function statusChipClass(status) {
  return status === 'completed' ? 'ok' : 'warn'
}

export function statusText(status) {
  return status === 'completed' ? '已结束' : '进行中'
}

export function outcomeChipClass(outcome) {
  if (outcome === 'win') return 'ok'
  if (outcome === 'loss') return 'danger'
  if (outcome === 'draw') return 'gray'
  return 'gray'
}

export function outcomeText(outcome) {
  return { win: '胜', loss: '负', draw: '平' }[outcome] || '—'
}
