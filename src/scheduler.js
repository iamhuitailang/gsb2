/*
 * Voicebox — deterministic short-sound voice scheduler.
 *
 * Pure module: no DOM, no Web Audio. Given a category config and an event
 * sheet it returns a fully auditable plan: one decision per event and one
 * playback per audible event.
 *
 * Rules, in the order the scheduler applies them:
 *
 *  1. Events are processed by planned time. At the same planned time the
 *     higher priority is processed first; equal priority keeps event-sheet
 *     order. That tie-break is what makes equal-priority events stable.
 *  2. A category's trigger interval (cooldown) delays the earliest start.
 *  3. A start needs one free channel for the sound's whole length AND room
 *     under the category's concurrency cap for that whole length.
 *  4. `steal` policy may cut lower-priority sounds that were already sounding
 *     before the arrival instant. Cut sounds must be lower priority; equal
 *     priority is never evicted. `queue` never cuts, `drop` never waits.
 *     Waiting caused by cooldown or queueing never triggers a steal.
 *  5. No placement inside [planned, planned + maxDelay] => dropped.
 *  6. A cut sound vacates its channel at the cut instant, not at its natural
 *     end, and its decision becomes `preempted`.
 *
 * Priority is a right to evict and a same-instant processing order. It never
 * reorders the sheet.
 */

export const POLICIES = Object.freeze({
  steal: {
    id: 'steal',
    name: '抢占优先',
    short: '顶替低优先级 → 排队 → 舍弃',
    detail:
      '到达瞬间资源不足时，按优先级从低到高顶替已经在播放的声音；没有可顶替的就排队，超过最大延迟舍弃。因触发间隔或排队错过的时机不会补抢。',
  },
  queue: {
    id: 'queue',
    name: '延迟优先',
    short: '排队 → 舍弃',
    detail: '不顶替任何声音。在最大延迟内等待通道或同类配额，超时舍弃。',
  },
  drop: {
    id: 'drop',
    name: '直接舍弃',
    short: '舍弃',
    detail: '不等待也不顶替。到达时资源不足立即舍弃。',
  },
});

export const STATUSES = Object.freeze({
  kept: { id: 'kept', label: '保留', icon: '●', tone: 'good' },
  delayed: { id: 'delayed', label: '延后', icon: '◔', tone: 'warning' },
  preempted: { id: 'preempted', label: '顶掉', icon: '✂', tone: 'serious' },
  dropped: { id: 'dropped', label: '舍弃', icon: '✕', tone: 'critical' },
  muted: { id: 'muted', label: '静音', icon: '—', tone: 'muted' },
});

export const REASONS = Object.freeze({
  'free-slot': '有空闲通道，按计划播放',
  'wait-voice': '通道占满，排队等待',
  'wait-category': '同类并发上限已满，排队等待',
  'wait-cooldown': '触发间隔未到，延后播放',
  'steal-voice': '顶替低优先级声音，取得通道',
  'steal-category': '顶替同类的低优先级声音，取得配额',
  'drop-policy': '策略为直接舍弃，遇到冲突不等待',
  'drop-cooldown': '触发间隔将开始时间推出最大延迟',
  'drop-cap': '同类上限已满，且无可顶替的低优先级声音',
  'drop-voice': '通道占满，且无可顶替的低优先级声音',
  'drop-delay-exceeded': '最大延迟内始终没有空位',
  'drop-unknown': '音色不存在，事件无效',
  muted: '所属类别被静音，不参与调度',
});

export const TIMBRES = Object.freeze([
  { id: 'footstep', name: '脚步 · 噪声闷响' },
  { id: 'coin', name: '金币 · 双音叮' },
  { id: 'sword', name: '剑击 · 噪声扫频' },
  { id: 'hit', name: '受击 · 低频重击' },
  { id: 'ui', name: '界面 · 短哔声' },
  { id: 'magic', name: '法术 · FM 微光' },
]);

export const COLOR_SLOTS = 6;
export const MAX_CATEGORIES = 6;
export const EPS = 0.25;

