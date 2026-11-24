import { useMemo, useState } from 'react'
import {
  RATES,
  formatLabel,
  formatSignedSeconds,
  frameDurationSeconds,
  frameToTimecodeWithDay,
  makeFormat,
  type FrameFormat,
  type RateId,
} from '../lib/timecode'
import { convertModeLabel, convertPoint, convertRange, type ConvertMode } from '../lib/convert'
import { itemFrameCount, type MarkerItem } from '../lib/items'
import { Badge, Empty, InlineNote, Panel, Stat, Toggle } from './ui'

const RATE_TITLES: Record<RateId, string> = {
  '25': '25',
  '2997': '29.97',
  '5994': '59.94',
}

function TargetFormatPicker({ value, onChange }: { value: FrameFormat; onChange: (next: FrameFormat) => void }) {
  return (
    <div className="target-format">
      <div className="segmented segmented-compact" role="radiogroup" aria-label="目标帧率">
        {(['25', '2997', '5994'] as RateId[]).map((rate) => (
          <button
            key={rate}
            type="button"
            role="radio"
            aria-checked={value.rate === rate}
            className={value.rate === rate ? 'is-active' : ''}
            onClick={() => onChange(makeFormat(rate, value.dropFrame))}
          >
            {RATE_TITLES[rate]}
          </button>
        ))}
      </div>
      <div className="segmented segmented-compact" role="radiogroup" aria-label="目标跳号标记">
        <button
          type="button"
          role="radio"
          aria-checked={value.dropFrame}
          disabled={!RATES[value.rate].dropFrames}
          className={value.dropFrame ? 'is-active' : ''}
          onClick={() => onChange(makeFormat(value.rate, true))}
        >
          DF
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!value.dropFrame}
          className={!value.dropFrame ? 'is-active' : ''}
          onClick={() => onChange(makeFormat(value.rate, false))}
        >
          NDF
        </button>
      </div>
    </div>
  )
}

