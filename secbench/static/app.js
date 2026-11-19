/* secbench 前端：原生 JS，无外部依赖。所有数据来自本机 127.0.0.1 服务。 */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SEVERITY_LABEL = { high: "高", medium: "中", low: "低" };
const STATUS_LABEL = { open: "待处理", confirmed: "已确认", false_positive: "误报" };
const SOURCE_LABEL = { auth: "身份认证", proxy: "反向代理", endpoint: "终端" };

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function api(path, options = {}) {
  const resp = await fetch(path, options);
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}

function formParams(form) {
  return new URLSearchParams([...new FormData(form)].filter(([, v]) => v !== ""));
}

// ---------------- Tab 切换 ----------------
$$("nav.tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    $$("nav.tabs button").forEach((b) => b.classList.toggle("active", b === btn));
    $$("main .tab").forEach((s) => s.classList.toggle("active", s.id === `tab-${btn.dataset.tab}`));
    $$("main .tab").forEach((s) => s.classList.toggle("hidden", s.id !== `tab-${btn.dataset.tab}`));
  });
});

// ---------------- 健康检查 ----------------
async function loadHealth() {
  try {
    const data = await api("/api/health");
    $("#health").textContent = `已连接本机服务 · 规则版本 ${data.rule_version}`;
  } catch (err) {
    $("#health").textContent = `服务未连接: ${err.message}`;
  }
}

// ---------------- 导入 ----------------
$("#upload-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const file = $("#file-input").files[0];
  if (!file) return;
  const box = $("#import-result");
  box.classList.remove("hidden");
  box.innerHTML = "导入中…";
  try {
    const data = await api("/api/import", { method: "POST", body: file });
    const c = data.counts;
    box.innerHTML = `
      <strong>导入完成：${esc(data.filename)}</strong>
      <div class="counts">
        <span class="count accepted">已接收 ${c.accepted}</span>
        <span class="count duplicate">重复 ${c.duplicate}</span>
        <span class="count quarantined">隔离 ${c.quarantined}</span>
        <span class="count error">错误 ${c.error}</span>
        <span>总行数 ${c.total}</span>
      </div>
      ${data.errors.length ? `<strong>行级错误：</strong><ul>${
        data.errors.map((e) => `<li>第 ${e.line_no} 行：${esc(e.reason)}</li>`).join("")}</ul>` : ""}
      ${data.quarantined.length ? `<strong>隔离记录：</strong><ul>${
        data.quarantined.map((q) => `<li>第 ${q.line_no} 行：${esc(q.reason)}</li>`).join("")}</ul>` : ""}`;
    $("#file-input").value = "";
    await refreshImportTab();
  } catch (err) {
    box.innerHTML = `<strong style="color:var(--danger)">整批被拒绝：</strong>${esc(err.message)}（已有数据未受影响）`;
    await refreshImportTab();
  }
});

$("#reset-btn").addEventListener("click", async () => {
  if (!confirm("确认清空本机全部演示数据？此操作不可恢复。")) return;
  await api("/api/reset", { method: "POST" });
  await refreshAll();
});

