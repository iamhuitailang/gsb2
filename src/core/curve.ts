import type { Vec3 } from '../math/vec3.js';
import { add, addScaled, distance, normalize, scale, sub } from '../math/vec3.js';

const SAMPLES_PER_SEGMENT = 64;
const CENTRIPETAL_ALPHA = 0.5;
const EPS = 1e-9;

interface Segment {
  /** Knot parameter values for the four control points. */
  t0: number;
  t1: number;
  t2: number;
  t3: number;
  p0: Vec3;
  p1: Vec3;
  p2: Vec3;
  p3: Vec3;
  /** Sampled positions, 3 * (SAMPLES_PER_SEGMENT + 1). */
  samples: Float64Array;
  /** Cumulative length at each sample. */
  lengths: Float64Array;
  startLength: number;
}

export interface PathSample {
  position: Vec3;
  tangent: Vec3;
  /** Normalized arc-length parameter, 0..1 (may be outside for closed wrap input). */
  s: number;
  segment: number;
  /** Local normalized parameter inside the segment. */
  u: number;
}

export interface NearestResult {
  s: number;
  distance: number;
  position: Vec3;
}

function lerpKnot(a: Vec3, b: Vec3, wa: number, wb: number, den: number): Vec3 {
  const inv = 1 / (Math.abs(den) < EPS ? EPS : den);
  return [
    (a[0] * wa + b[0] * wb) * inv,
    (a[1] * wa + b[1] * wb) * inv,
    (a[2] * wa + b[2] * wb) * inv,
  ];
}

/**
 * Centripetal Catmull-Rom interpolating spline through control points.
 * C1 continuous at every knot and closed loops wrap seamlessly.
 */
export class PathSpline {
  readonly positions: Vec3[];
  readonly closed: boolean;
  readonly totalLength: number;
  private readonly segments: Segment[] = [];

  constructor(positions: Vec3[], closed: boolean) {
    this.positions = positions.map((p) => [p[0], p[1], p[2]] as Vec3);
    const n = this.positions.length;
    this.closed = closed && n >= 3;

    if (n >= 2) {
      const segCount = this.closed ? n : n - 1;
      let cumulative = 0;
      for (let i = 0; i < segCount; i++) {
        const seg = this.buildSegment(i);
        seg.startLength = cumulative;
        cumulative += seg.lengths[seg.lengths.length - 1];
        this.segments.push(seg);
      }
      this.totalLength = cumulative;
    } else if (n === 1) {
      // Degenerate path with a single point: zero-length segment for stable sampling.
      const p = this.positions[0];
      const samples = new Float64Array(3);
      samples.set(p, 0);
      const lengths = new Float64Array(1);
      this.segments.push({
        t0: 0, t1: 0, t2: 1, t3: 1,
        p0: p, p1: p, p2: p, p3: p,
        samples,
        lengths,
        startLength: 0,
      });
      this.totalLength = 0;
    } else {
      this.totalLength = 0;
    }
  }

  get segmentCount(): number {
    return this.segments.length;
  }

  private controlPoint(index: number): Vec3 {
    const n = this.positions.length;
    if (this.closed) return this.positions[((index % n) + n) % n];
    return this.positions[Math.max(0, Math.min(n - 1, index))];
  }

  private buildSegment(i: number): Segment {
    const n = this.positions.length;
    const p1 = this.controlPoint(i);
    const p2 = this.controlPoint(i + 1);
    let p0: Vec3;
    let p3: Vec3;
    if (this.closed) {
      p0 = this.controlPoint(i - 1);
      p3 = this.controlPoint(i + 2);
    } else {
      p0 = i > 0 ? this.positions[i - 1] : [p1[0] * 2 - p2[0], p1[1] * 2 - p2[1], p1[2] * 2 - p2[2]];
      p3 = i + 2 < n ? this.positions[i + 2] : [p2[0] * 2 - p1[0], p2[1] * 2 - p1[1], p2[2] * 2 - p1[2]];
    }

    const knot = (a: Vec3, b: Vec3) => Math.max(1e-4, Math.pow(Math.max(distance(a, b), 1e-6), CENTRIPETAL_ALPHA));
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);

