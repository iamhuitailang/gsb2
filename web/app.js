/* 关键帧裁切检查工具前端：无外部依赖，全部数据来自本机 API。 */
"use strict";

const state = {
  probe: null,
  inIdx: 0,
  outIdx: 0,
  plans: null,
  planError: "",
};

const $ = (id) => document.getElementById(id);

async function api(url, options) {
  const resp = await fetch(url, options);
  const payload = await resp.json();
  if (!payload.ok) throw new Error(payload.error || "请求失败");
  return payload.data;
}

function toast(msg, isError = false) {
  const el = $("toast");
  el.textContent = msg;
  el.style.background = isError ? "#b91c1c" : "#111827";
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3500);
}

function hms(sec) {
  if (sec === null || sec === undefined) return "N/A";
  const sign = sec < 0 ? "-" : "";
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3)}`;
}

function msLabel(sec) {
  return `${sec >= 0 ? "+" : ""}${(sec * 1000).toFixed(1)} ms`;
}

function frameAt(idx) {
  return state.probe.frames[idx];
}

function thumbUrl(path, n) {
  return `/api/thumb?path=${encodeURIComponent(path)}&n=${n}`;
}

// ---------------- 载入 ----------------

async function loadMedia(path) {
  const data = await api(`/api/probe?path=${encodeURIComponent(path)}`);
  state.probe = data;
  state.inIdx = 0;
  state.outIdx = Math.min(60, data.frames.length - 1);
  state.plans = null;
  ["infoPanel", "timelinePanel", "thumbsPanel", "planPanel", "resultPanel"].forEach((id) =>
    $(id).classList.remove("hidden"));
  $("resultPanel").classList.add("hidden");
  renderAll();
}

function renderInfo() {
  const p = state.probe;
  const v = p.video;
  const cells = [
    ["文件", p.path],
    ["编码 / 尺寸", `${v.codec} ${v.width}×${v.height} ${v.pix_fmt}`],
    ["平均帧率", v.avg_fps ? `${v.avg_fps} fps（${v.nb_frames} 帧）` : `${v.nb_frames} 帧`],
    ["容器起点 start_time", `${hms(p.format_start_time)}（轨道起点）`],
    ["视频流起点", `${hms(v.start_time)}（显示起点 ${hms(v.display_start_time)}）`],
    ["显示时长", hms(p.format_duration)],
    ["重排帧(B帧)", v.reorder_detected ? "检测到，已按显示顺序(PTS)排列" : "未检测到"],
    ["音轨", p.audio ? `${p.audio.codec} ${p.audio.sample_rate}Hz，覆盖显示 ${hms(p.audio.display_start)} ~ ${hms(p.audio.display_end)}` : "无音轨"],
  ];
  $("infoGrid").innerHTML = cells
    .map(([k, val]) => `<div class="cell"><b>${k}</b><span>${val}</span></div>`).join("");
  const warns = [
    ...p.warnings.map((w) => `<div class="warn-item">⚠️ ${w}</div>`),
    ...p.notes.map((n) => `<div class="note-item">${n}</div>`),
  ];
  $("warnings").innerHTML = warns.join("");
}

// ---------------- 时间线 ----------------

function renderTimeline() {
  const p = state.probe;
  const dur = p.format_duration || p.frames.at(-1).display_time + p.frames.at(-1).duration;
  const pct = (t) => `${(t / dur) * 100}%`;

  const marks = p.keyframes.map((idx) => {
    const f = frameAt(idx);
    return `<div class="keyframe-mark" style="left:${pct(f.display_time)}" data-label="#${idx}"></div>`;
  }).join("");

  const inT = frameAt(state.inIdx).display_time;
  const outT = frameAt(state.outIdx).display_time;
  const pill = state.outIdx > state.inIdx
    ? `<div class="range-pill" style="left:${pct(inT)};width:${pct(outT - inT)}"></div>` : "";

  $("timeline").innerHTML =
    marks + pill +
    `<div class="cursor" style="left:${pct(inT)}"></div>` +
    `<div class="cursor out" style="left:${pct(outT)}"></div>`;
  $("inTime").value = inT.toFixed(3);
  $("outTime").value = outT.toFixed(3);
  $("tlCursor").innerHTML =
    `入点 <b class="mono">#${state.inIdx} ${hms(inT)}</b> ｜ 出点 <b class="mono">#${state.outIdx} ${hms(outT)}</b>`;
  renderNearest();
}

async function renderNearest() {
  const p = state.probe;
  const t = frameAt(state.inIdx).display_time;
  const data = await api(`/api/nearest?path=${encodeURIComponent(p.path)}&t=${t}`);
  const f = (x) => x
    ? `<b>#${x.idx}</b> <span class="mono">${hms(x.display_time)}</span>（${x.pict_type}帧）`
    : "<span class='hint'>无（已到素材边缘）</span>";
  $("nearestBox").innerHTML = [
    `<div class="kf">当前帧 ${f(data.at)}</div>`,
    `<div class="kf">前一个关键帧 ${f(data.prev_keyframe)}</div>`,
    `<div class="kf">后一个关键帧 ${f(data.next_keyframe)}</div>`,
  ].join("");
}

