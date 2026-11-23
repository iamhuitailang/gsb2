/* 黑白零件图轮廓测量 —— 前端单页逻辑（原生 JS，无外部依赖）。
 * 后端负责 OpenCV 分析，前端负责画布绘制与交互。 */
"use strict";

const $ = (id) => document.getElementById(id);
const KIND_COLOR = { outer: "#3caa3c", hole: "#e64632", border: "#e6b800" };
const KIND_LABEL = { outer: "外轮廓", hole: "孔", border: "断到图边" };

const state = {
  imageId: null,
  imageName: "",
  imgEl: null,            // 原始灰度图 Image 对象
  displayScale: 1,        // 画布相对原图的缩放
  imageShape: [0, 0],
  // 标定
  calib: null,
  pickMode: null,         // 'h' | 'v' | null
  hPicks: [],
  vPicks: [],
  // 分析
  params: { threshold: 128, min_speck_area_px: 3000, morph_open: 0, invert: false },
  analysis: null,
  overlayImg: null,
  overlayScale: 1,
  components: [],
  selectedId: null,
  measurements: {},
  // 快照
  snapshots: [],
  diffResult: null,
  pending: {},
  demoName: null,
};

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

// --------------------------------------------------------------------- //
// HTTP 辅助
// --------------------------------------------------------------------- //
async function api(path, options = {}) {
  const resp = await fetch(path, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败 ${resp.status}`);
  return data;
}
function postJSON(path, body) {
  return api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function setStatus(text, isWarn) {
  const el = $("status");
  el.textContent = text;
  el.style.color = isWarn ? "#b45309" : "";
}

// --------------------------------------------------------------------- //
// 图片加载
// --------------------------------------------------------------------- //
function loadImageById(imageId, name) {
  state.imageId = imageId;
  state.imageName = name || "";
  state.calib = null;
  state.analysis = null;
  state.components = [];
  state.selectedId = null;
  state.measurements = {};
  state.hPicks = [];
  state.vPicks = [];
  state.snapshots = [];
  state.diffResult = null;
  $("snapshot-select").innerHTML = "";
  $("diff-panel").classList.add("hidden");

  const img = new Image();
  img.onload = () => {
    state.imgEl = img;
    state.imageShape = [img.naturalHeight, img.naturalWidth];
    fitCanvas();
    draw();
    setStatus(`已加载 ${name || "图片"}：${img.naturalWidth}×${img.naturalHeight}px`);
  };
  img.src = `/api/image/${imageId}/file?t=${Date.now()}`;
}

function fitCanvas() {
  if (!state.imgEl) return;
  const stage = $("stage");
  const maxW = stage.clientWidth - 24;
  const maxH = stage.clientHeight - 24;
  const s = Math.min(1, maxW / state.imgEl.naturalWidth,
                        maxH / state.imgEl.naturalHeight);
  state.displayScale = s;
  canvas.width = Math.round(state.imgEl.naturalWidth * s);
  canvas.height = Math.round(state.imgEl.naturalHeight * s);
}

// --------------------------------------------------------------------- //
// 画布绘制
// --------------------------------------------------------------------- //
function draw() {
  if (!state.imgEl) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const s = state.displayScale;

  // 底图：有轮廓叠加图就用叠加图，否则原图
  const base = state.overlayImg || state.imgEl;
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

  // 有效测量区域
  if (state.calib) {
    const poly = state.calib.valid_polygon_px;
    ctx.save();
    ctx.beginPath();
    poly.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s)
                             : ctx.moveTo(p[0] * s, p[1] * s));
    ctx.closePath();
    ctx.fillStyle = "rgba(200,200,80,0.10)";
    ctx.fill();
    ctx.strokeStyle = "rgba(180,160,20,0.9)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([7, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 两根标尺
    drawRuler(state.calib.horizontal, "#e07b00", "横");
    drawRuler(state.calib.vertical, "#0072e0", "纵");
  }

  // 选点过程中的临时标尺端点
  drawPickPoints(state.hPicks, "#e07b00");
  drawPickPoints(state.vPicks, "#0072e0");

  // 选中零件的高亮 + 超界点
  if (state.selectedId != null) {
    const comp = state.components.find((c) => c.comp_id === state.selectedId);
    if (comp) {
      ctx.save();
      ctx.beginPath();
      comp.contour.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s)
                                       : ctx.moveTo(p[0] * s, p[1] * s));
      ctx.closePath();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#ffffff";
      ctx.stroke();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = KIND_COLOR[comp.kind];
      ctx.stroke();
      ctx.restore();
    }
    const m = state.measurements[state.selectedId];
    if (m && m.outside_points_px && m.outside_points_px.length) {
      ctx.save();
      ctx.fillStyle = "#ff2d55";
      m.outside_points_px.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p[0] * s, p[1] * s, 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();
    }
    drawMeasureLines(m, s);
  }

  // 对比模式下旧快照轮廓（虚线叠加）
  if (state.diffResult && state.diffResult._oldContours) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(120,60,200,0.85)";
    ctx.lineWidth = 1.5;
    state.diffResult._oldContours.forEach((pts) => {
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s)
                              : ctx.moveTo(p[0] * s, p[1] * s));
      ctx.closePath();
      ctx.stroke();
    });
    ctx.restore();
  }
}

function drawRuler(r, color, label) {
  const s = state.displayScale;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(r.a[0] * s, r.a[1] * s);
  ctx.lineTo(r.b[0] * s, r.b[1] * s);
  ctx.stroke();
  [r.a, r.b].forEach((p) => {
    ctx.beginPath();
    ctx.arc(p[0] * s, p[1] * s, 5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });
  ctx.fillStyle = color;
  ctx.font = "12px sans-serif";
  ctx.fillText(`${label}尺 ${r.length_mm}mm`, r.b[0] * s + 7, r.b[1] * s - 7);
  ctx.restore();
}

function drawPickPoints(points, color) {
  const s = state.displayScale;
  ctx.save();
  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p[0] * s, p[1] * s, 6, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
  ctx.restore();
}

function drawMeasureLines(m, s) {
  if (!m || !state.calib) return;
  const calib = state.calib;
  const comp = state.components.find((c) => c.comp_id === state.selectedId);
  if (!comp) return;
  // 用轮廓点的 mm 包围盒，反算测量线段端点
  const pts = comp.contour.map((p) => pixelToMm(p));
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  const u0 = Math.min(...us), u1 = Math.max(...us);
  const v0 = Math.min(...vs), v1 = Math.max(...vs);
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const wA = mmToPixel([u0, vm]), wB = mmToPixel([u1, vm]);
  const hA = mmToPixel([um, v0]), hB = mmToPixel([um, v1]);
  ctx.save();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#e07b00";
  line(wA, wB, s);
  ctx.strokeStyle = "#0072e0";
  line(hA, hB, s);
  ctx.restore();
}
function line(a, b, s) {
  ctx.beginPath();
  ctx.moveTo(a[0] * s, a[1] * s);
  ctx.lineTo(b[0] * s, b[1] * s);
  ctx.stroke();
}

// 前端本地近似的 mm 换算（与后端同一仿射参数）
function pixelToMm(px) {
  const c = state.calib;
  const o = c.origin_px, m = c._px2mm;
  const dx = px[0] - o[0], dy = px[1] - o[1];
  return [m[0][0] * dx + m[0][1] * dy, m[1][0] * dx + m[1][1] * dy];
}
function mmToPixel(uv) {
  const c = state.calib;
  const o = c.origin_px, b = c._basis;
  return [o[0] + b[0][0] * uv[0] + b[0][1] * uv[1],
          o[1] + b[1][0] * uv[0] + b[1][1] * uv[1]];
}

// --------------------------------------------------------------------- //
// 画布交互：选点 & 点选零件
// --------------------------------------------------------------------- //
canvas.addEventListener("click", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const px = [(ev.clientX - rect.left) / state.displayScale,
              (ev.clientY - rect.top) / state.displayScale];
  if (state.pickMode === "h") {
    state.hPicks.push(px);
    $("btn-pick-h").textContent = `点选横尺端点(${state.hPicks.length}/2)`;
    if (state.hPicks.length === 2) { state.pickMode = null; $("btn-pick-h").classList.remove("pick-active"); }
    draw();
    return;
  }
  if (state.pickMode === "v") {
    state.vPicks.push(px);
    $("btn-pick-v").textContent = `点选纵尺端点(${state.vPicks.length}/2)`;
    if (state.vPicks.length === 2) { state.pickMode = null; $("btn-pick-v").classList.remove("pick-active"); }
    draw();
    return;
  }
  pickComponent(px);
});

canvas.addEventListener("mousemove", (ev) => {
  const rect = canvas.getBoundingClientRect();
  const px = [(ev.clientX - rect.left) / state.displayScale,
              (ev.clientY - rect.top) / state.displayScale];
  const hit = hitTest(px);
  canvas.style.cursor = (state.pickMode || hit != null) ? "pointer" : "crosshair";
  const tip = $("tooltip");
  if (hit != null) {
    const c = state.components[hit];
    tip.textContent = `#${c.comp_id} ${KIND_LABEL[c.kind]}`;
    tip.style.left = `${ev.clientX - rect.left + 12}px`;
    tip.style.top = `${ev.clientY - rect.top + 12}px`;
    tip.classList.remove("hidden");
  } else {
    tip.classList.add("hidden");
  }
});

