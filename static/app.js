/* 字幕版面预览与成片导出 —— 前端。
 * 预览与导出共用同一套 Canvas 排版渲染（layoutPieces/drawPiece），
 * 导出时把每个字幕片段渲染成透明 PNG 交给 ffmpeg 按时间窗叠加，保证所见即所得。 */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------------- 状态 ----------------
const DEFAULTS = {
  landscape: {
    safeT: 5, safeB: 5, safeL: 5, safeR: 5,
    hints: [],
    fontSizePct: 4.5, bottomPct: 7, maxWidthPct: 80, lineSpacing: 1.25,
    color: "#ffffff", strokeColor: "#000000", strokeW: 0.09,
    bgColor: "#000000", bgAlpha: 0.45,
    cropX: 0.5, outH: 720,
  },
  portrait: {
    safeT: 10, safeB: 16, safeL: 5, safeR: 5,
    hints: [
      { name: "右侧操作栏", x: 86, y: 32, w: 14, h: 42 },
      { name: "底部信息区", x: 0, y: 80, w: 100, h: 20 },
    ],
    fontSizePct: 3.4, bottomPct: 22, maxWidthPct: 84, lineSpacing: 1.25,
    color: "#ffffff", strokeColor: "#000000", strokeW: 0.09,
    bgColor: "#000000", bgAlpha: 0.45,
    cropX: 0.5, outH: 1280,
  },
};

const state = {
  orient: "landscape",
  videoPath: "", srtPath: "",
  videoInfo: null,          // {width,height,duration,hasAudio,...}
  events: [],               // [{id,start,end,text}]
  cfg: JSON.parse(JSON.stringify(DEFAULTS)),
  layout: { landscape: [], portrait: [] },  // pieces，见 computeLayout
  violations: { landscape: [], portrait: [] },
};

const video = $("#video");
const stage = $("#stage");
const sctx = stage.getContext("2d");
const measureCanvas = document.createElement("canvas");
const mctx = measureCanvas.getContext("2d");

const ASPECT = { landscape: 16 / 9, portrait: 9 / 16 };
const FONT_STACK = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
// 老浏览器没有 ctx.roundRect 时的兜底
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h) {
    this.rect(x, y, w, h);
  };
}
// 中文排版禁则：行首禁排 / 行尾禁排
const NO_LINE_START = "，。！？；：、）】》”’…—·％";
const NO_LINE_END = "（【《“‘";

// ---------------- 工具 ----------------
const fmt = (t) => t.toFixed(2) + "s";
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function outSize(o) {
  // 宽高都取偶数，否则 libx264/yuv420p 无法编码
  const H = Math.max(2, Math.round(state.cfg[o].outH / 2) * 2);
  const W = Math.round((H * ASPECT[o]) / 2) * 2;
  return { W, H };
}

function fontStr(px) { return `${px}px ${FONT_STACK}`; }

function parseSRT(text) {
  text = text.replace(/^﻿/, "").replace(/\r/g, "");
  const evts = [];
  const re = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.trim().split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const ti = lines.findIndex((l) => re.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(re);
    const toSec = (h, m2, s, ms) =>
      +h * 3600 + +m2 * 60 + +s + +("0." + ms.padEnd(3, "0"));
    const txt = lines.slice(ti + 1).join("\n");
    if (txt) evts.push({ start: toSec(m[1], m[2], m[3], m[4]),
                         end: toSec(m[5], m[6], m[7], m[8]), text: txt });
  }
  evts.sort((a, b) => a.start - b.start);
  evts.forEach((e, i) => (e.id = i));
  return evts;
}

// ---------------- 排版 ----------------
function wrapText(text, fontSize, maxW) {
  mctx.font = fontStr(fontSize);
  const lines = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const ch of para) {
      if (!cur || mctx.measureText(cur + ch).width <= maxW) {
        cur += ch;
        continue;
      }
      if (NO_LINE_START.includes(ch)) {
        cur += ch;              // 标点不落到行首，允许轻微超宽
        lines.push(cur); cur = "";
      } else {
        if (NO_LINE_END.includes(cur[cur.length - 1])) {
          const tail = cur[cur.length - 1];   // 开括号不留在行尾
          cur = cur.slice(0, -1);
          lines.push(cur);
          cur = tail + ch;
        } else {
          lines.push(cur); cur = ch;
        }
      }
    }
    if (cur) lines.push(cur);
  }
  return lines;
}

