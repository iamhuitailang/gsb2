/* Single-page UI for the temperature batch service. Vanilla JS, no build. */

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json();
}

const fmt2 = (n) => (Math.round(n * 100) / 100).toFixed(2);

// ISO window label like 2024-01-01 10:05 UTC
const windowLabel = (isoStr) =>
  isoStr.replace("T", " ").replace(/:00\.000Z$/, " UTC");

const instantLabel = (isoStr) => isoStr.replace("T", " ").replace(/\.\d+Z$/, " UTC");

// datetime-local <-> ISO
const localInputToIso = (value) => {
  if (!value) return null;
  return new Date(value + "Z").toISOString();
};
const isoToLocalInput = (isoStr) => isoStr.slice(0, 16);

const WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- tabs ----
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${btn.dataset.tab}`)
    );
    if (btn.dataset.tab === "batches") loadBatches();
    if (btn.dataset.tab === "recompute") {
      loadDevices("rc-device-select");
      loadRecomputeJobs();
    }
  });
});

// ------------------------------------------------------------- modal ------
function openModal(title, node) {
  $("#modal-title").textContent = title;
  const body = $("#modal-body");
  body.innerHTML = "";
  body.appendChild(node);
  $("#modal-backdrop").classList.remove("hidden");
}
$("#modal-close").addEventListener("click", () => $("#modal-backdrop").classList.add("hidden"));
$("#modal-backdrop").addEventListener("click", (e) => {
  if (e.target.id === "modal-backdrop") $("#modal-backdrop").classList.add("hidden");
});

function kvTable(pairs) {
  const wrap = document.createElement("div");
  wrap.className = "kv";
  for (const [k, v] of pairs) {
    const b = document.createElement("b");
    b.textContent = k;
    const span = document.createElement("span");
    span.append(v);
    wrap.append(b, span);
  }
  return wrap;
}

// ------------------------------------------------- tab 1: device windows ---
async function loadDevices(selectId = "device-select") {
  const devices = await api("/api/devices");
  const select = document.getElementById(selectId);
  const previous = select.value;
  select.innerHTML = "";
  if (devices.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "（暂无设备，请先发送批次）";
    opt.value = "";
    select.append(opt);
    return;
  }
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    select.append(opt);
  }
  if (devices.includes(previous)) select.value = previous;
}

$("#device-select").addEventListener("change", loadWindows);
$("#btn-query").addEventListener("click", loadWindows);
$("#btn-clear-range").addEventListener("click", () => {
  $("#range-start").value = "";
  $("#range-end").value = "";
  loadWindows();
});

// Fill the gaps between stored window rows so empty windows render "no data".
function fillEmptyWindows(rows) {
  if (rows.length < 2) return rows.map((r) => ({ ...r, _empty: false }));
  const filled = [];
  for (let i = 0; i < rows.length; i++) {
    filled.push({ ...rows[i], _empty: false });
    if (i === rows.length - 1) break;
    let t = new Date(rows[i].window_start).getTime() + WINDOW_MS;
    const nextT = new Date(rows[i + 1].window_start).getTime();
    while (t < nextT) {
      filled.push({
        window_start: new Date(t).toISOString(),
        _empty: true,
      });
      t += WINDOW_MS;
    }
  }
  return filled;
}

async function loadWindows() {
  const device = $("#device-select").value;
  const tbody = $("#window-table tbody");
  tbody.innerHTML = "";
  $("#window-meta").textContent = "";
  if (!device) return;

  const params = new URLSearchParams();
  const start = localInputToIso($("#range-start").value);
  const end = localInputToIso($("#range-end").value);
  if (start) params.set("start", start);
  if (end) params.set("end", end);

  const rows = fillEmptyWindows(await api(`/api/devices/${encodeURIComponent(device)}/windows?${params}`));
  if (rows.length === 0) {
    $("#window-meta").textContent = "该设备在此范围内没有任何窗口（无数据）。";
    return;
  }
  $("#window-meta").textContent = `共 ${rows.length} 个五分钟窗口（含空窗口）。`;

  for (const row of rows) {
    const tr = document.createElement("tr");
    if (!row._empty) tr.classList.add("clickable");
    tr.innerHTML = row._empty
      ? `<td>${windowLabel(row.window_start)}</td><td colspan="4" class="empty-row">无数据</td>`
      : `<td>${windowLabel(row.window_start)}</td>
         <td class="num">${row.count}</td>
         <td class="num">${fmt2(row.min_temp)}</td>
         <td class="num">${fmt2(row.max_temp)}</td>
         <td class="num">${fmt2(row.avg_temp)}</td>`;
    if (!row._empty) {
      tr.addEventListener("click", () => openWindowReadings(device, row.window_start));
    }
    tbody.append(tr);
  }
}

async function openWindowReadings(device, windowStart) {
  const data = await api(
    `/api/devices/${encodeURIComponent(device)}/readings?window_start=${encodeURIComponent(windowStart)}`
  );
  const wrap = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = `参与 ${windowLabel(windowStart)} 统计的当前读数（每个读数编号只取最新版本），共 ${data.readings.length} 条：`;
  wrap.append(p);

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>读数编号</th><th>版本</th><th>测量时间（UTC）</th><th>温度</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const r of data.readings) {
    const tr = document.createElement("tr");
    tr.classList.add("clickable");
    tr.innerHTML = `<td>${r.reading_id}</td><td class="num">v${r.version}</td>
                    <td>${instantLabel(r.measured_at)}</td><td class="num">${fmt2(r.temperature)}</td>`;
    tr.addEventListener("click", () => openReadingHistory(device, r.reading_id));
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  openModal(`${device} · ${windowLabel(windowStart)} · 参与计算的读数`, wrap);
}

async function openReadingHistory(device, readingId) {
  const data = await api(
    `/api/readings/${encodeURIComponent(device)}/${encodeURIComponent(readingId)}/history`
  );
  const wrap = document.createElement("div");
  if (data.current) {
    wrap.append(
      kvTable([
        ["当前生效版本", `v${data.current.version}`],
        ["当前温度", `${fmt2(data.current.temperature)}`],
        ["当前测量时间", instantLabel(data.current.measured_at)],
        ["所属窗口", windowLabel(data.current.window_start)],
      ])
    );
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>版本</th><th>测量时间（原始 / UTC）</th><th>温度</th>
    <th>收到时间（UTC）</th><th>入批时判定</th><th>状态</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const v of data.versions) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="num">v${v.version}</td>
      <td><div>${v.measured_at_raw}</div><div class="hint">${instantLabel(v.measured_at)}</div></td>
      <td class="num">${fmt2(v.temperature)}</td>
      <td>${instantLabel(v.received_at)}</td>
      <td><span class="badge ${v.classification}">${v.classification}</span></td>
      <td>${v.is_current ? "当前生效" : "历史版本"}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  openModal(`${device} · 读数 ${readingId} · 历史版本`, wrap);
}

// ------------------------------------------------------------- tab 2 ------
let SAMPLE_FILES = [];

async function loadSampleSelect() {
  SAMPLE_FILES = await api("/api/samples");
  const select = $("#sample-select");
  select.innerHTML = "";
  for (const f of SAMPLE_FILES) {
    const opt = document.createElement("option");
    opt.value = f;
    opt.textContent = f;
    select.append(opt);
  }
}

$("#btn-send-sample").addEventListener("click", async () => {
  const file = $("#sample-select").value;
  await sendBatchFile(file);
});

$("#btn-send-all").addEventListener("click", async () => {
  for (const file of SAMPLE_FILES) {
    await sendBatchFile(file, true);
  }
});

$("#btn-refresh-batches").addEventListener("click", loadBatches);

$("#btn-reset").addEventListener("click", async () => {
  if (!confirm("确认清空全部批次、读数和汇总？")) return;
  await api("/api/admin/reset", { method: "POST" });
  $("#batch-result").classList.add("hidden");
  $("#batch-detail").classList.add("hidden");
  await loadBatches();
  await loadDevices();
});

async function sendBatchFile(file, quiet = false) {
  const payload = await api(`/api/samples/${encodeURIComponent(file)}`);
  try {
    const result = await api("/api/batches", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!quiet) renderBatchResult(file, payload, result);
  } catch (err) {
    alert(`发送 ${file} 失败：${err.message}`);
    throw err;
  }
  await loadBatches();
  await loadDevices();
}

function renderBatchResult(file, payload, result) {
  const box = $("#batch-result");
  box.classList.remove("hidden");
  const c = result.counts;
  box.innerHTML = "";
  box.append(
    kvTable([
      ["样例文件", file],
      ["批次编号", `#${result.batch_id}`],
      ["收到时间", instantLabel(result.received_at)],
      [
        "分类计数",
        ["new", "correction", "duplicate", "stale", "conflict", "invalid"]
          .map((k) => `<span class="badge ${k}">${k}: ${c[k] || 0}</span>`)
          .join(" "),
      ],
    ])
  );
  if (result.conflicts.length) {
    const h = document.createElement("h4");
    h.textContent = "冲突明细（保留已接收版本，未存储冲突内容）";
    box.append(h);
    for (const conf of result.conflicts) {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(conf, null, 2);
      box.append(pre);
    }
  }
}

