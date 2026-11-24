import { useMemo, useState } from 'react'
import {
  formatLabel,
  formatShortLabel,
  frameDurationSeconds,
  frameToRealSeconds,
  frameToTimecodeWithDay,
  makeFormat,
  splitAbsoluteFrame,
  type FrameFormat,
  type RateId,
} from '../lib/timecode'
import {
  checkPointAgainstSegments,
  checkRangeAgainstSegments,
  isAmbiguousMidnightTime,
  itemBoundaryLabel,
  itemFrameCount,
  setItemDay,
  shiftItem,
  type MarkerItem,
  type MarkerPatch,
  type MarkerSegmentCheck,
  type Segment,
} from '../lib/items'
import { convertModeLabel, convertRange } from '../lib/convert'
import { Badge, Empty, InlineNote, Panel, Toggle } from './ui'

function statusTone(status: MarkerSegmentCheck['status']) {
  switch (status) {
    case 'inside':
      return 'ok' as const
    case 'partial':
      return 'warn' as const
    case 'before':
    case 'after':
      return 'error' as const
    case 'format-mismatch':
      return 'warn' as const
    default:
      return 'neutral' as const
  }
}

function statusLabel(status: MarkerSegmentCheck['status']): string {
  switch (status) {
    case 'inside':
      return '段内'
    case 'partial':
      return '部分落入'
    case 'before':
      return '早于段'
    case 'after':
      return '超出段'
    case 'format-mismatch':
      return '格式不同'
    default:
      return '段无效'
  }
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds * 1000) / 1000
  const minutes = Math.floor(total / 60)
  const rest = total - minutes * 60
  return `${minutes}m ${rest.toFixed(3)}s`
}

/** 判断这一行是否需要用户裁定日期：单独出现、没有显式日期、且落在午夜后第一分钟内 */
function needsDateDecision(item: MarkerItem): boolean {
  if (item.kind !== 'marker' || item.dayExplicit || item.dateDecision !== null) return false
  const { frameInDay } = splitAbsoluteFrame(item.startFrame, item.format)
  return isAmbiguousMidnightTime(frameInDay, item.format)
}

