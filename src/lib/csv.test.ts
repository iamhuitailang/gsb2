import { describe, expect, it } from 'vitest'
import { makeFormat, parseFormatKey } from './timecode'
import { importMarkersCsv, markersToCsv, parseCsv, toCsv } from './csv'
import type { MarkerItem } from './items'

const df2997 = makeFormat('2997', true)
const p25 = makeFormat('25', false)
const options = { endInclusive: true, defaultFormat: df2997 }

describe('CSV 解析器', () => {
  it('处理引号、逗号与换行', () => {
    const csv = 'a,b\r\n"x,1","y""z"\r\n'
    const parsed = parseCsv(csv)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.header).toEqual(['a', 'b'])
      expect(parsed.rows[0]!.cells).toEqual(['x,1', 'y"z'])
      expect(parsed.rows[0]!.line).toBe(2)
    }
  })

  it('记录原始行号（含空行与 BOM）', () => {
    const csv = '﻿name,start_tc\n\nA,00:00:00:00\nB,00:00:01:00\n'
    const parsed = parseCsv(csv)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.header).toEqual(['name', 'start_tc'])
      expect(parsed.rows.map((row) => row.line)).toEqual([3, 4])
    }
  })

  it('未闭合引号报错', () => {
    const parsed = parseCsv('a,b\n"x,1\n')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues[0]!.code).toBe('CSV_UNCLOSED_QUOTE')
  })

  it('toCsv 会转义并加 BOM', () => {
    const text = toCsv([
      ['a', 'b'],
      ['x,1', 'y"z'],
    ])
    expect(text.startsWith('﻿')).toBe(true)
    expect(text).toContain('"x,1"')
    expect(text).toContain('"y""z"')
  })
})

describe('CSV 导入', () => {
  it('导入点时码并给出对应帧', () => {
    const csv = 'name,kind,format,start_tc\n整点,marker,2997df,01:00:00;00\n'
    const result = importMarkersCsv(csv, options)
    expect(result.ok).toBe(true)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.startFrame).toBe(107892)
    expect(result.rows[0]!.line).toBe(2)
    expect(result.rows[0]!.status).toBe('ok')
  })

  it('定位被跳过的标签到原行号', () => {
    const csv = [
      'name,start_tc',
      'ok,00:00:59;29',
      'bad,00:01:00;00',
      'ok2,00:01:00;02',
    ].join('\n')
    const result = importMarkersCsv(csv, options)
    expect(result.items).toHaveLength(2)
    const bad = result.rows.find((row) => row.name === 'bad')!
    expect(bad.status).toBe('error')
    expect(bad.line).toBe(3)
    expect(bad.issues.some((entry) => entry.code === 'DROPPED_LABEL')).toBe(true)
  })

  it('定位超出帧率的帧号', () => {
    const csv = 'name,format,start_tc\n25帧越界,25,00:00:00:25\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items).toHaveLength(0)
    const row = result.rows[0]!
    expect(row.status).toBe('error')
    expect(row.line).toBe(2)
    expect(row.issues.some((entry) => entry.code === 'FRAME_RANGE')).toBe(true)
  })

  it('格式错误定位到列', () => {
    const csv = 'name,format,start_tc\n坏格式,2997,99:99:99;99\n'
    const result = importMarkersCsv(csv, options)
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'HOUR_RANGE')).toBe(true)
  })

  it('未知格式列报错', () => {
    const csv = 'name,format,start_tc\nX,abc,00:00:00;00\n'
    const result = importMarkersCsv(csv, options)
    const row = result.rows[0]!
    expect(row.status).toBe('error')
    expect(row.issues.some((entry) => entry.code === 'FORMAT_INVALID')).toBe(true)
  })

  it('支持从帧号列导入', () => {
    const csv = 'name,start_frame\n点,1800\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items[0]!.startFrame).toBe(1800)
  })

  it('支持从秒数列导入并提示取整', () => {
    // 90.5 s 在 29.97 下不是整数帧，导入时应取整并提示
    const csv = 'name,start_sec\n点,90.5\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items[0]!.startFrame).toBe(2712)
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'SECONDS_ROUNDED')).toBe(true)
  })

  it('区间跨午夜自动加一天', () => {
    const csv = 'name,kind,start_tc,out_tc\n跨午夜,range,23:59:59;20,00:00:00;20\n'
    const result = importMarkersCsv(csv, options)
    const item = result.items[0]!
    expect(item.kind).toBe('range')
    if (item.kind === 'range') {
      expect(item.outFrame).toBeGreaterThan(item.startFrame)
    }
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'MIDNIGHT_WRAP')).toBe(true)
  })

  it('帧数列决定出点并校验一致性', () => {
    const csv = 'name,kind,format,start_tc,frame_count\n区间,range,25,00:00:00:00,100\n'
    const result = importMarkersCsv(csv, options)
    const item = result.items[0]!
    expect(item.kind).toBe('range')
    if (item.kind === 'range') expect(item.outFrame).toBe(99)
  })

  it('末端包含列与界面不同时调整并提示', () => {
    const csv = 'name,kind,start_tc,out_tc,end_inclusive\n区间,range,00:00:00;00,00:00:00;29,false\n'
    const result = importMarkersCsv(csv, options)
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'INCLUSIVE_ADJUSTED')).toBe(true)
  })

  it('日期列覆盖时码后缀并提示冲突', () => {
    const csv = 'name,start_tc,start_day\n点,00:00:00;00 +1d,0\n'
    const result = importMarkersCsv(csv, options)
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'DAY_CONFLICT')).toBe(true)
    expect(result.items[0]!.startFrame).toBe(0)
  })

  it('缺少入点列直接失败', () => {
    const csv = 'name,note\nA,x\n'
    const result = importMarkersCsv(csv, options)
    expect(result.ok).toBe(false)
    expect(result.issues.some((entry) => entry.code === 'HEADER_MISSING_START')).toBe(true)
  })

  it('未知列给出提示但不影响导入', () => {
    const csv = 'name,start_tc,weird\nA,00:00:00;00,1\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items).toHaveLength(1)
    expect(result.issues.some((entry) => entry.code === 'CSV_UNKNOWN_COLUMN')).toBe(true)
  })

  it('中文列名可用', () => {
    const csv = '名称,类型,帧率,入点时码,出点时码\n区间,区间,29.97 DF,00:00:00;00,00:00:01;00\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.kind).toBe('range')
  })

  it('出点早于入点（显式同日）报错', () => {
    const csv =
      'name,kind,start_tc,out_tc,format\n错序,range,00:00:10;00 +0d,00:00:05;00 +0d,2997df\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items).toHaveLength(0)
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'OUT_BEFORE_IN')).toBe(true)
  })

  it('午夜附近的单点标为日期待定', () => {
    const csv = 'name,start_tc\n午夜点,00:00:02;00\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items[0]!.startFrame).toBe(60)
    expect(result.items[0]!.dateDecision).toBeNull()
    expect(result.rows[0]!.issues.some((entry) => entry.code === 'DAY_AMBIGUOUS')).toBe(true)
  })

  it('day_explicit=false 可以还原日期待定标记并保持往返一致', () => {
    // 00:00:00;02 在 29.97 DF 下就是帧 2，两个来源一致
    const csv = 'name,kind,start_tc,start_frame,day_explicit\n午夜点,marker,00:00:00;02,2,false\n'
    const result = importMarkersCsv(csv, options)
    expect(result.items[0]!.dateDecision).toBeNull()
    expect(result.items[0]!.dayExplicit).toBe(false)
    expect(result.items[0]!.startFrame).toBe(2)
  })
})

