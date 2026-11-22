/* 本地视频亮度范围检查与转换 —— 前端逻辑（无框架、无外部依赖） */
"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  id: null,
  probe: null,
  nbFrames: 0,
  frameNo: 0,
  interpret: "tv",        // 当前预览解释 tv / pc
  declared: "unknown",
  frameCache: new Map(),  // frameNo -> {w,h,yuv}
  frameBusy: false,
  pendingFrame: null,
  convertTargets: { retag: null, pixels: null },
  history: null,
};
window.state = state; // 便于控制台/自动化调试

// ---------------- API ---------------- //
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : await res.arrayBuffer();
  if (!res.ok || (data && data.error)) {
    throw new Error(data.error || `请求失败 ${res.status}` + (data.detail ? `\n${data.detail}` : ""));
  }
  return data;
}
const postJSON = (path, body) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body) });

// ---------------- YUV444p 渲染 ---------------- //
function matrixCoeffs(probe) {
  // 只按显式 color_space 标记选矩阵；未标记时与 ffmpeg swscale 一致默认 BT.601
  const space = (probe?.video?.color_space || "").toLowerCase();
  if (space.includes("470") || space.includes("601") || space.includes("smpte170")
      || space.includes("smpte240")) {
    return { kr: 0.299, kb: 0.114 };   // BT.601
  }
  if (space.includes("2020") || space.includes("2100")) {
    return { kr: 0.2627, kb: 0.0593 }; // BT.2020
  }
  return { kr: 0.2126, kb: 0.0722 };   // BT.709（含 unknown 的默认情况）
}

function yuvToRgb(y, u, v, range, m) {
  let yN, cN;
  if (range === "tv") {
    yN = (y - 16) / 219;
    cN = (u - 128) / 224;
    const cNv = (v - 128) / 224;
    const r = yN + 2 * (1 - m.kr) * cNv;
    const b = yN + 2 * (1 - m.kb) * cN;
    const g = yN - (2 * m.kr * (1 - m.kr) / (1 - m.kr - m.kb)) * cNv
                  - (2 * m.kb * (1 - m.kb) / (1 - m.kr - m.kb)) * cN;
    return [r, b, g];
  }
  yN = y / 255;
  cN = (u - 128) / 256;
  const cNv = (v - 128) / 256;
  const r = yN + 2 * (1 - m.kr) * cNv;
  const b = yN + 2 * (1 - m.kb) * cN;
  const g = yN - (2 * m.kr * (1 - m.kr) / (1 - m.kr - m.kb)) * cNv
              - (2 * m.kb * (1 - m.kb) / (1 - m.kr - m.kb)) * cN;
  return [r, b, g];
}

function renderFrame(canvas, yuv, w, h, range, m) {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const y = yuv[i], u = yuv[n + i], v = yuv[2 * n + i];
    let [r, b, g] = yuvToRgb(y, u, v, range, m);
    const o = i * 4;
    out[o] = clamp255(r * 255);
    out[o + 1] = clamp255(g * 255);
    out[o + 2] = clamp255(b * 255);
    out[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
const clamp255 = (x) => (x < 0 ? 0 : x > 255 ? 255 : x | 0);

// 检查点用：编码 Y 经某种解释后的显示灰阶（0–255）
function displayLuma(y, range) {
  if (range === "tv") return clamp255(((y - 16) / 219) * 255);
  return y;
}
const grayHex = (g) => "#" + [g, g, g].map((v) => v.toString(16).padStart(2, "0")).join("");

// ---------------- 加载文件 ---------------- //
$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setStatus(`正在上传并探测 ${file.name} …`);
  try {
    const buf = await file.arrayBuffer();
    const data = await api("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "video/mp4", "X-Filename": encodeURIComponent(file.name) },
      body: buf,
    });
    setStatus("加载完成：" + file.name);
    loadSource(data.id, data.probe);
  } catch (err) {
    setStatus("加载失败：" + err.message, true);
  }
  e.target.value = "";
});

