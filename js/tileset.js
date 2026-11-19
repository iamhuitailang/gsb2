/* 图块定义、碰撞形状、标签与程序化图集渲染 */
'use strict';

const COLLISION_SHAPES = ['none', 'full', 'half-top', 'half-bottom', 'half-left', 'half-right', 'slope-up', 'slope-down'];
const COLLISION_SHAPE_NAMES = {
  'none': '无', 'full': '完整方块', 'half-top': '上半', 'half-bottom': '下半',
  'half-left': '左半', 'half-right': '右半', 'slope-up': '斜坡 /', 'slope-down': '斜坡 \\',
};
const KNOWN_TAGS = ['solid', 'one-way', 'hazard', 'ladder', 'water', 'decoration'];
const TAG_NAMES = {
  solid: '实体', 'one-way': '单向平台', hazard: '伤害',
  ladder: '梯子', water: '水体', decoration: '装饰',
};

/* id 0 固定为空图块。collision/tags 可在编辑器中修改并随地图导出。 */
const TILE_DEFS = [
  { id: 0,  name: '空',     color: null,       collision: 'none',        tags: [] },
  { id: 1,  name: '草地',   color: '#4caf50',  collision: 'full',        tags: ['solid'] },
  { id: 2,  name: '泥土',   color: '#8d6e63',  collision: 'full',        tags: ['solid'] },
  { id: 3,  name: '石块',   color: '#9e9e9e',  collision: 'full',        tags: ['solid'] },
  { id: 4,  name: '砖块',   color: '#c0543c',  collision: 'full',        tags: ['solid'] },
  { id: 5,  name: '木平台', color: '#c8956c',  collision: 'half-top',    tags: ['one-way'] },
  { id: 6,  name: '金属块', color: '#78909c',  collision: 'full',        tags: ['solid'] },
  { id: 7,  name: '尖刺',   color: '#cfd8dc',  collision: 'half-bottom', tags: ['hazard'] },
  { id: 8,  name: '水',     color: '#2196f3',  collision: 'none',        tags: ['water'] },
  { id: 9,  name: '梯子',   color: '#a1887f',  collision: 'none',        tags: ['ladder'] },
  { id: 10, name: '云',     color: '#eceff1',  collision: 'none',        tags: ['decoration'] },
  { id: 11, name: '箱子',   color: '#ffb300',  collision: 'full',        tags: ['solid'] },
  { id: 12, name: '斜坡/',  color: '#7e57c2',  collision: 'slope-up',    tags: ['solid'] },
  { id: 13, name: '斜坡\\', color: '#5e35b1',  collision: 'slope-down',  tags: ['solid'] },
  { id: 14, name: '远山',   color: '#546e7a',  collision: 'none',        tags: ['decoration'] },
  { id: 15, name: '花',     color: '#e91e63',  collision: 'none',        tags: ['decoration'] },
];

const TILE_SRC_SIZE = 32; // 图集中每块的像素尺寸

function tileDef(id) {
  return TILE_DEFS.find(t => t.id === id) || null;
}

/* 程序化绘制整张贴图，返回 canvas；每个图块一行一个，按 id 排列 */
function buildTilesetCanvas() {
  const cv = document.createElement('canvas');
  cv.width = TILE_SRC_SIZE;
  cv.height = TILE_SRC_SIZE * TILE_DEFS.length;
  const ctx = cv.getContext('2d');
  for (const def of TILE_DEFS) {
    if (!def.color) continue;
    drawTile(ctx, def, 0, def.id * TILE_SRC_SIZE, TILE_SRC_SIZE);
  }
  return cv;
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * f)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * f)));
  return `rgb(${r},${g},${b})`;
}

