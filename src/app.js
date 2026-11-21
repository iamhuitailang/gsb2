/**
 * 应用入口：状态、事件、渲染。
 */

import {
  APP_NAME,
  APP_VERSION,
  CHANNELS,
  CHANNEL_IDS,
  FIT_MODES,
  LIMITS,
  OUTPUT_TYPES,
  ROLES,
  SAMPLE_MODES,
  getFitMode,
  getOutputType,
  getRole,
  getSampleMode,
} from "./lib/constants.js";
import {
  buildOutput,
  describeFit,
  extractPackedChannel,
  previewDimensions,
  renderNormalSphere,
} from "./lib/imaging.js";
import {
  createMaterial,
  createOutput,
  createProject,
  defaultPresetsFor,
  deserializeProject,
  detectRoleFromFileName,
  normalizeChannels,
  outputPreset,
  rebindImages,
  resolveOutputSize,
  serializeProject,
  uid,
} from "./lib/project.js";
import { buildExportPlan, runExportPlan, sanitizeName } from "./lib/batch.js";
import { buildManifest, summarizeOutput } from "./lib/report.js";
import { renderOutputItem } from "./lib/render.js";
import { createZip } from "./lib/zip.js";
import { decodeFile, decodeUrl, imageToThumbnail } from "./lib/decode.js";

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = "texture-channel-packer/autosave/v1";
const PREVIEW_MAX = 512;

const state = {
  project: null,
  previewMode: "composite",
  lastBuild: null,
  lastBuildSize: null,
  busy: false,
  previewQueued: false,
  pendingSlot: null,
  pendingRebind: null,
  batchZip: null,
  restored: null,
};

const $ = (sel) => document.querySelector(sel);
const el = {
  projectName: $("#projectName"),
  materialList: $("#materialList"),
  outputList: $("#outputList"),
  presetRow: $("#presetRow"),
  editor: $("#editorPanel"),
  previewCanvas: $("#previewCanvas"),
  previewFrame: $("#previewFrame"),
  previewBadge: $("#previewBadge"),
  previewMeta: $("#previewMeta"),
  previewModes: $("#previewModes"),
  previewStage: $("#previewStage"),
  normalCompare: $("#normalCompare"),
  compareHint: $("#compareHint"),
  warnings: $("#previewWarnings"),
  sourceList: $("#sourceList"),
  batchPanel: $("#batchPanel"),
  statusText: $("#statusText"),
  statusMeta: $("#statusMeta"),
  toasts: $("#toasts"),
  exportDialog: $("#exportDialog"),
  exportProgressBar: $("#exportProgressBar"),
  exportProgressText: $("#exportProgressText"),
  exportSummary: $("#exportSummary"),
  exportItems: $("#exportItems"),
  btnDownloadZip: $("#btnDownloadZip"),
  btnExportAgain: $("#btnExportAgain"),
  recoverDialog: $("#recoverDialog"),
  recoverDesc: $("#recoverDesc"),
  rebindDialog: $("#rebindDialog"),
  rebindDesc: $("#rebindDesc"),
  rebindList: $("#rebindList"),
  fileOpenProject: $("#fileOpenProject"),
  fileImportFolder: $("#fileImportFolder"),
  fileRebind: $("#fileRebind"),
  fileSingleImage: $("#fileSingleImage"),
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function activeMaterial() {
  if (!state.project) return null;
  return (
    state.project.materials.find((m) => m.id === state.project.activeMaterialId) ||
    state.project.materials[0] ||
    null
  );
}

function activeOutput() {
  const m = activeMaterial();
  if (!m) return null;
  return m.outputs.find((o) => o.id === state.project.selectedOutputId) || m.outputs[0] || null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .3s";
    setTimeout(() => node.remove(), 320);
  }, kind === "error" ? 6200 : 3400);
}

function setStatus(text, meta = "", kind = "") {
  el.statusText.textContent = text;
  el.statusText.className = kind;
  el.statusMeta.textContent = meta;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function debounce(fn, delay = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/* ------------------------------------------------------------------ */
/* 工程生命周期                                                        */
/* ------------------------------------------------------------------ */

function initProject() {
  state.project = createProject("未命名工程");
  // 空工程不预置输出：先导入素材，再从左下角添加预设，避免一打开就满屏"缺少来源"。
  state.project.selectedOutputId = null;
}

function ensureMaterials(project) {
  if (!project.materials.length) {
    project.materials.push(createMaterial("材质 01"));
  }
  for (const m of project.materials) {
    if (!m.images) m.images = {};
    if (!Array.isArray(m.outputs)) m.outputs = [];
  }
  if (!project.materials.some((m) => m.id === project.activeMaterialId)) {
    project.activeMaterialId = project.materials[0].id;
  }
}

function scheduleSave() {
  if (!state.project) return;
  const snapshot = {
    savedAt: new Date().toISOString(),
    project: serializeProject(state.project),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    /* 忽略配额错误 */
  }
}

const scheduleSaveDebounced = debounce(scheduleSave, 600);

function maybeOfferRecovery() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed?.project) return;
  try {
    const restored = deserializeProject(parsed.project);
    ensureMaterials(restored);
    // 只有"确实有内容"的工程才值得弹出恢复：有来源图或多组材质。
    // 否则默认模板也会触发提示，每次打开都被打扰。
    const meaningful =
      restored.materials.length > 1 ||
      restored.materials.some((m) => Object.keys(m.images || {}).length > 0);
    if (!meaningful) return;
    state.restored = { project: restored, savedAt: parsed.savedAt };
    const when = new Date(parsed.savedAt).toLocaleString("zh-CN");
    el.recoverDesc.textContent = `保存于 ${when}，包含 ${restored.materials.length} 组材质。恢复后需要重新选择来源贴图（或使用「保存（含贴图）」保存的文件）。`;
    el.recoverDialog.showModal();
  } catch {
    /* 旧数据格式不兼容，静默忽略 */
  }
}

el.recoverDialog.addEventListener("close", () => {
  if (el.recoverDialog.returnValue === "restore" && state.restored) {
    state.project = state.restored.project;
    state.restored = null;
    ensureMaterials(state.project);
    renderAll();
    toast("已恢复上次编辑的通道结构", "success");
    openRebindIfNeeded();
  } else {
    state.restored = null;
  }
});

// 点遮罩关闭（原生 dialog 的默认行为），避免用户误以为卡住
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}

/* ------------------------------------------------------------------ */
/* 侧栏渲染                                                            */
/* ------------------------------------------------------------------ */

function renderSidebar() {
  const project = state.project;
  el.projectName.value = project.name;
  el.materialList.innerHTML = "";
  for (const material of project.materials) {
    const li = document.createElement("li");
    li.className = `material-row${material.id === project.activeMaterialId ? " active" : ""}`;
    li.dataset.action = "select-material";
    li.dataset.id = material.id;
    li.tabIndex = 0;
    const imageCount = Object.keys(material.images || {}).length;
    li.innerHTML = `
      <span class="name" title="${escapeHtml(material.name)}">${escapeHtml(material.name)}</span>
      <span class="meta">${imageCount}图 · ${material.outputs.length}出</span>
    `;
    el.materialList.appendChild(li);
  }

  const material = activeMaterial();
  el.outputList.innerHTML = "";
  el.presetRow.innerHTML = "";
  if (!material) return;

  for (const output of material.outputs) {
    const li = document.createElement("li");
    li.className =
      `output-row${output.id === activeOutput()?.id ? " active" : ""}${output.enabled === false ? " disabled" : ""}`;
    li.dataset.action = "select-output";
    li.dataset.id = output.id;
    li.tabIndex = 0;
    li.innerHTML = `
      <span class="swatch" title="通道映射">${channelSwatches(output)}</span>
      <span class="name">
        ${escapeHtml(output.name)}
        <span class="sub">${getOutputType(output.type).short} · ${escapeHtml(summarizeOutput(material, output))}</span>
      </span>
    `;
    el.outputList.appendChild(li);
  }

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "添加预设输出";
  el.presetRow.appendChild(label);
  for (const type of OUTPUT_TYPES) {
    const btn = document.createElement("button");
    btn.className = "btn ghost small";
    btn.type = "button";
    btn.dataset.action = "add-preset";
    btn.dataset.type = type.id;
    btn.textContent = `＋ ${type.label}`;
    el.presetRow.appendChild(btn);
  }
}

