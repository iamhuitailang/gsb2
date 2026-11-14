const $ = (id) => document.getElementById(id);
const STATUS_TEXT = { running: '进行中', paused: '已暂停', done: '已完成', failed: '失败' };

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function showError(elId, err) {
  const el = $(elId);
  if (!err) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 5000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

// ---------- 供应商状态 ----------
async function refreshSupplier() {
  try {
    const s = await api('/api/supplier/status');
    $('supplier-status').innerHTML = `
      <span class="k">已发布批次</span><span>${s.publishedBatches} / ${s.totalBatches}</span>
      <span class="k">目录商品数</span><span>${s.productCount}</span>
      <span class="k">最大版本号</span><span class="mono">v${s.maxVersion}</span>
      <span class="k">下一批</span><span>${s.hasNextBatch ? '可发布' : '暂无'}</span>`;
    $('btn-publish').disabled = !s.hasNextBatch;
    $('batch-list').innerHTML = s.batches.map((b) =>
      `<li>第 ${b.batch_no} 批 · ${fmtTime(b.published_at)} · ${b.change_count} 条 · ${escapeHtml(b.note)}</li>`
    ).join('');
  } catch (err) {
    showError('supplier-error', err);
  }
}

// ---------- 同步任务 ----------
function renderRun(run) {
  const panel = $('run-panel');
  if (!run) {
    panel.innerHTML = '<div class="muted">暂无任务，点击下方按钮开始首轮全量同步。</div>';
    $('btn-pause').hidden = true;
    $('btn-resume').hidden = true;
    return;
  }
  panel.innerHTML = `
    <div class="kv">
      <span class="k">任务编号</span><span>#${run.id}
        <span class="badge ${run.mode}">${run.mode === 'full' ? '全量' : '增量'}</span>
        <span class="badge ${run.status}">${STATUS_TEXT[run.status]}</span></span>
      <span class="k">水位线</span><span class="mono">since_version = ${run.since_version}</span>
      <span class="k">下一页游标</span><span><code>${run.next_cursor ?? '（空 = 下一页是第 1 页）'}</code></span>
      <span class="k">接着跑的位置</span><span>已写完 <b>${run.pages_done}</b> 页，从该游标继续拉下一页</span>
    </div>
    <div class="stat-row">
      <div class="stat pg"><div class="num">${run.pages_done}</div><div class="lbl">已完成页</div></div>
      <div class="stat"><div class="num">${run.fetched_rows}</div><div class="lbl">接口返回行</div></div>
      <div class="stat ins"><div class="num">${run.inserted_count}</div><div class="lbl">实际新增</div></div>
      <div class="stat upd"><div class="num">${run.updated_count}</div><div class="lbl">实际更新</div></div>
      <div class="stat skp"><div class="num">${run.skipped_count}</div><div class="lbl">旧版跳过</div></div>
    </div>
    ${run.error ? `<div class="error">${escapeHtml(run.error)}</div>` : ''}
    <div class="muted">开始 ${fmtTime(run.started_at)} · 最近更新 ${fmtTime(run.updated_at)} · 结束 ${fmtTime(run.finished_at)}</div>`;

  $('btn-pause').hidden = run.status !== 'running';
  $('btn-resume').hidden = !(run.status === 'paused' || run.status === 'failed');
  $('btn-resume').textContent = run.status === 'failed' ? '重试该任务' : '继续';
}

async function refreshRun() {
  try {
    const { activeRun } = await api('/api/console/stats');
    renderRun(activeRun);
  } catch (err) {
    showError('sync-error', err);
  }
}

async function refreshRuns() {
  const { runs } = await api('/api/console/runs');
  $('runs-body').innerHTML = runs.map((r) => `
    <tr>
      <td>#${r.id}</td>
      <td><span class="badge ${r.mode}">${r.mode === 'full' ? '全量' : '增量'}</span></td>
      <td><span class="badge ${r.status}">${STATUS_TEXT[r.status]}</span></td>
      <td class="num">${r.pages_done}</td>
      <td class="num">${r.fetched_rows}</td>
      <td class="num">${r.inserted_count}</td>
      <td class="num">${r.updated_count}</td>
      <td class="num">${r.skipped_count}</td>
      <td>${fmtTime(r.started_at)}</td>
      <td>${fmtTime(r.finished_at)}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="muted">暂无记录</td></tr>';
}

// ---------- 本地目录 ----------
async function refreshProducts() {
  const keyword = $('keyword').value.trim();
  const { products } = await api(`/api/console/products?keyword=${encodeURIComponent(keyword)}`);
  const { catalog } = await api('/api/console/stats');
  $('products-body').innerHTML = products.map((p) => `
    <tr>
      <td class="mono">${escapeHtml(p.sku)}</td>
      <td>${escapeHtml(p.name)}</td>
      <td class="num">¥${p.price.toFixed(2)}</td>
      <td class="num mono">v${p.source_version}</td>
      <td>${fmtTime(p.updated_at)}</td>
      <td>${fmtTime(p.synced_at)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">没有匹配的商品</td></tr>';
  $('catalog-summary').textContent =
    `本地共 ${catalog.product_count} 个商品 · 已同步水位线 v${catalog.lastSyncedVersion}`;
}

async function refreshAll() {
  await Promise.all([refreshSupplier(), refreshRun(), refreshRuns(), refreshProducts()]);
}

// ---------- 事件 ----------
$('btn-publish').addEventListener('click', async () => {
  try {
    await api('/api/supplier/publish-next', { method: 'POST' });
    await refreshSupplier();
  } catch (err) {
    showError('supplier-error', err);
  }
});

$('btn-start').addEventListener('click', async () => {
  try {
    await api('/api/console/sync/start', { method: 'POST' });
    await refreshRun();
  } catch (err) {
    showError('sync-error', err);
  }
});

$('btn-pause').addEventListener('click', async () => {
  const { activeRun } = await api('/api/console/stats');
  if (!activeRun) return;
  try {
    await api(`/api/console/sync/${activeRun.id}/pause`, { method: 'POST' });
    await refreshRun();
  } catch (err) {
    showError('sync-error', err);
  }
});

$('btn-resume').addEventListener('click', async () => {
  const { activeRun } = await api('/api/console/stats');
  if (!activeRun) return;
  try {
    await api(`/api/console/sync/${activeRun.id}/resume`, { method: 'POST' });
    await refreshRun();
  } catch (err) {
    showError('sync-error', err);
  }
});

$('btn-search').addEventListener('click', refreshProducts);
$('keyword').addEventListener('keydown', (e) => { if (e.key === 'Enter') refreshProducts(); });

refreshAll();
// 同步进行/暂停时 1s 轮询，方便观察一页一页推进；页面静止时开销也很小
setInterval(() => { refreshRun(); refreshRuns(); refreshProducts(); }, 1000);
