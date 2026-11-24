import { useMemo, useState } from 'react'
import {
  formatLabel,
  formatShortLabel,
  frameDurationSeconds,
  frameToTimecodeWithDay,
  makeFormat,
  parseTimecodeWithDay,
  type FrameFormat,
} from '../lib/timecode'
import {
  createId,
  segmentGeometry,
  type MarkerItem,
  type Segment,
} from '../lib/items'
import { Badge, Empty, InlineNote, Panel } from './ui'
import { FormatPicker } from './QueryPanel'

interface SegmentDraft {
  name: string
  format: FrameFormat
  startTc: string
  frameCount: string
  note: string
}

const emptyDraft = (format: FrameFormat): SegmentDraft => ({
  name: '',
  format,
  startTc: '',
  frameCount: '',
  note: '',
})

function SegmentRow({
  segment,
  markerCount,
  onRemove,
  onEdit,
  onUse,
}: {
  segment: Segment
  markerCount: number
  onRemove: (id: string) => void
  onEdit: (id: string, patch: Partial<Segment>) => void
  onUse: (segment: Segment) => void
}) {
  const geometry = segmentGeometry(segment)
  const [nameDraft, setNameDraft] = useState(segment.name)
  const [startDraft, setStartDraft] = useState(frameToTimecodeWithDay(segment.startFrame, segment.format))
  const [countDraft, setCountDraft] = useState(String(segment.frameCount))
  const startParsed = parseTimecodeWithDay(startDraft, segment.format)
  const countValue = Number(countDraft.replace(/,/g, ''))
  const countValid = Number.isInteger(countValue) && countValue > 0

  return (
    <div className="segment-row">
      <div className="segment-head">
        <input
          className="inline-input name-input"
          value={nameDraft}
          aria-label="素材名称"
          onChange={(event) => {
            setNameDraft(event.target.value)
            onEdit(segment.id, { name: event.target.value })
          }}
        />
        <Badge tone="info">{formatShortLabel(segment.format)}</Badge>
        <Badge tone={markerCount > 0 ? 'ok' : 'neutral'}>{markerCount} 个标记落入</Badge>
      </div>
      <div className="segment-meta mono small">
        <span>
          {geometry.startTc} → {geometry.endTc}
        </span>
        <span className="muted">
          {segment.frameCount.toLocaleString('en-US')} 帧 · {(geometry.durationSeconds / 60).toFixed(3)} 分
        </span>
        <span className="muted">末端边界 {geometry.endExclusiveTc}</span>
      </div>
      <div className="segment-controls">
        <label className="mini-field">
          <span>起始时码（可加 +1d）</span>
          <input
            className={`mono ${startParsed.ok ? '' : 'is-invalid'}`}
            value={startDraft}
            onChange={(event) => {
              setStartDraft(event.target.value)
              const parsed = parseTimecodeWithDay(event.target.value, segment.format)
              if (parsed.ok) onEdit(segment.id, { startFrame: parsed.absoluteFrame })
            }}
            spellCheck={false}
          />
        </label>
        <label className="mini-field">
          <span>实际帧数</span>
          <input
            className={`mono ${countValid ? '' : 'is-invalid'}`}
            inputMode="numeric"
            value={countDraft}
            onChange={(event) => {
              setCountDraft(event.target.value)
              const value = Number(event.target.value.replace(/,/g, ''))
              if (Number.isInteger(value) && value > 0) onEdit(segment.id, { frameCount: value })
            }}
          />
        </label>
        <label className="mini-field grow">
          <span>备注</span>
          <input
            value={segment.note}
            onChange={(event) => onEdit(segment.id, { note: event.target.value })}
            placeholder="磁带号、场次、交接说明"
          />
        </label>
        <div className="segment-buttons">
          <button type="button" onClick={() => onUse(segment)} title="把单点互查定位到这一段">
            定位
          </button>
          <button type="button" className="btn-danger" onClick={() => onRemove(segment.id)}>
            删除
          </button>
        </div>
      </div>
      {(!startParsed.ok || !countValid) && (
        <InlineNote tone="error">
          {!startParsed.ok ? startParsed.error.message : '实际帧数必须是正整数'}
        </InlineNote>
      )}
    </div>
  )
}

