/* Local HDR tool — frontend logic (vanilla JS, no build step). */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  sessionId: null,
  images: new Map(),          // image_id -> info
  selected: new Set(),        // image ids checked in library
  groups: new Map(),          // group_id -> group payload
  currentGroup: null,
  mode: "view",
  draft: [],                  // in-progress polygon, normalized points
  marks: [],                  // mark objects for current group
  fused: false,
  tonemapTimer: null,
  baseFrameUrl: null,         // image currently drawn on canvas
};

const MARK_COLORS = ["#ff4040", "#4080ff", "#40d070", "#d040d0", "#d0c040"];

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const body = ct.includes("json") ? await res.json() : { error: res.statusText };
    throw new Error(body.error || "请求失败");
  }
  // Return the raw Response for binary payloads (caller decides blob/arrayBuffer);
  // JSON responses are parsed for convenience.
  return ct.includes("json") ? res.json() : res;
}

function imgUrl(path) {
  return `/api/sessions/${state.sessionId}${path}?t=${Date.now()}`;
}

function fmtEV(inf) {
  if (inf.ev === null || inf.ev === undefined) return "曝光: 未知";
  const tag = inf.ev_source === "estimated" ? "（估算）" : "";
  return `EV ${inf.ev.toFixed(2)}${tag}`;
}

function fmtExposure(inf) {
  const parts = [];
  if (inf.exposure_time) parts.push(`快门 ${inf.exposure_time < 0.5 ? inf.exposure_time.toFixed(3) + "s" : (1 / inf.exposure_time).toFixed(0) + "分之一"}`);
  if (inf.f_number) parts.push(`f/${inf.f_number}`);
  if (inf.iso) parts.push(`ISO ${inf.iso}`);
  return parts.join(" · ") || "无 EXIF 曝光信息";
}

// ---------------------------------------------------------------------------
// Session bootstrap
// ---------------------------------------------------------------------------

async function init() {
  const s = await api("/api/sessions", { method: "POST" });
  state.sessionId = s.session_id;
  bindEvents();
}

function bindEvents() {
  $("#input-images").addEventListener("change", onUpload);
  $("#btn-create-group").addEventListener("click", onCreateGroup);
  $("#btn-sort-ev").addEventListener("click", onSortEV);
  $("#btn-align").addEventListener("click", onAlign);
  $("#btn-detect-ghost").addEventListener("click", onDetectGhost);
  $("#chk-auto-ghost").addEventListener("change", onToggleAutoGhost);
  $("#btn-fuse").addEventListener("click", onFuse);
  $("#btn-export").addEventListener("click", onExport);
  $("#btn-save-project").addEventListener("click", onSaveProject);
  $("#input-load-project").addEventListener("change", onLoadProject);
  $("#btn-reset-tonemap").addEventListener("click", resetTonemap);

  $$('input[name="canvas-mode"]').forEach(r =>
    r.addEventListener("change", () => { state.mode = r.value; redrawCanvas(); }));

  for (const id of ["sl-exposure", "sl-shadows", "sl-highlights", "sl-saturation"]) {
    $("#" + id).addEventListener("input", onTonemapInput);
  }

  const canvas = $("#canvas");
  canvas.addEventListener("click", onCanvasClick);
  canvas.addEventListener("dblclick", finishDraft);
  canvas.addEventListener("mousemove", onCanvasMove);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finishDraft();
    if (e.key === "Escape") { state.draft = []; redrawCanvas(); }
  });
}

// ---------------------------------------------------------------------------
// Upload + library
// ---------------------------------------------------------------------------

async function onUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const fd = new FormData();
  files.forEach(f => fd.append("files", f));
  try {
    const res = await api(`/api/sessions/${state.sessionId}/images`,
      { method: "POST", body: fd });
    res.uploaded.forEach(inf => state.images.set(inf.image_id, inf));
    if (res.failed?.length) {
      const box = $("#upload-failures");
      box.hidden = false;
      box.innerHTML = res.failed.map(f =>
        `<div>✗ ${f.filename}: ${f.reason}</div>`).join("");
    }
    renderLibrary();
    toast(`已导入 ${res.uploaded.length} 张照片`);
  } catch (err) {
    toast(err.message, true);
  }
  e.target.value = "";
}

