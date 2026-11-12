// 毫秒 <-> HH:MM:SS.mmm 文本，裁切精度到毫秒。

export function msToText(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  ms = Math.round(ms)
  const millis = ms % 1000
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`
}

// 接受 HH:MM:SS.mmm / MM:SS.mmm / SS.mmm / 纯数字（按毫秒）
export function textToMs(text) {
  const trimmed = String(text).trim()
  if (!trimmed) return NaN
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?$/)
  if (!match) return NaN
  const [, hours, minutes, seconds, millisRaw] = match
  const millis = Number((millisRaw || '').padEnd(3, '0'))
  return (
    Number(hours || 0) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    millis
  )
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let i = -1
  do {
    value /= 1024
    i += 1
  } while (value >= 1024 && i < units.length - 1)
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`
}

export function formatTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
