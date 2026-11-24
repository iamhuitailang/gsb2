import type {
  Allocation,
  CurrentRound,
  Device,
  GameState,
  PersistedGame,
  PresetKey,
  RoundRecord,
  TeamId,
  ViewModel,
  HistoryEntry,
  ReplayResult,
} from './types.ts';
import { PHASE_LABELS, TEAM_IDS, TEAM_NAMES } from './types.ts';
import { replayRecord, settleRound, validatePlan, verifyRecord, planTotal } from './rules.ts';
import { scenarioDevicesFor, SCENARIOS, examplePlanFor } from './scenarios.ts';
import { checksumOf } from './rng.ts';

export interface Outcome {
  state: GameState;
  error: string | null;
}

export interface SettleOutcome extends Outcome {
  record: RoundRecord | null;
  /** true 表示这是同一轮结算被重复触发，历史没有新增。 */
  duplicate: boolean;
}

export const STORAGE_KEY = 'repair-lab:v1:save';
export const INTERNAL_VERSION = 1;

function zeroAllocation(devices: readonly Device[]): Allocation {
  const allocation: Allocation = {};
  for (const device of devices) allocation[device.id] = 0;
  return allocation;
}

export function roundSeed(baseSeed: string, round: number): string {
  return `${baseSeed}#R${round}`;
}

function makeRound(baseSeed: string, round: number, preset: PresetKey): CurrentRound {
  const seed = roundSeed(baseSeed, round);
  const devices = scenarioDevicesFor(preset, seed);
  return {
    round,
    seed,
    devices,
    phase: 'handoff-a',
    drafts: {
      A: { allocations: zeroAllocation(devices), submittedAt: null },
      B: { allocations: zeroAllocation(devices), submittedAt: null },
    },
    createdAt: Date.now(),
  };
}

export const DEFAULT_BASE_SEED = 'repair-lab-2026';

export function createGame(options?: {
  baseSeed?: string;
  preset?: PresetKey;
  now?: number;
}): GameState {
  const baseSeed = options?.baseSeed?.trim() || DEFAULT_BASE_SEED;
  const preset = options?.preset ?? 'contested';
  const current = makeRound(baseSeed, 1, preset);
  if (options?.now !== undefined) current.createdAt = options.now;
  return {
    version: INTERNAL_VERSION,
    baseSeed,
    preset,
    budget: SCENARIOS[preset].budget,
    current,
    history: [],
  };
}

export function beginEditing(state: GameState, team: TeamId): Outcome {
  const expected = team === 'A' ? 'handoff-a' : 'handoff-b';
  if (state.current.phase !== expected) {
    return { state, error: `当前是「${PHASE_LABELS[state.current.phase]}」，不能由${TEAM_NAMES[team]}开始编辑。` };
  }
  const current = {
    ...state.current,
    phase: (team === 'A' ? 'editing-a' : 'editing-b') as CurrentRound['phase'],
  };
  return { state: { ...state, current }, error: null };
}

export function setAllocation(
  state: GameState,
  team: TeamId,
  deviceId: string,
  value: number,
): Outcome {
  const phase = state.current.phase;
  if (phase !== 'editing-a' && phase !== 'editing-b') {
    return { state, error: '当前不在编辑阶段。' };
  }
  if ((phase === 'editing-a' ? 'A' : 'B') !== team) {
    return { state, error: `现在不能修改${TEAM_NAMES[team]}的分工。` };
  }
  const device = state.current.devices.find((item) => item.id === deviceId);
  if (!device) return { state, error: `未知设备：${deviceId}` };
  if (!Number.isInteger(value) || value < 0) {
    return { state, error: '工时必须是非负整数。' };
  }
  const draft = state.current.drafts[team];
  if (draft.submittedAt !== null) {
    return { state, error: '方案已密封提交，不能再修改。' };
  }
  const previous = draft.allocations[deviceId] ?? 0;
  const nextTotal = planTotal(draft.allocations) - previous + value;
  if (nextTotal > state.budget) {
    return {
      state,
      error: `合计 ${nextTotal} 工时超过本队预算 ${state.budget}。`,
    };
  }
  const nextDraft = {
    ...draft,
    allocations: { ...draft.allocations, [deviceId]: value },
  };
  const next = {
    ...state,
    current: {
      ...state.current,
      drafts: { ...state.current.drafts, [team]: nextDraft },
    },
  };
  return { state: next, error: null };
}

/**
 * 一次性替换整份草稿（用于载入示例）。
 * 与逐格 setAllocation 不同，这里只校验最终合计，避免替换过程中出现临时超预算。
 */
