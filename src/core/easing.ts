import type { EasingName } from './types';

export const EASING_OPTIONS: { value: EasingName; label: string }[] = [
  { value: 'linear', label: '线性 Linear' },
  { value: 'smoothstep', label: '平滑 Smoothstep' },
  { value: 'easeOutCubic', label: '快入缓出 Out Cubic' },
  { value: 'easeInOutCubic', label: '缓入缓出 InOut Cubic' },
  { value: 'easeInOutQuad', label: '二次缓动 InOut Quad' },
  { value: 'easeOutBack', label: '轻微回弹 Out Back' },
];

export function ease(name: EasingName, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (name) {
    case 'linear':
      return x;
    case 'smoothstep':
      return x * x * (3 - 2 * x);
    case 'easeOutCubic':
      return 1 - Math.pow(1 - x, 3);
    case 'easeInOutCubic':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'easeInOutQuad':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'easeOutBack': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
    }
  }
}

/** 帧率无关指数阻尼系数：返回本帧应插值的比例 */
export function dampAlpha(dt: number, smoothTime: number): number {
  if (smoothTime <= 0) return 1;
  return 1 - Math.exp(-dt / smoothTime);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 角度插值（弧度），走最短弧 */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

let idCounter = 0;
export function uid(prefix = 'id'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}
