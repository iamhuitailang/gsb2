/* 凭据管理页前端逻辑：轮询状态、签发/轮换/吊销、演示时钟与接口试用 */

const ACTION_LABELS = {
  'inventory:read': '查库存',
  'stocktake:submit': '提交盘点',
};
const WH_LABELS = { WH1: '仓库一', WH2: '仓库二' };

let state = null;
let lastIssuedSecret = '';

const $ = (sel) => document.querySelector(sel);

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error}: ${data.message}`);
  return data;
}

async function refresh() {
  const res = await fetch('/api/admin/state');
  state = await res.json();
  render();
}

function fmt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function badge(status, label) {
  return `<span class="badge badge-${status}">${label}</span>`;
}

function render() {
  renderClock();
  renderAccounts();
  renderInventory();
  renderIssueForm();
  renderKeys();
  renderJobs();
  renderApiTester();
}

function renderClock() {
  $('#clockNow').textContent = fmt(new Date(state.clock.now).toISOString());
  const mins = Math.round(state.clock.offsetMs / 60000);
  $('#clockOffset').textContent = `相对真实时间偏移 ${mins} 分钟 · 排队延迟 ${state.queueDelayMs / 1000} 秒`;
}

function renderAccounts() {
  $('#accounts').innerHTML = state.serviceAccounts.map((a) => `
    <div class="account">
      <h3>
        <span>${a.name} <code>${a.id}</code></span>
        ${a.enabled ? badge('on', '启用中') : badge('off', '已停用')}
      </h3>
      <div class="scopes">
        <span>可访问仓库：${a.allowedWarehouses.map((w) => WH_LABELS[w] || w).join('、')}</span>
        <span>可执行动作：${a.allowedActions.map((x) => ACTION_LABELS[x] || x).join('、')}</span>
        <span>钥匙：共 ${a.keyCount} 把，当前有效 ${a.effectiveKeyCount} 把</span>
      </div>
      <button class="small ${a.enabled ? 'danger ghost' : ''}" data-toggle-account="${a.id}">
        ${a.enabled ? '提前停用账号（所有钥匙立即失效）' : '重新启用账号'}
      </button>
    </div>
  `).join('');
}

function renderInventory() {
  $('#inventoryBody').innerHTML = state.inventory
    .map((i) => `<tr><td>${i.sku}</td><td>${WH_LABELS[i.warehouse] || i.warehouse}</td><td>${i.name}</td><td>${i.qty}</td></tr>`)
    .join('');
}

function renderIssueForm() {
  const sel = $('#issueAccount');
  const current = sel.value;
  sel.innerHTML = state.serviceAccounts
    .map((a) => `<option value="${a.id}" ${a.id === current ? 'selected' : ''}>${a.name}${a.enabled ? '' : '（已停用）'}</option>`)
    .join('');
  const account = state.serviceAccounts.find((a) => a.id === sel.value) || state.serviceAccounts[0];

  $('#issueWarehouses').innerHTML = account.allowedWarehouses
    .map((w) => `<label><input type="checkbox" name="warehouses" value="${w}" checked> ${WH_LABELS[w] || w}</label>`)
    .join('');
  $('#issueActions').innerHTML = account.allowedActions
    .map((x) => `<label><input type="checkbox" name="actions" value="${x}" checked> ${ACTION_LABELS[x] || x}</label>`)
    .join('');

  const apiWh = $('#apiWarehouse');
  const apiWhVal = apiWh.value;
  apiWh.innerHTML = state.warehouses
    .map((w) => `<option value="${w.code}" ${w.code === apiWhVal ? 'selected' : ''}>${w.name}</option>`)
    .join('');
}

function renderKeys() {
  $('#keysBody').innerHTML = state.keys.length === 0
    ? '<tr><td colspan="6" class="muted">还没有钥匙，使用左上方表单签发第一把。</td></tr>'
    : state.keys.map((k) => `
      <tr>
        <td><code>${k.prefix}</code></td>
        <td>${k.serviceAccountName}</td>
        <td class="scope-cell">
          <span>仓库：${k.warehouses.map((w) => WH_LABELS[w] || w).join('、')}</span>
          <span>动作：${k.actions.map((x) => ACTION_LABELS[x] || x).join('、')}</span>
        </td>
        <td>${badge(k.status, k.statusLabel)}</td>
        <td class="scope-cell">
          <span>创建：${fmt(k.createdAt)}</span>
          <span>截止：${fmt(k.expiresAt)}</span>
          ${k.rotatedFromId ? '<span>由旧钥匙轮换而来</span>' : ''}
        </td>
        <td class="row-actions">
          ${k.status === 'active' ? `<button class="small" data-rotate="${k.id}">轮换（重叠 1 小时）</button>` : ''}
          ${k.status === 'active' || k.status === 'overlapping'
            ? `<button class="small danger ghost" data-revoke="${k.id}">吊销</button>` : ''}
        </td>
      </tr>`).join('');
}

function renderJobs() {
  $('#jobsBody').innerHTML = state.jobs.length === 0
    ? '<tr><td colspan="7" class="muted">暂无盘点任务。</td></tr>'
    : state.jobs.map((j) => `
      <tr>
        <td><code>${j.id.slice(0, 12)}…</code></td>
        <td>${WH_LABELS[j.warehouse] || j.warehouse} / ${j.sku}</td>
        <td>${j.countedQty}</td>
        <td><code>${j.keyPrefix}</code></td>
        <td>${badge(j.status, j.statusLabel)}</td>
        <td class="scope-cell"><span>入队 ${fmt(j.enqueuedAt)}</span><span>执行 ${fmt(j.runAt)}</span></td>
        <td>${j.result || '—'}</td>
      </tr>`).join('');
}

function renderApiTester() {
  $('#stocktakeFields').hidden = $('#apiAction').value !== 'stocktake:submit';
}

function showSecretModal(title, secret, extra) {
  $('#secretTitle').textContent = title;
  $('#secretText').textContent = extra ? `${secret}\n\n${extra}` : secret;
  lastIssuedSecret = secret;
  $('#secretModal').hidden = false;
}

/* ---------- 事件绑定 ---------- */

document.querySelectorAll('[data-advance]').forEach((btn) =>
  btn.addEventListener('click', () => api('/api/admin/clock/advance', { ms: Number(btn.dataset.advance) }).then(render))
);

$('#clockSetBtn').addEventListener('click', () => {
  const v = $('#clockSetAt').value;
  if (!v) return alert('请先选择时间');
  const iso = new Date(v).toISOString();
  fetch('/api/admin/state').then((r) => r.json()).then((s) => {
    const delta = Date.parse(iso) - s.clock.now;
    return api('/api/admin/clock/advance', { ms: delta });
  }).then(render);
});

$('#clockResetBtn').addEventListener('click', () => api('/api/admin/clock/reset').then(render));
$('#demoResetBtn').addEventListener('click', () => {
  if (confirm('恢复初始演示数据？所有钥匙和排队任务都会清空。')) {
    api('/api/admin/demo/reset').then(render);
  }
});

document.addEventListener('click', (e) => {
  const toggleId = e.target.dataset.toggleAccount;
  if (toggleId) api('/api/admin/service-accounts/toggle', { id: toggleId }).then(render);

  const rotateId = e.target.dataset.rotate;
  if (rotateId) {
    api('/api/admin/keys/rotate', { keyId: rotateId })
      .then((data) => showSecretModal(
        '轮换成功 · 新钥匙明文（仅展示一次）',
        data.issued.secret,
        `旧钥匙 ${data.issued.oldKey.prefix} 进入重叠期，截止时刻 ${fmt(data.issued.oldKey.expiresAt)}`
      ))
      .then(refresh)
      .catch((err) => alert(err.message));
  }

  const revokeId = e.target.dataset.revoke;
  if (revokeId && confirm('确定吊销这把钥匙？吊销后立即不可用。')) {
    api('/api/admin/keys/revoke', { keyId: revokeId }).then(render);
  }
});

$('#issueForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const serviceAccountId = $('#issueAccount').value;
  const warehouses = [...document.querySelectorAll('input[name="warehouses"]:checked')].map((x) => x.value);
  const actions = [...document.querySelectorAll('input[name="actions"]:checked')].map((x) => x.value);
  try {
    const data = await api('/api/admin/keys', { serviceAccountId, warehouses, actions });
    await showSecretModal('签发成功 · 钥匙明文（仅展示一次）', data.issued.secret);
    render();
  } catch (error) {
    alert(error.message);
  }
});

$('#apiAction').addEventListener('change', renderApiTester);

$('#apiForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const secret = $('#apiSecret').value.trim();
  const warehouse = $('#apiWarehouse').value;
  const action = $('#apiAction').value;
  const box = $('#apiResult');
  box.hidden = false;
  try {
    let res, data;
    if (action === 'inventory:read') {
      res = await fetch(`/api/inventory?warehouse=${encodeURIComponent(warehouse)}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      data = await res.json();
    } else {
      res = await fetch('/api/stocktakes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          warehouse,
          sku: $('#apiSku').value.trim(),
          countedQty: Number($('#apiQty').value),
        }),
      });
      data = await res.json();
    }
    box.className = `result ${res.ok ? 'ok' : 'fail'}`;
    box.textContent = `HTTP ${res.status}\n${JSON.stringify(data, null, 2)}`;
    refresh();
  } catch (error) {
    box.className = 'result fail';
    box.textContent = error.message;
  }
});

$('#secretCopy').addEventListener('click', () => {
  navigator.clipboard.writeText(lastIssuedSecret).then(() => {
    $('#secretCopy').textContent = '已复制';
    setTimeout(() => ($('#secretCopy').textContent = '复制'), 1500);
  });
});
$('#secretUse').addEventListener('click', () => {
  $('#apiSecret').value = lastIssuedSecret;
  $('#secretModal').hidden = true;
});
$('#secretClose').addEventListener('click', () => ($('#secretModal').hidden = true));

refresh();
setInterval(refresh, 1000);
