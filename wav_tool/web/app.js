const $ = (sel) => document.querySelector(sel);

const state = {
  sourceId: null,
  sourceFile: null,
  wav: null,
  demo: null,
  cutConfig: null,
  cuts: [],
  segments: [],
  assemblyId: null,
  manifest: null,
  slotFiles: {},
  report: null,
  comparison: null,
  objectUrls: [],
};

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  el.style.background = isError ? "#7a271a" : "#101828";
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add("hidden"), 4200);
}

async function parseError(response) {
  try {
    const data = await response.json();
    return data.error || JSON.stringify(data);
  } catch {
    return `${response.status} ${response.statusText}`;
  }
}

function revokeObjectUrls() {
  while (state.objectUrls.length) URL.revokeObjectURL(state.objectUrls.pop());
}

function fmtInt(n) {
  if (n === null || n === undefined) return "—";
  return Number(n).toLocaleString("en-US");
}

function fmtSeconds(s, digits = 6) {
  if (s === null || s === undefined || Number.isNaN(s)) return "—";
  return `${Number(s).toFixed(digits).replace(/0+$/, "").replace(/\.$/, ".0")} s`;
}

function fmtMs(s) {
  if (s === null || s === undefined) return "—";
  return `${(Number(s) * 1000).toFixed(3)} ms`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function rangeText(r) {
  return `[${fmtInt(r.start_frame)}, ${fmtInt(r.end_frame)}) · ${fmtInt(r.frame_count)} 帧`;
}

function statusLabel(status) {
  return {
    ok: "采样校验通过",
    missing: "缺失",
    swapped: "内容属于其他段（调换）",
    same_name_replaced: "同名文件已被替换",
    hash_mismatch: "内容校验不符",
    invalid_wav: "WAV 无法读取",
    ambiguous_duplicate: "与多个重复段匹配",
  }[status] || status;
}

function sourceMetaHtml(wav, filename) {
  return `
    <span class="meta-pill">文件 <strong>${escapeHtml(filename || "WAV")}</strong></span>
    <span class="meta-pill">采样率 <strong>${fmtInt(wav.sample_rate)} Hz</strong></span>
    <span class="meta-pill">声道 <strong>${wav.channels}</strong></span>
    <span class="meta-pill">采样帧/声道样本 <strong>${fmtInt(wav.total_frames)}</strong></span>
    <span class="meta-pill">时长 <strong>${wav.duration_seconds.toFixed(3)} s</strong></span>
    <span class="meta-pill">位宽 <strong>${wav.sample_width * 8} bit</strong></span>
    <span class="meta-pill">格式 <strong>${wav.audio_format === 3 ? "IEEE float" : "PCM"}</strong></span>
  `;
}

function setSource(data, file = null) {
  state.sourceId = data.source_id;
  state.wav = data.wav;
  state.demo = data.demo || null;
  if (file) state.sourceFile = file;
  $("#sourceMeta").classList.remove("empty");
  $("#sourceMeta").innerHTML = sourceMetaHtml(data.wav, data.filename);
  $("#useLoadedSourceBtn").disabled = false;
}

async function uploadSourceFile(file) {
  $("#exportMessage").textContent = "正在读取 WAV…";
  const res = await fetch("/api/sources", {
    method: "POST",
    headers: { "X-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = await res.json();
  setSource(data, file);
  $("#exportMessage").textContent = "";
  await planCuts();
}

function getCutConfig() {
  const mode = $("#cutMode").value;
  if (mode === "fixed") {
    return { mode: "fixed", interval_seconds: Number($("#intervalSeconds").value) };
  }
  const raw = $("#customValues").value;
  const values = raw.split(/[\s,，;；]+/).filter(Boolean);
  return {
    mode: "custom",
    unit: mode === "custom_frames" ? "frames" : "seconds",
    values,
  };
}

async function planCuts() {
  if (!state.sourceId) {
    toast("请先选择或载入 WAV", true);
    return false;
  }
  const config = getCutConfig();
  const res = await fetch(`/api/sources/${state.sourceId}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    toast(await parseError(res), true);
    return false;
  }
  const data = await res.json();
  state.cutConfig = config;
  state.cuts = data.cuts;
  state.segments = data.segments;
  renderCuts();
  renderSegments();
  $("#exportBtn").disabled = false;
  toast(`已定位 ${state.cuts.length} 个切点、${state.segments.length} 个分段`);
  return true;
}

function renderCuts() {
  const tbody = $("#cutTable tbody");
  if (!state.cuts.length) {
    tbody.innerHTML = `<tr class="placeholder-row"><td colspan="6">没有内部切点；整段音频将作为唯一分段</td></tr>`;
    return;
  }
  tbody.innerHTML = state.cuts
    .map((cut) => {
      const delta = cut.delta_frames;
      const deltaClass = Math.abs(delta) < 0.0001 ? "ok" : "";
      return `
        <tr>
          <td><strong>#${cut.index}</strong></td>
          <td class="mono">${escapeHtml(cut.raw_text ?? cut.requested_seconds)}</td>
          <td class="frame-strong mono">${fmtInt(cut.frame)}</td>
          <td class="mono">${fmtSeconds(cut.time_seconds)}</td>
          <td class="mono ${deltaClass}">${delta >= 0 ? "+" : ""}${Number(delta).toFixed(3)} 帧<br><span class="hint">${cut.delta_seconds >= 0 ? "+" : ""}${fmtMs(cut.delta_seconds)}</span></td>
          <td><button class="secondary audition-btn" data-frame="${cut.frame}" data-index="${cut.index}">▶ 试听跨 #${cut.index}</button></td>
        </tr>`;
    })
    .join("");
}

function renderSegments() {
  const tbody = $("#segmentTable tbody");
  if (!state.segments.length) {
    tbody.innerHTML = `<tr class="placeholder-row"><td colspan="6">等待计算</td></tr>`;
    return;
  }
  tbody.innerHTML = state.segments
    .map(
      (s) => `
      <tr>
        <td>${s.order}</td>
        <td class="mono">${escapeHtml(s.filename)}</td>
        <td class="mono">${fmtInt(s.start_frame)}</td>
        <td class="mono">${fmtInt(s.end_frame)}</td>
        <td class="mono">${fmtInt(s.frame_count)}</td>
        <td class="mono">${s.start_seconds.toFixed(3)}–${s.end_seconds.toFixed(3)} s</td>
      </tr>`
    )
    .join("");
}

async function audition(frame, index) {
  if (!state.sourceId) return;
  const preMs = Number($("#preMs").value || 50);
  const postMs = Number($("#postMs").value || 100);
  const wav = state.wav;
  const preFrames = Math.round((preMs / 1000) * wav.sample_rate);
  const postFrames = Math.round((postMs / 1000) * wav.sample_rate);
  const start = Math.max(0, frame - preFrames);
  const end = Math.min(wav.total_frames, frame + postFrames);

  $("#auditionStatus").innerHTML = `切点 #${index} 位于采样帧 <strong>${fmtInt(frame)}</strong>；试听导出区间 <code>[${fmtInt(start)}, ${fmtInt(end)})</code>，共 ${fmtInt(end - start)} 帧。`;
  const res = await fetch(`/api/sources/${state.sourceId}/audition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ frame, pre_seconds: preMs / 1000, post_seconds: postMs / 1000 }),
  });
  if (!res.ok) {
    toast(await parseError(res), true);
    return;
  }
  const blob = await res.blob();
  revokeObjectUrls();
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);
  const player = $("#auditionPlayer");
  player.src = url;
  try { await player.play(); } catch { /* browser may require manual play */ }
}

async function exportZip() {
  if (!state.sourceId) return;
  // Always honor the currently visible cut form, even if the user changed it
  // after the last explicit “calculate” click.
  const planned = await planCuts();
  if (!planned) return;
  $("#exportMessage").className = "inline-message";
  $("#exportMessage").textContent = "正在生成分段和清单…";
  const res = await fetch(`/api/sources/${state.sourceId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.cutConfig),
  });
  if (!res.ok) {
    $("#exportMessage").className = "inline-message error";
    $("#exportMessage").textContent = await parseError(res);
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "wav_segments_with_manifest.zip";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("#exportMessage").className = "inline-message success";
  $("#exportMessage").textContent = "已导出 ZIP，内含 segments/*.wav 与 manifest.json。";
}

async function loadManifestFile(file) {
  const text = await file.text();
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    toast(`manifest JSON 无效：${e.message}`, true);
    return;
  }
  const res = await fetch("/api/assemblies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: text,
  });
  if (!res.ok) {
    toast(await parseError(res), true);
    return;
  }
  const data = await res.json();
  state.manifest = manifest;
  state.assemblyId = data.assembly_id;
  state.slotFiles = {};
  state.report = null;
  state.comparison = null;
  $("#slotTableWrap").classList.remove("hidden");
  $("#verifySummary").classList.add("hidden");
  $("#problemList").innerHTML = "";
  $("#previewBox").classList.add("hidden");
  $("#comparisonSummary").classList.add("hidden");
  $("#channelCompare").innerHTML = "";
  renderSlotTable();
  toast(`清单已载入：${manifest.segments.length} 段`);
}

function renderSlotTable(report = null) {
  const tbody = $("#slotTable tbody");
  tbody.innerHTML = state.manifest.segments
    .map((seg) => {
      const r = report?.segments?.find((x) => x.index === seg.index);
      const selected = state.slotFiles[seg.index];
      const provided = r?.provided_filename || selected?.name || "";
      return `
        <tr data-index="${seg.index}">
          <td><strong>#${seg.order}</strong><br><span class="slot-range mono">${rangeText(seg)}</span><br><span class="hint">${seg.start_seconds?.toFixed?.(3) ?? (seg.start_frame / state.manifest.source.wav.sample_rate).toFixed(3)}–${seg.end_seconds?.toFixed?.(3) ?? (seg.end_frame / state.manifest.source.wav.sample_rate).toFixed(3)} s</span></td>
          <td class="mono">${escapeHtml(seg.filename)}<br><span class="hint">${escapeHtml(seg.sha256_raw.slice(0, 16))}… raw</span></td>
          <td>
            <input type="file" accept=".wav,audio/wav" data-slot-input="${seg.index}" />
            <div class="slot-file-label slot-provided" data-selected-label="${seg.index}">${provided ? `已指定：${escapeHtml(provided)}` : "未选择"}</div>
          </td>
          <td class="slot-status-cell" data-slot-status="${seg.index}">${r ? renderStatus(r) : '<span class="badge neutral">待校验</span>'}</td>
        </tr>`;
    })
    .join("");
}

function renderStatus(r) {
  const badge = `<span class="badge ${escapeHtml(r.status)}">${statusLabel(r.status)}</span>`;
  const detail = [];
  if (r.error) detail.push(`<div class="hint error">${escapeHtml(r.error)}</div>`);
  if (r.warnings?.length) detail.push(...r.warnings.map((w) => `<div class="hint">⚠ ${escapeHtml(w)}</div>`));
  if (r.actual_sha256_raw) detail.push(`<div class="hint mono">actual ${escapeHtml(r.actual_sha256_raw.slice(0, 16))}…</div>`);
  return badge + detail.join("");
}

async function assignFilesToSlots(fileList) {
  const files = Array.from(fileList || []);
  const manifestFromFolder = files.find((file) => file.name === "manifest.json");
  if (manifestFromFolder && !state.assemblyId) {
    await loadManifestFile(manifestFromFolder);
  }
  if (!state.manifest) {
    toast("请先选择 manifest.json，或选择包含 manifest.json 的文件夹", true);
    return;
  }

  let assigned = 0;
  for (const file of files) {
    if (file.name === "manifest.json") continue;
    const idx = state.manifest.segments.findIndex(
      (s) => s.filename === file.name || s.file.endsWith(`/${file.name}`)
    );
    if (idx >= 0) {
      state.slotFiles[idx] = file;
      assigned++;
    }
  }
  if (assigned) {
    renderSlotTable(state.report);
    toast(`已按文件名自动分配 ${assigned} 个分段，可逐行调整`);
  } else if (!manifestFromFolder) {
    toast("没有找到与清单期望文件名匹配的 WAV；可在表格中手动分配", true);
  }
}

function updateSelectedLabels() {
  for (const [idx, file] of Object.entries(state.slotFiles)) {
    const el = document.querySelector(`[data-selected-label="${idx}"]`);
    if (el) {
      el.textContent = `已指定：${file.name}`;
      el.classList.add("success");
    }
  }
}

async function verifyAssembly() {
  if (!state.assemblyId) return;
  $("#verifyMessage").className = "inline-message";
  $("#verifyMessage").textContent = "正在上传并计算 SHA-256…";
  try {
    for (const [idx, file] of Object.entries(state.slotFiles)) {
      const res = await fetch(`/api/assemblies/${state.assemblyId}/segments/${idx}`, {
        method: "PUT",
        headers: { "X-Filename": encodeURIComponent(file.name), "Content-Type": "audio/wav" },
        body: file,
      });
      if (!res.ok) throw new Error(await parseError(res));
    }
    const res = await fetch(`/api/assemblies/${state.assemblyId}/verify`, { method: "POST" });
    if (!res.ok) throw new Error(await parseError(res));
    const data = await res.json();
    state.report = data.report;
    state.comparison = data.comparison;
    renderReport(data.report);
    if (data.comparison) renderComparison(data.comparison);
    $("#verifyMessage").className = "inline-message success";
    $("#verifyMessage").textContent = "校验完成";
  } catch (e) {
    $("#verifyMessage").className = "inline-message error";
    $("#verifyMessage").textContent = e.message;
  }
}

function renderReport(report) {
  state.report = report;
  if (state.manifest) renderSlotTable(report);

  const c = report.counts;
  const summary = $("#verifySummary");
  summary.classList.remove("hidden");
  summary.innerHTML = `
    <div class="stat ${report.sample_complete ? "good" : "bad"}"><div class="num">${report.sample_complete ? "完整" : "不完整"}</div><div class="label">${report.sample_complete ? "所有位置采样校验通过" : "尚不能按当前交接完整验收"}</div></div>
    <div class="stat good"><div class="num">${c.ok}</div><div class="label">校验通过段数</div></div>
    <div class="stat bad"><div class="num">${c.missing}</div><div class="label">缺失</div></div>
    <div class="stat warn"><div class="num">${c.swapped + c.ambiguous_duplicate}</div><div class="label">调换/身份不明</div></div>
    <div class="stat bad"><div class="num">${c.same_name_replaced + c.hash_mismatch + c.invalid_wav}</div><div class="label">替换/错误/损坏</div></div>
    <div class="stat ${report.all_expected_content_present ? "good" : "bad"}"><div class="num">${report.all_expected_content_present ? "是" : "否"}</div><div class="label">所有期望采样内容是否均可识别</div></div>
  `;

  const problems = $("#problemList");
  if (!report.problems.length) {
    problems.innerHTML = `<div class="problem" style="border-left-color:var(--ok-ink);background:var(--ok-bg)"><h4>✅ 全部逐段校对通过</h4><p>每段的实际原始采样字节均与清单一致，边界为半开区间，可完整拼回。</p></div>`;
  } else {
    problems.innerHTML = report.problems
      .map((p) => {
        const seg = state.manifest?.segments?.[p.index];
        const rate = state.manifest?.source?.wav?.sample_rate || 1;
        return `
        <div class="problem ${escapeHtml(p.status)}">
          <h4>第 ${p.order} 段：${statusLabel(p.status)}</h4>
          <p><strong>应处来源范围：</strong><span class="mono">${rangeText(p.range)}</span>，时间 ${(p.range.start_frame / rate).toFixed(6)}s → ${(p.range.end_frame / rate).toFixed(6)}s</p>
          <p>${escapeHtml(p.message || "")}</p>
        </div>`;
      })
      .join("");
  }

  const box = $("#previewBox");
  box.classList.remove("hidden", "good", "warn");
  const player = $("#restorePlayer");
  const download = $("#downloadAudio");
  if (report.sample_complete) {
    box.classList.add("good");
    $("#previewExplanation").innerHTML = "✅ 所有分段均通过实际采样数据校验。下面的 <code>restored.wav</code> 按清单顺序无损拼回，可与原始文件逐样本比较。";
    const url = `/api/assemblies/${state.assemblyId}/audio?kind=restored&t=${Date.now()}`;
    player.src = url;
    download.href = `${url}&download=1`;
    download.setAttribute("download", "restored.wav");
  } else {
    box.classList.add("warn");
    let extra = "";
    if (report.corrected_assembly_possible) {
      extra = " 所有期望内容的哈希都已出现：下面的预览会把可识别分段放到其清单指定的真实位置，因此可验证“纠正顺序后”样本完全连续；但当前交接的文件名/顺序仍不算完整验收通过。";
    } else {
      extra = " 缺失或无法识别的范围在预览中以静音零样本占位，时间轴保持不变；这只是部分成功预览，不算完整拼回。";
    }
    $("#previewExplanation").innerHTML = `⚠ 当前有 ${report.problems.length} 个位置未通过。${extra}`;
    const url = `/api/assemblies/${state.assemblyId}/audio?kind=partial&t=${Date.now()}`;
    player.src = url;
    download.href = `${url}&download=1`;
    download.setAttribute("download", "partial_timeline_preview.wav");
  }
}

async function compareOriginal(file) {
  if (!state.assemblyId) {
    toast("请先导入清单或运行演示，生成拼回/预览后再比较", true);
    return;
  }
  $("#compareUploadMessage").textContent = "正在逐声道比较…";
  const res = await fetch(`/api/assemblies/${state.assemblyId}/original`, {
    method: "POST",
    headers: { "X-Filename": encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) {
    $("#compareUploadMessage").className = "inline-message error";
    $("#compareUploadMessage").textContent = await parseError(res);
    return;
  }
  const data = await res.json();
  state.comparison = data.comparison;
  renderComparison(data.comparison);
  $("#compareUploadMessage").className = "inline-message success";
  $("#compareUploadMessage").textContent = "比较完成";
}

function renderComparison(cmp) {
  state.comparison = cmp;
  const sum = $("#comparisonSummary");
  sum.classList.remove("hidden");
  const identity = cmp.identical_sample_data;
  sum.innerHTML = `
    <div class="stat ${identity ? "good" : "bad"}"><div class="num">${identity ? "完全一致" : "存在差异"}</div><div class="label">各声道实际样本</div></div>
    <div class="stat ${cmp.frame_count_match ? "good" : "bad"}"><div class="num">${cmp.frame_count_match ? "相等" : "不等"}</div><div class="label">总采样帧数 / 每声道样本数</div></div>
    <div class="stat"><div class="num">${fmtInt(cmp.original_total_frames)}</div><div class="label">原始采样帧数 / 每声道样本数</div></div>
    <div class="stat"><div class="num">${fmtInt(cmp.candidate_total_frames)}</div><div class="label">拼回采样帧数 / 每声道样本数</div></div>
    <div class="stat"><div class="num">${fmtInt(cmp.original_total_sample_values)}</div><div class="label">原始采样值总数（帧×声道）</div></div>
    <div class="stat"><div class="num">${fmtInt(cmp.candidate_total_sample_values)}</div><div class="label">拼回采样值总数（帧×声道）</div></div>
    <div class="stat ${cmp.sample_rate_match ? "good" : "warn"}"><div class="num">${cmp.sample_rate_original}/${cmp.sample_rate_candidate}</div><div class="label">采样率 Hz</div></div>
    <div class="stat ${cmp.channels_match ? "good" : "warn"}"><div class="num">${cmp.channels_original}/${cmp.channels_candidate}</div><div class="label">声道数</div></div>
  `;

  const lengthHtml = (cmp.length_differences || [])
    .map(
      (d) => `<div class="problem"><h4>${escapeHtml(d.message)}</h4><p class="mono">${rangeText(d)} · ${fmtSeconds(d.start_seconds)}–${fmtSeconds(d.end_seconds)}</p></div>`
    )
    .join("");

  $("#channelCompare").innerHTML =
    lengthHtml +
    cmp.channels_report
      .map((ch) => {
        const cls = ch.identical ? "ok" : "bad";
        const badge = ch.identical
          ? '<span class="badge ok">样本完全一致</span>'
          : `<span class="badge missing">${ch.difference_count === null ? "声道缺失" : `${fmtInt(ch.difference_count)} 个样本不同`}</span>`;
        const first = ch.first_difference
          ? `<p>首个差异：采样帧 <strong class="frame-strong">${fmtInt(ch.first_difference.frame)}</strong>，时间 ${fmtSeconds(ch.first_difference.time_seconds)}；原始值 <code>${escapeHtml(ch.first_difference.expected)}</code>，拼回值 <code>${escapeHtml(ch.first_difference.actual)}</code></p>`
          : ch.note
            ? `<p>${escapeHtml(ch.note)}</p>`
            : "<p>无差异。</p>";
        const bounding = ch.bounding_difference_range
          ? `<p><strong>差异外包区间：</strong><span class="mono">${rangeText(ch.bounding_difference_range)}</span>，${ch.bounding_difference_range.start_seconds.toFixed(6)}s → ${ch.bounding_difference_range.end_seconds.toFixed(6)}s<br><span class="hint">${escapeHtml(ch.bounding_difference_range.note)}</span></p>`
          : "";
        const ranges = (ch.difference_ranges || [])
          .map(
            (r) => `<div class="range-chip mono">${rangeText(r)}<br>${r.start_seconds.toFixed(6)}s → ${r.end_seconds.toFixed(6)}s</div>`
          )
          .join("");
        return `
          <div class="channel-card ${cls}">
            <h3>声道 ${ch.channel + 1}${ch.label ? `（${ch.label}）` : ""} ${badge}</h3>
            ${first}
            ${bounding}
            ${ranges ? `<div class="range-list">${ranges}</div>` : ""}
            ${ch.ranges_truncated ? '<p class="hint">差异区间很多，仅显示前 100 段；difference_count 仍是完整统计。</p>' : ""}
          </div>`;
      })
      .join("");
}

async function loadDemoSource() {
  const res = await fetch("/api/demo/source");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "demo source failed");
  const rawRes = await fetch(`/api/sources/${data.source_id}/raw`);
  const blob = await rawRes.blob();
  const file = new File([blob], data.filename, { type: "audio/wav" });
  setSource(data, file);
  $("#cutMode").value = "fixed";
  $("#intervalSeconds").value = String(data.demo.interval_seconds || 1);
  toggleCutFields();
  await planCuts();
  toast("样音已载入：注意切点处左右相反的脉冲");
}

async function runDemo(caseName) {
  toast(`正在生成并校验演示：${caseName}…`);
  const res = await fetch(`/api/demo/run?case=${encodeURIComponent(caseName)}`, { method: "POST" });
  const data = await res.json();
  if (!res.ok) {
    toast(data.error || "演示失败", true);
    return;
  }
  state.assemblyId = data.assembly_id;
  state.manifest = data.manifest;
  state.slotFiles = {};
  state.wav = data.manifest.source.wav;
  state.cuts = data.cuts;
  state.report = data.report;
  state.comparison = data.comparison;
  $("#slotTableWrap").classList.remove("hidden");
  renderSlotTable(data.report);
  renderReport(data.report);
  renderComparison(data.comparison);
  $("#verifyMessage").textContent = "这是服务端内置演示的校验结果；也可手动选择导出的文件复现。";
  document.getElementById("verifySummary").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function toggleCutFields() {
  const mode = $("#cutMode").value;
  $("#intervalField").classList.toggle("hidden", mode !== "fixed");
  $("#customField").classList.toggle("hidden", mode === "fixed");
  $("#customField").querySelector("textarea").placeholder =
    mode === "custom_frames" ? "例如：44100, 88200, 132300" : "例如：1.0, 2.5, 4.25";
}

// Event wiring
$("#cutMode").addEventListener("change", toggleCutFields);
$("#planCutsBtn").addEventListener("click", () => planCuts().catch((e) => toast(e.message, true)));
$("#sourceFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) uploadSourceFile(file).catch((err) => toast(err.message, true));
});
$("#cutTable").addEventListener("click", (e) => {
  const btn = e.target.closest(".audition-btn");
  if (btn) audition(Number(btn.dataset.frame), Number(btn.dataset.index)).catch((err) => toast(err.message, true));
});
$("#exportBtn").addEventListener("click", () => exportZip().catch((e) => toast(e.message, true)));
$("#manifestFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) loadManifestFile(file).catch((err) => toast(err.message, true));
});
$("#segmentFiles").addEventListener("change", (e) =>
  assignFilesToSlots(e.target.files).catch((err) => toast(err.message, true))
);
$("#folderFiles").addEventListener("change", (e) =>
  assignFilesToSlots(e.target.files).catch((err) => toast(err.message, true))
);
$("#slotTable").addEventListener("change", (e) => {
  const input = e.target.closest("[data-slot-input]");
  if (!input) return;
  const idx = Number(input.dataset.slotInput);
  const file = input.files?.[0];
  if (file) {
    state.slotFiles[idx] = file;
    const label = document.querySelector(`[data-selected-label="${idx}"]`);
    if (label) {
      label.textContent = `已指定：${file.name}`;
      label.classList.add("success");
    }
  }
});
$("#verifyBtn").addEventListener("click", () => verifyAssembly().catch((e) => toast(e.message, true)));
$("#clearSlotsBtn").addEventListener("click", async () => {
  try {
    if (state.assemblyId) {
      await fetch(`/api/assemblies/${state.assemblyId}/clear`, { method: "POST" });
    }
    state.slotFiles = {};
    state.report = null;
    state.comparison = null;
    if (state.manifest) renderSlotTable();
    $("#verifySummary").classList.add("hidden");
    $("#problemList").innerHTML = "";
    $("#previewBox").classList.add("hidden");
    $("#comparisonSummary").classList.add("hidden");
    $("#channelCompare").innerHTML = "";
    $("#verifyMessage").className = "inline-message";
    $("#verifyMessage").textContent = "已清空已上传/选择的分段";
  } catch (err) {
    toast(err.message, true);
  }
});
$("#originalCompareFile").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) compareOriginal(file).catch((err) => toast(err.message, true));
});
$("#useLoadedSourceBtn").addEventListener("click", () => {
  if (!state.sourceFile) return toast("上方没有可上传的原始 File；演示一键场景已自带比较结果", true);
  compareOriginal(state.sourceFile).catch((err) => toast(err.message, true));
});
$("#loadDemoSourceBtn").addEventListener("click", () => loadDemoSource().catch((e) => toast(e.message, true)));
document.querySelectorAll("[data-demo]").forEach((btn) =>
  btn.addEventListener("click", () => runDemo(btn.dataset.demo).catch((e) => toast(e.message, true)))
);
