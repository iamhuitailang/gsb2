// 工作台前端主逻辑。
// 直接 import src/core 的同一套分析模块（与 Node 测试、CLI、HTTP API 共用实现），
// 所有计算在浏览器本地完成，不存在任何网络上报或远程调用。

import {
  parsePolicy,
  parseHeaderText,
  lintPolicy,
  lintPolicies,
  analyzeCoverage,
  evaluateSample,
  comparePolicies,
  RESOURCE_TYPE_LABELS,
  INLINE_CAPABLE,
} from '/src/core/index.js';
import { loadPolicies, savePolicies, upsertPolicy, removePolicy, newId } from '/src/web/storage.js';
import { DEMO_POLICIES, DEMO_SAMPLES } from '/src/data/demo-policies.js';

const state = {
  policies: [],
  selectedId: null,
  dirty: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- 初始化 ----------
function init() {
  const loaded = loadPolicies();
  if (!loaded.ok) toast(loaded.error, 'error');
  state.policies = loaded.policies;
  bindTabs();
  bindEditor();
  bindToolbar();
  bindVerify();
  bindCompare();
  bindModal();
  renderPolicyList();
  renderSelectors();
  if (state.policies.length) selectPolicy(state.policies[0].id);
  else clearEditor();
}

function bindTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#panel-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'check') renderCheck();
      if (tab.dataset.tab === 'coverage') renderCoverage();
    });
  });
}

// ---------- 策略列表与编辑 ----------
function renderPolicyList() {
  $('#policy-count').textContent = state.policies.length;
  const ul = $('#policy-list');
  if (!state.policies.length) {
    ul.innerHTML = '<li class="storage-note">暂无策略，点击“新建”或“载入演示数据”开始。</li>';
    return;
  }
  ul.innerHTML = state.policies
    .map((p) => {
      const parsed = safeParse(p);
      const errCount = countErrors(parsed);
      return `
      <li class="policy-item ${p.id === state.selectedId ? 'selected' : ''}" data-id="${p.id}">
        <div class="p-name">${esc(p.name) || '(未命名)'}</div>
        <div class="p-meta">
          ${p.mode === 'report-only' ? '<span class="chip chip-info">报告模式</span>' : '<span class="chip chip-ok">强制模式</span>'}
          ${errCount ? `<span class="chip chip-error">${errCount} 错误</span>` : '<span class="chip chip-ok">可解析</span>'}
        </div>
      </li>`;
    })
    .join('');
  ul.querySelectorAll('.policy-item').forEach((li) => {
    li.addEventListener('click', () => selectPolicy(li.dataset.id));
  });
}

function safeParse(p) {
  try {
    if (p.text.includes(',')) return parseHeaderText(p.text, { mode: p.mode });
    return { policies: [parsePolicy(p.text, { mode: p.mode, name: p.name })], issues: [] };
  } catch (err) {
    return { policies: [], issues: [{ severity: 'error', message: `解析异常：${err.message}` }] };
  }
}

function countErrors(parsed) {
  const parseErrs = (parsed.issues || []).filter((i) => i.severity === 'error').length;
  const lintErrs = parsed.policies.flatMap(lintPolicy).filter((i) => i.severity === 'error').length;
  return parseErrs + lintErrs;
}

function selectPolicy(id) {
  const p = state.policies.find((x) => x.id === id);
  if (!p) return;
  state.selectedId = id;
  $('#edit-name').value = p.name;
  $('#edit-mode').value = p.mode || 'enforce';
  $('#edit-desc').value = p.description || '';
  $('#edit-text').value = p.text;
  $('#save-state').textContent = `最近保存：${new Date(p.updatedAt).toLocaleString()}`;
  state.dirty = false;
  renderPolicyList();
  refreshCanonical();
  refreshLiveErrors();
}

function clearEditor() {
  state.selectedId = null;
  $('#edit-name').value = '';
  $('#edit-mode').value = 'enforce';
  $('#edit-desc').value = '';
  $('#edit-text').value = '';
  $('#canonical-view').textContent = '（保存或解析后显示）';
  $('#edit-live-errors').innerHTML = '';
  $('#save-state').textContent = '';
  renderPolicyList();
}

