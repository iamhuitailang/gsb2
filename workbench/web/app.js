/* Local Secret Workbench — dependency-free UI.
 * All untrusted values are inserted with textContent / DOM APIs, never innerHTML. */
"use strict";

const state = {
  config: null,
  scans: [],
  selectedScanId: null,
  findings: [],
  facets: null,
  baselines: [],
  comparison: null,
  pollTimer: null,
  directory: null,
  impact: null,
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2), value);
      } else if (key === "dataset") {
        for (const [k, v] of Object.entries(value)) node.dataset[k] = v;
      } else node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function toast(message, isError) {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast" + (isError ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => node.classList.add("hidden"), 4200);
}

async function api(path, options) {
  const opts = Object.assign({ headers: {} }, options || {});
  if (opts.method && opts.method !== "GET") {
    opts.headers["X-Workbench-Request"] = "1";
    opts.headers["Content-Type"] = "application/json";
    if (opts.body !== undefined && typeof opts.body !== "string") {
      opts.body = JSON.stringify(opts.body);
    }
  }
  const response = await fetch(path, opts);
  const type = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    let message = "请求失败（HTTP " + response.status + "）";
    let code = "http_" + response.status;
    if (type.includes("application/json")) {
      try {
        const payload = await response.json();
        if (payload && payload.error) {
          message = payload.error.message || message;
          code = payload.error.code || code;
        }
      } catch (_) { /* keep default */ }
    }
    const error = new Error(message);
    error.code = code;
    error.status = response.status;
    throw error;
  }
  if (opts.raw) return response;
  return response.json();
}

/* ------------------------------------------------------------------ utils */
function fmtTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function plural(value, unit) {
  return value + " " + unit;
}

function bytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let index = 0;
  let value = n;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
}

function severityChip(severity) {
  const labels = { critical: "严重", high: "高", medium: "中", low: "低" };
  return el("span", { class: "chip " + severity, text: (labels[severity] || severity) + " · " + severity });
}

function reviewChip(item) {
  const map = {
    pending: "ok", accepted: "warn", ignored: "warn",
    ignore_expired: "critical", needs_rereview: "critical",
  };
  const cls = map[item.review_state] || "";
  return el("span", { class: "chip " + cls, text: item.review_state_label || item.review_state });
}

function statusChip(item) {
  const map = { new: "critical", persistent: "high", resolved: "ok", unreviewable: "warn" };
  return el("span", { class: "chip " + (map[item.status] || ""), text: item.status_label || item.status });
}

/* ---------------------------------------------------------------- routing */
function showView(name) {
  $$(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.view === name));
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === "view-" + name));
  if (name === "baseline") loadBaselines().catch((err) => toast(err.message, true));
  if (name === "reviews") loadReviews().catch((err) => toast(err.message, true));
  if (name === "rules") loadRules().catch((err) => toast(err.message, true));
}

$$(".nav-btn").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

/* ------------------------------------------------------------------- init */
async function boot() {
  try {
    state.config = await api("/api/config");
    $("#top-meta").appendChild(
      el("span", { text: "数据目录 " }),
      el("code", { text: state.config.data_dir }),
      el("span", { text: "规则 " }),
      el("code", { text: state.config.rules_path }),
    );
  } catch (err) {
    toast("无法读取配置：" + err.message, true);
  }
  await refreshScans();
}