export const DEFAULT_CATEGORIES = Object.freeze([
  {
    id: 'footstep',
    name: '脚步',
    timbre: 'footstep',
    durationMs: 90,
    priority: 1,
    cooldownMs: 120,
    cap: 2,
    gain: 0.5,
    muted: false,
    colorSlot: 0,
  },
  {
    id: 'coin',
    name: '金币',
    timbre: 'coin',
    durationMs: 180,
    priority: 2,
    cooldownMs: 200,
    cap: 1,
    gain: 0.42,
    muted: false,
    colorSlot: 1,
  },
  {
    id: 'sword',
    name: '剑击',
    timbre: 'sword',
    durationMs: 160,
    priority: 4,
    cooldownMs: 180,
    cap: 1,
    gain: 0.55,
    muted: false,
    colorSlot: 2,
  },
  {
    id: 'hit',
    name: '受击',
    timbre: 'hit',
    durationMs: 200,
    priority: 3,
    cooldownMs: 150,
    cap: 2,
    gain: 0.55,
    muted: false,
    colorSlot: 3,
  },
  {
    id: 'ui',
    name: '界面',
    timbre: 'ui',
    durationMs: 70,
    priority: 1,
    cooldownMs: 80,
    cap: 2,
    gain: 0.32,
    muted: false,
    colorSlot: 4,
  },
]);

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  maxVoices: 3,
  maxDelayMs: 420,
  policy: 'steal',
  masterGain: 0.8,
  categories: DEFAULT_CATEGORIES,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const round1 = (v) => Math.round(v * 10) / 10;
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  aStart < bEnd - EPS && bStart < aEnd - EPS;

export function normalizeCategory(raw, index = 0) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || `cat-${index + 1}`).trim() || `cat-${index + 1}`;
  const timbre = TIMBRES.some((t) => t.id === src.timbre) ? src.timbre : 'footstep';
  return {
    id,
    name: String(src.name || id).slice(0, 24),
    timbre,
    durationMs: clamp(Math.round(num(src.durationMs, 120)), 40, 1200),
    priority: clamp(Math.round(num(src.priority, 2)), 1, 5),
    cooldownMs: clamp(Math.round(num(src.cooldownMs, 0)), 0, 2000),
    cap: clamp(Math.round(num(src.cap, 1)), 1, 4),
    gain: clamp(num(src.gain, 0.5), 0, 1),
    muted: Boolean(src.muted),
    colorSlot: clamp(Math.round(num(src.colorSlot, index)), 0, COLOR_SLOTS - 1),
  };
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const seenIds = new Set();
  const seenSlots = new Set();
  const rawCats = Array.isArray(src.categories) ? src.categories : DEFAULT_CATEGORIES;
  const list = rawCats.slice(0, MAX_CATEGORIES);
  const categories = list.map((c, i) => {
    const cat = normalizeCategory(c, i);
    let id = cat.id;
    let n = 2;
    while (seenIds.has(id)) id = `${cat.id}-${n++}`;
    cat.id = id;
    seenIds.add(id);
    let slot = cat.colorSlot;
    while (seenSlots.has(slot)) slot = (slot + 1) % COLOR_SLOTS;
    cat.colorSlot = slot;
    seenSlots.add(slot);
    return cat;
  });
  if (!categories.length) categories.push(normalizeCategory(DEFAULT_CATEGORIES[0], 0));
  return {
    version: 1,
    maxVoices: clamp(Math.round(num(src.maxVoices, 3)), 1, 8),
    maxDelayMs: clamp(Math.round(num(src.maxDelayMs, 420)), 0, 2000),
    policy: POLICIES[src.policy] ? src.policy : 'steal',
    masterGain: clamp(num(src.masterGain, 0.8), 0, 1),
    categories,
  };
}

