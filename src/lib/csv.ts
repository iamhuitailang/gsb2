import {
  formatKey,
  frameDurationSeconds,
  frameToRealSeconds,
  frameToTimecodeWithDay,
  framesPerDay,
  parseClockSeconds,
  parseFormatKey,
  parseTimecodeWithDay,
  realSecondsToFrameExact,
  splitAbsoluteFrame,
  type FrameFormat,
  type TcIssue,
} from './timecode'
import {
  createId,
  isAmbiguousMidnightTime,
  itemBoundaryLabel,
  itemEndDisplayFrame,
  itemFrameCount,
  itemStartLabel,
  type MarkerItem,
  type Segment,
} from './items'

export type ImportSeverity = 'error' | 'warning'

export interface ImportIssue {
  line: number
  column: string
  code: string
  message: string
  severity: ImportSeverity
}

export interface ParsedCsvRow {
  line: number
  cells: string[]
  raw: string
}

export interface CsvParseFailure {
  ok: false
  issues: ImportIssue[]
}

export interface CsvParseSuccess {
  ok: true
  header: string[]
  headerLine: number
  rows: ParsedCsvRow[]
  issues: ImportIssue[]
}

export type CsvParseResult = CsvParseSuccess | CsvParseFailure

/** 支持引号、CRLF、BOM、末尾无换行的最小 CSV 解析器 */
export function parseCsv(text: string): CsvParseResult {
  const issues: ImportIssue[] = []
  const source = text.replace(/^﻿/, '')
  const logicalRows: { line: number; cells: string[]; raw: string }[] = []
  let cells: string[] = []
  let field = ''
  let rawRow = ''
  let inQuotes = false
  let line = 1
  let rowStartLine = 1

  const pushField = () => {
    cells.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    if (!cells.every((cell) => cell.trim() === '')) {
      logicalRows.push({ line: rowStartLine, cells, raw: rawRow })
    }
    cells = []
    rawRow = ''
  }

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          rawRow += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
        rawRow += char
        if (char === '\n') line += 1
      }
      continue
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true
      rawRow += char
      continue
    }
    if (char === '"') {
      field += char
      rawRow += char
      issues.push({
        line,
        column: `第 ${cells.length + 1} 列`,
        code: 'CSV_STRAY_QUOTE',
        message: '字段中间的引号未按 CSV 规则转义，已按字面读取',
        severity: 'warning',
      })
      continue
    }
    if (char === ',') {
      rawRow += char
      pushField()
      continue
    }
    if (char === '\r') {
      if (source[i + 1] === '\n') continue
      pushRow()
      line += 1
      rowStartLine = line
      continue
    }
    if (char === '\n') {
      pushRow()
      line += 1
      rowStartLine = line
      continue
    }
    field += char
    rawRow += char
  }

  if (inQuotes) {
    issues.push({
      line: rowStartLine,
      column: '整行',
      code: 'CSV_UNCLOSED_QUOTE',
      message: '存在未闭合的引号，文件可能被截断或格式有误',
      severity: 'error',
    })
    return { ok: false, issues }
  }
  if (field.length > 0 || cells.length > 0) {
    pushRow()
  }
  if (logicalRows.length === 0) {
    issues.push({
      line: 1,
      column: '整行',
      code: 'CSV_EMPTY',
      message: 'CSV 为空，至少需要一行表头和一行数据',
      severity: 'error',
    })
    return { ok: false, issues }
  }

  const headerRow = logicalRows[0]!
  const header = headerRow.cells.map((cell) => cell.trim())
  if (header.every((cell) => cell === '')) {
    issues.push({
      line: headerRow.line,
      column: '整行',
      code: 'CSV_HEADER_EMPTY',
      message: '表头为空',
      severity: 'error',
    })
    return { ok: false, issues }
  }
  return { ok: true, header, headerLine: headerRow.line, rows: logicalRows.slice(1), issues }
}

// ─────────────────────────────────────────────────────────────────────────────
// 表头映射
// ─────────────────────────────────────────────────────────────────────────────

