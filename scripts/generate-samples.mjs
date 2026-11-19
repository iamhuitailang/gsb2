#!/usr/bin/env node
/**
 * 生成可直接查看的本地示例素材（不依赖浏览器）：
 *   samples/images/*.png        示例原图（与画布内示例完全一致）
 *   samples/sample-draft.json   可直接“打开草稿”的示例项目
 *   samples/annotations.json    导出格式示例（含 categories 映射）
 *   samples/masks/*.mask.png    单通道类别索引掩码
 *   samples/preview/*.png       彩色掩码预览（便于肉眼检查）
 *   samples/source-label-map.csv
 *
 * 用法：npm run generate:samples
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { createCanvasBuffer } from '../src/paint.js';
import { SAMPLE_SCENES, buildSampleProject, drawScene } from '../src/samples.js';
import { buildExport, serializeDraft, parseDraft } from '../src/model.js';
import { maskToPreviewRGBA, rasterizeImageMask } from '../src/raster.js';
import { encodePng } from '../src/png.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'samples');

/** 使用 Node 的 zlib 真压缩，生成文件体积正常。 */
function encodeCompressedPng(size, pixels, colorType = 0) {
  return encodePng(size, pixels, {
    colorType,
    deflate: (raw) => new Uint8Array(deflateSync(raw)),
  });
}

async function writeFileAt(relativePath, data) {
  const target = join(OUT, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

async function main() {
  const sampleIds = {
    label: (key) => `lbl_sample_${key}`,
    image: (sceneId) => `img_sample_${sceneId.replace(/^sample-/, '')}`,
    annotation: (sceneId, index) => `ann_sample_${sceneId.replace(/^sample-/, '')}_${index}`,
  };
  const project = buildSampleProject(sampleIds);

  // 自检：项目能通过草稿解析，说明示例数据本身合法
  const roundTrip = parseDraft(serializeDraft(project));
  if (roundTrip.images.length !== project.images.length) {
    throw new Error('示例项目序列化后图片数量不一致');
  }
  for (const image of project.images) {
    const parsed = roundTrip.images.find((item) => item.name === image.name);
    if (!parsed || parsed.annotations.length !== image.annotations.length) {
      throw new Error(`示例项目序列化后标注不一致：${image.name}`);
    }
  }

  const results = [];
  for (const scene of SAMPLE_SCENES) {
    const buffer = drawScene(scene, createCanvasBuffer);
    const png = encodeCompressedPng(
      { width: buffer.width, height: buffer.height },
      buffer.rgba,
      6,
    );
    const path = await writeFileAt(join('images', scene.name), png);
    results.push({ kind: 'image', path, bytes: png.length });
  }

  const draft = serializeDraft(project);
  const draftBytes = Buffer.from(`${JSON.stringify(draft, null, 2)}\n`, 'utf8');
  results.push({ kind: 'draft', path: await writeFileAt('sample-draft.json', draftBytes), bytes: draftBytes.length });

  const exported = buildExport(project, { exportedAt: '2026-01-01T00:00:00.000Z' });
  const exportBytes = Buffer.from(`${JSON.stringify(exported, null, 2)}\n`, 'utf8');
  results.push({ kind: 'annotations', path: await writeFileAt('annotations.json', exportBytes), bytes: exportBytes.length });

  const labels = project.labels;
  const csv = ['index,name,color', ...labels.map((label, i) => `${i + 1},"${label.name}",${label.color}`)];
  results.push({
    kind: 'csv',
    path: await writeFileAt('source-label-map.csv', Buffer.from(`${csv.join('\n')}\n`, 'utf8')),
  });

  for (const [index, image] of project.images.entries()) {
    const mask = rasterizeImageMask(image, labels);
    const maskPng = encodeCompressedPng(mask, mask.data, 0);
    const relativeMask = exported.images[index].mask.replace(/^masks\//, '');
    const maskPath = await writeFileAt(join('masks', relativeMask), maskPng);
    const previewPng = encodeCompressedPng(mask, maskToPreviewRGBA(mask, labels), 6);
    const previewPath = await writeFileAt(join('preview', relativeMask), previewPng);
    results.push({ kind: 'mask', path: maskPath, bytes: maskPng.length });
    results.push({ kind: 'preview', path: previewPath, bytes: previewPng.length });
  }

  let total = 0;
  for (const result of results) {
    total += result.bytes ?? 0;
    const relative = result.path.slice(ROOT.length + 1);
    console.log(`  ${relative}${result.bytes ? `  ${(result.bytes / 1024).toFixed(1)} KB` : ''}`);
  }
  console.log(`\n共 ${results.length} 个文件，${(total / 1024).toFixed(1)} KB，输出目录：samples/`);
  console.log(`示例标注：${exported.annotationCount} 个 / ${exported.imageCount} 张图片；类别：${exported.categories.map((c) => `${c.index}=${c.name}`).join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
