export interface Point {
  x: number;
  y: number;
}

export interface Frame {
  point: Point;
  tangent: Point;
  /** Angle in SVG/canvas coordinates; positive values rotate clockwise visually. */
  angle: number;
}

export interface CubicSegment {
  p0: Point;
  c1: Point;
  c2: Point;
  p1: Point;
}

export interface PathAnchor extends Point {
  /** When false, this anchor is treated as a corner by the editor. */
  smooth?: boolean;
}

export interface CurveConfig {
  closed: boolean;
  anchors: PathAnchor[];
  /** Catmull-Rom handle factor; 1/6 is the standard centripetal-ish spline. */
  tension?: number;
}

interface ArcSample {
  t: number;
  distance: number;
}

interface SegmentGeometry {
  cubic: CubicSegment;
  length: number;
  start: number;
  samples: ArcSample[];
}

const EPSILON = 1e-9;

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Point, factor: number): Point {
  return { x: a.x * factor, y: a.y * factor };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function modulo(value: number, size: number): number {
  if (size <= 0) return 0;
  return ((value % size) + size) % size;
}

function cubicPoint(segment: CubicSegment, t: number): Point {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * segment.p0.x + b * segment.c1.x + c * segment.c2.x + d * segment.p1.x,
    y: a * segment.p0.y + b * segment.c1.y + c * segment.c2.y + d * segment.p1.y,
  };
}

function cubicDerivative(segment: CubicSegment, t: number): Point {
  const mt = 1 - t;
  return {
    x:
      3 * mt * mt * (segment.c1.x - segment.p0.x) +
      6 * mt * t * (segment.c2.x - segment.c1.x) +
      3 * t * t * (segment.p1.x - segment.c2.x),
    y:
      3 * mt * mt * (segment.c1.y - segment.p0.y) +
      6 * mt * t * (segment.c2.y - segment.c1.y) +
      3 * t * t * (segment.p1.y - segment.c2.y),
  };
}