function loadSource(id, probe) {
  state.id = id;
  state.probe = probe;
  state.nbFrames = probe.nb_frames || 0;
  state.declared = probe.video.color_range;
  state.frameCache.clear();
  state.frameNo = 0;
  state.interpret = state.declared === "pc" ? "pc" : "tv";

  $("#probeCard").hidden = false;
  $("#analysisCard").hidden = false;
  $("#convertCard").hidden = false;
  $("#exportCard").hidden = false;

  $("#pContainer").textContent = `${probe.container} · ${probe.video.codec}${probe.has_audio ? " · 含音轨" : " · 无音轨"}`;
  $("#pPixfmt").textContent = probe.video.pix_fmt;
  $("#pGeom").textContent = `${probe.video.width}×${probe.video.height} · ${probe.video.fps}fps · ${state.nbFrames} 帧`;
  renderDeclared();

  const missing = state.declared === "unknown";
  $("#missingTagBox").hidden = !missing;
  $("#tagOkBox").hidden = missing;
  syncInterpSeg();
  $("#srcRangeSel").value = state.interpret;
  $("#frameInput").value = 0;
  $("#maxFrame").textContent = state.nbFrames ? state.nbFrames - 1 : "–";

  const video = $("#srcVideo");
  video.src = `/api/media?id=${id}&t=${Date.now()}`;
  video.load();

  refreshHistory();
  loadFrame(0);
}

function renderDeclared() {
  const el = $("#pDeclared");
  if (state.declared === "tv") {
    el.innerHTML = '<span class="pill tv">tv / limited (16–235)</span>';
  } else if (state.declared === "pc") {
    el.innerHTML = '<span class="pill pc">pc / full (0–255)</span>';
  } else {
    el.innerHTML = '<span class="pill unk">unknown（无标记）</span>';
  }
}

function syncInterpSeg() {
  $$("#assumeSeg button, #interpSeg button").forEach((b) =>
    b.classList.toggle("active", b.dataset.rng === state.interpret));
  $("#pInterpret").innerHTML = state.interpret === "tv"
    ? '<span class="rng-tv">limited(TV)</span>（拉伸 16–235）'
    : '<span class="rng-pc">full(PC)</span>（原样 0–255）';
}

$$("#assumeSeg button, #interpSeg button").forEach((b) =>
  b.addEventListener("click", () => {
    state.interpret = b.dataset.rng;
    $("#srcRangeSel").value = state.interpret;
    syncInterpSeg();
    rerenderCurrent();
  }));

// ---------------- 抽帧 / 渲染 / 统计 ---------------- //
async function fetchFrame(n) {
  if (state.frameCache.has(n)) return state.frameCache.get(n);
  const res = await fetch(`/api/frame?id=${state.id}&n=${n}`);
  if (!res.ok) throw new Error("抽帧失败 " + res.status);
  const w = Number(res.headers.get("X-Frame-Width"));
  const h = Number(res.headers.get("X-Frame-Height"));
  const buf = new Uint8Array(await res.arrayBuffer());
  const entry = { w, h, yuv: buf };
  state.frameCache.set(n, entry);
  if (state.frameCache.size > 12) {
    state.frameCache.delete(state.frameCache.keys().next().value);
  }
  return entry;
}

async function loadFrame(n) {
  if (!state.id || state.frameBusy) {
    state.pendingFrame = n;
    return;
  }
  n = Math.max(0, state.nbFrames ? Math.min(n, state.nbFrames - 1) : n);
  state.frameBusy = true;
  $("#seekHint").textContent = "抽帧中…";
  try {
    const entry = await fetchFrame(n);
    state.frameNo = n;
    $("#curFrame").textContent = n;
    $("#frameInput").value = n;
    renderAll(entry);
    const stats = await api(`/api/stats?id=${state.id}&n=${n}`);
    renderStats(stats);
  } catch (err) {
    $("#seekHint").textContent = "出错：" + err.message;
  } finally {
    state.frameBusy = false;
    $("#seekHint").textContent = "";
    if (state.pendingFrame !== null && state.pendingFrame !== n) {
      const next = state.pendingFrame;
      state.pendingFrame = null;
      loadFrame(next);
    } else {
      state.pendingFrame = null;
    }
  }
}