function hitTest(px) {
  // 从上层（孔）往外层找，点在轮廓内即命中
  const ordered = [...state.components].sort((a, b) =>
    (a.kind === "hole" ? 0 : 1) - (b.kind === "hole" ? 0 : 1));
  for (const c of ordered) {
    if (pointInPolygon(px, c.contour)) {
      // 点孔时返回其所属零件
      return c.kind === "hole" ? c.parent_id : c.comp_id;
    }
  }
  return null;
}
function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > p[1]) !== (yj > p[1]) &&
        p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

async function pickComponent(px) {
  const cid = hitTest(px);
  if (cid == null) return;
  state.selectedId = cid;
  draw();
  await requestMeasurements();
}

// --------------------------------------------------------------------- //
// 标定
// --------------------------------------------------------------------- //
$("btn-pick-h").onclick = () => {
  state.pickMode = "h";
  state.hPicks = [];
  $("btn-pick-h").classList.add("pick-active");
  $("btn-pick-v").classList.remove("pick-active");
};
$("btn-pick-v").onclick = () => {
  state.pickMode = "v";
  state.vPicks = [];
  $("btn-pick-v").classList.add("pick-active");
  $("btn-pick-h").classList.remove("pick-active");
};
$("btn-clear-calib").onclick = () => {
  state.calib = null; state.hPicks = []; state.vPicks = [];
  $("calib-quality").innerHTML = "";
  $("btn-pick-h").textContent = "点选横尺端点(0/2)";
  $("btn-pick-v").textContent = "点选纵尺端点(0/2)";
  draw();
};

