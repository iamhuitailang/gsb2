import type { AutomationPoint } from '../types';
import { clamp, lerp } from './helpers';

/**
 * 计算某一时刻的自动化增益（线性插值，分段线性 ramp）。
 * - 无关键点：返回 null，调用方使用轨道基础音量
 * - 时间在首尾点之外：钳制到端点值
 */
export function automationValueAt(points: AutomationPoint[], time: number): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    if (time >= p0.time && time <= p1.time) {
      const span = p1.time - p0.time;
      const t = span <= 1e-6 ? 0 : (time - p0.time) / span;
      return clamp(lerp(p0.value, p1.value, t), 0, 1);
    }
  }
  return last.value;
}

/** 把自动化关键点按时间排序后返回（不修改原数组） */
export function sortPoints(points: AutomationPoint[]): AutomationPoint[] {
  return [...points].sort((a, b) => a.time - b.time);
}
