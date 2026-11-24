/**
 * 时码核心：帧序号 ↔ 时码（含 29.97 / 59.94 跳号）↔ 实际媒体时间。
 *
 * 术语：
 * - nominal（标称帧率）：25 / 30 / 60，决定时码里秒和帧的进位方式。
 * - actual（实际帧率）：25 / 30000÷1001 / 60000÷1001，决定真实经过时间。
 * - 跳号（drop-frame）：29.97 与 59.94 下，每个非整十分钟的分钟边界
 *   跳过编号 ;00（29.97 为 ;00–;01，59.94 为 ;00–;03），整十分钟与整点不跳。
 */

export type RateId = '25' | '2997' | '5994'

export interface RateSpec {
  id: RateId
  /** 界面展示用的帧率名 */
  label: string
  /** 时码进位用的标称帧率 */
  nominal: number
  /** 实际帧率 = actualNum / actualDen */
  actualNum: number
  actualDen: number
  /** 跳号时每分钟跳过的帧号数量；不支持跳号则为 0 */
  dropFrames: number
}

export const RATES: Record<RateId, RateSpec> = {
  '25': {
    id: '25',
    label: '25',
    nominal: 25,
    actualNum: 25,
    actualDen: 1,
    dropFrames: 0,
  },
  '2997': {
    id: '2997',
    label: '29.97',
    nominal: 30,
    actualNum: 30000,
    actualDen: 1001,
    dropFrames: 2,
  },
  '5994': {
    id: '5994',
    label: '59.94',
    nominal: 60,
    actualNum: 60000,
    actualDen: 1001,
    dropFrames: 4,
  },
}

export interface FrameFormat {
  rate: RateId
  dropFrame: boolean
}

export function makeFormat(rate: RateId, dropFrame: boolean): FrameFormat {
  return { rate, dropFrame: dropFrame && RATES[rate].dropFrames > 0 }
}

export function formatKey(format: FrameFormat): string {
  return `${format.rate}${format.dropFrame ? 'df' : 'ndf'}`
}

export function parseFormatKey(key: string): FrameFormat | null {
  const normalized = key
    .trim()
    .toLowerCase()
    .replace(/non[\s._-]*drop[\s._-]*(frame)?/g, 'ndf')
    .replace(/drop[\s._-]*(frame)?/g, 'df')
    .replace(/[\s._-]/g, '')
  if (normalized === '25' || normalized === '25ndf') return makeFormat('25', false)
  if (normalized === '2997df' || normalized === 'df2997') return makeFormat('2997', true)
  if (normalized === '2997' || normalized === '2997ndf' || normalized === 'ndf2997')
    return makeFormat('2997', false)
  if (normalized === '5994df' || normalized === 'df5994') return makeFormat('5994', true)
  if (normalized === '5994' || normalized === '5994ndf' || normalized === 'ndf5994')
    return makeFormat('5994', false)
  return null
}

export function formatLabel(format: FrameFormat): string {
  const spec = RATES[format.rate]
  if (!spec.dropFrames) return `${spec.label} · 不跳号`
  return `${spec.label} · ${format.dropFrame ? '跳号 DF' : '不跳号 NDF'}`
}

export function formatShortLabel(format: FrameFormat): string {
  const spec = RATES[format.rate]
  if (!spec.dropFrames) return spec.label
  return `${spec.label} ${format.dropFrame ? 'DF' : 'NDF'}`
}

export function nominalFps(format: FrameFormat): number {
  return RATES[format.rate].nominal
}

export function actualFps(format: FrameFormat): number {
  const spec = RATES[format.rate]
  return spec.actualNum / spec.actualDen
}

export function frameDurationSeconds(format: FrameFormat): number {
  const spec = RATES[format.rate]
  return spec.actualDen / spec.actualNum
}

export function dropFramesPerMinute(format: FrameFormat): number {
  return format.dropFrame ? RATES[format.rate].dropFrames : 0
}

export function framesPerMinute(format: FrameFormat): number {
  return nominalFps(format) * 60 - dropFramesPerMinute(format)
}

export function framesPerTenMinutes(format: FrameFormat): number {
  return nominalFps(format) * 600 - dropFramesPerMinute(format) * 9
}

export function framesPerDay(format: FrameFormat): number {
  return nominalFps(format) * 86400 - dropFramesPerMinute(format) * 9 * 144
}

// ─────────────────────────────────────────────────────────────────────────────
// 时码文本
// ─────────────────────────────────────────────────────────────────────────────

function pad(value: number, width = 2): string {
  return String(Math.abs(value)).padStart(width, '0')
}

export interface TimecodeParts {
  hours: number
  minutes: number
  seconds: number
  frames: number
  /** 相对第 0 天的天数偏移 */
  dayOffset: number
}

