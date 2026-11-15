const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function api(path, options) {
  const res = await fetch(path, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtNum(n) { return Number(n ?? 0).toLocaleString('zh-CN'); }

function fmtTime(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19);
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// ---------- tab 切换 ----------
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  const view = tab.dataset.view;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'ingest') loadBatches();
  if (view === 'report') loadReport();
  if (view === 'orders') { loadCampaignOptions(); loadOrders(); }
}));

// ---------- 数据接入 ----------
$$('.pick-file').forEach((btn) => btn.addEventListener('click', () => {
  $(`.file-input[data-type="${btn.dataset.type}"]`).click();
}));

$$('.file-input').forEach((input) => input.addEventListener('change', async () => {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  try {
    const res = await fetch(`/api/ingest/${input.dataset.type}`, {
      method: 'POST',
      headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'text/csv' },
      body: file,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || `上传失败（${res.status}）`);
    renderIngestResult(input.dataset.type, data);
    toast(`已接收 ${file.name}：接受 ${data.accepted} 行`);
    loadBatches();
  } catch (err) {
    renderIngestResult(input.dataset.type, { fatal: err.message });
    toast(err.message, 'error');
  }
}));

const TYPE_LABEL = { clicks: '点击', payments: '付款', refunds: '退款' };

function renderIngestResult(type, r) {
  const box = $(`#result-${type}`);
  if (r.fatal) {
    box.innerHTML = `<div class="badge error">整文件拒绝</div><p class="err-text">${esc(r.fatal)}</p>`;
    return;
  }
  const badges = [
    `<span class="badge ok">接受 ${fmtNum(r.accepted)}</span>`,
    `<span class="badge warn">重复 ${fmtNum(r.duplicate)}</span>`,
    `<span class="badge ${r.errorRows ? 'error' : 'muted'}">错误 ${fmtNum(r.errorRows)}</span>`,
  ].join(' ');
  box.innerHTML = `${badges}<p class="hint">共 ${fmtNum(r.total)} 行 · ${TYPE_LABEL[type]}批次 #${r.batchId}</p>` +
    (r.errors?.length ? `<ul class="err-list">${r.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '');
}

async function loadBatches() {
  const body = $('#batches-body');
  try {
    const list = await api('/api/ingest/batches');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty">暂无上传记录</td></tr>';
      return;
    }
    body.innerHTML = list.map((b) => `
      <tr>
        <td>${b.id}</td>
        <td>${esc(TYPE_LABEL[b.recordType] ?? b.recordType)}</td>
        <td>${esc(b.originalName)}</td>
        <td class="num">${fmtNum(b.totalRows)}</td>
        <td class="num">${fmtNum(b.accepted)}</td>
        <td class="num">${fmtNum(b.duplicate)}</td>
        <td class="num">${fmtNum(b.errorRows)}</td>
        <td>${esc(fmtTime(b.createdAt))}</td>
        <td class="err-cell">${b.errors.length ? esc(b.errors.join('；')) : '—'}</td>
      </tr>`).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="9" class="empty">${esc(err.message)}</td></tr>`;
  }
}

// ---------- 归因报表 ----------
$('#report-mode').addEventListener('change', (e) => {
  const range = e.target.value === 'range';
  $('#label-date').classList.toggle('hidden', range);
  $('#label-start').classList.toggle('hidden', !range);
  $('#label-end').classList.toggle('hidden', !range);
});

function reportQuery() {
  if ($('#report-mode').value === 'range') {
    return new URLSearchParams({
      startDate: $('#report-start').value || todayStr(),
      endDate: $('#report-end').value || todayStr(),
    });
  }
  return new URLSearchParams({ date: $('#report-date').value || todayStr() });
}

async function loadReport() {
  const qs = reportQuery();
  $('#link-export-summary').href = `/api/exports/summary.csv?${qs}`;
  $('#link-export-detail').href = `/api/exports/orders.csv?${qs}`;
  try {
    const report = await api(`/api/reports?${qs}`);
    $('#report-range-hint').textContent = `区间 ${report.startDate} ~ ${report.endDate}，按付款日期统计；含零单活动与直接成交补零行。`;
    const head = ['付款日期', ...report.campaigns.map((c) => esc(c.campaignName))];
    const dayTables = report.rows.map((day) => {
      const gross = day.campaigns.map((c) => `<td class="num">${fmtNum(c.gross)}</td>`).join('');
      const refunded = day.campaigns.map((c) => `<td class="num${c.refunded ? ' neg' : ''}">${fmtNum(c.refunded)}</td>`).join('');
      const net = day.campaigns.map((c) => `<td class="num strong">${fmtNum(c.net)}</td>`).join('');
      return `
        <h3 class="day-title">${day.payDate}</h3>
        <table>
          <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
          <tbody>
            <tr><td>成交单数</td>${gross}</tr>
            <tr><td>退款单数</td>${refunded}</tr>
            <tr><td>净单数</td>${net}</tr>
          </tbody>
        </table>`;
    }).join('');
    const totalRow = report.totals.map((c) => `<td class="num strong">${fmtNum(c.net)}</td>`).join('');
    $('#report-tables').innerHTML = dayTables + `
      <h3 class="day-title">区间净单数合计</h3>
      <table>
        <thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
        <tbody><tr><td>净单数</td>${totalRow}</tr></tbody>
      </table>`;
  } catch (err) {
    $('#report-tables').innerHTML = `<p class="err-text">${esc(err.message)}</p>`;
  }
}

