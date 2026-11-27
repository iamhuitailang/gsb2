const CATEGORY_LABEL = {
  high: "高度相似",
  uncertain: "证据不足",
  different: "明显不同",
};

let state = null;
let report = null;
let currentFilter = "all";
let searchQuery = "";
let showRemoved = false;
let visibleItems = [];
let historyItems = [];
const peaksCache = new Map();
let toastTimer = null;

const $ = (selector) => document.querySelector(selector);
const resultsEl = $("#results");
const historyEl = $("#historyList");
const fileListEl = $("#fileList");

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: options.body && !(options.body instanceof File) ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function toast(message, type = "") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${type}`;
  clearTimeout(toastTimer);
  if (message) toastTimer = setTimeout(() => (el.textContent = ""), 5000);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function formatTime(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return "—";
  if (n < 60) return `${n.toFixed(2)}s`;
  const m = Math.floor(n / 60);
  const s = (n - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function formatDuration(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return "时长未知";
  return formatTime(n);
}

function formatSampleRate(hz) {
  if (!hz) return "采样率未知";
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz` : `${hz} Hz`;
}

function formatChannels(n) {
  if (!n) return "声道未知";
  if (n === 1) return "单声道";
  if (n === 2) return "立体声";
  return `${n} 声道`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fileMeta(file) {
  const m = file.metadata || {};
  return [
    formatSampleRate(m.sample_rate),
    formatChannels(m.channels),
    formatDuration(m.duration),
    file.size ? formatSize(file.size) : "",
  ].filter(Boolean).join(" · ");
}

async function refreshState() {
  state = await api("/api/state");
  report = state.last_report;
  renderAll();
}

function renderAll() {
  renderStats();
  renderLibrary();
  renderParams();
  renderResults();
  renderHistory();
}

function renderParams() {
  const params = state?.params || report?.params || {};
  if (document.activeElement !== $("#highThreshold")) $("#highThreshold").value = params.high_similarity ?? 0.8;
  if (document.activeElement !== $("#uncertainThreshold")) $("#uncertainThreshold").value = params.uncertain_similarity ?? 0.64;
}

function renderStats() {
  const counts = report?.counts || { high: 0, uncertain: 0, different: 0, false_positive: 0, confirmed: 0 };
  const stats = [
    { label: "可分析文件", value: state?.readable_count ?? 0, cls: "" },
    { label: "高度相似", value: counts.high || 0, cls: "high" },
    { label: "证据不足", value: counts.uncertain || 0, cls: "uncertain" },
    { label: "明显不同", value: counts.different || 0, cls: "different" },
    { label: "人工误判", value: counts.false_positive || 0, cls: "false" },
  ];
  $("#stats").innerHTML = stats.map((s) => `
    <div class="stat-tile ${s.cls}">
      <div class="stat-label">${s.label}</div>
      <div class="stat-value">${s.value}</div>
    </div>`).join("");

  document.querySelectorAll(".tab [data-count]").forEach((el) => {
    const key = el.dataset.count;
    el.textContent = counts[key] ?? (key === "all" ? report?.items?.length || 0 : 0);
  });
}

function fileCard(file, removed = false) {
  return `
    <div class="file-card ${file.error ? "error" : ""}">
      <div class="file-title">
        <span class="file-name" title="${esc(file.path || file.name)}">${esc(file.name)}</span>
        <span class="file-actions">
          ${file.error && !removed ? `<button class="icon-btn" title="重新读取" data-file-action="retry" data-id="${esc(file.id)}">↻</button>` : ""}
          ${removed
            ? `<button class="icon-btn" title="恢复" data-file-action="restore" data-id="${esc(file.id)}">↺</button>
               <button class="icon-btn" title="彻底删除记录" data-file-action="purge" data-id="${esc(file.id)}">⌫</button>`
            : `<button class="icon-btn" title="移出列表（保留判定）" data-file-action="remove" data-id="${esc(file.id)}">×</button>`}
        </span>
      </div>
      <div class="file-meta">${esc(file.error ? "无法解码" : fileMeta(file))}</div>
      ${file.error ? `<div class="error-text">${esc(file.error)}</div>` : `<div class="file-path">${esc(file.path || "")}</div>`}
    </div>`;
}

function renderLibrary() {
  const allActive = state?.files || [];
  const readableFiles = allActive.filter((f) => !f.error);
  fileListEl.innerHTML = readableFiles.length
    ? readableFiles.map((f) => fileCard(f)).join("")
    : `<p class="hint">尚未添加可分析文件。</p>`;

  const unreadable = allActive.filter((f) => f.error);
  $("#unreadableSection").hidden = unreadable.length === 0;
  $("#unreadableList").innerHTML = unreadable.map((f) => fileCard(f)).join("");

  const removed = state?.removed || [];
  $("#removedSection").hidden = !showRemoved || removed.length === 0;
  $("#removedList").innerHTML = removed.map((f) => fileCard(f, true)).join("");
}

function itemMatchesFilter(item) {
  const status = item.verdict?.status;
  if (currentFilter === "false_positive") return status === "false_positive";
  if (currentFilter === "confirmed") return status === "confirmed";
  if (["high", "uncertain", "different"].includes(currentFilter)) return item.category === currentFilter;
  return true;
}

function renderResults() {
  const items = report?.items || [];
  const q = searchQuery.trim().toLowerCase();
  visibleItems = items.filter((item) => {
    if (!itemMatchesFilter(item)) return false;
    if (!q) return true;
    return [item.file_a?.name, item.file_b?.name, item.file_a?.path, item.file_b?.path]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });

  $("#emptyState").style.display = items.length === 0 ? "block" : "none";
  if (!items.length) {
    resultsEl.innerHTML = "";
    $("#emptyState").querySelector("h2").textContent = state?.readable_count >= 2 ? "点击重新扫描开始比对" : "还没有可查看的相似结果";
    return;
  }

  if (!visibleItems.length) {
    resultsEl.innerHTML = `<div class="panel empty-state"><h2>当前筛选下没有结果</h2><p>切换分类或清空文件名筛选。</p></div>`;
    return;
  }

  resultsEl.innerHTML = visibleItems.map((item, idx) => resultCard(item, idx, "results")).join("");
  resultsEl.querySelectorAll("canvas.wave-canvas").forEach((canvas) => {
    drawWaveform(canvas).catch((err) => console.warn("waveform draw failed", err));
  });
}

function renderHistory() {
  const allHistory = report?.historical_verdicts || [];
  historyItems = ["false_positive", "confirmed"].includes(currentFilter)
    ? allHistory.filter((item) => item.verdict?.status === currentFilter)
    : allHistory;
  const panel = $("#historyPanel");
  panel.hidden = allHistory.length === 0;
  $("#historyCount").textContent = allHistory.length ? `（${allHistory.length} 条）` : "";
  if (!historyItems.length) {
    historyEl.innerHTML = currentFilter === "false_positive" || currentFilter === "confirmed"
      ? `<p class="hint">该筛选下没有历史判定。</p>`
      : "";
    return;
  }
  if (currentFilter === "false_positive" || currentFilter === "confirmed") {
    $("#historyDetails").open = true;
  }
  historyEl.innerHTML = historyItems.map((item, idx) => resultCard(item, idx, "history")).join("");
  historyEl.querySelectorAll("canvas.wave-canvas").forEach((canvas) => {
    drawWaveform(canvas).catch((err) => console.warn("history waveform draw failed", err));
  });
}

function verdictBadge(item) {
  const status = item.verdict?.status;
  if (status === "false_positive") return `<span class="badge false_positive">× 人工标记误判</span>`;
  if (status === "confirmed") return `<span class="badge confirmed">✓ 人工确认相似</span>`;
  return "";
}

function wavePanel(item, idx, side) {
  const file = item[`file_${side}`];
  const start = item[`${side}_start`];
  const end = item[`${side}_end`];
  const title = side === "a" ? "片段 A" : "片段 B";
  return `
    <div class="wave-panel" data-side-panel="${side}">
      <div class="wave-title">
        <span><strong>${title} · ${esc(file.name)}</strong></span>
        <span class="time-range">${formatTime(start)} – ${formatTime(end)}</span>
      </div>
      <canvas class="wave-canvas"
        data-file-id="${esc(file.id)}" data-side="${side}" data-idx="${idx}"
        data-start="${start}" data-end="${end}"
        data-duration="${file.metadata?.duration || 0}"
        data-category="${item.category}"></canvas>
      <div class="wave-controls">
        <button class="mini-btn" type="button" data-action="play-range" data-idx="${idx}" data-side="${side}">从对应位置试听</button>
        <button class="mini-btn" type="button" data-action="play-all" data-idx="${idx}" data-side="${side}">从头播放</button>
        <audio preload="none" controls src="/api/files/${encodeURIComponent(file.id)}/audio"></audio>
      </div>
    </div>`;
}

function resultCard(item, idx, scope = "results") {
  const category = item.category;
  const color = category === "high" ? "var(--good)" : category === "uncertain" ? "var(--warning)" : "var(--different)";
  const vStatus = item.verdict?.status || "";
  const verdictKey = item.verdict?.key || item.verdict_key;
  const note = esc(item.verdict?.note || "");
  const metrics = [
    ["频谱对齐", `${(item.similarity * 100).toFixed(1)}%`],
    ["依据时长", `${item.duration?.toFixed(2)}s`],
    ["对齐瞬态", `${item.aligned_events ?? 0} 个`],
    ["高信息量", `${item.info_seconds?.toFixed(2)}s`],
    ["强帧占比", `${Math.round((item.strong_ratio || 0) * 100)}%`],
  ];
  return `
    <article class="panel result-card ${category} ${vStatus ? `is-${vStatus}` : ""} ${item.historical ? "historical" : ""}" data-idx="${idx}" data-key="${esc(item.verdict_key)}" data-scope="${scope}">
      <div class="result-head">
        <span class="badge ${category}">${category === "high" ? "●" : category === "uncertain" ? "▲" : "○"} ${CATEGORY_LABEL[category]}</span>
        <div>
          <div class="result-title">${esc(item.file_a.name)}<span class="vs">↔</span>${esc(item.file_b.name)}</div>
          <div class="result-sub">
            <span>A：${formatTime(item.a_start)}–${formatTime(item.a_end)}</span>
            <span>B：${formatTime(item.b_start)}–${formatTime(item.b_end)}</span>
            <span>${item.file_a.metadata?.sample_rate ? formatSampleRate(item.file_a.metadata.sample_rate) : ""} / ${formatChannels(item.file_a.metadata?.channels)}</span>
          </div>
        </div>
        <div class="score-ring" style="--pct:${item.score};--score-color:${color}"><span>${item.score}</span></div>
      </div>
      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        ${verdictBadge(item)}
        ${item.historical ? '<span class="badge different">历史记录 / 有文件已移除</span>' : ""}
      </div>
      <div class="metrics">${metrics.map(([label, value]) => `<span class="metric">${label} <b>${value}</b></span>`).join("")}</div>
      <ul class="reasons">${(item.reasons || []).map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
      <div class="wave-grid">${wavePanel(item, idx, "a")}${wavePanel(item, idx, "b")}</div>
      <div class="verdict-row">
        <button class="btn small ${vStatus === "confirmed" ? "active-confirmed" : "secondary"}" data-action="verdict" data-status="confirmed" data-key="${esc(verdictKey)}">✓ 确认相似</button>
        <button class="btn small ${vStatus === "false_positive" ? "active-false" : "secondary danger"}" data-action="verdict" data-status="false_positive" data-key="${esc(verdictKey)}">× 标记误判</button>
        <button class="btn small ghost" data-action="verdict" data-status="reset" data-key="${esc(verdictKey)}">取消标记</button>
        <input type="text" placeholder="备注，例如：只是同音色 / 只有单音" value="${note}" data-note-input="${esc(verdictKey)}" />
        <button class="mini-btn" data-action="save-note" data-key="${esc(verdictKey)}">保存备注</button>
        <span class="verdict-current">判定保存在本机状态中，增删文件后仍会按对齐位置恢复。</span>
      </div>
    </article>`;
}

async function getPeaks(fileId) {
  if (!peaksCache.has(fileId)) {
    peaksCache.set(fileId, await api(`/api/files/${encodeURIComponent(fileId)}/peaks`));
  }
  return peaksCache.get(fileId);
}

function categoryColor(category, alpha = 1) {
  const colors = {
    high: [12, 163, 12],
    uncertain: [214, 151, 0],
    different: [137, 135, 129],
  };
  const [r, g, b] = colors[category] || colors.different;
  return `rgba(${r},${g},${b},${alpha})`;
}

async function drawWaveform(canvas) {
  const fileId = canvas.dataset.fileId;
  if (!fileId || !canvas.isConnected) return;
  const peaks = await getPeaks(fileId);
  if (!canvas.isConnected) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(260, rect.width);
  const height = rect.height || 92;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const mins = peaks.min || [];
  const maxs = peaks.max || [];
  const n = Math.min(mins.length, maxs.length);
  if (!n) return;
  const duration = Number(canvas.dataset.duration) || n * (peaks.bucket_seconds || 0.01);
  const xFor = (t) => Math.max(0, Math.min(width, (t / Math.max(duration, 0.001)) * width));
  const yFor = (v) => height / 2 - v * (height * 0.42);

  const start = Number(canvas.dataset.start);
  const end = Number(canvas.dataset.end);
  const xs = xFor(start);
  const xe = xFor(end);
  ctx.fillStyle = categoryColor(canvas.dataset.category, 0.16);
  ctx.fillRect(xs, 0, Math.max(2, xe - xs), height);
  ctx.strokeStyle = categoryColor(canvas.dataset.category, 0.75);
  ctx.lineWidth = 1;
  for (const x of [xs, xe]) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(n - 1, 1)) * width;
    const y = yFor(maxs[i]);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    const x = (i / Math.max(n - 1, 1)) * width;
    ctx.lineTo(x, yFor(mins[i]));
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(42, 120, 214, 0.34)";
  ctx.fill();

  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / Math.max(n - 1, 1)) * width;
    const rms = peaks.rms?.[i] || 0;
    const y = yFor(rms);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "rgba(42, 120, 214, 0.72)";
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const panel = canvas.closest(".wave-panel");
  const audio = panel?.querySelector("audio");
  if (audio && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
    const x = xFor(audio.currentTime);
    ctx.strokeStyle = "var(--text)";
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--text") || "#0b0b0b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function getCardElements(target) {
  const card = target.closest(".result-card");
  if (!card) return {};
  const idx = Number(card.dataset.idx);
  const item = visibleItems[idx];
  return { card, idx, item };
}