const CANONICAL_COLUMNS = [
  'name',
  'kind',
  'format',
  'start_tc',
  'out_tc',
  'start_frame',
  'out_frame',
  'start_sec',
  'out_sec',
  'start_day',
  'out_day',
  'day_explicit',
  'end_inclusive',
  'frame_count',
  'note',
] as const

type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number]

const IGNORED_EXPORT_COLUMNS = new Set([
  'row',
  'line',
  'id',
  'duration_sec',
  'start_real_sec',
  'boundary_tc',
  'end_boundary_tc',
  'end_tc_check',
  'check',
])

const HEADER_ALIASES: Record<string, CanonicalColumn> = {
  name: 'name',
  title: 'name',
  名称: 'name',
  标记名: 'name',
  标记名称: 'name',
  kind: 'kind',
  type: 'kind',
  类型: 'kind',
  标记类型: 'kind',
  format: 'format',
  fps: 'format',
  rate: 'format',
  帧率: 'format',
  格式: 'format',
  start_tc: 'start_tc',
  starttimecode: 'start_tc',
  in_tc: 'start_tc',
  intc: 'start_tc',
  tc: 'start_tc',
  timecode: 'start_tc',
  start: 'start_tc',
  入点时码: 'start_tc',
  开始时间码: 'start_tc',
  起始时码: 'start_tc',
  时码: 'start_tc',
  out_tc: 'out_tc',
  end_tc: 'out_tc',
  outtimecode: 'out_tc',
  endtimecode: 'out_tc',
  出点时码: 'out_tc',
  结束时间码: 'out_tc',
  结束时码: 'out_tc',
  end: 'out_tc',
  start_frame: 'start_frame',
  in_frame: 'start_frame',
  inframe: 'start_frame',
  startframe: 'start_frame',
  frame: 'start_frame',
  入点帧: 'start_frame',
  开始帧: 'start_frame',
  起始帧: 'start_frame',
  out_frame: 'out_frame',
  end_frame: 'out_frame',
  outframe: 'out_frame',
  出点帧: 'out_frame',
  结束帧: 'out_frame',
  start_sec: 'start_sec',
  start_seconds: 'start_sec',
  in_sec: 'start_sec',
  inseconds: 'start_sec',
  入点秒: 'start_sec',
  开始秒: 'start_sec',
  起始秒: 'start_sec',
  out_sec: 'out_sec',
  out_seconds: 'out_sec',
  end_sec: 'out_sec',
  endseconds: 'out_sec',
  出点秒: 'out_sec',
  结束秒: 'out_sec',
  start_day: 'start_day',
  in_day: 'start_day',
  day: 'start_day',
  日期: 'start_day',
  入点日期: 'start_day',
  开始日期: 'start_day',
  out_day: 'out_day',
  end_day: 'out_day',
  出点日期: 'out_day',
  结束日期: 'out_day',
  day_explicit: 'day_explicit',
  start_day_explicit: 'day_explicit',
  日期明确: 'day_explicit',
  日期已知: 'day_explicit',
  end_inclusive: 'end_inclusive',
  inclusive: 'end_inclusive',
  末端包含: 'end_inclusive',
  包含末端: 'end_inclusive',
  frame_count: 'frame_count',
  framecount: 'frame_count',
  帧数: 'frame_count',
  总帧数: 'frame_count',
  note: 'note',
  notes: 'note',
  备注: 'note',
  说明: 'note',
}

function normalizeHeaderCell(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s\-–—/]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function buildColumnLookup(header: string[]): Map<CanonicalColumn, number> {
  const lookup = new Map<CanonicalColumn, number>()
  header.forEach((cell, index) => {
    const canonical = HEADER_ALIASES[normalizeHeaderCell(cell)]
    if (canonical && !lookup.has(canonical)) lookup.set(canonical, index)
  })
  return lookup
}