export default function SegmentPanel({
  segments,
  markers,
  defaultFormat,
  onAdd,
  onRemove,
  onEdit,
  onSeek,
}: {
  segments: Segment[]
  markers: MarkerItem[]
  defaultFormat: FrameFormat
  onAdd: (segment: Segment) => void
  onRemove: (id: string) => void
  onEdit: (id: string, patch: Partial<Segment>) => void
  onSeek: (frame: number, format: FrameFormat) => void
}) {
  const [draft, setDraft] = useState<SegmentDraft>(() => emptyDraft(defaultFormat))
  const [error, setError] = useState<string | null>(null)

  const parsedStart = useMemo(() => parseTimecodeWithDay(draft.startTc, draft.format), [draft.startTc, draft.format])
  const frameCountValue = Number(draft.frameCount.replace(/,/g, ''))
  const frameCountValid = Number.isInteger(frameCountValue) && frameCountValue > 0

  const markerCountBySegment = useMemo(() => {
    const map = new Map<string, number>()
    for (const segment of segments) {
      const geometry = segmentGeometry(segment)
      let count = 0
      for (const marker of markers) {
        if (marker.format.rate !== segment.format.rate || marker.format.dropFrame !== segment.format.dropFrame) continue
        const out = marker.kind === 'range' ? marker.outFrame : marker.startFrame
        if (marker.startFrame >= geometry.startAbsolute && out <= geometry.endAbsolute) count += 1
      }
      map.set(segment.id, count)
    }
    return map
  }, [segments, markers])

  const submit = () => {
    setError(null)
    if (!draft.startTc.trim()) {
      setError('请填写起始时码')
      return
    }
    if (!parsedStart.ok) {
      setError(parsedStart.error.message)
      return
    }
    if (!frameCountValid) {
      setError('实际帧数必须是正整数')
      return
    }
    onAdd({
      id: createId('seg'),
      name: draft.name.trim() || `素材 ${segments.length + 1}`,
      format: draft.format,
      startFrame: parsedStart.absoluteFrame,
      frameCount: frameCountValue,
      note: draft.note,
    })
    setDraft(emptyDraft(draft.format))
  }

  return (
    <Panel
      id="segments"
      eyebrow="02 · 素材段"
      title="每段素材的起始时码与实际帧数"
      subtitle="标记的绝对时码落不到任何素材段内时，标记列表会明确标出；格式不同的段之间不做帧号比较。"
      actions={<Badge tone="neutral">{segments.length} 段</Badge>}
    >
      {segments.length === 0 ? (
        <Empty>还没有素材段。先添加一段，或在“导入导出与核验”里载入项目自带数据。</Empty>
      ) : (
        <div className="segment-list">
          {segments.map((segment) => (
            <SegmentRow
              key={segment.id}
              segment={segment}
              markerCount={markerCountBySegment.get(segment.id) ?? 0}
              onRemove={onRemove}
              onEdit={onEdit}
              onUse={(value) => onSeek(value.startFrame, value.format)}
            />
          ))}
        </div>
      )}

      <div className="draft-card">
        <h3>新增素材段</h3>
        <div className="draft-grid">
          <label className="mini-field">
            <span>名称</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如 A001 采访"
            />
          </label>
          <label className="mini-field">
            <span>起始时码（可加 +1d）</span>
            <input
              className={`mono ${draft.startTc && !parsedStart.ok ? 'is-invalid' : ''}`}
              value={draft.startTc}
              onChange={(event) => setDraft({ ...draft, startTc: event.target.value })}
              placeholder="00:59:50;00"
              spellCheck={false}
            />
          </label>
          <label className="mini-field">
            <span>实际帧数</span>
            <input
              className={`mono ${draft.frameCount && !frameCountValid ? 'is-invalid' : ''}`}
              inputMode="numeric"
              value={draft.frameCount}
              onChange={(event) => setDraft({ ...draft, frameCount: event.target.value })}
              placeholder="9000"
            />
          </label>
        </div>
        <FormatPicker
          format={draft.format}
          onRate={(rate) => setDraft({ ...draft, format: makeFormat(rate, draft.format.dropFrame) })}
          onDrop={(dropFrame) => setDraft({ ...draft, format: makeFormat(draft.format.rate, dropFrame) })}
          compact
        />
        {draft.startTc && !parsedStart.ok && <InlineNote tone="error">{parsedStart.error.message}</InlineNote>}
        {parsedStart.ok && frameCountValid && (
          <p className="muted small">
            预览：{formatLabel(draft.format)} · {frameToTimecodeWithDay(parsedStart.absoluteFrame, draft.format)} →{' '}
            {frameToTimecodeWithDay(parsedStart.absoluteFrame + frameCountValue - 1, draft.format)} ·{' '}
            {(frameCountValue * frameDurationSeconds(draft.format)).toFixed(3)} s（{(frameCountValue * frameDurationSeconds(draft.format) / 60).toFixed(3)} 分）
          </p>
        )}
        {error && <InlineNote tone="error">{error}</InlineNote>}
        <div className="draft-actions">
          <button type="button" className="btn-primary" onClick={submit}>
            添加素材段
          </button>
          <button type="button" onClick={() => setDraft(emptyDraft(draft.format))}>
            清空
          </button>
        </div>
      </div>

      {segments.length > 0 && (
        <div className="muted small segment-footnote">
          <p>
            时长按真实帧率计算：25 → 40.000 ms/帧；29.97 → {(1001 / 30).toFixed(3)} ms/帧；59.94 →{' '}
            {(1001 / 60).toFixed(3)} ms/帧。段末“末端边界”是最后一帧之后的下一帧，与区间末端包含开关无关。
          </p>
          <p>
            当前共 {markers.length} 个标记，其中 {[...markerCountBySegment.values()].reduce((sum, value) => sum + value, 0)}{' '}
            个完全落在某个素材段内。
          </p>
        </div>
      )}
    </Panel>
  )
}