function channelSwatches(output) {
  return CHANNELS.map((c) => {
    const def = output.channels[c.id];
    let color = "#0b0e13";
    if (def?.source?.kind === "role") {
      color = getRole(def.source.role).accent;
    } else {
      const v = Math.round((def?.constant ?? 255));
      color = `rgb(${v},${v},${v})`;
    }
    return `<i style="background:${color}"></i>`;
  }).join("");
}

/* ------------------------------------------------------------------ */
/* 编辑器渲染                                                          */
/* ------------------------------------------------------------------ */

function renderEditor() {
  const material = activeMaterial();
  const output = activeOutput();
  if (!material) {
    el.editor.innerHTML = `<div class="editor-empty"><strong>还没有材质</strong><span>点左上角「＋」新增，或「⇪」导入素材文件夹</span></div>`;
    return;
  }

  const outputSection = output
    ? renderOutputSection(material, output, resolveOutputSize(material, output))
    : `<section class="section">
         <div class="section-head"><h3>输出贴图</h3></div>
         <div class="editor-empty" style="min-height:160px">
           <strong>还没有输出贴图</strong>
           <span>从左下角的「添加预设输出」选一个，或点「＋」新建</span>
         </div>
       </section>`;

  el.editor.innerHTML = `
    ${renderMaterialSection(material)}
    ${renderSourceSection(material)}
    ${outputSection}
  `;
}

function renderMaterialSection(material) {
  return `
    <section class="section">
      <div class="section-head">
        <h3>材质设置</h3>
        <div class="block-actions">
          <button class="btn ghost small" type="button" data-action="duplicate-material">复制材质</button>
          <button class="btn ghost small danger" type="button" data-action="delete-material">删除材质</button>
        </div>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="matName">材质名</label>
          <input id="matName" type="text" data-field="material-name" value="${escapeHtml(material.name)}" />
        </div>
        <div class="field">
          <label>目标尺寸（宽 × 高）</label>
          <div style="display:flex;gap:6px">
            <input type="number" min="1" max="${LIMITS.maxTarget}" step="1" data-field="target-width" value="${material.targetWidth}" aria-label="目标宽度" />
            <input type="number" min="1" max="${LIMITS.maxTarget}" step="1" data-field="target-height" value="${material.targetHeight}" aria-label="目标高度" />
          </div>
          <span class="sub">每组材质可不同；单个输出也可单独覆盖</span>
        </div>
        <div class="field">
          <label>尺寸不一致时</label>
          <select data-field="fit-mode">${fitOptions(material.fitMode)}</select>
          <span class="sub">${escapeHtml(getFitMode(material.fitMode).description)}</span>
        </div>
      </div>
      <div class="warnings" id="materialWarnings" style="padding:0"></div>
    </section>
  `;
}

function fitOptions(current, includeInherit = false) {
  return [
    includeInherit ? `<option value="inherit"${current === "inherit" ? " selected" : ""}>跟随材质</option>` : "",
    ...FIT_MODES.map(
      (m) => `<option value="${m.id}"${current === m.id ? " selected" : ""}>${m.label}</option>`,
    ),
  ].join("");
}

function renderSourceSection(material) {
  const roles = ROLES.filter((r) => r.id !== "other");
  const slots = roles.map((role) => renderSlot(material, role)).join("");
  const warnings = collectSourceWarnings(material);
  return `
    <section class="section">
      <div class="section-head">
        <h3>来源贴图</h3>
        <span class="hint">点击槽位替换；支持拖拽图片到此处</span>
      </div>
      <div class="source-grid" id="sourceGrid">${slots}</div>
      ${
        warnings.length
          ? `<div class="warnings" style="padding:10px 0 0">${warnings
              .map((w) => `<div class="warning-item"><span class="ico">!</span><span>${escapeHtml(w)}</span></div>`)
              .join("")}</div>`
          : ""
      }
    </section>
  `;
}

function renderSlot(material, role) {
  const img = material.images?.[role.id];
  const error = img?.error;
  const needsRebind = img?.needsRebind && !img?.thumb;
  const missing = !img && !needsRebind;
  const usable = img && !error && !needsRebind;
  const thumb = usable ? img.thumb : null;
  const dims = img?.width && img?.height ? `${img.width}×${img.height}` : "";
  const mismatch =
    img?.width &&
    img?.height &&
    (img.width !== material.targetWidth || img.height !== material.targetHeight);
  const note = error
    ? error
    : needsRebind
      ? "工程只记录了文件名，请重新指认或单独选择"
      : img?.duplicates
        ? `同角色还有 ${img.duplicates} 张图片，当前复用第一张`
        : "";

  return `
    <div class="source-slot${error ? " has-error" : ""}${missing || needsRebind ? " is-missing" : ""}" data-slot-role="${role.id}">
      <div class="slot-preview">
        ${thumb ? `<img src="${thumb}" alt="${escapeHtml(role.label)} 来源缩略图" loading="lazy" />` : `<span class="empty">${needsRebind ? "需要重新指认" : missing ? "未指定来源" : "无法预览"}</span>`}
      </div>
      <div class="slot-body">
        <div class="slot-title">
          <span class="role-chip" style="--role-color:${role.accent}">${escapeHtml(role.label)}</span>
          <span class="slot-dims${mismatch ? " warn" : ""}" title="${mismatch ? "与目标尺寸不一致" : ""}">${escapeHtml(dims)}</span>
        </div>
        <div class="slot-file" title="${escapeHtml(img?.fileName || "")}">${escapeHtml(img?.fileName || "—")}</div>
        <div class="slot-file" style="color:${error ? "var(--danger)" : "var(--text-faint)"}">${escapeHtml(note)}</div>
        <div class="slot-actions">
          <button class="btn ghost small" type="button" data-action="pick-image" data-role="${role.id}">选择…</button>
          <button class="btn ghost small" type="button" data-action="clear-image" data-role="${role.id}" ${missing ? "disabled" : ""}>清除</button>
        </div>
      </div>
    </div>
  `;
}

function collectSourceWarnings(material) {
  const out = [];
  for (const [roleId, img] of Object.entries(material.images || {})) {
    if (!img) continue;
    if (img.error) {
      out.push(`「${getRole(roleId).label}」${img.fileName || ""}：${img.error}（导出时将按常量补齐）`);
    } else if (img.needsRebind) {
      out.push(`「${getRole(roleId).label}」${img.fileName || ""} 需要重新指认来源文件（导出时将按常量补齐）`);
    }
  }
  const used = new Set();
  for (const output of material.outputs.filter((o) => o.enabled !== false)) {
    for (const id of CHANNEL_IDS) {
      const def = output.channels[id];
      if (def?.source?.kind !== "role") continue;
      if (id === "a" && !output.includeAlpha) continue;
      const img = material.images?.[def.source.role];
      if (!img) {
        used.add(`输出「${output.name}」的 ${id.toUpperCase()} 通道引用了「${getRole(def.source.role).label}」，但该来源未指定，将用常量补齐`);
      }
    }
  }
  out.push(...used);
  return out;
}

