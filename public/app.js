import {
  ANSWER_LABELS, $, copyText, draftId, escapeHtml,
  fmtClock, fmtDateTime, readStore, request, toast, writeStore,
} from './shared.js';
import {
  STATE, createDraft, groupByCheckpoint, normalizeDrafts, runSync,
  selectSyncTargets, summarize, updateDraftPayload,
} from './queue-core.js';

const QUEUE_KEY = 'inspection.queue.v1';
const CACHE_KEY = 'inspection.checkpoints.v1';
const OFFLINE_KEY = 'inspection.offline.v1';

const queue = loadQueue();
const definitions = new Map(Object.entries(readStore(CACHE_KEY) ?? {}));
const formState = new Map();

let serverState = null;
let lastCheckpointsSignature = '';
let lastQueueSignature = '';
let simulatedOffline = readStore(OFFLINE_KEY, true) === true;
let syncing = false;

const isOffline = () => simulatedOffline || navigator.onLine === false;

/* ---------------- persistence ---------------- */

function loadQueue() {
  return normalizeDrafts(readStore(QUEUE_KEY));
}

function persistQueue() {
  if (!writeStore(QUEUE_KEY, queue)) {
    toast('本机存储不可用，草稿可能无法保留', 'err');
  }
}

function cacheDefinitions(checkpoints) {
  let changed = false;
  for (const cp of checkpoints) {
    const prev = definitions.get(cp.id) ?? {};
    // 撤销授权后不再保留任务正文和资料，只留下检查项名称，
    // 让被拦截的草稿仍能被读懂、被复制，而不是把资料继续留在本机。
    const next = cp.authorized
      ? {
        authorized: true,
        task: cp.task,
        materials: cp.materials,
        items: cp.items,
        name: cp.name,
        code: cp.code,
        location: cp.location,
      }
      : {
        authorized: false,
        task: null,
        materials: [],
        items: prev.items ?? [],
        name: cp.name,
        code: cp.code,
        location: cp.location,
      };
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    definitions.set(cp.id, next);
    changed = true;
  }
  if (changed) writeStore(CACHE_KEY, Object.fromEntries(definitions));
}

/* ---------------- form state ---------------- */

function ensureForm(cp) {
  let form = formState.get(cp.id);
  if (form) return form;
  const definition = definitions.get(cp.id) ?? cp;
  const answers = {};
  // 初始不预选结论，避免把「合格」当成默认答案。
  for (const item of definition.items ?? []) answers[item.id] = { result: '', note: '' };
  form = { answers, note: '', editingDraftId: null };
  formState.set(cp.id, form);
  return form;
}

function formFromDraft(draft) {
  const answers = {};
  for (const [itemId, answer] of Object.entries(draft.payload?.answers ?? {})) {
    answers[itemId] = { result: answer.result ?? '', note: answer.note ?? '' };
  }
  return { answers, note: draft.payload?.note ?? '', editingDraftId: draft.id };
}

/** 草稿入库后重置表单，避免用户对着已提交的内容再存出一条新草稿。 */
function resetForm(cpId) {
  const definition = definitions.get(cpId) ?? serverState?.checkpoints.find((c) => c.id === cpId);
  const answers = {};
  for (const item of definition?.items ?? []) answers[item.id] = { result: '', note: '' };
  formState.set(cpId, { answers, note: '', editingDraftId: null });
}

function checkpointTitle(id) {
  const cp = definitions.get(id) ?? serverState?.checkpoints.find((c) => c.id === id);
  return cp ? `${cp.code} · ${cp.name.replace(/^[^·]+·\s*/, '')}` : id;
}

function checkpointCode(id) {
  const cp = definitions.get(id) ?? serverState?.checkpoints.find((c) => c.id === id);
  return cp?.code ?? '？';
}

function isAuthorized(id) {
  const cp = serverState?.checkpoints.find((c) => c.id === id);
  if (cp) return cp.authorized;
  // 服务端不可达时以本机缓存的授权状态为准。
  const cached = definitions.get(id);
  return Boolean(cached) && cached.authorized !== false;
}

/* ---------------- server sync ---------------- */

