/* Number mask workbench — dependency-free browser logic. */
"use strict";

const $ = (id) => document.getElementById(id);
const EPS = 0.02;
const PALETTE = ["#4da3ff", "#fb923c", "#4ade80", "#f472b6", "#a78bfa", "#facc15", "#2dd4bf"];

function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 8)}${Date.now().toString(16).slice(-4)}`;
}
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function round3(v) {
  return Math.round(Number(v) * 1000) / 1000;
}
function fmtTime(v) {
  return `${Number(v || 0).toFixed(3)}s`;
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function defaultProject() {
  return {
    version: 1,
    app: "number-mask-workbench",
    assetId: "",
    video: { name: "", assetId: "", assetUrl: "", width: 1280, height: 720, duration: 0, fps: 30 },
    settings: { keyInterval: 1, padding: 0, verifyKeyFrames: true },
    targets: [],
    reviews: {},
  };
}

function normalizeProject(input) {
  const p = Object.assign(defaultProject(), input || {});
  p.video = Object.assign(defaultProject().video, input?.video || {});
  p.settings = Object.assign(defaultProject().settings, input?.settings || {});
  p.targets = Array.isArray(input?.targets) ? input.targets : [];
  p.reviews = input?.reviews && typeof input.reviews === "object" ? input.reviews : {};
  p.targets.forEach((t) => {
    t.keyframes = Array.isArray(t.keyframes) ? t.keyframes : [];
    t.gaps = Array.isArray(t.gaps) ? t.gaps : [];
    t.enabled = t.enabled !== false;
    t.opacity = clamp(Number(t.opacity ?? 1), 0.1, 1);
  });
  return p;
}

/* ---------------- Shared trajectory semantics (mirrors core.py) ---------------- */

function sortedKeys(target) {
  return [...(target.keyframes || [])].sort((a, b) => Number(a.t) - Number(b.t));
}
function activeGapAt(target, t) {
  return (target.gaps || []).find((g) => Number(g.start) - EPS <= t && t <= Number(g.end) + EPS);
}
function boxAt(target, t) {
  if (activeGapAt(target, t)) return null;
  const keys = sortedKeys(target);
  if (!keys.length) return null;
  for (const k of keys) if (Math.abs(Number(k.t) - t) <= EPS) return { ...k, mode: "key" };

  let left = null;
  let right = null;
  for (const k of keys) {
    const kt = Number(k.t);
    if (kt < t - EPS) left = k;
    else if (kt > t + EPS && !right) {
      right = k;
      break;
    }
  }
  if (!left || !right) return null;

  const lt = Number(left.t);
  const rt = Number(right.t);
  const crossing = (target.gaps || []).find((g) => {
    const gs = Number(g.start);
    const ge = Number(g.end ?? gs);
    return ge > lt + EPS && gs < rt - EPS;
  });
  if (crossing) {
    const gs = Number(crossing.start);
    const ge = Number(crossing.end ?? gs);
    if (t < gs) return { ...left, mode: "hold-before-gap" };
    if (t > ge) return { ...right, mode: "hold-after-gap" };
    return null;
  }
  const u = clamp((t - lt) / Math.max(0.0001, rt - lt), 0, 1);
  return {
    x: Number(left.x) + (Number(right.x) - Number(left.x)) * u,
    y: Number(left.y) + (Number(right.y) - Number(left.y)) * u,
    w: Number(left.w) + (Number(right.w) - Number(left.w)) * u,
    h: Number(left.h) + (Number(right.h) - Number(left.h)) * u,
    mode: "interpolate",
  };
}

function boxViolations(box) {
  if (!box) return [];
  const x = Number(box.x), y = Number(box.y), w = Number(box.w), h = Number(box.h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return ["invalid"];
  const out = [];
  if (x < -EPS || y < -EPS) out.push("top-left");
  if (x + w > 1 + EPS || y + h > 1 + EPS) out.push("bottom-right");
  return out;
}

function signature(payload) {
  return JSON.stringify(payload);
}

function buildIssues(p) {
  const duration = Math.max(0.1, Number(p.video?.duration) || 10);
  const maxInterval = Math.max(0.2, Number(p.settings?.keyInterval) || 1);
  const frameEps = 0.09;
  const issues = [];
  const add = (i) => issues.push(i);

  for (const target of p.targets || []) {
    const tid = target.id;
    const name = target.name || "未命名目标";
    const keys = sortedKeys(target);
    const base = { targetId: tid, targetName: name, color: target.color || "#4da3ff" };

    if (!keys.length) {
      add({ ...base, id: `no-keys:${tid}`, reviewId: `no-keys:${tid}`, severity: "error", start: 0, end: duration,
        message: `「${name}」还没有任何遮盖关键点`, signature: signature(["no-keys", tid]) });
      continue;
    }

    const first = keys[0], last = keys[keys.length - 1];
    const ft = Number(first.t), lt = Number(last.t);
    if (ft > frameEps) add({ ...base, id: `missing-prefix:${tid}`, reviewId: `missing-prefix:${tid}`, severity: "warning", start: 0, end: ft,
      message: `首个关键点在 ${ft.toFixed(2)}s，之前的片段没有遮盖`, signature: signature(["prefix", tid, ft, first]) });
    if (duration - lt > frameEps) add({ ...base, id: `missing-suffix:${tid}`, reviewId: `missing-suffix:${tid}`, severity: "warning", start: lt, end: duration,
      message: `最后关键点在 ${lt.toFixed(2)}s，之后到片尾没有遮盖`, signature: signature(["suffix", tid, lt, last, duration]) });

    for (const key of keys) {
      const kt = Number(key.t);
      if (boxViolations(key).length) add({ ...base, id: `outside-key:${tid}:${key.id}`, reviewId: `outside-key:${tid}:${key.id}`, severity: "error",
        start: Math.max(0, kt - .2), end: Math.min(duration, kt + .2), time: kt,
        message: `${kt.toFixed(2)}s 的框超出原画面或尺寸无效，导出前需要修正`,
        signature: signature(["outside", tid, key.id, kt, key]) });
    }

    for (const [index, left] of keys.entries()) {
      const right = keys[index + 1];
      if (!right) continue;
      const lt = Number(left.t), rt = Number(right.t), dt = rt - lt;
      const reviewId = `pair:${tid}:${left.id}:${right.id}`;
      const payload = ["pair", tid, left.id, right.id, lt, rt, left, right, target.gaps || []];
      const crossing = (target.gaps || []).find((g) => Number(g.end ?? g.start) > lt + EPS && Number(g.start) < rt - EPS);
      if (crossing) {
        add({ ...base, id: `gap-crossing:${tid}:${left.id}:${right.id}`, reviewId, severity: "info", start: lt, end: rt,
          message: "该补间跨过免遮盖段；导出时不会横扫，段外按最近关键点保持，建议两侧补点", signature: signature(payload) });
      } else if (dt > maxInterval) {
        const move = Math.hypot((Number(left.x) + Number(left.w) / 2) - (Number(right.x) + Number(right.w) / 2),
          (Number(left.y) + Number(left.h) / 2) - (Number(right.y) + Number(right.h) / 2));
        add({ ...base, id: `sparse-pair:${tid}:${left.id}:${right.id}`, reviewId, severity: move > .08 ? "warning" : "info", start: lt, end: rt,
          message: `关键点间隔 ${dt.toFixed(2)}s${move > .08 ? "且位移较大，建议逐帧检查或补点" : "，可逐帧确认"}`, signature: signature(payload) });
      }
    }

    for (const gap of target.gaps || []) {
      const gs = Number(gap.start), ge = Number(gap.end ?? gs);
      add({ ...base, id: `gap:${tid}:${gap.id}`, reviewId: `gap:${tid}:${gap.id}`, severity: "info", start: gs, end: ge,
        message: "免遮盖段：转身 / 遮挡 / 出画时此处不会画框",
        signature: signature(["gap", tid, gap.id, gs, ge, gap.reason || ""]) });
      const nearStart = Math.min(...keys.map((k) => Math.abs(Number(k.t) - gs)));
      const nearEnd = Math.min(...keys.map((k) => Math.abs(Number(k.t) - ge)));
      if (keys.length && (nearStart > .16 || nearEnd > .16)) {
        add({ ...base, id: `gap-boundary:${tid}:${gap.id}`, reviewId: `gap-boundary:${tid}:${gap.id}`, severity: "warning", start: gs, end: ge,
          message: "免遮盖段两端 0.16s 内缺少贴近的关键框，容易在边界漏遮或多盖",
          signature: signature(["gap-boundary", tid, gap.id, gs, ge, keys]) });
      }
    }
  }
  const order = { error: 0, warning: 1, info: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity] || a.start - b.start || a.targetName.localeCompare(b.targetName));
  return issues;
}

function reviewState(issue) {
  const r = state.project.reviews?.[issue.reviewId];
  if (!r?.checked) return { checked: false, stale: false };
  return { checked: true, stale: r.signature !== issue.signature, at: r.at };
}

/* ---------------- State and DOM ---------------- */

const state = {
  project: normalizeProject(null),
  asset: null,
  selectedTargetId: null,
  selectedKeyId: null,
  selectedGapId: null,
  tool: "select",
  showMask: false,
  issueFilter: "open",
  zoomPct: 100,
  interaction: null,
  jobTimer: null,
  lastJobId: null,
  verifyOnlyMasked: false,
  ffmpegOk: true,
};

const video = $("video");
const canvas = $("overlay");
const ctx = canvas.getContext("2d");
let toastTimer = null;

function showToast(message, sticky = false) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = message;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    ...options,
    body: options.body && typeof options.body !== "string" && !(options.body instanceof FormData)
      ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
  return data;
}

function selectedTarget() {
  return state.project.targets.find((t) => t.id === state.selectedTargetId) || null;
}
function selectedKey(target = selectedTarget()) {
  return target?.keyframes.find((k) => k.id === state.selectedKeyId) || null;
}
function duration() {
  return Number(video.duration || state.project.video?.duration || 0);
}
function fps() {
  return Number(state.project.video?.fps) || 30;
}
function frameSnap() {
  return Math.max(EPS, 0.5 / fps());
}

function markDirty() {
  try { localStorage.setItem("mask-workbench-draft", JSON.stringify(state.project)); } catch { /* ignore */ }
}

/* ---------------- Project / asset loading ---------------- */

function loadAsset(asset, project) {
  state.asset = asset;
  if (project) state.project = normalizeProject(project);
  state.project.assetId = asset.assetId || state.project.assetId || "";
  state.project.video = Object.assign({}, state.project.video, {
    assetId: asset.assetId,
    assetUrl: asset.url,
    name: asset.name || state.project.video.name,
    width: asset.width || state.project.video.width,
    height: asset.height || state.project.video.height,
    duration: asset.duration || state.project.video.duration,
    fps: asset.fps || state.project.video.fps,
  });
  if (!state.selectedTargetId && state.project.targets[0]) state.selectedTargetId = state.project.targets[0].id;
  $("emptyState").hidden = true;
  video.src = asset.url;
  video.load();
  markDirty();
  renderAll();
}

video.addEventListener("loadedmetadata", () => {
  const vw = video.videoWidth || state.project.video.width || 1280;
  const vh = video.videoHeight || state.project.video.height || 720;
  canvas.width = vw;
  canvas.height = vh;
  if (!state.project.video.width) state.project.video.width = vw;
  if (!state.project.video.height) state.project.video.height = vh;
  if (!state.project.video.duration) state.project.video.duration = video.duration;
  $("stage").style.aspectRatio = `${vw} / ${vh}`;
  $("fpsInput").value = Math.round(fps() * 1000) / 1000;
  applyZoom();
  renderAll();
  video.currentTime = 0;
});

video.addEventListener("error", () => {
  if (!state.asset) return;
  showToast("浏览器无法直接解码该视频（常见于 MKV/部分 MOV 编码）。可先用 FFmpeg 转为 H.264 MP4；导出引擎仍可能支持原文件。", true);
});

async function generateDemo() {
  const buttons = [$("demoBtn"), $("emptyDemoBtn")];
  buttons.forEach((b) => (b.disabled = true));
  showToast("正在用几何体和虚构编号生成本机演示片…", true);
  try {
    const data = await api("/api/demo", { method: "POST" });
    data.asset.url += `?t=${Date.now()}`;
    loadAsset(data.asset, data.project);
    showToast("演示片已生成：两块牌交叉，蓝牌和绿牌会短时出画。可直接导出或改点练习。");
  } catch (err) {
    showToast(`演示片生成失败：${err.message}`, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function uploadVideo(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/assets?name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) showToast(`正在本机接收视频：${Math.round((e.loaded / e.total) * 100)}%`, true);
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new Error(data.error || `上传失败 ${xhr.status}`));
      } catch (err) { reject(err); }
    };
    xhr.onerror = () => reject(new Error("本机上传失败，请确认服务正在运行"));
    xhr.send(file);
  });
}

async function handleVideoFile(file) {
  if (!file) return;
  if (state.project.targets.length && !confirm("打开新视频会开始新的工程。若当前轨迹还需要保留，请先导出 JSON 配置。继续？")) return;
  try {
    const asset = await uploadVideo(file);
    const p = defaultProject();
    p.video.name = file.name;
    loadAsset(asset, p);
    showToast("视频已在本机打开。选择目标后，用矩形/椭圆工具在画面上拖出第一个关键点。");
  } catch (err) {
    showToast(err.message, true);
  }
}

async function importConfigFile(file) {
  try {
    const text = await file.text();
    const parsed = normalizeProject(JSON.parse(text));
    const url = parsed.video?.assetUrl;
    let asset = null;
    if (url) {
      try {
        const head = await fetch(url, { method: "HEAD" });
        if (head.ok) {
          asset = {
            assetId: parsed.video.assetId || parsed.assetId,
            url,
            name: parsed.video.name,
            width: parsed.video.width,
            height: parsed.video.height,
            duration: parsed.video.duration,
            fps: parsed.video.fps,
          };
        }
      } catch { /* relink below */ }
    }
    if (asset) {
      loadAsset(asset, parsed);
      showToast("配置已导入，并重新连接到本机素材。");
    } else {
      state.project = parsed;
      state.asset = null;
      $("emptyState").hidden = false;
      renderAll();
      showToast("配置已导入。请选择对应的原始视频以重新连接素材并导出。", true);
      $("videoFileInput").click();
    }
  } catch (err) {
    showToast(`配置导入失败：${err.message}`, true);
  }
}

function downloadConfig() {
  if (!state.project.targets.length) showToast("当前还没有目标；仍会导出空白配置。");
  syncSettingsFromInputs();
  state.project.assetId = state.asset?.assetId || state.project.assetId || "";
  state.project.video.assetId = state.project.assetId;
  if (state.asset?.url) state.project.video.assetUrl = state.asset.url;
  if (duration()) state.project.video.duration = duration();
  markDirty();
  const blob = new Blob([JSON.stringify(state.project, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `mask-project-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast("可继续编辑的 JSON 配置已导出。");
}

