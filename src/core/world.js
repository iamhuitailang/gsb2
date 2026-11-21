import {
  comparisonBounds,
  matrixFromAlignment,
  normalizeAlignment,
} from './alignment.js';
import { DIFF_SIDE_LIMIT } from './diff.js';

export const DIFF_MAX_SIDE = DIFF_SIDE_LIMIT;

export function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Rasterise both images into the same world space at diff resolution.
 * World space is image A's native pixel grid; image B is placed with its
 * current alignment. Transparent pixels mean "no image here", which the
 * diff engine reports as coverage differences when enabled.
 */
export function renderWorldRasters({
  imgA,
  imgB,
  alignment,
  maxSide = DIFF_MAX_SIDE,
}) {
  const wA = imgA.naturalWidth || imgA.width;
  const hA = imgA.naturalHeight || imgA.height;
  const wB = imgB.naturalWidth || imgB.width;
  const hB = imgB.naturalHeight || imgB.height;
  const al = normalizeAlignment(alignment);
  const bounds = comparisonBounds(wA, hA, al, wB, hB);
  const longest = Math.max(bounds.width, bounds.height, 1);
  const factor = Math.min(1, maxSide / longest);
  const width = Math.max(1, Math.ceil(bounds.width * factor));
  const height = Math.max(1, Math.ceil(bounds.height * factor));
  const matrix = matrixFromAlignment(al);

  const aPixels = drawToPixels(
    width,
    height,
    (ctx) => {
      ctx.setTransform(
        factor,
        0,
        0,
        factor,
        -bounds.minX * factor,
        -bounds.minY * factor,
      );
      ctx.drawImage(imgA, 0, 0, wA, hA);
    },
  );

  const bPixels = drawToPixels(
    width,
    height,
    (ctx) => {
      ctx.setTransform(
        factor * matrix.a,
        factor * matrix.b,
        factor * matrix.c,
        factor * matrix.d,
        (matrix.e - bounds.minX) * factor,
        (matrix.f - bounds.minY) * factor,
      );
      ctx.drawImage(imgB, 0, 0, wB, hB);
    },
  );

  return {
    aPixels,
    bPixels,
    width,
    height,
    factor,
    bounds,
    rasterKey: rasterKeyFor({ wA, hA, wB, hB, alignment: al, factor, width, height }),
  };
}

function drawToPixels(width, height, paint) {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, width, height);
  paint(ctx);
  return ctx.getImageData(0, 0, width, height).data;
}

export function rasterKeyFor({ wA, hA, wB, hB, alignment, factor, width, height }) {
  const al = normalizeAlignment(alignment);
  return [
    wA,
    hA,
    wB,
    hB,
    al.tx.toFixed(4),
    al.ty.toFixed(4),
    al.scale.toFixed(6),
    al.rotation.toFixed(6),
    factor.toFixed(6),
    width,
    height,
  ].join(':');
}

export function maskKeyFor({ strokesRevision, factor, width, height, bounds }) {
  return [
    strokesRevision,
    factor.toFixed(6),
    width,
    height,
    bounds.minX.toFixed(3),
    bounds.minY.toFixed(3),
  ].join(':');
}

/** Snapshot current images into one canvas for export / report thumbnails. */
export function renderComparisonImage({
  imgA,
  imgB,
  alignment,
  mode = 'side',
  opacity = 0.55,
  maxSide = 1600,
  background = '#0d1219',
}) {
  const wA = imgA.naturalWidth || imgA.width;
  const hA = imgA.naturalHeight || imgA.height;
  const wB = imgB.naturalWidth || imgB.width;
  const hB = imgB.naturalHeight || imgB.height;
  const al = normalizeAlignment(alignment);
  const matrix = matrixFromAlignment(al);

  if (mode === 'overlay') {
    const bounds = comparisonBounds(wA, hA, al, wB, hB);
    const scale = Math.min(1.6, maxSide / Math.max(bounds.width, bounds.height));
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    const canvas = makeCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    drawChecker(ctx, width, height, 24);
    ctx.save();
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      -bounds.minX * scale,
      -bounds.minY * scale,
    );
    ctx.drawImage(imgA, 0, 0, wA, hA);
    ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
    ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    ctx.drawImage(imgB, 0, 0, wB, hB);
    ctx.restore();
    return canvas;
  }

  if (mode === 'diff') {
    // Diff composites are produced by the diff engine; the caller draws them.
    throw new Error('diff 模式快照需使用差异结果画布');
  }

  // Side-by-side at native scale: A at 1:1, B at its aligned scale relative A.
  const pad = 24;
  const gap = 24;
  const bW = wB * al.scale;
  const bH = hB * al.scale;
  const width = Math.ceil(pad * 2 + wA + gap + bW);
  const height = Math.ceil(pad * 2 + Math.max(hA, bH));
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = makeCanvas(width * scale, height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  drawChecker(ctx, width, height, 24);
  ctx.imageSmoothingQuality = 'high';

  const topA = pad + (Math.max(hA, bH) - hA) / 2;
  const topB = pad + (Math.max(hA, bH) - bH) / 2;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(pad - 8, topA - 8, wA + 16, hA + 16);
  ctx.drawImage(imgA, pad, topA, wA, hA);

  const rightX = pad + wA + gap;
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fillRect(rightX - 8, topB - 8, bW + 16, bH + 16);
  ctx.save();
  ctx.translate(rightX + bW / 2, topB + bH / 2);
  ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, 0, 0);
  ctx.drawImage(imgB, -wB / 2, -hB / 2, wB, hB);
  ctx.restore();

  ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText('A', pad, pad - 8);
  ctx.fillText('B', rightX, pad - 8);
  return canvas;
}

/**
 * Render one side of a pair into A's world frame, on a dark background.
 * Used for report thumbnails where A and B should be shown independently but
 * at the same scale.
 */
export function renderWorldThumbnail({
  imgA,
  imgB,
  alignment,
  which,
  maxSide = 720,
  background = '#0b1018',
}) {
  const rasters = renderWorldRasters({ imgA, imgB, alignment, maxSide: 1600 });
  const pixels = which === 'b' ? rasters.bPixels : rasters.aPixels;
  const canvas = makeCanvas(rasters.width, rasters.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const image = ctx.createImageData(rasters.width, rasters.height);
  image.data.set(pixels);
  const layer = document.createElement('canvas');
  layer.width = rasters.width;
  layer.height = rasters.height;
  layer.getContext('2d').putImageData(image, 0, 0);
  ctx.drawImage(layer, 0, 0);
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  if (scale >= 1) return canvas;
  const small = makeCanvas(canvas.width * scale, canvas.height * scale);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, small.width, small.height);
  return small;
}

export function drawChecker(ctx, width, height, size = 16) {
  const tile = Math.max(4, size);
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const dark = ((x / tile) | 0) % 2 === ((y / tile) | 0) % 2;
      ctx.fillStyle = dark ? '#0b1018' : '#0e141d';
      ctx.fillRect(x, y, tile, tile);
    }
  }
}