function renderOutputSection(material, output, size) {
  const type = getOutputType(output.type);
  const effectiveFit = size.fitMode;
  return `
    <section class="section">
      <div class="section-head">
        <h3>输出贴图</h3>
        <div class="block-actions">
          <button class="btn ghost small" type="button" data-action="toggle-output">
            ${output.enabled === false ? "启用此输出" : "停用此输出"}
          </button>
          <button class="btn ghost small danger" type="button" data-action="delete-output">删除输出</button>
        </div>
      </div>
      <div class="field-grid">
        <div class="field">
          <label for="outName">输出名（也是文件名）</label>
          <input id="outName" type="text" data-field="output-name" value="${escapeHtml(output.name)}" />
        </div>
        <div class="field">
          <label>输出类型</label>
          <select data-field="output-type">
            ${OUTPUT_TYPES.map(
              (t) => `<option value="${t.id}"${t.id === type.id ? " selected" : ""}>${t.label}</option>`,
            ).join("")}
          </select>
        </div>
        <div class="field">
          <label>尺寸（留空跟随材质 ${material.targetWidth}×${material.targetHeight}）</label>
          <div style="display:flex;gap:6px">
            <input type="number" min="1" max="${LIMITS.maxTarget}" step="1" data-field="output-width" value="${output.width ?? ""}" placeholder="${material.targetWidth}" aria-label="输出宽度" />
            <input type="number" min="1" max="${LIMITS.maxTarget}" step="1" data-field="output-height" value="${output.height ?? ""}" placeholder="${material.targetHeight}" aria-label="输出高度" />
          </div>
          <span class="sub">实际输出 ${size.width}×${size.height}</span>
        </div>
        <div class="field">
          <label>尺寸处理</label>
          <select data-field="output-fit">${fitOptions(output.fitMode, true)}</select>
          <span class="sub">当前：${escapeHtml(getFitMode(effectiveFit).label)}</span>
        </div>
        <div class="field">
          <label>法线方向（影响 G 通道解读）</label>
          <select data-field="output-convention">
            <option value="opengl"${output.convention === "opengl" ? " selected" : ""}>OpenGL / Unity / Blender（+Y 向上）</option>
            <option value="directx"${output.convention === "directx" ? " selected" : ""}>DirectX / Unreal（-Y 向下，翻转绿）</option>
          </select>
          <span class="sub">切换后会立即重算预览与球面对比</span>
        </div>
        <div class="field">
          <label>Alpha 通道</label>
          <label class="check">
            <input type="checkbox" data-field="output-alpha" ${output.includeAlpha ? "checked" : ""} />
            写入 A 通道（否则固定为不透明 255）
          </label>
        </div>
      </div>

      <div class="channel-table-wrap" style="overflow-x:auto">
        <table class="channel-table">
          <thead>
            <tr>
              <th>通道</th>
              <th>来源</th>
              <th>取色方式</th>
              <th>反相</th>
              <th>强度</th>
              <th>缺少来源时的常量</th>
            </tr>
          </thead>
          <tbody>
            ${CHANNELS.map((ch) => renderChannelRow(material, output, ch)).join("")}
          </tbody>
        </table>
      </div>
      <div class="chan-map-bar" aria-hidden="true">${channelMapBar(material, output)}</div>
      <p class="fineprint" style="margin-top:8px">${escapeHtml(summarizeOutput(material, output))}</p>
    </section>
  `;
}

function renderChannelRow(material, output, ch) {
  const def = output.channels[ch.id];
  const isRole = def.source.kind === "role";
  const role = isRole ? getRole(def.source.role) : null;
  const missing = isRole && !material.images?.[def.source.role];
  const disabled = ch.id === "a" && !output.includeAlpha;
  const constantColor = `rgb(${def.constant},${def.constant},${def.constant})`;
  return `
    <tr class="${disabled ? "alpha-off" : ""}">
      <td><span class="chan-badge" style="--chan-color:${ch.color}">${ch.label}</span></td>
      <td class="chan-cell">
        <select data-channel="${ch.id}" data-channel-field="source" aria-label="${ch.label} 通道来源">
          <option value="constant"${!isRole ? " selected" : ""}>常量</option>
          ${ROLES.filter((r) => r.id !== "other")
            .map(
              (r) =>
                `<option value="role:${r.id}"${isRole && def.source.role === r.id ? " selected" : ""}>${r.label}${material.images?.[r.id] ? "" : "（未指定）"}</option>`,
            )
            .join("")}
        </select>
        ${
          missing
            ? `<div class="sub" style="color:var(--warn);font-size:10px">缺少来源，用常量 ${def.constant} 补齐</div>`
            : isRole
              ? `<div class="sub" style="font-size:10px">${escapeHtml(material.images?.[def.source.role]?.fileName || role?.en || "")}</div>`
              : ""
        }
      </td>
      <td>
        <select data-channel="${ch.id}" data-channel-field="sample" aria-label="${ch.label} 取色方式" ${!isRole ? "disabled" : ""}>
          ${SAMPLE_MODES.map(
            (m) => `<option value="${m.id}"${def.sample === m.id ? " selected" : ""}>${m.label}</option>`,
          ).join("")}
        </select>
      </td>
      <td>
        <label class="check"><input type="checkbox" data-channel="${ch.id}" data-channel-field="invert" ${def.invert ? "checked" : ""} ${!isRole ? "disabled" : ""} />反相</label>
      </td>
      <td>
        <div class="strength-cell">
          <input type="range" min="0" max="3" step="0.05" value="${def.strength}" data-channel="${ch.id}" data-channel-field="strength" aria-label="${ch.label} 强度滑块" />
          <input type="number" min="0" max="3" step="0.05" value="${def.strength}" data-channel="${ch.id}" data-channel-field="strength" aria-label="${ch.label} 强度数值" />
        </div>
      </td>
      <td>
        <div class="chan-constant">
          <span class="swatchbox" style="background:${constantColor}"></span>
          <input type="number" min="0" max="255" step="1" value="${def.constant}" data-channel="${ch.id}" data-channel-field="constant" aria-label="${ch.label} 通道常量" ${isRole && !missing ? 'title="来源可用时以来源为准；仅在缺少来源时使用"' : ""} />
        </div>
      </td>
    </tr>
  `;
}

function channelMapBar(material, output) {
  return CHANNELS.map((c) => {
    const def = output.channels[c.id];
    let color = "#1d2531";
    if (c.id === "a" && !output.includeAlpha) color = "#1d2531";
    else if (def.source.kind === "role") color = getRole(def.source.role).accent;
    else {
      const v = def.constant;
      color = `rgb(${v},${v},${v})`;
    }
    return `<span style="flex:1;background:${color}" title="${c.label} 通道"></span>`;
  }).join("");
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

function queuePreview() {
  if (state.previewQueued) return;
  state.previewQueued = true;
  requestAnimationFrame(() => {
    state.previewQueued = false;
    try {
      renderPreview();
    } catch (err) {
      console.error(err);
      setStatus(`预览失败：${err.message}`, "", "err");
    }
  });
}

function buildPreview() {
  const material = activeMaterial();
  const output = activeOutput();
  if (!material || !output) return null;
  const size = resolveOutputSize(material, output);
  const preview = previewDimensions(size.width, size.height, PREVIEW_MAX);
  const images = new Map();
  for (const [roleId, img] of Object.entries(material.images || {})) {
    images.set(roleId, img);
  }
  const resolvePreviewImage = (role) => {
    const img = images.get(role);
    if (!img || img.needsRebind) return null;
    // 有 error 的图片原样返回，让 buildOutput 记录"解码失败并用常量补齐"
    return img;
  };
  const build = buildOutput({
    width: preview.width,
    height: preview.height,
    fitMode: size.fitMode,
    convention: output.convention,
    channels: output.channels,
    includeAlpha: output.includeAlpha,
    warnOnSizeMismatch: false,
    resolveImage: resolvePreviewImage,
  });
  return { build, preview, size, material, output };
}

function renderPreview() {
  const ctx0 = buildPreview();
  const material = activeMaterial();
  const output = activeOutput();
  if (!ctx0) {
    drawEmptyPreview();
    el.normalCompare.classList.add("hidden");
    return;
  }
  const { build, preview, size } = ctx0;
  state.lastBuild = build;
  state.lastBuildSize = size;

  // Alpha 被关闭时，A 预览没有意义，回落到合成视图
  if (state.previewMode === "a" && !ctx0.output.includeAlpha) state.previewMode = "composite";

  const canvas = el.previewCanvas;
  const ctx = canvas.getContext("2d");
  let width = preview.width;
  let height = preview.height;
  let data = build.data;

  if (state.previewMode !== "composite") {
    data = extractPackedChannel(build.data, width, height, state.previewMode);
  } else if (output.includeAlpha) {
    // 在棋盘背景上合成，方便判断 A 通道
    data = checkerComposite(build.data, width, height);
  }

  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

  el.previewBadge.textContent =
    state.previewMode === "composite"
      ? `${preview.width}×${preview.height} 预览 · 目标 ${size.width}×${size.height}`
      : `${state.previewMode.toUpperCase()} 通道 · ${preview.width}×${preview.height}`;
  el.previewMeta.textContent = `${getFitMode(size.fitMode).short} · ${output.convention === "directx" ? "DirectX" : "OpenGL"}`;

  const anyMismatch = build.channels.some(
    (c) => c.sourceWidth && (c.sourceWidth !== size.width || c.sourceHeight !== size.height),
  );
  el.previewFrame.hidden = !(anyMismatch && state.previewMode === "composite");

  renderNormalCompare(build, preview, output);
  renderPreviewWarnings(build, size, material);
  renderSourceList(build, size, material);
  renderPreviewModes(output);
}

function checkerComposite(data, width, height) {
  const out = new Uint8ClampedArray(data.length);
  const tile = 12;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const a = data[p + 3] / 255;
      const checker = (Math.floor(x / tile) + Math.floor(y / tile)) % 2 === 0 ? 92 : 60;
      const base = checker;
      out[p] = data[p] * a + base * (1 - a);
      out[p + 1] = data[p + 1] * a + base * (1 - a);
      out[p + 2] = data[p + 2] * a + base * (1 - a);
      out[p + 3] = 255;
    }
  }
  return out;
}

