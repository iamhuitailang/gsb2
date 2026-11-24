import type {
  Allocation,
  Device,
  DeviceSettlement,
  ReplayResult,
  RewardSplit,
  RoundRecord,
  TeamId,
  TrimEvent,
} from './types.ts';
import { TEAM_NAMES } from './types.ts';
import { checksumOf, stableStringify } from './rng.ts';

export const RULES_VERSION = 'repair-lab/2026-11-24.v1';

/** 结算与校验对外的统一错误形状。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function pair(a: number, b: number): Record<TeamId, number> {
  return { A: a, B: b };
}

function copyPair(source: Record<TeamId, number>): Record<TeamId, number> {
  return { A: source.A, B: source.B };
}

export function planTotal(plan: Allocation): number {
  return Object.values(plan).reduce((sum, value) => sum + value, 0);
}

export interface PlanValidation {
  ok: boolean;
  total: number;
  errors: string[];
}

/**
 * 分工合法性：只允许已知设备、非负整数、且本队合计不超过工时预算。
 * 允许 0（某台设备本轮不派人）。
 */
export function validatePlan(devices: readonly Device[], budget: number, plan: Allocation): PlanValidation {
  const errors: string[] = [];
  const known = new Set(devices.map((device) => device.id));
  let total = 0;
  for (const [id, value] of Object.entries(plan)) {
    if (!known.has(id)) errors.push(`未知设备：${id}`);
    if (!Number.isInteger(value)) errors.push(`设备 ${id} 的工时必须是整数`);
    else if (value < 0) errors.push(`设备 ${id} 的工时不能为负`);
    else total += value;
  }
  if (total > budget) errors.push(`合计 ${total} 工时超过本队预算 ${budget}`);
  return { ok: errors.length === 0, total, errors };
}

/** 比较两人数值：返回数值更小的一方；相同则甲队。 */
function smallerSide(a: number, b: number): TeamId {
  if (a < b) return 'A';
  if (b < a) return 'B';
  return 'A';
}

/** 交替计入顺序：先手先放，之后甲乙轮流，直至一方耗尽。 */
function buildOrder(capped: Record<TeamId, number>, first: TeamId): TeamId[] {
  const order: TeamId[] = [];
  const left = copyPair(capped);
  const sequence: TeamId[] = first === 'A' ? ['A', 'B'] : ['B', 'A'];
  while (left.A + left.B > 0) {
    let placed = false;
    for (const side of sequence) {
      if (left[side] > 0) {
        order.push(side);
        left[side] -= 1;
        placed = true;
      }
    }
    if (!placed) break;
  }
  return order;
}

/**
 * 收益分配：
 * - 按双方“有效计入工时”的比例分，先各自向下取整；
 * - 取整后剩余的点数（两队时最多 1 分）给占比余数更大的一方（最大余数法）；
 * - 双方余数正好相同（含有效工时相等、即平手的情形）时，给放下最后一单位（第 severity 个）的收官方。
 *
 * 平手与最后一单位分配因此只有一个判定入口，方便逐条核对。
 */
function splitReward(
  reward: number,
  used: Record<TeamId, number>,
  finisher: TeamId | null,
): RewardSplit {
  const totalUsed = used.A + used.B;
  const exactA = (reward * used.A) / totalUsed;
  const exactB = (reward * used.B) / totalUsed;
  const base = pair(Math.floor(exactA), Math.floor(exactB));
  const leftover = reward - base.A - base.B;
  const fracA = exactA - Math.floor(exactA);
  const fracB = exactB - Math.floor(exactB);
  let remainderTo: TeamId | null = null;
  if (leftover > 0) {
    if (Math.abs(fracA - fracB) > 1e-9) remainderTo = fracA > fracB ? 'A' : 'B';
    else remainderTo = finisher ?? 'A';
  }
  if (remainderTo) base[remainderTo] += leftover;
  return {
    pool: reward,
    base,
    remainder: leftover,
    remainderTo,
    finisher,
  };
}

