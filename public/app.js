import { api, escapeHtml, formatRelative, toast } from './api.js';

const loginView = document.querySelector('#login-view');
const appView = document.querySelector('#app-view');
const loginForm = document.querySelector('#login-form');
const loginError = document.querySelector('#login-error');
const loginSubmit = document.querySelector('#login-submit');
const draftGrid = document.querySelector('#draft-grid');
const draftCount = document.querySelector('#draft-count');
const userName = document.querySelector('#user-name');
const userAvatar = document.querySelector('#user-avatar');
const deviceNameInput = document.querySelector('#device-name');

// 记住这个浏览器上次填写的设备名：重新登录时默认沿用，安全页才能把同一台设备的新旧会话归在一起。
const DEVICE_NAME_KEY = 'gsb2:device-name';

try {
  const remembered = window.localStorage.getItem(DEVICE_NAME_KEY);
  if (remembered) deviceNameInput.value = remembered;
} catch {
  // 本地存储不可用时忽略。
}

function showLogin(message = '') {
  appView.hidden = true;
  loginView.hidden = false;
  draftGrid.innerHTML = '';
  if (message) {
    loginError.textContent = message;
    loginError.classList.add('is-visible');
  } else {
    loginError.classList.remove('is-visible');
  }
  document.querySelector('#username').focus();
}

function showApp() {
  loginView.hidden = true;
  appView.hidden = false;
}

function renderUser(user) {
  userName.textContent = user.displayName ?? user.username;
  userAvatar.textContent = (user.displayName ?? user.username).slice(0, 1);
}

function excerpt(content) {
  const compact = String(content ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(1)
    .join(' ');
  return compact.slice(0, 120) || '还没有内容';
}

function renderDrafts(drafts) {
  draftCount.dataset.state = 'saved';
  draftCount.querySelector('span:last-child').textContent = `服务端共 ${drafts.length} 份草稿`;

  if (drafts.length === 0) {
    draftGrid.innerHTML = '<div class="card empty">还没有草稿。</div>';
    return;
  }

  draftGrid.innerHTML = drafts
    .map(
      (draft) => `
        <a class="card draft-card" href="/editor?id=${encodeURIComponent(draft.id)}">
          <h2>${escapeHtml(draft.title)}</h2>
          <p>${escapeHtml(excerpt(draft.content))}</p>
          <footer>
            <span>版本 v${draft.version}</span>
            <span>更新于 ${escapeHtml(formatRelative(draft.updatedAt))}</span>
          </footer>
        </a>`,
    )
    .join('');
}

async function loadDrafts({ silent = false } = {}) {
  if (!silent) {
    draftCount.dataset.state = 'saving';
    draftCount.querySelector('span:last-child').textContent = '读取中…';
  }
  try {
    const data = await api('/api/drafts');
    renderDrafts(data.drafts);
  } catch (error) {
    if (error.status === 401) {
      // 会话已在服务端结束：回到登录表单，并说明原因。
      showLogin(
        error.code === 'session_revoked'
          ? '这台设备上的登录已被其他设备结束，请重新登录。'
          : '登录已过期，请重新登录。',
      );
      return;
    }
    draftCount.dataset.state = 'error';
    draftCount.querySelector('span:last-child').textContent = error.message;
    if (!silent) toast(error.message, 'danger');
  }
}

async function boot() {
  try {
    const me = await api('/api/me');
    renderUser(me.user);
    showApp();
    await loadDrafts();
  } catch (error) {
    if (error.status === 401) {
      showLogin(error.code === 'session_revoked' ? '这台设备上的登录已结束，请重新登录。' : '');
      return;
    }
    showLogin('无法连接服务，请确认本地服务已启动。');
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginSubmit.disabled = true;
  loginError.classList.remove('is-visible');
  try {
    const deviceName = deviceNameInput.value;
    const data = await api('/api/login', {
      method: 'POST',
      body: {
        username: document.querySelector('#username').value,
        password: document.querySelector('#password').value,
        deviceName,
        kind: document.querySelector('#device-kind').value,
      },
    });
    try {
      if (deviceName.trim()) window.localStorage.setItem(DEVICE_NAME_KEY, deviceName.trim());
    } catch {
      // 忽略
    }
    renderUser(data.user);
    showApp();
    await loadDrafts();
    toast('已登录', 'success');
  } catch (error) {
    loginError.textContent = error.message;
    loginError.classList.add('is-visible');
  } finally {
    loginSubmit.disabled = false;
  }
});

document.querySelector('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // 服务端会话可能已经结束，本地仍然回到登录页。
  }
  showLogin('已退出登录。');
  toast('已退出登录');
});

document.querySelector('#refresh-btn').addEventListener('click', () => loadDrafts());

window.addEventListener('session:invalid', (event) => {
  if (event.detail.code === 'session_revoked') {
    showLogin('这台设备上的登录已被其他设备结束。');
  }
});

// 页面重新获得焦点时同步一次服务端状态，便于演示「另一端已下线」。
window.addEventListener('focus', () => {
  if (!appView.hidden) loadDrafts({ silent: true });
});

boot();
