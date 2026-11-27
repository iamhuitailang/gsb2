/* 表格切格检查工具前端 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const api = async (url, opts = {}) => {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
};

const state = {
  pages: [],
  current: null,          // 图片名
  page: null,             // /api/page 返回
  mode: "inspect",
  mergeStart: null,       // 合并拖拽起点槽位
  hover: null,
  scale: 1,
  mappedGrid: null,       // 拉正网格角点 -> 原图坐标的缓存
  mappedSig: null,        // 缓存对应的网格签名
};

const COLORS = {
  present: "#1f3552",
  absent: "#2e9e5b",
  uncertain: "#d9534f",
  bridge: "#8e5bb5",
  faint: "#e0a800",
  cellFill: "rgba(44,74,112,0.07)",
  cellHover: "rgba(44,74,112,0.18)",
  mergedFill: "rgba(46,158,91,0.10)",
  lowConf: "rgba(217,83,79,0.85)",
};

const canvasOrig = $("#canvas-original");
const canvasDesk = $("#canvas-deskewed");
const ctxO = canvasOrig.getContext("2d");
const ctxD = canvasDesk.getContext("2d");
let imgOrig = null, imgDesk = null;

// ------------------------------------------------------------------ 工具
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  setTimeout(() => t.classList.add("hidden"), 3200);
  t.classList.remove("hidden");
}

function segKey(orientation, a, b) { return `${orientation}:${a},${b}`; }

function segState(grid, orientation, a, b) {
  const ov = grid.overrides[segKey(orientation, a, b)];
  if (ov) return ov;
  const bag = orientation === "h" ? grid.h_segs : grid.v_segs;
  const seg = bag[`${a},${b}`];
  return seg ? seg.state : "present";
}
function segInfo(grid, orientation, a, b) {
  const bag = orientation === "h" ? grid.h_segs : grid.v_segs;
  return bag[`${a},${b}`] || {};
}

// ------------------------------------------------------------------ 页面加载
async function loadPages() {
  const data = await api("/api/pages");
  state.pages = data.pages;
  const ul = $("#page-list");
  ul.innerHTML = "";
  for (const p of state.pages) {
    const li = document.createElement("li");
    li.className = p.name === state.current ? "active" : "";
    const st = p.status === "pending"
      ? `<span class="status-pending">待处理</span>`
      : `<span class="status-ready">就绪</span>`;
    li.innerHTML = `<div>${p.name}</div><div>${st}${
      p.error ? "：" + p.error : ""}</div>`;
    li.onclick = () => openPage(p.name);
    ul.appendChild(li);
  }
}

async function openPage(name) {
  state.current = name;
  const data = await api(`/api/page/${encodeURIComponent(name)}`);
  if (!data.ok) { toast(data.error, true); return; }
  state.page = data;
  state.mergeStart = null;
  await Promise.all([loadImage(canvasOrig, `/api/image/${name}/original`),
                     loadImage(canvasDesk, `/api/image/${name}/deskewed`)]);
  imgOrig = canvasOrig; imgDesk = canvasDesk;
  renderAll();
  loadPages();
}

function loadImage(cv, url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      cv.width = img.naturalWidth;
      cv.height = img.naturalHeight;
      cv._img = img;
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}

// ------------------------------------------------------------------ 渲染
function renderAll() {
  if (!state.page) return;
  state.mappedGrid = null;  // 网格可能已变，作废缓存
  drawDeskewed();
  drawOriginal();
  renderLowConf();
  renderCellTable();
  $("#lc-count").textContent = state.page.grid.low_confidence.length;
}

function cellAtSlot(grid, r, c) {
  return grid.cells.find(cell =>
    cell.anchor[0] <= r && r <= cell.anchor[0] + cell.span[0] - 1 &&
    cell.anchor[1] <= c && c <= cell.anchor[1] + cell.span[1] - 1);
}

function drawDeskewed() {
  const g = state.page.grid;
  ctxD.clearRect(0, 0, canvasDesk.width, canvasDesk.height);
  ctxD.drawImage(canvasDesk._img, 0, 0);
  const { xs, ys } = g;

  // 格子填充
  for (const cell of g.cells) {
    const x0 = xs[cell.anchor[1]], y0 = ys[cell.anchor[0]];
    const x1 = xs[cell.anchor[1] + cell.span[1]];
    const y1 = ys[cell.anchor[0] + cell.span[0]];
    const merged = cell.span[0] > 1 || cell.span[1] > 1;
    ctxD.fillStyle = merged ? COLORS.mergedFill : COLORS.cellFill;
    ctxD.fillRect(x0, y0, x1 - x0, y1 - y0);
    if (cell.confidence === "low") {
      ctxD.strokeStyle = COLORS.lowConf;
      ctxD.lineWidth = 2;
      ctxD.setLineDash([6, 4]);
      ctxD.strokeRect(x0 + 2, y0 + 2, x1 - x0 - 4, y1 - y0 - 4);
      ctxD.setLineDash([]);
    }
    ctxD.fillStyle = "#1f3552";
    ctxD.font = "12px ui-monospace, monospace";
    ctxD.fillText(cell.code, x0 + 5, y0 + 15);
  }

  // 横线逐段
  for (let iy = 0; iy < ys.length; iy++) {
    for (let j = 0; j < xs.length - 1; j++) {
      drawSeg(ctxD, "h", iy, j, xs[j], ys[iy], xs[j + 1], ys[iy], g);
    }
  }
  // 竖线逐段
  for (let i = 0; i < ys.length - 1; i++) {
    for (let jx = 0; jx < xs.length; jx++) {
      drawSeg(ctxD, "v", i, jx, xs[jx], ys[i], xs[jx], ys[i + 1], g);
    }
  }

  // 合并拖拽预览
  if (state.mode === "merge" && state.mergeStart && state.hover) {
    const a = state.mergeStart, b = state.hover;
    const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
    const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
    ctxD.strokeStyle = "#e07b00";
    ctxD.lineWidth = 3;
    ctxD.strokeRect(xs[c0], ys[r0], xs[c1 + 1] - xs[c0], ys[r1 + 1] - ys[r0]);
  }
}

function drawSeg(ctx, orientation, a, b, x0, y0, x1, y1, g) {
  const st = segState(g, orientation, a, b);
  const info = segInfo(g, orientation, a, b);
  const overridden = g.overrides[segKey(orientation, a, b)];
  ctx.lineWidth = 2;
  if (st === "present") {
    ctx.strokeStyle = info.faint ? COLORS.faint : COLORS.present;
    ctx.setLineDash(info.bridged ? [10, 5] : []);
  } else if (st === "absent") {
    ctx.strokeStyle = COLORS.absent;
    ctx.setLineDash([3, 6]);
  } else {
    ctx.strokeStyle = COLORS.uncertain;
    ctx.setLineDash([8, 4]);
  }
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.setLineDash([]);
  if (overridden) {
    // 手工覆写加圆点标记
    ctx.fillStyle = st === "absent" ? COLORS.absent : COLORS.present;
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    ctx.beginPath();
    ctx.arc(mx, my, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

async function drawOriginal() {
  const g = state.page.grid;
  ctxO.clearRect(0, 0, canvasOrig.width, canvasOrig.height);
  ctxO.drawImage(canvasOrig._img, 0, 0);
  // 拉正网格角点 -> 原图坐标（批量，且按网格签名缓存）
  const sig = JSON.stringify([g.xs, g.ys]);
  if (!state.mappedGrid || state.mappedSig !== sig) {
    const pts = [];
    for (const y of g.ys) for (const x of g.xs) pts.push([x, y]);
    const r = await api(`/api/page/${encodeURIComponent(state.current)}/map-points`, {
      method: "POST",
      body: JSON.stringify({ points: pts, direction: "r2o" }),
    });
    state.mappedGrid = r.points.map(([x, y]) => ({ x, y }));
    state.mappedSig = sig;
  }
  const mapped = state.mappedGrid;
  const idx = (iy, jx) => iy * g.xs.length + jx;

  // 格子外轮廓（映射后为四边形）
  for (const cell of g.cells) {
    const [r0, c0] = cell.anchor;
    const r1 = r0 + cell.span[0], c1 = c0 + cell.span[1];
    const quad = [mapped[idx(r0, c0)], mapped[idx(r0, c1)],
                  mapped[idx(r1, c1)], mapped[idx(r1, c0)]];
    ctxO.strokeStyle = cell.confidence === "low"
      ? COLORS.lowConf : "rgba(44,74,112,0.9)";
    ctxO.lineWidth = 1.5;
    ctxO.beginPath();
    ctxO.moveTo(quad[0].x, quad[0].y);
    for (const q of quad.slice(1)) ctxO.lineTo(q.x, q.y);
    ctxO.closePath();
    ctxO.stroke();
  }
  // 悬停格高亮
  if (state.hover) {
    const cell = cellAtSlot(g, state.hover.r, state.hover.c);
    if (cell) {
      const [r0, c0] = cell.anchor;
      const r1 = r0 + cell.span[0], c1 = c0 + cell.span[1];
      const quad = [mapped[idx(r0, c0)], mapped[idx(r0, c1)],
                    mapped[idx(r1, c1)], mapped[idx(r1, c0)]];
      ctxO.fillStyle = COLORS.cellHover;
      ctxO.beginPath();
      ctxO.moveTo(quad[0].x, quad[0].y);
      for (const q of quad.slice(1)) ctxO.lineTo(q.x, q.y);
      ctxO.closePath();
      ctxO.fill();
    }
  }
}

// ------------------------------------------------------------------ 坐标拾取
function eventPos(canvas, ev) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left) * (canvas.width / rect.width),
    y: (ev.clientY - rect.top) * (canvas.height / rect.height),
  };
}

function slotAt(x, y) {
  const g = state.page.grid;
  const { xs, ys } = g;
  if (x < xs[0] || x > xs[xs.length - 1] || y < ys[0] || y > ys[ys.length - 1])
    return null;
  let c = 0;
  while (c < xs.length - 2 && x > xs[c + 1]) c++;
  let r = 0;
  while (r < ys.length - 2 && y > ys[r + 1]) r++;
  return { r, c };
}

function nearestEdge(x, y, orientation) {
  const g = state.page.grid;
  const { xs, ys } = g;
  if (orientation === "h") {
    let iy = 0, best = Infinity;
    ys.forEach((v, i) => {
      if (Math.abs(v - y) < best) { best = Math.abs(v - y); iy = i; }
    });
    if (best > 8) return null;
    let j = 0;
    while (j < xs.length - 2 && x > xs[j + 1]) j++;
    return { a: iy, b: j };
  }
  let jx = 0, best = Infinity;
  xs.forEach((v, i) => {
    if (Math.abs(v - x) < best) { best = Math.abs(v - x); jx = i; }
  });
  if (best > 8) return null;
  let i = 0;
  while (i < ys.length - 2 && y > ys[i + 1]) i++;
  return { a: i, b: jx };
}

// ------------------------------------------------------------------ 画布交互
canvasDesk.addEventListener("mousemove", (ev) => {
  if (!state.page) return;
  const p = eventPos(canvasDesk, ev);
  const slot = slotAt(p.x, p.y);
  state.hover = slot;
  drawDeskewed();
  drawOriginal();
  updateInfo(p, slot);
});

canvasDesk.addEventListener("click", async (ev) => {
  if (!state.page) return;
  const p = eventPos(canvasDesk, ev);
  const g = state.page.grid;

  if (state.mode === "edge") {
    // 靠近线则切换该边段；否则提示
    const nearH = nearestEdge(p.x, p.y, "h");
    const nearV = nearestEdge(p.x, p.y, "v");
    let pick = null;
    if (nearH && nearV) {
      pick = Math.abs(g.ys[nearH.a] - p.y) < Math.abs(g.xs[nearV.b] - p.x)
        ? { orientation: "h", ...nearH } : { orientation: "v", ...nearV };
    } else if (nearH) pick = { orientation: "h", ...nearH };
    else if (nearV) pick = { orientation: "v", ...nearV };
    if (!pick) { toast("请点击靠近框线的位置"); return; }
    const r = await api(`/api/page/${state.current}/edge`, {
      method: "POST",
      body: JSON.stringify({ orientation: pick.orientation, a: pick.a, b: pick.b }),
    });
    if (r.ok) { state.page.grid = r.grid; renderAll(); toast("边段状态已切换"); }
    return;
  }

  if (state.mode === "add-v" || state.mode === "add-h") {
    const orientation = state.mode === "add-v" ? "v" : "h";
    const pos = orientation === "v" ? p.x : p.y;
    const r = await api(`/api/page/${state.current}/line/add`, {
      method: "POST",
      body: JSON.stringify({ orientation, pos }),
    });
    if (r.ok) { state.page.grid = r.grid; renderAll(); toast("已新增分隔线"); }
    return;
  }

  const slot = slotAt(p.x, p.y);
  if (!slot) return;

  if (state.mode === "merge") {
    if (!state.mergeStart) {
      state.mergeStart = slot;
      $("#hint").textContent = `起点 R${slot.r + 1}C${slot.c + 1}，再点终点格`;
    } else {
      const a = state.mergeStart, b = slot;
      const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
      const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
      const r = await api(`/api/page/${state.current}/merge`, {
        method: "POST",
        body: JSON.stringify({ r0, r1, c0, c1 }),
      });
      state.mergeStart = null;
      $("#hint").textContent = modeHint();
      if (r.ok) { state.page.grid = r.grid; renderAll(); toast("合并范围已确认"); }
    }
    return;
  }

  if (state.mode === "unmerge") {
    const r = await api(`/api/page/${state.current}/merge`, {
      method: "POST",
      body: JSON.stringify({ r0: slot.r, r1: slot.r, c0: slot.c, c1: slot.c, unmerge: true }),
    });
    if (r.ok) { state.page.grid = r.grid; renderAll(); toast("已拆开合并格"); }
    return;
  }

  // inspect：点格显示信息
  const cell = cellAtSlot(g, slot.r, slot.c);
  if (cell) showCellDetail(cell);
});

// 原图上点击 -> 映射到拉正图并定位槽位
canvasOrig.addEventListener("click", async (ev) => {
  if (!state.page || state.mode !== "inspect") return;
  const p = eventPos(canvasOrig, ev);
  const r = await api(`/api/page/${state.current}/map-point`, {
    method: "POST",
    body: JSON.stringify({ x: p.x, y: p.y, direction: "o2r" }),
  });
  const slot = slotAt(r.x, r.y);
  if (slot) {
    state.hover = slot;
    drawDeskewed(); drawOriginal();
    const cell = cellAtSlot(state.page.grid, slot.r, slot.c);
    if (cell) showCellDetail(cell);
    $("#coord-info").textContent =
      `原图(${p.x.toFixed(0)},${p.y.toFixed(0)}) → 拉正(${r.x.toFixed(0)},${r.y.toFixed(0)})`;
  }
});

function updateInfo(p, slot) {
  if (!slot) { $("#cell-info").textContent = "未选择格子"; return; }
  const cell = cellAtSlot(state.page.grid, slot.r, slot.c);
  if (cell) {
    const merged = cell.span[0] > 1 || cell.span[1] > 1;
    $("#cell-info").textContent =
      `${cell.code}  跨度 ${cell.span[0]}行×${cell.span[1]}列  可信度 ${cell.confidence}` +
      (merged ? "  [合并]" : "");
  }
}

function showCellDetail(cell) {
  const g = state.page.grid;
  const x0 = g.xs[cell.anchor[1]], y0 = g.ys[cell.anchor[0]];
  const x1 = g.xs[cell.anchor[1] + cell.span[1]];
  const y1 = g.ys[cell.anchor[0] + cell.span[0]];
  $("#cell-info").innerHTML =
    `<b>${cell.code}</b> 行${cell.anchor[0] + 1}-${cell.anchor[0] + cell.span[0]} ` +
    `列${cell.anchor[1] + 1}-${cell.anchor[1] + cell.span[1]} ` +
    `矩形(${x0.toFixed(0)},${y0.toFixed(0)})-(${x1.toFixed(0)},${y1.toFixed(0)}) ` +
    `可信度 ${cell.confidence} ${cell.notes.length ? "｜" + cell.notes.join("；") : ""}`;
}

// ------------------------------------------------------------------ 低可信清单
function renderLowConf() {
  const ul = $("#lc-list");
  ul.innerHTML = "";
  for (const item of state.page.grid.low_confidence) {
    const li = document.createElement("li");
    li.className = "lc-item";
    const label = item.orientation === "h"
      ? `横线${item.line + 1} 列段${item.seg + 1}`
      : `竖线${item.line + 1} 行段${item.seg + 1}`;
    li.innerHTML = `<div>${label} <span class="status-pending">${item.state}</span></div>
      <span class="lc-reason">${item.reason || ""}</span>`;
    li.onclick = async () => {
      // 点低可信项 -> 切到边段模式并直接切换该边
      setMode("edge");
      const r = await api(`/api/page/${state.current}/edge`, {
        method: "POST",
        body: JSON.stringify({ orientation: item.orientation, a: item.line, b: item.seg }),
      });
      if (r.ok) { state.page.grid = r.grid; renderAll(); toast("已采纳人工判定"); }
    };
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ 格子表
function renderCellTable() {
  const g = state.page.grid;
  const head = $("#cell-table-head");
  const body = $("#cell-table-body");
  head.innerHTML = "<th>行＼列</th>" +
    Array.from({ length: g.n_cols }, (_, c) => `<th>C${c + 1}</th>`).join("");
  body.innerHTML = "";
  for (let r = 0; r < g.n_rows; r++) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<th>R${r + 1}</th>`;
    for (let c = 0; c < g.n_cols; c++) {
      const td = document.createElement("td");
      const cell = cellAtSlot(g, r, c);
      const isAnchor = cell && cell.anchor[0] === r && cell.anchor[1] === c;
      if (!cell) {
        td.className = "slot-missing";
        td.textContent = "缺图";
      } else if (!isAnchor) {
        td.className = "slot-merged";
        td.textContent = `并入 ${cell.code}`;
      } else {
        td.className = "cell-anchor conf-" + cell.confidence;
        const merged = cell.span[0] > 1 || cell.span[1] > 1;
        td.innerHTML = `${cell.code}` +
          (merged ? `<span class="tag tag-merge">${cell.span[0]}×${cell.span[1]}</span>` : "") +
          (cell.is_blank ? `<span class="tag tag-blank">空白</span>` : "");
        td.onclick = () => { state.hover = { r, c }; drawDeskewed(); drawOriginal(); showCellDetail(cell); };
      }
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ------------------------------------------------------------------ 模式
function modeHint() {
  return {
    inspect: "查看模式：悬停联动两图，点击格子看详情",
    edge: "边段模式：点击框线在 实线/无边 间切换，绿虚线=合并无边，红虚线=待确认",
    "add-v": "在点击位置增加一条竖分隔线",
    "add-h": "在点击位置增加一条横分隔线",
    merge: "依次点击起点格和终点格，确认矩形合并范围",
    unmerge: "点击合并格内任意位置将其拆开",
  }[state.mode];
}
function setMode(m) {
  state.mode = m;
  state.mergeStart = null;
  document.querySelectorAll("#mode-group button").forEach(b =>
    b.classList.toggle("active", b.dataset.mode === m));
  $("#hint").textContent = modeHint();
}
document.querySelectorAll("#mode-group button").forEach(b =>
  b.onclick = () => setMode(b.dataset.mode));

// ------------------------------------------------------------------ 顶部按钮
$("#btn-generate").onclick = async () => {
  const seed = Math.floor(Math.random() * 100000);
  const r = await api("/api/generate", {
    method: "POST",
    body: JSON.stringify({ seed }),
  });
  if (r.ok) {
    toast(r.status === "pending" ? `已生成但待处理：${r.error}` : `已生成 ${r.name}`);
    await loadPages();
    if (r.status !== "pending") await openPage(r.name);
  } else toast(r.error, true);
};

$("#file-upload").onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("image", f);
  const res = await fetch("/api/upload", { method: "POST", body: fd });
  const r = await res.json();
  await loadPages();
  if (r.status === "pending") toast(`已加入待处理：${r.error}`, true);
  else { toast(`已打开 ${r.name}`); await openPage(r.name); }
  ev.target.value = "";
};

$("#btn-export").onclick = async () => {
  if (!state.current) return toast("请先选择页面", true);
  const r = await api(`/api/page/${state.current}/export`, { method: "POST" });
  if (r.ok) toast(`已导出 ${r.n_cells} 格（空白 ${r.n_blank}）→ ${r.manifest}`);
  else toast(r.error, true);
};

$("#btn-batch").onclick = async () => {
  const r = await api("/api/batch-export", { method: "POST" });
  const lines = r.results.map(x => x.skipped
    ? `跳过 ${x.name}（${x.reason}）`
    : x.ok ? `${x.name}: ${x.n_cells} 格` : `${x.name} 失败: ${x.error}`);
  toast(lines.join("　｜　") || "没有可导出的页面");
};

$("#btn-verify").onclick = async () => {
  if (!state.current) return toast("请先选择合成图页面", true);
  const r = await api(`/api/page/${state.current}/verify`);
  if (!r.ok) return toast(r.error, true);
  const failed = r.checks.filter(c => !c.passed);
  if (r.ok) {
    const ce = r.crop_error_px || {};
    toast(`自检通过：${r.checks.length} 项全过，裁切最大偏差 ${(ce.max || 0).toFixed(2)}px`);
  } else {
    toast("自检未过：" + failed.map(f => f.name + "(" + f.detail + ")").join("；"), true);
  }
};

// 初始化
loadPages();
setMode("inspect");