function renderNormalCompare(build, preview, output) {
  const isNormal = output.type === "normal" || build.channels.some((c) => c.role === "normal" && !c.usedConstant);
  if (!isNormal) {
    el.normalCompare.classList.add("hidden");
    return;
  }
  el.normalCompare.classList.remove("hidden");
  const size = 150;
  for (const fig of el.normalCompare.querySelectorAll(".compare-item")) {
    const convention = fig.dataset.convention;
    const canvas = fig.querySelector("canvas");
    const pixels = renderNormalSphere({
      data: build.data,
      width: preview.width,
      height: preview.height,
      convention,
      size,
    });
    canvas.width = size;
    canvas.height = size;
    canvas.getContext("2d").putImageData(new ImageData(pixels, size, size), 0, 0);
    fig.classList.toggle("active", output.convention === convention);
  }
  el.compareHint.textContent =
    output.convention === "directx"
      ? "左边是 OpenGL 引擎读同一张 DirectX 结果（凹凸方向会反），右边是 DirectX 引擎读到的正确效果。若右侧更符合预期，说明方向设置正确。"
      : "左边是 OpenGL 引擎读同一张 OpenGL 结果（正确），右边是 DirectX 引擎误读（凹凸方向会反）。若左侧更符合预期，说明方向设置正确。";
}

function renderPreviewModes(output) {
  const modes = [
    { id: "composite", label: "合成" },
    ...CHANNELS.map((c) => ({ id: c.id, label: `${c.label} 通道`, color: c.color })),
  ];
  el.previewModes.innerHTML = "";
  for (const mode of modes) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = "preview-mode";
    btn.dataset.mode = mode.id;
    btn.textContent = mode.label;
    if (mode.color) btn.style.setProperty("--dot", mode.color);
    if (mode.id === "a" && !output.includeAlpha) btn.disabled = true;
    btn.classList.toggle("active", state.previewMode === mode.id);
    el.previewModes.appendChild(btn);
  }
}

function renderPreviewWarnings(build, size, material) {
  const items = [...build.warnings];
  // 预览按比例缩小渲染，不能用预览尺寸判断是否不一致；这里用目标尺寸补上提示
  for (const ch of build.channels) {
    if (!ch.sourceWidth || !ch.sourceHeight) continue;
    if (ch.sourceWidth === size.width && ch.sourceHeight === size.height) continue;
    const msg = `「${ch.roleLabel}」尺寸 ${ch.sourceWidth}×${ch.sourceHeight} 与目标 ${size.width}×${size.height} 不一致，按「${getFitMode(size.fitMode).short}」处理`;
    if (!items.includes(msg)) items.push(msg);
  }
  const missing = collectSourceWarnings(material);
  for (const m of missing) if (!items.includes(m)) items.push(m);
  el.warnings.innerHTML = items.length
    ? items
        .slice(0, 8)
        .map((w) => `<div class="warning-item"><span class="ico">!</span><span>${escapeHtml(w)}</span></div>`)
        .join("")
    : "";
}

function renderSourceList(build, size, material) {
  el.sourceList.innerHTML = "";
  for (const ch of build.channels) {
    const color = CHANNELS.find((c) => c.id === ch.id)?.color || "#888";
    const row = document.createElement("div");
    row.className = `source-row${ch.usedConstant ? " is-constant" : ""}`;
    row.style.setProperty("--chan-color", color);
    const desc = ch.usedConstant
      ? ch.sourceKind === "role"
        ? `<b>常量 ${ch.constant}</b> · ${escapeHtml(
            ch.decodeFailed
              ? `来源解码失败（${ch.sourceError}）`
              : ch.missingSource
                ? "来源未指定"
                : "Alpha 未启用",
          )}`
        : `<b>常量 ${ch.constant}</b> · 固定填充`
      : `<b>${escapeHtml(getRole(ch.role).label)}</b> · ${escapeHtml(ch.sourceFileName || "")}<br /><span class="mono">取 ${escapeHtml(ch.sampleLabel)}${ch.invert ? " · 反相" : ""}${Number(ch.strength) !== 1 ? ` · ×${ch.strength}` : ""}</span>`;
    const fit =
      ch.sourceWidth && ch.sourceHeight && (ch.sourceWidth !== size.width || ch.sourceHeight !== size.height)
        ? `<br /><span class="mono">${escapeHtml(describeFit(ch.sourceWidth, ch.sourceHeight, size.width, size.height, size.fitMode))}</span>`
        : "";

    row.innerHTML = `
      <span class="chan">${ch.label}</span>
      <span class="desc">${desc}${fit}</span>
      <span class="stat">${ch.usedConstant ? "CONST" : `${ch.min}-${ch.max}`}</span>
    `;
    el.sourceList.appendChild(row);
  }
}

function drawEmptyPreview() {
  const canvas = el.previewCanvas;
  canvas.width = 2;
  canvas.height = 2;
  canvas.getContext("2d").clearRect(0, 0, 2, 2);
  el.previewBadge.textContent = "等待素材";
  el.previewMeta.textContent = "—";
  el.sourceList.innerHTML = "";
  el.warnings.innerHTML = "";
  el.previewModes.innerHTML = "";
  el.previewFrame.hidden = true;
}

/* ------------------------------------------------------------------ */
/* 总渲染                                                              */
/* ------------------------------------------------------------------ */

function renderAll() {
  if (!state.project) return;
  ensureMaterials(state.project);
  renderSidebar();
  renderEditor();
  queuePreview();
  scheduleSaveDebounced();
  updateStatus();
}

function updateStatus() {
  const material = activeMaterial();
  if (!material) {
    setStatus("还没有材质");
    return;
  }
  const enabled = material.outputs.filter((o) => o.enabled !== false).length;
  const total = state.project.materials.reduce(
    (n, m) => n + m.outputs.filter((o) => o.enabled !== false).length,
    0,
  );
  setStatus(
    `工程「${state.project.name}」· ${state.project.materials.length} 组材质 · 当前组 ${enabled} 个启用输出 · 全部 ${total} 个`,
    `来源 ${Object.keys(material.images || {}).length} 张`,
  );
}

/* ------------------------------------------------------------------ */
/* 导入 / 素材                                                         */
/* ------------------------------------------------------------------ */

