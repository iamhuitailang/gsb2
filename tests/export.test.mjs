import assert from 'node:assert/strict';
import test from 'node:test';

import { createZip } from '../src/zip.js';
import { crc32 } from '../src/png.js';
import { SAMPLE_SCENES, buildSampleProject, drawScene } from '../src/samples.js';
import { createCanvasBuffer } from '../src/paint.js';
import { buildExport, parseDraft, serializeDraft } from '../src/model.js';
import { rasterizeImageMask } from '../src/raster.js';

const sampleIds = {
  label: (key) => `lbl_sample_${key}`,
  image: (sceneId) => `img_sample_${sceneId.replace(/^sample-/, '')}`,
  annotation: (sceneId, index) => `ann_sample_${sceneId.replace(/^sample-/, '')}_${index}`,
};

/** 解析 ZIP 中央目录，返回文件条目（仅支持本项目的 stored 模式）。 */
function readZip(bytes) {
  const buffer = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, '缺少 EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  assert.equal(buffer.readUInt16LE(eocd + 8), count);
  assert.equal(centralOffset + centralSize, eocd);

  const files = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名');
    const crc = buffer.readUInt32LE(offset + 16);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, '本地文件签名');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + size);
    files.push({ name, crc, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

test('ZIP 打包：条目完整、CRC 正确、中文文件名可还原', () => {
  const a = new TextEncoder().encode('hello');
  const b = new TextEncoder().encode('{"name":"测试"}');
  const zip = createZip([
    { name: 'annotations.json', data: b },
    { name: 'masks/街景.mask.png', data: a },
  ], new Date('2026-01-02T03:04:05'));
  const files = readZip(zip);
  assert.deepEqual(files.map((file) => file.name), ['annotations.json', 'masks/街景.mask.png']);
  assert.equal(new TextDecoder().decode(files[0].data), '{"name":"测试"}');
  assert.equal(new TextDecoder().decode(files[1].data), 'hello');
  assert.equal(files[0].crc, crc32(new TextEncoder().encode('{"name":"测试"}')));
  assert.equal(files[1].crc, crc32(a));
});

test('示例场景非空且尺寸正确', () => {
  assert.equal(SAMPLE_SCENES.length, 3);
  for (const scene of SAMPLE_SCENES) {
    const buffer = drawScene(scene, createCanvasBuffer);
    assert.equal(buffer.width, scene.width);
    assert.equal(buffer.height, scene.height);
    const distinct = new Set();
    for (let i = 0; i < buffer.rgba.length; i += 4 * 97) {
      distinct.add(`${buffer.rgba[i]},${buffer.rgba[i + 1]},${buffer.rgba[i + 2]}`);
    }
    assert.ok(distinct.size > 20, `${scene.name} 颜色过于单一`);
    assert.ok(scene.annotations.length >= 8, `${scene.name} 标注过少`);
  }
});

test('示例项目含多边形、矩形、重叠区域和隐藏/锁定状态', () => {
  const project = buildSampleProject(sampleIds);
  const all = project.images.flatMap((image) => image.annotations);
  assert.ok(all.some((a) => a.type === 'polygon'));
  assert.ok(all.some((a) => a.type === 'rect'));
  assert.ok(all.some((a) => a.hidden));
  assert.ok(all.some((a) => a.locked));
  // 至少一张图内存在重叠：矩形/多边形包围盒相交
  const boxes = project.images[0].annotations.map((annotation) => {
    if (annotation.type === 'rect') return annotation.rect;
    const xs = annotation.points.map((p) => p[0]);
    const ys = annotation.points.map((p) => p[1]);
    return {
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  });
  let overlaps = 0;
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && b.x < a.x + a.width
        && a.y < b.y + b.height && b.y < a.y + a.height) overlaps += 1;
    }
  }
  assert.ok(overlaps > 0, '示例应包含重叠区域');
});

test('示例导出包含图像尺寸、类别映射与掩码路径', () => {
  const project = buildSampleProject(sampleIds);
  const exported = buildExport(project, { exportedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(exported.format, 'local-image-annotator/annotations');
  assert.equal(exported.categories.length, project.labels.length);
  exported.categories.forEach((category, index) => {
    assert.equal(category.index, index + 1);
  });
  for (const image of exported.images) {
    assert.ok(image.width > 0 && image.height > 0);
    assert.match(image.mask, /^masks\/.+\.mask\.png$/);
    for (const annotation of image.annotations) {
      assert.ok(annotation.categoryIndex >= 1);
      assert.ok(['rect', 'polygon'].includes(annotation.type));
      const [x, y, w, h] = annotation.bbox;
      assert.ok(x >= 0 && y >= 0);
      assert.ok(x + w <= image.width + 1e-6);
      assert.ok(y + h <= image.height + 1e-6);
      if (annotation.type === 'rect') {
        assert.equal(annotation.points.length, 4);
      }
    }
  }
  // 隐藏标注不出现在导出里
  const hiddenCount = project.images
    .flatMap((image) => image.annotations)
    .filter((annotation) => annotation.hidden).length;
  assert.ok(hiddenCount > 0);
  assert.equal(
    exported.annotationCount,
    project.images.flatMap((image) => image.annotations).length - hiddenCount,
  );
});

test('示例草稿可完整往返，掩码尺寸与图像一致', () => {
  const project = buildSampleProject(sampleIds);
  const restored = parseDraft(JSON.parse(JSON.stringify(serializeDraft(project))));
  assert.deepEqual(
    restored.images.map((image) => [image.name, image.width, image.height]),
    project.images.map((image) => [image.name, image.width, image.height]),
  );
  for (const image of restored.images) {
    const mask = rasterizeImageMask(image, restored.labels);
    assert.equal(mask.width, image.width);
    assert.equal(mask.height, image.height);
    assert.equal(mask.data.length, image.width * image.height);
    for (const annotation of image.annotations) {
      for (const [x, y] of annotation.type === 'polygon'
        ? annotation.points
        : [[annotation.rect.x, annotation.rect.y]]) {
        assert.ok(x >= 0 && x <= image.width);
        assert.ok(y >= 0 && y <= image.height);
      }
    }
  }
});
