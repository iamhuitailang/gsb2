import type { LoopMode, Waypoint } from '../core/types';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface RouteSample {
  position: Vec3Like;
  /** 归一化水平朝向（移动方向） */
  forward: Vec3Like;
  /** 与镜头基约定一致：forward = (sin yaw, 0, cos yaw) */
  yaw: number;
  moving: boolean;
  /** 最近到达 / 正在前往的路径点序号 */
  waypointIndex: number;
  /** 时间映射后实际用于采样的时间 */
  wrappedTime: number;
  /** pingpong 时当前是否反向行驶 */
  forwardTime: boolean;
  finished: boolean;
}

type Interval =
  | { kind: 'hold'; t0: number; t1: number; wp: number }
  | { kind: 'move'; t0: number; t1: number; from: number; to: number };

function v(x = 0, y = 0, z = 0): Vec3Like {
  return { x, y, z };
}

function clone(p: Waypoint): Vec3Like {
  return { x: p.x, y: p.y, z: p.z };
}

// ---- 向心 Catmull-Rom（alpha=0.5），直角转弯也不易过冲 ----

function knot(t: number, pA: Vec3Like, pB: Vec3Like, alpha = 0.5): number {
  const dx = pB.x - pA.x;
  const dy = pB.y - pA.y;
  const dz = pB.z - pA.z;
  return t + Math.pow(dx * dx + dy * dy + dz * dz, alpha * 0.5);
}

function catmullPoint(p0: Vec3Like, p1: Vec3Like, p2: Vec3Like, p3: Vec3Like, u: number): Vec3Like {
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const t = t1 + (t2 - t1) * u;

  const A1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
  const A1y = ((t1 - t) / (t1 - t0)) * p0.y + ((t - t0) / (t1 - t0)) * p1.y;
  const A1z = ((t1 - t) / (t1 - t0)) * p0.z + ((t - t0) / (t1 - t0)) * p1.z;

  const A2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
  const A2y = ((t2 - t) / (t2 - t1)) * p1.y + ((t - t1) / (t2 - t1)) * p2.y;
  const A2z = ((t2 - t) / (t2 - t1)) * p1.z + ((t - t1) / (t2 - t1)) * p2.z;

  const A3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
  const A3y = ((t3 - t) / (t3 - t2)) * p2.y + ((t - t2) / (t3 - t2)) * p3.y;
  const A3z = ((t3 - t) / (t3 - t2)) * p2.z + ((t - t2) / (t3 - t2)) * p3.z;

  const B1x = ((t2 - t) / (t2 - t0)) * A1x + ((t - t0) / (t2 - t0)) * A2x;
  const B1y = ((t2 - t) / (t2 - t0)) * A1y + ((t - t0) / (t2 - t0)) * A2y;
  const B1z = ((t2 - t) / (t2 - t0)) * A1z + ((t - t0) / (t2 - t0)) * A2z;

  const B2x = ((t3 - t) / (t3 - t1)) * A2x + ((t - t1) / (t3 - t1)) * A3x;
  const B2y = ((t3 - t) / (t3 - t1)) * A2y + ((t - t1) / (t3 - t1)) * A3y;
  const B2z = ((t3 - t) / (t3 - t1)) * A2z + ((t - t1) / (t3 - t1)) * A3z;

  return {
    x: ((t2 - t) / (t2 - t1)) * B1x + ((t - t1) / (t2 - t1)) * B2x,
    y: ((t2 - t) / (t2 - t1)) * B1y + ((t - t1) / (t2 - t1)) * B2y,
    z: ((t2 - t) / (t2 - t1)) * B1z + ((t - t1) / (t2 - t1)) * B2z,
  };
}

/** 第 segment 段（wp[segment] → wp[segment+1]）上 u∈[0,1] 的点 */
export function samplePath(waypoints: Waypoint[], segment: number, u: number): Vec3Like {
  const n = waypoints.length;
  if (n === 0) return v();
  if (n === 1) return clone(waypoints[0]);
  const i = Math.min(Math.max(segment, 0), n - 2);
  const p1 = clone(waypoints[i]);
  const p2 = clone(waypoints[i + 1]);
  const p0 = clone(waypoints[Math.max(0, i - 1)]);
  const p3 = clone(waypoints[Math.min(n - 1, i + 2)]);
  // 首尾段把端点外推镜像，避免起步/终点被往里拉
  if (i === 0) {
    p0.x = 2 * p1.x - p2.x;
    p0.y = 2 * p1.y - p2.y;
    p0.z = 2 * p1.z - p2.z;
  }
  if (i === n - 2) {
    p3.x = 2 * p2.x - p1.x;
    p3.y = 2 * p2.y - p1.y;
    p3.z = 2 * p2.z - p1.z;
  }
  return catmullPoint(p0, p1, p2, p3, Math.min(1, Math.max(0, u)));
}

