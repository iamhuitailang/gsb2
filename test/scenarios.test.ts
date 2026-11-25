import { describe, expect, it } from 'vitest';
import { ArcLengthCurve } from '../src/core/geometry';
import { createDefaultConfig } from '../src/core/config';
import { layoutText } from '../src/core/layout';
import { measurer, rectangleCurve, testConfig } from './helpers';

const sampleText = '弯路 Café résumé 中文 ABC 123';

describe('required demonstration routes', () => {
  it('lays forward and backward text on the inflection line', () => {
    for (const direction of ['forward', 'backward'] as const) {
      const config = createDefaultConfig('inflection');
      config.text = sampleText;
      config.layout.direction = direction;
      config.layout.fit = 'shrink';

      const curve = ArcLengthCurve.fromAnchors(config.curve);
      config.layout.startDistance = direction === 'forward' ? 80 : curve.length - 80;
      const result = layoutText(config, measurer, curve);

      expect(result.accepted, result.rejectionReason).toBe(true);
      expect(result.glyphs.length).toBeGreaterThan(10);
      expect(result.glyphs.every((g) => Number.isFinite(g.position.x))).toBe(true);
      expect(result.glyphs.map((g) => g.index)).toEqual(
        Array.from({ length: result.glyphs.length }, (_, i) => i),
      );

      const travels = result.glyphs.map((g) => g.midTravel);
      expect(travels.every((value, i) => i === 0 || value > travels[i - 1])).toBe(true);
    }
  });

  it('keeps hairpin glyphs upward without changing the string sequence', () => {
    const config = createDefaultConfig('hairpin');
    const curve = ArcLengthCurve.fromAnchors(config.curve);
    config.layout.startDistance = curve.length * 0.2;
    config.text = '回头路AAAAAAAAAAAAAAAAAAAA';

    const following = layoutText(config, measurer, curve);
    expect(following.glyphs.some((glyph) => Math.cos(glyph.angle) < -0.9)).toBe(true);

    const upright = layoutText(
      { ...config, layout: { ...config.layout, orientation: 'upright' } },
      measurer,
      curve,
    );
    expect(upright.accepted).toBe(true);
    expect(upright.glyphs.every((glyph) => Math.cos(glyph.angle) >= -1e-6)).toBe(true);
    expect(upright.glyphs.map((glyph) => glyph.grapheme).join('')).toBe(config.text);
  });

  it('handles forward and backward text immediately beside the closed seam', () => {
    const config = createDefaultConfig('closed');
    config.text = sampleText;
    config.layout.fit = 'shrink';
    const curve = ArcLengthCurve.fromAnchors(config.curve);

    const forward = layoutText(
      {
        ...config,
        layout: { ...config.layout, startDistance: curve.length - 55, direction: 'forward' },
      },
      measurer,
      curve,
    );
    const backward = layoutText(
      {
        ...config,
        layout: { ...config.layout, startDistance: 55, direction: 'backward' },
      },
      measurer,
      curve,
    );

    expect(forward.accepted, forward.rejectionReason).toBe(true);
    expect(backward.accepted, backward.rejectionReason).toBe(true);
    expect(forward.seamGlyphIndexes.length).toBeGreaterThan(0);
    expect(backward.seamGlyphIndexes.length).toBeGreaterThan(0);

    for (const result of [forward, backward]) {
      const distances = result.glyphs.map((g) => Number(g.pathDistance.toFixed(6)));
      expect(new Set(distances).size).toBe(distances.length);
      expect(result.glyphs.map((g) => g.grapheme).join('')).toBe(sampleText);
    }
  });

  it('does not create a duplicate origin when exact text spans the closed loop', () => {
    const curve = rectangleCurve();
    const exact = layoutText(
      testConfig({ text: 'ABCDEFGHIJKLMNO', curve: { closed: true, anchors: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 50 },
        { x: 0, y: 50 },
      ] } }),
      measurer,
      curve,
    );

    expect(exact.glyphs).toHaveLength(15);
    expect(exact.report.requiredLength).toBeCloseTo(300, 5);
    expect(exact.report.unusedLength).toBeCloseTo(0, 5);

    const origins = exact.glyphs.map((g) => Math.round(g.pathDistance * 1e6));
    expect(new Set(origins).size).toBe(15);
  });

  it('recomputes glyph locations after the curve is edited', () => {
    const config = createDefaultConfig('inflection');
    config.text = '曲线跟着锚点变化';
    const beforeCurve = ArcLengthCurve.fromAnchors(config.curve);
    const before = layoutText(config, measurer, beforeCurve);

    const edited = structuredClone(config);
    edited.curve.anchors[2].x += 90;
    edited.curve.anchors[2].y -= 70;
    const afterCurve = ArcLengthCurve.fromAnchors(edited.curve);
    const after = layoutText(edited, measurer, afterCurve);

    expect(after.accepted).toBe(true);
    const movedCount = after.glyphs.filter((glyph, i) => {
      const old = before.glyphs[i].position;
      return Math.hypot(glyph.position.x - old.x, glyph.position.y - old.y) > 0.5;
    }).length;
    expect(movedCount).toBeGreaterThan(2);
  });
});
