/**
 * 批量导出计划：命名去重、逐项结果、失败原因、来源说明。
 *
 * 核心约束：不同材质 / 不同输出的同名文件不能互相覆盖。
 * 策略：先按「材质目录 + 输出文件名」分配，若同一材质目录下重名，
 * 再依次追加输出类型短名、输出序号，绝不静默覆盖。
 */

import { getOutputType, getRole } from "./constants.js";
import { resolveOutputSize } from "./project.js";

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 安全化文件/目录名片段。保留中英文、数字、空格、- _ .。 */
export function sanitizeName(name, fallback = "unnamed") {
  let value = String(name ?? "")
    .replace(ILLEGAL, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (!value) value = fallback;
  if (RESERVED.test(value)) value = `_${value}`;
  return value.slice(0, 96);
}

/** 唯一化：碰撞时追加 -2、-3 ... */
export function uniqueName(desired, used, caseInsensitive = true) {
  const keyOf = (s) => (caseInsensitive ? s.toLowerCase() : s);
  if (!used.has(keyOf(desired))) {
    used.add(keyOf(desired));
    return desired;
  }
  const dot = desired.lastIndexOf(".");
  const stem = dot > 0 ? desired.slice(0, dot) : desired;
  const ext = dot > 0 ? desired.slice(dot) : "";
  let n = 2;
  while (used.has(keyOf(`${stem}-${n}${ext}`))) n++;
  const final = `${stem}-${n}${ext}`;
  used.add(keyOf(final));
  return final;
}

/** 材质在导出包内的目录名。同名材质追加序号（大小写不敏感，兼容 macOS / Windows）。 */
export function assignMaterialFolders(materials) {
  const used = new Set();
  const map = new Map();
  materials.forEach((m, index) => {
    const base = sanitizeName(m.name, `material-${index + 1}`);
    map.set(m.id, uniqueName(base, used, true));
  });
  return map;
}

/**
 * 生成导出计划。
 * @param {object} project
 * @param {{format?:string}} [options]
 * @returns {{items:object[], skipped:object[], warnings:string[]}}
 */
export function buildExportPlan(project, options = {}) {
  const { format = "png" } = options;
  const folders = assignMaterialFolders(project.materials);
  const items = [];
  const skipped = [];
  const warnings = [];

  const globalNames = new Set();
  let index = 0;

  for (const material of project.materials) {
    const folder = folders.get(material.id);
    const usedInFolder = new Set();
    const enabled = material.outputs.filter((o) => o.enabled !== false);

    if (enabled.length === 0) {
      warnings.push(`材质「${material.name}」没有启用的输出，已跳过`);
      continue;
    }

    for (const output of enabled) {
      index += 1;
      const size = resolveOutputSize(material, output);
      const errors = [];
      if (!Number.isInteger(size.width) || size.width < 1 || size.width > 8192) {
        errors.push(`宽度 ${size.width} 无效（需 1~8192）`);
      }
      if (!Number.isInteger(size.height) || size.height < 1 || size.height > 8192) {
        errors.push(`高度 ${size.height} 无效（需 1~8192）`);
      }
      if (errors.length) {
        // 跳过项不占用文件名，避免把后面有效输出挤成 -2
        skipped.push({
          kind: "output",
          materialId: material.id,
          materialName: material.name,
          outputId: output.id,
          outputName: output.name,
          reason: errors.join("；"),
        });
        continue;
      }

      const baseName = sanitizeName(output.name, `${getOutputType(output.type).short}_${index}`);
      let fileStem = baseName;
      if (usedInFolder.has(fileStem.toLowerCase())) {
        const withType = `${baseName}_${getOutputType(output.type).short}`;
        fileStem = withType;
        warnings.push(
          `材质「${material.name}」内输出「${output.name}」重名，已改用「${withType}」避免覆盖`,
        );
      }
      fileStem = uniqueName(fileStem, usedInFolder);

      const fileCandidate = `${fileStem}.${format}`;
      const zipPath = uniqueName(`${folder}/${fileCandidate}`, globalNames);

      items.push({
        index,
        materialId: material.id,
        materialName: material.name,
        folder,
        outputId: output.id,
        outputName: output.name,
        outputType: getOutputType(output.type).id,
        type: getOutputType(output.type).id,
        width: size.width,
        height: size.height,
        fitMode: size.fitMode,
        convention: output.convention,
        includeAlpha: output.includeAlpha,
        channels: output.channels,
        fileStem,
        fileName: fileCandidate,
        zipPath,
        reportPath: `${folder}/${fileStem}.source.txt`,
        status: "pending",
        error: null,
        warnings: [],
      });
    }
  }

  return { items, skipped, warnings, folders };
}

/**
 * 执行导出计划。runner 负责真正的渲染 + 编码：
 *   runner(item) => Promise<{ png: Uint8Array, sources: object[], warnings: string[] }>
 * 单项失败只记入该项，不影响其它项；成功项保留。
 */
export async function runExportPlan(plan, runner, options = {}) {
  const { onProgress = () => {}, onItem = () => {} } = options;
  const results = [];
  const succeeded = [];
  const failed = [];
  const reports = [];

  let done = 0;
  for (const item of plan.items) {
    try {
      onProgress({ phase: "start", done, total: plan.items.length, item });
      const rendered = await runner(item);
      item.status = "ok";
      item.error = null;
      item.warnings = rendered.warnings || [];
      item.png = rendered.png;
      item.byteLength = rendered.png?.byteLength || rendered.png?.length || 0;
      item.sources = rendered.sources || [];
      item.reportText = rendered.reportText || "";
      succeeded.push(item);
      if (item.reportPath) {
        reports.push({
          name: item.reportPath,
          data: new TextEncoder().encode(item.reportText),
        });
      }
      results.push({ ok: true, item });
      onItem({ ok: true, item });
    } catch (err) {
      item.status = "failed";
      item.error = err?.message || String(err);
      failed.push(item);
      results.push({ ok: false, item, error: item.error });
      onItem({ ok: false, item, error: item.error });
    }
    done += 1;
    onProgress({ phase: "item", done, total: plan.items.length, item });
  }

  return { results, succeeded, failed, reports, skipped: plan.skipped };
}

/** 供 UI 与文本报告共用的逐通道来源行。 */
export function describeChannelSource(channelStat, channelId) {
  const id = channelId.toUpperCase();
  if (channelStat.usedConstant) {
    let why;
    if (channelStat.decodeFailed) {
      why = `解码失败${channelStat.sourceError ? `（${channelStat.sourceError}）` : ""}，用常量补齐`;
    } else if (channelStat.missingSource) {
      why = `缺少来源${channelStat.sourceError ? `（${channelStat.sourceError}）` : ""}，用常量补齐`;
    } else {
      why = "常量填充";
    }
    return `${id}: ${why} = ${channelStat.constant} (${(channelStat.constant / 255).toFixed(3)})`;
  }
  const role = getRole(channelStat.role).label;
  const parts = [
    `${id}: ${role} ${channelStat.sourceFileName || "(未命名)"} · 取 ${channelStat.sampleLabel}`,
  ];
  if (channelStat.invert) parts.push("反相");
  if (Number(channelStat.strength) !== 1) parts.push(`强度 ×${channelStat.strength}`);
  parts.push(`范围 ${channelStat.min}~${channelStat.max}，均值 ${channelStat.mean}`);
  return parts.join(" · ");
}