/* 停车记录配对处理台前端，原生 JS，无构建依赖。 */

const $ = (sel) => document.querySelector(sel);

const api = {
  async get(path) {
    const res = await fetch(path);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  },
};

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const fmtDuration = (sec) => {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  if (h) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
};

const typeTag = (t) =>
  t === "entry"
    ? '<span class="tag tag-entry">进场</span>'
    : '<span class="tag tag-exit">出场</span>';

let currentEventId = null;

/* ------------------------------ Tab 切换 ------------------------------ */
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
    refreshAll();
  });
});

/* ------------------------------ 提示 ------------------------------ */
let toastTimer = null;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

/* ------------------------------ 导入 ------------------------------ */
$("#file-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  const out = $("#import-results");
  for (const file of files) {
    try {
      const content = await file.text();
      const r = await api.post("/api/import", { filename: file.name, content });
      out.innerHTML =
        `<div class="trail-item">✅ 导入 <b>${esc(r.filename)}</b>：` +
        `共 ${r.total_rows} 行，新增 ${r.inserted} 条，` +
        `重复跳过 ${r.duplicates} 条，已自动重算配对。</div>` + out.innerHTML;
    } catch (err) {
      out.innerHTML =
        `<div class="trail-item">❌ <b>${esc(file.name)}</b>：${esc(err.message)}</div>` +
        out.innerHTML;
      toast(err.message, true);
    }
  }
  e.target.value = "";
  loadBatches();
  refreshAll();
});

