/* 本地全景拼接工具前端(原生 JS, 无外部依赖) */
"use strict";

const $ = (id) => document.getElementById(id);

const state = {
  order: [],
  images: {},
  pairs: [],
  feather: 60,
  autoExposure: true,
  render: null,          // {preview, coverage, groups, gains, group_of}
  selectedId: null,
  // 画布视图变换
  view: { scale: 1, tx: 0, ty: 0 },
  showCoverage: true,
  showLabels: true,
  // 交互状态
  panning: null,
  draggingImage: null,
  previewImg: null,
  previewToken: 0,
};

// ------------------------------------------------------------------ API

async function api(path, payload) {
  api._seq = (api._seq || 0) + 1;
  const seq = api._seq;
  const opts = payload === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload) };
  const resp = await fetch(path, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `请求失败 (${resp.status})`);
  // 过期响应(期间又发起了新请求)直接丢弃, 防止旧状态覆盖新状态
  if (seq !== api._seq) {
    const err = new Error("stale response");
    err.stale = true;
    throw err;
  }
  return data;
}

function toast(msg, kind = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 4200);
}

function setStatus(msg) { $("status").textContent = msg; }

function applyState(data) {
  state.order = data.order || [];
  state.images = data.images || {};
  state.pairs = data.pairs || [];
  state.feather = data.feather_px ?? 60;
  state.autoExposure = data.auto_exposure ?? true;
  if (data.render !== undefined) state.render = data.render;
  if (state.selectedId && !state.images[state.selectedId]) {
    state.selectedId = null;
  }
  if (data.detector) $("detector-label").textContent = `特征检测器: ${data.detector}`;
  renderAll();
}

// ------------------------------------------------------------------ 缩略图

function thumbUrl(id) { return `/api/image?id=${encodeURIComponent(id)}&thumb=1`; }

function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  state.order.forEach((id, i) => {
    const meta = state.images[id];
    const div = document.createElement("div");
    div.className = "thumb" + (state.selectedId === id ? " selected" : "");
    div.draggable = true;
    div.dataset.id = id;

    const img = document.createElement("img");
    img.src = thumbUrl(id);
    img.alt = meta.name;
    div.appendChild(img);

    const m = document.createElement("div");
    m.className = "meta";
    m.innerHTML =
      `<span class="idx">${i + 1}</span><span class="name" title="${meta.name}">${meta.name}</span>`;
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.title = "移除这张图";
    rm.textContent = "✕";
    rm.onclick = async (e) => {
      e.stopPropagation();
      await removeImage(id);
    };
    m.appendChild(rm);
    div.appendChild(m);

    // 状态徽标: 所属组 + 相邻匹配状态
    const badges = document.createElement("div");
    badges.className = "badges";
    if (state.render && state.render.group_of) {
      const g = state.render.group_of[id];
      const b = document.createElement("span");
      b.className = "badge group";
      b.textContent = `组 ${g + 1}`;
      badges.appendChild(b);
    }
    state.pairs.forEach((p) => {
      if (p.a !== id && p.b !== id) return;
      const b = document.createElement("span");
      b.className = `badge ${p.ok ? "ok" : "fail"}`;
      b.textContent = p.ok ? `#${p.index + 1} 匹配 ${p.inliers}点` : `#${p.index + 1} 失败`;
      badges.appendChild(b);
    });
    div.appendChild(badges);

    div.onclick = () => selectImage(id);
    bindDragSort(div);
    box.appendChild(div);
  });
}