/* 把时间轴在所有事件边界处切成段；每段内活跃事件按开始时间排序自下而上堆叠。
 * 返回 pieces: [{eventId,start,end,cx,topY,lines,lineW,lineH,fontSize,padX,padY,blockW,blockH}]
 * 坐标均为输出画幅像素。导出时同一事件相邻且位置不变的 piece 会被合并。 */
function computeLayout(o) {
  const cfg = state.cfg[o];
  const { W, H } = outSize(o);
  const fontSize = Math.max(8, Math.round(H * cfg.fontSizePct / 100));
  const lineH = Math.round(fontSize * cfg.lineSpacing);
  const padX = Math.round(fontSize * 0.35);
  const padY = Math.round(fontSize * 0.18);
  const gap = Math.round(fontSize * 0.35);
  const maxTextW = W * cfg.maxWidthPct / 100 - 2 * padX;

  const shaped = state.events.map((e) => {
    const lines = wrapText(e.text, fontSize, maxTextW);
    mctx.font = fontStr(fontSize);
    const lineW = lines.map((l) => Math.ceil(mctx.measureText(l).width));
    const blockW = Math.max(...lineW, 1) + 2 * padX;
    const blockH = lines.length * lineH + 2 * padY;
    return { e, lines, lineW, blockW, blockH };
  });

  const bounds = new Set();
  state.events.forEach((e) => { bounds.add(e.start); bounds.add(e.end); });
  const cuts = [...bounds].sort((a, b) => a - b);

  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const t0 = cuts[i], t1 = cuts[i + 1];
    const active = shaped
      .filter((s) => s.e.start <= t0 && s.e.end >= t1)
      .sort((a, b) => a.e.start - b.e.start || a.e.id - b.e.id);
    let bottom = H * (1 - cfg.bottomPct / 100);   // 最底一条的底边
    for (const s of active) {
      const topY = bottom - s.blockH;
      pieces.push({
        eventId: s.e.id, start: t0, end: t1,
        cx: W / 2, topY,
        lines: s.lines, lineW: s.lineW, lineH, fontSize, padX, padY,
        blockW: s.blockW, blockH: s.blockH,
      });
      bottom = topY - gap;
    }
  }
  return pieces;
}

// ---------------- 绘制 ----------------
function drawPiece(ctx, p, cfg) {
  ctx.save();
  ctx.font = fontStr(p.fontSize);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  const [r, g, b] = hex2rgb(cfg.bgColor);
  ctx.fillStyle = `rgba(${r},${g},${b},${cfg.bgAlpha})`;
  p.lines.forEach((line, i) => {
    const lineTop = p.topY + p.padY + i * p.lineH;
    const textTop = lineTop + (p.lineH - p.fontSize) / 2;
    const w = p.lineW[i];
    if (cfg.bgAlpha > 0) {
      const bx = p.cx - w / 2 - p.padX, by = textTop - p.padY;
      const bw = w + 2 * p.padX, bh = p.fontSize + 2 * p.padY;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, Math.min(8, bh / 4));
      ctx.fill();
    }
    if (cfg.strokeW > 0) {
      ctx.strokeStyle = cfg.strokeColor;
      ctx.lineWidth = Math.max(1, p.fontSize * cfg.strokeW);
      ctx.strokeText(line, p.cx, textTop);
    }
    ctx.fillStyle = cfg.color;
    ctx.fillText(line, p.cx, textTop);
    ctx.fillStyle = `rgba(${r},${g},${b},${cfg.bgAlpha})`;
  });
  ctx.restore();
}

