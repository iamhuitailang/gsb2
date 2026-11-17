/**
 * 检查员页面逻辑
 *
 * 离线优先：
 *  - 所有草稿先落本机 localStorage 队列，再尝试发送。
 *  - 断网模拟开启时请求不出本机，恢复后逐条同步。
 *  - 同步时逐条按服务端“当前权限”核对：无权限的草稿留在本机（blocked），
 *    不影响同队列里其他检查点的草稿。
 *  - 服务端以 draftId 幂等：同一份草稿重试不会重复入库。
 */
import {
  EMPLOYEE_ID,
  OfflineError,
  ApiError,
  isOnline,
  setOnline,
  apiFetch,
  loadOutbox,
  addOutboxItem,
  updateOutboxItem,
  removeOutboxItem,
  cacheCheckpoints,
  loadCachedCheckpoints,
  toast,
  formatTime,
} from './common.js';

const RESULT_LABEL = { pass: '合格', fail: '不合格', 'n/a': '不适用' };

let checkpoints = [];
// 最近一次拿到的权限快照：checkpointId -> {granted, stale}
let permissionSnapshot = new Map();
let syncing = false;

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------
function init() {
  bindNetworkToggle();
  renderCheckpoints(loadCachedCheckpoints());
  refresh();
  // 页面打开时若在线，自动尝试一次队列同步（覆盖“关掉页面再打开”的重连场景）
  if (isOnline()) syncOutbox({ silent: true });
}

function bindNetworkToggle() {
  const toggle = document.getElementById('netToggle');
  toggle.checked = isOnline();
  renderNetState();
  toggle.addEventListener('change', async () => {
    const nowOnline = toggle.checked;
    setOnline(nowOnline);
    renderNetState();
    if (nowOnline) {
      toast('网络已恢复，开始同步本地队列…', 'success');
      await refresh();
      await syncOutbox();
    } else {
      toast('已模拟断网：请求不会发出，草稿只保存在本机');
    }
  });
}

function renderNetState() {
  const online = isOnline();
  document.getElementById('netLabel').textContent = online ? '在线' : '离线（模拟）';
  const dot = document.getElementById('netDot');
  dot.className = `net-dot ${online ? 'online' : 'offline'}`;
}

async function refresh() {
  if (isOnline()) {
    try {
      const [cpRes, meRes] = await Promise.all([
        apiFetch('/api/checkpoints'),
        apiFetch(`/api/me?employeeId=${EMPLOYEE_ID}`),
      ]);
      checkpoints = cpRes.checkpoints;
      cacheCheckpoints(checkpoints);
      permissionSnapshot = new Map(
        meRes.permissions.map((p) => [p.checkpointId, { granted: p.granted, stale: false }])
      );
    } catch (err) {
      if (err instanceof OfflineError) {
        checkpoints = loadCachedCheckpoints();
      } else {
        toast(err.message, 'error');
      }
    }
  } else {
    checkpoints = loadCachedCheckpoints();
    // 离线期间权限可能已被主管修改，缓存的快照标记为“可能过期”
    for (const key of [...permissionSnapshot.keys()]) {
      permissionSnapshot.get(key).stale = true;
    }
  }
  renderCheckpoints(checkpoints);
  renderPermBar();
  renderOutbox();
}

// ---------------------------------------------------------------------------
// 检查点表单
// ---------------------------------------------------------------------------
function renderCheckpoints(list) {
  const wrap = document.getElementById('checkpoints');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty">暂无任务数据（先在线打开一次，任务与资料会缓存到本机）</div>`;
    return;
  }
  wrap.innerHTML = list
    .map(
      (cp) => `
      <div class="checkpoint" id="cp-${cp.id}">
        <div class="cp-head">
          <h3>${cp.name}</h3>
          <span id="perm-${cp.id}"></span>
        </div>
        <div class="materials">📎 ${cp.materials}</div>
        <div class="task-list">
          ${cp.tasks
            .map(
              (t) => `
            <div class="task-row">
              <label for="${cp.id}-${t.id}">${t.label}</label>
              <select id="${cp.id}-${t.id}" data-task="${t.id}">
                <option value="">请选择…</option>
                <option value="pass">合格</option>
                <option value="fail">不合格</option>
                <option value="n/a">不适用</option>
              </select>
            </div>`
            )
            .join('')}
        </div>
        <div class="task-row" style="margin-top:8px">
          <textarea id="note-${cp.id}" rows="2" placeholder="备注（可选）"></textarea>
        </div>
        <div class="cp-foot">
          <button data-action="save-draft" data-cp="${cp.id}">保存草稿并尝试提交</button>
          <span class="muted small">断网时也可保存，内容先入本机队列</span>
        </div>
      </div>`
    )
    .join('');

  wrap.querySelectorAll('button[data-action="save-draft"]').forEach((btn) => {
    btn.addEventListener('click', () => saveDraft(btn.dataset.cp));
  });
  renderPermBar();
}