function editorRecord() {
  return {
    id: state.selectedId || newId(),
    name: $('#edit-name').value.trim() || '未命名策略',
    description: $('#edit-desc').value.trim(),
    mode: $('#edit-mode').value,
    text: $('#edit-text').value,
  };
}

function bindEditor() {
  const markDirty = () => { state.dirty = true; refreshLiveErrors(); };
  $('#edit-text').addEventListener('input', markDirty);
  $('#edit-mode').addEventListener('change', markDirty);

  $('#btn-new-policy').addEventListener('click', () => {
    clearEditor();
    $('#edit-name').focus();
  });

  $('#btn-save').addEventListener('click', () => {
    const record = editorRecord();
    if (!record.text.trim()) {
      toast('策略文本不能为空', 'error');
      return;
    }
    const { policies, record: saved } = upsertPolicy(state.policies, record);
    state.policies = policies;
    state.selectedId = saved.id;
    const r = savePolicies(state.policies);
    if (!r.ok) return toast(r.error, 'error');
    state.dirty = false;
    toast('已保存到本地浏览器', 'ok');
    renderPolicyList();
    renderSelectors();
    $('#save-state').textContent = `最近保存：${new Date(saved.updatedAt).toLocaleString()}`;
  });

  $('#btn-delete').addEventListener('click', () => {
    if (!state.selectedId) return toast('没有选中的策略', 'error');
    if (!confirm('确认删除该策略？此操作只影响本地存储。')) return;
    state.policies = removePolicy(state.policies, state.selectedId);
    savePolicies(state.policies);
    toast('已删除', 'ok');
    clearEditor();
    renderSelectors();
  });

  $('#btn-parse').addEventListener('click', () => {
    refreshCanonical();
    refreshLiveErrors();
    const parsed = parseCurrent();
    const total = (parsed.issues || []).length + parsed.policies.flatMap(lintPolicy).length;
    toast(total ? `发现 ${total} 个问题，详见“检查结果”标签` : '未发现问题', total ? 'error' : 'ok');
  });

  $('#btn-copy-canonical').addEventListener('click', async () => {
    const text = $('#canonical-view').textContent;
    if (!text || text.startsWith('（')) return toast('还没有可复制的规范化结果', 'error');
    try {
      await navigator.clipboard.writeText(text);
      toast('规范化文本已复制', 'ok');
    } catch {
      toast('剪贴板不可用，请手动选择复制', 'error');
    }
  });
}

function parseCurrent() {
  const record = editorRecord();
  if (record.text.includes(',')) {
    const header = parseHeaderText(record.text, { mode: record.mode });
    return { ...header, policies: header.policies };
  }
  const policy = parsePolicy(record.text, { mode: record.mode, name: record.name });
  return { policies: [policy], issues: policy.issues };
}

function refreshCanonical() {
  const text = $('#edit-text').value;
  if (!text.trim()) {
    $('#canonical-view').textContent = '（保存或解析后显示）';
    return;
  }
  const parsed = parseCurrent();
  $('#canonical-view').textContent = parsed.policies.map((p) => p.canonical || '(空策略)').join('\n---\n');
}

function refreshLiveErrors() {
  const box = $('#edit-live-errors');
  const text = $('#edit-text').value;
  if (!text.trim()) { box.innerHTML = ''; return; }
  const parsed = parseCurrent();
  const issues = [
    ...(parsed.issues || []),
    ...parsed.policies.flatMap(lintPolicy),
    ...lintPolicies(parsed.policies),
  ];
  if (!issues.length) {
    box.innerHTML = '<span class="chip chip-ok">未发现问题</span>';
    return;
  }
  box.innerHTML = issues
    .slice(0, 6)
    .map((i) => {
      const pos = i.loc ? ` ${i.loc.line}:${i.loc.column}` : '';
      return `<span class="chip chip-${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'}">${esc(i.code)}${pos} ${esc(i.message)}</span>`;
    })
    .join('') + (issues.length > 6 ? `<span class="chip">另有 ${issues.length - 6} 项…</span>` : '');
}