function seekAndPlay(audio, time, stopAt) {
  audio.dataset.stopAt = Number.isFinite(stopAt) ? String(stopAt) : "";
  const start = () => {
    try {
      audio.currentTime = time;
    } catch (_) {
      // Some browsers only allow seeking after metadata; the loadedmetadata path handles that.
    }
    audio.play().catch((err) => toast(`浏览器阻止播放：${err.message}`, "error"));
  };
  if (audio.readyState >= 1) {
    start();
  } else {
    audio.addEventListener("loadedmetadata", start, { once: true });
    audio.load();
  }
}

function playSide(item, idx, side, onlyRange, scope = "results") {
  const root = scope === "history" ? historyEl : resultsEl;
  const card = root.querySelector(`.result-card[data-idx="${idx}"]`);
  const panel = card?.querySelector(`[data-side-panel="${side}"]`);
  const audio = panel?.querySelector("audio");
  if (!audio || !item) return;
  const rangeStart = Number(item[`${side}_start`]);
  const rangeEnd = Number(item[`${side}_end`]);
  if (onlyRange) {
    seekAndPlay(audio, rangeStart, rangeEnd);
  } else {
    seekAndPlay(audio, 0, null);
  }
}

async function runScan() {
  $("#scanBtn").disabled = true;
  resultsEl.innerHTML = `<div class="panel loading">正在对齐频谱、起音点和时间范围…</div>`;
  try {
    const high = parseFloat($("#highThreshold").value);
    const uncertain = parseFloat($("#uncertainThreshold").value);
    const params = {};
    if (Number.isFinite(high)) params.high_similarity = high;
    if (Number.isFinite(uncertain)) params.uncertain_similarity = uncertain;
    await api("/api/analyze", { method: "POST", body: JSON.stringify({ params }) });
    await refreshState();
    toast("扫描完成，判定已合并", "success");
  } catch (err) {
    toast(err.message, "error");
    await refreshState();
  } finally {
    $("#scanBtn").disabled = false;
  }
}

