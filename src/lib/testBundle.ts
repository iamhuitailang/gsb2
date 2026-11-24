import {
  frameToRealSeconds,
  frameToTimecodeWithDay,
  framesPerDay,
  parseFormatKey,
  parseTimecodeWithDay,
  type FrameFormat,
} from './timecode'
import { createId, itemFrameCount, type MarkerItem, type Segment } from './items'
import { importMarkersCsv, markersToCsv, type ImportIssue } from './csv'

export interface TestCaseRecord {
  name: string
  format: string
  frame: number
  expect_tc: string
  note: string
}

/** 项目自带测试标记：覆盖 25p、29.97、59.94、跳号/不跳号、跨分钟与跨午夜 */
export const TEST_BOUNDARY_CASES: TestCaseRecord[] = [
  {
    name: '29.97 DF · 第 1 分钟边界前一帧',
    format: '2997df',
    frame: 1799,
    expect_tc: '00:00:59;29',
    note: '下一帧跳过后从 00:01:00;02 开始',
  },
  {
    name: '29.97 DF · 第 1 分钟边界',
    format: '2997df',
    frame: 1800,
    expect_tc: '00:01:00;02',
    note: ';00 与 ;01 被跳过',
  },
  {
    name: '29.97 DF · 十分钟边界前一帧',
    format: '2997df',
    frame: 17981,
    expect_tc: '00:09:59;29',
    note: '整十分钟不跳号',
  },
  {
    name: '29.97 DF · 十分钟边界',
    format: '2997df',
    frame: 17982,
    expect_tc: '00:10:00;00',
    note: '十分钟边界恢复到 ;00',
  },
  {
    name: '29.97 DF · 整点前一帧',
    format: '2997df',
    frame: 107891,
    expect_tc: '00:59:59;29',
    note: '整点不跳号',
  },
  {
    name: '29.97 DF · 整点',
    format: '2997df',
    frame: 107892,
    expect_tc: '01:00:00;00',
    note: '整点边界恢复到 ;00',
  },
  {
    name: '29.97 DF · 午夜前一帧',
    format: '2997df',
    frame: 2589407,
    expect_tc: '23:59:59;29',
    note: '午夜同样不跳',
  },
  {
    name: '29.97 DF · 午夜',
    format: '2997df',
    frame: 2589408,
    expect_tc: '00:00:00;00 +1d',
    note: '日期归属加 1 天',
  },
  {
    name: '59.94 DF · 第 1 分钟边界前一帧',
    format: '5994df',
    frame: 3599,
    expect_tc: '00:00:59;59',
    note: '下一帧从 00:01:00;04 开始',
  },
  {
    name: '59.94 DF · 第 1 分钟边界',
    format: '5994df',
    frame: 3600,
    expect_tc: '00:01:00;04',
    note: ';00–;03 被跳过',
  },
  {
    name: '59.94 DF · 十分钟边界',
    format: '5994df',
    frame: 35964,
    expect_tc: '00:10:00;00',
    note: '整十分钟不跳号',
  },
  {
    name: '59.94 DF · 午夜',
    format: '5994df',
    frame: 5178816,
    expect_tc: '00:00:00;00 +1d',
    note: '午夜翻页',
  },
  {
    name: '29.97 NDF · 第 1 分钟边界',
    format: '2997ndf',
    frame: 1800,
    expect_tc: '00:01:00:00',
    note: '不跳号，标签不跳过',
  },
  {
    name: '25 · 普通分钟边界',
    format: '25',
    frame: 1500,
    expect_tc: '00:01:00:00',
    note: '25p 无跳号',
  },
  {
    name: '25 · 午夜',
    format: '25',
    frame: 2160000,
    expect_tc: '00:00:00:00 +1d',
    note: '午夜翻页',
  },
]

export interface TestMarkerBundle {
  endInclusive: boolean
  segments: Segment[]
  markers: MarkerItem[]
  cases: TestCaseRecord[]
}

function dayLength(format: FrameFormat): number {
  return framesPerDay(format)
}

function tcToFrame(text: string, format: FrameFormat): number | null {
  const parsed = parseTimecodeWithDay(text, format)
  return parsed.ok ? parsed.absoluteFrame : null
}