async function loadBatches() {
  const batches = await api("/api/batches");
  const tbody = $("#batch-table tbody");
  tbody.innerHTML = "";
  for (const b of batches) {
    const c = b.counts;
    const tr = document.createElement("tr");
    tr.classList.add("clickable");
    tr.innerHTML = `<td>#${b.id}</td><td>${instantLabel(b.received_at)}</td>
      <td>${b.note || ""}</td>
      <td class="num">${c.new || 0}</td><td class="num">${c.correction || 0}</td>
      <td class="num">${c.duplicate || 0}</td><td class="num">${c.stale || 0}</td>
      <td class="num">${c.conflict || 0}</td><td class="num">${c.invalid || 0}</td>`;
    tr.addEventListener("click", () => openBatchDetail(b.id));
    tbody.append(tr);
  }
}

async function openBatchDetail(batchId) {
  const b = await api(`/api/batches/${batchId}`);
  const box = $("#batch-detail");
  box.classList.remove("hidden");
  box.innerHTML = "";
  box.append(kvTable([["批次", `#${b.id}`], ["收到时间", instantLabel(b.received_at)], ["备注", b.note || ""]]));

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>设备</th><th>读数编号</th><th>版本</th><th>判定</th><th>详情</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const item of b.items) {
    const tr = document.createElement("tr");
    let detail = "";
    if (item.classification === "conflict") {
      const d = item.detail;
      detail = `<div class="diff-old">已接收: v${d.existing.version} · ${instantLabel(d.existing.measured_at)} · ${fmt2(d.existing.temperature)}℃</div>
                <div class="diff-new">被拒绝: v${d.incoming.version} · ${instantLabel(d.incoming.measured_at)} · ${fmt2(d.incoming.temperature)}℃</div>`;
    } else if (item.classification === "invalid") {
      detail = item.detail || "";
    }
    tr.innerHTML = `<td>${item.device_id}</td><td>${item.reading_id}</td>
      <td class="num">v${item.version}</td>
      <td><span class="badge ${item.classification}">${item.classification}</span></td>
      <td>${detail}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  box.scrollIntoView({ behavior: "smooth" });
}

// ------------------------------------------------------------- tab 3 ------
$("#btn-recompute").addEventListener("click", async () => {
  const device = $("#rc-device-select").value;
  const start = localInputToIso($("#rc-start").value);
  const end = localInputToIso($("#rc-end").value);
  if (!device || !start || !end) {
    alert("请选择设备并填写起止时间");
    return;
  }
  try {
    const job = await api("/api/recompute", {
      method: "POST",
      body: JSON.stringify({ device_id: device, start, end }),
    });
    renderRecomputeResult(job);
    await loadRecomputeJobs();
    loadWindows();
  } catch (err) {
    alert(`补算失败：${err.message}`);
  }
});

function renderRecomputeResult(job) {
  const box = $("#rc-result");
  box.classList.remove("hidden");
  box.innerHTML = "";
  box.append(
    kvTable([
      ["任务编号", `#${job.job_id}`],
      ["设备", job.device_id],
      ["范围", `${windowLabel(job.range_start)} ~ ${instantLabel(job.range_end)}（不含）`],
      ["覆盖窗口数", String(job.covered_windows.length)],
      ["有改动的窗口数", String(job.changes.length)],
    ])
  );
  if (job.changes.length === 0) {
    const p = document.createElement("p");
    p.textContent = "覆盖窗口的汇总与按原始版本重算的结果一致，没有改动。";
    box.append(p);
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>窗口（UTC）</th><th>改动类型</th><th>改动前</th><th>改动后</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const aggText = (a) =>
    a ? `条数 ${a.count} · 最低 ${fmt2(a.min_temp)} · 最高 ${fmt2(a.max_temp)} · 平均 ${fmt2(a.avg_temp)}` : "无数据";
  for (const ch of job.changes) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${windowLabel(ch.window_start)}</td><td><span class="badge correction">${ch.change_type}</span></td>
      <td>${aggText(ch.before)}</td><td>${aggText(ch.after)}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
}