function renderLibrary() {
  const lib = $("#library");
  if (!state.images.size) {
    lib.innerHTML = `<p class="hint">添加至少两张同一场景、不同曝光的照片</p>`;
    return;
  }
  lib.innerHTML = "";
  for (const inf of state.images.values()) {
    const item = document.createElement("div");
    item.className = "lib-item";
    const checked = state.selected.has(inf.image_id) ? "checked" : "";
    const evCls = inf.ev_source === "estimated" ? "ev estimated" : "ev";
    item.innerHTML = `
      <input type="checkbox" ${checked} data-id="${inf.image_id}">
      <img src="${imgUrl(`/thumb/${inf.image_id}`)}" alt="">
      <div class="lib-meta">
        <div class="name" title="${inf.filename}">${inf.filename}</div>
        <div class="${evCls}">${fmtEV(inf)}</div>
        <div class="ev">${fmtExposure(inf)}</div>
      </div>`;
    item.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? state.selected.add(inf.image_id)
                       : state.selected.delete(inf.image_id);
    });
    lib.appendChild(item);
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

async function onCreateGroup() {
  const ids = Array.from(state.selected);
  if (ids.length < 2) return toast("请至少勾选两张照片建组", true);
  const name = $("#group-name").value.trim();
  try {
    const g = await api(`/api/sessions/${state.sessionId}/groups`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_ids: ids, name }),
    });
    state.groups.set(g.group_id, g);
    renderGroupTabs();
    selectGroup(g.group_id);
    toast("分组已创建，已按曝光信息自动排序");
  } catch (err) { toast(err.message, true); }
}

function renderGroupTabs() {
  const tabs = $("#group-tabs");
  tabs.innerHTML = "";
  for (const g of state.groups.values()) {
    const t = document.createElement("div");
    t.className = "group-tab" + (g.group_id === state.currentGroup ? " active" : "");
    t.textContent = g.name;
    t.addEventListener("click", () => selectGroup(g.group_id));
    tabs.appendChild(t);
  }
}

function selectGroup(gid) {
  state.currentGroup = gid;
  const g = state.groups.get(gid);
  state.marks = g.marks || [];
  state.draft = [];
  state.fused = !!g.fused;
  $("#chk-auto-ghost").checked = !!g.auto_ghost_used;
  renderGroupTabs();
  renderFrameStrip();
  renderSourceSelect();
  renderMarks();
  renderReports(g);
  if (state.fused) showFused(); else showBaseFrame();
  $("#canvas-empty").style.display = g ? "none" : "block";
}

function renderFrameStrip() {
  const strip = $("#frame-strip");
  strip.innerHTML = "";
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  g.frames.forEach((inf, pos) => {
    const card = document.createElement("div");
    card.className = "frame-card";
    card.draggable = true;
    card.dataset.pos = pos;
    const evCls = inf.ev_source === "estimated" ? "fev estimated" : "fev";
    const badge = inf.status === "error"
      ? `<span class="badge error">对齐失败</span>`
      : inf.aligned ? `<span class="badge ok">已对齐</span>` : "";
    card.innerHTML = `
      <span class="idx">${pos + 1}</span>
      <img src="${imgUrl(`/thumb/${inf.image_id}`)}">
      <div class="fname" title="${inf.filename}">${inf.filename}</div>
      <div class="${evCls}">${fmtEV(inf)}</div>${badge}`;
    card.title = inf.message || fmtExposure(inf);

    card.addEventListener("dragstart", () => card.classList.add("dragging"));
    card.addEventListener("dragend", () => {
      card.classList.remove("dragging");
      $$(".frame-card").forEach(c => c.classList.remove("drop-before", "drop-after"));
    });
    card.addEventListener("dragover", (e) => {
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      card.classList.toggle("drop-before", before);
      card.classList.toggle("drop-after", !before);
    });
    card.addEventListener("drop", async (e) => {
      e.preventDefault();
      const from = Number($(".frame-card.dragging")?.dataset.pos);
      const rect = card.getBoundingClientRect();
      let to = Number(card.dataset.pos);
      if (e.clientX > rect.left + rect.width / 2 && from !== to) to += 1;
      if (from === to || Number.isNaN(from)) return;
      try {
        const updated = await api(
          `/api/sessions/${state.sessionId}/groups/${g.group_id}/reorder`,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from, to }) });
        state.groups.set(g.group_id, updated);
        selectGroup(g.group_id);
        toast("曝光顺序已调整");
      } catch (err) { toast(err.message, true); }
    });
    strip.appendChild(card);
  });
}

