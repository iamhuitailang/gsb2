"use strict";

const state = {
  user: null,
  csrf: "",
  folderId: null,
  batch: "",
  keyword: "",
  folders: [],
  batches: [],
  manifest: null,
  permit: null, // { permit, operation_id, expires_at, count, folder_id, batch, keyword }
  countdownTimer: null,
  confirmManifest: null,
  historyLoaded: false,
};

const $ = (id) => document.getElementById(id);

async function api(path, { method = "GET", body = null } = {}) {
  const headers = { "X-CSRF-Token": state.csrf };
  if (body !== null) headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = { error: "bad_response", message: "服务器返回内容无法解析。" };
  }
  if (!response.ok) {
    const error = new Error(data.message || "请求失败。");
    error.status = response.status;
    error.code = data.error;
    error.payload = data;
    // Only a dead session sends the operator back to the login screen; a
    // rejected re-authentication (bad password) must stay in context.
    if (data.error === "unauthorized") {
      showLogin();
    }
    throw error;
  }
  return data;
}

function showLogin() {
  clearPermit();
  state.user = null;
  state.csrf = "";
  $("app-view").hidden = true;
  $("login-view").hidden = false;
}

/* ------------------------------------------------------------- rendering */

function showBanner(kind, title, text, actions = []) {
  const banner = $("banner");
  banner.className = `banner ${kind}`;
  banner.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = title;
  banner.appendChild(strong);
  if (text) {
    const p = document.createElement("span");
    p.textContent = text;
    banner.appendChild(p);
  }
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost banner-action";
    button.textContent = action.label;
    button.addEventListener("click", action.onClick);
    banner.appendChild(button);
  }
  banner.hidden = false;
}

function hideBanner() {
  const banner = $("banner");
  banner.hidden = true;
  banner.replaceChildren();
}

function fmtTime(epoch) {
  if (!epoch) return "—";
  const date = new Date(epoch * 1000);
  return date.toLocaleString("zh-CN", { hour12: false });
}

function renderFolders() {
  const list = $("folder-list");
  list.replaceChildren();
  for (const folder of state.folders) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = folder.name;
    if (folder.id === state.folderId) button.classList.add("active");
    button.addEventListener("click", () => {
      if (folder.id === state.folderId) return;
      applyScope({ folder_id: folder.id, batch: "", keyword: "" });
    });
    li.appendChild(button);
    list.appendChild(li);
  }
}

function renderBatches() {
  const select = $("scope-batch");
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部批次";
  select.appendChild(all);
  const values = [...state.batches];
  if (state.batch && !values.includes(state.batch)) values.push(state.batch);
  for (const batch of values) {
    const option = document.createElement("option");
    option.value = batch;
    option.textContent = batch;
    select.appendChild(option);
  }
  select.value = state.batch || "";
  $("scope-keyword").value = state.keyword || "";
}

function renderManifest(manifest) {
  state.manifest = manifest;
  $("manifest-title").textContent = manifest.folder_name
    ? `清理范围 · ${manifest.folder_name}`
    : "清理范围";
  $("manifest-meta").textContent = manifest.filter_label || "—";
  $("record-count").textContent = String(manifest.count);
  $("record-digest").textContent = manifest.digest
    ? manifest.digest.slice(0, 16)
    : "—";

  const rows = $("record-rows");
  rows.replaceChildren();
  for (const record of manifest.records) {
    const tr = document.createElement("tr");
    const idCell = document.createElement("td");
    idCell.className = "num";
    idCell.textContent = String(record.id);
    const titleCell = document.createElement("td");
    titleCell.textContent = record.title;
    const batchCell = document.createElement("td");
    batchCell.textContent = record.batch;
    tr.append(idCell, titleCell, batchCell);
    rows.appendChild(tr);
  }
  $("empty-scope").hidden = manifest.records.length > 0;
  $("open-confirm").disabled = manifest.count === 0;
  updatePermitCard();
}

function permitMatchesScope() {
  if (!state.permit) return false;
  const sameScope =
    state.permit.folder_id === state.folderId &&
    state.permit.batch === (state.batch || "") &&
    state.permit.keyword === (state.keyword || "");
  if (!sameScope) return false;
  // If the displayed manifest no longer matches the confirmed record set
  // (for example new records arrived), the permit must not be used.
  if (state.manifest && state.permit.digest) {
    return state.manifest.digest === state.permit.digest;
  }
  return true;
}