/** 单台设备的结算。纯函数：同样的输入永远得到同样的输出。 */
export function settleDevice(device: Device, raw: Record<TeamId, number>): DeviceSettlement {
  const rawA = raw.A;
  const rawB = raw.B;
  const rawPair = pair(rawA, rawB);
  const capped = pair(rawA, rawB);
  const steps: string[] = [];
  const trims: TrimEvent[] = [];

  steps.push(
    `${device.name}：${TEAM_NAMES.A}投入 ${rawA}，${TEAM_NAMES.B}投入 ${rawB}；设备上限 ${device.cap}，修复阈值 ${device.severity}，修复收益 ${device.reward}。`,
  );

  const totalRaw = rawA + rawB;
  if (totalRaw > device.cap) {
    const excess = totalRaw - device.cap;
    const straightTie = rawA === rawB;
    let remaining = excess;

    const applyTrim = (side: TeamId, take: number): void => {
      if (take <= 0) return;
      const before = copyPair(capped);
      capped[side] -= take;
      remaining -= take;
      trims.push({
        kind: 'cap',
        side,
        tieBreak: straightTie,
        before,
        after: copyPair(capped),
        limit: device.cap,
      });
      steps.push(
        `${device.name}：合计 ${before.A + before.B} 超过上限 ${device.cap}，作废 ${TEAM_NAMES[side]}的 ${take} 个工时${
          straightTie ? '（平手规则：双方投入相同，固定从乙队先扣）' : '（从投入更多的一方先扣）'
        }。`,
      );
    };

    // 超上限时先从投入更多的一方扣；双方相同（平手）则固定从乙队先扣。
    const trimFirst: TeamId = straightTie ? 'B' : rawA > rawB ? 'A' : 'B';
    const trimSecond: TeamId = trimFirst === 'A' ? 'B' : 'A';
    applyTrim(trimFirst, Math.min(capped[trimFirst], remaining));
    applyTrim(trimSecond, Math.min(capped[trimSecond], remaining));
  }

  const totalCapped = capped.A + capped.B;
  const first = smallerSide(capped.A, capped.B);
  const order = buildOrder(capped, first);
  const counted = Math.min(totalCapped, device.severity);
  const used = pair(0, 0);
  for (let i = 0; i < counted; i += 1) {
    const side = order[i] as TeamId;
    used[side] += 1;
  }
  const overRepair = pair(capped.A - used.A, capped.B - used.B);
  const repaired = counted >= device.severity && device.severity > 0;
  const finisher: TeamId | null = repaired ? (order[device.severity - 1] as TeamId) : null;

  if (totalCapped === 0) {
    steps.push(`${device.name}：双方都没有派工，进度 0 / ${device.severity}。`);
  } else if (repaired) {
    steps.push(
      `${device.name}：作废后剩 ${totalCapped} 个。先手为${TEAM_NAMES[first]}（投入较少者先计入，相同则甲队），交替顺序为 ${order
        .map((side) => TEAM_NAMES[side])
        .join(' → ')}。`,
    );
    steps.push(
      `${device.name}：前 ${device.severity} 个计入修复，第 ${device.severity} 个单位由${TEAM_NAMES[finisher as TeamId]}放下，设备修复。有效工时 ${TEAM_NAMES.A} ${used.A} / ${TEAM_NAMES.B} ${used.B}。`,
    );
    if (overRepair.A + overRepair.B > 0) {
      steps.push(
        `${device.name}：超出修复阈值的 ${overRepair.A + overRepair.B} 个单位属于超额维修，不计分（${TEAM_NAMES.A} ${overRepair.A}，${TEAM_NAMES.B} ${overRepair.B}）。`,
      );
    }
  } else {
    const missing = device.severity - totalCapped;
    steps.push(
      `${device.name}：作废后合计 ${totalCapped} 个，距修复阈值 ${device.severity} 还差 ${missing} 个，本轮未修复，双方 0 分。`,
    );
  }

  const tie = repaired && used.A === used.B && used.A > 0;
  let rewardSplit: RewardSplit | null = null;
  const awarded = pair(0, 0);

  if (repaired && used.A + used.B > 0) {
    rewardSplit = splitReward(device.reward, used, finisher);
    awarded.A = rewardSplit.base.A;
    awarded.B = rewardSplit.base.B;
    if (tie) {
      steps.push(
        `${device.name}：双方有效工时相同（各 ${used.A} 个），按平手规则均分 ${device.reward} 分；${
          device.reward % 2 === 1 ? `奇数余 1 分给放下最后一单位的${TEAM_NAMES[finisher as TeamId]}` : '无需再分余数'
        }。`,
      );
    } else {
      steps.push(
        `${device.name}：按有效工时比例分配 ${device.reward} 分${
          rewardSplit.remainder > 0
            ? `，余数 ${rewardSplit.remainder} 分给${TEAM_NAMES[rewardSplit.remainderTo as TeamId]}`
            : ''
        }。`,
      );
    }
    steps.push(`${device.name}：${TEAM_NAMES.A}得 ${awarded.A} 分，${TEAM_NAMES.B}得 ${awarded.B} 分。`);
  }

  return {
    deviceId: device.id,
    name: device.name,
    severity: device.severity,
    cap: device.cap,
    reward: device.reward,
    raw: rawPair,
    capped,
    used,
    trimmed: pair(rawA - capped.A, rawB - capped.B),
    overRepair,
    progress: counted,
    repaired,
    first,
    order,
    counted,
    finisher,
    rewardPool: device.reward,
    rewardSplit,
    awarded,
    tie,
    tieTrimUsed: trims.some((trim) => trim.tieBreak),
    trims,
    steps,
  };
}

