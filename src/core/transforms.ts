import * as THREE from 'three';
import type { Vec3 } from './types';

/**
 * 变换数学工具。
 *
 * 约定：
 * - 每个节点保存局部 TRS（平移 / 欧拉旋转 XYZ / 缩放，缩放允许非均匀）。
 * - 世界矩阵 = 父世界矩阵 × 局部矩阵。
 * - 当祖先链上存在「非均匀缩放 + 旋转」时，世界矩阵无法再严格分解成 TRS
 *   （会出现剪切/shear），此时 decompose 给出的是最小误差意义下的近似 TRS，
 *   检查器会明确标注，且该读数与 gizmo 显示、实际矩阵在同一套分解规则下保持一致。
 */

export function vec3(v: Vec3): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[1], v[2]);
}

/** 由局部 TRS 构造局部矩阵（不修改任何入参） */
export function composeLocal(
  position: Vec3,
  rotation: Vec3,
  scale: Vec3,
): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(rotation[0], rotation[1], rotation[2], 'XYZ'),
  );
  return m.compose(vec3(position), q, vec3(scale));
}

export interface DecomposedTRS {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
  /**
   * 矩阵是否包含剪切（即无法用精确 TRS 表达）。
   * 判定方式：重新 compose 后与原矩阵比较。
   */
  hasShear: boolean;
}

const _recomposed = new THREE.Matrix4();

/** 把任意仿射矩阵分解为 TRS，并检测剪切 */
export function decompose(matrix: THREE.Matrix4): DecomposedTRS {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const rotation = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

  _recomposed.compose(position, quaternion, scale);
  // 剪切检测：存在剪切时 decompose+compose 无法还原原矩阵。
  // 纯 TRS 往返的浮点抖动约 1e-15，真实剪切（非均匀缩放+旋转）偏差通常 >1e-4，
  // 取 1e-7 作为分界，避免把数值噪声误判成剪切。
  const hasShear = !matrixRelativeEquals(_recomposed, matrix, 1e-7);

  return { position, quaternion, rotation, scale, hasShear };
}

/** 矩阵逐元素相对误差比较（平移项用绝对误差兜底） */
export function matrixRelativeEquals(
  a: THREE.Matrix4,
  b: THREE.Matrix4,
  relEps: number,
): boolean {
  const ae = a.elements;
  const be = b.elements;
  for (let i = 0; i < 16; i++) {
    const diff = Math.abs(ae[i] - be[i]);
    const tol = relEps * Math.max(1, Math.abs(ae[i]), Math.abs(be[i]));
    if (diff > tol) return false;
  }
  return true;
}

/**
 * 计算「保持世界变换不变」时，节点重新挂接到新父节点后应有的局部 TRS。
 *
 *   localNew = world(newParent)⁻¹ × world(node)
 *
 * 新父为 null（场景根）时其父世界矩阵取单位矩阵。
 */
export function reparentLocalTRS(
  worldMatrix: THREE.Matrix4,
  newParentWorld: THREE.Matrix4 | null,
): { position: Vec3; rotation: Vec3; scale: Vec3 } {
  const invParent = newParentWorld
    ? newParentWorld.clone().invert()
    : new THREE.Matrix4().identity();
  // 用新矩阵承接乘积，绝不原地修改入参 worldMatrix
  const newLocal = invParent.multiply(worldMatrix.clone());
  const d = decompose(newLocal);
  return {
    position: [d.position.x, d.position.y, d.position.z],
    rotation: [d.rotation.x, d.rotation.y, d.rotation.z],
    scale: [d.scale.x, d.scale.y, d.scale.z],
  };
}

/** 判定 ancestorId 是否为 nodeId 的祖先（含自身） */
export function isAncestor(
  nodeId: string,
  ancestorId: string,
  getParent: (id: string) => string | null,
): boolean {
  let cur: string | null = nodeId;
  const guard = new Set<string>();
  while (cur !== null) {
    if (cur === ancestorId) return true;
    if (guard.has(cur)) return false; // 数据里已存在环，防御性退出
    guard.add(cur);
    cur = getParent(cur);
  }
  return false;
}

/** 四元数转欧拉角（XYZ，弧度） */
export function quaternionToEuler(q: THREE.Quaternion): Vec3 {
  const e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
  return [e.x, e.y, e.z];
}

export function eulerToQuaternion(r: Vec3): THREE.Quaternion {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(r[0], r[1], r[2], 'XYZ'),
  );
}

/** 数值近似比较（测试与世界保持校验用） */
export function approxVec3(a: Vec3 | THREE.Vector3, b: Vec3 | THREE.Vector3, eps = 1e-5): boolean {
  const av = Array.isArray(a) ? a : [a.x, a.y, a.z];
  const bv = Array.isArray(b) ? b : [b.x, b.y, b.z];
  return (
    Math.abs(av[0] - bv[0]) < eps &&
    Math.abs(av[1] - bv[1]) < eps &&
    Math.abs(av[2] - bv[2]) < eps
  );
}