function hex2rgb(h) {
  return [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
}

function activePieces(t) {
  return state.layout[state.orient].filter((p) => p.start <= t && t < p.end);
}

function renderFrame(ctx, W, H, t, withGuides) {
  const cfg = state.cfg[state.orient];
  ctx.clearRect(0, 0, W, H);
  // 视频帧：竖版按 cropX 裁切，字幕位置始终按输出画幅算
  if (video.readyState >= 2 && video.videoWidth) {
    const vw = video.videoWidth, vh = video.videoHeight;
    let sw = vw, sh = vh, sx = 0, sy = 0;
    if (vw / vh > W / H) {          // 源比输出宽 → 左右裁
      sw = vh * (W / H);
      sx = (vw - sw) * cfg.cropX;
    } else {                        // 源比输出窄 → 上下裁
      sh = vw / (W / H);
      sy = (vh - sh) * cfg.cropX;
    }
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
  } else {
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, W, H);
  }
  for (const p of activePieces(t)) drawPiece(ctx, p, cfg);
  if (withGuides) drawGuides(ctx, W, H, cfg);
}

function drawGuides(ctx, W, H, cfg) {
  const sx = W * cfg.safeL / 100, sy = H * cfg.safeT / 100;
  const sw = W * (100 - cfg.safeL - cfg.safeR) / 100;
  const sh = H * (100 - cfg.safeT - cfg.safeB) / 100;
  ctx.save();
  ctx.strokeStyle = "rgba(0,255,120,0.9)";
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, sy, sw, sh);
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,60,60,0.25)";
  ctx.strokeStyle = "rgba(255,60,60,0.8)";
  ctx.lineWidth = 1;
  ctx.font = fontStr(Math.max(12, Math.round(H * 0.018)));
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  for (const h of cfg.hints) {
    const hx = W * h.x / 100, hy = H * h.y / 100;
    const hw = W * h.w / 100, hh = H * h.h / 100;
    ctx.fillRect(hx, hy, hw, hh);
    ctx.strokeRect(hx, hy, hw, hh);
    ctx.fillStyle = "rgba(255,120,120,0.95)";
    ctx.fillText(h.name, hx + 4, hy + 4);
    ctx.fillStyle = "rgba(255,60,60,0.25)";
  }
  ctx.restore();
}

// ---------------- 违规检查 ----------------
function checkViolations(o) {
  const cfg = state.cfg[o];
  const { W, H } = outSize(o);
  const safe = {
    x: W * cfg.safeL / 100, y: H * cfg.safeT / 100,
    w: W * (100 - cfg.safeL - cfg.safeR) / 100,
    h: H * (100 - cfg.safeT - cfg.safeB) / 100,
  };
  const out = [];
  for (const p of state.layout[o]) {
    const box = { x: p.cx - p.blockW / 2, y: p.topY, w: p.blockW, h: p.blockH };
    const reasons = [];
    if (box.x < safe.x - 0.5 || box.y < safe.y - 0.5 ||
        box.x + box.w > safe.x + safe.w + 0.5 ||
        box.y + box.h > safe.y + safe.h + 0.5) {
      const sides = [];
      if (box.x < safe.x - 0.5) sides.push("左");
      if (box.y < safe.y - 0.5) sides.push("上");
      if (box.x + box.w > safe.x + safe.w + 0.5) sides.push("右");
      if (box.y + box.h > safe.y + safe.h + 0.5) sides.push("下");
      reasons.push("超出安全区(" + sides.join("") + ")");
    }
    for (const hz of cfg.hints) {
      const hb = { x: W * hz.x / 100, y: H * hz.y / 100,
                   w: W * hz.w / 100, h: H * hz.h / 100 };
      if (box.x < hb.x + hb.w && box.x + box.w > hb.x &&
          box.y < hb.y + hb.h && box.y + box.h > hb.y) {
        reasons.push("被「" + hz.name + "」遮挡");
      }
    }
    if (reasons.length) {
      const ev = state.events[p.eventId];
      out.push({ start: p.start, end: p.end, text: ev.text.slice(0, 18),
                 reasons });
    }
  }
  // 相邻同事件同原因的段合并
  out.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const v of out) {
    const last = merged[merged.length - 1];
    if (last && last.text === v.text &&
        last.reasons.join() === v.reasons.join() &&
        Math.abs(last.end - v.start) < 0.001) {
      last.end = v.end;
    } else merged.push({ ...v });
  }
  return merged;
}

