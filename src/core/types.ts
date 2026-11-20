// 全项目共享的数据类型定义

import type { BBox, Vec3 } from './math';

/** 渲染显示模式 */
export type DisplayMode = 'material' | 'wireframe' | 'normal';

/** 光照环境预设 */
export type EnvironmentId = 'studio' | 'daylight' | 'night';

/** 读取 / 解析阶段产生的警告，全部携带具体位置 */
export interface ParseWarning {
  level: 'warn' | 'error';
  code: string;
  /** 人类可读的说明（中文界面直接展示） */
  message: string;
  /** 来源文件名 */
  file: string;
  /** 行号（从 1 开始；无行号时为 null） */
  line: number | null;
  /** 原始行内容，便于定位 */
  raw?: string;
}

/** 一条面的原始顶点引用（1 基索引，可能为负，0/越界由构建阶段校验） */
export interface RawFaceVertex {
  v: number;
  vt: number;
  vn: number;
}

export interface RawFace {
  vertices: RawFaceVertex[];
  material: string | null;
  line: number;
  invalid?: string;
}

export interface RawGroup {
  name: string | null;
  faceIndices: number[];
}

export interface RawObject {
  name: string | null;
  /** 该对象下声明过的组（至少一个，默认组名 null） */
  groups: RawGroup[];
  startLine: number;
}

export interface ParsedObj {
  vertices: Vec3[];
  texcoords: [number, number][];
  normals: Vec3[];
  objects: RawObject[];
  faces: RawFace[];
  mtllibs: string[];
  warnings: ParseWarning[];
}

export interface MtlColor {
  r: number;
  g: number;
  b: number;
}

export interface MtlTextureRef {
  /** 声明里的原始路径（区分大小写的 basename 匹配） */
  path: string;
  line: number;
}

export interface MtlMaterial {
  name: string;
  diffuse: MtlColor;
  ambient: MtlColor;
  specular: MtlColor;
  /** 高光指数 */
  shininess: number;
  /** 不透明度 0..1（d 与 Tr 都会归一化到这里） */
  opacity: number;
  diffuseMap: MtlTextureRef | null;
  normalMap: MtlTextureRef | null;
  /** 该材质实际使用到的贴图文件路径（解析后回填是否缺失） */
}

export interface ParsedMtl {
  file: string;
  materials: Map<string, MtlMaterial>;
  warnings: ParseWarning[];
}

/** 一个材质分桶的可渲染网格（每个 group 内按材质拆分） */
export interface SubMesh {
  materialName: string | null;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
  bbox: BBox;
}

export interface SceneNode {
  /** 稳定唯一 ID：对象为 "o:idx"，组为 "o:idx/g:idx"，不依赖名字 */
  id: string;
  kind: 'object' | 'group';
  /** 界面展示名（同名已加序号后缀，保证兄弟节点不重名） */
  label: string;
  /** OBJ 文件中的原始名字（可能为 null 或重复） */
  rawName: string | null;
  objectIndex: number;
  groupIndex: number | null;
  children: SceneNode[];
  submeshes: SubMesh[];
  bbox: BBox;
  vertexCount: number;
  faceCount: number;
  hidden: boolean;
  /** 颜色覆盖（null = 使用材质本色） */
  colorOverride: string | null;
}

export interface SceneModel {
  root: SceneNode;
  objects: SceneNode[];
  materials: Map<string, MtlMaterial>;
  /** 材质名 -> 缺失贴图的声明路径 */
  missingTextures: Map<string, string[]>;
  /** obj 中引用但所有 mtl 都没有定义的材质名 */
  missingMaterials: string[];
  warnings: ParseWarning[];
  objFileName: string;
  mtlFileNames: string[];
}

/** 单个节点的持久化覆盖项 */
export interface NodeOverride {
  hidden?: boolean;
  colorOverride?: string | null;
}

/** 单个材质的持久化覆盖项 */
export interface MaterialOverride {
  diffuse?: string;
  opacity?: number;
}

export interface CameraState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
}

/** 项目文件（.mvproj.json） */
export interface ProjectFile {
  format: 'webgl-model-viewer-project';
  version: 1;
  savedAt: string;
  sources: {
    objFileName: string;
    objText: string;
    mtlFiles: { name: string; text: string }[];
    textures: { name: string; dataUrl: string }[];
  };
  camera: CameraState;
  displayMode: DisplayMode;
  environment: EnvironmentId;
  nodeOverrides: Record<string, NodeOverride>;
  materialOverrides: Record<string, MaterialOverride>;
  selectedNodeId: string | null;
}

export interface LoadedSource {
  name: string;
  text: string | null;
  dataUrl: string | null;
  kind: 'obj' | 'mtl' | 'texture' | 'other';
}
