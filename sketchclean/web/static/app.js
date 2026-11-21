/* sketchclean 本地界面 —— 原生 JS，无外部依赖，完全离线 */

const $ = (sel) => document.querySelector(sel);
const state = {
  sid: null,
  params: defaultParams(),
  view: "cleaned",          // original | cleaned | inspect | background
  overlay: { breaks: true, dots: true, shadow: true },
  mode: "pan",              // pan | roi | polygon
  roi: null,                // 归一化 [[x0,y0],[x1,y1]]
  regions: [],              // 手绘区域
  drawing: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  imgSize: null,            // 预览图像素尺寸
  procTimer: null,
};

const OVERLAY_COLORS = { breaks: "#e34948", dots: "#eb6834", shadow: "#2a78d6" };

function defaultParams() {
  return {
    roi: null,
    background_scale: 0.08, paper_quantile: 0.75, solid_block_size: 0.02,
    white_target: 245.0, gamma: 1.15,
    despeckle: true, despeckle_size: 10, despeckle_strength: 0.8,
    ink_threshold: 210, break_distance: 0.012, shadow_residual: 12,
    regions: [],
  };
}

// ------------------------------------------------------------ API
async function api(url, opts) {
  const r = await fetch(url, opts);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "请求失败");
  return j;
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);
  const j = await api("/api/upload", { method: "POST", body: fd });
  loadSession(j);
}

async function loadSample(which) {
  const j = await api(`/api/sample/${which}`);
  loadSession(j);
}

function loadSession(j) {
  state.sid = j.session;
  state.imgSize = { w: j.preview_width, h: j.preview_height };
  state.roi = null;
  state.regions = [];
  state.params = defaultParams();
  state.zoom = 1; state.pan = { x: 0, y: 0 };
  Object.keys(imgs).forEach(k => { delete imgs[k]; });
  syncControls();
  drawHistogram($("#hist"), j.histogram, {
    median: j.hist_median, p05: j.hist_p05, p95: j.hist_p95,
  });
  $("#hist2").getContext("2d").clearRect(0, 0, 9999, 9999);
  $("#status").textContent = `已载入 ${j.name}（${j.width}×${j.height}）`;
  showImage("original");
  requestAnimationFrame(() => { fitZoom(); render(); });
  refreshRoiList();
}

function imageUrl(kind) {
  // v 随每次处理递增，避免浏览器缓存上一轮结果。
  return `/api/image/${state.sid}/${kind}?t=${state.imgVersion || 0}`;
}