async function refreshState({ announce = false, forceRender = false } = {}) {
  try {
    const previous = serverState;
    serverState = await request('/api/state', { offline: isOffline() });
    cacheDefinitions(serverState.checkpoints);
    const signature = JSON.stringify(
      serverState.checkpoints.map((cp) => [
        cp.id,
        cp.authorized,
        cp.task,
        cp.materials?.map((m) => m.id).join(','),
        cp.items?.map((i) => i.id).join(','),
      ]),
    );
    const listChanged = signature !== lastCheckpointsSignature;
    lastCheckpointsSignature = signature;
    renderNetwork();
    // 定期轮询不要打断正在填写的表单：只有授权或资料变化时才重绘检查单。
    if (forceRender || listChanged || !previous) renderCheckpoints();
    renderQueue();
    if (announce) toast('已与主管系统核对最新授权');
    return serverState;
  } catch (error) {
    if (error?.kind === 'offline') {
      if (announce) toast('当前离线，显示的是本机缓存的检查点资料', 'warn');
    } else {
      toast(`读取检查任务失败：${error.message}`, 'err');
    }
    return null;
  }
}

function payloadOf(form, itemIds = null) {
  const answers = {};
  for (const [itemId, answer] of Object.entries(form.answers)) {
    // 检查项列表可能在两次填写之间变过，别把已下线的检查项一起报上去。
    if (itemIds && !itemIds.has(itemId)) continue;
    answers[itemId] = { result: answer.result };
    if (answer.note?.trim()) answers[itemId].note = answer.note.trim();
  }
  const payload = { answers, filledAt: new Date().toISOString() };
  if (form.note?.trim()) payload.note = form.note.trim();
  return payload;
}

function saveDraft(cp, form) {
  const itemIds = new Set((cp.items ?? []).map((item) => item.id));
  const existing = form.editingDraftId ? queue.find((draft) => draft.id === form.editingDraftId) : null;
  if (existing && existing.state !== STATE.SYNCED) {
    updateDraftPayload(existing, payloadOf(form, itemIds));
    existing.checkpointName = cp.name;
    persistQueue();
    renderQueue();
    return existing;
  }
  const draft = createDraft({
    id: draftId(),
    checkpointId: cp.id,
    checkpointName: cp.name,
    payload: payloadOf(form, itemIds),
  });
  queue.push(draft);
  form.editingDraftId = draft.id;
  persistQueue();
  renderQueue();
  return draft;
}

async function submitDraft(draft) {
  return request('/api/drafts', {
    method: 'POST',
    body: { draftId: draft.id, checkpointId: draft.checkpointId, payload: draft.payload },
  });
}

async function syncQueue({ onlyId = null, announce = true } = {}) {
  if (isOffline()) {
    if (announce) toast('当前离线，草稿已保存在本机，恢复网络后再同步', 'warn');
    return;
  }
  if (syncing) return;
  if (selectSyncTargets(queue, onlyId).length === 0) {
    if (announce) toast('没有需要同步的草稿');
    return;
  }

  syncing = true;
  updateSyncButton();
  try {
    // 逐条按当前权限核对：先拿一次最新授权，再由服务端逐条裁决。
    await refreshState();
    const result = await runSync(queue, {
      submit: submitDraft,
      isOffline,
      onlyId,
      onChange: () => {
        persistQueue();
        renderQueue();
      },
    });
    for (const { draft, record } of result.duplicates) {
      toast(`「${shortName(draft)}」服务端已有同编号记录 #${record.seq}，未重复入库`);
    }
    persistQueue();
    renderAll();
    if (announce) {
      if (result.interrupted) toast('网络中断，剩余草稿留在本机', 'warn');
      else if (result.accepted && result.blocked) {
        toast(`已入库 ${result.accepted} 条，${result.blocked} 条需要你处理`, 'warn', 5000);
      } else if (result.accepted) toast(`已入库 ${result.accepted} 条`);
      else if (result.blocked) toast(`${result.blocked} 条未通过服务端核对，请按提示处理`, 'err', 5200);
    }
    // 已入库的草稿对应表单清空，免得误存成第二条。
    for (const draft of queue) {
      if (draft.state !== STATE.SYNCED) continue;
      const form = formState.get(draft.checkpointId);
      if (form?.editingDraftId === draft.id) resetForm(draft.checkpointId);
    }
    renderCheckpoints();
  } finally {
    syncing = false;
    updateSyncButton();
  }
}