/* ------------------------------------------------------------------ scans */
async function refreshScans() {
  try {
    const payload = await api("/api/scans?limit=60");
    state.scans = payload.items || [];
    renderScanList();
    if (!state.selectedScanId && state.scans.length) {
      selectScan(state.scans[0].id).catch(() => {});
    } else if (state.selectedScanId) {
      const current = state.scans.find((s) => s.id === state.selectedScanId);
      if (current) {
        renderProgress(current);
        if (current.status === "running" || current.status === "queued") schedulePoll();
      }
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderScanList() {
  const list = $("#scan-list");
  clear(list);
  if (!state.scans.length) {
    list.appendChild(el("div", { class: "empty", text: "还没有扫描记录" }));
    return;
  }
  for (const scan of state.scans) {
    const stats = scan.stats || {};
    const item = el("div", {
      class: "scan-item" + (scan.id === state.selectedScanId ? " selected" : ""),
      role: "button",
      tabindex: "0",
      onclick: () => selectScan(scan.id).catch((err) => toast(err.message, true)),
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") selectScan(scan.id).catch(() => {});
      },
    }, [
      el("div", {}, [
        el("div", { class: "path", text: scan.root }),
        el("div", { class: "meta" }, [
          el("span", { text: "开始 " + fmtTime(scan.created_at) }),
          el("span", { text: "发现 " + (stats.findings || 0) }),
          el("span", { text: "新增 " + (stats.new || 0) }),
          el("span", { text: "未检查 " + (scan.skipped_count || 0) }),
          el("span", { text: "规则 " + String(scan.ruleset_version || "").slice(0, 8) }),
        ]),
      ]),
      el("span", { class: "status-pill " + scan.status, text: scan.status }),
    ]);
    list.appendChild(item);
  }
}

function renderProgress(scan) {
  const card = $("#scan-progress-card");
  if (!scan || (scan.status !== "running" && scan.status !== "queued")) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const stats = scan.stats || {};
  const processed = stats.processed || 0;
  const total = stats.discovered || 0;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : (stats.phase === "scanning" ? 5 : 0);
  $("#progress-bar").style.width = pct + "%";
  $("#progress-title").textContent = scan.status === "queued" ? "扫描排队中" : "扫描进行中";
  $("#progress-status").textContent = scan.status;
  $("#progress-detail").textContent =
    processed + " / " + total + " 个候选文件 · 已检查 " + (stats.inspected || 0) +
    " · 未检查 " + (stats.skipped || 0) + " · 已扫描行 " + (stats.lines || 0);
}

function schedulePoll() {
  if (state.pollTimer) return;
  state.pollTimer = setTimeout(async () => {
    state.pollTimer = null;
    await refreshScans();
    const scan = state.scans.find((s) => s.id === state.selectedScanId);
    if (scan && (scan.status === "running" || scan.status === "queued")) {
      schedulePoll();
    } else if (scan && scan.status === "completed") {
      await selectScan(scan.id).catch(() => {});
    }
  }, 900);
}

async function startScan() {
  const root = $("#scan-root").value.trim();
  const msg = $("#scan-msg");
  msg.className = "notice hidden";
  if (!root) {
    msg.className = "notice err";
    msg.textContent = "请先选择本机项目目录";
    return;
  }
  const excludeRaw = $("#scan-exclude").value.trim();
  const patterns = excludeRaw ? excludeRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const body = {
    root,
    exclude_patterns: patterns,
    options: {
      max_file_bytes: Math.max(1, Number($("#scan-max-file").value) || 2) * 1024 * 1024,
      max_files: Math.max(1, Number($("#scan-max-files").value) || 20000),
    },
  };
  const button = $("#scan-btn");
  button.disabled = true;
  try {
    const payload = await api("/api/scans", { method: "POST", body });
    state.selectedScanId = payload.scan.id;
    msg.className = "notice ok";
    msg.textContent = "扫描已启动：" + payload.scan.root;
    await refreshScans();
    await selectScan(payload.scan.id);
  } catch (err) {
    msg.className = "notice err";
    msg.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

$("#scan-btn").addEventListener("click", startScan);
$("#refresh-scans").addEventListener("click", () => refreshScans().catch((e) => toast(e.message, true)));

/* ------------------------------------------------------------ directory picker */
async function browseDirectory(path) {
  const payload = await api("/api/directory?path=" + encodeURIComponent(path || ""));
  state.directory = payload;
  const body = el("div", { class: "stack" }, [
    el("div", { class: "mono small", text: payload.path }),
    el("div", { class: "table-wrap", style: "max-height:46vh" },
      [el("table", {}, [el("tbody", {}, payload.entries.map((entry) =>
        el("tr", {
          class: "clickable",
          onclick: () => {
            if (entry.symlink) { toast("符号链接目录不会进入扫描；可手动输入其他路径", true); return; }
            closeModal();
            browseDirectory(entry.path).catch((err) => toast(err.message, true));
          },
        }, [
          el("td", { text: entry.symlink ? "🔗 " + entry.name : "📁 " + entry.name }),
        ])
      ))])]),
  ]);
  openModal({
    title: "选择项目目录",
    body,
    actions: [
      el("button", { type: "button", text: "上级", onclick: () => {
        if (!payload.parent) return;
        closeModal();
        browseDirectory(payload.parent).catch((err) => toast(err.message, true));
      }}),
      el("button", { type: "button", text: "取消", onclick: closeModal }),
      el("button", { class: "primary", type: "button", text: "选择此目录", onclick: () => {
        $("#scan-root").value = payload.path;
        closeModal();
      }}),
    ],
  });
}

$("#browse-btn").addEventListener("click", () => {
  browseDirectory($("#scan-root").value.trim() || "").catch((err) => toast(err.message, true));
});

/* ----------------------------------------------------------------- results */
async function selectScan(scanId) {
  state.selectedScanId = scanId;
  renderScanList();
  const scan = await api("/api/scans/" + encodeURIComponent(scanId));
  renderProgress(scan.scan);
  if (scan.scan.status === "running" || scan.scan.status === "queued") {
    $("#results-card").classList.add("hidden");
    schedulePoll();
    return;
  }
  $("#results-card").classList.remove("hidden");
  renderMeter(scan.scan);
  await Promise.all([loadFindings(), loadSkipped(), loadBaselines(), loadCompareOptions()]);
}

function renderMeter(scan) {
  const stats = scan.stats || {};
  const meter = $("#result-meter");
  clear(meter);
  const cells = [
    ["检查文件", stats.files_inspected || 0],
    ["扫描行", stats.lines_scanned || 0],
    ["发现", stats.findings || 0],
    ["新增", stats.new || 0],
    ["持续存在", stats.persistent || 0],
    ["已消失", stats.resolved || 0],
    ["无法复核", stats.unreviewable || 0],
    ["未检查文件", scan.skipped_count || 0],
  ];
  for (const [label, value] of cells) {
    meter.appendChild(el("div", { class: "cell" }, [
      el("div", { class: "n", text: String(value) }),
      el("div", { class: "l", text: label }),
    ]));
  }
}

function currentFilters() {
  const pick = (id) => Array.from($(id).selectedOptions).map((o) => o.value);
  return {
    severity: pick("#f-severity").join(","),
    status: pick("#f-status").join(","),
    review_state: pick("#f-review").join(","),
    rule: pick("#f-rule").join(","),
    path: $("#f-path").value.trim(),
    q: $("#f-q").value.trim(),
  };
}

function queryForFilters() {
  const filters = currentFilters();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return params.toString();
}

async function loadFindings() {
  if (!state.selectedScanId) return;
  const qs = queryForFilters();
  const payload = await api(
    "/api/scans/" + encodeURIComponent(state.selectedScanId) + "/findings" + (qs ? "?" + qs : "")
  );
  state.findings = payload.items || [];
  state.facets = payload.facets || {};
  renderFindings();
  renderRuleFilter();
  $("#result-count").textContent = "共 " + state.findings.length + " 条结果";
}

function renderRuleFilter() {
  const select = $("#f-rule");
  const chosen = new Set(Array.from(select.selectedOptions).map((o) => o.value));
  clear(select);
  const facets = (state.facets && state.facets.rule) || {};
  const names = {};
  for (const finding of state.findings) names[finding.rule_id] = finding.rule_name;
  for (const ruleId of Object.keys(facets).sort()) {
    const option = el("option", { value: ruleId, text: (names[ruleId] || ruleId) + " (" + facets[ruleId] + ")" });
    option.selected = chosen.has(ruleId);
    select.appendChild(option);
  }
}

function renderFindings() {
  const body = $("#findings-body");
  clear(body);
  if (!state.findings.length) {
    body.appendChild(el("tr", {}, [el("td", { colspan: "8" }, [
      el("div", { class: "empty", text: "没有符合筛选条件的发现" }),
    ])]));
    return;
  }
  for (const finding of state.findings) {
    const row = el("tr", { class: "clickable", onclick: () => openFinding(finding) }, [
      el("td", {}, [severityChip(finding.severity)]),
      el("td", {}, [statusChip(finding)]),
      el("td", {}, [reviewChip(finding)]),
      el("td", {}, [
        el("div", { text: finding.rule_name }),
        el("div", { class: "small muted mono", text: finding.rule_id }),
      ]),
      el("td", { class: "path", text: finding.path }),
      el("td", { class: "mono nowrap", text: finding.line + ":" + finding.column }),
      el("td", {}, [el("span", { class: "preview", title: finding.preview, text: finding.preview })]),
      el("td", {}, [el("button", { class: "ghost", type: "button", text: "详情", onclick: (event) => {
        event.stopPropagation();
        openFinding(finding);
      } })]),
    ]);
    body.appendChild(row);
  }
}

function openFinding(finding) {
  const body = el("div", { class: "stack" });
  const kv = el("dl", { class: "kv" });
  const add = (label, value, cls) => {
    kv.appendChild(el("dt", { text: label }));
    kv.appendChild(cls ? el("dd", { class: cls, text: value }) : el("dd", { text: value }));
  };
  add("文件", finding.path, "mono");
  add("位置", "第 " + finding.line + " 行，第 " + finding.column + " 列");
  add("规则", finding.rule_name + "（" + finding.rule_id + "）");
  add("family", finding.family, "mono small");
  add("风险", finding.severity);
  add("状态", finding.status_label || finding.status);
  add("复核", finding.review_state_label || finding.review_state);
  if (finding.review_note) add("说明", finding.review_note);
  add("遮蔽预览", finding.preview, "preview");
  add("匹配长度", String(finding.secret_length) + " 字符 / 熵 " + finding.secret_entropy);
  add("内容身份", finding.identity, "mono");
  add("规则版本", finding.rule_version + "（语义 " + finding.rule_semantic_hash + "）");
  if (finding.rule_changed_since_scan) add("提示", "扫描后规则文件已修改，建议重新扫描");
  if (finding.overlaps && finding.overlaps.length) {
    add("重叠规则", finding.overlaps.join(", ") + "（被更具体的规则覆盖，未重复计数）");
  }
  if (finding.verification_reason) add("核查说明", finding.verification_reason);
  body.appendChild(kv);

  const reasonField = el("div", { class: "field" }, [
    el("label", { text: "复核理由（必填）" }),
    el("textarea", { id: "review-reason", rows: "3", placeholder: "例如：这是测试用占位值，已在上游轮换" }),
  ]);
  const actorField = el("div", { class: "field" }, [
    el("label", { text: "复核人（可选）" }),
    el("input", { type: "text", id: "review-actor", placeholder: "姓名或工号" }),
  ]);
  const daysField = el("div", { class: "field" }, [
    el("label", { text: "忽略天数（到期后重新提示）" }),
    el("input", { type: "number", id: "review-days", min: "1", max: String((state.config && state.config.max_ignore_days) || 3650), value: String((state.config && state.config.default_ignore_days) || 30) }),
  ]);
  const reasonWrap = el("div", { class: "stack" }, [reasonField, actorField, daysField]);
  body.appendChild(reasonWrap);

  const canReview = finding.status === "new" || finding.status === "persistent";
  const actions = [el("button", { type: "button", text: "关闭", onclick: closeDrawer })];
  if (canReview) {
    actions.push(el("button", { type: "button", class: "danger", text: "忽略…", onclick: () => submitReview(finding, "ignore") }));
    actions.push(el("button", { type: "button", class: "primary", text: "接受", onclick: () => submitReview(finding, "accept") }));
    if (finding.review_state !== "pending") {
      actions.push(el("button", { type: "button", text: "清除复核", onclick: () => clearReview(finding) }));
    }
  } else {
    body.appendChild(el("div", { class: "notice", text: "该发现当前状态不可复核（已消失或本次未检查）。" }));
  }

  openDrawer({ title: "发现详情", body, actions });
}

async function submitReview(finding, decision) {
  const reason = $("#review-reason").value.trim();
  if (!reason) { toast("请填写复核理由", true); $("#review-reason").focus(); return; }
  const payload = { decision, reason, expected_fingerprint: finding.fingerprint };
  const actor = $("#review-actor").value.trim();
  if (actor) payload.actor = actor;
  if (decision === "ignore") {
    const days = Number($("#review-days").value);
    if (!days || days < 1) { toast("忽略天数必须大于 0", true); return; }
    payload.ignore_days = days;
  }
  try {
    await api("/api/findings/" + encodeURIComponent(finding.id) + "/review", { method: "POST", body: payload });
    closeDrawer();
    toast(decision === "ignore" ? "已忽略，到期后会重新提示" : "已接受");
    await loadFindings();
    await refreshScans();
  } catch (err) {
    toast(err.message, true);
  }
}

async function clearReview(finding) {
  try {
    await api("/api/findings/" + encodeURIComponent(finding.id) + "/review", { method: "DELETE" });
    closeDrawer();
    toast("已清除复核记录");
    await loadFindings();
  } catch (err) {
    toast(err.message, true);
  }
}

["#f-severity", "#f-status", "#f-review", "#f-rule", "#f-path", "#f-q"].forEach((sel) => {
  $(sel).addEventListener("change", () => loadFindings().catch((e) => toast(e.message, true)));
  if (sel === "#f-path" || sel === "#f-q") {
    let timer = null;
    $(sel).addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadFindings().catch(() => {}), 280);
    });
  }
});
$("#f-reset").addEventListener("click", () => {
  ["#f-severity", "#f-status", "#f-review", "#f-rule"].forEach((sel) => {
    Array.from($(sel).options).forEach((o) => { o.selected = false; });
  });
  $("#f-path").value = "";
  $("#f-q").value = "";
  loadFindings().catch((e) => toast(e.message, true));
});

/* ---------------------------------------------------------------- skipped */
async function loadSkipped() {
  if (!state.selectedScanId) return;
  const payload = await api("/api/scans/" + encodeURIComponent(state.selectedScanId) + "/skipped");
  const summary = $("#skipped-summary");
  clear(summary);
  if (!payload.items.length) {
    summary.appendChild(el("span", { class: "small muted", text: "所有候选文件均已检查，没有跳过项。" }));
  }
  const labels = (state.config && state.config.skip_reason_labels) || {};
  for (const [reason, count] of Object.entries(payload.by_reason || {})) {
    summary.appendChild(el("span", { class: "chip warn", text: (labels[reason] || reason) + " " + count }));
  }
  const body = $("#skipped-body");
  clear(body);
  for (const item of payload.items) {
    body.appendChild(el("tr", {}, [
      el("td", { class: "path", text: item.path }),
      el("td", {}, [el("span", { class: "chip warn", text: item.label || item.reason })]),
      el("td", { class: "small" }, [item.message || ""]),
    ]));
  }
  if (!payload.items.length) {
    body.appendChild(el("tr", {}, [el("td", { colspan: "3" }, [el("div", { class: "empty", text: "没有未检查的文件" })])]));
  }
}

/* --------------------------------------------------------------- baselines */
async function loadBaselines() {
  const payload = await api("/api/baselines");
  state.baselines = payload.items || [];
  const body = $("#baseline-body");
  clear(body);
  if (!state.baselines.length) {
    body.appendChild(el("tr", {}, [el("td", { colspan: "6" }, [el("div", { class: "empty", text: "还没有基线" })])]));
  }
  for (const baseline of state.baselines) {
    body.appendChild(el("tr", {}, [
      el("td", {}, [el("div", { text: baseline.name }), el("div", { class: "small muted", text: baseline.note || "" })]),
      el("td", { class: "nowrap", text: fmtTime(baseline.created_at) }),
      el("td", { class: "mono", text: String(baseline.finding_count) }),
      el("td", { class: "mono small", text: String(baseline.ruleset_version).slice(0, 12) }),
      el("td", { class: "mono small", text: String(baseline.scan_id).slice(0, 12) }),
      el("td", {}, [el("button", { class: "danger", type: "button", text: "删除", onclick: async () => {
        if (!window.confirm("删除基线「" + baseline.name + "」？")) return;
        try {
          await api("/api/baselines/" + encodeURIComponent(baseline.id), { method: "DELETE" });
          toast("基线已删除");
          await loadBaselines();
          await loadCompareOptions();
        } catch (err) { toast(err.message, true); }
      } })]),
    ]));
  }
  await loadCompareOptions();
}

async function loadCompareOptions() {
  const select = $("#compare-baseline");
  const previous = select.value;
  clear(select);
  const scan = state.scans.find((s) => s.id === state.selectedScanId);
  const candidates = state.baselines.filter((b) => !scan || b.root_real === scan.root_real);
  if (!candidates.length) {
    select.appendChild(el("option", { value: "", text: "（没有与当前项目匹配的基线）" }));
    return;
  }
  for (const baseline of candidates) {
    select.appendChild(el("option", { value: baseline.id, text: baseline.name + " · " + fmtTime(baseline.created_at) }));
  }
  if (previous) select.value = previous;
}

async function runCompare() {
  const baselineId = $("#compare-baseline").value;
  if (!baselineId) { toast("请先选择基线", true); return; }
  try {
    const payload = await api(
      "/api/scans/" + encodeURIComponent(state.selectedScanId) + "/compare?baseline_id=" + encodeURIComponent(baselineId)
    );
    state.comparison = payload.comparison;
    renderComparison(payload.comparison);
  } catch (err) {
    toast(err.message, true);
  }
}

function comparisonTable(title, items, options) {
  const card = el("div", { class: "card", style: "box-shadow:none;margin-bottom:14px" }, [
    el("div", { class: "card-header" }, [
      el("h3", { text: title }),
      el("span", { class: "badge-mini", text: String(items.length) }),
    ]),
  ]);
  if (!items.length) {
    card.appendChild(el("div", { class: "empty", text: "无" }));
    return card;
  }
  const rows = items.map((item) => el("tr", {}, [
    el("td", {}, [severityChip(item.severity)]),
    el("td", { class: "path", text: item.path }),
    el("td", { class: "mono nowrap", text: String(item.line) + (item.column ? ":" + item.column : "") }),
    el("td", {}, [el("span", { class: "preview", text: item.preview || "" })]),
    el("td", { class: "small muted", text: (options && options.extra && options.extra(item)) || item.rule_id }),
  ]));
  card.appendChild(el("div", { class: "table-wrap", style: "max-height:36vh" }, [
    el("table", {}, [
      el("thead", {}, [el("tr", {}, [
        el("th", { text: "风险" }), el("th", { text: "文件" }), el("th", { text: "行" }),
        el("th", { text: "遮蔽预览" }), el("th", { text: "规则 / 说明" }),
      ])]),
      el("tbody", {}, rows),
    ]),
  ]));
  return card;
}

function renderComparison(comparison) {
  const out = $("#compare-output");
  clear(out);
  const s = comparison.summary;
  const changedNote = comparison.ruleset_changed
    ? el("div", { class: "notice", text: "基线规则版本与本次扫描不同；新增可能来自规则变化，而不是新增凭据。建议结合规则版本判断。" })
    : null;
  if (changedNote) out.appendChild(changedNote);
  out.appendChild(el("div", { class: "meter", style: "margin-bottom:14px" }, [
    ["新增", s.new, "critical"], ["路径/行号变化（身份不变）", s.relocated, "warn"],
    ["仍存在", s.persistent, "high"], ["已消失", s.resolved, "ok"], ["无法确认", s.unverifiable, "warn"],
  ].map(([label, value, cls]) => el("div", { class: "cell" }, [
    el("div", { class: "n " , text: String(value) }),
    el("div", { class: "l", text: label }),
  ]))));
  out.appendChild(comparisonTable("新增发现", comparison.new));
  out.appendChild(comparisonTable("基线中已消失", comparison.resolved));
  out.appendChild(comparisonTable("路径或行号变化（身份稳定）", comparison.changed, {
    extra: (item) => "原位置 " + (item.baseline_location ? item.baseline_location.path + ":" + item.baseline_location.line : "—"),
  }));
  out.appendChild(comparisonTable("无法确认（对应文件未检查）", comparison.unverifiable));
}

$("#compare-btn").addEventListener("click", runCompare);

$("#save-baseline-btn").addEventListener("click", () => {
  if (!state.selectedScanId) { toast("请先选择一次扫描", true); return; }
  const nameField = el("input", { type: "text", id: "baseline-name", placeholder: "例如：发布前基线 2026-11" });
  const noteField = el("input", { type: "text", id: "baseline-note", placeholder: "可选备注" });
  const includeField = el("select", { id: "baseline-include" }, [
    el("option", { value: "all", text: "全部当前发现" }),
    el("option", { value: "accepted", text: "仅已接受的发现" }),
    el("option", { value: "open", text: "仅未接受/未忽略的发现" }),
  ]);
  openModal({
    title: "保存基线",
    body: el("div", { class: "stack" }, [
      el("div", { class: "field" }, [el("label", { text: "名称" }), nameField]),
      el("div", { class: "field" }, [el("label", { text: "备注" }), noteField]),
      el("div", { class: "field" }, [el("label", { text: "范围" }), includeField]),
    ]),
    actions: [
      el("button", { type: "button", text: "取消", onclick: closeModal }),
      el("button", { class: "primary", type: "button", text: "保存", onclick: async () => {
        try {
          await api("/api/scans/" + encodeURIComponent(state.selectedScanId) + "/baseline", {
            method: "POST",
            body: {
              name: nameField.value.trim(),
              note: noteField.value.trim(),
              include: includeField.value,
            },
          });
          closeModal();
          toast("基线已保存");
          await loadBaselines();
        } catch (err) { toast(err.message, true); }
      } }),
    ],
  });
});

/* ----------------------------------------------------------------- export */
async function exportReport(format) {
  if (!state.selectedScanId) return;
  const qs = queryForFilters();
  const params = new URLSearchParams(qs);
  params.set("format", format);
  const baselineId = $("#compare-baseline").value;
  if (baselineId && !$("#tab-compare").classList.contains("hidden")) params.set("baseline_id", baselineId);
  try {
    const response = await api(
      "/api/scans/" + encodeURIComponent(state.selectedScanId) + "/report?" + params.toString(),
      { raw: true }
    );
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const match = /filename="([^"]+)"/.exec(disposition);
    const name = match ? match[1] : "report." + format;
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("报告已导出（不含匹配原文）");
  } catch (err) {
    toast(err.message, true);
  }
}
$("#export-json").addEventListener("click", () => exportReport("json"));
$("#export-csv").addEventListener("click", () => exportReport("csv"));