const THUMB_MAX = 128;

async function prepareImage(fileName, image) {
  let thumb = null;
  try {
    thumb = imageToThumbnail(image, THUMB_MAX);
  } catch {
    thumb = null;
  }
  return { ...image, fileName, thumb, error: null };
}

async function decodeOne(file) {
  try {
    const image = await decodeFile(file);
    return await prepareImage(file.name, image);
  } catch (err) {
    return { fileName: file.name, error: err.message, width: 0, height: 0, thumb: null };
  }
}

/** 把一批图片按文件名分组，生成或填充材质。 */
async function importFiles(files) {
  const list = [...files].filter((f) => f && /\.(png|jpe?g|webp|bmp|gif|tga|svg)$/i.test(f.name));
  if (list.length === 0) {
    toast("没有可导入的受支持图片（PNG / JPEG / WebP / BMP / GIF / TGA / SVG）", "error");
    return;
  }
  setStatus(`正在解码 ${list.length} 张图片…`);
  const decoded = await Promise.all(
    list.map(async (file) => {
      const info = detectRoleFromFileName(file.name);
      const image = await decodeOne(file);
      return { ...image, detectedRole: info.role, baseName: info.baseName || file.name };
    }),
  );

  const groups = new Map();
  for (const item of decoded) {
    const key = (item.baseName || item.fileName).toLowerCase();
    if (!groups.has(key)) groups.set(key, { baseName: item.baseName || item.fileName, items: [] });
    groups.get(key).items.push(item);
  }

  const failed = decoded.filter((d) => d.error);
  const created = [];

  // 新建工程里只有一个空材质时，直接用它承接第一组，避免留下空的「材质 01」
  const emptyDefault =
    state.project.materials.length === 1 &&
    Object.keys(state.project.materials[0].images || {}).length === 0
      ? state.project.materials[0]
      : null;

  let firstGroup = true;
  for (const { baseName, items } of groups.values()) {
    let material;
    if (emptyDefault && firstGroup) {
      material = emptyDefault;
      material.name = humanizeBaseName(baseName);
    } else {
      material = createMaterial(humanizeBaseName(baseName));
      state.project.materials.push(material);
    }
    firstGroup = false;
    fillMaterialFromGroup(material, items);
    material.outputs = defaultPresetsFor(material);
    created.push(material);
  }

  // 每组材质按自己第一张可用图片的尺寸设定目标尺寸
  for (const material of created) {
    const first = Object.values(material.images).find((i) => i?.width);
    if (first) {
      material.targetWidth = first.width;
      material.targetHeight = first.height;
    }
  }

  if (created.length) {
    state.project.activeMaterialId = created[0].id;
    state.project.selectedOutputId = created[0].outputs[0]?.id || null;
  }

  renderAll();
  const okCount = decoded.length - failed.length;
  setStatus(
    `导入完成：${okCount} 张图片，生成/更新 ${created.length} 组材质${failed.length ? `，${failed.length} 张失败` : ""}`,
    "",
    failed.length ? "err" : "ok",
  );
  if (failed.length) {
    toast(failed.map((f) => `${f.fileName}：${f.error}`).join("\n").slice(0, 400), "error");
  } else {
    toast(`已导入 ${okCount} 张图片`, "success");
  }
}

function fillMaterialFromGroup(material, items) {
  for (const item of items) {
    const role = item.detectedRole === "other" ? guessRoleByUsage(item.fileName) : item.detectedRole;
    if (!isUsableRole(role)) continue;
    // 一组里出现两张同角色图时，选文件名更"标准"的那张图会更好，但这里保持简单：
    // 先到先得，并在界面上提示"多张同角色图片，复用第一张"。
    if (!material.images[role]) {
      material.images[role] = {
        role,
        width: item.width,
        height: item.height,
        data: item.data,
        fileName: item.fileName,
        thumb: item.thumb,
        error: item.error || null,
        bytes: null,
        duplicates: 0,
      };
    } else {
      material.images[role].duplicates = (material.images[role].duplicates || 0) + 1;
    }
  }
}

function isUsableRole(role) {
  return ROLES.some((r) => r.id === role && r.id !== "other");
}

function guessRoleByUsage(fileName) {
  const lower = fileName.toLowerCase();
  if (/colou?r|diffuse|albedo/.test(lower)) return "albedo";
  if (/norm/.test(lower)) return "normal";
  if (/rough|gloss/.test(lower)) return "roughness";
  if (/metal/.test(lower)) return "metallic";
  if (/\bao\b|occlusion/.test(lower)) return "ao";
  if (/height|disp|bump/.test(lower)) return "height";
  return "other";
}

function humanizeBaseName(baseName) {
  return baseName
    .replace(/[_\-]+/g, " ")
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .trim();
}

async function loadSamples() {
  setStatus("正在载入样例工程…");
  try {
    const response = await fetch("samples/demo-project.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.json();
    const project = deserializeProject(raw);
    ensureMaterials(project);

    let loaded = 0;
    const failures = [];
    const intended = [];
    for (const material of project.materials) {
      for (const [role, saved] of Object.entries(material.images)) {
        if (!saved.url) continue;
        try {
          const image = await decodeUrl(saved.url, saved.fileName);
          const prepared = await prepareImage(saved.fileName || saved.url.split("/").pop(), image);
          material.images[role] = { ...prepared, role, url: saved.url, bytes: saved.bytes };
          loaded += 1;
        } catch (err) {
          material.images[role] = {
            role,
            fileName: saved.fileName,
            url: saved.url,
            error: err.message,
          };
          // 「损坏样例」里的坏文件是刻意准备的演示数据，不算载入失败
          if (material.name.includes("损坏")) {
            intended.push(`${saved.fileName || saved.url}：${err.message}`);
          } else {
            failures.push(`${saved.fileName || saved.url}：${err.message}`);
          }
        }
      }
      for (const output of material.outputs) {
        output.channels = normalizeChannels(output.channels);
      }
    }

    state.project = project;
    renderAll();
    const intendedNote = intended.length ? `（另有 ${intended.length} 张刻意准备的损坏样例）` : "";
    setStatus(
      `样例已载入：${project.materials.length} 组材质，${loaded} 张贴图${failures.length ? `，${failures.length} 张失败` : ""}${intendedNote}`,
      "样例工程",
      failures.length ? "err" : "ok",
    );
    if (failures.length) toast(failures.slice(0, 3).join("\n"), "error");
    else toast("样例已载入，可直接查看效果或点击导出", "success");
  } catch (err) {
    console.error(err);
    setStatus(`载入样例失败：${err.message}`, "", "err");
    toast(`载入样例失败：${err.message}`, "error");
  }
}

/* ------------------------------------------------------------------ */
/* 事件：侧栏 / 编辑器                                                 */
/* ------------------------------------------------------------------ */

el.materialList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-action='select-material']");
  if (!row) return;
  state.project.activeMaterialId = row.dataset.id;
  const material = activeMaterial();
  state.project.selectedOutputId = material.outputs[0]?.id || null;
  renderAll();
});

el.outputList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-action='select-output']");
  if (!row) return;
  state.project.selectedOutputId = row.dataset.id;
  renderSidebar();
  renderEditor();
  queuePreview();
  scheduleSaveDebounced();
});

el.presetRow.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='add-preset']");
  if (!btn) return;
  addPresetOutput(btn.dataset.type);
});

function addPresetOutput(typeId) {
  const material = activeMaterial();
  if (!material) return;
  const output = outputPreset(typeId, material);
  const existing = new Set(material.outputs.map((o) => o.name.toLowerCase()));
  if (existing.has(output.name.toLowerCase())) {
    output.name = `${output.name} ${material.outputs.length + 1}`;
  }
  material.outputs.push(output);
  state.project.selectedOutputId = output.id;
  renderAll();
  toast(`已添加输出「${output.name}」`, "success");
}