function shortName(draft) {
  return checkpointTitle(draft.checkpointId);
}

/* ---------------- rendering: checkpoints ---------------- */

function badgeForState(state) {
  if (state === STATE.SYNCED) return '<span class="badge badge-ok">已成功</span>';
  if (state === STATE.NEEDS_ACTION) return '<span class="badge badge-danger">待处理</span>';
  if (state === STATE.SYNCING) return '<span class="badge badge-muted">发送中</span>';
  return '<span class="badge badge-warn">未发送</span>';
}

function renderCheckpoints() {
  const host = $('#checkpoints');
  const fromServer = serverState?.checkpoints ?? [];
  // 离线首次打开时服务端不可达，退回使用本机缓存的资料副本。
  const checkpoints = fromServer.length
    ? fromServer
    : [...definitions.entries()].map(([id, definition]) => ({
      id,
      ...definition,
      authorized: definition.authorized !== false,
    }));

  if (!checkpoints.length) {
    host.innerHTML = `<div class="card"><div class="empty">${
      isOffline()
        ? '离线状态下没有缓存的任务资料。<br>请先在联网时打开本页，再模拟断网。'
        : '正在读取检查任务…'
    }</div></div>`;
    return;
  }
  host.innerHTML = checkpoints.map(renderCheckpointCard).join('');
}

function renderCheckpointCard(cp) {
  const definition = definitions.get(cp.id) ?? cp;
  const hasDefinition = Boolean((definition.items ?? []).length);
  const pendingHere = queue.filter((d) => d.checkpointId === cp.id && d.state !== STATE.SYNCED);
  const offline = isOffline();
  const authorizedNow = cp.authorized;
  // 已撤销授权的检查点即使断网也不再展开填写；缓存副本仅用于仍授权的任务。
  const editable = hasDefinition && authorizedNow;

  const authBadge = authorizedNow
    ? '<span class="badge badge-ok">已授权</span>'
    : '<span class="badge badge-danger">授权已撤销</span>';
  const offlineBadge = offline ? '<span class="badge badge-warn">离线填写中</span>' : '';

  const pendingSummary = pendingHere.length ? `本机有 ${pendingHere.length} 条未上报草稿` : '';
  const pendingLine = pendingSummary
    ? `<p class="form-status">${pendingSummary}，可在右侧队列查看。</p>`
    : '';

  if (!editable) {
    const lockedReason = authorizedNow
      ? {
        title: '本机没有该检查点的任务资料',
        body: '请先联网打开本页，把任务与资料缓存到本机后再离线填写。',
      }
      : {
        title: '主管已撤销该检查点的授权',
        body: '任务与资料不再下发。本机残留的草稿仍可复制带走，但不能写入服务端正式检查单。',
      };
    return `
      <article class="card cp-card" data-cp="${escapeHtml(cp.id)}">
        <div class="cp-head">
          <div class="cp-code">${escapeHtml(cp.code)}</div>
          <div>
            <h2>${escapeHtml(cp.name)}</h2>
            <p>${escapeHtml(cp.location)}</p>
          </div>
          <div class="cp-badges">${authBadge}</div>
        </div>
        <div class="locked">
          <div>
            <strong>${escapeHtml(lockedReason.title)}</strong>
            ${escapeHtml(lockedReason.body)}
            ${pendingLine}
          </div>
        </div>
        ${pendingHere.length ? `<div class="cp-body" style="padding-top:0">${pendingHere.map(renderLocalDraftLine).join('')}</div>` : ''}
      </article>`;
  }

  const form = ensureForm({ ...cp, items: definition.items });
  const items = definition.items ?? [];
  const itemsHtml = items.map((item) => {
    const answer = form.answers[item.id] ?? { result: '', note: '' };
    form.answers[item.id] = answer;
    return `
      <div class="item">
        <span class="item-label">${escapeHtml(item.label)}</span>
        <div class="seg" role="radiogroup" aria-label="${escapeHtml(item.label)}">
          ${Object.entries(ANSWER_LABELS).map(([value, label]) => `
            <label>
              <input type="radio" name="ans-${escapeHtml(cp.id)}-${escapeHtml(item.id)}"
                     value="${value}" ${answer.result === value ? 'checked' : ''}
                     data-cp="${escapeHtml(cp.id)}" data-item="${escapeHtml(item.id)}" />
              <span>${label}</span>
            </label>`).join('')}
        </div>
        <input type="text" placeholder="备注（可选）：证据编号、异常描述…"
               value="${escapeHtml(answer.note)}" maxlength="2000"
               data-cp="${escapeHtml(cp.id)}" data-item="${escapeHtml(item.id)}" data-field="note" />
      </div>`;
  }).join('');

  return `
    <article class="card cp-card" data-cp="${escapeHtml(cp.id)}">
      <div class="cp-head">
        <div class="cp-code">${escapeHtml(cp.code)}</div>
        <div>
          <h2>${escapeHtml(cp.name)}</h2>
          <p>${escapeHtml(cp.location)}</p>
        </div>
        <div class="cp-badges">${authBadge}${offlineBadge}</div>
      </div>
      <div class="cp-body">
        <div class="cp-meta">
          <div class="meta-block">
            <h3>检查任务</h3>
            <p class="task">${escapeHtml(definition.task)}</p>
            <p class="form-status" style="margin:6px 0 0">
              ${offline ? '离线模式：使用本机缓存的资料副本' : '资料由主管按检查点授权下发'}
            </p>
          </div>
          <div class="meta-block">
            <h3>随任务下发资料</h3>
            <ul>
              ${(definition.materials ?? []).map((material) => `
                <li><span>${escapeHtml(material.label)} <span class="hint">${escapeHtml(material.hint)}</span></span></li>
              `).join('')}
            </ul>
          </div>
        </div>
        <h3 class="meta-block" style="margin:0 0 4px">检查项</h3>
        ${itemsHtml}
        <div class="field">
          <label for="note-${escapeHtml(cp.id)}">整体备注</label>
          <textarea id="note-${escapeHtml(cp.id)}" maxlength="4000" data-cp="${escapeHtml(cp.id)}" data-field="overall-note"
                    placeholder="现场情况、整改要求…">${escapeHtml(form.note)}</textarea>
        </div>
        <div class="actions">
          <button class="btn btn-primary" type="button" data-action="save" data-cp="${escapeHtml(cp.id)}">保存到本机队列</button>
          <button class="btn" type="button" data-action="save-submit" data-cp="${escapeHtml(cp.id)}">保存并立即上报</button>
          <span class="spacer"></span>
          <span class="form-status">${pendingSummary}</span>
        </div>
      </div>
    </article>`;
}

