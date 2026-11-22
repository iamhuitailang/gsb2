/* 图块渲染：程序生成的色块，无图片资源。所有图块按"规范掩码 + 顺时针旋转"绘制 */
(function (global) {
  'use strict';

  const E = global.TileEngine;
  const BG = '#20242c';
  const GRID_LINE = 'rgba(255,255,255,0.07)';
  const MISSING_BG = '#3a3f4b';
  const CONFLICT_COLOR = '#ff3b5c';

  function variantStyle(ctx, size, variantId) {
    if (!variantId) return { light: 0, deco: 0 };
    const h = E.fnv1a(String(variantId));
    return { light: ((h % 24) - 12), deco: (h >>> 8) % 3 };
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, Math.min(255, (n >> 16) + amt));
    const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
    const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
    return `rgb(${r},${g},${b})`;
  }

  /*
   * 画规范帧（N 朝上）。
   * 几何：四条边带 + 四个对角小方块 + 中心块；
   * 掩码中某位为 0 就不画对应部分，于是天然形成边/外角/内角的缺口。
   */
  function drawCanonical(ctx, mask, color, size, variantId) {
    const half = size / 2;
    const st = variantStyle(ctx, size, variantId);
    const fill = shade(color, st.light);
    ctx.fillStyle = fill;

    const edge = size * 0.5;   // 边带宽
    const corner = half;       // 对角块边长

    ctx.fillRect(half - edge / 2, 0, edge, half);                 // N 带
    ctx.fillRect(half, half - edge / 2, half, edge);              // E 带
    ctx.fillRect(half - edge / 2, half, edge, half);              // S 带
    ctx.fillRect(0, half - edge / 2, half, edge);                 // W 带
    ctx.fillRect(half - edge / 2, half - edge / 2, edge, edge);   // 中心

    if (mask & 0x10) ctx.fillRect(half, 0, corner, corner);       // NE
    if (mask & 0x20) ctx.fillRect(half, half, corner, corner);    // SE
    if (mask & 0x40) ctx.fillRect(0, half, corner, corner);       // SW
    if (mask & 0x80) ctx.fillRect(0, 0, corner, corner);          // NW

    if (st.deco) {
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = st.deco === 1 ? '#ffffff' : '#000000';
      const d = size * 0.12;
      ctx.fillRect(size * 0.5 - d / 2, size * 0.18, d, d);
      if (st.deco === 2) ctx.fillRect(size * 0.5 - d / 2, size * 0.7, d, d);
      ctx.restore();
    }
  }

  function drawTile(ctx, x, y, size, evalCell, terrainColor) {
    if (!evalCell || evalCell.empty) return;
    if (evalCell.missing) {
      ctx.fillStyle = MISSING_BG;
      ctx.fillRect(x, y, size, size);
      // 醒目叉号标出缺项
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = Math.max(1.5, size * 0.06);
      ctx.beginPath();
      ctx.moveTo(x + size * 0.2, y + size * 0.2);
      ctx.lineTo(x + size * 0.8, y + size * 0.8);
      ctx.moveTo(x + size * 0.8, y + size * 0.2);
      ctx.lineTo(x + size * 0.2, y + size * 0.8);
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.translate(x + size / 2, y + size / 2);
    ctx.rotate((evalCell.rotDeg * Math.PI) / 180);
    ctx.translate(-size / 2, -size / 2);
    drawCanonical(ctx, evalCell.canonMask, terrainColor, size, evalCell.variantId);
    ctx.restore();

    if (evalCell.conflictRuleIds && evalCell.conflictRuleIds.length) {
      ctx.save();
      ctx.strokeStyle = CONFLICT_COLOR;
      ctx.lineWidth = Math.max(2, size * 0.08);
      ctx.strokeRect(x + 1.5, y + 1.5, size - 3, size - 3);
      ctx.restore();
    }
  }

  /* 空格的底色：露出相邻地表的颜色，直观看到"这格属于谁的边缘" */
  function drawEmptyBackground(ctx, gx, gy, size, grid, terrains) {
    const colorById = {};
    terrains.forEach((t) => { colorById[t.id] = t.color; });
    let color = null;
    for (const d of E.CARDINALS) {
      const n = grid.get(gx + E.DX[d], gy + E.DY[d]);
      if (n && colorById[n]) { color = shade(colorById[n], -28); break; }
    }
    if (color) {
      ctx.fillStyle = color;
      ctx.fillRect(gx * size, gy * size, size, size);
    }
  }

  function renderMap(canvas, state) {
    const { grid, rules, seed, selection, cellSize, evalCache } = state;
    const ctx = canvas.getContext('2d');
    const W = grid.w * cellSize, H = grid.h * cellSize;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const colorById = {};
    rules.terrains.forEach((t) => { colorById[t.id] = t.color; });

    for (let y = 0; y < grid.h; y++) {
      for (let x = 0; x < grid.w; x++) {
        const t = grid.get(x, y);
        if (!t) drawEmptyBackground(ctx, x, y, cellSize, grid, rules.terrains);
        const ev = evalCache.get(grid.idx(x, y));
        if (ev) drawTile(ctx, x * cellSize, y * cellSize, cellSize, ev, colorById[t]);
      }
    }

    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= grid.w; i++) {
      ctx.moveTo(i * cellSize + 0.5, 0);
      ctx.lineTo(i * cellSize + 0.5, H);
    }
    for (let j = 0; j <= grid.h; j++) {
      ctx.moveTo(0, j * cellSize + 0.5);
      ctx.lineTo(W, j * cellSize + 0.5);
    }
    ctx.stroke();

    if (selection) {
      ctx.strokeStyle = '#4cc2ff';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(selection.x * cellSize + 1, selection.y * cellSize + 1, cellSize - 2, cellSize - 2);
    }
  }

  /* 在图块左上角画旋转箭头（检查器/预览用） */
  function drawRotBadge(ctx, x, y, size, rotDeg) {
    if (!rotDeg) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(x + size * 0.2, y + size * 0.2, size * 0.13, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.floor(size * 0.18)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(rotDeg + '°', x + size * 0.2, y + size * 0.2 + 0.5);
    ctx.restore();
  }

  /* 迷你预览：指定规范图块掩码与旋转 */
  function renderPreview(canvas, mask, rot, color, size, variantId, missing) {
    const ctx = canvas.getContext('2d');
    size = size || 48;
    if (canvas.width !== size) canvas.width = size;
    if (canvas.height !== size) canvas.height = size;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, size, size);
    if (missing) {
      ctx.fillStyle = MISSING_BG;
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#ffd23f';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(size * 0.2, size * 0.2); ctx.lineTo(size * 0.8, size * 0.8);
      ctx.moveTo(size * 0.8, size * 0.2); ctx.lineTo(size * 0.2, size * 0.8);
      ctx.stroke();
    } else {
      // 与主地图一致：画规范帧后整体旋转 rot 次
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate((rot * 90 * Math.PI) / 180);
      ctx.translate(-size / 2, -size / 2);
      drawCanonical(ctx, mask, color || '#7aa2f7', size, variantId);
      ctx.restore();
      drawRotBadge(ctx, 0, 0, size, rot * 90);
    }
  }

  global.TileRender = {
    renderMap, renderPreview, drawTile, shade, BG,
  };
})(typeof window !== 'undefined' ? window : globalThis);
