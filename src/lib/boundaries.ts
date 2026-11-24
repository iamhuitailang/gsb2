import {
  RATES,
  dropFramesPerMinute,
  frameToParts,
  frameToRealSeconds,
  frameToTimecodeWithDay,
  framesPerDay,
  nominalFps,
  splitAbsoluteFrame,
  type FrameFormat,
} from './timecode'

export interface BoundaryKind {
  id: 'minute' | 'tenMinute' | 'hour' | 'midnight'
  title: string
  hint: string
}

export const BOUNDARY_KINDS: readonly BoundaryKind[] = [
  {
    id: 'minute',
    title: '普通分钟边界',
    hint: '非整十分钟的分钟交界。跳号格式在这里跳过编号；不跳号格式只按标称帧率进位。',
  },
  {
    id: 'tenMinute',
    title: '十分钟边界',
    hint: '跳号规则每十分钟恢复一次：整十分钟（包括 60 分整点）不跳编号。',
  },
  {
    id: 'hour',
    title: '整点边界',
    hint: '29.97 / 59.94 的跳号在 60 分整点同样不跳，下一帧是 ;00，时码与真实时间重新对齐。',
  },
  {
    id: 'midnight',
    title: '午夜边界',
    hint: '24 小时循环点。跨午夜的区间必须保留先后顺序；单独出现的小时数无法确定归属哪一天。',
  },
]

/**
 * 第 m 个分钟边界之后第一帧的绝对帧号。
 * 跳号格式下，非整十分钟的边界从 ;drop 开始，整十分钟（含整点）从 ;00 开始。
 * 帧号公式与解析一致：label = nominal×总秒 + 帧号 − drop×(总分钟 − ⌊总分钟/10⌋)。
 */
export function minuteBoundaryAfterFrame(format: FrameFormat, m: number): number {
  const nominal = nominalFps(format)
  const drop = dropFramesPerMinute(format)
  if (drop === 0) return nominal * 60 * m
  const framesIntoSecond = m % 10 === 0 ? 0 : drop
  const droppedTotal = drop * (m - Math.floor(m / 10))
  return nominal * 60 * m + framesIntoSecond - droppedTotal
}

export interface BoundaryRow {
  kind: BoundaryKind['id']
  title: string
  hint: string
  beforeFrame: number
  afterFrame: number
  crossesDay: boolean
  beforeTc: string
  afterTc: string
  beforeReal: number
  afterReal: number
  /** 相邻两帧的真实时间差（毫秒） */
  realStepMs: number
  /** 相邻两帧的时码读数差（毫秒） */
  labelStepMs: number
  /** 边界帧上的累计漂移 = 时码读数 − 真实经过时间（毫秒） */
  driftAfterMs: number
  driftBeforeMs: number
  /** 被跳过的编号（仅跳号格式的普通分钟边界） */
  skippedLabels: string[]
  /** 该边界后的第一帧按当前帧率规范应是哪个时码 */
  expectedAfterTc: string
  /** 是否符合当前帧率的规范；不跳号格式为 null */
  compliant: boolean | null
  note: string
}

function labelSecondsOf(frame: number, format: FrameFormat): number {
  const parts = frameToParts(frame, format)
  return parts.hours * 3600 + parts.minutes * 60 + parts.seconds + parts.frames / nominalFps(format)
}

function driftMsAt(frame: number, format: FrameFormat): number {
  const day = splitAbsoluteFrame(frame, format).day
  return (labelSecondsOf(frame, format) + day * 86400 - frameToRealSeconds(frame, format)) * 1000
}

function isExactRate(format: FrameFormat): boolean {
  const spec = RATES[format.rate]
  return spec.actualNum === spec.actualDen * spec.nominal
}

