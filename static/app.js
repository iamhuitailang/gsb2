/* 本地视频防抖工作台前端逻辑(原生 JS, 无外部依赖, 可离线运行) */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const S = {
  session: null,
  frame: 0,
  playing: false,
  playTimer: null,
  previewWidth: 1280,
  showOverlay: true,
  metric: "x",
  paramsVersion: 0,
  frameToken: 0,
  paramsTimer: null,
  chartDrag: null,       // {x0, frame0, frame1}
  chartAction: null,     // {mode:'add', s,e} | {mode:'ex', index}
  lastExportPath: null,
};

/* ============================== 工具 ============================== */

async function api(path, options = {}) {
  const opts = { headers: {}, ...options };
  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 非 json */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `请求失败 (${res.status})`);
  }
  return data;
}

let toastTimer = null;
function toast(msg, type = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast" + (type ? " " + type : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function fmtFrame(f) { return String(Math.round(f)).padStart(4, "0"); }

function setBlobInto(imgEl, blob) {
  const url = URL.createObjectURL(blob);
  const old = imgEl.src;
  imgEl.src = url;
  if (old && old.startsWith("blob:")) URL.revokeObjectURL(old);
}

/* ============================== 任务轮询 ============================== */

async function pollJob(jobId, onUpdate) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const job = await api(`/api/job/${jobId}`);
    if (onUpdate) onUpdate(job);
    if (["done", "error", "cancelled"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 450));
  }
}

async function runOverlayJob(startPromise, title) {
  $("#job-title").textContent = title;
  $("#job-overlay").hidden = false;
  $("#job-fill").style.width = "4%";
  $("#job-msg").textContent = "排队中…";
  let jobId = null;
  try {
    const started = await startPromise;
    jobId = started.job_id;
    window._activeOverlayJob = jobId;
    const job = await pollJob(jobId, (j) => {
      $("#job-fill").style.width = `${Math.max(3, j.progress * 100).toFixed(1)}%`;
      $("#job-msg").textContent = j.message || "处理中…";
    });
    if (job.status === "error") throw new Error(job.error || "任务失败");
    if (job.status === "cancelled") toast("任务已取消");
    return job;
  } finally {
    window._activeOverlayJob = null;
    $("#job-overlay").hidden = true;
  }
}

/* ============================== 示例素材 ============================== */

async function loadSamples() {
  const data = await api("/api/samples");
  const box = $("#sample-list");
  box.innerHTML = "";
  data.samples.forEach((s) => {
    const chip = document.createElement("button");
    chip.className = "sample-chip" + (s.exists ? "" : " missing");
    chip.innerHTML = `<span class="dot"></span>${s.title}` +
      (s.exists ? `<span class="size">${(s.size_kb / 1024).toFixed(1)}MB</span>`
                 : `<span class="size">未生成</span>`);
    chip.title = s.path;
    chip.onclick = async () => {
      try {
        if (!s.exists) {
          await runOverlayJob(api("/api/samples/generate", {
            method: "POST", body: { kind: s.kind },
          }), `正在生成示例：${s.title}`);
          await loadSamples();
        }
        await analyzePath(s.path);
      } catch (e) { toast(e.message, "error"); }
    };
    box.appendChild(chip);
  });
}

$("#btn-gen-samples").onclick = async () => {
  try {
    await runOverlayJob(api("/api/samples/generate", {
      method: "POST", body: { kind: "all" },
    }), "正在生成全部示例短片");
    await loadSamples();
    toast("示例素材已生成到 samples/ 目录", "ok");
  } catch (e) { toast(e.message, "error"); }
};

/* ============================== 打开 / 分析 ============================== */

async function analyzePath(path) {
  if (!path) return;
  stopPlay();
  try {
    await runOverlayJob(api("/api/analyze", { method: "POST", body: { path } }),
      "正在分析画面运动轨迹");
    await refreshSession();
    toast("分析完成", "ok");
  } catch (e) { toast(e.message, "error"); }
}

$("#btn-open-path").onclick = () => analyzePath($("#path-input").value.trim());
$("#path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyzePath($("#path-input").value.trim());
});

