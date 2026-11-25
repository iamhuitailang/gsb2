import { ArcLengthCurve, type CubicSegment } from '../src/core/geometry';
import { createDefaultConfig, type LayoutSettings, type ToolConfig } from '../src/core/config';
import { FixedWidthMeasurer } from '../src/core/text';

export function lineSegment(x1: number, y1: number, x2: number, y2: number): CubicSegment {
  return {
    p0: { x: x1, y: y1 },
    c1: { x: x1 + (x2 - x1) / 3, y: y1 + (y2 - y1) / 3 },
    c2: { x: x1 + (2 * (x2 - x1)) / 3, y: y1 + (2 * (y2 - y1)) / 3 },
    p1: { x: x2, y: y2 },
  };
}

export function straightCurve(length = 100): ArcLengthCurve {
  return new ArcLengthCurve([lineSegment(0, 0, length, 0)], false);
}

/** Rectangle perimeter 300: top 100, right 50, bottom 100 right-to-left, left 50. */
export function rectangleCurve(): ArcLengthCurve {
  return new ArcLengthCurve(
    [
      lineSegment(0, 0, 100, 0),
      lineSegment(100, 0, 100, 50),
      lineSegment(100, 50, 0, 50),
      lineSegment(0, 50, 0, 0),
    ],
    true,
  );
}

export function testConfig(
  overrides: Partial<ToolConfig> = {},
  layoutOverrides: Partial<LayoutSettings> = {},
): ToolConfig {
  const config = createDefaultConfig('inflection');
  return {
    ...config,
    ...overrides,
    text: overrides.text ?? 'ABCDE',
    font: { ...config.font, size: 20, weight: 500, ...overrides.font },
    curve: overrides.curve ?? config.curve,
    layout: {
      ...config.layout,
      startDistance: 0,
      direction: 'forward',
      fit: 'reject',
      minFontSize: 10,
      letterSpacing: 0,
      endPadding: 0,
      avoidOverlap: false,
      overlapClearance: 0,
      orientation: 'path',
      ...overrides.layout,
      ...layoutOverrides,
    },
  };
}

export const measurer = new FixedWidthMeasurer(20, 0.5);