function renderPermBar() {
  const bar = document.getElementById('permBar');
  if (!checkpoints.length) {
    bar.textContent = '暂无检查点数据';
    return;
  }
  bar.innerHTML = checkpoints
    .map((cp) => {
      const p = permissionSnapshot.get(cp.id);
      let badge;
      if (!p) badge = `<span class="badge pending">未知</span>`;
      else if (p.granted) badge = `<span class="badge ok">已授权</span>`;
      else badge = `<span class="badge no">已撤销</span>`;
      const stale = p?.stale ? `<span class="badge stale">离线缓存，待核对</span>` : '';
      return `<span style="display:inline-flex;gap:6px;align-items:center;margin-right:18px">
        ${cp.name} ${badge} ${stale}
      </span>`;
    })
    .join('');

  // 同步更新卡片头部的小徽章
  checkpoints.forEach((cp) => {
    const el = document.getElementById(`perm-${cp.id}`);
    if (!el) return;
    const p = permissionSnapshot.get(cp.id);
    el.innerHTML = !p
      ? ''
      : p.granted
      ? `<span class="badge ok">已授权</span>`
      : `<span class="badge no">已撤销</span>`;
  });
}

function readForm(checkpointId) {
  const cp = checkpoints.find((c) => c.id === checkpointId);
  const tasks = cp.tasks.map((t) => {
    const select = document.getElementById(`${checkpointId}-${t.id}`);
    return { id: t.id, label: t.label, result: select.value };
  });
  const note = document.getElementById(`note-${checkpointId}`).value.trim();
  return { cp, tasks, note };
}

async function saveDraft(checkpointId) {
  const { cp, tasks, note } = readForm(checkpointId);
  if (tasks.some((t) => !t.result)) {
    toast('请先完成所有检查项的选择', 'error');
    return;
  }

  const now = new Date().toISOString();
  const item = {
    draftId: crypto.randomUUID(),
    employeeId: EMPLOYEE_ID,
    checkpointId,
    checkpointName: cp.name,
    tasks,
    note,
    status: 'queued',
    createdAt: now,
    lastAttemptAt: null,
    attempts: 0,
    lastError: null,
  };
  // 1. 先落本机队列 —— 无论在线与否都不会丢
  addOutboxItem(item);
  renderOutbox();
  toast(isOnline() ? '草稿已保存，正在提交…' : '断网中：草稿已存入本机队列，恢复后同步');

  // 2. 在线则立即尝试一次；离线就等同步
  if (isOnline()) {
    await sendOne(item.draftId);
  }
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------
async function sendOne(draftId) {
  const item = loadOutbox().find((i) => i.draftId === draftId);
  if (!item || item.status === 'synced') return;

  // 断网时请求不会发出，不计入尝试次数
  if (!isOnline()) {
    updateOutboxItem(draftId, { status: 'queued', lastError: '离线，尚未发送' });
    renderOutbox();
    return;
  }

  updateOutboxItem(draftId, {
    lastAttemptAt: new Date().toISOString(),
    attempts: item.attempts + 1,
  });

  try {
    const res = await apiFetch('/api/records', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: item.employeeId,
        checkpointId: item.checkpointId,
        draftId: item.draftId,
        result: summarize(item.tasks),
        note: buildNoteText(item),
      }),
    });

    updateOutboxItem(draftId, {
      status: 'synced',
      lastError: null,
      serverRecordId: res.record.id,
      duplicated: res.duplicated === true,
      syncedAt: new Date().toISOString(),
    });
    toast(
      res.duplicated
        ? `${item.checkpointName}：服务端确认已入库，未重复保存`
        : `${item.checkpointName}：检查单已成功入库`,
      'success'
    );
  } catch (err) {
    if (err instanceof OfflineError) {
      updateOutboxItem(draftId, { status: 'queued', lastError: '离线，尚未发送' });
    } else if (err instanceof ApiError && err.status === 403) {
      // 权限不足：草稿留在本机供复制，绝不进入服务端正式检查单
      updateOutboxItem(draftId, {
        status: 'blocked',
        lastError: err.message,
        blockedAt: new Date().toISOString(),
      });
      toast(`${item.checkpointName}：授权已被撤销，草稿保留在本机待处理`, 'error');
    } else {
      updateOutboxItem(draftId, {
        status: 'queued',
        lastError: err.message || '发送失败，可重试',
      });
      toast(`${item.checkpointName}：${err.message}`, 'error');
    }
  }
  renderOutbox();
}

