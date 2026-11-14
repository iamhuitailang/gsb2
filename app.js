/* 展会报名/到场归并工作台 —— 纯前端实现，数据保存在浏览器 localStorage */
'use strict';

// ---------- 字段整理（规范化） ----------
function normText(s) {
  return (s || '')
    .replace(/[　\s]+/g, ' ')          // 全角/半角空白统一
    .trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch =>  // 全角英数转半角
      String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}
function normName(s) { return normText(s); }
function normEmail(s) { return normText(s).toLowerCase(); }
// 单位匹配键：去掉常见公司后缀，使“云杉科技”与“云杉科技有限公司”视为同一单位
function normOrgKey(s) {
  return normText(s)
    .replace(/[\s·・,，.。()（）-]/g, '')
    .replace(/(有限责任公司|股份有限公司|有限公司|集团公司|集团|公司)$/, '')
    .toLowerCase();
}

// ---------- CSV 解析（支持引号包裹） ----------
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  text = text.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

function csvToRecords(text, source) {
  const rows = parseCSV(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => normText(h));
  const col = names => names.map(n => header.indexOf(n)).find(i => i >= 0);
  const iName = col(['姓名', 'name', 'Name']);
  const iOrg = col(['单位', '公司', 'org', 'company']);
  const iEmail = col(['邮箱', 'email', 'Email', '邮件']);
  if (iName === undefined) throw new Error('CSV 缺少“姓名”列');
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const name = rows[r][iName] || '';
    if (!normText(name)) continue;
    const org = iOrg === undefined ? '' : (rows[r][iOrg] || '');
    const email = iEmail === undefined ? '' : (rows[r][iEmail] || '');
    const rec = {
      source,
      row: r + 1,
      name: normText(name),
      org: normText(org),
      email: normText(email),
      nName: normName(name),
      nEmail: normEmail(email),
      nOrgKey: normOrgKey(org),
    };
    // 指纹：同一张表再次导入时内容一致 → 指纹一致 → 已确认的决定继续生效
    rec.fp = [source, rec.nName, rec.nEmail, rec.nOrgKey].join('::');
    out.push(rec);
  }
  return out;
}

// ---------- 状态 ----------
const LS_DECISIONS = 'expoMerge.decisions.v1';
const LS_TABLES = 'expoMerge.tables.v1';

const state = {
  records: [],          // 全部原始记录（永不删除）
  decisions: {},        // clusterKey -> 'merge' | 'split'
  persons: [],          // 归并后的人
  pending: [],          // 待人工确认的候选簇
  autoMerged: [],       // 自动合并成的人
  decided: [],          // 已人工处理的簇（含结果）
  peopleFilter: 'all',
  tables: { reg: null, onsite: null }, // 原始 CSV 文本
};

function loadState() {
  try { state.decisions = JSON.parse(localStorage.getItem(LS_DECISIONS)) || {}; }
  catch { state.decisions = {}; }
  try { state.tables = JSON.parse(localStorage.getItem(LS_TABLES)) || { reg: null, onsite: null }; }
  catch { state.tables = { reg: null, onsite: null }; }
}
function saveDecisions() { localStorage.setItem(LS_DECISIONS, JSON.stringify(state.decisions)); }
function saveTables() { localStorage.setItem(LS_TABLES, JSON.stringify(state.tables)); }

function clusterKey(records) {
  return records.map(r => r.fp).sort().join('‖');
}