/* ---------------- Render: targets / properties / gaps ---------------- */

function renderAll() {
  renderTargetList();
  renderProperties();
  renderGapPanel();
  renderIssues();
  renderTimeline();
  updateTransportUI();
  drawOverlay();
  markDirty();
}

function renderTargetList() {
  const el = $("targetList");
  if (!state.project.targets.length) {
    el.innerHTML = `<div class="empty-project">还没有目标。点击右上角“＋ 新目标”，或直接选择画框工具。</div>`;
    return;
  }
  el.innerHTML = state.project.targets.map((t, i) => `
    <div class="target-item ${t.id === state.selectedTargetId ? "is-selected" : ""} ${t.enabled ? "" : "is-off"}"
         data-action="select-target" data-id="${t.id}">
      <span class="swatch" style="background:${escapeHtml(t.color || PALETTE[i % PALETTE.length])}"></span>
      <input class="target-name" value="${escapeHtml(t.name)}" data-action="target-name" data-id="${t.id}" aria-label="目标名称" />
      <span class="target-meta">${t.keyframes.length} 点</span>
      <span class="mini-actions">
        <button class="mini-btn" data-action="toggle-target" data-id="${t.id}" title="${t.enabled ? "暂时停用/隐藏" : "启用"}">${t.enabled ? "👁" : "—"}</button>
        <button class="mini-btn danger" data-action="delete-target" data-id="${t.id}" title="删除此目标">×</button>
      </span>
    </div>`).join("");
}

