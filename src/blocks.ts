import type { BlockStyle } from './types';

const PATTERNS = new Set<BlockStyle['pattern']>([
  'solid',
  'stripe',
  'dots',
  'grid',
  'diagonal',
  'ring',
]);

export function isSafeColor(c: unknown): c is string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(c);
}

export function normalizeBlock(raw: unknown): BlockStyle | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const colors = Array.isArray(b.colors)
    ? b.colors.filter(isSafeColor).slice(0, 3)
    : [];
  if (colors.length === 0) return null;
  const pattern = PATTERNS.has(b.pattern as BlockStyle['pattern'])
    ? (b.pattern as BlockStyle['pattern'])
    : 'solid';
  const glyph =
    typeof b.glyph === 'string' ? b.glyph.slice(0, 12) : '?';
  const block: BlockStyle = { colors, pattern, glyph };
  if (isSafeColor(b.ink)) block.ink = b.ink;
  return block;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function patternOverlay(pattern: BlockStyle['pattern']): string {
  switch (pattern) {
    case 'stripe':
      return `
      <pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="9" height="20" fill="#ffffff" opacity="0.16"/>
      </pattern>
      <rect x="4" y="4" width="152" height="152" rx="18" fill="url(#p)"/>`;
    case 'dots':
      return `
      <pattern id="p" width="18" height="18" patternUnits="userSpaceOnUse">
        <circle cx="5" cy="5" r="3" fill="#ffffff" opacity="0.28"/>
      </pattern>
      <rect x="4" y="4" width="152" height="152" rx="18" fill="url(#p)"/>`;
    case 'grid':
      return `
      <pattern id="p" width="20" height="20" patternUnits="userSpaceOnUse">
        <path d="M20 0H0V20" fill="none" stroke="#ffffff" stroke-width="1.4" opacity="0.25"/>
      </pattern>
      <rect x="4" y="4" width="152" height="152" rx="18" fill="url(#p)"/>`;
    case 'ring':
      return `
      <circle cx="80" cy="80" r="52" fill="none" stroke="#ffffff" stroke-width="6" opacity="0.30"/>
      <circle cx="80" cy="80" r="34" fill="none" stroke="#000000" stroke-width="4" opacity="0.18"/>`;
    case 'diagonal':
      return `
      <path d="M156 4 L156 156 L4 156 Z" fill="#000000" opacity="0.18"/>
      <line x1="156" y1="4" x2="4" y2="156" stroke="#ffffff" stroke-width="3" opacity="0.35"/>`;
    case 'solid':
    default:
      return '';
  }
}

function glyphFontSize(glyph: string): number {
  const len = [...glyph].length;
  if (len <= 1) return 62;
  if (len === 2) return 46;
  if (len <= 4) return 32;
  if (len <= 6) return 25;
  return 20;
}

/** 生成色块演示图的 data: URI（SVG），可直接赋给 img.src */
export function blockDataUri(input: BlockStyle, size = 160): string {
  const block = normalizeBlock(input) ?? {
    colors: ['#9ca3af', '#4b5563'],
    pattern: 'solid' as const,
    glyph: '?',
  };
  const [c0, c1 = c0, c2] = block.colors;
  const ink = block.ink ?? '#ffffff';
  const gid = `g${Math.abs(hashCode(block.glyph + block.colors.join() + block.pattern))}`;
  const fontSize = glyphFontSize(block.glyph);
  const secondStop = c2 ? `<stop offset="1" stop-color="${c2}"/>` : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 160 160" role="img" aria-label="${escapeXml(block.glyph)}">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c0}"/>
      <stop offset="1" stop-color="${c1}"/>
      ${secondStop}
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="152" height="152" rx="20" fill="url(#${gid})"/>
  ${patternOverlay(block.pattern)}
  <rect x="4.5" y="4.5" width="151" height="151" rx="19.5" fill="none" stroke="#000000" stroke-opacity="0.28" stroke-width="2"/>
  <text x="80" y="82" text-anchor="middle" dominant-baseline="central"
        font-family="'PingFang SC','Microsoft YaHei',system-ui,sans-serif"
        font-size="${fontSize}" font-weight="800" fill="${ink}"
        stroke="rgba(0,0,0,0.35)" stroke-width="5" paint-order="stroke"
        letter-spacing="1">${escapeXml(block.glyph)}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h;
}
