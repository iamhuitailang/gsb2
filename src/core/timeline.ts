import type { EaseKind, TimelineData, TimelineKey } from './types.js';
import { clamp } from '../math/vec3.js';

export interface TimelineEntry {
  keyIndex: number;
  key: TimelineKey;
  /** [holdStart, holdEnd) — camera rests at sStart. */
  holdStart: number;
  holdEnd: number;
  /** [travelStart, travelEnd) — camera moves from sStart to sEnd. */
  travelStart: number;
  travelEnd: number;
  sStart: number;
  sEnd: number;
  distance: number;
  /** Effective world units per second. */
  speed: number;
  ease: EaseKind;
  /** True when this entry wraps from the last key back to the first. */
  closesLoop: boolean;
}

export interface TimelineState {
  time: number;
  /** Normalized path parameter. */
  s: number;
  phase: 'hold' | 'travel' | 'end';
  keyIndex: number;
  segmentIndex: number;
  /** Raw (uneased) progress in the active travel segment, 0..1. */
  progress: number;
}

export function applyEase(kind: EaseKind, t: number): number {
  const x = clamp(t, 0, 1);
  switch (kind) {
    case 'easeIn':
      return x * x;
    case 'easeOut':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOut':
      return x * x * (3 - 2 * x);
    case 'linear':
    default:
      return x;
  }
}

export function sortKeys(keys: TimelineKey[]): TimelineKey[] {
  return [...keys].sort((a, b) => a.s - b.s || a.id.localeCompare(b.id));
}

/**
 * Deterministic evaluator that maps timeline seconds to a normalized path
 * parameter. Everything is derived from the project data, so scrubbing to a
 * time always reproduces exactly the same camera pose.
 */
export class Timeline {
  readonly entries: TimelineEntry[] = [];
  readonly duration: number;
  readonly fps: number;
  readonly closed: boolean;
  readonly keys: TimelineKey[];

  constructor(data: TimelineData, totalPathLength: number, pathClosed: boolean) {
    this.fps = Math.max(1, Math.round(data.fps || 30));
    this.closed = pathClosed;
    this.keys = sortKeys(data.keys).map((k) => ({ ...k, s: clamp(k.s, 0, 1) }));

    const keys = this.keys;
    const baseSpeed = Math.max(0.05, data.baseSpeed || 1);
    const length = Math.max(totalPathLength, 1e-6);

    if (keys.length === 0) {
      const fallback: TimelineKey = { id: 'fallback', s: 0, hold: 0, speed: 1, ease: 'linear' };
      keys.push(fallback);
    }

    let cursor = 0;
    const pushEntry = (
      keyIndex: number,
      sStart: number,
      sEnd: number,
      sSpan: number,
      closesLoop: boolean,
    ) => {
      const key = keys[keyIndex];
      const hold = Math.max(0, Number.isFinite(key.hold) ? key.hold : 0);
      const speed = Math.max(0.05, (Number.isFinite(key.speed) ? key.speed : 1) * baseSpeed);
      const distance = Math.abs(sSpan) * length;
      const travelDuration = distance / speed;

      const entry: TimelineEntry = {
        keyIndex,
        key,
        holdStart: cursor,
        holdEnd: cursor + hold,
        travelStart: cursor + hold,
        travelEnd: cursor + hold + travelDuration,
        sStart,
        sEnd,
        distance,
        speed,
        ease: key.ease,
        closesLoop,
      };
      this.entries.push(entry);
      cursor = entry.travelEnd;
    };

    const n = keys.length;
    if (n === 1) {
      pushEntry(0, keys[0].s, pathClosed ? keys[0].s + 1 : keys[0].s, pathClosed ? 1 : 0, pathClosed);
    } else {
      for (let i = 0; i < n; i++) {
        const last = i === n - 1;
        if (last && !pathClosed) {
          // Terminal dwell on the final key.
          const key = keys[i];
          const hold = Math.max(0, key.hold);
          this.entries.push({
            keyIndex: i,
            key,
            holdStart: cursor,
            holdEnd: cursor + hold,
            travelStart: cursor + hold,
            travelEnd: cursor + hold,
            sStart: key.s,
            sEnd: key.s,
            distance: 0,
            speed: 0,
            ease: key.ease,
            closesLoop: false,
          });
          cursor += hold;
          break;
        }
        const nextIndex = (i + 1) % n;
        // For a closed path the final leg overshoots past 1 and wraps, so the
        // camera always travels forward along the curve.
        const nextS = last ? keys[nextIndex].s + 1 : keys[nextIndex].s;
        const sStart = keys[i].s;
        const sEnd = nextS;
        const span = nextS - sStart;
        pushEntry(i, sStart, sEnd, span, last);
      }
    }

    this.duration = Math.max(cursor, 0);
  }

  /** Time at which a key's dwell begins. */
  keyStartTime(keyIndex: number): number {
    const entry = this.entries.find((e) => e.keyIndex === keyIndex);
    return entry ? entry.holdStart : 0;
  }

  keyHoldDuration(keyIndex: number): number {
    const entry = this.entries.find((e) => e.keyIndex === keyIndex);
    return entry ? entry.holdEnd - entry.holdStart : 0;
  }

  entryForTime(time: number): { entry: TimelineEntry; local: 'hold' | 'travel' | 'end' } | null {
    if (this.entries.length === 0) return null;
    const t = clamp(time, 0, this.duration);
    for (const entry of this.entries) {
      if (t >= entry.holdStart && t < entry.holdEnd) return { entry, local: 'hold' };
      if (t >= entry.travelStart && t < entry.travelEnd) return { entry, local: 'travel' };
    }
    const last = this.entries[this.entries.length - 1];
    if (this.closed && this.duration > 0 && t >= this.duration) {
      return { entry: this.entries[0], local: 'end' };
    }
    return { entry: last, local: 'end' };
  }

  evaluate(time: number): TimelineState {
    const clamped = clamp(time, 0, this.duration);
    const found = this.entryForTime(clamped);
    if (!found) {
      return { time: clamped, s: 0, phase: 'end', keyIndex: 0, segmentIndex: 0, progress: 0 };
    }
    const { entry, local } = found;
    if (local === 'hold') {
      return {
        time: clamped,
        s: entry.sStart,
        phase: 'hold',
        keyIndex: entry.keyIndex,
        segmentIndex: this.entries.indexOf(entry),
        progress: 0,
      };
    }
    if (local === 'travel') {
      const span = entry.travelEnd - entry.travelStart;
      const progress = span > 1e-9 ? (clamped - entry.travelStart) / span : 1;
      const eased = applyEase(entry.ease, progress);
      const rawS = entry.sStart + (entry.sEnd - entry.sStart) * eased;
      const s = this.closed ? ((rawS % 1) + 1) % 1 : clamp(rawS, 0, 1);
      return {
        time: clamped,
        s,
        phase: 'travel',
        keyIndex: entry.keyIndex,
        segmentIndex: this.entries.indexOf(entry),
        progress,
      };
    }
    // End: sits on the final key (or on the loop's first key when closed).
    const terminalS = this.closed
      ? this.entries[0].sStart
      : entry.sEnd;
    return {
      time: clamped,
      s: this.closed ? ((terminalS % 1) + 1) % 1 : terminalS,
      phase: 'end',
      keyIndex: entry.keyIndex,
      segmentIndex: this.entries.indexOf(entry),
      progress: 1,
    };
  }

  /** Find the nearest key to a path parameter (used when creating keys). */
  nearestKeyIndex(s: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.keys.length; i++) {
      const d = Math.abs(this.keys[i].s - s);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  }
}