async function refreshImportTab() {
  const [imp, errs, qs] = await Promise.all([
    api("/api/imports"), api("/api/errors"), api("/api/quarantined"),
  ]);
  $("#imports-table tbody").innerHTML = imp.imports.map((r) => `
    <tr>
      <td>${r.id}</td><td>${esc(r.imported_at)}</td><td>${esc(r.filename)}</td>
      <td>${r.accepted_count}</td><td>${r.duplicate_count}</td>
      <td>${r.quarantined_count}</td><td>${r.error_count}</td>
      <td>${r.rejected_reason ? esc(r.rejected_reason) : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="hint">暂无导入</td></tr>`;
  $("#errors-table tbody").innerHTML = errs.row_errors.map((r) => `
    <tr><td>${r.import_id}</td><td>${r.line_no}</td><td>${esc(r.reason)}</td>
    <td class="raw-cell" title="${esc(r.raw_line)}">${esc(r.raw_line)}</td></tr>`
  ).join("") || `<tr><td colspan="4" class="hint">无行级错误</td></tr>`;
  $("#quarantine-table tbody").innerHTML = qs.quarantined.map((r) => `
    <tr><td>${r.import_id}</td><td>${esc(r.source)}</td><td>${esc(r.event_id)}</td>
    <td>${esc(r.reason)}</td>
    <td class="raw-cell" title="${esc(r.raw_line)}">${esc(r.raw_line)}</td></tr>`
  ).join("") || `<tr><td colspan="5" class="hint">隔离区为空</td></tr>`;
}

// ---------------- 事件 ----------------
async function loadEvents() {
  const params = formParams($("#event-filter"));
  const data = await api(`/api/events?${params}`);
  $("#events-table tbody").innerHTML = data.events.map((e) => `
    <tr>
      <td>${e.id}</td><td>${SOURCE_LABEL[e.source] || e.source}</td>
      <td>${esc(e.event_time)}</td><td>${esc(e.event_id)}</td>
      <td>${esc(e.subject)}</td><td>${esc(e.src_ip)}</td>
      <td>${esc(e.action)}</td><td>${esc(e.target)}</td><td>${esc(e.result)}</td>
      <td><button class="ghost" data-raw="${e.id}">原始</button></td>
    </tr>`).join("") || `<tr><td colspan="10" class="hint">暂无事件</td></tr>`;
  $$("#events-table [data-raw]").forEach((btn) => btn.addEventListener("click", () => showRaw(btn.dataset.raw)));
}
$("#event-filter").addEventListener("submit", (ev) => { ev.preventDefault(); loadEvents(); });
$("#event-reset").addEventListener("click", () => { $("#event-filter").reset(); loadEvents(); });

async function showRaw(eventPk) {
  try {
    const ev = await api(`/api/events/${eventPk}`);
    $("#raw-dialog-content").textContent = ev.raw_line;
  } catch (err) {
    $("#raw-dialog-content").textContent = `(未找到: ${err.message})`;
  }
  $("#raw-dialog").showModal();
}

// ---------------- 告警 ----------------
async function loadAlerts() {
  const params = formParams($("#alert-filter"));
  const data = await api(`/api/alerts?${params}`);
  $("#alerts-container").innerHTML = data.alerts.map(alertCard).join("")
    || `<p class="hint">当前筛选下没有告警。规则需要跨事件关联，单条普通失败不会产生告警。</p>`;
  $$(".alert-head").forEach((head) => head.addEventListener("click", (ev) => {
    if (ev.target.closest("button, input, select, form")) return;
    const body = head.nextElementSibling;
    body.classList.toggle("hidden");
  }));
  $$(".disposition-form").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = form.dataset.alertId;
      await api(`/api/alerts/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: form.elements.status.value,
          disposition_note: form.elements.disposition_note.value,
        }),
      });
      await loadAlerts();
    });
  });
  $$(".ev-raw-btn").forEach((btn) => btn.addEventListener("click", () => showRaw(btn.dataset.raw)));
}

function alertCard(a) {
  const subjects = a.involved_subjects.map(esc).join(", ") || "—";
  const targets = a.involved_targets.map(esc).join(", ") || "—";
  const sources = a.involved_sources.map((s) => SOURCE_LABEL[s] || s).join(", ");
  return `
  <div class="alert">
    <div class="alert-head">
      <span class="badge ${a.severity}">${a.severity_label}</span>
      <span class="badge ${a.status}">${a.status_label}</span>
      ${a.superseded ? '<span class="badge superseded">已失效</span>' : ""}
      <span class="alert-title">#${a.id} ${esc(a.rule_name)}</span>
      <span class="alert-meta">${esc(a.first_event_time)} → ${esc(a.last_event_time)}</span>
      <span class="hint">点击展开证据时间线</span>
    </div>
    <div class="alert-body hidden">
      <p>${esc(a.summary)}</p>
      <p class="alert-meta">涉及来源：${esc(sources)} ｜ 主体：${subjects} ｜ 目标：${targets} ｜ 规则版本：${esc(a.rule_version)}</p>
      <div class="rationale"><strong>关联依据：</strong>${esc(a.rationale)}</div>
      <div class="timeline" data-alert="${a.id}"><em>证据加载中…</em></div>
      <form class="disposition disposition-form" data-alert-id="${a.id}">
        <label>处置
          <select name="status">
            <option value="open" ${a.status === "open" ? "selected" : ""}>待处理</option>
            <option value="confirmed" ${a.status === "confirmed" ? "selected" : ""}>已确认</option>
            <option value="false_positive" ${a.status === "false_positive" ? "selected" : ""}>误报</option>
          </select>
        </label>
        <input type="text" name="disposition_note" placeholder="处置说明" value="${esc(a.disposition_note)}">
        <button type="submit">保存处置</button>
      </form>
    </div>
  </div>`;
}

// 展开时懒加载证据时间线（按事件时间升序）
const observer = new MutationObserver(() => {
  $$(".timeline").forEach(async (box) => {
    if (box.dataset.loaded) return;
    box.dataset.loaded = "1";
    const id = box.dataset.alert;
    const data = await api(`/api/alerts/${id}/evidence`);
    box.innerHTML = `
      <div class="ev-row ev-head"><span>事件时间(UTC)</span><span>来源</span><span>编号</span><span>关键字段</span><span></span></div>
      ${data.evidence.map((e) => `
      <div class="ev-row">
        <span>${esc(e.event_time)}</span>
        <span>${SOURCE_LABEL[e.source] || e.source}</span>
        <span>${esc(e.event_id)}</span>
        <span><span class="ev-role">${esc(e.evidence_role)}</span>
          ${esc(e.subject)} @${esc(e.src_ip)} ${esc(e.action)} → ${esc(e.target)} [${esc(e.result)}]</span>
        <button class="ghost ev-raw-btn" data-raw="${e.id}">原始</button>
      </div>`).join("")}`;
    $$(".ev-raw-btn", box).forEach((btn) => btn.addEventListener("click", () => showRaw(btn.dataset.raw)));
  });
});
observer.observe($("#alerts-container"), { childList: true });

$("#alert-filter").addEventListener("submit", (ev) => { ev.preventDefault(); loadAlerts(); });
$("#alert-reset").addEventListener("click", () => { $("#alert-filter").reset(); loadAlerts(); });

$("#export-json").addEventListener("click", () => {
  window.location = `/api/export?format=json&${formParams($("#alert-filter"))}`;
});
$("#export-jsonl").addEventListener("click", () => {
  window.location = `/api/export?format=jsonl&${formParams($("#alert-filter"))}`;
});

// ---------------- 设置与规则文档 ----------------
const SETTING_LABELS = {
  max_import_bytes: "导入文件大小上限（字节）",
  max_import_events: "单次事件数上限（条）",
  r1_fail_threshold: "R1 失败账号去重数下限",
  r1_window_seconds: "R1 失败统计窗口（秒）",
  r1_success_window_seconds: "R1 末次失败→成功登录最大间隔（秒）",
  r2_window_seconds: "R2 探测→后续访问窗口（秒）",
  r3_window_seconds: "R3 登录→跨地址导出窗口（秒）",
};

async function loadSettings() {
  const [settings, rulesDoc] = await Promise.all([api("/api/settings"), api("/api/rules")]);
  $("#settings-form").innerHTML = Object.entries(SETTING_LABELS).map(([key, label]) => `
    <label>${label}<input type="number" min="1" name="${key}" value="${settings[key]}"></label>`).join("");
  $("#rules-doc").innerHTML = rulesDoc.map((r) => `
    <div class="rule-doc-item">
      <strong><span class="badge ${r.severity}">${SEVERITY_LABEL[r.severity]}</span> ${esc(r.rule_id)}</strong>
      —— ${esc(r.name)}<br>
      <span class="hint">${esc(r.rationale_template)}</span>
    </div>`).join("");
}
$("#settings-save").addEventListener("click", async () => {
  const updates = {};
  for (const [key, input] of new FormData($("#settings-form"))) updates[key] = Number(input);
  try {
    await api("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    alert("已保存并重新评估告警。");
    await loadAlerts();
  } catch (err) {
    alert(err.message);
  }
});

async function refreshAll() {
  await loadHealth();
  await refreshImportTab();
  await loadEvents();
  await loadAlerts();
  await loadSettings();
}
refreshAll();
