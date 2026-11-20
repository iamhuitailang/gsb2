// 实例化植被渲染：每条规则一个 InstancedMesh，分块变化时只重建受影响规则的矩阵。
// 大区域下 draw call 数 = 规则数，与实例总数无关；天然支持分块增量编辑。

import * as THREE from 'three';
import { createVegetationTemplate } from './vegetation.js';

// 单条规则允许的最大实例数，超出后扩容重建
const CAPACITY_STEP = 2000;

export class VegetationRenderer {
  /**
   * @param {THREE.Scene} scene
   * @param {Array} rules
   */
  constructor(scene, rules) {
    this.scene = scene;
    this.rules = rules;
    /** @type {Map<string, {mesh: THREE.InstancedMesh, capacity:number, template:THREE.Group}>} */
    this.byRule = new Map();
    this.dummy = new THREE.Object3D();
    this._buildPools(rules);
  }

  _buildPools(rules) {
    for (const rule of rules) {
      const template = createVegetationTemplate(rule);
      // 合并模板几何为单个几何，InstancedMesh 只支持单材质单几何
      const merged = mergeTemplate(template);
      const mesh = new THREE.InstancedMesh(merged.geometry, merged.material, CAPACITY_STEP);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // 实例遍布地形，跳过包围体剔除避免闪烁
      this.scene.add(mesh);
      this.byRule.set(rule.id, { mesh, capacity: CAPACITY_STEP, template });
    }
  }

  /**
   * 根据全量实例刷新受影响规则的 InstancedMesh。
   * @param {Array} allInstances scatter.getAllInstances() 的结果
   * @param {Set<string>} [changedRuleIds] 本次脏块涉及的规则；不传则全量刷新
   */
  update(allInstances, changedRuleIds) {
    const grouped = new Map();
    for (const inst of allInstances) {
      if (changedRuleIds && !changedRuleIds.has(inst.ruleId)) continue;
      if (!grouped.has(inst.ruleId)) grouped.set(inst.ruleId, []);
      grouped.get(inst.ruleId).push(inst);
    }
    // 受影响但本次没有实例的规则也要清零
    const targets = changedRuleIds ?? new Set(this.rules.map((r) => r.id));
    for (const ruleId of targets) {
      const pool = this.byRule.get(ruleId);
      if (!pool) continue;
      this._fillPool(pool, grouped.get(ruleId) ?? []);
    }
  }

  _fillPool(pool, instances) {
    if (instances.length > pool.capacity) {
      const newCapacity = Math.ceil(instances.length / CAPACITY_STEP) * CAPACITY_STEP;
      this._growPool(pool, newCapacity);
    }
    const { mesh } = pool;
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      this.dummy.position.set(inst.x, inst.y, inst.z);
      // 绕 Y 的随机旋转；倾斜贴合法线时叠加 X 轴小角度
      this.dummy.rotation.set(
        (inst.tiltDeg * Math.PI) / 180,
        inst.rotationY,
        0,
      );
      this.dummy.scale.setScalar(inst.scale);
      this.dummy.updateMatrix();
      mesh.setMatrixAt(i, this.dummy.matrix);
    }
    mesh.count = instances.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  _growPool(pool, newCapacity) {
    const old = pool.mesh;
    const mesh = new THREE.InstancedMesh(old.geometry, old.material, newCapacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = old.count;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    // 复制已有矩阵
    for (let i = 0; i < old.count; i++) {
      mesh.setMatrixAt(i, old.getMatrixAt(i));
    }
    this.scene.remove(old);
    old.dispose();
    this.scene.add(mesh);
    pool.mesh = mesh;
    pool.capacity = newCapacity;
  }

  /** 规则集合整体替换（增删规则/改色）时重建所有池。 */
  rebuildPools(rules, allInstances) {
    for (const { mesh } of this.byRule.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    this.byRule.clear();
    this.rules = rules;
    this._buildPools(rules);
    this.update(allInstances);
  }

  /**
   * 规则 id 集合未变（只改参数/颜色）时，按新规则重建几何与材质但保留实例数据。
   */
  syncRuleTemplates(rules, allInstances) {
    const sameIds = rules.length === this.rules.length &&
      rules.every((r) => this.byRule.has(r.id));
    if (!sameIds) {
      this.rebuildPools(rules, allInstances);
      return;
    }
    for (const rule of rules) {
      const pool = this.byRule.get(rule.id);
      const old = pool.mesh;
      const template = createVegetationTemplate(rule);
      const merged = mergeTemplate(template);
      const mesh = new THREE.InstancedMesh(merged.geometry, merged.material, pool.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = old.count;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      for (let i = 0; i < old.count; i++) mesh.setMatrixAt(i, old.getMatrixAt(i));
      this.scene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
      old.dispose();
      this.scene.add(mesh);
      pool.mesh = mesh;
      pool.template = template;
    }
    this.rules = rules;
  }

  dispose() {
    for (const { mesh } of this.byRule.values()) {
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    this.byRule.clear();
  }
}

/**
 * 把模板 Group 里的多个 Mesh 烘焙成单个 BufferGeometry + 单材质。
 * 颜色逐顶点写入，保证一个 InstancedMesh 就能表现树干与叶冠。
 */
function mergeTemplate(group) {
  group.updateMatrixWorld(true);
  const geometries = [];
  const materials = [];
  let vertexCount = 0;
  let indexCount = 0;

  group.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone();
    geo.applyMatrix4(o.matrixWorld);
    const color = o.material.color ?? new THREE.Color(0xffffff);
    const vCount = geo.attributes.position.count;
    const colorArr = new Float32Array(vCount * 3);
    for (let i = 0; i < vCount; i++) {
      colorArr[i * 3] = color.r;
      colorArr[i * 3 + 1] = color.g;
      colorArr[i * 3 + 2] = color.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colorArr, 3));
    geometries.push(geo);
    materials.push(o.material);
    vertexCount += vCount;
    indexCount += geo.index ? geo.index.count : vCount;
  });

  const merged = new THREE.BufferGeometry();
  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const color = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(indexCount);

  let vOff = 0;
  let iOff = 0;
  for (const geo of geometries) {
    const vCount = geo.attributes.position.count;
    position.set(geo.attributes.position.array, vOff * 3);
    normal.set(geo.attributes.normal.array, vOff * 3);
    color.set(geo.attributes.color.array, vOff * 3);
    if (geo.attributes.uv) uv.set(geo.attributes.uv.array, vOff * 2);
    const src = geo.index
      ? geo.index.array
      : Uint32Array.from({ length: vCount }, (_, i) => i);
    for (let i = 0; i < src.length; i++) indices[iOff++] = src[i] + vOff;
    vOff += vCount;
  }

  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));

  // 统一材质：顶点色驱动，双面保证草叶可见
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  return { geometry: merged, material };
}