function updatePermitCard() {
  const card = $("permit-card");
  if (!state.permit) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const permit = state.permit;
  $("permit-operation").textContent = permit.operation_id;
  $("permit-count").textContent = String(permit.count);
  $("permit-expiry").textContent = fmtTime(permit.expires_at);
  const submit = $("submit-btn");
  const matches = permitMatchesScope();
  const now = Date.now() / 1000;
  const expired = now >= permit.expires_at;
  submit.disabled = !matches || expired;
  if (expired) {
    $("permit-countdown").textContent = "许可已过期，请重新确认清单。";
  } else if (!matches) {
    $("permit-countdown").textContent =
      "当前清单与该许可不一致（筛选或资料条数已变化），许可暂不可用；核对清单后需重新确认。";
  } else {
    const left = Math.max(0, Math.floor(permit.expires_at - now));
    $("permit-countdown").textContent = `剩余 ${left} 秒。`;
  }
}

function startCountdown() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updatePermitCard, 1000);
}

function clearPermit() {
  state.permit = null;
  updatePermitCard();
}

function renderHistory(operations) {
  const rows = $("history-rows");
  rows.replaceChildren();
  $("history-empty").hidden = operations.length > 0;
  for (const operation of operations) {
    const tr = document.createElement("tr");
    const time = document.createElement("td");
    time.textContent = fmtTime(operation.completed_at);
    const scope = document.createElement("td");
    scope.textContent = operation.filter_label;
    const count = document.createElement("td");
    count.className = "num";
    count.textContent = String(operation.record_count);
    const user = document.createElement("td");
    user.textContent = operation.completed_by || operation.username;
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = "查看清单";
    button.addEventListener("click", () => loadHistoryDetail(operation.id));
    action.appendChild(button);
    tr.append(time, scope, count, user, action);
    rows.appendChild(tr);
  }
}

