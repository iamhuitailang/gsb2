// 网格数据模型与工厂。
// mesh = {
//   name, positions:[[x,y,z]...], faces:[[a,b,c]...],
//   faceMaterials:string[], materials:{name:{diffuse:[r,g,b]}},
//   uvSets:[[ [[u,v],x3] per face ]...],   // 每套内按面、按 corner 存 UV
//   seams:Set<string>, topology:buildTopology(faces)
// }

import { buildTopology } from './topology.js';

export function createMesh({ name = 'mesh', positions, faces, faceMaterials, materials, uvSets }) {
  const topology = buildTopology(faces);
  const seamInit = new Set();
  // 非流形/边界天然是缝；内部边初始不切
  const mesh = {
    name,
    positions,
    faces,
    faceMaterials: faceMaterials ?? faces.map(() => 'default'),
    materials: materials ?? { default: { diffuse: [0.62, 0.65, 0.7] } },
    uvSets: uvSets ?? [],
    seams: seamInit,
    topology,
  };
  if (!mesh.uvSets.length) addUvSet(mesh);
  return mesh;
}

/** 新增一套 UV。默认复制第 0 套（若存在），否则给 [0,1] 占位坐标。 */
export function addUvSet(mesh, name) {
  const base = mesh.uvSets[0];
  const uvs = base
    ? base.map((tri) => tri.map(([u, v]) => [u, v]))
    : mesh.faces.map((f, i) => f.map((_, k) => [(k / 3 + (i % 4) * 0.25) % 1, ((i + k) % 4) * 0.25]));
  mesh.uvSets.push(uvs);
  mesh.uvNames = mesh.uvNames ?? [];
  mesh.uvNames.push(name ?? `UVSet ${mesh.uvSets.length}`);
  return mesh.uvSets.length - 1;
}

export function removeUvSet(mesh, index) {
  if (mesh.uvSets.length <= 1) return false;
  mesh.uvSets.splice(index, 1);
  mesh.uvNames?.splice(index, 1);
  return true;
}

/** 深拷贝（项目保存/测试用）。 */
export function cloneMesh(mesh) {
  return {
    name: mesh.name,
    positions: mesh.positions.map((p) => [...p]),
    faces: mesh.faces.map((f) => [...f]),
    faceMaterials: [...mesh.faceMaterials],
    materials: Object.fromEntries(
      Object.entries(mesh.materials).map(([k, v]) => [k, { diffuse: [...v.diffuse] }]),
    ),
    uvSets: mesh.uvSets.map((s) => s.map((t) => t.map(([u, v]) => [u, v]))),
    uvNames: mesh.uvNames ? [...mesh.uvNames] : undefined,
    seams: new Set(mesh.seams),
    topology: mesh.topology, // 拓扑只依赖 faces，可共享
  };
}
