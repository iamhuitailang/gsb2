import { CONFLICT, HIGH } from '../core.js';
import { escapeHtml, valueBadge, valueText } from './format.js';

function stateY(value, highY, lowY) {
  if (value === HIGH) return highY;
  if (value === 0) return lowY;
  return (highY + lowY) / 2;
}

function segmentClass(value, runKey) {
  if (value === HIGH) return `high-${runKey}`;
  if (value === 0) return 'low';
  if (value === CONFLICT) return 'conflict';
  if (value === null) return 'unknown';
  return 'missing';
}

function renderTrack(row, runKey, yHigh, yLow) {
  const parts = [];
  const values = row.points.map((point) => point[runKey]);

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    const x = i * 46;
    const y = stateY(value, yHigh, yLow);
    if (value === undefined) {
      parts.push(
        `<rect x="${x}" y="${yLow - 3}" width="46" height="6" fill="#eef1f5" />`,
      );
      continue;
    }

    parts.push(
      `<line class="wave-segment ${segmentClass(value, runKey)}" x1="${x}" y1="${y}" x2="${x + 46}" y2="${y}" />`,
    );

    if (i > 0 && values[i - 1] !== undefined) {
      const previousY = stateY(values[i - 1], yHigh, yLow);
      if (previousY !== y) {
        parts.push(
          `<line class="wave-vertical" x1="${x}" y1="${previousY}" x2="${x}" y2="${y}" />`,
        );
      }
    }

    if (value === null || value === CONFLICT) {
      parts.push(
        `<text x="${x + 23}" y="${y + 0.5}" text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="900" fill="${value === CONFLICT ? '#9d2424' : '#7a5200'}">${valueText(value)}</text>`,
      );
    }
  }
  return parts.join('');
}

function renderWaveRow(row, maxTicks) {
  const width = maxTicks * 46;
  const mismatchCount = row.mismatches
    ? `<span class="mismatch-pill">${row.mismatches} 个已知值不一致</span>`
    : '';
  return `
    <div class="wave-row" data-row-key="${escapeHtml(row.key)}">
      <div class="wave-label">
        <strong title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</strong>
        <div class="run-mini"><i class="run-tag a"></i>A · ${row.lampA ? '有信号' : '此运行无此灯'}</div>
        <div class="run-mini"><i class="run-tag b"></i>B · ${row.lampB ? '有信号' : '此运行无此灯'}</div>
        ${mismatchCount}
      </div>
      <div class="wave-svg-wrap">
        <svg class="wave-svg" width="${width}" height="66" viewBox="0 0 ${width} 66" aria-label="${escapeHtml(row.name)} 时序">
          ${row.points.filter((p) => p.mismatch).map((p) => `
            <rect class="wave-mismatch-band" x="${p.tick * 46}" y="2" width="46" height="62" rx="4"></rect>
          `).join('')}
          ${renderTrack(row, 'a', 12, 27)}
          ${renderTrack(row, 'b', 42, 57)}
          <line class="wave-crosshair" x1="0" y1="0" x2="0" y2="66" hidden></line>
          ${row.points.map((p) => `
            <rect class="wave-hit" data-wave-tick="${p.tick}" data-row-key="${escapeHtml(row.key)}"
              x="${p.tick * 46}" y="0" width="46" height="66"></rect>
          `).join('')}
        </svg>
      </div>
    </div>
  `;
}

export function renderWaveformComparison(rows) {
  if (!rows.length) {
    return `
      <div class="empty-state">
        <h3>没有可比较的显示灯</h3>
        <p>请先在电路中放置并连接“显示灯”，然后分别创建两次运行。</p>
      </div>`;
  }
  const maxTicks = Math.max(...rows.map((row) => row.points.length), 1);
  const axisTicks = Array.from({ length: maxTicks }, (_, tick) => `
    <span class="wave-tick-label" style="left:${tick * 46 + 23}px">${tick}</span>
  `).join('');

  return `
    <div class="wave-scroll">
      <div class="wave-inner" style="width:${190 + maxTicks * 46}px">
        <div class="wave-axis">
          <div class="wave-axis-label">显示灯 / 运行</div>
          <div class="wave-ticks" style="width:${maxTicks * 46}px">${axisTicks}</div>
        </div>
        ${rows.map((row) => renderWaveRow(row, maxTicks)).join('')}
      </div>
    </div>
  `;
}

export function renderComparisonTable(rows) {
  if (!rows.length) return '<div class="empty-state"><h3>没有可比较的信号</h3></div>';
  const maxTicks = Math.max(...rows.map((row) => row.points.length), 1);
  const head = Array.from({ length: maxTicks }, (_, i) => `<th>T+${i}</th>`).join('');
  const body = rows.map((row) => {
    const cellsA = row.points.map((p) => `<td class="${p.mismatch ? 'cell-mismatch' : ''}">${valueBadge(p.a)}</td>`).join('');
    const cellsB = row.points.map((p) => `<td class="${p.mismatch ? 'cell-mismatch' : ''}">${valueBadge(p.b)}</td>`).join('');
    return `
      <tr>
        <th class="name" rowspan="2">${escapeHtml(row.name)}</th>
        <td><i class="run-tag a"></i> A</td>${cellsA}
      </tr>
      <tr>
        <td><i class="run-tag b"></i> B</td>${cellsB}
      </tr>`;
  }).join('');

  return `
    <div class="data-table-wrap">
      <table class="data-table">
        <thead><tr><th class="name">信号</th><th>运行</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}