// ---------- 顶部工具栏：演示数据 / 导入 / 导出 ----------
function bindToolbar() {
  $('#btn-load-demo').addEventListener('click', () => {
    if (state.policies.length && !confirm('将把 6 条演示策略追加到本地列表，继续？')) return;
    const before = state.policies.length;
    for (const demo of DEMO_POLICIES) {
      const { policies } = upsertPolicy(state.policies, {
        id: newId(),
        name: demo.name,
        description: demo.description,
        mode: demo.mode,
        text: demo.text,
      });
      state.policies = policies;
    }
    savePolicies(state.policies);
    renderPolicyList();
    renderSelectors();
    selectPolicy(state.policies[before].id);
    toast('演示数据已载入（仅本地保存）', 'ok');
  });

  $('#btn-export-all').addEventListener('click', () => {
    if (!state.policies.length) return toast('没有可导出的策略', 'error');
    const payload = {
      format: 'csp-workbench-export',
      exportedAt: new Date().toISOString(),
      policies: state.policies.map(({ id, name, description, mode, text }) => ({ id, name, description, mode, text })),
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'csp-policies.json');
    toast('已导出 JSON 文件', 'ok');
  });

  $('#file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const content = await file.text();
      const imported = extractImported(content, file.name);
      if (!imported.length) return toast('文件中没有识别出可用策略', 'error');
      if (state.policies.length && !confirm(`识别到 ${imported.length} 条策略，确认导入并追加到本地列表？`)) return;
      for (const item of imported) {
        const { policies } = upsertPolicy(state.policies, { id: newId(), ...item });
        state.policies = policies;
      }
      savePolicies(state.policies);
      renderPolicyList();
      renderSelectors();
      toast(`已导入 ${imported.length} 条策略（仅解析为数据，未执行任何内容）`, 'ok');
    } catch (err) {
      toast(`导入失败：${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
}

// 支持两种导入：本工具导出的 JSON，或纯文本 CSP（按行/逗号拆分为策略）
function extractImported(content, filename) {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed);
    const arr = Array.isArray(json) ? json : json.policies;
    if (!Array.isArray(arr)) throw new Error('JSON 中找不到 policies 数组');
    return arr
      .filter((p) => p && typeof p.text === 'string')
      .map((p) => ({
        name: String(p.name || filename).slice(0, 80),
        description: p.description || '导入策略',
        mode: p.mode === 'report-only' ? 'report-only' : 'enforce',
        text: p.text,
      }));
  }
  // 纯文本：按逗号（多策略头）或换行拆分
  return trimmed
    .split(/\r?\n|,(?=\s*[a-z-]+\s)/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => ({
      name: `${filename} #${i + 1}`,
      description: '从文本文件导入',
      mode: 'enforce',
      text: line.replace(/;$/, ''),
    }));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 选择器 ----------
function renderSelectors() {
  const opts = state.policies
    .map((p) => `<option value="${p.id}">${esc(p.name)}（${p.mode === 'report-only' ? '报告' : '强制'}）</option>`)
    .join('');
  for (const id of ['#check-policy-select', '#coverage-policy-select', '#compare-a', '#compare-b']) {
    const el = $(id);
    el.innerHTML = opts || '<option value="">（请先新建或导入策略）</option>';
  }
  if (state.policies.length > 1) $('#compare-b').value = state.policies[1].id;
  const multi = $('#verify-policy-select');
  multi.innerHTML = state.policies
    .map((p) => `<option value="${p.id}" selected>${esc(p.name)}</option>`)
    .join('');

  const typeSel = $('#verify-type');
  typeSel.innerHTML = Object.entries(RESOURCE_TYPE_LABELS)
    .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
    .join('');
}