function recompute() {
  for (const o of ["landscape", "portrait"]) {
    state.layout[o] = computeLayout(o);
    state.violations[o] = checkViolations(o);
  }
  renderViolations();
}

function renderViolations() {
  const box = $("#violations");
  const list = state.violations[state.orient];
  if (!state.events.length) {
    box.innerHTML = '<span class="dim">载入字幕后自动检查</span>';
    return;
  }
  if (!list.length) {
    box.innerHTML = '<span class="dim">当前画幅没有超框或被遮挡的时间段 ✓</span>';
    return;
  }
  box.innerHTML = "";
  for (const v of list) {
    const div = document.createElement("div");
    div.className = "viol";
    div.innerHTML = `<span class="t">${fmt(v.start)} – ${fmt(v.end)}</span> ` +
      `${v.reasons.join("；")} <span class="dim">「${v.text}…」</span>`;
    div.onclick = () => { video.currentTime = v.start + 0.01; };
    box.appendChild(div);
  }
}

// ---------------- 预览循环 ----------------
function fitStage() {
  const { W, H } = outSize(state.orient);
  stage.width = W; stage.height = H;
}

function tick() {
  const t = video.currentTime || 0;
  const { W, H } = outSize(state.orient);
  renderFrame(sctx, W, H, t, $("#showGuides").checked);
  const d = state.videoInfo ? state.videoInfo.duration : 0;
  $("#timeLabel").textContent = `${t.toFixed(2)} / ${d.toFixed(2)}`;
  if (!video.seeking) $("#seek").value = d ? (t / d) * 1000 : 0;
  // 当前时刻违规提示
  const flags = [];
  for (const v of state.violations[state.orient]) {
    if (v.start <= t && t < v.end) flags.push(...v.reasons);
  }
  $("#flagBar").innerHTML = [...new Set(flags)]
    .map((f) => `<span class="flag">${f}</span>`).join("");
  requestAnimationFrame(tick);
}

