/* FrameLab 前端逻辑：原生 JS，无依赖、无构建 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const api = async (route, body) => {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(route, opt);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "请求失败");
  return data;
};
const mediaUrl = (absPath) => `/api/raw-media?path=${encodeURIComponent(absPath)}`;

const state = {
  project: null,
  stats: null,
  kind: "",
  offset: 0,
  limit: 100,
  total: 0,
  srcToOut: {},
  selectedOut: null,
};

// ---------- 健康检查 & 样片 ----------
async function health() {
  try {
    await fetch("/api/health");
    const el = $("#health");
    el.textContent = "本地服务在线";
    el.className = "pill ok";
    loadSamples();
  } catch {
    const el = $("#health");
    el.textContent = "服务不可用";
    el.className = "pill bad";
  }
}

async function loadSamples() {
  const data = await api("/api/samples");
  const box = $("#samples");
  box.innerHTML = "";
  if (!data.samples.length) {
    box.innerHTML = '<span class="hint">未发现样片，请运行 python3 scripts/generate_samples.py</span>';
    return;
  }
  for (const s of data.samples) {
    const chip = document.createElement("div");
    chip.className = "sample-chip";
    chip.innerHTML = `<b>${s.name}</b><span>${(s.size / 1024).toFixed(0)} KB · 点击载入</span>`;
    chip.onclick = () => { $("#srcPath").value = s.path; openProject(); };
    box.appendChild(chip);
  }
}

// ---------- 项目 ----------
async function openProject() {
  const path = $("#srcPath").value.trim();
  if (!path) return;
  $("#analyzeError").classList.add("hidden");
  try {
    const created = await api("/api/projects", { path });
    state.project = created.project;
    const data = await api("/api/analyze", { id: state.project.id });
    state.project = data.project;
    renderProbe(data.probe);
    showWorkspace();
    await applySettings(false);
  } catch (e) {
    // 分析失败：保留项目，展示错误与已有信息
    const box = $("#analyzeError");
    box.textContent = `分析失败（项目已保留，可重试）：${e.message}`;
    box.classList.remove("hidden");
  }
}

function renderProbe(p) {
  const v = p.video || {};
  const a = p.audio;
  const rows = [
    ["时长", `${p.duration.toFixed(3)} s`],
    ["总帧数", p.frame_count],
    ["源帧率", v.fps ? `${v.fps.toFixed(3)} fps` : "—"],
    ["分辨率", v.width ? `${v.width}×${v.height}` : "—"],
    ["视频编码", v.codec || "—"],
    ["可变帧率", p.is_vfr ? '<span class="vfr-tag">VFR</span>' : "CFR"],
    ["音频", a ? `${a.codec} · ${a.sample_rate}Hz · ${a.channels}ch` : "无音频轨"],
    ["像素格式", v.pix_fmt || "—"],
  ];
  $("#probeInfo").innerHTML = "<dl>" +
    rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join("") + "</dl>";
  $("#probeInfo").classList.remove("hidden");
}

function showWorkspace() {
  for (const id of ["#settingsCard", "#previewCard", "#mappingCard", "#exportCard"]) {
    $(id).classList.remove("hidden");
  }
  $("#srcVideo").src = mediaUrl(state.project.source);
  renderHistory();
}

// ---------- 参数与统计 ----------
async function applySettings(showHint = true) {
  const s = state.project.settings;
  s.dst_fps = parseFloat($("#dstFps").value);
  s.speed = parseFloat($("#speed").value);
  s.method = $("#method").value;
  s.keep_pitch = $("#keepPitch").value === "1";
  const data = await api("/api/settings", { id: state.project.id, ...s });
  state.stats = data.stats;
  state.project.settings = data.settings;
  renderStats(state.stats);
  state.offset = 0;
  await loadMapping();
  if (showHint) flashHint("参数已应用并保存到项目");
}

function renderStats(s) {
  const cards = [
    ["源帧数", s.src_frame_count, ""],
    ["输出帧数", s.out_frame_count, ""],
    ["输出时长", `${s.out_duration.toFixed(3)}s`, ""],
    ["重复帧", s.duplicate_frames, s.duplicate_frames ? "warn" : "ok"],
    ["最长连重", s.max_duplicate_run, s.max_duplicate_run > 1 ? "bad" : ""],
    ["丢帧跳跃行", s.drop_frames, s.drop_frames ? "bad" : "ok"],
    ["丢弃源帧", s.dropped_src_frames.length, s.dropped_src_frames.length ? "warn" : "ok"],
    ["混合帧", s.blend_frames, s.method === "blend" ? "" : "ok"],
    ["拖影帧", s.ghost_frames, s.ghost_frames ? "warn" : "ok"],
    ["卡顿占比", `${(s.stutter_ratio * 100).toFixed(1)}%`, s.stutter_ratio > 0.3 ? "bad" : ""],
  ];
  $("#stats").innerHTML = cards.map(([k, v, cls]) =>
    `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
  $("#stats").classList.remove("hidden");
}

// ---------- 映射表 ----------
async function loadMapping() {
  const data = await api("/api/mapping", {
    id: state.project.id,
    offset: state.offset, limit: state.limit, kind: state.kind || undefined,
  });
  state.total = data.total;
  state.srcToOut = data.src_to_out;
  renderRows(data.rows);
  const from = data.total ? state.offset + 1 : 0;
  const to = Math.min(state.offset + state.limit, data.total);
  $("#pageInfo").textContent = `${from}–${to} / 共 ${data.total} 行`;
  $("#btnPrev").disabled = state.offset === 0;
  $("#btnNext").disabled = to >= data.total;
}

function kindBadge(k) {
  const label = { exact: "精确", duplicate: "重复", drop: "丢帧", blend: "混合" }[k] || k;
  return `<span class="kind kind-${k}">${label}</span>`;
}

function renderRows(rows) {
  const tb = $("#mapTable tbody");
  tb.innerHTML = "";
  const pid = state.project.id;
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.dataset.out = r.out_index;
    tr.innerHTML = `
      <td>${r.out_index}</td>
      <td>${r.out_timecode}</td>
      <td>${r.out_time.toFixed(4)}</td>
      <td>${kindBadge(r.kind)}</td>
      <td>${r.src_index}</td>
      <td>${r.src_index_2 ?? "—"}</td>
      <td>${r.blend_weight ? r.blend_weight.toFixed(3) : "—"}</td>
      <td>${r.src_timecode}</td>
      <td>${r.src_time.toFixed(4)}</td>
      <td><img loading="lazy" src="/api/frame?id=${pid}&src=${r.src_index}" alt="源帧${r.src_index}"></td>`;
    tr.onclick = () => locateOutput(r.out_index, r.src_index, r.out_time, r.src_time);
    tb.appendChild(tr);
  }
}

function locateOutput(outIndex, srcIndex, outTime, srcTime) {
  state.selectedOut = outIndex;
  document.querySelectorAll("#mapTable tr.selected").forEach((t) => t.classList.remove("selected"));
  const tr = document.querySelector(`#mapTable tr[data-out="${outIndex}"]`);
  if (tr) {
    tr.classList.add("selected");
    tr.scrollIntoView({ block: "nearest" });
  }
  if ($("#autoScroll").checked) {
    $("#srcVideo").currentTime = Math.min(srcTime, $("#srcVideo").duration || 1e9);
    $("#srcTag").textContent = `源帧 #${srcIndex} · ${srcTime.toFixed(3)}s`;
    if (!isNaN($("#outVideo").duration)) {
      $("#outVideo").currentTime = Math.min(outTime, $("#outVideo").duration);
      $("#outTag").textContent = `输出帧 #${outIndex} · ${outTime.toFixed(3)}s`;
    }
  }
}

// ---------- 跳转 ----------
async function jumpToOutput(frameNo) {
  // 在当前筛选条件下找到该行所在页
  const probe = await api("/api/mapping", {
    id: state.project.id, offset: 0, limit: 1, kind: state.kind || undefined,
  });
  // 全量定位：逐步翻页代价高，直接请求包含目标帧的窗口（未筛选时帧号即偏移）
  if (!state.kind) {
    state.offset = Math.max(0, Math.floor(frameNo / state.limit) * state.limit);
  } else {
    state.offset = 0; // 筛选模式下回到开头由用户翻页
  }
  await loadMapping();
  const tr = document.querySelector(`#mapTable tr[data-out="${frameNo}"]`);
  if (tr) tr.click();
  else flashHint(`当前筛选下未找到输出帧 #${frameNo}`);
}

function jumpToSrc(srcIndex) {
  const outs = state.srcToOut[String(srcIndex)];
  if (!outs || !outs.length) {
    flashHint(`源帧 #${srcIndex} 未被任何输出帧引用（已被丢弃）`);
    return;
  }
  flashHint(`源帧 #${srcIndex} → 输出帧 ${outs.join(", ")}，已跳到首个`);
  jumpToOutput(outs[0]);
}

// ---------- 预览与导出 ----------
async function makePreview() {
  flashHint("正在生成 2 秒对比预览…");
  try {
    const data = await api("/api/preview", { id: state.project.id, seconds: 2 });
    $("#outVideo").src = `/api/raw-media?path=${encodeURIComponent(data.path)}&t=${Date.now()}`;
    $("#outTag").textContent = "2 秒预览（与正式导出同一滤镜链）";
    flashHint("预览已生成，可播放对比卡顿/拖影");
  } catch (e) {
    flashHint(`预览失败：${e.message}`);
  }
}

async function resolveExportPath(name) {
  // 通过下载接口的 probe 模式取服务端绝对路径，再交给 raw-media 流式播放
  const res = await fetch(`/api/download?id=${state.project.id}&kind=export&name=${name}&probe=1`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "导出文件不可用");
  return j.path;
}

async function exportVideo() {
  $("#exportStatus").textContent = "转码中，请稍候…（失败也会保留分析结果与日志）";
  try {
    const data = await api("/api/export/video", { id: state.project.id });
    const outAbs = await resolveExportPath(data.record.output);
    $("#outVideo").src = `/api/raw-media?path=${encodeURIComponent(outAbs)}&t=${Date.now()}`;
    $("#exportStatus").innerHTML =
      `✅ 已导出 <a href="${data.download}" download>${data.record.output}</a>`;
  } catch (e) {
    $("#exportStatus").innerHTML = `<span class="fail-text">❌ ${e.message}</span>`;
  }
  renderHistory();
}

async function exportManifest(fmt) {
  const data = await api("/api/export/manifest", { id: state.project.id, format: fmt });
  const name = fmt === "json" ? data.json : data.csv;
  const a = document.createElement("a");
  a.href = `/api/download?id=${state.project.id}&kind=export&name=${name}`;
  a.download = "";
  a.click();
  flashHint(`清单已导出（${fmt.toUpperCase()}）`);
}

function renderHistory() {
  const exports = state.project.exports || [];
  if (!exports.length) { $("#exportHistory").innerHTML = ""; return; }
  $("#exportHistory").innerHTML = `<table><thead><tr>
    <th>时间</th><th>文件</th><th>状态</th><th>下载</th></tr></thead><tbody>` +
    exports.map((e) => `<tr>
      <td>${e.time}</td><td>${e.output}</td>
      <td class="${e.ok ? "ok-text" : "fail-text"}">${e.ok ? "成功" : "失败"}</td>
      <td>${e.ok ? `<a href="/api/download?id=${state.project.id}&kind=export&name=${e.output}" download>下载</a>` : "—"}</td>
    </tr>`).join("") + "</tbody></table>";
}

function flashHint(msg) {
  const el = $("#saveHint");
  el.textContent = msg;
  clearTimeout(flashHint._t);
  flashHint._t = setTimeout(() => (el.textContent = ""), 3500);
}

// ---------- 事件绑定 ----------
$("#btnRefreshSamples").onclick = loadSamples;
$("#btnOpen").onclick = openProject;
$("#srcPath").addEventListener("keydown", (e) => e.key === "Enter" && openProject());
$("#btnApply").onclick = () => applySettings();
$("#btnSave").onclick = async () => {
  await api("/api/settings", { id: state.project.id, ...state.project.settings });
  flashHint("项目已保存");
};
$("#btnPreview").onclick = makePreview;
$("#btnExportVideo").onclick = exportVideo;
$("#btnExportCsv").onclick = () => exportManifest("csv");
$("#btnExportJson").onclick = () => exportManifest("json");
$("#btnNext").onclick = async () => { state.offset += state.limit; await loadMapping(); };
$("#btnPrev").onclick = async () => { state.offset = Math.max(0, state.offset - state.limit); await loadMapping(); };
$("#btnJumpOut").onclick = () => {
  const n = parseInt($("#jumpOut").value, 10);
  if (!isNaN(n)) jumpToOutput(n);
};
$("#btnJumpSrc").onclick = () => {
  const n = parseInt($("#jumpSrc").value, 10);
  if (!isNaN(n)) jumpToSrc(n);
};
document.querySelectorAll("#kindFilter button").forEach((b) => {
  b.onclick = async () => {
    document.querySelectorAll("#kindFilter button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    state.kind = b.dataset.kind;
    state.offset = 0;
    await loadMapping();
  };
});
$("#method").onchange = () => flashHint("提示：切换方式后点「应用并重新计算」，再生成预览对比卡顿/拖影");

health();
