import {
  api,
  deviceIcon,
  escapeHtml,
  formatAbsolute,
  formatRelative,
  toast,
} from './api.js';

const deviceList = document.querySelector('#device-list');
const statusLine = document.querySelector('#security-status');
const statOnline = document.querySelector('#stat-online');
const statSessions = document.querySelector('#stat-sessions');
const statEnded = document.querySelector('#stat-ended');
const noticeHost = document.querySelector('#security-notice');
const revokeOthersBtn = document.querySelector('#revoke-others-btn');
const dialog = document.querySelector('#confirm-dialog');

const REASON_TEXT = {
  self_signout: '本设备主动退出',
  revoked_by_device: '被其他设备退出',
  replaced_by_new_login: '该浏览器重新登录',
};

let revoked = false;
let redirecting = false;

function goToLogin() {
  if (redirecting) return;
  redirecting = true;
  window.location.replace('/');
}

function setStatus(text, state = 'saved') {
  statusLine.dataset.state = state;
  statusLine.querySelector('span:last-child').textContent = text;
}

function confirmAction({ title, text, okLabel = '确认', danger = true }) {
  return new Promise((resolve) => {
    document.querySelector('#confirm-title').textContent = title;
    document.querySelector('#confirm-text').textContent = text;
    const ok = document.querySelector('#confirm-ok');
    ok.textContent = okLabel;
    ok.className = danger ? 'btn btn--danger' : 'btn btn--primary';

    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  });
}

function sessionTimes(session) {
  const parts = [];
  parts.push(`<span><b>登录时间</b>${escapeHtml(formatAbsolute(session.createdAt))}</span>`);
  if (session.status === 'online') {
    parts.push(
      `<span><b>最后活动</b>${escapeHtml(formatRelative(session.lastSeenAt))} · ${escapeHtml(
        formatAbsolute(session.lastSeenAt),
      )}</span>`,
    );
  } else {
    parts.push(`<span><b>结束于</b>${escapeHtml(formatAbsolute(session.revokedAt))}</span>`);
  }
  return parts.join('');
}

function renderSession(session, { ended = false, activeCount = 1 } = {}) {
  const badges = [];
  if (session.isCurrent) {
    badges.push('<span class="badge badge--current"><span class="dot"></span>正在使用</span>');
  } else if (!ended) {
    badges.push('<span class="badge badge--online"><span class="dot"></span>在线</span>');
  }

  const action =
    !ended && !session.isCurrent
      ? `<button class="btn btn--sm btn--danger" type="button" data-revoke="${escapeHtml(
          session.id,
        )}" data-device="${escapeHtml(session.deviceName)}">${
          activeCount > 1 ? '退出这个会话' : '退出这台设备'
        }</button>`
      : '';

  const endedNote = ended
    ? `<span class="badge badge--ended">已结束 · ${escapeHtml(
        REASON_TEXT[session.revokedReason] ?? '已结束',
      )}${session.revokedByDeviceName ? `（由 ${escapeHtml(session.revokedByDeviceName)} 操作）` : ''}</span>`
    : '';

  return `
    <li class="session-row ${ended ? 'session-row--ended' : ''}">
      <div class="session-row__main">
        <div class="session-row__name">
          <span>会话 ${escapeHtml(session.shortId ?? session.id)}</span>
          ${badges.join('')}
          ${endedNote}
        </div>
        <div class="session-row__times">${sessionTimes(session)}</div>
      </div>
      <div class="session-row__action">${action}</div>
    </li>`;
}

function renderDevice(device) {
  const active = device.activeSessions ?? [];
  const ended = device.endedSessions ?? [];

  if (active.length === 0 && ended.length === 0) return '';

  const badges = [];
  if (device.isCurrentDevice) {
    badges.push('<span class="badge badge--current"><span class="dot"></span>当前设备</span>');
  } else if (active.length > 0) {
    badges.push(`<span class="badge badge--online"><span class="dot"></span>在线</span>`);
  } else {
    badges.push('<span class="badge badge--ended">已结束</span>');
  }

  const rows = [
    ...active.map((session) => renderSession(session, { activeCount: active.length })),
    ...ended.map((session) => renderSession(session, { ended: true })),
  ].join('');

  const endedHint =
    ended.length > 0
      ? `<p class="ended-note">这台设备上有 ${device.endedSessionTotal ?? ended.length} 条已结束的会话${
          ended.length < (device.endedSessionTotal ?? ended.length) ? `（显示最近 ${ended.length} 条）` : ''
        }；重新登录会产生一条新会话，与旧会话分开记录。</p>`
      : '';

  const iconKind = active[0]?.kind ?? ended[0]?.kind ?? 'desktop';

  return `
    <article class="card device">
      <div class="device__head">
        <div class="device__icon">${deviceIcon(iconKind)}</div>
        <div>
          <div class="device__title">
            <h3>${escapeHtml(device.deviceName)}</h3>
            ${badges.join('')}
          </div>
          <p class="device__meta">
            ${escapeHtml(device.kindLabel)} · ${escapeHtml(device.deviceSummary)}
            · ${active.length} 个在线会话
          </p>
        </div>
      </div>
      <ul class="session-list">${rows}</ul>
      ${endedHint}
    </article>`;
}