/**
 * 帧序号 → 时码字段。帧序号 0 对应 00:00:00:00 / 00:00:00;00。
 * 超过一天时只取 24 小时内的时码，天数在 dayOffset 中返回。
 */
export function frameToParts(frame: number, format: FrameFormat): TimecodeParts {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new RangeError(`帧序号必须是非负整数，收到 ${frame}`)
  }
  const day = framesPerDay(format)
  const dayOffset = Math.floor(frame / day)
  let withinDay = frame % day
  const nominal = nominalFps(format)

  if (format.dropFrame) {
    const drop = dropFramesPerMinute(format)
    const per10 = framesPerTenMinutes(format)
    const perMinute = framesPerMinute(format)
    const tenMinuteBlocks = Math.floor(withinDay / per10)
    const remainder = withinDay % per10
    // 每个十分钟周期补偿 9 次跳号；周期内从第 1 分钟起每次边界再补 drop 个编号
    withinDay += drop * 9 * tenMinuteBlocks
    withinDay += drop * Math.floor(Math.max(0, remainder - drop) / perMinute)
  }

  const totalSeconds = Math.floor(withinDay / nominal)
  const frames = withinDay % nominal
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60) % 24
  return { hours, minutes, seconds, frames, dayOffset }
}

/** 帧序号 → 时码文本（不带天数） */
export function frameToTimecode(frame: number, format: FrameFormat): string {
  const p = frameToParts(frame, format)
  return partsToTimecode(p, format)
}

export function partsToTimecode(parts: Omit<TimecodeParts, 'dayOffset'>, format: FrameFormat): string {
  const sep = format.dropFrame ? ';' : ':'
  return `${pad(parts.hours)}:${pad(parts.minutes)}:${pad(parts.seconds)}${sep}${pad(parts.frames)}`
}

/** 带天数信息：时码 +（可选）+Nd */
export function frameToTimecodeWithDay(frame: number, format: FrameFormat): string {
  const p = frameToParts(frame, format)
  const base = partsToTimecode(p, format)
  if (p.dayOffset === 0) return base
  return `${base} ${p.dayOffset > 0 ? '+' : '-'}${Math.abs(p.dayOffset)}d`
}

export function splitAbsoluteFrame(frame: number, format: FrameFormat): { day: number; frameInDay: number } {
  const perDay = framesPerDay(format)
  const day = Math.floor(frame / perDay)
  return { day, frameInDay: frame - day * perDay }
}

// ─────────────────────────────────────────────────────────────────────────────
// 时码解析
// ─────────────────────────────────────────────────────────────────────────────

export type TcIssueCode =
  | 'SYNTAX'
  | 'HOUR_RANGE'
  | 'MINUTE_RANGE'
  | 'SECOND_RANGE'
  | 'FRAME_RANGE'
  | 'DROPPED_LABEL'
  | 'DF_MARKER_ON_NDF'
  | 'NDF_MARKER_MISMATCH'
  | 'DAY_RANGE'

export interface TcIssue {
  code: TcIssueCode
  message: string
  /** 出现问题的字段 */
  field?: 'hours' | 'minutes' | 'seconds' | 'frames'
  value?: number
}

export type TimecodeParseResult =
  | {
      ok: true
      frame: number
      parts: Omit<TimecodeParts, 'dayOffset'>
      /** 时码最后一个分隔符是否表示跳号 */
      dropMarked: boolean
      warnings: TcIssue[]
    }
  | {
      ok: false
      error: TcIssue
      warnings: TcIssue[]
    }

const TC_PATTERN = /^(\d{1,3}):(\d{1,2}):(\d{1,2})([:;.,])(\d{1,3})$/

function normalizeTcText(text: string): string {
  return text
    .trim()
    .replace(/　/g, ' ')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/．/g, '.')
    .replace(/，/g, ',')
}

