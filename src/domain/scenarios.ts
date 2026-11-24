import type { Device, PresetKey, ScenarioDefinition } from './types.ts';
import { createRng, randomInt } from './rng.ts';

const RANDOM_NAMES = [
  '主泵站',
  '冷却阀组',
  '伺服电机',
  '中控台',
  '传送带',
  '液压臂',
  '配电柜',
  '传感器阵列',
] as const;

/**
 * 由种子生成设备故障分布。
 * 只在创建轮次时调用；生成结果会写进存档，恢复时不会重新抽取。
 */
export function generateDevices(seed: string, count = 4): Device[] {
  const rng = createRng(`${seed}:devices`);
  const names = [...RANDOM_NAMES];
  for (let i = names.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = names[i] as string;
    const b = names[j] as string;
    names[i] = b;
    names[j] = a;
  }
  const devices: Device[] = [];
  for (let i = 0; i < count; i += 1) {
    const severity = randomInt(rng, 2, 5);
    devices.push({
      id: `d${i + 1}`,
      name: names[i % names.length] ?? `设备 ${i + 1}`,
      severity,
      // 上限不低于阈值，保证“双方都投入”时理论可修。
      cap: severity + randomInt(rng, 0, 2),
      reward: severity * 2 + randomInt(rng, 0, 3),
    });
  }
  return devices;
}

const CONTESTED: ScenarioDefinition = {
  key: 'contested',
  name: '竞争同一设备',
  summary:
    '两队都把工时压在“主泵站”和“控制台”上：主泵站会触发超额维修和平手，控制台会撞上设备上限并触发平手扣减。',
  budget: 6,
  devices: [
    { id: 'm1', name: '主泵站', severity: 4, cap: 5, reward: 10 },
    { id: 'm2', name: '冷却阀', severity: 3, cap: 3, reward: 7 },
    { id: 'm3', name: '伺服电机', severity: 5, cap: 6, reward: 12 },
    { id: 'm4', name: '控制台', severity: 2, cap: 3, reward: 7 },
  ],
  examplePlans: {
    A: { m1: 3, m2: 1, m3: 0, m4: 2 },
    B: { m1: 2, m2: 1, m3: 1, m4: 2 },
  },
  exampleNote:
    '甲队 6 工时 / 乙队 6 工时。主泵站：两队共投 5 个，正好等于上限 5，无需作废；投入较少的乙队先放，交替顺序为 乙甲乙甲甲，前 4 个计入，双方各 2 个有效单位，平手各得 5 分，甲队多出的 1 个属于超额维修、不计分。控制台：2 + 2 = 4 超过上限 3，按平手规则从乙队扣 1 个；交替顺序 乙甲，双方各 1 个有效单位，7 分向下取整后余 1 分给放下最后一单位的甲队，即 4 / 3。冷却阀与伺服电机都未达到修复阈值，双方 0 分。总分 9 : 8。',
};

const ONE_SHORT: ScenarioDefinition = {
  key: 'one-short',
  name: '两方都少分一单位',
  summary:
    '每队预算 4 工时，但都只派出 3 个：备用泵停在 2 / 3，双方都拿不到 9 分。其余两台设备刚好卡到阈值，平手平分。',
  budget: 4,
  devices: [
    { id: 'n1', name: '备用泵', severity: 3, cap: 4, reward: 9 },
    { id: 'n2', name: '传动机', severity: 2, cap: 2, reward: 6 },
    { id: 'n3', name: '配电柜', severity: 2, cap: 3, reward: 8 },
  ],
  examplePlans: {
    A: { n1: 1, n2: 1, n3: 1 },
    B: { n1: 1, n2: 1, n3: 1 },
  },
  exampleNote:
    '两队都各留了 1 个工时没派。备用泵合计 2 个，距修复阈值 3 还差 1 个，本轮双方都是 0 分；传动机和配电柜卡到阈值，双方平手各得 3 分和 4 分，总分 7 : 7。',
};

const RANDOM: ScenarioDefinition = {
  key: 'random',
  name: '固定种子随机分布',
  summary:
    '按种子生成本轮设备故障程度、工时上限和修复收益。同一份存档恢复后不会重新抽取；同一 base seed 的每一轮分布可复现。',
  budget: 6,
  devices: null,
};

export const SCENARIOS: Record<PresetKey, ScenarioDefinition> = {
  contested: CONTESTED,
  'one-short': ONE_SHORT,
  random: RANDOM,
};

export const SCENARIO_ORDER: readonly PresetKey[] = ['contested', 'one-short', 'random'];

/** 固定场景自带的示例分工；随机场景没有。 */
export function examplePlanFor(
  preset: PresetKey,
  team: 'A' | 'B',
  devices: readonly Device[],
): Record<string, number> | null {
  const scenario = SCENARIOS[preset];
  if (!scenario.devices || !scenario.examplePlans) return null;
  const sameShape =
    scenario.devices.length === devices.length &&
    scenario.devices.every((device, index) => device.id === devices[index]?.id);
  if (!sameShape) return null;
  return { ...scenario.examplePlans[team] };
}

export function scenarioDevicesFor(preset: PresetKey, seed: string): Device[] {
  const scenario = SCENARIOS[preset];
  if (scenario.devices) return scenario.devices.map((device) => ({ ...device }));
  return generateDevices(seed);
}
