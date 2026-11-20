// 植被规则：每种模型一条规则，描述出现比例、密度、间距、随机范围与环境约束。
// 规则是纯数据，可序列化；评估函数不依赖渲染层，便于测试。

let nextRuleId = 1;

export function createRule(partial = {}) {
  return {
    id: partial.id ?? `rule_${nextRuleId++}`,
    name: partial.name ?? '新植物',
    kind: partial.kind ?? 'tree', // tree | grass | rock
    color: partial.color ?? 0x3f8f4f,
    enabled: partial.enabled ?? true,
    weight: partial.weight ?? 1, // 出现比例（相对权重，层内归一化）
    density: partial.density ?? 0.15, // 每平方米期望实例数
    spacing: partial.spacing ?? 1.5, // 与任何实例的最小中心间距（米）
    rotation: { min: 0, max: 360, ...(partial.rotation ?? {}) }, // Y 轴随机旋转（度）
    scale: { min: 0.8, max: 1.3, ...(partial.scale ?? {}) }, // 均匀随机缩放
    tiltMax: partial.tiltMax ?? 10, // 贴合地形法线允许的最大倾斜（度）
    heightRange: partial.heightRange ?? [-Infinity, Infinity], // 海拔约束（米）
    slopeRange: partial.slopeRange ?? [0, 35], // 坡度约束（度）
    maskThreshold: partial.maskThreshold ?? 0, // 遮罩低于该值不生成；0 表示忽略遮罩
    maskInvert: partial.maskInvert ?? false,
  };
}

export function DEFAULT_RULES() {
  return [
    createRule({
      id: 'pine', name: '针叶树', kind: 'tree', color: 0x2f6b43,      weight: 6, density: 0.08, spacing: 2.4,
      scale: { min: 0.9, max: 1.6 }, tiltMax: 8,
      heightRange: [-40, 40], slopeRange: [0, 28], maskThreshold: 0,
    }),
    createRule({
      id: 'broadleaf', name: '阔叶树', kind: 'tree', color: 0x5ea23f,
      weight: 4, density: 0.06, spacing: 2.0,
      scale: { min: 0.8, max: 1.4 }, tiltMax: 12,
      heightRange: [-40, 40], slopeRange: [0, 22],
    }),
    createRule({
      id: 'grass', name: '草丛', kind: 'grass', color: 0x7cbf52,
      weight: 10, density: 0.55, spacing: 0.45,
      rotation: { min: 0, max: 360 }, scale: { min: 0.7, max: 1.6 }, tiltMax: 25,
      slopeRange: [0, 40],
    }),
    createRule({
      id: 'fern', name: '蕨类', kind: 'grass', color: 0x4f9e5c,
      weight: 5, density: 0.3, spacing: 0.6,
      scale: { min: 0.6, max: 1.2 }, tiltMax: 20, slopeRange: [0, 35],
    }),
    createRule({
      id: 'rock', name: '岩石', kind: 'rock', color: 0x8d8a82,
      weight: 2, density: 0.04, spacing: 1.1,
      rotation: { min: 0, max: 360 }, scale: { min: 0.6, max: 1.8 },
      tiltMax: 35, slopeRange: [0, 45],
    }),
  ];
}

/** 规则是否通过环境约束。maskValue 由调用方采样。 */
export function ruleAcceptsEnvironment(rule, env) {
  if (!rule.enabled) return false;
  if (env.height < rule.heightRange[0] || env.height > rule.heightRange[1]) return false;
  if (env.slope < rule.slopeRange[0] || env.slope > rule.slopeRange[1]) return false;
  if (rule.maskThreshold > 0) {
    const pass = rule.maskInvert
      ? env.mask < rule.maskThreshold
      : env.mask >= rule.maskThreshold;
    if (!pass) return false;
  }
  return true;
}

/**
 * 按权重确定性挑选规则。
 * @param {Array} rules 已通过环境约束的候选
 * @param {number} r [0,1) 随机数
 * @returns 选中的规则或 null
 */
export function pickWeightedRule(rules, r) {
  if (rules.length === 0) return null;
  const total = rules.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (total <= 0) return null;
  let target = r * total;
  for (const rule of rules) {
    target -= Math.max(0, rule.weight);
    if (target < 0) return rule;
  }
  return rules[rules.length - 1];
}

// JSON 不能表示 ±Infinity（会序列化成 null），用有限哨兵值存档，读取时还原
const RANGE_SENTINEL = 1e9;

/** 把规则转成可安全 JSON.stringify 的普通对象。 */
export function ruleToJSON(rule) {
  const json = structuredClone(rule);
  json.heightRange = rule.heightRange.map((v) =>
    v === Infinity ? RANGE_SENTINEL : v === -Infinity ? -RANGE_SENTINEL : v,
  );
  return json;
}

/** 从存档恢复规则，哨兵值还原为 ±Infinity。 */
export function ruleFromJSON(json) {
  const rule = createRule(json);
  rule.heightRange = json.heightRange.map((v) =>
    v >= RANGE_SENTINEL ? Infinity : v <= -RANGE_SENTINEL ? -Infinity : v,
  );
  return rule;
}