function reportUnknownColumns(header: string[], line: number): ImportIssue[] {
  const issues: ImportIssue[] = []
  const seen = new Set<string>()
  header.forEach((cell) => {
    const key = normalizeHeaderCell(cell)
    if (!key || HEADER_ALIASES[key]) return
    if (IGNORED_EXPORT_COLUMNS.has(key)) return
    if (seen.has(key)) return
    seen.add(key)
    issues.push({
      line,
      column: cell,
      code: 'CSV_UNKNOWN_COLUMN',
      message: `未识别的列“${cell}”，已忽略`,
      severity: 'warning',
    })
  })
  return issues
}

// ─────────────────────────────────────────────────────────────────────────────
// 行解析
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportSide {
  absolute: number
  frameInDay: number
  day: number
  dayExplicit: boolean
  source: 'timecode' | 'frame' | 'seconds'
  secondsExact?: number
}

export interface ImportRowResult {
  line: number
  name: string
  kind: 'marker' | 'range'
  formatText: string
  status: 'ok' | 'warning' | 'error'
  item: MarkerItem | null
  summary: string
  issues: ImportIssue[]
}

export interface ImportOptions {
  endInclusive: boolean
  defaultFormat: FrameFormat
}

export interface ImportResult {
  ok: boolean
  header: string[]
  rows: ImportRowResult[]
  items: MarkerItem[]
  issues: ImportIssue[]
}

const KIND_MARKER = new Set(['marker', 'point', '点', '点标记', '标记', '单点', 'p'])
const KIND_RANGE = new Set(['range', 'interval', 'inout', 'in_out', '区间', '片段', '起止', '段', 'clip'])

function parseBooleanCell(value: string): boolean | null {
  const text = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y', '是', '包含', 'inclusive', 'include'].includes(text)) return true
  if (['false', '0', 'no', 'n', '否', '不包含', 'exclusive', 'exclude'].includes(text)) return false
  return null
}

