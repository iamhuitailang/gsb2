import { useCallback, useMemo, useState } from 'react'
import {
  createId,
  makePointMarker,
  type MarkerItem,
  type MarkerPatch,
  type Segment,
} from './lib/items'
import {
  formatKey,
  frameToTimecodeWithDay,
  makeFormat,
  splitAbsoluteFrame,
  type FrameFormat,
} from './lib/timecode'
import QueryPanel from './components/QueryPanel'
import SegmentPanel from './components/SegmentPanel'
import MarkersPanel from './components/MarkersPanel'
import BoundaryPanel from './components/BoundaryPanel'
import ConversionPanel from './components/ConversionPanel'
import ImportExportPanel from './components/ImportExportPanel'
import type { TestMarkerBundle } from './lib/testBundle'
import { convertModeLabel, type ConvertMode } from './lib/convert'
import './styles.css'

const NAV = [
  { href: '#query', label: '互查' },
  { href: '#segments', label: '素材段' },
  { href: '#markers', label: '标记' },
  { href: '#boundaries', label: '边界' },
  { href: '#conversion', label: '换算' },
  { href: '#io', label: '导入导出' },
]

export default function App() {
  const [format, setFormat] = useState<FrameFormat>(() => makeFormat('2997', true))
  const [currentFrame, setCurrentFrame] = useState(1800)
  const [markers, setMarkers] = useState<MarkerItem[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [endInclusive, setEndInclusive] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.setTimeout(() => {
      setToast((current) => (current === message ? null : current))
    }, 4200)
  }, [])

  const handleRate = useCallback((rate: FrameFormat['rate']) => {
    setFormat((prev) => makeFormat(rate, prev.dropFrame))
  }, [])
  const handleDrop = useCallback((dropFrame: boolean) => {
    setFormat((prev) => makeFormat(prev.rate, dropFrame))
  }, [])

  const addMarkerAt = useCallback(
    (frame: number, markerFormat: FrameFormat) => {
      const name = `标记 ${markers.length + 1} · ${frameToTimecodeWithDay(frame, markerFormat)}`
      const item = makePointMarker(frame, markerFormat, name, {
        dayExplicit: true,
        dateDecision: splitAbsoluteFrame(frame, markerFormat).day,
      })
      setMarkers((prev) => [...prev, item])
      showToast(`已新增点标记：${name}`)
    },
    [markers.length, showToast],
  )

  const editMarker = useCallback((id: string, patch: MarkerPatch) => {
    setMarkers((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item
        if (item.kind === 'marker') {
          const next = { ...item }
          if (patch.name !== undefined) next.name = patch.name
          if (patch.format !== undefined) next.format = patch.format
          if (patch.startFrame !== undefined) next.startFrame = patch.startFrame
          if (patch.dayExplicit !== undefined) next.dayExplicit = patch.dayExplicit
          if (patch.dateDecision !== undefined) next.dateDecision = patch.dateDecision
          if (patch.note !== undefined) next.note = patch.note
          return next
        }
        const next = { ...item }
        if (patch.name !== undefined) next.name = patch.name
        if (patch.format !== undefined) next.format = patch.format
        if (patch.startFrame !== undefined) next.startFrame = patch.startFrame
        if (patch.dayExplicit !== undefined) next.dayExplicit = patch.dayExplicit
        if (patch.dateDecision !== undefined) next.dateDecision = patch.dateDecision
        if (patch.note !== undefined) next.note = patch.note
        if (patch.outFrame !== undefined) next.outFrame = patch.outFrame
        return next
      }),
    )
  }, [])

  const removeMarker = useCallback((id: string) => {
    setMarkers((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const duplicateMarker = useCallback((item: MarkerItem) => {
    setMarkers((prev) => {
      const copy = { ...item, id: createId('marker'), name: `${item.name} 副本` }
      return [...prev, copy]
    })
  }, [])

  const addSegment = useCallback(
    (segment: Segment) => {
      setSegments((prev) => [...prev, segment])
      showToast(`已新增素材段：${segment.name}`)
    },
    [showToast],
  )

  const editSegment = useCallback((id: string, patch: Partial<Segment>) => {
    setSegments((prev) => prev.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment)))
  }, [])

  const removeSegment = useCallback((id: string) => {
    setSegments((prev) => prev.filter((segment) => segment.id !== id))
  }, [])

  const importMarkers = useCallback((items: MarkerItem[]) => {
    setMarkers(items)
    const first = items[0]
    if (first) {
      setCurrentFrame(first.startFrame)
      setFormat(first.format)
    }
  }, [])

  const loadTestBundle = useCallback((bundle: TestMarkerBundle) => {
    setSegments(bundle.segments)
    setMarkers(bundle.markers)
    setEndInclusive(bundle.endInclusive)
    const first = bundle.markers[0]
    if (first) {
      setCurrentFrame(first.startFrame)
      setFormat(first.format)
    }
  }, [])

  const applyConversion = useCallback(
    (next: MarkerItem[], target: FrameFormat, mode: ConvertMode) => {
      setMarkers(next)
      setFormat(target)
      showToast(
        `已按「${convertModeLabel(mode)}」换算 ${next.length} 个标记到 ${formatKey(target)}`,
      )
    },
    [showToast],
  )

  const seek = useCallback((frame: number, seekFormat: FrameFormat) => {
    setCurrentFrame(Math.max(0, frame))
    setFormat(seekFormat)
    document.getElementById('query')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const addPointFromCurrent = useCallback(() => {
    addMarkerAt(currentFrame, format)
  }, [addMarkerAt, currentFrame, format])

  const addRangeFromCurrent = useCallback(() => {
    const step = Math.round(format.rate === '25' ? 125 : format.rate === '2997' ? 150 : 300)
    const item: MarkerItem = {
      id: createId('marker'),
      name: `区间 ${markers.length + 1} · ${frameToTimecodeWithDay(currentFrame, format)}`,
      format,
      startFrame: currentFrame,
      outFrame: currentFrame + step,
      dayExplicit: true,
      dateDecision: splitAbsoluteFrame(currentFrame, format).day,
      note: '',
      kind: 'range',
    }
    setMarkers((prev) => [...prev, item])
    showToast('已新增 5 秒区间（帧数按当前末端规则计算）')
  }, [currentFrame, format, markers.length, showToast])

  const headerTc = useMemo(() => frameToTimecodeWithDay(currentFrame, format), [currentFrame, format])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            TC
          </span>
          <div>
            <h1>时码核对台</h1>
            <p>本地运行 · 帧序号 / 实际媒体时间 / 时码互查 · 29.97 与 59.94 跳号</p>
          </div>
        </div>
        <nav className="top-nav" aria-label="页面导航">
          {NAV.map((entry) => (
            <a key={entry.href} href={entry.href}>
              {entry.label}
            </a>
          ))}
        </nav>
        <div className="header-meta">
          <span className="mono small">{headerTc}</span>
          <span className="mono small muted">{formatKey(format)}</span>
        </div>
      </header>

      <main>
        <div className="intro">
          <div>
            <h2>把交接记录里的两种时间对齐</h2>
            <p>
              一份记录写带帧号的时间码，另一份写播放器上的秒数。这里的计算全部在浏览器里完成：
              帧序号 ↔ 实际媒体时间 ↔ 时码三向互查；29.97 / 59.94 的跳号按规范在非整十分钟跳过编号，
              整十分钟与整点不跳；跨午夜时用绝对帧号保留先后顺序。
            </p>
          </div>
          <ul className="intro-points">
            <li>25p、29.97、59.94 的跳号 / 不跳号（DF / NDF）</li>
            <li>素材段起点 + 实际帧数；标记落段外时明确提示</li>
            <li>CSV 批量导入逐行定位问题，导出后可原样倒回</li>
            <li>换帧率时选择保留真实时间或保留帧号，并显示取整差</li>
          </ul>
        </div>

        <QueryPanel
          format={format}
          onRate={handleRate}
          onDrop={handleDrop}
          frame={currentFrame}
          onFrame={setCurrentFrame}
          onAddMarker={addMarkerAt}
        />

        <SegmentPanel
          segments={segments}
          markers={markers}
          defaultFormat={format}
          onAdd={addSegment}
          onRemove={removeSegment}
          onEdit={editSegment}
          onSeek={seek}
        />

        <MarkersPanel
          markers={markers}
          segments={segments}
          endInclusive={endInclusive}
          onEndInclusive={setEndInclusive}
          onEdit={editMarker}
          onRemove={removeMarker}
          onDuplicate={duplicateMarker}
          onAddPoint={addPointFromCurrent}
          onAddRange={addRangeFromCurrent}
          defaultTarget={format}
        />

        <BoundaryPanel />

        <ConversionPanel
          markers={markers}
          endInclusive={endInclusive}
          onEndInclusive={setEndInclusive}
          onApply={applyConversion}
        />

        <ImportExportPanel
          markers={markers}
          segments={segments}
          endInclusive={endInclusive}
          defaultFormat={format}
          onEndInclusive={setEndInclusive}
          onImport={importMarkers}
          onLoadTest={loadTestBundle}
          showToast={showToast}
        />
      </main>

      <footer className="app-footer">
        <span>时码核对台 · 纯本地运行，数据不会离开浏览器</span>
        <span className="mono small">29.97 = 30000/1001 · 59.94 = 60000/1001</span>
      </footer>

      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  )
}
