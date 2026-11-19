// 前端状态机。硬性时序：任何新分析/换文件先清空为空态，
// 仅当 HTTP 200 且响应 ok===true 才写入结果；错误响应不经过结果渲染路径。
'use strict';

const PAGE_SIZE = 100;
const SEVERITY_ORDER = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
const SEVERITY_LABEL = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示' };

function createEmptyState() {
  return {
    report: null,
    files: { lockfile: null, rules: null, baseline: null },
    filter: { severities: new Set(['critical', 'high', 'medium', 'low', 'info']), diff: '', host: '', name: '' },
    sort: { key: 'severity', dir: 'desc' },
    page: 0,
    expanded: new Set(),
  };
}

let state = createEmptyState();

const el = (id) => document.getElementById(id);

function setError(message) {
  const banner = el('error-banner');
  banner.textContent = message;
  banner.classList.remove('hidden');
}

function clearError() {
  const banner = el('error-banner');
  banner.textContent = '';
  banner.classList.add('hidden');
}

// 渲染空态：隐藏结果区，确保旧报告不残留
function renderEmpty() {
  el('results').classList.add('hidden');
  el('empty-state').classList.remove('hidden');
  el('btn-export').disabled = true;
  el('findings-tbody').innerHTML = '';
  el('inconclusive-list').innerHTML = '';
  el('summary-cards').innerHTML = '';
  el('meta-list').innerHTML = '';
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取本地文件失败'));
    reader.readAsText(file);
  });
}

async function loadSamples() {
  try {
    const resp = await fetch('/api/samples');
    const data = await resp.json();
    const select = el('sample-select');
    if (!data.ok) return;
    for (const sample of data.samples) {
      const opt = document.createElement('option');
      opt.value = sample.name;
      opt.textContent = `${sample.name} — ${sample.description}`;
      select.appendChild(opt);
    }
  } catch {
    // 离线服务未启动或不可用时静默，用户仍可手动选文件
  }
}

async function onSampleChange() {
  const name = el('sample-select').value;
  if (!name) return;
  // 载入新样本即清空上一次结果
  resetToEmpty();
  try {
    const resp = await fetch(`/api/samples/${encodeURIComponent(name)}`);
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error?.message ?? '示例载入失败');
    state.files.lockfile = { fileName: data.name, content: data.content };
    el('name-lockfile').textContent = data.name;
    el('file-lockfile').value = '';
    el('request-hint').textContent = `已载入示例 ${data.name}，点击「开始审计」`;
  } catch (err) {
    setError(err.message);
  }
}

function resetToEmpty() {
  state = createEmptyState();
  clearError();
  renderEmpty();
}

function bindFileInputs() {
  const bind = (inputId, nameId, slot, defaultLabel) => {
    el(inputId).addEventListener('change', async (e) => {
      resetToEmpty();
      const file = e.target.files[0];
      if (!file) {
        state.files[slot] = null;
        el(nameId).textContent = defaultLabel;
        return;
      }
      try {
        const content = await readFileAsText(file);
        state.files[slot] = { fileName: file.name, content };
        el(nameId).textContent = file.name;
      } catch (err) {
        setError(err.message);
      }
    });
  };
  bind('file-lockfile', 'name-lockfile', 'lockfile', '未选择');
  bind('file-rules', 'name-rules', 'rules', '默认规则');
  bind('file-baseline', 'name-baseline', 'baseline', '未选择');
}

