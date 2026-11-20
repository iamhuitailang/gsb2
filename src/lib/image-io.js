/**
 * Image decoding and rendering.
 *
 * Two sizes are decoded from the same source bytes:
 *   - a *working copy* (long edge ≤ 1600 px) used for the live preview
 *   - the *full-resolution* bitmap, decoded lazily only for export
 *
 * Both go through the identical `drawUpright` + `renderPixels` path, so
 * orientation and colour match between preview and exported file.
 */

import { readExifOrientation } from './exif.js';
import { drawUpright, uprightSize } from './orientation.js';
import { renderPixels } from './render.js';

export const WORKING_MAX_EDGE = 1600;
export const THUMBNAIL_MAX_EDGE = 240;

export const SUPPORTED_INPUT_FORMATS = [
  'JPEG (.jpg/.jpeg)',
  'PNG (.png)',
  'WebP (.webp)',
  'GIF (.gif，仅首帧)',
  'BMP (.bmp)',
  'AVIF (.avif，取决于浏览器)',
  'SVG (.svg) — 仅浏览器可解码的矢量图，不推荐用于照片'
];

const DECODABLE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/avif',
  'image/svg+xml'
];

export function isPlausiblySupported(file) {
  if (!file) return false;
  if (file.type && DECODABLE_TYPES.includes(file.type)) return true;
  if (file.type && file.type.startsWith('image/')) return true;
  return /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i.test(file.name || '');
}

export class DecodeError extends Error {
  constructor(message, { unsupported = false } = {}) {
    super(message);
    this.name = 'DecodeError';
    this.unsupported = unsupported;
  }
}

/**
 * Decode a blob to an ImageBitmap.
 *
 * `imageOrientation: 'none'` guarantees raw (pre-rotation) pixels, which is what
 * our own orientation matrix needs. A few engines reject the options bag; in
 * that case the retry may apply EXIF rotation itself, so the caller is told
 * (`baked: true`) and must NOT apply the orientation a second time.
 *
 * @returns {Promise<{bitmap: ImageBitmap, baked: boolean}>}
 */
async function decodeBitmap(blob) {
  try {
    return { bitmap: await createImageBitmap(blob, { imageOrientation: 'none' }), baked: false };
  } catch (firstError) {
    try {
      return { bitmap: await createImageBitmap(blob), baked: true };
    } catch {
      throw new DecodeError(
        `无法解码该图片（${firstError?.message || '浏览器不支持此格式'}）。`,
        { unsupported: true }
      );
    }
  }
}

function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('画布导出失败'))), type, quality);
  });
}

function assertCanvas(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height);
  // A fully *empty* canvas means the decode silently produced nothing. A
  // transparent-but-coloured image (e.g. a PNG logo with alpha) is valid, so
  // check colour as well as alpha before declaring failure.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0 || data[i + 3] !== 0) return;
  }
  throw new DecodeError('图片内容为空，或当前浏览器不支持该格式的像素访问。');
}

/**
 * Load an image into an editable session object.
 * @param {File|Blob} file
 */