export interface SettleRoundInput {
  round: number;
  seed: string;
  budget: number;
  devices: readonly Device[];
  plans: Record<TeamId, Allocation>;
  submittedAt: Record<TeamId, number>;
  settledAt: number;
}

function roundTotals(settlements: readonly DeviceSettlement[]): Record<TeamId, number> {
  const totals = pair(0, 0);
  for (const settlement of settlements) {
    totals.A += settlement.awarded.A;
    totals.B += settlement.awarded.B;
  }
  return totals;
}

export function roundChecksum(input: {
  round: number;
  seed: string;
  budget: number;
  devices: readonly Device[];
  plans: Record<TeamId, Allocation>;
  settlements: readonly DeviceSettlement[];
  totals: Record<TeamId, number>;
}): string {
  return checksumOf({
    rulesVersion: RULES_VERSION,
    round: input.round,
    seed: input.seed,
    budget: input.budget,
    devices: input.devices,
    plans: input.plans,
    settlements: input.settlements,
    totals: input.totals,
  });
}

export function recordId(round: number, checksum: string): string {
  return `R${round}-${checksum.slice(0, 8)}`;
}

/**
 * 结算整轮：逐台设备套用同一规则，合计双方得分，生成可独立校验的记录。
 * 结果只依赖 seed / devices / plans，与调用次数、时钟、UI 状态无关。
 */
export function settleRound(input: SettleRoundInput): RoundRecord {
  const settlements = input.devices.map((device) =>
    settleDevice(device, {
      A: input.plans.A[device.id] ?? 0,
      B: input.plans.B[device.id] ?? 0,
    }),
  );
  const totals = roundTotals(settlements);
  const checksum = roundChecksum({ ...input, settlements, totals });
  return {
    id: recordId(input.round, checksum),
    round: input.round,
    seed: input.seed,
    budget: input.budget,
    devices: input.devices.map((device) => ({ ...device })),
    plans: {
      A: { ...input.plans.A },
      B: { ...input.plans.B },
    },
    settlements,
    totals,
    submittedAt: { ...input.submittedAt },
    settledAt: input.settledAt,
    rulesVersion: RULES_VERSION,
    checksum,
  };
}

/**
 * 用同一份已结算记录重播：只读取记录里的 seed / devices / plans，
 * 重新跑结算并与记录中的分值、逐台明细、校验值比较。
 */
export function replayRecord(record: RoundRecord): ReplayResult {
  const replayed = settleRound({
    round: record.round,
    seed: record.seed,
    budget: record.budget,
    devices: record.devices,
    plans: record.plans,
    submittedAt: record.submittedAt,
    settledAt: record.settledAt,
  });
  const checksumMatches = replayed.checksum === record.checksum;
  const totalsMatch = replayed.totals.A === record.totals.A && replayed.totals.B === record.totals.B;
  const settlementsMatch = stableStringify(replayed.settlements) === stableStringify(record.settlements);
  return {
    matches: checksumMatches && totalsMatch && settlementsMatch,
    checksumMatches,
    totalsMatch,
    settlementsMatch,
    replayed,
    comparison: `${TEAM_NAMES.A} ${replayed.totals.A} : ${replayed.totals.B} ${TEAM_NAMES.B}`,
  };
}

/** 外部记录进入历史前先校验结构，并用重播确认分值自洽。 */
export function verifyRecord(record: RoundRecord): Result<RoundRecord> {
  if (!record || typeof record !== 'object') return { ok: false, error: '记录不是对象' };
  if (!record.id || !record.seed || !Array.isArray(record.devices) || !Array.isArray(record.settlements)) {
    return { ok: false, error: '记录缺少必要字段' };
  }
  if (!record.plans?.A || !record.plans?.B) return { ok: false, error: '记录缺少双方投入' };
  if (record.rulesVersion !== RULES_VERSION) {
    return { ok: false, error: `规则版本不匹配：记录为 ${String(record.rulesVersion)}，当前为 ${RULES_VERSION}` };
  }
  const replay = replayRecord(record);
  if (!replay.matches) {
    return {
      ok: false,
      error: `记录校验失败：录入 ${TEAM_NAMES.A} ${record.totals?.A} / ${TEAM_NAMES.B} ${record.totals?.B}，重播得到 ${replay.comparison}`,
    };
  }
  return { ok: true, value: record };
}
