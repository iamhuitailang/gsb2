// 前端单页应用：原生 JS，无构建依赖。
// 关键交互：复核请求携带页面当前版本号 expected_version，
// 服务端返回 VERSION_CHANGED 时提示「版本已变化」并引导刷新。
const state = {
  users: [],
  currentUserId: localStorage.getItem('demo_current_user') || 'u_jia',
  detail: null, // 详情页缓存的数据（可能已过期，正是乐观锁要拦截的场景）
};

const view = document.getElementById('view');
const userSelect = document.getElementById('user-select');
const toastEl = document.getElementById('toast');

// ---------- 工具 ----------

function yuan(cents) {
  return `¥${(cents / 100).toFixed(2)}`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer;
function toast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload?.error?.message || '请求失败');
    err.code = payload?.error?.code;
    err.currentVersion = payload?.error?.current_version;
    err.httpStatus = res.status;
    throw err;
  }
  return payload;
}

function currentUser() {
  return state.users.find((u) => u.id === state.currentUserId) || null;
}

const STATUS_TEXT = {
  PENDING_APPROVAL: '待复核',
  PENDING_EXECUTION: '待执行',
};
const ROLE_TEXT = { SUBMITTER: '提交人', REVIEWER: '复核人' };
const ACTION_TEXT = {
  CREATED: '创建指令',
  UPDATED: '修改指令',
  APPROVED: '复核同意',
  APPROVAL_REJECTED: '复核被拒绝',
  ENTERED_PENDING_EXECUTION: '进入待执行',
};

// ---------- 用户切换 ----------

async function loadUsers() {
  const { users } = await api('/api/users');
  state.users = users;
  if (!users.some((u) => u.id === state.currentUserId)) {
    state.currentUserId = users[0].id;
  }
  userSelect.innerHTML = users
    .map((u) => `<option value="${u.id}" ${u.id === state.currentUserId ? 'selected' : ''}>${esc(u.name)}（${ROLE_TEXT[u.role]}）</option>`)
    .join('');
}

userSelect.addEventListener('change', () => {
  state.currentUserId = userSelect.value;
  localStorage.setItem('demo_current_user', state.currentUserId);
  route();
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  if (!window.confirm('确定重置为初始样例数据？所有改动与复核记录将清空。')) return;
  await api('/api/reset', { method: 'POST' });
  state.detail = null;
  toast('样例数据已重置', 'success');
  location.hash = '#/';
  route();
});

// ---------- 路由 ----------

