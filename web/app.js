// 调度台前端逻辑：每秒刷新状态，所有操作直接调采集后台 API
const $ = (id) => document.getElementById(id);

let state = null;
let quotaMap = {};   // source_id -> 模拟来源实时额度
let logFilter = "";

function fmtTime(ts) {
  if (!ts && ts !== 0) return "-";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDateTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtTime(ts)}`;
}

function badge(text, cls) {
  return `<span class="badge ${cls}">${text}</span>`;
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await resp.json();
  if (!resp.ok) throw new Error(payload.error || `HTTP ${resp.status}`);
  return payload;
}

function showMsg(text, ok = true) {
  const el = $("action-msg");
  el.textContent = text;
  el.className = `msg ${ok ? "ok" : "err"}`;
  if (text) setTimeout(() => { el.textContent = ""; }, 4000);
}

// ------------------------------------------------------------------ 主状态
async function refreshState() {
  try {
    state = await api("/api/state");
    $("server-time").textContent = `服务端时间 ${fmtDateTime(state.server_time)}`;
    renderVenueOptions();
    renderSources();
    renderJobs();
    renderSchedules();
  } catch (e) {
    $("server-time").textContent = `后台不可达：${e.message}`;
  }
}

function renderVenueOptions() {
  const sel = $("venue-select");
  if (sel.options.length) return;
  for (const v of state.venues) {
    sel.add(new Option(`${v.name}（${v.id}）`, v.id));
  }
  const filter = $("log-source-filter");
  if (filter.options.length <= 1) {
    for (const s of state.sources) filter.add(new Option(s.name, s.id));
  }
  if (!$("date-input").value) $("date-input").value = "2026-11-15";
}

// ------------------------------------------------------------------ 来源
async function refreshQuota() {
  await Promise.all(state.sources.map(async (s) => {
    try {
      quotaMap[s.id] = await api(`/api/source/quota?source_id=${encodeURIComponent(s.id)}`);
    } catch (e) {
      quotaMap[s.id] = { error: e.message };
    }
  }));
  renderSources();
}

function renderSources() {
  if (!state) return;
  const now = state.server_time;
  $("sources-body").innerHTML = state.sources.map((s) => {
    const q = quotaMap[s.id] || {};
    let quotaCell = "额度查询中…";
    if (q.error) quotaCell = `<span class="badge error">来源不可达</span>`;
    if (q.source_id) {
      const dots = Array.from({ length: q.capacity }, (_, i) =>
        `<span class="dot ${i < q.remaining ? "on" : "off"}"></span>`
      ).join("");
      quotaCell = `<div class="quota-bar">${dots}
        <span>剩余 ${q.remaining}/${q.capacity}</span>
        ${q.paused ? badge(`暂停中（${q.retry_after}s/轮）`, "backoff") : badge("可用", "idle")}
      </div>`;
    }
    let nextReq = "-";
    if (s.status === "backoff" && s.next_request_at) {
      const left = Math.max(0, s.next_request_at - now);
      nextReq = `${fmtTime(s.next_request_at)} <span class="countdown">（${left.toFixed(1)}s 后）</span>`;
    } else if (s.status === "running") {
      nextReq = "请求中…";
    }
    return `<tr>
      <td><strong>${s.name}</strong><br><code>${s.id}</code></td>
      <td>${s.base_url}</td>
      <td>${quotaCell}</td>
      <td>${nextReq}</td>
      <td>${badge(s.status, s.status)}</td>
      <td>${s.last_error || "-"}</td>
      <td><button onclick="startCycle('${s.id}')">启动一轮预设额度周期</button></td>
    </tr>`;
  }).join("");
}

window.startCycle = async function (sourceId) {
  try {
    const q = await api("/api/source/start-cycle", {
      method: "POST",
      body: JSON.stringify({ source_id: sourceId }),
    });
    showMsg(`已启动新一轮额度周期（第 ${q.cycle_seq} 轮，额度 ${q.capacity} 次）`);
    await refreshQuota();
  } catch (e) {
    showMsg(e.message, false);
  }
};

// ------------------------------------------------------------------ 任务
function renderJobs() {
  if (!state) return;
  const venueName = Object.fromEntries(state.venues.map((v) => [v.id, v.name]));
  const sourceName = Object.fromEntries(state.sources.map((s) => [s.id, s.name]));
  $("jobs-body").innerHTML = state.jobs.map((j) => {
    const total = j.total_pages ?? "?";
    const pages = (j.pages || []).map((p) =>
      `<li>第 ${p.page_no} 页：${badge(p.status, p.status)} · 新写入 ${p.rows_written} 条 · 尝试 ${p.attempt_count} 次</li>`
    ).join("");
    return `<tr>
      <td><strong>${venueName[j.venue_id] || j.venue_id}</strong><br>${j.date}<br><code>#${j.id}</code></td>
      <td>${sourceName[j.source_id] || j.source_id}</td>
      <td>${badge(j.status, j.status)}</td>
      <td>${j.done_pages}/${total} 页
        <ul class="pages-sub">${pages || "<li>等待调度…</li>"}</ul>
      </td>
      <td><strong>${j.reservation_count}</strong> 条</td>
      <td>${j.triggers.split(",").map((t) => badge(t === "manual" ? "手动" : "计划", t === "manual" ? "idle" : "pending")).join(" ")}</td>
      <td>${fmtDateTime(j.created_at)}</td>
      <td>${fmtDateTime(j.updated_at)}</td>
      <td><button class="secondary" onclick="rerunJob(${j.id})">从头重跑</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" style="text-align:center;color:#6b7280">暂无任务</td></tr>`;
}

