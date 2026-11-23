// 共享的数据类型定义

export interface InstanceData {
  /** 稳定逻辑编号，删除后不复用，与绘制 slot 无关 */
  id: number;
  /** 逻辑批次编号（同一批由同一次操作生成，共享网格与批次变换基调） */
  batchId: number;
  position: [number, number, number];
  /** 欧拉角，单位度，XYZ 内禀顺序 */
  rotationDeg: [number, number, number];
  /** 缩放；分量为负表示镜像 */
  scale: [number, number, number];
  color: [number, number, number];
  visible: boolean;
}

export interface DrawItem {
  /** 指向 InstanceData 的稳定 id */
  id: number;
  /** 本帧在绘制列表中的槽位，每帧重建，不保证稳定 */
  slot: number;
  /** 逻辑批次 */
  batchId: number;
}

export interface PickNeighborCell {
  dx: number;
  dy: number;
  /** 该像素读到的实例 id，0 = 背景 */
  id: number;
}

export interface PickResult {
  /** 点选发生的时间戳 */
  time: number;
  /** CSS 像素坐标 */
  cssX: number;
  cssY: number;
  /** 物理（drawing buffer）像素坐标 */
  physX: number;
  physY: number;
  /** 命中的稳定实例 id，0 = 未命中 */
  hitId: number;
  /** 命中面：局部空间的 ±X/±Y/±Z */
  face: string;
  /** 命中点世界坐标 */
  world: [number, number, number] | null;
  /** 命中点实例局部坐标（镜像/非均匀缩放下仍贴合原网格） */
  local: [number, number, number] | null;
  /** gl_FragCoord.z，0~1 */
  depth: number;
  /** 5×5 邻域像素的 id 分布（启用邻域核对时） */
  neighborhood: PickNeighborCell[];
  /** 点选时视角是否处于冻结布局状态 */
  frozen: boolean;
}

export interface SerializedLayout {
  version: 1;
  exportedAt: string;
  instances: InstanceData[];
  nextId: number;
  nextBatchId: number;
  cameraSnapshot: unknown;
}