export function replaceDraftPlan(state: GameState, team: TeamId, plan: Allocation): Outcome {
  const phase = state.current.phase;
  if (phase !== 'editing-a' && phase !== 'editing-b') {
    return { state, error: '当前不在编辑阶段。' };
  }
  if ((phase === 'editing-a' ? 'A' : 'B') !== team) {
    return { state, error: `现在不能修改${TEAM_NAMES[team]}的分工。` };
  }
  const draft = state.current.drafts[team];
  if (draft.submittedAt !== null) {
    return { state, error: '方案已密封提交，不能再修改。' };
  }
  const normalized: Allocation = { ...zeroAllocation(state.current.devices), ...plan };
  const check = validatePlan(state.current.devices, state.budget, normalized);
  if (!check.ok) return { state, error: check.errors.join('；') };
  return {
    state: {
      ...state,
      current: {
        ...state.current,
        drafts: { ...state.current.drafts, [team]: { allocations: normalized, submittedAt: null } },
      },
    },
    error: null,
  };
}

export function submitTeam(state: GameState, team: TeamId, now = Date.now()): Outcome {
  const editingPhase = team === 'A' ? 'editing-a' : 'editing-b';
  if (state.current.phase !== editingPhase) {
    return { state, error: `${TEAM_NAMES[team]}现在不能提交。` };
  }
  const draft = state.current.drafts[team];
  if (draft.submittedAt !== null) {
    return { state, error: '方案已经提交过了。' };
  }
  const check = validatePlan(state.current.devices, state.budget, draft.allocations);
  if (!check.ok) return { state, error: check.errors.join('；') };

  const nextPhase: CurrentRound['phase'] = team === 'A' ? 'handoff-b' : 'awaiting-settlement';
  const normalized: Allocation = { ...zeroAllocation(state.current.devices), ...draft.allocations };
  const next: GameState = {
    ...state,
    current: {
      ...state.current,
      phase: nextPhase,
      drafts: {
        ...state.current.drafts,
        [team]: { allocations: normalized, submittedAt: now },
      },
    },
  };
  return { state: next, error: null };
}

/** 结算本轮；重复调用只返回已有记录，不新增历史。 */
export function settleCurrent(state: GameState, now = Date.now()): SettleOutcome {
  if (state.current.phase === 'settled') {
    const existing = state.history.find((record) => record.round === state.current.round) ?? null;
    return { state, error: null, record: existing, duplicate: true };
  }
  if (state.current.phase !== 'awaiting-settlement') {
    return {
      state,
      error: `双方尚未全部提交（当前「${PHASE_LABELS[state.current.phase]}」），不能结算。`,
      record: null,
      duplicate: false,
    };
  }
  const draftA = state.current.drafts.A;
  const draftB = state.current.drafts.B;
  if (draftA.submittedAt === null || draftB.submittedAt === null) {
    return { state, error: '仍有队伍没有提交方案。', record: null, duplicate: false };
  }
  const record = settleRound({
    round: state.current.round,
    seed: state.current.seed,
    budget: state.budget,
    devices: state.current.devices,
    plans: {
      A: { ...draftA.allocations },
      B: { ...draftB.allocations },
    },
    submittedAt: { A: draftA.submittedAt, B: draftB.submittedAt },
    settledAt: now,
  });
  const next: GameState = {
    ...state,
    current: { ...state.current, phase: 'settled' },
    history: [...state.history, record],
  };
  return { state: next, error: null, record, duplicate: false };
}

export function nextRound(state: GameState, now = Date.now()): Outcome {
  if (state.current.phase !== 'settled') {
    return { state, error: '本轮尚未结算，不能进入下一轮。' };
  }
  const round = state.current.round + 1;
  const current = makeRound(state.baseSeed, round, state.preset);
  current.createdAt = now;
  return { state: { ...state, current }, error: null };
}

export function newGame(options: { baseSeed: string; preset: PresetKey }, now = Date.now()): GameState {
  return createGame({ ...options, now });
}

export function currentRecord(state: GameState): RoundRecord | null {
  if (state.current.phase !== 'settled') return null;
  return state.history.find((record) => record.round === state.current.round) ?? null;
}

/* ------------------------------------------------------------------ */
/* 展示模型：隐私闸门只在这里打开一次。                                */
/* ------------------------------------------------------------------ */

function planForDisplay(devices: readonly Device[], plan: Allocation): Record<string, number> {
  const view: Record<string, number> = {};
  for (const device of devices) view[device.id] = plan[device.id] ?? 0;
  return view;
}