/* ============================== 项目 ============================== */

async function loadProjectOptions(selectFile) {
  const data = await api("/api/projects");
  const sel = $("#project-select");
  sel.innerHTML = `<option value="">— 已保存项目 —</option>`;
  data.projects.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = `${p.name}（${p.saved_at || p.file}）`;
    sel.appendChild(opt);
  });
  if (selectFile) sel.value = selectFile;
}

$("#btn-save-project").onclick = async () => {
  if (!S.session) return;
  const def = S.session.video_name || "project";
  const name = window.prompt("保存项目名称（分析数据与全部参数都会写入 projects/）", def);
  if (name === null) return;
  try {
    const r = await api("/api/projects/save", { method: "POST", body: { name } });
    toast(`项目已保存：${r.file}`, "ok");
    await loadProjectOptions(r.file);
    S.session.project_file = r.file;
  } catch (e) { toast(e.message, "error"); }
};

$("#btn-load-project").onclick = async () => {
  const file = $("#project-select").value;
  if (!file) { toast("请先在左侧下拉框选择项目"); return; }
  stopPlay();
  try {
    const job = await runOverlayJob(
      api("/api/projects/load", { method: "POST", body: { file } }),
      "正在载入项目");
    await refreshSession();
    if (job.result && job.result.source_exists === false) {
      toast("项目已载入，但原片文件不存在；参数可查看调整，预览需要原片", "error");
    } else {
      toast("项目已载入", "ok");
    }
  } catch (e) { toast(e.message, "error"); }
};

/* ============================== 会话与控件同步 ============================== */

async function refreshSession() {
  const data = await api("/api/session");
  if (!data.has_session) {
    S.session = null;
    $("#empty-state").hidden = false;
    $("#workspace").hidden = true;
    $("#btn-export-params").disabled = true;
    $("#btn-export-video").disabled = true;
    $("#btn-export-video-2").disabled = true;
    return;
  }
  S.session = data;
  S.frame = clamp(S.frame, 0, data.frame_count - 1);
  if (S.frame === 0) S.frame = 0;

  $("#empty-state").hidden = true;
  $("#workspace").hidden = false;
  // 预览框跟随真实视频宽高比(竖屏素材也能完整显示)
  document.querySelectorAll(".canvas-wrap").forEach((el) => {
    el.style.aspectRatio = `${data.width} / ${data.height}`;
  });
  $("#btn-export-params").disabled = false;
  $("#btn-export-video").disabled = false;
  $("#btn-export-video-2").disabled = false;

  // 走带范围
  const range = $("#frame-range");
  range.max = data.frame_count - 1;
  $("#frame-total").textContent = `/ ${data.frame_count - 1}`;
  $("#frame-input").max = data.frame_count - 1;

  // 参数控件
  const p = data.params;
  $("#rng-strength").value = Math.round(p.strength * 100);
  $("#val-strength").textContent = `${Math.round(p.strength * 100)}%`;
  $("#rng-smooth").value = p.smooth_sec;
  $("#val-smooth").textContent = `${Number(p.smooth_sec).toFixed(2)} s`;
  $("#smooth-frames").textContent =
    `半径约 ${data.radius_frames} 帧 / 窗口约 ${Math.round(p.smooth_sec * data.fps)} 帧`;
  $("#rng-zoom").value = p.crop_zoom;
  $("#val-zoom").textContent = `${Number(p.crop_zoom).toFixed(3)}×`;
  $("#chk-auto-zoom").checked = p.crop_mode === "auto";
  $("#chk-adaptive").checked = !!p.adaptive_pan;
  $("#rng-pan-sens").value = p.pan_sensitivity;
  $("#val-pan-sens").textContent = `${Number(p.pan_sensitivity).toFixed(1)}×`;
  $("#pan-sens-row").style.opacity = p.adaptive_pan ? "1" : ".45";
  $("#chk-overlay").checked = S.showOverlay;

  updateCropInfo(data);
  updateWarnings(data.warnings);
  renderExList();
  renderEventSummary();
  loadProjectOptions(data.project_file || undefined);

  S.paramsVersion++;
  await renderFrame(S.frame);
  drawChart();
}

