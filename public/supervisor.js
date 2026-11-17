import { ANSWER_LABELS, $, escapeHtml, fmtDateTime, request, toast } from './shared.js';

let state = null;
// 授权请求在途时不接受轮询结果，免得开关被旧状态覆盖。
let authPending = false;
let lastRenderSignature = '';

function renderAuthorizations() {
  const host = $('#authList');
  const checkpoints = state?.checkpoints ?? [];
  if (!checkpoints.length) {
    host.innerHTML = '<div class="empty">没有检查点</div>';
    return;
  }
  host.innerHTML = checkpoints.map((cp) => {
    const auth = cp.inspectorAuthorization ?? { granted: cp.authorized, updatedAt: null, updatedBy: null };
    return `
      <div class="auth-row" data-cp="${escapeHtml(cp.id)}">
        <div class="cp-code" style="width:34px;height:34px;font-size:17px">${escapeHtml(cp.code)}</div>
        <div class="info">
          <strong>${escapeHtml(cp.name)}</strong>
          <small>${escapeHtml(cp.location)} · 资料 ${cp.materials?.length ?? 0} 份 · 检查项 ${cp.items?.length ?? 0} 个</small>
          <small style="display:block">${auth.updatedAt ? `最近调整：${fmtDateTime(auth.updatedAt)} · ${escapeHtml(auth.updatedBy ?? '')}` : '尚未调整过'}</small>
        </div>
        <div class="toggle">
          <span class="badge ${auth.granted ? 'badge-ok' : 'badge-danger'}">${auth.granted ? '已授权' : '已撤销'}</span>
          <label class="switch">
            <input type="checkbox" ${auth.granted ? 'checked' : ''} data-action="toggle-auth" data-cp="${escapeHtml(cp.id)}"
                   aria-label="${escapeHtml(cp.name)} 授权开关" />
            <span class="slider"></span>
          </label>
        </div>
      </div>`;
  }).join('');
}

function renderRecords() {
  const records = state?.records ?? [];
  $('#recordCount').textContent = String(records.length);
  const host = $('#records');
  if (!records.length) {
    host.innerHTML = '<div class="empty">还没有检查单入库</div>';
    return;
  }
  host.innerHTML = records.map((record) => {
    const items = state.checkpoints
      .find((cp) => cp.id === record.checkpointId)?.items ?? [];
    const labelOf = (id) => items.find((item) => item.id === id)?.label ?? id;
    const answers = Object.entries(record.payload?.answers ?? {});
    const fails = answers.filter(([, a]) => a.result === 'fail').length;
    return `
      <article class="record">
        <div class="record-head">
          <span class="seq">#${record.seq}</span>
          <strong>${escapeHtml(record.checkpointName)}</strong>
          ${fails ? `<span class="badge badge-danger">${fails} 项不合格</span>` : '<span class="badge badge-ok">全部合格</span>'}
          <span class="meta">${fmtDateTime(record.receivedAt)}</span>
        </div>
        <dl>
          ${answers.map(([itemId, answer]) => `
            <dt>${escapeHtml(labelOf(itemId))}</dt>
            <dd>${escapeHtml(ANSWER_LABELS[answer.result] ?? answer.result)}${answer.note ? ` · ${escapeHtml(answer.note)}` : ''}</dd>
          `).join('')}
          <dt>检查员</dt>
          <dd>${escapeHtml(record.inspectorName)}</dd>
          <dt>草稿编号</dt>
          <dd style="font-family:var(--mono);font-size:11.5px;word-break:break-all">${escapeHtml(record.draftId)}</dd>
        </dl>
        ${record.payload?.note ? `<p class="overall">整体备注：${escapeHtml(record.payload.note)}</p>` : ''}
      </article>`;
  }).join('');
}

const AUDIT_LABELS = {
  accepted: '入库',
  rejected: '拒绝',
  duplicate: '去重',
  authorization: '授权',
};

function renderAudit() {
  const host = $('#audit');
  const entries = state?.audit ?? [];
  if (!entries.length) {
    host.innerHTML = '<div class="empty">暂无记录</div>';
    return;
  }
  host.innerHTML = entries.map((entry) => `
    <div class="audit-item">
      <span class="at">${fmtDateTime(entry.at)}</span>
      <span class="kind ${entry.type}">${AUDIT_LABELS[entry.type] ?? entry.type}</span>
      <span class="txt">
        ${escapeHtml(entry.checkpointName ? `「${entry.checkpointName}」` : '')}${escapeHtml(entry.detail ?? '')}
        ${entry.actor ? `<span style="color:var(--ink-3)"> · ${escapeHtml(entry.actor)}</span>` : ''}
      </span>
    </div>`).join('');
}

function renderUpdatedAt() {
  const stamps = (state?.checkpoints ?? [])
    .map((cp) => cp.inspectorAuthorization?.updatedAt)
    .filter(Boolean)
    .sort();
  $('#authUpdated').textContent = stamps.length ? `最近调整 ${fmtDateTime(stamps[stamps.length - 1])}` : '—';
}

function render() {
  // 轮询每 3 秒来一次；状态没变就不重绘，免得开关动画和焦点被打断。
  const signature = JSON.stringify({
    auth: state?.checkpoints?.map((cp) => [cp.id, cp.authorized, cp.inspectorAuthorization?.updatedAt]),
    records: state?.records?.map((r) => r.seq),
    audit: state?.audit?.map((a) => a.id),
  });
  if (signature === lastRenderSignature) return;
  lastRenderSignature = signature;
  renderAuthorizations();
  renderRecords();
  renderAudit();
  renderUpdatedAt();
}

async function refresh({ silent = true } = {}) {
  try {
    const next = await request('/api/state', { actor: 'wang' });
    if (authPending) return state;
    state = next;
    render();
    return state;
  } catch (error) {
    if (!silent) toast(`刷新失败：${error.message}`, 'err');
    return null;
  }
}

async function toggleAuthorization(cpId, granted) {
  authPending = true;
  try {
    await request('/api/authorization', {
      method: 'POST',
      actor: 'wang',
      body: { inspectorId: 'li', checkpointId: cpId, granted },
    });
    const cp = state?.checkpoints.find((c) => c.id === cpId);
    toast(`${granted ? '已恢复' : '已撤销'}「${cp?.name ?? cpId}」的授权`);
  } catch (error) {
    toast(`调整授权失败：${error.message}`, 'err');
  } finally {
    authPending = false;
    // 请求失败时状态没变也要重绘，否则开关会一直停在 disabled。
    lastRenderSignature = '';
    await refresh();
  }
}

function bind() {
  $('#authList').addEventListener('change', (event) => {
    const input = event.target.closest('input[data-action="toggle-auth"]');
    if (!input) return;
    input.disabled = true;
    toggleAuthorization(input.dataset.cp, input.checked);
  });
  $('#refreshBtn').addEventListener('click', () => refresh({ silent: false }));
  setInterval(() => {
    if (!document.hidden && !authPending) refresh();
  }, 3000);
}

bind();
refresh({ silent: false });
