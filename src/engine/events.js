// 事件类型、动作类型与规则预设常量。

export const EVENT = Object.freeze({
  ENTER: 'enter',
  EXIT: 'exit',
  STAY: 'stay',
});

export const EVENT_LABEL = Object.freeze({
  enter: '进入',
  exit: '退出',
  stay: '停留',
});

export const ACTION = Object.freeze({
  WALK: 'walk',
  TELEPORT: 'teleport',
  DASH: 'dash',
  IDLE: 'idle',
});

export const ACTION_LABEL = Object.freeze({
  walk: '步行',
  teleport: '瞬移',
  dash: '高速穿过',
  idle: '静止',
});

// 单区域动作规则：每个动作在“进入 / 停留”阶段是否算数。
// 退出永远算数（否则状态机会与实际几何位置不一致）。
// teleport.land 只决定瞬移落点在区内时是否发进入；
// 瞬移起点在区内时是否发退出由 teleport.exit 决定。
export const POLICY_FIELDS = [
  'walk',
  'teleportLand',
  'teleportExit',
  'dash',
];

// 严格预设：只有正常步行/静止才触发；瞬移与高速穿过一律不算。
export const RULES_STRICT = Object.freeze({
  id: 'strict',
  name: '严格（只认步行）',
  walk: true,
  teleportLand: false,
  teleportExit: true,
  dash: false,
  dashSampleStep: 12,
});

// 宽松预设：任何动作经过都算；高速穿过按固定步长采样判定是否真的经过区域。
export const RULES_LENIENT = Object.freeze({
  id: 'lenient',
  name: '宽松（动作皆算，dash 采样）',
  walk: true,
  teleportLand: true,
  teleportExit: true,
  dash: true,
  dashSampleStep: 12,
});

export function normalizeRules(rules) {
  const base = { ...RULES_STRICT, ...rules };
  for (const f of POLICY_FIELDS) {
    if (typeof base[f] !== 'boolean') base[f] = !!base[f];
  }
  if (!(base.dashSampleStep > 0)) base.dashSampleStep = 12;
  return base;
}