/** 构造项目自带的测试数据（不落盘，纯内存） */
export function makeTestBundle(): TestMarkerBundle {
  const df = parseFormatKey('2997df')!
  const ndf25 = parseFormatKey('25')!
  const ndf5994 = parseFormatKey('5994ndf')!

  const segmentStartA = tcToFrame('00:59:50;00', df) ?? 0
  const segmentStartC = tcToFrame('23:59:50;00', df) ?? framesPerDay(df) - 300
  const segments: Segment[] = [
    {
      id: createId('seg'),
      name: 'A001 · 采访主机位',
      format: df,
      startFrame: segmentStartA,
      frameCount: 600 * 30,
      note: '起点 00:59:50;00，跨过整点与普通分钟边界',
    },
    {
      id: createId('seg'),
      name: 'B002 · 空镜',
      format: ndf25,
      startFrame: 0,
      frameCount: 25 * 60,
      note: '25p，与 29.97 段不可直接比较帧号',
    },
    {
      id: createId('seg'),
      name: 'C003 · 夜景（跨午夜）',
      format: df,
      startFrame: segmentStartC,
      frameCount: 30 * 30,
      note: '23:59:50;00 起，跨午夜到次日',
    },
    {
      id: createId('seg'),
      name: 'D004 · 59.94 空镜',
      format: ndf5994,
      startFrame: 0,
      frameCount: 600 * 60,
      note: '59.94 不跳号，10 分钟',
    },
    {
      id: createId('seg'),
      name: 'E005 · 次日采访',
      format: df,
      startFrame: framesPerDay(df),
      frameCount: 30 * 30 * 60,
      note: '从第 1 天 00:00:00;00 开始，用来演示午夜标记的日期归属',
    },
    {
      id: createId('seg'),
      name: 'F006 · 第 0 天凌晨',
      format: df,
      startFrame: 0,
      frameCount: 30 * 30 * 60,
      note: '让午夜后的单点在默认日期下也能落在段内',
    },
  ]

  const markerSpecs: { name: string; kind: 'marker' | 'range'; start: string; out?: string; note: string; format: FrameFormat }[] = [
    { name: '整点前 1 秒', kind: 'marker', start: '00:59:59;00 +0d', note: '整点边界之前的点', format: df },
    { name: '整点后 1 秒', kind: 'marker', start: '01:00:00;00 +0d', note: '整点不跳号', format: df },
    { name: '普通分钟跨越', kind: 'range', start: '01:00:59;00', out: '01:01:00;10', note: '跨普通分钟，跳号后从 ;02 起', format: df },
    { name: '跨午夜区间', kind: 'range', start: '23:59:55;00', out: '00:00:05;00', note: '出点读数更小，按次日解释', format: df },
    { name: '午夜后单点', kind: 'marker', start: '00:00:02;00', note: '无法确定日期归属，需手动选', format: df },
    { name: '段落外的点', kind: 'marker', start: '02:30:00;00 +0d', note: '故意落在所有素材段之外，用来演示段外提示', format: df },
    { name: '25p 区间', kind: 'range', start: '00:00:10:00', out: '00:00:20:00', note: '25p 无跳号', format: ndf25 },
    { name: '59.94 不跳号点', kind: 'marker', start: '00:00:59:59 +0d', note: '59.94 NDF', format: ndf5994 },
  ]
  const markers: MarkerItem[] = []
  for (const spec of markerSpecs) {
    const start = parseTimecodeWithDay(spec.start, spec.format)
    if (!start.ok) continue
    if (spec.kind === 'marker') {
      markers.push({
        id: createId('marker'),
        name: spec.name,
        format: spec.format,
        startFrame: start.absoluteFrame,
        dayExplicit: start.hasDaySuffix,
        dateDecision: start.hasDaySuffix ? start.day : null,
        note: spec.note,
        kind: 'marker',
      })
      continue
    }
    if (!spec.out) continue
    const out = parseTimecodeWithDay(spec.out, spec.format)
    if (!out.ok) continue
    const outFrame =
      !out.hasDaySuffix && out.absoluteFrame < start.absoluteFrame
        ? out.absoluteFrame + dayLength(spec.format)
        : out.absoluteFrame
    markers.push({
      id: createId('marker'),
      name: spec.name,
      format: spec.format,
      startFrame: start.absoluteFrame,
      outFrame,
      dayExplicit: start.hasDaySuffix,
      dateDecision: start.day,
      note: spec.note,
      kind: 'range',
    })
  }

  return { endInclusive: true, segments, markers, cases: TEST_BOUNDARY_CASES }
}

