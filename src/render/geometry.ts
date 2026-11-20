import * as THREE from 'three';
import type { GeometrySpec, MaterialSpec } from '../core/types';

/**
 * 内置几何体工厂：全部由参数化原始几何体生成，不加载任何外部模型。
 * params 语义按 kind 区分，未提供时使用合理默认值。
 */
export function createGeometry(spec: GeometrySpec): THREE.BufferGeometry {
  const p = spec.params ?? [];
  switch (spec.kind) {
    case 'box':
      return new THREE.BoxGeometry(p[0] ?? 1, p[1] ?? 1, p[2] ?? 1);
    case 'sphere':
      return new THREE.SphereGeometry(p[0] ?? 0.5, p[1] ?? 32, p[2] ?? 24);
    case 'cylinder':
      return new THREE.CylinderGeometry(
        p[0] ?? 0.5, // radiusTop
        p[1] ?? 0.5, // radiusBottom
        p[2] ?? 1, // height
        p[3] ?? 32,
      );
    case 'cone':
      return new THREE.ConeGeometry(p[0] ?? 0.5, p[1] ?? 1, p[2] ?? 32);
    case 'torus':
      return new THREE.TorusGeometry(p[0] ?? 0.5, p[1] ?? 0.18, p[2] ?? 16, p[3] ?? 48);
    case 'plane':
      return new THREE.PlaneGeometry(p[0] ?? 2, p[1] ?? 2);
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`未知几何体类型: ${String(exhaustive)}`);
    }
  }
}

export function createMaterial(spec: MaterialSpec): THREE.MeshStandardMaterial {
  const opacity = spec.opacity ?? 1;
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(spec.color),
    metalness: spec.metalness ?? 0.1,
    roughness: spec.roughness ?? 0.65,
    transparent: opacity < 1,
    opacity,
  });
}