function rerenderCurrent() {
  const entry = state.frameCache.get(state.frameNo);
  if (entry) renderAll(entry);
}

function renderAll(entry) {
  const m = matrixCoeffs(state.probe);
  renderFrame($("#cvTv"), entry.yuv, entry.w, entry.h, "tv", m);
  renderFrame($("#cvPc"), entry.yuv, entry.w, entry.h, "pc", m);
}

function renderStats(stats) {
  // 像素线索
  const clue = [];
  if (stats.below_16_pct > 0.05) clue.push(`Y<16 像素占 ${stats.below_16_pct}%（limited 编码不应出现）`);
  if (stats.above_235_pct > 0.05) clue.push(`Y>235 像素占 ${stats.above_235_pct}%（limited 编码不应出现）`);
  if (!clue.length) clue.push("像素全部落在 16–235，符合 limited 编码特征（full 素材若内容不含纯黑纯白也可能如此）");
  $("#pPixelClue").innerHTML = clue.join("；") +
    `。<span class="mono">Ymin=${stats.y_min}, Ymax=${stats.y_max}, 均值=${stats.y_mean}</span>`;

  drawHistogram(stats.histogram);
  $("#histStats").innerHTML = [
    ["Y 最小值", stats.y_min], ["Y 最大值", stats.y_max],
    ["Y<16 占比", stats.below_16_pct + "%"], ["Y>235 占比", stats.above_235_pct + "%"],
  ].map(([k, v]) => `<div><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  renderCheckpoints(stats);
  renderBands(stats);
}

function drawHistogram(hist) {
  const cv = $("#histCanvas");
  const W = cv.clientWidth || 1000, H = 220;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  const max = Math.max(...hist);
  const barW = W / 256;
  for (let i = 0; i < 256; i++) {
    const bh = max ? (hist[i] / max) * (H - 26) : 0;
    ctx.fillStyle = i < 16 ? "#e06a6a" : i > 235 ? "#e8b34b" : "#5b9dff";
    ctx.fillRect(i * barW, H - 18 - bh, Math.max(1, barW - 0.2), bh);
  }
  ctx.fillStyle = "#9aa4b2";
  ctx.font = "11px monospace";
  [0, 16, 128, 235, 255].forEach((x) => {
    ctx.fillText(String(x), x * barW, H - 4);
    ctx.strokeStyle = "rgba(154,164,178,.35)";
    ctx.beginPath(); ctx.moveTo(x * barW, 0); ctx.lineTo(x * barW, H - 18); ctx.stroke();
  });
  $("#histTip").textContent =
    `峰值电平 ${hist.indexOf(max)}，红色/黄色柱若有高度，说明素材里存在 limited 解释会被裁切的电平。`;
}

function renderCheckpoints(stats) {
  const present = new Set();
  stats.histogram.forEach((c, y) => { if (c > 0) present.add(y); });
  const rows = [0, 8, 16, 32, 128, 220, 235, 245, 255];
  const meaning = {
    0: "full 纯黑；limited 解释下被压到与 Y=16 同级黑",
    8: "full 暗部细节；limited 解释下与黑场无法区分",
    16: "limited 黑场；full 解释下显示为深灰",
    235: "limited 白场；full 解释下显示为浅灰",
    245: "full 高光细节；limited 解释下与白场无法区分",
    255: "full 纯白；limited 解释下被压到与 Y=235 同级白",
  };
  $("#checkTable tbody").innerHTML = rows.map((y) => {
    const gTv = displayLuma(y, "tv"), gPc = displayLuma(y, "pc");
    return `<tr>
      <td class="mono">${y}</td>
      <td><span class="swatch" style="background:${grayHex(gTv)}"></span>${gTv}</td>
      <td><span class="swatch" style="background:${grayHex(gPc)}"></span>${gPc}</td>
      <td>${present.has(y) ? "有" : "—"}</td>
      <td>${meaning[y] || "—"}</td>
    </tr>`;
  }).join("");
}

function renderBands(stats) {
  $("#bandTable tbody").innerHTML = stats.bands.map((b) => {
    const gTv = displayLuma(b.peak_y, "tv"), gPc = displayLuma(b.peak_y, "pc");
    return `<tr>
      <td class="mono">${b.lo}–${b.hi}</td>
      <td class="mono">${b.peak_y}</td>
      <td class="mono">${b.count.toLocaleString()}</td>
      <td><span class="swatch" style="background:${grayHex(gTv)}"></span>${gTv}</td>
      <td><span class="swatch" style="background:${grayHex(gPc)}"></span>${gPc}</td>
    </tr>`;
  }).join("");

  // 压级检测：统计 limited 解释下映射到同一显示级的不同编码电平
  const groups = new Map();
  stats.histogram.forEach((c, y) => {
    if (!c) return;
    const g = displayLuma(y, "tv");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(y);
  });
  const crushedDark = [], crushedHigh = [];
  for (const [g, ys] of groups) {
    if (ys.length < 2) continue;
    if (g === 0) crushedDark.push(...ys);
    if (g === 255) crushedHigh.push(...ys);
  }
  const note = $("#crushNote");
  if (crushedDark.length || crushedHigh.length) {
    note.hidden = false;
    note.innerHTML = `<b>检测到被压成同一级的电平：</b>` +
      (crushedDark.length ? `暗部 Y=${[...new Set(crushedDark)].join(", ")} 在 limited 解释下全部显示为纯黑 0；` : "") +
      (crushedHigh.length ? `高光 Y=${[...new Set(crushedHigh)].join(", ")} 在 limited 解释下全部显示为纯白 255。` : "") +
      " 切换到 full 解释即可看到这些层级被分开。";
  } else {
    note.hidden = true;
  }
}

// ---------------- 帧导航（不改变范围选择） ---------------- //
$("#goFrame").addEventListener("click", () =>
  loadFrame(parseInt($("#frameInput").value, 10) || 0));
$("#frameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") loadFrame(parseInt(e.target.value, 10) || 0);
});
$("#prevFrame").addEventListener("click", () => loadFrame(state.frameNo - 1));
$("#nextFrame").addEventListener("click", () => loadFrame(state.frameNo + 1));
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowLeft") loadFrame(state.frameNo - 1);
  if (e.key === "ArrowRight") loadFrame(state.frameNo + 1);
});

// ---------------- 转换 ---------------- //
$$(".target-seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const mode = seg.dataset.mode;
    state.convertTargets[mode] = btn.dataset.rng;
    seg.querySelectorAll("button").forEach((b) =>
      b.classList.toggle("active", b === btn));
  });
});

$$("button.go").forEach((btn) =>
  btn.addEventListener("click", () => doConvert(btn.dataset.mode, false)));

async function doConvert(mode, confirmed) {
  const target = state.convertTargets[mode];
  if (!target) return alert("请先选择目标范围");
  const body = { id: state.id, mode, target_range: target, confirmed };
  if (mode === "pixels") body.source_range = $("#srcRangeSel").value;
  try {
    const data = await postJSON("/api/convert", body);
    if (data.need_confirm) {
      $("#confirmBox").hidden = false;
      $("#confirmMsg").innerHTML =
        `<b>重复转换提示：</b>${data.message}` +
        `<div class="hint" style="margin-top:6px">已有输出：` +
        data.prior.map((p) => `${p.output}（${p.mode} → ${p.declared_after}）`).join("；") +
        "</div>";
      $("#confirmYes").onclick = async () => {
        $("#confirmBox").hidden = true;
        await doConvert(mode, true);
      };
      return;
    }
    $("#confirmBox").hidden = true;
    showConvertResult(data);
    await refreshHistory();
  } catch (err) {
    alert("转换失败：" + err.message);
  }
}
$("#confirmNo").addEventListener("click", () => ($("#confirmBox").hidden = true));

function showConvertResult(data) {
  const c = data.conversion;
  const lc = c.level_change_frame0;
  const samePixels = lc.y_min_before === lc.y_min_after && lc.y_max_before === lc.y_max_after;
  const box = $("#convertResult");
  box.hidden = false;
  box.innerHTML = `
    <b>导出完成：${c.output_name}</b>
    ${c.warning ? `<div class="warnbox" style="margin:8px 0">${c.warning}</div>` : ""}
    <div class="hint" style="margin:6px 0">
      模式：${c.mode === "retag"
        ? (c.lossless ? "仅修正标记（码流复制，完全无损）"
                      : "仅修正标记（MKV 容器限制：保像素重编码，电平不变但有压缩损失）")
        : "实际转换像素（重编码，音轨复制保留）"}<br>
      标记变化：${c.declared_before} → <b>${c.declared_after}</b><br>
      帧0 实际电平回读：Y min ${lc.y_min_before}→${lc.y_min_after}，
      Y max ${lc.y_max_before}→${lc.y_max_after}，
      均值 ${lc.y_mean_before}→${lc.y_mean_after}<br>
      越界像素：Y&lt;16 占比 ${lc.below_16_pct_before}%→${lc.below_16_pct_after}%，
      Y&gt;235 占比 ${lc.above_235_pct_before}%→${lc.above_235_pct_after}%<br>
      <b>${samePixels ? "像素电平未变化（符合仅改标记的预期）" : "像素电平已改变（符合像素转换的预期）"}</b>
    </div>
    <div class="hrow">
      <a href="/api/media?id=${data.output_id}" download="${c.output_name}">
        <button>下载导出文件</button></a>
      <button onclick="recheck('${data.output_id}')">回读复核该文件</button>
      <button onclick="loadAsCurrent('${data.output_id}')">载入到检查区继续核对</button>
    </div>
    <details class="hint"><summary>实际执行的 ffmpeg 命令</summary>
      <pre class="mono" style="white-space:pre-wrap">${c.ffmpeg_cmd.replace(/</g, "&lt;")}</pre></details>`;
}

// ---------------- 历史 / 导出表 / 回读 ---------------- //
async function refreshHistory() {
  state.history = await api("/api/history");
  const files = Object.values(state.history.files);
  const rows = files.map((f) => {
    const rng = f.probe?.video?.color_range || "?";
    const pill = rng === "tv" ? '<span class="pill tv">tv</span>'
      : rng === "pc" ? '<span class="pill pc">pc</span>'
      : '<span class="pill unk">unknown</span>';
    const last = f.conversions?.at(-1);
    let change = "—";
    if (last) {
      const l = last.level_change_frame0;
      change = `${l.y_min_before}→${l.y_min_after} / ${l.y_max_before}→${l.y_max_after}`;
    }
    const over = last
      ? `${l(last, "below_16_pct")} / ${l(last, "above_235_pct")}` : "—";
    return `<tr>
      <td>${f.original_name}</td>
      <td>${roleLabel(f)}</td>
      <td>${pill}</td>
      <td>${last ? (last.mode === "retag" ? "仅改标记" : "像素转换") : "（原件）"}</td>
      <td class="mono">${change}</td>
      <td class="mono">${over}</td>
      <td>
        <a href="/api/media?id=${f.id}" download="${f.original_name}"><button>下载</button></a>
        <button onclick="recheck('${f.id}')">回读检查</button>
        <button onclick="loadAsCurrent('${f.id}')">载入检查区</button>
      </td></tr>`;
  }).join("");
  $("#historyTable tbody").innerHTML = rows ||
    '<tr><td colspan="7" class="hint">暂无记录</td></tr>';
}
function l(c, key) {
  return `${c.level_change_frame0[key + "_before"]}%→${c.level_change_frame0[key + "_after"]}%`;
}
function roleLabel(f) {
  return { source: "源文件", output: "导出", sample: "样例" }[f.role] || f.role;
}

window.recheck = async function (id) {
  const frameNo = state.frameNo || 0;
  try {
    const r = await postJSON("/api/recheck", { id, frame_no: frameNo });
    const s = r.stats;
    const convs = (r.conversions || []).map((c) =>
      `<li>${c.mode === "retag" ? "仅改标记" : "像素转换"}：${c.declared_before} → ${c.declared_after}（目标 ${c.target_range}）</li>`
    ).join("") || "<li>无转换记录（原始文件）</li>";
    $("#recheckBox").hidden = false;
    $("#recheckBox").innerHTML = `<b>回读：${r.filename}</b>
      <div class="grid4" style="margin-top:8px">
        <div><div class="k">当前范围标记</div><div class="v">${r.probe.video.color_range}</div></div>
        <div><div class="k">帧 ${s.frame_no} Y min/max</div><div class="v mono">${s.y_min} / ${s.y_max}</div></div>
        <div><div class="k">Y&lt;16 占比</div><div class="v">${s.below_16_pct}%</div></div>
        <div><div class="k">Y&gt;235 占比</div><div class="v">${s.above_235_pct}%</div></div>
      </div>
      <div class="hint">灰阶带峰值：${s.bands.map((b) => b.peak_y).join(", ")}</div>
      <ul class="hint">${convs}</ul>`;
    $("#recheckBox").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    alert("回读失败：" + err.message);
  }
};

window.loadAsCurrent = async function (id) {
  // history 可能尚未加载（页面刚打开就触发），先确保有记录再取
  if (!state.history || !state.history.files || !state.history.files[id]) {
    await refreshHistory();
  }
  const rec = state.history?.files?.[id];
  if (!rec) {
    alert("找不到该文件的记录，请刷新页面后重试");
    return;
  }
  const probe = await (await fetch(`/api/probe?id=${id}`)).json();
  loadSource(id, probe.probe);
  window.scrollTo({ top: 0, behavior: "smooth" });
};

// ---------------- 样例生成 ---------------- //
$("#genSamplesBtn").addEventListener("click", async () => {
  setStatus("正在用 ffmpeg 生成样例（约几秒）…");
  try {
    const data = await postJSON("/api/generate-samples", {});
    $("#sampleCard").hidden = false;
    $("#sampleList").innerHTML = data.samples.map((s) => `
      <div class="op" style="margin-bottom:10px">
        <b>${s.filename}</b>
        <div class="hint" style="margin:4px 0">${s.intent}</div>
        <div class="grid4">
          <div><div class="k">回读标记</div><div class="v">${s.declared_range}</div></div>
          <div><div class="k">帧0 Y min/max</div><div class="v mono">${s.y_min} / ${s.y_max}</div></div>
          <div><div class="k">Y&lt;16 / Y&gt;235</div><div class="v">${s.below_16_pct}% / ${s.above_235_pct}%</div></div>
          <div><div class="k">音轨</div><div class="v">${s.has_audio ? "440Hz 已保留" : "无"}</div></div>
        </div>
        <div class="hrow">
          <button onclick="loadAsCurrent('${s.id}')">载入检查区对比</button>
          <a href="/api/media?id=${s.id}" download="${s.filename}"><button class="ghost">下载</button></a>
        </div>
      </div>`).join("");
    await refreshHistory();
    setStatus("样例已生成并回读校验，见页面底部 ⑤");
  } catch (err) {
    setStatus("样例生成失败：" + err.message, true);
  }
});

function setStatus(msg, bad = false) {
  const el = $("#loadStatus");
  el.textContent = msg;
  el.style.color = bad ? "var(--danger)" : "var(--dim)";
}
