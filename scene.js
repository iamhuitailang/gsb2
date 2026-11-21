// scene.js —— 内置演示场景：两级移动平台 + 两扇定时门
// 坐标为侧视图逻辑坐标（像素），canvas 渲染时整体缩放。
// 换乘点（dock）与平台端点重合，角色在停靠窗口内原地登/下车。

export const demoScene = {
  name: '两级平台双闸门演示',
  walkSpeed: 60, // 角色平地速度 px/s
  points: [
    { id: 'start', name: '出发点', x: 60, y: 420, kind: 'start' },
    { id: 'waitA', name: '一层等待点', x: 200, y: 420, kind: 'wait' },
    { id: 'p1top', name: '一层换乘台', x: 300, y: 280, kind: 'dock' },
    { id: 'p2top', name: '二层换乘台', x: 720, y: 160, kind: 'dock' },
    { id: 'goal', name: '终点', x: 920, y: 160, kind: 'goal' },
  ],
  platforms: [
    {
      id: 'p1', name: '下层升降平台',
      ax: 300, ay: 420, bx: 300, by: 280, // A 端接地面，B 端=一层换乘台
      period: 10, dwellA: 0.8, dwellB: 0.8, phase: 0,
    },
    {
      id: 'p2', name: '上层平移平台',
      ax: 300, ay: 160, bx: 720, by: 160, // A 端=一层换乘台上方，B 端=二层换乘台
      period: 12, dwellA: 0.8, dwellB: 0.8, phase: 0,
    },
  ],
  doors: [
    {
      id: 'd1', name: '一道门',
      x: 250, y: 380, w: 14, h: 48,
      period: 8, dwellA: 5, dwellB: 3, phase: 0, // 开门 [0,3)
    },
    {
      id: 'd2', name: '二道门（硬闸门）',
      x: 840, y: 120, w: 14, h: 48,
      period: 8, dwellA: 3.5, dwellB: 4.5, phase: 0,
    },
  ],
  // 策划路线：走 → 等 → 搭两台 → 过两道门
  route: [
    { type: 'walk', to: 'waitA', waitForDoor: ['d1'], allowWait: true },
    { type: 'wait', point: 'waitA', duration: 0.5 },
    { type: 'ride', platform: 'p1', to: 'p1top', side: 'A' },
    { type: 'ride', platform: 'p2', to: 'p2top', side: 'A' },
    { type: 'walk', to: 'goal', waitForDoor: ['d2'], allowWait: false },
  ],
  horizon: 60,
};

// 救回方案：路线完全不动，只把上层平台的起始相位挪 1s，
// 使平台到港时刻提前，角色能在硬闸门关闭前通过（基线 51.5% -> 100%）。
export const rescuePatch = {
  platforms: {
    p2: { phase: 1.0 },
  },
};

// 深拷贝场景，便于 UI 编辑与基线快照
export function cloneScene(scene) {
  return JSON.parse(JSON.stringify(scene));
}

export function applyPatch(scene, patch) {
  const next = cloneScene(scene);
  if (patch?.platforms) {
    for (const [id, fields] of Object.entries(patch.platforms)) {
      const ent = next.platforms.find((p) => p.id === id);
      if (ent) Object.assign(ent, fields);
    }
  }
  if (patch?.doors) {
    for (const [id, fields] of Object.entries(patch.doors)) {
      const ent = next.doors.find((d) => d.id === id);
      if (ent) Object.assign(ent, fields);
    }
  }
  return next;
}