// ---------------- 载入 ----------------
async function api(path) {
  const r = await fetch(path);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

async function loadAll() {
  const vp = $("#videoPath").value.trim();
  const sp = $("#srtPath").value.trim();
  const msg = $("#loadMsg");
  try {
    if (vp && vp !== state.videoPath) {
      msg.textContent = "探测视频…";
      const info = await api("/api/probe?path=" + encodeURIComponent(vp));
      state.videoInfo = info;
      state.videoPath = vp;
      video.src = "/api/media?path=" + encodeURIComponent(vp);
      $("#videoInfo").textContent =
        `${vp.split("/").pop()}  ${info.width}×${info.height}  ` +
        `${info.duration.toFixed(1)}s  ` +
        (info.hasAudio ? `音频 ${info.audioChannels}ch(${info.audioLayout})`
                       : "无音频");
      // 默认输出高度跟随源
      state.cfg.landscape.outH = Math.min(1080, info.height);
      state.cfg.portrait.outH = Math.min(1920, info.height);
      syncCfgInputs();
      const dir = vp.slice(0, vp.lastIndexOf("/"));
      const base = vp.slice(vp.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      $("#outPath").value = `${dir}/${base}_${state.orient === "portrait" ? "竖版" : "横版"}_字幕.mp4`;
    }
    if (sp && sp !== state.srtPath) {
      msg.textContent = "解析字幕…";
      const r = await fetch("/api/file?path=" + encodeURIComponent(sp));
      if (!r.ok) throw new Error((await r.json()).error);
      state.events = parseSRT(await r.text());
      state.srtPath = sp;
    }
    recompute();
    msg.textContent = `已载入 ${state.events.length} 条字幕`;
  } catch (e) {
    msg.textContent = "出错: " + e.message;
  }
}

// ---------------- 导出 ----------------
async function doExport() {
  if (!state.videoPath || !state.events.length) {
    alert("请先载入视频和字幕"); return;
  }
  const out = $("#outPath").value.trim();
  if (!out) { alert("请填写输出路径"); return; }
  const o = state.orient;
  const { W, H } = outSize(o);
  const cfg = state.cfg[o];
  $("#exportState").textContent = "渲染字幕 PNG…";
  await fetch("/api/export/reset", { method: "POST", body: "{}" });
  // 渲染每个 piece 为透明 PNG，相邻同事件同位置的合并
  const pieces = state.layout[o];
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.eventId === p.eventId && last.topY === p.topY &&
        Math.abs(last.end - p.start) < 0.001) {
      last.end = p.end;
    } else merged.push({ ...p });
  }
  const CHUNK = 15;
  for (let i = 0; i < merged.length; i += CHUNK) {
    const group = merged.slice(i, i + CHUNK);
    const payload = [];
    for (const p of group) {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      drawPiece(c.getContext("2d"), p, cfg);
      payload.push({ start: p.start, end: p.end,
                     png: c.toDataURL("image/png") });
    }
    const r = await fetch("/api/export/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: payload }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    $("#exportState").textContent =
      `上传字幕图 ${Math.min(i + CHUNK, merged.length)}/${merged.length}…`;
  }
  const r = await fetch("/api/export/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video: state.videoPath, out, outW: W, outH: H, cropX: cfg.cropX,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  pollExport();
}

async function pollExport() {
  const st = await api("/api/export/status");
  $("#exportState").textContent =
    { idle: "空闲", running: "ffmpeg 导出中…", done: "完成 ✓",
      error: "失败 ✗" }[st.state] || st.state;
  $("#exportLog").textContent = st.log;
  if (st.state === "running") {
    setTimeout(pollExport, 800);
  } else if (st.state === "done") {
    $("#verifyPanel").classList.remove("hidden");
    $("#verifyT").value = state.events.length ? state.events[0].start + 0.5 : 1;
  }
}

// ---------------- 成片核对 ----------------
async function doVerify() {
  const t = parseFloat($("#verifyT").value) || 0;
  const out = $("#outPath").value.trim();
  const { W, H } = outSize(state.orient);
  // 预览渲染（无辅助线）
  const pc = $("#verifyPreview");
  pc.width = W; pc.height = H;
  const saveT = video.currentTime;
  video.currentTime = t;
  await new Promise((res) => {
    const h = () => { video.removeEventListener("seeked", h); res(); };
    video.addEventListener("seeked", h);
    setTimeout(res, 1500);
  });
  renderFrame(pc.getContext("2d"), W, H, t, false);
  // 成片取帧
  const img = new Image();
  img.src = "/api/frame?path=" + encodeURIComponent(out) + "&t=" + t;
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error("成片取帧失败（确认已导出）"));
  });
  const ec = $("#verifyExport");
  ec.width = W; ec.height = H;
  const ectx = ec.getContext("2d");
  ectx.drawImage(img, 0, 0, W, H);
  // 像素差异统计
  const a = pc.getContext("2d").getImageData(0, 0, W, H).data;
  const b = ectx.getImageData(0, 0, W, H).data;
  let diff = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) +
              Math.abs(a[i + 2] - b[i + 2]);
    sum += d;
    if (d > 48) diff++;
  }
  const pct = (diff / (a.length / 4) * 100).toFixed(2);
  const mean = (sum / (a.length / 4) / 3).toFixed(1);
  $("#verifyStat").textContent =
    `差异像素 ${pct}%（阈值48），平均色差 ${mean} —— 压缩噪声属正常，重点看字幕位置是否一致`;
  video.currentTime = saveT;
}

// ---------------- 设置面板绑定 ----------------
function syncCfgInputs() {
  const cfg = state.cfg[state.orient];
  $$("[data-cfg]").forEach((inp) => {
    const k = inp.dataset.cfg;
    if (inp.type === "checkbox") inp.checked = cfg[k];
    else inp.value = cfg[k];
  });
  renderHints();
}