export default function ConversionPanel({
  markers,
  endInclusive,
  onEndInclusive,
  onApply,
}: {
  markers: MarkerItem[]
  endInclusive: boolean
  onEndInclusive: (value: boolean) => void
  onApply: (markers: MarkerItem[], target: FrameFormat, mode: ConvertMode) => void
}) {
  const [sourceFormat, setSourceFormat] = useState<FrameFormat>(() => makeFormat('2997', true))
  const [targetFormat, setTargetFormat] = useState<FrameFormat>(() => makeFormat('25', false))
  const [mode, setMode] = useState<ConvertMode>('real')

  const sourceMarkers = useMemo(
    () => markers.filter((item) => item.format.rate === sourceFormat.rate && item.format.dropFrame === sourceFormat.dropFrame),
    [markers, sourceFormat],
  )

  const converted = useMemo(
    () => sourceMarkers.map((item) => convertRange(item, item.format, targetFormat, mode, endInclusive)),
    [sourceMarkers, targetFormat, mode, endInclusive],
  )

  const roundingDeltas = converted.flatMap((entry, index) =>
    sourceMarkers[index]!.kind === 'range'
      ? [Math.abs(entry.start.roundingFrames), Math.abs(entry.out.roundingFrames)]
      : [Math.abs(entry.start.roundingFrames)],
  )
  const totalRounding = roundingDeltas.reduce((sum, value) => sum + value, 0)
  const maxRounding = roundingDeltas.reduce((max, value) => Math.max(max, value), 0)
  const countChanged = converted.filter((entry) => entry.countDelta !== 0).length
  const flipped = converted.filter((entry) => entry.out.frame < entry.start.frame).length

  const apply = () => {
    const byId = new Map(sourceMarkers.map((item) => [item.id, item]))
    const next: MarkerItem[] = markers.map((item) => {
      const source = byId.get(item.id)
      if (!source) return item
      const result = convertRange(source, source.format, targetFormat, mode, endInclusive)
      if (item.kind === 'marker') {
        return { ...item, format: targetFormat, startFrame: result.start.frame }
      }
      return { ...item, format: targetFormat, startFrame: result.start.frame, outFrame: result.out.frame }
    })
    onApply(next, targetFormat, mode)
  }

  return (
    <Panel
      id="conversion"
      eyebrow="05 · 帧率换算"
      title="更换目标帧率：保留真实时间或保留帧号"
      subtitle="两种方式都会显示端点取整差异；区间末端是否包含在界面与导出里使用同一开关。"
      actions={<Badge tone="accent">{mode === 'real' ? '保留真实经过时间' : '保留原帧序号'}</Badge>}
    >
      <div className="conversion-settings">
        <div>
          <span className="eyebrow">源格式</span>
          <TargetFormatPicker value={sourceFormat} onChange={setSourceFormat} />
          <p className="muted small">
            源格式下有 {sourceMarkers.length} 个标记可换算（格式必须完全一致，DF 与 NDF 视为不同格式）。
          </p>
        </div>
        <div className="conversion-arrow" aria-hidden="true">
          →
        </div>
        <div>
          <span className="eyebrow">目标格式</span>
          <TargetFormatPicker value={targetFormat} onChange={setTargetFormat} />
          <p className="muted small">
            {formatLabel(sourceFormat)} → {formatLabel(targetFormat)}
          </p>
        </div>
      </div>

      <div className="mode-switch">
        {(['real', 'frame'] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            className={`mode-card ${mode === entry ? 'is-active' : ''}`}
            onClick={() => setMode(entry)}
            aria-pressed={mode === entry}
          >
            <strong>{convertModeLabel(entry)}</strong>
            <span>
              {entry === 'real'
                ? '按源格式的真实经过时间换算到目标帧率，端点四舍五入到最近帧，可能改变帧数。'
                : '帧号一一对应地搬到目标格式，真实经过时间会随帧率改变，不会出现取整差。'}
            </span>
          </button>
        ))}
      </div>

      <div className="toggle-row">
        <Toggle checked={endInclusive} onChange={onEndInclusive} label="区间末端包含" hint="界面、换算与 CSV 导出同步" />
        <span className="muted small">
          当前规则：{endInclusive ? '出点这一帧算在区间内' : '出点是区间结束后的边界，不算在区间内'}
        </span>
      </div>

      <div className="stat-grid">
        <Stat
          label="端点最大取整差"
          value={`${maxRounding.toFixed(4)} 帧`}
          hint={`约 ${(maxRounding * frameDurationSeconds(targetFormat) * 1000).toFixed(3)} ms`}
          tone={maxRounding > 1e-9 ? 'warn' : 'ok'}
        />
        <Stat label="取整差合计" value={`${totalRounding.toFixed(4)} 帧`} hint={`${converted.length} 个标记`} />
        <Stat
          label="帧数变化"
          value={`${countChanged} / ${converted.length}`}
          hint={endInclusive ? '末端按包含计数' : '末端按不包含计数'}
          tone={countChanged > 0 ? 'warn' : 'ok'}
        />
        <Stat
          label="区间翻转"
          value={String(flipped)}
          hint={flipped > 0 ? '换算后出点早于入点，需要人工修正' : '顺序正常'}
          tone={flipped > 0 ? 'error' : 'ok'}
        />
      </div>

      {sourceMarkers.length === 0 ? (
        <Empty>没有与源格式匹配的标记。可以回到“标记”面板修改格式，或先导入数据。</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>标记</th>
                <th>源时码</th>
                <th>目标时码</th>
                <th>取整差</th>
                <th>真实时间变化</th>
                <th>帧数</th>
              </tr>
            </thead>
            <tbody>
              {sourceMarkers.map((item, index) => {
                const result = converted[index]!
                const point = item.kind === 'marker' ? convertPoint(item.startFrame, item.format, targetFormat, mode) : result.start
                return (
                  <tr key={item.id}>
                    <td>
                      <span className="cell-title">{item.name}</span>
                      <span className="muted small">{item.kind === 'range' ? ' 区间' : ' 点'}</span>
                    </td>
                    <td className="mono">
                      {item.kind === 'range' ? (
                        <>
                          {frameToTimecodeWithDay(item.startFrame, item.format)}
                          <br />
                          <small>{frameToTimecodeWithDay(item.outFrame, item.format)}</small>
                        </>
                      ) : (
                        frameToTimecodeWithDay(item.startFrame, item.format)
                      )}
                    </td>
                    <td className="mono">
                      {item.kind === 'range' ? (
                        <>
                          {result.start.targetTc}
                          <br />
                          <small>{result.out.targetTc}</small>
                        </>
                      ) : (
                        point.targetTc
                      )}
                      <small className="muted"> · 帧 {point.frame}</small>
                    </td>
                    <td className="mono">
                      <span className={Math.abs(result.start.roundingFrames) > 1e-9 ? 'text-warn' : ''}>
                        {result.start.roundingFrames >= 0 ? '+' : ''}
                        {result.start.roundingFrames.toFixed(4)} 帧
                      </span>
                      {item.kind === 'range' && (
                        <>
                          <br />
                          <span className={Math.abs(result.out.roundingFrames) > 1e-9 ? 'text-warn' : ''}>
                            {result.out.roundingFrames >= 0 ? '+' : ''}
                            {result.out.roundingFrames.toFixed(4)} 帧
                          </span>
                        </>
                      )}
                    </td>
                    <td className="mono">
                      {formatSignedSeconds(result.start.realDeltaMs / 1000)}
                      {item.kind === 'range' && (
                        <>
                          <br />
                          <small>出点 {formatSignedSeconds(result.out.realDeltaMs / 1000)}</small>
                        </>
                      )}
                    </td>
                    <td className="mono">
                      {itemFrameCount(item, endInclusive)} → {result.targetFrameCount}
                      {result.countDelta !== 0 && (
                        <span className="text-warn small">
                          {' '}
                          （{result.countDelta > 0 ? '+' : ''}
                          {result.countDelta}）
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {converted.some((entry) => entry.warnings.length > 0) && (
        <div className="warnings">
          {[...new Set(converted.flatMap((entry) => entry.warnings))].map((warning) => (
            <InlineNote key={warning} tone="warn">
              {warning}
            </InlineNote>
          ))}
        </div>
      )}

      <div className="panel-footer">
        <button
          type="button"
          className="btn-primary"
          disabled={sourceMarkers.length === 0 || flipped > 0}
          onClick={apply}
          title={flipped > 0 ? '存在区间翻转，先修正后再应用' : '把换算结果写回全部匹配标记'}
        >
          将换算结果应用到 {sourceMarkers.length} 个标记
        </button>
        <span className="muted small">
          应用后标记格式变为 {formatLabel(targetFormat)}；不匹配源格式的标记保持不动。
        </span>
      </div>
    </Panel>
  )
}