export function buildViewModel(state: GameState): ViewModel {
  const current = state.current;
  const phaseLabel = PHASE_LABELS[current.phase];
  const base = {
    baseSeed: state.baseSeed,
    preset: state.preset,
    presetName: SCENARIOS[state.preset].name,
    round: current.round,
    seed: current.seed,
    budget: state.budget,
    devices: current.devices.map((device) => ({ ...device })),
    phase: current.phase,
    phaseLabel,
    submitted: {
      A: current.drafts.A.submittedAt !== null,
      B: current.drafts.B.submittedAt !== null,
    } as Record<TeamId, boolean>,
    submittedAt: {
      A: current.drafts.A.submittedAt,
      B: current.drafts.B.submittedAt,
    } as Record<TeamId, number | null>,
    history: state.history.map(historyEntry),
  };

  let handoff: ViewModel['handoff'] = null;
  let editing: ViewModel['editing'] = null;
  let awaiting: ViewModel['awaiting'] = null;
  let settled: ViewModel['settled'] = null;

  if (current.phase === 'handoff-a') {
    handoff = {
      team: 'A',
      title: '请把键盘交给甲队',
      detail: '甲队先安排本轮工时。乙队此时不参与，也看不到任何方案。',
      previousSubmitted: false,
    };
  } else if (current.phase === 'handoff-b') {
    handoff = {
      team: 'B',
      title: '甲队已密封提交，请把键盘交给乙队',
      detail:
        '甲队的分工已经封存。乙队接手后的编辑界面、普通历史与导出里都不会出现甲队的选择；双方都提交后再统一结算。',
      previousSubmitted: true,
    };
  } else if (current.phase === 'editing-a' || current.phase === 'editing-b') {
    const team: TeamId = current.phase === 'editing-a' ? 'A' : 'B';
    const draft = current.drafts[team];
    editing = {
      team,
      allocations: planForDisplay(current.devices, draft.allocations),
      spent: planTotal(draft.allocations),
      budget: state.budget,
      sealed: draft.submittedAt !== null,
      exampleAvailable: examplePlanFor(state.preset, team, current.devices) !== null,
    };
  } else if (current.phase === 'awaiting-settlement') {
    awaiting = {
      submitted: { A: true, B: true },
      detail: '两队方案都已密封。结算只读取两份已提交方案，不会改变其中任何一边。',
    };
  } else if (current.phase === 'settled') {
    const record = currentRecord(state);
    if (record) {
      settled = {
        record,
        totals: record.totals,
        replay: replayRecord(record),
        plans: {
          A: planForDisplay(record.devices, record.plans.A),
          B: planForDisplay(record.devices, record.plans.B),
        },
      };
    }
  }

  return {
    ...base,
    handoff,
    editing,
    awaiting,
    settled,
    pendingRecordCount: state.history.length,
    autosaveKey: STORAGE_KEY,
  };
}

function historyEntry(record: RoundRecord): HistoryEntry {
  return {
    id: record.id,
    round: record.round,
    seed: record.seed,
    totals: record.totals,
    checksum: record.checksum,
    settledAt: record.settledAt,
    record: structuredClone(record),
  };
}

/* ------------------------------------------------------------------ */
/* 公开导出：当前轮的方案在结算前一律不出现。                          */
/* ------------------------------------------------------------------ */

export function buildStateExport(state: GameState): string {
  const current = state.current;
  const payload = {
    kind: 'repair-lab-public-snapshot',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    baseSeed: state.baseSeed,
    preset: state.preset,
    budget: state.budget,
    currentRound: {
      round: current.round,
      seed: current.seed,
      phase: current.phase,
      devices: current.devices,
      submitted: {
        A: current.drafts.A.submittedAt !== null,
        B: current.drafts.B.submittedAt !== null,
      },
    },
    history: state.history,
    note:
      current.phase === 'settled'
        ? '本轮已结算，投入已公开在 history 中。'
        : '当前轮尚未结算：不包含任何队伍的方案；已结算轮次在 history 中公开。',
  };
  return JSON.stringify(payload, null, 2);
}

export function buildRecordExport(record: RoundRecord): string {
  return JSON.stringify(
    {
      kind: 'repair-lab-round-record',
      rulesVersion: record.rulesVersion,
      checksum: record.checksum,
      record,
    },
    null,
    2,
  );
}

/** 从粘贴/导出的 JSON 里读出一条已结算记录，并做完整重播校验。 */
export interface RecordInspection {
  record: RoundRecord | null;
  replay: ReplayResult | null;
  error: string | null;
}

