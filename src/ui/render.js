/**
 * 画布渲染与坐标换算。
 *
 * 关键点：屏幕坐标 -> 像素坐标只依赖 canvas 的 CSS 尺寸与工程尺寸，
 * 绝不用“缩放倍数”去二次计算，避免设备像素比（DPR）或 CSS 缩放导致
 * 笔尖偏移。
 */

export function fitZoomFor(viewport, project, padding = 48) {
  const availableW = Math.max(64, viewport.width - padding);
  const availableH = Math.max(64, viewport.height - padding);
  const raw = Math.min(availableW / project.width, availableH / project.height);
  // 整数倍缩放保证每个像素大小一致、边缘清晰。
  return Math.max(1, Math.min(40, Math.floor(raw)));
}

/**
 * @param {number} clientX
 * @param {number} clientY
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {number} projectWidth
 * @param {number} projectHeight
 */
export function pixelFromClient(clientX, clientY, rect, projectWidth, projectHeight) {
  if (!rect.width || !rect.height) return null;
  const x = Math.floor(((clientX - rect.left) / rect.width) * projectWidth);
  const y = Math.floor(((clientY - rect.top) / rect.height) * projectHeight);
  if (x < 0 || y < 0 || x >= projectWidth || y >= projectHeight) return null;
  return { x, y };
}

function checkerPattern(ctx, cell, light = '#1c1e2b', dark = '#151722') {
  const pattern = ctx.createPattern(makeCheckerTile(cell, light, dark), 'repeat');
  return pattern;
}

let tileCache = new Map();
function makeCheckerTile(cell, light, dark) {
  const key = `${cell}|${light}|${dark}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = cell * 2;
  canvas.height = cell * 2;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, cell * 2, cell * 2);
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, cell, cell);
  ctx.fillRect(cell, cell, cell, cell);
  tileCache.set(key, canvas);
  return canvas;
}

export function drawCheckerboard(ctx, width, height, cell = 8) {
  ctx.save();
  ctx.fillStyle = checkerPattern(ctx, cell);
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** 把 RGBA 缓冲画到 2D 上下文，最近邻放大。 */
export function drawPixels(ctx, pixels, width, height, zoom) {
  const image = new ImageData(new Uint8ClampedArray(pixels), width, height);
  const off = getScratch(width, height);
  off.ctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off.canvas, 0, 0, width * zoom, height * zoom);
}

let scratch = null;
function getScratch(width, height) {
  if (!scratch || scratch.canvas.width !== width || scratch.canvas.height !== height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    scratch = { canvas, ctx: canvas.getContext('2d') };
  }
  return scratch;
}

/**
 * 洋葱皮：把像素整体调向 tint 颜色并降低不透明度。
 * 返回新的 RGBA 缓冲，不修改输入。
 */
export function tintPixels(pixels, tint, alpha) {
  const [tr, tg, tb] = tint;
  const out = new Uint8ClampedArray(pixels.length);
  const a = Math.max(0, Math.min(1, alpha));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    // 保留一点原色，避免完全变成纯色块，更容易辨认轮廓。
    out[i] = Math.round(pixels[i] * 0.25 + tr * 0.75);
    out[i + 1] = Math.round(pixels[i + 1] * 0.25 + tg * 0.75);
    out[i + 2] = Math.round(pixels[i + 2] * 0.25 + tb * 0.75);
    out[i + 3] = Math.round(pixels[i + 3] * a);
  }
  return out;
}

export function drawGrid(ctx, width, height, zoom, { major = 8, showMajor = true } = {}) {
  if (zoom < 4) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.beginPath();
  for (let x = 1; x < width; x += 1) {
    const px = x * zoom + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height * zoom);
  }
  for (let y = 1; y < height; y += 1) {
    const py = y * zoom + 0.5;
    ctx.moveTo(0, py);
    ctx.lineTo(width * zoom, py);
  }
  ctx.stroke();
  if (showMajor && major > 1) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    for (let x = major; x < width; x += major) {
      const px = x * zoom + 0.5;
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height * zoom);
    }
    for (let y = major; y < height; y += major) {
      const py = y * zoom + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(width * zoom, py);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** 画布外框：让浅色像素在深色背景上有清晰边界。 */
export function drawBorder(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.restore();
}

/**
 * 选中像素的方框（当前指针位置）。几何与 stamp() 完全一致：
 * 偶数尺寸向右/下扩展，奇数尺寸居中，光标框才不会和实际落笔错位。
 */
export function drawCursorCell(ctx, x, y, zoom, size = 1) {
  const s = Math.max(1, Math.round(size));
  const start = -Math.floor((s - 1) / 2);
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 205, 117, 0.95)';
  ctx.lineWidth = 1;
  ctx.strokeRect((x + start) * zoom + 0.5, (y + start) * zoom + 0.5, zoom * s, zoom * s);
  ctx.restore();
}