/**
 * 逐条同步队列。不同检查点的草稿各自处理，互不阻塞。
 * blocked（权限不足）的草稿不会自动重试，需用户处理。
 */
async function syncOutbox({ silent = false } = {}) {
  if (syncing) return;
  if (!isOnline()) {
    if (!silent) toast('当前处于离线状态，无法同步', 'error');
    return;
  }
  syncing = true;
  document.getElementById('syncBtn').disabled = true;

  try {
    // 同步前先拉取“当前权限”，后续逐条核对都以服务端此刻的授权为准
    const me = await apiFetch(`/api/me?employeeId=${EMPLOYEE_ID}`);
    permissionSnapshot = new Map(
      me.permissions.map((p) => [p.checkpointId, { granted: p.granted, stale: false }])
    );
    renderPermBar();

    const queued = loadOutbox().filter((i) => i.status === 'queued');
    let ok = 0;
    let blocked = 0;
    let failed = 0;
    // 逐条处理：一条 403 不影响下一条
    for (const item of queued) {
      await sendOne(item.draftId);
      const latest = loadOutbox().find((i) => i.draftId === item.draftId);
      if (latest.status === 'synced') ok += 1;
      else if (latest.status === 'blocked') blocked += 1;
      else failed += 1;
    }

    if (!silent) {
      if (queued.length === 0) toast('没有待发送的草稿');
      else toast(`同步完成：入库 ${ok} 条，需处理 ${blocked} 条，仍失败 ${failed} 条`);
    }
  } catch (err) {
    if (!silent) toast(err instanceof OfflineError ? '仍处于离线状态' : err.message, 'error');
  } finally {
    syncing = false;
    document.getElementById('syncBtn').disabled = false;
    renderOutbox();
  }
}

// ---------------------------------------------------------------------------
// 队列渲染
// ---------------------------------------------------------------------------
function statusBadge(item) {
  if (item.status === 'synced') {
    return `<span class="badge synced">✓ 已入库${item.duplicated ? '（重试未重复）' : ''}</span>`;
  }
  if (item.status === 'blocked') {
    return `<span class="badge blocked">⚠ 需用户处理（权限不足）</span>`;
  }
  return `<span class="badge pending">待发送</span>`;
}

