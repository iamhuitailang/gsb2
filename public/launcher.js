const sessionLine = document.querySelector('#session-line');
const identityRow = document.querySelector('#identity-row');
const openLinks = [document.querySelector('#open-jia'), document.querySelector('#open-yi')];

function setLoggedIn(user) {
  if (!user) {
    sessionLine.textContent = '当前未登录。请选择下面的演示账号。';
    openLinks.forEach((a) => {
      a.dataset.ready = 'false';
      a.title = '需要先登录';
    });
    return;
  }
  const orgs = user.organizations.map((org) => org.name).join(' + ') || '无组织';
  sessionLine.textContent = `当前登录：${user.user.name}（可访问：${orgs}）`;
  openLinks.forEach((a) => {
    a.dataset.ready = 'true';
    a.title = '';
  });
}

async function refresh() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return setLoggedIn(null);
    const data = await res.json();
    setLoggedIn({ user: data.user, organizations: data.organizations });
  } catch {
    sessionLine.textContent = '无法连接本地服务。';
  }
}

identityRow.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-login]');
  if (!button) return;
  button.disabled = true;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: button.dataset.login }),
    });
    if (!res.ok) throw new Error('login failed');
    await refresh();
  } catch {
    sessionLine.textContent = '登录失败，请重试。';
  } finally {
    button.disabled = false;
  }
});

refresh();