async function loadHistoryDetail(operationId) {
  const data = await api(`/api/history/${operationId}`);
  const operation = data.operation;
  $("history-detail").hidden = false;
  $("history-detail-meta").textContent =
    `${operation.filter_label} · 共 ${operation.record_count} 条 · ` +
    `操作者 ${operation.completed_by || operation.username} · ${fmtTime(operation.completed_at)}`;

  const rows = $("history-detail-rows");
  rows.replaceChildren();
  for (const record of operation.records) {
    const tr = document.createElement("tr");
    const idCell = document.createElement("td");
    idCell.className = "num";
    idCell.textContent = String(record.id);
    const titleCell = document.createElement("td");
    titleCell.textContent = record.title;
    const batchCell = document.createElement("td");
    batchCell.textContent = record.batch;
    tr.append(idCell, titleCell, batchCell);
    rows.appendChild(tr);
  }

  const labels = {
    permit_issued: "生成短期许可",
    permit_discarded: "放弃短期许可",
    cleanup_completed: "完成清理",
    submit_denied: "拒绝提交",
    permit_revoked: "许可作废",
    confirm_denied: "确认被拒",
    scope_set: "调整筛选",
    login: "登录",
    logout: "退出",
  };
  const audit = $("history-audit");
  audit.replaceChildren();
  for (const event of data.audit) {
    const li = document.createElement("li");
    const label = labels[event.action] || event.action;
    li.textContent = `${fmtTime(event.at)} · ${label}`;
    if (event.username) li.textContent += ` · ${event.username}`;
    if (event.record_count != null) {
      li.textContent += ` · ${event.record_count} 条`;
    }
    if (event.detail && event.detail.reason) {
      li.textContent += ` · 原因：${event.detail.reason}`;
    }
    audit.appendChild(li);
  }
  $("history-detail").scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------------------------------------------------------- actions */

async function loadState() {
  const data = await api("/api/state");
  state.user = data.user;
  state.csrf = data.csrf;
  state.folderId = data.folder_id;
  state.batch = data.batch || "";
  state.keyword = data.keyword || "";
  state.folders = data.folders || [];
  state.batches = data.batches || [];
  $("whoami").textContent = `当前用户：${state.user}`;
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  renderFolders();
  renderBatches();
  renderManifest(data.manifest);
  startCountdown();
}

async function applyScope(payload) {
  hideBanner();
  try {
    await api("/api/scope", { method: "POST", body: payload });
    await loadState();
    if (state.permit && !permitMatchesScope()) {
      showBanner(
        "warn",
        "当前范围与许可不一致",
        "刚才的短期许可只对确认时的目录与筛选有效，不能用于当前清单。"
      );
    }
  } catch (error) {
    handleError(error, "调整筛选失败");
  }
}

function openConfirmModal() {
  const manifest = state.manifest;
  if (!manifest || manifest.count === 0) return;
  state.confirmManifest = manifest;
  $("confirm-folder").textContent = manifest.folder_name || "—";
  $("confirm-filter").textContent = manifest.filter_label || "—";
  $("confirm-count").textContent = String(manifest.count);
  const rows = $("confirm-rows");
  rows.replaceChildren();
  for (const record of manifest.records) {
    const tr = document.createElement("tr");
    const idCell = document.createElement("td");
    idCell.className = "num";
    idCell.textContent = String(record.id);
    const titleCell = document.createElement("td");
    titleCell.textContent = record.title;
    tr.append(idCell, titleCell);
    rows.appendChild(tr);
  }
  $("confirm-note").textContent =
    `校验指纹 ${manifest.digest.slice(0, 16)}。确认后生成的许可仅在当前会话有效。`;
  $("confirm-password").value = "";
  $("confirm-error").textContent = "";
  $("confirm-modal").hidden = false;
  $("confirm-password").focus();
}

function closeConfirmModal() {
  $("confirm-modal").hidden = true;
  state.confirmManifest = null;
}

async function submitConfirm(event) {
  event.preventDefault();
  const manifest = state.confirmManifest;
  if (!manifest) return;
  const password = $("confirm-password").value;
  if (!password) {
    $("confirm-error").textContent = "请输入登录密码。";
    return;
  }
  const button = event.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await api("/api/confirm", {
      method: "POST",
      body: {
        folder_id: manifest.folder_id,
        batch: manifest.batch,
        keyword: manifest.keyword,
        digest: manifest.digest,
        password,
      },
    });
    state.permit = {
      permit: result.permit,
      operation_id: result.operation_id,
      expires_at: result.expires_at,
      count: result.manifest.count,
      digest: result.manifest.digest,
      folder_id: result.manifest.folder_id,
      batch: result.manifest.batch,
      keyword: result.manifest.keyword,
    };
    closeConfirmModal();
    renderManifest(result.manifest);
    showBanner(
      "ok",
      "身份验证通过，短期许可已生成",
      `许可绑定当前会话与本次 ${result.manifest.count} 条记录，${result.expires_in} 秒内有效。`
    );
  } catch (error) {
    const payload = error.payload || {};
    if (error.code === "scope_changed" || error.code === "scope_drift") {
      closeConfirmModal();
      if (payload.manifest) {
        applyManifestFromServer(payload.manifest);
      }
      showBanner(
        "warn",
        "清单已变化，请重新确认",
        error.message
      );
    } else if (error.code === "already_processed") {
      closeConfirmModal();
      showBanner(
        "ok",
        "本次操作已处理",
        "这套清单已经完成过清理，不会重复删除。"
      );
    } else {
      $("confirm-error").textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
}

function applyManifestFromServer(manifest) {
  if (manifest.folder_id != null) {
    state.folderId = manifest.folder_id;
    renderFolders();
  }
  state.batch = manifest.batch || "";
  state.keyword = manifest.keyword || "";
  renderBatches();
  renderManifest(manifest);
}

async function submitPermit() {
  if (!state.permit) return;
  const button = $("submit-btn");
  button.disabled = true;
  try {
    const result = await api("/api/submit", {
      method: "POST",
      body: { permit: state.permit.permit },
    });
    clearPermit();
    const operation = result.operation;
    showBanner(
      "ok",
      "清理完成",
      `已删除 ${operation.record_count} 条资料，操作者 ${operation.completed_by}。`,
      [
        {
          label: "查看清理记录",
          onClick: () => {
            switchTab("history");
            loadHistory();
          },
        },
      ]
    );
    const manifest = await api("/api/preview");
    applyManifestFromServer(manifest);
    state.historyLoaded = false;
  } catch (error) {
    if (error.code === "scope_drift") {
      const payload = error.payload || {};
      if (payload.manifest) applyManifestFromServer(payload.manifest);
      clearPermit();
      showBanner(
        "warn",
        "许可已作废",
        "确认之后清单发生了变化。请核对新的清单，再次确认清理。"
      );
    } else if (error.code === "already_processed") {
      clearPermit();
      const operation = (error.payload || {}).operation;
      showBanner(
        "ok",
        "本次操作已处理",
        operation
          ? `该批资料已在 ${fmtTime(operation.completed_at)} 由 ${operation.completed_by || operation.username} 清理，不会重复删除。`
          : "这套清单已经完成过清理，不会重复删除。"
      );
      try {
        const preview = await api("/api/preview");
        applyManifestFromServer(preview);
      } catch (refreshError) {
        /* keep the banner; the manifest will refresh on the next action */
      }
    } else if (error.code === "scope_changed") {
      const payload = error.payload || {};
      if (payload.manifest) applyManifestFromServer(payload.manifest);
      showBanner(
        "warn",
        "筛选条件已变更",
        "许可只对确认时的目录与筛选有效。请核对当前清单，重新确认清理。"
      );
    } else if (error.code === "expired" || error.code === "forbidden") {
      clearPermit();
      showBanner("warn", "许可不可用", error.message);
    } else {
      showBanner("error", "提交失败", error.message);
    }
    updatePermitCard();
  } finally {
    if (state.permit) button.disabled = false;
  }
}

function handleError(error, title) {
  showBanner("error", title, error.message || "发生未知错误。");
}

async function loadHistory() {
  try {
    const data = await api("/api/history");
    renderHistory(data.operations || []);
    state.historyLoaded = true;
  } catch (error) {
    handleError(error, "加载清理记录失败");
  }
}

function switchTab(name) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  $("tab-cleanup").hidden = name !== "cleanup";
  $("tab-history").hidden = name !== "history";
  if (name === "history" && !state.historyLoaded) loadHistory();
}

/* ------------------------------------------------------------------- boot */

async function init() {
  try {
    await loadState();
  } catch (error) {
    showLogin();
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = $("login-username").value.trim();
    const password = $("login-password").value;
    $("login-error").textContent = "";
    try {
      await api("/api/login", { method: "POST", body: { username, password } });
      $("login-password").value = "";
      await loadState();
    } catch (error) {
      $("login-error").textContent = error.message;
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: {} });
    } catch (error) {
      /* cookie may already be gone */
    }
    showLogin();
  });

  $("scope-form").addEventListener("submit", (event) => {
    event.preventDefault();
    applyScope({
      folder_id: state.folderId,
      batch: $("scope-batch").value,
      keyword: $("scope-keyword").value.trim(),
    });
  });

  $("refresh-btn").addEventListener("click", async () => {
    try {
      const manifest = await api("/api/preview");
      applyManifestFromServer(manifest);
      if (state.permit && !permitMatchesScope()) {
        showBanner(
          "warn",
          "清单已变化，许可不可用",
          "请核对刷新后的清单；如需继续清理，请重新确认身份。"
        );
      } else {
        hideBanner();
      }
    } catch (error) {
      handleError(error, "刷新清单失败");
    }
  });

  $("open-confirm").addEventListener("click", openConfirmModal);
  $("confirm-cancel").addEventListener("click", closeConfirmModal);
  $("confirm-form").addEventListener("submit", submitConfirm);
  $("confirm-modal").addEventListener("click", (event) => {
    if (event.target === $("confirm-modal")) closeConfirmModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("confirm-modal").hidden) closeConfirmModal();
  });

  $("submit-btn").addEventListener("click", submitPermit);
  $("discard-permit").addEventListener("click", async () => {
    if (state.permit) {
      const permit = state.permit.permit;
      try {
        await api("/api/discard", { method: "POST", body: { permit } });
      } catch (error) {
        /* the permit may already be expired or consumed */
      }
    }
    clearPermit();
    hideBanner();
  });

  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  }
  $("history-refresh").addEventListener("click", loadHistory);
}

document.addEventListener("DOMContentLoaded", init);
