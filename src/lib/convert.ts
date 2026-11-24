import {
  frameDurationSeconds,
  frameToRealSeconds,
  frameToTimecodeWithDay,
  nominalFps,
  realSecondsToFrameExact,
  type FrameFormat,
} from './timecode'
import { itemBoundaryFrame, itemFrameCount, type MarkerItem } from './items'

export type ConvertMode = 'real' | 'frame'

/** 时码标签所表示的秒数（与画面时码读数一致，按 24 小时制循环） */
function timecodeLabelSeconds(frame: number, format: FrameFormat): number {
  const tc = frameToTimecodeWithDay(frame, format).split(' ')[0]!
  const match = /^(\d{2}):(\d{2}):(\d{2})[:;.](\d{2})$/.exec(tc)
  if (!match) return 0
  const h = Number(match[1])
  const m = Number(match[2])
  const s = Number(match[3])
  const f = Number(match[4])
  return h * 3600 + m * 60 + s + f / nominalFps(format)
}

export interface PointConversion {
  mode: ConvertMode
  sourceFrame: number
  sourceTc: string
  sourceRealSeconds: number
  /** 目标格式下精确（未取整）的帧位置；“保留帧序号”时与 sourceFrame 相同 */
  exactFrame: number
  /** 取整后的目标帧号 */
  frame: number
  /** 取整差 = 取整后 − 精确值（帧） */
  roundingFrames: number
  roundingMs: number
  targetTc: string
  targetRealSeconds: number
  /** 目标实际时间 − 源实际时间（毫秒） */
  realDeltaMs: number
  /** 目标时码读数 − 源时码读数（毫秒）。跳号/不跳号切换时时码读数会整体跳动。 */
  labelDeltaMs: number
}

export function convertPoint(
  sourceFrame: number,
  from: FrameFormat,
  to: FrameFormat,
  mode: ConvertMode,
): PointConversion {
  const sourceRealSeconds = frameToRealSeconds(sourceFrame, from)
  const exactFrame = mode === 'real' ? realSecondsToFrameExact(sourceRealSeconds, to) : sourceFrame
  const frame = mode === 'real' ? Math.round(exactFrame) : sourceFrame
  const roundingFrames = frame - exactFrame
  const targetRealSeconds = frameToRealSeconds(frame, to)
  const labelDeltaMs = (timecodeLabelSeconds(frame, to) - timecodeLabelSeconds(sourceFrame, from)) * 1000
  return {
    mode,
    sourceFrame,
    sourceTc: frameToTimecodeWithDay(sourceFrame, from),
    sourceRealSeconds,
    exactFrame,
    frame,
    roundingFrames,
    roundingMs: roundingFrames * frameDurationSeconds(to) * 1000,
    targetTc: frameToTimecodeWithDay(frame, to),
    targetRealSeconds,
    realDeltaMs: (targetRealSeconds - sourceRealSeconds) * 1000,
    labelDeltaMs,
  }
}

export interface RangeConversion {
  start: PointConversion
  out: PointConversion
  /** 源格式下按末端包含规则计算的帧数 */
  sourceFrameCount: number
  /** 每个端点分别取整后，目标格式下的帧数 */
  targetFrameCount: number
  countDelta: number
  /** 用未取整的精确端点计算的目标帧数，用来解释取整带来的差异 */
  exactTargetFrameCount: number
  warnings: string[]
}

export function convertRange(
  item: MarkerItem,
  from: FrameFormat,
  to: FrameFormat,
  mode: ConvertMode,
  endInclusive: boolean,
): RangeConversion {
  const startSource = item.startFrame
  const outSource = item.kind === 'range' ? item.outFrame : item.startFrame
  const start = convertPoint(startSource, from, to, mode)
  const out = convertPoint(outSource, from, to, mode)
  const sourceFrameCount = itemFrameCount(item, endInclusive)
  const targetFrameCount =
    item.kind === 'range' ? out.frame - start.frame + (endInclusive ? 1 : 0) : 1
  const exactTargetFrameCount =
    item.kind === 'range' ? out.exactFrame - start.exactFrame + (endInclusive ? 1 : 0) : 1
  const warnings: string[] = []
  if (item.kind === 'range' && out.frame < start.frame) {
    warnings.push('换算后出点早于入点，区间发生翻转；请换用另一种换算方式或手动修正出点。')
  } else if (item.kind === 'range' && targetFrameCount <= 0) {
    warnings.push('换算后区间为空（末端不包含时出点必须晚于入点）。')
  }
  if (targetFrameCount !== sourceFrameCount) {
    warnings.push(
      `帧数由 ${sourceFrameCount} 变为 ${targetFrameCount}（差 ${targetFrameCount - sourceFrameCount} 帧）。`,
    )
  }
  const startRounding = start.roundingFrames
  const outRounding = out.roundingFrames
  if (Math.abs(startRounding) > 1e-9 || Math.abs(outRounding) > 1e-9) {
    warnings.push(
      `端点取整：入点 ${startRounding >= 0 ? '+' : ''}${startRounding.toFixed(4)} 帧，出点 ${
        outRounding >= 0 ? '+' : ''
      }${outRounding.toFixed(4)} 帧；帧数可能因此改变。`,
    )
  }
  if (mode === 'real' && item.kind === 'range') {
    // 末端边界在“包含”时是出点 + 1，在“不包含”时就是出点本身
    const boundarySource = itemBoundaryFrame(item, endInclusive)
    const expectedBoundaryFrame = endInclusive ? out.frame + 1 : out.frame
    const boundary = convertPoint(boundarySource, from, to, mode)
    if (boundary.frame !== expectedBoundaryFrame) {
      warnings.push(
        `末端边界单独换算后落在帧 ${boundary.frame}，与“${
          endInclusive ? '出点 + 1' : '出点'
        }”的 ${expectedBoundaryFrame} 不同；导出时以末端包含开关统一重算。`,
      )
    }
  }
  return {
    start,
    out,
    sourceFrameCount,
    targetFrameCount,
    countDelta: targetFrameCount - sourceFrameCount,
    exactTargetFrameCount,
    warnings,
  }
}

export function convertModeLabel(mode: ConvertMode): string {
  return mode === 'real' ? '保留真实经过时间' : '保留原帧序号'
}
