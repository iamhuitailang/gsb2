import { describe, expect, it } from 'vitest';
import { layoutText } from '../src/core/layout';
import { ArcLengthCurve, uprightAngle } from '../src/core/geometry';
import { graphemes } from '../src/core/text';
import { lineSegment, measurer, rectangleCurve, straightCurve, testConfig } from './helpers';

describe('open paths: exact endpoints and direction', () => {
  it('places exactly the characters whose advances fit, with no extra endpoint glyph', () => {
    const curve = straightCurve(100);
    const exact = layoutText(testConfig({ text: 'ABCDE' }), measurer, curve);

    expect(exact.accepted).toBe(true);
    expect(exact.status).toBe('ready');
    expect(exact.placedGlyphs).toHaveLength(5);
    expect(exact.report.requiredLength).toBeCloseTo(100, 6);
    expect(exact.report.unusedLength).toBeCloseTo(0, 6);
    expect(exact.limitGlyphIndexes).toContain(4);

    const tooLong = layoutText(testConfig({ text: 'ABCDEF' }), measurer, curve);
    expect(tooLong.accepted).toBe(false);
    expect(tooLong.status).toBe('rejected');
    expect(tooLong.placedGlyphs).toHaveLength(0);
    expect(tooLong.glyphs).toHaveLength(6);
    expect(tooLong.glyphs[5].position.x).toBeGreaterThan(tooLong.glyphs[4].position.x);
  });

  it('lays reverse text from the adjusted start toward distance zero in text order', () => {
    const curve = straightCurve(100);
    const config = testConfig(
      { text: 'ABCDE' },
      {
        startDistance: 100,
        direction: 'backward',
      },
    );
    const result = layoutText(config, measurer, curve);

    expect(result.accepted).toBe(true);
    expect(result.glyphs.map((g) => g.grapheme).join('')).toBe('ABCDE');
    expect(result.glyphs.map((g) => g.index)).toEqual([0, 1, 2, 3, 4]);

    const travels = result.glyphs.map((g) => g.midTravel);
    expect([...travels].sort((a, b) => a - b)).toEqual(travels);

    const rawDistances = result.glyphs.map((g) => g.unwrappedDistance);
    expect(rawDistances[0]).toBeCloseTo(90, 5);
    expect(rawDistances[4]).toBeCloseTo(10, 5);
    expect(result.report.endUnwrappedDistance).toBeCloseTo(0, 6);
    expect(result.report.endpointMargin).toBeCloseTo(0, 6);
  });

  it('uses an interior start and reports inspectable start/end distances', () => {
    const curve = straightCurve(120);
    const config = testConfig({ text: 'ABC' }, { startDistance: 40 });
    const result = layoutText(config, measurer, curve);

    expect(result.accepted).toBe(true);
    expect(result.report.startDistance).toBe(40);
    expect(result.report.availableLength).toBe(80);
    expect(result.report.requiredLength).toBe(60);
    expect(result.report.endUnwrappedDistance).toBeCloseTo(100, 6);
    expect(result.report.endpointMargin).toBeCloseTo(20, 6);
    expect(result.glyphs[0].unwrappedDistance).toBeCloseTo(50, 5);
  });
});

describe('fit policy', () => {
  it('shrinks to the largest size that fits', () => {
    const curve = straightCurve(100);
    const config = testConfig(
      { text: 'ABCDEF' },
      {
        fit: 'shrink',
        minFontSize: 12,
      },
    );
    const result = layoutText(config, measurer, curve);

    expect(result.status).toBe('shrunk');
    expect(result.accepted).toBe(true);
    expect(result.glyphs).toHaveLength(6);
    expect(result.report.scale).toBeCloseTo(100 / 120, 5);
    expect(result.report.fontSize).toBeCloseTo(16.6667, 3);
    expect(result.report.requiredLength).toBeLessThanOrEqual(100 + 1e-6);
  });

  it('rejects instead of silently truncating in reject mode', () => {
    const curve = straightCurve(100);
    const config = testConfig({ text: 'ABCDEF' }, { fit: 'reject' });
    const result = layoutText(config, measurer, curve);

    expect(result.status).toBe('rejected');
    expect(result.accepted).toBe(false);
    expect(result.placedGlyphs).toHaveLength(0);
    expect(result.rejectionReason).toContain('路径过短');
  });

  it('rejects when even the minimum shrink size is too large', () => {
    const curve = straightCurve(50);
    const config = testConfig(
      { text: 'ABCDE' },
      {
        fit: 'shrink',
        minFontSize: 12,
      },
    );
    const result = layoutText(config, measurer, curve);

    expect(result.status).toBe('rejected');
    expect(result.report.fontSize).toBe(12);
    expect(result.rejectionReason).toContain('缩到最小');
  });
});

