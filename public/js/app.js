/*
 * app.js —— 界面与状态管理。
 * 全局状态 project 由本模块持有，所有编辑先改状态，再 render() 重绘。
 */
(function (global) {
  "use strict";
  const MT = global.MT;
  const core = MT.core;
  const imageApi = MT.image;
  const batch = MT.batch;
  const preview = MT.preview;

  const state = {
    project: core.defaultProject(),
    selectedGroupIndex: 0,
    selectedOutputIndex: 0,
    normalCompare: false,   // 法线 OpenGL/DirectX 分屏对比
    lightAngle: 35,
    normalPreview: null,
    lastComposed: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ------------------------------------------------------------------ //
  // 输入控件辅助
  // ------------------------------------------------------------------ //

  function bindNumber(input, get, set, { min = 0, max = 255, step = 1, allowFloat = false } = {}) {
    input.type = "number";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = get();
    input.addEventListener("change", () => {
      let v = allowFloat ? parseFloat(input.value) : parseInt(input.value, 10);
      if (Number.isNaN(v)) v = get();
      v = core.clamp(v, min, max);
      set(v);
      input.value = v;
      schedulePreview();
    });
  }

  function bindCheckbox(input, get, set) {
    input.type = "checkbox";
    input.checked = !!get();
    input.addEventListener("change", () => {
      set(input.checked);
      schedulePreview();
    });
  }

  function selectBox(options, value, labels, onChange) {
    const s = el("select");
    for (const opt of options) {
      const o = el("option", null, labels ? labels[opt] || opt : opt);
      o.value = opt;
      if (opt === value) o.selected = true;
      s.appendChild(o);
    }
    s.addEventListener("change", () => onChange(s.value));
    return s;
  }

  // ------------------------------------------------------------------ //
  // 左栏：全局设置 + 输出通道配置
  // ------------------------------------------------------------------ //

  function renderSettings() {
    const host = $("#settings-panel");
    host.innerHTML = "";
    const s = state.project.settings;

    const row = (labelText, control) => {
      const r = el("div", "form-row");
      r.appendChild(el("label", null, labelText));
      r.appendChild(control);
      return r;
    };

    const w = el("input");
    bindNumber(w, () => s.outputWidth, (v) => (s.outputWidth = v), { min: 8, max: 4096 });
    const h = el("input");
    bindNumber(h, () => s.outputHeight, (v) => (s.outputHeight = v), { min: 8, max: 4096 });
    const sizeRow = el("div", "form-row");
    sizeRow.appendChild(el("label", null, "输出尺寸"));
    sizeRow.appendChild(w);
    sizeRow.appendChild(el("span", "sep", "×"));
    sizeRow.appendChild(h);
    host.appendChild(sizeRow);

    host.appendChild(
      row(
        "尺寸不一致",
        selectBox(core.RESIZE_POLICIES, s.resizePolicy, core.RESIZE_POLICY_LABELS, (v) => {
          s.resizePolicy = v;
          schedulePreview();
        })
      )
    );

    const padWrap = el("div", "form-row pad-row");
    padWrap.appendChild(el("label", null, "留边填充色"));
    for (const c of ["r", "g", "b", "a"]) {
      const inp = el("input", "pad-input");
      bindNumber(inp, () => s.padColor[c], (v) => (s.padColor[c] = v));
      padWrap.appendChild(inp);
    }
    host.appendChild(padWrap);

    host.appendChild(
      row(
        "法线方向约定",
        selectBox(core.ORIENTATIONS, s.normalOrientation, core.ORIENTATION_LABELS, (v) => {
          s.normalOrientation = v;
          schedulePreview();
        })
      )
    );

    const strength = el("input");
    bindNumber(strength, () => s.normalStrength, (v) => (s.normalStrength = v), {
      min: 0, max: 4, step: 0.05, allowFloat: true,
    });
    host.appendChild(row("法线强度", strength));

    const compare = el("input");
    bindCheckbox(compare, () => state.normalCompare, (v) => (state.normalCompare = v));
    host.appendChild(row("分屏对比两种方向", compare));

    const failOnMissing = el("input");
    bindCheckbox(failOnMissing, () => !!s.failOnMissingRole, (v) => (s.failOnMissingRole = v));
    host.appendChild(row("缺来源即判失败", failOnMissing));

    const pattern = el("input", "text-input");
    pattern.type = "text";
    pattern.value = s.filenamePattern;
    pattern.placeholder = "{group}_{output}";
    pattern.addEventListener("change", () => (s.filenamePattern = pattern.value || "{group}_{output}"));
    host.appendChild(row("导出文件名模板", pattern));

    const embed = el("input");
    bindCheckbox(embed, () => s.embedImages, (v) => (s.embedImages = v));
    host.appendChild(row("工程内嵌图片", embed));
  }

  function renderOutputs() {
    const host = $("#outputs-panel");
    host.innerHTML = "";
    state.project.outputs.forEach((output, oi) => {
      const card = el("div", "card output-card" + (oi === state.selectedOutputIndex ? " selected" : ""));
      const head = el("div", "card-head");
      const name = el("input", "card-name");
      name.value = output.name;
      name.addEventListener("change", () => {
        output.name = name.value || output.name;
        renderOutputs();
      });
      head.appendChild(name);

      const normalToggle = el("button", "mini-btn", output.isNormal ? "法线输出 ✓" : "普通输出");
      normalToggle.title = "切换法线输出（应用 G 翻转与法线强度）";
      normalToggle.addEventListener("click", () => {
        output.isNormal = !output.isNormal;
        renderAll();
      });
      head.appendChild(normalToggle);

      const del = el("button", "mini-btn danger", "删除");
      del.addEventListener("click", () => {
        if (state.project.outputs.length <= 1) return alert("至少保留一个输出");
        state.project.outputs.splice(oi, 1);
        state.selectedOutputIndex = Math.min(state.selectedOutputIndex, state.project.outputs.length - 1);
        renderAll();
      });
      head.appendChild(del);
      card.appendChild(head);

      const fileRow = el("div", "form-row compact");
      fileRow.appendChild(el("label", null, "文件名片段"));
      const fileInput = el("input", "text-input");
      fileInput.value = output.filename;
      fileInput.addEventListener("change", () => (output.filename = fileInput.value || output.filename));
      fileRow.appendChild(fileInput);
      card.appendChild(fileRow);

      const table = el("div", "channel-table");
      output.channels.forEach((spec) => table.appendChild(renderChannelRow(output, spec)));
      card.appendChild(table);

      const addCh = el("button", "mini-btn", "+ 添加通道");
      const used = new Set(output.channels.map((c) => c.channel));
      const nextCh = core.CHANNELS.find((c) => !used.has(c));
      if (!nextCh) addCh.disabled = true;
      addCh.addEventListener("click", () => {
        output.channels.push(core.channelSpec(nextCh, null, "red", {
          source: { type: "constant", value: nextCh === "a" ? 255 : 0 },
        }));
        renderAll();
      });
      card.appendChild(addCh);

      // 点击卡片任意空白处即切换为当前编辑输出；控件自身的事件不受影响。
      // 只更新选中样式与预览，不重建 DOM，避免点击目标被移除带来的状态丢失。
      card.addEventListener("click", (e) => {
        if (e.target.closest("input, select, button, label, option, a")) return;
        if (state.selectedOutputIndex === oi) return;
        state.selectedOutputIndex = oi;
        document.querySelectorAll(".output-card").forEach((c, i) =>
          c.classList.toggle("selected", i === oi)
        );
        schedulePreview();
      });
      host.appendChild(card);
    });

    const add = el("button", "btn", "+ 新建输出");
    add.addEventListener("click", () => {
      state.project.outputs.push({
        id: core.uid("out"),
        name: `输出 ${state.project.outputs.length + 1}`,
        filename: `output${state.project.outputs.length + 1}`,
        isNormal: false,
        channels: [
          core.channelSpec("r", null, "red", { source: { type: "constant", value: 0 } }),
          core.channelSpec("g", null, "red", { source: { type: "constant", value: 0 } }),
          core.channelSpec("b", null, "red", { source: { type: "constant", value: 0 } }),
        ],
      });
      renderAll();
    });
    host.appendChild(add);
  }

  function renderChannelRow(output, spec) {
    const rowEl = el("div", "channel-row");
    rowEl.appendChild(el("span", "ch-badge ch-" + spec.channel, spec.channel.toUpperCase()));

    // 来源：角色 / 常量
    const srcSel = el("select");
    const constOpt = el("option", null, "常量补齐");
    constOpt.value = "__const";
    if (spec.source.type === "constant") constOpt.selected = true;
    srcSel.appendChild(constOpt);
    for (const role of core.ROLES) {
      const o = el("option", null, core.ROLE_LABELS[role]);
      o.value = role;
      if (spec.source.type === "role" && spec.source.role === role) o.selected = true;
      srcSel.appendChild(o);
    }
    srcSel.addEventListener("change", () => {
      spec.source = srcSel.value === "__const"
        ? { type: "constant", value: spec.constant ?? 255 }
        : { type: "role", role: srcSel.value };
      renderOutputs();
      schedulePreview();
    });
    rowEl.appendChild(srcSel);

    if (spec.source.type === "constant") {
      const cv = el("input", "const-input");
      bindNumber(cv, () => core.clamp8(spec.source.value), (v) => (spec.source.value = v));
      rowEl.appendChild(cv);
      const swatch = el("span", "const-swatch");
      swatch.style.background = `rgb(${spec.source.value},${spec.source.value},${spec.source.value})`;
      swatch.title = "常量预览";
      rowEl.appendChild(swatch);
    } else {
      rowEl.appendChild(
        selectBox(core.PICK_MODES, spec.mode, core.PICK_MODE_LABELS, (v) => {
          spec.mode = v;
          schedulePreview();
        })
      );
      const inv = el("input");
      bindCheckbox(inv, () => spec.invert, (v) => (spec.invert = v));
      inv.title = "反转该通道";
      const invLabel = el("label", "inline", "反");
      invLabel.appendChild(inv);
      rowEl.appendChild(invLabel);

      const st = el("input", "strength-input");
      bindNumber(st, () => spec.strength, (v) => (spec.strength = v), {
        min: 0, max: 4, step: 0.05, allowFloat: true,
      });
      st.title = "通道强度（0~4）";
      rowEl.appendChild(st);

      const rm = el("button", "mini-btn danger", "×");
      rm.title = "移除该通道";
      rm.addEventListener("click", () => {
        output.channels = output.channels.filter((c) => c !== spec);
        renderOutputs();
        schedulePreview();
      });
      rowEl.appendChild(rm);
    }
    return rowEl;
  }

  // ------------------------------------------------------------------ //
  // 中栏：材质分组与文件
  // ------------------------------------------------------------------ //

  async function handleFiles(fileList) {
    const accepted = Array.from(fileList).filter((f) =>
      core.IMAGE_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext))
    );
    const rejected = Array.from(fileList).length - accepted.length;
    const loaded = [];
    for (const f of accepted) {
      try {
        loaded.push(await imageApi.readImageFile(f));
      } catch (err) {
        log(`[失败] ${f.name}: ${err.message}`, "err");
      }
    }
    if (!loaded.length) {
      if (rejected) log(`忽略 ${rejected} 个不支持的文件`, "warn");
      return;
    }
    const existing = allFiles().map((f) => ({
      ...f,
      role: findRoleOf(f) || "unassigned",
      group: findGroupOf(f)?.name,
    }));
    const groups = core.matchGroups([...existing, ...loaded], state.project.roleSuffixes);
    state.project.groups = groups;
    state.selectedGroupIndex = Math.min(state.selectedGroupIndex, groups.length - 1);
    log(`载入 ${loaded.length} 张图，识别出 ${groups.length} 组材质` + (rejected ? `，忽略 ${rejected} 个非图片文件` : ""));
    renderAll();
  }

  function findGroupOf(file) {
    return state.project.groups.find(
      (g) => Object.values(g.files).some((f) => f.id === file.id) ||
        g.unassigned.some((f) => f.id === file.id)
    );
  }
  function findRoleOf(file) {
    for (const g of state.project.groups) {
      for (const [role, f] of Object.entries(g.files)) {
        if (f.id === file.id) return role;
      }
    }
    return null;
  }

  function allFiles() {
    const out = [];
    for (const g of state.project.groups) {
      Object.values(g.files).forEach((f) => out.push(f));
      g.unassigned.forEach((f) => out.push(f));
    }
    return out;
  }

  function renderGroups() {
    const host = $("#groups-panel");
    host.innerHTML = "";
    const groups = state.project.groups;
    if (!groups.length) {
      host.appendChild(el("div", "empty-hint", "尚未载入贴图。可点上方「载入贴图」选择多张图片，或「载入内置样例」。"));
    }
    groups.forEach((g, gi) => {
      const card = el("div", "card group-card" + (gi === state.selectedGroupIndex ? " selected" : ""));
      const head = el("div", "card-head");
      head.appendChild(el("strong", null, g.name));
      head.appendChild(el("span", "muted", ` ${Object.keys(g.files).length} 张已识别`));
      card.appendChild(head);

      const roles = el("div", "role-grid");
      for (const role of core.ROLES) {
        const f = g.files[role];
        const cell = el("div", "role-cell" + (f ? "" : " missing"));
        cell.appendChild(el("span", "role-label", core.ROLE_LABELS[role]));
        const select = el("select");
        const none = el("option", null, f ? "—" : "（缺）");
        none.value = "";
        select.appendChild(none);
        const candidates = [...g.unassigned, ...Object.values(g.files)];
        for (const cand of candidates) {
          const o = el("option", null, `${cand.name} (${cand.width}×${cand.height})`);
          o.value = cand.id;
          if (f && cand.id === f.id) o.selected = true;
          select.appendChild(o);
        }
        select.addEventListener("change", () => {
          assignRole(g, role, select.value);
        });
        cell.appendChild(select);
        if (f) {
          const thumb = el("img", "thumb");
          thumb.src = f.dataUrl;
          thumb.title = `${f.name}\n${f.width}×${f.height}`;
          cell.appendChild(thumb);
        }
        roles.appendChild(cell);
      }
      card.appendChild(roles);

      if (g.warnings.length) {
        const w = el("div", "warn-box");
        g.warnings.forEach((msg) => w.appendChild(el("div", null, "⚠ " + msg)));
        card.appendChild(w);
      }

      const actions = el("div", "card-actions");
      const remove = el("button", "mini-btn danger", "删除整组");
      remove.addEventListener("click", () => {
        state.project.groups.splice(gi, 1);
        state.selectedGroupIndex = Math.max(0, state.selectedGroupIndex - 1);
        renderAll();
      });
      actions.appendChild(remove);
      card.appendChild(actions);

      card.addEventListener("click", (e) => {
        if (e.target.closest("select, button, img, input, label, a")) return;
        state.selectedGroupIndex = gi;
        renderGroups();
        schedulePreview();
      });
      host.appendChild(card);
    });
  }

  function assignRole(group, role, fileId) {
    // 从旧角色/未分配里摘出
    const detach = (id) => {
      for (const r of Object.keys(group.files)) {
        if (group.files[r] && group.files[r].id === id) delete group.files[r];
      }
      group.unassigned = group.unassigned.filter((f) => f.id !== id);
    };
    if (!fileId) {
      if (group.files[role]) {
        group.unassigned.push(group.files[role]);
        delete group.files[role];
      }
    } else {
      const all = [...group.unassigned, ...Object.values(group.files)];
      const f = all.find((x) => x.id === fileId);
      if (!f) return;
      detach(fileId);
      if (group.files[role]) group.unassigned.push(group.files[role]);
      group.files[role] = f;
    }
    renderGroups();
    schedulePreview();
  }

  // ------------------------------------------------------------------ //
  // 右栏：预览
  // ------------------------------------------------------------------ //

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 60);
  }

  function currentGroup() {
    return state.project.groups[state.selectedGroupIndex] || null;
  }
  function currentOutput() {
    return state.project.outputs[state.selectedOutputIndex] || null;
  }

  function updatePreview() {
    const out = currentOutput();
    const group = currentGroup();
    const previewHost = $("#preview-panel");
    previewHost.innerHTML = "";
    if (!out) return;

    if (!group) {
      previewHost.appendChild(el("div", "empty-hint", "载入贴图后在此预览通道合成结果。"));
      renderNormalPreview(null);
      return;
    }

    let composed;
    try {
      composed = imageApi.composeOutput(group, out, state.project.settings);
      state.lastComposed = composed;
    } catch (err) {
      previewHost.appendChild(el("div", "error-box", "预览失败: " + err.message));
      return;
    }

    // 合成结果
    previewHost.appendChild(el("h3", null, `合成预览 — ${group.name} / ${out.name}`));
    const wrap = el("div", "preview-main");
    const canvas = el("canvas", "preview-canvas");
    preview.drawImageData(canvas, composed.imageData);
    preview.drawResizeOverlay(canvas, composed.resizeInfos, state.project.settings.outputWidth, state.project.settings.outputHeight);
    wrap.appendChild(canvas);
    const meta = el("div", "preview-meta");
    const missing = composed.notes.filter((n) => n.usedFallback);
    meta.appendChild(el("div", missing.length ? "warn-text" : "ok-text",
      missing.length ? `⚠ ${missing.length} 个通道使用常量补齐` : "✓ 所有通道均有图片来源"));
    composed.resizeInfos.filter((r) => r.mismatch).forEach((r) => {
      meta.appendChild(el("div", "warn-text",
        `尺寸不一致 ${r.sourceWidth}×${r.sourceHeight} → ${state.project.settings.outputWidth}×${state.project.settings.outputHeight}（${core.RESIZE_POLICY_LABELS[r.policy].split("（")[0]}）`));
    });
    wrap.appendChild(meta);
    previewHost.appendChild(wrap);

    // 逐通道灰度预览
    const chGrid = el("div", "channel-preview-grid");
    composed.channelPreviews.forEach(({ spec, gray, note }) => {
      const cell = el("div", "channel-preview-cell");
      const cv = el("canvas");
      preview.drawImageData(cv, gray);
      cell.appendChild(cv);
      const cap = el("div", "channel-caption");
      cap.appendChild(el("strong", null, core.CHANNEL_LABELS[spec.channel]));
      cap.appendChild(el("div", "muted small", note.source));
      cap.appendChild(el("div", "muted small", note.detail));
      cell.appendChild(cap);
      chGrid.appendChild(cell);
    });
    previewHost.appendChild(el("h4", null, "各通道实际结果（灰度）"));
    previewHost.appendChild(chGrid);

    // 法线表面效果
    if (out.isNormal) renderNormalPreview(composed.imageData);
    else renderNormalPreview(null);
  }

  function renderNormalPreview(imageData) {
    const host = $("#normal-preview-panel");
    host.innerHTML = "";
    if (!currentOutput() || !currentOutput().isNormal) {
      host.style.display = "none";
      return;
    }
    host.style.display = "";
    host.appendChild(el("h3", null, "法线表面效果（方向约定即时对比）"));
    const canvas = el("canvas", "normal-canvas");
    canvas.width = 560;
    canvas.height = 260;
    host.appendChild(canvas);
    const caption = el("div", "muted small");
    host.appendChild(caption);

    if (!imageData) {
      caption.textContent = "载入含法线来源的组后显示";
      return;
    }
    try {
      if (!state.normalPreview) state.normalPreview = new preview.NormalPreview(canvas);
      const np = state.normalPreview;
      if (!np.ok) {
        caption.textContent = "当前浏览器不支持 WebGL，无法显示表面效果";
        return;
      }
      np.displayCanvas = canvas;
      np.updateTexture(imageData);
      const orientations = state.normalCompare ? ["opengl", "directx"] : [state.project.settings.normalOrientation];
      np.render(orientations, state.lightAngle);
      caption.textContent = orientations.length === 2
        ? "左：OpenGL / glTF（+Y）　右：DirectX / Unity（-Y），同一法线图同光照对比"
        : `当前约定：${core.ORIENTATION_LABELS[state.project.settings.normalOrientation]}`;
    } catch (err) {
      caption.textContent = "法线预览失败: " + err.message;
    }
  }

  // 光源角度滑块（独立小控件，放在法线面板里动态构建）
  function initLightSlider() {
    const slider = $("#light-angle");
    slider.min = "0";
    slider.max = "360";
    slider.value = String(state.lightAngle);
    slider.addEventListener("input", () => {
      state.lightAngle = parseInt(slider.value, 10);
      updatePreview();
    });
  }

  // ------------------------------------------------------------------ //
  // 内置样例
  // ------------------------------------------------------------------ //

  async function loadSamples() {
    const data = global.MT_SAMPLE_DATA;
    if (!data) {
      log("未找到样例数据。请先运行 npm run generate:samples", "err");
      return;
    }
    const files = [];
    for (const [rel, url] of Object.entries(data)) {
      if (rel.endsWith(".js") || rel.endsWith(".json")) continue;
      try {
        const name = rel.split("/").pop();
        const image = await imageApi.loadImageElement(url);
        const file = {
          id: core.uid("img"), name, dataUrl: url, image,
          width: image.naturalWidth, height: image.naturalHeight,
        };
        // 尺寸不一致样例：归入 brick 组的未分配，方便手工替换颜色角色演示三种策略
        if (rel.startsWith("mismatch/")) {
          file.role = "unassigned";
          file.group = "brick";
        }
        files.push(file);
      } catch (err) {
        log(`[样例失败] ${rel}: ${err.message}`, "err");
      }
    }
    state.project.groups = core.matchGroups(files, state.project.roleSuffixes);
    state.selectedGroupIndex = 0;
    const mismatchGroup = state.project.groups.find((g) => g.name === "brick");
    if (mismatchGroup && mismatchGroup.unassigned.length) {
      mismatchGroup.warnings.push(
        `尺寸不一致演示：${mismatchGroup.unassigned.map((f) => `${f.name}（${f.width}×${f.height}）`).join("、")} ` +
        "已放入未分配，可把「颜色」角色替换为它，再切换拉伸/裁切/留边策略对比效果"
      );
    }
    log(`已载入内置样例：${state.project.groups.length} 组（含 128×128 尺寸不一致样例）`);
    renderAll();
  }

  // ------------------------------------------------------------------ //
  // 工程保存 / 打开
  // ------------------------------------------------------------------ //

  function saveProject() {
    const json = batch.serializeProject(state.project, state.project.settings.embedImages);
    downloadText("mtpack-project.json", json, "application/json");
    log("工程已保存（" + (state.project.settings.embedImages ? "图片已内嵌" : "仅保存引用，恢复时需重新上传") + "）");
  }

  async function openProject(file) {
    const text = await file.text();
    try {
      const { project, decodeErrors } = await batch.rehydrateProject(text);
      state.project = project;
      state.selectedGroupIndex = 0;
      state.selectedOutputIndex = 0;
      const missingCount = project.groups.reduce(
        (n, g) => n + Object.values(g.files).filter((f) => f.missing).length, 0
      );
      log(`工程已恢复：${project.outputs.length} 个输出、${project.groups.length} 组材质` +
        (missingCount ? `，${missingCount} 张图片未内嵌需重新指定` : ""));
      decodeErrors.forEach((m) => log("解码失败: " + m, "err"));
      renderAll();
    } catch (err) {
      alert("工程文件无法打开: " + err.message);
    }
  }

  // ------------------------------------------------------------------ //
  // 批量导出
  // ------------------------------------------------------------------ //

  async function exportAll() {
    if (!state.project.groups.length) return alert("没有可处理的材质组");
    const btn = $("#export-btn");
    btn.disabled = true;
    btn.textContent = "处理中…";
    try {
      const { entries, successes, failures, manifest } = await batch.runBatch(state.project, (done, total) => {
        btn.textContent = `处理中 ${done}/${total}…`;
      });
      const zipBytes = core.zipStore(entries);
      downloadBytes("mtpack-export.zip", zipBytes, "application/zip");
      const logHost = $("#batch-log");
      logHost.innerHTML = "";
      logHost.appendChild(el("div", "ok-text", `✓ 成功 ${successes.length} 项，打包 ${entries.length} 个文件（含 manifest.json 与每张输出的 *_sources.txt 来源说明）`));
      if (failures.length) {
        logHost.appendChild(el("div", "err-text", `✗ 失败 ${failures.length} 项（成功项已保留）：`));
        failures.forEach((f) => logHost.appendChild(el("div", "err-text small", `· [${f.group}/${f.output}] ${f.reason}`)));
      }
      successes.forEach((r) => {
        const tags = [];
        if (r.fallbackChannels.length) tags.push("常量补齐: " + r.fallbackChannels.join(","));
        if (r.sizeMismatches) tags.push(`尺寸处理 ${r.sizeMismatches} 处`);
        logHost.appendChild(el("div", "small", `· ${r.file} ${tags.length ? "（" + tags.join("；") + "）" : ""}`));
      });
    } catch (err) {
      log("导出失败: " + err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "批量导出 ZIP";
    }
  }

  // ------------------------------------------------------------------ //
  // 下载与日志
  // ------------------------------------------------------------------ //

  function downloadText(name, text, mime) {
    downloadBytes(name, new TextEncoder().encode(text), mime);
  }
  function downloadBytes(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime });
    const a = el("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function log(msg, level) {
    const host = $("#status-log");
    const line = el("div", level === "err" ? "err-text" : level === "warn" ? "warn-text" : "small",
      `[${new Date().toLocaleTimeString()}] ${msg}`);
    host.prepend(line);
  }

  function renderAll() {
    renderSettings();
    renderOutputs();
    renderGroups();
    schedulePreview();
  }

  // ------------------------------------------------------------------ //
  // 启动
  // ------------------------------------------------------------------ //

  function init() {
    $("#file-input").addEventListener("change", (e) => {
      handleFiles(e.target.files);
      e.target.value = "";
    });
    $("#sample-btn").addEventListener("click", loadSamples);
    $("#save-btn").addEventListener("click", saveProject);
    $("#open-project").addEventListener("change", (e) => {
      if (e.target.files[0]) openProject(e.target.files[0]);
      e.target.value = "";
    });
    $("#export-btn").addEventListener("click", exportAll);
    initLightSlider();
    renderAll();
    log("就绪。支持格式：PNG / JPG / JPEG / WebP / BMP / GIF（以浏览器解码能力为准）");
  }

  document.addEventListener("DOMContentLoaded", init);
})(typeof globalThis !== "undefined" ? globalThis : this);
