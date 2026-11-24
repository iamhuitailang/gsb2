import { describe, expect, it } from 'vitest'
import { makeFormat } from './timecode'
import { markerToCsvRow, EXPORT_HEADER } from './csv'
import { makePointMarker, makeRangeMarker } from './items'

const df2997 = makeFormat('2997', true)

function rowToMap(row: (string | number)[]): Record<string, string | number | undefined> {
  const entries = EXPORT_HEADER.map((key, index) => [key, row[index]] as const)
  return Object.fromEntries(entries)
}

describe('单行导出', () => {
  it('导出列为时码、日期、帧号、末端规则、边界与帧数', () => {
    const range = makeRangeMarker(100, 200, df2997, '区间')
    const row = markerToCsvRow(range, 0, true)
    const map = rowToMap(row)
    expect(map.start_frame).toBe(100)
    expect(map.out_frame).toBe(200)
    expect(map.frame_count).toBe(101)
    expect(map.end_inclusive).toBe('true')
    expect(map.start_tc).toBe('00:00:03;10')
  })

  it('不包含末端时帧数少一', () => {
    const range = makeRangeMarker(100, 200, df2997, '区间')
    const row = markerToCsvRow(range, 0, false)
    const map = rowToMap(row)
    expect(map.frame_count).toBe(100)
    expect(map.end_inclusive).toBe('false')
  })

  it('点标记的出点列为空', () => {
    const point = makePointMarker(10, df2997, '点')
    const row = markerToCsvRow(point, 0, true)
    const map = rowToMap(row)
    expect(map.out_frame).toBe('')
    expect(map.out_tc).toBe('')
    expect(map.frame_count).toBe(1)
  })
})