async function onAnalyze() {
  // 关键：发起新分析前无条件清空，杜绝旧结果残留
  resetToEmpty();
  if (!state.files.lockfile) {
    setError('请先选择 package-lock.json 或载入示例');
    return;
  }
  el('request-hint').textContent = '分析中…';

  const payload = {
    lockfile: state.files.lockfile,
    rules: state.files.rules,
    baseline: state.files.baseline,
  };

  let resp;
  let data;
  try {
    resp = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    data = await resp.json();
  } catch (err) {
    // 网络/服务错误：结果区保持空态
    setError(`请求失败：${err.message}。结果区已清空，未保留任何旧报告。`);
    el('request-hint').textContent = '';
    return;
  }

  if (!resp.ok || !data.ok) {
    // 业务错误（解析失败/结构不支持/超限）：同样不渲染结果
    const e = data.error ?? {};
    const loc = e.line ? `（第 ${e.line} 行第 ${e.column} 列）` : '';
    setError(`[${e.code ?? 'ERROR'}] ${e.message ?? '分析失败'}${loc}\n结果区已清空，未保留任何旧报告。`);
    el('request-hint').textContent = '';
    return;
  }

  // 只有成功响应才写入 state 并渲染
  state.report = data.report;
  clearError();
  el('request-hint').textContent = '';
  populateFilters();
  renderAll();
  el('btn-export').disabled = false;
}

function populateFilters() {
  const hostSelect = el('f-host');
  hostSelect.innerHTML = '<option value="">全部</option><option value="__none__">(无法判定)</option>';
  const hosts = Object.keys(state.report.summary.hosts).sort();
  for (const host of hosts) {
    const opt = document.createElement('option');
    opt.value = host;
    opt.textContent = `${host}（${state.report.summary.hosts[host]}）`;
    hostSelect.appendChild(opt);
  }

  const diffSelect = el('f-diff');
  diffSelect.innerHTML = '<option value="">全部</option>';
  const diffKinds = new Set();
  if (state.report.diff) {
    for (const entry of state.report.diff.entries) {
      if (entry.status !== 'unchanged') diffKinds.add(entry.status);
      for (const ct of entry.changeTypes) diffKinds.add(ct);
    }
  }
  for (const kind of [...diffKinds].sort()) {
    const opt = document.createElement('option');
    opt.value = kind;
    opt.textContent = kind;
    diffSelect.appendChild(opt);
  }
}

function recordOf(finding) {
  return state.report.records.find((r) => r.recordId === finding.recordId) || null;
}