function render(data) {
  const devices = data.devices.filter(
    (device) => device.activeSessions.length > 0 || device.endedSessions.length > 0,
  );
  const onlineDevices = devices.filter((device) => device.activeSessions.length > 0);
  const onlineSessions = devices.reduce((sum, device) => sum + device.activeSessions.length, 0);
  const endedSessions =
    data.endedSessionCount ??
    devices.reduce((sum, device) => sum + device.endedSessions.length, 0);

  statOnline.textContent = String(onlineDevices.length);
  statSessions.textContent = String(onlineSessions);
  statEnded.textContent = String(endedSessions);

  deviceList.innerHTML =
    devices.map(renderDevice).join('') || '<div class="card empty">还没有登录记录。</div>';

  revokeOthersBtn.disabled = onlineSessions <= 1;
  setStatus(`已刷新 · ${formatRelative(data.checkedAt)}`, 'saved');
}

function showNotice(html) {
  noticeHost.innerHTML = html;
}

async function loadSessions({ silent = false, notice = '' } = {}) {
  if (!silent) setStatus('正在读取设备列表…', 'saving');
  try {
    const data = await api('/api/security/sessions');
    render(data);
    if (notice) showNotice(`<p class="hint hint--notice">${notice}</p>`);
    else if (!silent) showNotice('');
  } catch (error) {
    if (error.status === 401) {
      if (error.code === 'session_revoked') {
        renderRevoked(error);
      } else {
        goToLogin();
      }
      return;
    }
    setStatus(error.message, 'error');
    toast(error.message, 'danger');
  }
}

// 既接受接口错误（ApiError），也接受 session:invalid 事件（CustomEvent）。
function revokedInfo(source) {
  if (!source) return {};
  if (source.detail) return source.detail;
  return source.payload?.error ?? {};
}

function renderRevoked(source) {
  revoked = true;
  deviceList.innerHTML = '';
  revokeOthersBtn.disabled = true;
  setStatus('这台设备上的登录已结束', 'locked');
  const info = revokedInfo(source);
  const when = info.revokedAt ? `（${escapeHtml(formatAbsolute(info.revokedAt))}）` : '';
  const by = info.revokedByDeviceName
    ? `，由「${escapeHtml(info.revokedByDeviceName)}」操作`
    : '';
  showNotice(`
    <div class="card empty">
      这台设备上的登录已结束${when}${by}，已无法查看或管理会话。<br />
      <a class="btn btn--primary btn--sm" href="/">回到登录页</a>
    </div>`);
}

deviceList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-revoke]');
  if (!button) return;
  const sessionId = button.dataset.revoke;
  const deviceName = button.dataset.device;

  const ok = await confirmAction({
    title: `退出「${deviceName}」`,
    text: '退出后，这台设备上的登录立即在服务端失效。它已打开但尚未保存的内容会保留在那一端本地，可以复制出来，但无法再写回服务端。',
    okLabel: '退出这台设备',
  });
  if (!ok) return;

  button.disabled = true;
  try {
    const result = await api(`/api/security/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
    });
    toast(result.alreadyEnded ? '该会话已经结束' : `已退出「${deviceName}」`, 'success');
    await loadSessions({
      notice: `已结束「${escapeHtml(deviceName)}」上的会话。若该设备正在编辑草稿，下一次保存会被服务端拒绝。`,
    });
    // 刷新后通知的 innerHTML 由本轮 notice 生成，因此 deviceName 已经过转义。
  } catch (error) {
    button.disabled = false;
    if (error.status === 401) return;
    toast(error.message, 'danger');
  }
});

revokeOthersBtn.addEventListener('click', async () => {
  const ok = await confirmAction({
    title: '退出其他所有设备',
    text: '除当前这台设备外，其他设备上的登录都会在服务端失效。当前设备的会话不受影响，你不需要重新登录。',
    okLabel: '全部退出',
  });
  if (!ok) return;

  revokeOthersBtn.disabled = true;
  try {
    const result = await api('/api/security/sessions/revoke-others', { method: 'POST' });
    toast(
      result.revokedCount > 0 ? `已退出 ${result.revokedCount} 个会话` : '没有其他在线会话',
      'success',
    );
    await loadSessions({
      notice:
        result.revokedCount > 0
          ? `已结束其他设备上的 ${result.revokedCount} 个会话，当前设备的登录保持不变。`
          : '当前没有其他在线会话。',
    });
  } catch (error) {
    revokeOthersBtn.disabled = false;
    if (error.status !== 401) toast(error.message, 'danger');
  }
});

document.querySelector('#refresh-btn').addEventListener('click', () => loadSessions());

document.querySelector('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // 会话可能已在别处结束，直接回登录页。
  }
  goToLogin();
});

window.addEventListener('session:invalid', (event) => {
  if (revoked) return;
  if (event.detail.code === 'session_revoked') renderRevoked(event);
  else goToLogin();
});

window.addEventListener('focus', () => {
  if (revoked) return;
  loadSessions({ silent: true });
});

async function boot() {
  try {
    const me = await api('/api/me');
    document.querySelector('#user-name').textContent = me.user.displayName ?? me.user.username;
    document.querySelector('#user-avatar').textContent = (me.user.displayName ?? me.user.username).slice(0, 1);
    await loadSessions();
  } catch (error) {
    if (error.status === 401) {
      if (error.code === 'session_revoked') renderRevoked(error);
      else goToLogin();
      return;
    }
    setStatus('无法连接服务', 'error');
    deviceList.innerHTML =
      '<div class="card empty">无法连接本地服务，请确认已运行 <code>npm start</code>。</div>';
  }
}

boot();