// ─────────────────────────────────────────────────────────────────────────────
// 样例核验
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundaryCheckResult {
  case: TestCaseRecord
  actualTc: string
  actualRealSeconds: number
  tcMatches: boolean
  ok: boolean
}

export function checkBoundaryCases(cases: readonly TestCaseRecord[]): BoundaryCheckResult[] {
  return cases.map((entry) => {
    const format = parseFormatKey(entry.format)
    if (!format) {
      return {
        case: entry,
        actualTc: '—',
        actualRealSeconds: Number.NaN,
        tcMatches: false,
        ok: false,
      }
    }
    const actualTc = frameToTimecodeWithDay(entry.frame, format)
    return {
      case: entry,
      actualTc,
      actualRealSeconds: frameToRealSeconds(entry.frame, format),
      tcMatches: actualTc === entry.expect_tc,
      ok: actualTc === entry.expect_tc,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV 往返核验
// ─────────────────────────────────────────────────────────────────────────────

export interface RoundtripRow {
  name: string
  before: string
  after: string
  match: boolean
  issues: ImportIssue[]
}

export interface RoundtripResult {
  ok: boolean
  rows: RoundtripRow[]
  issues: ImportIssue[]
}

/**
 * 导出为 CSV 再重新导入，逐行比对起点、出点、帧数与末端规则，
 * 确认导出文件可以还原有效标记。
 */
export function checkCsvRoundtrip(
  markers: readonly MarkerItem[],
  endInclusive: boolean,
): RoundtripResult {
  const csv = markersToCsv(markers, endInclusive)
  const imported = importMarkersCsv(csv, {
    endInclusive,
    defaultFormat: parseFormatKey('2997df')!,
  })
  const issues: ImportIssue[] = []
  const rows: RoundtripRow[] = []
  let cursor = 0
  for (const marker of markers) {
    const importedRow = imported.rows[cursor]
    cursor += 1
    const afterItem = importedRow?.item ?? null
    const before = describeItem(marker, endInclusive)
    const after = afterItem ? describeItem(afterItem, endInclusive) : '（无有效标记）'
    let match = false
    if (afterItem) {
      match =
        afterItem.startFrame === marker.startFrame &&
        afterItem.kind === marker.kind &&
        (marker.kind !== 'range' ||
          (afterItem.kind === 'range' && afterItem.outFrame === marker.outFrame)) &&
        formatText(afterItem.format) === formatText(marker.format) &&
        afterItem.dayExplicit === marker.dayExplicit &&
        (afterItem.dateDecision === null) === (marker.dateDecision === null) &&
        itemFrameCount(afterItem, endInclusive) === itemFrameCount(marker, endInclusive)
    }
    if (!match) {
      issues.push({
        line: importedRow?.line ?? cursor + 1,
        column: '往返比对',
        code: 'ROUNDTRIP_MISMATCH',
        message: `标记“${marker.name}”重新导入后与导出前不一致：${before} → ${after}`,
        severity: 'error',
      })
    }
    rows.push({ name: marker.name, before, after, match, issues: importedRow?.issues ?? [] })
  }
  if (imported.rows.length !== markers.length) {
    issues.push({
      line: 1,
      column: '往返比对',
      code: 'ROUNDTRIP_ROW_COUNT',
      message: `导出 ${markers.length} 行，重新导入得到 ${imported.rows.length} 行数据`,
      severity: 'error',
    })
  }
  return { ok: rows.every((row) => row.match) && imported.rows.length === markers.length, rows, issues }
}

function formatText(format: FrameFormat): string {
  return `${format.rate}${format.dropFrame ? 'df' : 'ndf'}`
}

function describeItem(item: MarkerItem, endInclusive: boolean): string {
  const start = frameToTimecodeWithDay(item.startFrame, item.format)
  const dateNote = item.dateDecision === null ? ' · 日期待定' : ''
  if (item.kind === 'marker') return `${item.name} @ ${start} [${formatText(item.format)}${dateNote}]`
  return `${item.name} @ ${start} → ${frameToTimecodeWithDay(item.outFrame, item.format)} [${
    formatText(item.format)
  }${dateNote}] ${endInclusive ? '包含末端' : '不含末端'}`
}