// ---------------- 三帧核对 ----------------

async function renderThumbs() {
  const p = state.probe;
  // 必须 await 最新计划，否则入点刚变化时这里会读到上一次的 state.plans（竞态）
  await refreshPlans();
  const target = frameAt(state.inIdx);
  const fastIdx = state.plans ? state.plans.fast.actual_in_idx : state.inIdx;
  const accIdx = state.inIdx;

  $("thumbTarget").src = thumbUrl(p.path, state.inIdx);
  $("thumbFast").src = thumbUrl(p.path, fastIdx);
  $("thumbAcc").src = thumbUrl(p.path, accIdx);

  $("capTarget").textContent = `源片 #${target.idx} / ${hms(target.display_time)} / ${target.pict_type}帧`;
  $("capFast").textContent = `源片 #${fastIdx} / ${hms(frameAt(fastIdx).display_time)} / 关键帧`;
  $("capAcc").textContent = `源片 #${accIdx} / ${hms(frameAt(accIdx).display_time)}（重编码后画面同源此帧）`;

  const delta = target.display_time - frameAt(fastIdx).display_time;
  const box = $("deltaBox");
  if (delta <= 1e-6) {
    box.className = "delta zero";
    box.textContent = "入点正好落在关键帧上：快速裁切与精确裁切首帧一致，不会多出内容。";
  } else {
    box.className = "delta";
    box.innerHTML =
      `入点在两个关键帧之间：快速裁切首帧比指定帧早 <b>${msLabel(delta)}</b>，` +
      `即多出 <b>${state.inIdx - fastIdx} 帧</b>（画面来自源片 #${fastIdx} ~ #${state.inIdx - 1}）；` +
      `精确裁切首帧与指定帧一致（时间差 0.0 ms）。`;
  }
}

// ---------------- 计划 ----------------