$("btn-apply-calib").onclick = async () => {
  if (state.hPicks.length !== 2 || state.vPicks.length !== 2) {
    setStatus("请先在图上点齐横尺、纵尺各两个端点", true);
    return;
  }
  await applyCalibration({
    horizontal: { a: state.hPicks[0], b: state.hPicks[1],
                  length_mm: parseFloat($("h-length").value), name: "横尺" },
    vertical: { a: state.vPicks[0], b: state.vPicks[1],
                length_mm: parseFloat($("v-length").value), name: "纵尺" },
  });
};

async function applyCalibration(payload) {
  try {
    const data = await postJSON(`/api/calibration/${state.imageId}`, payload);
    state.calib = enrichCalib(data);
    renderCalibQuality(data);
    draw();
    setStatus("标定完成：黄框内为有效测量区域，超出读数会提醒");
    if (state.analysis) await requestMeasurements();
  } catch (e) { setStatus(e.message, true); }
}

function enrichCalib(data) {
  // 补出前端本地仿射矩阵，供绘制测量线
  const h = data.horizontal, v = data.vertical;
  const o = data.origin_px;
  const bu = [(h.b[0] - h.a[0]) / h.length_mm, (h.b[1] - h.a[1]) / h.length_mm];
  const bv = [(v.b[0] - v.a[0]) / v.length_mm, (v.b[1] - v.a[1]) / v.length_mm];
  const basis = [[bu[0], bv[0]], [bu[1], bv[1]]];
  const det = basis[0][0] * basis[1][1] - basis[0][1] * basis[1][0];
  const inv = Math.abs(det) < 1e-12 ? null : [
    [basis[1][1] / det, -basis[0][1] / det],
    [-basis[1][0] / det, basis[0][0] / det],
  ];
  return { ...data, _basis: basis, _px2mm: inv };
}

