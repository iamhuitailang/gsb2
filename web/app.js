const $ = (sel) => document.querySelector(sel);

const TYPE_LABELS = { recharge: '充值', purchase: '消费', refund: '退款' };
const STATUS_LABELS = { posted: '已入账', pending: '暂存', rejected: '被拒绝' };

const state = {
  cardId: null,
  selectedTxId: null,
  highlightTxId: null,
};

/* ------------------------------- 工具函数 ------------------------------- */

// 元转分：避免 0.1 + 0.2 类浮点误差，按两位小数字符串解析
function yuanToCents(value) {
  const s = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [yuan, frac = ''] = s.split('.');
  return Number(yuan) * 100 + Number((frac + '00').slice(0, 2));
}

function centsToYuan(cents) {
  return (cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { body });
  return body;
}

/* -------------------------------- 卡管理 -------------------------------- */

async function loadCards(preselectId) {
  // 复用流水接口拿到全部卡号（单店规模下足够），再补卡余额
  const txs = await api('/api/transactions');
  const ids = [...new Set(txs.map((t) => t.cardId))].sort();
  const cards = await Promise.all(
    ids.map((id) => api(`/api/cards/${encodeURIComponent(id)}`).catch(() => null)),
  ).then((rs) => rs.filter(Boolean));

  const select = $('#cardSelect');
  select.innerHTML = '';
  if (cards.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '（暂无卡，请先开卡）';
    opt.value = '';
    select.appendChild(opt);
    state.cardId = null;
    renderBalance(null);
    renderTxs([]);
    return;
  }
  for (const c of cards) {
    const opt = document.createElement('option');
    opt.value = c.cardId;
    opt.textContent = `${c.cardId}（余额 ¥${centsToYuan(c.balanceCents)}）`;
    select.appendChild(opt);
  }
  const target = cards.some((c) => c.cardId === (preselectId || state.cardId))
    ? (preselectId || state.cardId)
    : cards[0].cardId;
  select.value = target;
  state.cardId = target;
  await refreshCard();
}

async function refreshCard() {
  if (!state.cardId) return;
  const card = await api(`/api/cards/${encodeURIComponent(state.cardId)}`);
  renderBalance(card);
  const status = $('#statusFilter').value;
  const type = $('#typeFilter').value;
  let txs = card.transactions;
  if (status) txs = txs.filter((t) => t.status === status);
  if (type) txs = txs.filter((t) => t.type === type);
  renderTxs(txs);
}

function renderBalance(card) {
  const box = $('#cardBalance');
  if (!card) {
    box.innerHTML = '—';
    $('#cardMeta').textContent = '';
    return;
  }
  box.innerHTML = `¥${centsToYuan(card.balanceCents)}<small>${card.balanceCents} 分</small>`;
  $('#cardMeta').textContent = `卡号 ${card.cardId} · 开卡时间 ${card.createdAt}`;
}

/* ------------------------------- 流水渲染 ------------------------------- */

function renderTxs(txs) {
  const tbody = $('#txTbody');
  tbody.innerHTML = '';
  $('#emptyHint').hidden = txs.length > 0;

  for (const t of txs) {
    const tr = document.createElement('tr');
    tr.dataset.id = t.id;
    if (t.id === state.highlightTxId) tr.classList.add('highlight');
    if (t.id === state.selectedTxId) tr.style.fontWeight = '700';

    tr.innerHTML = `
      <td>${t.id}</td>
      <td>${esc(t.registerId)} / ${esc(t.seq)}</td>
      <td><span class="type-tag type-${t.type}">${TYPE_LABELS[t.type]}</span></td>
      <td class="num">¥${centsToYuan(t.amountCents)}<span class="cents-sub">${t.amountCents} 分</span></td>
      <td><span class="badge badge-${t.status}">${STATUS_LABELS[t.status]}</span></td>
      <td class="num">${t.balanceAfterCents == null
        ? '<span class="muted">—</span>'
        : `¥${centsToYuan(t.balanceAfterCents)}<span class="cents-sub">${t.balanceAfterCents} 分</span>`}</td>
      <td class="num">${renderRefundable(t)}</td>
      <td class="reason-cell">${renderReason(t)}</td>
      <td class="hint">${esc(t.postedAt || t.createdAt)}</td>
    `;
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('link-btn')) return;
      state.selectedTxId = t.id;
      showDetail(t);
    });
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('.link-btn').forEach((btn) => {
    btn.addEventListener('click', () => jumpToOrigin(Number(btn.dataset.txId)));
  });
}

function renderRefundable(t) {
  if (t.type !== 'purchase') return '<span class="muted">—</span>';
  const cls = t.refundableCents === 0 ? 'muted' : '';
  return `<span class="${cls}">¥${centsToYuan(t.refundableCents)}</span>`;
}

