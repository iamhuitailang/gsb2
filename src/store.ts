import type { DrawItem, InstanceData } from './types';
import { matFromTRS, matMultiply, quatFromEulerDeg, type Mat4, type Vec3 } from './math';

export interface DrawStats {
  total: number;
  visibleCount: number;
  drawnCount: number;
  logicalBatches: number;
  instancedCalls: number;
  chunkCapacity: number;
  bufferCapacity: number;
  reallocCount: number;
}

export class InstanceStore {
  /** 稳定编号 -> 实例数据（Map 保留插入顺序，但绘制顺序由 drawOrder 决定） */
  private instances = new Map<number, InstanceData>();
  /** 本帧绘制顺序，存的是稳定 id；删除/隐藏后 slot 由这里重建 */
  private drawOrder: number[] = [];
  private nextId = 1;
  private nextBatchId = 1;
  reallocCount = 0;

  createBatch(
    specs: Array<{
      position: Vec3;
      rotationDeg?: Vec3;
      scale?: Vec3;
      color: Vec3;
    }>,
  ): number {
    const batchId = this.nextBatchId++;
    for (const spec of specs) {
      const id = this.nextId++; // 单调递增，删除后不复用
      const inst: InstanceData = {
        id,
        batchId,
        position: [...spec.position] as Vec3,
        rotationDeg: spec.rotationDeg
          ? ([...spec.rotationDeg] as Vec3)
          : [0, 0, 0],
        scale: spec.scale ? ([...spec.scale] as Vec3) : [1, 1, 1],
        color: [...spec.color] as Vec3,
        visible: true,
      };
      this.instances.set(id, inst);
      this.drawOrder.push(id);
    }
    return batchId;
  }

  get(id: number): InstanceData | undefined {
    return this.instances.get(id);
  }

  getAll(): InstanceData[] {
    return [...this.instances.values()];
  }

  getDrawOrder(): number[] {
    return this.drawOrder;
  }

  /** 重建本帧绘制列表：只含存在且可见的实例，slot 即时重排 */
  buildDrawList(frustumCull: boolean, mvp: Mat4): DrawItem[] {
    const items: DrawItem[] = [];
    const batchSet = new Set<number>();
    let slot = 0;
    for (const id of this.drawOrder) {
      const inst = this.instances.get(id);
      if (!inst || !inst.visible) continue;
      if (frustumCull && !this.isInFrustum(inst, mvp)) continue;
      items.push({ id, slot: slot++, batchId: inst.batchId });
      batchSet.add(inst.batchId);
    }
    return items;
  }

  /** 8 个角点经 MVP 变换后全部落在裁剪面外才剔除 */
  private isInFrustum(inst: InstanceData, mvp: Mat4): boolean {
    const model = matFromTRS(
      inst.position,
      quatFromEulerDeg(inst.rotationDeg),
      inst.scale,
    );
    const mvpModel = matMultiply(mvp, model);
    let inside = false;
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          // 列主序矩阵乘点 (x,y,z,1)
          const cx =
            mvpModel[0] * sx + mvpModel[4] * sy +
            mvpModel[8] * sz + mvpModel[12];
          const cy =
            mvpModel[1] * sx + mvpModel[5] * sy +
            mvpModel[9] * sz + mvpModel[13];
          const cz =
            mvpModel[2] * sx + mvpModel[6] * sy +
            mvpModel[10] * sz + mvpModel[14];
          const cw =
            mvpModel[3] * sx + mvpModel[7] * sy +
            mvpModel[11] * sz + mvpModel[15];
          if (cw <= 0) continue;
          // 齐次裁剪：-w <= x,y,z <= w（等价 NDC 落在 [-1,1]）
          if (
            cx >= -cw && cx <= cw &&
            cy >= -cw && cy <= cw &&
            cz >= -cw && cz <= cw
          ) {
            inside = true;
          }
        }
      }
    }
    return inside;
  }

  setVisible(id: number, visible: boolean): void {
    const inst = this.instances.get(id);
    if (inst) inst.visible = visible;
  }

  hideSelected(ids: number[]): void {
    for (const id of ids) this.setVisible(id, false);
  }

  showAll(): void {
    for (const inst of this.instances.values()) inst.visible = true;
  }

  deleteIds(ids: number[]): void {
    const kill = new Set(ids);
    for (const id of kill) this.instances.delete(id);
    this.drawOrder = this.drawOrder.filter((id) => !kill.has(id));
  }

  /** 重排绘制顺序（Fisher–Yates），稳定 id 与 slot 的对应关系随之变化 */
  shuffleDrawOrder(): void {
    for (let i = this.drawOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.drawOrder[i], this.drawOrder[j]] = [
        this.drawOrder[j],
        this.drawOrder[i],
      ];
    }
  }

  /** 当前 slot -> 稳定 id，用于面板对照“内部顺序 vs 编号” */
  slotOf(id: number, drawList: DrawItem[]): number {
    return drawList.find((item) => item.id === id)?.slot ?? -1;
  }

  stats(
    drawList: DrawItem[],
    chunkCapacity: number,
    bufferCapacity: number,
  ): DrawStats {
    const batchSet = new Set<number>();
    for (const inst of this.instances.values()) batchSet.add(inst.batchId);
    return {
      total: this.instances.size,
      visibleCount: [...this.instances.values()].filter((i) => i.visible)
        .length,
      drawnCount: drawList.length,
      logicalBatches: batchSet.size,
      instancedCalls: Math.ceil(drawList.length / chunkCapacity),
      chunkCapacity,
      bufferCapacity,
      reallocCount: this.reallocCount,
    };
  }

  serialize(): {
    instances: InstanceData[];
    nextId: number;
    nextBatchId: number;
    drawOrder: number[];
  } {
    return {
      instances: this.getAll().map((i) => ({
        ...i,
        position: [...i.position] as Vec3,
        rotationDeg: [...i.rotationDeg] as Vec3,
        scale: [...i.scale] as Vec3,
        color: [...i.color] as Vec3,
      })),
      nextId: this.nextId,
      nextBatchId: this.nextBatchId,
      drawOrder: [...this.drawOrder],
    };
  }

  static deserialize(data: {
    instances: InstanceData[];
    nextId: number;
    nextBatchId: number;
    drawOrder?: number[];
  }): InstanceStore {
    const store = new InstanceStore();
    store.instances = new Map(data.instances.map((i) => [i.id, i]));
    store.nextId = data.nextId;
    store.nextBatchId = data.nextBatchId;
    store.drawOrder =
      data.drawOrder && data.drawOrder.length === data.instances.length
        ? [...data.drawOrder]
        : data.instances.map((i) => i.id);
    return store;
  }
}
