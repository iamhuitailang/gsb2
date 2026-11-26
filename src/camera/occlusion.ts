import * as THREE from 'three';
import type { OcclusionAttempt, OcclusionConfig, OcclusionReport } from '../core/types';

export interface OcclusionQuery {
  pivot: THREE.Vector3;
  desired: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  colliders: THREE.Object3D[];
  config: OcclusionConfig;
}

export interface OcclusionSolveResult {
  position: THREE.Vector3;
  report: OcclusionReport;
}

interface RayHit {
  distance: number;
  point: THREE.Vector3;
  name: string;
}

function objectName(obj: THREE.Object3D | null | undefined): string {
  let o: THREE.Object3D | null = obj ?? null;
  while (o) {
    if (o.userData?.displayName) return String(o.userData.displayName);
    if (o.name) return o.name;
    o = o.parent;
  }
  return '障碍物';
}

/** 最近命中；忽略背向 / 极近的异常结果 */
function raycastNearest(
  raycaster: THREE.Raycaster,
  colliders: THREE.Object3D[],
  from: THREE.Vector3,
  to: THREE.Vector3,
): RayHit | null {
  const dir = new THREE.Vector3().subVectors(to, from);
  const dist = dir.length();
  if (dist < 1e-4) return null;
  dir.multiplyScalar(1 / dist);
  raycaster.set(from, dir);
  raycaster.near = 0;
  raycaster.far = dist;
  const hits = raycaster.intersectObjects(colliders, false);
  if (hits.length === 0) return null;
  const h = hits[0];
  return { distance: h.distance, point: h.point.clone(), name: objectName(h.object) };
}

interface Candidate {
  label: string;
  kind: OcclusionReport['kind'];
  pos: THREE.Vector3;
  cost: number;
}