function bindDragSort(el) {
  el.addEventListener("dragstart", (e) => {
    el.classList.add("dragging");
    e.dataTransfer.setData("text/plain", el.dataset.id);
    e.dataTransfer.effectAllowed = "move";
  });
  el.addEventListener("dragend", () => el.classList.remove("dragging"));
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    el.classList.add("drag-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
  el.addEventListener("drop", async (e) => {
    e.preventDefault();
    el.classList.remove("drag-over");
    const srcId = e.dataTransfer.getData("text/plain");
    const dstId = el.dataset.id;
    if (!srcId || srcId === dstId) return;
    const order = state.order.filter((x) => x !== srcId);
    order.splice(order.indexOf(dstId), 0, srcId);
    setStatus("正在调整顺序…");
    try {
      const data = await api("/api/reorder", { order });
      applyState(data);
      toast("顺序已更新, 相邻匹配已重置, 请重新自动对齐");
    } catch (err) { if (!err.stale) toast(err.message, "error"); }
  });
}

// ------------------------------------------------------------------ 对齐信息

function renderPairs() {
  const box = $("pair-list");
  box.innerHTML = "";
  if (!state.pairs.length) {
    box.innerHTML = '<p class="sub">点击「自动对齐」估计相邻图片的变换关系</p>';
    return;
  }
  state.pairs.forEach((p) => {
    const a = state.images[p.a]?.name || "?";
    const b = state.images[p.b]?.name || "?";
    const item = document.createElement("div");
    item.className = `pair-item ${p.ok ? "ok" : "fail"}`;
    const title = p.ok
      ? `✅ 第 ${p.index + 1} 对: ${a} → ${b}`
      : `❌ 第 ${p.index + 1} 对: ${a} → ${b}`;
    item.innerHTML = `<div class="pair-title">${title}</div>`;
    if (p.ok) {
      const meta = document.createElement("div");
      meta.className = "pair-meta";
      meta.textContent = `可靠匹配 ${p.total_matches} 对, 几何内点 ${p.inliers} 个`;
      item.appendChild(meta);
    } else {
      const reason = document.createElement("div");
      reason.className = "pair-reason";
      reason.textContent = `失败原因: ${p.reason}`;
      item.appendChild(reason);
      const tip = document.createElement("div");
      tip.className = "pair-reason";
      tip.textContent = "可移除其中问题图片后重新对齐; 已成功的分组会保留。";
      item.appendChild(tip);
    }
    item.onclick = () => selectImage(p.b);
    box.appendChild(item);
  });
}

// ------------------------------------------------------------------ 融合面板

function renderFusionPanel() {
  $("feather").value = state.feather;
  $("feather").disabled = state.order.length === 0;
  $("feather-value").textContent = `${state.feather} px`;
  $("auto-exposure").checked = state.autoExposure;
  $("auto-exposure").disabled = state.order.length === 0;

  const list = $("gain-list");
  list.innerHTML = "";
  const gains = state.render?.gains || {};
  state.order.forEach((id) => {
    const meta = state.images[id];
    const row = document.createElement("div");
    row.className = "gain-row";
    row.title = meta.name;
    const name = document.createElement("span");
    name.className = "gname";
    name.textContent = meta.name;
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0.3"; input.max = "2.5"; input.step = "0.01";
    // meta.gain 是服务端保存的手动增益(可能为 null), 否则用当前生效的自动增益
    const cur = (meta.gain !== null && meta.gain !== undefined)
      ? meta.gain : (gains[id] ?? 1);
    input.value = cur;
    const val = document.createElement("span");
    val.className = "gval";
    val.textContent = Number(cur).toFixed(2);
    input.oninput = () => { val.textContent = Number(input.value).toFixed(2); };
    input.onchange = async () => {
      try {
        const data = await api("/api/update-image", { id, gain: Number(input.value) });
        applyState(data);
      } catch (err) { if (!err.stale) toast(err.message, "error"); }
    };
    const reset = document.createElement("button");
    reset.textContent = "自动";
    reset.onclick = async () => {
      try {
        const data = await api("/api/update-image", { id, gain: null });
        applyState(data);
        toast("已恢复自动增益");
      } catch (err) { if (!err.stale) toast(err.message, "error"); }
    };
    row.append(name, input, val, reset);
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ 手动调整

function selectImage(id) {
  state.selectedId = id;
  renderThumbs();
  renderManualPanel();
  drawCanvas();
}

function renderManualPanel() {
  const id = state.selectedId;
  const empty = $("manual-empty");
  const controls = $("manual-controls");
  const target = $("manual-target");
  if (!id) {
    empty.classList.remove("hidden");
    controls.classList.add("hidden");
    target.textContent = "";
    return;
  }
  empty.classList.add("hidden");
  controls.classList.remove("hidden");
  target.textContent = state.images[id]?.name || "";
  const [ox, oy] = state.images[id]?.offset || [0, 0];
  $("off-x").value = ox;
  $("off-y").value = oy;
  $("off-x-value").textContent = `${Math.round(ox)} px`;
  $("off-y-value").textContent = `${Math.round(oy)} px`;
}

async function updateOffset(id, ox, oy) {
  try {
    const data = await api("/api/update-image", {
      id, offset_x: ox, offset_y: oy,
    });
    applyState(data);
  } catch (err) { if (!err.stale) toast(err.message, "error"); }
}

function bindManualControls() {
  const sendSlider = async () => {
    const id = state.selectedId;
    if (!id) return;
    const ox = Number($("off-x").value);
    const oy = Number($("off-y").value);
    $("off-x-value").textContent = `${ox} px`;
    $("off-y-value").textContent = `${oy} px`;
    await updateOffset(id, ox, oy);
  };
  $("off-x").onchange = sendSlider;
  $("off-y").onchange = sendSlider;

  document.querySelectorAll("[data-nudge]").forEach((btn) => {
    btn.onclick = async (e) => {
      const id = state.selectedId;
      if (!id) return;
      const step = e.shiftKey ? 10 : 1;
      const [ox0, oy0] = state.images[id].offset || [0, 0];
      let ox = ox0, oy = oy0;
      switch (btn.dataset.nudge) {
        case "up": oy -= step; break;
        case "down": oy += step; break;
        case "left": ox -= step; break;
        case "right": ox += step; break;
        case "reset": ox = 0; oy = 0; break;
      }
      await updateOffset(id, ox, oy);
    };
  });
}

// ------------------------------------------------------------------ 画布

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

function resizeCanvas() {
  const wrap = $("canvas-wrap");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = `${wrap.clientWidth}px`;
  canvas.style.height = `${wrap.clientHeight}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawCanvas();
}
window.addEventListener("resize", resizeCanvas);

function loadPreview() {
  const url = state.render?.preview;
  if (!url) { state.previewImg = null; drawCanvas(); return; }
  const token = ++state.previewToken;
  const img = new Image();
  img.onload = () => {
    if (token !== state.previewToken) return;  // 已有更新的预览, 丢弃本次
    const firstLoad = !state.previewImg;
    state.previewImg = img;
    drawCanvas();
    if (firstLoad) fitView();
  };
  img.src = url;
}

function fitView() {
  if (!state.previewImg) return;
  const wrap = $("canvas-wrap");
  const pad = 40;
  const sx = (wrap.clientWidth - pad * 2) / state.previewImg.width;
  const sy = (wrap.clientHeight - pad * 2) / state.previewImg.height;
  state.view.scale = Math.min(sx, sy, 1);
  state.view.tx = (wrap.clientWidth - state.previewImg.width * state.view.scale) / 2;
  state.view.ty = (wrap.clientHeight - state.previewImg.height * state.view.scale) / 2;
  drawCanvas();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function screenToCanvas(x, y) {
  return {
    x: (x - state.view.tx) / state.view.scale,
    y: (y - state.view.ty) / state.view.scale,
  };
}

function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect =
      (yi > pt.y) !== (yj > pt.y) &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function hitTest(pt) {
  if (!state.render?.coverage) return null;
  // 后画的在上层, 逆序检测
  for (let k = state.render.coverage.length - 1; k >= 0; k--) {
    const c = state.render.coverage[k];
    if (pointInPolygon(pt, c.polygon)) return c.image_id;
  }
  return null;
}

const GROUP_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

function drawCanvas() {
  const wrap = $("canvas-wrap");
  const w = wrap.clientWidth, h = wrap.clientHeight;
  ctx.clearRect(0, 0, w, h);
  $("empty-hint").style.display = state.order.length ? "none" : "flex";
  $("zoom-label").textContent = state.previewImg
    ? `${Math.round(state.view.scale * 100)}%` : "—";

  if (!state.previewImg) return;
  const { scale, tx, ty } = state.view;
  ctx.save();
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(state.previewImg, 0, 0);

  if (state.showCoverage && state.render?.coverage) {
    state.render.coverage.forEach((c) => {
      const color = GROUP_COLORS[c.group % GROUP_COLORS.length];
      const selected = c.image_id === state.selectedId;
      ctx.beginPath();
      c.polygon.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      ctx.closePath();
      ctx.lineWidth = (selected ? 2.5 : 1.2) / scale;
      ctx.strokeStyle = color;
      ctx.globalAlpha = selected ? 0.95 : 0.7;
      ctx.fillStyle = color;
      ctx.fillRect(c.polygon[0][0], c.polygon[0][1] - 14 / scale, 4 / scale, 14 / scale);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (state.showLabels) {
        const name = state.images[c.image_id]?.name || c.image_id;
        const lx = c.polygon[0][0], ly = c.polygon[0][1] - 4 / scale;
        ctx.font = `${12 / scale}px sans-serif`;
        const tw = ctx.measureText(name).width;
        ctx.fillStyle = "rgba(17,24,39,0.82)";
        ctx.fillRect(lx, ly - 13 / scale, tw + 8 / scale, 16 / scale);
        ctx.fillStyle = "#fff";
        ctx.fillText(name, lx + 4 / scale, ly - 2 / scale);
      }
    });
  }
  ctx.restore();
}

function bindCanvas() {
  canvas.addEventListener("mousedown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const pt = screenToCanvas(sx, sy);
    const hit = state.showCoverage ? hitTest(pt) : null;
    if (hit && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      // 修饰键 + 点击覆盖框: 手动平移这张图
      state.draggingImage = {
        id: hit, startX: sx, startY: sy,
        offset: [...(state.images[hit].offset || [0, 0])],
      };
      selectImage(hit);
      canvas.classList.add("adjustable");
    } else if (hit) {
      selectImage(hit);
      state.panning = { startX: sx, startY: sy, tx: state.view.tx, ty: state.view.ty };
      canvas.classList.add("panning");
    } else {
      state.panning = { startX: sx, startY: sy, tx: state.view.tx, ty: state.view.ty };
      canvas.classList.add("panning");
    }
  });

  window.addEventListener("mousemove", async (e) => {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    if (state.panning) {
      state.view.tx = state.panning.tx + (sx - state.panning.startX);
      state.view.ty = state.panning.ty + (sy - state.panning.startY);
      drawCanvas();
    } else if (state.draggingImage) {
      const d = state.draggingImage;
      const dx = (sx - d.startX) / state.view.scale;
      const dy = (sy - d.startY) / state.view.scale;
      const ox = clamp(d.offset[0] + dx, -5000, 5000);
      const oy = clamp(d.offset[1] + dy, -5000, 5000);
      $("off-x").value = ox;
      $("off-y").value = oy;
      $("off-x-value").textContent = `${Math.round(ox)} px`;
      $("off-y-value").textContent = `${Math.round(oy)} px`;
      if (!bindCanvas._pending) {
        bindCanvas._pending = true;
        requestAnimationFrame(async () => {
          bindCanvas._pending = false;
          const cur = state.draggingImage;
          if (!cur) return;
          // 用当前最新鼠标位移重新计算, 避免排队期间用旧值
          const rect = canvas.getBoundingClientRect();
          const ddx = (sx - cur.startX) / state.view.scale;
          const ddy = (sy - cur.startY) / state.view.scale;
          await updateOffset(
            cur.id,
            clamp(cur.offset[0] + ddx, -5000, 5000),
            clamp(cur.offset[1] + ddy, -5000, 5000),
          );
        });
      }
    }
  });

  window.addEventListener("mouseup", () => {
    state.panning = null;
    state.draggingImage = null;
    canvas.classList.remove("panning", "adjustable");
  });

  canvas.addEventListener("wheel", (e) => {
    if (!state.previewImg) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const newScale = clamp(state.view.scale * factor, 0.05, 12);
    // 以鼠标位置为缩放中心
    const cx = (mx - state.view.tx) / state.view.scale;
    const cy = (my - state.view.ty) / state.view.scale;
    state.view.scale = newScale;
    state.view.tx = mx - cx * newScale;
    state.view.ty = my - cy * newScale;
    drawCanvas();
  }, { passive: false });

  // 双击适应窗口
  canvas.addEventListener("dblclick", fitView);
}

function bindZoomButtons() {
  const zoomBy = (f) => {
    if (!state.previewImg) return;
    const wrap = $("canvas-wrap");
    const cx = wrap.clientWidth / 2, cy = wrap.clientHeight / 2;
    const px = (cx - state.view.tx) / state.view.scale;
    const py = (cy - state.view.ty) / state.view.scale;
    state.view.scale = clamp(state.view.scale * f, 0.05, 12);
    state.view.tx = cx - px * state.view.scale;
    state.view.ty = cy - py * state.view.scale;
    drawCanvas();
  };
  $("btn-zoom-in").onclick = () => zoomBy(1.25);
  $("btn-zoom-out").onclick = () => zoomBy(1 / 1.25);
  $("btn-fit").onclick = fitView;
  $("btn-zoom-100").onclick = () => zoomBy(1 / state.view.scale);
  $("chk-coverage").onchange = (e) => {
    state.showCoverage = e.target.checked; drawCanvas();
  };
  $("chk-labels").onchange = (e) => {
    state.showLabels = e.target.checked; drawCanvas();
  };
}

// ------------------------------------------------------------------ 动作

async function removeImage(id) {
  setStatus("正在移除图片并重新渲染…");
  try {
    const data = await api("/api/remove", { id });
    applyState(data);
    toast("图片已移除, 请重新自动对齐");
  } catch (err) { if (!err.stale) toast(err.message, "error"); }
}

function bindToolbar() {
  $("btn-upload").onclick = () => $("file-input").click();
  $("file-input").onchange = async () => {
    const files = [...$("file-input").files];
    if (!files.length) return;
    await uploadFiles(files);
    $("file-input").value = "";
  };

  $("btn-samples").onclick = async () => {
    setStatus("正在载入演示素材…");
    try {
      const data = await api("/api/load-samples", {});
      applyState(data);
      toast("演示素材已载入(含曝光差与不可匹配图片), 点击「自动对齐」");
    } catch (err) { if (!err.stale) toast(err.message, "error"); }
  };

  $("btn-align").onclick = async () => {
    setStatus("正在估计相邻图片对齐关系…");
    try {
      const data = await api("/api/align", {});
      applyState(data);
      fitView();
      const failed = data.failed_pairs || [];
      if (failed.length) {
        const names = failed.map((f) => `${f.a} → ${f.b}`).join("; ");
        toast(`${failed.length} 对匹配失败: ${names}。其它分组已保留, 可移除问题图片后重算`, "error");
      } else {
        toast("全部相邻图片对齐成功", "success");
      }
    } catch (err) { if (!err.stale) toast(err.message, "error"); }
  };

  $("btn-export-png").onclick = () => { window.location = "/api/export?format=png"; };
  $("btn-export-jpg").onclick = () => { window.location = "/api/export?format=jpeg"; };

  $("btn-save-project").onclick = async () => {
    try {
      const resp = await fetch("/api/project");
      if (!resp.ok) throw new Error((await resp.json()).error);
      const blob = await resp.blob();
      downloadBlob(blob, `panorama_project_${ts()}.json`);
      toast("项目文件已保存(内嵌图片, 可随时重新打开继续调整)", "success");
    } catch (err) { if (!err.stale) toast(err.message, "error"); }
  };

  $("btn-open-project").onclick = () => $("project-input").click();
  $("project-input").onchange = async () => {
    const file = $("project-input").files[0];
    if (!file) return;
    setStatus("正在打开项目…");
    try {
      const resp = await fetch("/api/project/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await file.text()),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error);
      applyState(data);
      fitView();
      toast(`项目已打开: ${file.name}`, "success");
    } catch (err) { if (!err.stale) toast(err.message, "error"); }
    $("project-input").value = "";
  };

  $("btn-reset").onclick = async () => {
    if (!confirm("确定清空当前所有图片与调整?")) return;
    const data = await api("/api/reset", {});
    applyState(data);
    state.selectedId = null;
    state.previewImg = null;
    renderAll();
    toast("已清空");
  };

  $("feather").onchange = async (e) => {
    const data = await api("/api/render", { feather_px: Number(e.target.value) });
    applyState(data);
  };
  $("auto-exposure").onchange = async (e) => {
    const data = await api("/api/render", { auto_exposure: e.target.checked });
    applyState(data);
    toast(e.target.checked ? "已开启自动曝光补偿" : "已关闭自动曝光补偿");
  };
}

async function uploadFiles(files) {
  const form = new FormData();
  files.forEach((f) => form.append("files", f, f.name));
  setStatus(`正在上传 ${files.length} 张图片…`);
  try {
    const resp = await fetch("/api/upload", { method: "POST", body: form });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error);
    applyState(data);
    toast(`已添加 ${files.length} 张图片`);
  } catch (err) { if (!err.stale) toast(err.message, "error"); }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 拖文件到窗口直接上传
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  if (e.target.closest(".thumb")) return;  // 排序拖拽
  e.preventDefault();
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
  if (files.length) uploadFiles(files);
});

// ------------------------------------------------------------------ 总渲染

function renderAll() {
  renderThumbs();
  renderPairs();
  renderFusionPanel();
  renderManualPanel();
  loadPreview();
  const has = state.order.length > 0;
  $("btn-align").disabled = state.order.length < 2;
  $("btn-export-png").disabled = !has;
  $("btn-export-jpg").disabled = !has;
  $("btn-save-project").disabled = !has;
  setStatus(has ? `${state.order.length} 张图片` : "就绪");
}

async function init() {
  bindToolbar();
  bindCanvas();
  bindZoomButtons();
  bindManualControls();
  resizeCanvas();
  try {
    const data = await api("/api/state");
    applyState(data);
    fitView();
  } catch (err) {
    toast(`初始化失败: ${err.message}`, "error");
  }
}
init();
