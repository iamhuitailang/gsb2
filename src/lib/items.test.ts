import { describe, expect, it } from 'vitest'
import { makeFormat } from './timecode'
import {
  checkPointAgainstSegments,
  checkRangeAgainstSegments,
  itemBoundaryFrame,
  itemFrameCount,
  makePointMarker,
  makeRangeMarker,
  makeSegment,
  segmentGeometry,
  setItemDay,
  shiftItem,
} from './items'

const df2997 = makeFormat('2997', true)
const p25 = makeFormat('25', false)

describe('区间末端包含规则', () => {
  const range = makeRangeMarker(100, 200, df2997, '区间')

  it('包含时帧数是 out - start + 1', () => {
    expect(itemFrameCount(range, true)).toBe(101)
  })

  it('不包含时帧数是 out - start', () => {
    expect(itemFrameCount(range, false)).toBe(100)
  })

  it('末端边界帧：包含时是出点下一帧，不包含时就是出点', () => {
    expect(itemBoundaryFrame(range, true)).toBe(201)
    expect(itemBoundaryFrame(range, false)).toBe(200)
  })

  it('点标记只有一帧', () => {
    expect(itemFrameCount(makePointMarker(50, df2997, '点'), true)).toBe(1)
    expect(itemFrameCount(makePointMarker(50, df2997, '点'), false)).toBe(1)
  })
})

describe('素材段', () => {
  it('段内、段前、段后的判定', () => {
    const segment = makeSegment(1000, 100, df2997, 'A')
    const inside = checkPointAgainstSegments(1050, df2997, [segment])
    expect(inside[0]!.status).toBe('inside')
    expect(inside[0]!.offsetFrames).toBe(50)

    const before = checkPointAgainstSegments(900, df2997, [segment])
    expect(before[0]!.status).toBe('before')
    // 段首是 1000，900 比段首早 100 帧
    expect(before[0]!.distanceFrames).toBe(100)

    const after = checkPointAgainstSegments(1200, df2997, [segment])
    expect(after[0]!.status).toBe('after')
    // 段末帧是 1099，1200 比它晚 101 帧
    expect(after[0]!.distanceFrames).toBe(101)
  })

  it('段末帧算在段内，下一帧算段外', () => {
    const segment = makeSegment(1000, 100, df2997, 'A')
    expect(checkPointAgainstSegments(1099, df2997, [segment])[0]!.status).toBe('inside')
    expect(checkPointAgainstSegments(1100, df2997, [segment])[0]!.status).toBe('after')
  })

  it('格式不同时不做帧号比较', () => {
    const segment = makeSegment(0, 1000, p25, '25p')
    const check = checkPointAgainstSegments(50, df2997, [segment])
    expect(check[0]!.status).toBe('format-mismatch')
  })

  it('区间完全落在段内', () => {
    const segment = makeSegment(1000, 500, df2997, 'A')
    const checks = checkRangeAgainstSegments(1100, 1200, df2997, [segment])
    expect(checks[0]!.status).toBe('inside')
    expect(checks[0]!.offsetFrames).toBe(100)
  })

  it('区间部分越界明确给出距离', () => {
    const segment = makeSegment(1000, 100, df2997, 'A')
    // 入点 1050 落在段内，出点 1200 超出段末帧 1099
    const checks = checkRangeAgainstSegments(1050, 1200, df2997, [segment])
    expect(checks[0]!.status).toBe('partial')
    expect(checks[0]!.distanceFrames).toBe(101)
    expect(checks[0]!.message).toContain('部分落入')
  })

  it('整段都在段后时状态是 after', () => {
    const segment = makeSegment(1000, 100, df2997, 'A')
    // 入点 1150 已超过段末帧 1099
    const checks = checkRangeAgainstSegments(1150, 1200, df2997, [segment])
    expect(checks[0]!.status).toBe('after')
    expect(checks[0]!.distanceFrames).toBe(51)
  })

  it('入点早于段首、出点仍在段内时也是 partial', () => {
    const segment = makeSegment(1000, 100, df2997, 'A')
    const checks = checkRangeAgainstSegments(950, 1050, df2997, [segment])
    expect(checks[0]!.status).toBe('partial')
    expect(checks[0]!.distanceFrames).toBe(50)
  })

  it('帧数无效时报 invalid 且几何计算不抛错', () => {
    const segment = makeSegment(0, 0, df2997, '坏段')
    expect(checkPointAgainstSegments(0, df2997, [segment])[0]!.status).toBe('invalid')
    expect(segmentGeometry(segment).endAbsolute).toBe(0)
    expect(segmentGeometry(segment).durationSeconds).toBe(0)
  })
})

describe('日期归属与整体平移', () => {
  it('setItemDay 移动标记到指定日期并保留日内位置', () => {
    const item = makePointMarker(100, df2997, '点', { dayExplicit: false })
    const moved = setItemDay(item, 1)
    expect(moved.startFrame).toBe(100 + 2589408)
    expect(moved.dayExplicit).toBe(true)
    expect(moved.dateDecision).toBe(1)
    // 绝对帧号变为 +1d 后的同日位置
    expect(moved.startFrame).toBeGreaterThan(2589408)
  })

  it('setItemDay 不会把日期移到负数天', () => {
    const item = makePointMarker(100 + 2589408, df2997, '点', { dayExplicit: true })
    const moved = setItemDay(item, -3)
    expect(moved.startFrame).toBe(100)
    expect(moved.dateDecision).toBe(0)
  })

  it('shiftItem 同步移动入点与出点并保持区间长度', () => {
    const range = makeRangeMarker(100, 200, df2997, '区间')
    const shifted = shiftItem(range, 50)
    expect(shifted.startFrame).toBe(150)
    if (shifted.kind === 'range') expect(shifted.outFrame).toBe(250)
  })

  it('shiftItem 在起点附近不会把出点推成负数', () => {
    const range = makeRangeMarker(10, 30, df2997, '区间')
    const shifted = shiftItem(range, -50)
    expect(shifted.startFrame).toBe(0)
    // 起点被截到 0，出点按原区间长度 20 顺延，而不是变成负数
    if (shifted.kind === 'range') expect(shifted.outFrame).toBe(20)
  })
})