function renderHints() {
  const cfg = state.cfg[state.orient];
  const box = $("#hintList");
  if (!cfg.hints.length) {
    box.innerHTML = '<div class="dim">无（可添加平台 UI 遮挡区）</div>';
    return;
  }
  let html = `<table><tr><th>名称</th><th>x%</th><th>y%</th>
    <th>宽%</th><th>高%</th><th></th></tr>`;
  cfg.hints.forEach((h, i) => {
    html += `<tr><td><input data-h="${i}" data-k="name" value="${h.name}" style="width:6em"></td>`;
    for (const k of ["x", "y", "w", "h"]) {
      html += `<td><input data-h="${i}" data-k="${k}" type="number" value="${h[k]}" min="0" max="100"></td>`;
    }
    html += `<td><button data-del="${i}">×</button></td></tr>`;
  });
  box.innerHTML = html + "</table>";
  box.querySelectorAll("input").forEach((inp) => {
    inp.onchange = () => {
      const h = cfg.hints[+inp.dataset.h];
      h[inp.dataset.k] = inp.dataset.k === "name"
        ? inp.value : clamp(+inp.value || 0, 0, 100);
      recompute();
    };
  });
  box.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => { cfg.hints.splice(+btn.dataset.del, 1);
                          renderHints(); recompute(); };
  });
}

function bindUI() {
  $("#btnLoad").onclick = loadAll;
  $("#btnSample").onclick = async () => {
    $("#loadMsg").textContent = "生成样例中…";
    try {
      const j = await api("/api/sample");
      $("#videoPath").value = j.video;
      $("#srtPath").value = j.srt;
      state.videoPath = ""; state.srtPath = "";
      await loadAll();
    } catch (e) { $("#loadMsg").textContent = "样例生成失败: " + e.message; }
  };

  $$("#orientTabs .tab").forEach((btn) => {
    btn.onclick = () => {
      state.orient = btn.dataset.o;
      $$("#orientTabs .tab").forEach((b) =>
        b.classList.toggle("active", b === btn));
      fitStage(); syncCfgInputs(); renderViolations();
    };
  });

  $$("[data-cfg]").forEach((inp) => {
    inp.addEventListener("change", () => {
      const k = inp.dataset.cfg;
      const v = inp.type === "number" ? +inp.value : inp.value;
      state.cfg[state.orient][k] = v;
      if (k === "outH") fitStage();
      recompute();
    });
  });

  $("#btnAddHint").onclick = () => {
    state.cfg[state.orient].hints.push(
      { name: "提示区", x: 0, y: 80, w: 100, h: 15 });
    renderHints(); recompute();
  };
  $("#btnHintPreset").onclick = () => {
    state.cfg.portrait.hints = JSON.parse(
      JSON.stringify(DEFAULTS.portrait.hints));
    if (state.orient === "portrait") renderHints();
    recompute();
  };

  // 播放控制
  $("#btnPlay").onclick = () => {
    if (video.paused) { video.play(); } else video.pause();
  };
  video.onplay = () => ($("#btnPlay").textContent = "⏸ 暂停");
  video.onpause = () => ($("#btnPlay").textContent = "▶ 播放");
  $("#btnBack").onclick = () => (video.currentTime -= 1);
  $("#btnFwd").onclick = () => (video.currentTime += 1);
  $("#seek").oninput = () => {
    if (state.videoInfo) {
      video.currentTime = ($("#seek").value / 1000) * state.videoInfo.duration;
    }
  };

  $("#btnExport").onclick = () => {
    doExport().catch((e) => {
      $("#exportState").textContent = "失败: " + e.message;
    });
  };
  $("#btnVerify").onclick = () => {
    doVerify().catch((e) => ($("#verifyStat").textContent = e.message));
  };
}

bindUI();
fitStage();
syncCfgInputs();
requestAnimationFrame(tick);
