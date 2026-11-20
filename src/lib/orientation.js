/**
 * EXIF orientation handling.
 *
 * Pixels are decoded without browser auto-rotation (see image-io.js) and drawn
 * upright by `drawUpright`, so preview and export share exactly one
 * orientation path.
 */

export const ORIENTATION_LABELS = {
  1: '正常',
  2: '水平镜像',
  3: '旋转 180°',
  4: '垂直镜像',
  5: '转置（镜像 + 90°）',
  6: '顺时针 90°',
  7: '反斜转置',
  8: '逆时针 90°'
};

export function describeOrientation(orientation) {
  if (!orientation || orientation === 1) return '正常（无旋转）';
  return `EXIF ${orientation} · ${ORIENTATION_LABELS[orientation] || '未知'}`;
}

export function uprightSize(width, height, orientation) {
  if (orientation >= 5 && orientation <= 8) return { width: height, height: width };
  return { width, height };
}

/**
 * Affine matrix mapping *source* pixel coordinates to *upright* coordinates.
 * All translations are expressed in source pixel units, which keeps the math
 * independent of any draw scale.
 *
 * @returns {[number, number, number, number, number, number]}
 */
export function orientationMatrix(sourceWidth, sourceHeight, orientation) {
  const W = sourceWidth;
  const H = sourceHeight;
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, W, 0];
    case 3: return [-1, 0, 0, -1, W, H];
    case 4: return [1, 0, 0, -1, 0, H];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, H, 0];
    case 7: return [0, -1, -1, 0, H, W];
    case 8: return [0, -1, 1, 0, 0, W];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

export function mapPoint(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}

/**
 * Draw `source` (decoded WITHOUT orientation applied) upright.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {CanvasImageSource} source
 * @param {number} sourceWidth raw (pre-rotation) pixel width
 * @param {number} sourceHeight raw (pre-rotation) pixel height
 * @param {number} orientation EXIF orientation 1–8
 * @param {number} [scale=1] draw scale, applied on top of the orientation map
 */
export function drawUpright(ctx, source, sourceWidth, sourceHeight, orientation, scale = 1) {
  const m = orientationMatrix(sourceWidth, sourceHeight, orientation);
  ctx.save();
  ctx.setTransform(m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale);
  ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight);
  ctx.restore();
}
