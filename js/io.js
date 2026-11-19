/* 导入 / 导出 / 本地存储 */
'use strict';

const STORAGE_KEY = 'gsb2-level-autosave';

/* 导出为纯 JSON 对象：包含图层顺序、图块编号、碰撞配置与关卡尺寸 */
function serializeLevel(level) {
  return {
    format: 'gsb2-level',
    version: 1,
    name: level.name,
    tileSize: level.tileSize,
    width: level.width,
    height: level.height,
    layers: level.layers.map(l => ({
      id: l.id,
      name: l.name,
      cellSize: l.cellSize,
      origin: [l.originX, l.originY],
      cols: l.cols,
      rows: l.rows,
      visible: l.visible,
      opacity: l.opacity,
      tiles: l.tiles.slice(), // 行优先，0 = 空
    })),
    tileset: {
      srcSize: TILE_SRC_SIZE,
      tiles: cloneTileDefs().map(t => ({
        id: t.id, name: t.name, color: t.color,
        collision: t.collision, tags: t.tags,
      })),
    },
  };
}

/* 校验并还原关卡。返回 {level, errors[]}，level 为 null 表示致命错误。 */
function deserializeLevel(data) {
  const errors = [];
  const fail = msg => { errors.push(msg); };
  if (!data || typeof data !== 'object') { fail('不是有效的 JSON 对象'); return { level: null, errors }; }
  if (data.format !== 'gsb2-level') fail(`format 应为 "gsb2-level"，实际为 ${JSON.stringify(data.format)}`);
  if (!Number.isInteger(data.width) || data.width < 1) fail('width 必须是正整数');
  if (!Number.isInteger(data.height) || data.height < 1) fail('height 必须是正整数');
  if (!Number.isInteger(data.tileSize) || data.tileSize < 1) fail('tileSize 必须是正整数');
  if (!Array.isArray(data.layers) || data.layers.length === 0) fail('layers 必须是非空数组');
  if (errors.length) return { level: null, errors };

  const level = createLevel(data.name || '未命名关卡', data.tileSize, data.width, data.height);
  const maxTileId = Math.max(...TILE_DEFS.map(t => t.id));
  const seenIds = new Set();

  data.layers.forEach((ld, i) => {
    const where = `图层[${i}]`;
    if (!Number.isInteger(ld.cellSize) || ld.cellSize < 1) { fail(`${where} cellSize 非法`); return; }
    if (!Number.isInteger(ld.cols) || !Number.isInteger(ld.rows) || ld.cols < 0 || ld.rows < 0) { fail(`${where} cols/rows 非法`); return; }
    if (!Array.isArray(ld.tiles) || ld.tiles.length !== ld.cols * ld.rows) { fail(`${where} tiles 长度 ${ld.tiles && ld.tiles.length} 与 cols*rows (${ld.cols * ld.rows}) 不符`); return; }
    const layer = createLayer(String(ld.name ?? where), ld.cellSize);
    if (ld.id) {
      if (seenIds.has(ld.id)) fail(`${where} id 重复: ${ld.id}`);
      seenIds.add(ld.id);
      layer.id = String(ld.id);
    }
    const [ox, oy] = Array.isArray(ld.origin) ? ld.origin : [0, 0];
    layer.originX = Number.isFinite(ox) ? ox : 0;
    layer.originY = Number.isFinite(oy) ? oy : 0;
    layer.cols = ld.cols; layer.rows = ld.rows;
    layer.visible = ld.visible !== false;
    layer.opacity = Number.isFinite(ld.opacity) ? Math.min(1, Math.max(0, ld.opacity)) : 1;
    layer.tiles = ld.tiles.map(t => {
      if (!Number.isInteger(t) || t < 0) { fail(`${where} 含非法图块编号 ${t}`); return 0; }
      if (t > maxTileId) fail(`${where} 图块编号 ${t} 超出图集范围`);
      return t;
    });
    level.layers.push(layer);
  });

  // 恢复图块碰撞配置
  if (data.tileset && Array.isArray(data.tileset.tiles)) {
    for (const td of data.tileset.tiles) {
      const def = tileDef(td.id);
      if (!def) { fail(`tileset 中未知图块 id ${td.id}`); continue; }
      if (COLLISION_SHAPES.includes(td.collision)) def.collision = td.collision;
      else if (td.collision !== undefined) fail(`图块 ${td.id} 碰撞形状非法: ${td.collision}`);
      if (Array.isArray(td.tags)) def.tags = td.tags.filter(t => typeof t === 'string');
    }
  }
  if (errors.length) return { level: null, errors };
  return { level, errors };
}

function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveToLocal(level) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeLevel(level))); }
  catch (e) { /* 存储满等异常忽略 */ }
}

function loadFromLocal() {
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    return s ? deserializeLevel(JSON.parse(s)) : null;
  } catch (e) { return null; }
}
