import { useMemo, useRef, useState } from 'react'
import {
  importMarkersCsv,
  markersToCsv,
  sampleImportCsv,
  segmentsToCsv,
  toCsv,
  type ImportIssue,
  type ImportResult,
} from '../lib/csv'
import {
  TEST_BOUNDARY_CASES,
  checkBoundaryCases,
  checkCsvRoundtrip,
  makeTestBundle,
  type TestMarkerBundle,
} from '../lib/testBundle'
import { checkPointAgainstSegments, checkRangeAgainstSegments, type MarkerItem, type Segment } from '../lib/items'
import { formatLabel, type FrameFormat } from '../lib/timecode'
import { downloadText, readTextFile, timestampSuffix } from '../lib/download'
import { Badge, Empty, InlineNote, Panel, Toggle } from './ui'

function IssueTable({ issues }: { issues: ImportIssue[] }) {
  if (issues.length === 0) return <InlineNote tone="ok">没有发现格式或取值问题。</InlineNote>
  return (
    <div className="table-wrap">
      <table className="data-table issue-table">
        <thead>
          <tr>
            <th>行</th>
            <th>列</th>
            <th>级别</th>
            <th>问题</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((entry, index) => (
            <tr key={`${entry.line}-${entry.column}-${entry.code}-${index}`} className={`issue-${entry.severity}`}>
              <td className="mono">{entry.line > 0 ? entry.line : '—'}</td>
              <td>{entry.column}</td>
              <td>
                <Badge tone={entry.severity === 'error' ? 'error' : 'warn'}>
                  {entry.severity === 'error' ? '错误' : '提示'}
                </Badge>
              </td>
              <td>
                {entry.message}
                <span className="mono small muted"> {entry.code}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ImportExportPanel({
  markers,
  segments,
  endInclusive,
  defaultFormat,
  onEndInclusive,
  onImport,
  onLoadTest,
  showToast,
}: {
  markers: MarkerItem[]
  segments: Segment[]
  endInclusive: boolean
  defaultFormat: FrameFormat
  onEndInclusive: (value: boolean) => void
  onImport: (items: MarkerItem[]) => void
  onLoadTest: (bundle: TestMarkerBundle) => void
  showToast: (message: string) => void
}) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [fileName, setFileName] = useState('')
  const roundtrip = useMemo(
    () => (markers.length > 0 ? checkCsvRoundtrip(markers, endInclusive) : null),
    [markers, endInclusive],
  )
  const boundaryChecks = useMemo(() => checkBoundaryCases(TEST_BOUNDARY_CASES), [])
  const [showSample, setShowSample] = useState(false)

  const handleFile = async (file: File) => {
    try {
      const text = await readTextFile(file)
      const result = importMarkersCsv(text, { endInclusive, defaultFormat })
      setImportResult(result)
      setFileName(file.name)
      if (result.ok) {
        onImport(result.items)
        showToast(`已导入 ${result.items.length} 个有效标记；${result.rows.length - result.items.length} 行未通过`)
      } else {
        showToast('CSV 导入失败，请查看问题列表')
      }
    } catch (error) {
      showToast(`读取失败：${(error as Error).message}`)
    }
  }

  const exportMarkers = () => {
    downloadText(`timecode-markers-${timestampSuffix()}.csv`, markersToCsv(markers, endInclusive))
    showToast(`已导出 ${markers.length} 个标记（末端${endInclusive ? '包含' : '不包含'}）`)
  }

  const exportSegments = () => {
    downloadText(`timecode-segments-${timestampSuffix()}.csv`, segmentsToCsv(segments))
    showToast(`已导出 ${segments.length} 个素材段`)
  }

  const exportIssues = () => {
    if (!importResult) return
    const rows: (string | number)[][] = [['line', 'column', 'severity', 'code', 'message']]
    for (const entry of importResult.issues) {
      rows.push([entry.line, entry.column, entry.severity, entry.code, entry.message])
    }
    downloadText(`timecode-import-issues-${timestampSuffix()}.csv`, toCsv(rows))
  }

  const loadTest = () => {
    const bundle = makeTestBundle()
    onEndInclusive(bundle.endInclusive)
    onLoadTest(bundle)
    showToast(
      `已载入测试数据：${bundle.segments.length} 段素材、${bundle.markers.length} 个标记、${bundle.cases.length} 个边界样例`,
    )
  }

  const outOfSegment = useMemo(() => {
    if (segments.length === 0) return []
    return markers.filter((item) => {
      const checks =
        item.kind === 'range'
          ? checkRangeAgainstSegments(item.startFrame, item.outFrame, item.format, segments)
          : checkPointAgainstSegments(item.startFrame, item.format, segments)
      const comparable = checks.filter((check) => check.status !== 'format-mismatch' && check.status !== 'invalid')
      if (comparable.length === 0) return false
      if (comparable.some((check) => check.status === 'inside' || check.status === 'partial')) return false
      return true
    })
  }, [markers, segments])

  const passedCases = boundaryChecks.filter((entry) => entry.ok).length

  return (
    <Panel
      id="io"
      eyebrow="06 · 导入导出与核验"
      title="CSV 批量导入、导出倒回与自带样例"
      subtitle="导入会逐行列出对应帧；被跳过的标签、超出帧率的帧号、格式错误都能定位到原始行号。"
      actions={<Toggle checked={endInclusive} onChange={onEndInclusive} label="区间末端包含" hint="影响帧数与导出" />}
    >
      <div className="io-grid">
        <div className="io-card">
          <h3>导入标记 CSV</h3>
          <p className="muted small">
            表头可用 <code>name, kind, format, start_tc, out_tc</code>，也支持 <code>start_frame</code>、
            <code>start_sec</code>、<code>frame_count</code> 与中文列名。格式列可写 <code>25</code>、
            <code>2997df</code>、<code>2997ndf</code>、<code>5994df</code>、<code>5994ndf</code>。
            时码列可用后缀 <code>+0d</code> / <code>+1d</code> 明确日期；单点若只看读数又落在午夜后第一分钟内，
            会被标为“日期待定”。
          </p>
          <div className="io-actions">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
                event.target.value = ''
              }}
            />
            <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()}>
              选择 CSV 文件
            </button>
            <button type="button" onClick={() => setShowSample(!showSample)}>
              {showSample ? '隐藏示例' : '查看示例 CSV'}
            </button>
            <button type="button" onClick={() => downloadText('timecode-sample.csv', sampleImportCsv(endInclusive))}>
              下载示例 CSV
            </button>
          </div>
          {showSample && <pre className="code-block">{sampleImportCsv(endInclusive)}</pre>}
        </div>

        <div className="io-card">
          <h3>导出</h3>
          <p className="muted small">
            导出列包含时码、日期归属、绝对帧号、末端是否包含、末端边界、帧数、真实秒数与备注。重新导入时以帧号为准，
            因此可以完整还原有效标记。
          </p>
          <div className="io-actions">
            <button type="button" onClick={exportMarkers} disabled={markers.length === 0}>
              导出标记 CSV（{markers.length}）
            </button>
            <button type="button" onClick={exportSegments} disabled={segments.length === 0}>
              导出素材段 CSV（{segments.length}）
            </button>
            <button type="button" onClick={exportIssues} disabled={!importResult}>
              导出导入问题
            </button>
          </div>
        </div>
      </div>

      {fileName && (
        <div className="import-report">
          <h3>
            导入结果 <span className="mono small muted">{fileName}</span>
          </h3>
          {importResult && (
            <>
              <div className="import-summary">
                <Badge tone={importResult.ok ? 'ok' : 'error'}>解析{importResult.ok ? '完成' : '失败'}</Badge>
                <span className="small">
                  共 {importResult.rows.length} 行数据，有效 {importResult.items.length} 个，错误{' '}
                  {importResult.issues.filter((entry) => entry.severity === 'error').length} 条，提示{' '}
                  {importResult.issues.filter((entry) => entry.severity === 'warning').length} 条
                </span>
              </div>
              {importResult.rows.length > 0 && (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>原行号</th>
                        <th>名称</th>
                        <th>类型</th>
                        <th>格式</th>
                        <th>状态</th>
                        <th>对应帧</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResult.rows.map((row) => (
                        <tr key={row.line} className={`row-${row.status}`}>
                          <td className="mono">{row.line}</td>
                          <td>{row.name}</td>
                          <td>{row.kind === 'range' ? '区间' : '点'}</td>
                          <td className="mono">{row.formatText}</td>
                          <td>
                            <Badge tone={row.status === 'ok' ? 'ok' : row.status === 'warning' ? 'warn' : 'error'}>
                              {row.status === 'ok' ? '有效' : row.status === 'warning' ? '有提示' : '未通过'}
                            </Badge>
                          </td>
                          <td className="mono small">{row.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <IssueTable issues={importResult.issues} />
            </>
          )}
        </div>
      )}

      <div className="io-grid">
        <div className="io-card">
          <h3>项目自带测试数据</h3>
          <p className="muted small">
            载入 6 段素材与 8 个标记，覆盖 29.97 DF 的整点、普通分钟、跨午夜，25p 区间，59.94 NDF 点，
            以及第 0 天凌晨与次日素材段；其中「午夜后单点」故意留作日期待定，「段落外的点」故意落在所有段外，
            用来演示这两类提示。
          </p>
          <div className="io-actions">
            <button type="button" className="btn-primary" onClick={loadTest}>
              载入测试数据
            </button>
          </div>
          {outOfSegment.length > 0 && (
            <InlineNote tone="error">
              当前有 {outOfSegment.length} 个标记不落在任何素材段内：
              {outOfSegment.map((item) => item.name).join('、')}
              。测试数据里的「段落外的点」是故意保留的段外示例。
            </InlineNote>
          )}
        </div>

        <div className="io-card">
          <h3>导出往返核验</h3>
          {roundtrip === null ? (
            <p className="muted small">没有标记可核验。</p>
          ) : (
            <>
              <InlineNote tone={roundtrip.ok ? 'ok' : 'error'}>
                {roundtrip.ok
                  ? `${roundtrip.rows.length} 个标记导出后重新导入全部一致（末端${endInclusive ? '包含' : '不包含'}）。`
                  : `有 ${roundtrip.rows.filter((row) => !row.match).length} 个标记往返后不一致。`}
              </InlineNote>
              <div className="table-wrap">
                <table className="data-table compact-table">
                  <thead>
                    <tr>
                      <th>标记</th>
                      <th>导出前</th>
                      <th>重新导入后</th>
                      <th>一致</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roundtrip.rows.map((row, index) => (
                      <tr key={`${row.name}-${index}`} className={row.match ? 'row-ok' : 'row-error'}>
                        <td>{row.name}</td>
                        <td className="mono small">{row.before}</td>
                        <td className="mono small">{row.after}</td>
                        <td>{row.match ? <Badge tone="ok">是</Badge> : <Badge tone="error">否</Badge>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {roundtrip.issues.length > 0 && <IssueTable issues={roundtrip.issues} />}
            </>
          )}
        </div>
      </div>

      <div className="boundary-check">
        <h3>
          跨分钟 / 跨午夜样例核验{' '}
          <Badge tone={passedCases === boundaryChecks.length ? 'ok' : 'error'}>
            {passedCases} / {boundaryChecks.length} 通过
          </Badge>
        </h3>
        <p className="muted small">
          这些是项目自带的固定检查：给定帧号，核对时码读数是否与规范一致。全部通过说明跳号、不跳号、整十分钟、整点和午夜的实现相互一致。
        </p>
        <div className="table-wrap">
          <table className="data-table compact-table">
            <thead>
              <tr>
                <th>样例</th>
                <th>格式</th>
                <th>帧号</th>
                <th>期望时码</th>
                <th>实际时码</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {boundaryChecks.map((entry) => (
                <tr key={entry.case.name} className={entry.ok ? 'row-ok' : 'row-error'}>
                  <td>{entry.case.name}</td>
                  <td className="mono">{entry.case.format}</td>
                  <td className="mono">{entry.case.frame.toLocaleString('en-US')}</td>
                  <td className="mono">{entry.case.expect_tc}</td>
                  <td className="mono">{entry.actualTc}</td>
                  <td>{entry.ok ? <Badge tone="ok">通过</Badge> : <Badge tone="error">不一致</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {markers.length === 0 && <Empty>还没有标记可导出或核验。</Empty>}

      {markers.length > 0 && (
        <p className="muted small">
          当前目标格式 {formatLabel(defaultFormat)}；导出文件的 <code>end_inclusive</code> 列记录当前末端规则（
          {endInclusive ? 'true' : 'false'}）。
        </p>
      )}
    </Panel>
  )
}
