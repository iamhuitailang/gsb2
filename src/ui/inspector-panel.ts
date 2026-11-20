import * as THREE from 'three';
import type { NodeData, TransformSpace, Vec3 } from '../core/types';
import type { SceneDocument } from '../core/document';
import type { History } from '../core/history';
import { TransformCommand, takeTRS } from '../core/history';
import { eulerToQuaternion, quaternionToEuler } from '../core/transforms';

const FIELD_LABELS = ['X', 'Y', 'Z'] as const;

/**
 * 检查器：展示并编辑选中节点。
 *
 * - 局部空间：直接编辑局部 TRS。
 * - 世界空间：平移/旋转按世界矩阵编辑并反推局部 TRS；
 *   缩放始终是局部概念，世界空间下只读并给出说明。
 * - 世界矩阵含剪切（非均匀缩放+旋转的嵌套）时明确标注「近似分解」，
 *   该读数与 gizmo、内部计算使用同一套矩阵分解，保证一致。
 */
export class InspectorPanel {
  private el: HTMLElement;
  private space: TransformSpace = 'world';
  /** 抑制输入刷新导致的光标跳动 */
  private suppressRefresh = false;

  constructor(
    container: HTMLElement,
    private doc: SceneDocument,
    private history: History,
    private onStatus: (message: string, kind?: 'info' | 'error') => void,
  ) {
    this.el = container;
    this.doc.subscribe((change) => {
      if (
        change.type === 'transform' ||
        change.type === 'selection' ||
        change.type === 'structure' ||
        change.type === 'load' ||
        change.type === 'visibility' ||
        change.type === 'rename'
      ) {
        if (!this.suppressRefresh) this.render();
      }
    });
    this.render();
  }

  setSpace(space: TransformSpace): void {
    this.space = space;
    this.render();
  }

  render(): void {
    const id = this.doc.selection;
    const node = id ? this.doc.getNode(id) : undefined;
    if (!node) {
      this.el.innerHTML =
        '<div class="inspector-empty">未选中对象。<br/>在视图中点选，或在左侧场景树中选择。</div>';
      return;
    }

    this.el.innerHTML = '';
    this.el.appendChild(this.buildHeader(node));
    this.el.appendChild(this.buildTransformSection(node));
    if (node.geometry) this.el.appendChild(this.buildGeometryInfo(node));
  }

  private buildHeader(node: NodeData): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inspector-section';

    const title = document.createElement('h4');
    title.textContent = '对象';
    section.appendChild(title);

    const nameInput = document.createElement('input');
    nameInput.className = 'inspector-name';
    nameInput.value = node.name;
    nameInput.addEventListener('change', () => this.doc.setName(node.id, nameInput.value));
    section.appendChild(nameInput);

    const idLine = document.createElement('div');
    idLine.className = 'inspector-id';
    idLine.textContent = `id: ${node.id}`;
    section.appendChild(idLine);

    const visibleLabel = document.createElement('label');
    visibleLabel.className = 'inspector-checkbox';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = node.visible;
    checkbox.addEventListener('change', () => this.doc.setVisible(node.id, checkbox.checked));
    visibleLabel.appendChild(checkbox);
    visibleLabel.appendChild(document.createTextNode(' 可见（隐藏后不参与点选）'));
    section.appendChild(visibleLabel);

