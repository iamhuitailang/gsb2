import * as THREE from 'three';
import type { NodeData, Vec3 } from './types';
import type { ReparentResult, SceneDocument } from './document';

/**
 * 撤销 / 重做：命令模式。
 * 每个命令成对实现 redo/undo，文档的结构性方法返回撤销所需的完整快照，
 * 因此任何用户操作（包括拖动中间被取消）都能精确还原。
 */

export interface Command {
  label: string;
  redo(): void;
  undo(): void;
}

const HISTORY_LIMIT = 200;

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get nextUndoLabel(): string {
    return this.undoStack.at(-1)?.label ?? '';
  }
  get nextRedoLabel(): string {
    return this.redoStack.at(-1)?.label ?? '';
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  /** 执行一个新命令并压栈（会清空重做栈） */
  execute(cmd: Command): void {
    cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.notify();
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.notify();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.notify();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.notify();
  }
}

// ---------- 具体命令 ----------

interface TRSSnapshot {
  position: Vec3;
  rotation: Vec3;
  scale: Vec3;
}

function snapshot(node: NodeData): TRSSnapshot {
  return {
    position: [...node.position] as Vec3,
    rotation: [...node.rotation] as Vec3,
    scale: [...node.scale] as Vec3,
  };
}

/** 一次完整的 gizmo 拖动 / 检查器编辑（提交前后各一份局部 TRS 快照） */
export class TransformCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private id: string,
    private before: TRSSnapshot,
    private after: TRSSnapshot,
  ) {}

  redo(): void {
    this.doc.setLocalTRS(this.id, this.after);
  }
  undo(): void {
    this.doc.setLocalTRS(this.id, this.before);
  }
}

/** 世界空间 gizmo 提交：保存提交前后的世界矩阵，undo/redo 时反推局部 */
export class WorldTransformCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private id: string,
    private beforeWorld: THREE.Matrix4,
    private afterWorld: THREE.Matrix4,
  ) {}

  redo(): void {
    this.doc.setWorldMatrix(this.id, this.afterWorld);
  }
  undo(): void {
    this.doc.setWorldMatrix(this.id, this.beforeWorld);
  }
}

export class ReparentCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private id: string,
    private newParent: string | null,
    private newIndex: number | null,
    private preserveWorld: boolean,
  ) {}

  private reverse: ReparentResult | null = null;

  redo(): void {
    this.reverse = this.doc.reparent(
      this.id,
      this.newParent,
      this.newIndex,
      this.preserveWorld,
    );
  }
  undo(): void {
    if (!this.reverse) return;
    // 回到旧父旧位置；局部 TRS 直接恢复，保证数值级还原
    const r = this.reverse;
    this.doc.reparent(this.id, r.from.parentId, r.from.index, false);
    this.doc.setLocalTRS(this.id, r.oldLocal);
  }
}

export class AddCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private data: Omit<NodeData, 'id' | 'parentId'> & { id?: string },
    private parentId: string | null,
    private index: number | null,
  ) {}

  private addedId: string | null = null;

  redo(): void {
    const node = this.doc.addNode(this.data, this.parentId, this.index);
    this.addedId = node.id;
    this.doc.select(node.id);
  }
  undo(): void {
    if (this.addedId && this.doc.has(this.addedId)) {
      this.doc.removeNode(this.addedId, false);
    }
  }
}

export class DeleteCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private id: string,
    private keepChildren: boolean,
  ) {}

  private saved: ReturnType<SceneDocument['removeNode']> | null = null;
  private previousSelection: string | null = null;

  redo(): void {
    this.previousSelection = this.doc.selection;
    this.saved = this.doc.removeNode(this.id, this.keepChildren);
  }
  undo(): void {
    if (!this.saved) return;
    this.doc.restoreNodes(this.saved.removed, this.saved.reparented);
    this.doc.select(this.previousSelection && this.doc.has(this.previousSelection)
      ? this.previousSelection
      : null);
  }
}

export class DuplicateCommand implements Command {
  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private sourceId: string,
  ) {}

  private newRootId: string | null = null;

  redo(): void {
    const result = this.doc.duplicateSubtree(this.sourceId);
    this.newRootId = result.newRootId;
    this.doc.select(result.newRootId);
  }
  undo(): void {
    if (this.newRootId && this.doc.has(this.newRootId)) {
      this.doc.removeNode(this.newRootId, false);
    }
  }
}

export class LoadCommand implements Command {
  private previous: import('./types').SceneFile | null = null;

  constructor(
    private doc: SceneDocument,
    readonly label: string,
    private next: import('./types').SceneFile,
    /** 应用相机状态（渲染层由控制器注入），保证相机也随撤销/重做恢复 */
    private applyCamera: (camera: import('./types').CameraData) => void,
  ) {}

  /** execute 前调用：保存当前场景与相机 */
  setPrevious(file: import('./types').SceneFile): void {
    this.previous = file;
  }

  redo(): void {
    this.doc.loadValidated(this.next);
    this.applyCamera(this.next.camera);
  }
  undo(): void {
    if (!this.previous) return;
    this.doc.loadValidated(this.previous);
    this.applyCamera(this.previous.camera);
  }
}

export function takeTRS(doc: SceneDocument, id: string): TRSSnapshot {
  const node = doc.getNode(id);
  if (!node) throw new Error(`节点不存在: ${id}`);
  return snapshot(node);
}
