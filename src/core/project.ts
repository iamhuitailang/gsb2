// 项目文件：把源文件文本、贴图 dataUrl、相机状态、显示模式与全部覆盖项打包为单个 JSON

import type {
  CameraState,
  DisplayMode,
  EnvironmentId,
  LoadedSource,
  MaterialOverride,
  NodeOverride,
  ProjectFile,
  SceneModel,
  SceneNode,
} from './types';

export interface SaveInput {
  sources: LoadedSource[];
  model: SceneModel;
  camera: CameraState;
  displayMode: DisplayMode;
  environment: EnvironmentId;
  nodeOverrides: Map<string, NodeOverride>;
  materialOverrides: Map<string, MaterialOverride>;
  selectedNodeId: string | null;
}

export function buildProjectFile(input: SaveInput): ProjectFile {
  const objFiles = input.sources.filter((s) => s.kind === 'obj');
  const mtlFiles = input.sources
    .filter((s) => s.kind === 'mtl')
    .map((s) => ({ name: s.name, text: s.text ?? '' }));
  const textures = input.sources
    .filter((s) => s.kind === 'texture' && s.dataUrl)
    .map((s) => ({ name: s.name, dataUrl: s.dataUrl! }));

  const nodeOverrides: Record<string, NodeOverride> = {};
  for (const [id, override] of input.nodeOverrides) {
    // 空覆盖项不写入，保持文件精简
    const hasHidden = override.hidden === true;
    const hasColor = override.colorOverride !== undefined && override.colorOverride !== null;
    if (hasHidden || hasColor) nodeOverrides[id] = override;
  }
  const materialOverrides: Record<string, MaterialOverride> = {};
  for (const [name, override] of input.materialOverrides) {
    if (override.diffuse !== undefined || override.opacity !== undefined) {
      materialOverrides[name] = override;
    }
  }

  return {
    format: 'webgl-model-viewer-project',
    version: 1,
    savedAt: new Date().toISOString(),
    sources: {
      objFileName: objFiles[0]?.name ?? input.model.objFileName,
      objText: objFiles[0]?.text ?? '',
      mtlFiles,
      textures,
    },
    camera: input.camera,
    displayMode: input.displayMode,
    environment: input.environment,
    nodeOverrides,
    materialOverrides,
    selectedNodeId: input.selectedNodeId,
  };
}

export function serializeProject(file: ProjectFile): string {
  return JSON.stringify(file, null, 2);
}

export function parseProject(text: string): ProjectFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('项目文件不是合法 JSON，无法打开');
  }
  const obj = data as Partial<ProjectFile>;
  if (obj.format !== 'webgl-model-viewer-project' || obj.version !== 1) {
    throw new Error('文件格式或版本不受支持（需要 format=webgl-model-viewer-project, version=1）');
  }
  if (!obj.sources || typeof obj.sources.objText !== 'string') {
    throw new Error('项目文件缺少 sources.objText，数据不完整');
  }
  if (!obj.camera || !Array.isArray(obj.camera.target)) {
    throw new Error('项目文件缺少相机状态，数据不完整');
  }
  return obj as ProjectFile;
}

/** 项目文件还原为统一的 LoadedSource 列表，复用常规加载管线 */
export function projectToSources(project: ProjectFile): LoadedSource[] {
  const out: LoadedSource[] = [
    {
      name: project.sources.objFileName,
      text: project.sources.objText,
      dataUrl: null,
      kind: 'obj',
    },
    ...project.sources.mtlFiles.map((m) => ({
      name: m.name,
      text: m.text,
      dataUrl: null,
      kind: 'mtl' as const,
    })),
    ...project.sources.textures.map((t) => ({
      name: t.name,
      text: null,
      dataUrl: t.dataUrl,
      kind: 'texture' as const,
    })),
  ];
  return out;
}

/** 重新解析后按稳定 ID 校验覆盖项，丢弃已不存在的节点 */
export function reconcileNodeOverrides(
  saved: Record<string, NodeOverride>,
  root: SceneNode,
): Map<string, NodeOverride> {
  const validIds = new Set<string>();
  const walk = (node: SceneNode): void => {
    validIds.add(node.id);
    node.children.forEach(walk);
  };
  walk(root);
  const out = new Map<string, NodeOverride>();
  for (const [id, override] of Object.entries(saved)) {
    if (validIds.has(id)) out.set(id, override);
  }
  return out;
}

export function reconcileMaterialOverrides(
  saved: Record<string, MaterialOverride>,
  model: SceneModel,
): Map<string, MaterialOverride> {
  const out = new Map<string, MaterialOverride>();
  for (const [name, override] of Object.entries(saved)) {
    if (model.materials.has(name)) out.set(name, override);
  }
  return out;
}