function renderLocalDraftLine(draft) {
  return `
    <div class="qitem">
      <div class="qitem-top">
        <span class="time">${fmtDateTime(draft.createdAt)}</span>
        ${badgeForState(draft.state)}
        <button class="btn btn-sm" type="button" data-action="copy" data-id="${escapeHtml(draft.id)}" style="margin-left:auto">复制内容</button>
      </div>
      ${draft.lastError ? `<p class="reason">${escapeHtml(draft.lastError.message)}</p>` : ''}
    </div>`;
}

/* ---------------- rendering: queue ---------------- */

function renderQueue() {
  const list = $('#queueList');
  const stats = summarize(queue);
  $('#queueTotal').textContent = String(stats.total);
  $('#counts').innerHTML = [
    `<span class="badge badge-warn">未发送 ${stats.notSent}</span>`,
    `<span class="badge badge-danger">待处理 ${stats.needsAction}</span>`,
    `<span class="badge badge-ok">已成功 ${stats.succeeded}</span>`,
  ].join('');
  $('#queueSub').textContent = isOffline()
    ? '离线中：草稿只保存在这台设备上。'
    : '网络正常：可随时同步；服务端按草稿编号去重。';

  if (!queue.length) {
    list.innerHTML = '<div class="empty">队列是空的。<br>在左侧检查单里填写并保存后会出现在这里。</div>';
    lastQueueSignature = '';
    updateSyncButton();
    return;
  }

  // 状态没变就不重绘，避免收起用户展开的草稿详情。
  const signature = JSON.stringify(
    queue.map((d) => [
      d.id,
      d.state,
      d.updatedAt,
      d.attempts,
      d.lastError?.code,
      d.receipt?.seq,
      d.receipt?.duplicate,
    ]),
  );
  if (signature !== lastQueueSignature) {
    lastQueueSignature = signature;
    const openIds = new Set(
      [...list.querySelectorAll('details[open]')].map((node) => node.closest('.qitem')?.dataset.id).filter(Boolean),
    );
    list.innerHTML = [...groupByCheckpoint(queue).entries()].map(([cpId, drafts]) => `
      <div class="qgroup" data-cp="${escapeHtml(cpId)}">
        <div class="qgroup-head">
          <span class="code">${escapeHtml(checkpointCode(cpId))}</span>
          <span>${escapeHtml(checkpointTitle(cpId))}</span>
          <span class="count">${drafts.length} 条</span>
        </div>
        ${drafts.map(renderQueueItem).join('')}
      </div>`).join('');
    for (const id of openIds) {
      list.querySelector(`.qitem[data-id="${id}"] details`)?.setAttribute('open', '');
    }
  }
  updateSyncButton();
}