function normalize(v: Point): Point {
  const length = Math.hypot(v.x, v.y);
  if (length < EPSILON) return { x: 1, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

/** Build cubic segments through editable anchors. */
export function cubicSegmentsFromAnchors(config: CurveConfig): CubicSegment[] {
  const points = config.anchors;
  if (points.length < 2) {
    throw new Error('曲线至少需要两个锚点');
  }

  const factor = config.tension ?? 1 / 6;
  const closed = config.closed;
  const count = points.length;
  const segmentCount = closed ? count : count - 1;
  const at = (index: number): Point => {
    if (closed) return points[(index + count) % count];
    if (index < 0) {
      // Reflect the endpoint to make the first handle aim toward point 1.
      return { x: 2 * points[0].x - points[1].x, y: 2 * points[0].y - points[1].y };
    }
    if (index >= count) {
      const last = points[count - 1];
      const before = points[count - 2];
      return { x: 2 * last.x - before.x, y: 2 * last.y - before.y };
    }
    return points[index];
  };

  const segments: CubicSegment[] = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const p0 = at(i);
    const p1 = at(i + 1);

    let c1: Point;
    let c2: Point;

    if (points[i]?.smooth === false) {
      c1 = { ...p0 };
    } else {
      const before = at(i - 1);
      const after = at(i + 1);
      c1 = {
        x: p0.x + (after.x - before.x) * factor,
        y: p0.y + (after.y - before.y) * factor,
      };
    }

    const endIndex = (i + 1) % count;
    if (points[endIndex]?.smooth === false) {
      c2 = { ...p1 };
    } else {
      const before = at(i);
      const after = at(i + 2);
      c2 = {
        x: p1.x - (after.x - before.x) * factor,
        y: p1.y - (after.y - before.y) * factor,
      };
    }

    segments.push({ p0, c1, c2, p1 });
  }
  return segments;
}

export function curveToSvgPath(config: CurveConfig): string {
  const segments = cubicSegmentsFromAnchors(config);
  if (segments.length === 0) return '';
  const first = segments[0].p0;
  const parts = [`M ${round(first.x)} ${round(first.y)}`];
  for (const segment of segments) {
    parts.push(
      `C ${round(segment.c1.x)} ${round(segment.c1.y)} ${round(segment.c2.x)} ${round(
        segment.c2.y,
      )} ${round(segment.p1.x)} ${round(segment.p1.y)}`,
    );
  }
  if (config.closed) parts.push('Z');
  return parts.join(' ');
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Arc-length parameterized cubic curve. All layout distances are SVG user units. */
export class ArcLengthCurve {
  readonly closed: boolean;
  readonly length: number;
  readonly segments: readonly SegmentGeometry[];
  readonly cubicSegments: readonly CubicSegment[];

  constructor(
    segments: CubicSegment[],
    closed = false,
    readonly samplesPerSegment = 72,
  ) {
    if (segments.length === 0) throw new Error('曲线不能为空');
    this.closed = closed;
    this.cubicSegments = segments;

    let cursor = 0;
    this.segments = segments.map((cubic) => {
      const samples: ArcSample[] = [{ t: 0, distance: 0 }];
      let segmentLength = 0;
      let previous = cubicPoint(cubic, 0);

      for (let i = 1; i <= samplesPerSegment; i += 1) {
        const t = i / samplesPerSegment;
        const current = cubicPoint(cubic, t);
        segmentLength += distance(previous, current);
        samples.push({ t, distance: segmentLength });
        previous = current;
      }

      const geometry: SegmentGeometry = {
        cubic,
        length: segmentLength,
        start: cursor,
        samples,
      };
      cursor += segmentLength;
      return geometry;
    });

    this.length = cursor;
  }

  static fromAnchors(config: CurveConfig): ArcLengthCurve {
    return new ArcLengthCurve(cubicSegmentsFromAnchors(config), config.closed);
  }

  wrapDistance(rawDistance: number): number {
    return this.closed ? modulo(rawDistance, this.length) : clamp(rawDistance, 0, this.length);
  }

  /** Frame at a path-coordinate distance. Closed curves wrap; open curves clamp unless extrapolation is requested for diagnostics. */
  frameAt(distanceAlongPath: number, extrapolate = false): Frame {
    if (this.closed) {
      return this.rawFrameAt(modulo(distanceAlongPath, this.length));
    }

    if (extrapolate && distanceAlongPath < 0) {
      const edge = this.rawFrameAt(0);
      return {
        ...edge,
        point: add(edge.point, scale(edge.tangent, distanceAlongPath)),
      };
    }
    if (extrapolate && distanceAlongPath > this.length) {
      const edge = this.rawFrameAt(this.length);
      return {
        ...edge,
        point: add(edge.point, scale(edge.tangent, distanceAlongPath - this.length)),
      };
    }

    const distance = clamp(distanceAlongPath, 0, this.length);
    return this.rawFrameAt(distance);
  }

  private rawFrameAt(distance: number): Frame {
    const d = clamp(distance, 0, this.length);
    let segmentIndex = this.segments.findIndex(
      (segment) => d <= segment.start + segment.length + EPSILON,
    );
    if (segmentIndex < 0) segmentIndex = this.segments.length - 1;
    if (d <= EPSILON) segmentIndex = 0;

    const segment = this.segments[segmentIndex];
    const localDistance = clamp(d - segment.start, 0, segment.length);

    let low = 0;
    let high = segment.samples.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >> 1;
      if (segment.samples[middle].distance <= localDistance) low = middle;
      else high = middle;
    }

    const a = segment.samples[low];
    const b = segment.samples[high];
    const span = b.distance - a.distance;
    const fraction = span < EPSILON ? 0 : (localDistance - a.distance) / span;
    const t = clamp(a.t + (b.t - a.t) * fraction, 0, 1);

    const point = cubicPoint(segment.cubic, t);
    const tangent = normalize(cubicDerivative(segment.cubic, t));
    return { point, tangent, angle: Math.atan2(tangent.y, tangent.x) };
  }

  /** Nearest raw arc distance and point for an editor pointer position. */
  nearestDistance(point: Point): { distance: number; point: Point; delta: number } {
    let bestDistance = 0;
    let bestPoint: Point = { ...this.segments[0].cubic.p0 };
    let bestDelta = Infinity;

    for (const segment of this.segments) {
      for (const sample of segment.samples) {
        const candidate = cubicPoint(segment.cubic, sample.t);
        const delta = distance(candidate, point);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPoint = candidate;
          bestDistance = segment.start + sample.distance;
        }
      }
    }
    return { distance: bestDistance, point: bestPoint, delta: bestDelta };
  }
}

/**
 * Keep the glyph top pointing towards the top of the canvas.
 * A path-following angle is upright when cos(angle) > 0 in y-down coordinates.
 */
export function uprightAngle(angle: number): number {
  let normalized = modulo(angle + Math.PI, Math.PI * 2) - Math.PI;
  if (Math.cos(normalized) < 0) {
    normalized += normalized > 0 ? -Math.PI : Math.PI;
  }
  return normalized;
}