$("#btnAddMaterial").addEventListener("click", () => {
  const material = createMaterial(`材质 ${String(state.project.materials.length + 1).padStart(2, "0")}`);
  material.outputs = [];
  state.project.materials.push(material);
  state.project.activeMaterialId = material.id;
  state.project.selectedOutputId = null;
  renderAll();
});

$("#btnAddOutput").addEventListener("click", () => {
  const material = activeMaterial();
  if (!material) return;
  const output = outputPreset("custom", material);
  output.name = `自定义输出 ${material.outputs.length + 1}`;
  material.outputs.push(output);
  state.project.selectedOutputId = output.id;
  renderAll();
});

$("#btnImportFolder").addEventListener("click", () => el.fileImportFolder.click());
el.fileImportFolder.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await importFiles(files);
});

el.projectName.addEventListener("input", () => {
  state.project.name = el.projectName.value;
  updateStatus();
  scheduleSaveDebounced();
});

/* --------------------------- 编辑器事件委托 --------------------------- */

el.editor.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const material = activeMaterial();
  const output = activeOutput();

  switch (btn.dataset.action) {
    case "pick-image":
      state.pendingSlot = btn.dataset.role;
      el.fileSingleImage.click();
      return;
    case "clear-image":
      if (material) {
        delete material.images[btn.dataset.role];
        renderAll();
      }
      return;
    case "delete-material":
      if (!material) return;
      if (state.project.materials.length === 1) {
        toast("至少保留一组材质", "error");
        return;
      }
      if (!confirm(`删除材质「${material.name}」？`)) return;
      state.project.materials = state.project.materials.filter((m) => m.id !== material.id);
      state.project.activeMaterialId = state.project.materials[0].id;
      state.project.selectedOutputId = null;
      renderAll();
      return;
    case "duplicate-material":
      if (!material) return;
      duplicateMaterial(material);
      return;
    case "delete-output":
      if (!material || !output) return;
      if (material.outputs.length === 1) {
        toast("每组材质至少保留一个输出", "error");
        return;
      }
      material.outputs = material.outputs.filter((o) => o.id !== output.id);
      state.project.selectedOutputId = material.outputs[0]?.id || null;
      renderAll();
      return;
    case "toggle-output":
      if (!output) return;
      output.enabled = output.enabled === false;
      renderAll();
      return;
    default:
      return;
  }
});

function duplicateMaterial(material) {
  const copy = createMaterial(`${material.name} 副本`);
  copy.targetWidth = material.targetWidth;
  copy.targetHeight = material.targetHeight;
  copy.fitMode = material.fitMode;
  copy.images = {};
  for (const [role, img] of Object.entries(material.images || {})) {
    if (img) copy.images[role] = { ...img, role };
  }
  copy.outputs = material.outputs.map((o) =>
    createOutput({
      ...o,
      id: uid("out"),
      name: `${o.name}`,
      channels: JSON.parse(JSON.stringify(o.channels)),
    }),
  );
  state.project.materials.push(copy);
  state.project.activeMaterialId = copy.id;
  state.project.selectedOutputId = copy.outputs[0]?.id || null;
  renderAll();
}

el.editor.addEventListener("change", (e) => {
  const target = e.target;
  const material = activeMaterial();
  const output = activeOutput();
  const field = target.dataset.field;

  if (field && material) {
    if (field === "material-name") {
      material.name = target.value.trim() || "未命名材质";
      renderSidebar();
      scheduleSaveDebounced();
      return;
    }
    if (field === "target-width" || field === "target-height") {
      const value = clampSize(target.value);
      if (value == null) {
        target.value = field === "target-width" ? material.targetWidth : material.targetHeight;
        toast(`目标尺寸需在 1~${LIMITS.maxTarget} 之间`, "error");
        return;
      }
      if (field === "target-width") material.targetWidth = value;
      else material.targetHeight = value;
      renderAll();
      return;
    }
    if (field === "fit-mode") {
      material.fitMode = target.value;
      renderAll();
      return;
    }
  }

  if (field && output) {
    switch (field) {
      case "output-name":
        output.name = target.value.trim() || "未命名输出";
        renderSidebar();
        scheduleSaveDebounced();
        return;
      case "output-type":
        output.type = getOutputType(target.value).id;
        renderSidebar();
        renderEditor();
        queuePreview();
        scheduleSaveDebounced();
        return;
      case "output-width":
      case "output-height": {
        if (target.value.trim() === "") {
          if (field === "output-width") output.width = null;
          else output.height = null;
        } else {
          const value = clampSize(target.value);
          if (value == null) {
            target.value = field === "output-width" ? output.width ?? "" : output.height ?? "";
            toast(`输出尺寸需在 1~${LIMITS.maxTarget} 之间`, "error");
            return;
          }
          if (field === "output-width") output.width = value;
          else output.height = value;
        }
        renderEditor();
        queuePreview();
        scheduleSaveDebounced();
        return;
      }
      case "output-fit":
        output.fitMode = target.value;
        renderEditor();
        queuePreview();
        scheduleSaveDebounced();
        return;
      case "output-convention":
        output.convention = target.value;
        renderEditor();
        queuePreview();
        scheduleSaveDebounced();
        return;
      case "output-alpha":
        output.includeAlpha = target.checked;
        renderEditor();
        queuePreview();
        scheduleSaveDebounced();
        return;
      default:
        break;
    }
  }

  const channel = target.dataset.channel;
  const chanField = target.dataset.channelField;
  if (channel && chanField && output) {
    mutateChannel(output, channel, chanField, target);
  }
});

el.editor.addEventListener("input", (e) => {
  const target = e.target;
  const channel = target.dataset.channel;
  const chanField = target.dataset.channelField;
  const output = activeOutput();
  if (!output || !channel) return;
  if (chanField === "strength" && target.type === "range") {
    mutateChannel(output, channel, "strength", target, true);
  }
  if (chanField === "constant" && target.type === "number") {
    mutateChannel(output, channel, "constant", target, true);
  }
});

function clampSize(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > LIMITS.maxTarget) return null;
  return n;
}

function mutateChannel(output, channelId, field, target, light = false) {
  const def = output.channels[channelId];
  if (!def) return;
  switch (field) {
    case "source": {
      const value = target.value;
      if (value === "constant") {
        def.source = { kind: "constant" };
      } else if (value.startsWith("role:")) {
        def.source = { kind: "role", role: value.slice(5) };
      }
      renderSidebar();
      renderEditor();
      queuePreview();
      scheduleSaveDebounced();
      return;
    }
    case "sample":
      def.sample = getSampleMode(target.value).id;
      break;
    case "invert":
      def.invert = target.checked;
      break;
    case "strength": {
      const value = Number(target.value);
      def.strength = Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 1;
      break;
    }
    case "constant": {
      const value = Math.round(Number(target.value));
      def.constant = Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : 0;
      break;
    }
    default:
      return;
  }
  if (light) {
    // 拖动滑块时只更新数值和画布，避免整块编辑器重建导致焦点丢失
    const row = target.closest("tr");
    if (row) {
      // 同步同类控件（range 与 number 成对）
      if (field === "strength") {
        row.querySelectorAll('[data-channel-field="strength"]').forEach((input) => {
          if (input !== target && input.value !== String(def.strength)) input.value = def.strength;
        });
      }
      if (field === "constant") {
        const swatch = row.querySelector(".swatchbox");
        if (swatch) swatch.style.background = `rgb(${def.constant},${def.constant},${def.constant})`;
      }
    }
  }
  queuePreview();
  scheduleSaveDebounced();
}

el.fileSingleImage.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  const role = state.pendingSlot;
  state.pendingSlot = null;
  if (!file || !role) return;
  const material = activeMaterial();
  if (!material) return;
  const image = await decodeOne(file);
  material.images[role] = { ...image, role };
  renderAll();
  if (image.error) toast(`${file.name}：${image.error}`, "error");
  else toast(`已指定「${getRole(role).label}」来源：${file.name}`, "success");
});

/* ------------------------------ 拖拽导入 ------------------------------ */