function renderQueueItem(draft) {
  const errorLine = draft.lastError
    ? `<p class="reason">${escapeHtml(draft.lastError.message)}${draft.lastError.code === 'CHECKPOINT_NOT_AUTHORIZED' ? '（草稿保留在本机，可复制）' : ''}</p>`
    : '';
  const receiptLine = draft.receipt
    ? `<p class="ok-line">正式记录 #${draft.receipt.seq} · ${fmtDateTime(draft.receipt.receivedAt)}${draft.receipt.duplicate ? ' · 服务端已有同编号记录，未重复入库' : ''}</p>`
    : '';
  const retry = draft.state === STATE.NEEDS_ACTION
    ? `<button class="btn btn-sm" type="button" data-action="retry" data-id="${escapeHtml(draft.id)}">再次同步</button>`
    : '';
  const edit = draft.state !== STATE.SYNCED
    ? `<button class="btn btn-sm" type="button" data-action="edit" data-id="${escapeHtml(draft.id)}">重新编辑</button>`
    : '';
  // 已入库的草稿可以再发一次同一编号，用来验证服务端只保存一份。
  const repost = draft.state === STATE.SYNCED
    ? `<button class="btn btn-sm" type="button" data-action="repost" data-id="${escapeHtml(draft.id)}">重发验证去重</button>`
    : '';
  return `
    <div class="qitem" data-id="${escapeHtml(draft.id)}">
      <div class="qitem-top">
        <span class="time">${fmtClock(draft.updatedAt ?? draft.createdAt)}</span>
        ${badgeForState(draft.state)}
        ${draft.attempts ? `<span class="time" title="上报尝试次数">试 ${draft.attempts} 次</span>` : ''}
      </div>
      ${errorLine}
      ${receiptLine}
      <details>
        <summary>查看草稿内容${draft.state === STATE.NEEDS_ACTION ? ' / 复制' : ''}</summary>
        <pre>${escapeHtml(describeDraft(draft))}</pre>
        <div class="copy-row">
          <button class="btn btn-sm" type="button" data-action="copy" data-id="${escapeHtml(draft.id)}">复制全文</button>
          ${retry}
          ${edit}
          ${repost}
        </div>
      </details>
    </div>`;
}

function describeDraft(draft) {
  const lines = [
    `检查点：${checkpointTitle(draft.checkpointId)}`,
    `草稿编号：${draft.id}`,
    `填写时间：${fmtDateTime(draft.createdAt)}`,
    `状态：${draft.state === STATE.SYNCED ? '已入库' : draft.state === STATE.NEEDS_ACTION ? '需处理' : '待发送'}`,
    '',
  ];
  const definition = definitions.get(draft.checkpointId);
  const items = definition?.items ?? [];
  const labelOf = (itemId) => items.find((item) => item.id === itemId)?.label ?? itemId;
  for (const [itemId, answer] of Object.entries(draft.payload?.answers ?? {})) {
    lines.push(`- ${labelOf(itemId)}：${ANSWER_LABELS[answer.result] ?? answer.result}${answer.note ? `（${answer.note}）` : ''}`);
  }
  if (draft.payload?.note) lines.push('', `整体备注：${draft.payload.note}`);
  if (draft.lastError) lines.push('', `未通过原因：${draft.lastError.message}`);
  lines.push('', `原始数据：${JSON.stringify(draft.payload)}`);
  return lines.join('\n');
}

