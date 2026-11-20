import type { CameraData, NodeData, SceneFile } from '../core/types';
import { uid } from '../core/document';

/**
 * 内置场景：全部由参数化几何体搭建，无外部资源、无网络依赖。
 * 检查场景刻意构造嵌套层级、非均匀缩放、重叠/隐藏对象等情形，
 * 便于逐项核对需求中的父子变换行为。
 */

const DEFAULT_CAMERA: CameraData = {
  position: [7, 6, 9],
  target: [0, 0.6, 0],
  up: [0, 1, 0],
  fov: 50,
  near: 0.1,
  far: 1000,
};

type NodeInput = Omit<NodeData, 'id' | 'parentId'> & {
  key: string;
  parentKey?: string;
};

/** 用稳定可读的 key 搭场景，输出时再换成真实 id */
function build(
  inputs: NodeInput[],
  camera: CameraData = DEFAULT_CAMERA,
): SceneFile {
  const idByKey = new Map<string, string>();
  const nodes: NodeData[] = [];
  for (const input of inputs) {
    if (!idByKey.has(input.key)) idByKey.set(input.key, uid());
  }
  for (const input of inputs) {
    const { key, parentKey, ...data } = input;
    nodes.push({
      ...data,
      id: idByKey.get(key)!,
      parentId: parentKey ? idByKey.get(parentKey)! : null,
    });
  }
  return { formatVersion: 1, nodes, camera: structuredClone(camera) };
}

const mat = (color: number, opacity?: number) => ({
  material: { color, ...(opacity === undefined ? {} : { opacity }) },
});

// ---------- 示例：几何体小场景 ----------