/** 准时码语法解析：HH:MM:SS:FF（不跳号）或 HH:MM:SS;FF（跳号） */
export function parseTimecode(text: string, format: FrameFormat): TimecodeParseResult {
  const warnings: TcIssue[] = []
  const normalized = normalizeTcText(text)
  if (!normalized) {
    return {
      ok: false,
      error: { code: 'SYNTAX', message: '时码为空' },
      warnings,
    }
  }
  const match = TC_PATTERN.exec(normalized)
  if (!match) {
    return {
      ok: false,
      error: {
        code: 'SYNTAX',
        message: `无法识别“${text.trim()}”，时码格式应为 HH:MM:SS:FF（不跳号）或 HH:MM:SS;FF（跳号）`,
      },
      warnings,
    }
  }
  const hoursText = match[1]
  const minutesText = match[2]
  const secondsText = match[3]
  const sep = match[4]
  const framesText = match[5]
  if (
    hoursText === undefined ||
    minutesText === undefined ||
    secondsText === undefined ||
    sep === undefined ||
    framesText === undefined
  ) {
    return { ok: false, error: { code: 'SYNTAX', message: '时码字段不完整' }, warnings }
  }

  const hours = Number(hoursText)
  const minutes = Number(minutesText)
  const seconds = Number(secondsText)
  const frames = Number(framesText)
  const nominal = nominalFps(format)
  const dropMarked = sep === ';' || sep === ',' || sep === '.'

  if (dropMarked && !format.dropFrame) {
    warnings.push({
      code: 'DF_MARKER_ON_NDF',
      message: `分隔符“${sep}”表示跳号，但当前格式是 ${formatLabel(format)}；仍按当前格式解释。`,
    })
  }
  if (!dropMarked && format.dropFrame) {
    warnings.push({
      code: 'NDF_MARKER_MISMATCH',
      message: `分隔符“${sep}”表示不跳号，但当前格式是 ${formatLabel(format)}；仍按当前格式解释。`,
    })
  }
  if (hours > 23) {
    return {
      ok: false,
      error: {
        code: 'HOUR_RANGE',
        message: `小时 ${hours} 超出范围 00–23（时码按 24 小时制循环，跨午夜请另选日期）`,
        field: 'hours',
        value: hours,
      },
      warnings,
    }
  }
  if (minutes > 59) {
    return {
      ok: false,
      error: {
        code: 'MINUTE_RANGE',
        message: `分钟 ${minutes} 超出范围 00–59`,
        field: 'minutes',
        value: minutes,
      },
      warnings,
    }
  }
  if (seconds > 59) {
    return {
      ok: false,
      error: {
        code: 'SECOND_RANGE',
        message: `秒 ${seconds} 超出范围 00–59`,
        field: 'seconds',
        value: seconds,
      },
      warnings,
    }
  }
  if (frames >= nominal) {
    return {
      ok: false,
      error: {
        code: 'FRAME_RANGE',
        message: `帧号 ${frames} 超出 ${formatShortLabel(format)} 的帧号范围 00–${pad(nominal - 1)}`,
        field: 'frames',
        value: frames,
      },
      warnings,
    }
  }
  if (format.dropFrame && seconds === 0 && minutes % 10 !== 0 && frames < dropFramesPerMinute(format)) {
    const drop = dropFramesPerMinute(format)
    const range = drop === 2 ? ';00–;01' : `;00–;${pad(drop - 1)}`
    return {
      ok: false,
      error: {
        code: 'DROPPED_LABEL',
        message: `“${partsToTimecode({ hours, minutes, seconds, frames }, format)}”是被跳过的标签：${formatShortLabel(
          format,
        )} 在每个非整十分钟的分钟边界跳过 ${range}，该分钟应从 ;${pad(drop)} 开始（整十分钟与整点不跳）`,
        field: 'frames',
        value: frames,
      },
      warnings,
    }
  }

  let frame: number
  if (format.dropFrame) {
    const totalMinutes = hours * 60 + minutes
    frame =
      nominal * (hours * 3600 + minutes * 60 + seconds) +
      frames -
      dropFramesPerMinute(format) * (totalMinutes - Math.floor(totalMinutes / 10))
  } else {
    frame = nominal * (hours * 3600 + minutes * 60 + seconds) + frames
  }

  return {
    ok: true,
    frame,
    parts: { hours, minutes, seconds, frames },
    dropMarked,
    warnings,
  }
}

export interface ParsedTimecodeWithDay {
  ok: true
  /** 绝对帧号（含日期偏移） */
  absoluteFrame: number
  /** 日内帧号 */
  frameInDay: number
  day: number
  hasDaySuffix: boolean
  timecode: string
  parts: Omit<TimecodeParts, 'dayOffset'>
  warnings: TcIssue[]
}

export type TimecodeWithDayResult = ParsedTimecodeWithDay | { ok: false; error: TcIssue; warnings: TcIssue[] }

const DAY_SUFFIX = /\s*([+-]?\d+)\s*d\s*$/i