async function onSortEV() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/sort-ev`,
      { method: "POST" });
    state.groups.set(g.group_id, res.group);
    selectGroup(g.group_id);
    const hasEstimated = res.group.frames.some(f => f.ev_source === "estimated");
    toast(hasEstimated ? "部分照片缺少 EXIF，已按画面亮度估算曝光顺序" : "已按 EXIF 曝光信息排序");
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Alignment / ghost detection / fusion
// ---------------------------------------------------------------------------

async function onAlign() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  toast("正在校准位移…");
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/align`,
      { method: "POST" });
    state.groups.set(g.group_id, res.group);
    selectGroup(g.group_id);
    const failed = res.reports.filter(r => r.status === "error").length;
    toast(failed ? `对齐完成，${failed} 帧失败已保留原图，其余帧可用` : "全部帧对齐成功");
  } catch (err) { toast(err.message, true); }
}

function renderReports(g) {
  const box = $("#align-reports");
  const lines = g.frames
    .filter(f => f.message)
    .map(f => `<div class="report-line ${f.status === "error" ? "error" : "ok"}">
      ${f.filename}: ${f.message}</div>`).join("");
  box.innerHTML = lines;
}

async function onDetectGhost() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/detect-ghost`,
      { method: "POST" });
    state.baseFrameUrl = imgUrl(`/ghost-preview/${g.group_id}`);
    await loadCanvasImage(state.baseFrameUrl);
    drawOverlays();
    toast(`检测完成：疑似重影区域占画面 ${(res.coverage * 100).toFixed(2)}%，可勾选采用或手动标记`);
  } catch (err) { toast(err.message, true); }
}

async function onToggleAutoGhost(e) {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  try {
    await api(`/api/sessions/${state.sessionId}/groups/${g.group_id}/auto-ghost`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ used: e.target.checked }) });
    g.auto_ghost_used = e.target.checked;
    redrawCanvas();
  } catch (err) {
    e.target.checked = false;
    toast(err.message, true);
  }
}

async function onFuse() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  toast("正在合成 HDR…");
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/fuse`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ use_auto_ghost: g.auto_ghost_used }) });
    state.groups.set(g.group_id, res.group);
    state.fused = true;
    showFused();
    toast("合成完成，可在右侧调整色调预览");
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Canvas: base frame, fused preview, polygon marking
// ---------------------------------------------------------------------------

const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let canvasImage = null;     // HTMLImageElement currently displayed

function loadCanvasImage(url) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => {
      canvasImage = im;
      canvas.width = im.naturalWidth;
      canvas.height = im.naturalHeight;
      redrawCanvas();
      resolve(im);
    };
    im.onerror = () => reject(new Error("画布图片加载失败"));
    im.src = url;
  });
}

async function showBaseFrame() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  const mid = Math.floor(g.frames.length / 2);
  state.baseFrameUrl = imgUrl(`/groups/${g.group_id}/aligned/${mid}`);
  try { await loadCanvasImage(state.baseFrameUrl); }
  catch { await loadCanvasImage(imgUrl(`/image/${g.frames[mid].image_id}`)); }
  drawOverlays();
}