// ---------- ② 检查结果 ----------
function renderCheck() {
  const id = $('#check-policy-select').value;
  const p = state.policies.find((x) => x.id === id);
  const box = $('#check-issues');
  const summary = $('#check-summary');
  if (!p) { box.innerHTML = '<p class="storage-note">请先选择策略。</p>'; summary.innerHTML = ''; return; }

  const parsed = safeParse(p);
  const issues = [
    ...(parsed.issues || []),
    ...parsed.policies.flatMap(lintPolicy),
    ...lintPolicies(parsed.policies),
  ].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const count = (sev) => issues.filter((i) => i.severity === sev).length;
  summary.innerHTML = ['error', 'warning', 'info']
    .map((sev) => `<div class="summary-card"><div class="num">${count(sev)}</div><div class="lbl">${sev}</div></div>`)
    .join('') + `<div class="summary-card"><div class="num">${parsed.policies.length}</div><div class="lbl">策略条数</div></div>`;

  if (!issues.length) {
    box.innerHTML = '<div class="issue-card severity-info"><p class="issue-msg">未发现问题。注意：没有告警不等于策略足够严格，请结合“资源覆盖分析”确认兜底范围。</p></div>';
    return;
  }

  box.innerHTML = issues.map((i) => issueCard(i)).join('');
}

function severityRank(s) { return s === 'error' ? 0 : s === 'warning' ? 1 : 2; }

function issueCard(i) {
  const snippet = i.loc && i.loc.lineText
    ? `<div class="code-snippet">${esc(i.loc.lineText)}
<div>${' '.repeat(Math.max(0, i.loc.snippetStart))}<span class="caret">▲ 第 ${i.loc.line} 行第 ${i.loc.column} 列</span></div></div>`
    : '';
  return `
  <div class="issue-card severity-${i.severity}">
    <div class="issue-head">
      <span class="chip chip-${i.severity === 'error' ? 'error' : i.severity === 'warning' ? 'warning' : 'info'}">${i.severity}</span>
      <span class="issue-code">${esc(i.code)}</span>
      ${i.directiveName ? `<span class="issue-dir">${esc(i.directiveName)}</span>` : ''}
      ${i.loc ? `<span class="issue-loc">定位 ${i.loc.line}:${i.loc.column}</span>` : ''}
    </div>
    <p class="issue-msg">${esc(i.message)}</p>
    ${i.hint ? `<p class="issue-hint">建议：${esc(i.hint)}</p>` : ''}
    ${snippet}
  </div>`;
}

// ---------- ③ 覆盖分析 ----------
function renderCoverage() {
  const id = $('#coverage-policy-select').value;
  const p = state.policies.find((x) => x.id === id);
  const view = $('#coverage-view');
  if (!p) { view.innerHTML = '<p class="storage-note">请先选择策略。</p>'; return; }

  const parsed = safeParse(p);
  const cards = parsed.policies.flatMap((pol, polIdx) => {
    const cov = analyzeCoverage(pol);
    const header = parsed.policies.length > 1 ? `<h2>策略 ${polIdx + 1}：${esc(pol.name || '')}</h2>` : '';
    return header + '<div class="coverage-grid">' + Object.values(cov).map(coverageCard).join('') + '</div>';
  });
  view.innerHTML = cards.join('');
}

function coverageCard(c) {
  const chain = c.chain
    .map((step) => (step.present ? `<span class="${step.name === c.effectiveDirective ? 'hit' : ''}">${step.name}${step.present ? '✓' : ''}</span>` : `<span>${step.name}</span>`))
    .join(' → ');
  const tokens = c.effectiveSources
    .map((s) => `<span class="token ${s.breadth <= 20 ? 'broad' : ''}" title="规范化：${esc(s.canonical)}">${esc(s.raw)}</span>`)
    .join('');
  const invalid = c.chain
    .flatMap((s) => s.invalidTokens.map((t) => `<span class="token invalid" title="无法解析，已被浏览器忽略">${esc(t.raw)}</span>`))
    .join('');
  const notes = c.notes.map((n) => `<p class="note ${n.level}">• ${esc(n.text)}</p>`).join('');
  return `
  <div class="coverage-card ${c.covered ? '' : 'uncovered'}">
    <h3>${esc(c.label)} ${c.covered ? '' : '<span class="chip chip-warning">未覆盖</span>'}</h3>
    <div class="chain">回退链：${chain}</div>
    <div class="source-tokens">${tokens || '<span class="token">（无生效来源）</span>'}${invalid}</div>
    ${c.effectiveDirective ? `<p class="note">生效指令：<strong>${esc(c.effectiveDirective)}</strong>，模式：${esc(c.effectiveMode)}</p>` : ''}
    ${notes}
  </div>`;
}

