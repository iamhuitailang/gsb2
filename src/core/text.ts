export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ResolvedFont {
  family: string;
  size: number;
  weight?: number | string;
  style?: 'normal' | 'italic' | 'oblique';
}

export interface GlyphMetrics {
  advance: number;
  /** Tight ink box relative to the alphabetic origin; null for spaces. */
  ink: BBox | null;
  /** Full line/cell box used for boundary and editor hit display. */
  cell: BBox;
}

export interface TextMeasurer {
  measure(grapheme: string, font: ResolvedFont): GlyphMetrics;
}

export const MAC_LOCAL_FONT_STACKS = [
  {
    id: 'pingfang',
    label: '苹方 PingFang SC（中文）',
    family: '"PingFang SC", "Hiragino Sans GB", "STHeiti", sans-serif',
  },
  {
    id: 'hiragino-sans',
    label: 'Hiragino Sans GB（中文）',
    family: '"Hiragino Sans GB", "PingFang SC", "STHeiti", sans-serif',
  },
  {
    id: 'songti',
    label: '宋体 Songti SC（中文衬线）',
    family: '"Songti SC", "STSong", "SimSun", serif',
  },
  {
    id: 'kaiti',
    label: '楷体 Kaiti SC',
    family: '"Kaiti SC", "STKaiti", "KaiTi", serif',
  },
  {
    id: 'helvetica',
    label: 'Helvetica Neue（拉丁）',
    family: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  },
  {
    id: 'georgia',
    label: 'Georgia（拉丁衬线）',
    family: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'menlo',
    label: 'Menlo（等宽）',
    family: 'Menlo, Monaco, "Courier New", monospace',
  },
] as const;

const segmenterCtor = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
const graphemeSegmenter = segmenterCtor ? new segmenterCtor(undefined, { granularity: 'grapheme' }) : null;

/** Split by user-perceived characters so é and e + ◌́ stay together. */
export function graphemes(text: string): string[] {
  if (!text) return [];
  if (graphemeSegmenter) {
    return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
  }
  return Array.from(text.normalize('NFC'));
}

export function isSpaceGrapheme(grapheme: string): boolean {
  return /^\s+$/u.test(grapheme);
}

function canvasFont(font: ResolvedFont): string {
  const style = font.style ?? 'normal';
  const weight = font.weight ?? 500;
  return `${style} ${weight} ${font.size}px ${font.family}`;
}

/** Measures text with a local Canvas font. No web fonts are fetched. */
export class CanvasTextMeasurer implements TextMeasurer {
  private context: CanvasRenderingContext2D | null;
  private cache = new Map<string, GlyphMetrics>();

  constructor() {
    if (typeof document === 'undefined') {
      this.context = null;
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    this.context = canvas.getContext('2d');
  }

  measure(grapheme: string, font: ResolvedFont): GlyphMetrics {
    const key = `${canvasFont(font)}::${grapheme}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const ctx = this.context;
    const size = font.size;
    if (!ctx) {
      // Deterministic fallback for unusual server-side imports.
      const fallback: GlyphMetrics = {
        advance: isSpaceGrapheme(grapheme) ? size * 0.28 : size,
        ink: isSpaceGrapheme(grapheme)
          ? null
          : { minX: 0.05 * size, minY: -0.76 * size, maxX: 0.95 * size, maxY: 0.24 * size },
        cell: { minX: 0, minY: -0.8 * size, maxX: size, maxY: 0.2 * size },
      };
      this.cache.set(key, fallback);
      return fallback;
    }

    ctx.font = canvasFont(font);
    const metrics = ctx.measureText(grapheme);
    const advance = metrics.width;
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent ?? size * 0.8;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent ?? size * 0.2;
    const cell: BBox = { minX: 0, minY: -ascent, maxX: advance, maxY: descent };

    let ink: BBox | null = null;
    const hasInkBounds =
      Number.isFinite(metrics.actualBoundingBoxLeft) &&
      Number.isFinite(metrics.actualBoundingBoxRight) &&
      Number.isFinite(metrics.actualBoundingBoxAscent) &&
      Number.isFinite(metrics.actualBoundingBoxDescent);

    if (!isSpaceGrapheme(grapheme) && hasInkBounds) {
      const minX = -(metrics.actualBoundingBoxLeft ?? 0);
      const maxX = metrics.actualBoundingBoxRight ?? advance;
      const minY = -(metrics.actualBoundingBoxAscent ?? ascent * 0.8);
      const maxY = metrics.actualBoundingBoxDescent ?? descent * 0.8;
      if (maxX > minX + 0.01 && maxY > minY + 0.01) {
        ink = { minX, maxX, minY, maxY };
      }
    }

    const result: GlyphMetrics = { advance, ink, cell };
    this.cache.set(key, result);
    return result;
  }
}

/** Deterministic metrics for unit tests. CJK and accented clusters are one em. */
export class FixedWidthMeasurer implements TextMeasurer {
  constructor(
    private readonly emWidth = 20,
    private readonly spaceWidthRatio = 0.5,
  ) {}

  measure(grapheme: string, font: ResolvedFont): GlyphMetrics {
    const size = font.size;
    const space = isSpaceGrapheme(grapheme);
    const advance = space ? size * this.spaceWidthRatio : size * (this.emWidth / 20);
    return {
      advance,
      ink: space
        ? null
        : { minX: size * 0.06, minY: -size * 0.78, maxX: advance - size * 0.06, maxY: size * 0.22 },
      cell: { minX: 0, minY: -size * 0.8, maxX: advance, maxY: size * 0.2 },
    };
  }
}