function renderProperties() {
  const panel = $("propertiesPanel");
  const t = selectedTarget();
  if (!t) {
    panel.innerHTML = `
      <div class="panel-head"><h2>属性与关键帧</h2></div>
      <div class="empty-project">
        选中区域可以命名，并分别管理矩形或椭圆轨迹。<br><br>
        <button class="btn btn-primary" data-action="add-target">＋ 创建第一个遮盖目标</button>
      </div>`;
    return;
  }
  const key = selectedKey(t);
  const keyRows = sortedKeys(t).map((k) => `
    <div class="key-row ${k.id === state.selectedKeyId ? "is-selected" : ""}" data-action="select-key" data-key="${k.id}">
      <span class="key-time">${Number(k.t).toFixed(2)}s</span>
      <span class="key-coords">${(Number(k.x) * 100).toFixed(1)}, ${(Number(k.y) * 100).toFixed(1)} · ${(Number(k.w) * 100).toFixed(1)}×${(Number(k.h) * 100).toFixed(1)}%</span>
      <button class="mini-btn danger" data-action="delete-key" data-key="${k.id}" title="删除关键帧">×</button>
    </div>`).join("");

  panel.innerHTML = `
    <div class="panel-head">
      <h2>属性与关键帧</h2>
      <button class="btn btn-small" data-action="add-key-current">在当前帧加点</button>
    </div>
    <div class="field" style="margin-bottom:9px">
      <label>选中区域名称</label>
      <input data-action="target-name" data-id="${t.id}" value="${escapeHtml(t.name)}" />
    </div>
    <div class="field" style="margin-bottom:9px">
      <label>遮盖形状</label>
      <div class="segmented">
        <button class="seg-btn ${t.shape !== "ellipse" ? "is-active" : ""}" data-action="set-shape" data-shape="rect">矩形</button>
        <button class="seg-btn ${t.shape === "ellipse" ? "is-active" : ""}" data-action="set-shape" data-shape="ellipse">椭圆</button>
      </div>
    </div>
    <div class="form-grid">
      <label>遮盖颜色<input type="color" data-action="target-fill" value="${escapeHtml(t.fill || "#111111")}" /></label>
      <label>不透明度<input type="range" min="0.25" max="1" step="0.05" data-action="target-opacity" value="${Number(t.opacity ?? 1)}" /></label>
    </div>
    ${key ? `
      <div class="prop-row" style="margin:8px 0">
        ${["x", "y", "w", "h"].map((prop) => `
          <label class="field">${prop.toUpperCase()}%
            <input type="number" step="0.5" data-action="key-number" data-key="${key.id}" data-prop="${prop}"
              value="${(Number(key[prop]) * 100).toFixed(2)}" />
          </label>`).join("")}
      </div>` : `<p class="hint">在画面中拖框即可生成关键点；拖动两个关键点之间的补间框会在当前时间自动加点。</p>`}
    <div class="key-list">${keyRows || `<div class="empty-project">暂无关键帧</div>`}</div>
  `;
}

