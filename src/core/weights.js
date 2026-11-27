/**
 * Pure weight planning and editing helpers.
 * These functions never mutate their inputs, which makes single-vertex fixes
 * and lock/normalization behaviour straightforward to test.
 */

export const WEIGHT_EPS = 1e-6;
export const SUM_EPS = 1e-5;

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function roundWeight(value, digits = 4) {
  const f = 10 ** digits;
  return Math.round((value + Number.EPSILON) * f) / f;
}

export function getInfluences(vertex) {
  return Array.isArray(vertex?.influences) ? vertex.influences : [];
}

export function getLocks(vertex) {
  return vertex?.locks && typeof vertex.locks === 'object' ? vertex.locks : {};
}

export function isLocked(vertex, boneIndex) {
  return Object.prototype.hasOwnProperty.call(getLocks(vertex), String(boneIndex));
}

export function lockedValue(vertex, boneIndex) {
  const locks = getLocks(vertex);
  const raw = locks[boneIndex] ?? locks[String(boneIndex)];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Summarize raw and locked weight state. Lock keys are normalized to numbers
 * where possible by planNormalization.
 */
export function summarizeWeights(vertex) {
  const influences = getInfluences(vertex);
  const locks = getLocks(vertex);
  let rawSum = 0;
  let positiveCount = 0;
  let invalidCount = 0;

  for (const inf of influences) {
    const w = Number(inf?.weight);
    if (!Number.isFinite(w) || w < 0) invalidCount += 1;
    rawSum += Number.isFinite(w) ? w : 0;
    if (Number.isFinite(w) && w > WEIGHT_EPS) positiveCount += 1;
  }

  let lockedTotal = 0;
  const locked = [];
  for (const [key, rawValue] of Object.entries(locks)) {
    const boneIndex = Number(key);
    const value = Number(rawValue);
    locked.push({ boneIndex, value });
    lockedTotal += Number.isFinite(value) ? value : 0;
  }

  return {
    rawSum,
    positiveCount,
    invalidCount,
    locked,
    lockedCount: locked.length,
    lockedTotal,
    distributable: Math.max(0, 1 - lockedTotal),
  };
}

function lockMapToEntries(locks = {}) {
  const out = [];
  for (const [key, rawValue] of Object.entries(locks)) {
    const boneIndex = Number(key);
    const value = Number(rawValue);
    out.push({ boneIndex, value });
  }
  return out;
}

/**
 * Plan a normalization without changing `influences` or `locks`.
 *
 * Rules:
 * - Every locked bone keeps exactly its locked value.
 * - Locked total must be in [0, 1]. If it is over 1, callers must keep the
 *   original vertex data.
 * - The remaining 1 - lockedTotal is distributed over unlocked influences in
 *   proportion to their raw weights. If all unlocked raw weights are zero, it
 *   is split evenly across the available unlocked entries.
 */
export function planNormalization(influences = [], locks = {}) {
  const entries = influences.map((inf, slot) => ({
    boneIndex: Number(inf?.bone),
    rawWeight: Number(inf?.weight),
    slot,
  }));
  const lockEntries = lockMapToEntries(locks);

  for (const lock of lockEntries) {
    if (!Number.isInteger(lock.boneIndex) || lock.boneIndex < 0) {
      return { ok: false, code: 'INVALID_LOCK_BONE', message: '锁定中包含无效骨骼编号。' };
    }
    if (!Number.isFinite(lock.value) || lock.value < -WEIGHT_EPS || lock.value > 1 + WEIGHT_EPS) {
      return {
        ok: false,
        code: 'LOCK_VALUE_OUT_OF_RANGE',
        message: `骨骼 ${lock.boneIndex} 的锁定值必须在 0 到 1 之间。`,
        lockedTotal: Number.NaN,
        distributable: Number.NaN,
      };
    }
  }

  const lockedTotal = lockEntries.reduce((sum, l) => sum + Math.max(0, l.value), 0);
  if (lockedTotal > 1 + SUM_EPS) {
    return {
      ok: false,
      code: 'LOCKED_TOTAL_EXCEEDS_ONE',
      message: `锁定权重合计为 ${lockedTotal.toFixed(3)}，超过 1；已保留原数据。`,
      lockedTotal,
      distributable: 0,
    };
  }

  const lockedByBone = new Map(lockEntries.map((l) => [l.boneIndex, clamp01(l.value)]));
  const remainder = Math.max(0, 1 - lockedTotal);

  // Make sure locked bones exist in the output even if the influence row was
  // accidentally removed from the editable list.
  for (const [boneIndex, value] of lockedByBone) {
    if (!entries.some((e) => e.boneIndex === boneIndex)) {
      entries.push({ boneIndex, rawWeight: value, slot: entries.length, missingRow: true });
    }
  }

  const unlocked = entries.filter((e) => !lockedByBone.has(e.boneIndex));
  const unlockedRawSum = unlocked.reduce(
    (sum, e) => sum + (Number.isFinite(e.rawWeight) ? Math.max(0, e.rawWeight) : 0),
    0,
  );

  let scale = 0;
  let evenFallback = false;
  if (unlocked.length > 0) {
    if (unlockedRawSum > SUM_EPS) {
      scale = remainder / unlockedRawSum;
    } else if (remainder > SUM_EPS) {
      evenFallback = true;
    }
  } else if (remainder > SUM_EPS) {
    return {
      ok: false,
      code: 'REMAINDER_WITHOUT_TARGET',
      message: `锁定后还有 ${remainder.toFixed(3)} 可分配权重，但没有未锁定骨骼可接收。`,
      lockedTotal,
      distributable: remainder,
      unallocated: remainder,
      values: [],
    };
  }

  const values = entries.map((entry) => {
    if (lockedByBone.has(entry.boneIndex)) {
      const value = lockedByBone.get(entry.boneIndex);
      return { ...entry, weight: value, locked: true };
    }
    const raw = Number.isFinite(entry.rawWeight) ? Math.max(0, entry.rawWeight) : 0;
    const weight = evenFallback ? remainder / unlocked.length : raw * scale;
    return { ...entry, weight: Math.max(0, weight), locked: false };
  });

  // Correct tiny floating point drift on the largest unlocked/locked entry.
  const total = values.reduce((s, v) => s + v.weight, 0);
  const drift = 1 - total;
  if (Math.abs(drift) > WEIGHT_EPS && values.length > 0) {
    const adjustTarget =
      [...values].reverse().find((v) => !v.locked && v.weight > WEIGHT_EPS) ??
      values.find((v) => !v.locked) ??
      null;
    if (adjustTarget) adjustTarget.weight = Math.max(0, adjustTarget.weight + drift);
  }

  const finalSum = values.reduce((s, v) => s + v.weight, 0);
  return {
    ok: true,
    code: 'OK',
    lockedTotal,
    distributable: remainder,
    unlockedRawSum,
    scale,
    evenFallback,
    unallocated: Math.abs(1 - finalSum) > SUM_EPS ? 1 - finalSum : 0,
    values: values
      .map((v) => ({ bone: v.boneIndex, slot: v.slot, weight: Math.max(0, v.weight), locked: v.locked }))
      .filter((v) => Number.isInteger(v.bone)),
  };
}

/** Return a new vertex with one influence weight changed. Does not normalize. */
export function withInfluenceWeight(vertex, boneIndex, weight) {
  const nextWeight = Number.isFinite(Number(weight)) ? Math.max(0, Number(weight)) : 0;
  const influences = getInfluences(vertex).map((inf) =>
    Number(inf.bone) === Number(boneIndex) ? { ...inf, weight: nextWeight } : { ...inf },
  );
  return { ...vertex, influences };
}

export function withLock(vertex, boneIndex, value = null) {
  const locks = { ...getLocks(vertex) };
  const key = String(boneIndex);
  if (value === null) {
    const current = getInfluences(vertex).find((inf) => Number(inf.bone) === Number(boneIndex));
    locks[key] = clamp01(Number(current?.weight ?? 0));
  } else {
    locks[key] = clamp01(Number(value));
  }
  return { ...vertex, locks };
}

export function withoutLock(vertex, boneIndex) {
  const locks = { ...getLocks(vertex) };
  delete locks[String(boneIndex)];
  delete locks[Number(boneIndex)];
  return { ...vertex, locks };
}

/**
 * Deterministic influence cap.
 *
 * Tie retention order for numerically equal weights:
 *   1. locked influence, when preserveLocks is enabled
 *   2. lower skeleton/tie priority rank (default: lower bone index)
 *   3. earlier influence slot in the stored vertex data
 *
 * Locked influences are force-retained before the cap is filled. If more than
 * `maxInfluences` are locked, the result reports LOCK_LIMIT_CONFLICT and keeps
 * all locks rather than silently dropping one.
 */
export function pruneInfluences(influences, maxInfluences, options = {}) {
  const max = Number(maxInfluences) === 2 ? 2 : 4;
  const boneOrder = options.boneOrder ?? [];
  const boneCount = Number.isInteger(options.boneCount) ? options.boneCount : null;
  const preserveLocks = options.preserveLocks !== false;
  const locks = options.locks ?? {};
  const rankOf = (boneIndex) => {
    const i = boneOrder.indexOf(boneIndex);
    return i === -1 ? boneIndex + 10_000 : i;
  };
  const lockSet = new Set(
    Object.keys(locks).map(Number).filter((b) => Number.isInteger(b) && b >= 0),
  );

  const all = (influences ?? []).map((inf, slot) => {
    const bone = Number(inf?.bone);
    const beforeWeight = Number(inf?.weight) || 0;
    const locked = preserveLocks && lockSet.has(bone);
    return {
      bone,
      beforeWeight,
      slot,
      locked,
      valid:
        Number.isInteger(bone) &&
        bone >= 0 &&
        (boneCount === null || bone < boneCount) &&
        beforeWeight > WEIGHT_EPS,
      tieRank: rankOf(bone),
    };
  });

  const positive = all.filter((e) => e.valid);
  const lockedEntries = positive.filter((e) => e.locked);
  const flexible = positive.filter((e) => !e.locked);

  const compare = (a, b) => {
    // Primary rank is weight. Only exact/near ties invoke the explicit order.
    if (Math.abs(b.beforeWeight - a.beforeWeight) > WEIGHT_EPS) {
      return b.beforeWeight - a.beforeWeight;
    }
    if (a.locked !== b.locked) return a.locked ? -1 : 1;
    if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
    return a.slot - b.slot;
  };

  flexible.sort(compare);
  lockedEntries.sort(compare);

  const conflict = lockedEntries.length > max;
  const retained = [...lockedEntries];
  if (!conflict) {
    for (const entry of flexible) {
      if (retained.length >= max) break;
      retained.push(entry);
    }
  } else {
    retained.push(...flexible.slice(0, Math.max(0, max - lockedEntries.length)));
  }

  const retainedBones = new Set(retained.map((e) => e.bone));
  const discarded = positive.filter((e) => !retainedBones.has(e.bone));
  const zeroOrInvalid = all.filter((e) => !e.valid);

  // Re-sort retained for stable display by resulting importance later.
  const lockMap = Object.fromEntries(
    lockedEntries.map((e) => [e.bone, Number(locks[e.bone] ?? locks[String(e.bone)] ?? e.beforeWeight)]),
  );
  const plan = planNormalization(
    retained.map((e) => ({ bone: e.bone, weight: e.beforeWeight })),
    preserveLocks ? lockMap : {},
  );

  let afterByBone = new Map();
  if (plan.ok) afterByBone = new Map(plan.values.map((v) => [v.bone, v.weight]));
  else {
    const sum = retained.reduce((s, e) => s + e.beforeWeight, 0);
    for (const e of retained) afterByBone.set(e.bone, sum > 0 ? e.beforeWeight / sum : 0);
  }

  const retainedResult = retained
    .map((e) => ({
      bone: e.bone,
      beforeWeight: e.beforeWeight,
      afterWeight: afterByBone.get(e.bone) ?? 0,
      locked: e.locked,
      slot: e.slot,
      tieRank: e.tieRank,
    }))
    .sort((a, b) => b.afterWeight - a.afterWeight || a.tieRank - b.tieRank);

  const discardedResult = discarded.map((e) => ({
    bone: e.bone,
    beforeWeight: e.beforeWeight,
    afterWeight: 0,
    locked: e.locked,
    slot: e.slot,
    tieRank: e.tieRank,
    redistributedWeight: e.beforeWeight,
  }));

  // Describe tie groups that touched the retention boundary.
  const sortedAll = [...positive].sort(compare);
  const cutoffWeight = sortedAll[max - 1]?.beforeWeight;
  const tieGroup =
    cutoffWeight === undefined
      ? []
      : positive
          .filter((e) => Math.abs(e.beforeWeight - cutoffWeight) <= WEIGHT_EPS)
          .sort(compare)
          .map((e) => e.bone);

  return {
    maxInfluences: max,
    ok: !conflict,
    code: conflict ? 'LOCK_LIMIT_CONFLICT' : 'OK',
    message: conflict
      ? `有 ${lockedEntries.length} 根锁定骨骼，但每点上限为 ${max}；为遵守锁定未强制截断。`
      : '',
    retained: retainedResult,
    discarded: discardedResult,
    ignored: zeroOrInvalid,
    tieOrder: ['weight desc', 'locked first on tie', 'skeleton order / lower bone index', 'stored slot'],
    tieGroup,
    normalization: plan,
  };
}

export function weightsEqual(a, b, eps = 1e-6) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}