$('#btn-query-report').addEventListener('click', loadReport);

// ---------- 订单查询 ----------
async function loadCampaignOptions() {
  const sel = $('#order-campaign');
  const current = sel.value;
  const list = await api('/api/campaigns');
  sel.innerHTML = '<option value="">全部</option>' +
    '<option value="__direct__">直接成交</option>' +
    list.map((c) => `<option value="${esc(c.campaignId)}">${esc(c.campaignName)}</option>`).join('');
  sel.value = current;
}

async function loadOrders() {
  const qs = new URLSearchParams({
    q: $('#order-q').value.trim(),
    campaignId: $('#order-campaign').value,
    payDate: $('#order-paydate').value,
  });
  const body = $('#orders-body');
  try {
    const list = await api(`/api/orders?${qs}`);
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">没有符合条件的订单</td></tr>';
      return;
    }
    body.innerHTML = list.map((o) => `
      <tr>
        <td>${esc(o.orderId)}</td>
        <td>${esc(o.accountId)}</td>
        <td>${esc(fmtMs(o.paymentTimeMs))}</td>
        <td>${esc(o.payDate)}</td>
        <td>${esc(o.campaignName ?? '直接成交')}</td>
        <td>${esc(o.clickId ?? '—')}</td>
        <td>${o.refundId ? `<span class="badge error">已退 ${esc(o.refundId)}</span>` : '<span class="badge muted">未退款</span>'}</td>
        <td><button class="btn ghost small" data-order="${esc(o.orderId)}">查看时间线</button></td>
      </tr>`).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="8" class="empty">${esc(err.message)}</td></tr>`;
  }
}

$('#btn-query-orders').addEventListener('click', loadOrders);
$('#orders-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-order]');
  if (btn) openOrder(btn.dataset.order);
});

async function openOrder(orderId) {
  try {
    const d = await api(`/api/orders/${encodeURIComponent(orderId)}`);
    const o = d.order;
    $('#modal-title').textContent = `订单 ${o.orderId}`;
    $('#modal-body').innerHTML = `
      <dl class="facts">
        <dt>账号</dt><dd>${esc(o.accountId)}</dd>
        <dt>付款时间</dt><dd>${esc(fmtMs(o.paymentTimeMs))}（付款日期 ${esc(o.payDate)}）</dd>
        <dt>当前归因</dt><dd>${esc(o.campaignName ?? '直接成交')}${o.clickId ? `（点击 ${esc(o.clickId)}）` : ''}</dd>
        <dt>退款状态</dt><dd>${o.refundId ? `已整单退款 ${esc(o.refundId)}，退款时间 ${esc(fmtMs(o.refundTimeMs))}` : '未退款'}</dd>
      </dl>
      <h3>归因与退款时间线</h3>
      <ul class="timeline">
        ${d.timeline.map((t) => `
          <li class="tl-item ${esc(t.kind === '整单退款' ? 'refund' : t.kind === '归因改判' ? 'change' : 'init')}">
            <div class="tl-head">
              <span class="badge ${t.kind === '整单退款' ? 'error' : t.kind === '归因改判' ? 'warn' : 'ok'}">${esc(t.kind)}</span>
              <span class="tl-title">${esc(t.title)}</span>
              <span class="tl-time">${esc(fmtTime(t.at))}</span>
            </div>
            <p class="tl-detail">${esc(t.detail)}</p>
          </li>`).join('')}
      </ul>`;
    $('#modal-mask').classList.remove('hidden');
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#btn-close-modal').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
$('#modal-mask').addEventListener('click', (e) => {
  if (e.target.id === 'modal-mask') $('#modal-mask').classList.add('hidden');
});

// ---------- 初始化 ----------
$('#report-date').value = todayStr();
$('#report-start').value = todayStr();
$('#report-end').value = todayStr();
loadBatches();