let dragDepth = 0;
const stage = document.querySelector(".app");
window.addEventListener("dragenter", (e) => {
  if (![...(e.dataTransfer?.types || [])].includes("Files")) return;
  dragDepth += 1;
  stage.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) stage.classList.remove("dragging");
});
window.addEventListener("dragover", (e) => {
  if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault();
});
window.addEventListener("drop", async (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  dragDepth = 0;
  stage.classList.remove("dragging");
  if (!files.length) return;
  e.preventDefault();

  const slot = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-slot-role]");
  if (slot) {
    const role = slot.dataset.slotRole;
    const file = files[0];
    const material = activeMaterial();
    if (material) {
      const image = await decodeOne(file);
      material.images[role] = { ...image, role };
      renderAll();
      toast(image.error ? `${file.name}：${image.error}` : `已指定「${getRole(role).label}」来源`, image.error ? "error" : "success");
    }
    return;
  }

  const projectFile = files.find((f) => /\.json$/i.test(f.name));
  if (projectFile) {
    await openProjectFile(projectFile);
    return;
  }
  await importFiles(files);
});

/* ------------------------------------------------------------------ */
/* 预览模式                                                            */
/* ------------------------------------------------------------------ */

el.previewModes.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action='preview-mode']");
  if (!btn) return;
  state.previewMode = btn.dataset.mode;
  renderPreview();
});

/* ------------------------------------------------------------------ */
/* 工程打开 / 保存                                                     */
/* ------------------------------------------------------------------ */

$("#btnSave").addEventListener("click", () => saveProject(false));
$("#btnSaveEmbed").addEventListener("click", () => saveProject(true));
$("#btnNew").addEventListener("click", () => {
  if (!confirm("新建工程会替换当前未保存的内容，继续？")) return;
  initProject();
  renderAll();
  toast("已新建工程", "success");
});
$("#btnOpen").addEventListener("click", () => el.fileOpenProject.click());
$("#btnLoadSamples").addEventListener("click", loadSamples);

el.fileOpenProject.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (file) await openProjectFile(file);
});

async function openProjectFile(file) {
  try {
    const text = await file.text();
    const project = deserializeProject(text);
    ensureMaterials(project);
    state.project = project;
    renderAll();
    setStatus(`已打开工程「${project.name}」`, `${project.materials.length} 组材质`, "ok");
    toast("工程已打开，通道映射已恢复", "success");
    await openRebindIfNeeded();
  } catch (err) {
    console.error(err);
    toast(`打开工程失败：${err.message}`, "error");
    setStatus(`打开工程失败：${err.message}`, "", "err");
  }
}

async function saveProject(embedImages) {
  try {
    const payload = serializeProject(state.project, { embedImages: false });
    if (embedImages) {
      let total = 0;
      for (const material of state.project.materials) {
        const target = payload.materials.find((m) => m.id === material.id);
        for (const [role, img] of Object.entries(material.images || {})) {
          if (!img || img.error || !img.data || !target?.images?.[role]) continue;
          const dataUrl = await rgbaToPngDataUrl(img);
          target.images[role].dataUrl = dataUrl;
          total += dataUrl.length;
        }
      }
      if (total > 120 * 1024 * 1024) {
        toast("贴图总大小过大，内嵌工程可能无法保存", "error");
      }
    }
    const json = JSON.stringify(payload, null, 2);
    const name = `${sanitizeName(state.project.name, "texture-project")}${embedImages ? "-embedded" : ""}.json`;
    downloadBlob(new Blob([json], { type: "application/json" }), name);
    toast(embedImages ? "已保存含贴图的工程" : "工程已保存", "success");
  } catch (err) {
    toast(`保存失败：${err.message}`, "error");
  }
}

async function rgbaToPngDataUrl(image) {
  const { encodePng } = await import("./lib/png.js");
  const png = await encodePng({ width: image.width, height: image.height, data: image.data });
  const blob = new Blob([png], { type: "image/png" });
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/* --------------------------- 重新指认来源 --------------------------- */

async function openRebindIfNeeded() {
  if (!state.project) return;
  const needs = [];
  for (const material of state.project.materials) {
    for (const [role, saved] of Object.entries(material.images || {})) {
      if (!saved) continue;
      // 1) 内嵌 dataURL：直接恢复
      if (saved.dataUrl) {
        try {
          const image = await imageFromDataUrl(saved.dataUrl, saved.fileName);
          material.images[role] = { ...(await prepareImage(saved.fileName || `${role}.png`, image)), role };
          continue;
        } catch {
          /* 继续尝试其它方式 */
        }
      }
      // 2) 工程里记录了相对 url（如仓库样例）：尝试直接读取
      if (saved.url) {
        try {
          const image = await decodeUrl(saved.url, saved.fileName);
          material.images[role] = { ...(await prepareImage(saved.fileName || saved.url, image)), role, url: saved.url };
          continue;
        } catch {
          /* 交给重新指认 */
        }
      }
      if (saved.fileName) needs.push({ material, role, fileName: saved.fileName });
    }
  }
  renderAll();
  if (needs.length === 0) return;

  el.rebindDesc.textContent = `工程记录了 ${needs.length} 个来源文件名，但没有附带图片数据。请选择素材文件夹，系统会按文件名自动匹配；点下面任意一行也可以单独指定该槽位。`;
  el.rebindList.innerHTML = needs
    .map(
      (n) => `<li class="rebind-item missing" data-material="${n.material.id}" data-role="${n.role}">
        <span class="role">${escapeHtml(n.material.name)} · ${escapeHtml(getRole(n.role).label)}</span>
        <span class="file">${escapeHtml(n.fileName)}</span>
      </li>`,
    )
    .join("");
  state.pendingRebind = needs;
  if (!el.rebindDialog.open) el.rebindDialog.showModal();
}

// 点击重新指认列表中的某一项：先切到对应材质与角色，再选图
el.rebindList.addEventListener("click", (e) => {
  const row = e.target.closest("[data-material]");
  if (!row) return;
  state.project.activeMaterialId = row.dataset.material;
  const material = activeMaterial();
  state.project.selectedOutputId = material?.outputs[0]?.id || null;
  state.pendingSlot = row.dataset.role;
  renderAll();
  el.rebindDialog.close();
  el.fileSingleImage.click();
});

async function imageFromDataUrl(dataUrl, fileName) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return decodeFile(new File([blob], fileName || "embedded.png", { type: blob.type || "image/png" }));
}

$("#btnCloseRebind").addEventListener("click", () => el.rebindDialog.close());
$("#btnRebindClose").addEventListener("click", () => el.rebindDialog.close());
$("#btnRebindFolder").addEventListener("click", () => el.fileRebind.click());
el.fileRebind.addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  setStatus(`正在匹配 ${files.length} 个文件…`);
  const loaded = await Promise.all(
    files.map(async (f) => {
      try {
        const image = await decodeFile(f);
        return { ...image, fileName: f.name };
      } catch {
        return null;
      }
    }),
  );
  const valid = loaded.filter((img) => img && img.data && img.data.length > 0);
  const result = rebindImages(state.project, valid);
  // 重新指认后把缩略图补上，并清掉"需要重新指认"标记
  for (const material of state.project.materials) {
    for (const [role, img] of Object.entries(material.images || {})) {
      if (!img || !img.data) continue;
      if (!img.thumb) {
        try {
          img.thumb = imageToThumbnail(img, THUMB_MAX);
        } catch {
          img.thumb = null;
        }
      }
      img.needsRebind = false;
      img.role = role;
      if (!img.error) delete img.error;
    }
  }
  renderAll();
  el.rebindDialog.close();
  const missing = result.missing.length + result.ambiguous.length;
  setStatus(
    `重新指认：绑定 ${result.bound.length} 张${missing ? `，仍有 ${missing} 张缺失或有歧义` : ""}`,
    "",
    missing ? "err" : "ok",
  );
  const parts = [`已匹配 ${result.bound.length} 张来源贴图`];
  if (result.ambiguous.length) parts.push(`${result.ambiguous.length} 张存在同名歧义（请单独选择）`);
  if (result.missing.length) parts.push(`${result.missing.length} 张缺失`);
  toast(parts.join("，"), missing ? "" : "success");
});

