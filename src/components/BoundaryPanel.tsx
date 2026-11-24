import { useMemo, useState } from 'react'
import { boundaryRows, formatBoundaryDelta, type BoundaryRow } from '../lib/boundaries'
import { formatLabel, frameToRealSeconds, framesPerDay, makeFormat, type FrameFormat } from '../lib/timecode'
import { Badge, Empty, InlineNote, Panel, Toggle } from './ui'

function BoundaryCard({ row, format }: { row: BoundaryRow; format: FrameFormat }) {
  return (
    <article className="boundary-card">
      <header className="boundary-head">
        <div>
          <h3>{row.title}</h3>
          <p className="muted small">{row.hint}</p>
        </div>
        <div className="boundary-badges">
          <Badge tone="neutral">{formatLabel(format)}</Badge>
          {row.compliant === true && <Badge tone="ok">符合规范</Badge>}
          {row.compliant === false && <Badge tone="error">与规范不符</Badge>}
          {row.compliant === null && <Badge tone="info">不跳号</Badge>}
          {row.crossesDay && <Badge tone="warn">跨午夜</Badge>}
        </div>
      </header>

      <div className="boundary-pair">
        <div className="boundary-step">
          <span className="eyebrow">边界前一帧</span>
          <span className="mono strong">{row.beforeTc}</span>
          <span className="mono small">帧 {row.beforeFrame.toLocaleString('en-US')}</span>
          <span className="mono small muted">{frameToRealSeconds(row.beforeFrame, format).toFixed(6)} s</span>
        </div>
        <div className="boundary-arrow">
          <span className="mono small">{row.realStepMs.toFixed(3)} ms 真实</span>
          <span className="arrow" aria-hidden="true">
            →
          </span>
          <span className="mono small">读数 {row.labelStepMs.toFixed(3)} ms</span>
        </div>
        <div className="boundary-step">
          <span className="eyebrow">边界后第一帧</span>
          <span className="mono strong">{row.afterTc}</span>
          <span className="mono small">帧 {row.afterFrame.toLocaleString('en-US')}</span>
          <span className="mono small muted">{frameToRealSeconds(row.afterFrame, format).toFixed(6)} s</span>
        </div>
      </div>

      <dl className="kv compact">
        <dt>规范期望</dt>
        <dd className="mono">{row.expectedAfterTc}</dd>
        <dt>累计漂移（边界后）</dt>
        <dd className="mono">{formatBoundaryDelta(row.driftAfterMs)}</dd>
        <dt>累计漂移（边界前）</dt>
        <dd className="mono">{formatBoundaryDelta(row.driftBeforeMs)}</dd>
        {row.skippedLabels.length > 0 && (
          <>
            <dt>被跳过的编号</dt>
            <dd className="mono">{row.skippedLabels.join('、')}</dd>
          </>
        )}
      </dl>
      <p className="small boundary-note">{row.note}</p>
    </article>
  )
}

const FORMAT_TABS: { label: string; format: FrameFormat }[] = [
  { label: '29.97 DF', format: makeFormat('2997', true) },
  { label: '29.97 NDF', format: makeFormat('2997', false) },
  { label: '59.94 DF', format: makeFormat('5994', true) },
  { label: '59.94 NDF', format: makeFormat('5994', false) },
  { label: '25', format: makeFormat('25', false) },
]