function route() {
  const hash = location.hash || '#/';
  const detailMatch = hash.match(/^#\/instructions\/([\w-]+)$/);
  if (detailMatch) {
    renderDetail(detailMatch[1]);
  } else {
    renderList();
  }
}
window.addEventListener('hashchange', route);

// ---------- 列表视图 ----------

async function renderList() {
  const { instructions } = await api('/api/instructions');
  const me = currentUser();
  const canCreate = me?.role === 'SUBMITTER';

  view.innerHTML = `
    ${canCreate ? `
    <section class="card">
      <div class="card-header"><h2>新建付款指令</h2></div>
      <div class="card-body">
        <form id="create-form">
          <div class="form-grid">
            <div class="form-field">
              <label>收款方</label>
              <input name="payee" required maxlength="60" placeholder="例如：华东供应商有限公司" />
            </div>
            <div class="form-field">
              <label>金额（元）</label>
              <input name="amount" type="number" required min="0.01" step="0.01" placeholder="0.00" />
            </div>
            <div class="form-field">
              <label>提交人</label>
              <input value="${esc(me.name)}（${ROLE_TEXT[me.role]}）" disabled />
            </div>
          </div>
          <div class="form-actions">
            <button class="btn btn-primary" type="submit">提交指令</button>
            <span class="hint">提交后进入待复核，需两名不同复核人同意才会进入待执行</span>
          </div>
        </form>
      </div>
    </section>` : ''}

    <section class="card">
      <div class="card-header">
        <h2>付款指令列表</h2>
        <span class="hint">点击指令编号查看版本与复核详情</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>指令编号</th><th>收款方</th><th class="right">当前金额</th>
              <th>版本</th><th>复核进度</th><th>状态</th><th>提交人</th>
            </tr>
          </thead>
          <tbody>
            ${instructions.length === 0 ? `<tr><td colspan="7"><div class="empty">暂无指令</div></td></tr>` : ''}
            ${instructions.map((it) => `
              <tr>
                <td><a class="clickable" href="#/instructions/${esc(it.id)}">${esc(it.instruction_no)}</a></td>
                <td>${esc(it.payee)}</td>
                <td class="num right">${yuan(it.amount_cents)}</td>
                <td><span class="badge badge-version">v${it.current_version}</span></td>
                <td>${it.status === 'PENDING_EXECUTION'
                  ? '<span class="muted">已完成</span>'
                  : `${it.approval_count} / ${2} 人同意`}</td>
                <td><span class="badge ${it.status === 'PENDING_EXECUTION' ? 'badge-execution' : 'badge-pending'}">${STATUS_TEXT[it.status]}</span></td>
                <td>${esc(it.submitter_name)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </section>`;

  const form = document.getElementById('create-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        const created = await api('/api/instructions', {
          method: 'POST',
          body: JSON.stringify({
            user_id: state.currentUserId,
            payee: fd.get('payee'),
            amount_yuan: Number(fd.get('amount')),
          }),
        });
        toast('指令已提交，等待复核', 'success');
        location.hash = `#/instructions/${created.id}`;
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

// ---------- 详情视图 ----------

async function fetchDetail(id) {
  state.detail = await api(`/api/instructions/${id}`);
  return state.detail;
}

async function renderDetail(id, banner = null) {
  let d;
  try {
    d = await fetchDetail(id);
  } catch (err) {
    view.innerHTML = `<div class="alert alert-error"><strong>加载失败</strong>${esc(err.message)}</div>
      <a class="btn btn-ghost" href="#/">返回列表</a>`;
    return;
  }
  const me = currentUser();
  const isSubmitter = me?.id === d.submitter_id;
  const isReviewer = me?.role === 'REVIEWER';
  const finalized = d.status === 'PENDING_EXECUTION';

  view.innerHTML = `
    <div class="back-link"><a class="btn-link" href="#/">← 返回指令列表</a></div>

    ${banner ? `<div class="alert ${banner.type}">${banner.html}</div>` : ''}

    <section class="card">
      <div class="card-header">
        <h2>${esc(d.instruction_no)}</h2>
        <span class="badge ${finalized ? 'badge-execution' : 'badge-pending'}">${STATUS_TEXT[d.status]}</span>
      </div>
      <div class="card-body">
        <div class="kv-grid">
          <div class="kv"><div class="k">提交人</div><div class="v">${esc(d.submitter.name)}</div></div>
          <div class="kv"><div class="k">当前版本</div><div class="v">v${d.current_version}</div></div>
          <div class="kv"><div class="k">收款方</div><div class="v">${esc(d.versions.at(-1).payee)}</div></div>
          <div class="kv"><div class="k">当前金额</div><div class="v amount">${yuan(d.versions.at(-1).amount_cents)}</div></div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-header"><h2>操作区（当前身份：${esc(me.name)} · ${ROLE_TEXT[me.role]}）</h2></div>
      <div class="card-body" id="action-area">${renderActionArea(d, me, isSubmitter, isReviewer, finalized)}</div>
    </section>

    <section class="card">
      <div class="card-header"><h2>版本与复核记录</h2>
        <span class="hint">复核绑定具体版本；新版产生后旧复核不计入新版</span>
      </div>
      <div class="card-body" id="version-area">${d.versions.map((v) => renderVersionBlock(v, d)).join('')}</div>
    </section>

    <section class="card">
      <div class="card-header"><h2>操作时间线</h2></div>
      <div class="card-body">
        <div class="timeline">
          ${d.audit_events.map(renderTimelineItem).join('')}
        </div>
      </div>
    </section>`;

  bindDetailActions(id);
}

function renderActionArea(d, me, isSubmitter, isReviewer, finalized) {
  if (finalized) {
    return `<div class="alert alert-success"><strong>指令已进入待执行</strong>当前 v${d.current_version} 已集齐 ${d.required_approvals} 名不同复核人同意，不再接受修改或复核。</div>`;
  }
  const parts = [];

  if (isReviewer) {
    parts.push(`
      <div class="alert alert-info">
        <strong>复核操作将绑定当前版本 v${d.current_version}</strong>
        若在此期间提交人修改了指令，本次复核会被拒绝并提示版本变化，需刷新核对新版后重新同意。
      </div>
      <button class="btn btn-primary" id="approve-btn" type="button">同意复核（v${d.current_version}）</button>`);
  } else if (isSubmitter) {
    parts.push(`
      <div class="alert alert-error" style="margin-bottom:14px">
        <strong>提交人不能复核自己的指令</strong>请切换到复核人「乙」或「丙」身份进行复核。
      </div>`);
  }

  if (isSubmitter) {
    const cur = d.versions.at(-1);
    parts.push(`
      <h3 style="margin:18px 0 10px;font-size:14px;">修改收款方 / 金额（生成新版本，旧复核自动失效）</h3>
      <form id="edit-form">
        <div class="form-grid">
          <div class="form-field">
            <label>收款方</label>
            <input name="payee" required maxlength="60" value="${esc(cur.payee)}" />
          </div>
          <div class="form-field">
            <label>金额（元）</label>
            <input name="amount" type="number" required min="0.01" step="0.01" value="${(cur.amount_cents / 100).toFixed(2)}" />
          </div>
          <div class="form-field">
            <label>基于版本</label>
            <input value="v${d.current_version}" disabled />
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit">保存修改并生成新版本</button>
        </div>
      </form>`);
  }
  return parts.join('');
}

function renderVersionBlock(v, d) {
  const isCurrent = v.version === d.current_version;
  const chips = v.approvals.length
    ? v.approvals.map((a) => `<span class="chip">✓ ${esc(a.reviewer_name)} 同意 · ${fmtTime(a.created_at)}</span>`).join('')
    : '<span class="chip chip-empty">暂无复核</span>';
  return `
    <div class="version-block ${isCurrent ? 'current' : 'obsolete'}">
      <div class="version-head">
        <h3>版本 v${v.version}</h3>
        ${isCurrent ? '<span class="badge badge-version">当前版本</span>' : '<span class="badge badge-role">历史版本</span>'}
        <span class="muted">${esc(v.change_summary || '')}</span>
      </div>
      <div class="kv-grid">
        <div class="kv"><div class="k">收款方</div><div class="v" style="font-size:14px">${esc(v.payee)}</div></div>
        <div class="kv"><div class="k">金额</div><div class="v num" style="font-size:14px">${yuan(v.amount_cents)}</div></div>
      </div>
      <div class="approval-chips">${chips}</div>
    </div>`;
}

function renderTimelineItem(e) {
  const cls = e.action === 'APPROVAL_REJECTED' ? 'event-rejected'
    : e.action === 'ENTERED_PENDING_EXECUTION' ? 'event-execution'
      : e.action === 'APPROVED' ? 'event-ok' : '';
  const versionTag = e.version ? `v${e.version} · ` : '';
  return `
    <div class="tl-item ${cls}">
      <span class="tl-dot"></span>
      <div class="tl-time">${fmtTime(e.created_at)}</div>
      <div class="tl-title">${versionTag}${ACTION_TEXT[e.action] || esc(e.action)} · ${esc(e.actor_name || '系统')}</div>
      ${e.detail ? `<div class="tl-detail">${esc(e.detail)}</div>` : ''}
    </div>`;
}

function bindDetailActions(id) {
  const approveBtn = document.getElementById('approve-btn');
  if (approveBtn) {
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      // 携带页面加载时的版本号；若页面过期，服务端返回 VERSION_CHANGED
      const expectedVersion = state.detail.current_version;
      try {
        const result = await api(`/api/instructions/${id}/approvals`, {
          method: 'POST',
          body: JSON.stringify({ user_id: state.currentUserId, expected_version: expectedVersion }),
        });
        if (result.duplicate) {
          toast(result.message, '');
        } else if (result.entered_pending_execution) {
          toast('复核成功，指令已进入待执行', 'success');
        } else {
          toast('复核已记录，等待另一名复核人同意', 'success');
        }
        renderDetail(id);
      } catch (err) {
        approveBtn.disabled = false;
        if (err.code === 'VERSION_CHANGED') {
          // 丙在未刷新的旧页面点同意 → 显眼的版本变化提示 + 一键刷新
          renderDetail(id, {
            type: 'alert-error',
            html: `<strong>⚠ 版本已变化，本次复核未生效</strong>
              ${esc(err.message)}
              <div style="margin-top:10px"><button class="btn btn-primary" id="reload-detail-btn" type="button">刷新并核对新版本</button></div>`,
          });
        } else {
          toast(err.message, 'error');
        }
      }
    });
  }

  const reloadBtn = document.getElementById('reload-detail-btn');
  if (reloadBtn) reloadBtn.addEventListener('click', () => renderDetail(id));

  const editForm = document.getElementById('edit-form');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(editForm);
      try {
        await api(`/api/instructions/${id}/versions`, {
          method: 'POST',
          body: JSON.stringify({
            user_id: state.currentUserId,
            payee: fd.get('payee'),
            amount_yuan: Number(fd.get('amount')),
            expected_version: state.detail.current_version,
          }),
        });
        toast('已生成新版本，旧版本复核记录不再计入新版', 'success');
        renderDetail(id);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }
}

// ---------- 启动 ----------

loadUsers().then(route).catch((err) => {
  view.innerHTML = `<div class="alert alert-error"><strong>系统初始化失败</strong>${esc(err.message)}</div>`;
});