async function refreshPlans() {
  const p = state.probe;
  const body = JSON.stringify({
    path: p.path,
    in: frameAt(state.inIdx).display_time,
    out: frameAt(state.outIdx).display_time,
  });
  try {
    state.plans = await api("/api/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    state.planError = "";
    $("planError").textContent = "";
  } catch (err) {
    state.plans = null;
    state.planError = err.message;
    $("planError").textContent = `区间不合法：${err.message}`;
  }
  renderPlans();
}

function planRows(plan) {
  const rows = [
    ["要求入点", `#${plan.target_in_idx} / ${hms(plan.target_in_display)}`],
    ["要求出点(半开)", `#${plan.target_out_idx} 前 / ${hms(plan.target_out_display)}`],
    ["计划首帧", `#${plan.actual_in_idx} / ${hms(plan.actual_in_display)}`],
    ["计划尾界", `#${plan.actual_out_idx} 前 / ${hms(plan.actual_out_display)}`],
    ["声音", plan.has_audio ? "随视频一起裁" : "源片无音轨，仅视频"],
    ["说明", plan.note],
  ];
  return "<table>" + rows.map(([k, v]) =>
    `<tr><td>${k}</td><td class="mono">${v}</td></tr>`).join("") + "</table>";
}

function renderPlans() {
  if (!state.plans) return;
  $("planFast").innerHTML = planRows(state.plans.fast);
  $("planAcc").innerHTML = planRows(state.plans.accurate);
}

// ---------------- 执行与读回 ----------------

async function runCut(mode) {
  if (!state.plans || state.planError) {
    toast("当前区间不合法，无法裁切", true);
    return;
  }
  const p = state.probe;
  const body = JSON.stringify({
    path: p.path, mode,
    in: frameAt(state.inIdx).display_time,
    out: frameAt(state.outIdx).display_time,
  });
  toast("正在裁切并读回核对…");
  try {
    const data = await api("/api/cut", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    renderResult(data);
    toast("裁切完成，结果已读回");
  } catch (err) {
    toast(err.message, true);
  }
}

function badge(conf) {
  const label = { exact: "精确匹配", high: "高可信", medium: "中等可信", unknown: "无法判断" }[conf] || conf;
  return `<span class="badge ${conf}">${label}</span>`;
}

function frameMapText(m) {
  if (m.source_idx === null || m.source_idx === undefined) return `无法判断（${m.detail}）`;
  return `源片 #${m.source_idx} / ${hms(m.source_display_time)} ${badge(m.confidence)}
    <div class="hint">${m.detail}；与目标帧时间差 ${m.delta_vs_target_ms >= 0 ? "+" : ""}${m.delta_vs_target_ms} ms</div>`;
}

function renderResult(data) {
  const v = data.verify;
  const o = v.output;
  const rows = [
    ["成品文件", data.files.output],
    ["成品帧数", `${o.nb_frames} 帧`],
    ["成品首/尾显示时间", `${hms(o.first_display)} ~ ${hms(o.last_display)}（尾帧结束 ${hms(o.last_frame_end)}）`],
    ["成品首帧来源", frameMapText(v.first_frame)],
    ["成品尾帧来源", frameMapText(v.last_frame)],
    ["实际起点 vs 要求入点", v.actual_start_display === null ? "无法判断" : msLabel(v.actual_start_display - data.plan.target_in_display)],
  ];
  const ar = v.audio;
  if (ar.status === "none") {
    rows.push(["声音覆盖", ar.detail]);
  } else if (ar.status === "missing") {
    rows.push(["声音覆盖", `⚠️ ${ar.detail}`]);
  } else {
    rows.push(["声音覆盖(源片时间线)", `${hms(ar.source_display_start)} ~ ${hms(ar.source_display_end)}`]);
    rows.push(["声音头/尾缺口", `${ar.head_gap_ms >= 0 ? "+" : ""}${ar.head_gap_ms} ms / ${ar.tail_gap_ms >= 0 ? "+" : ""}${ar.tail_gap_ms} ms（${ar.detail}）`]);
  }
  const unknowns = v.unknowns.length
    ? `<div class="warn-item">无法判断：${v.unknowns.join("；")}</div>` : "";
  $("resultBox").innerHTML =
    `<div class="result-block"><table>${rows.map(([k, val]) =>
      `<tr><td>${k}</td><td class="mono">${val}</td></tr>`).join("")}</table>${unknowns}</div>`;
  $("reportLinks").innerHTML = ["output", "report_md", "report_json"].map((k) => {
    const name = data.files[k];
    const label = { output: "下载成品 MP4", report_md: "核对记录 Markdown", report_json: "核对记录 JSON" }[k];
    return `<a href="/api/report?name=${encodeURIComponent(name)}" target="_blank">${label} ↓</a>`;
  }).join("");
  $("resultPanel").classList.remove("hidden");
  $("resultPanel").scrollIntoView({ behavior: "smooth" });
}

// ---------------- 事件 ----------------

function renderAll() {
  renderInfo();
  renderTimeline();
  // renderThumbs 内部会 await refreshPlans 并渲染计划卡片，无需再单独刷新
  renderThumbs();
}

async function setInByIdx(idx) {
  state.inIdx = Math.max(0, Math.min(state.probe.frames.length - 1, idx));
  if (state.outIdx <= state.inIdx) state.outIdx = Math.min(state.probe.frames.length - 1, state.inIdx + 1);
  renderTimeline();
  await renderThumbs();
  refreshPlans();
}

async function setOutByIdx(idx) {
  state.outIdx = Math.max(0, Math.min(state.probe.frames.length - 1, idx));
  renderTimeline();
  refreshPlans();
}

function bind() {
  $("btnLoad").addEventListener("click", async () => {
    const path = $("srcPath").value.trim();
    if (!path) return toast("请先填写本机视频绝对路径", true);
    try { await loadMedia(path); } catch (err) { toast(err.message, true); }
  });
  $("srcPath").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btnLoad").click(); });

  $("btnGen").addEventListener("click", async () => {
    try {
      const data = await api("/api/generate-samples", { method: "POST", body: "{}" });
      $("genStatus").textContent =
        `已生成到 ${data.out_dir}：${data.manifest.files.join("、")}（关键帧 #${data.manifest.keyframe_indices.join(" #")}）`;
      $("srcPath").value = `${data.out_dir}/${data.manifest.files[0]}`;
      toast("测试素材已生成，路径已填入，点「载入素材」即可");
    } catch (err) { toast(err.message, true); }
  });

  $("prevFrame").addEventListener("click", () => setInByIdx(state.inIdx - 1));
  $("nextFrame").addEventListener("click", () => setInByIdx(state.inIdx + 1));
  $("outPrevFrame").addEventListener("click", () => setOutByIdx(state.outIdx - 1));
  $("outNextFrame").addEventListener("click", () => setOutByIdx(state.outIdx + 1));

  $("inTime").addEventListener("change", async () => {
    const t = parseFloat($("inTime").value);
    if (Number.isNaN(t) || !state.probe) return;
    const nearest = state.probe.frames.reduce((best, f) =>
      Math.abs(f.display_time - t) < Math.abs(best.display_time - t) ? f : best, state.probe.frames[0]);
    await setInByIdx(nearest.idx);
  });
  $("outTime").addEventListener("change", async () => {
    const t = parseFloat($("outTime").value);
    if (Number.isNaN(t) || !state.probe) return;
    const nearest = state.probe.frames.reduce((best, f) =>
      Math.abs(f.display_time - t) < Math.abs(best.display_time - t) ? f : best, state.probe.frames[0]);
    await setOutByIdx(nearest.idx);
  });

  $("btnMidCut").addEventListener("click", () => {
    const keys = state.probe.keyframes;
    const gap = keys.find((k) => k > state.inIdx);
    const prev = [...keys].reverse().find((k) => k <= state.inIdx) ?? 0;
    const target = gap ? Math.floor((prev + gap) / 2) : prev + 5;
    setInByIdx(target);
  });
  $("btnKeyCut").addEventListener("click", () => {
    const keys = state.probe.keyframes;
    const target = keys.find((k) => k > state.inIdx) ?? keys[0];
    setInByIdx(target);
  });

  document.querySelectorAll(".cut-btn").forEach((btn) =>
    btn.addEventListener("click", () => runCut(btn.dataset.mode)));
}

bind();