$$("#result-tabs .tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$("#result-tabs .tab").forEach((t) => t.classList.toggle("active", t === tab));
    ["findings", "skipped", "compare"].forEach((name) => {
      $("#tab-" + name).classList.toggle("hidden", name !== tab.dataset.tab);
    });
  });
});

/* ------------------------------------------------------------------ rules */
async function loadRules() {
  const payload = await api("/api/rules");
  $("#rules-editor").value = payload.text;
  $("#rules-path").textContent = payload.path;
  $("#rules-version-chip").textContent = "版本 " + payload.version;
  const body = $("#rules-table-body");
  clear(body);
  for (const rule of payload.snapshot.rules) {
    body.appendChild(el("tr", {}, [
      el("td", { class: "mono", text: rule.id }),
      el("td", { class: "mono small", text: rule.family }),
      el("td", {}, [el("div", { text: rule.name }), el("div", { class: "small muted", text: rule.description })]),
      el("td", {}, [severityChip(rule.severity)]),
      el("td", { class: "mono small", text: rule.version }),
      el("td", { class: "mono small", text: rule.semantic_hash }),
    ]));
  }
}

async function rulesAction(kind) {
  const text = $("#rules-editor").value;
  const msg = $("#rules-msg");
  msg.className = "notice hidden";
  const out = $("#rules-impact-out");
  clear(out);
  try {
    if (kind === "validate") {
      const payload = await api("/api/rules/validate", { method: "POST", body: { text } });
      msg.className = "notice ok";
      msg.textContent = "规则有效，版本 " + payload.version + "（共 " + payload.snapshot.rules.length + " 条规则）";
    } else if (kind === "impact") {
      const impact = await api("/api/rules/impact", { method: "POST", body: { text } });
      state.impact = impact;
      const list = (label, items) => el("div", { class: "stack" }, [
        el("h3", { text: label }),
        items.length ? el("div", { class: "chips" }, items.map((f) => el("span", { class: "chip", text: f })))
          : el("div", { class: "small muted", text: "无" }),
      ]);
      out.appendChild(el("div", { class: "stack" }, [
        impact.warning ? el("div", { class: "notice", text: impact.warning }) : el("div", { class: "notice ok", text: "规则含义没有变化" }),
        list("含义变化（旧复核失效）", impact.semantic_change_families),
        list("仅外观/元数据变化", impact.cosmetic_change_families),
        list("新增 family", impact.added_families),
        list("移除 family", impact.removed_families),
      ]));
    } else if (kind === "save") {
      const payload = await api("/api/rules", { method: "PUT", body: { text } });
      msg.className = "notice ok";
      msg.textContent = "已保存，新规则版本 " + payload.version + "。请重新扫描以应用新规则。";
      await loadRules();
    }
  } catch (err) {
    msg.className = "notice err";
    msg.textContent = err.message;
  }
}
$("#rules-validate").addEventListener("click", () => rulesAction("validate"));
$("#rules-impact").addEventListener("click", () => rulesAction("impact"));
$("#rules-save").addEventListener("click", () => rulesAction("save"));

