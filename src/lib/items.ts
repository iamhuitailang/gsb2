import {
  formatLabel,
  frameDurationSeconds,
  frameToTimecodeWithDay,
  framesPerDay,
  nominalFps,
  splitAbsoluteFrame,
  type FrameFormat,
} from './timecode'

export interface ItemBase {
  id: string
  name: string
  format: FrameFormat
  /** 绝对帧号（0 = 第 0 天 00:00:00:00），可超过一天 */
  startFrame: number
  /** 导入时是否明确写了日期（后缀 +Nd 或 day 列） */
  dayExplicit: boolean
  /** 跨午夜待定日期时用户的选择；null 表示尚未选择 */
  dateDecision: number | null
  note: string
}

export interface PointMarker extends ItemBase {
  kind: 'marker'
}

export interface RangeMarker extends ItemBase {
  kind: 'range'
  /** 出点帧号；是否包含由全局开关决定 */
  outFrame: number
}

export type MarkerItem = PointMarker | RangeMarker

/** 编辑补丁：允许同时写 outFrame，应用时按标记类型忽略无关字段 */
export type MarkerPatch = Partial<Omit<PointMarker, 'kind'>> & { outFrame?: number }

/**
 * 区间帧数：末端包含时算上出点，不包含时出点是边界。
 * 界面、换算与 CSV 共用这一规则。
 */
export function itemFrameCount(item: MarkerItem, endInclusive: boolean): number {
  if (item.kind === 'marker') return 1
  return item.outFrame - item.startFrame + (endInclusive ? 1 : 0)
}

/** 结束边界帧：包含时是出点的下一帧，不包含时就是出点本身。 */
export function itemBoundaryFrame(item: MarkerItem, endInclusive: boolean): number {
  if (item.kind === 'marker') return item.startFrame + 1
  return item.outFrame + (endInclusive ? 1 : 0)
}

/** 界面/导出里显示的出点帧（始终是用户填的 out 帧）。 */
export function itemEndDisplayFrame(item: MarkerItem): number {
  return item.kind === 'marker' ? item.startFrame : item.outFrame
}

export function itemStartLabel(item: MarkerItem): string {
  return frameToTimecodeWithDay(item.startFrame, item.format)
}

export function itemBoundaryLabel(item: MarkerItem, endInclusive: boolean): string {
  return frameToTimecodeWithDay(itemBoundaryFrame(item, endInclusive), item.format)
}

let idSeed = 0
export function createId(prefix: string): string {
  idSeed += 1
  return `${prefix}-${Date.now().toString(36)}-${idSeed.toString(36)}`
}

export interface Segment {
  id: string
  name: string
  format: FrameFormat
  startFrame: number
  frameCount: number
  note: string
}

export interface SegmentGeometry {
  startAbsolute: number
  /** 最后一帧（包含） */
  endAbsolute: number
  /** 末端边界（不包含） */
  endExclusive: number
  startTc: string
  endTc: string
  endExclusiveTc: string
  durationSeconds: number
}

export function segmentGeometry(segment: Segment): SegmentGeometry {
  const startAbsolute = segment.startFrame
  const safeCount = Number.isFinite(segment.frameCount) ? Math.max(0, Math.floor(segment.frameCount)) : 0
  // 帧数无效时不让几何计算抛错，交给调用方报 invalid
  const endAbsolute = startAbsolute + Math.max(0, safeCount - 1)
  const endExclusive = startAbsolute + safeCount
  return {
    startAbsolute,
    endAbsolute,
    endExclusive,
    startTc: frameToTimecodeWithDay(startAbsolute, segment.format),
    endTc: frameToTimecodeWithDay(endAbsolute, segment.format),
    endExclusiveTc: frameToTimecodeWithDay(endExclusive, segment.format),
    durationSeconds: safeCount * frameDurationSeconds(segment.format),
  }
}

export type SegmentMarkStatus = 'inside' | 'partial' | 'before' | 'after' | 'format-mismatch' | 'invalid'

export interface MarkerSegmentCheck {
  segmentId: string
  segmentName: string
  status: SegmentMarkStatus
  /** 段内时相对段首的帧偏移 */
  offsetFrames: number | null
  /** 段外时距离最近段端的帧数 */
  distanceFrames: number | null
  message: string
  segmentStartTc: string
  segmentEndTc: string
}

export function sameFormat(a: FrameFormat, b: FrameFormat): boolean {
  return a.rate === b.rate && a.dropFrame === b.dropFrame
}

/**
 * 单独出现、没有显式日期的标记是否属于“午夜前后、无法确定归属哪一天”。
 * 取午夜后的第一分钟作为窗口：跨午夜交接时，00:00:xx 的标记既可能属于当天也可能属于次日。
 */
export function isAmbiguousMidnightTime(frameInDay: number, format: FrameFormat): boolean {
  return frameInDay < nominalFps(format) * 60
}

/**
 * 把一对入/出点与各素材段比对：
 * 命中返回段内偏移；落在段外则明确给出距离段首/段尾多少帧与多少秒。
 */