// ---------- 归并核心 ----------
function rebuild() {
  // 重新导入时从原始 CSV 重建记录
  state.records = [];
  for (const src of ['reg', 'onsite']) {
    if (state.tables[src]) {
      state.records.push(...csvToRecords(state.tables[src], src));
    }
  }

  state.persons = [];
  state.pending = [];
  state.autoMerged = [];
  state.decided = [];

  const assigned = new Set();
  const byEmail = new Map();
  for (const r of state.records) {
    if (!r.nEmail) continue;
    if (!byEmail.has(r.nEmail)) byEmail.set(r.nEmail, []);
    byEmail.get(r.nEmail).push(r);
  }

  const rest = [];
  // 第一步：邮箱一致且只对应一人 → 自动合并
  for (const recs of byEmail.values()) {
    const names = new Set(recs.map(r => r.nName));
    if (recs.length > 1 && names.size === 1) {
      const p = makePerson(recs, 'auto');
      state.persons.push(p);
      state.autoMerged.push(p);
      recs.forEach(r => assigned.add(r));
    } else if (recs.length > 1) {
      // 邮箱相同但姓名不同 → 也需人工确认
      rest.push(...recs);
    } else {
      rest.push(recs[0]);
    }
  }
  rest.push(...state.records.filter(r => !r.nEmail && !assigned.has(r)));

  // 第二步：剩余记录按姓名分组，同名多于一条 → 候选簇
  const byName = new Map();
  for (const r of rest) {
    if (assigned.has(r)) continue;
    if (!byName.has(r.nName)) byName.set(r.nName, []);
    byName.get(r.nName).push(r);
  }
  for (const recs of byName.values()) {
    if (recs.length === 1) {
      state.persons.push(makePerson(recs, 'single'));
      continue;
    }
    const key = clusterKey(recs);
    const decision = state.decisions[key];
    const cluster = { key, records: recs, hints: matchHints(recs), sameNameAuto: null };
    // 提示：是否存在同名但已通过邮箱自动合并的人（同名不同人的典型情况）
    const auto = state.autoMerged.find(p => p.records.some(r => r.nName === recs[0].nName));
    if (auto) cluster.sameNameAuto = auto;
    if (decision === 'merge') {
      const p = makePerson(recs, 'manual-merge');
      state.persons.push(p);
      state.decided.push({ ...cluster, result: 'merge', person: p });
    } else if (decision === 'split') {
      const ps = recs.map(r => makePerson([r], 'manual-split'));
      state.persons.push(...ps);
      state.decided.push({ ...cluster, result: 'split', persons: ps });
    } else {
      state.pending.push(cluster);
    }
  }
}

let personSeq = 0;
function makePerson(records, origin) {
  const reg = records.filter(r => r.source === 'reg');
  const onsite = records.filter(r => r.source === 'onsite');
  return {
    id: 'p' + (++personSeq),
    records,
    origin,
    name: records[0].name,
    orgs: [...new Set(records.map(r => r.org).filter(Boolean))],
    emails: [...new Set(records.map(r => r.email).filter(Boolean))],
    registered: reg.length > 0,
    attended: onsite.length > 0,
  };
}

// 候选簇的字段匹配情况
function matchHints(recs) {
  const hints = [];
  const names = new Set(recs.map(r => r.nName));
  hints.push({ field: '姓名', match: names.size === 1, detail: names.size === 1 ? '相同' : '不同' });
  const orgs = new Set(recs.map(r => r.nOrgKey).filter(Boolean));
  if (orgs.size === 0) hints.push({ field: '单位', match: null, detail: '均缺失' });
  else if (orgs.size === 1) {
    const exact = new Set(recs.map(r => r.org)).size === 1;
    hints.push({ field: '单位', match: true, detail: exact ? '相同' : '写法不同但视为同一单位' });
  } else hints.push({ field: '单位', match: false, detail: '不同' });
  const emails = recs.map(r => r.nEmail);
  const filled = new Set(emails.filter(Boolean));
  if (emails.every(e => !e)) hints.push({ field: '邮箱', match: null, detail: '均缺失' });
  else if (emails.some(e => !e)) hints.push({ field: '邮箱', match: null, detail: '部分缺失' });
  else if (filled.size === 1) hints.push({ field: '邮箱', match: true, detail: '相同' });
  else hints.push({ field: '邮箱', match: false, detail: '不同' });
  return hints;
}

// ---------- 渲染 ----------
const $ = sel => document.querySelector(sel);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const SOURCE_LABEL = { reg: '报名表', onsite: '现场登记表' };
const ORIGIN_LABEL = {
  auto: '邮箱自动合并', single: '无冲突单独成员',
  'manual-merge': '人工确认合并', 'manual-split': '人工确认分开',
};

function recordsTable(records) {
  return `<table><thead><tr><th>来源</th><th>行号</th><th>姓名</th><th>单位</th><th>邮箱</th></tr></thead><tbody>` +
    records.map(r => `<tr><td>${SOURCE_LABEL[r.source]}</td><td>${r.row}</td>` +
      `<td>${esc(r.name)}</td><td>${esc(r.org) || '—'}</td><td>${esc(r.email) || '—'}</td></tr>`).join('') +
    `</tbody></table>`;
}

function hintBadges(hints) {
  return hints.map(h => {
    const cls = h.match === true ? 'ok' : h.match === false ? 'bad' : 'warn';
    return `<span class="hint-badge ${cls}">${h.field}：${h.detail}</span>`;
  }).join(' ');
}

