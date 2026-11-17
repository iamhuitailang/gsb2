/* 本地网页资源安全策略分析台前端逻辑。
 * 纯原生 JS，不引用任何外部资源、不向除本机服务外的任何地址发送数据。
 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const RESOURCE_LABELS = {
  img: "图片", script: "脚本", style: "样式", font: "字体",
  media: "媒体", frame: "子页面", connect: "接口连接",
  worker: "Worker", object: "插件对象",
};
const MODE_LABELS = { enforce: "拦截模式", report: "仅报告" };

let state = {
  policies: [],
  records: [],
  samples: [],
  editingId: null,
  selectedPolicyIds: new Set(),
};

// ---------------- 通用工具 ----------------
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function toast(msg, kind = "error") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "info" ? "info" : ""}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  if (name === "policies") loadPolicies();
  if (name === "records") loadRecords();
  if (name === "analyze") renderPolicyPicker();
  if (name === "samples") loadSamples();
}

// ---------------- 选项卡 ----------------
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

// ---------------- 策略管理 ----------------
function renderIssues(container, issues, ok) {
  if (!issues || !issues.length) {
    container.innerHTML = ok
      ? `<div class="issue warning" style="border-color:var(--ok);background:rgba(53,194,143,.1)">
           语法校验通过，未发现问题。</div>`
      : "";
    return;
  }
  container.innerHTML = issues
    .map((i) => `
      <div class="issue ${i.level}">
        <span class="loc">第 ${i.line} 行 第 ${i.column} 列</span>
        ${esc(i.message)}
        <span class="code">[${i.code}]</span>
        ${i.snippet ? ` <span class="code">片段: ${esc(i.snippet)}</span>` : ""}
      </div>`)
    .join("");
}

async function validatePolicy(persist) {
  const name = $("#p-name").value.trim();
  const text = $("#p-text").value;
  const mode = $("#p-mode").value;
  const parsed = await api("/api/parse", { method: "POST", body: { text } });
  renderIssues($("#p-issues"), [...parsed.errors, ...parsed.warnings], parsed.ok);
  if (!parsed.ok) {
    toast(`策略存在 ${parsed.errors.length} 个错误，已${persist ? "拒绝保存" : ""}，请按提示修正`);
    return false;
  }
  if (!persist) {
    toast("语法校验通过（含警告时会逐条说明，警告不影响保存）", "info");
    return true;
  }
  try {
    if (state.editingId) {
      await api(`/api/policies/${state.editingId}`, {
        method: "PUT", body: { name, text, mode },
      });
      toast("策略已替换；历史记录保留替换前的快照，不会被改写", "info");
    } else {
      await api("/api/policies", { method: "POST", body: { name, text, mode } });
      toast("策略已保存", "info");
    }
    resetPolicyForm();
    await loadPolicies();
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

function resetPolicyForm() {
  state.editingId = null;
  $("#policy-form-title").textContent = "新建策略";
  $("#p-name").value = "";
  $("#p-text").value = "";
  $("#p-mode").value = "enforce";
  $("#p-issues").innerHTML = "";
}

async function loadPolicies() {
  const data = await api("/api/policies");
  state.policies = data.policies;
  $("#p-count").textContent = state.policies.length;
  $("#policy-tbody").innerHTML = state.policies.map((p) => `
    <tr data-id="${p.id}">
      <td><input type="checkbox" class="row-pick" data-id="${p.id}"
            ${state.selectedPolicyIds.has(p.id) ? "checked" : ""} /></td>
      <td><b>${esc(p.name)}</b></td>
      <td><span class="badge ${p.mode}">${MODE_LABELS[p.mode]}</span></td>
      <td class="policy-text-cell mono">${esc(p.text)}</td>
      <td>${p.warnings && p.warnings.length
        ? `<span class="badge warn">${p.warnings.length} 条说明</span>`
        : "—"}</td>
      <td class="row gap">
        <button class="small act-edit" data-id="${p.id}">编辑</button>
        <button class="small danger act-del" data-id="${p.id}">删除</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="6" class="hint">还没有策略，先在左侧新建或导入。</td></tr>`;

  $$(".act-edit").forEach((b) => b.addEventListener("click", () => editPolicy(b.dataset.id)));
  $$(".act-del").forEach((b) => b.addEventListener("click", () => removePolicy(b.dataset.id)));
  $$(".row-pick").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) state.selectedPolicyIds.add(cb.dataset.id);
    else state.selectedPolicyIds.delete(cb.dataset.id);
  }));
  renderPolicyPicker();
  renderFilterPolicies();
}

function editPolicy(id) {
  const p = state.policies.find((x) => x.id === id);
  if (!p) return;
  state.editingId = id;
  $("#policy-form-title").textContent = `替换策略：${p.name}（历史快照不受影响）`;
  $("#p-name").value = p.name;
  $("#p-text").value = p.text;
  $("#p-mode").value = p.mode;
  $("#p-issues").innerHTML = "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function removePolicy(id) {
  const p = state.policies.find((x) => x.id === id);
  if (!confirm(`确认删除策略「${p.name}」？\n历史分析记录会保留该策略的快照，不会被删除或改写。`)) return;
  try {
    await api(`/api/policies/${id}`, { method: "DELETE" });
    state.selectedPolicyIds.delete(id);
    if (state.editingId === id) resetPolicyForm();
    await loadPolicies();
    toast("策略已删除，历史记录中的快照仍可查看", "info");
  } catch (e) {
    toast(e.message);
  }
}

$("#p-save").addEventListener("click", () => validatePolicy(true));
$("#p-validate").addEventListener("click", () => validatePolicy(false));
$("#p-reset").addEventListener("click", resetPolicyForm);

$("#p-import-file").addEventListener("click", () => $("#p-file-import").click());
$("#p-file-import").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const text = await file.text();
  $("#p-name").value = file.name.replace(/\.[^.]+$/, "");
  $("#p-text").value = text;
  state.editingId = null;
  $("#policy-form-title").textContent = "新建策略（来自文件导入）";
  await validatePolicy(false);
  ev.target.value = "";
});

$("#p-export-file").addEventListener("click", () => {
  const picked = state.policies.filter((p) => state.selectedPolicyIds.has(p.id));
  const targets = picked.length ? picked : state.policies;
  if (!targets.length) return toast("没有可导出的策略");
  const parts = targets.map(
    (p) => `# 策略: ${p.name}\n# 模式: ${MODE_LABELS[p.mode]}\n${p.text}\n`
  );
  downloadText("csp-policies.txt", parts.join("\n"), "text/plain");
  toast(`已导出 ${targets.length} 份策略文本`, "info");
});

function downloadText(filename, content, mime) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------------- 新建分析 ----------------
$("#r-inline").addEventListener("change", (e) => {
  $("#inline-box").hidden = !e.target.checked;
});

function renderPolicyPicker() {
  const el = $("#r-policy-picker");
  if (!state.policies.length) {
    el.innerHTML = `<p class="hint">请先在「策略管理」中创建至少一份策略。</p>`;
    return;
  }
  el.innerHTML = state.policies.map((p) => `
    <label class="picker-item">
      <input type="checkbox" class="pick-policy" data-id="${p.id}"
        ${state.selectedPolicyIds.has(p.id) ? "checked" : ""} />
      <span>
        <b>${esc(p.name)}</b>
        <span class="badge ${p.mode}">${MODE_LABELS[p.mode]}</span>
        <div class="meta mono">${esc(p.text)}</div>
      </span>
    </label>`).join("");
  $$(".pick-policy").forEach((cb) => cb.addEventListener("change", () => {
    if (cb.checked) state.selectedPolicyIds.add(cb.dataset.id);
    else state.selectedPolicyIds.delete(cb.dataset.id);
  }));
}

async function buildRequestPayload() {
  const isInline = $("#r-inline").checked;
  const payload = {
    page_url: $("#r-page").value.trim(),
    resource_type: $("#r-type").value,
    resource_url: $("#r-url").value.trim(),
    is_inline: isInline,
    nonce: $("#r-nonce").value.trim() || null,
    inline_content: $("#r-content").value || null,
    inline_digest: $("#r-digest").value.trim() || null,
    initiator: $("#r-initiator").value,
    parent_trusted: $("#r-parent-trusted").checked,
  };
  // 内联原文时，优先在浏览器本地用 Web Crypto 计算 sha256，避免依赖服务端
  if (isInline && payload.inline_content && !payload.inline_digest) {
    payload.inline_digest = await sha256Digest(payload.inline_content);
  }
  return payload;
}

async function sha256Digest(content) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const bin = String.fromCharCode(...new Uint8Array(buf));
  return "sha256-" + btoa(bin);
}

function renderSourceChecks(checks) {
  if (!checks || !checks.length) return "";
  return `<ul class="check-list">${checks.map((c) => {
    const cls = c.matched ? "hit" : c.kind === "unknown" ? "neutral" : "miss";
    return `<li class="${cls}"><span class="raw">${esc(c.raw)}</span> — ${esc(c.reason)}</li>`;
  }).join("")}</ul>`;
}

function renderAnalyzeResult(record) {
  const bannerCls = record.decision === "allow" ? "allow" : "block";
  const decisions = record.policy_decisions.map((d) => `
    <div class="decision-card">
      <h3>
        <span class="badge ${d.decision}">${d.decision === "allow" ? "放行" : "拦截"}</span>
        策略「${esc(d.policy_name)}」
        <span class="badge ${d.mode}">${MODE_LABELS[d.mode]}</span>
      </h3>
      <div class="chain">回退链: ${d.directive_chain.map(esc).join(" → ")}
        ${d.matched_directive ? `· 命中指令 <b>${esc(d.matched_directive)}</b>` : "· 无对应指令（不受限）"}
      </div>
      <p>${esc(d.reason)}</p>
      ${renderSourceChecks(d.source_checks)}
    </div>`).join("");

  const reportNote = record.reports.length
    ? `<div class="issue warning">本次产生 ${record.reports.length} 条拦截/拟拦截记录，
       已含策略、资源类别（${RESOURCE_LABELS[record.request.resource_type]}）、
       命中原因与时间，可在「分析记录」中筛选查看。</div>`
    : "";

  $("#analyze-result").innerHTML = `
    <div class="result-banner ${bannerCls}">
      <b>最终判定：${record.decision === "allow" ? "放行" : "拦截"}</b>
      <div>${esc(record.reason_summary)}</div>
    </div>
    ${reportNote}
    ${decisions}
    <p class="hint">记录已保存；之后即使删除或替换上述策略，本条记录仍保留当时的策略快照。</p>`;
}

$("#r-run").addEventListener("click", async () => {
  const ids = Array.from(state.selectedPolicyIds);
  if (!ids.length) return toast("请至少选择一份参与判定的策略");
  try {
    const request = await buildRequestPayload();
    const data = await api("/api/analyze", {
      method: "POST", body: { policy_ids: ids, request },
    });
    renderAnalyzeResult(data.record);
    toast("判定完成，已写入分析记录", "info");
  } catch (e) {
    toast(e.message);
  }
});

$("#r-clear").addEventListener("click", () => { $("#analyze-result").innerHTML = ""; });

// ---------------- 分析记录 ----------------
function renderFilterPolicies() {
  const sel = $("#f-policy");
  const current = sel.value;
  sel.innerHTML = `<option value="">全部</option>` + state.policies
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  sel.value = current;
}

function renderTypeFilter() {
  const sel = $("#f-type");
  sel.innerHTML = `<option value="">全部</option>` +
    Object.entries(RESOURCE_LABELS)
      .map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
}

async function loadRecords() {
  const params = new URLSearchParams();
  const pick = (id) => $(id).value;
  [["decision", "#f-decision"], ["resource_type", "#f-type"], ["policy_id", "#f-policy"],
   ["mode", "#f-mode"], ["keyword", "#f-keyword"]].forEach(([k, sel]) => {
    const v = $(sel).value.trim();
    if (v) params.set(k, v);
  });
  const data = await api(`/api/records?${params.toString()}`);
  state.records = data.records;
  $("#records-list").innerHTML = state.records.map(renderRecord).join("") ||
    `<p class="hint">没有符合条件的记录。</p>`;
}

function renderRecord(r) {
  const req = r.request;
  const snapshots = r.policy_snapshots.map((s) => `
    <details>
      <summary>策略快照：${esc(s.name)} <span class="badge ${s.mode}">${MODE_LABELS[s.mode]}</span></summary>
      <div class="snapshot">${esc(s.text)}</div>
    </details>`).join("");
  const perPolicy = r.policy_decisions.map((d) => `
    <div class="decision-card">
      <h3>
        <span class="badge ${d.decision}">${d.decision === "allow" ? "放行" : "拦截"}</span>
        ${esc(d.policy_name)} <span class="badge ${d.mode}">${MODE_LABELS[d.mode]}</span>
      </h3>
      <div class="chain">${d.directive_chain.map(esc).join(" → ")}
        ${d.matched_directive ? `· 命中 ${esc(d.matched_directive)}` : "· 无对应指令"}</div>
      <p>${esc(d.reason)}</p>
      ${renderSourceChecks(d.source_checks)}
    </div>`).join("");
  return `
    <div class="record">
      <div class="record-head">
        <span class="badge ${r.decision}">${r.decision === "allow" ? "放行" : "拦截"}</span>
        <b>${RESOURCE_LABELS[req.resource_type] || req.resource_type}</b>
        <span class="kv">${req.is_inline ? "内联" : esc(req.resource_url || "(无URL)")}</span>
        <span class="kv">发起方: ${req.initiator === "script" ? "脚本" : "页面本身"}</span>
        <time>${fmtTime(r.time)}</time>
      </div>
      <div class="kv"><b>依据：</b>${esc(r.reason_summary)}</div>
      <details>
        <summary>查看逐策略判定依据（${r.policy_decisions.length} 份策略）</summary>
        ${perPolicy}
      </details>
      ${snapshots}
    </div>`;
}

$("#f-apply").addEventListener("click", loadRecords);
$("#f-reset").addEventListener("click", async () => {
  ["#f-decision", "#f-type", "#f-policy", "#f-mode", "#f-keyword"].forEach((s) => { $(s).value = ""; });
  await loadRecords();
});
$("#f-clear").addEventListener("click", async () => {
  if (!confirm("确认清空全部分析记录？此操作不可恢复（策略本身不受影响）。")) return;
  await api("/api/records", { method: "DELETE" });
  await loadRecords();
  toast("记录已清空", "info");
});

function currentFilterQuery() {
  const params = new URLSearchParams();
  [["decision", "#f-decision"], ["resource_type", "#f-type"], ["policy_id", "#f-policy"],
   ["mode", "#f-mode"], ["keyword", "#f-keyword"]].forEach(([k, sel]) => {
    const v = $(sel).value.trim();
    if (v) params.set(k, v);
  });
  return params.toString();
}

$("#f-export-csv").addEventListener("click", () => {
  window.location.href = `/api/records/export?${currentFilterQuery()}`;
});
$("#f-export-json").addEventListener("click", () => {
  const filtered = state.records;
  downloadText("csp-analysis.json", JSON.stringify(filtered, null, 2), "application/json");
  toast(`已导出 ${filtered.length} 条记录（JSON）`, "info");
});

// ---------------- 样例 ----------------
async function loadSamples() {
  if (!state.samples.length) {
    const data = await api("/api/samples");
    state.samples = data.samples;
  }
  $("#samples-list").innerHTML = state.samples.map((s) => `
    <div class="sample-card" data-key="${s.key}">
      <h3>${esc(s.title)}</h3>
      <p class="hint">${esc(s.description)}</p>
      <div class="row gap">
        ${s.policies.map((p) => `<span class="badge ${p.mode}">${MODE_LABELS[p.mode]} · ${esc(p.name)}</span>`).join("")}
        <button class="small s-import" data-key="${s.key}">导入策略到策略库</button>
        <span class="s-result summary"></span>
      </div>
      <div class="sample-req">
        ${s.requests.map((r, i) => `
          <div class="req-line">
            <code>${esc(r.key)}</code>
            <span>${RESOURCE_LABELS[r.resource_type] || r.resource_type}</span>
            <code>${esc(r.resource_url || (r.is_inline ? "inline" : ""))}</code>
            <span class="expected">预期: <b class="badge ${s.expected[i]}">${s.expected[i] === "allow" ? "放行" : "拦截"}</b></span>
            <span class="actual"></span>
          </div>`).join("")}
      </div>
    </div>`).join("");

  $$(".s-import").forEach((b) => b.addEventListener("click", async () => {
    try {
      const d = await api("/api/samples/import", { method: "POST", body: { key: b.dataset.key } });
      toast(`已导入 ${d.imported.length} 份样例策略`, "info");
      await loadPolicies();
    } catch (e) {
      toast(e.message);
    }
  }));
}

$("#s-run-all").addEventListener("click", async () => {
  const data = await api("/api/samples/run");
  const summary = $("#s-summary");
  summary.className = `summary ${data.all_pass ? "pass" : "fail"}`;
  summary.textContent = data.all_pass
    ? `✓ 全部 ${data.cases.reduce((n, c) => n + c.rows.length, 0)} 条样例判定与预期一致`
    : "✗ 存在与预期不一致的样例，请检查引擎";

  data.cases.forEach((c) => {
    const card = $(`.sample-card[data-key="${c.key}"]`);
    if (!card) return;
    card.querySelector(".s-result").className =
      `s-result summary ${c.case_pass ? "pass" : "fail"}`;
    card.querySelector(".s-result").textContent = c.case_pass ? "本组通过" : "本组失败";
    const lines = card.querySelectorAll(".req-line");
    c.rows.forEach((r, i) => {
      const actual = lines[i].querySelector(".actual");
      actual.innerHTML = `实际: <span class="badge ${r.actual}">${r.actual === "allow" ? "放行" : "拦截"}</span>`
        + (r.passed ? " ✓" : ` ✗ <span class="hint">${esc(r.reason_summary)}</span>`);
    });
  });
});

// ---------------- 启动 ----------------
async function boot() {
  try {
    const health = await api("/api/health");
    const pill = $("#health");
    pill.className = "health-pill ok";
    pill.textContent = health.offline ? "本地服务在线 · 离线模式" : "本地服务在线";
    renderTypeFilter();
    await loadPolicies();
  } catch (e) {
    const pill = $("#health");
    pill.className = "health-pill bad";
    pill.textContent = "无法连接本地服务，请先运行 python3 server.py";
  }
}
boot();
