import { api, formatAbsolute, formatRelative, toast } from './api.js';

const params = new URLSearchParams(window.location.search);
const draftId = params.get('id');

const loadingEl = document.querySelector('#editor-loading');
const bodyEl = document.querySelector('#editor-body');
const titleEl = document.querySelector('#draft-title');
const editor = document.querySelector('#editor');
const saveBtn = document.querySelector('#save-btn');
const revertBtn = document.querySelector('#revert-btn');
const statusEl = document.querySelector('#save-status');
const statusText = document.querySelector('#save-status-text');
const lockedBanner = document.querySelector('#locked-banner');
const lockedTitle = document.querySelector('#locked-title');
const lockedText = document.querySelector('#locked-text');
const localHint = document.querySelector('#local-hint');
const conflictBox = document.querySelector('#conflict-box');
const conflictContent = document.querySelector('#conflict-content');

const state = {
  draft: null,
  baseVersion: null,
  lastSavedContent: '',
  dirty: false,
  locked: false,
  saving: false,
  saveTimer: null,
  conflict: null,
};

const backupKey = draftId ? `gsb2:draft-backup:${draftId}` : null;

function setStatus(text, status = 'saved') {
  statusEl.dataset.state = status;
  statusText.textContent = text;
}

function setLocked({
  reason = 'revoked',
  revokedAt = null,
  byDevice = null,
  contentKnown = true,
} = {}) {
  state.locked = true;
  editor.readOnly = true;
  saveBtn.disabled = true;
  revertBtn.disabled = true;
  setStatus(state.dirty ? '登录已结束 · 内容仅保存在本地' : '登录已结束 · 请重新登录', 'locked');
  lockedBanner.classList.add('is-visible');

  if (reason === 'revoked') {
    lockedTitle.textContent = '这台设备上的登录已结束';
    const when = revokedAt ? formatAbsolute(revokedAt) : '刚才';
    const by = byDevice ? `（由「${byDevice}」操作）` : '';
    let detail;
    if (!contentKnown) {
      detail = state.dirty
        ? '这台浏览器里还保留着上次未保存的内容，可以复制或下载。'
        : '本页的草稿没有加载出来，也没有本地副本；重新登录后可以继续编辑。';
    } else if (state.dirty) {
      detail =
        '本页尚未保存的内容仍保留在编辑框和本地副本里，可以复制或下载；保存请求不会再写入服务端。';
    } else {
      detail = '本页内容已经是服务端的最新版本，重新登录后可以继续编辑。';
    }
    lockedText.textContent = `服务端已于 ${when}${by}使这台设备的会话失效。${detail}`;
  } else {
    lockedTitle.textContent = '无法保存';
    lockedText.textContent = '当前页面已无法写入服务端，本页内容仍保留在本地。';
  }
  if (state.dirty) persistBackup();
}

function updateButtons() {
  const hasChanges = state.dirty;
  saveBtn.disabled = state.locked || state.saving || !hasChanges;
  revertBtn.disabled = state.locked || state.saving || !hasChanges;
  saveBtn.textContent = state.saving ? '保存中…' : '保存';
}

