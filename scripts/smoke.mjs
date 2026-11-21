/**
 * 快速验证脚本（不依赖浏览器）：跑一遍解码 → 自动调色板 → 量化 → 指标 → PNG 编码，
 * 用于本地冒烟测试和性能检查。
 *
 *   npm run smoke
 */
import { encodeRgbaPng, decodePng, readPngInfo } from '../src/png.js';
import { generatePaletteFromModel, createSourceModel, addImageToModel } from '../src/palette.js';
import { quantizeImage, DITHER_IDS } from '../src/quantize.js';
import { computeMetrics, computeSSIM } from '../src/metrics.js';
import { SAMPLE_DEFINITIONS } from '../src/samples.js';
import { encodeResult } from '../src/exporters.js';
import { createZip } from '../src/zip.js';

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures++;
    console.error(`  ✗ ${message}`);
  }
}

for (const def of SAMPLE_DEFINITIONS) {
  const image = def.build();
  console.log(`\n${def.name} ${def.file} (${image.width}×${image.height})`);
  const png = await encodeRgbaPng(image.rgba, image.width, image.height);
  const decoded = await decodePng(png);
  check(decoded.width === image.width && decoded.height === image.height, 'PNG 往返尺寸一致');
  let mismatch = 0;
  for (let i = 0; i < image.rgba.length; i++) {
    if (decoded.rgba[i] !== image.rgba[i]) mismatch++;
  }
  check(mismatch === 0, `PNG 往返像素一致（差异 ${mismatch}）`);

  const model = createSourceModel();
  addImageToModel(model, image.rgba, 128);
  const palette = generatePaletteFromModel(model, def.recommended.colorCount);
  check(palette.length > 0 && palette.length <= def.recommended.colorCount, `调色板 ${palette.length} 色`);

  for (const dither of DITHER_IDS) {
    const t0 = performance.now();
    const result = quantizeImage(image.rgba, image.width, image.height, {
      palette,
      dither,
      alphaCutoff: 128,
      alphaMode: 'binary',
    });
    const elapsed = performance.now() - t0;
    const metrics = computeMetrics(image.rgba, result.rgba, image.width, image.height, { alphaCutoff: 128 });
    const ssim = computeSSIM(image.rgba, result.rgba, image.width, image.height, 128);
    const out = await encodeResult(result, 'indexed');
    const info = readPngInfo(out);
    check(info.isIndexed, `[${dither}] 索引 PNG 有效`);
    check(
      result.hasTransparency
        ? result.transparentIndex === result.palette.length - 1 && result.palette[result.transparentIndex].transparent === true
        : result.transparentIndex === -1,
      `[${dither}] 透明索引处理正确`,
    );
    check(Number.isFinite(metrics.psnr) && Number.isFinite(metrics.mae), `[${dither}] 指标有限`);
    check(ssim === null || (ssim > 0 && ssim <= 1), `[${dither}] SSIM 合法`);
    if (dither === 'none' || dither === 'floyd-steinberg') {
      console.log(
        `  · ${dither.padEnd(16)} ${elapsed.toFixed(1).padStart(6)} ms  PSNR ${metrics.psnr.toFixed(2).padStart(6)} dB  ΔE ${metrics.deltaE76Mean.toFixed(2).padStart(5)}  ${out.length} B`,
      );
    }
  }

  const result = quantizeImage(image.rgba, image.width, image.height, {
    palette,
    dither: def.recommended.dither,
  });
  const zip = createZip([
    { name: def.file, data: await encodeResult(result, 'indexed') },
    { name: 'metrics.csv', data: new TextEncoder().encode('x') },
  ]);
  check(zip.length > 0, 'ZIP 生成成功');
}

// 边界情况：全透明图、保留半透明 alpha、固定调色板
console.log('\n边界情况');
const blank = new Uint8ClampedArray(4 * 4);
const bwPalette = [
  { r: 0, g: 0, b: 0 },
  { r: 255, g: 255, b: 255 },
];
const transparentResult = quantizeImage(blank, 2, 2, { palette: bwPalette, dither: 'none' });
check(transparentResult.hasTransparency, '全透明图被识别为带透明');
check(transparentResult.palette.length === 3, '调色板追加透明索引');
const blankMetrics = computeMetrics(blank, transparentResult.rgba, 2, 2, { alphaCutoff: 128 });
check(blankMetrics.mae === 0, '全透明图 MAE 为 0');

// 半透明 + preserve：索引 PNG 通过 tRNS 展开，逐像素保持 alpha
const semi = new Uint8ClampedArray([
  200, 120, 60, 255,
  200, 120, 60, 192,
  200, 120, 60, 0,
  200, 120, 60, 160,
]);
const semiResult = quantizeImage(semi, 2, 2, {
  palette: bwPalette,
  dither: 'none',
  alphaMode: 'preserve',
});
const semiPng = await encodeResult(semiResult, 'indexed');
const semiDecoded = await decodePng(semiPng);
let alphaMismatch = 0;
for (let p = 0; p < 4; p++) {
  if (semiDecoded.rgba[p * 4 + 3] !== semiResult.rgba[p * 4 + 3]) alphaMismatch++;
}
check(alphaMismatch === 0, 'preserve 模式下索引 PNG 保留半透明 alpha');
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures ? 1 : 0);
