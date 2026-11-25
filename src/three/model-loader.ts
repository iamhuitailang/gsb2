/**
 * 本地模型加载：支持 OBJ(+MTL+贴图) 与 glTF/GLB。
 * 所有资源来自用户选择的本地 File，通过 LoadingManager 的 URL modifier
 * 按文件名解析 .mtl / .bin / 贴图等伴随文件，不访问网络。
 */
import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface LoadedObject {
  name: string;
  format: 'obj' | 'gltf' | 'glb';
  root: THREE.Group;
  /** 网格与其原始材质名（按 group 顺序） */
  meshes: Array<{ mesh: THREE.Mesh; materialNames: string[] }>;
  /** 从模型文件中解析出的贴图：材质名 -> 纹理 */
  embeddedTextures: Map<string, THREE.Texture>;
  /** 原始文件（保存工程时内嵌） */
  files: Map<string, Uint8Array>;
}

export const SUPPORTED_EXTENSIONS = ['.obj', '.mtl', '.gltf', '.glb'];

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/**
 * 建立文件名 -> objectURL 的映射，并返回 LoadingManager。
 */
function buildManager(files: File[]): {
  manager: THREE.LoadingManager;
  bytes: Map<string, Uint8Array>;
  revoke: () => void;
} {
  const urls = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  for (const f of files) {
    const name = baseName(f.name);
    urls.set(name, URL.createObjectURL(f));
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = baseName(url.split('?')[0]);
    return urls.get(name) ?? url;
  });
  return {
    manager,
    bytes,
    revoke: () => {
      for (const u of urls.values()) URL.revokeObjectURL(u);
    },
  };
}

async function readFilesAsBytes(files: File[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    out.set(baseName(f.name), new Uint8Array(await f.arrayBuffer()));
  }
  return out;
}

function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

function extractTextures(meshes: THREE.Mesh[]): Map<string, THREE.Texture> {
  const map = new Map<string, THREE.Texture>();
  for (const mesh of meshes) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m, i) => {
      const std = m as THREE.MeshStandardMaterial;
      if (std?.map) {
        const name = m.name || `material_${i}`;
        if (!map.has(name)) map.set(name, std.map);
      }
    });
  }
  return map;
}

async function loadObj(files: File[]): Promise<LoadedObject> {
  const objFile = files.find((f) => extOf(f.name) === '.obj')!;
  const mtlFile = files.find((f) => extOf(f.name) === '.mtl');
  const { manager, revoke } = buildManager(files);
  try {
    let materials: MTLLoader.MaterialCreator | null = null;
    if (mtlFile) {
      const mtlLoader = new MTLLoader(manager);
      materials = await new Promise<MTLLoader.MaterialCreator>((resolve, reject) =>
        mtlLoader.load(
          baseName(mtlFile.name),
          (m) => resolve(m),
          undefined,
          reject,
        ),
      );
      materials.preload();
    }
    const objLoader = new OBJLoader(manager);
    if (materials) objLoader.setMaterials(materials);
    const root = await new Promise<THREE.Group>((resolve, reject) =>
      objLoader.load(
        baseName(objFile.name),
        (o) => resolve(o),
        undefined,
        reject,
      ),
    );
    const meshes = collectMeshes(root);
    const result = meshes.map((mesh) => {
      const g = mesh.geometry as THREE.BufferGeometry;
      const count = g.groups.length || 1;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const materialNames = Array.from(
        { length: count },
        (_, i) => mats[i]?.name || `material_${i}`,
      );
      return { mesh, materialNames };
    });
    return {
      name: baseName(objFile.name).replace(/\.obj$/i, ''),
      format: 'obj',
      root,
      meshes: result,
      embeddedTextures: extractTextures(meshes),
      files: await readFilesAsBytes(files),
    };
  } finally {
    // 纹理解码后再回收；延迟一帧保证图像已载入
    setTimeout(revoke, 5000);
  }
}

async function loadGltf(files: File[]): Promise<LoadedObject> {
  const main = files.find(
    (f) => extOf(f.name) === '.gltf' || extOf(f.name) === '.glb',
  )!;
  const format = extOf(main.name) === '.glb' ? 'glb' : 'gltf';
  const { manager, revoke } = buildManager(files);
  try {
    const loader = new GLTFLoader(manager);
    const gltf = await new Promise<GLTF>((resolve, reject) =>
      loader.load(
        baseName(main.name),
        (g) => resolve(g),
        undefined,
        reject,
      ),
    );
    const root = gltf.scene;
    const meshes = collectMeshes(root);
    const result = meshes.map((mesh) => {
      const g = mesh.geometry as THREE.BufferGeometry;
      const count = g.groups.length || 1;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const materialNames = Array.from(
        { length: count },
        (_, i) => mats[i]?.name || `material_${i}`,
      );
      return { mesh, materialNames };
    });
    return {
      name: baseName(main.name).replace(/\.(gltf|glb)$/i, ''),
      format,
      root,
      meshes: result,
      embeddedTextures: extractTextures(meshes),
      files: await readFilesAsBytes(files),
    };
  } finally {
    setTimeout(revoke, 5000);
  }
}

export async function loadModelFiles(files: File[]): Promise<LoadedObject> {
  const exts = files.map((f) => extOf(f.name));
  if (exts.includes('.obj')) return loadObj(files);
  if (exts.includes('.gltf') || exts.includes('.glb')) return loadGltf(files);
  throw new Error(
    `不支持的文件类型：${exts.join(', ')}。支持 ${SUPPORTED_EXTENSIONS.join(' / ')}`,
  );
}
