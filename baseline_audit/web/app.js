/* 本地基线核查台前端：原生 JS，无外部资源、无 CDN。 */
"use strict";

const state = {
  rootToken: null,
  rootLabel: null,
  run: null,
  selectedId: null,
};

const $ = (sel) => document.querySelector(sel);
const severityRank = { high: 0, medium: 1, low: 2 };
const statusLabel = {
  new: "新增", present: "仍存在", changed: "发生变化", disappeared: "已消失",
};
const noticeLabel = {
  read_error: "文件/目录读取失败",
  parse_error: "配置解析失败",
  tool_error: "工具自身错误",
};

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.error || `请求失败 (${resp.status})`);
  }
  return data;
}

function withRoot(payload = {}) {
  return { ...payload, root_token: state.rootToken };
}

function showBanner(text, isError = false) {
  const el = $("#banner");
  if (!text) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------- 核查 ----------------

async function startScan() {
  const path = $("#root-path").value.trim();
  if (!path) {
    showBanner("请先输入待核查的本地目录路径。", true);
    return;
  }
  showBanner("核查中……");
  try {
    const data = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    state.rootToken = data.root_token;
    state.rootLabel = data.root_label;
    state.run = data.run;
    $("#btn-baseline").disabled = false;
    $("#btn-export").disabled = false;
    renderAll();
    const warnings = (data.run.warnings || []).join("\n");
    showBanner(warnings || `核查完成：目录「${data.root_label}」，共 ${data.run.stats.findings_total} 项发现。`);
  } catch (err) {
    showBanner(err.message, true);
  }
}

// ---------------- 渲染 ----------------

function renderStats() {
  const run = state.run;
  if (!run) {
    $("#stats").classList.add("hidden");
    return;
  }
  $("#stats").classList.remove("hidden");
  $("#rule-version").textContent = "规则版本 " + run.rule_version;
  $("#cnt-high").textContent = run.stats.by_severity.high;
  $("#cnt-medium").textContent = run.stats.by_severity.medium;
  $("#cnt-low").textContent = run.stats.by_severity.low;
  $("#cnt-new").textContent = run.findings.filter((f) => f.status === "new").length;
  $("#cnt-changed").textContent = run.findings.filter((f) => f.status === "changed").length;
  $("#cnt-gone").textContent = run.findings.filter((f) => f.status === "disappeared").length;
  $("#cnt-notice").textContent = run.notices.length;
}

function filteredFindings() {
  const sev = $("#f-severity").value;
  const st = $("#f-status").value;
  const pathKw = $("#f-path").value.trim().toLowerCase();
  const hideExc = $("#f-hide-exc").checked;
  return state.run.findings
    .filter((f) => !sev || f.severity === sev)
    .filter((f) => !st || f.status === st)
    .filter((f) => !pathKw || f.rel_path.toLowerCase().includes(pathKw))
    .filter((f) => !(hideExc && f.exception))
    .sort((a, b) => {
      const rank = severityRank[a.severity] - severityRank[b.severity];
      return rank !== 0 ? rank : a.rel_path.localeCompare(b.rel_path);
    });
}

function renderFindings() {
  const host = $("#finding-list");
  if (!state.run) {
    host.innerHTML = '<div class="empty">尚未执行核查。</div>';
    return;
  }
  const items = filteredFindings();
  if (!items.length) {
    host.innerHTML = '<div class="empty">当前筛选条件下没有发现项。</div>';
    return;
  }
  host.innerHTML = items.map((f) => `
    <div class="item" data-id="${esc(f.id)}">
      <div class="item-head">
        <span class="badge ${f.severity}">${esc(f.severity.toUpperCase())}</span>
        <span class="badge status-${esc(f.status)}">${esc(statusLabel[f.status] || f.status)}</span>
        ${f.exception ? '<span class="badge exc">例外中</span>' : ""}
        <span class="path">${esc(f.rel_path)}</span>
      </div>
      <div class="item-sub">
        <code>${esc(f.rule_id)}</code>
        <span>${esc(f.title)}</span>
        <span>${esc(f.aspect)}</span>
      </div>
    </div>`).join("");
  host.querySelectorAll(".item").forEach((el) =>
    el.addEventListener("click", () => openDrawer(el.dataset.id))
  );
}

function renderNotices() {
  const host = $("#notice-list");
  if (!state.run) {
    host.innerHTML = '<div class="empty">尚未执行核查。</div>';
    return;
  }
  if (!state.run.notices.length) {
    host.innerHTML = '<div class="empty">本次核查没有读取/解析/工具错误。</div>';
    return;
  }
  host.innerHTML = state.run.notices.map((n) => `
    <div class="item notice-item ${esc(n.category)}">
      <div class="item-head">
        <span class="badge high">${esc(noticeLabel[n.category] || n.category)}</span>
        <code>${esc(n.code)}</code>
        <span class="path">${esc(n.rel || ".")}</span>
      </div>
      <div class="item-sub"><span>${esc(n.detail)}</span></div>
    </div>`).join("");
}

async function renderExceptions() {
  const host = $("#exception-list");
  if (!state.rootToken) {
    host.innerHTML = '<div class="empty">请先执行一次核查。</div>';
    return;
  }
  try {
    const data = await api(`/api/exceptions?root_token=${encodeURIComponent(state.rootToken)}`);
    if (!data.exceptions.length) {
      host.innerHTML = '<div class="empty">还没有例外。可在发现项详情中添加。</div>';
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    host.innerHTML = data.exceptions.map((e) => {
      const expired = e.expires_at &&
        Date.parse(e.expires_at.endsWith("Z") ? e.expires_at : e.expires_at + "Z") / 1000 < nowSec;
      return `
      <div class="item">
        <div class="item-head">
          <code>${esc(e.finding_id)}</code>
          <span class="badge ${e.revoked ? "status-disappeared" : expired ? "status-changed" : "status-new"}">
            ${e.revoked ? "已撤销" : expired ? "已过期" : "生效中"}
          </span>
          <span>范围：${esc(e.scope)} · 失效：${esc(e.expires_at || "永久")}</span>
        </div>
        <div class="item-sub"><span>${esc(e.reason || "（未填写理由）")}</span>
          ${e.revoked ? "" : `<button class="danger" data-revoke="${esc(e.exception_id)}">撤销例外</button>`}
        </div>
      </div>`;
    }).join("");
    host.querySelectorAll("[data-revoke]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        await api("/api/exceptions/revoke", {
          method: "POST",
          body: JSON.stringify(withRoot({ exception_id: btn.dataset.revoke })),
        });
        await refreshRun();
        renderExceptions();
      })
    );
  } catch (err) {
    host.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function renderHistory() {
  const host = $("#history-list");
  if (!state.rootToken) {
    host.innerHTML = '<div class="empty">请先执行一次核查。</div>';
    return;
  }
  try {
    const data = await api(`/api/runs?root_token=${encodeURIComponent(state.rootToken)}`);
    if (!data.runs.length) {
      host.innerHTML = '<div class="empty">暂无历史核查。</div>';
      return;
    }
    host.innerHTML = data.runs.slice().reverse().map((r) => `
      <div class="item history-item" data-run="${esc(r.run_id)}">
        <div class="item-head">
          <code>${esc(r.run_id)}</code>
          <span>${esc(r.started_at)} UTC</span>
          <span class="ok">规则 ${esc(r.rule_version)}</span>
        </div>
        <div class="item-sub">
          <span>发现 ${r.stats.findings_total} 项</span>
          <span>提示 ${r.stats.notices_total} 条</span>
          ${(r.warnings || []).map((w) => `<span class="badge status-changed">${esc(w)}</span>`).join("")}
        </div>
      </div>`).join("");
    host.querySelectorAll("[data-run]").forEach((el) =>
      el.addEventListener("click", async () => {
        const data = await api(
          `/api/run?root_token=${encodeURIComponent(state.rootToken)}&run_id=${encodeURIComponent(el.dataset.run)}`
        );
        state.run = data.run;
        renderAll();
      })
    );
  } catch (err) {
    host.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

async function renderLog() {
  const host = $("#log-list");
  try {
    const data = await api("/api/log");
    host.innerHTML = data.events.length
      ? data.events.slice().reverse().map((e) => `
        <div class="log-line">${esc(e.ts)}  ${esc(e.event)}  ${esc(e.detail)}</div>`).join("")
      : '<div class="empty">暂无审计日志。</div>';
  } catch (err) {
    host.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

// ---------------- 详情抽屉 ----------------

function findingHistory(f) {
  return `状态：${esc(statusLabel[f.status] || f.status)}；基线对比：${
    esc(f.baseline_state || "未设置基线")
  }`;
}

function openDrawer(id) {
  const f = state.run.findings.find((item) => item.id === id);
  if (!f) return;
  state.selectedId = id;
  $("#d-title").textContent = f.title;
  $("#d-body").innerHTML = `
    <dl class="kv">
      <dt>规则</dt><dd><code>${esc(f.rule_id)}</code></dd>
      <dt>风险等级</dt><dd><span class="badge ${f.severity}">${esc(f.severity.toUpperCase())}</span></dd>
      <dt>相对路径</dt><dd>${esc(f.rel_path)}</dd>
      <dt>维度</dt><dd>${esc(f.aspect)}</dd>
      <dt>稳定身份</dt><dd><code>${esc(f.id)}</code></dd>
      <dt>状态历史</dt><dd>${findingHistory(f)}</dd>
    </dl>
    <h3>判断理由</h3><p>${esc(f.reason)}</p>
    <h3>规则说明</h3><p>${esc(f.rationale)}</p>
    <h3>修复建议</h3><p>${esc(f.remediation)}</p>
    <h3>可复核证据（敏感值已遮蔽）</h3>
    <pre class="evidence">${esc(JSON.stringify(f.evidence, null, 2))}</pre>
    ${f.exception ? `
      <h3>当前例外</h3>
      <p>范围 ${esc(f.exception.scope)}，失效时间 ${esc(f.exception.expires_at || "永久")}
         ；理由：${esc(f.exception.reason || "（无）")}</p>` : ""}
    <div class="exc-form">
      <h3>添加例外</h3>
      <label>适用范围</label>
      <select id="exc-scope">
        <option value="finding">仅该发现（同身份匹配）</option>
        <option value="path">该路径（记录身份仍绑定具体发现）</option>
        <option value="rule">该规则（记录身份仍绑定具体发现）</option>
      </select>
      <label>失效时间（UTC，留空为永久；到期后自动重新显示）</label>
      <input id="exc-expires" type="datetime-local" step="1">
      <label>理由</label>
      <textarea id="exc-reason" rows="2" placeholder="为什么接受该风险"></textarea>
      <p style="margin-top:8px">
        <button class="primary" id="exc-submit">保存例外</button>
      </p>
    </div>`;
  $("#drawer").classList.remove("hidden");
  $("#drawer-mask").classList.remove("hidden");
  $("#exc-submit").addEventListener("click", submitException);
}

function closeDrawer() {
  state.selectedId = null;
  $("#drawer").classList.add("hidden");
  $("#drawer-mask").classList.add("hidden");
}

async function submitException() {
  const local = $("#exc-expires").value;
  const expiresAt = local
    ? new Date(local).toISOString().replace(/\.\d+Z$/, "Z")
    : "";
  try {
    await api("/api/exceptions", {
      method: "POST",
      body: JSON.stringify(withRoot({
        finding_id: state.selectedId,
        scope: $("#exc-scope").value,
        expires_at: expiresAt,
        reason: $("#exc-reason").value,
      })),
    });
    closeDrawer();
    await refreshRun();
    renderExceptions();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------- 基线 / 导出 / 刷新 ----------------

async function saveBaseline() {
  try {
    await api("/api/baseline", {
      method: "POST",
      body: JSON.stringify(withRoot({ run_id: state.run.run_id })),
    });
    showBanner("基线已保存。后续核查会与该基线对比并标注新增/变化。");
  } catch (err) {
    showBanner(err.message, true);
  }
}

function exportReport() {
  const url = `/api/export?root_token=${encodeURIComponent(state.rootToken)}`;
  // 经 fetch 拿到 JSON 后本地下载，文件名不含绝对路径
  api(url).then((report) => {
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `baseline-report-${report.scanned_at.replace(/[:T]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }).catch((err) => showBanner(err.message, true));
}

async function refreshRun() {
  if (!state.rootToken || !state.run) return;
  const data = await api(
    `/api/runs?root_token=${encodeURIComponent(state.rootToken)}`
  );
  const latest = data.runs[data.runs.length - 1];
  if (!latest) return;
  const detail = await api(
    `/api/run?root_token=${encodeURIComponent(state.rootToken)}&run_id=${encodeURIComponent(latest.run_id)}`
  );
  state.run = detail.run;
  renderAll();
}

function renderAll() {
  renderStats();
  renderFindings();
  renderNotices();
}

// ---------------- 事件绑定 ----------------

$("#btn-scan").addEventListener("click", startScan);
$("#btn-baseline").addEventListener("click", saveBaseline);
$("#btn-export").addEventListener("click", exportReport);
$("#d-close").addEventListener("click", closeDrawer);
$("#drawer-mask").addEventListener("click", closeDrawer);
["f-severity", "f-status", "f-path", "f-hide-exc"].forEach((id) =>
  $(`#${id}`).addEventListener("input", renderFindings)
);
$("#btn-clear-filter").addEventListener("click", () => {
  $("#f-severity").value = "";
  $("#f-status").value = "";
  $("#f-path").value = "";
  $("#f-hide-exc").checked = false;
  renderFindings();
});
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    $(`#tab-${tab.dataset.tab}`).classList.remove("hidden");
    if (tab.dataset.tab === "exceptions") renderExceptions();
    if (tab.dataset.tab === "history") renderHistory();
    if (tab.dataset.tab === "log") renderLog();
  })
);
$("#root-path").addEventListener("keydown", (e) => {
  if (e.key === "Enter") startScan();
});
