import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RATES,
  actualFps,
  formatClockSeconds,
  formatLabel,
  formatSecondsValue,
  formatShortLabel,
  formatSignedSeconds,
  frameDurationSeconds,
  frameToLabelDriftSeconds,
  frameToParts,
  frameToRealSeconds,
  frameToTimecodeWithDay,
  framesPerDay,
  nominalFps,
  parseClockSeconds,
  parseTimecodeWithDay,
  realSecondsToFrameExact,
  splitAbsoluteFrame,
  type FrameFormat,
  type RateId,
} from '../lib/timecode'
import { Badge, InlineNote, Panel, Stat } from './ui'

type Direction = 'frame' | 'timecode' | 'seconds'

const RATE_CHOICES: { id: RateId; title: string; note: string }[] = [
  { id: '25', title: '25', note: 'PAL / 25p，无跳号' },
  { id: '2997', title: '29.97', note: '30000/1001，可跳号' },
  { id: '5994', title: '59.94', note: '60000/1001，可跳号' },
]

export function FormatPicker({
  format,
  onRate,
  onDrop,
  compact = false,
}: {
  format: FrameFormat
  onRate: (rate: RateId) => void
  onDrop: (drop: boolean) => void
  compact?: boolean
}) {
  const supportsDrop = RATES[format.rate].dropFrames > 0
  return (
    <div className={`format-picker ${compact ? 'is-compact' : ''}`}>
      <div className="format-row">
        <div className="segmented" role="radiogroup" aria-label="帧率">
          {RATE_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={format.rate === choice.id}
              className={format.rate === choice.id ? 'is-active' : ''}
              onClick={() => onRate(choice.id)}
              title={choice.note}
            >
              <strong>{choice.title}</strong>
              {!compact && <small>{choice.note}</small>}
            </button>
          ))}
        </div>
        <div className="segmented segmented-compact" role="radiogroup" aria-label="跳号标记">
          <button
            type="button"
            role="radio"
            aria-checked={format.dropFrame}
            className={format.dropFrame ? 'is-active' : ''}
            disabled={!supportsDrop}
            onClick={() => onDrop(true)}
            title={supportsDrop ? '时码帧号用分号分隔，按规范跳过编号' : '该帧率没有跳号规则'}
          >
            跳号 DF
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={!format.dropFrame}
            className={!format.dropFrame ? 'is-active' : ''}
            onClick={() => onDrop(false)}
            title="时码帧号用冒号分隔，编号连续不跳"
          >
            不跳号 NDF
          </button>
        </div>
      </div>
      <p className="format-caption">
        实际 <span className="mono">{actualFps(format).toFixed(6)}</span> fps · 标称{' '}
        <span className="mono">{nominalFps(format)}</span> fps · 帧长{' '}
        <span className="mono">{(frameDurationSeconds(format) * 1000).toFixed(3)}</span> ms
        {supportsDrop && format.dropFrame && (
          <>
            {' '}
            · 每分钟跳 <span className="mono">{RATES[format.rate].dropFrames}</span> 个编号（整十分钟与整点除外）
          </>
        )}
      </p>
    </div>
  )
}