function MarkerCard({
  item,
  index,
  segments,
  endInclusive,
  defaultTarget,
  onEdit,
  onRemove,
  onDuplicate,
}: {
  item: MarkerItem
  index: number
  segments: Segment[]
  endInclusive: boolean
  defaultTarget: FrameFormat
  onEdit: (id: string, patch: MarkerPatch) => void
  onRemove: (id: string) => void
  onDuplicate: (item: MarkerItem) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [shiftText, setShiftText] = useState('')
  const [target, setTarget] = useState<FrameFormat>(() => defaultTarget)

  const checks =
    item.kind === 'range'
      ? checkRangeAgainstSegments(item.startFrame, item.outFrame, item.format, segments)
      : checkPointAgainstSegments(item.startFrame, item.format, segments)
  const insideAny = checks.some((check) => check.status === 'inside')
  const partialAny = checks.some((check) => check.status === 'partial')
  const comparable = checks.filter((check) => check.status !== 'format-mismatch' && check.status !== 'invalid')
  const pendingDay = needsDateDecision(item)
  const count = itemFrameCount(item, endInclusive)
  const currentDay = splitAbsoluteFrame(item.startFrame, item.format).day

  const applyShift = () => {
    const delta = Number(shiftText)
    if (!Number.isInteger(delta) || delta === 0) return
    const next = shiftItem(item, delta)
    if (next.kind === 'marker') {
      onEdit(item.id, { startFrame: next.startFrame })
    } else {
      onEdit(item.id, { startFrame: next.startFrame, outFrame: next.outFrame })
    }
    setShiftText('')
  }

  return (
    <article className={`marker-card ${insideAny || partialAny ? '' : 'is-outside'}`}>
      <div className="marker-head">
        <span className="marker-index mono">{String(index + 1).padStart(2, '0')}</span>
        <input
          className="inline-input marker-name"
          value={item.name}
          aria-label="标记名称"
          onChange={(event) => onEdit(item.id, { name: event.target.value })}
        />
        <Badge tone={item.kind === 'range' ? 'accent' : 'info'}>{item.kind === 'range' ? '区间' : '点标记'}</Badge>
        <Badge tone="neutral">{formatShortLabel(item.format)}</Badge>
        {segments.length > 0 &&
          (insideAny ? (
            <Badge tone="ok">落在素材段</Badge>
          ) : partialAny ? (
            <Badge tone="warn">部分落入素材段</Badge>
          ) : (
            <Badge tone="error">不落在任何素材段</Badge>
          ))}
        {pendingDay && <Badge tone="warn">日期待定</Badge>}
      </div>

      <div className="marker-body">
        <dl className="kv compact">
          <dt>入点</dt>
          <dd className="mono">
            {frameToTimecodeWithDay(item.startFrame, item.format)} · 帧 {item.startFrame.toLocaleString('en-US')} ·{' '}
            {frameToRealSeconds(item.startFrame, item.format).toFixed(3)} s
          </dd>
          {item.kind === 'range' && (
            <>
              <dt>出点</dt>
              <dd className="mono">
                {frameToTimecodeWithDay(item.outFrame, item.format)} · 帧 {item.outFrame.toLocaleString('en-US')} ·{' '}
                {frameToRealSeconds(item.outFrame, item.format).toFixed(3)} s
              </dd>
              <dt>帧数 / 时长</dt>
              <dd className="mono">
                {count.toLocaleString('en-US')} 帧 · {formatDuration(count * frameDurationSeconds(item.format))}
                <span className="muted"> （末端{endInclusive ? '包含' : '不包含'}）</span>
              </dd>
              <dt>末端边界</dt>
              <dd className="mono">{itemBoundaryLabel(item, endInclusive)}（边界本身不计入帧数）</dd>
            </>
          )}
        </dl>

        {pendingDay && (
          <InlineNote tone="warn">
            这是单独出现、落在午夜后第一分钟内的时码，无法确定属于第 0 天还是次日。请选择日期归属：
            <div className="inline-actions">
              {[0, 1].map((day) => (
                <button
                  key={day}
                  type="button"
                  className={item.dayExplicit && currentDay === day ? 'btn-primary' : ''}
                  onClick={() => onEdit(item.id, setItemDay(item, day))}
                >
                  第 {day} 天
                </button>
              ))}
            </div>
          </InlineNote>
        )}

        {segments.length === 0 && <p className="muted small">尚未添加素材段，无法做段内校验。</p>}

        {checks.length > 0 && (
          <div className="check-list">
            {checks.map((check) => (
              <div key={check.segmentId} className={`check-row check-${statusTone(check.status)}`}>
                <Badge tone={statusTone(check.status)}>{statusLabel(check.status)}</Badge>
                <span className="check-name">{check.segmentName}</span>
                <span className="mono small">{check.message}</span>
              </div>
            ))}
            {comparable.length > 0 && !insideAny && !partialAny && (
              <p className="small check-hint">该标记没有落到任何可比素材段内。请核对起始时码 / 日期，或确认它属于其它素材。</p>
            )}
            {partialAny && (
              <p className="small check-hint check-hint-warn">
                区间有一部分落在素材段外，导出前请确认是否需要裁剪到段内。
              </p>
            )}
          </div>
        )}

        <div className="marker-controls">
          <label className="mini-field grow">
            <span>备注</span>
            <input
              value={item.note}
              onChange={(event) => onEdit(item.id, { note: event.target.value })}
              placeholder="交接说明、磁带号、场次"
            />
          </label>
          <label className="mini-field">
            <span>整体平移（帧）</span>
            <input
              className="mono"
              inputMode="numeric"
              value={shiftText}
              placeholder="±N"
              onChange={(event) => setShiftText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyShift()
              }}
            />
          </label>
          <div className="marker-buttons">
            <button type="button" onClick={applyShift} disabled={!shiftText}>
              平移
            </button>
            <button type="button" onClick={() => setExpanded(!expanded)}>
              {expanded ? '收起' : '换算到'}
            </button>
            <button type="button" onClick={() => onDuplicate(item)}>
              复制
            </button>
            <button type="button" className="btn-danger" onClick={() => onRemove(item.id)}>
              删除
            </button>
          </div>
        </div>

        {expanded && (
          <div className="conversion-inline">
            <div className="expand-target">
              <span className="muted small">目标格式</span>
              <div className="segmented segmented-compact">
                {(['25', '2997', '5994'] as RateId[]).map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    className={target.rate === rate ? 'is-active' : ''}
                    onClick={() => setTarget(makeFormat(rate, target.dropFrame))}
                  >
                    {rate === '25' ? '25' : rate === '2997' ? '29.97' : '59.94'}
                  </button>
                ))}
                <button
                  type="button"
                  className={target.dropFrame ? 'is-active' : ''}
                  disabled={target.rate === '25'}
                  onClick={() => setTarget(makeFormat(target.rate, !target.dropFrame))}
                >
                  {target.dropFrame ? 'DF' : 'NDF'}
                </button>
              </div>
            </div>
            <p className="muted small">
              与“帧率换算”面板同一套取整规则；末端{endInclusive ? '包含' : '不包含'}也一致。
            </p>
            <table className="mini-table">
              <thead>
                <tr>
                  <th>方式</th>
                  <th>入点</th>
                  <th>出点</th>
                  <th>帧数</th>
                </tr>
              </thead>
              <tbody>
                {(['real', 'frame'] as const).map((mode) => {
                  const result = convertRange(item, item.format, target, mode, endInclusive)
                  return (
                    <tr key={mode}>
                      <th scope="row">{convertModeLabel(mode)}</th>
                      <td className="mono">
                        {result.start.targetTc}
                        <small className="rounding">
                          {Math.abs(result.start.roundingFrames) > 1e-9
                            ? ` 取整 ${result.start.roundingFrames > 0 ? '+' : ''}${result.start.roundingFrames.toFixed(3)} 帧`
                            : ' 无取整差'}
                        </small>
                      </td>
                      <td className="mono">
                        {item.kind === 'range' ? result.out.targetTc : '—'}
                        {item.kind === 'range' && Math.abs(result.out.roundingFrames) > 1e-9 && (
                          <small className="rounding">
                            {' '}
                            取整 {result.out.roundingFrames > 0 ? '+' : ''}
                            {result.out.roundingFrames.toFixed(3)} 帧
                          </small>
                        )}
                      </td>
                      <td className="mono">
                        {result.targetFrameCount} 帧
                        {result.countDelta !== 0 && (
                          <small className="rounding">
                            {' '}
                            （差 {result.countDelta > 0 ? '+' : ''}
                            {result.countDelta}）
                          </small>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {convertRange(item, item.format, target, 'real', endInclusive).warnings.map((warning) => (
              <InlineNote key={warning} tone="warn">
                {warning}
              </InlineNote>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

export default function MarkersPanel({
  markers,
  segments,
  endInclusive,
  onEndInclusive,
  onEdit,
  onRemove,
  onDuplicate,
  onAddPoint,
  onAddRange,
  defaultTarget,
}: {
  markers: MarkerItem[]
  segments: Segment[]
  endInclusive: boolean
  onEndInclusive: (value: boolean) => void
  onEdit: (id: string, patch: MarkerPatch) => void
  onRemove: (id: string) => void
  onDuplicate: (item: MarkerItem) => void
  onAddPoint: () => void
  onAddRange: () => void
  defaultTarget: FrameFormat
}) {
  const pending = useMemo(() => markers.filter((item) => needsDateDecision(item)).length, [markers])
  const outside = useMemo(() => {
    return markers.filter((item) => {
      if (segments.length === 0) return false
      const checks =
        item.kind === 'range'
          ? checkRangeAgainstSegments(item.startFrame, item.outFrame, item.format, segments)
          : checkPointAgainstSegments(item.startFrame, item.format, segments)
      if (checks.length === 0) return false
      const comparableChecks = checks.filter(
        (check) => check.status !== 'format-mismatch' && check.status !== 'invalid',
      )
      if (comparableChecks.length === 0) return false
      return !comparableChecks.some((check) => check.status === 'inside' || check.status === 'partial')
    })
  }, [markers, segments])
  return (
    <Panel
      id="markers"
      eyebrow="03 · 标记"
      title="标记列表与素材段校验"
      subtitle={
        <>
          当前末端规则：
          <strong>{endInclusive ? '包含末端（出点这一帧算在区间内）' : '不包含末端（出点是区间结束后的边界）'}</strong>
          。界面显示、帧数计算与 CSV 导出使用同一规则。
        </>
      }
      actions={
        <div className="panel-action-row">
          <Toggle checked={endInclusive} onChange={onEndInclusive} label="区间末端包含" hint="帧数与导出同步变化" />
          <button type="button" onClick={onAddRange}>
            新增区间
          </button>
          <button type="button" className="btn-primary" onClick={onAddPoint}>
            新增点标记
          </button>
        </div>
      }
    >
      {(pending > 0 || outside.length > 0) && (
        <div className="marker-alerts">
          {outside.length > 0 && (
            <InlineNote tone="error">
              {outside.length} 个标记不落在任何素材段内：{outside.map((item) => item.name).join('、')}
            </InlineNote>
          )}
          {pending > 0 && (
            <InlineNote tone="warn">
              {pending} 个标记的日期归属待定（单独出现、无法确定属于哪一天），请在对应卡片中选择。
            </InlineNote>
          )}
        </div>
      )}

      {markers.length === 0 ? (
        <Empty>还没有标记。可以在“单点互查”里把当前帧加为标记，或从 CSV 导入。</Empty>
      ) : (
        <div className="marker-list">
          {markers.map((item, index) => (
            <MarkerCard
              key={item.id}
              item={item}
              index={index}
              segments={segments}
              endInclusive={endInclusive}
              defaultTarget={defaultTarget}
              onEdit={onEdit}
              onRemove={onRemove}
              onDuplicate={onDuplicate}
            />
          ))}
        </div>
      )}

      {segments.length > 0 && (
        <p className="muted small">
          标记只在格式完全一致的素材段内校验帧号；29.97 的跳号（DF）与不跳号（NDF）被视为不同格式。
          {[...new Set(markers.map((item) => formatLabel(item.format)))].length > 0 && (
            <> 当前标记格式：{[...new Set(markers.map((item) => formatLabel(item.format)))].join(' / ')}。</>
          )}
        </p>
      )}
    </Panel>
  )
}
