/**
 * 精灵表导出。
 *
 * 所有格子尺寸一致（cellWidth × cellHeight），导出图保留 alpha 通道。
 * 提供两种排版：横向条带、网格。网格模式支持列数与“列优先/行优先”。
 */

import { clamp } from './util.js';

export const SPRITE_SHEET_PRESETS = {
  horizontal: { label: '横向条带（1×N）' },
  grid: { label: '网格' },
};

export const MAX_SHEET_SIZE = 4096;
export const MAX_SHEET_PIXELS = 24 * 1024 * 1024;

/**
 * @param {{width:number,height:number,frames:{data:Uint8ClampedArray,duration:number}[],columns?:number,cellGap?:number}} options
 */
export function buildSpriteSheet({ width, height, frames, columns = null, cellGap = 0 }) {
  if (!frames.length) throw new Error('没有可导出的帧');
  const gap = clamp(Math.round(cellGap), 0, 16);
  const count = frames.length;
  const cols = columns == null ? count : clamp(Math.round(columns), 1, count);
  const rows = Math.ceil(count / cols);
  const sheetWidth = cols * width + (cols - 1) * gap;
  const sheetHeight = rows * height + (rows - 1) * gap;

  if (sheetWidth > MAX_SHEET_SIZE || sheetHeight > MAX_SHEET_SIZE) {
    throw new Error(
      `精灵表 ${sheetWidth}×${sheetHeight} 超过 ${MAX_SHEET_SIZE} 像素上限，请减少列数或缩小画布`,
    );
  }
  if (sheetWidth * sheetHeight > MAX_SHEET_PIXELS) {
    throw new Error('精灵表总像素过大，无法安全导出');
  }

  const data = new Uint8ClampedArray(sheetWidth * sheetHeight * 4);
  const placed = [];
  frames.forEach((frame, index) => {
    if (frame.data.length !== width * height * 4) {
      throw new Error(`第 ${index + 1} 帧像素数据长度不符`);
    }
    const col = index % cols;
    const row = Math.floor(index / cols);
    const ox = col * (width + gap);
    const oy = row * (height + gap);
    for (let y = 0; y < height; y += 1) {
      const srcStart = y * width * 4;
      const dstStart = ((oy + y) * sheetWidth + ox) * 4;
      data.set(frame.data.subarray(srcStart, srcStart + width * 4), dstStart);
    }
    placed.push({ index, x: ox, y: oy, width, height, duration: frame.duration });
  });

  return {
    width: sheetWidth,
    height: sheetHeight,
    columns: cols,
    rows,
    cellWidth: width,
    cellHeight: height,
    gap,
    data,
    frames: placed,
  };
}

/**
 * 生成精灵表元数据 JSON，帧时长随 sheet 一起给出，避免信息丢失。
 * 若传入已放大的 sheet，cell / size 均按放大后的像素记录。
 */
export function spriteSheetMetadata(project, sheet, { name = project.name, imageFile = null } = {}) {
  const scale = project.width > 0 ? sheet.cellWidth / project.width : 1;
  return {
    meta: {
      app: 'pixanim',
      format: 'pixanim-spritesheet',
      version: 1,
      name,
      image: imageFile,
      size: { w: sheet.width, h: sheet.height },
      scale,
      cell: { w: sheet.cellWidth, h: sheet.cellHeight },
      sourceCell: { w: project.width, h: project.height },
      columns: sheet.columns,
      rows: sheet.rows,
      gap: sheet.gap,
      frameCount: sheet.frames.length,
      totalDuration: project.frames.reduce((sum, f) => sum + f.duration, 0),
      loop: project.loop,
    },
    frames: sheet.frames.map((f) => ({
      index: f.index,
      x: f.x,
      y: f.y,
      w: f.width,
      h: f.height,
      duration: f.duration,
      elapsed: project.frames.slice(0, f.index).reduce((sum, fr) => sum + fr.duration, 0),
    })),
  };
}

/**
 * 把精灵表按整数倍最近邻放大。放大后再作为 GIF/PNG 下载，便于小尺寸像素画预览。
 */
export function scaleSheet(sheet, factor) {
  const scale = clamp(Math.round(factor), 1, 8);
  if (scale === 1) return sheet;
  const outW = sheet.width * scale;
  const outH = sheet.height * scale;
  const data = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y += 1) {
    const srcY = Math.floor(y / scale);
    for (let x = 0; x < outW; x += 1) {
      const src = (srcY * sheet.width + Math.floor(x / scale)) * 4;
      const dst = (y * outW + x) * 4;
      data[dst] = sheet.data[src];
      data[dst + 1] = sheet.data[src + 1];
      data[dst + 2] = sheet.data[src + 2];
      data[dst + 3] = sheet.data[src + 3];
    }
  }
  return {
    ...sheet,
    width: outW,
    height: outH,
    cellWidth: sheet.cellWidth * scale,
    cellHeight: sheet.cellHeight * scale,
    gap: sheet.gap * scale,
    data,
    frames: sheet.frames.map((f) => ({
      ...f,
      x: f.x * scale,
      y: f.y * scale,
      width: f.width * scale,
      height: f.height * scale,
    })),
  };
}