function renderCalibQuality(data) {
  const q = data.quality;
  const rows = [
    `横尺 ${q.horizontal_mm_per_pixel.toFixed(5)} mm/px`,
    `纵尺 ${q.vertical_mm_per_pixel.toFixed(5)} mm/px`,
    `横尺相对图边倾斜 ${q.horizontal_tilt_deg.toFixed(2)}°`,
    `两尺夹角 ${q.ruler_angle_deg.toFixed(2)}°（正交偏差 ${q.ruler_angle_from_orthogonal_deg.toFixed(2)}°）`,
    `两尺比例差异 ${q.scale_mismatch_percent.toFixed(2)}%`,
  ];
  $("calib-quality").innerHTML = rows.map((r) => `• ${r}`).join("<br>");
}

// --------------------------------------------------------------------- //
// 分割分析
// --------------------------------------------------------------------- //
let analyzeTimer = null;
function scheduleAnalyze() {
  clearTimeout(analyzeTimer);
  analyzeTimer = setTimeout(runAnalyze, 180);
}
["threshold", "speck", "morph"].forEach((id) => {
  $(id).addEventListener("input", () => {
    state.params.threshold = parseInt($("threshold").value, 10);
    state.params.min_speck_area_px = parseInt($("speck").value, 10);
    state.params.morph_open = parseInt($("morph").value, 10) || 0;
    $("threshold-val").textContent = state.params.threshold;
    $("speck-val").textContent = state.params.min_speck_area_px;
    scheduleAnalyze();
  });
});
$("invert").addEventListener("change", (e) => {
  state.params.invert = e.target.checked;
  runAnalyze();
});

async function runAnalyze() {
  if (!state.imageId) return;
  try {
    const data = await postJSON(`/api/analyze/${state.imageId}`, state.params);
    state.analysis = data;
    state.overlayScale = data.overlay_scale;
    state.components = data.components;
    state.selectedId = null;
    state.measurements = {};
    const img = new Image();
    img.onload = () => { state.overlayImg = img; draw(); };
    img.src = data.overlay_png;
    $("seg-counts").innerHTML =
      `外轮廓 <b>${data.counts.outer}</b> · 孔 <b>${data.counts.hole}</b> · ` +
      `断到图边 <b>${data.counts.border}</b><br>` +
      `保留小黑点 ${data.counts.kept_specks} · 过滤噪点 ${data.counts.dropped_specks}`;
    if (state.calib) await requestMeasurements();
    setStatus("轮廓已更新（绿=外轮廓，红=孔，黄=断到图边）");
  } catch (e) { setStatus(e.message, true); }
}