async function loadBatches() {
  const rows = await api.get("/api/batches");
  $("#batches-body").innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${r.id}</td><td>${esc(r.filename)}</td><td>${esc(r.imported_at)}</td>` +
        `<td>${r.total_rows}</td><td>${r.inserted}</td><td>${r.duplicates}</td></tr>`
    )
    .join("");
}

/* ------------------------------ 停车记录 ------------------------------ */
async function loadPairs() {
  const plate = $("#pairs-filter-plate").value.trim();
  const lot = $("#pairs-filter-lot").value.trim();
  const qs = new URLSearchParams();
  if (plate) qs.set("plate", plate);
  if (lot) qs.set("lot", lot);
  const rows = await api.get(`/api/pairs?${qs}`);
  $("#pairs-body").innerHTML = rows
    .map((r) => {
      const plateCell =
        r.exit_raw_plate !== r.plate || r.entry_raw_plate !== r.plate
          ? `${esc(r.plate)} <span class="tag tag-changed">含更正</span>`
          : esc(r.plate);
      return `<tr>
        <td>${esc(r.lot)}</td><td>${plateCell}</td>
        <td class="mono">${esc(r.entry_time)}</td>
        <td class="mono">${esc(r.entry_gate)} / ${r.entry_seq}</td>
        <td class="mono">${esc(r.exit_time)}</td>
        <td class="mono">${esc(r.exit_gate)} / ${r.exit_seq}</td>
        <td><b>${fmtDuration(r.duration_seconds)}</b>（${r.duration_seconds} 秒）</td>
      </tr>`;
    })
    .join("");
}

/* ------------------------------ 未配对 ------------------------------ */
async function loadUnpaired() {
  const plate = $("#unpaired-filter-plate").value.trim();
  const lot = $("#unpaired-filter-lot").value.trim();
  const qs = new URLSearchParams();
  if (plate) qs.set("plate", plate);
  if (lot) qs.set("lot", lot);
  const rows = await api.get(`/api/unpaired?${qs}`);
  $("#unpaired-body").innerHTML = rows
    .map(
      (r) => `<tr class="clickable" onclick="openEvent(${r.id})">
        <td>${esc(r.lot)}</td>
        <td>${esc(r.effective_plate)}${
          r.effective_plate !== r.raw_plate
            ? ' <span class="tag tag-changed">已更正</span>'
            : ""
        }</td>
        <td>${typeTag(r.event_type)}</td>
        <td class="mono">${esc(r.event_time)}</td>
        <td class="mono">${esc(r.gate)} / ${r.seq}</td>
        <td>${esc(r.source_file)}</td>
        <td>${
          r.trail.length
            ? `曾在 ${r.trail.length} 次重算中配对（点击查看）`
            : '<span class="muted">从未配对</span>'
        }</td>
      </tr>`
    )
    .join("");
}

/* ------------------------------ 事件总表 ------------------------------ */
async function loadEvents() {
  const plate = $("#events-filter-plate").value.trim();
  const lot = $("#events-filter-lot").value.trim();
  const qs = new URLSearchParams();
  if (plate) qs.set("plate", plate);
  if (lot) qs.set("lot", lot);
  const rows = await api.get(`/api/events?${qs}`);
  $("#events-body").innerHTML = rows
    .map(
      (r) => `<tr>
        <td>${esc(r.lot)}</td>
        <td class="mono">${esc(r.gate)}</td>
        <td class="mono">${r.seq}</td>
        <td class="mono">${esc(r.raw_plate)}</td>
        <td class="mono">${esc(r.effective_plate)}${
          r.effective_plate !== r.raw_plate
            ? ' <span class="tag tag-changed">已更正</span>'
            : ""
        }</td>
        <td>${typeTag(r.event_type)}</td>
        <td class="mono">${esc(r.event_time)}</td>
        <td>${esc(r.source_file)}</td>
        <td><button onclick="openEvent(${r.id})">详情 / 更正</button></td>
      </tr>`
    )
    .join("");
}

/* ------------------------------ 每日统计 ------------------------------ */
async function loadStats() {
  const rows = await api.get("/api/stats");
  $("#stats-body").innerHTML = rows
    .map(
      (r) => `<tr><td>${esc(r.exit_date)}</td><td>${esc(r.lot)}</td>` +
        `<td>${r.exit_count}</td><td>${r.avg_duration_minutes}</td></tr>`
    )
    .join("");
}

/* ------------------------------ 事件详情弹窗 ------------------------------ */
async function openEvent(eventId) {
  currentEventId = eventId;
  const r = await api.get(`/api/events/${eventId}`);
  $("#correct-plate").value = r.effective_plate;
  $("#correct-reason").value = "";

  const corrections = r.corrections
    .map(
      (c) => `<div class="correction-item">
        <b>${esc(c.created_at)}</b>：${esc(c.old_plate)} → <b>${esc(c.new_plate)}</b>
        ${c.reason ? `<div class="muted">原因：${esc(c.reason)}</div>` : ""}
      </div>`
    )
    .join("") || '<p class="muted">无更正记录</p>';

  const trail = r.trail
    .map((t) => {
      const p = t.partner;
      return `<div class="trail-item">
        重算批次 #${t.run_id}（${esc(t.run_reason)}，${esc(t.run_at)}）：
        作为${t.role === "entry" ? "进场" : "出场"}与
        ${p.event_type === "entry" ? "进场" : "出场"}事件
        <b class="mono">${esc(p.gate)} / ${p.seq}</b>
        （${esc(p.event_time)}）配对
      </div>`;
    })
    .join("") || '<p class="muted">该事件从未参与过配对</p>';

  $("#modal-body").innerHTML = `
    <dl class="kv">
      <dt>事件 ID</dt><dd class="mono">${r.id}</dd>
      <dt>停车场</dt><dd>${esc(r.lot)}</dd>
      <dt>闸机号 / 流水号</dt><dd class="mono">${esc(r.gate)} / ${r.seq}</dd>
      <dt>事件类型</dt><dd>${typeTag(r.event_type)}</dd>
      <dt>事件时间</dt><dd class="mono">${esc(r.event_time)}</dd>
      <dt>原始导入车牌</dt><dd class="mono">${esc(r.raw_plate)}</dd>
      <dt>当前生效车牌</dt><dd class="mono"><b>${esc(r.effective_plate)}</b></dd>
      <dt>来源文件</dt><dd>${esc(r.source_file)}（批次 #${r.import_batch_id}，${esc(r.imported_at)}）</dd>
    </dl>
    <h4>更正历史（原始导入内容保留）</h4>
    ${corrections}
    <h4>配对轨迹</h4>
    ${trail}`;
  $("#modal-mask").classList.remove("hidden");
}

function closeModal() {
  $("#modal-mask").classList.add("hidden");
  currentEventId = null;
}

async function submitCorrection() {
  if (!currentEventId) return;
  const newPlate = $("#correct-plate").value.trim();
  const reason = $("#correct-reason").value.trim();
  if (!newPlate) return toast("请输入新车牌", true);
  try {
    await api.post(`/api/events/${currentEventId}/correct`, {
      new_plate: newPlate,
      reason: reason || null,
    });
    toast("更正成功，受影响车牌的配对已重新计算");
    closeModal();
    refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
}

$("#modal-mask").addEventListener("click", (e) => {
  if (e.target.id === "modal-mask") closeModal();
});

/* ------------------------------ 初始化 ------------------------------ */
function refreshAll() {
  loadBatches();
  loadPairs();
  loadUnpaired();
  loadEvents();
  loadStats();
}
refreshAll();
