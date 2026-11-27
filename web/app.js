/* Shot Shelf front-end.
 *
 * State model: the server owns the project document; the browser keeps a
 * snapshot and re-renders from it. Every mutation (split, merge, tag, note,
 * boundary nudge) is a request, and the response's full project replaces the
 * snapshot — no local drift between thumbnail keys and in/out points.
 */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

  const state = {
    health: null,
    project: null,
    projects: [],
    sampleInfo: null,
    activeShotId: null,
    selected: new Set(),
    filters: { q: "", duration: "all", tagMode: "any", tags: new Set(), fromMs: null, toMs: null },
    playerTimeMs: 0,
    playing: false,
    settingsDirty: false,
    detailOpen: true,
    loadingShot: null,
    jobs: new Map(),
    localThumbs: new Map(),
    lastInspected: null,
    pendingNoteSave: null,
    tagDraft: "",
  };

  const els = {};
  const refs = [
    "project-select", "btn-import", "btn-sample", "btn-export", "btn-cache", "health-chip",
    "empty-state", "workspace", "project-title", "project-subtitle", "btn-refresh",
    "filter-q", "filter-duration", "filter-tag-mode", "btn-clear-filters",
    "filter-from", "filter-to", "btn-apply-range", "tag-filter",
    "shot-count", "btn-merge", "btn-clear-selection", "shot-list",
    "player", "player-placeholder", "btn-prev", "btn-play", "btn-next",
    "btn-frame-back", "btn-frame-fwd", "player-timecode",
    "btn-goto-in", "btn-goto-out", "timeline",
    "shot-editor", "editor-number", "btn-toggle-details", "btn-locate-boundary",
    "editor-thumb", "editor-thumb-sample", "editor-thumb-drift", "editor-evidence",
    "input-start", "input-end", "btn-start-here", "btn-end-here", "btn-split-playhead",
    "btn-merge-prev", "btn-merge-next", "shot-tags", "tag-input", "shot-note",
    "editor-save-state",
    "inspect-input", "btn-inspect", "btn-inspect-playhead", "inspect-image", "inspect-meta",
    "boundary-summary", "btn-reset-manual", "boundary-table",
    "val-threshold", "set-threshold", "val-strong", "set-strong", "val-minshot",
    "set-minshot", "set-keep-short", "set-merge-similar", "val-lumatol", "set-lumatol",
    "val-sattol", "set-sattol", "btn-apply-settings", "btn-reset-settings", "settings-hint",
    "project-meta", "btn-export-2", "btn-open-export", "btn-delete-project", "export-result",
    "toast", "import-dialog", "import-form", "import-path", "import-name", "import-analyze",
    "import-note", "btn-pick-file", "btn-import-confirm", "btn-import-2", "btn-sample-2",
    "cache-dialog", "cache-list", "cache-note", "btn-clear-cache",
    "progress-dialog", "progress-title", "progress-bar", "progress-message", "btn-progress-close",
  ];
  for (const id of refs) els[id] = $(id);

  // ------------------------------------------------------------------ utils

  function toast(message, kind = "") {
    const node = els["toast"];
    node.textContent = message;
    node.className = "toast" + (kind ? " " + kind : "");
    node.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { node.hidden = true; }, kind === "error" ? 6000 : 3200);
  }

  function msToTc(ms, withMillis = true) {
    ms = Math.max(0, Math.round(ms || 0));
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor(ms % 1000);
    const base = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return withMillis ? `${base}.${String(millis).padStart(3, "0")}` : base;
  }

  function tcToMs(text) {
    text = String(text || "").trim().replace(/：/g, ":");
    if (!text) return null;
    if (text.includes(":")) {
      const parts = text.split(":");
      if (parts.length > 3) return null;
      const nums = parts.map((p) => {
        const value = parseFloat(p.replace(",", "."));
        return Number.isFinite(value) ? value : NaN;
      });
      if (nums.some(Number.isNaN)) return null;
      let total = 0;
      for (const n of nums) total = total * 60 + n;
      return Math.round(total * 1000);
    }
    const value = parseFloat(text);
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 1000);
  }

  function fmtDuration(ms) {
    const seconds = Math.max(0, ms) / 1000;
    if (seconds < 10) return seconds.toFixed(2) + "s";
    if (seconds < 60) return seconds.toFixed(1) + "s";
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function frameMs() {
    const fps = state.project?.media?.info?.fps || 30;
    return 1000 / fps;
  }

  function escapeHtml(text) {
    return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {} };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(path, init);
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* empty body */ }
    if (!response.ok) {
      const message = payload?.error || `请求失败 (${response.status})`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  // --------------------------------------------------------------- project

  const durationFilter = {
    "0-1000": [0, 1000],
    "1000-3000": [1000, 3000],
    "3000-8000": [3000, 8000],
    "8000-99999999": [8000, Number.POSITIVE_INFINITY],
  };

  function shotsFiltered() {
    const project = state.project;
    if (!project) return [];
    const { q, duration, tags, tagMode, fromMs, toMs } = state.filters;
    const needle = q.trim().toLowerCase();
    return project.shots.filter((shot) => {
      if (fromMs != null && shot.end_ms <= fromMs) return false;
      if (toMs != null && shot.start_ms >= toMs) return false;
      if (duration !== "all") {
        const [lo, hi] = durationFilter[duration] || [0, Infinity];
        if (shot.duration_ms < lo || shot.duration_ms >= hi) return false;
      }
      if (tags.size) {
        const list = [...tags];
        const hit = tagMode === "all"
          ? list.every((t) => shot.tags.includes(t))
          : list.some((t) => shot.tags.includes(t));
        if (!hit) return false;
      }
      if (needle) {
        const hay = [
          shot.tags.join(" "), shot.note, shot.start_tc, shot.end_tc,
          String(shot.number), shot.id,
        ].join(" ").toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }

  function activeShot() {
    if (!state.project || !state.activeShotId) return null;
    return state.project.shots.find((shot) => shot.id === state.activeShotId) || null;
  }

  function shotIndex(shot) {
    return state.project.shots.indexOf(shot);
  }

  function thumbUrl(shot, width = 480) {
    if (!state.project) return "";
    // The version param covers everything that changes the pixels: the media
    // fingerprint, the shot's in/out points, and the sample width.  When a
    // boundary moves the URL changes, so the browser can never reuse an
    // immutable cached image from the previous cut.
    const fingerprint = state.project.media?.fingerprint || "";
    const version = `${fingerprint}-${shot.start_ms}-${shot.end_ms}-${width}`;
    return `/api/projects/${state.project.id}/thumb?shot_id=${encodeURIComponent(shot.id)}&pos=0.35&w=${width}&v=${version}`;
  }

  // ---------------------------------------------------------------- render

  function setProject(project) {
    const previousShot = state.activeShotId;
    state.project = project;
    // Prefer an id match; otherwise keep the new shot that covers the same
    // time so an edit does not jump the selection back to the first shot.
    let nextShotId = project.shots[0]?.id || null;
    if (project.shots.some((shot) => shot.id === previousShot)) {
      nextShotId = previousShot;
    } else if (state.playerTimeMs > 0) {
      const covering = project.shots.find(
        (shot) => shot.start_ms <= state.playerTimeMs && state.playerTimeMs < shot.end_ms
      );
      if (covering) nextShotId = covering.id;
    }
    state.activeShotId = nextShotId;
    for (const id of [...state.selected]) {
      if (!project.shots.some((shot) => shot.id === id)) state.selected.delete(id);
    }
    state.localThumbs.clear();
    renderAll();
    loadPlayerSource();
  }

  function renderAll() {
    if (!state.project) {
      els["empty-state"].hidden = false;
      els.workspace.hidden = true;
      return;
    }
    els["empty-state"].hidden = true;
    els.workspace.hidden = false;
    renderProjectHeader();
    renderTagFilter();
    renderShotList();
    renderEditor();
    renderBoundaries();
    renderSidebar();
    drawTimeline();
    syncTransport();
  }

  function renderProjectHeader() {
    const project = state.project;
    els["project-title"].textContent = project.name || "未命名项目";
    const info = project.media.info;
    els["project-subtitle"].textContent =
      `${project.media.name} · ${msToTc(info.duration_ms, false)} · ${info.width}×${info.height} @ ${info.fps}fps`;
    els["btn-export"].disabled = !project.shots.length;
    els["btn-export-2"].disabled = !project.shots.length;
    els["project-select"].innerHTML = state.projects.map((item) =>
      `<option value="${escapeHtml(item.id)}" ${item.id === project.id ? "selected" : ""}>${escapeHtml(item.name || item.id)}</option>`
    ).join("");
  }

  function renderTagFilter() {
    const tags = state.project?.tags || [];
    const container = els["tag-filter"];
    if (!tags.length) {
      container.innerHTML = '<span class="muted tiny">还没有标签。给片段添加标签后会出现在这里。</span>';
      return;
    }
    container.innerHTML = tags.map(({ tag, count }) => {
      const pressed = state.filters.tags.has(tag);
      return `<button type="button" class="tag-pill" data-tag="${escapeHtml(tag)}" aria-pressed="${pressed}">${escapeHtml(tag)}<span class="n">${count}</span></button>`;
    }).join("");
    for (const button of container.querySelectorAll(".tag-pill")) {
      button.addEventListener("click", () => {
        const tag = button.dataset.tag;
        if (state.filters.tags.has(tag)) state.filters.tags.delete(tag);
        else state.filters.tags.add(tag);
        renderTagFilter();
        renderShotList();
      });
    }
  }

  function renderShotList() {
    const shots = shotsFiltered();
    els["shot-count"].textContent = `${shots.length} / ${state.project.shots.length} 个片段`;
    const selectedCount = state.selected.size;
    els["btn-merge"].disabled = selectedCount < 2;
    els["btn-clear-selection"].disabled = selectedCount === 0;
    if (!shots.length) {
      els["shot-list"].innerHTML = '<div class="list-empty">没有符合条件的片段。<br>试试清空筛选。</div>';
      return;
    }
    const html = shots.map((shot) => {
      const classes = ["shot-item"];
      if (shot.id === state.activeShotId) classes.push("active");
      if (state.selected.has(shot.id)) classes.push("selected");
      const thumb = state.localThumbs.get(shot.id) || thumbUrl(shot, 200);
      const badge = shot.created_manual ? '<span class="shot-flag">人工</span>' : "";
      return `
        <div class="${classes.join(" ")}" data-shot="${escapeHtml(shot.id)}" tabindex="0">
          <span class="shot-check" data-check="${escapeHtml(shot.id)}" role="checkbox" aria-checked="${state.selected.has(shot.id)}">${state.selected.has(shot.id) ? "✓" : ""}</span>
          <img class="shot-thumb" loading="lazy" src="${thumb}" alt="">
          <div class="shot-body">
            <div class="shot-line1">
              <span class="shot-num">#${String(shot.number).padStart(3, "0")} ${badge}</span>
              <span class="shot-dur">${fmtDuration(shot.duration_ms)}</span>
            </div>
            <div class="shot-tc">${shot.start_tc} → ${shot.end_tc}</div>
            ${shot.tags.length ? `<div class="shot-tags">${shot.tags.slice(0, 4).map((t) => `<i>${escapeHtml(t)}</i>`).join("")}</div>` : ""}
            ${shot.note ? `<div class="shot-note-preview">${escapeHtml(shot.note)}</div>` : ""}
          </div>
        </div>`;
    }).join("");
    els["shot-list"].innerHTML = html;
    for (const row of els["shot-list"].querySelectorAll(".shot-item")) {
      row.addEventListener("click", (event) => {
        if (event.target.closest("[data-check]")) {
          toggleSelect(row.dataset.shot);
          return;
        }
        selectShot(row.dataset.shot, { seek: true });
      });
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectShot(row.dataset.shot, { seek: true });
        }
      });
    }
    const active = els["shot-list"].querySelector(".shot-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
  }

  function toggleSelect(shotId) {
    if (state.selected.has(shotId)) state.selected.delete(shotId);
    else state.selected.add(shotId);
    renderShotList();
  }

  function renderEditor() {
    const shot = activeShot();
    if (!shot) {
      els["shot-editor"].hidden = true;
      els["player-placeholder"].hidden = false;
      return;
    }
    els["shot-editor"].hidden = false;
    els["editor-number"].textContent = `#${String(shot.number).padStart(3, "0")} · ${shot.id}`;
    els["input-start"].value = shot.start_tc;
    els["input-end"].value = shot.end_tc;
    els["shot-note"].value = shot.note || "";
    els["tag-input"].value = state.tagDraft;

    els["shot-tags"].innerHTML = shot.tags.length
      ? shot.tags.map((tag) => `<span class="tag-chip">${escapeHtml(tag)}<button type="button" data-remove-tag="${escapeHtml(tag)}" title="移除">×</button></span>`).join("")
      : '<span class="muted small">暂无标签</span>';
    for (const button of els["shot-tags"].querySelectorAll("[data-remove-tag]")) {
      button.addEventListener("click", () => removeTag(button.dataset.removeTag));
    }

    const url = state.localThumbs.get(shot.id) || thumbUrl(shot, 640);
    els["editor-thumb"].src = url;
    els["editor-thumb"].alt = `片段 ${shot.number} 缩略图`;
    // Sample position is known server-side even before the image loads.
    els["editor-thumb-sample"].textContent = shot.thumb_sample_tc
      ? `取样 ${shot.thumb_sample_tc}`
      : "";
    els["editor-thumb-drift"].textContent = "";

    // The image response carries the requested time, the decoded PTS and the
    // drift.  `force-cache` reuses the immutable thumbnail the <img> already
    // fetched, so this costs no second extraction; any real drift caused by
    // seek rounding is surfaced instead of hidden.
    const wantedShot = shot.id;
    fetch(url, { cache: "force-cache" })
      .then((response) => {
        if (!response.ok || state.activeShotId !== wantedShot) return;
        const sampleMs = Number(response.headers.get("X-Requested-Ms"));
        const actualRaw = response.headers.get("X-Actual-Ms");
        const driftRaw = response.headers.get("X-Drift-Ms");
        if (Number.isFinite(sampleMs) && response.headers.get("X-Requested-Ms")) {
          els["editor-thumb-sample"].textContent = `取样 ${msToTc(sampleMs)}`;
        }
        if (actualRaw && driftRaw) {
          const drift = Number(driftRaw);
          if (!Number.isFinite(drift)) return;
          const tolerance = 1000 / (state.project?.media?.info?.fps || 30) / 2;
          const aligned = Math.abs(drift) <= tolerance;
          els["editor-thumb-drift"].textContent = aligned
            ? "对位准确"
            : `解码帧偏移 ${drift > 0 ? "+" : ""}${drift}ms`;
          els["editor-thumb-drift"].className = "small " + (aligned ? "ok" : "warn");
        }
      })
      .catch(() => {});

    els["editor-evidence"].innerHTML = evidenceForShot(shot);
    const detailsHidden = !state.detailOpen;
    els["shot-editor"].querySelector(".editor-grid").style.display = detailsHidden ? "none" : "";
    els["btn-toggle-details"].textContent = detailsHidden ? "展开细节" : "收起细节";
  }

  function evidenceForShot(shot) {
    const boundaries = state.project.detection?.boundaries || [];
    const startBoundary = boundaries.find((b) => Math.abs(b.at_ms - shot.start_ms) <= 2 && b.decision !== "merged");
    const endBoundary = boundaries.find((b) => Math.abs(b.at_ms - shot.end_ms) <= 2 && b.decision !== "merged");
    const parts = [];
    for (const [label, boundary] of [["入点", startBoundary], ["出点", endBoundary]]) {
      if (!boundary) {
        parts.push(`<div class="row"><b>${label}</b><span>${label === "入点" && shot.start_ms === 0 ? "视频开头" : label === "出点" ? "没有后续切点" : "视频开头"}</span></div>`);
        continue;
      }
      const strength = boundary.source === "manual" ? "手动" : `强度 ${Number(boundary.score).toFixed(2)}`;
      const kind = boundary.kind === "manual" ? "人工切点" : boundary.kind === "gradual" ? "渐变" : "硬切";
      parts.push(
        `<div class="row"><b>${label}</b><span>${kind} · ${strength} · 置信 ${boundary.confidence_label || "-"}</span></div>`
      );
      parts.push(`<div class="row"><span>${escapeHtml(boundary.reason || "")}</span></div>`);
    }
    return parts.join("");
  }

  function renderBoundaries() {
    const detection = state.project.detection || {};
    const boundaries = [...(detection.boundaries || [])].sort((a, b) => a.at_ms - b.at_ms);
    const summary = detection.summary || {};
    els["boundary-summary"].textContent =
      `${boundaries.length} 个候选 · 保留 ${summary.cuts ?? "-"} · 合并 ${summary.merged ?? "-"}` +
      (summary.kept_short ? ` · 保留短镜头 ${summary.kept_short}` : "") +
      (summary.flash_merged ? ` · 闪光合并 ${summary.flash_merged}` : "");
    const tbody = els["boundary-table"].querySelector("tbody");
    if (!boundaries.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="muted">还没有切点数据。导入视频并分析后会出现在这里。</td></tr>';
      return;
    }
    tbody.innerHTML = boundaries.map((boundary) => {
      const decision = boundary.decision || "candidate";
      const label = decision === "kept" ? "保留"
        : decision === "short-kept" ? "保留短镜头"
        : decision === "merged" ? "已合并" : "候选";
      const manual = boundary.source === "manual";
      const conf = clamp(Number(boundary.confidence) || 0, 0, 1);
      const isActive = activeShot() && (Math.abs(boundary.at_ms - activeShot().start_ms) <= 2 || Math.abs(boundary.at_ms - activeShot().end_ms) <= 2);
      return `
        <tr data-boundary="${boundary.at_ms}" class="${isActive ? "active" : ""}">
          <td class="num"><button class="row-action" data-seek="${boundary.at_ms}" title="跳到这个位置">${msToTc(boundary.at_ms)}</button></td>
          <td class="num">
            <span class="conf-bar" title="置信度 ${(conf * 100).toFixed(0)}%">
              <span class="bar"><span class="fill" style="width:${(conf * 100).toFixed(0)}%"></span></span>
              ${Number(boundary.score).toFixed(2)}
            </span>
            <div class="kind-tag">${escapeHtml(boundary.confidence_label || "")}</div>
          </td>
          <td>${manual ? "手动" : boundary.kind === "gradual" ? "渐变" : "硬切"}</td>
          <td class="num">${boundary.width_ms ?? 0}ms</td>
          <td class="num">${Number(boundary.luma_delta || 0) >= 0 ? "+" : ""}${Number(boundary.luma_delta || 0).toFixed(1)}</td>
          <td class="num">${Number(boundary.sat_delta || 0) >= 0 ? "+" : ""}${Number(boundary.sat_delta || 0).toFixed(1)}</td>
          <td><span class="pill ${manual ? "manual" : decision}">${label}</span></td>
          <td class="reason">${escapeHtml(boundary.reason || "")}</td>
          <td>
            ${decision !== "merged" && boundary.at_ms > 0 && boundary.at_ms < (state.project.media.info.duration_ms)
              ? `<button class="row-action" data-remove-cut="${boundary.at_ms}" title="删除这个切点并合并两侧">删除切点</button>` : ""}
          </td>
        </tr>`;
    }).join("");

    for (const button of tbody.querySelectorAll("[data-seek]")) {
      button.addEventListener("click", () => seekTo(Number(button.dataset.seek)));
    }
    for (const button of tbody.querySelectorAll("[data-remove-cut]")) {
      button.addEventListener("click", () => removeCut(Number(button.dataset.removeCut)));
    }
  }

  function renderSidebar() {
    const project = state.project;
    const info = project.media.info;
    const stats = project.stats || {};
    const rows = [
      ["源文件", project.media.name],
      ["路径", project.media.path],
      ["时长", msToTc(info.duration_ms)],
      ["分辨率", `${info.width}×${info.height}`],
      ["帧率", `${info.fps} fps`],
      ["片段数", String(stats.shot_count ?? project.shots.length)],
      ["已加标签", String(stats.tagged ?? 0)],
      ["已写备注", String(stats.noted ?? 0)],
      ["人工修正", String(stats.manual_edits ?? 0)],
      ["缩略图缓存", `${project.thumb_stats?.files ?? 0} 张`],
    ];
    els["project-meta"].innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd title="${escapeHtml(v)}">${escapeHtml(v)}</dd>`).join("");

    const settings = project.settings || {};
    if (!state.settingsDirty) {
      els["set-threshold"].value = settings.threshold ?? 0.26;
      els["set-strong"].value = settings.strong_threshold ?? 0.52;
      els["set-minshot"].value = settings.min_shot_ms ?? 800;
      els["set-keep-short"].checked = settings.keep_short_strong !== false;
      els["set-merge-similar"].checked = settings.merge_similar !== false;
      els["set-lumatol"].value = settings.similar_luma_tol ?? 16;
      els["set-sattol"].value = settings.similar_sat_tol ?? 20;
    }
    els["val-threshold"].textContent = Number(els["set-threshold"].value).toFixed(2);
    els["val-strong"].textContent = Number(els["set-strong"].value).toFixed(2);
    els["val-minshot"].textContent = `${Math.round(Number(els["set-minshot"].value))}ms`;
    els["val-lumatol"].textContent = Number(els["set-lumatol"].value).toFixed(0);
    els["val-sattol"].textContent = Number(els["set-sattol"].value).toFixed(0);
    els["btn-apply-settings"].disabled = !state.settingsDirty;
    els["settings-hint"].textContent = state.settingsDirty
      ? "有未应用的改动。"
      : "调整后只在本机重新计算切点，不重新解码视频。";
  }

  // -------------------------------------------------------------- timeline

  function drawTimeline() {
    const canvas = els.timeline;
    const project = state.project;
    if (!canvas || !project) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.round(88 * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = rect.width;
    const height = 88;
    ctx.clearRect(0, 0, width, height);

    const duration = Math.max(1, project.media.info.duration_ms);
    const xOf = (ms) => clamp((ms / duration) * width, 0, width);

    // Background
    ctx.fillStyle = "#0b0e13";
    ctx.fillRect(0, 0, width, height);

    // Shot bands
    const chartTop = 10;
    const chartHeight = 46;
    for (const shot of project.shots) {
      const x0 = xOf(shot.start_ms);
      const x1 = xOf(shot.end_ms);
      const isActive = shot.id === state.activeShotId;
      ctx.fillStyle = isActive ? "rgba(124,196,255,0.18)" : "rgba(255,255,255,0.035)";
      ctx.fillRect(x0 + 0.5, chartTop - 8 + 46, Math.max(1, x1 - x0 - 1), 22);
      if (isActive) {
        ctx.strokeStyle = "rgba(124,196,255,0.55)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, chartTop - 8 + 46, Math.max(1, x1 - x0 - 1), 22);
      }
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fillRect(x0 + 0.5, chartTop, Math.max(0.5, x1 - x0 - 1), chartHeight);
    }

    // Score series
    const series = project.detection?.series || [];
    if (series.length) {
      const maxScore = Math.max(0.5, ...series.map(([, v]) => v));
      ctx.beginPath();
      ctx.moveTo(0, chartTop + chartHeight);
      for (const [ms, value] of series) {
        const x = xOf(ms);
        const y = chartTop + chartHeight - clamp(value / maxScore, 0, 1) * chartHeight;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, chartTop + chartHeight);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, chartTop, 0, chartTop + chartHeight);
      gradient.addColorStop(0, "rgba(124,196,255,0.55)");
      gradient.addColorStop(1, "rgba(124,196,255,0.06)");
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    // Sensitivity line
    const threshold = project.settings?.threshold ?? 0.26;
    const maxScore = Math.max(0.5, ...(series.map(([, v]) => v)));
    const ty = chartTop + chartHeight - clamp(threshold / maxScore, 0, 1) * chartHeight;
    ctx.strokeStyle = "rgba(255,212,121,0.5)";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, ty);
    ctx.lineTo(width, ty);
    ctx.stroke();
    ctx.setLineDash([]);

    // Boundaries
    const boundaries = project.detection?.boundaries || [];
    for (const boundary of boundaries) {
      const x = xOf(boundary.at_ms);
      let color = "rgba(142,230,168,0.9)";
      if (boundary.source === "manual") color = "rgba(255,212,121,0.95)";
      else if (boundary.decision === "merged") color = "rgba(255,156,138,0.45)";
      ctx.strokeStyle = color;
      ctx.lineWidth = boundary.decision === "merged" ? 1 : 1.4;
      ctx.beginPath();
      ctx.moveTo(x, chartTop - 4);
      ctx.lineTo(x, chartTop + chartHeight + 2);
      ctx.stroke();
    }

    // Playhead
    const px = xOf(state.playerTimeMs);
    ctx.strokeStyle = "#7cc4ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
    ctx.stroke();
    ctx.fillStyle = "#7cc4ff";
    ctx.beginPath();
    ctx.moveTo(px - 4, 0);
    ctx.lineTo(px + 4, 0);
    ctx.lineTo(px, 6);
    ctx.closePath();
    ctx.fill();

    // Shot edges (numbered ticks)
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.font = "9px -apple-system, sans-serif";
    for (const shot of project.shots) {
      if (shot.number === 1 || shot.number % Math.max(1, Math.ceil(project.shots.length / 12)) === 0) {
        const x = xOf(shot.start_ms);
        if (x > 12 && x < width - 12) ctx.fillText(String(shot.number), x + 3, chartTop - 2);
      }
    }
  }

  // ---------------------------------------------------------------- player

  function loadPlayerSource() {
    const player = els.player;
    const project = state.project;
    if (!project) return;
    const wanted = `/api/projects/${project.id}/video`;
    if (!player.src.endsWith(wanted)) {
      player.src = wanted;
    }
    els["player-placeholder"].hidden = true;
  }

  function seekTo(ms, { selectShot = false } = {}) {
    const player = els.player;
    const project = state.project;
    if (!project) return;
    const duration = project.media.info.duration_ms;
    ms = clamp(ms, 0, Math.max(0, duration - 1));
    state.playerTimeMs = ms;
    if (player.readyState > 0) {
      try { player.currentTime = ms / 1000; } catch (_) { /* not seekable yet */ }
    } else {
      player.addEventListener("loadedmetadata", () => { try { player.currentTime = ms / 1000; } catch (_) {} }, { once: true });
    }
    if (selectShot) {
      const shot = project.shots.find((s) => s.start_ms <= ms && ms < s.end_ms);
      if (shot && shot.id !== state.activeShotId) {
        selectShotById(shot.id, { seek: false });
      }
    }
    updateTimecode();
    drawTimeline();
  }

  function selectShot(shotId, { seek = false } = {}) {
    selectShotById(shotId, { seek });
  }

  function selectShotById(shotId, { seek = true } = {}) {
    let shot = state.project.shots.find((s) => s.id === shotId);
    if (!shot) return;
    state.activeShotId = shotId;
    if (seek) seekTo(shot.start_ms);
    renderShotList();
    renderEditor();
    renderBoundaries();
    drawTimeline();
    updateTimecode();
  }

  function updateTimecode() {
    const fps = state.project?.media?.info?.fps || 30;
    const frame = Math.round((state.playerTimeMs * fps) / 1000);
    els["player-timecode"].innerHTML = `${msToTc(state.playerTimeMs)} <span class="muted">帧 ${frame}</span>`;
  }

  function syncTransport() {
    const player = els.player;
    els["btn-play"].textContent = player.paused ? "▶" : "⏸";
    const shot = activeShot();
    els["btn-goto-in"].disabled = !shot;
    els["btn-goto-out"].disabled = !shot;
  }

  function stepFrame(direction) {
    const ms = frameMs();
    seekTo(state.playerTimeMs + direction * ms);
  }

  function gotoAdjacent(direction) {
    const project = state.project;
    if (!project) return;
    const shots = project.shots;
    const current = activeShot() || shots[0];
    const index = shots.indexOf(current);
    const next = shots[clamp(index + direction, 0, shots.length - 1)];
    if (next) selectShotById(next.id, { seek: true });
  }

  // ------------------------------------------------------------- mutations

  async function refreshProject(projectPayload) {
    // Keep the playing position and selection stable across edits unless the
    // active shot disappeared; setProject already handles that fallback.
    setProject(projectPayload);
  }

  async function patchShot(shotId, patch, { quiet = false } = {}) {
    const project = state.project;
    if (!project) return;
    try {
      const payload = await api(`/api/projects/${project.id}/shots/${encodeURIComponent(shotId)}`, {
        method: "PATCH", body: patch,
      });
      await refreshProject(payload.project);
      if (!quiet) flashSaveState("已保存");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  let saveTimer = null;
  function flashSaveState(text, kind = "") {
    const node = els["editor-save-state"];
    node.textContent = text;
    node.className = "save-state small " + (kind || "muted");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { node.textContent = ""; }, 2200);
  }

  async function commitNote(value) {
    const shot = activeShot();
    if (!shot) return;
    if ((shot.note || "") === value) return;
    await patchShot(shot.id, { note: value }, { quiet: true });
    flashSaveState("备注已保存", "ok");
  }

  async function addTag(tag) {
    const shot = activeShot();
    if (!shot) return;
    tag = String(tag || "").trim();
    if (!tag) return;
    if (shot.tags.includes(tag)) { state.tagDraft = ""; renderEditor(); return; }
    state.tagDraft = "";
    await patchShot(shot.id, { tags: [...shot.tags, tag] }, { quiet: true });
    flashSaveState("标签已添加", "ok");
    els["tag-input"].focus();
  }

  async function removeTag(tag) {
    const shot = activeShot();
    if (!shot) return;
    await patchShot(shot.id, { tags: shot.tags.filter((t) => t !== tag) }, { quiet: true });
    flashSaveState("标签已移除", "ok");
  }

  async function splitAtPlayhead() {
    const shot = activeShot();
    if (!shot) return;
    const at = state.playerTimeMs;
    if (!(shot.start_ms < at && at < shot.end_ms)) {
      toast("播放头不在当前片段内", "error");
      return;
    }
    try {
      const payload = await api(`/api/projects/${state.project.id}/split`, {
        method: "POST", body: { shot_id: shot.id, at_ms: at },
      });
      await refreshProject(payload.project);
      toast("已在播放头处切开", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function mergeShots(shotIds) {
    if (!shotIds || shotIds.length < 2) return;
    try {
      const payload = await api(`/api/projects/${state.project.id}/merge`, {
        method: "POST", body: { shot_ids: shotIds },
      });
      state.selected.clear();
      await refreshProject(payload.project);
      toast(`已合并 ${shotIds.length} 个片段`, "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function mergeWithNeighbour(direction) {
    const shot = activeShot();
    if (!shot) return;
    const index = state.project.shots.indexOf(shot);
    const other = state.project.shots[index + direction];
    if (!other) { toast(direction < 0 ? "已经是第一段" : "已经是最后一段", "error"); return; }
    await mergeShots(direction < 0 ? [other.id, shot.id] : [shot.id, other.id]);
  }

  async function removeCut(atMs) {
    try {
      const payload = await api(`/api/projects/${state.project.id}/boundaries/remove`, {
        method: "POST", body: { at_ms: atMs },
      });
      await refreshProject(payload.project);
      toast("已删除切点并合并两侧片段", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function applyBoundary(field, valueMs) {
    const shot = activeShot();
    if (!shot) return;
    try {
      const payload = await api(`/api/projects/${state.project.id}/shots/${encodeURIComponent(shot.id)}`, {
        method: "PATCH", body: field === "start" ? { start_ms: valueMs } : { end_ms: valueMs },
      });
      await refreshProject(payload.project);
      flashSaveState("边界已更新", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function resetManual() {
    try {
      const payload = await api(`/api/projects/${state.project.id}/reset`, { method: "POST", body: {} });
      await refreshProject(payload.project);
      toast("已清除人工修正并按当前设置重检", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // ------------------------------------------------------------- detection

  function settingsFromForm() {
    return {
      threshold: Number(els["set-threshold"].value),
      strong_threshold: Number(els["set-strong"].value),
      min_shot_ms: Math.round(Number(els["set-minshot"].value)),
      keep_short_strong: els["set-keep-short"].checked,
      merge_similar: els["set-merge-similar"].checked,
      similar_luma_tol: Number(els["set-lumatol"].value),
      similar_sat_tol: Number(els["set-sattol"].value),
    };
  }

  async function applySettings() {
    try {
      const payload = await api(`/api/projects/${state.project.id}/detect`, {
        method: "POST", body: { settings: settingsFromForm() },
      });
      state.settingsDirty = false;
      await refreshProject(payload.project);
      toast("已按新设置重新切分", "ok");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // ---------------------------------------------------------------- import

  function openImportDialog(prefillPath = "") {
    els["import-path"].value = prefillPath;
    els["import-note"].textContent = "";
    els["import-note"].className = "dialog-note";
    els["import-dialog"].showModal();
  }

  async function submitImport(event) {
    event.preventDefault();
    const path = els["import-path"].value.trim();
    if (!path) {
      els["import-note"].textContent = "请填写视频的绝对路径，或点击“浏览…”选择。";
      els["import-note"].className = "dialog-note error";
      return;
    }
    els["btn-import-confirm"].disabled = true;
    els["import-note"].textContent = "正在读取视频信息…";
    els["import-note"].className = "dialog-note";
    try {
      const payload = await api("/api/projects", {
        method: "POST", body: { path, name: els["import-name"].value.trim() || undefined },
      });
      els["import-dialog"].close();
      await bootstrapProject(payload.project, { analyze: els["import-analyze"].checked });
    } catch (error) {
      els["import-note"].textContent = error.message;
      els["import-note"].className = "dialog-note error";
    } finally {
      els["btn-import-confirm"].disabled = false;
    }
  }

  async function bootstrapProject(project, { analyze = false } = {}) {
    await loadProjects();
    setProject(project);
    if (analyze && (!project.analysis || project.analysis.status !== "ready" || !project.shots.length)) {
      await runAnalysis(project.id);
    } else {
      renderAll();
    }
  }

  async function loadSample() {
    toast("正在准备样片（首次生成约需十几秒）…");
    try {
      const payload = await api("/api/samples", { method: "POST", body: {} });
      await loadProjects();
      await bootstrapProject(payload.project, { analyze: payload.needs_analysis });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  async function loadProjects() {
    try {
      const payload = await api("/api/projects");
      state.projects = payload.projects || [];
    } catch (error) {
      state.projects = [];
    }
    if (state.project) renderProjectHeader();
  }

  // ---------------------------------------------------------------- jobs

  function openProgress(title) {
    els["progress-title"].textContent = title;
    els["progress-bar"].style.width = "0%";
    els["progress-message"].textContent = "";
    els["btn-progress-close"].hidden = true;
    if (!els["progress-dialog"].open) els["progress-dialog"].showModal();
  }

  function updateProgress(job) {
    const percent = clamp(Number(job.progress) || 0, 0, 100);
    els["progress-bar"].style.width = `${percent}%`;
    els["progress-message"].textContent = job.message || "";
    if (job.status === "done" || job.status === "error") {
      els["btn-progress-close"].hidden = false;
      if (job.status === "error") {
        els["progress-message"].textContent = `分析失败：${job.message}`;
      }
    }
  }

  async function pollJob(jobId, { onUpdate } = {}) {
    for (;;) {
      let job;
      try {
        job = await api(`/api/jobs/${jobId}`);
      } catch (error) {
        throw error;
      }
      updateProgress(job);
      if (onUpdate) onUpdate(job);
      if (job.status === "done" || job.status === "error") return job;
      await new Promise((resolve) => setTimeout(resolve, 650));
    }
  }

  async function runAnalysis(projectId) {
    openProgress("正在分析画面变化…");
    try {
      const { job_id } = await api(`/api/projects/${projectId}/analyze`, {
        method: "POST", body: { force: false },
      });
      const job = await pollJob(job_id);
      if (job.status === "error") {
        toast(`分析失败：${job.message}`, "error");
        return;
      }
      const refreshed = await api(`/api/projects/${projectId}`);
      await loadProjects();
      setProject(refreshed.project);
      toast(job.message || "分析完成", "ok");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      setTimeout(() => { if (els["progress-dialog"].open) els["progress-dialog"].close(); }, 500);
    }
  }

  // --------------------------------------------------------------- inspect

  async function inspectFrame(ms) {
    const project = state.project;
    if (!project) return;
    ms = clamp(Math.round(ms), 0, Math.max(0, project.media.info.duration_ms - 1));
    els["inspect-input"].value = msToTc(ms);
    try {
      const response = await fetch(`/api/projects/${project.id}/frame?t_ms=${ms}&w=720`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `抽帧失败 (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (state.lastInspected?.url) URL.revokeObjectURL(state.lastInspected.url);
      state.lastInspected = { url, ms };
      els["inspect-image"].src = url;
      els["inspect-image"].hidden = false;
      const headers = response.headers;
      const requested = Number(headers.get("X-Requested-Ms"));
      const actualRaw = headers.get("X-Actual-Ms");
      const driftRaw = headers.get("X-Drift-Ms");
      const fps = Number(headers.get("X-Fps")) || project.media.info.fps;
      const requestedTc = headers.get("X-Requested-Tc") || msToTc(requested);
      const actualTc = headers.get("X-Actual-Tc");
      const frame = headers.get("X-Frame");
      const drift = driftRaw === null || driftRaw === "" ? null : Number(driftRaw);
      const rows = [
        ["请求时间码", requestedTc],
        ["请求帧号", frame ?? "-"],
        ["实际解码 PTS", actualTc || "—"],
        ["偏移", drift === null ? "—" : `${drift > 0 ? "+" : ""}${drift}ms`],
      ];
      els["inspect-meta"].innerHTML = rows.map(([k, v], index) => {
        const cls = index === 3 && drift !== null ? (Math.abs(drift) <= Math.max(1, 1000 / fps) ? "ok" : "warn") : "";
        return `<dt>${escapeHtml(k)}</dt><dd class="${cls}">${escapeHtml(String(v))}</dd>`;
      }).join("");
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // --------------------------------------------------------------- export

  async function exportCatalogue() {
    const project = state.project;
    if (!project) return;
    const buttons = [els["btn-export"], els["btn-export-2"]];
    buttons.forEach((b) => { b.disabled = true; });
    toast("正在导出网页目录…");
    try {
      const payload = await api(`/api/projects/${project.id}/export`, { method: "POST", body: {} });
      els["export-result"].hidden = false;
      els["export-result"].innerHTML = `
        <span class="ok">已导出 ${payload.shots} 个片段 · ${fmtBytes(payload.bytes)}</span>
        <span>目录：<a href="#" data-copy="${escapeHtml(payload.path)}">${escapeHtml(payload.path)}</a></span>
        <span>入口：index.html · 清单：shots.csv / manifest.json</span>`;
      els["btn-open-export"].hidden = false;
      els["btn-open-export"].dataset.path = payload.index;
      toast("导出完成，可直接用浏览器打开 index.html", "ok");
      for (const link of els["export-result"].querySelectorAll("[data-copy]")) {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          navigator.clipboard?.writeText(link.dataset.copy).then(
            () => toast("路径已复制", "ok"),
            () => toast(link.dataset.copy)
          );
        });
      }
    } catch (error) {
      toast(error.message, "error");
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  }

  // ---------------------------------------------------------------- cache

  async function openCacheDialog() {
    els["cache-note"].textContent = "";
    els["cache-note"].className = "dialog-note";
    els["cache-dialog"].showModal();
    els["cache-list"].innerHTML = '<div class="muted small">读取中…</div>';
    try {
      const payload = await api("/api/cache");
      const usage = payload.usage;
      const labels = {
        analysis: "场景分析缓存（可重建）",
        thumbs: "镜头缩略图",
        previews: "精确抽帧预览",
        exports: "导出目录",
        samples: "示例素材",
        projects: "项目文件（不会被清理）",
      };
      els["cache-list"].innerHTML = Object.entries(usage).map(([key, value]) => {
        const size = key === "projects" ? `${value.files} 个文件` : `${value.files} 个文件 · ${fmtBytes(value.bytes)}`;
        return `<div class="cache-row">
          <div>
            <div>${escapeHtml(labels[key] || key)}</div>
            <div class="path">${escapeHtml(value.path)}</div>
          </div>
          <span class="num">${escapeHtml(size)}</span>
        </div>`;
      }).join("");
    } catch (error) {
      els["cache-list"].innerHTML = `<div class="muted small">${escapeHtml(error.message)}</div>`;
    }
  }

  async function clearCache() {
    if (!confirm("清理分析缓存、缩略图、预览和导出目录？项目文件会保留，但需要重新分析。")) return;
    try {
      const payload = await api("/api/cache/clear", { method: "POST", body: { what: "all" } });
      const count = payload.removed?.length || 0;
      els["cache-note"].textContent = `已清理 ${count} 个缓存目录。项目文件仍在，重新打开项目时需要点“重新分析”。`;
      els["cache-note"].className = "dialog-note";
      const refreshed = await api(`/api/projects/${state.project.id}`).catch(() => null);
      if (refreshed) setProject(refreshed.project);
      toast("缓存已清理", "ok");
    } catch (error) {
      els["cache-note"].textContent = error.message;
      els["cache-note"].className = "dialog-note error";
    }
  }

  // ------------------------------------------------------------- binding

  function bind() {
    els["btn-import"]?.addEventListener("click", () => openImportDialog());
    els["btn-import-2"]?.addEventListener("click", () => openImportDialog());
    els["btn-sample"]?.addEventListener("click", loadSample);
    els["btn-sample-2"]?.addEventListener("click", loadSample);
    els["btn-export"]?.addEventListener("click", exportCatalogue);
    els["btn-export-2"]?.addEventListener("click", exportCatalogue);
    els["btn-cache"]?.addEventListener("click", openCacheDialog);
    els["btn-clear-cache"]?.addEventListener("click", clearCache);
    for (const button of document.querySelectorAll("[data-close]")) {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    }
    els["import-form"]?.addEventListener("submit", submitImport);
    els["btn-pick-file"]?.addEventListener("click", async () => {
      try {
        const payload = await api("/api/pick-file");
        if (payload.path) els["import-path"].value = payload.path;
        else if (payload.error) els["import-note"].textContent = payload.error;
      } catch (error) {
        els["import-note"].textContent = error.message;
      }
    });
    els["btn-progress-close"]?.addEventListener("click", () => els["progress-dialog"].close());
    els["btn-refresh"]?.addEventListener("click", async () => {
      if (!state.project) return;
      try {
        const payload = await api(`/api/projects/${state.project.id}`);
        await loadProjects();
        setProject(payload.project);
        toast("已刷新", "ok");
      } catch (error) { toast(error.message, "error"); }
    });

    els["project-select"]?.addEventListener("change", async (event) => {
      const id = event.target.value;
      if (!id || id === state.project?.id) return;
      try {
        const payload = await api(`/api/projects/${id}`);
        setProject(payload.project);
      } catch (error) { toast(error.message, "error"); }
    });

    els["filter-q"]?.addEventListener("input", (event) => {
      state.filters.q = event.target.value;
      renderShotList();
    });
    els["filter-duration"]?.addEventListener("change", (event) => {
      state.filters.duration = event.target.value;
      renderShotList();
    });
    els["filter-tag-mode"]?.addEventListener("change", (event) => {
      state.filters.tagMode = event.target.value;
      renderShotList();
    });
    els["btn-clear-filters"]?.addEventListener("click", () => {
      state.filters = { q: "", duration: "all", tagMode: "any", tags: new Set(), fromMs: null, toMs: null };
      els["filter-q"].value = "";
      els["filter-duration"].value = "all";
      els["filter-tag-mode"].value = "any";
      els["filter-from"].value = "";
      els["filter-to"].value = "";
      renderTagFilter();
      renderShotList();
    });
    els["btn-apply-range"]?.addEventListener("click", () => {
      const from = tcToMs(els["filter-from"].value);
      const to = tcToMs(els["filter-to"].value);
      if (from === null && els["filter-from"].value.trim()) { toast("起始时间码格式不正确", "error"); return; }
      if (to === null && els["filter-to"].value.trim()) { toast("结束时间码格式不正确", "error"); return; }
      state.filters.fromMs = from;
      state.filters.toMs = to;
      renderShotList();
    });

    els["btn-merge"]?.addEventListener("click", () => {
      const ids = state.project.shots.filter((s) => state.selected.has(s.id)).map((s) => s.id);
      mergeShots(ids);
    });
    els["btn-clear-selection"]?.addEventListener("click", () => {
      state.selected.clear();
      renderShotList();
    });

    els["player"]?.addEventListener("timeupdate", () => {
      state.playerTimeMs = els.player.currentTime * 1000;
      updateTimecode();
      drawTimeline();
    });
    els["player"]?.addEventListener("play", () => { state.playing = true; syncTransport(); });
    els["player"]?.addEventListener("pause", () => { state.playing = false; syncTransport(); });
    els["player"]?.addEventListener("loadedmetadata", () => {
      if (els.player.currentTime * 1000 < 1) {
        const shot = activeShot();
        if (shot) seekTo(shot.start_ms);
      }
      syncTransport();
    });
    els["btn-play"]?.addEventListener("click", () => {
      if (els.player.paused) els.player.play().catch(() => {});
      else els.player.pause();
    });
    els["btn-prev"]?.addEventListener("click", () => gotoAdjacent(-1));
    els["btn-next"]?.addEventListener("click", () => gotoAdjacent(1));
    els["btn-frame-back"]?.addEventListener("click", () => stepFrame(-1));
    els["btn-frame-fwd"]?.addEventListener("click", () => stepFrame(1));
    els["btn-goto-in"]?.addEventListener("click", () => { const shot = activeShot(); if (shot) seekTo(shot.start_ms); });
    els["btn-goto-out"]?.addEventListener("click", () => { const shot = activeShot(); if (shot) seekTo(Math.max(shot.start_ms, shot.end_ms - 1)); });

    els["timeline"]?.addEventListener("click", (event) => {
      const rect = els.timeline.getBoundingClientRect();
      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      seekTo(ratio * state.project.media.info.duration_ms, { selectShot: true });
    });

    els["btn-toggle-details"]?.addEventListener("click", () => {
      state.detailOpen = !state.detailOpen;
      renderEditor();
    });
    els["btn-locate-boundary"]?.addEventListener("click", () => {
      const shot = activeShot();
      if (!shot) return;
      const boundary = (state.project.detection?.boundaries || []).find(
        (b) => Math.abs(b.at_ms - shot.start_ms) <= 2 || Math.abs(b.at_ms - shot.end_ms) <= 2
      );
      if (!boundary) { toast("这个片段没有对应的自动切点"); return; }
      seekTo(boundary.at_ms);
      const row = els["boundary-table"].querySelector(`tr[data-boundary="${boundary.at_ms}"]`);
      if (row) {
        row.scrollIntoView({ block: "center" });
        row.classList.add("flash");
        setTimeout(() => row.classList.remove("flash"), 1200);
      }
    });

    els["input-start"]?.addEventListener("change", () => {
      const ms = tcToMs(els["input-start"].value);
      if (ms === null) { toast("时间码格式不正确", "error"); renderEditor(); return; }
      applyBoundary("start", ms);
    });
    els["input-end"]?.addEventListener("change", () => {
      const ms = tcToMs(els["input-end"].value);
      if (ms === null) { toast("时间码格式不正确", "error"); renderEditor(); return; }
      applyBoundary("end", ms);
    });
    els["btn-start-here"]?.addEventListener("click", () => {
      const shot = activeShot(); if (!shot) return;
      applyBoundary("start", Math.round(state.playerTimeMs));
    });
    els["btn-end-here"]?.addEventListener("click", () => {
      const shot = activeShot(); if (!shot) return;
      applyBoundary("end", Math.round(state.playerTimeMs));
    });
    for (const button of document.querySelectorAll("[data-bump]")) {
      button.addEventListener("click", () => {
        const shot = activeShot(); if (!shot) return;
        const delta = Number(button.dataset.delta) * frameMs();
        const field = button.dataset.bump;
        const value = Math.round((field === "start" ? shot.start_ms : shot.end_ms) + delta);
        applyBoundary(field, value);
      });
    }
    els["btn-split-playhead"]?.addEventListener("click", splitAtPlayhead);
    els["btn-merge-prev"]?.addEventListener("click", () => mergeWithNeighbour(-1));
    els["btn-merge-next"]?.addEventListener("click", () => mergeWithNeighbour(1));

    els["tag-input"]?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "," || event.key === "，") {
        event.preventDefault();
        addTag(els["tag-input"].value);
      } else if (event.key === "Backspace" && !els["tag-input"].value) {
        const shot = activeShot();
        if (shot?.tags.length) removeTag(shot.tags[shot.tags.length - 1]);
      } else {
        state.tagDraft = event.target.value;
      }
    });
    els["shot-note"]?.addEventListener("input", () => {
      clearTimeout(state.pendingNoteSave);
      const value = els["shot-note"].value;
      state.pendingNoteSave = setTimeout(() => commitNote(value), 650);
    });
    els["shot-note"]?.addEventListener("blur", () => {
      clearTimeout(state.pendingNoteSave);
      commitNote(els["shot-note"].value);
    });

    for (const id of ["set-threshold", "set-strong", "set-minshot", "set-keep-short", "set-merge-similar", "set-lumatol", "set-sattol"]) {
      els[id]?.addEventListener("input", () => {
        state.settingsDirty = true;
        renderSidebar();
      });
      els[id]?.addEventListener("change", () => {
        state.settingsDirty = true;
        renderSidebar();
      });
    }
    els["btn-apply-settings"]?.addEventListener("click", applySettings);
    els["btn-reset-settings"]?.addEventListener("click", async () => {
      const defaults = { threshold: 0.26, strong_threshold: 0.52, min_shot_ms: 800, keep_short_strong: true, merge_similar: true, similar_luma_tol: 16, similar_sat_tol: 20 };
      try {
        const payload = await api(`/api/projects/${state.project.id}/detect`, { method: "POST", body: { settings: defaults } });
        state.settingsDirty = false;
        await refreshProject(payload.project);
        toast("已恢复默认设置", "ok");
      } catch (error) { toast(error.message, "error"); }
    });

    els["btn-reset-manual"]?.addEventListener("click", resetManual);
    els["btn-inspect"]?.addEventListener("click", () => {
      const ms = tcToMs(els["inspect-input"].value);
      if (ms === null) { toast("时间码格式不正确", "error"); return; }
      inspectFrame(ms);
    });
    els["btn-inspect-playhead"]?.addEventListener("click", () => inspectFrame(state.playerTimeMs));

    els["btn-open-export"]?.addEventListener("click", async () => {
      const path = els["btn-open-export"].dataset.path;
      if (!path) return;
      try {
        await api("/api/reveal", { method: "POST", body: { path } });
      } catch (error) {
        navigator.clipboard?.writeText(path);
        toast(error.message || "已复制入口文件路径，可在浏览器中打开");
      }
    });

    els["btn-delete-project"]?.addEventListener("click", async () => {
      if (!state.project) return;
      if (!confirm(`删除项目“${state.project.name}”？源视频不会被删除，缩略图缓存会一并清理。`)) return;
      try {
        await api(`/api/projects/${state.project.id}`, { method: "DELETE" });
        state.project = null;
        state.activeShotId = null;
        state.selected.clear();
        await loadProjects();
        if (state.projects.length) {
          const payload = await api(`/api/projects/${state.projects[0].id}`);
          setProject(payload.project);
        } else {
          els["empty-state"].hidden = false;
          els["workspace"].hidden = true;
        }
        toast("项目已删除", "ok");
      } catch (error) { toast(error.message, "error"); }
    });

    document.addEventListener("keydown", (event) => {
      if (event.target.matches("input, textarea, select")) return;
      if (document.querySelector("dialog[open]")) return;
      if (!state.project) return;
      switch (event.key) {
        case " ":
          event.preventDefault();
          if (els.player.paused) els.player.play().catch(() => {}); else els.player.pause();
          break;
        case "ArrowLeft":
          event.preventDefault();
          stepFrame(-1);
          break;
        case "ArrowRight":
          event.preventDefault();
          stepFrame(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          gotoAdjacent(-1);
          break;
        case "ArrowDown":
          event.preventDefault();
          gotoAdjacent(1);
          break;
        case "i": case "I": {
          const shot = activeShot(); if (shot) applyBoundary("start", Math.round(state.playerTimeMs));
          break;
        }
        case "o": case "O": {
          const shot = activeShot(); if (shot) applyBoundary("end", Math.round(state.playerTimeMs));
          break;
        }
        case "s": case "S":
          splitAtPlayhead();
          break;
        case "m": case "M": {
          const ids = state.project.shots.filter((s) => state.selected.has(s.id)).map((s) => s.id);
          if (ids.length >= 2) mergeShots(ids);
          break;
        }
        default:
          break;
      }
    });

    window.addEventListener("resize", () => drawTimeline());
  }

  // ---------------------------------------------------------------- health

  async function checkHealth() {
    try {
      const health = await api("/api/health");
      state.health = health;
      const chip = els["health-chip"];
      const ready = health.ffmpeg && health.ffprobe && health.analysis_filters;
      if (ready) {
        chip.textContent = "ffmpeg 就绪";
        chip.className = "chip ok";
        chip.title = `${health.ffmpeg_version || ""}\n${health.ffmpeg}`;
      } else {
        chip.textContent = "ffmpeg 异常";
        chip.className = "chip bad";
        chip.title = (health.errors || []).join("\n") || "缺少场景分析所需的 ffmpeg 滤镜";
      }
    } catch (error) {
      els["health-chip"].textContent = "服务未连接";
      els["health-chip"].className = "chip bad";
    }
  }

  async function init() {
    bind();
    checkHealth();
    await loadProjects();
    const params = new URLSearchParams(location.search);
    const wanted = params.get("project");
    try {
      if (wanted) {
        const payload = await api(`/api/projects/${wanted}`);
        setProject(payload.project);
      } else if (state.projects.length) {
        const payload = await api(`/api/projects/${state.projects[0].id}`);
        setProject(payload.project);
      } else {
        els["empty-state"].hidden = false;
        els["workspace"].hidden = true;
      }
    } catch (error) {
      els["empty-state"].hidden = false;
      els["workspace"].hidden = true;
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
