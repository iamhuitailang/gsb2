/* app.js — 页面控制器。依赖 trace.js / graph.js / sample-data.js（普通 script 加载）。 */
(function () {
  'use strict';

  // 显式取全局依赖（普通 <script> 加载，浏览器与测试沙箱均可解析）
  const Trace = window.Trace;
  const Graph = window.Graph;
  const SampleData = window.SampleData;

  const STORE_KEY = 'food-trace:ledgers:v1';
  const SNAP_KEY = 'food-trace:snapshots:v1';

  const state = {
    data: null,          // 当前台账 { materials, production, outbound, corrections }
    lastResult: null,    // 最近一次追溯结果（实时）
    lastQuery: null,     // 最近查询的原料批次
    viewingSnapshot: false,
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
  }

  // ---------- 持久化 ----------
  function saveLedgers() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.data));
  }
  function loadLedgers() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {
      console.warn('本地台账读取失败，回退示例数据', e);
    }
    return SampleData.fullLedger();
  }
  function loadSnapshots() {
    try {
      return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }
  function saveSnapshots(list) {
    localStorage.setItem(SNAP_KEY, JSON.stringify(list));
  }

  // ---------- 表格渲染 ----------
  function table(el, columns, rows, rowId) {
    const head = '<tr>' + columns.map((c) => `<th>${escapeHtml(c.title)}</th>`).join('') + '</tr>';
    const body = rows
      .map((row, idx) => {
        const id = rowId ? rowId(row) : `r${idx}`;
        const tds = columns
          .map((c) => `<td class="${c.noStrike && row._revoked ? 'nostrike' : ''}">${c.cell(row)}</td>`)
          .join('');
        return `<tr id="${escapeHtml(id)}" class="${row._revoked ? 'revoked' : ''}">${tds}</tr>`;
      })
      .join('');
    el.innerHTML = '<thead>' + head + '</thead><tbody>' + body + '</tbody>';
  }

  function renderLedgers() {
    const d = state.data;
    const revokedIds = new Set(d.corrections.filter((c) => c.type === 'revoke').map((c) => c.detailId));
    const detailById = new Map(d.outbound.map((o) => [o.id, o]));

    table(
      $('tbl-materials'),
      [
        { title: '原料批次', cell: (r) => `<b>${escapeHtml(r.batchId)}</b>` },
        { title: '名称', cell: (r) => escapeHtml(r.name) },
        { title: '供应商', cell: (r) => escapeHtml(r.supplier) },
        { title: '入库日期', cell: (r) => escapeHtml(r.inboundDate) },
        { title: '数量(kg)', cell: (r) => r.qty },
      ],
      d.materials,
      (r) => `row-mat-${r.batchId}`
    );

    table(
      $('tbl-production'),
      [
        { title: '生产批号', cell: (r) => `<b>${escapeHtml(r.id)}</b>` },
        { title: '产出批次', cell: (r) => escapeHtml(r.outputBatch) },
        { title: '阶段', cell: (r) => escapeHtml(r.stage) },
        { title: '投入批次', cell: (r) => (r.inputs || []).map(escapeHtml).join('、') },
        { title: '产出日期', cell: (r) => escapeHtml(r.outputDate) },
        { title: '备注', cell: (r) => escapeHtml(r.note || '') },
      ],
      d.production,
      (r) => `row-prd-${r.id}`
    );

    const outRows = d.outbound.map((r) => ({ ...r, _revoked: revokedIds.has(r.id) }));
    table(
      $('tbl-outbound'),
      [
        { title: '明细号', cell: (r) => `<b>${escapeHtml(r.id)}</b>${r._revoked ? ' <span class="badge revoked">已撤销</span>' : ''}`, noStrike: true },
        { title: '出库单', cell: (r) => escapeHtml(r.orderNo) },
        { title: '成品批次', cell: (r) => escapeHtml(r.productBatch) },
        { title: '件数', cell: (r) => r.qty },
        { title: '发货日期', cell: (r) => escapeHtml(r.shipDate) },
        { title: '客户', cell: (r) => escapeHtml(r.customer) },
        {
          title: '操作',
          noStrike: true,
          cell: (r) =>
            r._revoked
              ? '<span class="hint">已更正撤销</span>'
              : `<button data-act="revoke" data-id="${escapeHtml(r.id)}">撤销此明细</button>`,
        },
      ],
      outRows,
      (r) => `row-out-${r.id}`
    );

    const corrRows = d.corrections.map((c) => {
      const detail = detailById.get(c.detailId);
      return { ...c, _detail: detail };
    });
    table(
      $('tbl-corrections'),
      [
        { title: '更正号', cell: (r) => `<b>${escapeHtml(r.id)}</b>` },
        { title: '类型', cell: (r) => '撤销旧明细' },
        { title: '被撤销明细', cell: (r) => escapeHtml(r.detailId) },
        { title: '涉及出库单', cell: (r) => escapeHtml(r._detail?.orderNo || '—') },
        { title: '日期', cell: (r) => escapeHtml(r.date) },
        { title: '原因', cell: (r) => escapeHtml(r.reason || '') },
        { title: '操作', cell: (r) => `<button data-act="restore" data-id="${escapeHtml(r.id)}">恢复明细</button>` },
      ],
      corrRows,
      (r) => `row-cor-${r.id}`
    );

    // 台账状态
    const activeQty = d.outbound.filter((o) => !revokedIds.has(o.id)).reduce((s, o) => s + o.qty, 0);
    $('ledger-status').innerHTML =
      `原料 <b>${d.materials.length}</b> 批 · 生产 <b>${d.production.length}</b> 批 · ` +
      `出库明细 <b>${d.outbound.length}</b> 条（有效 ${d.outbound.length - revokedIds.size} 条 / 共 ${activeQty} 件）· ` +
      `更正 <b>${d.corrections.length}</b> 条`;

    // 原料下拉
    const sel = $('query-batch');
    const prev = sel.value;
    sel.innerHTML = d.materials.map((m) => `<option value="${escapeHtml(m.batchId)}">${escapeHtml(m.batchId)}（${escapeHtml(m.name)}）</option>`).join('');
    if (prev && d.materials.some((m) => m.batchId === prev)) sel.value = prev;
  }

  // ---------- 缺失关联 ----------
  function renderGlobalMissing() {
    const panel = $('missing-panel');
    const missing = Trace.findGlobalMissing(state.data);
    if (!missing.length) {
      panel.classList.add('hidden');
      panel.innerHTML = '';
      return;
    }
    panel.classList.remove('hidden');
    panel.innerHTML =
      `<h2>⚠️ 台账后到：发现 ${missing.length} 处缺失关联</h2><ul>` +
      missing.map((m) => `<li>${escapeHtml(m.message)}</li>`).join('') +
      `</ul><button id="btn-refill-recalc">补齐后重算当前追溯</button>`;
    $('btn-refill-recalc').addEventListener('click', runTrace);
  }

  // ---------- 追溯 ----------
  function runTrace() {
    const batch = $('query-batch').value;
    if (!batch) {
      toast('请先选择原料批次');
      return;
    }
    state.lastQuery = batch;
    state.viewingSnapshot = false;
    state.lastResult = Trace.trace(batch, state.data);
    renderResult(state.lastResult, { live: true });
    $('btn-save-snapshot').disabled = false;
  }

  function pathText(path) {
    return path.map((id) => escapeHtml(id)).join(' <span class="arrow">→</span> ');
  }

  function renderResult(result, opts) {
    const panel = $('result-panel');
    const d = state.data;
    const missingBatches = new Set(result.missing.map((m) => m.batch));

    const s = result.stats;
    const banner = opts.snapshot
      ? `<div class="snapshot-banner">
           <span>📦 正在查看历史快照（保存于 ${escapeHtml(opts.savedAt)}）· 当时范围不随后续更正变化</span>
           <button id="btn-back-live">返回实时结果</button>
         </div>`
      : '';

    const missingHtml = result.missing.length
      ? `<div class="missing" style="margin:0 0 10px">
           <h2>⚠️ 该追溯范围内有 ${result.missing.length} 处关联缺失</h2>
           <ul>${result.missing.map((m) => `<li>${escapeHtml(m.message)}</li>`).join('')}</ul>
         </div>`
      : '';

    panel.innerHTML = '';
    if (banner) panel.insertAdjacentHTML('beforeend', banner);
    panel.insertAdjacentHTML(
      'beforeend',
      `<h2>原料批次 ${escapeHtml(result.materialBatchId)} 的追溯结果${opts.snapshot ? '（快照）' : ''}</h2>
       ${missingHtml}
       <div class="cards">
         <div class="card"><b>${s.productionCount}</b><span>生产批次（去重）</span></div>
         <div class="card"><b>${s.productBatchCount}</b><span>受影响成品批次（去重）</span></div>
         <div class="card"><b>${s.outboundOrderCount}</b><span>出库单（去重）</span></div>
         <div class="card"><b>${s.outboundDetailCount}</b><span>当前有效明细</span></div>
         <div class="card"><b>${s.outboundQty}</b><span>当前有效出库件数</span></div>
         <div class="card"><b>${s.revokedQty}</b><span>已撤销件数</span></div>
       </div>
       <h3>流向图（点击节点/边可跳回原始台账）</h3>
       <div class="graph-legend">
         <span class="item"><span class="swatch" style="background:#2a78d6"></span>原料</span>
         <span class="item"><span class="swatch" style="background:#eb6834"></span>半成品</span>
         <span class="item"><span class="swatch" style="background:#1baf7a"></span>成品</span>
         <span class="item"><span class="swatch" style="background:#fff8e6;border-color:#eac54f;border-style:dashed"></span>记录缺失（台账后到）</span>
         <span class="item"><span class="line"></span>生产/出库流向</span>
         <span class="item"><span class="line revoked"></span>已撤销的出库</span>
       </div>`
    );

    const graph = Graph.render(
      result,
      { materials: d.materials, production: d.production, missingBatches },
      jumpToLedger
    );
    panel.appendChild(graph);

    // 路径列表（同一成品的两条路径都会列出）
    panel.insertAdjacentHTML(
      'beforeend',
      `<h3>关联路径（${result.paths.length} 条，按路径去重）</h3>
       <ol class="paths">${result.paths.map((p) => `<li>${pathText(p)}</li>`).join('')}</ol>`
    );

    // 命中生产批次
    panel.insertAdjacentHTML(
      'beforeend',
      `<h3>涉及的生产批次（${result.production.length}）</h3>
       <table><thead><tr><th>生产批号</th><th>产出</th><th>阶段</th><th>投入</th><th>日期</th></tr></thead><tbody>
       ${result.production
         .map(
           (p) =>
             `<tr style="cursor:pointer" data-jump="production:${escapeHtml(p.id)}">
                <td><b>${escapeHtml(p.id)}</b></td><td>${escapeHtml(p.outputBatch)}</td>
                <td>${escapeHtml(p.stage)}</td><td>${(p.inputs || []).map(escapeHtml).join('、')}</td>
                <td>${escapeHtml(p.outputDate)}</td></tr>`
         )
         .join('')}
       </tbody></table>`
    );

    // 命中出库明细（撤销行照常展示，标注状态，不计入当前汇总）
    panel.insertAdjacentHTML(
      'beforeend',
      `<h3>涉及的出库单明细（${result.outboundDetails.length}，按明细去重）</h3>
       <table><thead><tr><th>明细号</th><th>出库单</th><th>成品批次</th><th>件数</th><th>状态</th><th>客户</th></tr></thead><tbody>
       ${result.outboundDetails
         .map((o) =>
           o.revoked
             ? `<tr class="revoked" style="cursor:pointer" data-jump="outbound:${escapeHtml(o.id)}">
                  <td class="nostrike"><b>${escapeHtml(o.id)}</b> <span class="badge revoked">已撤销</span></td>
                  <td>${escapeHtml(o.orderNo)}</td><td>${escapeHtml(o.productBatch)}</td>
                  <td>${o.qty}</td><td class="nostrike">不计入当前汇总</td><td>${escapeHtml(o.customer)}</td></tr>`
             : `<tr style="cursor:pointer" data-jump="outbound:${escapeHtml(o.id)}">
                  <td><b>${escapeHtml(o.id)}</b> <span class="badge ok">有效</span></td>
                  <td>${escapeHtml(o.orderNo)}</td><td>${escapeHtml(o.productBatch)}</td>
                  <td>${o.qty}</td><td>计入当前汇总</td><td>${escapeHtml(o.customer)}</td></tr>`
         )
         .join('')}
       </tbody></table>
       <p class="hint">同一成品经多条路径关联时只在流向图与路径列表重复展示，统计卡片按成品批次、出库单明细去重。</p>`
    );

    if (opts.snapshot) {
      $('btn-back-live').addEventListener('click', closeSnapshotAndRestore);
    }
  }

  function backToLive() {
    if (state.lastResult) renderResult(state.lastResult, { live: true });
    else $('result-panel').innerHTML = '<p class="placeholder">请选择原料批次并点击「追溯」。</p>';
    state.viewingSnapshot = false;
  }

  // ---------- 跳回原始台账 ----------
  function jumpToLedger(type, id) {
    let anchor = null;
    if (type === 'production') anchor = `row-prd-${id}`;
    else if (type === 'outbound') anchor = `row-out-${id}`;
    else if (type === 'batch') {
      anchor =
        document.getElementById(`row-mat-${id}`)?.id ||
        document.getElementById(`row-prd-${state.data.production.find((p) => p.outputBatch === id)?.id || ''}`)?.id ||
        null;
    }
    const el = anchor && document.getElementById(anchor);
    const section = $('ledgers');
    if (!el) {
      toast('原始台账中暂未找到该记录（可能后到未补齐）');
      section.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    section.scrollIntoView({ behavior: 'smooth' });
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  }

  // ---------- 出库更正 ----------
  function revokeDetail(detailId) {
    const d = state.data;
    if (d.corrections.some((c) => c.type === 'revoke' && c.detailId === detailId)) return;
    const seq = d.corrections.length + 1;
    d.corrections.push({
      id: `COR-${String(seq).padStart(2, '0')}`,
      type: 'revoke',
      detailId,
      date: new Date().toISOString().slice(0, 10),
      reason: '出库单更正：撤销该明细',
    });
    persistAndRefresh();
    toast(`已撤销明细 ${detailId}，当前汇总已更新（历史快照不受影响）`);
  }

  function restoreDetail(correctionId) {
    const d = state.data;
    d.corrections = d.corrections.filter((c) => c.id !== correctionId);
    persistAndRefresh();
    toast('已恢复该出库明细');
  }

  function persistAndRefresh() {
    saveLedgers();
    renderLedgers();
    renderGlobalMissing();
    if (state.lastQuery && !state.viewingSnapshot) runTrace();
    renderSnapshotList();
  }

  // ---------- 快照 ----------
  function saveSnapshot() {
    if (!state.lastResult) return;
    const list = loadSnapshots();
    const snap = {
      id: `snap-${Date.now()}`,
      savedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
      materialBatchId: state.lastResult.materialBatchId,
      fingerprint: Trace.dataFingerprint(state.data),
      data: SampleData.clone(state.data),
      result: state.lastResult,
    };
    list.unshift(snap);
    saveSnapshots(list);
    renderSnapshotList();
    toast('追溯结果已保存为历史快照');
  }

  function renderSnapshotList() {
    const ul = $('snapshot-list');
    const list = loadSnapshots();
    if (!list.length) {
      ul.innerHTML = '<li class="empty">暂无保存记录</li>';
      return;
    }
    ul.innerHTML = list
      .map((snap) => {
        const s = snap.result.stats;
        return `<li data-snap="${escapeHtml(snap.id)}">
          <b>原料 ${escapeHtml(snap.materialBatchId)}</b>
          <div class="meta">${escapeHtml(snap.savedAt)} · 成品 ${s.productBatchCount} 批 ·
          出库 ${s.outboundQty} 件（有效 ${s.outboundDetailCount} 条 / 撤销 ${s.revokedDetailCount} 条）</div>
          <button data-act="open">打开当时范围</button>
          <button data-act="del" class="danger">删除</button>
        </li>`;
      })
      .join('');
  }

  function openSnapshot(id) {
    const snap = loadSnapshots().find((s) => s.id === id);
    if (!snap) return;
    // 用保存时的台账副本渲染，但不覆盖当前台账；关闭快照即回到实时
    const currentData = state.data;
    state.data = snap.data;
    state.viewingSnapshot = true;
    renderLedgers();
    renderGlobalMissing();
    renderResult(snap.result, { snapshot: true, savedAt: snap.savedAt });
    const unchanged = Trace.dataFingerprint(currentData) === snap.fingerprint;
    toast(unchanged ? '快照范围与当前台账一致' : '当前台账已变化：此处展示的是保存时的范围');
    // 记录待恢复的实时台账
    state._liveData = currentData;
    $('btn-save-snapshot').disabled = true;
  }

  function closeSnapshotAndRestore() {
    if (state._liveData) {
      state.data = state._liveData;
      state._liveData = null;
    }
    state.viewingSnapshot = false;
    renderLedgers();
    renderGlobalMissing();
    backToLive();
    $('btn-save-snapshot').disabled = !state.lastResult;
  }

  function deleteSnapshot(id) {
    saveSnapshots(loadSnapshots().filter((s) => s.id !== id));
    renderSnapshotList();
    toast('快照已删除');
  }

  // ---------- 导入 / 导出 ----------
  function readJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (e) {
          reject(e);
        }
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  async function importLedger(key, file) {
    const rows = await readJsonFile(file);
    if (!Array.isArray(rows)) throw new Error('台账文件应为 JSON 数组');
    state.data[key] = rows;
    if (key === 'outbound') {
      // 导入新出库台账后，清掉指向不存在明细的更正
      const ids = new Set(rows.map((r) => r.id));
      state.data.corrections = state.data.corrections.filter((c) => ids.has(c.detailId));
    }
    saveLedgers();
    renderLedgers();
    renderGlobalMissing();
    if (state.lastQuery && !state.viewingSnapshot) runTrace();
  }

  function exportLedgers() {
    const blob = new Blob([JSON.stringify(state.data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `food-trace-ledgers-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('btn-trace').addEventListener('click', runTrace);
    $('btn-save-snapshot').addEventListener('click', saveSnapshot);
    $('btn-export').addEventListener('click', exportLedgers);
    $('btn-reset').addEventListener('click', () => {
      state.data = SampleData.fullLedger();
      state.lastResult = null;
      state.lastQuery = null;
      saveLedgers();
      renderLedgers();
      renderGlobalMissing();
      renderSnapshotList();
      $('result-panel').innerHTML = '<p class="placeholder">请选择原料批次并点击「追溯」。</p>';
      $('btn-save-snapshot').disabled = true;
      toast('已重置为内置示例台账');
    });

    $('btn-demo-late').addEventListener('click', () => {
      if (state.viewingSnapshot) closeSnapshotAndRestore();
      state.data = SampleData.withLateLedger();
      saveLedgers();
      renderLedgers();
      renderGlobalMissing();
      if (state.lastQuery) runTrace();
      toast('已移除 PRD-H2：R1 的第二条路径缺失，黄条已标出');
    });
    $('btn-demo-fill').addEventListener('click', () => {
      const full = SampleData.fullLedger();
      // 只补生产台账，保留当前的出库更正状态
      state.data.production = full.production;
      saveLedgers();
      renderLedgers();
      renderGlobalMissing();
      if (state.lastQuery) runTrace();
      toast('迟到的生产记录已补齐，追溯已重算');
    });
    $('btn-demo-revoke').addEventListener('click', () => {
      if (state.viewingSnapshot) closeSnapshotAndRestore();
      if (!state.data.outbound.some((o) => o.id === 'OUT-2')) {
        toast('示例台账中没有 OUT-2，请先重置为示例数据');
        return;
      }
      revokeDetail('OUT-2');
    });
    $('btn-demo-restore').addEventListener('click', () => {
      const cor = state.data.corrections.find((c) => c.detailId === 'OUT-2');
      if (cor) restoreDetail(cor.id);
      else toast('当前没有针对 OUT-2 的撤销记录');
    });

    for (const [key, inputId] of [
      ['materials', 'imp-materials'],
      ['production', 'imp-production'],
      ['outbound', 'imp-outbound'],
    ]) {
      $(inputId).addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        if (!file) return;
        try {
          await importLedger(key, file);
          toast(`已导入${key === 'materials' ? '原料' : key === 'production' ? '生产' : '出库'}台账（${file.name}）`);
        } catch (e) {
          toast('导入失败：' + e.message);
        } finally {
          ev.target.value = '';
        }
      });
    }

    // 台账区事件委托：撤销 / 恢复
    $('ledgers').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'revoke') revokeDetail(btn.dataset.id);
      if (act === 'restore') restoreDetail(btn.dataset.id);
    });

    // 快照区事件委托
    $('snapshot-list').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const li = btn.closest('li[data-snap]');
      const id = li.dataset.snap;
      if (btn.dataset.act === 'open') closeSnapshotGuard(id);
      if (btn.dataset.act === 'del') deleteSnapshot(id);
    });
  }

  function closeSnapshotGuard(id) {
    if (state.viewingSnapshot) closeSnapshotAndRestore();
    openSnapshot(id);
  }

  // ---------- 启动 ----------
  // 自动化/截图钩子：?demo=trace:R1,revoke:OUT-2,snapshot,late,fill
  function runDemoScript() {
    if (typeof location === 'undefined' || typeof URLSearchParams === 'undefined') return;
    const params = new URLSearchParams(location.search).get('demo');
    if (!params) return;
    for (const step of params.split(',')) {
      const [act, arg] = step.split(':');
      if (act === 'trace') {
        $('query-batch').value = arg || 'R1';
        runTrace();
      } else if (act === 'revoke') {
        revokeDetail(arg || 'OUT-2');
      } else if (act === 'snapshot') {
        saveSnapshot();
      } else if (act === 'late') {
        state.data = SampleData.withLateLedger();
        saveLedgers();
        renderLedgers();
        renderGlobalMissing();
        if (state.lastQuery) runTrace();
      } else if (act === 'fill') {
        state.data.production = SampleData.fullLedger().production;
        saveLedgers();
        renderLedgers();
        renderGlobalMissing();
        if (state.lastQuery) runTrace();
      } else if (act === 'openSnapshot') {
        const snap = loadSnapshots()[0];
        if (snap) openSnapshot(snap.id);
      }
    }
  }

  function init() {
    state.data = loadLedgers();
    bind();
    renderLedgers();
    renderGlobalMissing();
    renderSnapshotList();
    // 结果区点击委托：节点/边/行跳回原始台账
    $('result-panel').addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-jump]');
      if (!target) return;
      const [type, id] = target.dataset.jump.split(':');
      jumpToLedger(type, id);
    });
    runDemoScript();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