function renderReason(t) {
  const parts = [];
  if (t.reasonCode) {
    parts.push(`<span class="reason-text" title="${esc(t.reasonCode)}">${esc(t.reasonDetail || t.reasonCode)}</span>`);
    parts.push(`<span class="reason-code">${esc(t.reasonCode)}</span>`);
  }
  if (t.type === 'refund' && t.ref) {
    const refText = `原消费：${esc(t.ref.registerId)} / ${esc(t.ref.seq)}`;
    if (t.linkedTxId) {
      parts.push(`<button class="link-btn" data-tx-id="${t.linkedTxId}">${refText} → 跳转 #${t.linkedTxId}</button>`);
    } else {
      parts.push(`<span class="hint">${refText}</span>`);
    }
  }
  return parts.join('') || '<span class="muted">—</span>';
}

function showDetail(t) {
  const lines = [
    `流水 #${t.id}（${TYPE_LABELS[t.type]} / ${STATUS_LABELS[t.status]}）`,
    `卡：${t.cardId}`,
    `收银点 / 流水号：${t.registerId} / ${t.seq}`,
    `金额：¥${centsToYuan(t.amountCents)}（${t.amountCents} 分）`,
    `入账后余额：${t.balanceAfterCents == null ? '未入账' : `¥${centsToYuan(t.balanceAfterCents)}（${t.balanceAfterCents} 分）`}`,
  ];
  if (t.type === 'purchase') {
    lines.push(`已退：¥${centsToYuan(t.refundedCents)}；剩余可退：¥${centsToYuan(t.refundableCents)}`);
  }
  if (t.ref) lines.push(`指向原消费：${t.ref.registerId} / ${t.ref.seq}${t.linkedTxId ? `（#${t.linkedTxId}）` : ''}`);
  if (t.reasonCode) lines.push(`原因：${t.reasonDetail || ''} [${t.reasonCode}]`);
  window.alert(lines.join('\n'));
}

// 从退款跳到原消费：必要时清掉筛选条件以保证目标行可见
async function jumpToOrigin(txId) {
  $('#statusFilter').value = '';
  $('#typeFilter').value = '';
  state.highlightTxId = txId;
  state.selectedTxId = txId;
  await refreshCard();
  const row = document.querySelector(`tr[data-id="${txId}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => { state.highlightTxId = null; }, 1800);
  }
}

/* -------------------------------- 表单 -------------------------------- */

function showFormMsg(ok, text) {
  const el = $('#formMsg');
  el.hidden = false;
  el.className = `form-msg ${ok ? 'ok' : 'err'}`;
  el.textContent = text;
  setTimeout(() => { el.hidden = true; }, 5000);
}

$('#txType').addEventListener('change', (e) => {
  $('#refFields').hidden = e.target.value !== 'refund';
});

$('#txForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const cents = yuanToCents(fd.get('amountYuan'));
  if (cents == null) return showFormMsg(false, '金额需为最多两位小数的正数');

  const payload = {
    cardId: state.cardId,
    registerId: fd.get('registerId'),
    seq: fd.get('seq'),
    type: fd.get('type'),
    amountCents: cents,
  };
  if (payload.type === 'refund') {
    payload.refRegisterId = fd.get('refRegisterId');
    payload.refSeq = fd.get('refSeq');
  }
  try {
    const result = await api('/api/transactions', { method: 'POST', body: JSON.stringify(payload) });
    const t = result.tx;
    showFormMsg(
      true,
      `${result.duplicate ? '重复上报，返回既有流水' : '已接收'}：#${t.id}，状态「${STATUS_LABELS[t.status]}」` +
      `${t.reasonDetail ? `（${t.reasonDetail}）` : ''}`,
    );
    e.target.reset();
    $('#refFields').hidden = true;
    state.highlightTxId = t.id;
    await loadCards(state.cardId);
  } catch (err) {
    showFormMsg(false, `提交失败：${err.message}`);
  }
});

$('#createCardBtn').addEventListener('click', async () => {
  const cardId = $('#newCardId').value.trim();
  const balance = yuanToCents($('#newCardBalance').value || '0');
  if (!cardId) return showFormMsg(false, '请输入卡号');
  if (balance == null) return showFormMsg(false, '初始余额格式不正确');
  try {
    await api('/api/cards', { method: 'POST', body: JSON.stringify({ cardId, initialBalanceCents: balance }) });
    showFormMsg(true, `卡 ${cardId} 已创建`);
    $('#newCardId').value = '';
    $('#newCardBalance').value = '0';
    await loadCards(cardId);
  } catch (err) {
    showFormMsg(false, `开卡失败：${err.message}`);
  }
});

$('#refreshBtn').addEventListener('click', () => loadCards());
$('#cardSelect').addEventListener('change', (e) => { state.cardId = e.target.value; refreshCard(); });
$('#statusFilter').addEventListener('change', refreshCard);
$('#typeFilter').addEventListener('change', refreshCard);

/* ------------------------------ 自动刷新 ------------------------------ */

loadCards();
setInterval(() => loadCards(), 3000);