function updateSyncButton() {
  const btn = $('#syncBtn');
  const stats = summarize(queue);
  const actionable = stats.notSent + stats.needsAction;
  btn.disabled = isOffline() || syncing || actionable === 0;
  btn.textContent = syncing
    ? '正在逐条核对…'
    : isOffline()
      ? '离线中 · 无法同步'
      : actionable
        ? `同步队列（${actionable}）`
        : '队列已同步';
}

/* ---------------- rendering: chrome ---------------- */

function renderNetwork() {
  const toggle = $('#netToggle');
  const offline = isOffline();
  const realOffline = navigator.onLine === false;
  toggle.classList.toggle('is-offline', offline);
  toggle.setAttribute('aria-pressed', String(simulatedOffline));
  $('#netState').textContent = offline
    ? realOffline
      ? '浏览器已断网'
      : '已断网（本页模拟）'
    : '网络正常';
  $('#netHint').textContent = simulatedOffline
    ? '点击恢复网络'
    : realOffline
      ? '等待网络恢复'
      : '点击模拟断网';
  document.documentElement.dataset.offline = String(offline);
}

function renderAll() {
  renderNetwork();
  renderCheckpoints();
  renderQueue();
}

/* ---------------- events ---------------- */

function findDraft(id) {
  return queue.find((draft) => draft.id === id);
}

function onCheckpointInput(event) {
  const target = event.target;
  const cpId = target.dataset?.cp;
  if (!cpId) return;
  const cp = serverState?.checkpoints.find((c) => c.id === cpId);
  const definition = definitions.get(cpId) ?? cp;
  if (!definition) return;
  const form = ensureForm({ ...definition, id: cpId });
  if (target.dataset.field === 'overall-note') {
    form.note = target.value;
    return;
  }
  const itemId = target.dataset.item;
  if (!itemId) return;
  if (!form.answers[itemId]) form.answers[itemId] = { result: '', note: '' };
  if (target.type === 'radio') form.answers[itemId].result = target.value;
  else form.answers[itemId].note = target.value;
}

