import * as THREE from 'three';
import type { NodeData, SceneFile, Vec3 } from './types';
import {
  composeLocal,
  decompose,
  isAncestor,
  reparentLocalTRS,
  type DecomposedTRS,
} from './transforms';

export type DocChangeType =
  | 'structure'
  | 'transform'
  | 'visibility'
  | 'rename'
  | 'selection'
  | 'load';

export interface DocChange {
  type: DocChangeType;
  /** 受影响的节点 id（load 时为空） */
  nodeIds?: string[];
}

export interface ReparentResult {
  from: { parentId: string | null; index: number };
  to: { parentId: string | null; index: number };
  /** 重挂接前的局部 TRS，撤销时恢复 */
  oldLocal: Pick<NodeData, 'position' | 'rotation' | 'scale'>;
}

let idCounter = 0;
export function uid(prefix = 'node'): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/**
 * 场景文档：编辑器唯一的数据源（single source of truth）。
 * 渲染对象、场景树 UI、检查器都从这里派生；场景文件也是它的序列化结果。
 */
export class SceneDocument {
  private nodes = new Map<string, NodeData>();
  /** key 为父节点 id，根用 null */
  private childrenOf = new Map<string | null, string[]>();
  private worldCache = new Map<string, THREE.Matrix4>();
  private listeners = new Set<(change: DocChange) => void>();
  private _selection: string | null = null;

  constructor() {
    this.childrenOf.set(null, []);
  }

  // ---------- 订阅 ----------