function readBackup() {
  if (!backupKey) return null;
  try {
    const raw = window.localStorage.getItem(backupKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.content !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function persistBackup() {
  if (!backupKey) return;
  try {
    const existing = readBackup();

    if (!editor.value.trim()) {
      if (state.dirty && !state.locked) {
        // 用户主动清空了还未同步的内容：不能留下会「复活」的旧副本。
        window.localStorage.removeItem(backupKey);
        localHint.textContent = '';
        return;
      }
      // 本页没有内容：保留浏览器里已有的副本。
      if (existing?.content) {
        localHint.textContent = `这台浏览器里还保存着 ${formatAbsolute(
          existing.savedAt,
        )} 的一份本地副本；本页当前没有可保存的内容。`;
      }
      return;
    }

    // 已与服务器同步、也没有被下线：不需要本地副本。
    if (!state.dirty && !state.locked) {
      window.localStorage.removeItem(backupKey);
      localHint.textContent = '';
      return;
    }

    const payload = {
      content: editor.value,
      baseVersion: state.baseVersion,
      savedAt: new Date().toISOString(),
      draftTitle: state.draft?.title ?? '',
    };
    window.localStorage.setItem(backupKey, JSON.stringify(payload));
    localHint.textContent = `本页还有未写回服务端的内容，已自动保存在这台浏览器的本地（${formatAbsolute(
      payload.savedAt,
    )}）。${
      state.locked ? '即使关闭页面，下次用同一浏览器打开这份草稿仍可找回。' : ''
    }`;
  } catch {
    localHint.textContent = '无法写入浏览器本地存储，请尽快复制内容。';
  }
}

function clearBackup() {
  if (!backupKey) return;
  try {
    window.localStorage.removeItem(backupKey);
  } catch {
    // 忽略
  }
  localHint.textContent = '';
}

function markDirty() {
  state.dirty = editor.value !== state.lastSavedContent;
  clearTimeout(state.saveTimer);
  if (state.dirty) {
    setStatus('有未保存的修改', 'dirty');
    state.saveTimer = setTimeout(persistBackup, 300);
  } else {
    // 改回已保存的内容：清掉旧的本地副本，避免下次打开误恢复过期版本。
    if (!state.locked) setStatus('已是最新', 'saved');
    persistBackup();
  }
  updateButtons();
}

function applyDraft(draft) {
  state.draft = draft;
  state.baseVersion = draft.version;
  document.title = `${draft.title} · 轻协作`;
  titleEl.textContent = draft.title;
  editor.value = draft.content;
  state.lastSavedContent = draft.content;
  state.dirty = false;
  updateButtons();
}

// 兜底复制只针对编辑框自身的内容；不能用来复制其它文本（那会清掉用户正在编辑的选区）。
function fallbackCopyEditor(successMessage) {
  editor.focus();
  editor.select();
  const ok = document.execCommand?.('copy');
  toast(ok ? successMessage : '复制失败，请手动全选复制', ok ? 'success' : 'danger');
}

function copyText(text, successMessage = '已复制到剪贴板', { fromEditor = false } = {}) {
  const fallback = () => {
    if (fromEditor) {
      fallbackCopyEditor(successMessage);
      return;
    }
    toast('复制失败，请手动选中后复制', 'danger');
  };

  // 没有 Clipboard API（非安全上下文等）时直接走兜底，避免对 undefined 调用 .then。
  if (!navigator.clipboard?.writeText) {
    fallback();
    return;
  }
  navigator.clipboard.writeText(text).then(() => toast(successMessage, 'success'), fallback);
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function loadDraft() {
  if (!draftId) {
    loadingEl.textContent = '缺少草稿编号，请从草稿列表进入。';
    return;
  }
  try {
    // 先确认会话，再读草稿：会话已结束时不要先把内容渲染出来再丢掉。
    const me = await api('/api/me');
    document.querySelector('#user-name').textContent = me.user.displayName ?? me.user.username;
    document.querySelector('#user-avatar').textContent = (me.user.displayName ?? me.user.username).slice(0, 1);

    const data = await api(`/api/drafts/${encodeURIComponent(draftId)}`);

    applyDraft(data.draft);
    loadingEl.hidden = true;
    bodyEl.hidden = false;

    const backup = readBackup();
    if (backup && backup.content !== data.draft.content) {
      editor.value = backup.content;
      state.dirty = true;
      // 用备份当初所基于的版本去保存：如果服务端此后又变了，会得到 409 而不是悄悄覆盖。
      state.baseVersion = Number.isInteger(backup.baseVersion)
        ? backup.baseVersion
        : data.draft.version;
      setStatus('已恢复本地未保存内容', 'dirty');
      updateButtons();
      persistBackup();
      toast('已恢复上次在这台浏览器里未保存的内容', 'info');
    } else {
      if (backup) clearBackup();
      setStatus(`已同步 · v${data.draft.version}`, 'saved');
    }
    editor.focus();
  } catch (error) {
    if (error.status === 401) {
      if (error.code === 'session_revoked') {
        showLockedWithoutDraft(error);
      } else {
        loadingEl.innerHTML =
          '请先登录。 <a class="btn btn--sm btn--primary" href="/">回到登录页</a>';
      }
      return;
    }
    loadingEl.textContent = error.message;
  }
}

function showLockedWithoutDraft(error) {
  loadingEl.hidden = true;
  bodyEl.hidden = false;
  state.draft = { title: '草稿' };
  // 先恢复本地副本，再锁定；锁定过程会再次落盘，不应把已有副本当成「已同步」清掉。
  const backup = readBackup();
  editor.value = backup?.content ?? '';
  state.lastSavedContent = '';
  state.dirty = editor.value.length > 0;
  setLocked({
    reason: 'revoked',
    revokedAt: error.payload?.error?.revokedAt,
    byDevice: error.payload?.error?.revokedByDeviceName,
    contentKnown: false,
  });
  updateButtons();
}

async function save({ auto = false } = {}) {
  if (state.locked || state.saving || !state.dirty) return;
  if (!draftId) {
    toast('缺少草稿编号，无法保存', 'danger');
    return;
  }

  state.saving = true;
  updateButtons();
  setStatus('正在保存…', 'saving');
  clearTimeout(state.saveTimer);

  // 记录本次实际发出的内容：请求期间用户可能继续输入，不能把新输入误判为已保存。
  const sentContent = editor.value;
  try {
    const result = await api(`/api/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: { content: sentContent, baseVersion: state.baseVersion },
    });
    state.saving = false;
    state.lastSavedContent = sentContent;
    state.baseVersion = result.draft.version;
    state.dirty = editor.value !== sentContent;
    state.conflict = null;
    conflictBox.classList.remove('is-visible');
    if (state.dirty) {
      setStatus('已保存上一版，又有新的修改', 'dirty');
      persistBackup();
    } else {
      clearBackup();
      setStatus(`已保存 · v${result.draft.version} · ${formatRelative(result.draft.updatedAt)}`, 'saved');
    }
    updateButtons();
    if (!auto) toast('已保存到服务端', 'success');
  } catch (error) {
    state.saving = false;
    updateButtons();

    if (error.status === 401) {
      if (error.code === 'session_revoked') {
        setLocked({
          reason: 'revoked',
          revokedAt: error.payload?.error?.revokedAt,
          byDevice: error.payload?.error?.revokedByDeviceName,
        });
        toast('保存被拒绝：这台设备上的登录已被结束', 'danger');
      } else {
        setLocked({ reason: 'unauthenticated' });
        toast('保存被拒绝：请重新登录', 'danger');
      }
      // setLocked 已经按需保存了本地副本，这里不再重复写入。
      return;
    }

    if (error.status === 409 && error.code === 'version_conflict') {
      state.conflict = error.payload.error;
      conflictContent.textContent = error.payload.error.currentContent ?? '';
      conflictBox.classList.add('is-visible');
      setStatus('保存未完成：服务端内容已更新', 'error');
      persistBackup();
      toast('服务端上的草稿已被更新，本次保存没有写入', 'danger');
      return;
    }

    setStatus(`保存失败：${error.message}`, 'error');
    persistBackup();
    if (!auto) toast(`保存失败：${error.message}`, 'danger');
  }
}

editor.addEventListener('input', () => {
  if (state.locked) return;
  markDirty();
});

editor.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
});

saveBtn.addEventListener('click', () => save());

// 放弃本次修改，回到最后一次成功保存的内容（没有冲突时）或服务器上的最新内容（有冲突时）。
function revertToLastSaved() {
  if (state.conflict) {
    acceptServerVersion();
    return;
  }
  editor.value = state.lastSavedContent;
  markDirty();
}

revertBtn.addEventListener('click', revertToLastSaved);

function acceptServerVersion() {
  if (!state.conflict) return;
  editor.value = state.conflict.currentContent ?? '';
  state.baseVersion = state.conflict.currentVersion ?? state.baseVersion;
  state.lastSavedContent = editor.value;
  state.conflict = null;
  state.dirty = false;
  conflictBox.classList.remove('is-visible');
  clearBackup();
  setStatus(`已用服务器版本重新加载 · v${state.baseVersion}`, 'saved');
  updateButtons();
}

// 在明确提示冲突后，用户仍然选择保留自己的版本：以服务器最新版本为基线再写一次。
async function overwriteWithLocal() {
  if (!state.conflict) return;
  const confirmed = window.confirm(
    '这会用本页的内容覆盖服务器上的最新版本，其他人刚才的修改将丢失。确定继续吗？',
  );
  if (!confirmed) return;

  state.baseVersion = state.conflict.currentVersion ?? state.baseVersion;
  state.conflict = null;
  conflictBox.classList.remove('is-visible');
  state.dirty = editor.value !== state.lastSavedContent;
  if (!state.dirty) {
    setStatus(`已用服务器版本重新加载 · v${state.baseVersion}`, 'saved');
    updateButtons();
    clearBackup();
    return;
  }
  await save();
}

document.querySelector('#copy-local-btn').addEventListener('click', () => {
  copyText(editor.value, '已复制本地内容', { fromEditor: true });
});

document.querySelector('#download-local-btn').addEventListener('click', () => {
  const name = `${state.draft?.title ?? '草稿'}-本地副本.txt`;
  downloadText(editor.value, name);
});

document.querySelector('#discard-local-btn').addEventListener('click', () => {
  const ok = window.confirm('这会删除这台浏览器里保存的本地副本和编辑框里的内容。确定继续吗？');
  if (!ok) return;
  clearBackup();
  editor.value = '';
  state.dirty = false;
  updateButtons();
  localHint.textContent = '本页内容已清空，浏览器里不再保留本地副本。';
});

document.querySelector('#conflict-copy-btn').addEventListener('click', () => {
  copyText(state.conflict?.currentContent ?? '', '已复制服务器版本');
});

document.querySelector('#conflict-reload-btn').addEventListener('click', acceptServerVersion);

document.querySelector('#conflict-overwrite-btn').addEventListener('click', overwriteWithLocal);

document.querySelector('#logout-btn').addEventListener('click', async () => {
  if (state.dirty && !state.locked) {
    const ok = window.confirm('本页还有未保存的修改，仍要退出登录吗？本地会保留一份副本。');
    if (!ok) return;
    persistBackup();
  }
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // 会话可能已结束
  }
  window.location.href = '/';
});

window.addEventListener('session:invalid', (event) => {
  if (event.detail.code !== 'session_revoked' || state.locked) return;
  if (state.saving) return;
  setLocked({
    reason: 'revoked',
    revokedAt: event.detail.revokedAt,
    byDevice: event.detail.revokedByDeviceName,
  });
});

// 切回编辑页时安静地核对一次服务端会话：被下线后即使还没点保存，也能及时看到提示。
// 编辑框里的内容不会被动过；真正的写入拦截仍然发生在保存时。
async function revalidateSession() {
  if (state.locked || state.saving || !draftId) return;
  try {
    await api('/api/me');
  } catch {
    // 401 会通过 api.js 广播 session:invalid，由上面的监听器统一处理。
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') revalidateSession();
});

window.addEventListener('beforeunload', (event) => {
  if (!state.dirty || state.locked) return;
  event.preventDefault();
  event.returnValue = '';
});

// 关页/切走时立刻落盘，避免 300ms 防抖窗口内丢内容。
window.addEventListener('pagehide', () => {
  if (!state.dirty) return;
  clearTimeout(state.saveTimer);
  persistBackup();
});

loadDraft();