export function solveOcclusion(q: OcclusionQuery): OcclusionSolveResult {
  const { pivot, desired, right, up, colliders, config } = q;
  const desiredDist = pivot.distanceTo(desired);
  const raycaster = new THREE.Raycaster();

  const emptyReportBase = {
    desiredDistance: desiredDist,
    finalDistance: desiredDist,
    attempts: [] as OcclusionAttempt[],
    rayFrom: [pivot.x, pivot.y, pivot.z] as [number, number, number],
    rayTo: [desired.x, desired.y, desired.z] as [number, number, number],
  };

  if (!config.enabled || colliders.length === 0) {
    return {
      position: desired.clone(),
      report: {
        ...emptyReportBase,
        kind: 'clear',
        reason: config.enabled ? '视野通畅' : '遮挡检测已关闭',
        hitObjectName: null,
        hitDistance: null,
        hitPoint: null,
      },
    };
  }

  // 1) 原始期望位置的遮挡情况（用于调试射线与原因）
  const directHit = raycastNearest(raycaster, colliders, pivot, desired);
  const attempts: OcclusionAttempt[] = [];

  const record = (label: string, pos: THREE.Vector3, hit: RayHit | null, cost: number) => {
    attempts.push({
      label,
      clear: !hit,
      cost,
      position: [pos.x, pos.y, pos.z],
      hitName: hit?.name,
    });
  };

  if (!directHit) {
    record('期望机位', desired, null, 0);
    return {
      position: desired.clone(),
      report: {
        ...emptyReportBase,
        kind: 'clear',
        reason: '视野通畅，使用期望机位',
        hitObjectName: null,
        hitDistance: null,
        hitPoint: null,
        attempts,
      },
    };
  }

  const dir = new THREE.Vector3().subVectors(desired, pivot).normalize();
  const safeDist = Math.max(0.45, directHit.distance - config.skin);
  const pullPos = pivot.clone().addScaledVector(dir, safeDist);
  const distanceLoss = Math.max(0, desiredDist - safeDist);

  const candidates: Candidate[] = [
    {
      label: `沿射线前移到 ${safeDist.toFixed(2)}m`,
      kind: 'pull-in',
      pos: pullPos,
      cost: distanceLoss * 2.2 + 0.05,
    },
  ];

  // 2) 侧向移位（保持距离优先，能绕开柱子时体验比贴脸好）
  if (config.sideProbe) {
    const shifts = [0.55, -0.55, 1.1, -1.1, 1.8, -1.8, 2.6, -2.6];
    for (const s of shifts) {
      const pos = desired.clone().addScaledVector(right, s);
      candidates.push({
        label: `侧向 ${s > 0 ? '右' : '左'}移 ${Math.abs(s).toFixed(1)}m`,
        kind: 'side-shift',
        pos,
        cost: Math.abs(s) * 1.25 + 0.2,
      });
      // 侧移后仍被挡：沿新射线回收
      const hit = raycastNearest(raycaster, colliders, pivot, pos);
      if (hit) {
        const d2 = Math.max(0.45, hit.distance - config.skin);
        const pulled = pivot
          .clone()
          .add(new THREE.Vector3().subVectors(pos, pivot).normalize().multiplyScalar(d2));
        candidates.push({
          label: `侧移 ${Math.abs(s).toFixed(1)}m + 前移`,
          kind: 'combined',
          pos: pulled,
          cost: Math.abs(s) * 1.25 + (desiredDist - d2) * 2.2 + 0.6,
        });
      }
    }
  }

  // 3) 抬高镜头
  if (config.raiseProbe) {
    for (const h of [0.9, 1.8]) {
      const pos = desired.clone().addScaledVector(up, h);
      const hit = raycastNearest(raycaster, colliders, pivot, pos);
      let finalPos = pos;
      let extraLoss = 0;
      if (hit) {
        const d2 = Math.max(0.45, hit.distance - config.skin);
        finalPos = pivot
          .clone()
          .add(new THREE.Vector3().subVectors(pos, pivot).normalize().multiplyScalar(d2));
        extraLoss = desiredDist - d2;
      }
      candidates.push({
        label: `抬高 ${h.toFixed(1)}m${hit ? ' + 前移' : ''}`,
        kind: 'raise',
        pos: finalPos,
        cost: h * 1.6 + extraLoss * 2.2 + 0.9,
      });
    }
  }

  // 4) 评估所有候选，选「调整代价最小且视线通畅」的
  let best: { candidate: Candidate; cost: number } | null = null;
  for (const c of candidates) {
    const hit = raycastNearest(raycaster, colliders, pivot, c.pos);
    record(c.label, c.pos, hit, c.cost);
    if (!hit && (!best || c.cost < best.cost)) {
      best = { candidate: c, cost: c.cost };
    }
  }

  const hitPoint: [number, number, number] = [
    directHit.point.x,
    directHit.point.y,
    directHit.point.z,
  ];

  if (!best) {
    // 理论上 pull-in 一定通畅；兜底强制贴近视点
    return {
      position: pullPos,
      report: {
        ...emptyReportBase,
        kind: 'forced',
        reason: `严重遮挡：${directHit.name}，已强制缩短到 ${safeDist.toFixed(1)}m`,
        hitObjectName: directHit.name,
        hitDistance: directHit.distance,
        hitPoint,
        finalDistance: safeDist,
        attempts,
      },
    };
  }

  const chosen = best.candidate;
  const finalDist = pivot.distanceTo(chosen.pos);
  let reason = '';
  switch (chosen.kind) {
    case 'pull-in':
      reason = `${directHit.name} 挡住视线，镜头前移至距目标 ${finalDist.toFixed(1)}m`;
      break;
    case 'side-shift': {
      const side = chosen.pos.clone().sub(desired).dot(right) >= 0 ? '右' : '左';
      reason = `${directHit.name} 遮挡，向${side}侧移位绕过（保持距离）`;
      break;
    }
    case 'combined':
      reason = `${directHit.name} 遮挡，侧向移位并前移至 ${finalDist.toFixed(1)}m`;
      break;
    case 'raise':
      reason = `${directHit.name} 遮挡，抬高镜头并回收距离`;
      break;
    default:
      reason = `避让 ${directHit.name}`;
  }

  return {
    position: chosen.pos,
    report: {
      ...emptyReportBase,
      kind: chosen.kind,
      reason,
      hitObjectName: directHit.name,
      hitDistance: directHit.distance,
      hitPoint,
      finalDistance: finalDist,
      attempts,
    },
  };
}