export function FrameScale({
  format,
  frame,
  onSeek,
}: {
  format: FrameFormat
  frame: number
  onSeek: (frame: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const perDay = framesPerDay(format)
  const { day, frameInDay } = splitAbsoluteFrame(frame, format)
  const ticks = useMemo(
    () =>
      Array.from({ length: 25 }, (_, hour) => ({
        ratio: hour / 24,
        label: String(hour).padStart(2, '0'),
      })),
    [],
  )

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)))
      const nextInDay = Math.round(ratio * (perDay - 1))
      onSeek(day * perDay + nextInDay)
    },
    [day, onSeek, perDay],
  )

  const ratio = frameInDay / Math.max(1, perDay - 1)

  return (
    <div className="frame-scale">
      <div className="frame-scale-head">
        <div>
          <span className="eyebrow">可拖动帧尺</span>
          <p className="muted small">
            拖动手柄或点击轨道定位；方向键 ±1 帧，Shift + 方向键 ±1 秒，PageUp / PageDown 跳 1 秒，Home 回当天零点。
          </p>
        </div>
        <span className="mono small">
          第 {day} 天 · 日内帧 {frameInDay.toLocaleString('en-US')}
        </span>
      </div>
      <div
        className={`scale-track ${dragging ? 'is-dragging' : ''}`}
        ref={trackRef}
        role="slider"
        aria-label="帧位置"
        aria-valuemin={0}
        aria-valuemax={perDay - 1}
        aria-valuenow={frameInDay}
        aria-valuetext={frameToTimecodeWithDay(frame, format)}
        tabIndex={0}
        onPointerDown={(event) => {
          setDragging(true)
          event.currentTarget.setPointerCapture(event.pointerId)
          seekFromClientX(event.clientX)
        }}
        onPointerMove={(event) => {
          if (dragging) seekFromClientX(event.clientX)
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            onSeek(Math.max(0, frame - (event.shiftKey ? nominalFps(format) : 1)))
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            onSeek(frame + (event.shiftKey ? nominalFps(format) : 1))
          } else if (event.key === 'PageUp') {
            event.preventDefault()
            onSeek(frame + nominalFps(format))
          } else if (event.key === 'PageDown') {
            event.preventDefault()
            onSeek(Math.max(0, frame - nominalFps(format)))
          } else if (event.key === 'Home') {
            event.preventDefault()
            onSeek(day * perDay)
          }
        }}
      >
        <div className="scale-grid">
          {ticks.map((tick) => (
            <div key={tick.label} className="scale-tick" style={{ left: `${tick.ratio * 100}%` }}>
              <span>{tick.label}</span>
            </div>
          ))}
        </div>
        <div className="scale-fill" style={{ width: `${Math.min(1, Math.max(0, ratio)) * 100}%` }} />
        <div className="scale-thumb" style={{ left: `${Math.min(1, Math.max(0, ratio)) * 100}%` }}>
          <span className="mono">{frameToTimecodeWithDay(frame, format)}</span>
        </div>
      </div>
      <div className="scale-range mono small">
        <span>00:00</span>
        <span>12:00</span>
        <span>24:00</span>
      </div>
    </div>
  )
}