    return section;
  }

  private buildTransformSection(node: NodeData): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inspector-section';
    const title = document.createElement('h4');
    title.textContent = this.space === 'local' ? '局部变换 (TRS)' : '世界变换 (TRS)';
    section.appendChild(title);

    if (this.space === 'world') {
      const world = this.doc.getWorldTRS(node.id);
      if (world.hasShear) {
        const warn = document.createElement('div');
        warn.className = 'inspector-warning';
        warn.textContent =
          '⚠ 祖先链存在非均匀缩放+旋转，世界矩阵含剪切：以下旋转/缩放为最小误差近似分解（与 gizmo 同源），位置精确。';
        section.appendChild(warn);
      }
    }

    if (this.space === 'local') {
      section.appendChild(
        this.buildVec3Editor('平移', node.position, (v) =>
          this.commitLocal(node, { position: v }),
        ),
      );
      section.appendChild(
        this.buildVec3Editor(
          '旋转 (°)',
          node.rotation.map((r) => THREE.MathUtils.radToDeg(r)) as Vec3,
          (v) =>
            this.commitLocal(node, {
              rotation: v.map((d) => THREE.MathUtils.degToRad(d)) as Vec3,
            }),
        ),
      );
      section.appendChild(
        this.buildVec3Editor('缩放', node.scale, (v) => {
          if (v.some((x) => x === 0)) {
            this.onStatus('缩放不能为 0（矩阵将不可逆），已忽略', 'error');
            this.render();
            return;
          }
          this.commitLocal(node, { scale: v });
        }),
      );
    } else {
      const world = this.doc.getWorldTRS(node.id);
      const worldEuler = [world.rotation.x, world.rotation.y, world.rotation.z] as Vec3;

      section.appendChild(
        this.buildVec3Editor(
          '世界平移',
          [world.position.x, world.position.y, world.position.z],
          (v) => this.commitWorld(node, { position: v }),
        ),
      );
      section.appendChild(
        this.buildVec3Editor(
          '世界旋转 (°)',
          worldEuler.map((r) => THREE.MathUtils.radToDeg(r)) as Vec3,
          (v) =>
            this.commitWorld(node, {
              rotation: v.map((d) => THREE.MathUtils.degToRad(d)) as Vec3,
            }),
        ),
      );
      const scaleEditor = this.buildVec3Editor(
        '世界缩放（只读）',
        [world.scale.x, world.scale.y, world.scale.z],
        () => undefined,
      );
      scaleEditor.querySelectorAll('input').forEach((input) => {
        input.readOnly = true;
        input.classList.add('readonly');
      });
      const note = document.createElement('div');
      note.className = 'inspector-note';
      note.textContent = '缩放定义在节点局部坐标系；请切到「局部」编辑。';
      section.appendChild(scaleEditor);
      section.appendChild(note);
    }
    return section;
  }

  private buildGeometryInfo(node: NodeData): HTMLElement {
    const section = document.createElement('div');
    section.className = 'inspector-section';
    const title = document.createElement('h4');
    title.textContent = '几何体 / 材质';
    section.appendChild(title);

    const line = document.createElement('div');
    line.className = 'inspector-id';
    const params = node.geometry!.params?.join(', ') ?? '默认参数';
    line.textContent = `类型: ${node.geometry!.kind}（${params}）`;
    section.appendChild(line);

    if (node.material) {
      const colorLine = document.createElement('div');
      colorLine.className = 'inspector-id';
      colorLine.textContent = `颜色: #${node.material.color.toString(16).padStart(6, '0')}`;
      section.appendChild(colorLine);
    }
    return section;
  }

  private buildVec3Editor(
    label: string,
    values: Vec3,
    onCommit: (v: Vec3) => void,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'vec3-editor';
    const labelEl = document.createElement('span');
    labelEl.className = 'vec3-label';
    labelEl.textContent = label;
    wrap.appendChild(labelEl);

    const inputs: HTMLInputElement[] = [];
    FIELD_LABELS.forEach((axis, i) => {
      const field = document.createElement('label');
      field.className = 'vec3-field';
      const axisLabel = document.createElement('span');
      axisLabel.textContent = axis;
      axisLabel.className = `axis axis-${axis.toLowerCase()}`;
      const input = document.createElement('input');
      input.type = 'number';
      input.step = axis === 'X' ? '0.1' : '0.1';
      input.value = Number(values[i].toFixed(5)).toString();
      input.disabled = input.readOnly;
      field.appendChild(axisLabel);
      field.appendChild(input);
      wrap.appendChild(field);
      inputs.push(input);
    });

    const commit = (): void => {
      const v = inputs.map((input) => parseFloat(input.value)) as Vec3;
      if (v.some((x) => !Number.isFinite(x))) {
        this.onStatus('请输入有效数字', 'error');
        this.render();
        return;
      }
      this.suppressRefresh = true;
      try {
        onCommit(v);
      } finally {
        this.suppressRefresh = false;
      }
    };
    inputs.forEach((input) => input.addEventListener('change', commit));
    return wrap;
  }

  // ---------- 提交 ----------

  private commitLocal(node: NodeData, patch: Partial<Pick<NodeData, 'position' | 'rotation' | 'scale'>>): void {
    const before = takeTRS(this.doc, node.id);
    this.doc.setLocalTRS(node.id, patch);
    const after = takeTRS(this.doc, node.id);
    this.history.execute(new TransformCommand(this.doc, '检查器编辑', node.id, before, after));
  }

  /**
   * 世界空间编辑：读出当前世界 TRS，替换被编辑的分量后重建世界矩阵，
   * 由文档反推局部 TRS。旋转编辑保留当前世界缩放与平移。
   */
  private commitWorld(
    node: NodeData,
    patch: { position?: Vec3; rotation?: Vec3 },
  ): void {
    const current = this.doc.getWorldTRS(node.id);
    const position = patch.position
      ? new THREE.Vector3(...patch.position)
      : current.position.clone();
    const quaternion = patch.rotation
      ? eulerToQuaternion(patch.rotation)
      : current.quaternion.clone();
    const scale = current.scale.clone();
    const world = new THREE.Matrix4().compose(position, quaternion, scale);

    const beforeWorld = this.doc.getWorldMatrix(node.id).clone();
    this.doc.setWorldMatrix(node.id, world);
    const afterWorld = this.doc.getWorldMatrix(node.id).clone();

    // 用 WorldTransformCommand 等价的局部快照方式入栈
    const beforeLocal = this.snapshotFromWorld(node, beforeWorld);
    const afterLocal = this.snapshotFromWorld(node, afterWorld);
    this.history.execute(
      new TransformCommand(this.doc, '世界空间编辑', node.id, beforeLocal, afterLocal),
    );
  }

  private snapshotFromWorld(node: NodeData, world: THREE.Matrix4): {
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
  } {
    const parentWorld =
      node.parentId === null ? null : this.doc.getWorldMatrix(node.parentId);
    const local = parentWorld
      ? parentWorld.clone().invert().multiply(world.clone())
      : world.clone();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    local.decompose(p, q, s);
    const e = quaternionToEuler(q);
    return {
      position: [p.x, p.y, p.z],
      rotation: e,
      scale: [s.x, s.y, s.z],
    };
  }
}