function showImage(kind) {
  state.view = kind;
  document.querySelectorAll(".view-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.view === kind));
  render();
}

// ------------------------------------------------------------ 处理调度（防抖）
function scheduleProcess() {
  clearTimeout(state.procTimer);
  state.procTimer = setTimeout(runProcess, 220);
}

async function runProcess() {
  if (!state.sid) return;
  state.params.roi = state.roi ? [
    Math.min(state.roi[0][0], state.roi[1][0]),
    Math.min(state.roi[0][1], state.roi[1][1]),
    Math.max(state.roi[0][0], state.roi[1][0]),
    Math.max(state.roi[0][1], state.roi[1][1]),
  ] : null;
  state.params.regions = state.regions;
  $("#status").textContent = "处理中…";
  try {
    const j = await api(`/api/process/${state.sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: state.params }),
    });
    $("#status").textContent =
      `完成（${j.ms}ms） 小点 ${j.counts.dots} · 疑似断裂 ${j.counts.breaks} 像素 · 阴影残留 ${j.counts.shadow} 像素`;
    drawHistogram($("#hist2"), j.hist_cleaned, { baseline: j.hist_original });
    state.imgVersion = (state.imgVersion || 0) + 1;
    ["cleaned", "inspect", "background"].forEach(k => { delete imgs[k]; });
    render();
  } catch (e) {
    $("#status").textContent = "处理失败: " + e.message;
  }
}

// ------------------------------------------------------------ 画布渲染
const canvas = $("#viewer");
const ctx = canvas.getContext("2d");

function fitZoom() {
  const r = canvas.parentElement.getBoundingClientRect();
  state.zoom = Math.min(r.width / state.imgSize.w, r.height / state.imgSize.h);
  state.pan = {
    x: (r.width - state.imgSize.w * state.zoom) / 2,
    y: (r.height - state.imgSize.h * state.zoom) / 2,
  };
}

function render() {
  if (!state.sid || !state.imgSize) return;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
  ctx.fillStyle = "#1f2125";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const kind = state.view === "inspect" ? "inspect"
    : state.view === "background" ? "background"
    : state.view === "original" ? "original" : "cleaned";
  const img = ensureImage(kind);
  if (img.complete && img.naturalWidth) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, state.pan.x, state.pan.y,
      img.naturalWidth * state.zoom, img.naturalHeight * state.zoom);
  }

  // ROI 框
  if (state.roi) drawRect(state.roi, "#3987e5", 2);
  if (state.drawing && state.mode === "roi") drawRect(state.drawing, "#3987e5", 2);

  // 手绘区域
  state.regions.forEach(reg => {
    drawPolygon(reg.points, reg.mode === "exclude" ? "#eda100" : "#1baf7a");
  });
  if (state.drawing && state.mode === "polygon") {
    drawPolygon(state.drawing, "#1baf7a", false);
  }
}

const imgs = {};
function ensureImage(kind) {
  if (!state.sid) return null;
  if (!imgs[kind] || imgs[kind].dataset.sid !== state.sid) {
    const im = new Image();
    im.dataset.sid = state.sid;
    im.onload = render;
    im.src = imageUrl(kind);
    imgs[kind] = im;
  }
  return imgs[kind];
}

function toCanvasCoords(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}
function toNorm(ev) {
  const c = toCanvasCoords(ev);
  return {
    x: (c.x - state.pan.x) / (state.imgSize.w * state.zoom),
    y: (c.y - state.pan.y) / (state.imgSize.h * state.zoom),
  };
}

function drawRect(rc, color, width) {
  const [p0, p1] = rc;
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.strokeRect(
    state.pan.x + Math.min(p0[0], p1[0]) * state.imgSize.w * state.zoom,
    state.pan.y + Math.min(p0[1], p1[1]) * state.imgSize.h * state.zoom,
    Math.abs(p1[0] - p0[0]) * state.imgSize.w * state.zoom,
    Math.abs(p1[1] - p0[1]) * state.imgSize.h * state.zoom);
}

function drawPolygon(points, color, closed = true) {
  if (points.length < 1) return;
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = state.pan.x + p[0] * state.imgSize.w * state.zoom;
    const y = state.pan.y + p[1] * state.imgSize.h * state.zoom;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  if (closed) ctx.closePath();
  ctx.globalAlpha = 0.9;
  ctx.stroke();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  if (closed) ctx.fill();
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------ 交互
let panning = null;
canvas.addEventListener("mousedown", (ev) => {
  const n = toNorm(ev);
  if (state.mode === "roi") {
    state.drawing = [[n.x, n.y], [n.x, n.y]];
  } else if (state.mode === "polygon") {
    if (!state.drawing) state.drawing = [];
    state.drawing.push([n.x, n.y]);
  } else {
    panning = { ...toCanvasCoords(ev), ...state.pan };
  }
  render();
});

canvas.addEventListener("mousemove", (ev) => {
  if (state.mode === "roi" && state.drawing) {
    const n = toNorm(ev);
    state.drawing[1] = [n.x, n.y];
    render();
  } else if (panning) {
    const c = toCanvasCoords(ev);
    state.pan = { x: panning.x + c.x - panning.x, y: panning.y + c.y - panning.y };
    render();
  }
});

window.addEventListener("mouseup", () => {
  if (state.mode === "roi" && state.drawing) {
    const [p0, p1] = state.drawing;
    if (Math.abs(p1[0] - p0[0]) > 0.01 && Math.abs(p1[1] - p0[1]) > 0.01) {
      state.roi = state.drawing;
    }
    state.drawing = null;
    scheduleProcess();
  }
  panning = null;
  render();
});

canvas.addEventListener("dblclick", () => {
  if (state.mode === "polygon" && state.drawing && state.drawing.length >= 3) {
    const id = "r" + Date.now();
    state.regions.push({
      id, points: state.drawing, mode: $("#region-mode").value,
      gamma: parseFloat($("#region-gamma").value),
      white_target: parseFloat($("#region-wt").value),
      despeckle_size: 0, note: "",
    });
    state.drawing = null;
    refreshRoiList();
    scheduleProcess();
  }
});

canvas.addEventListener("wheel", (ev) => {
  ev.preventDefault();
  const c = toCanvasCoords(ev);
  const nx = (c.x - state.pan.x) / state.zoom;
  const ny = (c.y - state.pan.y) / state.zoom;
  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  state.zoom = Math.max(0.1, Math.min(8, state.zoom * factor));
  state.pan = { x: c.x - nx * state.zoom, y: c.y - ny * state.zoom };
  render();
}, { passive: false });

// ------------------------------------------------------------ 控件
function syncControls() {
  const p = state.params;
  const set = (id, val, fmt) => {
    $(id).value = val;
    const label = $(id + "-v");
    if (label) label.textContent = fmt ? fmt(val) : val;
  };
  set("#bg-scale", p.background_scale, v => parseFloat(v).toFixed(3));
  set("#white-target", p.white_target, v => parseFloat(v).toFixed(0));
  set("#gamma", p.gamma, v => parseFloat(v).toFixed(2));
  $("#despeckle").checked = p.despeckle;
  set("#despeckle-size", p.despeckle_size);
  set("#despeckle-strength", p.despeckle_strength, v => parseFloat(v).toFixed(2));
  set("#ink-th", p.ink_threshold);
  set("#break-dist", p.break_distance, v => parseFloat(v).toFixed(3));
  set("#shadow-th", p.shadow_residual);
}

const bindRange = (id, key, fmt) => {
  const el = $(id);
  el.addEventListener("input", () => {
    state.params[key] = parseFloat(el.value);
    $(id + "-v").textContent = fmt ? fmt(el.value) : el.value;
    scheduleProcess();
  });
};
bindRange("#bg-scale", "background_scale", v => parseFloat(v).toFixed(3));
bindRange("#white-target", "white_target", v => parseFloat(v).toFixed(0));
bindRange("#gamma", "gamma", v => parseFloat(v).toFixed(2));
bindRange("#despeckle-size", "despeckle_size");
bindRange("#despeckle-strength", "despeckle_strength", v => parseFloat(v).toFixed(2));
bindRange("#ink-th", "ink_threshold");
bindRange("#break-dist", "break_distance", v => parseFloat(v).toFixed(3));
bindRange("#shadow-th", "shadow_residual");

$("#despeckle").addEventListener("change", (e) => {
  state.params.despeckle = e.target.checked;
  scheduleProcess();
});

document.querySelectorAll(".view-btn").forEach(b =>
  b.addEventListener("click", () => showImage(b.dataset.view)));
document.querySelectorAll(".tool-btn").forEach(b =>
  b.addEventListener("click", () => {
    state.mode = b.dataset.tool;
    document.querySelectorAll(".tool-btn").forEach(x =>
      x.classList.toggle("active", x === b));
    canvas.style.cursor = state.mode === "pan" ? "grab" : "crosshair";
  }));

$("#clear-roi").addEventListener("click", () => { state.roi = null; scheduleProcess(); });
$("#fit-view").addEventListener("click", () => { fitZoom(); render(); });
$("#reset-params").addEventListener("click", () => {
  state.params = defaultParams();
  state.regions = [];
  refreshRoiList();
  syncControls();
  scheduleProcess();
});

function refreshRoiList() {
  const box = $("#region-list");
  box.innerHTML = "";
  state.regions.forEach((reg, i) => {
    const row = document.createElement("div");
    row.className = "region-row";
    row.innerHTML = `<span class="dot" style="background:${reg.mode === "exclude" ? "#eda100" : "#1baf7a"}"></span>
      区域 ${i + 1}（${reg.mode === "exclude" ? "排除处理" : "单独调整"}）
      <button data-id="${reg.id}" class="mini del">删除</button>`;
    row.querySelector(".del").addEventListener("click", () => {
      state.regions = state.regions.filter(r => r.id !== reg.id);
      refreshRoiList();
      scheduleProcess();
    });
    box.appendChild(row);
  });
}

// ------------------------------------------------------------ 导出 / 批量
$("#export-btn").addEventListener("click", async () => {
  try {
    state.params.regions = state.regions;
    const j = await api(`/api/export/${state.sid}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: state.params }),
    });
    $("#status").innerHTML =
      `已原尺寸导出 ${j.width}×${j.height}：<a href="/api/download/${state.sid}?file=cleaned.full.png">清理图</a>
       · <a href="/api/download/${state.sid}?file=params.json">参数 JSON</a>`;
  } catch (e) { $("#status").textContent = "导出失败: " + e.message; }
});