function skippedLabelsFor(boundaryMinute: number, format: FrameFormat): string[] {
  const drop = dropFramesPerMinute(format)
  if (drop === 0) return []
  const hours = Math.floor(boundaryMinute / 60)
  const minutes = boundaryMinute % 60
  return Array.from({ length: drop }, (_, index) =>
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00;${String(index).padStart(2, '0')}`,
  )
}

export function boundaryRow(kind: BoundaryKind['id'], format: FrameFormat): BoundaryRow {
  const meta = BOUNDARY_KINDS.find((entry) => entry.id === kind)!
  const drop = dropFramesPerMinute(format)
  const afterFrame =
    kind === 'minute'
      ? minuteBoundaryAfterFrame(format, 1)
      : kind === 'tenMinute'
        ? minuteBoundaryAfterFrame(format, 10)
        : kind === 'hour'
          ? minuteBoundaryAfterFrame(format, 60)
          : framesPerDay(format)
  const beforeFrame = afterFrame - 1

  const dayBefore = splitAbsoluteFrame(beforeFrame, format).day
  const dayAfter = splitAbsoluteFrame(afterFrame, format).day
  const beforeTc = frameToTimecodeWithDay(beforeFrame, format)
  const afterTc = frameToTimecodeWithDay(afterFrame, format)
  const beforeReal = frameToRealSeconds(beforeFrame, format)
  const afterReal = frameToRealSeconds(afterFrame, format)
  const realStepMs = (afterReal - beforeReal) * 1000
  // 读数步进按时码字段本身计算，午夜时取 24 小时循环内的一步（23:59:59;29 → 00:00:00;00）
  const rawLabelStep = labelSecondsOf(afterFrame, format) - labelSecondsOf(beforeFrame, format)
  const labelStepMs = (((rawLabelStep % 86400) + 86400) % 86400) * 1000
  const driftAfterMs = driftMsAt(afterFrame, format)
  const driftBeforeMs = driftMsAt(beforeFrame, format)
  const afterParts = frameToParts(afterFrame, format)

  const expectedAfterTc =
    kind === 'midnight'
      ? `${format.dropFrame ? '00:00:00;00' : '00:00:00:00'} +1d`
      : `${String(afterParts.hours).padStart(2, '0')}:${String(afterParts.minutes).padStart(2, '0')}:00${
          format.dropFrame ? `;${String(kind === 'minute' ? drop : 0).padStart(2, '0')}` : ':00'
        }`

  let skippedLabels: string[] = []
  let compliant: boolean | null = null
  let note: string

  if (kind === 'midnight') {
    compliant =
      dayAfter === dayBefore + 1 &&
      afterParts.hours === 0 &&
      afterParts.minutes === 0 &&
      afterParts.seconds === 0 &&
      afterParts.frames === 0
    note = `午夜翻页：${beforeTc} → ${afterTc}；绝对帧号连续 +1，日期归属 +1 天。${
      format.dropFrame
        ? '跳号格式在午夜同样不跳，下一次跳号从次日第 1 分钟开始；读数以分钟为周期摆动，并随时间缓慢累积，一天约 +86.4 ms（约 2.6 帧）。'
        : isExactRate(format)
          ? '25 帧是整数帧率，一天正好 24 小时，不存在累积漂移。'
          : '不跳号格式的读数比真实时间慢，一天累计约 −86.4 秒；午夜只是标签循环点，不会纠正这个偏差。'
    }`
  } else if (format.dropFrame) {
    if (kind === 'minute') {
      skippedLabels = skippedLabelsFor(1, format)
      compliant = afterParts.seconds === 0 && afterParts.frames === drop
      note = `跳号生效：${skippedLabels.join('、')} 被跳过，${afterTc} 直接接在 ${beforeTc} 之后。读数跨了 ${(
        labelStepMs / 1000
      ).toFixed(3)} s，真实只过了 ${(realStepMs / 1000).toFixed(3)} s。`
    } else {
      compliant = afterParts.seconds === 0 && afterParts.frames === 0
      note =
        kind === 'hour'
          ? `整点同样不跳号：${beforeTc} → ${afterTc}。跳号只在非整十分钟的分钟边界发生，整点 60 分属于整十分钟。`
          : `整十分钟不跳号：${beforeTc} → ${afterTc}，时码读数与真实时间在这一帧重新对齐。`
    }
  } else {
    note = isExactRate(format)
      ? `25 帧是整数帧率：${beforeTc} → ${afterTc}，读数与真实时间始终一致，不存在累积漂移。`
      : `不跳号：${beforeTc} → ${afterTc}，编号按 ${nominalFps(format)} 帧/秒递增；读数与真实时间会持续累积漂移（每小时约 −3.6 秒）。`
  }

  return {
    kind,
    title: meta.title,
    hint: meta.hint,
    beforeFrame,
    afterFrame,
    crossesDay: dayAfter !== dayBefore,
    beforeTc,
    afterTc,
    beforeReal,
    afterReal,
    realStepMs,
    labelStepMs,
    driftAfterMs,
    driftBeforeMs,
    skippedLabels,
    expectedAfterTc,
    compliant,
    note,
  }
}

export function boundaryRows(format: FrameFormat): BoundaryRow[] {
  return BOUNDARY_KINDS.map((kind) => boundaryRow(kind.id, format))
}

export function formatBoundaryDelta(ms: number): string {
  const rounded = Math.round(ms * 1000) / 1000
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(3)} ms`
}
