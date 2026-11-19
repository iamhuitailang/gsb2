// 工单系统前端：分页勾选 → 预览 → 批量提交
(() => {
  "use strict";

  const state = {
    token: null,
    csrf: null,
    user: null,
    viewGroupId: null,     // 管理员查看/转移时使用的小组
    page: 1,
    pageSize: 10,
    totalPages: 1,
    selected: new Set(),   // 跨页保留的编号
    batchKey: null,        // 同一批重复提交时复用，避免重复记账
    batchKeyIds: "",
  };

  const $ = (id) => document.getElementById(id);

  // ---- API ----------------------------------------------------------
  async function api(method, path, body) {
    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["X-Session-Token"] = state.token;
    if (state.csrf) headers["X-CSRF-Token"] = state.csrf;
    const resp = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error((data.error && data.error.message) || "请求失败");
      err.code = data.error && data.error.code;
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  function showError(target, err) {
    target.textContent = err.message || String(err);
    target.classList.remove("hidden");
  }

  function clearError(target) {
    target.textContent = "";
    target.classList.add("hidden");
  }

  // ---- 登录 ---------------------------------------------------------
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    clearError($("login-error"));
    try {
      const data = await api("POST", "/api/login", {
        username: form.username.value,
        password: form.password.value,
      });
      state.token = data.token;
      state.csrf = data.csrf_token;
      state.user = data.user;
      form.reset();
      enterMain();
    } catch (err) {
      showError($("login-error"), err);
    }
  });

  $("logout-btn").addEventListener("click", async () => {
    try { await api("POST", "/api/logout", {}); } catch (_) { /* 忽略 */ }
    resetState();
  });

  function resetState() {
    state.token = state.csrf = state.user = null;
    state.viewGroupId = null;
    state.selected.clear();
    state.batchKey = null;
    state.batchKeyIds = "";
    state.page = 1;
    $("admin-bar").classList.add("hidden");
    $("transfer-msg").textContent = "";
    $("main-view").classList.add("hidden");
    $("login-view").classList.remove("hidden");
  }

  async function enterMain() {
    $("login-view").classList.add("hidden");
    $("main-view").classList.remove("hidden");
    const user = state.user;
    $("whoami").textContent =
      `${user.username}（${user.role === "supervisor" ? "主管" : user.role}`
      + `${user.group_name ? " · " + user.group_name : ""}）`;
    renderSelection();
    // 管理员没有固定小组，交给 setupAdminBar 选组后再加载
    if (user.role === "admin") {
      try {
        await setupAdminBar();
      } catch (err) {
        $("page-info").textContent = err.message;
        $("ticket-rows").textContent = "";
      }
      return;
    }
    try {
      await loadPage(1);
    } catch (err) {
      $("page-info").textContent = err.message;
      $("ticket-rows").textContent = "";
    }
  }

  // ---- 管理员工具：查看任意小组、转移工单 ----------------------------
  async function setupAdminBar() {
    const { groups } = await api("GET", "/api/groups");
    if (state.viewGroupId === null && groups.length) state.viewGroupId = groups[0].id;
    fillGroupSelect($("view-group"), groups, state.viewGroupId);
    fillGroupSelect($("transfer-group"), groups, state.viewGroupId);
    $("admin-bar").classList.remove("hidden");
    if (state.viewGroupId) await loadPage(1);
  }

  function fillGroupSelect(select, groups, selectedId) {
    select.textContent = "";
    for (const group of groups) {
      const option = document.createElement("option");
      option.value = String(group.id);
      option.textContent = group.name;
      if (group.id === selectedId) option.selected = true;
      select.append(option);
    }
  }

  $("view-group").addEventListener("change", async () => {
    state.viewGroupId = Number($("view-group").value);
    try {
      await loadPage(1);
    } catch (err) {
      $("page-info").textContent = err.message;
    }
  });

  $("transfer-btn").addEventListener("click", async () => {
    const ticketId = Number($("transfer-id").value);
    const toGroupId = Number($("transfer-group").value);
    const msg = $("transfer-msg");
    if (!Number.isInteger(ticketId) || ticketId <= 0) {
      msg.textContent = "请填写工单编号";
      return;
    }
    try {
      const data = await api("POST", `/api/tickets/${ticketId}/transfer`, {
        to_group_id: toGroupId,
      });
      const t = data.transfer;
      msg.textContent = t.changed
        ? `已把 #${t.ticket_id} 转到 ${t.group_name}`
        : `#${t.ticket_id} 已在 ${t.group_name}`;
      $("transfer-id").value = "";
      await loadPage(state.page);
    } catch (err) {
      msg.textContent = `转移失败：${err.message}`;
    }
  });

  // ---- 工单列表与分页 ------------------------------------------------
  async function loadPage(page) {
    const groupQuery = state.viewGroupId ? `&group_id=${state.viewGroupId}` : "";
    let data = await api(
      "GET",
      `/api/tickets?page=${page}&page_size=${state.pageSize}${groupQuery}`
    );
    // 关闭工单后当前页可能越界，自动回退到最后一页
    if (page > data.total_pages) {
      data = await api(
        "GET",
        `/api/tickets?page=${data.total_pages}&page_size=${state.pageSize}${groupQuery}`
      );
    }
    state.page = data.page;
    state.totalPages = data.total_pages;
    renderRows(data.items);
    $("page-info").textContent = `第 ${data.page} / ${data.total_pages} 页 · 共 ${data.total} 张`;
    $("prev-page").disabled = data.page <= 1;
    $("next-page").disabled = data.page >= data.total_pages;
    $("empty-hint").classList.toggle("hidden", data.items.length > 0);
  }

  function renderRows(items) {
    const tbody = $("ticket-rows");
    tbody.textContent = "";
    for (const item of items) {
      const tr = document.createElement("tr");
      tr.dataset.ticketId = String(item.ticket_id);
      if (state.selected.has(item.ticket_id)) tr.classList.add("selected");

      const tdCheck = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = state.selected.has(item.ticket_id);
      checkbox.setAttribute("aria-label", `选择工单 ${item.ticket_id}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(item.ticket_id);
        else state.selected.delete(item.ticket_id);
        tr.classList.toggle("selected", checkbox.checked);
        onSelectionChanged();
      });
      tdCheck.append(checkbox);

      const tdId = document.createElement("td");
      tdId.textContent = String(item.ticket_id);

      const tdTitle = document.createElement("td");
      tdTitle.textContent = item.title;

      const tdStatus = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = `badge ${item.status}`;
      badge.textContent = item.status_label;
      tdStatus.append(badge);

      tr.append(tdCheck, tdId, tdTitle, tdStatus);
      tbody.append(tr);
    }
  }

  $("prev-page").addEventListener("click", () => {
    if (state.page > 1) loadPage(state.page - 1).catch((e) => alert(e.message));
  });
  $("next-page").addEventListener("click", () => {
    if (state.page < state.totalPages) loadPage(state.page + 1).catch((e) => alert(e.message));
  });

  // 手动加入编号：用于验证后端逐条校验（组外编号只会显示“无权处理”）
  $("add-id-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("add-id-input");
    const id = Number(input.value);
    if (!Number.isInteger(id) || id <= 0) return;
    state.selected.add(id);
    input.value = "";
    // 若该行在当前页，同步勾选状态
    const tr = document.querySelector(`tr[data-ticket-id="${id}"]`);
    if (tr) {
      tr.classList.add("selected");
      const box = tr.querySelector('input[type="checkbox"]');
      if (box) box.checked = true;
    }
    onSelectionChanged();
  });

  // ---- 选中项 --------------------------------------------------------
  function sortedSelection() {
    return [...state.selected].sort((a, b) => a - b);
  }

  function onSelectionChanged() {
    // 选择变了就不再复用旧批次标识，防止把不同批次当成重放
    state.batchKey = null;
    state.batchKeyIds = "";
    hide("preview-box");
    hide("result-box");
    renderSelection();
  }

  function renderSelection() {
    const chips = $("selected-chips");
    chips.textContent = "";
    for (const id of sortedSelection()) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.append(document.createTextNode(`#${id}`));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除工单 ${id}`);
      remove.addEventListener("click", () => {
        state.selected.delete(id);
        const tr = document.querySelector(`tr[data-ticket-id="${id}"]`);
        if (tr) {
          tr.classList.remove("selected");
          const box = tr.querySelector('input[type="checkbox"]');
          if (box) box.checked = false;
        }
        onSelectionChanged();
      });
      chip.append(remove);
      chips.append(chip);
    }
    const count = state.selected.size;
    const canClose = isSupervisor();
    $("selected-count").textContent = count ? `已选 ${count} 张` : "尚未选择工单";
    $("preview-btn").disabled = !canClose || count === 0;
    $("submit-btn").disabled = !canClose || count === 0;
    const submit = $("submit-btn");
    submit.textContent = count ? `提交关闭（${count}）` : "提交关闭";
  }

  function isSupervisor() {
    return !!state.user && state.user.role === "supervisor";
  }

  function hide(id) { $(id).classList.add("hidden"); $(id).textContent = ""; }
  function show(id) { $(id).classList.remove("hidden"); }

  // ---- 预览 ----------------------------------------------------------
  const REASON_TEXT = {
    no_permission: "无权处理",
    not_found: "无权处理",
    archived: "已归档，不能关闭",
    already_closed: "已关闭，无需处理",
    state_changed: "状态已变化，未处理",
    invalid_status: "状态不支持关闭",
  };

  $("preview-btn").addEventListener("click", async () => {
    const box = $("preview-box");
    hide("preview-box");
    show("preview-box");
    box.textContent = "正在校验…";
    try {
      const data = await api("POST", "/api/close-batches/preview", {
        ticket_ids: sortedSelection(),
      });
      renderPreview(box, data);
    } catch (err) {
      box.textContent = `预览失败：${err.message}`;
    }
  });

  function renderPreview(box, data) {
    box.textContent = "";
    const summary = document.createElement("p");
    summary.className = "result-summary";
    summary.textContent =
      `共 ${data.total} 张，其中可关闭 ${data.closable_count} 张，`
      + `不可或无需处理 ${data.total - data.closable_count} 张`;
    box.append(summary);

    const blocked = data.items.filter((item) => !item.closable);
    if (blocked.length) {
      const title = document.createElement("h3");
      title.textContent = "预览中的提示";
      const list = document.createElement("ul");
      for (const item of blocked) {
        const li = document.createElement("li");
        li.className = "count-warn";
        li.textContent = `#${item.ticket_id} · ${REASON_TEXT[item.reason] || "未处理"}`;
        list.append(li);
      }
      box.append(title, list);
    }
  }

  // ---- 提交 ----------------------------------------------------------
  $("submit-btn").addEventListener("click", async () => {
    const box = $("result-box");
    const ids = sortedSelection();
    const idsKey = ids.join(",");

    // 同一批重复提交复用同一个 batch_key：后端据此返回原结果，不再写关闭记录
    if (!state.batchKey || state.batchKeyIds !== idsKey) {
      state.batchKey = newBatchKey();
      state.batchKeyIds = idsKey;
    }

    hide("result-box");
    show("result-box");
    box.textContent = "正在提交…";
    const button = $("submit-btn");
    button.disabled = true;
    try {
      const data = await api("POST", "/api/close-batches", {
        ticket_ids: ids,
        batch_key: state.batchKey,
      });
      await renderResult(box, data.batch);
      // 勾选保留：同一批再点一次提交会命中幂等键，只会回放结果，不会重复记账
      renderSelection();
      await loadPage(state.page);
    } catch (err) {
      box.textContent = `提交失败：${err.message}`;
    } finally {
      button.disabled = state.selected.size === 0 || !isSupervisor();
    }
  });

  function newBatchKey() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `b-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function renderResult(box, batch) {
    box.textContent = "";

    const summary = document.createElement("p");
    summary.className = "result-summary";
    summary.textContent =
      `批次 #${batch.batch_id}：关闭成功 ${batch.closed_count} 张，`
      + `未处理 ${batch.unprocessed_count} 张`
      + (batch.replayed ? "（重复提交，已返回上次结果）" : "");
    box.append(summary);

    if (batch.closed.length) {
      const title = document.createElement("h3");
      title.textContent = "关闭成功";
      const list = document.createElement("ul");
      for (const item of batch.closed) {
        const li = document.createElement("li");
        li.className = "count-ok";
        li.textContent = `#${item.ticket_id} ${item.title}`;
        list.append(li);
      }
      box.append(title, list);
    }

    if (batch.unprocessed.length) {
      const title = document.createElement("h3");
      title.textContent = "未处理";
      const list = document.createElement("ul");
      for (const item of batch.unprocessed) {
        const li = document.createElement("li");
        li.className = "count-warn";
        // 组外条目后端不会下发标题与状态，这里只显示编号与“无权处理”
        if (item.title) {
          li.textContent = `#${item.ticket_id} ${item.title} · `
            + `${REASON_TEXT[item.reason] || "未处理"}`;
        } else {
          li.textContent = `#${item.ticket_id} · ${REASON_TEXT[item.reason] || "无权处理"}`;
        }
        list.append(li);
      }
      box.append(title, list);
    }
  }
})();
