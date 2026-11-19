import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeGif, gifTimingReport } from '../src/core/gif.js';
import { createMosslingProject } from '../src/samples/mossling.js';
import {
  compositeFrame,
  createProject,
  setFrameDuration,
  totalLoopDuration,
  insertFrame,
} from '../src/core/project.js';
import { colorFromHex, getPixel, setPixel } from '../src/core/raster.js';
import { buildSpriteSheet, spriteSheetMetadata } from '../src/core/spritesheet.js';
import { parseGif, gifFrameToRgba } from './lib/gif-decode.mjs';

function fillFrame(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = color[3];
  }
  return data;
}

test('GIF 编码器输出可被独立解码器还原：尺寸、帧数与时长', () => {
  const width = 6;
  const height = 5;
  const frames = [
    { data: fillFrame(width, height, [255, 0, 0, 255]), duration: 120 },
    { data: fillFrame(width, height, [0, 128, 255, 255]), duration: 330 },
    { data: fillFrame(width, height, [0, 0, 0, 0]), duration: 80 },
  ];
  const gif = encodeGif({ width, height, frames, loop: true });
  const parsed = parseGif(gif);
  assert.equal(parsed.signature, 'GIF89a');
  assert.equal(parsed.width, width);
  assert.equal(parsed.height, height);
  assert.equal(parsed.frames.length, 3);
  assert.equal(parsed.loopCount, 0, 'NETSCAPE 循环次数 0 表示无限循环');
  assert.deepEqual(
    parsed.frames.map((f) => f.gce.delay * 10),
    [120, 330, 80],
  );
  assert.deepEqual(
    parsed.frames.map((f) => f.gce.disposal),
    [2, 2, 2],
    '每帧使用还原背景，避免透明区域残留',
  );
  const red = gifFrameToRgba(parsed.frames[0]);
  assert.deepEqual(getPixel(red, width, height, 0, 0), [255, 0, 0, 255]);
  const blue = gifFrameToRgba(parsed.frames[1]);
  assert.deepEqual(getPixel(blue, width, height, 5, 4), [0, 128, 255, 255]);
  const empty = gifFrameToRgba(parsed.frames[2]);
  assert.equal(getPixel(empty, width, height, 2, 2)[3], 0, '透明帧应保持透明');
});

test('GIF 保留透明背景与局部像素位置', () => {
  const width = 8;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  setPixel(data, width, height, 1, 2, colorFromHex('#00ff00'));
  setPixel(data, width, height, 7, 7, colorFromHex('#ff0000'));
  const gif = encodeGif({ width, height, frames: [{ data, duration: 100 }] });
  const parsed = parseGif(gif);
  const rgba = gifFrameToRgba(parsed.frames[0]);
  assert.deepEqual(getPixel(rgba, width, height, 1, 2), [0, 255, 0, 255]);
  assert.deepEqual(getPixel(rgba, width, height, 7, 7), [255, 0, 0, 255]);
  assert.equal(getPixel(rgba, width, height, 0, 0)[3], 0);
  assert.equal(getPixel(rgba, width, height, 4, 4)[3], 0);
});

test('GIF 时长量化提示', () => {
  const report = gifTimingReport([{ duration: 124 }, { duration: 100 }, { duration: 5 }]);
  assert.equal(report[0].clipped, true);
  assert.equal(report[0].actualMs, 120);
  assert.equal(report[1].clipped, false);
  assert.equal(report[2].actualMs, 10, '小于 10ms 的帧至少按 10ms 编码');
});

test('GIF 帧数较多时使用量化调色板且仍可解码', () => {
  const width = 24;
  const height = 24;
  const frames = [];
  for (let f = 0; f < 6; f += 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        data[i] = (x * 10 + f * 20) % 256;
        data[i + 1] = (y * 9 + f * 7) % 256;
        data[i + 2] = (x * y + f * 30) % 256;
        data[i + 3] = 255;
      }
    }
    frames.push({ data, duration: 90 + f * 10 });
  }
  const gif = encodeGif({ width, height, frames });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 6);
  assert.ok(parsed.frames[0].colorTable.length <= 256);
  const rgba = gifFrameToRgba(parsed.frames[0]);
  // 量化后颜色可能略有偏差，但不应该全透明
  assert.equal(rgba[3], 255);
});

