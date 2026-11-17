const $ = (selector) => document.querySelector(selector);

const loginForm = $('#login-form');
const loginResult = $('#login-result');
const clockResult = $('#clock-result');
const status = {
  accountUsed: $('#account-used'),
  accountLimit: $('#account-limit'),
  accountBar: $('#account-bar'),
  accountRetry: $('#account-retry'),
  sourceUsed: $('#source-used'),
  sourceLimit: $('#source-limit'),
  sourceBar: $('#source-bar'),
  sourceRetry: $('#source-retry'),
  retryRows: $('#retry-rows'),
  clockValue: $('#clock-value'),
  clockOffset: $('#clock-offset'),
  logList: $('#log-list'),
};

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || '请求失败');
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function currentSelection() {
  const data = new FormData(loginForm);
  return {
    username: String(data.get('username') || ''),
    source: String(data.get('source') || ''),
  };
}

function renderStatus(snapshot) {
  status.clockValue.textContent = formatClock(snapshot.now);
  const minutes = Math.round(snapshot.clockOffsetMs / 60000);
  status.clockOffset.textContent = `偏移 ${minutes} 分钟`;

  renderMeter(
    snapshot.accountWindow,
    status.accountUsed,
    status.accountLimit,
    status.accountBar,
    status.accountRetry,
  );
  renderMeter(
    snapshot.sourceWindow,
    status.sourceUsed,
    status.sourceLimit,
    status.sourceBar,
    status.sourceRetry,
  );

  status.retryRows.innerHTML = '';
  for (const [label, win] of [
    ['账号层', snapshot.accountWindow],
    ['来源层', snapshot.sourceWindow],
  ]) {
    const row = document.createElement('tr');
    if (win.blocked && win.retryAt !== null) {
      const remaining = Math.max(0, win.retryAt - snapshot.now);
      row.innerHTML = `<td>${label}</td><td>${formatDateTime(win.retryAt)}（${formatDuration(remaining)}后）</td>`;
      row.classList.add('blocked');
    } else {
      row.innerHTML = `<td>${label}</td><td>未触发</td>`;
    }
    status.retryRows.append(row);
  }

  const overall = document.createElement('tr');
  if (snapshot.nextRetryAt !== null) {
    const remaining = Math.max(0, snapshot.nextRetryAt - snapshot.now);
    overall.innerHTML = `<td><strong>综合</strong></td><td>${formatDateTime(snapshot.nextRetryAt)}（${formatDuration(remaining)}后）</td>`;
    overall.classList.add('blocked');
  } else {
    overall.innerHTML = '<td><strong>综合</strong></td><td>现在可以尝试</td>';
  }
  status.retryRows.append(overall);
}

function renderMeter(win, usedEl, limitEl, barEl, retryEl) {
  usedEl.textContent = String(win.used);
  limitEl.textContent = String(win.limit);
  const ratio = Math.min(1, win.used / win.limit);
  barEl.style.width = `${ratio * 100}%`;
  barEl.dataset.state = win.used >= win.limit ? 'full' : win.used > 0 ? 'warn' : 'ok';
  retryEl.textContent = win.blocked && win.retryAt !== null
    ? `${formatDateTime(win.retryAt)} 后可再试`
    : '可正常尝试';
}