async function loadRecomputeJobs() {
  const jobs = await api("/api/recompute");
  const tbody = $("#rc-table tbody");
  tbody.innerHTML = "";
  for (const j of jobs) {
    const tr = document.createElement("tr");
    tr.classList.add("clickable");
    tr.innerHTML = `<td>#${j.id}</td><td>${j.device_id}</td>
      <td>${windowLabel(j.window_start)} ~ ${instantLabel(j.window_end)}</td>
      <td>${j.status}</td><td>${instantLabel(j.started_at)}</td>
      <td>${j.finished_at ? instantLabel(j.finished_at) : "-"}</td>
      <td class="num">${j.changes.length}</td>`;
    tr.addEventListener("click", () => openRecomputeDetail(j.id));
    tbody.append(tr);
  }
}

async function openRecomputeDetail(jobId) {
  const j = await api(`/api/recompute/${jobId}`);
  const box = $("#rc-detail");
  box.classList.remove("hidden");
  box.innerHTML = "";
  box.append(
    kvTable([
      ["任务", `#${j.id}`],
      ["设备", j.device_id],
      ["覆盖范围", `${windowLabel(j.window_start)} ~ ${instantLabel(j.window_end)}（不含）`],
      ["状态", j.status],
    ])
  );
  const ul = document.createElement("ul");
  for (const ch of j.changes) {
    const li = document.createElement("li");
    let before;
    let after;
    try {
      before = ch.before_json ? JSON.parse(ch.before_json) : null;
      after = ch.after_json ? JSON.parse(ch.after_json) : null;
    } catch {
      before = ch.before_json;
      after = ch.after_json;
    }
    const fmt = (a) =>
      a ? `n=${a.count}, min=${fmt2(a.min_temp)}, max=${fmt2(a.max_temp)}, avg=${fmt2(a.avg_temp)}` : "无数据";
    li.innerHTML = `<b>${windowLabel(ch.window_start)}</b> [${ch.change_type}]
      <div class="diff-old">before: ${fmt(before)}</div>
      <div class="diff-new">after: ${fmt(after)}</div>`;
    ul.append(li);
  }
  if (j.changes.length === 0) {
    const p = document.createElement("p");
    p.textContent = "本次补算覆盖的窗口均无改动。";
    box.append(p);
  } else {
    box.append(ul);
  }
  box.scrollIntoView({ behavior: "smooth" });
}

// ---------------------------------------------------------------- init ----
(async function init() {
  await loadSampleSelect();
  await loadDevices();
  await loadWindows();
  await loadBatches();
})();