describe('unicode and spacing', () => {
  it('segments Chinese, composed/decomposed accents, and spaces as user-perceived glyphs', () => {
    // café is NFD; the final é is also intentionally decomposed.
    const text = '中文 café é';
    const clusters = graphemes(text);

    expect(clusters).toHaveLength(9);
    expect(clusters[0]).toBe('中');
    expect(clusters[1]).toBe('文');
    expect(clusters[2]).toBe(' ');
    expect(clusters[6]).toBe('é');
    expect(clusters[7]).toBe(' ');
    expect(clusters[8]).toBe('é');

    const curve = straightCurve(200);
    const result = layoutText(testConfig({ text: '中 é' }), measurer, curve);
    expect(result.glyphs.map((g) => g.grapheme)).toEqual(['中', ' ', 'é']);
    expect(result.glyphs[1].advance).toBeCloseTo(10, 6);
  });
});

describe('upright hairpin orientation', () => {
  it('flips upside-down directed angles while preserving text order', () => {
    expect(uprightAngle(Math.PI)).toBeCloseTo(0, 8);
    expect(uprightAngle(-Math.PI)).toBeCloseTo(0, 8);
    expect(uprightAngle((3 * Math.PI) / 4)).toBeGreaterThan(-Math.PI / 2);
    expect(uprightAngle((3 * Math.PI) / 4)).toBeLessThan(Math.PI / 2);

    const curve = rectangleCurve();
    const pathFollowing = layoutText(testConfig({ text: 'ABCDEFGHIJK' }), measurer, curve);
    expect(pathFollowing.glyphs.some((g) => Math.cos(g.angle) < -0.99)).toBe(true);

    const upright = layoutText(
      testConfig({ text: 'ABCDEFGHIJK' }, { orientation: 'upright' }),
      measurer,
      curve,
    );
    expect(upright.glyphs.every((g) => Math.cos(g.angle) >= -1e-6)).toBe(true);
    expect(upright.glyphs.map((g) => g.grapheme).join('')).toBe('ABCDEFGHIJK');
    expect(upright.glyphs.map((g) => g.index)).toEqual(
      pathFollowing.glyphs.map((g) => g.index),
    );
  });

  it('keeps reverse horizontal text upright without reversing the logical glyph sequence', () => {
    const curve = straightCurve(100);
    const result = layoutText(
      testConfig(
        { text: 'ABCDE' },
        {
          startDistance: 100,
          direction: 'backward',
          orientation: 'upright',
        },
      ),
      measurer,
      curve,
    );

    expect(result.glyphs.map((g) => g.grapheme).join('')).toBe('ABCDE');
    expect(result.glyphs.every((g) => Math.abs(g.angle) < 1e-6)).toBe(true);
    expect(result.glyphs[0].position.x).toBeGreaterThan(result.glyphs[4].position.x);
  });
});

describe('sharp-bend overlap avoidance', () => {
  it('adjusts spacing around a right-angle bend and reports no collisions', () => {
    const curve = new ArcLengthCurve(
      [lineSegment(0, 0, 100, 0), lineSegment(100, 0, 100, 100)],
      false,
    );

    const crowded = layoutText(
      testConfig({ text: 'ABCDEFGH' }, { avoidOverlap: false, fit: 'shrink' }),
      measurer,
      curve,
    );
    expect(crowded.collisions.length).toBeGreaterThan(0);

    const adjusted = layoutText(
      testConfig(
        { text: 'ABCDEFGH' },
        {
          avoidOverlap: true,
          fit: 'shrink',
          overlapClearance: 1,
        },
      ),
      measurer,
      curve,
    );

    expect(adjusted.accepted).toBe(true);
    expect(adjusted.collisions).toHaveLength(0);
    expect(adjusted.report.requiredLength).toBeGreaterThanOrEqual(
      adjusted.report.naturalLength - 1e-6,
    );
  });
});