function renderGapPanel() {
  const panel = $("gapPanel");
  const t = selectedTarget();
  if (!t) {
    panel.innerHTML = `<div class="panel-head"><h2>免遮盖段</h2></div><div class="empty-project">请先选择或创建一个目标。</div>`;
    return;
  }
  const rows = (t.gaps || []).map((g) => `
    <div class="gap-row" data-gap="${g.id}">
      <label class="field">起点(s)
        <input type="number" step="0.01" data-action="gap-field" data-gap="${g.id}" data-prop="start" value="${Number(g.start).toFixed(3)}" />
      </label>
      <label class="field">终点(s)
        <input type="number" step="0.01" data-action="gap-field" data-gap="${g.id}" data-prop="end" value="${Number(g.end).toFixed(3)}" />
      </label>
      <button class="mini-btn" data-action="gap-start-current" data-gap="${g.id}" title="起点设为当前帧">[</button>
      <button class="mini-btn" data-action="gap-end-current" data-gap="${g.id}" title="终点设为当前帧">]</button>
      <button class="mini-btn danger" data-action="gap-delete" data-gap="${g.id}" title="删除免遮盖段">×</button>
      <input class="full" style="grid-column:1/-1; border:1px solid var(--border); border-radius:7px; padding:6px 8px"
        data-action="gap-field" data-gap="${g.id}" data-prop="reason" value="${escapeHtml(g.reason || "")}" placeholder="原因：转身 / 被挡住 / 出画" />
    </div>`).join("");
  panel.innerHTML = `
    <div class="panel-head">
      <h2>免遮盖段</h2>
      <button class="btn btn-small" data-action="gap-add">＋ 当前位置添加</button>
    </div>
    ${rows || `<p class="hint">物体短暂被挡或出画时添加一段；该时间段不会绘制或导出遮盖，避免盖住旁边无关区域。</p>`}
  `;
}

function renderIssues() {
  state.issues = buildIssues(state.project);
  const total = state.issues.length;
  const resolved = state.issues.filter((i) => reviewState(i).checked && !reviewState(i).stale).length;
  const errors = state.issues.filter((i) => i.severity === "error").length;
  $("reviewProgress").innerHTML = `
    <span>${errors ? `<b class="danger-text">${errors} 个错误</b> · ` : ""}共 ${total} 个待确认片段</span>
    <span class="progress-pill">${resolved}/${total} 已检查</span>`;

  const filtered = state.issues.filter((issue) => {
    const r = reviewState(issue);
    const done = r.checked && !r.stale;
    if (state.issueFilter === "open") return !done;
    if (state.issueFilter === "checked") return done;
    return true;
  });

  const list = $("issueList");
  if (!filtered.length) {
    list.innerHTML = `<div class="empty-project">${state.issueFilter === "checked" ? "还没有已确认项目。" : "当前筛选下没有遗漏片段。可以切换到“全部”复查。"}</div>`;
    return;
  }
  list.innerHTML = filtered.map((issue) => {
    const r = reviewState(issue);
    return `
    <div class="issue severity-${issue.severity} ${r.checked && !r.stale ? "is-checked" : ""}">
      <div class="issue-top">
        <span class="issue-color" style="background:${escapeHtml(issue.color)}"></span>
        <div>
          <div class="issue-message">${escapeHtml(issue.message)}</div>
          <div class="issue-range">${issue.start.toFixed(2)}s → ${issue.end.toFixed(2)}s · ${escapeHtml(issue.targetName)}</div>
        </div>
      </div>
      <div class="issue-actions">
        <label class="issue-check">
          <input type="checkbox" data-action="review-check" data-review="${escapeHtml(issue.reviewId)}" ${r.checked ? "checked" : ""} />
          已逐帧检查
          ${r.stale ? `<span class="stale">修改后需复查</span>` : ""}
        </label>
        <button class="btn btn-small" data-action="locate-issue" data-review="${escapeHtml(issue.reviewId)}">定位</button>
      </div>
    </div>`;
  }).join("");
}

/* ---------------- Timeline ---------------- */

function renderTimeline() {
  const d = duration();
  const ruler = $("timelineRuler");
  if (!d) {
    ruler.innerHTML = "";
    $("trackList").innerHTML = `<div class="empty-project">载入视频后显示多目标时间轴</div>`;
    return;
  }
  const step = d <= 18 ? 1 : d <= 45 ? 2 : 5;
  let ticks = "";
  for (let t = 0; t <= d + 0.001; t += step) {
    ticks += `<span class="tick" style="left:${(t / d) * 100}%">${Math.round(t)}s</span>`;
  }
  ruler.innerHTML = ticks;

  $("trackList").innerHTML = state.project.targets.map((t) => {
    const gaps = (t.gaps || []).map((g) => {
      const left = (Number(g.start) / d) * 100;
      const width = Math.max(0.4, ((Number(g.end) - Number(g.start)) / d) * 100);
      return `<span class="gap-region" style="left:${left}%;width:${width}%"></span>`;
    }).join("");
    const markers = sortedKeys(t).map((k) => `
      <button class="key-marker ${k.id === state.selectedKeyId ? "is-selected" : ""}"
        data-target="${t.id}" data-key="${k.id}" data-time="${Number(k.t)}"
        style="left:${(Number(k.t) / d) * 100}%;background:${escapeHtml(t.color || "#4da3ff")}"
        title="${Number(k.t).toFixed(3)}s"></button>`).join("");
    return `
      <div class="timeline-track ${t.id === state.selectedTargetId ? "is-selected" : ""}" data-target="${t.id}">
        <span class="track-label">${escapeHtml(t.name)}</span>
        ${gaps}${markers}
      </div>`;
  }).join("");
}

$("timelineRuler").addEventListener("click", (e) => {
  const d = duration();
  if (!d) return;
  const rect = e.currentTarget.getBoundingClientRect();
  seekTo(clamp((e.clientX - rect.left) / rect.width, 0, 1) * d);
});
$("trackList").addEventListener("click", (e) => {
  const marker = e.target.closest(".key-marker");
  if (marker) {
    e.stopPropagation();
    state.selectedTargetId = marker.dataset.target;
    state.selectedKeyId = marker.dataset.key;
    seekTo(Number(marker.dataset.time));
    renderAll();
    return;
  }
  const track = e.target.closest(".timeline-track");
  if (track) {
    state.selectedTargetId = track.dataset.target;
    const rect = track.getBoundingClientRect();
    const d = duration();
    seekTo(clamp((e.clientX - rect.left) / rect.width, 0, 1) * d);
    renderAll();
  }
});

/* ---------------- Transport / zoom ---------------- */

function seekTo(t) {
  const d = duration();
  const next = clamp(Number(t) || 0, 0, d || 0);
  if (isFinite(video.duration)) video.currentTime = next;
  state.project.currentTime = next;
  updateTransportUI();
  drawOverlay();
}
function togglePlay() {
  if (!state.asset) { showToast("请先选择或生成视频。"); return; }
  if (video.paused) video.play().catch((err) => showToast(err.message));
  else video.pause();
}
function stepFrame(direction) {
  if (!state.asset) return;
  video.pause();
  seekTo(video.currentTime + direction / fps());
}
function updateTransportUI() {
  const d = duration();
  const t = Number(video.currentTime || 0);
  const f = fps();
  $("timeLabel").textContent = `${t.toFixed(3)}s / ${d.toFixed(3)}s · 帧 ${Math.round(t * f)}`;
  $("playBtn").textContent = video.paused ? "播放" : "暂停";
  if (document.activeElement !== $("seekBar")) $("seekBar").value = d ? String((t / d) * 1000) : "0";
  const pct = d ? clamp(t / d, 0, 1) : 0;
  $("playhead").style.left = `calc(14px + (100% - 28px) * ${pct})`;
}
function applyZoom() {
  const scroll = $("stageScroll");
  const available = Math.max(280, scroll.clientWidth - 52);
  const width = available * (Number(state.zoomPct) / 100);
  $("stage").style.width = `${width}px`;
  $("stage").style.maxWidth = "none";
  $("zoomRange").value = String(state.zoomPct);
  $("zoomLabel").textContent = `${state.zoomPct}%`;
  drawOverlay();
}
window.addEventListener("resize", applyZoom);