export default function QueryPanel({
  format,
  onRate,
  onDrop,
  frame: globalFrame,
  onFrame,
  onAddMarker,
}: {
  format: FrameFormat
  onRate: (rate: RateId) => void
  onDrop: (drop: boolean) => void
  frame: number
  onFrame: (frame: number) => void
  onAddMarker: (frame: number, format: FrameFormat) => void
}) {
  const [direction, setDirection] = useState<Direction>('frame')
  const [frameText, setFrameText] = useState(String(globalFrame))
  const [tcText, setTcText] = useState(() => frameToTimecodeWithDay(globalFrame, format))
  const [secondsText, setSecondsText] = useState(() => frameToRealSeconds(globalFrame, format).toFixed(3))

  // 外部（帧尺、导入、其它面板）改变帧或格式时，把输入框同步到当前帧
  useEffect(() => {
    setFrameText(String(globalFrame))
    setTcText(frameToTimecodeWithDay(globalFrame, format))
    setSecondsText(frameToRealSeconds(globalFrame, format).toFixed(3))
  }, [globalFrame, format])

  const parsedFrame = /^\d+$/.test(frameText.trim().replace(/,/g, ''))
    ? Number(frameText.trim().replace(/,/g, ''))
    : null
  const frameValid = parsedFrame !== null && Number.isSafeInteger(parsedFrame)

  const tcParsed = useMemo(() => parseTimecodeWithDay(tcText, format), [tcText, format])
  const secondsValue = useMemo(() => parseClockSeconds(secondsText), [secondsText])
  const secondsExact = secondsValue === null ? null : realSecondsToFrameExact(secondsValue, format)
  const secondsRounded = secondsExact === null ? null : Math.round(secondsExact)

  // 当前输入方向的有效结果；无效时退回全局帧，保证下方数据始终有意义
  const resolvedFrame =
    direction === 'frame' && frameValid
      ? parsedFrame!
      : direction === 'timecode' && tcParsed.ok
        ? tcParsed.absoluteFrame
        : direction === 'seconds' && secondsRounded !== null
          ? secondsRounded
          : globalFrame

  const effectiveFrame = Math.max(0, resolvedFrame)
  const activeValid =
    direction === 'frame' ? frameValid : direction === 'timecode' ? tcParsed.ok : secondsRounded !== null
  const parts = frameToParts(effectiveFrame, format)
  const startOfDay = splitAbsoluteFrame(effectiveFrame, format)
  const realSeconds = frameToRealSeconds(effectiveFrame, format)
  const driftSeconds = frameToLabelDriftSeconds(effectiveFrame, format)

  const commit = (value: number) => {
    const next = Math.max(0, Math.round(value))
    setFrameText(String(next))
    setTcText(frameToTimecodeWithDay(next, format))
    setSecondsText(frameToRealSeconds(next, format).toFixed(3))
    onFrame(next)
  }

  return (
    <Panel
      id="query"
      eyebrow="01 · 单点互查"
      title="帧序号 ↔ 实际媒体时间 ↔ 时码"
      subtitle="三个方向共用同一帧率设置；任一方向得到有效结果后，另外两种表示会同步给出。"
      actions={<Badge tone="accent">{formatLabel(format)}</Badge>}
    >
      <FormatPicker format={format} onRate={onRate} onDrop={onDrop} />

      <div className="segmented segmented-tabs" role="tablist" aria-label="输入方式">
        {(
          [
            ['frame', '帧序号'],
            ['timecode', '时码'],
            ['seconds', '实际秒数'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={direction === id}
            className={direction === id ? 'is-active' : ''}
            onClick={() => setDirection(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {direction === 'frame' && (
        <div className="field-row">
          <label className="field">
            <span>帧序号（从 0 开始，可超过一天）</span>
            <input
              className={`mono ${frameValid ? '' : 'is-invalid'}`}
              inputMode="numeric"
              value={frameText}
              onChange={(event) => setFrameText(event.target.value)}
              placeholder="例如 1800"
            />
          </label>
          <div className="field-actions">
            <button type="button" onClick={() => commit(effectiveFrame - 1)}>
              −1 帧
            </button>
            <button type="button" onClick={() => commit(effectiveFrame + 1)}>
              +1 帧
            </button>
            <button type="button" onClick={() => commit(effectiveFrame - nominalFps(format))}>
              −1 秒
            </button>
            <button type="button" onClick={() => commit(0)}>
              归零
            </button>
          </div>
        </div>
      )}
      {direction === 'frame' && !frameValid && <InlineNote tone="error">帧序号必须是非负整数。</InlineNote>}

      {direction === 'timecode' && (
        <div className="field-row">
          <label className="field">
            <span>时码（HH:MM:SS:FF 不跳号，或 HH:MM:SS;FF 跳号；可加 “+1d”）</span>
            <input
              className={`mono ${tcParsed.ok ? '' : 'is-invalid'}`}
              value={tcText}
              onChange={(event) => setTcText(event.target.value)}
              placeholder="00:01:00;02"
              spellCheck={false}
            />
          </label>
          <div className="field-actions">
            <button
              type="button"
              disabled={!tcParsed.ok}
              onClick={() => tcParsed.ok && commit(tcParsed.absoluteFrame)}
            >
              采用该时码
            </button>
          </div>
        </div>
      )}
      {direction === 'timecode' && !tcParsed.ok && <InlineNote tone="error">{tcParsed.error.message}</InlineNote>}
      {direction === 'timecode' && tcParsed.ok && tcParsed.warnings.length > 0 && (
        <InlineNote tone="warn">
          {tcParsed.warnings.map((warning) => (
            <div key={warning.code}>{warning.message}</div>
          ))}
        </InlineNote>
      )}

      {direction === 'seconds' && (
        <div className="field-row">
          <label className="field">
            <span>实际经过秒数（可写 90.5 或 00:01:30.500）</span>
            <input
              className={`mono ${secondsValue === null ? 'is-invalid' : ''}`}
              value={secondsText}
              onChange={(event) => setSecondsText(event.target.value)}
              placeholder="60.060"
              spellCheck={false}
            />
          </label>
          <div className="field-actions">
            <button
              type="button"
              disabled={secondsRounded === null}
              onClick={() => secondsRounded !== null && commit(secondsRounded)}
            >
              取整为帧并采用
            </button>
          </div>
        </div>
      )}
      {direction === 'seconds' && secondsValue !== null && secondsExact !== null && secondsRounded !== null && (
        <InlineNote tone={Math.abs(secondsExact - secondsRounded) > 1e-9 ? 'warn' : 'ok'}>
          精确帧位置 <span className="mono">{secondsExact.toFixed(6)}</span> → 取整帧{' '}
          <span className="mono">{secondsRounded}</span>
          {Math.abs(secondsExact - secondsRounded) > 1e-9 && (
            <>
              （差 <span className="mono">{(secondsExact - secondsRounded).toFixed(6)}</span> 帧，约{' '}
              <span className="mono">
                {Math.abs((secondsExact - secondsRounded) * frameDurationSeconds(format) * 1000).toFixed(3)}
              </span>{' '}
              ms）
            </>
          )}
        </InlineNote>
      )}

      <div className="stat-grid">
        <Stat label="时码" value={frameToTimecodeWithDay(effectiveFrame, format)} hint={formatShortLabel(format)} />
        <Stat
          label="帧序号"
          value={effectiveFrame.toLocaleString('en-US')}
          hint={`第 ${startOfDay.day} 天 · 日内 ${startOfDay.frameInDay.toLocaleString('en-US')}`}
        />
        <Stat label="实际媒体时间" value={formatClockSeconds(realSeconds)} hint={`${realSeconds.toFixed(6)} s`} />
        <Stat
          label="读数 − 实际"
          value={formatSignedSeconds(driftSeconds)}
          hint="正数表示读数跑快；DF 以分钟为周期摆动，NDF 会持续累积"
          tone={Math.abs(driftSeconds) < 0.1 ? 'ok' : 'warn'}
        />
      </div>

      <div className="detail-grid">
        <div>
          <h3>字段拆解</h3>
          <dl className="kv">
            <dt>时 / 分 / 秒 / 帧</dt>
            <dd className="mono">
              {parts.hours} / {parts.minutes} / {parts.seconds} / {parts.frames}
            </dd>
            <dt>日内帧号</dt>
            <dd className="mono">{startOfDay.frameInDay.toLocaleString('en-US')}</dd>
            <dt>实际秒数</dt>
            <dd className="mono">{formatSecondsValue(realSeconds, 6)}</dd>
            <dt>单帧时长</dt>
            <dd className="mono">{(frameDurationSeconds(format) * 1000).toFixed(3)} ms</dd>
            <dt>一天帧数</dt>
            <dd className="mono">{framesPerDay(format).toLocaleString('en-US')}</dd>
          </dl>
        </div>
        <div>
          <h3>相邻帧</h3>
          <dl className="kv">
            <dt>上一帧</dt>
            <dd className="mono">{frameToTimecodeWithDay(Math.max(0, effectiveFrame - 1), format)}</dd>
            <dt>当前</dt>
            <dd className="mono strong">{frameToTimecodeWithDay(effectiveFrame, format)}</dd>
            <dt>下一帧</dt>
            <dd className="mono">{frameToTimecodeWithDay(effectiveFrame + 1, format)}</dd>
            <dt>每帧真实增量</dt>
            <dd className="mono">{(frameDurationSeconds(format) * 1000).toFixed(3)} ms</dd>
            <dt>时码读数</dt>
            <dd className="mono">{formatClockSeconds(realSeconds + driftSeconds)}</dd>
          </dl>
          {format.dropFrame && (
            <p className="muted small">
              跳号格式的秒由 {nominalFps(format)} 个编号组成，真实帧率是 {actualFps(format).toFixed(6)}。
              差额靠每十分钟少跳一次、整点（60 分属于整十分钟）不跳来补齐。
            </p>
          )}
        </div>
      </div>

      <FrameScale format={format} frame={effectiveFrame} onSeek={commit} />

      <div className="query-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={!activeValid}
          onClick={() => onAddMarker(effectiveFrame, format)}
        >
          把当前帧加为标记
        </button>
        <span className="muted small">标记会带上当前格式；可在“标记”面板继续调整日期归属与区间。</span>
      </div>
    </Panel>
  )
}