function renderAll() {
  renderImport(); renderMerge(); renderStats(); renderPeople(); renderExport();
}

function renderImport() {
  $('#status-reg').textContent = state.tables.reg
    ? `已导入 ${state.records.filter(r => r.source === 'reg').length} 条` : '未导入';
  $('#status-onsite').textContent = state.tables.onsite
    ? `已导入 ${state.records.filter(r => r.source === 'onsite').length} 条` : '未导入';
  $('#import-preview').innerHTML = state.records.length
    ? recordsTable(state.records) : '<p class="hint">暂无记录</p>';
}

function renderMerge() {
  const n = state.pending.length;
  $('#pending-count').textContent = n;
  const badge = $('#badge-pending');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);

  $('#candidate-list').innerHTML = n ? state.pending.map((c, i) => `
    <div class="card candidate">
      <div class="candidate-head">
        <strong>候选 ${i + 1}：${esc(c.records[0].name)}（${c.records.length} 条记录）</strong>
        <span>${hintBadges(c.hints)}</span>
      </div>
      ${c.sameNameAuto ? `<p class="warn-text">注意：另有一名同名的「${esc(c.sameNameAuto.name)}」（${esc(c.sameNameAuto.orgs.join('、'))}）已通过邮箱自动合并，请留意是否为同名不同人。</p>` : ''}
      ${recordsTable(c.records)}
      <div class="actions">
        <button class="primary" onclick="decide(${i}, 'merge')">是同一人，合并</button>
        <button onclick="decide(${i}, 'split')">不是同一人，分开</button>
      </div>
    </div>`).join('') : '<p class="hint">没有待确认的候选。</p>';

  $('#auto-list').innerHTML = state.autoMerged.length
    ? state.autoMerged.map(p => `
      <div class="card">
        <strong>${esc(p.name)}</strong>（${esc(p.emails.join('、'))}）
        — ${p.records.length} 条记录自动合并
        ${recordsTable(p.records)}
      </div>`).join('')
    : '<p class="hint">暂无自动合并。</p>';

  $('#decided-list').innerHTML = state.decided.length
    ? state.decided.map((c, i) => `
      <div class="card">
        <strong>${esc(c.records[0].name)}</strong> — ${c.result === 'merge' ? '已确认为同一人（合并）' : '已确认为不同人（分开）'}
        ${recordsTable(c.records)}
        <div class="actions"><button onclick="undecide(${i})">撤销决定，重新确认</button></div>
      </div>`).join('')
    : '<p class="hint">暂无人工处理记录。</p>';
}

function renderStats() {
  const reg = state.persons.filter(p => p.registered);
  const att = state.persons.filter(p => p.attended);
  $('#stat-registered').textContent = reg.length;
  $('#stat-attended').textContent = att.length;
  $('#stat-absent').textContent = reg.filter(p => !p.attended).length;
  $('#stat-walkin').textContent = att.filter(p => !p.registered).length;
  $('#stat-rate').textContent = reg.length
    ? (att.filter(p => p.registered).length / reg.length * 100).toFixed(1) + '%'
    : '—';
  const note = $('#stat-pending-note');
  if (state.pending.length) {
    note.textContent = `注意：还有 ${state.pending.length} 组候选未确认，确认后以上数字可能变化。`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
  }
}

function personMatches(p, f) {
  if (f === 'registered') return p.registered;
  if (f === 'attended') return p.attended;
  if (f === 'absent') return p.registered && !p.attended;
  if (f === 'walkin') return p.attended && !p.registered;
  return true;
}

function renderPeople() {
  const FILTER_LABEL = { all: '全部人员', registered: '已报名', attended: '已到场', absent: '报名未到场', walkin: '现场报名' };
  const list = state.persons.filter(p => personMatches(p, state.peopleFilter));
  $('#people-filter').innerHTML =
    `当前筛选：<strong>${FILTER_LABEL[state.peopleFilter]}</strong>（${list.length} 人） ` +
    (state.peopleFilter !== 'all' ? `<a href="#" onclick="setFilter('all');return false;">清除筛选</a>` : '');
  $('#people-list').innerHTML = list.length
    ? `<table><thead><tr><th>姓名</th><th>单位</th><th>邮箱</th><th>报名</th><th>到场</th><th>归并方式</th><th></th></tr></thead><tbody>` +
      list.map(p => `<tr>
        <td>${esc(p.name)}</td>
        <td>${esc(p.orgs.join('、')) || '—'}</td>
        <td>${esc(p.emails.join('、')) || '—'}</td>
        <td>${p.registered ? '✓' : '—'}</td>
        <td>${p.attended ? '✓' : '—'}</td>
        <td>${ORIGIN_LABEL[p.origin]}</td>
        <td><button onclick="showPerson('${p.id}')">来源记录</button></td>
      </tr>`).join('') + `</tbody></table>`
    : '<p class="hint">暂无人员。</p>';
}

