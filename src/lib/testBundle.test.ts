import { describe, expect, it } from 'vitest'
import { checkBoundaryCases, checkCsvRoundtrip, makeTestBundle, TEST_BOUNDARY_CASES } from './testBundle'
import { markersToCsv, importMarkersCsv } from './csv'
import { checkPointAgainstSegments } from './items'
import { makeFormat } from './timecode'

describe('项目自带测试数据', () => {
  const bundle = makeTestBundle()

  it('包含素材段与标记', () => {
    expect(bundle.segments.length).toBeGreaterThanOrEqual(6)
    expect(bundle.markers.length).toBeGreaterThanOrEqual(8)
    expect(bundle.cases.length).toBeGreaterThanOrEqual(10)
  })

  it('午夜后的单点默认落在第 0 天素材段内', () => {
    const point = bundle.markers.find((item) => item.name === '午夜后单点')!
    const segment = bundle.segments.find((item) => item.name.includes('第 0 天凌晨'))!
    const inside =
      point.startFrame >= segment.startFrame &&
      point.startFrame < segment.startFrame + segment.frameCount &&
      point.format.rate === segment.format.rate &&
      point.format.dropFrame === segment.format.dropFrame
    expect(inside).toBe(true)
    expect(point.dateDecision).toBeNull()

    const checks = checkPointAgainstSegments(point.startFrame, point.format, bundle.segments)
    const midnightSegment = checks.find((check) => check.segmentId === segment.id)!
    expect(midnightSegment.status).toBe('inside')
  })

  it('标记覆盖 25 / 29.97 / 59.94', () => {
    const rates = new Set(bundle.markers.map((item) => item.format.rate))
    expect(rates.has('25')).toBe(true)
    expect(rates.has('2997')).toBe(true)
    expect(rates.has('5994')).toBe(true)
  })

  it('有跨午夜的区间且顺序正确', () => {
    const crossing = bundle.markers.filter(
      (item) => item.kind === 'range' && item.startFrame < 2589408 && item.outFrame >= 2589408,
    )
    expect(crossing.length).toBeGreaterThan(0)
  })

  it('有落在素材段外的标记用于演示提示', () => {
    const outside = bundle.markers.find((item) => item.name === '段落外的点')!
    const dfSegments = bundle.segments.filter(
      (segment) => segment.format.rate === '2997' && segment.format.dropFrame,
    )
    const insideAny = dfSegments.some(
      (segment) =>
        outside.startFrame >= segment.startFrame &&
        outside.startFrame < segment.startFrame + segment.frameCount,
    )
    expect(insideAny).toBe(false)
  })

  it('有日期待定的单点', () => {
    const pending = bundle.markers.filter((item) => item.kind === 'marker' && item.dateDecision === null)
    expect(pending.length).toBeGreaterThan(0)
  })
})

describe('边界样例核验', () => {
  it('全部样例通过', () => {
    const results = checkBoundaryCases(TEST_BOUNDARY_CASES)
    const failed = results.filter((result) => !result.ok)
    expect(failed.map((result) => `${result.case.name}: ${result.actualTc}`)).toEqual([])
  })
})

describe('导出往返核验', () => {
  it('自带标记导出后原样倒回', () => {
    const bundle = makeTestBundle()
    const result = checkCsvRoundtrip(bundle.markers, true)
    expect(result.ok).toBe(true)
    expect(result.rows.every((row) => row.match)).toBe(true)
  })

  it('不包含末端时同样可倒回', () => {
    const bundle = makeTestBundle()
    const result = checkCsvRoundtrip(bundle.markers, false)
    expect(result.ok).toBe(true)
  })

  it('导出文件重新导入后有效标记数与导出前一致', () => {
    const bundle = makeTestBundle()
    const csv = markersToCsv(bundle.markers, true)
    const imported = importMarkersCsv(csv, { endInclusive: true, defaultFormat: makeFormat('2997', true) })
    expect(imported.items).toHaveLength(bundle.markers.length)
  })
})