// ---------- ④ 样例验证 ----------
function bindVerify() {
  $('#verify-type').addEventListener('change', toggleVerifyRows);
  $('#verify-inline').addEventListener('change', toggleVerifyRows);
  $('#verify-redirected').addEventListener('change', toggleVerifyRows);
  $('#btn-run-verify').addEventListener('click', runVerify);

  $('#btn-load-sample').addEventListener('click', () => {
    const names = DEMO_SAMPLES.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
    const pick = prompt(`输入要载入的样例序号：\n${names}`, '1');
    const idx = Number(pick) - 1;
    const sample = DEMO_SAMPLES[idx];
    if (!sample) return toast('序号无效', 'error');
    fillVerifyForm(sample);
  });
}

function toggleVerifyRows() {
  const type = $('#verify-type').value;
  const inlineCapable = INLINE_CAPABLE.has(type);
  if (!inlineCapable) $('#verify-inline').checked = false;
  const inline = $('#verify-inline').checked;
  $('#verify-inline-row').hidden = !inline;
  $('#verify-url-row').hidden = inline;
  $('#verify-trusted-line').hidden = !type.startsWith('script');
  $('#redirect-url-row').hidden = !$('#verify-redirected').checked;
}

function fillVerifyForm(s) {
  $('#verify-type').value = s.resourceType;
  $('#verify-inline').checked = !!s.inline;
  $('#verify-redirected').checked = !!s.redirected;
  $('#verify-url').value = s.url || '';
  $('#verify-redirect-url').value = s.redirectUrl || '';
  $('#verify-nonce').value = s.nonce || '';
  $('#verify-trusted').checked = !!s.trusted;
  toggleVerifyRows();
}

function runVerify() {
  const ids = [...$('#verify-policy-select').selectedOptions].map((o) => o.value);
  const policies = ids
    .map((id) => state.policies.find((p) => p.id === id))
    .filter(Boolean)
    .flatMap((p) => safeParse(p).policies);
  if (!policies.length) return toast('请至少选择一条被测策略', 'error');

  const sample = {
    resourceType: $('#verify-type').value,
    inline: $('#verify-inline').checked,
    redirected: $('#verify-redirected').checked,
    trusted: $('#verify-trusted').checked,
    url: $('#verify-url').value.trim(),
    redirectUrl: $('#verify-redirect-url').value.trim(),
    nonce: $('#verify-nonce').value.trim(),
    hashAlgo: $('#verify-hash-algo').value,
    hashValue: $('#verify-hash-value').value.trim(),
    documentOrigin: 'https://app.demo.local',
  };

  const verdict = evaluateSample(sample, policies);
  $('#verify-result').innerHTML = renderVerdict(verdict);
}

function renderVerdict(v) {
  const label = {
    blocked: '⛔ 拦截',
    allowed: '✅ 允许',
    'allowed-with-report': '✅ 允许（但报告策略会上报）',
    'allowed-report-only': '📋 允许加载，但产生违规报告',
    error: '⚠️ 输入错误',
  }[v.decision] || v.decision;
  const perPolicy = v.perPolicy
    .map((r) => {
      const traces = r.trace
        .map((t) => {
          const cls = t.includes('拒绝') || t.includes('忽略') ? 'deny' : t.includes('允许') || t.includes('命中') ? 'allow' : '';
          return `<div class="trace ${cls}">${esc(t)}</div>`;
        })
        .join('');
      return `
      <div class="policy-verdict">
        <h4>${esc(r.policyName)}（${r.mode === 'report-only' ? '报告模式' : '强制模式'}）→
          <span class="chip chip-${r.decision === 'allowed' ? 'ok' : r.decision === 'blocked' ? 'error' : 'warning'}">${r.decision}</span>
          ${r.directive ? `命中指令 <code>${esc(r.directive)}</code>` : '无适用指令'}
          ${r.matchedSource ? `匹配来源 <code>${esc(r.matchedSource)}</code>` : ''}
        </h4>
        <p class="note">${esc(r.reason)}</p>
        ${traces}
      </div>`;
    })
    .join('');

  return `
  <div class="verdict-box ${v.decision}">
    <p class="verdict-title">${label}</p>
    <p>${esc(v.reason)}</p>
    ${v.urlInfo ? `<p class="note">解析后的地址（仅本地解析，未访问）：<code>${esc(v.urlInfo.href)}</code> · 协议 ${esc(v.urlInfo.scheme)} · 主机 ${esc(v.urlInfo.host)}</p>` : ''}
    ${v.redirected ? '<p class="note warning">重定向场景：重定向前后两个地址都必须通过检查。</p>' : ''}
    ${perPolicy}
  </div>`;
}

