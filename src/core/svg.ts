import { curveToSvgPath } from './geometry';
import { EMBEDDED_CONFIG_ID, type ToolConfig } from './config';
import type { LayoutResult } from './layout';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function embedJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');
}

function n(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

export interface SvgExportOptions {
  /** Include editor boundary boxes and distance markers in the exported file. */
  includeGuides?: boolean;
}

/** Deterministic standalone SVG. Glyph transforms are precomputed, so viewers do not reflow textPath. */
export function buildSvg(
  config: ToolConfig,
  layout: LayoutResult,
  options: SvgExportOptions = {},
): string {
  if (!layout.accepted || layout.placedGlyphs.length === 0) {
    throw new Error(layout.rejectionReason ?? '当前配置没有可导出的文字');
  }

  const pathD = curveToSvgPath(config.curve);
  const { width, height, background } = config.canvas;
  const roadWidth = Math.max(34, config.font.size * 1.45);
  const report = layout.report;

  const glyphElements = layout.placedGlyphs
    .map((glyph) => {
      const classes = ['ct-glyph'];
      if (layout.limitGlyphIndexes.includes(glyph.index)) classes.push('ct-limit');
      if (layout.seamGlyphIndexes.includes(glyph.index)) classes.push('ct-seam');
      if (glyph.collidesWith.length > 0) classes.push('ct-collision');

      const dataAttributes = [
        `data-index="${glyph.index}"`,
        `data-travel="${n(glyph.midTravel)}"`,
        `data-path-distance="${n(glyph.pathDistance)}"`,
        `data-unwrapped-distance="${n(glyph.unwrappedDistance)}"`,
        glyph.crossesSeam ? 'data-crosses-seam="true"' : '',
        glyph.touchesLimit ? 'data-touches-limit="true"' : '',
      ]
        .filter(Boolean)
        .join(' ');

      return [
        `    <text class="${classes.join(' ')}" ${dataAttributes}`,
        `      transform="translate(${n(glyph.position.x)} ${n(glyph.position.y)}) rotate(${n(glyph.angleDeg)})"`,
        `      text-anchor="middle" dominant-baseline="alphabetic" xml:space="preserve"`,
        `      font-family="${escapeXml(config.font.family)}" font-size="${n(glyph.fontSize)}"`,
        `      font-weight="${config.font.weight}" font-style="${config.font.style}"`,
        `      fill="#172033">${escapeXml(glyph.grapheme)}</text>`,
      ].join('\n');
    })
    .join('\n');

  const guideElements = options.includeGuides
    ? layout.placedGlyphs
        .map((glyph) => {
          const points = glyph.corners.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
          const stroke = layout.limitGlyphIndexes.includes(glyph.index)
            ? '#dc2626'
            : layout.seamGlyphIndexes.includes(glyph.index)
              ? '#7c3aed'
              : '#0ea5e9';
          return `    <polygon points="${points}" fill="${stroke}" fill-opacity="0.08" stroke="${stroke}" stroke-width="1.2" pointer-events="none"/>`;
        })
        .join('\n')
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" version="1.1">
  <title>${escapeXml(config.name)}</title>
  <desc>曲线排字导出。起点弧长 ${n(report.startDistance)}，末字结束弧长 ${n(report.endWrappedDistance)}，已用 ${n(report.requiredLength)} / 可用 ${n(report.availableLength)}。</desc>
  <metadata id="${EMBEDDED_CONFIG_ID}" type="application/json">${embedJson({ config, layoutReport: report })}</metadata>
  <rect width="100%" height="100%" fill="${background}"/>
  <g id="curve-road" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path id="road-casing" d="${pathD}" stroke="#334155" stroke-width="${n(roadWidth + 8)}"/>
    <path id="road-surface" d="${pathD}" stroke="#f8fafc" stroke-width="${n(roadWidth)}"/>
    <path id="road-center" d="${pathD}" stroke="#f59e0b" stroke-width="3" stroke-dasharray="18 16" opacity="0.9"/>
  </g>
  <path id="curve-path" d="${pathD}" fill="none" stroke="#2563eb" stroke-width="2" stroke-dasharray="7 7" opacity="0.75"/>
${guideElements ? `  <g id="boundary-guides">\n${guideElements}\n  </g>\n` : ''}  <g id="curve-text"
     data-start-distance="${n(report.startDistance)}"
     data-end-distance="${n(report.endWrappedDistance)}"
     data-end-unwrapped-distance="${n(report.endUnwrappedDistance)}"
     data-required-length="${n(report.requiredLength)}"
     data-available-length="${n(report.availableLength)}"
     data-unused-length="${n(report.unusedLength)}">
${glyphElements}
  </g>
</svg>
`;
}

export function extractEmbeddedConfig(svgText: string): unknown {
  const pattern = new RegExp(
    `<metadata[^>]*id=["']${EMBEDDED_CONFIG_ID}["'][^>]*>([\\s\\S]*?)</metadata>`,
    'i',
  );
  const match = svgText.match(pattern);
  if (!match) throw new Error('这个 SVG 中没有找到本工具嵌入的配置');
  return JSON.parse(match[1]) as unknown;
}
