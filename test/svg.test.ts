import { describe, expect, it } from 'vitest';
import { buildSvg, extractEmbeddedConfig } from '../src/core/svg';
import { normalizeConfig } from '../src/core/config';
import { layoutText } from '../src/core/layout';
import { measurer, testConfig } from './helpers';

function lineConfig() {
  return testConfig({
    name: 'SVG 往返测试',
    text: '中文 Café A B',
    curve: {
      closed: false,
      anchors: [
        { x: 40, y: 80 },
        { x: 300, y: 80 },
      ],
    },
  });
}

describe('SVG export and configuration round-trip', () => {
  it('exports path, every glyph, distance data, and embedded reproducible config', () => {
    const config = lineConfig();
    const layout = layoutText(config, measurer);
    const svg = buildSvg(config, layout, { includeGuides: true });

    expect(svg).toContain('<path id="curve-path"');
    expect(svg).toContain('id="curve-text"');
    expect(svg.match(/class="ct-glyph/g)).toHaveLength(layout.placedGlyphs.length);
    expect(svg).toContain('中文');
    expect(svg).toContain('Café');
    expect(svg).toContain('data-start-distance="0"');
    expect(svg).toContain('data-end-distance=');
    expect(svg).toContain('<polygon');

    const embedded = extractEmbeddedConfig(svg) as { config: unknown };
    const reopened = normalizeConfig(embedded.config);
    expect(reopened.text).toBe(config.text);
    expect(reopened.curve.anchors).toEqual(config.curve.anchors);
    expect(reopened.layout.direction).toBe(config.layout.direction);
    expect(reopened.font.family).toBe(config.font.family);

    const relaid = layoutText(reopened, measurer);
    expect(relaid.placedGlyphs.map((g) => g.pathDistance)).toEqual(
      layout.placedGlyphs.map((g) => g.pathDistance),
    );
  });

  it('refuses to export rejected text as glyph elements', () => {
    const config = testConfig(
      { text: 'ABCDEFGHIJ' },
      { fit: 'reject' },
    );
    config.curve = { closed: false, anchors: [{ x: 0, y: 0 }, { x: 60, y: 0 }] };
    const layout = layoutText(config, measurer);
    expect(layout.accepted).toBe(false);
    expect(() => buildSvg(config, layout)).toThrow(/路径过短/);
  });
});