function updateCropInfo(data) {
  const es = data.effective_source;
  if (es) {
    $("#crop-info").textContent =
      `有效源画幅约 ${es.width} × ${es.height} px（缩放 ${Number(es.zoom).toFixed(3)}×，` +
      `每边裁掉约 ${(100 * (1 - 1 / es.zoom)).toFixed(1)}%）`;
  }
}

function updateWarnings(warnings) {
  const w = (warnings && warnings[0]) || "";
  const el = $("#zoom-warning");
  const badge = $("#badge-blackwarn");
  if (w) {
    el.hidden = false; el.textContent = "⚠ " + w;
    badge.hidden = false;
  } else {
    el.hidden = true; badge.hidden = true;
  }
}

/* ============================== 参数提交(防抖) ============================== */

function collectParams() {
  const p = S.session.params;
  return {
    strength: Number($("#rng-strength").value) / 100,
    smooth_sec: Number($("#rng-smooth").value),
    crop_zoom: Number($("#rng-zoom").value),
    crop_mode: $("#chk-auto-zoom").checked ? "auto" : "manual",
    adaptive_pan: $("#chk-adaptive").checked,
    pan_sensitivity: Number($("#rng-pan-sens").value),
    show_overlay: $("#chk-overlay").checked,
    exclusions: p.exclusions || [],
  };
}

function scheduleParamsPush() {
  // 即时标签反馈
  const strength = Number($("#rng-strength").value);
  $("#val-strength").textContent = `${strength}%`;
  const sec = Number($("#rng-smooth").value);
  $("#val-smooth").textContent = `${sec.toFixed(2)} s`;
  const zoom = Number($("#rng-zoom").value);
  $("#val-zoom").textContent = `${zoom.toFixed(3)}×`;
  $("#val-pan-sens").textContent = `${Number($("#rng-pan-sens").value).toFixed(1)}×`;
  $("#pan-sens-row").style.opacity = $("#chk-adaptive").checked ? "1" : ".45";

  clearTimeout(S.paramsTimer);
  S.paramsTimer = setTimeout(pushParams, 130);
}

async function pushParams() {
  if (!S.session) return;
  const body = collectParams();
  try {
    const data = await api("/api/params", { method: "POST", body });
    S.session.params = data.params;
    S.session.auto_zoom = data.auto_zoom;
    S.session.radius_frames = data.radius_frames;
    S.session.warnings = data.warnings;
    S.session.effective_source = data.effective_source;
    S.session.chart.smoothed = data.chart.smoothed;
    S.session.chart.envelope = data.chart.envelope;

    // 自动裁切可能回填倍数
    if (data.params.crop_mode === "auto") {
      $("#rng-zoom").value = data.params.crop_zoom;
      $("#val-zoom").textContent = `${Number(data.params.crop_zoom).toFixed(3)}×`;
    }
    $("#smooth-frames").textContent =
      `半径约 ${data.radius_frames} 帧 / 窗口约 ${Math.round(data.params.smooth_sec * S.session.fps)} 帧`;
    updateCropInfo(data);
    updateWarnings(data.warnings);
    renderExList();

    S.paramsVersion++;
    renderFrame(S.frame);
    drawChart();
  } catch (e) { toast(e.message, "error"); }
}

["rng-strength", "rng-smooth", "rng-zoom", "rng-pan-sens"].forEach((id) => {
  $("#" + id).addEventListener("input", () => {
    // 用户手动拖裁切条 => 切到手动模式
    if (id === "rng-zoom") $("#chk-auto-zoom").checked = false;
    scheduleParamsPush();
  });
});
$("#chk-adaptive").addEventListener("change", scheduleParamsPush);
$("#chk-auto-zoom").addEventListener("change", () => {
  if ($("#chk-auto-zoom").checked) {
    S.session.params.crop_mode = "auto";
    pushParams();
  } else {
    scheduleParamsPush();
  }
});
$("#btn-auto-zoom").onclick = async () => {
  $("#chk-auto-zoom").checked = true;
  await pushParams();
  toast(`自动裁切倍数 ${S.session.params.crop_zoom.toFixed(3)}×`, "ok");
};
$("#chk-overlay").addEventListener("change", () => {
  S.showOverlay = $("#chk-overlay").checked;
  renderFrame(S.frame);
});
$("#preview-width").addEventListener("change", (e) => {
  S.previewWidth = Number(e.target.value);
  renderFrame(S.frame);
});

