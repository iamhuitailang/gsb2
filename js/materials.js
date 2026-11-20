// 材质库：每种材质提供默认颜色与工厂函数（每次调用返回新实例，避免共享状态）
// envMapIntensity 统一调低，让环境反射只作衬托、灯光设计仍是画面主导
import * as THREE from 'three';

const ENV = 0.3;

export const MATERIAL_LIBRARY = {
  metal: {
    name: '抛光金属', defaultColor: '#c8cfd8',
    make: c => new THREE.MeshStandardMaterial({ color: c, metalness: 1.0, roughness: 0.16, envMapIntensity: ENV }),
  },
  brushed: {
    name: '拉丝金属', defaultColor: '#9aa2ab',
    make: c => new THREE.MeshStandardMaterial({ color: c, metalness: 1.0, roughness: 0.48, envMapIntensity: ENV }),
  },
  plastic: {
    name: '哑光塑料', defaultColor: '#d94f3d',
    make: c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.0, roughness: 0.85, envMapIntensity: ENV }),
  },
  ceramic: {
    name: '釉面陶瓷', defaultColor: '#f2f2ef',
    make: c => new THREE.MeshPhysicalMaterial({
      color: c, metalness: 0.0, roughness: 0.12, clearcoat: 1.0, clearcoatRoughness: 0.08,
      envMapIntensity: ENV,
    }),
  },
  wood: {
    name: '原木', defaultColor: '#8a5a2e',
    make: c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.0, roughness: 0.62, envMapIntensity: ENV }),
  },
  rubber: {
    name: '橡胶', defaultColor: '#33363c',
    make: c => new THREE.MeshStandardMaterial({ color: c, metalness: 0.0, roughness: 1.0, envMapIntensity: ENV }),
  },
  glass: {
    name: '玻璃', defaultColor: '#ffffff',
    make: c => new THREE.MeshPhysicalMaterial({
      color: c, metalness: 0.0, roughness: 0.05, transmission: 0.92,
      thickness: 0.8, ior: 1.5, transparent: true, envMapIntensity: ENV,
    }),
  },
  emissive: {
    name: '自发光', defaultColor: '#66ccff',
    make: c => new THREE.MeshStandardMaterial({
      color: '#151515', emissive: new THREE.Color(c), emissiveIntensity: 1.8, envMapIntensity: ENV,
    }),
  },
};

export function materialName(key) {
  return key && MATERIAL_LIBRARY[key] ? MATERIAL_LIBRARY[key].name : '原始材质';
}