function renderExport() {
  $('#export-preview').innerHTML = state.persons.length
    ? `<table><thead><tr><th>姓名</th><th>单位</th><th>邮箱</th><th>是否报名</th><th>是否到场</th><th>来源记录数</th></tr></thead><tbody>` +
      state.persons.map(p => `<tr><td>${esc(p.name)}</td><td>${esc(p.orgs.join('、'))}</td>` +
        `<td>${esc(p.emails.join('、'))}</td><td>${p.registered ? '是' : '否'}</td>` +
        `<td>${p.attended ? '是' : '否'}</td><td>${p.records.length}</td></tr>`).join('') +
      `</tbody></table>`
    : '<p class="hint">暂无数据。</p>';
}

// ---------- 交互 ----------
window.decide = (idx, result) => {
  const c = state.pending[idx];
  state.decisions[c.key] = result;
  saveDecisions();
  rebuild(); renderAll();
};

window.undecide = idx => {
  const c = state.decided[idx];
  delete state.decisions[c.key];
  saveDecisions();
  rebuild(); renderAll();
};

window.setFilter = f => { state.peopleFilter = f; renderPeople(); };

window.showPerson = id => {
  const p = state.persons.find(x => x.id === id);
  if (!p) return;
  $('#person-detail-body').innerHTML = `
    <p><strong>${esc(p.name)}</strong> — ${ORIGIN_LABEL[p.origin]}；
    ${p.registered ? '已报名' : '未报名'}；${p.attended ? '已到场' : '未到场'}</p>
    <p class="hint">以下 ${p.records.length} 条原始记录全部保留，未做修改：</p>
    ${recordsTable(p.records)}`;
  $('#person-detail').classList.remove('hidden');
  $('#person-detail').scrollIntoView({ behavior: 'smooth' });
};

function importFile(input, source) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      csvToRecords(reader.result, source); // 先校验
      state.tables[source] = reader.result;
      saveTables();
      rebuild(); renderAll();
    } catch (e) {
      alert(`导入失败：${e.message}`);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function exportCSV() {
  const header = ['姓名', '单位', '邮箱', '是否报名', '是否到场', '来源记录数', '归并方式'];
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [header.map(q).join(',')].concat(
    state.persons.map(p => [
      p.name, p.orgs.join('、'), p.emails.join('、'),
      p.registered ? '是' : '否', p.attended ? '是' : '否',
      p.records.length, ORIGIN_LABEL[p.origin],
    ].map(q).join(','))
  );
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '归并后人员清单.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- 初始化 ----------
function init() {
  loadState();
  rebuild();
  renderAll();

  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('#tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.querySelectorAll('.stat-card').forEach(card => {
    card.addEventListener('click', () => {
      state.peopleFilter = card.dataset.filter;
      renderPeople();
      document.querySelector('.tab[data-tab="people"]').click();
    });
  });

  $('#file-reg').addEventListener('change', e => importFile(e.target, 'reg'));
  $('#file-onsite').addEventListener('change', e => importFile(e.target, 'onsite'));

  $('#btn-demo').addEventListener('click', () => {
    state.tables = { reg: DEMO_REG_CSV, onsite: DEMO_ONSITE_CSV };
    saveTables();
    rebuild(); renderAll();
  });

  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('确定清空全部数据和已确认的归并决定？')) return;
    localStorage.removeItem(LS_DECISIONS);
    localStorage.removeItem(LS_TABLES);
    state.decisions = {};
    state.tables = { reg: null, onsite: null };
    rebuild(); renderAll();
  });

  $('#btn-export').addEventListener('click', exportCSV);
  $('#btn-close-detail').addEventListener('click', () => $('#person-detail').classList.add('hidden'));
}

document.addEventListener('DOMContentLoaded', init);