function drawTile(ctx, def, x, y, s) {
  const c = def.color;
  // 实心方块类整格填充；造型类（尖刺/云/山/花/梯子）保留透明背景
  const SOLID_FILL = [1, 2, 3, 4, 5, 6, 8, 11, 12, 13];
  if (SOLID_FILL.includes(def.id)) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, s, s);
  }
  const u = s / 8; // 以 8x8 逻辑单位绘制细节
  ctx.fillStyle = shade(c, 0.75);
  switch (def.id) {
    case 1: // 草地：顶部亮绿
      ctx.fillStyle = shade(c, 1.25); ctx.fillRect(x, y, s, 2 * u);
      ctx.fillStyle = shade(c, 0.8);
      ctx.fillRect(x + u, y + 4 * u, u, u); ctx.fillRect(x + 5 * u, y + 6 * u, u, u);
      break;
    case 2: // 泥土：杂点
      ctx.fillRect(x + u, y + u, u, u); ctx.fillRect(x + 5 * u, y + 3 * u, u, u);
      ctx.fillRect(x + 3 * u, y + 6 * u, u, u);
      break;
    case 3: // 石块：边框
      ctx.strokeStyle = shade(c, 0.7); ctx.lineWidth = u;
      ctx.strokeRect(x + u / 2, y + u / 2, s - u, s - u);
      break;
    case 4: // 砖块：砖缝
      ctx.fillRect(x, y + 3.5 * u, s, u); ctx.fillRect(x, y + 7.5 * u, s, u / 2);
      ctx.fillRect(x + 3.5 * u, y, u, 3.5 * u); ctx.fillRect(x + 1.5 * u, y + 4.5 * u, u, 3 * u);
      ctx.fillRect(x + 5.5 * u, y + 4.5 * u, u, 3 * u);
      break;
    case 5: // 木平台：上半木板
      ctx.fillRect(x, y + 3 * u, s, u);
      ctx.fillStyle = shade(c, 1.2); ctx.fillRect(x, y, s, 3 * u);
      break;
    case 6: // 金属：铆钉
      ctx.fillRect(x + u, y + u, u, u); ctx.fillRect(x + 6 * u, y + u, u, u);
      ctx.fillRect(x + u, y + 6 * u, u, u); ctx.fillRect(x + 6 * u, y + 6 * u, u, u);
      break;
    case 7: // 尖刺
      ctx.fillStyle = c;
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * 2 * u, y + s);
        ctx.lineTo(x + (i * 2 + 1) * u, y + 2 * u);
        ctx.lineTo(x + (i * 2 + 2) * u, y + s);
        ctx.fill();
      }
      break;
    case 8: // 水：波浪线
      ctx.fillStyle = shade(c, 1.4);
      ctx.fillRect(x, y + u, 2 * u, u); ctx.fillRect(x + 3 * u, y + 2 * u, 2 * u, u);
      ctx.fillRect(x + 6 * u, y + u, 2 * u, u);
      break;
    case 9: // 梯子
      ctx.fillRect(x + u, y, u, s); ctx.fillRect(x + 6 * u, y, u, s);
      for (let i = 1; i < 4; i++) ctx.fillRect(x + u, y + i * 2 * u, 6 * u, u);
      break;
    case 10: // 云
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(x + 3 * u, y + 5 * u, 2.5 * u, 0, 7);
      ctx.arc(x + 5.5 * u, y + 4 * u, 2 * u, 0, 7);
      ctx.fill();
      break;
    case 11: // 箱子：X 纹
      ctx.strokeStyle = shade(c, 0.7); ctx.lineWidth = u;
      ctx.strokeRect(x + u / 2, y + u / 2, s - u, s - u);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y); ctx.lineTo(x, y + s); ctx.stroke();
      break;
    case 12: // 斜坡 /
      ctx.beginPath(); ctx.moveTo(x, y + s); ctx.lineTo(x + s, y); ctx.lineTo(x + s, y + s); ctx.fill();
      break;
    case 13: // 斜坡 \
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y + s); ctx.lineTo(x, y + s); ctx.fill();
      break;
    case 14: // 远山：三角
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.moveTo(x, y + s); ctx.lineTo(x + 4 * u, y + u); ctx.lineTo(x + s, y + s); ctx.fill();
      break;
    case 15: // 花
      ctx.fillStyle = '#4caf50'; ctx.fillRect(x + 3.5 * u, y + 4 * u, u, 4 * u);
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(x + 4 * u, y + 3 * u, 2 * u, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffeb3b';
      ctx.beginPath(); ctx.arc(x + 4 * u, y + 3 * u, u, 0, 7); ctx.fill();
      break;
    default:
      ctx.fillStyle = shade(c, 0.8);
      ctx.fillRect(x + u, y + u, s - 2 * u, s - 2 * u);
  }
}

/* 碰撞形状在某个格子内的绘制路径（用于碰撞覆盖层与缩略图） */
function collisionShapePath(ctx, shape, x, y, w, h) {
  ctx.beginPath();
  switch (shape) {
    case 'full':        ctx.rect(x, y, w, h); break;
    case 'half-top':    ctx.rect(x, y, w, h / 2); break;
    case 'half-bottom': ctx.rect(x, y + h / 2, w, h / 2); break;
    case 'half-left':   ctx.rect(x, y, w / 2, h); break;
    case 'half-right':  ctx.rect(x + w / 2, y, w / 2, h); break;
    case 'slope-up':
      ctx.moveTo(x, y + h); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + h); ctx.closePath();
      break;
    case 'slope-down':
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
      break;
    default: return false;
  }
  return true;
}