export function inspectRecord(raw: string): RecordInspection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { record: null, replay: null, error: '不是合法的 JSON。' };
  }
  const candidate =
    typeof parsed === 'object' && parsed !== null && 'record' in parsed
      ? (parsed as { record: RoundRecord }).record
      : (parsed as RoundRecord);
  const checked = verifyRecord(candidate);
  if (!checked.ok) return { record: null, replay: null, error: checked.error };
  return { record: checked.value, replay: replayRecord(checked.value), error: null };
}

export interface ImportOutcome extends RecordInspection {
  /** 导入只做重播核对，不会改动当前进度或历史。 */
  state: GameState;
  /** 该轮是否已经在本机历史里（重复导入时用于提示）。 */
  alreadyInHistory: boolean;
}

/**
 * 导入外部记录：只做重播校验，不写入历史，也不改动当前轮。
 * 这样导出/导入既不会把私有草稿带进历史，也不会用外部数据覆盖本局进度。
 */
export function importRecord(state: GameState, raw: string): ImportOutcome {
  const inspection = inspectRecord(raw);
  if (!inspection.record) return { ...inspection, state, alreadyInHistory: false };
  const record = inspection.record;
  const alreadyInHistory = state.history.some((item) => item.round === record.round || item.id === record.id);
  return { ...inspection, state, alreadyInHistory };
}

/* ------------------------------------------------------------------ */
/* 内部存档（仅本机 localStorage，用于中断恢复；不是对外导出）。       */
/* ------------------------------------------------------------------ */

export function serializeInternal(state: GameState, now = Date.now()): string {
  const persisted: PersistedGame = {
    schemaVersion: INTERNAL_VERSION,
    savedAt: now,
    state,
  };
  return JSON.stringify(persisted);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min;
}

/** 历史记录与当前局面的一致性检查。 */
function checkHistoryConsistency(
  history: readonly RoundRecord[],
  budget: number,
  baseSeed: string,
  currentRound: number,
  settledCurrent: boolean,
): string | null {
  const rounds = new Set<number>();
  for (const record of history) {
    if (rounds.has(record.round)) return `第 ${record.round} 轮出现重复记录。`;
    rounds.add(record.round);
    if (record.budget !== budget) return `第 ${record.round} 轮的预算与当前局面不一致。`;
    if (record.seed !== roundSeed(baseSeed, record.round)) {
      return `第 ${record.round} 轮的种子与 base seed 不一致。`;
    }
    if (record.round > currentRound) return `第 ${record.round} 轮晚于当前轮次。`;
  }
  if (settledCurrent) {
    if (!rounds.has(currentRound)) return '存档标记为已结算，但历史里没有本轮记录。';
  } else if (rounds.has(currentRound)) {
    return '当前轮次尚未结算，却已经存在于历史中。';
  }
  return null;
}

function validateAllocation(devices: readonly Device[], allocation: unknown): string | null {
  if (!isPlainObject(allocation)) return '分工不是对象';
  const ids = new Set(devices.map((device) => device.id));
  for (const [id, value] of Object.entries(allocation)) {
    if (!ids.has(id)) return `存档里出现未知设备 ${id}`;
    if (!isInteger(value)) return `设备 ${id} 的工时不是非负整数`;
  }
  return null;
}

/**
 * 恢复内部存档：只读取存档里的设备数组，绝不重新生成分布。
 * 阶段与草稿/提交时间必须自洽，已结算记录必须能重播一致。
 */
