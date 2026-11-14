// 纯原生 JS 单页应用：批次接收 / 库存查询 / 历史批次
const $ = (sel) => document.querySelector(sel);

let currentDetail = null; // 当前打开的批次详情
let pendingUpload = null; // 待选文件的仓库上下文
let warehousesCache = [];

// ---------------- 通用 ----------------

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

let toastTimer;
function toast(msg, type = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n) {
  return Number(n).toLocaleString('zh-CN');
}
function fmtTime(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 19);
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------- 标签页 ----------------

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.view').forEach((v) =>
      v.classList.toggle('active', v.id === `view-${tab.dataset.view}`));
    if (tab.dataset.view === 'inventory') loadInventory();
    if (tab.dataset.view === 'history') loadHistory();
  });
});

// ---------------- 批次接收 ----------------

$('#date-input').value = todayStr();

$('#btn-open-batch').addEventListener('click', async () => {
  const date = $('#date-input').value;
  if (!date) return toast('请先选择盘点日期', 'error');
  try {
    const detail = await api('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ countDate: date }),
    });
    showBatch(detail);
  } catch (err) {
    toast(err.message, 'error');
  }
});

function showBatch(detail) {
  currentDetail = detail;
  $('#batch-panel').classList.remove('hidden');
  const { batch, expectedCount, submittedCount, allSubmitted } = detail;
  $('#batch-title').textContent = `${batch.countDate} 盘点批次`;
  const statusText = batch.status === 'published' ? '已发布' : '接收中';
  $('#batch-meta').textContent =
    `批次 #${batch.id} · ${statusText} · 应到 ${expectedCount} 仓，已交 ${submittedCount} 仓` +
    (batch.publishedAt ? ` · 发布于 ${fmtTime(batch.publishedAt)}` : '');

  const pct = expectedCount ? (submittedCount / expectedCount) * 100 : 0;
  const fill = $('.progress-fill');
  fill.style.width = `${pct}%`;
  fill.classList.toggle('done', allSubmitted);

  const published = batch.status === 'published';
  $('#btn-publish').disabled = published || !allSubmitted;
  $('#btn-publish').title = published
    ? '该批次已发布'
    : allSubmitted ? '' : '所有仓库交齐后才能发布';
  $('#btn-preview').disabled = submittedCount === 0;
  $('#receive-hint').textContent = published
    ? '该批次已发布并锁定，文件仅供下载，不能再替换。'
    : allSubmitted
      ? '全部交齐，可以预览后发布。'
      : '未收齐：可先预览新批次，库存查询仍展示上一次发布的数据。';

  $('#warehouse-tbody').innerHTML = detail.warehouses.map((w) => {
    let badge;
    if (w.status === 'missing') {
      badge = '<span class="badge missing">未交表</span>';
    } else if (w.isEmpty) {
      badge = '<span class="badge empty">零行表</span>';
    } else {
      badge = '<span class="badge ok">已交表</span>';
    }
    const action = published
      ? `<a class="btn small" href="/api/batches/${batch.id}/warehouses/${w.whCode}/file">下载原始文件</a>`
      : `<button class="btn small primary" data-act="upload" data-wh="${w.whCode}">
           ${w.status === 'missing' ? '上传 CSV' : `重新上传（v${w.version}）`}
         </button>`
         + (w.status === 'submitted'
            ? ` <a class="btn small" href="/api/batches/${batch.id}/warehouses/${w.whCode}/file">当前文件</a>`
            : '');
    return `<tr>
      <td>${esc(w.whCode)}</td>
      <td>${esc(w.whName)}</td>
      <td>${badge}</td>
      <td class="num">${fmtNum(w.itemCount)}${w.isEmpty ? ' <span class="hint">(零行)</span>' : ''}</td>
      <td class="num">${fmtNum(w.totalQuantity)}</td>
      <td>${fmtTime(w.receivedAt)}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');
}

$('#warehouse-tbody').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="upload"]');
  if (!btn || !currentDetail) return;
  pendingUpload = { batchId: currentDetail.batch.id, whCode: btn.dataset.wh };
  $('#file-input').click();
});

$('#file-input').addEventListener('change', async () => {
  const file = $('#file-input').files[0];
  $('#file-input').value = '';
  if (!file || !pendingUpload) return;
  const { batchId, whCode } = pendingUpload;
  try {
    const detail = await api(`/api/batches/${batchId}/warehouses/${whCode}/submission`, {
      method: 'PUT',
      headers: { 'X-Filename': encodeURIComponent(file.name), 'Content-Type': 'text/csv' },
      body: file,
    });
    toast(`${whCode} 的盘点表已接收（重交只替换该仓库草稿）`, 'success');
    showBatch(detail);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// 预览（收齐前也允许，只读）
$('#btn-preview').addEventListener('click', async () => {
  if (!currentDetail) return;
  try {
    const data = await api(`/api/batches/${currentDetail.batch.id}/preview`);
    openPreview(data);
  } catch (err) {
    toast(err.message, 'error');
  }
});

function openPreview(data) {
  const zero = data.warehouses.filter((w) => w.isEmpty).map((w) => w.whCode);
  $('#modal-summary').innerHTML =
    `草稿合计：<b>${fmtNum(data.totals.itemCount)}</b> 个商品、` +
    `<b>${fmtNum(data.totals.totalQuantity)}</b> 件库存；` +
    (zero.length ? `零行表仓库：${esc(zero.join('、'))}（库存按 0 处理）；` : '') +
    `共 ${data.previewItems.length} 行明细。<b>预览不会改变库存查询结果。</b>`;
  $('#modal-tbody').innerHTML = data.previewItems.length
    ? data.previewItems.map((it) => `<tr>
        <td>${esc(it.whCode)}</td><td>${esc(it.sku)}</td>
        <td>${esc(it.productName)}</td><td class="num">${fmtNum(it.quantity)}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="hint">当前草稿没有明细行（可能都是零行表）</td></tr>';
  $('#modal-mask').classList.remove('hidden');
}
$('#btn-modal-close').addEventListener('click', () => $('#modal-mask').classList.add('hidden'));
$('#modal-mask').addEventListener('click', (e) => {
  if (e.target === $('#modal-mask')) $('#modal-mask').classList.add('hidden');
});

// 手动发布
$('#btn-publish').addEventListener('click', async () => {
  if (!currentDetail) return;
  const ok = window.confirm(
    `确认发布 ${currentDetail.batch.countDate} 的盘点批次？\n` +
    '发布后库存查询会一次性切换到这一批数据，且各仓库文件将被锁定、不可再替换。'
  );
  if (!ok) return;
  try {
    const detail = await api(`/api/batches/${currentDetail.batch.id}/publish`, { method: 'POST' });
    toast('发布成功，库存查询已切换到新批次', 'success');
    showBatch(detail);
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ---------------- 库存查询 ----------------

async function loadWarehouses() {
  if (warehousesCache.length) return warehousesCache;
  const data = await api('/api/warehouses');
  warehousesCache = data.warehouses;
  $('#inv-wh').innerHTML = '<option value="">全部仓库</option>' +
    warehousesCache.map((w) => `<option value="${esc(w.code)}">${esc(w.name)}</option>`).join('');
  return warehousesCache;
}

async function loadInventory() {
  try {
    await loadWarehouses();
    const params = new URLSearchParams();
    const q = $('#inv-q').value.trim();
    const wh = $('#inv-wh').value;
    if (q) params.set('q', q);
    if (wh) params.set('whCode', wh);
    const [inv, batchList] = await Promise.all([
      api(`/api/inventory?${params.toString()}`),
      api('/api/batches'),
    ]);

    const collecting = batchList.batches.filter((b) => b.batch.status === 'collecting');
    const banner = $('#inv-banner');
    if (!inv.currentBatch) {
      banner.className = 'banner none';
      banner.textContent = '还没有发布过任何盘点批次，暂无库存数据。';
    } else {
      banner.className = 'banner live';
      banner.textContent =
        `当前库存来自 ${inv.currentBatch.countDate} 盘点批次（发布于 ${fmtTime(inv.currentBatch.publishedAt)}）` +
        (collecting.length ? `；另有 ${collecting.length} 个批次接收中，发布前本页数据不会变化。` : '。');
    }

    $('#inv-tbody').innerHTML = inv.items.length
      ? inv.items.map((it) => `<tr>
          <td>${esc(it.whCode)}</td><td>${esc(it.sku)}</td>
          <td>${esc(it.productName)}</td><td class="num">${fmtNum(it.quantity)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="hint">没有匹配的库存记录</td></tr>';
    $('#inv-footer').textContent = inv.items.length
      ? `显示 ${inv.totalRows} 行（上限 1000 行）`
      : '';
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#btn-query').addEventListener('click', loadInventory);
$('#inv-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadInventory(); });

// ---------------- 历史批次 ----------------

async function loadHistory() {
  try {
    const data = await api('/api/batches');
    $('#history-tbody').innerHTML = data.batches.length
      ? data.batches.map((b) => {
          const files = b.warehouses
            .filter((w) => w.status === 'submitted')
            .map((w) => `<a class="btn small" style="margin:2px"
                 href="/api/batches/${b.batch.id}/warehouses/${w.whCode}/file">
                 ${esc(w.whCode)}${w.isEmpty ? '（零行表）' : ''} · v${w.version}</a>`)
            .join('');
          const missing = b.warehouses.filter((w) => w.status === 'missing').map((w) => w.whCode);
          return `<tr>
            <td><b>${esc(b.batch.countDate)}</b></td>
            <td><span class="badge ${b.batch.status}">${b.batch.status === 'published' ? '已发布' : '接收中'}</span></td>
            <td>${b.submittedCount}/${b.expectedCount}${missing.length ? ` <span class="hint">缺：${esc(missing.join('、'))}</span>` : ''}</td>
            <td class="hint">建：${fmtTime(b.batch.createdAt)}<br>发：${fmtTime(b.batch.publishedAt)}</td>
            <td>${files || '<span class="hint">暂无交表</span>'}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="5" class="hint">还没有任何批次</td></tr>';
  } catch (err) {
    toast(err.message, 'error');
  }
}
