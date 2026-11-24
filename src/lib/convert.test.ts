import { describe, expect, it } from 'vitest'
import { makeFormat } from './timecode'
import { convertPoint, convertRange } from './convert'
import { makeRangeMarker } from './items'

const df2997 = makeFormat('2997', true)
const p25 = makeFormat('25', false)
const df5994 = makeFormat('5994', true)

describe('保留真实经过时间', () => {
  it('29.97 → 25 的真实时间保持不变', () => {
    const result = convertPoint(1800, df2997, p25, 'real')
    const sourceReal = 1800 * (1001 / 30000)
    const targetReal = result.frame * 0.04
    expect(Math.abs(sourceReal - targetReal)).toBeLessThan(0.04)
    expect(result.mode).toBe('real')
  })

  it('取整差不超过半个目标帧（允许浮点误差）', () => {
    for (let frame = 0; frame < 5000; frame += 37) {
      const result = convertPoint(frame, df2997, p25, 'real')
      expect(Math.abs(result.roundingFrames)).toBeLessThanOrEqual(0.5 + 1e-6)
    }
  })

  it('保留真实时间时帧号可能变化', () => {
    const result = convertPoint(1800, df2997, p25, 'real')
    expect(result.frame).not.toBe(1800)
    expect(result.exactFrame).not.toBe(1800)
  })

  it('29.97 → 59.94 帧号约翻倍', () => {
    const result = convertPoint(3000, df2997, df5994, 'real')
    expect(result.frame).toBeGreaterThan(5900)
    expect(result.frame).toBeLessThan(6100)
  })

  it('保留帧序号时，DF 与 NDF 的时码读数差会明显暴露', () => {
    // 同一帧号 9000：DF 的读数因跳号而多于 NDF
    const result = convertPoint(9000, df2997, makeFormat('2997', false), 'frame')
    expect(Math.abs(result.labelDeltaMs)).toBeGreaterThan(100)
  })
})

describe('保留原帧序号', () => {
  it('帧号不变且没有取整差', () => {
    const result = convertPoint(1800, df2997, p25, 'frame')
    expect(result.frame).toBe(1800)
    expect(result.exactFrame).toBe(1800)
    expect(result.roundingFrames).toBe(0)
  })

  it('真实时间随目标帧率改变', () => {
    const result = convertPoint(1800, df2997, p25, 'frame')
    // 帧号不变，25p 下 1800 帧是 72 秒，比 29.97 的 60.06 秒更长
    expect(result.realDeltaMs).toBeGreaterThan(0)
  })
})

describe('区间换算', () => {
  const range = makeRangeMarker(100, 200, df2997, '区间')

  it('末端包含与否影响目标帧数', () => {
    const inclusive = convertRange(range, df2997, p25, 'real', true)
    const exclusive = convertRange(range, df2997, p25, 'real', false)
    expect(inclusive.targetFrameCount - exclusive.targetFrameCount).toBe(1)
  })

  it('保留帧号时区间帧数不变', () => {
    const result = convertRange(range, df2997, p25, 'frame', true)
    expect(result.targetFrameCount).toBe(result.sourceFrameCount)
    expect(result.countDelta).toBe(0)
  })

  it('换算后出点可能翻转并提示', () => {
    const tiny = makeRangeMarker(0, 0, df2997, '极小')
    const result = convertRange(tiny, df2997, p25, 'real', false)
    expect(result.targetFrameCount).toBeLessThanOrEqual(0)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})