/* ============================== 逐帧预览 ============================== */

async function renderFrame(i) {
  if (!S.session) return;
  const n = S.session.frame_count;
  i = clamp(Math.round(i), 0, n - 1);
  S.frame = i;

  $("#frame-range").value = i;
  $("#frame-input").value = i;
  $("#timecode").textContent = fmtTime(i / S.session.fps);

  const excluded = (S.session.params.exclusions || [])
    .some((x) => i >= x.start && i <= x.end);
  $("#badge-excluded").hidden = !excluded;

  const token = ++S.frameToken;
  const q = `i=${i}&w=${S.previewWidth}&overlay=${S.showOverlay ? 1 : 0}&pv=${S.paramsVersion}`;
  try {
    const [bo, bs] = await Promise.all([
      apiBlob(`/api/frame?kind=original&${q}`),
      apiBlob(`/api/frame?kind=stable&${q}`),
    ]);
    if (token !== S.frameToken) return;
    setBlobInto($("#img-original"), bo);
    setBlobInto($("#img-stable"), bs);
    $("#stable-meta").textContent =
      `帧 ${i + 1}/${n} · ${S.session.width}×${S.session.height}`;
    drawChart(); // 当前帧竖线
  } catch (e) {
    if (token === S.frameToken) {
      stopPlay();
      toast(`预览帧加载失败：${e.message}`, "error");
    }
  }
}

async function apiBlob(url) {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.blob();
}

/* ---------- 走带 ---------- */

function stopPlay() {
  S.playing = false;
  if (S.playTimer) { clearTimeout(S.playTimer); S.playTimer = null; }
  $("#btn-play").innerHTML = "▶ 播放";
}

async function playTick() {
  if (!S.playing || !S.session) return;
  if (S.frame >= S.session.frame_count - 1) { stopPlay(); return; }
  const t0 = performance.now();
  await renderFrame(S.frame + 1);
  if (!S.playing) return;
  const frameMs = 1000 / S.session.fps;
  const delay = Math.max(0, frameMs - (performance.now() - t0));
  S.playTimer = setTimeout(playTick, delay);
}

function togglePlay() {
  if (!S.session) return;
  if (S.playing) { stopPlay(); return; }
  if (S.frame >= S.session.frame_count - 1) S.frame = -1; // renderFrame(0)
  S.playing = true;
  $("#btn-play").innerHTML = "⏸ 暂停";
  playTick();
}

$("#btn-play").onclick = togglePlay;
$("#btn-prev").onclick = () => { stopPlay(); renderFrame(S.frame - 1); };
$("#btn-next").onclick = () => { stopPlay(); renderFrame(S.frame + 1); };
$("#btn-first").onclick = () => { stopPlay(); renderFrame(0); };
$("#btn-last").onclick = () => { stopPlay(); renderFrame(S.session.frame_count - 1); };
$("#frame-range").addEventListener("input", (e) => {
  stopPlay();
  renderFrame(Number(e.target.value));
});
$("#frame-input").addEventListener("change", (e) => {
  if (!S.session) return;
  stopPlay();
  renderFrame(Number(e.target.value) || 0);
});

document.addEventListener("keydown", (e) => {
  if (!S.session || $("#workspace").hidden) return;
  const t = e.target;
  const textLike = t && t.matches &&
    t.matches('input[type="text"], input[type="number"], textarea, select');
  if (e.code === "Space") {
    if (textLike) return;
    if (t && t.matches("button")) return; // 让按钮原生 click 处理
    e.preventDefault();
    togglePlay();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (textLike) return;
    e.preventDefault();
    stopPlay();
    renderFrame(S.frame + (e.key === "ArrowRight" ? 1 : -1));
  } else if (e.key === "Home" || e.key === "End") {
    if (textLike) return;
    e.preventDefault();
    stopPlay();
    renderFrame(e.key === "Home" ? 0 : S.session.frame_count - 1);
  }
});

