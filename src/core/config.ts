import type { CurveConfig } from './geometry';

export type Direction = 'forward' | 'backward';
export type FitMode = 'shrink' | 'reject';
export type OrientationMode = 'path' | 'upright';
export type PresetName = 'inflection' | 'hairpin' | 'closed';

export interface FontConfig {
  /** Full CSS/SVG font-family stack. */
  family: string;
  size: number;
  weight: number;
  style: 'normal' | 'italic';
}

export interface LayoutSettings {
  /** Absolute arc distance from SVG path d's zero coordinate. */
  startDistance: number;
  direction: Direction;
  fit: FitMode;
  minFontSize: number;
  /** Extra tracking in base-font pixels; it scales together with shrink-to-fit. */
  letterSpacing: number;
  orientation: OrientationMode;
  avoidOverlap: boolean;
  /** Extra pixels inserted between sharp-bend glyph boxes. */
  overlapClearance: number;
  /** Reserved distance before the terminal endpoint / one closed loop. */
  endPadding: number;
  showBounds: boolean;
}

export interface CanvasSettings {
  width: number;
  height: number;
  background: string;
}

export interface ToolConfig {
  version: 1;
  name: string;
  text: string;
  font: FontConfig;
  curve: CurveConfig;
  layout: LayoutSettings;
  canvas: CanvasSettings;
}

export const CONFIG_STORAGE_KEY = 'curve-type-studio:v1';
export const EMBEDDED_CONFIG_ID = 'curve-text-config';

const PINGFANG = '"PingFang SC", "Hiragino Sans GB", "STHeiti", sans-serif';

export const DEFAULT_CANVAS: CanvasSettings = {
  width: 960,
  height: 600,
  background: '#f7f4ec',
};

export function presetCurve(name: PresetName): CurveConfig {
  if (name === 'closed') {
    return {
      closed: true,
      anchors: [
        { x: 230, y: 105 },
        { x: 480, y: 78 },
        { x: 748, y: 176 },
        { x: 824, y: 360 },
        { x: 665, y: 510 },
        { x: 360, y: 520 },
        { x: 145, y: 410 },
        { x: 112, y: 220 },
      ],
    };
  }

  if (name === 'hairpin') {
    return {
      closed: false,
      anchors: [
        { x: 82, y: 165 },
        { x: 430, y: 132 },
        { x: 724, y: 170 },
        { x: 812, y: 278 },
        { x: 700, y: 374 },
        { x: 330, y: 350 },
        { x: 178, y: 408 },
        { x: 246, y: 486 },
        { x: 720, y: 470 },
        { x: 872, y: 520 },
      ],
    };
  }

  return {
    closed: false,
    anchors: [
      { x: 78, y: 438 },
      { x: 205, y: 178 },
      { x: 350, y: 306 },
      { x: 486, y: 142 },
      { x: 620, y: 282 },
      { x: 760, y: 150 },
      { x: 884, y: 356 },
    ],
  };
}

export function createDefaultConfig(preset: PresetName = 'inflection'): ToolConfig {
  return {
    version: 1,
    name:
      preset === 'closed'
        ? '闭合路线·接缝测试'
        : preset === 'hairpin'
          ? '回头路·翻正测试'
          : '拐点线·正排测试',
    text: '弯路排字 Café résumé 中文 ＡＢＣ',
    font: {
      family: PINGFANG,
      size: 34,
      weight: 600,
      style: 'normal',
    },
    curve: presetCurve(preset),
    layout: {
      startDistance: 56,
      direction: 'forward',
      fit: 'shrink',
      minFontSize: 12,
      letterSpacing: 1.5,
      orientation: 'path',
      avoidOverlap: true,
      overlapClearance: 1.5,
      endPadding: 8,
      showBounds: false,
    },
    canvas: { ...DEFAULT_CANVAS },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/** Parse imported JSON or the config embedded in an exported SVG. */
export function normalizeConfig(raw: unknown): ToolConfig {
  const defaults = createDefaultConfig();
  if (!isRecord(raw)) throw new Error('配置必须是 JSON 对象');

  const curveRaw = isRecord(raw.curve) ? raw.curve : {};
  const anchorsRaw = Array.isArray(curveRaw.anchors) ? curveRaw.anchors : [];
  const anchors = anchorsRaw
    .filter(isRecord)
    .map((anchor) => ({
      x: numberOr(anchor.x, 0),
      y: numberOr(anchor.y, 0),
      smooth: typeof anchor.smooth === 'boolean' ? anchor.smooth : undefined,
    }))
    .filter((anchor) => Number.isFinite(anchor.x) && Number.isFinite(anchor.y));

  if (anchors.length < 2) throw new Error('配置中的曲线至少需要两个锚点');

  const fontRaw = isRecord(raw.font) ? raw.font : {};
  const layoutRaw = isRecord(raw.layout) ? raw.layout : {};
  const canvasRaw = isRecord(raw.canvas) ? raw.canvas : {};

  const direction = stringOr(layoutRaw.direction, defaults.layout.direction);
  const fit = stringOr(layoutRaw.fit, defaults.layout.fit);
  const orientation = stringOr(layoutRaw.orientation, defaults.layout.orientation);

  return {
    version: 1,
    name: stringOr(raw.name, defaults.name),
    text: stringOr(raw.text, defaults.text),
    font: {
      family: stringOr(fontRaw.family, defaults.font.family),
      size: Math.max(1, numberOr(fontRaw.size, defaults.font.size)),
      weight: numberOr(fontRaw.weight, defaults.font.weight),
      style: fontRaw.style === 'italic' ? 'italic' : 'normal',
    },
    curve: {
      closed: Boolean(curveRaw.closed),
      tension: numberOr(curveRaw.tension, 1 / 6),
      anchors,
    },
    layout: {
      startDistance: Math.max(0, numberOr(layoutRaw.startDistance, defaults.layout.startDistance)),
      direction: direction === 'backward' ? 'backward' : 'forward',
      fit: fit === 'reject' ? 'reject' : 'shrink',
      minFontSize: Math.max(1, numberOr(layoutRaw.minFontSize, defaults.layout.minFontSize)),
      letterSpacing: numberOr(layoutRaw.letterSpacing, defaults.layout.letterSpacing),
      orientation: orientation === 'upright' ? 'upright' : 'path',
      avoidOverlap:
        typeof layoutRaw.avoidOverlap === 'boolean'
          ? layoutRaw.avoidOverlap
          : defaults.layout.avoidOverlap,
      overlapClearance: Math.max(0, numberOr(layoutRaw.overlapClearance, 1.5)),
      endPadding: Math.max(0, numberOr(layoutRaw.endPadding, defaults.layout.endPadding)),
      showBounds:
        typeof layoutRaw.showBounds === 'boolean'
          ? layoutRaw.showBounds
          : defaults.layout.showBounds,
    },
    canvas: {
      width: Math.max(320, numberOr(canvasRaw.width, defaults.canvas.width)),
      height: Math.max(240, numberOr(canvasRaw.height, defaults.canvas.height)),
      background: stringOr(canvasRaw.background, defaults.canvas.background),
    },
  };
}

export function cloneConfig(config: ToolConfig): ToolConfig {
  return JSON.parse(JSON.stringify(config)) as ToolConfig;
}