async function showFused() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  await loadCanvasImage(imgUrl(`/fused-preview/${g.group_id}`));
  requestTonemap();          // apply current slider settings on top
}

function redrawCanvas() {
  if (!canvasImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvasImage, 0, 0, canvas.width, canvas.height);
  drawOverlays();
}

function drawOverlays() {
  if (!canvasImage) return;
  // committed marks
  state.marks.forEach((m, k) => drawPolygon(m.points, MARK_COLORS[k % MARK_COLORS.length], true));
  // draft polygon
  if (state.draft.length) {
    drawPolygon(state.draft, "#ffffff", false);
    if (state.hoverPoint) {
      const pts = state.draft.concat([state.hoverPoint]);
      drawPolygon(pts, "#ffffff", false);
    }
  }
}

function drawPolygon(points, color, closed) {
  if (!points.length) return;
  const w = canvas.width, h = canvas.height;
  ctx.beginPath();
  ctx.moveTo(points[0][0] * w, points[0][1] * h);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0] * w, points[i][1] * h);
  if (closed) ctx.closePath();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, w / 600);
  ctx.stroke();
  if (closed) {
    ctx.fillStyle = color + "33";
    ctx.fill();
  }
  points.forEach(p => {
    ctx.beginPath();
    ctx.arc(p[0] * w, p[1] * h, Math.max(3, w / 250), 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
}

function eventToNorm(e) {
  const rect = canvas.getBoundingClientRect();
  return [
    Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
    Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
  ];
}

function onCanvasClick(e) {
  if (state.mode !== "mark" || !state.groups.get(state.currentGroup)) return;
  state.draft.push(eventToNorm(e));
  redrawCanvas();
}

function onCanvasMove(e) {
  if (state.mode !== "mark" || !state.draft.length) return;
  state.hoverPoint = eventToNorm(e);
  redrawCanvas();
}

async function finishDraft() {
  if (state.mode !== "mark" || state.draft.length < 3) {
    if (state.draft.length) toast("至少需要 3 个点才能构成区域", true);
    return;
  }
  const g = state.groups.get(state.currentGroup);
  const source_index = Number($("#select-source-frame").value);
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/marks`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: state.draft, source_index,
                               label: `标记 ${state.marks.length + 1}` }) });
    state.marks.push(res.mark);
    state.draft = [];
    renderMarks();
    redrawCanvas();
    toast("重影区域已标记，重新合成后该区域将仅取自所选来源帧");
  } catch (err) { toast(err.message, true); }
}

function renderSourceSelect() {
  const sel = $("#select-source-frame");
  const g = state.groups.get(state.currentGroup);
  sel.innerHTML = "";
  if (!g) return;
  g.frames.forEach((inf, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `来源：第 ${i + 1} 帧（${inf.filename}）`;
    sel.appendChild(opt);
  });
  sel.value = String(Math.floor(g.frames.length / 2));
}

function renderMarks() {
  const ul = $("#marks-list");
  ul.innerHTML = "";
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  state.marks.forEach((m, k) => {
    const li = document.createElement("li");
    li.className = "mark-row";
    const opts = g.frames.map((f, i) =>
      `<option value="${i}" ${i === m.source_index ? "selected" : ""}>第 ${i + 1} 帧 · ${f.filename}</option>`
    ).join("");
    li.innerHTML = `
      <span class="mark-swatch" style="background:${MARK_COLORS[k % MARK_COLORS.length]}"></span>
      <span>${m.label || "标记 " + (k + 1)}</span>
      <select data-mid="${m.mark_id}">${opts}</select>
      <span class="spacer"></span>
      <button class="btn small" data-del="${m.mark_id}">删除</button>`;
    li.querySelector("select").addEventListener("change", async (e) => {
      try {
        await api(`/api/sessions/${state.sessionId}/groups/${g.group_id}/marks/${m.mark_id}`,
          { method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source_index: Number(e.target.value) }) });
        m.source_index = Number(e.target.value);
        toast("来源帧已更新，重新合成后生效");
      } catch (err) { toast(err.message, true); }
    });
    li.querySelector("[data-del]").addEventListener("click", async () => {
      await api(`/api/sessions/${state.sessionId}/groups/${g.group_id}/marks/${m.mark_id}`,
        { method: "DELETE" });
      state.marks = state.marks.filter(x => x.mark_id !== m.mark_id);
      renderMarks();
      redrawCanvas();
    });
    ul.appendChild(li);
  });
}

// ---------------------------------------------------------------------------
// Tonemap controls (debounced; never touches input images)
// ---------------------------------------------------------------------------

function tonemapParams() {
  return {
    exposure: Number($("#sl-exposure").value),
    shadows: Number($("#sl-shadows").value),
    highlights: Number($("#sl-highlights").value),
    saturation: Number($("#sl-saturation").value),
  };
}

function onTonemapInput() {
  $("#val-exposure").textContent = Number($("#sl-exposure").value).toFixed(2);
  $("#val-shadows").textContent = Number($("#sl-shadows").value).toFixed(2);
  $("#val-highlights").textContent = Number($("#sl-highlights").value).toFixed(2);
  $("#val-saturation").textContent = Number($("#sl-saturation").value).toFixed(2);
  if (!state.fused) return;
  clearTimeout(state.tonemapTimer);
  state.tonemapTimer = setTimeout(requestTonemap, 120);
}

async function requestTonemap() {
  const g = state.groups.get(state.currentGroup);
  if (!g || !state.fused) return;
  try {
    const res = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/tonemap`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tonemapParams()) });
    const blob = await res.blob();
    await loadCanvasImage(URL.createObjectURL(blob));
  } catch (err) { toast(err.message, true); }
}