$("playBtn").addEventListener("click", togglePlay);
$("startBtn").addEventListener("click", () => seekTo(0));
$("endBtn").addEventListener("click", () => seekTo(duration()));
$("prevFrameBtn").addEventListener("click", () => stepFrame(-1));
$("nextFrameBtn").addEventListener("click", () => stepFrame(1));
$("seekBar").addEventListener("input", (e) => seekTo((Number(e.target.value) / 1000) * duration()));
$("fpsInput").addEventListener("change", (e) => {
  state.project.video.fps = Math.max(1, Number(e.target.value) || 30);
  markDirty();
});
$("zoomRange").addEventListener("input", (e) => { state.zoomPct = Number(e.target.value); applyZoom(); });
$("zoomInBtn").addEventListener("click", () => { state.zoomPct = clamp(state.zoomPct + 10, 40, 260); applyZoom(); });
$("zoomOutBtn").addEventListener("click", () => { state.zoomPct = clamp(state.zoomPct - 10, 40, 260); applyZoom(); });
$("fitBtn").addEventListener("click", () => { state.zoomPct = 100; applyZoom(); });
$("barsBtn").addEventListener("click", (e) => {
  state.bars = !state.bars;
  $("stage").classList.toggle("test-bars", state.bars);
  e.currentTarget.setAttribute("aria-pressed", String(state.bars));
});

$("beforeViewBtn").addEventListener("click", () => setShowMask(false));
$("afterViewBtn").addEventListener("click", () => setShowMask(true));
function setShowMask(value) {
  state.showMask = value;
  $("beforeViewBtn").classList.toggle("is-active", !value);
  $("afterViewBtn").classList.toggle("is-active", value);
  drawOverlay();
}
document.querySelectorAll("[data-tool]").forEach((btn) => btn.addEventListener("click", () => setTool(btn.dataset.tool)));
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("is-active", b.dataset.tool === tool));
  canvas.classList.toggle("tool-select", tool === "select");
  canvas.style.cursor = tool === "select" ? "default" : "crosshair";
}

/* ---------------- Canvas drawing and direct manipulation ---------------- */

