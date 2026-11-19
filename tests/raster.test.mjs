import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
import test from 'node:test';

import { addAnnotation, addImage, addLabel, buildExport, createProject } from '../src/model.js';
import { fillPolygonIndex, fillRectIndex, rasterizeImageMask, createMaskBuffer } from '../src/raster.js';
import { encodePng, zlibStore, adler32, crc32, encodePngAsync } from '../src/png.js';

/** 解析 PNG，返回 {width,height,data(RGBA 或灰度)}；用于验证编码正确性。 */
function decodePng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert.deepEqual([...bytes.slice(0, 8)], signature);
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const data = bytes.slice(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const compressed = Buffer.concat(idat.map((chunk) => Buffer.from(chunk)));
  const raw = inflateSync(compressed);
  const channels = colorType === 6 ? 4 : 1;
  const stride = width * channels + 1;
  const pixels = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * stride], 0, '仅使用 filter 0');
    pixels.set(raw.slice(y * stride + 1, (y + 1) * stride), y * width * channels);
  }
  return { width, height, colorType, pixels };
}

test('crc32 / adler32 与标准值一致', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
});

test('PNG 编码可被标准 zlib 解码，且像素一致', () => {
  const width = 6;
  const height = 4;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i += 1) data[i] = i % 7;
  const png = encodePng({ width, height }, data, { colorType: 0 });
  const decoded = decodePng(png);
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual([...decoded.pixels], [...data]);
});

test('stored 模式与异步模式都能生成合法 PNG', async () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const stored = encodePng({ width: 2, height: 2 }, data);
  assert.deepEqual([...decodePng(stored).pixels], [1, 2, 3, 4]);
  const zg = zlibStore(data);
  assert.equal(zg[0], 0x78);
  assert.equal(inflateSync(Buffer.from(zg)).toString('hex'), '01020304');

  const asyncPng = await encodePngAsync({ width: 2, height: 2 }, data, 0);
  assert.deepEqual([...decodePng(asyncPng).pixels], [1, 2, 3, 4]);
});

test('矩形填充使用像素中心采样，边界与半开区间一致', () => {
  const buffer = createMaskBuffer(10, 10);
  fillRectIndex(buffer, { x: 2, y: 3, width: 4, height: 3 }, 2);
  const at = (x, y) => buffer.data[y * buffer.width + x];
  assert.equal(at(2, 3), 2);
  assert.equal(at(5, 5), 2);
  assert.equal(at(6, 5), 0);
  assert.equal(at(5, 6), 0);
  assert.equal(at(1, 3), 0);
});

test('多边形扫描线填充：内部为类别索引，外部为 0', () => {
  const buffer = createMaskBuffer(20, 20);
  fillPolygonIndex(buffer, [[5, 5], [15, 5], [15, 15], [5, 15]], 3);
  const at = (x, y) => buffer.data[y * buffer.width + x];
  assert.equal(at(10, 10), 3);
  assert.equal(at(5, 5), 3);
  assert.equal(at(14, 14), 3);
  assert.equal(at(4, 10), 0);
  assert.equal(at(15, 10), 0);
});

test('掩码：重叠时后绘制的覆盖先绘制的；隐藏不参与；类别索引与导出映射一致', () => {
  let project = createProject();
  project = addLabel(project, '背景物').project;
  project = addLabel(project, '前景物').project;
  project = addImage(project, { id: 'img', name: 'x.png', width: 32, height: 32 });
  const [bgLabel, fgLabel] = project.labels;
  project = addAnnotation(project, 'img', {
    type: 'rect', labelId: bgLabel.id, rect: { x: 0, y: 0, width: 32, height: 32 },
  }).project;
  project = addAnnotation(project, 'img', {
    type: 'polygon', labelId: fgLabel.id, points: [[8, 8], [24, 8], [24, 24], [8, 24]],
  }).project;
  project = addAnnotation(project, 'img', {
    type: 'rect', labelId: fgLabel.id, rect: { x: 0, y: 0, width: 4, height: 4 },
  }).project;
  const hiddenId = project.images[0].annotations[2].id;
  project = {
    ...project,
    images: [{
      ...project.images[0],
      annotations: project.images[0].annotations.map((annotation) => (
        annotation.id === hiddenId ? { ...annotation, hidden: true } : annotation
      )),
    }],
  };

  const mask = rasterizeImageMask(project.images[0], project.labels);
  const at = (x, y) => mask.data[y * mask.width + x];
  assert.equal(at(16, 16), 2, '前景覆盖背景');
  assert.equal(at(1, 1), 1, '隐藏标注不绘制');
  assert.equal(at(30, 30), 1);

  const exported = buildExport(project);
  const indices = new Map(exported.categories.map((c) => [c.id, c.index]));
  assert.equal(indices.get(bgLabel.id), 1);
  assert.equal(indices.get(fgLabel.id), 2);
  assert.equal(mask.categories[0].index, 1);
});

test('生成的 mask PNG 可以用 Python PIL 读取（若环境可用）', (t) => {
  let project = createProject();
  project = addLabel(project, '类别一').project;
  project = addImage(project, { id: 'img', name: 'm.png', width: 16, height: 8 });
  project = addAnnotation(project, 'img', {
    type: 'rect', labelId: project.labels[0].id, rect: { x: 4, y: 2, width: 8, height: 4 },
  }).project;
  const mask = rasterizeImageMask(project.images[0], project.labels);
  const png = encodePng(mask, mask.data, {
    colorType: 0,
    deflate: (raw) => new Uint8Array(deflateSync(raw)),
  });
  assert.equal(decodePng(png).pixels[2 * 16 + 5], 1);

  const python = (() => {
    try {
      execFileSync('python3', ['-I', '-c', 'import PIL'], { stdio: 'ignore' });
      return 'python3';
    } catch {
      return null;
    }
  })();
  if (!python) {
    t.skip('PIL 不可用');
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'mask-'));
  const file = join(dir, 'mask.png');
  writeFileSync(file, png);
  const output = execFileSync(python, ['-I', '-c', [
    'import sys, json',
    'from PIL import Image',
    'im = Image.open(sys.argv[1])',
    'print(json.dumps({"mode": im.mode, "size": im.size, "values": sorted(set(im.getdata()))}))',
  ].join('\n'), file]).toString();
  const info = JSON.parse(output);
  assert.equal(info.mode, 'L');
  assert.deepEqual(info.size, [16, 8]);
  assert.deepEqual(info.values, [0, 1]);
});