function resetTonemap() {
  $("#sl-exposure").value = 0;
  $("#sl-shadows").value = 0;
  $("#sl-highlights").value = 0;
  $("#sl-saturation").value = 1;
  onTonemapInput();
}

// ---------------------------------------------------------------------------
// Export / project save / load
// ---------------------------------------------------------------------------

async function onExport() {
  const g = state.groups.get(state.currentGroup);
  if (!g) return;
  if (!state.fused) return toast("请先执行合成再导出", true);
  try {
    const links = await api(
      `/api/sessions/${state.sessionId}/groups/${g.group_id}/export`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tonemapParams()) });
    const box = $("#export-links");
    box.innerHTML = `
      <a href="${links.png_url}" download>⬇ 8-bit PNG 合成图</a>
      <a href="${links.tiff_url}" download>⬇ 16-bit TIFF 高动态范围图</a>
      <a href="${links.params_url}" download>⬇ 参数记录 JSON</a>`;
    toast("导出完成，可从右侧链接下载");
  } catch (err) { toast(err.message, true); }
}

async function onSaveProject() {
  try {
    // The project endpoint returns JSON; re-serialize it into a downloadable
    // blob rather than calling .blob() on the already-parsed object.
    const project = await api(`/api/sessions/${state.sessionId}/project`);
    const blob = new Blob([JSON.stringify(project, null, 2)],
                          { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "hdr_project.hdrproj.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("工程已保存（含图片组、校准结果与重影标记）");
  } catch (err) { toast(err.message, true); }
}

async function onLoadProject(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("project", file);
  try {
    const res = await api("/api/projects/load", { method: "POST", body: fd });
    state.sessionId = res.session_id;
    state.images.clear();
    state.groups.clear();
    state.selected.clear();
    for (const g of res.groups) {
      state.groups.set(g.group_id, g);
      for (const f of g.frames) state.images.set(f.image_id, f);
    }
    renderLibrary();
    renderGroupTabs();
    if (res.groups.length) selectGroup(res.groups[0].group_id);
    toast("工程已恢复：图片组、校准与重影标记均已还原");
  } catch (err) { toast(err.message, true); }
  e.target.value = "";
}

init().catch(err => toast("初始化失败: " + err.message, true));
