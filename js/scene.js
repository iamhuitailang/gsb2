// 示例场景：包含多种表面材质与遮挡关系（堆叠、挡板、前后层次）
// 每个对象分配唯一 oid（与名称无关），因此重名对象也能被准确选中
import * as THREE from 'three';
import { MATERIAL_LIBRARY } from './materials.js';

let oidCounter = 0;

export function buildScene(scene) {
  const objects = [];

  function add(name, geometry, matKey, color, pos, rot = [0, 0, 0], opts = {}) {
    const def = MATERIAL_LIBRARY[matKey];
    const mesh = new THREE.Mesh(geometry, def.make(color || def.defaultColor));
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.castShadow = opts.castShadow !== false;
    mesh.receiveShadow = opts.receiveShadow !== false;
    const oid = 'obj-' + (++oidCounter);
    mesh.userData.oid = oid;
    scene.add(mesh);
    objects.push({ oid, name, mesh, baseMaterial: mesh.material, overrideMaterial: null });
    return mesh;
  }

  // 地面（只接收阴影）
  add('地面', new THREE.PlaneGeometry(46, 46), 'plastic', '#7d8187',
    [0, 0, 0], [-Math.PI / 2, 0, 0], { castShadow: false });

  // 背景墙（两面，便于观察方向光与阴影）
  add('后墙', new THREE.BoxGeometry(46, 12, 0.6), 'plastic', '#8d9099', [0, 6, -11]);
  add('侧墙', new THREE.BoxGeometry(0.6, 12, 22), 'plastic', '#84878f', [-14, 6, 0]);

  // 堆叠方块：上下遮挡关系；两个对象同名“装饰方块”，用于演示重名选择
  add('装饰方块', new THREE.BoxGeometry(3.2, 3.2, 3.2), 'plastic', '#c94f42', [-4.5, 1.6, -3]);
  add('装饰方块', new THREE.BoxGeometry(1.6, 1.6, 1.6), 'plastic', '#3d6fd9',
    [-4.5, 4.0, -3], [0, Math.PI / 6, 0]);

  // 金属球
  add('金属球', new THREE.SphereGeometry(1.35, 48, 32), 'metal', '#cfd6de', [1.5, 1.35, -1]);

  // 陶瓷圆柱
  add('陶瓷圆柱', new THREE.CylinderGeometry(1.0, 1.0, 3.0, 40), 'ceramic', '#f0efe9', [5.5, 1.5, -4]);

  // 玻璃球 + 橡胶底座（上下遮挡）
  add('底座', new THREE.CylinderGeometry(1.1, 1.3, 1.4, 32), 'rubber', '#2e3138', [1.0, 0.7, 3.6]);
  add('玻璃球', new THREE.SphereGeometry(0.95, 48, 32), 'glass', '#ffffff', [1.0, 2.35, 3.6]);

  // 木质圆环（平躺）
  add('木圆环', new THREE.TorusGeometry(1.3, 0.45, 24, 48), 'wood', '#8a5a2e',
    [-6.5, 0.45, 3.2], [Math.PI / 2, 0, 0]);

  // 金属挡板：位于多数物体与背景墙之间，会在场景中投下明显阴影（遮挡关系）
  add('挡板', new THREE.BoxGeometry(4.2, 4.2, 0.25), 'brushed', '#a8b0b8',
    [3.2, 2.4, -6.5], [0, Math.PI / 7, 0]);

  // 自发光小方块（夜景方案下效果明显）
  add('灯箱', new THREE.BoxGeometry(1.2, 1.2, 1.2), 'emissive', '#ffb54d', [-1.5, 0.6, 6.0]);

  // 网格地面参考线（不参与对象列表）
  const grid = new THREE.GridHelper(46, 46, 0x3a4150, 0x262b36);
  grid.position.y = 0.01;
  scene.add(grid);

  return objects;
}

// 默认灯光（一套初始布光）
export function defaultLights() {
  return [
    {
      id: 'light-1', name: '主聚光', type: 'spot', color: '#fff1dd', intensity: 260,
      position: [8, 11, 7], target: [0, 1, -1], distance: 45, angle: 32, penumbra: 0.35,
      decay: 2, castShadow: true, visible: true,
    },
    {
      id: 'light-2', name: '冷补光', type: 'point', color: '#7fb2ff', intensity: 60,
      position: [-8, 5, 6], target: [0, 0, 0], distance: 30, angle: 45, penumbra: 0.5,
      decay: 2, castShadow: false, visible: true,
    },
    {
      id: 'light-3', name: '轮廓方向光', type: 'directional', color: '#ffe6c4', intensity: 1.2,
      position: [-4, 9, -10], target: [0, 1, 0], distance: 0, angle: 45, penumbra: 0.5,
      decay: 2, castShadow: true, visible: true,
    },
  ];
}
