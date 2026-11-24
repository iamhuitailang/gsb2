import { describe, expect, it } from 'vitest'
import { makeFormat } from './timecode'
import { boundaryRow, boundaryRows, minuteBoundaryAfterFrame } from './boundaries'

const df2997 = makeFormat('2997', true)
const ndf2997 = makeFormat('2997', false)
const df5994 = makeFormat('5994', true)
const p25 = makeFormat('25', false)

describe('分钟边界帧号', () => {
  it('29.97 DF 各边界帧号', () => {
    expect(minuteBoundaryAfterFrame(df2997, 1)).toBe(1800)
    expect(minuteBoundaryAfterFrame(df2997, 2)).toBe(3598)
    expect(minuteBoundaryAfterFrame(df2997, 9)).toBe(16184)
    expect(minuteBoundaryAfterFrame(df2997, 10)).toBe(17982)
    expect(minuteBoundaryAfterFrame(df2997, 60)).toBe(107892)
    expect(minuteBoundaryAfterFrame(df2997, 1440)).toBe(2589408)
  })

  it('25 与 NDF 的分钟边界就是 帧率 × 60 × 分钟', () => {
    expect(minuteBoundaryAfterFrame(p25, 1)).toBe(1500)
    expect(minuteBoundaryAfterFrame(p25, 60)).toBe(90000)
    expect(minuteBoundaryAfterFrame(ndf2997, 1)).toBe(1800)
    expect(minuteBoundaryAfterFrame(ndf2997, 1440)).toBe(2592000)
  })
})

describe('普通分钟边界', () => {
  it('29.97 DF 跳过 ;00 与 ;01', () => {
    const row = boundaryRow('minute', df2997)
    expect(row.beforeTc).toBe('00:00:59;29')
    expect(row.afterTc).toBe('00:01:00;02')
    expect(row.skippedLabels).toEqual(['00:01:00;00', '00:01:00;01'])
    expect(row.compliant).toBe(true)
    expect(row.expectedAfterTc).toBe('00:01:00;02')
  })

  it('29.97 DF 边界读数一次跨 3 个编号（100 ms），真实只过 1 帧', () => {
    const row = boundaryRow('minute', df2997)
    expect(row.realStepMs).toBeCloseTo(1001 / 30, 6)
    // ;29 之后直接是 ;02：读数跨度是 3 个编号 = 100 ms
    expect(row.labelStepMs).toBeCloseTo(100, 6)
    expect(row.labelStepMs - row.realStepMs).toBeCloseTo(100 - 1001 / 30, 6)
  })

  it('29.97 DF 的读数漂移每分钟循环一次', () => {
    const row = boundaryRow('minute', df2997)
    // 边界前一帧读数落后约 60 ms，过边界后读数追平并略微超前
    expect(row.driftBeforeMs).toBeCloseTo(-60, 0)
    expect(row.driftAfterMs).toBeCloseTo(6.67, 0)
  })

  it('59.94 DF 跳过 ;00–;03', () => {
    const row = boundaryRow('minute', df5994)
    expect(row.afterTc).toBe('00:01:00;04')
    expect(row.skippedLabels).toEqual(['00:01:00;00', '00:01:00;01', '00:01:00;02', '00:01:00;03'])
    expect(row.compliant).toBe(true)
  })

  it('NDF 不跳号，边界为 :00', () => {
    const row = boundaryRow('minute', ndf2997)
    expect(row.afterTc).toBe('00:01:00:00')
    expect(row.skippedLabels).toEqual([])
    expect(row.compliant).toBeNull()
  })
})

describe('十分钟与整点边界', () => {
  it('29.97 DF 十分钟边界不跳', () => {
    const row = boundaryRow('tenMinute', df2997)
    expect(row.beforeTc).toBe('00:09:59;29')
    expect(row.afterTc).toBe('00:10:00;00')
    expect(row.compliant).toBe(true)
    expect(row.skippedLabels).toEqual([])
  })

  it('29.97 DF 整点不跳', () => {
    const row = boundaryRow('hour', df2997)
    expect(row.beforeTc).toBe('00:59:59;29')
    expect(row.afterTc).toBe('01:00:00;00')
    expect(row.compliant).toBe(true)
  })

  it('十分钟边界处 DF 漂移接近零', () => {
    const row = boundaryRow('tenMinute', df2997)
    expect(Math.abs(row.driftAfterMs)).toBeLessThan(1)
    expect(Math.abs(row.driftBeforeMs)).toBeLessThan(1)
    // 普通分钟边界前一帧读数落后，过边界后读数追平并略微超前
    const minuteRow = boundaryRow('minute', df2997)
    expect(minuteRow.driftBeforeMs).toBeLessThan(0)
    expect(minuteRow.driftAfterMs).toBeGreaterThan(0)
  })

  it('25p 十分钟与整点自然进位', () => {
    expect(boundaryRow('tenMinute', p25).afterTc).toBe('00:10:00:00')
    expect(boundaryRow('hour', p25).afterTc).toBe('01:00:00:00')
  })
})

describe('午夜边界', () => {
  it('29.97 DF 午夜翻页并跨天', () => {
    const row = boundaryRow('midnight', df2997)
    expect(row.beforeTc).toBe('23:59:59;29')
    expect(row.afterTc).toBe('00:00:00;00 +1d')
    expect(row.crossesDay).toBe(true)
    expect(row.compliant).toBe(true)
  })

  it('59.94 DF 午夜翻页', () => {
    const row = boundaryRow('midnight', df5994)
    expect(row.beforeTc).toBe('23:59:59;59')
    expect(row.afterTc).toBe('00:00:00;00 +1d')
    expect(row.crossesDay).toBe(true)
  })

  it('25p 午夜翻页', () => {
    const row = boundaryRow('midnight', p25)
    expect(row.beforeTc).toBe('23:59:59:24')
    expect(row.afterTc).toBe('00:00:00:00 +1d')
  })

  it('午夜的读数步进是 1/nominal 秒，真实步进是 1001/30000 秒', () => {
    const row = boundaryRow('midnight', df2997)
    expect(row.labelStepMs).toBeCloseTo(1000 / 30, 6)
    expect(row.realStepMs).toBeCloseTo(1001 / 30, 6)
  })

  it('午夜读数步进按 24 小时循环内的一步计算，而不是 24 小时', () => {
    const row = boundaryRow('midnight', df2997)
    expect(row.labelStepMs).toBeLessThan(100)
  })
})

describe('边界集合', () => {
  it('每种格式四类边界', () => {
    for (const format of [df2997, ndf2997, df5994, p25]) {
      const rows = boundaryRows(format)
      expect(rows.map((row) => row.kind)).toEqual(['minute', 'tenMinute', 'hour', 'midnight'])
    }
  })

  it('所有格式的跳号标记符合规范', () => {
    expect(boundaryRow('minute', df2997).compliant).toBe(true)
    expect(boundaryRow('minute', df5994).compliant).toBe(true)
    expect(boundaryRow('tenMinute', df5994).compliant).toBe(true)
  })
})
