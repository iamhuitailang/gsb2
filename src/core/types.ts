/**
 * 场景文档的纯数据类型。
 * 这些类型同时也是场景文件（JSON）的序列化格式，渲染层（three.js）不参与序列化。
 */

export type Vec3 = [number, number, number];

export type GeometryKind =
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'torus'
  | 'plane';

export interface GeometrySpec {
  kind: GeometryKind;
  /** 语义随几何体类型不同：box=尺寸, sphere=[半径,...], cylinder=[半径Top,半径Bottom,高度,...] 等 */
  params?: number[];
}

export interface MaterialSpec {
  color: number;
  opacity?: number;
  metalness?: number;
  roughness?: number;
}

export interface NodeData {
  id: string;
  name: string;
  /** null 或不存在表示挂在场景根下 */
  parentId: string | null;
  /** 局部平移（父节点坐标系） */
  position: Vec3;
  /** 局部欧拉旋转（弧度，XYZ 顺序） */
  rotation: Vec3;
  /** 局部缩放（各轴独立，允许非均匀缩放） */
  scale: Vec3;
  visible: boolean;
  /** 纯分组节点没有几何体 */
  geometry?: GeometrySpec;
  material?: MaterialSpec;
}

export interface CameraData {
  position: Vec3;
  /** 轨道控制器观察目标点 */
  target: Vec3;
  up: Vec3;
  fov: number;
  near: number;
  far: number;
}

export interface SceneFile {
  /** 格式版本号，后续升级时用于迁移 */
  formatVersion: 1;
  /** 节点在数组中的顺序即场景树同层排序 */
  nodes: NodeData[];
  camera: CameraData;
}

export type TransformSpace = 'local' | 'world';
export type GizmoMode = 'translate' | 'rotate' | 'scale';