export function sampleDiorama(): SceneFile {
  return build([
    {
      key: 'ground',
      name: '地面',
      position: [0, -0.06, 0],
      rotation: [-Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'plane', params: [16, 16] },
      ...mat(0x5b6b7f),
    },
    {
      key: 'house',
      name: '房子（组）',
      position: [-2.2, 0, -0.5],
      rotation: [0, 0.35, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'house-body',
      parentKey: 'house',
      name: '墙体',
      position: [0, 0.8, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box', params: [2.2, 1.6, 1.8] },
      ...mat(0xe8d8b0),
    },
    {
      key: 'house-roof',
      parentKey: 'house',
      name: '屋顶',
      position: [0, 2.0, 0],
      rotation: [0, 0, 0],
      scale: [1.25, 1, 1.05],
      visible: true,
      geometry: { kind: 'cone', params: [1.55, 1.1, 4] },
      ...mat(0xb5543f),
    },
    {
      key: 'house-door',
      parentKey: 'house',
      name: '门',
      position: [0, 0.55, 0.92],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box', params: [0.6, 1.1, 0.08] },
      ...mat(0x6b4a2b),
    },
    {
      key: 'trees',
      name: '树木（组）',
      position: [2.6, 0, 1.4],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'tree-a',
      parentKey: 'trees',
      name: '树A 树干',
      position: [0, 0.6, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'cylinder', params: [0.14, 0.2, 1.2, 12] },
      ...mat(0x7a5230),
    },
    {
      key: 'tree-a-crown',
      parentKey: 'trees',
      name: '树A 树冠',
      position: [0, 1.7, 0],
      rotation: [0, 0, 0],
      scale: [1, 1.15, 1],
      visible: true,
      geometry: { kind: 'sphere', params: [0.75, 24, 18] },
      ...mat(0x3f8f4f),
    },
    {
      key: 'tree-b',
      parentKey: 'trees',
      name: '树B（整棵）',
      position: [1.4, 0, -0.9],
      rotation: [0, 0, 0],
      scale: [0.8, 0.8, 0.8],
      visible: true,
      geometry: { kind: 'cone', params: [0.8, 2.4, 20] },
      ...mat(0x357a45),
    },
    {
      key: 'ring',
      name: '圆环摆件',
      position: [0.8, 0.5, 2.6],
      rotation: [Math.PI / 2, 0.4, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'torus', params: [0.55, 0.16, 16, 40] },
      ...mat(0xd9a441),
    },
    {
      key: 'balls',
      name: '球堆（组，演示复制）',
      position: [1.2, 0, -2.4],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'ball-1',
      parentKey: 'balls',
      name: '球 1',
      position: [0, 0.4, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'sphere', params: [0.4, 24, 18] },
      ...mat(0x5aa0e6),
    },
    {
      key: 'ball-2',
      parentKey: 'balls',
      name: '球 2',
      position: [0.55, 0.4, 0.2],
      rotation: [0, 0, 0],
      scale: [0.7, 0.7, 0.7],
      visible: true,
      geometry: { kind: 'sphere', params: [0.4, 24, 18] },
      ...mat(0xe65a6e),
    },
    {
      key: 'ball-3',
      parentKey: 'balls',
      name: '球 3',
      position: [-0.5, 0.4, 0.25],
      rotation: [0, 0, 0],
      scale: [0.55, 0.55, 0.55],
      visible: true,
      geometry: { kind: 'sphere', params: [0.4, 24, 18] },
      ...mat(0x8bd17c),
    },
  ]);
}

// ---------- 检查场景 ----------

export function testNested(): SceneFile {
  // 三层嵌套，每层带平移+旋转，验证世界矩阵与重挂接世界保持
  return build([
    {
      key: 'root-group',
      name: '根组 R（平移+旋转）',
      position: [2, 0, 0],
      rotation: [0, 0, 0.8],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'mid-group',
      parentKey: 'root-group',
      name: '中层 M（平移+Y旋转）',
      position: [1.5, 1, 0],
      rotation: [0, 0.6, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'leaf-box',
      parentKey: 'mid-group',
      name: '叶子盒子（拖动重挂到根，观察世界保持）',
      position: [1, 0, 0.5],
      rotation: [0.2, 0, 0.3],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box' },
      ...mat(0x66a3ff),
    },
    {
      key: 'leaf-sphere',
      parentKey: 'mid-group',
      name: '叶子球（可尝试挂到叶子盒子下）',
      position: [-1, 0.4, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'sphere' },
      ...mat(0xff9966),
    },
  ], { ...DEFAULT_CAMERA, position: [5, 4, 6] });
}

export function testNonUniform(): SceneFile {
  // 父非均匀缩放 + 子旋转 → 世界矩阵含剪切，检查器应标注且读数稳定
  return build([
    {
      key: 'squashed',
      name: '非均匀缩放父级 (3, 0.4, 1)',
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [3, 0.4, 1],
      visible: true,
    },
    {
      key: 'rotated-child',
      parentKey: 'squashed',
      name: '旋转子盒（世界 TRS 含剪切，读数应标注）',
      position: [0.6, 0, 0],
      rotation: [0, 0, Math.PI / 4],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box', params: [1.2, 0.8, 0.8] },
      ...mat(0xff6b6b),
    },
    {
      key: 'scaled-grandchild',
      parentKey: 'rotated-child',
      name: '再嵌套缩放孙节点 (0.5, 2, 1)',
      position: [1, 0, 0],
      rotation: [0.5, 0, 0],
      scale: [0.5, 2, 1],
      visible: true,
      geometry: { kind: 'sphere' },
      ...mat(0x6bffb0),
    },
    {
      key: 'reference',
      name: '对照：均匀缩放父级（无剪切标注）',
      position: [-3, 1, 0],
      rotation: [0, 0.7, 0],
      scale: [2, 2, 2],
      visible: true,
    },
    {
      key: 'reference-child',
      parentKey: 'reference',
      name: '对照子盒',
      position: [1, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box' },
      ...mat(0x9aa7ff),
    },
  ], { ...DEFAULT_CAMERA, position: [6, 4, 7] });
}

export function testReparent(): SceneFile {
  // 多棵子树，专门用于拖动重挂接与循环检测
  return build([
    {
      key: 'branch-a',
      name: '分支 A',
      position: [-2, 0, 0],
      rotation: [0, 0.4, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'a1',
      parentKey: 'branch-a',
      name: 'A-1（试试把分支 A 拖到它下面，应被拒绝）',
      position: [1, 0.8, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box' },
      ...mat(0xffcc66),
    },
    {
      key: 'a2',
      parentKey: 'a1',
      name: 'A-2（A-1 的子节点）',
      position: [1.2, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'sphere' },
      ...mat(0xff8866),
    },
    {
      key: 'branch-b',
      name: '分支 B（非均匀缩放，观察剪切边界提示）',
      position: [2.5, 0, 0],
      rotation: [0, -0.3, 0],
      scale: [2, 0.6, 1.4],
      visible: true,
    },
    {
      key: 'b1',
      parentKey: 'branch-b',
      name: 'B-1（把 A-2 拖到这里，世界位置应保持）',
      position: [0.8, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'cylinder' },
      ...mat(0x66ddcc),
    },
    {
      key: 'loose',
      name: '根级游离对象（拖动排序/挂接）',
      position: [0, 0.5, 2.2],
      rotation: [0.3, 0.4, 0.1],
      scale: [1.3, 0.8, 1],
      visible: true,
      geometry: { kind: 'torus' },
      ...mat(0xcc99ff),
    },
  ], { ...DEFAULT_CAMERA, position: [6, 5, 8] });
}

export function testPicking(): SceneFile {
  // 重叠对象（前后切换选择）+ 隐藏对象（不能挡住后方）
  return build([
    {
      key: 'back',
      name: '后方大球（半透明蓝）',
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1.4, 1.4, 1.4],
      visible: true,
      geometry: { kind: 'sphere' },
      ...mat(0x4d88ff, 0.45),
    },
    {
      key: 'middle',
      name: '中间立方体',
      position: [0, 1, 0.4],
      rotation: [0.3, 0.5, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box', params: [1.1, 1.1, 1.1] },
      ...mat(0xffb347),
    },
    {
      key: 'front',
      name: '前方小球（点选先命中它，Tab 可往后切）',
      position: [0, 1, 1.15],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'sphere', params: [0.35] },
      ...mat(0xff5d73),
    },
    {
      key: 'hidden-curtain',
      name: '隐藏的挡板（visible=false，不应阻挡选择后方）',
      position: [0, 1, 1.6],
      rotation: [0, 0, 0],
      scale: [3, 3, 0.2],
      visible: false,
      geometry: { kind: 'box' },
      ...mat(0x888888),
    },
    {
      key: 'hidden-parent',
      name: '隐藏父组（其子对象也不可被点选）',
      position: [-2.4, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: false,
    },
    {
      key: 'hidden-parent-child',
      parentKey: 'hidden-parent',
      name: '隐藏父组下的盒子',
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box' },
      ...mat(0x77dd77),
    },
    {
      key: 'side-target',
      name: '左侧可点选目标（与隐藏组相邻）',
      position: [-2.4, 1, 1.2],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'cone' },
      ...mat(0xf0e15c),
    },
  ], { ...DEFAULT_CAMERA, position: [0, 3, 6.5], target: [0, 0.9, 0.5] });
}

export function testDelete(): SceneFile {
  // 多层父子，验证删除父对象时保留/连带删除子对象两条路径
  return build([
    {
      key: 'company',
      name: '待删除父组（含两个子对象）',
      position: [0, 0, 0],
      rotation: [0, 0.5, 0],
      scale: [1.6, 1.6, 1.6],
      visible: true,
    },
    {
      key: 'child-a',
      parentKey: 'company',
      name: '子对象 A（保留模式下会被提升到根）',
      position: [1, 0.7, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'box' },
      ...mat(0x66c2ff),
    },
    {
      key: 'child-b',
      parentKey: 'company',
      name: '子对象 B（自身还带一个孙节点）',
      position: [-1, 0.7, 0.6],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
    },
    {
      key: 'grandchild',
      parentKey: 'child-b',
      name: '孙节点球',
      position: [0, 1, 0],
      rotation: [0, 0, 0],
      scale: [0.6, 0.6, 0.6],
      visible: true,
      geometry: { kind: 'sphere' },
      ...mat(0xff9ecf),
    },
    {
      key: 'bystander',
      name: '无关旁观对象（删除不应影响它）',
      position: [3, 0.8, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      visible: true,
      geometry: { kind: 'cylinder' },
      ...mat(0xc9c96b),
    },
  ], { ...DEFAULT_CAMERA, position: [6, 4.5, 7] });
}

export const BUILTIN_SCENES: Record<string, () => SceneFile> = {
  'sample:diorama': sampleDiorama,
  'test:nested': testNested,
  'test:nonuniform': testNonUniform,
  'test:reparent': testReparent,
  'test:picking': testPicking,
  'test:delete': testDelete,
};