export function normalizeEvents(rawEvents) {
  const list = Array.isArray(rawEvents) ? rawEvents : [];
  const seen = new Set();
  return list.map((raw, i) => {
    const src = raw && typeof raw === 'object' ? raw : {};
    const base = String(src.id || `e-${i + 1}`).trim() || `e-${i + 1}`;
    let id = base;
    let n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    seen.add(id);
    return {
      id,
      categoryId: String(src.categoryId || ''),
      timeMs: clamp(Math.round(num(src.timeMs, 0)), 0, 120000),
      note: String(src.note || '').slice(0, 80),
      sheetIndex: i,
    };
  });
}

/**
 * Build a plan. Decisions are returned sorted by planned time, then priority,
 * then sheet order; playbacks sorted by start, then channel.
 */
export function schedule(rawConfig, rawEvents) {
  const config = normalizeConfig(rawConfig);
  const events = normalizeEvents(rawEvents);
  const cats = new Map(config.categories.map((c) => [c.id, c]));

  const decisions = [];
  const decisionByEvent = new Map();
  const playbacks = [];
  const lastStartByCat = new Map();
  const mutedIds = new Set(config.categories.filter((c) => c.muted).map((c) => c.id));
  const priorityOf = (catId) => cats.get(catId)?.priority ?? 0;

  const order = events
    .map((e) => ({ e }))
    .sort(
      (a, b) =>
        a.e.timeMs - b.e.timeMs ||
        priorityOf(b.e.categoryId) - priorityOf(a.e.categoryId) ||
        a.e.sheetIndex - b.e.sheetIndex
    );

  const channelIsFree = (ch, start, end, skip) =>
    !playbacks.some(
      (p) =>
        !p.cutBy &&
        !skip?.has(p) &&
        p.channel === ch &&
        overlaps(start, end, p.start, p.end)
    );

  const freeChannel = (start, end, skip) => {
    for (let ch = 1; ch <= config.maxVoices; ch += 1) {
      if (channelIsFree(ch, start, end, skip)) return ch;
    }
    return null;
  };

  const capBlocked = (catId, start, end, skip) => {
    const cat = cats.get(catId);
    if (!cat) return false;
    const same = playbacks.filter(
      (p) =>
        !p.cutBy &&
        !skip?.has(p) &&
        p.categoryId === catId &&
        overlaps(start, end, p.start, p.end)
    );
    if (!same.length) return false;
    // Concurrency only changes at playback starts, so sample those instants.
    const samples = [start, ...same.map((p) => p.start).filter((t) => t > start && t < end)];
    return samples.some(
      (t) =>
        same.filter((p) => p.start <= t + EPS && t < p.end - EPS).length + 1 > cat.cap
    );
  };

  const fit = (catId, start, end, skip) => {
    if (capBlocked(catId, start, end, skip)) return null;
    const channel = freeChannel(start, end, skip);
    return channel == null ? null : { channel };
  };

  // Who is occupying what over a proposed interval (used only for the
  // explanatory "占用者" list; never for decisions).
  const overlapsOver = (catId, start, end, sameCategoryOnly) =>
    playbacks
      .filter(
        (p) =>
          !p.cutBy &&
          overlaps(start, end, p.start, p.end) &&
          (!sameCategoryOnly || p.categoryId === catId)
      )
      .slice(0, 4)
      .map((p) => p.eventId);

  for (const { e } of order) {
    const cat = cats.get(e.categoryId);
    const base = {
      eventId: e.id,
      sheetIndex: e.sheetIndex,
      categoryId: e.categoryId,
      plannedMs: e.timeMs,
      plannedEndMs: e.timeMs + (cat?.durationMs ?? 0),
      priority: cat?.priority ?? 0,
      naturalDurationMs: cat?.durationMs ?? 0,
      status: 'dropped',
      reasonCode: 'drop-unknown',
      startMs: null,
      endMs: null,
      channel: null,
      delayMs: 0,
      victims: [],
      preemptedBy: null,
      preemptedAtMs: null,
      blockers: [],
    };

    if (!cat) {
      const d = { ...base };
      decisions.push(d);
      decisionByEvent.set(e.id, d);
      continue;
    }
    if (mutedIds.has(cat.id)) {
      const d = { ...base, status: 'muted', reasonCode: 'muted' };
      decisions.push(d);
      decisionByEvent.set(e.id, d);
      continue;
    }

    const dur = cat.durationMs;
    const windowEnd = e.timeMs + config.maxDelayMs;
    const lastStart = lastStartByCat.get(cat.id);
    const earliest = Math.max(
      e.timeMs,
      lastStart == null ? -Infinity : lastStart + cat.cooldownMs
    );
    const cooldownPushed = earliest > e.timeMs + EPS;

    if (earliest > windowEnd + EPS) {
      const d = { ...base, status: 'dropped', reasonCode: 'drop-cooldown' };
      decisions.push(d);
      decisionByEvent.set(e.id, d);
      continue;
    }

    // 1) Try the earliest admissible instant (planned time, or the cooldown
    //    boundary when the trigger interval has not elapsed). Cooldown is a
    //    category spacing rule rather than channel contention: `steal` may
    //    still wait it out, while `drop` treats it as an immediate miss.
    let placement = null;
    if (!(config.policy === 'drop' && cooldownPushed)) {
      const atAnchor = fit(cat.id, earliest, earliest + dur, null);
      if (atAnchor) {
        placement = { start: earliest, channel: atAnchor.channel, victims: [], viaSteal: false };
      }
    }

    // 2) Steal at the arrival instant. Only sounds that were already sounding
    //    (started strictly before it) and are strictly lower priority may be
    //    cut. Cooldown-shifted events never steal ("错过的时机不补抢").
    if (!placement && config.policy === 'steal' && !cooldownPushed) {
      const cutAt = e.timeMs;
      const sounding = playbacks.filter(
        (p) =>
          !p.cutBy &&
          p.start < cutAt - EPS &&
          cutAt < p.end - EPS &&
          p.priority < cat.priority
      );
      const skip = new Set();
      // 2a) Satisfy the category cap by cutting the lowest-priority same-
      //     category sounds until the cap allows the new sound.
      let guard = 0;
      while (capBlocked(cat.id, cutAt, cutAt + dur, skip) && guard++ < 16) {
        const next = sounding
          .filter((p) => p.categoryId === cat.id && !skip.has(p))
          .sort(
            (a, b) => a.priority - b.priority || b.start - a.start || a.channel - b.channel
          )[0];
        if (!next) break;
        skip.add(next);
      }
      // 2b) Free a channel: pick the option needing the fewest cuts, then the
      //     one whose cheapest victim has the lowest priority, then lowest CH.
      if (!capBlocked(cat.id, cutAt, cutAt + dur, skip)) {
        const options = [];
        for (let ch = 1; ch <= config.maxVoices; ch += 1) {
          if (channelIsFree(ch, cutAt, cutAt + dur, skip)) {
            options.push({ channel: ch, victims: [] });
            continue;
          }
          const occupants = playbacks.filter(
            (p) =>
              !p.cutBy &&
              !skip.has(p) &&
              p.channel === ch &&
              // A sound beginning at this very instant is not playing yet:
              // cutting it would produce a zero-length "preempted" event.
              p.start < cutAt - EPS &&
              overlaps(cutAt, cutAt + dur, p.start, p.end)
          );
          if (occupants.length && occupants.every((p) => p.priority < cat.priority)) {
            options.push({ channel: ch, victims: occupants });
          }
        }
        if (options.length) {
          options.sort(
            (a, b) =>
              a.victims.length - b.victims.length ||
              (a.victims.length ? Math.min(...a.victims.map((v) => v.priority)) : 99) -
                (b.victims.length ? Math.min(...b.victims.map((v) => v.priority)) : 99) ||
              a.channel - b.channel
          );
          // Take the cheapest option that actually clears its own channel for
          // the whole sound. A cheaper option can fail when another sound that
          // started later occupies that channel but is not stealable.
          for (const option of options) {
            const victims = [...skip, ...option.victims];
            const victimSet = new Set(victims);
            if (capBlocked(cat.id, cutAt, cutAt + dur, victimSet)) continue;
            if (!channelIsFree(option.channel, cutAt, cutAt + dur, victimSet)) continue;
            placement = {
              start: cutAt,
              channel: option.channel,
              victims,
              viaSteal: true,
            };
            break;
          }
        }
      }
    }

    // 3) Queue: wait for an existing playback to end, inside maxDelay. Policy
    //    `drop` deliberately skips this step.
    if (!placement && config.policy !== 'drop') {
      const candidates = new Set();
      for (const p of playbacks) {
        if (p.end > earliest + EPS && p.end <= windowEnd + EPS) candidates.add(p.end);
      }
      for (const t of [...candidates].sort((a, b) => a - b)) {
        if (t <= earliest + EPS) continue;
        const slot = fit(cat.id, t, t + dur, null);
        if (slot) {
          placement = { start: t, channel: slot.channel, victims: [], viaSteal: false };
          break;
        }
      }
    }

    if (!placement) {
      const slotFree = freeChannel(e.timeMs, e.timeMs + dur, null) != null;
      const capBad = capBlocked(cat.id, e.timeMs, e.timeMs + dur, null);
      // If something blocked us it is visible at the earliest admissible
      // instant. `drop` never waits at all, so its reason names the binding
      // rule: the trigger interval or the no-wait policy itself.
      let reasonCode;
      if (config.policy === 'drop') {
        reasonCode = cooldownPushed ? 'drop-cooldown' : 'drop-policy';
      } else if (capBad) reasonCode = 'drop-cap';
      else if (!slotFree) reasonCode = 'drop-voice';
      else reasonCode = 'drop-delay-exceeded';
      const d = {
        ...base,
        status: 'dropped',
        reasonCode,
        blockedBy: capBad ? 'category' : !slotFree ? 'voice' : 'later',
        blockers: overlapsOver(cat.id, e.timeMs, e.timeMs + dur, capBad),
      };
      decisions.push(d);
      decisionByEvent.set(e.id, d);
      continue;
    }

    // Snapshot the arrival-instant state before the new playback changes it,
    // so the decision can explain why a steal or wait was needed.
    const capBadAtPlan = capBlocked(cat.id, e.timeMs, e.timeMs + dur, null);
    const channelBadAtPlan = freeChannel(e.timeMs, e.timeMs + dur, null) == null;
    const sameOnly = capBadAtPlan && !channelBadAtPlan;
    const blockersAtPlan = overlapsOver(cat.id, e.timeMs, e.timeMs + dur, sameOnly);

    // Commit cuts before searching the channel, so the freed slots are seen.
    for (const v of placement.victims) {
      v.end = placement.start;
      v.cutBy = e.id;
      v.cutAt = placement.start;
      const vd = decisionByEvent.get(v.eventId);
      if (vd) {
        vd.status = 'preempted';
        vd.endMs = placement.start;
        vd.preemptedBy = e.id;
        vd.preemptedAtMs = placement.start;
      }
    }

    const start = placement.start;
    const end = start + dur;
    playbacks.push({
      eventId: e.id,
      categoryId: cat.id,
      channel: placement.channel,
      start,
      end,
      naturalEnd: end,
      plannedMs: e.timeMs,
      priority: cat.priority,
      cutBy: null,
      cutAt: null,
      gain: cat.gain,
    });
    lastStartByCat.set(cat.id, start);

    let reasonCode;
    if (placement.viaSteal) {
      // Explain what the cuts bought: quota or channel.
      const stoleSame = placement.victims.some((v) => v.categoryId === cat.id);
      reasonCode = stoleSame ? 'steal-category' : 'steal-voice';
    } else if (start > e.timeMs + EPS) {
      if (cooldownPushed) reasonCode = 'wait-cooldown';
      else if (capBadAtPlan) reasonCode = 'wait-category';
      else reasonCode = 'wait-voice';
    } else {
      reasonCode = 'free-slot';
    }

    const d = {
      ...base,
      status: start > e.timeMs + EPS ? 'delayed' : 'kept',
      reasonCode,
      startMs: start,
      endMs: end,
      channel: placement.channel,
      delayMs: round1(start - e.timeMs),
      victims: placement.victims.map((v) => v.eventId),
      blockers: placement.viaSteal || reasonCode === 'free-slot' ? [] : blockersAtPlan,
    };
    decisions.push(d);
    decisionByEvent.set(e.id, d);
  }

  // Peak concurrency from the audible segments.
  const peakByCategory = {};
  for (const c of config.categories) peakByCategory[c.id] = 0;
  const peakFor = (predicate) => {
    let peak = 0;
    for (const p of playbacks) {
      const samples = [p.start];
      for (const q of playbacks) {
        if (q.start > p.start && q.start < p.end) samples.push(q.start);
      }
      for (const t of samples) {
        const n = playbacks.filter(
          (q) => predicate(q) && q.start <= t + EPS && t < q.end - EPS
        ).length;
        peak = Math.max(peak, n);
      }
    }
    return peak;
  };
  for (const c of config.categories) {
    peakByCategory[c.id] = peakFor((p) => p.categoryId === c.id);
  }
  const peakVoices = peakFor(() => true);

  const counts = { total: events.length, kept: 0, delayed: 0, preempted: 0, dropped: 0, muted: 0 };
  for (const d of decisions) counts[d.status] += 1;

  const delays = decisions.filter((d) => d.delayMs > 0.05).map((d) => d.delayMs);
  const lastPlanned = events.reduce(
    (m, e) => Math.max(m, e.timeMs + (cats.get(e.categoryId)?.durationMs ?? 0)),
    0
  );
  const lastEnd = playbacks.reduce((m, p) => Math.max(m, p.end), 0);
  const spanMs = Math.max(lastPlanned, lastEnd, 1) + 400;
  const busyMs = playbacks.reduce((s, p) => s + Math.max(0, p.end - p.start), 0);

  const summary = {
    ...counts,
    sounded: counts.kept + counts.delayed + counts.preempted,
    fullLength: counts.kept + counts.delayed,
    cutShort: counts.preempted,
    avgDelayMs: delays.length ? round1(delays.reduce((a, b) => a + b, 0) / delays.length) : 0,
    maxDelayObservedMs: delays.length ? round1(Math.max(...delays)) : 0,
    peakVoices,
    peakByCategory,
    utilizationPct: round1((busyMs / (config.maxVoices * spanMs)) * 100),
    soundedDurationMs: round1(busyMs),
    lastEndMs: lastEnd,
    spanMs,
  };

  decisions.sort(
    (a, b) =>
      a.plannedMs - b.plannedMs ||
      b.priority - a.priority ||
      a.sheetIndex - b.sheetIndex
  );
  playbacks.sort(
    (a, b) =>
      a.start - b.start || a.channel - b.channel || a.eventId.localeCompare(b.eventId)
  );

  const plan = {
    config,
    events,
    decisions,
    playbacks,
    summary,
    totalMs: spanMs,
    configDigest: digestConfig(config),
  };
  plan.outcomeDigest = digestPlan(plan);
  return plan;
}