function renderOutbox() {
  const items = loadOutbox();
  const counts = items.reduce(
    (acc, i) => {
      acc[i.status] = (acc[i.status] ?? 0) + 1;
      return acc;
    },
    { queued: 0, synced: 0, blocked: 0 }
  );
  document.getElementById('cntQueued').textContent = counts.queued;
  document.getElementById('cntSynced').textContent = counts.synced;
  document.getElementById('cntBlocked').textContent = counts.blocked;

  const body = document.getElementById('outboxBody');
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">队列是空的，先在上方保存一条草稿</td></tr>`;
    return;
  }

  body.innerHTML = items
    .map((item) => {
      const summary =
        item.tasks.map((t) => `${t.label}：${RESULT_LABEL[t.result]}`).join('；') +
        (item.note ? `；备注：${item.note}` : '');
      const detail =
        item.status === 'blocked'
          ? `<div class="small" style="color:var(--red);margin-top:4px">${item.lastError ?? ''}</div>
             <div class="small muted">该草稿只存在本机，服务端正式检查单中看不到它</div>`
          : item.lastError
          ? `<div class="small muted" style="margin-top:4px">${item.lastError}</div>`
          : '';
      const actions =
        item.status === 'queued'
          ? `<button class="secondary small" data-action="retry" data-id="${item.draftId}">重新同步</button>
             <button class="ghost small" data-action="copy" data-id="${item.draftId}">复制内容</button>
             <button class="ghost small" data-action="discard" data-id="${item.draftId}">删除</button>`
          : item.status === 'blocked'
          ? `<button class="secondary small" data-action="retry" data-id="${item.draftId}">重新点同步</button>
             <button class="secondary small" data-action="copy" data-id="${item.draftId}">复制内容</button>
             <button class="ghost small" data-action="discard" data-id="${item.draftId}">删除本机草稿</button>`
          : `<button class="ghost small" data-action="copy" data-id="${item.draftId}">复制内容</button>
             <button class="ghost small" data-action="discard" data-id="${item.draftId}">移除</button>`;
      return `
      <tr>
        <td>${item.checkpointName}<div class="small muted"><code class="mono">${item.draftId.slice(0, 8)}</code> · 尝试 ${item.attempts} 次</div></td>
        <td style="max-width:340px">${summary}</td>
        <td>${statusBadge(item)}</td>
        <td class="small">${formatTime(item.lastAttemptAt)}${detail}</td>
        <td style="white-space:nowrap">${actions}</td>
      </tr>`;
    })
    .join('');

  body.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleQueueAction(btn.dataset.action, btn.dataset.id));
  });
}

async function handleQueueAction(action, draftId) {
  const item = loadOutbox().find((i) => i.draftId === draftId);
  if (!item) return;
  if (action === 'retry') {
    if (!isOnline()) return toast('离线状态无法同步，请先恢复网络', 'error');
    await sendOne(draftId);
  } else if (action === 'copy') {
    await copyDraft(item);
  } else if (action === 'discard') {
    removeOutboxItem(draftId);
    renderOutbox();
    toast('已从本机队列移除');
  }
}

async function copyDraft(item) {
  const text = buildCopyText(item);
  try {
    await navigator.clipboard.writeText(text);
    toast('草稿全文已复制到剪贴板，可粘贴到其他系统', 'success');
  } catch {
    // 剪贴板权限不可用时的兜底
    window.prompt('复制以下草稿内容：', text);
  }
}

function buildCopyText(item) {
  const lines = [
    `检查点：${item.checkpointName}`,
    ...item.tasks.map((t) => `- ${t.label}：${RESULT_LABEL[t.result]}`),
    `备注：${item.note || '（无）'}`,
    `保存时间：${formatTime(item.createdAt)}`,
    `草稿编号：${item.draftId}`,
  ];
  if (item.status === 'blocked') lines.push(`未提交原因：${item.lastError ?? '权限不足'}`);
  return lines.join('\n');
}

// 整体结论：任一不合格即不合格，否则全 n/a 为 n/a，其余为合格
function summarize(tasks) {
  if (tasks.every((t) => t.result === 'n/a')) return 'n/a';
  if (tasks.some((t) => t.result === 'fail')) return 'fail';
  return 'pass';
}

function buildNoteText(item) {
  const taskLines = item.tasks.map((t) => `${t.label}=${RESULT_LABEL[t.result]}`).join('；');
  return item.note ? `${taskLines}｜备注：${item.note}` : taskLines;
}

document.getElementById('syncBtn').addEventListener('click', () => syncOutbox());
document.getElementById('clearSyncedBtn').addEventListener('click', () => {
  const remain = loadOutbox().filter((i) => i.status !== 'synced');
  localStorage.setItem('demo:outbox', JSON.stringify(remain));
  renderOutbox();
  toast('已清除本机队列中的入库记录（服务端正式检查单不受影响）');
});

init();