$("#batch-btn").addEventListener("click", async () => {
  const paths = $("#batch-paths").value.split("\n").map(s => s.trim()).filter(Boolean);
  if (!paths.length) return;
  const outdir = $("#batch-outdir").value.trim() || null;
  $("#status").textContent = "批量处理中…";
  try {
    const j = await api("/api/batch", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, outdir, params: { ...state.params, regions: state.regions } }),
    });
    const r = j.report;
    $("#status").innerHTML = `批量完成：成功 ${r.succeeded.length} 张，失败 ${r.failed.length} 张。输出目录：${j.outdir}`;
    $("#batch-result").innerHTML =
      r.failed.map(f => `<div class="fail">✗ ${f.input}<br><span>${f.error}</span></div>`).join("") ||
      '<div class="ok">全部成功</div>';
  } catch (e) { $("#status").textContent = "批量失败: " + e.message; }
});

// ------------------------------------------------------------ 直方图（单序列，中性蓝）
function drawHistogram(canvasEl, counts, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvasEl.clientWidth || 320, H = canvasEl.clientHeight || 140;
  canvasEl.width = W * dpr; canvasEl.height = H * dpr;
  const c = canvasEl.getContext("2d");
  c.scale(dpr, dpr);
  const pad = { l: 34, r: 10, t: 12, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  c.clearRect(0, 0, W, H);
  c.fillStyle = "#fcfcfb"; c.fillRect(0, 0, W, H);

  const max = Math.max(...counts) * 1.05;
  // 网格 + y 轴
  c.strokeStyle = "#e1e0d9"; c.fillStyle = "#898781";
  c.font = "10px system-ui"; c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ih * i / 4;
    c.beginPath(); c.moveTo(pad.l, y); c.lineTo(W - pad.r, y); c.stroke();
    c.fillText(String(Math.round(max * (4 - i) / 4)), 4, y + 3);
  }
  // 柱：单序列蓝，2px 表面间隙靠宽度收缩实现
  const bw = iw / 256;
  if (opts.baseline) {
    // 清理后直方图：灰线叠加原图基线，便于对比亮度迁移。
    const baseMax = Math.max(...opts.baseline) * 1.05;
    c.fillStyle = "rgba(82,81,78,0.35)";
    opts.baseline.forEach((v, x) => {
      const h2 = ih * (v / baseMax);
      c.fillRect(pad.l + x * bw, pad.t + ih - h2, Math.max(0.5, bw - 0.4), h2);
    });
  }
  counts.forEach((v, x) => {
    const h2 = ih * (v / max);
    c.fillStyle = "#2a78d6";
    c.fillRect(pad.l + x * bw, pad.t + ih - h2, Math.max(0.5, bw - 0.4), h2);
  });
  // x 轴刻度
  [0, 64, 128, 192, 255].forEach(t => {
    c.fillStyle = "#898781";
    c.fillText(String(t), pad.l + iw * t / 255 - 6, H - 7);
  });
  // 参考线：中位数 / 墨阈值
  const marks = [];
  if (opts.median != null) marks.push([opts.median, "#52514e"]);
  if (opts.baseline) marks.push([state.params.ink_threshold, "#e34948"]);
  marks.forEach(([v, color]) => {
    const x = pad.l + iw * v / 255;
    c.strokeStyle = color; c.setLineDash([4, 3]);
    c.beginPath(); c.moveTo(x, pad.t); c.lineTo(x, pad.t + ih); c.stroke();
    c.setLineDash([]);
  });
  // hover 提示
  canvasEl.onmousemove = (ev) => {
    const rect = canvasEl.getBoundingClientRect();
    const bin = Math.floor(((ev.clientX - rect.left - pad.l) / iw) * 256);
    if (bin >= 0 && bin < 256) {
      $("#hist-tip").textContent = `亮度 ${bin}：${counts[bin]} 像素`;
    }
  };
}

// ------------------------------------------------------------ 启动
$("#file-input").addEventListener("change", (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
});
["sample-shadow", "sample-texture"].forEach(id =>
  $("#" + id).addEventListener("click", () =>
    loadSample(id === "sample-shadow" ? "shadow" : "texture")));

window.addEventListener("resize", render);
syncControls();
