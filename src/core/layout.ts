import {
  ArcLengthCurve,
  clamp,
  modulo,
  uprightAngle,
  type Point,
} from './geometry';
import { graphemes, type BBox, type TextMeasurer } from './text';
import type { ToolConfig } from './config';

export type LayoutStatus = 'empty' | 'ready' | 'shrunk' | 'rejected';

export interface GlyphPlacement {
  index: number;
  grapheme: string;
  fontSize: number;
  /** Travel-coordinate interval, always increasing in text order. */
  startTravel: number;
  endTravel: number;
  midTravel: number;
  advance: number;
  /** Positive path coordinate at the glyph midpoint; may be outside [0, length]. */
  unwrappedDistance: number;
  /** Render distance after closed-path modulo / open-path clamp. */
  pathDistance: number;
  position: Point;
  angle: number;
  angleDeg: number;
  corners: Point[];
  crossesSeam: boolean;
  touchesSeam: boolean;
  touchesPathStart: boolean;
  touchesPathEnd: boolean;
  withinLimit: boolean;
  touchesLimit: boolean;
  collidesWith: number[];
}

export interface DistanceReport {
  pathLength: number;
  startDistance: number;
  startWrapped: number;
  availableLength: number;
  naturalLength: number;
  requiredLength: number;
  unusedLength: number;
  scale: number;
  fontSize: number;
  /** Positive path coordinate of the last glyph's far edge. */
  endUnwrappedDistance: number;
  endWrappedDistance: number;
  /** Open-path margin from the last far edge to the physical endpoint. */
  endpointMargin: number | null;
  seamForwardDistance: number | null;
  seamBackwardDistance: number | null;
}

export interface LayoutResult {
  status: LayoutStatus;
  accepted: boolean;
  text: string;
  glyphs: GlyphPlacement[];
  /** Empty when fit policy is reject and no size is accepted. */
  placedGlyphs: GlyphPlacement[];
  collisions: Array<[number, number]>;
  limitGlyphIndexes: number[];
  seamGlyphIndexes: number[];
  report: DistanceReport;
  rejectionReason?: string;
}

interface BuildResult {
  glyphs: GlyphPlacement[];
  requiredLength: number;
  naturalLength: number;
  collisions: Array<[number, number]>;
}

const FIT_EPSILON = 1e-6;
const TOUCH_EPSILON = 0.75;

function centeredCorners(
  bbox: BBox,
  center: Point,
  angle: number,
  advance: number,
  clearance: number,
): Point[] {
  // text-anchor="middle" shifts the left-origin metrics by -advance / 2.
  const minX = bbox.minX - advance / 2 - clearance;
  const maxX = bbox.maxX - advance / 2 + clearance;
  const minY = bbox.minY - clearance;
  const maxY = bbox.maxY + clearance;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ].map((p) => ({
    x: center.x + cos * p.x - sin * p.y,
    y: center.y + sin * p.x + cos * p.y,
  }));
}

function projectPolygon(polygon: Point[], axis: Point): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    const value = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

function polygonsIntersect(a: Point[], b: Point[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i += 1) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % polygon.length];
      const edge = { x: p2.x - p1.x, y: p2.y - p1.y };
      const axis = { x: -edge.y, y: edge.x };
      const length = Math.hypot(axis.x, axis.y);
      if (length < FIT_EPSILON) continue;
      axis.x /= length;
      axis.y /= length;

      const pa = projectPolygon(a, axis);
      const pb = projectPolygon(b, axis);
      if (pa.max < pb.min || pb.max < pa.min) return false;
    }
  }
  return true;
}