describe('CSV 导出与往返', () => {
  const items: MarkerItem[] = [
    {
      id: 'a',
      name: '点',
      kind: 'marker',
      format: df2997,
      startFrame: 1800,
      dayExplicit: true,
      dateDecision: 0,
      note: '',
    },
    {
      id: 'b',
      name: '区间',
      kind: 'range',
      format: df2997,
      startFrame: 100,
      outFrame: 200,
      dayExplicit: true,
      dateDecision: 0,
      note: '带,逗号',
    },
  ]

  it('导出后重新导入一致', () => {
    const csv = markersToCsv(items, true)
    const imported = importMarkersCsv(csv, options)
    expect(imported.items).toHaveLength(2)
    const point = imported.items[0]!
    const range = imported.items[1]!
    expect(point.startFrame).toBe(1800)
    expect(range.kind).toBe('range')
    if (range.kind === 'range') expect(range.outFrame).toBe(200)
    expect(range.note).toBe('带,逗号')
    expect(range.name).toBe('区间')
  })

  it('不包含末端导出也能往返', () => {
    const csv = markersToCsv(items, false)
    const imported = importMarkersCsv(csv, { ...options, endInclusive: false })
    expect(imported.items).toHaveLength(2)
    const range = imported.items[1]!
    if (range.kind === 'range') expect(range.outFrame).toBe(200)
  })

  it('导出含末端边界与帧数列', () => {
    const csv = markersToCsv(items, true)
    expect(csv).toContain('end_boundary_tc')
    expect(csv).toContain('end_inclusive')
  })

  it('25p 与 29.97 混合导出可还原格式', () => {
    const mixed: MarkerItem[] = [
      {
        id: 'c',
        name: '25p 点',
        kind: 'marker',
        format: p25,
        startFrame: 100,
        dayExplicit: true,
        dateDecision: 0,
        note: '',
      },
    ]
    const imported = importMarkersCsv(markersToCsv(mixed, true), options)
    expect(imported.items[0]!.format.rate).toBe('25')
    expect(imported.items[0]!.startFrame).toBe(100)
    expect(parseFormatKey('25')!.dropFrame).toBe(false)
  })
})
