/**
 * 来源说明 / 导出清单文本生成。纯字符串处理，可单测。
 */

import { getFitMode, getRole, getSampleMode } from "./constants.js";
import { describeFit } from "./imaging.js";
import { describeChannelSource } from "./batch.js";

/**
 * 单个输出的 .source.txt。
 * @param {{ material:object, output:object, size:object, build:object }} params
 */
export function buildSourceReport({ material, output, size, build, generatedAt = new Date() }) {
  const lines = [];
  lines.push("# 贴图来源说明");
  lines.push("");
  lines.push(`文件: ${output.fileStem || output.name}.png`);
  lines.push(`材质: ${material.name}`);
  lines.push(`输出: ${output.name} (${output.type})`);
  lines.push(`尺寸: ${size.width} × ${size.height}`);
  lines.push(`尺寸策略: ${getFitMode(size.fitMode).label} — ${getFitMode(size.fitMode).description}`);
  lines.push(`法线方向: ${output.convention === "directx" ? "DirectX (-Y 向下)" : "OpenGL (+Y 向上)"}`);
  lines.push(`Alpha: ${output.includeAlpha ? "写入" : "不透明 (255)"}`);
  lines.push(`生成时间: ${generatedAt.toISOString()}`);
  lines.push("");
  lines.push("## 通道映射");
  for (const ch of build.channels) {
    lines.push(`- ${describeChannelSource(ch, ch.id)}`);
    if (ch.sourceKind === "role" && ch.sourceWidth && ch.sourceHeight) {
      lines.push(
        `  - 来源尺寸 ${ch.sourceWidth}×${ch.sourceHeight} → ${describeFit(ch.sourceWidth, ch.sourceHeight, size.width, size.height, size.fitMode)}`,
      );
    }
  }
  lines.push("");
  lines.push("## 提示");
  if (build.warnings.length) {
    for (const w of build.warnings) lines.push(`- ${w}`);
  } else {
    lines.push("- 无");
  }
  lines.push("");
  return lines.join("\n");
}

/** 整个导出批次的 manifest.txt。 */
export function buildManifest({ project, plan, succeeded, failed, skipped, generatedAt = new Date() }) {
  // 计划内跳过的项可能被调用方同时传进 failed/skipped，这里统一去重
  const skippedList = [...(plan.skipped || []), ...(skipped || [])];
  const failedList = [...(failed || []), ...skippedList];
  const seen = new Set();
  const uniqueFailed = [];
  for (const item of failedList) {
    const key = `${item.materialId || ""}|${item.outputId || ""}|${item.error || item.reason || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueFailed.push(item);
  }

  const lines = [];
  lines.push("# 材质贴图导出清单");
  lines.push("");
  lines.push(`工程: ${project.name}`);
  lines.push(`生成时间: ${generatedAt.toISOString()}`);
  lines.push(`成功: ${succeeded.length}  失败/跳过: ${uniqueFailed.length}`);
  lines.push("");
  lines.push("## 成功");
  if (succeeded.length === 0) lines.push("- (无)");
  for (const item of succeeded) {
    lines.push(`- ${item.zipPath}  ${item.width}×${item.height}  [${item.materialName} / ${item.outputName}]`);
    for (const src of item.sources || []) {
      lines.push(`  - ${describeChannelSource(src, src.id)}`);
    }
    if (item.reportPath) lines.push(`  - 说明文件: ${item.reportPath}`);
  }
  lines.push("");
  lines.push("## 失败 / 跳过");
  if (uniqueFailed.length === 0) lines.push("- (无)");
  for (const item of uniqueFailed) {
    lines.push(`- [${item.materialName} / ${item.outputName || "(输出)"}] ${item.error || item.reason}`);
  }
  lines.push("");
  lines.push("## 命名冲突处理");
  const renames = (plan.warnings || []).filter((w) => w.includes("重名"));
  if (renames.length === 0) lines.push("- 无重名");
  for (const w of renames) lines.push(`- ${w}`);
  lines.push("");
  return lines.join("\n");
}

/** 导出前预览：把某个输出的通道映射读成一句人话。 */
export function summarizeOutput(material, output) {
  const parts = [];
  for (const id of ["r", "g", "b", "a"]) {
    const c = output.channels[id];
    if (!c) continue;
    if (c.source?.kind === "role") {
      const role = getRole(c.source.role);
      parts.push(`${id.toUpperCase()}←${role.label}(${getSampleMode(c.sample).short}${c.invert ? ",反相" : ""})`);
    } else {
      parts.push(`${id.toUpperCase()}=${c.constant}`);
    }
  }
  return parts.join(" ");
}