export class RouteTimeline {
  intervals: Interval[] = [];
  duration = 0;

  constructor(public waypoints: Waypoint[] = []) {
    this.rebuild(waypoints);
  }

  rebuild(waypoints: Waypoint[]): void {
    this.waypoints = waypoints;
    this.intervals = [];
    let t = 0;
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      if (wp.hold > 0.0001) {
        this.intervals.push({ kind: 'hold', t0: t, t1: t + wp.hold, wp: i });
        t += wp.hold;
      }
      if (i < waypoints.length - 1) {
        const dt = Math.max(0.05, waypoints[i + 1].moveTime);
        this.intervals.push({ kind: 'move', t0: t, t1: t + dt, from: i, to: i + 1 });
        t += dt;
      }
    }
    this.duration = t;
  }

  /** 把原始播放时间按循环模式映射到 [0, duration] */
  mapTime(raw: number, mode: LoopMode): { time: number; finished: boolean; forward: boolean } {
    const d = this.duration;
    if (d <= 0) return { time: 0, finished: true, forward: true };
    if (mode === 'once') {
      if (raw >= d) return { time: d, finished: true, forward: true };
      return { time: Math.max(0, raw), finished: false, forward: true };
    }
    if (mode === 'loop') {
      return { time: ((raw % d) + d) % d, finished: false, forward: true };
    }
    // pingpong
    const period = d * 2;
    let tt = ((raw % period) + period) % period;
    if (tt <= d) return { time: tt, finished: false, forward: true };
    return { time: d * 2 - tt, finished: false, forward: false };
  }

  sample(rawTime: number, mode: LoopMode): RouteSample {
    const n = this.waypoints.length;
    const mapped = this.mapTime(rawTime, mode);
    if (n === 0) {
      return {
        position: v(),
        forward: v(0, 0, 1),
        yaw: 0,
        moving: false,
        waypointIndex: -1,
        wrappedTime: 0,
        forwardTime: true,
        finished: mapped.finished,
      };
    }
    if (n === 1 || this.intervals.length === 0) {
      const p = clone(this.waypoints[0]);
      return {
        position: p,
        forward: v(0, 0, 1),
        yaw: 0,
        moving: false,
        waypointIndex: 0,
        wrappedTime: 0,
        forwardTime: true,
        finished: mapped.finished,
      };
    }

    const t = mapped.time;
    let interval = this.intervals.find((it) => t >= it.t0 && t < it.t1);
    if (!interval) interval = this.intervals[this.intervals.length - 1];

    if (interval.kind === 'hold') {
      const p = clone(this.waypoints[interval.wp]);
      // 停留时沿用行进方向：中间点用上一段到达切线；起点用第一段出发切线
      let a: Vec3Like;
      let b: Vec3Like;
      if (interval.wp === 0 && this.waypoints.length > 1) {
        a = samplePath(this.waypoints, 0, 0);
        b = samplePath(this.waypoints, 0, 0.03);
      } else {
        const seg = Math.max(0, interval.wp - 1);
        a = samplePath(this.waypoints, seg, 0.97);
        b = samplePath(this.waypoints, seg, 1);
      }
      const f = horizontalNormalize({ x: b.x - a.x, y: 0, z: b.z - a.z });
      return {
        position: p,
        forward: f,
        yaw: Math.atan2(f.x, f.z),
        moving: false,
        waypointIndex: interval.wp,
        wrappedTime: t,
        forwardTime: mapped.forward,
        finished: mapped.finished,
      };
    }

    const u = (t - interval.t0) / Math.max(0.0001, interval.t1 - interval.t0);
    // 起步/停车平滑（smoothstep），避免角色瞬时起步
    const uu = u * u * (3 - 2 * u);
    const pos = samplePath(this.waypoints, interval.from, uu);
    const ea = samplePath(this.waypoints, interval.from, Math.max(0, uu - 0.01));
    const eb = samplePath(this.waypoints, interval.from, Math.min(1, uu + 0.01));
    const f = horizontalNormalize({ x: eb.x - ea.x, y: 0, z: eb.z - ea.z });
    return {
      position: pos,
      forward: f,
      yaw: Math.atan2(f.x, f.z),
      moving: true,
      waypointIndex: interval.to,
      wrappedTime: t,
      forwardTime: mapped.forward,
      finished: mapped.finished,
    };
  }
}

function horizontalNormalize(d: Vec3Like): Vec3Like {
  const len = Math.hypot(d.x, d.z);
  if (len < 1e-6) return v(0, 0, 1);
  return { x: d.x / len, y: 0, z: d.z / len };
}
