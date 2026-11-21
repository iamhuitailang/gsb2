import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  DEFAULT_PREVIEW,
  normalizeSettings,
  normalizePreview,
  paletteHash,
  serializeProject,
  deserializeProject,
  normalizePresets,
  paletteTextFromId,
  fixedPaletteFromSettings,
  renderHash,
} from '../src/state.js';
import { generatePaletteFromModel, createSourceModel, addImageToModel } from '../src/palette.js';
import { quantizeImage } from '../src/quantize.js';
import { bytesToDataUrl } from '../src/utils.js';
import { encodeRgbaPng } from '../src/png.js';
import { makeGradient, makeTransparentEdge } from '../scripts/test-fixtures.mjs';
import { createZip } from '../src/zip.js';

test('设置归一化：非法值回退并被夹紧', () => {
  const s = normalizeSettings({ colorCount: 9999, strength: -3, alphaCutoff: 0, dither: 'nope', alphaMode: 'x' });
  assert.equal(s.colorCount, 256);
  assert.equal(s.strength, 0);
  assert.equal(s.alphaCutoff, 1);
  assert.equal(s.dither, DEFAULT_SETTINGS.dither);
  assert.equal(s.alphaMode, 'binary');
});

test('预览设置归一化', () => {
  const p = normalizePreview({ mode: 'nope', zoom: 1000, split: 5, background: 'x' });
  assert.equal(p.mode, DEFAULT_PREVIEW.mode);
  assert.equal(p.zoom, 32);
  assert.equal(p.split, 0.98);
  assert.equal(p.background, DEFAULT_PREVIEW.background);
});

test('paletteHash 对固定调色板内容敏感', () => {
  const a = normalizeSettings({ paletteSource: 'fixed', fixedPaletteText: '#000\n#fff' });
  const b = normalizeSettings({ paletteSource: 'fixed', fixedPaletteText: '#000\n#eee' });
  assert.notEqual(paletteHash(a, 'x'), paletteHash(b, 'x'));
});

test('renderHash 忽略预览选项但受抖动影响', () => {
  const a = normalizeSettings({ dither: 'none' });
  const b = normalizeSettings({ dither: 'atkinson' });
  assert.notEqual(renderHash(a), renderHash(b));
});

test('固定调色板解析支持预设文本', () => {
  const text = paletteTextFromId('gameboy');
  const settings = normalizeSettings({ paletteSource: 'fixed', fixedPalettePreset: 'gameboy', fixedPaletteText: text });
  const palette = fixedPaletteFromSettings(settings);
  assert.equal(palette.length, 4);
  assert.deepEqual(palette[0], { r: 15, g: 56, b: 15 });
});

test('工程序列化往返：设置、预览、覆盖与调色板快照', async () => {
  const image = makeGradient(8, 8);
  const bytes = await encodeRgbaPng(image.rgba, 8, 8);
  const project = {
    id: 'proj_test',
    name: '测试工程',
    createdAt: new Date().toISOString(),
    settings: normalizeSettings({ colorCount: 8, dither: 'atkinson' }),
    preview: normalizePreview({ mode: 'diff', zoom: 8 }),
    batchPalette: [{ r: 1, g: 2, b: 3 }],
    batchPaletteHash: 'abc',
    presets: normalizePresets([
      { id: 'p1', name: '我的', settings: { colorCount: 4, dither: 'none' } },
    ]),
    images: [
      {
        id: 'img1',
        name: 'gradient.png',
        width: 8,
        height: 8,
        dataUrl: bytesToDataUrl(bytes, 'image/png'),
        sourceInfo: null,
        overrideEnabled: true,
        overrides: { colorCount: 3 },
        paletteSnapshot: { hash: 'h1', palette: [{ r: 10, g: 20, b: 30 }] },
      },
    ],
  };
  const serialized = serializeProject(project, project.preview);
  const json = JSON.parse(JSON.stringify(serialized));
  const restored = deserializeProject(json);
  assert.equal(restored.name, '测试工程');
  assert.equal(restored.settings.colorCount, 8);
  assert.equal(restored.preview.mode, 'diff');
  assert.equal(restored.images.length, 1);
  assert.equal(restored.images[0].overrideEnabled, true);
  assert.deepEqual(restored.images[0].paletteSnapshot.palette, [{ r: 10, g: 20, b: 30 }]);
  assert.equal(restored.presets[0].name, '我的');
  assert.deepEqual(restored.batchPalette, [{ r: 1, g: 2, b: 3 }]);
});

test('拒绝非本工具的工程文件', () => {
  assert.throws(() => deserializeProject({ foo: 'bar' }), /不是 Palette Forge 工程/);
  assert.throws(() => deserializeProject({ format: 'palette-forge-project', version: 99 }), /高于当前支持/);
});

test('调色板快照保证重开工程后输出逐像素一致', async () => {
  const image = makeGradient(32, 32);
  const model = createSourceModel();
  addImageToModel(model, image.rgba, 128);
  const palette = generatePaletteFromModel(model, 8);
  const spec = { palette, dither: 'stucki', strength: 1, serpentine: true, alphaCutoff: 128, alphaMode: 'binary' };
  const a = quantizeImage(image.rgba, 32, 32, spec);
  // 模拟 JSON 往返：调色板用快照里的拷贝
  const snapshot = JSON.parse(JSON.stringify(palette));
  const b = quantizeImage(image.rgba, 32, 32, { ...spec, palette: snapshot });
  assert.deepEqual(Array.from(a.rgba), Array.from(b.rgba));
});

test('ZIP 结构包含本地文件头、中央目录与结束记录', () => {
  const zip = createZip([
    { name: 'a.txt', data: new TextEncoder().encode('hello') },
    { name: 'b.bin', data: new Uint8Array([1, 2, 3]) },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  // EOCD 签名必须在结尾附近
  let found = false;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      found = true;
      assert.equal(view.getUint16(i + 10, true), 2, '条目数应为 2');
      break;
    }
  }
  assert.ok(found, '缺少 EOCD');
});

test('透明边缘图使用固定调色板时透明像素保持透明', () => {
  const image = makeTransparentEdge(32);
  const result = quantizeImage(image.rgba, 32, 32, {
    palette: [
      { r: 0, g: 0, b: 0 },
      { r: 255, g: 255, b: 255 },
    ],
    dither: 'floyd-steinberg',
  });
  assert.equal(result.hasTransparency, true);
  assert.equal(result.palette.length, 3);
  for (let p = 0; p < image.width * image.height; p++) {
    if (image.rgba[p * 4 + 3] < 128) {
      assert.equal(result.rgba[p * 4 + 3], 0);
      assert.equal(result.indices[p], result.transparentIndex);
    }
  }
});
