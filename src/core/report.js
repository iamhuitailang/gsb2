import {
  alignmentMethodLabel,
  pairStatusLabel,
  PAIR_STATUSES,
} from './project.js';
import {
  formatArea,
  formatDate,
  formatDegrees,
  formatNumber,
  formatPercent,
  formatScale,
  escapeHtml,
  truncate,
} from './format.js';

export const REPORT_VERSION = '1.0';

/**
 * Build a plain report model shared by HTML, Markdown and JSON exports.
 * `assets` maps pairId -> {a, b, diff, overlay} data URLs (optional).
 */
export function buildReportData({ project, pairResults, assets = {}, generatedAt }) {
  const pairs = project.pairs.map((pair, index) => {
    const result = pairResults.get(pair.id) || null;
    return {
      index: index + 1,
      id: pair.id,
      name: pair.name,
      status: pair.status,
      statusLabel: pairStatusLabel(pair.status),
      a: { ...pair.a },
      b: { ...pair.b },
      alignment: { ...pair.alignment },
      alignmentMethod: pair.alignmentMethod,
      alignmentMethodLabel: alignmentMethodLabel(pair.alignmentMethod),
      cornerPoints: pair.cornerPoints.map((p) => ({ ...p })),
      cornerFit: pair.cornerFit ? { ...pair.cornerFit } : null,
      diffSettings: { ...pair.diffSettings },
      notes: pair.notes,
      ignoreStrokeCount: pair.ignoreStrokes.length,
      ignoredArea: result?.stats?.ignoredArea ?? null,
      stats: result?.stats ? { ...result.stats } : null,
      regions: result?.regions ? result.regions.map((r) => ({ ...r })) : [],
      assets: assets[pair.id] || {},
    };
  });
  const counts = Object.fromEntries(PAIR_STATUSES.map((s) => [s.id, 0]));
  for (const pair of pairs) counts[pair.status] = (counts[pair.status] || 0) + 1;
  return {
    reportVersion: REPORT_VERSION,
    generatedAt: generatedAt || new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    summary: {
      pairCount: pairs.length,
      imageCount: new Set(pairs.flatMap((p) => [p.a.imageId, p.b.imageId])).size,
      changedPairCount: pairs.filter(
        (p) => p.stats && p.stats.changedArea > 0,
      ).length,
      totalChangedArea: round(
        pairs.reduce((sum, p) => sum + (p.stats?.changedArea || 0), 0),
        2,
      ),
      totalRegionCount: pairs.reduce((sum, p) => sum + p.regions.length, 0),
      statusCounts: counts,
    },
    pairs,
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function reportFileName(projectName) {
  const stamp = new Date().toISOString().slice(0, 10);
  const stem = String(projectName || '进度对比').replace(/[\\/:*?"<>|]+/g, '-');
  return `${stem}-检查报告-${stamp}`;
}

export function reportToHtml(data) {
  const title = `${data.project.name} · 版本对比检查报告`;
  const summary = data.summary;
  const statusText = PAIR_STATUSES.map(
    (s) => `${s.label} ${summary.statusCounts[s.id] || 0}`,
  ).join(' · ');

  const pairSections = data.pairs.map((pair) => pairSectionHtml(pair)).join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 24px; background: #f4f2ed; color: #1d232b;
    font: 14px/1.65 "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 30px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -0.02em; }
  h2 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h3 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #6b7280; margin: 22px 0 8px; }
  .meta { color: #6b7280; font-size: 13px; }
  .lede { margin-top: 18px; color: #4b5563; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 24px 0 8px; }
  .card { background: #fff; border: 1px solid #e4ded0; border-radius: 12px; padding: 14px 16px; }
  .card b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
  .card span { color: #6b7280; font-size: 12px; }
  .pair { background: #fff; border: 1px solid #e4ded0; border-radius: 16px; padding: 26px 28px; margin: 22px 0; page-break-inside: avoid; }
  .pair-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 1px solid #eee9dd; padding-bottom: 14px; margin-bottom: 18px; }
  .tag { display: inline-block; font-size: 12px; padding: 3px 10px; border-radius: 99px; background: #efece4; color: #4b5563; white-space: nowrap; }
  .tag.ok { background: #dfeee4; color: #22693f; }
  .tag.warn { background: #fbe8d8; color: #9a4a12; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; }
  .kv { display: grid; grid-template-columns: 104px 1fr; gap: 4px 12px; font-size: 13px; }
  .kv dt { color: #6b7280; }
  .kv dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .images { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
  figure { margin: 0; background: #10161f; border-radius: 10px; overflow: hidden; }
  figure img { display: block; width: 100%; height: auto; }
  figcaption { color: #9ca3af; font-size: 12px; padding: 7px 10px; background: #171e28; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eee9dd; font-variant-numeric: tabular-nums; }
  th { color: #6b7280; font-weight: 500; }
  td.num { text-align: right; }
  .notes { background: #faf7ef; border: 1px solid #eee5d2; border-radius: 10px; padding: 12px 14px; font-size: 13px; white-space: pre-wrap; }
  .empty { color: #9ca3af; font-size: 13px; }
  footer { color: #9ca3af; font-size: 12px; margin-top: 32px; text-align: center; }
  @media print { body { background: #fff; padding: 0; } .pair { border-color: #ddd; break-inside: avoid; } }
  @media (max-width: 720px) { .grid, .images { grid-template-columns: 1fr; } .pair { padding: 20px; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">生成时间 ${escapeHtml(formatDate(data.generatedAt))} · 报告版本 ${escapeHtml(data.reportVersion)} · 所有对比均在本机完成</div>
    <p class="lede">本报告记录了 ${summary.pairCount} 组图片版本对比的对齐方式、差异统计、忽略区域与检查备注。差异面积基于对齐后的重叠区域计算；被忽略的区域不计入差异，原始图片不会被修改。</p>
  </header>

  <section class="cards">
    <div class="card"><b>${summary.pairCount}</b><span>对比组</span></div>
    <div class="card"><b>${summary.imageCount}</b><span>图片</span></div>
    <div class="card"><b>${summary.totalRegionCount}</b><span>变化区域</span></div>
    <div class="card"><b>${formatArea(summary.totalChangedArea)}</b><span>累计差异面积</span></div>
  </section>
  <p class="meta">状态统计：${escapeHtml(statusText)}</p>

  ${pairSections}

  <footer>Verso · 本地图片版本对比工作台</footer>
</main>
</body>
</html>`;
}

function pairSectionHtml(pair) {
  const stats = pair.stats;
  const tagClass = pair.status === 'confirmed' ? 'ok' : pair.status === 'attention' ? 'warn' : '';
  const imageBlock = pair.assets.a || pair.assets.b || pair.assets.diff
    ? `<div class="images">
        ${figureHtml(pair.assets.a, 'A · 基准版本')}
        ${figureHtml(pair.assets.b, 'B · 对比版本（按对齐参数放置）')}
        ${figureHtml(pair.assets.diff, '差异图 · 彩色差异 + 忽略区')}
        ${figureHtml(pair.assets.overlay, '叠加预览 · B 覆盖在 A 上')}
      </div>`
    : '<p class="empty">本报告未内嵌图片缩略图。</p>';

  const cornerInfo = pair.cornerPoints.length
    ? `${pair.cornerPoints.length} 对${pair.cornerFit ? `，拟合 RMS ${formatNumber(pair.cornerFit.rms, 2)} px，最大 ${formatNumber(pair.cornerFit.maxError, 2)} px` : ''}`
    : '未使用';

  const regionRows = pair.regions.length
    ? pair.regions
        .slice(0, 60)
        .map(
          (r) => `<tr>
            <td class="num">${r.index}</td>
            <td>${regionTypeLabel(r.type)}</td>
            <td class="num">${formatArea(r.area)}</td>
            <td>${formatNumber(r.bbox.x, 0)}, ${formatNumber(r.bbox.y, 0)} → ${formatNumber(r.bbox.x + r.bbox.width, 0)}, ${formatNumber(r.bbox.y + r.bbox.height, 0)}</td>
            <td>${formatNumber(r.centroid.x, 0)}, ${formatNumber(r.centroid.y, 0)}</td>
          </tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="empty">未检测到超过阈值的差异区域。</td></tr>';

  return `<section class="pair">
    <div class="pair-head">
      <div>
        <h2>${pair.index}. ${escapeHtml(pair.name)}</h2>
        <div class="meta">${escapeHtml(pair.a.version || pair.a.name)} → ${escapeHtml(pair.b.version || pair.b.name)}</div>
      </div>
      <span class="tag ${tagClass}">${escapeHtml(pair.statusLabel)}</span>
    </div>

    ${imageBlock}

    <div class="grid">
      <dl class="kv">
        <dt>基准图 A</dt><dd>${escapeHtml(pair.a.name)}${pair.a.version ? ` · ${escapeHtml(pair.a.version)}` : ''}</dd>
        <dt>尺寸</dt><dd>${pair.a.width} × ${pair.a.height} px</dd>
        <dt>对比图 B</dt><dd>${escapeHtml(pair.b.name)}${pair.b.version ? ` · ${escapeHtml(pair.b.version)}` : ''}</dd>
        <dt>尺寸</dt><dd>${pair.b.width} × ${pair.b.height} px</dd>
      </dl>
      <dl class="kv">
        <dt>对齐方式</dt><dd>${escapeHtml(pair.alignmentMethodLabel)}</dd>
        <dt>平移</dt><dd>X ${formatNumber(pair.alignment.tx, 2)} px · Y ${formatNumber(pair.alignment.ty, 2)} px</dd>
        <dt>缩放</dt><dd>${escapeHtml(formatScale(pair.alignment.scale))}</dd>
        <dt>旋转</dt><dd>${escapeHtml(formatDegrees(pair.alignment.rotation))}</dd>
        <dt>角点辅助</dt><dd>${cornerInfo}</dd>
      </dl>
    </div>

    <h3>差异统计</h3>
    <div class="grid">
      <dl class="kv">
        <dt>敏感度</dt><dd>${pair.diffSettings.sensitivity} / 100 · 阈值 ${stats ? formatNumber(stats.threshold, 1) : '—'}</dd>
        <dt>最小区域</dt><dd>${formatNumber(pair.diffSettings.minRegionArea, 0)} px²</dd>
        <dt>新内容检测</dt><dd>${pair.diffSettings.includeUncovered ? '开启（未覆盖区域计为差异）' : '关闭'}</dd>
        <dt>忽略笔画</dt><dd>${pair.ignoreStrokeCount} 条 · 忽略面积 ${pair.ignoredArea != null ? formatArea(pair.ignoredArea) : '—'}</dd>
      </dl>
      <dl class="kv">
        <dt>重叠面积</dt><dd>${stats ? formatArea(stats.comparedArea) : '—'}</dd>
        <dt>差异面积</dt><dd>${stats ? `${formatArea(stats.changedArea)}（颜色差异占重叠 ${formatPercent(stats.changedPct)}）` : '—'}</dd>
        <dt>变化区域</dt><dd>${stats ? `${formatNumber(stats.regionCount, 0)} 处` : '—'}</dd>
        <dt>对齐后总画布</dt><dd>${stats ? formatArea(stats.totalArea) : '—'}</dd>
      </dl>
    </div>

    <h3>变化区域（按面积排序）</h3>
    <table>
      <thead><tr><th>#</th><th>类型</th><th>面积</th><th>包围盒 x1, y1 → x2, y2</th><th>中心</th></tr></thead>
      <tbody>${regionRows}</tbody>
    </table>
    ${pair.regions.length > 60 ? `<p class="empty">仅列出前 60 个区域，共 ${pair.regions.length} 个。</p>` : ''}

    <h3>检查备注</h3>
    ${pair.notes ? `<div class="notes">${escapeHtml(pair.notes)}</div>` : '<p class="empty">未填写备注。</p>'}
  </section>`;
}

function figureHtml(src, caption) {
  if (!src) return '';
  return `<figure><img src="${src}" alt="${escapeHtml(caption)}"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

function regionTypeLabel(type) {
  if (type === 'coverage') return '覆盖率差异';
  if (type === 'mixed') return '颜色 + 覆盖率';
  return '颜色差异';
}

export function reportToMarkdown(data) {
  const lines = [];
  const summary = data.summary;
  lines.push(`# ${data.project.name} · 版本对比检查报告`);
  lines.push('');
  lines.push(`- 生成时间：${formatDate(data.generatedAt)}`);
  lines.push(`- 报告版本：${data.reportVersion}`);
  lines.push(`- 对比组：${summary.pairCount} 组 · 图片：${summary.imageCount} 张`);
  lines.push(`- 变化区域合计：${summary.totalRegionCount} 处 · 累计差异面积：${formatArea(summary.totalChangedArea)}`);
  lines.push(
    `- 状态统计：${PAIR_STATUSES.map((s) => `${s.label} ${summary.statusCounts[s.id] || 0}`).join(' / ')}`,
  );
  lines.push('');
  lines.push('> 差异面积基于对齐后的重叠区域计算；忽略区域不计入差异，原始图片不会被修改。所有对比均在本机完成。');
  lines.push('');

  for (const pair of data.pairs) {
    lines.push(`## ${pair.index}. ${pair.name}`);
    lines.push('');
    lines.push(`**状态**：${pair.statusLabel}`);
    lines.push('');
    lines.push(`| 项目 | A · 基准 | B · 对比 |`);
    lines.push(`| --- | --- | --- |`);
    lines.push(`| 名称 | ${pair.a.name} | ${pair.b.name} |`);
    lines.push(`| 版本 | ${pair.a.version || '—'} | ${pair.b.version || '—'} |`);
    lines.push(`| 尺寸 | ${pair.a.width} × ${pair.a.height} px | ${pair.b.width} × ${pair.b.height} px |`);
    lines.push('');
    lines.push('**对齐**');
    lines.push('');
    lines.push(`- 方式：${pair.alignmentMethodLabel}`);
    lines.push(`- 平移：X ${formatNumber(pair.alignment.tx, 2)} px，Y ${formatNumber(pair.alignment.ty, 2)} px`);
    lines.push(`- 缩放：${formatScale(pair.alignment.scale)} · 旋转：${formatDegrees(pair.alignment.rotation)}`);
    lines.push(
      `- 角点辅助：${pair.cornerPoints.length ? `${pair.cornerPoints.length} 对${pair.cornerFit ? `，RMS ${formatNumber(pair.cornerFit.rms, 2)} px` : ''}` : '未使用'}`,
    );
    lines.push('');
    lines.push('**差异**');
    lines.push('');
    lines.push(`- 敏感度：${pair.diffSettings.sensitivity} / 100${pair.stats ? `（阈值 ${formatNumber(pair.stats.threshold, 1)}）` : ''}`);
    lines.push(`- 最小区域：${formatNumber(pair.diffSettings.minRegionArea, 0)} px²`);
    lines.push(`- 新内容检测：${pair.diffSettings.includeUncovered ? '开启' : '关闭'}`);
    if (pair.stats) {
      lines.push(`- 重叠面积：${formatArea(pair.stats.comparedArea)}`);
      lines.push(`- 差异面积：${formatArea(pair.stats.changedArea)}（颜色差异占重叠 ${formatPercent(pair.stats.changedPct)}）`);
      lines.push(`- 变化区域：${pair.stats.regionCount} 处`);
      lines.push(`- 忽略面积：${formatArea(pair.stats.ignoredArea)}（${pair.ignoreStrokeCount} 条笔画）`);
    } else {
      lines.push('- 尚未生成差异结果');
    }
    lines.push('');
    if (pair.regions.length) {
      lines.push('| # | 类型 | 面积 | 包围盒 |');
      lines.push('| --- | --- | --- | --- |');
      for (const r of pair.regions.slice(0, 30)) {
        lines.push(
          `| ${r.index} | ${regionTypeLabel(r.type)} | ${formatArea(r.area)} | ${formatNumber(r.bbox.x, 0)}, ${formatNumber(r.bbox.y, 0)} → ${formatNumber(r.bbox.x + r.bbox.width, 0)}, ${formatNumber(r.bbox.y + r.bbox.height, 0)} |`,
        );
      }
      if (pair.regions.length > 30) {
        lines.push('');
        lines.push(`_仅列出前 30 个区域，共 ${pair.regions.length} 个。_`);
      }
      lines.push('');
    }
    lines.push(`**检查备注**：${pair.notes ? pair.notes.replace(/\n/g, '  \n') : '未填写。'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push('_由 Verso · 本地图片版本对比工作台生成。_');
  return lines.join('\n');
}

export function resultsToJson(data) {
  return JSON.stringify(
    {
      reportVersion: data.reportVersion,
      generatedAt: data.generatedAt,
      project: data.project,
      summary: data.summary,
      pairs: data.pairs.map(({ assets, ...pair }) => pair),
    },
    null,
    2,
  );
}

export function reportExcerpt(data, maxPairs = 3) {
  return data.pairs
    .slice(0, maxPairs)
    .map((p) => truncate(`${p.index}. ${p.name}`, 40))
    .join('、');
}