function parseIntCell(value: string): number | null {
  const text = value.trim().replace(/,/g, '')
  if (!/^[+-]?\d+$/.test(text)) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function issue(
  line: number,
  column: string,
  code: string,
  message: string,
  severity: ImportSeverity = 'error',
): ImportIssue {
  return { line, column, code, message, severity }
}

function tcIssueToImportIssue(line: number, column: string, tcIssue: TcIssue): ImportIssue {
  return issue(line, column, tcIssue.code, tcIssue.message)
}

function readCell(cells: string[], lookup: Map<CanonicalColumn, number>, column: CanonicalColumn): string | null {
  const index = lookup.get(column)
  if (index === undefined) return null
  return cells[index]?.trim() ?? ''
}

interface SideRead {
  side: ImportSide | null
  issues: ImportIssue[]
}

function readSide(
  cells: string[],
  lookup: Map<CanonicalColumn, number>,
  line: number,
  format: FrameFormat,
  prefix: 'start' | 'out',
  required = false,
): SideRead {
  const issues: ImportIssue[] = []
  const tcColumn: CanonicalColumn = prefix === 'start' ? 'start_tc' : 'out_tc'
  const frameColumn: CanonicalColumn = prefix === 'start' ? 'start_frame' : 'out_frame'
  const secColumn: CanonicalColumn = prefix === 'start' ? 'start_sec' : 'out_sec'
  const dayColumn: CanonicalColumn = prefix === 'start' ? 'start_day' : 'out_day'
  const label = prefix === 'start' ? '入点' : '出点'

  const tcText = readCell(cells, lookup, tcColumn)
  const frameText = readCell(cells, lookup, frameColumn)
  const secText = readCell(cells, lookup, secColumn)
  const dayText = readCell(cells, lookup, dayColumn)
  const explicitText = readCell(cells, lookup, 'day_explicit')
  const explicitFlag = explicitText ? parseBooleanCell(explicitText) : null
  const provided: ImportSide[] = []
  const dayFromColumn = dayText ? parseIntCell(dayText) : null
  if (dayText && dayFromColumn === null) {
    issues.push(issue(line, `${label}日期`, 'DAY_INVALID', `${label}日期“${dayText}”不是整数天数`))
  }

  if (tcText) {
    const parsed = parseTimecodeWithDay(tcText, format)
    if (!parsed.ok) {
      issues.push(tcIssueToImportIssue(line, `${label}时码`, parsed.error))
    } else {
      parsed.warnings.forEach((warning) => {
        issues.push(issue(line, `${label}时码`, warning.code, warning.message, 'warning'))
      })
      const suffixDay = parsed.day
      const day = dayFromColumn ?? suffixDay
      if (day < 0) {
        issues.push(
          issue(
            line,
            `${label}日期`,
            'DAY_NEGATIVE',
            `${label}日期为 ${day}，本工具只处理第 0 天及之后的时间码`,
          ),
        )
      } else if (dayFromColumn !== null && parsed.hasDaySuffix && dayFromColumn !== suffixDay) {
        issues.push(
          issue(
            line,
            `${label}日期`,
            'DAY_CONFLICT',
            `${label}时码后缀为 ${suffixDay >= 0 ? '+' : ''}${suffixDay}d，但日期列为 ${dayFromColumn}，已采用日期列`,
            'warning',
          ),
        )
      }
      if (day >= 0) {
        provided.push({
          absolute: day * framesPerDay(format) + parsed.frameInDay,
          frameInDay: parsed.frameInDay,
          day,
          // day_explicit 列只作用于入点：显式 false 用来还原“日期待定”的标记。
          // 出点仍以时码自带的 +Nd 后缀为准，避免把跨多天的出点拉回次日。
          dayExplicit:
            prefix === 'start'
              ? explicitFlag ?? (dayText ? true : parsed.hasDaySuffix)
              : dayText
                ? true
                : parsed.hasDaySuffix,
          source: 'timecode',
        })
      }
    }
  }

  if (frameText) {
    const parsedFrame = parseIntCell(frameText)
    if (parsedFrame === null) {
      issues.push(issue(line, `${label}帧`, 'FRAME_INVALID', `${label}帧“${frameText}”不是整数`))
    } else if (parsedFrame < 0) {
      issues.push(issue(line, `${label}帧`, 'FRAME_NEGATIVE', `${label}帧不能为负数`))
    } else {
      // 帧号本身就是绝对帧号，无需再用日期列叠加；因此视为已明确日期
      const split = splitAbsoluteFrame(parsedFrame, format)
      provided.push({
        absolute: parsedFrame,
        frameInDay: split.frameInDay,
        day: split.day,
        dayExplicit: true,
        source: 'frame',
      })
    }
  }

  if (secText) {
    const seconds = parseClockSeconds(secText)
    if (seconds === null) {
      issues.push(
        issue(line, `${label}秒`, 'SECONDS_INVALID', `${label}秒“${secText}”无法解析（可用 90.5 或 00:01:30.500）`),
      )
    } else if (seconds < 0) {
      issues.push(issue(line, `${label}秒`, 'SECONDS_NEGATIVE', `${label}秒不能为负数`))
    } else {
      const exact = realSecondsToFrameExact(seconds, format)
      const rounded = Math.round(exact)
      const split = splitAbsoluteFrame(rounded, format)
      if (Math.abs(exact - rounded) > 1e-9) {
        issues.push(
          issue(
            line,
            `${label}秒`,
            'SECONDS_ROUNDED',
            `${label}秒 ${seconds.toFixed(3)} s 换算后取整为帧 ${rounded}（精确值 ${exact.toFixed(6)}，差 ${(
              exact - rounded
            ).toFixed(6)} 帧）`,
            'warning',
          ),
        )
      }
      provided.push({
        absolute: rounded,
        frameInDay: split.frameInDay,
        day: split.day,
        // 秒数从原点起算，是绝对时间
        dayExplicit: true,
        source: 'seconds',
        secondsExact: seconds,
      })
    }
  }

  if (provided.length === 0) {
    if (required && !tcText && !frameText && !secText) {
      issues.push(issue(line, `${label}`, 'SIDE_MISSING', `缺少${label}：请提供时码、帧号或秒数`))
    }
    return { side: null, issues }
  }

  const primary = provided.find((entry) => entry.source === 'timecode') ?? provided[0]!
  const distinct = [...new Set(provided.map((entry) => entry.absolute))]
  if (distinct.length > 1) {
    const sourceLabel = primary.source === 'timecode' ? '时码' : primary.source === 'frame' ? '帧号' : '秒数'
    issues.push(
      issue(
        line,
        `${label}时码`,
        'SIDE_CONFLICT',
        `${label}同时提供了多个来源且换算结果不一致（帧 ${distinct.join(' / ')}），已采用${sourceLabel}`,
        'warning',
      ),
    )
  }
  // 帧号与秒数本身就是绝对时间，只有在使用它们时才认为日期已确定
  const dayExplicit =
    primary.source === 'timecode' ? primary.dayExplicit : true
  return { side: { ...primary, dayExplicit }, issues }
}

function frameSummary(absolute: number, format: FrameFormat): string {
  return `${frameToTimecodeWithDay(absolute, format)} · 帧 ${absolute} · ${frameToRealSeconds(
    absolute,
    format,
  ).toFixed(3)} s`
}

function rangeFrameCount(startFrame: number, outFrame: number, endInclusive: boolean): number {
  return outFrame - startFrame + (endInclusive ? 1 : 0)
}

export function importMarkersCsv(text: string, options: ImportOptions): ImportResult {
  const parsed = parseCsv(text)
  if (!parsed.ok) {
    return { ok: false, header: [], rows: [], items: [], issues: parsed.issues }
  }
  const headerIssues = reportUnknownColumns(parsed.header, parsed.headerLine)
  const lookup = buildColumnLookup(parsed.header)

  if (!lookup.has('start_tc') && !lookup.has('start_frame') && !lookup.has('start_sec')) {
    const fatal = issue(
      parsed.headerLine,
      '表头',
      'HEADER_MISSING_START',
      '表头缺少入点列：需要 start_tc / start_frame / start_sec 之一（也可用“入点时码”等中文列名）',
    )
    return { ok: false, header: parsed.header, rows: [], items: [], issues: [...parsed.issues, ...headerIssues, fatal] }
  }
  if (lookup.size === 0) {
    const fatal = issue(parsed.headerLine, '表头', 'HEADER_UNKNOWN', '无法识别任何列名，请参考示例表头')
    return { ok: false, header: parsed.header, rows: [], items: [], issues: [...parsed.issues, ...headerIssues, fatal] }
  }

  const rows: ImportRowResult[] = []
  const items: MarkerItem[] = []

  for (const row of parsed.rows) {
    const rowIssues: ImportIssue[] = []
    const cells = row.cells
    const nameText = readCell(cells, lookup, 'name') ?? ''
    const kindText = (readCell(cells, lookup, 'kind') ?? '').toLowerCase()
    const formatText = readCell(cells, lookup, 'format') ?? ''
    const note = readCell(cells, lookup, 'note') ?? ''

    let format = options.defaultFormat
    if (formatText) {
      const parsedFormat = parseFormatKey(formatText)
      if (!parsedFormat) {
        rowIssues.push(
          issue(
            row.line,
            '格式',
            'FORMAT_INVALID',
            `无法识别的帧率格式“${formatText}”，可用 25 / 2997df / 2997ndf / 5994df / 5994ndf`,
          ),
        )
      } else {
        format = parsedFormat
      }
    }

    const startRead = readSide(cells, lookup, row.line, format, 'start', true)
    const outRead = readSide(cells, lookup, row.line, format, 'out')

    const countText = readCell(cells, lookup, 'frame_count')
    const countValue = countText ? parseIntCell(countText) : null

    const hasOutCell =
      (readCell(cells, lookup, 'out_tc') ?? '') !== '' ||
      (readCell(cells, lookup, 'out_frame') ?? '') !== '' ||
      (readCell(cells, lookup, 'out_sec') ?? '') !== ''
    let kind: 'marker' | 'range'
    // 帧数列 > 1 视为区间；帧数列非法时也按区间处理，好让错误暴露出来
    const inferRange = hasOutCell || (countText !== null && countText !== '' && (countValue === null || countValue > 1))
    if (!kindText) {
      kind = inferRange ? 'range' : 'marker'
    } else if (KIND_MARKER.has(kindText)) {
      kind = 'marker'
    } else if (KIND_RANGE.has(kindText)) {
      kind = 'range'
    } else {
      kind = inferRange ? 'range' : 'marker'
      rowIssues.push(
        issue(
          row.line,
          '类型',
          'KIND_INVALID',
          `未识别的类型“${kindText}”，按${kind === 'range' ? '区间' : '点标记'}处理`,
          'warning',
        ),
      )
    }
    rowIssues.push(...startRead.issues)
    if (kind === 'range') {
      rowIssues.push(...outRead.issues)
      if (countText && countValue === null) {
        rowIssues.push(issue(row.line, '帧数', 'COUNT_INVALID', `帧数“${countText}”不是整数`))
      } else if (countValue !== null && countValue <= 0) {
        rowIssues.push(issue(row.line, '帧数', 'COUNT_INVALID', '帧数必须为正整数'))
      }
    }

    const start = startRead.side
    if (!start) {
      rows.push({
        line: row.line,
        name: nameText || `第 ${row.line} 行`,
        kind,
        formatText: formatText || formatKey(options.defaultFormat),
        status: 'error',
        item: null,
        summary: '—',
        issues: rowIssues,
      })
      continue
    }

    if (kind === 'marker') {
      const ambiguousDay =
        start.source === 'timecode' &&
        !start.dayExplicit &&
        isAmbiguousMidnightTime(start.frameInDay, format)
      if (hasOutCell) {
        rowIssues.push(
          issue(
            row.line,
            '类型',
            'MARKER_HAS_OUT',
            '点标记提供了出点列，出点已忽略（如需区间请把类型写为 range）',
            'warning',
          ),
        )
      }
      if (ambiguousDay) {
        rowIssues.push(
          issue(
            row.line,
            '入点时码',
            'DAY_AMBIGUOUS',
            '这是单独出现、落在午夜后第一分钟内的时码，无法确定属于第 0 天还是次日；已标为“日期待定”，请在标记列表中选择日期归属',
            'warning',
          ),
        )
      }
      const item: MarkerItem = {
        id: createId('import'),
        name: nameText || `第 ${row.line} 行标记`,
        format,
        startFrame: start.absolute,
        dayExplicit: start.dayExplicit,
        dateDecision: ambiguousDay ? null : start.day,
        note,
        kind: 'marker',
      }
      finishRow(row, item, rowIssues, formatText || formatKey(format))
      continue
    }

    const inclusiveText = readCell(cells, lookup, 'end_inclusive')
    const rowInclusive = inclusiveText ? parseBooleanCell(inclusiveText) : null
    if (inclusiveText && rowInclusive === null) {
      rowIssues.push(
        issue(
          row.line,
          '末端包含',
          'INCLUSIVE_INVALID',
          `末端包含值“${inclusiveText}”无法解析，按当前界面的${options.endInclusive ? '“包含”' : '“不包含”'}处理`,
          'warning',
        ),
      )
    }

    let out = outRead.side
    if (!out && countValue !== null && countValue > 0) {
      const effectiveInclusive = rowInclusive ?? options.endInclusive
      const outFrame = start.absolute + countValue - (effectiveInclusive ? 1 : 0)
      const split = splitAbsoluteFrame(outFrame, format)
      out = {
        absolute: outFrame,
        frameInDay: split.frameInDay,
        day: split.day,
        dayExplicit: false,
        source: 'frame',
      }
    }

    if (!out) {
      if (!outRead.issues.some((entry) => entry.severity === 'error')) {
        rowIssues.push(
          issue(row.line, '出点', 'OUT_MISSING', '区间缺少出点：请提供出点时码、帧号、秒数或帧数'),
        )
      }
      rows.push({
        line: row.line,
        name: nameText || `第 ${row.line} 行区间`,
        kind,
        formatText: formatText || formatKey(format),
        status: 'error',
        item: null,
        summary: '—',
        issues: rowIssues,
      })
      continue
    }

    // 出点时码没写日期时，跟随入点所在日期；若仍早于入点，按跨午夜解释到次日
    let outAbsolute = out.absolute
    if (out.source === 'timecode' && !out.dayExplicit) {
      outAbsolute = start.day * framesPerDay(format) + out.frameInDay
      if (outAbsolute < start.absolute) {
        outAbsolute += framesPerDay(format)
        rowIssues.push(
          issue(
            row.line,
            '出点时码',
            'MIDNIGHT_WRAP',
            `出点读数早于入点，已按跨午夜解释为次日 ${frameToTimecodeWithDay(outAbsolute, format)}`,
            'warning',
          ),
        )
      }
    }

    const effectiveRowInclusive = rowInclusive ?? options.endInclusive
    let outFrame = outAbsolute
    if (rowInclusive !== null && rowInclusive !== options.endInclusive) {
      const count = countValue ?? rangeFrameCount(start.absolute, outAbsolute, effectiveRowInclusive)
      if (count > 0) {
        outFrame = start.absolute + count - (options.endInclusive ? 1 : 0)
        rowIssues.push(
          issue(
            row.line,
            '末端包含',
            'INCLUSIVE_ADJUSTED',
            `该行末端为${rowInclusive ? '“包含”' : '“不包含”'}，已按界面设置（${
              options.endInclusive ? '包含' : '不包含'
            }）调整出点为帧 ${outFrame}，帧数保持 ${count}`,
            'warning',
          ),
        )
      }
    }

    if (outFrame < start.absolute) {
      rowIssues.push(
        issue(row.line, '出点', 'OUT_BEFORE_IN', `出点帧 ${outFrame} 早于入点帧 ${start.absolute}，区间顺序无效`),
      )
    } else if (outFrame === start.absolute && !options.endInclusive) {
      rowIssues.push(
        issue(row.line, '出点', 'EMPTY_RANGE', '末端不包含时，出点必须晚于入点，当前区间为空'),
      )
    }
    const finalCount = rangeFrameCount(start.absolute, outFrame, options.endInclusive)
    if (countValue !== null && countValue > 0 && finalCount !== countValue) {
      rowIssues.push(
        issue(
          row.line,
          '帧数',
          'COUNT_MISMATCH',
          `给出的帧数 ${countValue} 与起止帧计算出的 ${finalCount} 不一致（末端${
            options.endInclusive ? '包含' : '不包含'
          }）`,
          'warning',
        ),
      )
    }

    const item: MarkerItem = {
      id: createId('import'),
      name: nameText || `第 ${row.line} 行区间`,
      format,
      startFrame: start.absolute,
      outFrame,
      dayExplicit: start.dayExplicit,
      // 区间的先后顺序已经确定了日期，不再要求用户裁定
      dateDecision: start.day,
      note,
      kind: 'range',
    }
    finishRow(row, item, rowIssues, formatText || formatKey(format))
  }

  function finishRow(
    row: ParsedCsvRow,
    item: MarkerItem,
    rowIssues: ImportIssue[],
    formatText: string,
  ): void {
    const hasError = rowIssues.some((entry) => entry.severity === 'error')
    const hasWarning = rowIssues.some((entry) => entry.severity === 'warning')
    const summary =
      item.kind === 'marker'
        ? frameSummary(item.startFrame, item.format)
        : `${frameSummary(item.startFrame, item.format)} → ${frameToTimecodeWithDay(
            item.outFrame,
            item.format,
          )} · 帧 ${item.outFrame} · ${itemFrameCount(item, options.endInclusive)} 帧`
    rows.push({
      line: row.line,
      name: item.name,
      kind: item.kind,
      formatText,
      status: hasError ? 'error' : hasWarning ? 'warning' : 'ok',
      item: hasError ? null : item,
      summary,
      issues: rowIssues,
    })
    if (!hasError) items.push(item)
  }

  return {
    ok: true,
    header: parsed.header,
    rows,
    items,
    issues: [...parsed.issues, ...headerIssues, ...rows.flatMap((row) => row.issues)],
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 导出
// ─────────────────────────────────────────────────────────────────────────────

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  const lines = rows.map((row) => row.map((cell) => csvEscape(String(cell))).join(','))
  return `﻿${lines.join('\r\n')}\r\n`
}

export const EXPORT_HEADER = [
  'row',
  'name',
  'kind',
  'format',
  'start_tc',
  'start_day',
  'day_explicit',
  'start_frame',
  'out_tc',
  'out_day',
  'out_frame',
  'end_inclusive',
  'end_boundary_tc',
  'frame_count',
  'duration_sec',
  'start_real_sec',
  'note',
] as const

export function markerToCsvRow(
  item: MarkerItem,
  index: number,
  endInclusive: boolean,
): (string | number)[] {
  const count = itemFrameCount(item, endInclusive)
  return [
    index + 1,
    item.name,
    item.kind,
    formatKey(item.format),
    itemStartLabel(item),
    splitAbsoluteFrame(item.startFrame, item.format).day,
    item.dayExplicit ? 'true' : 'false',
    item.startFrame,
    item.kind === 'range' ? frameToTimecodeWithDay(itemEndDisplayFrame(item), item.format) : '',
    item.kind === 'range' ? splitAbsoluteFrame(item.outFrame, item.format).day : '',
    item.kind === 'range' ? item.outFrame : '',
    endInclusive ? 'true' : 'false',
    itemBoundaryLabel(item, endInclusive),
    count,
    (count * frameDurationSeconds(item.format)).toFixed(3),
    frameToRealSeconds(item.startFrame, item.format).toFixed(3),
    item.note,
  ]
}

export function markersToCsv(items: readonly MarkerItem[], endInclusive: boolean): string {
  const rows: (string | number)[][] = [Array.from(EXPORT_HEADER)]
  items.forEach((item, index) => {
    rows.push(markerToCsvRow(item, index, endInclusive))
  })
  return toCsv(rows)
}

export function segmentsToCsv(segments: readonly Segment[]): string {
  const rows: (string | number)[][] = [['name', 'format', 'start_tc', 'frame_count', 'note']]
  for (const segment of segments) {
    rows.push([
      segment.name,
      formatKey(segment.format),
      frameToTimecodeWithDay(segment.startFrame, segment.format),
      segment.frameCount,
      segment.note,
    ])
  }
  return toCsv(rows)
}

export function sampleImportCsv(endInclusive: boolean): string {
  return toCsv([
    ['name', 'kind', 'format', 'start_tc', 'out_tc', 'end_inclusive', 'note'],
    ['分钟边界前', 'marker', '2997df', '00:00:59;29 +0d', '', '', '普通分钟边界样例'],
    ['十分钟边界', 'range', '2997df', '00:09:59;20', '00:10:00;10', endInclusive ? 'true' : 'false', '整十分钟不跳号'],
    ['跨午夜区间', 'range', '2997df', '23:59:59;20', '00:00:00;20', endInclusive ? 'true' : 'false', '出点按次日解释'],
    ['午夜后单点', 'marker', '2997df', '00:00:00;10', '', '', '需要手动选日期归属'],
    ['被跳过的标签', 'marker', '2997df', '00:01:00;00', '', '', '这一行应当报错并定位到原行'],
    ['正常区间', 'range', '25', '00:00:10:00', '00:00:20:00', endInclusive ? 'true' : 'false', '25p 无跳号'],
  ])
}