// ---------- ⑤ 策略比较 ----------
function bindCompare() {
  $('#btn-run-compare').addEventListener('click', runCompare);
}

function runCompare() {
  const pa = state.policies.find((p) => p.id === $('#compare-a').value);
  const pb = state.policies.find((p) => p.id === $('#compare-b').value);
  const view = $('#compare-view');
  if (!pa || !pb) return toast('请选择两条策略', 'error');
  if (pa.id === pb.id) return toast('请选择两条不同的策略', 'error');

  const a = parsePolicy(pa.text, { mode: pa.mode, name: pa.name });
  const b = parsePolicy(pb.text, { mode: pb.mode, name: pb.name });
  const result = comparePolicies(a, b);

  const banner = result.modeChange ? `<div class="mode-banner">${esc(result.modeChange.label)}</div>` : '';
  const summary = `
    <div class="check-summary">
      <div class="summary-card"><div class="num">${result.summary.added}</div><div class="lbl">新增指令</div></div>
      <div class="summary-card"><div class="num">${result.summary.removed}</div><div class="lbl">删除指令</div></div>
      <div class="summary-card"><div class="num">${result.summary.modified}</div><div class="lbl">修改指令</div></div>
      <div class="summary-card"><div class="num" style="color:var(--danger)">${result.summary.loosened}</div><div class="lbl">放宽处</div></div>
      <div class="summary-card"><div class="num" style="color:var(--ok)">${result.summary.tightened}</div><div class="lbl">收紧处</div></div>
    </div>`;

  const rows = result.directiveDiffs
    .filter((d) => d.status !== 'unchanged')
    .map((d) => {
      const changes = d.changes
        .map(
          (c) =>
            `<div class="change-row change-${c.effect}">${c.directionLabel} <code>${esc(c.token)}</code>
              <span class="change-${c.effect}">[${c.effectLabel}]</span> — ${esc(c.reason)}</div>`
        )
        .join('');
      return `
      <tr class="${d.status}">
        <td><code>${esc(d.name)}</code><br><span class="chip chip-${d.status === 'added' ? 'ok' : d.status === 'removed' ? 'error' : 'warning'}">${d.statusLabel}</span></td>
        <td>${d.sourcesA.map(esc).join('<br>') || '—'}</td>
        <td>${d.sourcesB.map(esc).join('<br>') || '—'}${changes ? `<hr>${changes}` : ''}</td>
      </tr>`;
    })
    .join('');

  view.innerHTML =
    banner +
    summary +
    (rows
      ? `<table class="compare-table">
          <thead><tr><th>指令</th><th>${esc(pa.name)}（A）</th><th>${esc(pb.name)}（B）</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="storage-note">比较基于规范化后的来源集合，与输入顺序无关；无法解析的值以 ⚠ 标记且不计入放行。</p>`
      : '<div class="issue-card severity-info"><p class="issue-msg">两条策略在规范化后完全等价（输入顺序差异已被忽略）。</p></div>');
}

// ---------- 模态框 ----------
function bindModal() {
  const modal = $('#offline-modal');
  $('#link-offline-note').addEventListener('click', (e) => {
    e.preventDefault();
    modal.hidden = false;
  });
  $('#close-modal').addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
}

init();