function filteredFindings() {
  const f = state.filter;
  return state.report.findings.filter((item) => {
    if (!f.severities.has(item.severity)) return false;
    if (f.host) {
      const rec = recordOf(item);
      const host = rec?.host ?? '__none__';
      if (host !== f.host) return false;
    }
    if (f.name) {
      const q = f.name.toLowerCase();
      const hay = `${item.name ?? ''} ${item.packageKey ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f.diff) {
      if (item.source !== 'diff') return false;
      if (item.ruleId.includes(f.diff.toUpperCase().replace(/-/g, '_'))) return true;
      // 变化类型（如 resolved-host）落在 diff 条目里，这里做一次匹配
      const inDiff = state.report.diff?.entries.some(
        (d) => d.key === item.packageKey && (d.status === f.diff || d.changeTypes.includes(f.diff)),
      );
      if (!inDiff) return false;
    }
    return true;
  });
}

function sortFindings(list) {
  const { key, dir } = state.sort;
  const factor = dir === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    let va;
    let vb;
    if (key === 'severity') {
      va = SEVERITY_ORDER[a.severity];
      vb = SEVERITY_ORDER[b.severity];
    } else if (key === 'host') {
      va = recordOf(a)?.host ?? '';
      vb = recordOf(b)?.host ?? '';
    } else {
      va = a[key] ?? '';
      vb = b[key] ?? '';
    }
    if (va < vb) return -1 * factor;
    if (va > vb) return 1 * factor;
    return 0;
  });
}

function renderSummary() {
  const s = state.report.summary;
  const cards = [
    ['critical', s.bySeverity.critical, '严重'],
    ['high', s.bySeverity.high, '高'],
    ['medium', s.bySeverity.medium, '中'],
    ['low', s.bySeverity.low, '低'],
    ['info', s.bySeverity.info, '提示'],
  ];
  const html = cards
    .map(([sev, num, cap]) => `<div class="stat sev-${sev}"><div class="num">${num}</div><div class="cap">${cap}</div></div>`)
    .join('');
  el('summary-cards').innerHTML =
    html +
    `<div class="stat"><div class="num">${s.inconclusiveCount}</div><div class="cap">待核实</div></div>` +
    `<div class="stat"><div class="num">${state.report.lockfile.packageCount}</div><div class="cap">包总数</div></div>`;
}

function renderTable() {
  const list = sortFindings(filteredFindings());
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (state.page >= pageCount) state.page = pageCount - 1;
  const start = state.page * PAGE_SIZE;
  const pageItems = list.slice(start, start + PAGE_SIZE);

  const tbody = el('findings-tbody');
  tbody.innerHTML = '';
  for (const item of pageItems) {
    const rec = recordOf(item);
    const tr = document.createElement('tr');
    tr.className = 'expandable';
    tr.dataset.id = item.id;
    tr.innerHTML = `
      <td><span class="sev-tag sev-${item.severity}">${SEVERITY_LABEL[item.severity]}</span></td>
      <td class="mono">${item.ruleId}</td>
      <td>${item.name ?? '—'}</td>
      <td class="mono">${rec?.host ?? '<span class="hint">无法判定</span>'}</td>
      <td class="mono">${item.packageKey}</td>
      <td>${item.title}</td>
      <td class="${item.source === 'diff' ? 'source-diff' : 'source-lockfile'}">${item.source === 'diff' ? '差异' : '清单'}</td>
    `;
    tr.addEventListener('click', () => toggleDetail(item.id));
    tbody.appendChild(tr);
  }

  el('page-info').textContent = `第 ${state.page + 1} / ${pageCount} 页`;
  el('result-count').textContent = `共 ${list.length} 条匹配（每页 ${PAGE_SIZE} 条）`;
  el('page-prev').disabled = state.page === 0;
  el('page-next').disabled = state.page >= pageCount - 1;
}

function toggleDetail(id) {
  if (state.expanded.has(id)) {
    state.expanded.delete(id);
    const row = document.querySelector(`tr.detail-row[data-detail="${id}"]`);
    row?.remove();
    return;
  }
  state.expanded.add(id);
  const finding = state.report.findings.find((x) => x.id === id);
  const rec = recordOf(finding);
  const tr = document.querySelector(`tr.expandable[data-id="${id}"]`);
  const detail = document.createElement('tr');
  detail.className = 'detail-row';
  detail.dataset.detail = id;
  detail.innerHTML = `<td colspan="7">${renderDetail(finding, rec)}</td>`;
  tr.after(detail);
}

function renderPath(recordId) {
  const info = state.report.dependencyPaths[recordId];
  if (!info || !info.reachable) {
    return '<p class="hint">该条目在依赖图中不可达，没有从根项目出发的路径（见待核实项）。</p>';
  }
  const crumb = info.shortest
    .map((node, i) => {
      const label = node === '' ? '<根项目>' : node;
      return `${i > 0 ? '<span class="path-arrow">→</span>' : ''}<span class="path-node">${label}</span>`;
    })
    .join('');
  let alt = '';
  if (info.alternatives.length > 0) {
    alt = `<h4>其它路径（${info.alternatives.length} 条${info.truncated ? '，已截断' : ''}）</h4>` +
      info.alternatives
        .slice(0, 5)
        .map((p) => `<div class="path-breadcrumb">${p.map((n) => `<span class="path-node">${n === '' ? '<根>' : n}</span>`).join('<span class="path-arrow">→</span>')}</div>`)
        .join('');
  }
  return `<h4>依赖路径（直接依赖 → 目标包）</h4><div class="path-breadcrumb">${crumb}</div>${alt}`;
}

function renderDetail(finding, rec) {
  const expected = Object.keys(finding.expected).length
    ? JSON.stringify(finding.expected, null, 2)
    : '（无）';
  const actual = Object.keys(finding.actual).length
    ? JSON.stringify(finding.actual, null, 2)
    : '（无）';
  const integrityNote = finding.ruleId.startsWith('INTEGRITY')
    ? `<p class="kv">⚠️ ${finding.status ?? '仅声明、未实际验证压缩包内容'}</p>`
    : '';
  const pathBlock = rec ? renderPath(rec.recordId) : '';
  const rawBlock = rec
    ? `<h4>锁文件原始字段（证据）</h4><pre class="raw-json">${escapeHtml(JSON.stringify(rec.raw, null, 2))}</pre>`
    : '';
  return `
    <div class="detail-box">
      <div><h4>触发原因</h4><div>${finding.message}</div></div>
      ${integrityNote}
      <div class="kv"><h4>期望值 / 规则</h4><pre class="raw-json">${escapeHtml(expected)}</pre></div>
      <div class="kv"><h4>实际值</h4><pre class="raw-json">${escapeHtml(actual)}</pre></div>
      ${pathBlock}
      ${rawBlock}
    </div>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderInconclusive() {
  const ul = el('inconclusive-list');
  if (!state.report.inconclusive.length) {
    ul.innerHTML = '<li class="hint">无待核实项。</li>';
    return;
  }
  ul.innerHTML = state.report.inconclusive
    .map((i) => `<li><span class="mono">${i.packageKey}</span> — ${i.reason}${i.hint ? `（线索：${i.hint}）` : ''}</li>`)
    .join('');
}

function renderMeta() {
  const l = state.report.lockfile;
  const b = state.report.boundaries;
  const rows = [
    ['文件名', l.fileName],
    ['lockfileVersion', l.lockfileVersion],
    ['大小（字节）', l.sizeBytes],
    ['sha256', l.sha256],
    ['检查时间（本地）', `${state.report.generatedAtLocal}（${state.report.timeZone}）`],
    ['检查时间（UTC）', state.report.generatedAtUtc],
    ['离线边界', b.offline],
    ['完整性边界', b.integrity],
    ['措辞边界', b.wording],
    ['待核实边界', b.inconclusive],
  ];
  if (state.report.diff) {
    rows.push(['基线文件', `${state.report.diff.baseline.fileName}（${state.report.diff.baseline.sha256.slice(0, 12)}…）`]);
  }
  el('meta-list').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`).join('');
}

function renderAll() {
  el('empty-state').classList.add('hidden');
  el('results').classList.remove('hidden');
  renderSummary();
  renderTable();
  renderInconclusive();
  renderMeta();
}

function bindFilters() {
  document.querySelectorAll('.f-sev').forEach((box) => {
    box.addEventListener('change', () => {
      const set = state.filter.severities;
      if (box.checked) set.add(box.value);
      else set.delete(box.value);
      state.page = 0;
      renderTable();
    });
  });
  el('f-diff').addEventListener('change', (e) => {
    state.filter.diff = e.target.value;
    state.page = 0;
    renderTable();
  });
  el('f-host').addEventListener('change', (e) => {
    state.filter.host = e.target.value;
    state.page = 0;
    renderTable();
  });
  el('f-name').addEventListener('input', (e) => {
    state.filter.name = e.target.value.trim();
    state.page = 0;
    renderTable();
  });
  document.querySelectorAll('th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === 'desc' ? 'asc' : 'desc';
      } else {
        state.sort = { key, dir: 'desc' };
      }
      renderTable();
    });
  });
  el('page-prev').addEventListener('click', () => {
    state.page = Math.max(0, state.page - 1);
    renderTable();
  });
  el('page-next').addEventListener('click', () => {
    state.page += 1;
    renderTable();
  });
}

function onExport() {
  if (!state.report) return;
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lock-audit-report-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

el('btn-analyze').addEventListener('click', onAnalyze);
el('btn-export').addEventListener('click', onExport);
el('sample-select').addEventListener('change', onSampleChange);
bindFileInputs();
bindFilters();
renderEmpty();
loadSamples();