// --------------------------------------------------------------------- //
// 测量
// --------------------------------------------------------------------- //
async function requestMeasurements() {
  if (!state.calib || !state.analysis) return;
  try {
    const data = await postJSON(`/api/measure/${state.imageId}`, {
      params: state.params,
      comp_id: state.selectedId,
    });
    state.measurements = data.measurements;
    state.pending = Object.fromEntries(
      Object.entries(data.measurements)
        .filter(([, m]) => m.status === "pending")
        .map(([id, m]) => [id, m])
    );
    if (data.selected) renderMeasurement(data.selected);
    draw();
  } catch (e) { setStatus(e.message, true); }
}

function renderMeasurement(m) {
  const comp = state.components.find((c) => c.comp_id === m.comp_id);
  const kindTag = `<span class="tag ${m.kind}">${KIND_LABEL[m.kind]}</span>`;
  const statusTag = m.status === "pending"
    ? `<span class="tag pending">待确认</span>`
    : `<span class="tag confirmed">已确认</span>`;
  const warnings = (m.warnings || []).map((w) =>
    `<div class="warning">⚠ ${w}</div>`).join("");
  const holes = (m.holes || []).map((h) =>
    `<tr><td>孔 #${h.hole_id} 面积</td><td>${h.area_mm2.toFixed(2)} mm² ` +
    `（${h.width_mm.toFixed(2)}×${h.height_mm.toFixed(2)} mm）</td></tr>`).join("");
  const projs = (m.projections || []).map((p) =>
    `<tr><td>${p.label}</td><td>${p.size_mm.toFixed(2)} mm</td></tr>`).join("");

  $("measurement").innerHTML = `
    <div class="row" style="justify-content:space-between">
      <b>零件 #${m.comp_id}</b><span>${kindTag} ${statusTag}</span>
    </div>
    ${m.note ? `<div class="warning">备注：${escapeHtml(m.note)}</div>` : ""}
    ${warnings}
    <table class="measure">
      <tr><td>外宽（沿横尺，含孔外径）</td><td><b>${m.outer_width_mm.toFixed(2)}</b> mm</td></tr>
      <tr><td>外高（沿纵尺，含孔外径）</td><td><b>${m.outer_height_mm.toFixed(2)}</b> mm</td></tr>
      <tr><td>外轮廓面积（含孔口径）</td><td>${m.outer_area_mm2.toFixed(2)} mm²</td></tr>
      <tr><td>实际填充面积（不含孔）</td><td><b>${m.filled_area_mm2.toFixed(2)}</b> mm²</td></tr>
      <tr><td>孔面积合计（封闭孔）</td><td>${m.hole_area_mm2.toFixed(2)} mm²（${m.hole_count} 个）</td></tr>
      ${holes}
      <tr><td>有效区内轮廓点占比</td><td>${(m.inside_fraction * 100).toFixed(1)}%</td></tr>
    </table>
    <b>各方向投影尺寸（外轮廓口径，含孔）</b>
    <table class="measure">${projs}</table>
    <p class="muted">口径说明：外宽/外高/外轮廓面积/投影均为含孔的外轮廓尺寸；
      实际填充面积已扣除全部封闭孔；与外部连通的开口不计入孔面积。</p>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("btn-pending").onclick = () => updateStatus("pending");
$("btn-confirm").onclick = () => updateStatus("confirmed");
async function updateStatus(status) {
  if (state.selectedId == null) return;
  const note = prompt(status === "pending" ? "可填写待确认原因（可留空）：" : "备注（可留空）：",
                      state.pending[state.selectedId]?.note || "") ?? "";
  await postJSON(`/api/measure/${state.imageId}/status`, {
    comp_id: state.selectedId, status, note,
  });
  await requestMeasurements();
}

// --------------------------------------------------------------------- //
// 快照与对比
// --------------------------------------------------------------------- //
$("btn-snapshot").onclick = async () => {
  const label = prompt("快照名称：",
    `阈值${state.params.threshold}/斑点${state.params.min_speck_area_px}`);
  if (label == null) return;
  const data = await postJSON(`/api/snapshot/${state.imageId}`,
    { params: state.params, label });
  await refreshSnapshots(data.snapshot_id);
  setStatus(`已存快照「${label}」，调整阈值/标尺后可与之对比`);
};
async function refreshSnapshots(selectId) {
  const data = await api(`/api/snapshot/${state.imageId}/list`);
  state.snapshots = data.snapshots;
  const sel = $("snapshot-select");
  sel.innerHTML = state.snapshots.map((s) =>
    `<option value="${s.id}">${escapeHtml(s.label)}</option>`).join("");
  if (selectId) sel.value = selectId;
}

$("btn-diff").onclick = async () => {
  if (state.snapshots.length < 1) { setStatus("请先存一个快照", true); return; }
  const oldId = $("snapshot-select").value;
  const cur = await postJSON(`/api/snapshot/${state.imageId}`,
    { params: state.params, label: "当前结果" });
  const diff = await postJSON(`/api/snapshot/${state.imageId}/diff`,
    { old_id: oldId, new_id: cur.snapshot_id });
  // 取旧快照轮廓用于画布叠加
  diff._oldContours = state.components.map((c) => c.contour);
  state.diffResult = diff;
  renderDiff(diff);
  await refreshSnapshots();
};

function renderDiff(diff) {
  $("diff-panel").classList.remove("hidden");
  const blocks = diff.matched.map((cd) => {
    const fates = cd.hole_fates.map((f) =>
      `<div class="fate ${f.fate}">• ${f.label}` +
      `${f.connected_to_exterior ? "（<b>已与外部连通</b>）" : ""}` +
      `<br><span class="muted">${escapeHtml(f.detail)}</span></div>`).join("");
    return `<div><b>零件（旧#${cd.old_id} → 新#${cd.new_id}）</b>${fates || "<p>无孔</p>"}</div>`;
  }).join("");
  const onlyOld = diff.only_in_old.map((c) =>
    `<div class="fate to_part">旧版独有 #${c.comp_id}（${KIND_LABEL[c.kind]}）</div>`).join("");
  const onlyNew = diff.only_in_new.map((c) =>
    `<div class="fate new_hole">新版独有 #${c.comp_id}（${KIND_LABEL[c.kind]}）</div>`).join("");
  $("diff-content").innerHTML =
    `<p class="muted">紫色虚线为旧快照轮廓，底色为当前结果。</p>` +
    (blocks || "<p>未匹配到相同零件</p>") + onlyOld + onlyNew;
}
$("btn-close-diff").onclick = () => {
  state.diffResult = null;
  $("diff-panel").classList.add("hidden");
  draw();
};