function traceBox(c, box, W, H, shape = "rect") {
  const x = Number(box.x) * W, y = Number(box.y) * H;
  const w = Number(box.w) * W, h = Number(box.h) * H;
  c.beginPath();
  if (shape === "ellipse") {
    c.ellipse(x + w / 2, y + h / 2, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
  } else {
    c.rect(x, y, w, h);
  }
}

function drawOverlay() {
  if (!canvas.width || !canvas.height) return;
  const W = canvas.width, H = canvas.height;
  const u = Math.max(1, W / 1100);
  ctx.clearRect(0, 0, W, H);
  const t = Number(video.currentTime || 0);

  for (const target of state.project.targets) {
    if (target.enabled === false) continue;
    const box = boxAt(target, t);
    if (!box) continue;

    if (state.showMask) {
      ctx.save();
      ctx.globalAlpha = Number(target.opacity ?? 1);
      ctx.fillStyle = target.fill || "#111111";
      traceBox(ctx, box, W, H, target.shape);
      ctx.fill();
      ctx.restore();
    }

    const selected = target.id === state.selectedTargetId;
    ctx.save();
    ctx.lineWidth = (selected ? 2.6 : 1.7) * u;
    ctx.strokeStyle = target.color || "#4da3ff";
    if (!state.showMask || selected) {
      ctx.setLineDash(selected ? [] : [7 * u, 5 * u]);
      traceBox(ctx, box, W, H, target.shape);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (selected) {
      const x = box.x * W, y = box.y * H;
      ctx.font = `600 ${13 * u}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const label = target.name || "未命名";
      const tw = ctx.measureText(label).width + 14 * u;
      const th = 23 * u;
      const ly = Math.max(0, y - th - 2 * u);
      ctx.fillStyle = target.color || "#2563eb";
      ctx.fillRect(x, ly, tw, th);
      ctx.fillStyle = "white";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 7 * u, ly + th / 2 + 1);
      drawHandles(box, u);
    }
    ctx.restore();
  }

  if (state.interaction?.mode === "draw") {
    const rect = draftRect();
    if (rect.w && rect.h) {
      ctx.save();
      ctx.fillStyle = "rgba(37,99,235,.16)";
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 2 * u;
      traceBox(ctx, rect, W, H, state.interaction.shape);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawHandles(box, u) {
  const W = canvas.width, H = canvas.height;
  const points = handlePoints(box);
  const size = 11 * u;
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 1.5 * u;
  Object.values(points).forEach(([nx, ny]) => {
    const x = nx * W, y = ny * H;
    ctx.fillRect(x - size / 2, y - size / 2, size, size);
    ctx.strokeRect(x - size / 2, y - size / 2, size, size);
  });
  ctx.restore();
}
function handlePoints(b) {
  return {
    nw: [b.x, b.y], n: [b.x + b.w / 2, b.y], ne: [b.x + b.w, b.y],
    e: [b.x + b.w, b.y + b.h / 2], se: [b.x + b.w, b.y + b.h],
    s: [b.x + b.w / 2, b.y + b.h], sw: [b.x, b.y + b.h], w: [b.x, b.y + b.h / 2],
  };
}
function eventNorm(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, rect: r };
}
function handleAt(p, box, rect) {
  const tx = 12 / rect.width, ty = 12 / rect.height;
  for (const [name, [x, y]] of Object.entries(handlePoints(box))) {
    if (Math.abs(p.x - x) <= tx && Math.abs(p.y - y) <= ty) return name;
  }
  return null;
}
function pointInBox(p, box) {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
}
function draftRect() {
  const i = state.interaction;
  if (!i || i.mode !== "draw") return {};
  const x = Math.min(i.start.x, i.current.x);
  const y = Math.min(i.start.y, i.current.y);
  return { x, y, w: Math.abs(i.current.x - i.start.x), h: Math.abs(i.current.y - i.start.y), shape: i.shape };
}
function findKeyNear(t, time = Number(video.currentTime)) {
  return sortedKeys(t).find((k) => Math.abs(Number(k.t) - time) <= frameSnap());
}
function upsertKeyAtCurrent(target, box) {
  const time = round3(Number(video.currentTime || 0));
  let key = findKeyNear(target, time);
  if (!key) {
    key = { id: uid("k"), t: time };
    target.keyframes.push(key);
  }
  Object.assign(key, { x: box.x, y: box.y, w: box.w, h: box.h });
  state.selectedKeyId = key.id;
  return key;
}
function ensureKeyForCurrent(target) {
  const existing = findKeyNear(target);
  if (existing) {
    state.selectedKeyId = existing.id;
    return existing;
  }
  const box = boxAt(target, Number(video.currentTime));
  if (!box) return null;
  return upsertKeyAtCurrent(target, { x: box.x, y: box.y, w: box.w, h: box.h });
}

canvas.addEventListener("pointerdown", (e) => {
  if (!state.asset) return;
  const p = eventNorm(e);
  canvas.setPointerCapture?.(e.pointerId);

  if (state.tool.startsWith("draw-")) {
    let target = selectedTarget();
    if (!target) {
      addTarget(false);
      target = selectedTarget();
    }
    target.shape = state.tool === "draw-ellipse" ? "ellipse" : "rect";
    state.interaction = { mode: "draw", targetId: target.id, shape: target.shape, start: { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) }, current: { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) } };
    renderTargetList();
    renderProperties();
    drawOverlay();
    return;
  }

  let target = selectedTarget();
  const t = Number(video.currentTime);
  let box = target ? boxAt(target, t) : null;
  let handle = target && box ? handleAt(p, box, p.rect) : null;

  if (target && handle) {
    state.interaction = { mode: "resize-pending", handle, targetId: target.id, start: p, orig: { x: box.x, y: box.y, w: box.w, h: box.h } };
    drawOverlay();
    return;
  }

  let hit = target && box && pointInBox(p, box) ? target : null;
  if (!hit) {
    for (const candidate of [...state.project.targets].reverse()) {
      if (candidate.enabled === false) continue;
      const b = boxAt(candidate, t);
      if (b && pointInBox(p, b)) { hit = candidate; break; }
    }
  }
  if (hit) {
    state.selectedTargetId = hit.id;
    const hitBox = boxAt(hit, t);
    state.interaction = { mode: "move-pending", targetId: hit.id, start: p, orig: { x: hitBox.x, y: hitBox.y, w: hitBox.w, h: hitBox.h } };
    renderTargetList();
    renderProperties();
  }
  drawOverlay();
});

canvas.addEventListener("pointermove", (e) => {
  const p = eventNorm(e);
  const i = state.interaction;
  if (!i) {
    updateHoverCursor(p);
    return;
  }
  const target = state.project.targets.find((t) => t.id === i.targetId);
  if (!target) return;

  if (i.mode === "draw") {
    i.current = { x: clamp(p.x, 0, 1), y: clamp(p.y, 0, 1) };
    drawOverlay();
    return;
  }

  const dx = p.x - i.start.x, dy = p.y - i.start.y;
  if (i.mode === "move-pending" && Math.hypot(dx, dy) > 0.004) {
    const key = ensureKeyForCurrent(target);
    if (!key) { state.interaction = null; showToast("当前时刻处于免遮盖段或缺少两侧关键点，不能直接移动；请先在可见位置加点。"); return; }
    i.mode = "move";
    i.keyId = key.id;
  }
  if (i.mode === "resize-pending" && Math.hypot(dx, dy) > 0.002) {
    const key = ensureKeyForCurrent(target);
    if (!key) { state.interaction = null; showToast("请先在当前可见帧添加关键框。"); return; }
    i.mode = "resize";
    i.keyId = key.id;
  }

  const key = target.keyframes.find((k) => k.id === i.keyId);
  if (!key) return;
  if (i.mode === "move") {
    key.x = i.orig.x + dx;
    key.y = i.orig.y + dy;
  } else if (i.mode === "resize") {
    Object.assign(key, resizeBox(i.orig, i.handle, dx, dy));
  }
  drawOverlay();
});

canvas.addEventListener("pointerup", (e) => {
  const i = state.interaction;
  if (!i) return;
  if (i.mode === "draw") {
    const r = draftRect();
    const target = state.project.targets.find((t) => t.id === i.targetId);
    if (target && r.w > 0.012 && r.h > 0.012) {
      upsertKeyAtCurrent(target, r);
      showToast("已在当前时点生成关键帧。移动到另一时间后拖框，即可生成补间。");
    }
  } else if ((i.mode === "move" || i.mode === "resize") && i.keyId) {
    const target = state.project.targets.find((t) => t.id === i.targetId);
    const key = target?.keyframes.find((k) => k.id === i.keyId);
    if (key) ["x", "y", "w", "h"].forEach((prop) => (key[prop] = round3(key[prop])));
  }
  state.interaction = null;
  try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
  renderAll();
});

function updateHoverCursor(p) {
  if (state.tool !== "select") { canvas.style.cursor = "crosshair"; return; }
  const t = selectedTarget();
  const box = t ? boxAt(t, Number(video.currentTime)) : null;
  if (box) {
    const handle = handleAt(p, box, p.rect);
    if (handle) {
      const cursors = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
      canvas.style.cursor = cursors[handle] || "pointer";
      return;
    }
    if (pointInBox(p, box)) { canvas.style.cursor = "move"; return; }
  }
  canvas.style.cursor = "default";
}

function resizeBox(o, handle, dx, dy) {
  let { x, y, w, h } = o;
  const min = 0.025;
  if (handle.includes("w")) {
    const nx = Math.min(o.x + dx, o.x + o.w - min);
    w = o.x + o.w - nx; x = nx;
  }
  if (handle.includes("e")) w = Math.max(min, o.w + dx);
  if (handle.includes("n")) {
    const ny = Math.min(o.y + dy, o.y + o.h - min);
    h = o.y + o.h - ny; y = ny;
  }
  if (handle.includes("s")) h = Math.max(min, o.h + dy);
  return { x, y, w, h };
}

/* ---------------- Dynamic UI actions ---------------- */

function addTarget(render = true) {
  const n = state.project.targets.length + 1;
  const target = {
    id: uid("target"),
    name: `目标 ${n}`,
    shape: "rect",
    color: PALETTE[(n - 1) % PALETTE.length],
    fill: "#111111",
    opacity: 1,
    enabled: true,
    keyframes: [],
    gaps: [],
  };
  state.project.targets.push(target);
  state.selectedTargetId = target.id;
  state.selectedKeyId = null;
  if (render) renderAll();
  return target;
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "add-target") addTarget();
  if (action === "select-target" && !e.target.matches("input,button")) {
    state.selectedTargetId = el.dataset.id;
    state.selectedKeyId = null;
    renderAll();
  }
  if (action === "toggle-target") {
    const t = state.project.targets.find((x) => x.id === el.dataset.id);
    t.enabled = !t.enabled; renderAll();
  }
  if (action === "delete-target") {
    const t = state.project.targets.find((x) => x.id === el.dataset.id);
    if (t && confirm(`删除目标「${t.name}」及其全部轨迹？其他目标不受影响。`)) {
      state.project.targets = state.project.targets.filter((x) => x.id !== t.id);
      Object.keys(state.project.reviews).forEach((reviewId) => {
        if (reviewId.includes(t.id)) delete state.project.reviews[reviewId];
      });
      if (state.selectedTargetId === t.id) state.selectedTargetId = state.project.targets[0]?.id || null;
      renderAll();
    }
  }
  if (action === "set-shape") {
    const t = selectedTarget(); t.shape = el.dataset.shape; renderAll();
  }
  if (action === "add-key-current") {
    const t = selectedTarget();
    if (!t) return;
    const fallback = boxAt(t, video.currentTime) || { x: .35, y: .35, w: .25, h: .16 };
    upsertKeyAtCurrent(t, fallback);
    renderAll();
  }
  if (action === "select-key") {
    if (e.target.closest("[data-action='delete-key']")) return;
    const t = selectedTarget();
    const key = t?.keyframes.find((k) => k.id === el.dataset.key);
    if (key) {
      state.selectedKeyId = key.id;
      seekTo(Number(key.t));
      renderAll();
    }
  }
  if (action === "delete-key") {
    e.stopPropagation();
    const t = selectedTarget();
    t.keyframes = t.keyframes.filter((k) => k.id !== el.dataset.key);
    if (state.selectedKeyId === el.dataset.key) state.selectedKeyId = null;
    renderAll();
  }
  if (action === "gap-add") {
    const t = selectedTarget(); if (!t) return;
    const start = round3(video.currentTime || 0);
    const gap = { id: uid("gap"), start, end: round3(Math.min(duration() || start + .5, start + .5)), reason: "" };
    t.gaps.push(gap); state.selectedGapId = gap.id; renderAll();
  }
  if (action === "gap-delete") {
    const t = selectedTarget();
    t.gaps = t.gaps.filter((g) => g.id !== el.dataset.gap); renderAll();
  }
  if (action === "gap-start-current" || action === "gap-end-current") {
    const t = selectedTarget();
    const g = t.gaps.find((x) => x.id === el.dataset.gap);
    if (g) {
      if (action.endsWith("start-current")) g.start = round3(video.currentTime);
      else g.end = round3(video.currentTime);
      if (g.end < g.start) [g.start, g.end] = [g.end, g.start];
      renderAll();
    }
  }
  if (action === "locate-issue" || action === "verify-locate") {
    let time = Number(el.dataset.time);
    if (action === "locate-issue") {
      const issue = state.issues.find((i) => i.reviewId === el.dataset.review);
      if (!issue) return;
      time = issue.time ?? issue.start;
      state.selectedTargetId = issue.targetId;
    }
    seekTo(time);
    renderAll();
  }
  if (action === "next-issue") inspectNextIssue();
});

document.addEventListener("input", (e) => {
  const el = e.target;
  const action = el.dataset?.action;
  if (!action) return;
  const t = el.dataset.id ? state.project.targets.find((x) => x.id === el.dataset.id) : selectedTarget();

  if (action === "target-name" && t) t.name = el.value;
  if (action === "target-fill" && t) t.fill = el.value;
  if (action === "target-opacity" && t) t.opacity = Number(el.value);
  if (action === "key-number") {
    const target = selectedTarget();
    const key = target?.keyframes.find((k) => k.id === el.dataset.key);
    if (key) key[el.dataset.prop] = clamp(Number(el.value) / 100, -1, 2);
  }
  if (action === "gap-field") {
    const target = selectedTarget();
    const gap = target?.gaps.find((g) => g.id === el.dataset.gap);
    if (gap) gap[el.dataset.prop] = el.dataset.prop === "reason" ? el.value : Number(el.value);
  }
  drawOverlay();
  markDirty();
});

document.addEventListener("change", (e) => {
  const el = e.target;
  const action = el.dataset?.action;
  if (!action) return;
  if (action === "review-check") {
    const issue = state.issues.find((i) => i.reviewId === el.dataset.review);
    if (!issue) return;
    if (el.checked) state.project.reviews[issue.reviewId] = { checked: true, at: new Date().toISOString(), signature: issue.signature };
    else delete state.project.reviews[issue.reviewId];
    renderIssues();
    markDirty();
    return;
  }
  if (["target-name", "key-number", "gap-field", "target-fill", "target-opacity"].includes(action)) renderAll();
});

document.querySelectorAll("[data-filter]").forEach((btn) => btn.addEventListener("click", () => {
  state.issueFilter = btn.dataset.filter;
  document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("is-active", b === btn));
  renderIssues();
}));

function inspectNextIssue() {
  const next = state.issues.find((i) => {
    const r = reviewState(i);
    return !(r.checked && !r.stale);
  });
  if (!next) { showToast("所有片段都已确认。可切换到“全部”查看或直接导出。"); return; }
  state.issueFilter = "open";
  document.querySelectorAll("[data-filter]").forEach((b) => b.classList.toggle("is-active", b.dataset.filter === "open"));
  state.selectedTargetId = next.targetId;
  seekTo(next.time ?? next.start);
  renderAll();
  showToast(`已定位：${next.message}。用 , / . 逐帧检查，然后勾选“已逐帧检查”。`, true);
}
$("nextIssueBtn").addEventListener("click", inspectNextIssue);

/* ---------------- Static top buttons / settings ---------------- */

$("addTargetBtn").addEventListener("click", () => addTarget());
$("openVideoBtn").addEventListener("click", () => $("videoFileInput").click());
$("emptyOpenBtn").addEventListener("click", () => $("videoFileInput").click());
$("demoBtn").addEventListener("click", generateDemo);
$("emptyDemoBtn").addEventListener("click", generateDemo);
$("videoFileInput").addEventListener("change", (e) => handleVideoFile(e.target.files[0]));
$("importBtn").addEventListener("click", () => $("configFileInput").click());
$("configFileInput").addEventListener("change", (e) => importConfigFile(e.target.files[0]));
$("exportConfigBtn").addEventListener("click", downloadConfig);
$("exportConfigBtn2").addEventListener("click", downloadConfig);
$("exportVideoBtn").addEventListener("click", startExport);
$("exportVideoBtn2").addEventListener("click", startExport);

function syncSettingsFromInputs() {
  state.project.settings.keyInterval = Number($("intervalInput").value) || 1;
  state.project.settings.padding = Math.max(0, Math.round((Number($("paddingInput").value) || 0) / 2) * 2);
  state.project.settings.verifyKeyFrames = $("verifyInput").checked;
}
$("intervalInput").addEventListener("change", () => { syncSettingsFromInputs(); renderIssues(); });
$("paddingInput").addEventListener("change", syncSettingsFromInputs);
$("verifyInput").addEventListener("change", syncSettingsFromInputs);

/* ---------------- Export jobs and verification ---------------- */

async function startExport() {
  if (!state.asset) { showToast("请先选择或生成要导出的视频。"); return; }
  if (!state.project.targets.length && !confirm("当前还没有任何遮盖目标，导出的视频会与原画面相同。仍要继续吗？")) return;
  syncSettingsFromInputs();
  state.project.assetId = state.asset.assetId;
  state.project.video.assetId = state.asset.assetId;
  state.project.video.assetUrl = state.asset.url;
  state.project.video.duration = duration();
  state.project.video.fps = fps();

  const errors = buildIssues(state.project).filter((i) => i.severity === "error");
  if (errors.length && !confirm(`仍有 ${errors.length} 个错误（例如框超出画面或没有关键点）。仍要继续导出吗？`)) return;

  $("jobStatus").hidden = false;
  $("jobResult").hidden = true;
  $("jobError").hidden = true;
  $("jobBar").style.width = "4%";
  $("jobPercent").textContent = "4%";
  $("jobStage").textContent = "创建导出任务";
  $("jobMessage").textContent = "正在提交到本机 FFmpeg…";
  try {
    const job = await api("/api/export", { method: "POST", body: state.project });
    state.lastJobId = job.jobId;
    pollJob(job.jobId);
  } catch (err) {
    $("jobError").hidden = false;
    $("jobError").textContent = err.message;
    showToast(err.message, true);
  }
}

function pollJob(jobId) {
  clearInterval(state.jobTimer);
  state.jobTimer = setInterval(async () => {
    try {
      const job = await api(`/api/jobs/${jobId}`);
      const pct = Math.round((job.progress || 0) * 100);
      $("jobBar").style.width = `${pct}%`;
      $("jobPercent").textContent = `${pct}%`;
      $("jobStage").textContent = job.stage || "处理中";
      $("jobMessage").textContent = job.message || "";
      if (job.status === "error") {
        clearInterval(state.jobTimer);
        $("jobError").hidden = false;
        $("jobError").textContent = job.error || job.message;
        showToast("导出失败，请查看右侧错误信息。", true);
      }
      if (job.status === "done") {
        clearInterval(state.jobTimer);
        renderExportResult(job);
      }
    } catch (err) {
      clearInterval(state.jobTimer);
      $("jobError").hidden = false;
      $("jobError").textContent = err.message;
    }
  }, 800);
}

function renderExportResult(job) {
  const urls = job.resultUrls;
  $("jobBar").style.width = "100%";
  $("jobPercent").textContent = "100%";
  $("jobStage").textContent = "导出完成";
  $("jobMessage").textContent = `成片、JSON 配置和关键时点验证帧已保存到本机：${urls.directory || ""}`;
  $("jobResult").hidden = false;
  $("resultVideo").href = urls.video;
  $("resultConfig").href = urls.config;
  if (urls.audio) {
    $("resultAudio").hidden = false;
    $("resultAudio").href = urls.audio;
    $("resultAudio").textContent = "独立原始音轨";
  } else {
    $("resultAudio").hidden = true;
  }
  $("revealBtn").onclick = () => api(`/api/jobs/${job.id}/reveal`, { method: "POST" }).catch(() => {});

  const items = job.result?.verification || [];
  if (items.length) {
    $("verifyPanel").hidden = false;
    const base = `/files/exports/${job.id}/`;
    $("verifyList").className = `verify-list ${state.verifyOnlyMasked ? "only-masked" : ""}`;
    $("verifyList").innerHTML = items.map((item) => `
      <div class="verify-item">
        <div class="verify-head">
          <span>${Number(item.time).toFixed(2)}s · ${escapeHtml((item.targets || []).join("、"))}</span>
          <button class="btn btn-small" data-action="verify-locate" data-time="${item.time}">在编辑器定位</button>
        </div>
        <div class="verify-images">
          <figure><img loading="lazy" src="${base}${item.original}" alt="原始关键帧"><figcaption>原始关键帧</figcaption></figure>
          <figure><img loading="lazy" src="${base}${item.masked}" alt="导出成片验证帧"><figcaption>导出成片</figcaption></figure>
        </div>
      </div>`).join("");
  }
  showToast("导出完成：请查看关键时点验证图，确认没有号码边缘露出。");
}

$("toggleVerifyBtn").addEventListener("click", () => {
  state.verifyOnlyMasked = !state.verifyOnlyMasked;
  $("toggleVerifyBtn").textContent = state.verifyOnlyMasked ? "显示原图对比" : "只看成片";
  $("verifyList").classList.toggle("only-masked", state.verifyOnlyMasked);
});

/* ---------------- Keyboard / animation loop ---------------- */

document.addEventListener("keydown", (e) => {
  if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === ",") stepFrame(-1);
  if (e.key === ".") stepFrame(1);
  if (e.key.toLowerCase() === "b") setShowMask(!state.showMask);
  if (e.key.toLowerCase() === "v") setTool("select");
  if (e.key.toLowerCase() === "r") setTool("draw-rect");
  if (e.key.toLowerCase() === "o") setTool("draw-ellipse");
});

function tick() {
  updateTransportUI();
  if (!state.interaction) drawOverlay();
  requestAnimationFrame(tick);
}

/* ---------------- Boot ---------------- */

(function init() {
  try {
    const draft = localStorage.getItem("mask-workbench-draft");
    if (draft) state.project = normalizeProject(JSON.parse(draft));
  } catch { /* ignore corrupt draft */ }

  $("intervalInput").value = state.project.settings.keyInterval;
  $("paddingInput").value = state.project.settings.padding;
  $("verifyInput").checked = state.project.settings.verifyKeyFrames !== false;
  if (state.project.targets[0]) state.selectedTargetId = state.project.targets[0].id;
  renderAll();
  applyZoom();
  requestAnimationFrame(tick);

  api("/api/health").then(async (h) => {
    state.ffmpegOk = !!h.ffmpeg;
    if (!h.ffmpeg) showToast("未检测到 ffmpeg：关键帧编辑和配置导出可用，但 MP4 导出需要先安装 FFmpeg。", true);

    const savedUrl = state.project.video?.assetUrl;
    if (savedUrl && !state.asset) {
      try {
        const head = await fetch(savedUrl, { method: "HEAD" });
        if (head.ok) {
          loadAsset({
            assetId: state.project.video.assetId || state.project.assetId,
            url: savedUrl,
            name: state.project.video.name,
            width: state.project.video.width,
            height: state.project.video.height,
            duration: state.project.video.duration,
            fps: state.project.video.fps,
          }, state.project);
        }
      } catch { /* user can relink manually */ }
    }
  }).catch(() => showToast("本地服务未响应，请通过 ./start.sh 启动。", true));

  if (new URLSearchParams(location.search).get("demo") === "1") {
    generateDemo();
  }
})();