/* ============================== 区间列表 / 事件汇总 ============================== */

function renderExList() {
  if (!S.session) return;
  const list = $("#ex-list");
  const exs = S.session.params.exclusions || [];
  list.innerHTML = "";
  if (!exs.length) {
    const li = document.createElement("li");
    li.className = "ex-empty";
    li.textContent = "暂无标记 —— 可在下方轨迹图拖拽，或使用自动标记。";
    list.appendChild(li);
    return;
  }
  exs.forEach((ex, idx) => {
    const li = document.createElement("li");
    const mid = `<span class="ex-range">#${idx + 1} 帧 ${ex.start}–${ex.end}` +
      `<span class="ex-time">${fmtTime(ex.start / S.session.fps)} – ${fmtTime(ex.end / S.session.fps)}</span></span>`;
    li.innerHTML = mid;
    li.style.cursor = "pointer";
    li.title = "点击跳到区间起点";
    li.onclick = () => { stopPlay(); renderFrame(ex.start); };
    const del = document.createElement("button");
    del.className = "ex-del";
    del.textContent = "✕";
    del.title = "删除该区间";
    del.onclick = async (e) => {
      e.stopPropagation();
      const cur = S.session.params.exclusions.slice();
      cur.splice(idx, 1);
      S.session.params.exclusions = cur;
      await pushParams();
      toast("已删除不处理区间");
    };
    li.appendChild(del);
    list.appendChild(li);
  });
}

function renderEventSummary() {
  if (!S.session) return;
  const c = S.session.chart;
  const exN = (S.session.params.exclusions || []).length;
  $("#event-summary").innerHTML =
    `检测到 <b class="pan">${c.pan_frames.length}</b> 个快速摇摄帧、` +
    `<b class="cut">${c.cut_frames.length}</b> 个镜头切换点` +
    `（帧 ${c.cut_frames.join(", ") || "无"}）；` +
    `当前 <b>${exN}</b> 个不处理区间。切换点两侧已自动平滑回原画面。`;
}

$("#btn-clear-ex").onclick = async () => {
  if (!S.session) return;
  S.session.params.exclusions = [];
  await pushParams();
  toast("已清空全部不处理区间");
};

$("#btn-auto-pan").onclick = async () => {
  if (!S.session) return;
  try {
    const r = await api("/api/exclusions/auto", {
      method: "POST",
      body: { pan: true, cuts: $("#chk-auto-cuts").checked, pad: 12, mode: "merge" },
    });
    S.session.params.exclusions = r.exclusions;
    await refreshSession();
    toast(`已生成 ${r.exclusions.length} 个不处理区间`, "ok");
  } catch (e) { toast(e.message, "error"); }
};

/* ============================== 轨迹图 ============================== */

const chartCanvas = $("#traj-chart");
const ctx = chartCanvas.getContext("2d");
let chartGeom = null;

$$(".chart-tab").forEach((tab) => {
  tab.onclick = () => {
    $$(".chart-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    S.metric = tab.dataset.metric;
    drawChart();
  };
});

function resizeCanvasToDisplay(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const cssH = canvas.height; // 属性 height=210 作为 css 高度
  const h = 210;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: cssW, h };
}