export function checkRangeAgainstSegments(
  startAbsolute: number,
  outAbsolute: number,
  format: FrameFormat,
  segments: Segment[],
): MarkerSegmentCheck[] {
  return segments.map((segment) => {
    const geometry = segmentGeometry(segment)
    const base = {
      segmentId: segment.id,
      segmentName: segment.name,
      segmentStartTc: geometry.startTc,
      segmentEndTc: geometry.endTc,
    }
    if (segment.frameCount <= 0 || !Number.isInteger(segment.frameCount)) {
      return {
        ...base,
        status: 'invalid' as const,
        offsetFrames: null,
        distanceFrames: null,
        message: '素材段帧数无效（必须 ≥ 1）',
      }
    }
    if (!sameFormat(segment.format, format)) {
      return {
        ...base,
        status: 'format-mismatch' as const,
        offsetFrames: null,
        distanceFrames: null,
        message: `段格式为 ${formatLabel(segment.format)}，与当前 ${formatLabel(format)} 不同，不能直接比较帧号`,
      }
    }
    if (outAbsolute < geometry.startAbsolute) {
      const distance = geometry.startAbsolute - outAbsolute
      return {
        ...base,
        status: 'before' as const,
        offsetFrames: null,
        distanceFrames: distance,
        message: `整段早于素材：出点距段首还差 ${distance} 帧（${(distance * frameDurationSeconds(format)).toFixed(3)} s）`,
      }
    }
    if (startAbsolute > geometry.endAbsolute) {
      const distance = startAbsolute - geometry.endAbsolute
      return {
        ...base,
        status: 'after' as const,
        offsetFrames: null,
        distanceFrames: distance,
        message: `整段晚于素材：入点已超出段尾 ${distance} 帧（${(distance * frameDurationSeconds(format)).toFixed(3)} s）`,
      }
    }
    if (startAbsolute < geometry.startAbsolute) {
      const distance = geometry.startAbsolute - startAbsolute
      // 出点仍在段内：区间部分落入
      return {
        ...base,
        status: 'partial' as const,
        offsetFrames: null,
        distanceFrames: distance,
        message: `入点早于段首 ${distance} 帧（${(distance * frameDurationSeconds(format)).toFixed(
          3,
        )} s），区间部分落入`,
      }
    }
    if (outAbsolute > geometry.endAbsolute) {
      const distance = outAbsolute - geometry.endAbsolute
      return {
        ...base,
        status: 'partial' as const,
        offsetFrames: null,
        distanceFrames: distance,
        message: `出点超出段尾 ${distance} 帧（${(distance * frameDurationSeconds(format)).toFixed(
          3,
        )} s），区间部分落入`,
      }
    }
    const offset = startAbsolute - geometry.startAbsolute
    return {
      ...base,
      status: 'inside' as const,
      offsetFrames: offset,
      distanceFrames: 0,
      message: `完全在段内：入点距段首 ${offset} 帧（${(offset * frameDurationSeconds(format)).toFixed(3)} s）`,
    }
  })
}

export function checkPointAgainstSegments(
  absolute: number,
  format: FrameFormat,
  segments: Segment[],
): MarkerSegmentCheck[] {
  return segments.map((segment) => {
    const checks = checkRangeAgainstSegments(absolute, absolute, format, [segment])
    return checks[0]!
  })
}

/**
 * 把标记整体移动到指定日期（绝对天数），保留日内相对位置。
 * 用于“单独出现、日期归属不明”的标记由用户手动裁定。
 */
export function setItemDay(item: MarkerItem, day: number): MarkerItem {
  const { frameInDay } = splitAbsoluteFrame(item.startFrame, item.format)
  const safeDay = Math.max(0, Math.trunc(day))
  const target = safeDay * framesPerDay(item.format) + frameInDay
  const delta = target - item.startFrame
  if (item.kind === 'marker') {
    return { ...item, startFrame: Math.max(0, item.startFrame + delta), dateDecision: safeDay, dayExplicit: true }
  }
  const length = item.outFrame - item.startFrame
  const startFrame = Math.max(0, item.startFrame + delta)
  return { ...item, startFrame, outFrame: startFrame + length, dateDecision: safeDay, dayExplicit: true }
}

export function makePointMarker(
  startFrame: number,
  format: FrameFormat,
  name: string,
  options: Partial<Pick<ItemBase, 'dayExplicit' | 'dateDecision' | 'note' | 'id'>> = {},
): PointMarker {
  return {
    id: options.id ?? createId('marker'),
    name,
    format,
    startFrame,
    dayExplicit: options.dayExplicit ?? false,
    dateDecision: options.dateDecision ?? null,
    note: options.note ?? '',
    kind: 'marker',
  }
}

export function makeRangeMarker(
  startFrame: number,
  outFrame: number,
  format: FrameFormat,
  name: string,
  options: Partial<Pick<ItemBase, 'dayExplicit' | 'dateDecision' | 'note' | 'id'>> = {},
): RangeMarker {
  return {
    id: options.id ?? createId('marker'),
    name,
    format,
    startFrame,
    outFrame,
    dayExplicit: options.dayExplicit ?? false,
    dateDecision: options.dateDecision ?? null,
    note: options.note ?? '',
    kind: 'range',
  }
}

export function makeSegment(
  startFrame: number,
  frameCount: number,
  format: FrameFormat,
  name: string,
  options: Partial<Pick<Segment, 'id' | 'note'>> = {},
): Segment {
  return {
    id: options.id ?? createId('segment'),
    name,
    format,
    startFrame,
    frameCount,
    note: options.note ?? '',
  }
}

export function shiftItem(item: MarkerItem, deltaFrames: number): MarkerItem {
  const length = item.kind === 'range' ? item.outFrame - item.startFrame : 0
  const startFrame = Math.max(0, item.startFrame + deltaFrames)
  if (item.kind === 'marker') return { ...item, startFrame }
  return { ...item, startFrame, outFrame: startFrame + length }
}
