/* 关卡数据模型：图层、自动扩展、地图边缘扩展/裁切 */
'use strict';

let _layerSeq = 1;

function createLayer(name, cellSize) {
  return {
    id: 'L' + (_layerSeq++) + '_' + Date.now().toString(36),
    name,
    cellSize,          // 该层格子像素尺寸（世界坐标）
    originX: 0,        // 格子 (0,0) 的世界像素坐标，可为负
    originY: 0,
    cols: 0, rows: 0,  // tiles 数组的逻辑尺寸（稀疏，按需增长）
    tiles: [],
    visible: true,
    opacity: 1,
  };
}

function createLevel(name, tileSize, width, height) {
  return {
    format: 'gsb2-level',
    version: 1,
    name,
    tileSize,          // 基准格子像素尺寸，width/height 以此为单位
    width, height,     // 关卡尺寸（基准格数）
    layers: [],
  };
}

function levelWidthPx(level)  { return level.width * level.tileSize; }
function levelHeightPx(level) { return level.height * level.tileSize; }

function layerTileAt(layer, x, y) {
  if (x < 0 || y < 0 || x >= layer.cols || y >= layer.rows) return 0;
  return layer.tiles[y * layer.cols + x] || 0;
}

/* 直接写入（不扩容），调用方需保证范围 */
function setTileRaw(layer, x, y, id) {
  layer.tiles[y * layer.cols + x] = id;
}

/* 确保 (x,y) 在数组范围内，必要时向各方向扩容并平移 origin。
 * 格子坐标即数组下标：扩容只改 origin 与数据平移，已有格子的世界坐标不变。 */
function ensureCell(layer, x, y) {
  const { cols, rows, cellSize: cs } = layer;
  let growL = 0, growR = 0, growT = 0, growB = 0;
  if (x < 0) growL = -x;
  if (x >= cols) growR = x - cols + 1;
  if (y < 0) growT = -y;
  if (y >= rows) growB = y - rows + 1;
  if (!growL && !growR && !growT && !growB) return;
  const nCols = cols + growL + growR, nRows = rows + growT + growB;
  const nt = new Array(nCols * nRows).fill(0);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      nt[(r + growT) * nCols + (c + growL)] = layer.tiles[r * cols + c];
  layer.tiles = nt;
  layer.cols = nCols; layer.rows = nRows;
  layer.originX -= growL * cs;
  layer.originY -= growT * cs;
}

/* 世界像素坐标 -> 格子坐标 */
function cellAt(layer, wx, wy) {
  return {
    x: Math.floor((wx - layer.originX) / layer.cellSize),
    y: Math.floor((wy - layer.originY) / layer.cellSize),
  };
}

/* 格子是否与关卡范围相交（笔刷只允许画在关卡范围内） */
function cellIntersectsLevel(layer, x, y, level) {
  const cs = layer.cellSize;
  const x0 = layer.originX + x * cs, y0 = layer.originY + y * cs;
  return x0 < levelWidthPx(level) && x0 + cs > 0 &&
         y0 < levelHeightPx(level) && y0 + cs > 0;
}

/* 裁掉完全处于关卡范围之外的行/列，保持剩余格子世界坐标不变 */
function trimLayerToLevel(layer, level) {
  const cs = layer.cellSize;
  const W = levelWidthPx(level), H = levelHeightPx(level);
  // 左侧完全在外的列数：originX + (i+1)*cs <= 0
  let dropL = layer.originX < 0 ? Math.min(layer.cols, Math.floor(-layer.originX / cs)) : 0;
  // 右侧保留的列数：originX + i*cs < W
  let keepR = Math.max(0, Math.min(layer.cols, Math.ceil((W - layer.originX) / cs)));
  let dropT = layer.originY < 0 ? Math.min(layer.rows, Math.floor(-layer.originY / cs)) : 0;
  let keepB = Math.max(0, Math.min(layer.rows, Math.ceil((H - layer.originY) / cs)));
  if (keepR <= dropL || keepB <= dropT) { // 整层都在界外
    layer.cols = 0; layer.rows = 0; layer.tiles = [];
    layer.originX = 0; layer.originY = 0;
    return;
  }
  const nCols = keepR - dropL, nRows = keepB - dropT;
  const nt = new Array(nCols * nRows).fill(0);
  for (let r = 0; r < nRows; r++)
    for (let c = 0; c < nCols; c++)
      nt[r * nCols + c] = layer.tiles[(r + dropT) * layer.cols + (c + dropL)] || 0;
  layer.tiles = nt;
  layer.cols = nCols; layer.rows = nRows;
  layer.originX += dropL * cs;
  layer.originY += dropT * cs;
}

/*
 * 调整地图边缘。d = {left,right,top,bottom}，单位基准格，正扩负裁。
 * apply=false 时只返回预览信息（将被裁掉的格子），不修改数据。
 * 关卡范围始终是世界坐标 [0, widthPx]：向左扩展 = 所有图层 origin 右移，
 * 已有格子的数组下标不变（格子坐标与碰撞数据保持对应），裁切后 trim 界外格子。
 */
function resizeLevel(level, d, apply) {
  const ts = level.tileSize;
  const newW = level.width + d.left + d.right;
  const newH = level.height + d.top + d.bottom;
  if (newW < 1 || newH < 1) return null;

  // 预览：计算每层中与新边界外区域相交且非空的格子
  const removed = []; // {layer, cells:[{x,y}]}
  const tmp = { width: newW, height: newH, tileSize: ts };
  const dxPx = d.left * ts, dyPx = d.top * ts;
  for (const layer of level.layers) {
    const cells = [];
    const nox = layer.originX + dxPx, noy = layer.originY + dyPx; // 平移后的 origin
    const cs = layer.cellSize;
    for (let r = 0; r < layer.rows; r++) {
      for (let c = 0; c < layer.cols; c++) {
        if (!layer.tiles[r * layer.cols + c]) continue;
        const x0 = nox + c * cs, y0 = noy + r * cs;
        const out = x0 < 0 || y0 < 0 ||
                    x0 + cs > tmp.width * ts || y0 + cs > tmp.height * ts;
        if (out) cells.push({ x: c, y: r });
      }
    }
    if (cells.length) removed.push({ layer, cells });
  }

  if (apply) {
    level.width = newW; level.height = newH;
    for (const layer of level.layers) {
      layer.originX += dxPx;
      layer.originY += dyPx;
      trimLayerToLevel(layer, level);
    }
  }
  return { newW, newH, removed };
}

/* 深拷贝关卡（撤销快照 / 序列化共用） */
function cloneLevel(level) {
  return {
    format: level.format, version: level.version, name: level.name,
    tileSize: level.tileSize, width: level.width, height: level.height,
    layers: level.layers.map(l => ({
      ...l,
      tiles: l.tiles.slice(),
    })),
  };
}

/* 深拷贝图块定义（碰撞配置随地图导出） */
function cloneTileDefs() {
  return TILE_DEFS.map(t => ({ ...t, tags: t.tags.slice() }));
}
