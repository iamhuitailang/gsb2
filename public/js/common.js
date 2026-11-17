// 前端统一请求封装：Cookie 会话、JSON 解析、错误透出
async function api(method, path, body) {
  const options = {
    method,
    headers: {},
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(path, options);
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    const err = new Error(data?.error?.message || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function currentUser() {
  try {
    const data = await api('GET', '/api/auth/me');
    return data.user;
  } catch {
    return null;
  }
}

// 页面级守卫：要求登录且角色匹配，否则跳转登录页
async function guard(role) {
  const user = await currentUser();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  if (role && user.role !== role) {
    window.location.href = user.role === 'supervisor' ? '/admin.html' : '/customer.html';
    return null;
  }
  return user;
}

function showAlert(id, message, type = 'error') {
  const el = document.getElementById(id);
  el.className = `alert show ${type}`;
  el.textContent = message;
}

function hideAlert(id) {
  const el = document.getElementById(id);
  el.className = 'alert';
  el.textContent = '';
}

async function logout() {
  await api('POST', '/api/auth/logout');
  window.location.href = '/login.html';
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderTopbar(user, active) {
  const links =
    user.role === 'supervisor'
      ? [
          { href: '/admin.html', label: '维护后台' },
          { href: '/audit.html', label: '审计记录' },
          { href: '/demo.html', label: '演示请求' },
        ]
      : [
          { href: '/customer.html', label: '我的资料' },
          { href: '/demo.html', label: '演示请求' },
        ];
  const nav = links
    .map(
      (l) =>
        `<a href="${l.href}" class="${active === l.href ? 'style="color:var(--primary);font-weight:600"' : ''}">${l.label}</a>`,
    )
    .join('');
  const roleLabel = user.role === 'supervisor' ? `主管 · 门店 #${user.storeId}` : '客户';
  document.getElementById('topbar').innerHTML = `
    <span class="brand">客户资料中心</span>
    <nav>${nav}</nav>
    <span class="user">${esc(user.displayName)}（${roleLabel}）</span>
    <button class="secondary small" onclick="logout()">退出</button>
  `;
}