  subscribe(fn: (change: DocChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: DocChangeType, nodeIds?: string[]): void {
    const change: DocChange = { type, nodeIds };
    this.listeners.forEach((fn) => fn(change));
  }

  // ---------- 读取 ----------

  get selection(): string | null {
    return this._selection;
  }

  select(id: string | null): void {
    if (id !== null && !this.nodes.has(id)) id = null;
    if (this._selection === id) return;
    this._selection = id;
    this.emit('selection', id ? [id] : undefined);
  }

  getNode(id: string): NodeData | undefined {
    return this.nodes.get(id);
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  getParent(id: string): string | null {
    return this.nodes.get(id)?.parentId ?? null;
  }

  getChildren(parentId: string | null): string[] {
    return [...(this.childrenOf.get(parentId) ?? [])];
  }

  /** 深度优先的稳定顺序，同时也是序列化顺序 */
  getAllNodes(): NodeData[] {
    const out: NodeData[] = [];
    const walk = (parent: string | null): void => {
      for (const id of this.childrenOf.get(parent) ?? []) {
        const n = this.nodes.get(id);
        if (!n) continue;
        out.push(n);
        walk(id);
      }
    };
    walk(null);
    return out;
  }

  /** 收集子树（含自身），保持树顺序 */
  subtreeIds(id: string): string[] {
    const out: string[] = [];
    const walk = (cur: string): void => {
      out.push(cur);
      for (const child of this.childrenOf.get(cur) ?? []) walk(child);
    };
    walk(id);
    return out;
  }

  // ---------- 世界矩阵 ----------

  /** 节点世界矩阵（带缓存，任何变更都会清空缓存） */
  getWorldMatrix(id: string): THREE.Matrix4 {
    const cached = this.worldCache.get(id);
    if (cached) return cached;

    const node = this.nodes.get(id);
    if (!node) throw new Error(`节点不存在: ${id}`);
    const local = composeLocal(node.position, node.rotation, node.scale);
    // 不能原地 premultiply：那会修改父节点缓存矩阵本身。用新矩阵相乘。
    const world =
      node.parentId === null
        ? local
        : this.getWorldMatrix(node.parentId).clone().multiply(local);
    this.worldCache.set(id, world);
    return world;
  }

  getWorldTRS(id: string): DecomposedTRS {
    return decompose(this.getWorldMatrix(id));
  }

  private invalidateWorlds(ids?: string[]): void {
    if (ids) ids.forEach((id) => this.worldCache.delete(id));
    else this.worldCache.clear();
  }

  // ---------- 结构变更 ----------

  /**
   * 新建节点。返回新节点数据。
   * index 为 null 时追加到父节点末尾。
   */
  addNode(
    data: Omit<NodeData, 'id' | 'parentId'> & {
      id?: string;
      parentId?: string | null;
    },
    parentId: string | null = null,
    index: number | null = null,
  ): NodeData {
    if (parentId !== null && !this.nodes.has(parentId)) {
      throw new Error(`父节点不存在: ${parentId}`);
    }
    const id = data.id ?? uid();
    if (this.nodes.has(id)) throw new Error(`节点 id 重复: ${id}`);
    const node: NodeData = {
      ...data,
      id,
      parentId,
    };
    this.nodes.set(id, node);
    this.childrenOf.set(id, []);
    const list = this.childrenOf.get(parentId)!;
    const at = index === null ? list.length : THREE.MathUtils.clamp(index, 0, list.length);
    list.splice(at, 0, id);
    this.invalidateWorlds();
    this.emit('structure', [id]);
    return node;
  }

  /**
   * 重挂接 / 同层排序。
   * - 拒绝把节点挂到自身或其子孙下（会形成循环父子关系）。
   * - 默认保持世界变换不变：重算新父坐标系下的局部 TRS。
   * 返回撤销所需的完整信息。
   */
  reparent(
    id: string,
    newParentId: string | null,
    index: number | null = null,
    preserveWorld = true,
  ): ReparentResult {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`节点不存在: ${id}`);
    if (newParentId !== null && !this.nodes.has(newParentId)) {
      throw new Error(`目标父节点不存在: ${newParentId}`);
    }
    if (newParentId === id) {
      throw new Error('拒绝循环父子关系：不能把对象挂到它自己下面');
    }
    if (newParentId !== null && isAncestor(newParentId, id, (x) => this.getParent(x))) {
      throw new Error(
        `拒绝循环父子关系：「${this.nodes.get(newParentId)!.name}」是「${node.name}」的子孙，` +
          '挂接后层级会形成环',
      );
    }

    const oldParent = node.parentId;
    const oldIndex = this.childrenOf.get(oldParent)!.indexOf(id);
    const oldLocal = {
      position: [...node.position] as Vec3,
      rotation: [...node.rotation] as Vec3,
      scale: [...node.scale] as Vec3,
    };

    // 先算新世界局部 TRS（在移动之前取世界矩阵与新父世界矩阵）
    let newLocal = oldLocal;
    if (preserveWorld && newParentId !== oldParent) {
      const world = this.getWorldMatrix(id);
      const parentWorld =
        newParentId === null ? null : this.getWorldMatrix(newParentId);
      newLocal = reparentLocalTRS(world, parentWorld);
    }

    // 从旧父列表移除
    const oldList = this.childrenOf.get(oldParent)!;
    oldList.splice(oldIndex, 1);

    // 插入新父列表
    node.parentId = newParentId;
    const newList = this.childrenOf.get(newParentId)!;
    const at =
      index === null ? newList.length : THREE.MathUtils.clamp(index, 0, newList.length);
    newList.splice(at, 0, id);

    node.position = newLocal.position;
    node.rotation = newLocal.rotation;
    node.scale = newLocal.scale;

    this.invalidateWorlds();
    this.emit('structure', [id]);
    return {
      from: { parentId: oldParent, index: oldIndex },
      to: { parentId: newParentId, index: at },
      oldLocal,
    };
  }

  /**
   * 删除节点。
   * - keepChildren=true：子对象提升到被删节点的父级，并保持各自世界变换。
   * - keepChildren=false：整棵子树一起删除。
   * 返回被删除节点的快照（撤销时原样恢复）。
   */
  removeNode(
    id: string,
    keepChildren: boolean,
  ): { removed: NodeData[]; reparented: { id: string; old: ReparentResult }[] } {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`节点不存在: ${id}`);

    const removed: NodeData[] = [];
    const reparented: { id: string; old: ReparentResult }[] = [];

    if (keepChildren) {
      // 先把直接子节点逐个提升（递归处理：孙子会随子节点一起被提升链覆盖）
      const kids = [...(this.childrenOf.get(id) ?? [])];
      for (const childId of kids) {
        const old = this.reparent(childId, node.parentId, null, true);
        reparented.push({ id: childId, old });
      }
    } else {
      for (const sid of this.subtreeIds(id)) {
        removed.push(this.cloneNodeData(this.nodes.get(sid)!));
      }
    }

    if (keepChildren) removed.push(this.cloneNodeData(node));

    // 实际摘除
    const parent = node.parentId;
    const list = this.childrenOf.get(parent)!;
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);