function rawInterval(startDistance: number, directionSign: number, startTravel: number, endTravel: number) {
  const a = startDistance + directionSign * startTravel;
  const b = startDistance + directionSign * endTravel;
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

function seamFlags(curve: ArcLengthCurve, interval: { min: number; max: number }) {
  if (!curve.closed) {
    return { crossesSeam: false, touchesSeam: false };
  }
  const length = curve.length;
  const first = Math.ceil(interval.min / length - FIT_EPSILON);
  const last = Math.floor(interval.max / length + FIT_EPSILON);
  let crossesSeam = false;
  let touchesSeam = false;

  for (let k = first; k <= last; k += 1) {
    const seam = k * length;
    if (seam <= interval.min + TOUCH_EPSILON && seam >= interval.min - TOUCH_EPSILON) {
      touchesSeam = true;
    }
    if (seam <= interval.max + TOUCH_EPSILON && seam >= interval.max - TOUCH_EPSILON) {
      touchesSeam = true;
    }
    if (seam > interval.min + FIT_EPSILON && seam < interval.max - FIT_EPSILON) {
      crossesSeam = true;
    }
  }
  return { crossesSeam, touchesSeam };
}

function endpointFlags(curve: ArcLengthCurve, interval: { min: number; max: number }) {
  if (curve.closed) {
    return { touchesPathStart: false, touchesPathEnd: false };
  }
  return {
    touchesPathStart:
      Math.abs(interval.min) <= TOUCH_EPSILON || Math.abs(interval.max) <= TOUCH_EPSILON,
    touchesPathEnd:
      Math.abs(interval.min - curve.length) <= TOUCH_EPSILON ||
      Math.abs(interval.max - curve.length) <= TOUCH_EPSILON,
  };
}

export function layoutText(
  config: ToolConfig,
  measurer: TextMeasurer,
  curve: ArcLengthCurve = ArcLengthCurve.fromAnchors(config.curve),
): LayoutResult {
  const chars = graphemes(config.text);
  const pathLength = curve.length;
  const startDistance = clamp(config.layout.startDistance, 0, pathLength);
  const directionSign = config.layout.direction === 'backward' ? -1 : 1;
  // A closed route may cross its d=0 seam and continue for one full revolution;
  // its capacity ends when it returns to the adjustable start.
  const physicalAvailable = curve.closed
    ? pathLength
    : directionSign === 1
      ? pathLength - startDistance
      : startDistance;
  const availableLength = Math.max(0, physicalAvailable - config.layout.endPadding);

  const baseFontSize = config.font.size;
  const minScale = Math.min(1, Math.min(baseFontSize, config.layout.minFontSize) / baseFontSize);

  const build = (scale: number): BuildResult => {
    const fontSize = baseFontSize * scale;
    const letterSpacing = config.layout.letterSpacing * scale;
    const clearance = config.layout.overlapClearance * scale;
    const glyphs: GlyphPlacement[] = [];
    let cursor = 0;
    let naturalLength = 0;

    const makeGlyph = (index: number, intervalStart: number): GlyphPlacement => {
      const grapheme = chars[index];
      const metrics = measurer.measure(grapheme, {
        ...config.font,
        size: fontSize,
      });
      const advance = metrics.advance;
      const startTravel = intervalStart;
      const endTravel = intervalStart + advance;
      const midTravel = (startTravel + endTravel) / 2;
      const unwrappedDistance = startDistance + directionSign * midTravel;
      const pathDistance = curve.wrapDistance(unwrappedDistance);
      const frame = curve.frameAt(unwrappedDistance, true);
      const directedAngle =
        directionSign === 1 ? frame.angle : frame.angle + Math.PI;
      const angle =
        config.layout.orientation === 'upright'
          ? uprightAngle(directedAngle)
          : directedAngle;

      const bbox = metrics.ink ?? metrics.cell;
      const corners = centeredCorners(bbox, frame.point, angle, advance, clearance / 2);
      const interval = rawInterval(startDistance, directionSign, startTravel, endTravel);
      const seam = seamFlags(curve, interval);
      const endpoints = endpointFlags(curve, interval);
      const withinLimit = endTravel <= availableLength + FIT_EPSILON;
      const touchesLimit =
        withinLimit && Math.abs(availableLength - endTravel) <= TOUCH_EPSILON;

      return {
        index,
        grapheme,
        fontSize,
        startTravel,
        endTravel,
        midTravel,
        advance,
        unwrappedDistance,
        pathDistance,
        position: frame.point,
        angle,
        angleDeg: (angle * 180) / Math.PI,
        corners,
        ...seam,
        ...endpoints,
        withinLimit,
        touchesLimit,
        collidesWith: [],
      };
    };

    for (let i = 0; i < chars.length; i += 1) {
      if (i === 0) {
        cursor = 0;
      } else {
        const previous = glyphs[i - 1];
        cursor = previous.endTravel + letterSpacing;
        naturalLength += letterSpacing;
      }

      naturalLength += measurer.measure(chars[i], { ...config.font, size: fontSize }).advance;

      let glyph = makeGlyph(i, cursor);
      if (config.layout.avoidOverlap && i > 0) {
        const collidesNow = (candidate: GlyphPlacement) =>
          glyphs.some(
            (other) =>
              polygonsIntersect(candidate.corners, other.corners) &&
              // Spaces have null ink boxes and use a thin diagnostic box; do not
              // let a space alone force arbitrary extra tracking.
              candidate.grapheme.trim().length > 0 &&
              other.grapheme.trim().length > 0,
          );

        if (collidesNow(glyph)) {
          const maxExtra = fontSize * 5;
          let firstClear: number | null = null;
          for (let extra = 0.5; extra <= maxExtra + FIT_EPSILON; extra += 0.5) {
            const candidate = makeGlyph(i, cursor + extra);
            if (!collidesNow(candidate)) {
              firstClear = extra;
              break;
            }
          }

          if (firstClear !== null) {
            let low = Math.max(0, firstClear - 0.5);
            let high = firstClear;
            for (let iteration = 0; iteration < 9; iteration += 1) {
              const middle = (low + high) / 2;
              if (collidesNow(makeGlyph(i, cursor + middle))) low = middle;
              else high = middle;
            }
            glyph = makeGlyph(i, cursor + high);
          } else {
            glyph = makeGlyph(i, cursor + maxExtra);
          }
        }
      }

      glyphs.push(glyph);
      cursor = glyph.endTravel;
    }

    const collisions: Array<[number, number]> = [];
    for (let i = 0; i < glyphs.length; i += 1) {
      for (let j = i + 1; j < glyphs.length; j += 1) {
        if (
          chars[i].trim().length > 0 &&
          chars[j].trim().length > 0 &&
          polygonsIntersect(glyphs[i].corners, glyphs[j].corners)
        ) {
          collisions.push([i, j]);
          glyphs[i].collidesWith.push(j);
          glyphs[j].collidesWith.push(i);
        }
      }
    }

    const requiredLength = glyphs.length ? glyphs[glyphs.length - 1].endTravel : 0;
    return { glyphs, requiredLength, naturalLength, collisions };
  };

  const makeReport = (
    built: BuildResult,
    scale: number,
  ): DistanceReport => {
    const endUnwrappedDistance =
      startDistance + directionSign * built.requiredLength;
    const endWrappedDistance = curve.wrapDistance(endUnwrappedDistance);
    const endpointMargin = curve.closed
      ? null
      : directionSign === 1
        ? curve.length - endUnwrappedDistance
        : endUnwrappedDistance;

    return {
      pathLength,
      startDistance,
      startWrapped: curve.wrapDistance(startDistance),
      availableLength,
      naturalLength: built.naturalLength,
      requiredLength: built.requiredLength,
      unusedLength: availableLength - built.requiredLength,
      scale,
      fontSize: baseFontSize * scale,
      endUnwrappedDistance,
      endWrappedDistance,
      endpointMargin,
      seamForwardDistance: curve.closed
        ? modulo(pathLength - modulo(startDistance, pathLength), pathLength)
        : null,
      seamBackwardDistance: curve.closed ? modulo(startDistance, pathLength) : null,
    };
  };

  if (chars.length === 0) {
    const emptyBuild: BuildResult = {
      glyphs: [],
      requiredLength: 0,
      naturalLength: 0,
      collisions: [],
    };
    return {
      status: 'empty',
      accepted: true,
      text: config.text,
      glyphs: [],
      placedGlyphs: [],
      collisions: [],
      limitGlyphIndexes: [],
      seamGlyphIndexes: [],
      report: makeReport(emptyBuild, 1),
    };
  }

  const fits = (built: BuildResult) =>
    built.requiredLength <= availableLength + FIT_EPSILON &&
    (!config.layout.avoidOverlap || built.collisions.length === 0);

  const explainFailure = (built: BuildResult, sizeLabel: string): string => {
    if (built.requiredLength > availableLength + FIT_EPSILON) {
      return `路径过短：${sizeLabel}需要 ${built.requiredLength.toFixed(1)}，可用长度 ${availableLength.toFixed(1)}`;
    }
    if (config.layout.avoidOverlap && built.collisions.length > 0) {
      return `${sizeLabel}仍有 ${built.collisions.length} 对字框在急弯处相交；可继续缩小字号、放宽曲线或关闭防叠检查`;
    }
    return `${sizeLabel}无法满足当前路径限制`;
  };

  const requested = build(1);
  let acceptedBuild: BuildResult | null = null;
  let scale = 1;
  let status: LayoutStatus;
  let rejectionReason: string | undefined;

  if (fits(requested)) {
    acceptedBuild = requested;
    status = 'ready';
  } else if (config.layout.fit === 'shrink') {
    const minimum = build(minScale);
    if (fits(minimum)) {
      let low = minScale;
      let high = 1;
      for (let iteration = 0; iteration < 22; iteration += 1) {
        const middle = (low + high) / 2;
        if (fits(build(middle))) low = middle;
        else high = middle;
      }
      scale = low;
      acceptedBuild = build(scale);
      if (!fits(acceptedBuild)) {
        scale = minScale;
        acceptedBuild = minimum;
      }
      status = 'shrunk';
    } else {
      status = 'rejected';
      scale = minScale;
      rejectionReason = explainFailure(
        minimum,
        `缩到最小 ${config.layout.minFontSize}px 后`,
      );
    }
  } else {
    status = 'rejected';
    rejectionReason = explainFailure(requested, '当前字号下');
  }

  const diagnostic =
    status === 'rejected'
      ? build(config.layout.fit === 'shrink' ? minScale : 1)
      : (acceptedBuild as BuildResult);

  const finalBuild = status === 'rejected' ? diagnostic : (acceptedBuild as BuildResult);
  const limitGlyphIndexes = finalBuild.glyphs
    .filter((glyph) => glyph.touchesLimit || (!glyph.withinLimit && status === 'rejected'))
    .map((glyph) => glyph.index);
  const seamGlyphIndexes = finalBuild.glyphs
    .filter((glyph) => glyph.crossesSeam || glyph.touchesSeam)
    .map((glyph) => glyph.index);

  return {
    status,
    accepted: status !== 'rejected',
    text: config.text,
    glyphs: finalBuild.glyphs,
    placedGlyphs: status === 'rejected' ? [] : finalBuild.glyphs,
    collisions: finalBuild.collisions,
    limitGlyphIndexes,
    seamGlyphIndexes,
    report: makeReport(finalBuild, scale),
    rejectionReason,
  };
}
