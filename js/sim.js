// 确定性模拟核心：固定 120Hz 逻辑步进，与渲染帧率完全解耦。
// 同样的输入事件序列 + 同样的关卡配置 => 逐帧完全一致的位置。

export const TICK_RATE = 120;          // 逻辑帧率（Hz）
export const DT = 1 / TICK_RATE;       // 每步时长（秒）
export const WORLD_W = 480;
export const WORLD_H = 360;
export const PLAYER_SIZE = 24;

export const DIRS = ['up', 'down', 'left', 'right'];

// 内置关卡：障碍布局不同，用于演示“换布局后回放不兼容”
export const LEVELS = [
  {
    id: 'courtyard',
    name: '庭院（默认）',
    speed: 140,
    start: { x: 32, y: 168 },
    obstacles: [
      { x: 160, y: 60,  w: 32, h: 200 },
      { x: 300, y: 120, w: 120, h: 32 },
      { x: 300, y: 240, w: 32, h: 90 },
    ],
  },
  {
    id: 'corridor',
    name: '回廊',
    speed: 140,
    start: { x: 32, y: 32 },
    obstacles: [
      { x: 96,  y: 0,   w: 24, h: 260 },
      { x: 216, y: 100, w: 24, h: 260 },
      { x: 336, y: 0,   w: 24, h: 260 },
    ],
  },
  {
    id: 'pillars',
    name: '柱阵',
    speed: 140,
    start: { x: 40, y: 300 },
    obstacles: [
      { x: 120, y: 80,  w: 40, h: 40 },
      { x: 220, y: 160, w: 40, h: 40 },
      { x: 320, y: 60,  w: 40, h: 40 },
      { x: 360, y: 240, w: 40, h: 40 },
      { x: 140, y: 260, w: 40, h: 40 },
    ],
  },
];

export function getLevel(id) {
  return LEVELS.find(l => l.id === id) || LEVELS[0];
}

// 当前生效的关卡配置（内置关卡 + 用户调过的移速）
export function levelConfig(levelId, speed) {
  const base = getLevel(levelId);
  return {
    id: base.id,
    name: base.name,
    speed,
    start: { ...base.start },
    obstacles: base.obstacles.map(o => ({ ...o })),
  };
}

// 关卡指纹：布局 / 移速 / 起点 / 逻辑帧率 任一变化都会改变
export function levelHash(cfg) {
  const s = JSON.stringify({
    id: cfg.id, speed: cfg.speed, start: cfg.start,
    obstacles: cfg.obstacles, tickRate: TICK_RATE,
  });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

export function createState(cfg) {
  return { x: cfg.start.x, y: cfg.start.y, keys: new Set() };
}

// 应用一条输入事件（在即将从第 t 帧步进到 t+1 帧之前）
export function applyEvent(keys, ev) {
  if (ev.d) keys.add(ev.k); else keys.delete(ev.k);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function overlaps(x, y, o) {
  return x < o.x + o.w && x + PLAYER_SIZE > o.x &&
         y < o.y + o.h && y + PLAYER_SIZE > o.y;
}

// 单轴移动 + AABB 撞墙钳制
function moveAxis(state, cfg, dx, dy) {
  let nx = clamp(state.x + dx, 0, WORLD_W - PLAYER_SIZE);
  let ny = clamp(state.y + dy, 0, WORLD_H - PLAYER_SIZE);
  for (const o of cfg.obstacles) {
    if (!overlaps(nx, ny, o)) continue;
    if (dx > 0) nx = o.x - PLAYER_SIZE;
    else if (dx < 0) nx = o.x + o.w;
    if (dy > 0) ny = o.y - PLAYER_SIZE;
    else if (dy < 0) ny = o.y + o.h;
  }
  state.x = nx;
  state.y = ny;
}

// 推进一个逻辑帧。操作顺序固定 => 浮点结果确定。
export function step(state, cfg) {
  const k = state.keys;
  let dx = (k.has('right') ? 1 : 0) - (k.has('left') ? 1 : 0);
  let dy = (k.has('down') ? 1 : 0) - (k.has('up') ? 1 : 0);
  if (dx !== 0 && dy !== 0) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
  const v = cfg.speed * DT;
  moveAxis(state, cfg, dx * v, 0);
  moveAxis(state, cfg, 0, dy * v);
}
