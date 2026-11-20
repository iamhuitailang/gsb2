import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type { GizmoMode, TransformSpace } from '../core/types';
import type { SceneDocument } from '../core/document';
import {
  History,
  TransformCommand,
  WorldTransformCommand,
  takeTRS,
} from '../core/history';
import type { SceneRenderer } from './renderer';

/**
 * Gizmo 控制器。
 *
 * 空间约定（与检查器读数完全一致）：
 * - 平移 / 旋转：局部空间沿节点自身轴，世界空间沿世界轴。
 * - 缩放：缩放始终定义在节点局部坐标系（非均匀缩放在世界轴上没有良定义的 TRS），
 *   即使切换到世界空间，缩放 gizmo 仍使用局部轴并在 UI 提示。
 * - 含剪切的世界矩阵只影响「世界读数」的分解近似，实际矩阵仍按同一套分解写入，
 *   因此 gizmo 显示、检查器读数、场景表现三者来源一致。
 *
 * 一次按下-拖动-松开记为一条历史命令；拖动过程中实时写文档但不入栈。
 */
export class GizmoController {
  readonly controls: TransformControls;
  private mode: GizmoMode = 'translate';
  private space: TransformSpace = 'world';
  private dragging = false;
  private dragNodeId: string | null = null;
  private beforeLocal: ReturnType<typeof takeTRS> | null = null;
  private beforeWorld: THREE.Matrix4 | null = null;

  constructor(
    private renderer: SceneRenderer,
    private doc: SceneDocument,
    private history: History,
    private onStatus: (message: string) => void,
  ) {
    this.controls = new TransformControls(renderer.camera, renderer.canvas);
    this.controls.setSize(0.9);
    this.controls.setMode(this.mode);
    this.controls.setSpace(this.space);
    renderer.scene.add(this.controls.getHelper ? this.controls.getHelper() : (this.controls as unknown as THREE.Object3D));

    // 拖动 gizmo 时禁用轨道相机，避免冲突
    this.controls.addEventListener('dragging-changed', (event) => {
      const dragging = (event as unknown as { value: boolean }).value;
      this.renderer.orbit.enabled = !dragging;
      this.dragging = dragging;
      if (dragging) this.onDragStart();
      else this.onDragEnd();
    });

    this.controls.addEventListener('objectChange', () => {
      if (!this.dragging || !this.dragNodeId) return;
      const obj = this.controls.object;
      if (!obj) return;
      const id = this.dragNodeId;
      // gizmo 直接改的是 three 对象，把结果回写到文档（渲染器随后与文档对齐）
      if (this.effectiveSpace() === 'local' || this.mode === 'scale') {
        this.doc.setLocalTRS(id, {
          position: [obj.position.x, obj.position.y, obj.position.z],
          rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
          scale: [obj.scale.x, obj.scale.y, obj.scale.z],
        });
      } else {
        this.doc.setWorldMatrix(id, obj.matrixWorld);
      }
    });
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** 缩放模式强制 local；其余模式跟随用户切换 */
  private effectiveSpace(): TransformSpace {
    return this.mode === 'scale' ? 'local' : this.space;
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.controls.setMode(mode);
    this.controls.setSpace(this.effectiveSpace());
    if (mode === 'scale' && this.space === 'world') {
      this.onStatus('提示：缩放始终在节点局部坐标系下进行（世界空间下非均匀缩放无良定义）');
    }
  }

  setSpace(space: TransformSpace): void {
    this.space = space;
    this.controls.setSpace(this.effectiveSpace());
  }

  get currentMode(): GizmoMode {
    return this.mode;
  }
  get currentSpace(): TransformSpace {
    return this.space;
  }

  attachToSelection(): void {
    const id = this.doc.selection;
    if (!id) {
      this.controls.detach();
      return;
    }
    const obj = this.renderer.getObject(id);
    if (obj) this.controls.attach(obj);
  }

  private onDragStart(): void {
    const id = this.doc.selection;
    if (!id) return;
    this.dragNodeId = id;
    this.beforeLocal = takeTRS(this.doc, id);
    this.beforeWorld = this.doc.getWorldMatrix(id).clone();
  }

  private onDragEnd(): void {
    const id = this.dragNodeId;
    if (!id || !this.beforeLocal || !this.beforeWorld) {
      this.resetDrag();
      return;
    }
    const afterLocal = takeTRS(this.doc, id);
    const changed =
      !sameTRS(this.beforeLocal.position, afterLocal.position) ||
      !sameTRS(this.beforeLocal.rotation, afterLocal.rotation) ||
      !sameTRS(this.beforeLocal.scale, afterLocal.scale);

    if (changed) {
      const label = this.mode === 'translate' ? '平移' : this.mode === 'rotate' ? '旋转' : '缩放';
      if (this.effectiveSpace() === 'local' || this.mode === 'scale') {
        this.history.execute(
          new TransformCommand(this.doc, label, id, this.beforeLocal, afterLocal),
        );
      } else {
        const afterWorld = this.doc.getWorldMatrix(id).clone();
        this.history.execute(
          new WorldTransformCommand(
            this.doc,
            `世界${label}`,
            id,
            this.beforeWorld,
            afterWorld,
          ),
        );
      }
    }
    this.resetDrag();
  }

  private resetDrag(): void {
    this.dragNodeId = null;
    this.beforeLocal = null;
    this.beforeWorld = null;
  }

  dispose(): void {
    this.controls.detach();
    this.controls.dispose();
  }
}

function sameTRS(a: number[], b: number[]): boolean {
  return a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
}