/* ------------------------------------------------------------------ */
/* 批量导出                                                            */
/* ------------------------------------------------------------------ */

$("#btnExport").addEventListener("click", () => startExport());
$("#btnCloseExport").addEventListener("click", () => el.exportDialog.close());
$("#btnExportAgain").addEventListener("click", () => startExport());

async function startExport() {
  if (state.busy) return;
  const project = state.project;
  const enabled = project.materials.reduce(
    (n, m) => n + m.outputs.filter((o) => o.enabled !== false).length,
    0,
  );
  if (enabled === 0) {
    toast("没有启用的输出，请先添加输出贴图", "error");
    return;
  }

  state.busy = true;
  state.batchZip = null;
  el.btnDownloadZip.disabled = true;
  el.btnExportAgain.disabled = true;
  // 重新导出时 dialog 已经打开，再次 showModal 会抛 InvalidStateError
  if (!el.exportDialog.open) el.exportDialog.showModal();
  el.exportProgressBar.style.width = "0%";
  el.exportProgressText.textContent = "准备中…";
  el.exportSummary.textContent = "";
  el.exportItems.innerHTML = "";

  try {
    const plan = buildExportPlan(project, { format: "png" });
    const itemNodes = new Map();
    for (const item of plan.items) {
      const node = document.createElement("li");
      node.className = "export-item";
      node.innerHTML = `<span class="state">…</span><span class="path">${escapeHtml(item.zipPath)}</span><span class="size"></span>`;
      el.exportItems.appendChild(node);
      itemNodes.set(item, node);
    }
    for (const skip of plan.skipped) {
      const node = document.createElement("li");
      node.className = "export-item skip";
      node.innerHTML = `<span class="state">–</span><span class="path">${escapeHtml(skip.materialName)} / ${escapeHtml(skip.outputName || "")}</span><span class="reason">${escapeHtml(skip.reason)}</span>`;
      el.exportItems.appendChild(node);
    }

    const results = await runExportPlan(
      plan,
      async (item) => {
        const material = project.materials.find((m) => m.id === item.materialId);
        const images = new Map();
        for (const [role, img] of Object.entries(material.images || {})) {
          if (img && !img.needsRebind) images.set(role, img);
        }
        return renderOutputItem({
          material,
          output: { ...item, name: item.outputName },
          size: { width: item.width, height: item.height, fitMode: item.fitMode },
          images,
          failOnDecodeError: true,
        });
      },
      {
        onProgress: ({ done, total: all, phase }) => {
          const pct = all ? Math.round((done / all) * 100) : 0;
          el.exportProgressBar.style.width = `${pct}%`;
          el.exportProgressText.textContent =
            phase === "start" && done === 0 ? `处理中 1/${all}` : `处理中 ${done}/${all}`;
        },
        onItem: ({ ok, item, error }) => {
          const node = itemNodes.get(item);
          if (!node) return;
          node.classList.add(ok ? "ok" : "fail");
          node.querySelector(".state").textContent = ok ? "✓" : "✗";
          if (ok) {
            node.querySelector(".size").textContent = `${item.width}×${item.height} · ${formatBytes(item.byteLength)}`;
          } else {
            const reason = document.createElement("span");
            reason.className = "reason";
            reason.textContent = error;
            node.appendChild(reason);
            node.querySelector(".size").textContent = "";
          }
        },
      },
    );

    const manifest = buildManifest({
      project,
      plan,
      succeeded: results.succeeded,
      failed: results.failed,
    });

    const zipFiles = [];
    for (const item of results.succeeded) {
      if (item.png) zipFiles.push({ name: item.zipPath, data: item.png });
      if (item.reportPath && item.reportText) {
        zipFiles.push({ name: item.reportPath, data: new TextEncoder().encode(item.reportText) });
      }
    }
    zipFiles.push({ name: "manifest.txt", data: new TextEncoder().encode(manifest) });
    const zip = createZip(zipFiles);
    state.batchZip = { blob: new Blob([zip], { type: "application/zip" }), manifest, plan, results };

    const failed = results.failed.length + plan.skipped.length;
    el.exportSummary.innerHTML = `
      <span class="stat-pill ok"><b>${results.succeeded.length}</b><span>成功</span></span>
      <span class="stat-pill fail"><b>${failed}</b><span>失败 / 跳过</span></span>
      <span class="stat-pill"><b>${formatBytes(zip.length)}</b><span>ZIP 体积</span></span>
    `;
    el.exportProgressBar.style.width = "100%";
    el.exportProgressText.textContent = failed ? `完成，${failed} 项未导出` : "全部完成";
    el.btnDownloadZip.disabled = false;
    el.btnExportAgain.disabled = false;

    renderBatchPanel(results, plan);
    if (failed) {
      setStatus(`导出完成：成功 ${results.succeeded.length}，失败/跳过 ${failed}`, "详见导出面板", "err");
      toast(`有 ${failed} 项未导出，原因已列出；成功项已保留`, "error");
    } else {
      setStatus(`导出完成：${results.succeeded.length} 项`, "可下载 ZIP", "ok");
      toast(`导出完成，共 ${results.succeeded.length} 项`, "success");
    }
  } catch (err) {
    console.error(err);
    el.exportProgressText.textContent = `导出失败：${err.message}`;
    toast(`导出失败：${err.message}`, "error");
  } finally {
    state.busy = false;
  }
}
$("#btnDownloadZip").addEventListener("click", () => {
  if (!state.batchZip) return;
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(state.batchZip.blob, `${sanitizeName(state.project.name, "textures")}-${stamp}.zip`);
  toast("已开始下载 ZIP", "success");
});

function renderBatchPanel(results, plan) {
  const failed = [...results.failed, ...plan.skipped];
  el.batchPanel.classList.remove("hidden");
  const rows = [
    ...results.succeeded.map(
      (item) => `<li class="batch-row ok"><span class="state">✓</span><span class="path">${escapeHtml(item.zipPath)}</span></li>`,
    ),
    ...results.failed.map(
      (item) =>
        `<li class="batch-row fail"><span class="state">✗</span><span class="path">${escapeHtml(item.materialName)} / ${escapeHtml(item.outputName)}</span><span class="reason" title="${escapeHtml(item.error)}">${escapeHtml(item.error)}</span></li>`,
    ),
    ...plan.skipped.map(
      (item) =>
        `<li class="batch-row skip"><span class="state">–</span><span class="path">${escapeHtml(item.materialName)} / ${escapeHtml(item.outputName || "")}</span><span class="reason" title="${escapeHtml(item.reason)}">${escapeHtml(item.reason)}</span></li>`,
    ),
  ];
  el.batchPanel.innerHTML = `
    <div class="batch-summary">
      <div class="stat-pill ok"><b>${results.succeeded.length}</b><span>成功</span></div>
      <div class="stat-pill fail"><b>${failed.length}</b><span>失败/跳过</span></div>
    </div>
    <ul class="batch-list">${rows.join("")}</ul>
  `;
}

/* ------------------------------------------------------------------ */
/* 键盘快捷键                                                          */
/* ------------------------------------------------------------------ */

window.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveProject(e.shiftKey);
  } else if (e.key.toLowerCase() === "e") {
    e.preventDefault();
    startExport();
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  initProject();
  renderAll();
  maybeOfferRecovery();
  setStatus(`就绪 · ${APP_NAME} v${APP_VERSION}`, "支持 PNG / JPEG / WebP / BMP / GIF / TGA / SVG");
  console.info(`${APP_NAME} ${APP_VERSION}`);
}

boot();

/* 供调试与自动化测试使用 */
window.__texApp = {
  state,
  importFiles,
  loadSamples,
  startExport,
  serializeProject,
  buildPreview,
  renderAll,
};