/* ---------------------------------------------------------------- reviews */
async function loadReviews() {
  const payload = await api("/api/reviews");
  const body = $("#reviews-body");
  clear(body);
  if (!payload.items.length) {
    body.appendChild(el("tr", {}, [el("td", { colspan: "6" }, [el("div", { class: "empty", text: "还没有复核记录" })])]));
  }
  for (const review of payload.items) {
    body.appendChild(el("tr", {}, [
      el("td", {}, [el("span", { class: "chip " + (review.decision === "accept" ? "warn" : "low"), text: review.decision === "accept" ? "接受" : "忽略" })]),
      el("td", { class: "mono small", text: review.family }),
      el("td", { class: "small", text: review.reason }),
      el("td", { class: "small", text: review.actor || "—" }),
      el("td", { class: "small nowrap", text: fmtTime(review.updated_at) }),
      el("td", { class: "small nowrap", text: review.ignore_until ? fmtTime(review.ignore_until) : "—" }),
    ]));
  }
  const events = $("#events-body");
  clear(events);
  for (const event of payload.events || []) {
    events.appendChild(el("tr", {}, [
      el("td", { class: "small nowrap", text: fmtTime(event.reviewed_at) }),
      el("td", { class: "small", text: event.decision === "accept" ? "接受" : "忽略" }),
      el("td", { class: "mono small", text: event.family }),
      el("td", { class: "small", text: event.reason }),
      el("td", { class: "small nowrap", text: event.ignore_until ? fmtTime(event.ignore_until) : "—" }),
    ]));
  }
}
$("#refresh-reviews").addEventListener("click", () => loadReviews().catch((e) => toast(e.message, true)));

/* ------------------------------------------------------- modal & drawer */
function openModal({ title, body, actions }) {
  const root = $("#modal-root");
  clear(root);
  const backdrop = el("div", { class: "modal-backdrop", onclick: (event) => {
    if (event.target === backdrop) closeModal();
  } }, [
    el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
      el("header", {}, [el("h2", { text: title })]),
      el("div", { class: "body" }, [body]),
      el("footer", {}, actions || []),
    ]),
  ]);
  root.appendChild(backdrop);
}
function closeModal() { clear($("#modal-root")); }

function openDrawer({ title, body, actions }) {
  const root = $("#drawer-root");
  clear(root);
  const backdrop = el("div", { class: "drawer-backdrop", onclick: closeDrawer });
  const drawer = el("aside", { class: "drawer", role: "dialog", "aria-modal": "true" }, [
    el("header", {}, [el("h2", { text: title }), el("div", { class: "spacer" })]),
    el("div", { class: "body" }, [body]),
    el("footer", {}, actions || []),
  ]);
  root.appendChild(backdrop);
  root.appendChild(drawer);
}
function closeDrawer() { clear($("#drawer-root")); }

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { closeModal(); closeDrawer(); }
});

boot();