export function digestConfig(config) {
  const c = normalizeConfig(config);
  const payload = {
    maxVoices: c.maxVoices,
    maxDelayMs: c.maxDelayMs,
    policy: c.policy,
    masterGain: c.masterGain,
    categories: c.categories.map((x) => ({
      id: x.id,
      timbre: x.timbre,
      durationMs: x.durationMs,
      priority: x.priority,
      cooldownMs: x.cooldownMs,
      cap: x.cap,
      gain: x.gain,
      muted: x.muted,
    })),
  };
  return fnv1a(JSON.stringify(payload));
}

function digestPlan(plan) {
  const payload = {
    maxVoices: plan.config.maxVoices,
    maxDelayMs: plan.config.maxDelayMs,
    policy: plan.config.policy,
    decisions: [...plan.decisions]
      .sort((a, b) => a.eventId.localeCompare(b.eventId))
      .map((d) => [
        d.eventId,
        d.plannedMs,
        d.status,
        d.reasonCode,
        d.startMs == null ? null : round1(d.startMs),
        d.endMs == null ? null : round1(d.endMs),
        d.channel,
        d.preemptedBy,
        d.victims.join(','),
      ]),
    playbacks: [...plan.playbacks]
      .sort((a, b) => a.eventId.localeCompare(b.eventId))
      .map((p) => [p.eventId, p.channel, round1(p.start), round1(p.end)]),
    summary: {
      kept: plan.summary.kept,
      delayed: plan.summary.delayed,
      preempted: plan.summary.preempted,
      dropped: plan.summary.dropped,
      muted: plan.summary.muted,
    },
  };
  return fnv1a(JSON.stringify(payload));
}

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const sounded = (d) =>
  d.status === 'kept' || d.status === 'delayed' || d.status === 'preempted';