function formatDuration(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  if (totalMinutes >= 60) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} 小时 ${minutes} 分钟`;
  }
  return `${totalMinutes} 分钟`;
}

async function refreshStatus() {
  const { username, source } = currentSelection();
  try {
    const snapshot = await request(`/api/demo/status?account=${encodeURIComponent(username)}&source=${encodeURIComponent(source)}`);
    renderStatus(snapshot);
  } catch (error) {
    loginResult.textContent = error.message;
  }
}

async function refreshLog() {
  try {
    const { entries } = await request('/api/demo/log?limit=40');
    status.logList.innerHTML = '';
    if (entries.length === 0) {
      status.logList.innerHTML = '<li class="muted">暂无日志</li>';
      return;
    }
    for (const entry of entries) {
      const item = document.createElement('li');
      item.innerHTML = renderLogEntry(entry);
      status.logList.append(item);
    }
  } catch (error) {
    status.logList.innerHTML = `<li class="muted">${error.message}</li>`;
  }
}

function renderLogEntry(entry) {
  const time = formatClock(new Date(entry.at).getTime());
  const account = entry.account ? escapeHtml(entry.account) : '—';
  const source = entry.source ? escapeHtml(entry.source) : '—';

  switch (entry.event) {
    case 'login_blocked': {
      const layers = Array.isArray(entry.layers) && entry.layers.length > 0
        ? entry.layers
        : [entry.layer];
      const label = layers.map((layer) => (layer === 'account' ? '账号层' : '来源层')).join(' + ');
      return `<span class="tag danger">${label}限制</span>
        <span>${time} · ${account} @ ${source} 被拦截（账号 ${entry.accountFailures} 次 / 来源 ${entry.sourceFailures} 次）</span>`;
    }
    case 'login_failed':
      return `<span class="tag warn">失败</span>
        <span>${time} · ${account} @ ${source}（账号 ${entry.accountFailures} 次 / 来源 ${entry.sourceFailures} 次）</span>`;
    case 'login_success':
      return `<span class="tag ok">成功</span>
        <span>${time} · ${account} @ ${source}，已清除该账号失败计数</span>`;
    case 'state_evicted':
      return `<span class="tag danger">容量淘汰</span>
        <span>${time} · ${entry.bucket === 'accounts' ? '账号' : '来源'}层淘汰 ${entry.evictedKeys} 个键</span>`;
    case 'clock_advanced':
      return `<span class="tag muted">时钟</span><span>${time} · 前进 ${entry.minutes} 分钟</span>`;
    case 'clock_reset':
      return `<span class="tag muted">时钟</span><span>${time} · 已重置</span>`;
    case 'state_cleared':
      return `<span class="tag danger">重置</span><span>${time} · 已清空全部限流状态</span>`;
    default:
      return `<span class="tag muted">${escapeHtml(entry.event)}</span><span>${time}</span>`;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(loginForm);
  loginResult.textContent = '正在验证…';
  try {
    await request('/api/demo/login', {
      method: 'POST',
      body: JSON.stringify({
        username: data.get('username'),
        password: data.get('password'),
        source: data.get('source'),
      }),
    });
    loginResult.textContent = '登录成功。';
    loginResult.dataset.state = 'ok';
  } catch (error) {
    // 服务端对限流与密码错误返回同一句话，这里直接展示即可。
    loginResult.textContent = error.message;
    loginResult.dataset.state = 'error';
  }
  await Promise.all([refreshStatus(), refreshLog()]);
});

for (const button of document.querySelectorAll('[data-advance]')) {
  button.addEventListener('click', async () => {
    try {
      const result = await request('/api/demo/clock', {
        method: 'POST',
        body: JSON.stringify({ advanceMinutes: Number(button.dataset.advance) }),
      });
      clockResult.textContent = `时钟已前进到 ${formatClock(result.now)}`;
      await Promise.all([refreshStatus(), refreshLog()]);
    } catch (error) {
      clockResult.textContent = error.message;
    }
  });
}

$('#reset-clock').addEventListener('click', async () => {
  try {
    const result = await request('/api/demo/clock/reset', { method: 'POST', body: '{}' });
    clockResult.textContent = `时钟已重置到 ${formatClock(result.now)}`;
    await Promise.all([refreshStatus(), refreshLog()]);
  } catch (error) {
    clockResult.textContent = error.message;
  }
});

$('#reset-state').addEventListener('click', async () => {
  try {
    await request('/api/demo/reset', { method: 'POST', body: '{}' });
    clockResult.textContent = '已清空全部限流状态。';
    await Promise.all([refreshStatus(), refreshLog()]);
  } catch (error) {
    clockResult.textContent = error.message;
  }
});

$('#refresh-status').addEventListener('click', refreshStatus);
$('#refresh-log').addEventListener('click', refreshLog);
loginForm.addEventListener('change', refreshStatus);

refreshStatus();
refreshLog();
setInterval(refreshStatus, 5000);