window.rerunJob = async function (jobId) {
  try {
    await api("/api/jobs/rerun", { method: "POST", body: JSON.stringify({ job_id: jobId }) });
    showMsg(`任务 #${jobId} 已重置，将从头重拉（已入库记录按记录 id 去重）`);
    await refreshState();
  } catch (e) {
    showMsg(e.message, false);
  }
};

// ------------------------------------------------------------------ 计划任务
function renderSchedules() {
  if (!state) return;
  const venueName = Object.fromEntries(state.venues.map((v) => [v.id, v.name]));
  $("schedules-body").innerHTML = state.schedules.map((sc) => `
    <tr>
      <td>${venueName[sc.venue_id] || sc.venue_id}</td>
      <td>${sc.date}</td>
      <td>${sc.interval_seconds}</td>
      <td>${sc.enabled ? badge("启用", "idle") : badge("停用", "error")}</td>
      <td>${fmtDateTime(sc.last_run_at)}</td>
      <td>${fmtDateTime(sc.next_run_at)}</td>
      <td><button class="secondary" onclick="toggleSchedule(${sc.id}, ${sc.enabled ? 0 : 1})">
        ${sc.enabled ? "停用" : "启用"}</button></td>
    </tr>`).join("") || `<tr><td colspan="7" style="text-align:center;color:#6b7280">暂无计划任务</td></tr>`;
}

window.toggleSchedule = async function (id, enabled) {
  await api("/api/schedules/toggle", { method: "POST", body: JSON.stringify({ id, enabled: !!enabled }) });
  await refreshState();
};

// ------------------------------------------------------------------ 日志
async function loadLogs() {
  const qs = logFilter ? `?source_id=${encodeURIComponent(logFilter)}` : "";
  const { logs } = await api(`/api/logs${qs}`);
  $("logs-body").innerHTML = logs.map((l) => `
    <tr>
      <td>${l.source_id}</td>
      <td>${l.venue_id || "-"}</td>
      <td>${l.date || "-"}</td>
      <td>${l.page_no ?? "-"}</td>
      <td>${fmtDateTime(l.request_at)}</td>
      <td>${fmtDateTime(l.response_at)}</td>
      <td>${l.status_code ?? "-"}</td>
      <td>${badge(
        l.outcome === "success" ? "成功" : l.outcome === "rate_limited" ? "429 限流" : "错误",
        l.outcome
      )}</td>
      <td>${l.rows_written}</td>
      <td>${l.retry_after ?? "-"}</td>
      <td>${l.detail || "-"}</td>
    </tr>`).join("") || `<tr><td colspan="11" style="text-align:center;color:#6b7280">暂无请求日志</td></tr>`;
}

// ------------------------------------------------------------------ 事件绑定
$("btn-create").addEventListener("click", async () => {
  try {
    const r = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({
        venue_id: $("venue-select").value,
        date: $("date-input").value,
        trigger: "manual",
      }),
    });
    showMsg(r.merged
      ? `该场馆当天任务已存在，已合用同一次采集（任务 #${r.job.id}，状态：${r.job.status}）`
      : `已创建采集任务 #${r.job.id}`);
    await refreshState();
  } catch (e) {
    showMsg(e.message, false);
  }
});

$("btn-schedule").addEventListener("click", async () => {
  try {
    const r = await api("/api/schedules", {
      method: "POST",
      body: JSON.stringify({
        venue_id: $("venue-select").value,
        date: $("date-input").value,
        interval_seconds: Number($("interval-input").value),
      }),
    });
    showMsg(`已创建计划任务 #${r.schedule_id}，到期自动并入同场馆同日期的采集任务`);
    await refreshState();
  } catch (e) {
    showMsg(e.message, false);
  }
});

$("log-source-filter").addEventListener("change", (e) => {
  logFilter = e.target.value;
  loadLogs();
});
$("btn-refresh-logs").addEventListener("click", loadLogs);

// ------------------------------------------------------------------ 轮询
setInterval(() => {
  if ($("auto-refresh").checked) refreshState();
}, 1000);
setInterval(() => {
  if ($("auto-refresh").checked) refreshQuota();
}, 1000);
setInterval(loadLogs, 2000);

refreshState().then(refreshQuota).then(loadLogs);