function onActions(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const draft = button.dataset.id ? findDraft(button.dataset.id) : null;

  if (action === 'copy' && draft) {
    copyText(describeDraft(draft)).then((ok) => {
      toast(ok ? '草稿内容已复制，可粘贴到工单或消息里' : '复制失败，请手动选择文本复制', ok ? 'info' : 'err');
    });
    return;
  }
  if (action === 'retry' && draft) {
    if (draft.state === STATE.NEEDS_ACTION) {
      draft.state = STATE.PENDING;
      draft.lastError = null;
    }
    persistQueue();
    syncQueue({ onlyId: draft.id, announce: true });
    return;
  }
  if (action === 'repost' && draft) {
    // 用同一草稿编号再发一次：服务端应返回同一条正式记录，不新增。
    repostForDedup(draft);
    return;
  }
  if (action === 'edit' && draft) {
    if (!isAuthorized(draft.checkpointId)) {
      toast('该检查点的授权已撤销，草稿只能复制带走', 'err');
      return;
    }
    const cp = serverState?.checkpoints.find((c) => c.id === draft.checkpointId);
    const definition = definitions.get(draft.checkpointId) ?? cp;
    if (!definition) {
      toast('本机没有该检查点的资料副本，无法重新编辑', 'warn');
      return;
    }
    formState.set(draft.checkpointId, formFromDraft(draft));
    renderCheckpoints();
    document.querySelector(`[data-cp="${draft.checkpointId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('草稿已载入检查单，修改后可重新保存');
    return;
  }

  const cpId = button.dataset.cp;
  if (!cpId) return;
  if (!isAuthorized(cpId)) {
    toast('该检查点的授权已被撤销，不能再保存新的检查单', 'err');
    return;
  }
  const cp = serverState?.checkpoints.find((c) => c.id === cpId);
  const definition = definitions.get(cpId) ?? cp;
  if (!definition) return;
  const form = ensureForm({ ...definition, id: cpId });
  const missing = (definition.items ?? []).filter((item) => !form.answers[item.id]?.result);
  if (missing.length) {
    toast(`还有 ${missing.length} 个检查项未作答`, 'err');
    return;
  }

  const editingBefore = form.editingDraftId;
  const saved = saveDraft(
    { id: cpId, name: definition.name, items: definition.items },
    form,
  );
  if (action === 'save') {
    if (isOffline()) toast('已保存到本机队列，网络恢复后同步', 'warn');
    else toast(editingBefore === saved.id ? '草稿已更新到本机队列' : '已保存到本机队列，可点击同步上报');
    return;
  }
  if (isOffline()) {
    toast('当前离线，已保存到本机队列，恢复网络后再上报', 'warn');
    return;
  }
  syncQueue({ onlyId: saved.id });
}

/** 用同一草稿编号再提交一次，验证服务端只保存一份。 */
async function repostForDedup(draft) {
  if (isOffline()) {
    toast('当前离线，无法验证去重', 'warn');
    return;
  }
  try {
    const res = await request('/api/drafts', {
      method: 'POST',
      body: { draftId: draft.id, checkpointId: draft.checkpointId, payload: draft.payload },
    });
    if (res.duplicate) {
      toast(`服务端已有同编号记录 #${res.record.seq}，没有新增第二条`, 'info', 5200);
    } else {
      toast(`服务端新增了记录 #${res.record.seq}`, 'warn', 5200);
    }
    draft.receipt = {
      seq: res.record.seq,
      receivedAt: res.record.receivedAt,
      duplicate: Boolean(res.duplicate),
    };
    // 记录仍在本机队列，状态与重发前一致；清空签名强制重绘。
    lastQueueSignature = '';
    persistQueue();
    renderQueue();
  } catch (error) {
    toast(`验证去重失败：${error.message}`, 'err');
  }
}

function setOffline(next, { announce = true } = {}) {
  simulatedOffline = next;
  writeStore(OFFLINE_KEY, next, true);
  renderAll();
  if (!announce) return;
  if (next) {
    toast('已模拟断网：填写与保存只作用于本机', 'warn');
  } else {
    // 恢复网络后先核对一次授权，让检查员看到甲点已被撤权，再手动点同步。
    refreshState();
    toast('网络已恢复。点击「同步队列」按当前授权逐条核对草稿');
  }
}

function bind() {
  $('#netToggle').addEventListener('click', () => {
    setOffline(!simulatedOffline);
  });
  $('#syncBtn').addEventListener('click', () => syncQueue());
  $('#checkpoints').addEventListener('change', onCheckpointInput);
  $('#checkpoints').addEventListener('input', onCheckpointInput);
  $('#checkpoints').addEventListener('click', onActions);
  $('#queueList').addEventListener('click', onActions);
  $('#clearBtn').addEventListener('click', () => {
    // 只清已成功上报的副本；未发送和待处理的草稿必须留在本机，避免丢现场证据。
    const removable = queue.filter((draft) => draft.state === STATE.SYNCED);
    if (!removable.length) {
      toast('没有已成功上报的草稿可清理', 'warn');
      return;
    }
    if (!window.confirm(`从本机队列清掉 ${removable.length} 条已成功上报的草稿副本？服务端正式检查单不受影响。`)) return;
    for (const draft of removable) {
      queue.splice(queue.indexOf(draft), 1);
      for (const form of formState.values()) {
        if (form.editingDraftId === draft.id) form.editingDraftId = null;
      }
    }
    persistQueue();
    renderAll();
    toast('已清理本机队列中的已上报副本');
  });

  window.addEventListener('online', renderAll);
  window.addEventListener('offline', renderAll);

  // 主管可能随时调整授权：定期核对，但不打断正在填写的表单。
  setInterval(() => {
    if (!isOffline() && !document.hidden) refreshState();
  }, 5000);
}

async function boot() {
  bind();
  renderAll();
  await refreshState();
  // 上报一律由用户点击「同步队列」触发，便于演示逐条核对的过程。
  if (isOffline()) toast('当前处于断网模拟：任务资料来自本机缓存', 'warn', 5000);
}

boot();
