/*
 * batch.js —— 批量处理、来源说明生成、工程保存/恢复。
 */
(function (global) {
  "use strict";
  const MT = global.MT || (global.MT = {});
  const core = MT.core;
  const imageApi = MT.image;

  /** 序列化为可保存的纯 JSON（剥离 DOM Image 对象） */
  function serializeProject(project, embedImages) {
    const clone = JSON.parse(JSON.stringify(project));
    clone.settings.embedImages = !!embedImages;
    clone.groups = (project.groups || []).map((g) => ({
      name: g.name,
      warnings: g.warnings || [],
      files: Object.fromEntries(
        Object.entries(g.files || {}).map(([role, f]) => [
          role,
          {
            id: f.id,
            name: f.name,
            width: f.width,
            height: f.height,
            dataUrl: embedImages ? f.dataUrl : undefined,
          },
        ])
      ),
      unassigned: (g.unassigned || []).map((f) => ({
        id: f.id, name: f.name, width: f.width, height: f.height,
        dataUrl: embedImages ? f.dataUrl : undefined,
      })),
    }));
    return JSON.stringify(clone, null, 2);
  }

  /** 恢复工程：重新解码内嵌图片；未内嵌的图片保留占位，等待用户重新上传 */
  async function rehydrateProject(raw) {
    const project = core.normalizeProject(typeof raw === "string" ? JSON.parse(raw) : raw);
    const pending = [];
    const visit = (f) => {
      if (!f) return;
      if (f.dataUrl) {
        pending.push(
          imageApi.loadImageElement(f.dataUrl).then((img) => {
            f.image = img;
            f.width = img.naturalWidth;
            f.height = img.naturalHeight;
            f.missing = false;
          })
        );
      } else {
        f.missing = true;
      }
    };
    for (const g of project.groups || []) {
      Object.values(g.files || {}).forEach(visit);
      (g.unassigned || []).forEach(visit);
    }
    const results = await Promise.allSettled(pending);
    const decodeErrors = results.filter((r) => r.status === "rejected").map((r) => r.reason.message);
    return { project, decodeErrors };
  }

  function channelSourceText(spec, group, settings) {
    const label = core.CHANNEL_LABELS[spec.channel];
    if (spec.source.type === "constant") {
      return `${label}: 常量 ${core.clamp8(spec.source.value)}（无来源图片）`;
    }
    const file = group.files[spec.source.role];
    const roleLabel = core.ROLE_LABELS[spec.source.role] || spec.source.role;
    if (!file) {
      return `${label}: 缺少「${roleLabel}」来源，常量 ${core.clamp8(spec.constant)} 补齐`;
    }
    let line =
      `${label}: 来源 ${file.name}（${roleLabel}，${file.width}×${file.height}）` +
      `，取色方式：${core.PICK_MODE_LABELS[spec.mode]}`;
    if (spec.invert) line += "，已反转";
    if (spec.strength !== 1) line += `，强度 ×${spec.strength}`;
    return line;
  }

  function buildSidecarText(group, output, composed, settings) {
    const lines = [
      `# 输出来源说明 — ${group.name}/${output.name}`,
      `生成时间: ${new Date().toISOString()}`,
      `输出尺寸: ${settings.outputWidth}×${settings.outputHeight}`,
      `尺寸不一致策略: ${core.RESIZE_POLICY_LABELS[settings.resizePolicy]}`,
      output.isNormal
        ? `法线约定: ${core.ORIENTATION_LABELS[settings.normalOrientation]}，法线强度 ×${settings.normalStrength}`
        : "",
      "",
      "## 通道映射",
      ...output.channels.map((s) => channelSourceText(s, group, settings)),
      "",
      "## 实际处理记录",
      ...composed.notes.map((n) => `- [${core.CHANNEL_LABELS[n.channel]}] ${n.source} — ${n.detail}`),
    ];
    const mismatches = composed.resizeInfos.filter((r) => r.mismatch);
    if (mismatches.length) {
      lines.push("", "## 尺寸不一致处理");
      for (const m of mismatches) {
        lines.push(
          `- ${m.sourceWidth}×${m.sourceHeight} -> ${settings.outputWidth}×${settings.outputHeight}，` +
            `策略「${core.RESIZE_POLICY_LABELS[m.policy].split("（")[0]}」，` +
            `目标区域 (${m.rect.dx},${m.rect.dy}) ${m.rect.dw}×${m.rect.dh}`
        );
      }
    }
    return lines.filter((l) => l !== undefined).join("\n") + "\n";
  }

  /**
   * 批量处理全部组 × 全部输出。
   * @returns {{entries, successes, failures, manifest}}
   * 单个组/输出失败不影响其他项；文件名冲突自动追加序号，绝不覆盖。
   */
  async function runBatch(project, onProgress) {
    const settings = project.settings;
    const entries = [];
    const usedNames = [];
    const successes = [];
    const failures = [];
    const manifest = {
      generatedAt: new Date().toISOString(),
      settings: JSON.parse(JSON.stringify(settings)),
      outputs: project.outputs.map((o) => ({ name: o.name, filename: o.filename, isNormal: o.isNormal })),
      results: [],
    };

    const groups = project.groups || [];
    let done = 0;
    for (const group of groups) {
      if (!group.files || Object.keys(group.files).length === 0) {
        failures.push({ group: group.name, output: "*", reason: "组内没有任何已识别的贴图文件" });
        manifest.results.push({ group: group.name, output: "*", status: "failed", reason: "空组" });
        continue;
      }
      for (const output of project.outputs) {
        try {
          // 缺来源角色时：默认常量补齐；可在 settings.failOnMissingRole 下改为失败
          const missingRoles = [
            ...new Set(
              output.channels
                .filter((c) => c.source.type === "role" && !group.files[c.source.role])
                .map((c) => c.source.role)
            ),
          ];
          if (settings.failOnMissingRole && missingRoles.length) {
            throw new Error("缺少来源角色: " + missingRoles.map((r) => core.ROLE_LABELS[r] || r).join("、"));
          }
          const composed = imageApi.composeOutput(group, output, settings);
          const pngBytes = await imageApi.encodePNG(composed.imageData);
          const base = core.renderPattern(settings.filenamePattern || "{group}_{output}", group.name, output.filename);
          const pngName = core.uniqueName(base + ".png", usedNames);
          usedNames.push(pngName);
          const txtName = core.uniqueName(base + "_sources.txt", usedNames);
          usedNames.push(txtName);

          entries.push({ name: pngName, bytes: pngBytes });
          entries.push({
            name: txtName,
            bytes: new TextEncoder().encode(buildSidecarText(group, output, composed, settings)),
          });
          const record = {
            group: group.name,
            output: output.name,
            status: "ok",
            file: pngName,
            sidecar: txtName,
            fallbackChannels: composed.notes.filter((n) => n.usedFallback).map((n) => n.channel),
            sizeMismatches: composed.resizeInfos.filter((r) => r.mismatch).length,
          };
          successes.push(record);
          manifest.results.push(record);
        } catch (err) {
          const reason = err && err.message ? err.message : String(err);
          failures.push({ group: group.name, output: output.name, reason });
          manifest.results.push({ group: group.name, output: output.name, status: "failed", reason });
        }
      }
      done++;
      if (onProgress) onProgress(done, groups.length);
    }

    entries.push({
      name: "manifest.json",
      bytes: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });
    return { entries, successes, failures, manifest };
  }

  MT.batch = { serializeProject, rehydrateProject, buildSidecarText, runBatch };
  if (typeof module !== "undefined" && module.exports) module.exports = MT.batch;
})(typeof globalThis !== "undefined" ? globalThis : this);