/** Compare the current (possibly muted) plan against an all-unmuted baseline. */
export function comparePlans(baseline, current) {
  const before = new Map(baseline.decisions.map((d) => [d.eventId, d]));
  const affected = [];
  let changedStatus = 0;
  let changedStart = 0;
  let gainedSounded = 0;
  let lostSounded = 0;
  let shortened = 0;

  for (const d of current.decisions) {
    const b = before.get(d.eventId);
    if (!b) continue;
    const statusChanged = b.status !== d.status;
    const startChanged =
      b.startMs != null && d.startMs != null && Math.abs(b.startMs - d.startMs) > 0.5;
    const endChanged =
      b.endMs != null && d.endMs != null && Math.abs(b.endMs - d.endMs) > 0.5;
    if (statusChanged) changedStatus += 1;
    if (startChanged) changedStart += 1;
    if (statusChanged && sounded(b) && sounded(d) && b.status === 'kept' && d.status === 'preempted') {
      shortened += 1;
    }
    if (!sounded(b) && sounded(d)) gainedSounded += 1;
    if (sounded(b) && !sounded(d)) lostSounded += 1;
    if (!statusChanged && !startChanged && !endChanged) continue;
    affected.push({
      eventId: d.eventId,
      categoryId: d.categoryId,
      plannedMs: d.plannedMs,
      before: { status: b.status, startMs: b.startMs, endMs: b.endMs, channel: b.channel },
      after: { status: d.status, startMs: d.startMs, endMs: d.endMs, channel: d.channel },
      deltaStartMs:
        b.startMs != null && d.startMs != null ? round1(d.startMs - b.startMs) : null,
    });
  }
  affected.sort(
    (a, b) => a.plannedMs - b.plannedMs || a.eventId.localeCompare(b.eventId)
  );

  return {
    mutedCategoryIds: current.config.categories.filter((c) => c.muted).map((c) => c.id),
    affected,
    changedStatus,
    changedStart,
    shortened,
    gainedSounded,
    lostSounded,
    baselineSummary: baseline.summary,
    currentSummary: current.summary,
    countsBefore: {
      kept: baseline.summary.kept,
      delayed: baseline.summary.delayed,
      preempted: baseline.summary.preempted,
      dropped: baseline.summary.dropped,
      sounded: baseline.summary.sounded,
      fullLength: baseline.summary.fullLength,
    },
    countsAfter: {
      kept: current.summary.kept,
      delayed: current.summary.delayed,
      preempted: current.summary.preempted,
      dropped: current.summary.dropped,
      sounded: current.summary.sounded,
      fullLength: current.summary.fullLength,
    },
  };
}

export function formatMs(ms, digits = 2) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  return `${(ms / 1000).toFixed(digits)}s`;
}

/** Reserved status tone for a decision status (good / warning / serious / critical / muted). */
export function statusTone(status) {
  return STATUSES[status]?.tone || 'muted';
}

export { sounded, overlaps };