async function uploadPickedFiles(files) {
  if (!files.length) return;
  $("#pickBtn").disabled = true;
  try {
    let duplicateCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      toast(`正在上传/建立索引 ${i + 1}/${files.length}：${file.name}`);
      const res = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `上传失败：${file.name}`);
      if (data.duplicate) duplicateCount += 1;
    }
    toast(`处理完成：${files.length - duplicateCount} 个新索引，${duplicateCount} 个重复文件未重复建索引，开始扫描…`, "success");
    await runScan();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#pickBtn").disabled = false;
    $("#fileInput").value = "";
  }
}

async function addPaths() {
  const raw = $("#pathInput").value;
  const paths = raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (!paths.length) return toast("请先填写至少一个绝对路径", "error");
  $("#pathBtn").disabled = true;
  try {
    const result = await api("/api/paths", { method: "POST", body: JSON.stringify({ paths }) });
    $("#pathInput").value = "";
    const errorCount = result.errors?.length || 0;
    toast(`添加完成：新增 ${result.added?.length || 0}，重复 ${result.duplicates?.length || 0}，不可读 ${errorCount}`, errorCount ? "error" : "success");
    await runScan();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#pathBtn").disabled = false;
  }
}

async function fileAction(action, id) {
  try {
    if (action === "remove") {
      await api(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast("已移出当前音频库；历史判定保留", "success");
    } else if (action === "restore") {
      await api(`/api/files/${encodeURIComponent(id)}/restore`, { method: "POST" });
      toast("已恢复", "success");
    } else if (action === "retry") {
      const record = await api(`/api/files/${encodeURIComponent(id)}/retry`, { method: "POST" });
      toast(record.error ? `仍无法读取：${record.error}` : "文件已可读取", record.error ? "error" : "success");
    } else if (action === "purge") {
      if (!window.confirm("彻底删除该记录？上传到本机状态目录的副本也会被删除；原始路径文件不会被删除。")) return;
      await api(`/api/files/${encodeURIComponent(id)}?purge=1`, { method: "DELETE" });
      toast("已彻底删除", "success");
    }
    await runScan();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function verdictAction(key, status) {
  try {
    await api("/api/verdicts", { method: "POST", body: JSON.stringify({ key, status }) });
    await refreshState();
    toast(status === "reset" ? "已取消人工标记" : "判定已持久保存", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function saveNote(key) {
  const input = document.querySelector(`input[data-note-input="${CSS.escape(key)}"]`);
  const current = report?.items?.find((i) => i.verdict_key === key)?.verdict?.status
    || report?.historical_verdicts?.find((i) => i.verdict_key === key)?.verdict?.status;
  if (!current) return toast("请先点击“确认相似”或“标记误判”，再保存备注", "error");
  try {
    await api("/api/verdicts", { method: "POST", body: JSON.stringify({ key, status: current, note: input?.value || "" }) });
    await refreshState();
    toast("备注已保存", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

// Static top-level bindings.
$("#pickBtn").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (e) => uploadPickedFiles(Array.from(e.target.files || [])));
$("#pathBtn").addEventListener("click", addPaths);
$("#sampleBtn").addEventListener("click", async () => {
  $("#sampleBtn").disabled = true;
  try {
    const result = await api("/api/samples", { method: "POST" });
    toast(`示例已生成：新增 ${result.added?.length || 0}，重复 ${result.duplicates?.length || 0}`, "success");
    await runScan();
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("#sampleBtn").disabled = false;
  }
});
$("#scanBtn").addEventListener("click", runScan);
$("#applyParamsBtn").addEventListener("click", runScan);
$("#searchInput").addEventListener("input", (e) => {
  searchQuery = e.target.value;
  renderResults();
});
$("#showRemoved").addEventListener("change", (e) => {
  showRemoved = e.target.checked;
  renderLibrary();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentFilter = tab.dataset.filter;
    renderResults();
    renderHistory();
  });
});

// The aside is the common parent of active, unreadable and removed lists.
fileListEl.closest(".library").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-file-action]");
  if (btn) fileAction(btn.dataset.fileAction, btn.dataset.id);
});

async function handleCardClick(e, scope) {
  const root = scope === "history" ? historyEl : resultsEl;
  const items = scope === "history" ? historyItems : visibleItems;
  const actionBtn = e.target.closest("[data-action]");
  if (actionBtn && root.contains(actionBtn)) {
    const idx = Number(actionBtn.dataset.idx);
    const item = items[idx];
    if (actionBtn.dataset.action === "play-range") return playSide(item, idx, actionBtn.dataset.side, true, scope);
    if (actionBtn.dataset.action === "play-all") return playSide(item, idx, actionBtn.dataset.side, false, scope);
    if (actionBtn.dataset.action === "verdict") return verdictAction(actionBtn.dataset.key, actionBtn.dataset.status);
    if (actionBtn.dataset.action === "save-note") return saveNote(actionBtn.dataset.key);
  }

  if (e.target.matches("canvas.wave-canvas") && root.contains(e.target)) {
    const canvas = e.target;
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const duration = Number(canvas.dataset.duration);
    if (!duration) return;
    const idx = Number(canvas.dataset.idx);
    const item = items[idx];
    const audio = canvas.closest(".wave-panel")?.querySelector("audio");
    if (!audio || !item) return;
    const clickTime = ratio * duration;
    const start = Number(canvas.dataset.start);
    const end = Number(canvas.dataset.end);
    const stopAt = clickTime >= start && clickTime <= end ? end : null;
    seekAndPlay(audio, clickTime, stopAt);
  }
}

resultsEl.addEventListener("click", (e) => handleCardClick(e, "results"));
historyEl.addEventListener("click", (e) => handleCardClick(e, "history"));

document.addEventListener("timeupdate", (e) => {
  const audio = e.target;
  if (!(audio instanceof HTMLAudioElement)) return;
  const stopAt = Number(audio.dataset.stopAt);
  if (Number.isFinite(stopAt) && stopAt > 0 && audio.currentTime >= stopAt) {
    audio.pause();
    audio.dataset.stopAt = "";
  }
  const canvas = audio.closest(".wave-panel")?.querySelector("canvas.wave-canvas");
  if (canvas) drawWaveform(canvas);
}, true);

$("#historyDetails").addEventListener("toggle", (e) => {
  if (!e.target.open) return;
  requestAnimationFrame(() => {
    historyEl.querySelectorAll("canvas.wave-canvas").forEach((c) => drawWaveform(c));
  });
});

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    document.querySelectorAll(".result-card canvas.wave-canvas").forEach((c) => drawWaveform(c));
  }, 150);
});

refreshState().catch((err) => {
  toast(`初始化失败：${err.message}`, "error");
  $("#emptyState").style.display = "block";
});