/** 解析时码，支持可选的日期后缀，如 “00:00:00;10 +1d”。 */
export function parseTimecodeWithDay(text: string, format: FrameFormat): TimecodeWithDayResult {
  const trimmed = text.trim()
  const suffix = DAY_SUFFIX.exec(trimmed)
  let baseText = trimmed
  let day = 0
  if (suffix && suffix[1] !== undefined) {
    day = Number(suffix[1])
    baseText = trimmed.slice(0, suffix.index).trim()
    if (!Number.isInteger(day) || Math.abs(day) > 9999) {
      return {
        ok: false,
        error: { code: 'DAY_RANGE', message: `日期偏移“${(suffix[0] ?? '').trim()}”不是有效天数（最多 ±9999 天）` },
        warnings: [],
      }
    }
  }
  const parsed = parseTimecode(baseText, format)
  if (!parsed.ok) return parsed
  const frameInDay = parsed.frame
  const absolute = day * framesPerDay(format) + frameInDay
  if (absolute < 0) {
    return {
      ok: false,
      error: {
        code: 'DAY_RANGE',
        message: `日期后缀 ${day}d 使绝对帧号变成负数（${absolute}），本工具只处理第 0 天及之后的时间码`,
      },
      warnings: parsed.warnings,
    }
  }
  return {
    ok: true,
    absoluteFrame: absolute,
    frameInDay,
    day,
    hasDaySuffix: suffix !== null,
    timecode: partsToTimecode(parsed.parts, format),
    parts: parsed.parts,
    warnings: parsed.warnings,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 实际时间
// ─────────────────────────────────────────────────────────────────────────────

/** 从 00:00:00;00 起算的真实经过秒数 */
export function frameToRealSeconds(frame: number, format: FrameFormat): number {
  const spec = RATES[format.rate]
  return (frame * spec.actualDen) / spec.actualNum
}

/** 真实经过秒数 → 帧位置（可能是小数） */
export function realSecondsToFrameExact(seconds: number, format: FrameFormat): number {
  const spec = RATES[format.rate]
  return (seconds * spec.actualNum) / spec.actualDen
}

/** 时码标签所声称的秒数（把时码当成秒表读），用于对比漂移 */
export function frameToLabelSeconds(frame: number, format: FrameFormat): number {
  const parts = frameToParts(frame, format)
  return (
    parts.dayOffset * 86400 +
    parts.hours * 3600 +
    parts.minutes * 60 +
    parts.seconds +
    parts.frames / nominalFps(format)
  )
}

/** 时码标签时间 − 实际媒体时间（秒）。正数表示时码跑快。 */
export function frameToLabelDriftSeconds(frame: number, format: FrameFormat): number {
  return frameToLabelSeconds(frame, format) - frameToRealSeconds(frame, format)
}

/**
 * 秒数格式化为 HH:MM:SS.mmm，支持任意小时数。
 * 用整数缩放后再拆分，避免 59.9996 四舍五入成 59.999 的边界错误。
 */
export function formatClockSeconds(seconds: number, decimals = 3): string {
  const factor = 10 ** decimals
  const rounded = Math.round(seconds * factor)
  const negative = rounded < 0
  const abs = Math.abs(rounded)
  const whole = Math.floor(abs / factor)
  const fraction = abs % factor
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const fractionText = decimals > 0 ? `.${String(fraction).padStart(decimals, '0')}` : ''
  return `${negative ? '-' : ''}${pad(hours)}:${pad(minutes)}:${pad(secs)}${fractionText}`
}

/** 秒数（不带时:分结构） */
export function formatSecondsValue(seconds: number, decimals = 3): string {
  const factor = 10 ** decimals
  const rounded = Math.round(seconds * factor) / factor
  const negative = rounded < 0 && rounded !== 0
  return `${negative ? '-' : ''}${Math.abs(rounded).toFixed(decimals)} s`
}

/**
 * 解析用户输入的媒体时间：
 * - 纯数字：秒，可带小数（如 60.06）
 * - HH:MM:SS.mmm / MM:SS.mmm（可带负号，负数表示时码原点之前）
 */
export function parseClockSeconds(text: string): number | null {
  const normalized = text.trim().replace(/[：]/g, ':').replace(/[，]/g, '.')
  if (!normalized) return null
  if (/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    const value = Number(normalized)
    return Number.isFinite(value) ? value : null
  }
  const match = /^([+-])?(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?(?:\.(\d{1,3}))?$/.exec(normalized)
  if (!match) return null
  const signText = match[1]
  const aText = match[2]
  const bText = match[3]
  const cText = match[4]
  const fractionText = match[5]
  if (aText === undefined || bText === undefined) return null
  const sign = signText === '-' ? -1 : 1
  const a = Number(aText)
  const b = Number(bText)
  let hours = 0
  let minutes = a
  let seconds = b
  if (cText !== undefined) {
    hours = a
    minutes = b
    seconds = Number(cText)
  }
  if (minutes > 59 || seconds > 59) return null
  const fraction = fractionText ? Number(`0.${fractionText}`) : 0
  return sign * (hours * 3600 + minutes * 60 + seconds + fraction)
}

/** 把秒差格式化成带符号的文本：不足 1 秒用毫秒，否则用秒 */
export function formatSignedSeconds(seconds: number): string {
  const abs = Math.abs(seconds)
  if (abs < 0.0005) return '0 ms'
  const sign = seconds > 0 ? '+' : '-'
  if (abs < 1) return `${sign}${(abs * 1000).toFixed(1)} ms`
  return `${sign}${abs.toFixed(3)} s`
}
