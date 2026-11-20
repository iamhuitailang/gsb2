// 程序化植被模型：全部由 Three.js 基础几何体拼装，不加载任何外部模型/贴图。
// 每种规则按 kind 选择造型，颜色取自规则，便于在 UI 里区分。

import * as THREE from 'three';

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
    ...opts,
  });
}

/**
 * 创建一棵/一株植物的“母版”网格（单位尺寸，实例化时按 scale 缩放）。
 * @param {object} rule
 * @returns {THREE.Group}
 */
export function createVegetationTemplate(rule) {
  const group = new THREE.Group();
  const color = new THREE.Color(rule.color);

  if (rule.kind === 'tree') {
    buildTree(group, color, rule.id);
  } else if (rule.kind === 'grass') {
    buildGrass(group, color, rule.id);
  } else {
    buildRock(group, color);
  }

  // 让模型底部落在 y=0，实例位置即地形表面
  const box = new THREE.Box3().setFromObject(group);
  group.position.y = -box.min.y;
  group.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return group;
}

function buildTree(group, color, id) {
  const trunkMat = mat(0x6b4a2f, { flatShading: false });
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.14, 1.1, 6),
    trunkMat,
  );
  trunk.position.y = 0.55;
  group.add(trunk);

  const leafMat = mat(color);
  // 针叶树 = 叠锥；阔叶树 = 球簇。用 id 哈希决定风格，保持确定性
  const conifer = hashStr(id) % 2 === 0;
  if (conifer) {
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.75 - i * 0.16, 0.95, 7),
        leafMat,
      );
      cone.position.y = 1.15 + i * 0.62;
      group.add(cone);
    }
  } else {
    const offsets = [
      [0, 1.85, 0, 0.95],
      [0.55, 1.55, 0.2, 0.62],
      [-0.5, 1.6, -0.25, 0.66],
      [0.1, 2.35, -0.1, 0.6],
    ];
    for (const [x, y, z, r] of offsets) {
      const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), leafMat);
      blob.position.set(x, y, z);
      group.add(blob);
    }
  }
}

function buildGrass(group, color, id) {
  const bladeMat = mat(color, { side: THREE.DoubleSide });
  const fern = hashStr(id) % 2 === 0;
  const blades = fern ? 7 : 5;
  for (let i = 0; i < blades; i++) {
    const angle = (i / blades) * Math.PI * 2;
    const blade = new THREE.Mesh(
      new THREE.ConeGeometry(fern ? 0.12 : 0.09, fern ? 0.9 : 0.7, 4),
      bladeMat,
    );
    blade.position.set(Math.cos(angle) * 0.12, 0.4, Math.sin(angle) * 0.12);
    blade.rotation.z = (hashStr(id + i) % 7) * 0.06;
    blade.rotation.x = (hashStr(id + i * 3) % 5) * 0.05;
    group.add(blade);
  }
}

function buildRock(group, color) {
  const rockMat = mat(color, { flatShading: true });
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55, 0), rockMat);
  rock.position.y = 0.32;
  rock.scale.set(1, 0.72, 1.1);
  group.add(rock);
  const pebble = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), rockMat);
  pebble.position.set(0.5, 0.12, 0.3);
  group.add(pebble);
}

/** 简单确定性字符串哈希（仅用于程序化造型选择）。 */
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