// --------------------------------------------------------------------- //
// 导出 / 读回 / 描边
// --------------------------------------------------------------------- //
$("btn-export").onclick = async () => {
  if (!state.imageId || !state.calib) { setStatus("请先加载图片并标定", true); return; }
  const data = await postJSON(`/api/export/${state.imageId}`, {
    params: state.params, selected_id: state.selectedId,
    diff: state.diffResult ? stripRuntime(state.diffResult) : null,
  });
  downloadJSON(data.project, `${(state.imageName || "scan").replace(/\.\w+$/, "")}_project.json`);
  setStatus(`已导出工程与描边图：${data.annotated_path}`);
};
function stripRuntime(d) {
  const copy = { ...d };
  delete copy._oldContours;
  return copy;
}
function downloadJSON(obj, name) {
  const blob = new Blob([JSON.stringify(obj, null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("project-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("project", file);
  if (state.imageId) fd.append("image_id", state.imageId);
  const resp = await fetch("/api/import", { method: "POST", body: fd });
  const data = await resp.json();
  if (!resp.ok) { setStatus(data.error || "读回失败", true); return; }
  if (data.calibration) {
    state.calib = enrichCalib(data.calibration);
    renderCalibQuality(data.calibration);
  }
  // 还原分割参数与轮廓
  const sp = data.project.segmentation.params;
  Object.assign(state.params, sp);
  $("threshold").value = sp.threshold; $("threshold-val").textContent = sp.threshold;
  $("speck").value = sp.min_speck_area_px; $("speck-val").textContent = sp.min_speck_area_px;
  $("morph").value = sp.morph_open; $("invert").checked = !!sp.invert;
  state.components = data.project.segmentation.components.map((c) => ({
    comp_id: c.comp_id, kind: c.kind, parent_id: c.parent_id,
    child_ids: c.child_ids, bbox: c.bbox, contour: c.contour_px,
  }));
  state.measurements = data.project.measurements;
  state.pending = data.project.pending_readings || {};
  draw();
  const problems = data.problems.length
    ? `；注意：${data.problems.join("；")}` : "";
  setStatus(`工程已读回，轮廓与 ${Object.keys(state.measurements).length} 组测量已还原${problems}`,
    !!data.problems.length);
  if (state.selectedId != null && state.measurements[state.selectedId])
    renderMeasurement(state.measurements[state.selectedId]);
  ev.target.value = "";
});

$("btn-annotate").onclick = async () => {
  if (!state.imageId || !state.calib) { setStatus("请先加载图片并标定", true); return; }
  const data = await postJSON(`/api/annotate/${state.imageId}`,
    { params: state.params, selected_id: state.selectedId });
  const w = window.open("");
  w.document.write(
    `<title>测量描边图</title><body style="margin:0;background:#333">` +
    `<img src="${data.annotated_png}" style="max-width:100%">` +
    `<p style="color:#fff;font-family:sans-serif">黄框=有效区域；橙线=外宽，蓝线=外高，灰线=投影；绿=外轮廓，红=孔，黄=断到图边</p></body>`);
};

// --------------------------------------------------------------------- //
// 图片导入 & 演示
// --------------------------------------------------------------------- //
$("file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append("image", file);
  const resp = await fetch("/api/image/upload", { method: "POST", body: fd });
  const data = await resp.json();
  if (!resp.ok) { setStatus(data.error, true); return; }
  state.demoName = null;
  loadImageById(data.image_id, data.name);
  ev.target.value = "";
});

document.querySelectorAll("[data-demo]").forEach((btn) => {
  btn.onclick = async () => {
    const name = btn.dataset.demo;
    const data = await postJSON(`/api/demo/load/${name}`);
    state.demoName = name;
    loadImageById(data.image_id, data.name);
    const gt = await api("/api/demo/list");
    const entry = gt.images.find((e) => e.image === data.name);
    renderGroundTruth(entry);
  };
});

$("btn-demo-calib").onclick = async () => {
  if (!state.demoName) { setStatus("请先加载一张演示图", true); return; }
  const data = await postJSON(`/api/demo/calibration/${state.demoName}`,
    { image_id: state.imageId });
  state.calib = enrichCalib(data);
  state.hPicks = [data.horizontal.a, data.horizontal.b];
  state.vPicks = [data.vertical.a, data.vertical.b];
  $("h-length").value = data.horizontal.length_mm;
  $("v-length").value = data.vertical.length_mm;
  renderCalibQuality(data);
  draw();
  setStatus("已按演示标尺真值标定，可直接运行分析并核对误差");
};

function renderGroundTruth(entry) {
  const parts = entry.parts.map((p) => {
    const size = p.shape.kind === "circle"
      ? `直径 ${p.local_diameter_mm}mm`
      : `${p.local_width_mm}×${p.local_height_mm}mm`;
    return `<li>${p.name}：${size}，外面积 ${p.outer_area_mm2.toFixed(1)}mm²，` +
      `填充 ${p.filled_area_mm2.toFixed(1)}mm²，孔 ${p.holes.length} 个` +
      (p.expect_border ? "（预期被图边截断）" : "") + "</li>";
  }).join("");
  $("demo-gt").innerHTML =
    `<b>已知真值（${entry.scale_px_per_mm} px/mm）</b><ul style="margin:6px 0;padding-left:18px">${parts}</ul>`;
}

window.addEventListener("resize", () => { fitCanvas(); draw(); });
setStatus("就绪：可导入扫描图，或加载左侧演示数据");