export default function BoundaryPanel() {
  const [selectedKey, setSelectedKey] = useState('2997-1')
  const [showAll, setShowAll] = useState(false)
  const selected = FORMAT_TABS.find((entry) => `${entry.format.rate}-${entry.format.dropFrame ? 1 : 0}` === selectedKey)!.format
  const rows = useMemo(() => {
    if (showAll) {
      return FORMAT_TABS.flatMap((entry) => boundaryRows(entry.format).map((row) => ({ format: entry.format, row })))
    }
    return boundaryRows(selected).map((row) => ({ format: selected, row }))
  }, [showAll, selected])

  const failures = rows.filter((entry) => entry.row.compliant === false)

  return (
    <Panel
      id="boundaries"
      eyebrow="04 · 边界核对"
      title="跨普通分钟、十分钟、整点与午夜"
      subtitle="29.97 与 59.94 的跳号：每个非整十分钟的分钟边界跳过编号（29.97 跳 2 个、59.94 跳 4 个），整十分钟和整点不跳。"
      actions={<Toggle checked={showAll} onChange={setShowAll} label="对照全部格式" hint="同时显示 DF / NDF" />}
    >
      {!showAll && (
        <div className="segmented segmented-tabs" role="tablist" aria-label="对照格式">
          {FORMAT_TABS.map((entry) => {
            const key = `${entry.format.rate}-${entry.format.dropFrame ? 1 : 0}`
            return (
              <button
                key={entry.label}
                type="button"
                role="tab"
                aria-selected={selectedKey === key}
                className={selectedKey === key ? 'is-active' : ''}
                onClick={() => setSelectedKey(key)}
              >
                {entry.label}
              </button>
            )
          })}
        </div>
      )}

      <InlineNote tone={failures.length > 0 ? 'error' : 'ok'}>
        {showAll
          ? `已对照 ${FORMAT_TABS.length} 种格式。${failures.length === 0 ? '全部边界符合各自规范。' : `${failures.length} 个边界与规范不符。`}`
          : selected.rate === '25'
            ? '25 帧没有跳号规则；整点与午夜都是自然进位。'
            : selected.dropFrame
              ? '跳号只在非整十分钟的分钟边界生效；整十分钟与 60 分整点不跳。'
              : '不跳号格式不跳过任何编号；时码读数比真实时间慢，29.97 每小时约 −3.6 秒、每天约 −86.4 秒。'}
      </InlineNote>

      {rows.length === 0 ? (
        <Empty>没有可显示的边界。</Empty>
      ) : (
        <div className={`boundary-grid ${showAll ? 'is-dense' : ''}`}>
          {rows.map(({ format, row }) => (
            <BoundaryCard key={`${format.rate}-${format.dropFrame}-${row.kind}`} row={row} format={format} />
          ))}
        </div>
      )}

      <div className="boundary-summary">
        <h3>怎么读这张表</h3>
        <ul className="plain-list small">
          <li>
            “真实”是相邻两帧之间的实际经过时间：29.97 恒为 {(1001 / 30).toFixed(3)} ms、59.94 恒为{' '}
            {(1001 / 60).toFixed(3)} ms、25 恰好 40.000 ms；“读数”是时码上看到的跳变量。跳号格式的普通分钟边界读数跨度更大，
            十分钟与整点的读数步进则与真实步进基本相等，偏差在这一帧被拉回。
          </li>
          <li>跳号并不删除真实帧，只删除永远不会出现的编号。帧序号始终连续，实际媒体时间始终按真实帧率增长。</li>
          <li>
            每天跳号数量：29.97 每天 {2 * 9 * 144} 个编号、59.94 每天 {4 * 9 * 144} 个。午夜不跳号，所以一天的总帧数是：
            29.97 DF 为 {framesPerDay(makeFormat('2997', true)).toLocaleString('en-US')} 帧，59.94 DF 为{' '}
            {framesPerDay(makeFormat('5994', true)).toLocaleString('en-US')} 帧，29.97 NDF 为{' '}
            {framesPerDay(makeFormat('2997', false)).toLocaleString('en-US')} 帧，25 为{' '}
            {framesPerDay(makeFormat('25', false)).toLocaleString('en-US')} 帧。
          </li>
          <li>
            跨午夜区间必须保留“入点在前、出点在后”的绝对帧顺序；单独出现的 00 点附近时码无法确定归属哪天，工具会要求手动选择。
          </li>
        </ul>
      </div>
    </Panel>
  )
}