test('样例工程：8 帧非等时长，导出 GIF 的时长与工程一致', () => {
  const project = createMosslingProject();
  assert.equal(project.frames.length, 8);
  const durations = project.frames.map((f) => f.duration);
  assert.ok(new Set(durations).size > 1, '样例应包含非等时长帧');
  const total = totalLoopDuration(project);

  const frames = project.frames.map((frame) => ({
    data: compositeFrame(project, frame),
    duration: frame.duration,
  }));
  const gif = encodeGif({ width: project.width, height: project.height, frames });
  const parsed = parseGif(gif);
  assert.equal(parsed.frames.length, 8);
  assert.equal(
    parsed.frames.reduce((sum, f) => sum + f.gce.delay * 10, 0),
    total,
  );
  // 样例有透明背景（4 个角都没有像素）
  const first = gifFrameToRgba(parsed.frames[0]);
  assert.equal(getPixel(first, project.width, project.height, 0, 0)[3], 0);
});

test('导出 GIF 排除隐藏图层', () => {
  const project = createProject({ width: 6, height: 6 });
  const layer = project.layers[0];
  setPixel(project.frames[0].cels[layer.id], 6, 6, 1, 1, colorFromHex('#ff0000'));
  const dataVisible = compositeFrame(project, project.frames[0]);
  layer.visible = false;
  const dataHidden = compositeFrame(project, project.frames[0]);

  const gifVisible = encodeGif({ width: 6, height: 6, frames: [{ data: dataVisible, duration: 100 }] });
  const gifHidden = encodeGif({ width: 6, height: 6, frames: [{ data: dataHidden, duration: 100 }] });
  const vis = gifFrameToRgba(parseGif(gifVisible).frames[0]);
  const hid = gifFrameToRgba(parseGif(gifHidden).frames[0]);
  assert.deepEqual(getPixel(vis, 6, 6, 1, 1), [255, 0, 0, 255]);
  assert.equal(getPixel(hid, 6, 6, 1, 1)[3], 0, '隐藏图层不应出现在导出结果中');
});

test('精灵表保留透明通道与每帧单元格位置', () => {
  const width = 4;
  const height = 4;
  const frames = [];
  for (let i = 0; i < 5; i += 1) {
    const data = new Uint8ClampedArray(width * height * 4);
    setPixel(data, width, height, i % 4, Math.floor(i / 4), colorFromHex('#00ff00'));
    frames.push({ data, duration: 100 + i * 20 });
  }
  const sheet = buildSpriteSheet({ width, height, frames, columns: 3, cellGap: 2 });
  assert.equal(sheet.columns, 3);
  assert.equal(sheet.rows, 2);
  assert.equal(sheet.width, 3 * 4 + 2 * 2);
  assert.equal(sheet.height, 2 * 4 + 1 * 2);
  assert.equal(sheet.frames.length, 5);
  // 第二行第一列的帧（索引 3）应位于 y = 4+2
  assert.equal(sheet.frames[3].x, 0);
  assert.equal(sheet.frames[3].y, 6);
  // 绿色像素落在帧 3 的 (3, 0) 位置
  const idx = ((6 + 0) * sheet.width + 3) * 4;
  assert.deepEqual(
    [sheet.data[idx], sheet.data[idx + 1], sheet.data[idx + 2], sheet.data[idx + 3]],
    [0, 255, 0, 255],
  );
  // 间距区域保持透明
  const gapIdx = (0 * sheet.width + 4) * 4;
  assert.equal(sheet.data[gapIdx + 3], 0);
});

test('精灵表元数据记录每帧时长与累计时间', () => {
  const project = createProject({ width: 4, height: 4 });
  setFrameDuration(project, project.frames[0].id, 100);
  const second = insertFrame(project, { afterIndex: 0 });
  setFrameDuration(project, second.id, 250);
  const frames = project.frames.map((f) => ({
    data: compositeFrame(project, f),
    duration: f.duration,
  }));
  const sheet = buildSpriteSheet({
    width: project.width,
    height: project.height,
    frames,
    columns: 2,
  });
  const meta = spriteSheetMetadata(project, sheet, { name: '元数据测试' });
  assert.equal(meta.meta.frameCount, 2);
  assert.equal(meta.meta.totalDuration, 350);
  assert.equal(meta.frames[0].elapsed, 0);
  assert.equal(meta.frames[0].duration, 100);
  assert.equal(meta.frames[1].elapsed, 100);
  assert.equal(meta.frames[1].duration, 250);
});

test('精灵表超过尺寸上限时报错', () => {
  // 45 列 × 100px = 4500px > 4096 上限
  const frames = Array.from({ length: 45 }, () => ({
    data: new Uint8ClampedArray(100 * 100 * 4),
    duration: 100,
  }));
  assert.throws(
    () => buildSpriteSheet({ width: 100, height: 100, frames, columns: 45 }),
    /超过/,
  );
});