function drawChart() {
  if (!S.session) return;
  const { w: W, h: H } = resizeCanvasToDisplay(chartCanvas);
  const c = ctx;
  c.clearRect(0, 0, W, H);

  const N = S.session.frame_count;
  const ml = 46, mr = 14, mt = 12, mb = 24;
  const pw = W - ml - mr, ph = H - mt - mb;
  const xOf = (f) => ml + (N <= 1 ? 0 : (f / (N - 1)) * pw);
  const frameOfX = (x) => clamp(Math.round(((x - ml) / pw) * (N - 1)), 0, N - 1);
  chartGeom = { ml, mr, mt, mb, pw, ph, W, H, xOf, frameOfX };

  const chart = S.session.chart;
  const metric = S.metric;
  const isAngle = metric === "a";
  const isMotion = metric === "motion";
  const idxMap = { x: 0, y: 1, a: 2 };
  const toVal = (v) => isAngle ? v * 180 / Math.PI : v;

  // 取值
  let raw = [], smooth = [];
  if (isMotion) {
    raw = (chart.motion || []).slice();
  } else {
    const k = idxMap[metric];
    raw = chart.trajectory.map((p) => toVal(p[k]));
    smooth = chart.smoothed.map((p) => toVal(p[k]));
  }

  let lo = Infinity, hi = -Infinity;
  const consider = (arr) => { for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; } };
  consider(raw); if (smooth.length) consider(smooth);
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (isMotion) { lo = 0; hi = Math.max(40, percentile(raw, 0.98) * 1.15); }
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const padv = (hi - lo) * 0.08;
  lo -= padv; hi += padv;
  const yOf = (v) => mt + ph - ((v - lo) / (hi - lo)) * ph;

  // 背景网格 + Y 轴刻度
  c.font = "10.5px ui-monospace, Menlo, monospace";
  c.textBaseline = "middle";
  for (let g = 0; g <= 4; g++) {
    const y = mt + (ph * g) / 4;
    c.strokeStyle = "rgba(255,255,255,.055)";
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(ml, y + .5); c.lineTo(ml + pw, y + .5); c.stroke();
    const val = hi - ((hi - lo) * g) / 4;
    c.fillStyle = "#6b748c";
    c.textAlign = "right";
    c.fillText(formatTick(val, isAngle), ml - 7, y);
  }

  // X 轴时间刻度
  c.textAlign = "center";
  const ticks = 6;
  for (let g = 0; g <= ticks; g++) {
    const f = Math.round(((N - 1) * g) / ticks);
    const x = xOf(f);
    c.fillStyle = "#6b748c";
    c.fillText(fmtTime(f / S.session.fps).slice(0, 5), x, mt + ph + 13);
  }

  // 不处理区间
  (S.session.params.exclusions || []).forEach((ex) => {
    const x1 = xOf(ex.start), x2 = xOf(ex.end);
    c.fillStyle = "rgba(148,163,184,.20)";
    c.fillRect(x1, mt, Math.max(2, x2 - x1), ph);
    c.strokeStyle = "rgba(203,213,225,.55)";
    c.setLineDash([4, 3]); c.lineWidth = 1;
    c.strokeRect(x1 + .5, mt + .5, Math.max(2, x2 - x1), ph - 1);
    c.setLineDash([]);
  });

  // 摇摄帧背景
  c.fillStyle = "rgba(251,146,60,.16)";
  (chart.pan_frames || []).forEach((f) => {
    c.fillRect(xOf(f) - 1, mt, 2, ph);
  });

  // 切换点竖线
  (chart.cut_frames || []).forEach((f) => {
    const x = xOf(f);
    c.strokeStyle = "rgba(244,63,94,.85)";
    c.lineWidth = 1.4;
    c.setLineDash([6, 4]);
    c.beginPath(); c.moveTo(x, mt); c.lineTo(x, mt + ph); c.stroke();
    c.setLineDash([]);
    c.fillStyle = "#f43f5e";
    c.textAlign = "center";
    c.fillText("✂", x, mt + 9);
  });

  // 曲线
  if (isMotion) {
    // 运动量: 渐变填充
    const grad = c.createLinearGradient(0, mt, 0, mt + ph);
    grad.addColorStop(0, "rgba(251,191,36,.5)");
    grad.addColorStop(1, "rgba(251,191,36,.03)");
    c.beginPath();
    raw.forEach((v, i) => { const x = xOf(i), y = yOf(Math.min(v, hi)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.lineTo(xOf(N - 1), mt + ph); c.lineTo(xOf(0), mt + ph); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath();
    raw.forEach((v, i) => { const x = xOf(i), y = yOf(Math.min(v, hi)); i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = "#fbbf24"; c.lineWidth = 1.4; c.stroke();
  } else {
    drawLine(c, raw, xOf, yOf, "#5b657e", 1.2);
    drawLine(c, smooth, xOf, yOf, "#38bdf8", 2.1);
  }

  // 拖拽选区
  if (S.chartDrag) {
    const a = xOf(S.chartDrag.frame0), b = xOf(S.chartDrag.frame1);
    c.fillStyle = "rgba(56,189,248,.18)";
    c.fillRect(Math.min(a, b), mt, Math.abs(b - a), ph);
    c.strokeStyle = "#38bdf8"; c.lineWidth = 1.5;
    c.strokeRect(Math.min(a, b) + .5, mt + .5, Math.abs(b - a), ph - 1);
  }

  // 当前帧线
  const cx = xOf(S.frame);
  c.strokeStyle = "rgba(255,255,255,.9)";
  c.lineWidth = 1.4;
  c.beginPath(); c.moveTo(cx, mt); c.lineTo(cx, mt + ph); c.stroke();
  c.beginPath();
  c.moveTo(cx - 5, mt); c.lineTo(cx + 5, mt); c.lineTo(cx, mt + 6); c.closePath();
  c.fillStyle = "#fff"; c.fill();
}

function drawLine(c, arr, xOf, yOf, color, width) {
  if (!arr.length) return;
  c.beginPath();
  arr.forEach((v, i) => {
    const x = xOf(i), y = yOf(v);
    if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
  });
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineJoin = "round";
  c.stroke();
}

function percentile(arr, q) {
  if (!arr.length) return 1;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function formatTick(v, isAngle) {
  if (isAngle) return `${v.toFixed(1)}°`;
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

/* ---------- 图表指针交互 ---------- */

function pointerFrame(e) {
  const rect = chartCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  return { x, f: chartGeom ? chartGeom.frameOfX(x) : 0 };
}

chartCanvas.addEventListener("pointerdown", (e) => {
  if (!S.session || !chartGeom) return;
  chartCanvas.setPointerCapture(e.pointerId);
  const { x, f } = pointerFrame(e);
  S.chartDrag = { x0: x, frame0: f, frame1: f, moved: false };
  S._downFrame = f;
});

chartCanvas.addEventListener("pointermove", (e) => {
  if (!S.chartDrag) return;
  const { x, f } = pointerFrame(e);
  S.chartDrag.frame1 = f;
  if (Math.abs(x - S.chartDrag.x0) > 5) S.chartDrag.moved = true;
  drawChart();
});

chartCanvas.addEventListener("pointerup", async (e) => {
  if (!S.chartDrag) return;
  const drag = S.chartDrag;
  S.chartDrag = null;
  if (!drag.moved) {
    // 单击: 若点中已有区间 -> 给出删除操作; 否则跳转该帧
    const f = S._downFrame;
    const exIdx = (S.session.params.exclusions || [])
      .findIndex((x) => f >= x.start && f <= x.end);
    if (exIdx >= 0) {
      const ex = S.session.params.exclusions[exIdx];
      showChartAction("ex", { index: exIdx, s: ex.start, e: ex.end });
    } else {
      hideChartAction();
      stopPlay();
      renderFrame(f);
    }
  } else {
    const s = Math.min(drag.frame0, drag.frame1);
    const en = Math.max(drag.frame0, drag.frame1);
    if (en - s >= 1) showChartAction("add", { s, e: en });
  }
  drawChart();
});

function showChartAction(mode, payload) {
  S.chartAction = { mode, ...payload };
  const bar = $("#range-action");
  const txt = $("#range-text");
  const addBtn = $("#btn-range-add");
  bar.hidden = false;
  if (mode === "add") {
    txt.textContent = `已选帧 ${payload.s}–${payload.e}（${fmtTime(payload.s / S.session.fps)}–${fmtTime(payload.e / S.session.fps)}）`;
    addBtn.textContent = "标记为不处理";
    addBtn.style.display = "";
  } else {
    txt.textContent = `区间 #${payload.index + 1}：帧 ${payload.s}–${payload.e}`;
    addBtn.textContent = "删除该区间";
    addBtn.style.display = "";
  }
}
function hideChartAction() {
  S.chartAction = null;
  $("#range-action").hidden = true;
}

$("#btn-range-cancel").onclick = () => { hideChartAction(); drawChart(); };
$("#btn-range-add").onclick = async () => {
  const a = S.chartAction;
  if (!a) return;
  if (a.mode === "add") {
    S.session.params.exclusions.push({ start: a.s, end: a.e, label: "手动标记" });
    toast("已添加不处理区间");
  } else {
    S.session.params.exclusions.splice(a.index, 1);
    toast("已删除区间");
  }
  hideChartAction();
  await pushParams();
};

window.addEventListener("resize", () => drawChart());

/* ============================== 参数文件导出 ============================== */

$("#btn-export-params").onclick = () => {
  if (!S.session) return;
  // 直接走 GET 附件下载
  window.location.href = "/api/params/export";
  toast("正在导出逐帧处理参数 JSON…", "ok");
};

/* ============================== 视频导出 ============================== */

async function startExport() {
  if (!S.session) return;
  const name = $("#export-name").value.trim();
  $("#export-job").hidden = false;
  $("#export-link").hidden = true;
  $("#btn-reveal").hidden = true;
  $("#export-fill").style.width = "2%";
  $("#export-msg").textContent = "准备导出…";
  try {
    const started = await api("/api/export", { method: "POST", body: { name } });
    const job = await pollJob(started.job_id, (j) => {
      $("#export-fill").style.width = `${Math.max(2, j.progress * 100).toFixed(1)}%`;
      $("#export-msg").textContent = j.message || "导出中…";
    });
    if (job.status === "error") throw new Error(job.error);
    if (job.status === "cancelled") { $("#export-msg").textContent = "已取消"; return; }
    $("#export-fill").style.width = "100%";
    $("#export-msg").textContent =
      `导出完成：${job.result.file}` + (job.result.params_sidecar ? "（含同名 .params.json）" : "");
    const link = $("#export-link");
    link.href = job.result.url;
    link.hidden = false;
    S.lastExportPath = job.result.path;
    $("#btn-reveal").hidden = false;
    loadExportHistory();
    toast("视频导出完成，原片未被修改", "ok");
  } catch (e) {
    $("#export-msg").textContent = "导出失败：" + e.message;
    toast(e.message, "error");
  }
}
$("#btn-export-video").onclick = startExport;
$("#btn-export-video-2").onclick = startExport;

$("#btn-reveal").onclick = async () => {
  await api("/api/reveal", { method: "POST", body: { path: S.lastExportPath || "" } });
};

$("#btn-refresh-exports").onclick = async () => {
  const box = $("#export-history");
  box.hidden = !box.hidden;
  if (!box.hidden) await loadExportHistory();
};

async function loadExportHistory() {
  const data = await api("/api/exports");
  const box = $("#export-history");
  box.innerHTML = "";
  if (!data.exports.length) {
    box.innerHTML = `<span class="ex-empty">exports/ 目录还没有文件</span>`;
    return;
  }
  data.exports.forEach((f) => {
    const a = document.createElement("a");
    a.href = f.url;
    a.target = "_blank";
    a.innerHTML = `<span>🎬 ${f.file}</span><span>${f.size_mb} MB</span>`;
    box.appendChild(a);
  });
}

/* ============================== 任务遮罩取消 ============================== */

$("#btn-job-cancel").onclick = async () => {
  // 简化: 刷新页面状态由各 poll 循环感知; 这里只给提示
  toast("任务将在当前帧处理后取消…");
  if (window._activeOverlayJob) {
    try { await api(`/api/job/${window._activeOverlayJob}/cancel`, { method: "POST" }); } catch (_) {}
  }
};

/* ============================== 启动 ============================== */

(async function init() {
  try {
    await loadSamples();
    await loadProjectOptions();
    const s = await api("/api/session");
    if (s.has_session) await refreshSession();
  } catch (e) {
    toast("初始化失败：" + e.message, "error");
  }
})();
