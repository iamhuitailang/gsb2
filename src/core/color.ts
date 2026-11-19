import type { Gradient } from './types.ts';
import { clamp } from './rng.ts';

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

export function parseColor(hex: string): [number, number, number] {
  const safe = isValidHexColor(hex) ? hex : '#ffffff';
  return [
    parseInt(safe.slice(1, 3), 16),
    parseInt(safe.slice(3, 5), 16),
    parseInt(safe.slice(5, 7), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** 颜色渐变求值（sRGB 线性插值）。 */
export function evalGradient(gradient: Gradient, u: number): [number, number, number] {
  const stops = gradient.stops;
  if (stops.length === 0) return [255, 255, 255];
  const t = clamp(u, 0, 1);
  const first = stops[0];
  if (t <= first.t) return parseColor(first.color);
  const last = stops[stops.length - 1];
  if (t >= last.t) return parseColor(last.color);

  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.t) {
      const span = b.t - a.t;
      const k = span <= 1e-9 ? 1 : (t - a.t) / span;
      const ca = parseColor(a.color);
      const cb = parseColor(b.color);
      return [
        ca[0] + (cb[0] - ca[0]) * k,
        ca[1] + (cb[1] - ca[1]) * k,
        ca[2] + (cb[2] - ca[2]) * k,
      ];
    }
  }
  return parseColor(last.color);
}

export function normalizeGradient(gradient: Gradient): Gradient {
  return {
    stops: gradient.stops
      .filter((stop) => Number.isFinite(stop.t))
      .map((stop) => ({
        t: clamp(stop.t, 0, 1),
        color: isValidHexColor(stop.color) ? stop.color.toLowerCase() : '#ffffff',
      }))
      .sort((a, b) => a.t - b.t),
  };
}