export async function loadImageSource(file) {
  if (!file) throw new DecodeError('未选择文件。');
  const { bitmap, baked } = await decodeBitmap(file);
  const rawWidth = bitmap.width;
  const rawHeight = bitmap.height;
  if (!rawWidth || !rawHeight) {
    bitmap.close?.();
    throw new DecodeError('图片尺寸无效。');
  }

  let exifOrientation = 1;
  try {
    exifOrientation = (await readExifOrientation(file)) || 1;
  } catch {
    exifOrientation = 1;
  }
  // If the decode fallback already applied EXIF rotation, applying it again
  // would double-rotate the image; otherwise we own the transform.
  const orientation = baked ? 1 : exifOrientation;

  const upright = uprightSize(rawWidth, rawHeight, orientation);

  // Working copy for the live preview. Both the downscale and the orientation
  // transform happen here, so the cached base pixels are already upright.
  // Round the target size up and scale to *cover* it: a rounded-down edge would
  // leave a transparent 1px sliver that renders as black.
  const scale = Math.min(1, WORKING_MAX_EDGE / Math.max(upright.width, upright.height));
  const workWidth = Math.max(1, Math.round(upright.width * scale));
  const workHeight = Math.max(1, Math.round(upright.height * scale));
  const coverScale = Math.max(workWidth / upright.width, workHeight / upright.height);
  const workCanvas = makeCanvas(workWidth, workHeight);
  const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
  workCtx.imageSmoothingQuality = 'high';
  drawUpright(workCtx, bitmap, rawWidth, rawHeight, orientation, coverScale);
  assertCanvas(workCtx, workWidth, workHeight);
  const baseImageData = workCtx.getImageData(0, 0, workWidth, workHeight);

  // Thumbnail for the filmstrip (stored in the project, so it must be small).
  // The working canvas is already upright, so this is a plain downscale.
  const thumbScale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(workWidth, workHeight));
  const thumbCanvas = makeCanvas(
    Math.max(1, Math.round(workWidth * thumbScale)),
    Math.max(1, Math.round(workHeight * thumbScale))
  );
  const thumbCtx = thumbCanvas.getContext('2d');
  thumbCtx.imageSmoothingQuality = 'high';
  thumbCtx.drawImage(workCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  const thumbnailBlob = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.78);
  const thumbnail = await blobToDataUrl(thumbnailBlob);

  bitmap.close?.();

  return {
    baseImageData,
    displayWidth: workWidth,
    displayHeight: workHeight,
    fullWidth: upright.width,
    fullHeight: upright.height,
    rawWidth,
    rawHeight,
    orientation,
    thumbnail
  };
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('读取缩略图失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Render the live preview from cached base pixels into a 2D canvas.
 */
export function renderPreview(baseImageData, adjustments, targetCanvas) {
  const { width, height } = baseImageData;
  const ctx = targetCanvas.getContext('2d', { willReadFrequently: true });
  const output = ctx.createImageData(width, height);
  renderPixels(baseImageData.data, adjustments, output.data);
  ctx.putImageData(output, 0, 0);
  return output;
}

/**
 * Full-resolution render. Decodes the original file again, applies the same
 * orientation + pixel pipeline, and returns a blob in `format`.
 *
 * @param {File|Blob} file
 * @param {object} adjustments
 * @param {{format?: 'image/jpeg'|'image/png'|'image/webp', quality?: number, orientation?: number}} options
 */
export async function renderFullResolution(file, adjustments, options = {}) {
  const { format = 'image/jpeg', quality = 0.92, orientation: expectedOrientation } = options;
  const { bitmap, baked } = await decodeBitmap(file);
  // When the fallback decoder applied EXIF rotation itself, honouring the
  // stored orientation again would double-rotate the exported file.
  const orientation = baked
    ? 1
    : expectedOrientation || (await readExifOrientation(file)) || 1;
  const { width, height } = uprightSize(bitmap.width, bitmap.height, orientation);
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  drawUpright(ctx, bitmap, bitmap.width, bitmap.height, orientation);
  bitmap.close?.();
  const imageData = ctx.getImageData(0, 0, width, height);
  renderPixels(imageData.data, adjustments, imageData.data);
  ctx.putImageData(imageData, 0, 0);
  const blob = await canvasToBlob(canvas, format, quality);
  if (!blob || blob.size === 0) throw new Error('导出画布为空，未生成文件。');
  const outputType = blob.type || format;
  // Orientation is baked into the pixels; no EXIF orientation tag is written.
  return { blob, width, height, format: outputType, orientation: 1 };
}

export function suggestedExportName(originalName, { format = 'image/jpeg', suffix = 'adjusted' } = {}) {
  const base = String(originalName || 'image').replace(/\.[^.]+$/, '');
  const ext = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';
  return `${base}-${suffix}.${ext}`;
}

export { makeCanvas, canvasToBlob, decodeBitmap };