    const seg: Segment = {
      t0, t1, t2, t3, p0, p1, p2, p3,
      samples: new Float64Array(3 * (SAMPLES_PER_SEGMENT + 1)),
      lengths: new Float64Array(SAMPLES_PER_SEGMENT + 1),
      startLength: 0,
    };

    let acc = 0;
    let prev: Vec3 | null = null;
    for (let k = 0; k <= SAMPLES_PER_SEGMENT; k++) {
      const local = t1 + ((t2 - t1) * k) / SAMPLES_PER_SEGMENT;
      const p = this.evalSegment(seg, local);
      seg.samples[3 * k] = p[0];
      seg.samples[3 * k + 1] = p[1];
      seg.samples[3 * k + 2] = p[2];
      if (prev) acc += distance(prev, p);
      seg.lengths[k] = acc;
      prev = p;
    }
    return seg;
  }

  /** Barry-Goldman evaluation of the centripetal Catmull-Rom segment. */
  private evalSegment(seg: Segment, t: number): Vec3 {
    const { t0, t1, t2, t3, p0, p1, p2, p3 } = seg;
    const a1 = lerpKnot(p0, p1, t1 - t, t - t0, t1 - t0);
    const a2 = lerpKnot(p1, p2, t2 - t, t - t1, t2 - t1);
    const a3 = lerpKnot(p2, p3, t3 - t, t - t2, t3 - t2);
    const b1 = lerpKnot(a1, a2, t2 - t, t - t0, t2 - t0);
    const b2 = lerpKnot(a2, a3, t3 - t, t - t1, t3 - t1);
    return lerpKnot(b1, b2, t2 - t, t - t1, t2 - t1);
  }

  private segmentByLength(target: number): { seg: Segment; index: number } {
    const segs = this.segments;
    if (segs.length === 0) {
      throw new Error('Path has no segments');
    }
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const end = segs[mid].startLength + segs[mid].lengths[segs[mid].lengths.length - 1];
      if (target <= end) hi = mid;
      else lo = mid + 1;
    }
    // Skip zero-length trailing segments when target equals total length.
    let index = lo;
    while (
      index > 0 &&
      target <= segs[index].startLength + EPS &&
      segs[index].lengths[segs[index].lengths.length - 1] <= EPS
    ) {
      index -= 1;
    }
    return { seg: segs[index], index };
  }

  /** Sample position and tangent by normalized arc-length parameter. */
  sampleAt(s: number): PathSample {
    if (this.segments.length === 0) {
      return { position: [0, 0, 0], tangent: [0, 0, 1], s, segment: 0, u: 0 };
    }
    const wrapped = this.closed ? ((s % 1) + 1) % 1 : Math.max(0, Math.min(1, s));
    const target = wrapped * this.totalLength;
    const { seg, index } = this.segmentByLength(target);
    const localLength = Math.max(0, Math.min(target - seg.startLength, seg.lengths[seg.lengths.length - 1]));

    const lengths = seg.lengths;
    let lo = 0;
    let hi = lengths.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (lengths[mid] <= localLength) lo = mid;
      else hi = mid;
    }
    const span = lengths[hi] - lengths[lo];
    const frac = span > EPS ? (localLength - lengths[lo]) / span : 0;
    const u = (lo + frac) / SAMPLES_PER_SEGMENT;
    const knot = seg.t1 + (seg.t2 - seg.t1) * u;
    const position = this.evalSegment(seg, knot);
    const tangent = this.tangentOf(seg, knot, u);
    return { position, tangent, s: wrapped, segment: index, u };
  }

  private tangentOf(seg: Segment, knot: number, u: number): Vec3 {
    const span = seg.t2 - seg.t1;
    const delta = Math.max(span * 1e-4, 1e-7);
    let a = knot - delta;
    let b = knot + delta;
    if (a < seg.t1) {
      a = seg.t1;
      b = seg.t1 + delta * 2;
    }
    if (b > seg.t2) {
      b = seg.t2;
      a = seg.t2 - delta * 2;
    }
    const pa = this.evalSegment(seg, a);
    const pb = this.evalSegment(seg, b);
    const dir = sub(pb, pa);
    if (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2] < 1e-18) {
      // Fall back to finite difference against the sample neighbourhood.
      const k = Math.max(0, Math.min(SAMPLES_PER_SEGMENT, Math.round(u * SAMPLES_PER_SEGMENT)));
      const k2 = Math.min(SAMPLES_PER_SEGMENT, k + 1);
      const k1 = Math.max(0, k2 - 1);
      const s0: Vec3 = [seg.samples[3 * k1], seg.samples[3 * k1 + 1], seg.samples[3 * k1 + 2]];
      const s1: Vec3 = [seg.samples[3 * k2], seg.samples[3 * k2 + 1], seg.samples[3 * k2 + 2]];
      return normalize(sub(s1, s0), [0, 0, 1]);
    }
    return normalize(dir, [0, 0, 1]);
  }

  positionAt(s: number): Vec3 {
    return this.sampleAt(s).position;
  }

  tangentAt(s: number): Vec3 {
    return this.sampleAt(s).tangent;
  }

  /** Uniformly spaced polyline for drawing. */
  polyline(samplesPerSegment = 24): Vec3[] {
    const out: Vec3[] = [];
    const count = Math.max(2, this.segments.length * samplesPerSegment);
    for (let i = 0; i <= count; i++) {
      const s = i / count;
      out.push(this.positionAt(this.closed ? s % 1 : s));
    }
    if (!this.closed && out.length > 1) out[out.length - 1] = this.positionAt(1);
    return out;
  }

  nearest(target: Vec3): NearestResult {
    if (this.segments.length === 0) {
      return { s: 0, distance: Infinity, position: [0, 0, 0] };
    }
    let bestS = 0;
    let bestDist = Infinity;
    let bestPos: Vec3 = this.positions[0] ?? [0, 0, 0];
    const totalSamples = Math.max(64, this.segments.length * 96);
    for (let i = 0; i <= totalSamples; i++) {
      const s = i / totalSamples;
      const p = this.positionAt(this.closed ? s % 1 : s);
      const d = distance(p, target);
      if (d < bestDist) {
        bestDist = d;
        bestS = s;
        bestPos = p;
      }
    }
    // Local refinement (ternary search) around the best coarse hit.
    let lo = bestS - 1 / totalSamples;
    let hi = bestS + 1 / totalSamples;
    if (!this.closed) {
      lo = Math.max(0, lo);
      hi = Math.min(1, hi);
    }
    for (let iter = 0; iter < 24; iter++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      const p1 = this.positionAt(m1);
      const p2 = this.positionAt(m2);
      const d1 = distance(p1, target);
      const d2 = distance(p2, target);
      if (d1 < d2) hi = m2;
      else lo = m1;
      if (d1 < bestDist) {
        bestDist = d1;
        bestS = m1;
        bestPos = p1;
      }
      if (d2 < bestDist) {
        bestDist = d2;
        bestS = m2;
        bestPos = p2;
      }
    }
    const wrapped = this.closed ? ((bestS % 1) + 1) % 1 : Math.max(0, Math.min(1, bestS));
    return { s: wrapped, distance: bestDist, position: bestPos };
  }

  /**
   * Index at which a new control point should be inserted so that it lies
   * after the segment containing `s`.
   */
  insertionIndexForS(s: number): number {
    const n = this.positions.length;
    if (n <= 1) return n;
    const wrapped = this.closed ? ((s % 1) + 1) % 1 : Math.max(0, Math.min(1, s));
    const target = wrapped * this.totalLength;
    let index = this.segmentByLength(target).index;
    if (this.closed && index >= n - 1 && wrapped > 0.999) return n;
    return Math.min(n, index + 1);
  }

  bounds(): { min: Vec3; max: Vec3 } {
    if (this.positions.length === 0) {
      return { min: [-1, -1, -1], max: [1, 1, 1] };
    }
    const min: Vec3 = [Infinity, Infinity, Infinity];
    const max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const p of this.positions) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i];
        if (p[i] > max[i]) max[i] = p[i];
      }
    }
    return { min, max };
  }

  /** Offset a point tangentially (used by the "smooth" helper). */
  static offsetPoint(p: Vec3, dir: Vec3, amount: number): Vec3 {
    return addScaled(p, normalize(dir), amount);
  }

  static midpoint(a: Vec3, b: Vec3): Vec3 {
    return scale(add(a, b), 0.5);
  }
}
