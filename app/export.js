import { buildReportData, reportToHtml, reportToMarkdown, resultsToJson, reportFileName } from '../src/core/report.js';
import { renderComparisonImage, renderWorldThumbnail } from '../src/core/world.js';
import { canvasToBlob } from '../src/core/images.js';
import { safeFileStem } from '../src/core/format.js';
import { createZip } from './zip.js';

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function fileNameFor(pair, suffix, ext = 'png') {
  const stem = safeFileStem(
    `${String(pair.name || 'pair').replace(/\s+/g, '-')}`,
    'pair',
  );
  return `${String(pair.index).padStart(2, '0')}-${stem}-${suffix}.${ext}`;
}

export async function exportResults({ store, options, diffService }) {
  const project = store.project;
  const pairs = project.pairs;
  const name = safeFileStem(options.name || project.name || 'verso', 'verso');
  const files = [];
  const assetsByPair = {};
  const pairResults = new Map();

  for (const pair of pairs) {
    const imageA = store.imageRecord(pair.a.imageId);
    const imageB = store.imageRecord(pair.b.imageId);
    if (!imageA || !imageB) continue;
    let result = store.getDiff(pair.id);
    if (!result) {
      result = await diffService.compute({
        pairId: pair.id,
        imgA: imageA.img,
        imgB: imageB.img,
        alignment: pair.alignment,
        settings: pair.diffSettings,
        strokes: pair.ignoreStrokes,
        strokesRevision: pair.ignoreRevision,
      });
      if (result) store.setDiff(pair.id, result);
    }
    if (result) pairResults.set(pair.id, result);

    const assets = {};
    const pairIndex = pairs.indexOf(pair) + 1;
    if (options.diffImages && result) {
      const canvas = document.createElement('canvas');
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      ctx.putImageData(
        new ImageData(result.compositePixels.slice(), result.width, result.height),
        0,
        0,
      );
      const blob = await canvasToBlob(canvas);
      const fname = fileNameFor({ ...pair, index: pairIndex }, 'diff');
      files.push({ name: `差异图/${fname}`, data: new Uint8Array(await blob.arrayBuffer()) });
      assets.diff = canvas.toDataURL('image/png', 0.92);
    }

    if (options.overlays) {
      const canvas = renderComparisonImage({
        imgA: imageA.img,
        imgB: imageB.img,
        alignment: pair.alignment,
        mode: 'overlay',
        opacity: 0.55,
      });
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      const fname = fileNameFor({ ...pair, index: pairIndex }, 'overlay', 'jpg');
      files.push({ name: `叠加图/${fname}`, data: new Uint8Array(await blob.arrayBuffer()) });
      assets.overlay = canvas.toDataURL('image/jpeg', 0.85);
    }

    if (options.reportHtml && (options.overlays || options.diffImages)) {
      const thumbA = renderWorldThumbnail({
        imgA: imageA.img,
        imgB: imageB.img,
        alignment: pair.alignment,
        which: 'a',
        maxSide: 640,
      });
      const thumbB = renderWorldThumbnail({
        imgA: imageA.img,
        imgB: imageB.img,
        alignment: pair.alignment,
        which: 'b',
        maxSide: 640,
      });
      assets.a = thumbA.toDataURL('image/jpeg', 0.84);
      assets.b = thumbB.toDataURL('image/jpeg', 0.84);
    }

    assetsByPair[pair.id] = assets;
  }

  const reportData = buildReportData({
    project,
    pairResults,
    assets: assetsByPair,
    generatedAt: new Date().toISOString(),
  });

  if (options.reportHtml) {
    const html = reportToHtml(reportData);
    files.push({ name: `报告/${reportFileName(project.name)}.html`, data: html });
  }
  if (options.reportMarkdown) {
    const md = reportToMarkdown(reportData);
    files.push({ name: `报告/${reportFileName(project.name)}.md`, data: md });
  }
  if (options.reportJson) {
    const json = resultsToJson(reportData);
    files.push({ name: `报告/${reportFileName(project.name)}.json`, data: json });
  }
  if (options.projectFile) {
    const payload = await store.exportProjectPayload();
    files.push({
      name: `${name}.verso.json`,
      data: JSON.stringify(payload, null, 2),
    });
  }

  if (!files.length) {
    throw new Error('没有选择任何导出内容');
  }

  const readme = buildExportReadme({
    name,
    options,
    reportData,
  });
  files.unshift({ name: 'README.txt', data: readme });

  const zip = createZip(files);
  downloadBlob(zip, `${name}.zip`);
  return { fileCount: files.length, reportData };
}

function buildExportReadme({ name, options, reportData }) {
  const lines = [
    `${name} · 版本对比导出包`,
    `生成时间：${reportData.generatedAt}`,
    '',
    '目录说明：',
    options.diffImages
      ? '  差异图/  — 每组一张差异高亮 PNG（红色=颜色差异，琥珀色=仅一侧内容，青绿色网纹=已忽略区域）。'
      : null,
    options.overlays
      ? '  叠加图/  — B 图以 55% 不透明度叠在 A 图之上的预览。'
      : null,
    options.reportHtml
      ? '  报告/*.html — 可直接用浏览器打开或打印为 PDF，内嵌 A/B/差异/叠加缩略图。'
      : null,
    options.reportMarkdown
      ? '  报告/*.md — 纯文本报告，便于粘贴到工单或代码库。'
      : null,
    options.reportJson
      ? '  报告/*.json — 结构化数据，包含每组的区域坐标与统计（无内嵌图片）。'
      : null,
    options.projectFile
      ? '  *.verso.json — 项目文件，可在工作台中重新导入继续检查。'
      : null,
    '',
    '报告包含：',
    '  - 项目概要：对比组数、图片数、累计差异面积、变化区域总数、检查状态统计。',
    '  - 每组对比：A/B 名称与版本、像素尺寸、对齐方式及平移/缩放/旋转参数、角点拟合误差。',
    '  - 差异设置：敏感度、对应阈值、最小区域面积、是否检测新增/移除。',
    '  - 差异统计：重叠面积、差异面积及占比、区域数量、忽略区面积与笔画数。',
    '  - 变化区域表：按面积排序的序号、类型、面积 px²、包围盒与中心坐标。',
    '  - 检查备注与检查状态。',
    '',
    '说明：',
    '  - 所有对比均在本机浏览器内完成，未上传任何图片。',
    '  - 差异统计基于对齐后的重叠区域；忽略区域不会计入差异，原始图片字节未被修改。',
    '  - 敏感度与最小区域设置按组保存在项目文件中。',
  ].filter(Boolean);
  return lines.join('\n');
}

export function projectFileName(project) {
  return `${safeFileStem(project.name || 'verso-project', 'verso-project')}.verso.json`;
}

export async function exportProjectFile(store) {
  const payload = await store.exportProjectPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, projectFileName(store.project));
}

export async function exportSingleReport(store, diffService) {
  return exportResults({
    store,
    diffService,
    options: {
      diffImages: true,
      overlays: true,
      reportHtml: true,
      reportMarkdown: false,
      reportJson: false,
      projectFile: false,
      name: store.project.name,
    },
  });
}