    const eraseIds = keepChildren ? [id] : this.subtreeIds(id);
    for (const sid of eraseIds) {
      this.nodes.delete(sid);
      this.childrenOf.delete(sid);
      this.worldCache.delete(sid);
    }
    if (this._selection && !this.nodes.has(this._selection)) {
      this._selection = null;
      this.emit('selection');
    }
    this.invalidateWorlds();
    this.emit('structure', eraseIds);
    return { removed, reparented };
  }

  /** 恢复被删除的节点（撤销用，按快照原样重建）。只增量恢复被删子树，不动其他节点。 */
  restoreNodes(
    removed: NodeData[],
    reparented: { id: string; old: ReparentResult }[],
  ): void {
    // 1) 恢复节点数据及其（初始为空的）子列表。
    //    快照是删除时子树的 DFS，父节点一定先于子节点出现。
    for (const data of removed) {
      const snap = this.cloneNodeData(data);
      this.nodes.set(snap.id, snap);
      this.childrenOf.set(snap.id, []);
    }
    // 2) 按快照里的 parentId 接回层级。被删子树的内部父子关系在快照内闭合；
    //    子树根的父节点是删除时就存在、且未被删除的节点（否则它也会在快照里）。
    for (const data of removed) {
      const list = this.childrenOf.get(data.parentId);
      if (!list) {
        throw new Error(`恢复失败：父节点 ${data.parentId} 不存在，快照数据可能已损坏`);
      }
      list.push(data.id);
    }
    // 3) keepChildren 模式：删除前被临时提升的子节点要挂回原父，并恢复原局部 TRS
    for (const r of reparented) {
      const child = this.nodes.get(r.id);
      if (!child) continue;
      const list = this.childrenOf.get(child.parentId)!;
      const cur = list.indexOf(r.id);
      if (cur >= 0) list.splice(cur, 1);
      child.parentId = r.old.from.parentId;
      child.position = r.old.oldLocal.position;
      child.rotation = r.old.oldLocal.rotation;
      child.scale = r.old.oldLocal.scale;
      const target = this.childrenOf.get(r.old.from.parentId)!;
      target.splice(
        THREE.MathUtils.clamp(r.old.from.index, 0, target.length),
        0,
        r.id,
      );
    }
    if (this._selection && !this.nodes.has(this._selection)) this._selection = null;
    this.invalidateWorlds();
    this.emit('structure');
    this.emit('selection');
  }

  /**
   * 深复制一棵子树。副本作为原节点的兄弟插入，名称加 “ 副本”，id 全部重新生成。
   * 返回新子树根节点 id，以及 id 映射（测试用）。
   */
  duplicateSubtree(id: string): { newRootId: string; idMap: Map<string, string> } {
    const src = this.nodes.get(id);
    if (!src) throw new Error(`节点不存在: ${id}`);
    const idMap = new Map<string, string>();

    const cloneInto = (srcId: string, newParent: string | null): string => {
      const s = this.nodes.get(srcId)!;
      const created = this.addNode(
        {
          name: `${s.name} 副本`,
          position: [...s.position] as Vec3,
          rotation: [...s.rotation] as Vec3,
          scale: [...s.scale] as Vec3,
          visible: s.visible,
          geometry: s.geometry ? structuredClone(s.geometry) : undefined,
          material: s.material ? structuredClone(s.material) : undefined,
        },
        newParent,
      );
      idMap.set(srcId, created.id);
      for (const childId of this.childrenOf.get(srcId) ?? []) {
        cloneInto(childId, created.id);
      }
      return created.id;
    };

    const parent = src.parentId;
    const siblings = this.childrenOf.get(parent)!;
    const insertAt = siblings.indexOf(id) + 1;
    const newRootId = cloneInto(id, parent);

    // 移动到原节点之后
    const list = this.childrenOf.get(parent)!;
    const from = list.indexOf(newRootId);
    list.splice(from, 1);
    list.splice(insertAt, 0, newRootId);
    this.emit('structure', [newRootId]);
    return { newRootId, idMap };
  }

  // ---------- 属性变更 ----------

  /** 直接设置局部 TRS（gizmo 拖动过程中调用，不入历史） */
  setLocalTRS(
    id: string,
    trs: Partial<Pick<NodeData, 'position' | 'rotation' | 'scale'>>,
  ): void {
    const node = this.nodes.get(id);
    if (!node) return;
    if (trs.position) node.position = [...trs.position] as Vec3;
    if (trs.rotation) node.rotation = [...trs.rotation] as Vec3;
    if (trs.scale) node.scale = [...trs.scale] as Vec3;
    this.invalidateWorlds(this.subtreeIds(id));
    this.emit('transform', [id]);
  }

  /**
   * 以世界 TRS 反推局部 TRS 并写入。
   * 传入的是期望的世界矩阵（由世界空间 gizmo 的结果分解得到）。
   */
  setWorldMatrix(id: string, world: THREE.Matrix4): void {
    const node = this.nodes.get(id);
    if (!node) return;
    const parentWorld =
      node.parentId === null ? null : this.getWorldMatrix(node.parentId);
    const local = parentWorld
      ? parentWorld.clone().invert().multiply(world.clone())
      : world.clone();
    const d = decompose(local);
    node.position = [d.position.x, d.position.y, d.position.z];
    node.rotation = [d.rotation.x, d.rotation.y, d.rotation.z];
    node.scale = [d.scale.x, d.scale.y, d.scale.z];
    this.invalidateWorlds(this.subtreeIds(id));
    this.emit('transform', [id]);
  }

  setVisible(id: string, visible: boolean): void {
    const node = this.nodes.get(id);
    if (!node || node.visible === visible) return;
    node.visible = visible;
    if (!visible && this._selection === id) {
      // 隐藏不取消选择，但拾取时会被忽略；这里保留选择便于检查器操作
    }
    this.emit('visibility', [id]);
  }

  setName(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.name = name.trim() || node.name;
    this.emit('rename', [id]);
  }

  // ---------- 序列化 ----------

  toSceneFile(camera: SceneFile['camera']): SceneFile {
    return {
      formatVersion: 1,
      nodes: this.getAllNodes().map((n) => this.cloneNodeData(n)),
      camera: structuredClone(camera),
    };
  }

  /** 整体替换为已校验的数据。校验失败由 loader 抛错，本方法不做半加载。 */
  loadValidated(file: SceneFile): void {
    this.nodes.clear();
    this.childrenOf.clear();
    this.worldCache.clear();
    this.childrenOf.set(null, []);
    for (const n of file.nodes) {
      const node = this.cloneNodeData(n);
      this.nodes.set(node.id, node);
      this.childrenOf.set(node.id, []);
    }
    for (const n of file.nodes) {
      const list = this.childrenOf.get(n.parentId);
      if (!list) throw new Error(`场景数据无效：节点 ${n.id} 的父节点 ${n.parentId} 不存在`);
      list.push(n.id);
    }
    this._selection = null;
    this.invalidateWorlds();
    this.emit('load');
    this.emit('selection');
  }

  private cloneNodeData(n: NodeData): NodeData {
    return structuredClone(n);
  }
}