export function deserializeInternal(raw: string): { ok: true; state: GameState; savedAt: number } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '存档不是合法 JSON。' };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: '存档结构不正确。' };
  if (parsed.schemaVersion !== INTERNAL_VERSION) return { ok: false, error: '存档版本不匹配。' };
  const savedAt = isInteger(parsed.savedAt) ? parsed.savedAt : Date.now();
  const state = parsed.state;
  if (!isPlainObject(state) || state.version !== INTERNAL_VERSION) return { ok: false, error: '存档状态版本不匹配。' };
  if (typeof state.baseSeed !== 'string' || !state.baseSeed) return { ok: false, error: '缺少 base seed。' };
  if (!(typeof state.preset === 'string' && state.preset in SCENARIOS)) return { ok: false, error: '未知场景。' };
  if (!isInteger(state.budget, 1)) return { ok: false, error: '预算不合法。' };

  const current = state.current;
  if (!isPlainObject(current)) return { ok: false, error: '缺少当前轮次。' };
  if (!isInteger(current.round, 1)) return { ok: false, error: '轮次不合法。' };
  if (typeof current.seed !== 'string' || !current.seed) return { ok: false, error: '缺少本轮种子。' };
  if (!Array.isArray(current.devices) || current.devices.length === 0) return { ok: false, error: '缺少设备列表。' };
  const devices: Device[] = [];
  for (const item of current.devices) {
    if (!isPlainObject(item)) return { ok: false, error: '设备结构不正确。' };
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return { ok: false, error: '设备缺少 id/名称。' };
    if (!isInteger(item.severity, 1) || !isInteger(item.cap, 1) || !isInteger(item.reward, 0)) {
      return { ok: false, error: `设备 ${item.id} 参数不合法。` };
    }
    devices.push({
      id: item.id,
      name: item.name,
      severity: item.severity,
      cap: item.cap,
      reward: item.reward,
    });
  }
  const phases: CurrentRound['phase'][] = [
    'handoff-a',
    'editing-a',
    'handoff-b',
    'editing-b',
    'awaiting-settlement',
    'settled',
  ];
  if (!phases.includes(current.phase as CurrentRound['phase'])) return { ok: false, error: '轮次阶段不合法。' };
  if (!isPlainObject(current.drafts)) return { ok: false, error: '缺少草稿。' };
  const drafts = {
    A: { allocations: {} as Allocation, submittedAt: null as number | null },
    B: { allocations: {} as Allocation, submittedAt: null as number | null },
  };
  for (const team of TEAM_IDS) {
    const draft = (current.drafts as Record<string, unknown>)[team];
    if (!isPlainObject(draft)) return { ok: false, error: `缺少${TEAM_NAMES[team]}草稿。` };
    const allocationError = validateAllocation(devices, draft.allocations);
    if (allocationError) return { ok: false, error: allocationError };
    const submittedRaw = draft.submittedAt;
    if (submittedRaw !== null && !isInteger(submittedRaw)) return { ok: false, error: '提交时间不合法。' };
    const submittedAt: number | null = submittedRaw === null ? null : (submittedRaw as number);
    const allocations: Allocation = {};
    for (const device of devices) {
      allocations[device.id] = (draft.allocations as Allocation)[device.id] ?? 0;
    }
    const draftTotal = Object.values(allocations).reduce((sum, value) => sum + value, 0);
    if (draftTotal > state.budget) {
      return { ok: false, error: `${TEAM_NAMES[team]}草稿合计 ${draftTotal} 超过预算 ${state.budget}。` };
    }
    drafts[team] = { allocations, submittedAt };
  }

  const phase = current.phase as CurrentRound['phase'];
  const checkPhase = (expectedSubmitted: Record<TeamId, boolean>) => {
    for (const team of TEAM_IDS) {
      const sealed = drafts[team].submittedAt !== null;
      if (sealed !== expectedSubmitted[team]) {
        return `阶段 ${phase} 与${TEAM_NAMES[team]}的提交状态不一致`;
      }
    }
    return null;
  };
  const phaseErrors: Record<CurrentRound['phase'], Record<TeamId, boolean>> = {
    'handoff-a': { A: false, B: false },
    'editing-a': { A: false, B: false },
    'handoff-b': { A: true, B: false },
    'editing-b': { A: true, B: false },
    'awaiting-settlement': { A: true, B: true },
    settled: { A: true, B: true },
  };
  const phaseError = checkPhase(phaseErrors[phase]);
  if (phaseError) return { ok: false, error: phaseError };

  if (!Array.isArray(state.history)) return { ok: false, error: '历史记录结构不正确。' };
  const history: RoundRecord[] = [];
  for (const record of state.history) {
    if (!isPlainObject(record)) return { ok: false, error: '历史记录结构不正确。' };
    const verified = verifyRecord(record as unknown as RoundRecord);
    if (!verified.ok) return { ok: false, error: `历史记录校验失败：${verified.error}` };
    history.push(verified.value);
  }
  const historyError = checkHistoryConsistency(history, state.budget, state.baseSeed, current.round, phase === 'settled');
  if (historyError) return { ok: false, error: historyError };

  const createdAt = isInteger(current.createdAt) ? current.createdAt : Date.now();
  if (current.seed !== roundSeed(state.baseSeed, current.round)) {
    return { ok: false, error: '当前轮次的种子与 base seed 不一致。' };
  }
  const restored: GameState = {
    version: INTERNAL_VERSION,
    baseSeed: state.baseSeed,
    preset: state.preset as PresetKey,
    budget: state.budget,
    current: { round: current.round, seed: current.seed, devices, phase, drafts, createdAt },
    history: history.sort((a, b) => a.round - b.round),
  };
  return { ok: true, state: restored, savedAt };
}

export function stateFingerprint(state: GameState): string {
  return checksumOf({
    seed: state.current.seed,
    phase: state.current.phase,
    devices: state.current.devices,
    history: state.history.map((record) => record.checksum),
  });
}
